import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// The backfill route caps chunks at 100 array items and mounts a 5mb body limit; 50 items with
// 1MB of headroom keeps every chunk comfortably inside both.
export const MAX_CHUNK_ITEMS = 50;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

// postJson's 3s default exists to protect the 10s hook budget. The backfill is a foreground
// command and the server ingests a chunk's reports sequentially, which is seconds to tens of
// seconds.
const DEFAULT_BACKFILL_TIMEOUT_MS = 60_000;

// One in-run retry for transport-level failures (stale keep-alive socket, momentary server or
// DB blip): the chunk is idempotent server-side, and the fresh dial escapes a dead pooled
// connection. A second failure defers the sessions to the next login.
const RETRY_BACKOFF_MS = 500;

// Bisection depth guard: ceil(log2(50)) = 6 splits isolate any single poison session; anything
// deeper is a pathological server, not a payload problem.
const MAX_BISECT_DEPTH = 8;

// Per-session verdicts derived from the chunk response. ACCEPTED deliberately covers both
// "stored" and the server's benign zero-token skip — the response's stored/skipped are chunk
// totals with no per-session attribution, so claiming "stored" per session would assert
// something the wire never said.
export const BackfillSessionStatus = Object.freeze({
  ACCEPTED: 'accepted',
  PARTIAL: 'partial',
  REJECTED: 'rejected',
  FAILED: 'failed',
  UNATTRIBUTED: 'unattributed',
});

// Run-ending conditions — the caller stops sending and reports these distinctly.
export const BackfillHalt = Object.freeze({
  ALREADY_COMPLETED: 'already-completed',
  NOT_ALLOWED: 'not-allowed',
  UNSUPPORTED_SERVER: 'unsupported-server',
  FORBIDDEN: 'forbidden',
});

// The routes this transport may post to, as a CLOSED set of names.
//
// Sync and the one-time backfill share every line of chunking, verdict folding, bisection and
// retry below, and differ only in where the body lands — so the route is a parameter. It is a
// NAME and never a URL: a transport that accepts a caller-supplied address is one bad option bag
// away from sending a user's session history somewhere else, and it also makes "which pull did
// this run consume" unanswerable from the call site. An unrecognized value throws before any
// planning or network work happens, so a typo can never quietly fall back to the backfill route
// and burn the one-time pull.
export const AuditEndpoint = Object.freeze({
  BACKFILL: 'backfill',
  SYNC: 'sync',
});

// lib/config.mjs is integration-owned and its ENDPOINTS map has no sync entry yet; the path is
// pinned here until that patch lands (see handoff-sync.md) and read from ENDPOINTS the moment it
// does, so the two cannot drift.
const SYNC_ROUTE_FALLBACK = '/sessions/sync';

function endpointPath(selection) {
  if (selection == null || selection === AuditEndpoint.BACKFILL) return ENDPOINTS.sessionsBackfill;
  if (selection === AuditEndpoint.SYNC) {
    return ENDPOINTS.sessionsSync == null ? SYNC_ROUTE_FALLBACK : ENDPOINTS.sessionsSync;
  }
  // Deliberately says nothing about what was passed: the offending value can be a URL, and
  // echoing it into a log is how a rejected address ends up in a diagnostics payload anyway.
  throw new Error('beezi: unknown audit endpoint (expected "backfill" or "sync")');
}

// Split one chunk in half without a network round trip. Sessions first — a chunk carrying several
// is split at a session boundary so each half still owns whole sessions and its verdict is
// attributable. A single session over the budget by itself splits by report, and its parts carry
// `partialOf` so the caller accepts the session only when every part was accepted. Returns null
// for the one chunk that cannot be divided (one session, one report); that one is sent as-is and
// refused with a definite status rather than looped on.
function splitChunk(chunk) {
  const ids = [...new Set(chunk.sessionIds)];
  const timelines = chunk.timelines == null ? [] : chunk.timelines;
  if (ids.length > 1) {
    const splitIds = new Set(ids.slice(0, Math.ceil(ids.length / 2)));
    const first = { reports: [], sessionIds: [], timelines: [] };
    const second = { reports: [], sessionIds: [], timelines: [] };
    for (const report of chunk.reports) {
      (splitIds.has(report.sessionId) ? first : second).reports.push(report);
    }
    for (const timeline of timelines) {
      (splitIds.has(timeline.sessionId) ? first : second).timelines.push(timeline);
    }
    first.sessionIds = chunk.sessionIds.filter((id) => splitIds.has(id));
    second.sessionIds = chunk.sessionIds.filter((id) => !splitIds.has(id));
    if (chunk.partialOf != null) {
      first.partialOf = chunk.partialOf;
      second.partialOf = chunk.partialOf;
    }
    return [first, second];
  }
  if (chunk.reports.length > 1) {
    const mid = Math.ceil(chunk.reports.length / 2);
    const partialOf = chunk.partialOf == null ? ids[0] : chunk.partialOf;
    return [
      { reports: chunk.reports.slice(0, mid), sessionIds: chunk.sessionIds, timelines, partialOf },
      { reports: chunk.reports.slice(mid), sessionIds: chunk.sessionIds, timelines: [], partialOf },
    ];
  }
  return null;
}

const wireBytes = (reports, timelines = []) =>
  Buffer.byteLength(JSON.stringify({ sessions: reports, timelines }), 'utf-8');

// Pack whole sessions into request-sized chunks of at most `maxItems` payloads / `maxBytes`.
//
// A session stays an indivisible packing unit so the ledger can attribute a whole chunk's
// verdict to whole sessions — the server dedupes via its upsert keys and needs no such
// grouping itself. Only a session too large for one request splits; its continuations carry
// `partialOf` so the caller accepts the session only when every part was accepted.
//
// A group's optional `timeline` rides in the chunk that carries its reports (the FIRST part of
// a split session — the server applies it once the session has stored anything). Timelines are
// small next to the 1MB headroom over the route's 5mb limit, so the split path does not re-run
// its byte math over them; the normal path counts them.
//
// A group may carry its own `bytes`, and the audit supplies one because it has already serialized
// the group to decide when to dispatch — throwing that number away and re-deriving it here made
// the packing quadratic: every group re-serialized the whole growing chunk, so a 50-session batch
// did 50 serializations of up to 50 sessions' payloads. With `bytes` the loop keeps a running sum
// and each group is measured once.
//
// The running sum is an ESTIMATE, deliberately: it omits the chunk envelope, the commas between
// groups, and the difference between the audit's `{reports, timeline}` key names and this route's
// `{sessions, timelines}`. That is tens of bytes across a whole chunk, and it is only safe because
// MAX_BODY_BYTES sits a full 1MB UNDER the route's 5mb limit — tighten that headroom and this
// estimate becomes load-bearing. A group with no `bytes` falls back to exact serialization, so the
// function stays correct for any caller that just hands it groups.
export function planChunks(sessionGroups, { maxItems = MAX_CHUNK_ITEMS, maxBytes = MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let current = null;
  let currentBytes = 0;

  const flushCurrent = () => {
    if (current && current.reports.length > 0) chunks.push(current);
    current = null;
    currentBytes = 0;
  };

  for (const group of sessionGroups) {
    const reports = group.reports == null ? [] : group.reports;
    if (reports.length === 0) continue;
    const bytes = group.bytes == null
      ? wireBytes(reports, group.timeline ? [group.timeline] : [])
      : group.bytes;

    // Slightly more conservative than the split path's own math below, which measures reports
    // alone: a session is sent by itself when its reports PLUS its timeline overflow. Harmless —
    // the split emits the same parts either way, one boundary earlier at worst.
    if (reports.length > maxItems || bytes > maxBytes) {
      // Over-budget session: emit it alone, split by whichever cap binds first.
      flushCurrent();
      let part = [];
      let first = true;
      const emitPart = (partReports) => {
        chunks.push({
          reports: partReports,
          sessionIds: [group.sessionId],
          partialOf: group.sessionId,
          timelines: first && group.timeline ? [group.timeline] : [],
        });
        first = false;
      };
      for (const report of reports) {
        // A single report over the byte budget is still sent alone — it will be refused with a
        // definite status rather than looping forever trying to make it fit.
        if (part.length > 0 && (part.length >= maxItems || wireBytes([...part, report]) > maxBytes)) {
          emitPart(part);
          part = [];
        }
        part.push(report);
      }
      if (part.length > 0) emitPart(part);
      continue;
    }

    if (
      current &&
      (current.reports.length + reports.length > maxItems || currentBytes + bytes > maxBytes)
    ) {
      flushCurrent();
    }
    if (!current) current = { reports: [], sessionIds: [], timelines: [] };
    current.reports.push(...reports);
    current.sessionIds.push(group.sessionId);
    if (group.timeline) current.timelines.push(group.timeline);
    currentBytes += bytes;
  }
  flushCurrent();
  return chunks;
}

// Read a response body ONCE as text, then opportunistically as JSON. Never throws. The Nest
// error filter only covers requests that reach the router — an over-limit or malformed body is
// answered by Express itself with an HTML page, so `code`/`message` are null there and `raw`
// carries a capped excerpt for the summary line.
export async function readResponseBody(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    return { code: null, message: null, raw: '' };
  }
  try {
    const body = JSON.parse(raw);
    const bodyMessage = body == null ? undefined : body.message;
    const message = Array.isArray(bodyMessage) ? bodyMessage[0] : (bodyMessage == null ? null : bodyMessage);
    return { code: body == null || body.code == null ? null : body.code, message, raw: raw.slice(0, 2000), body };
  } catch {
    return { code: null, message: null, raw: raw.slice(0, 2000) };
  }
}

// POST the planned chunks and derive per-session verdicts from the real backfill contract:
// 2xx bodies carry chunk totals plus errors[{sessionId, segmentId, reason}] — a session is
// accepted unless it appears there.
//
// sessionGroups: [{ sessionId, reports: payload[] }] — order preserved.
// Returns { chunks, stored, skipped, itemErrors, retryableFailures, permanentRejections,
//           unattributed, bySession: Map, halt, lastError }.
export async function flushBackfillChunks(sessionGroups, token, deps = {}, options = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onChunk = deps.onChunk == null ? (() => {}) : deps.onChunk;
  const sleep = deps.sleep == null ? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))) : deps.sleep;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_BACKFILL_TIMEOUT_MS : options.timeoutMs;
  // Resolved FIRST, ahead of the result bag and the planner: an unusable endpoint must fail before
  // anything is measured, packed or sent.
  const route = endpointPath(options.endpoint);
  const maxBytes = options.maxBytes == null ? MAX_BODY_BYTES : options.maxBytes;

  const result = {
    chunks: 0,
    stored: 0,
    skipped: 0,
    timelines: 0,
    // Timelines this run deliberately abandoned to save the usage they rode with. Counted so the
    // summary can say the sessions landed but their timelines did not, instead of leaving an
    // unexplained gap between offered and attached.
    timelinesDropped: 0,
    itemErrors: 0,
    retryableFailures: 0,
    permanentRejections: 0,
    unattributed: 0,
    bySession: new Map(),
    halt: null,
    lastError: null,
  };
  const chunks = planChunks(sessionGroups, options);
  if (chunks.length === 0) return result;

  const url = `${apiBase()}${route}`;
  // A 401 is authentication, not a verdict on the payload. Renew once for the whole run and retry;
  // if renewal fails, the remaining chunks count as failed and stay eligible for a re-run.
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    const next = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    if (next && next !== token) { token = next; return next; }
    return null;
  };

  // `timelines` is omitted when empty so a chunk without them stays byte-identical to the
  // pre-timeline wire shape.
  const bodyFor = (chunk) =>
    (chunk.timelines != null && chunk.timelines.length
      ? { sessions: chunk.reports, timelines: chunk.timelines }
      : { sessions: chunk.reports });

  const post = async (body) => postJsonImpl(url, token, body, { fetchImpl, timeoutMs });

  const setSession = (sessionId, status, reason) => {
    const existing = result.bySession.get(sessionId);
    // A split session downgrades: any non-accepted part taints the whole session.
    if (existing && existing.status !== BackfillSessionStatus.ACCEPTED) return;
    if (existing && status === BackfillSessionStatus.ACCEPTED) return;
    result.bySession.set(sessionId, { status, reason: reason == null ? null : reason });
  };

  const markChunk = (chunk, status, reason) => {
    for (const sessionId of chunk.sessionIds) setSession(sessionId, status, reason);
  };

  // Fold one judged 2xx response: a session is accepted unless errors[] names it; the server's
  // `skipped` already includes the errored items, so the counters are not disjoint.
  const mergeChunkResponse = (chunk, parsed) => {
    result.stored += parsed.stored == null ? 0 : parsed.stored;
    result.skipped += parsed.skipped == null ? 0 : parsed.skipped;
    result.timelines += parsed.timelines == null ? 0 : parsed.timelines;
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    result.itemErrors += errors.length;
    // Only two things are ever read off a session's errors — how many there were, and why the
    // first one failed — so those two are what is kept. Accumulating the entries into per-session
    // arrays (by rebuilding each array on every append, no less) built garbage for the sole
    // purpose of reading `.length` and `[0]` off it.
    const errorsBySession = new Map();
    for (const entry of errors) {
      if (entry == null || !entry.sessionId) continue;
      const existing = errorsBySession.get(entry.sessionId);
      if (existing) existing.count += 1;
      else errorsBySession.set(entry.sessionId, { count: 1, firstReason: entry.reason == null ? null : entry.reason });
    }
    const sentBySession = new Map();
    for (const report of chunk.reports) {
      const count = sentBySession.get(report.sessionId);
      sentBySession.set(report.sessionId, (count == null ? 0 : count) + 1);
    }
    for (const sessionId of new Set(chunk.sessionIds)) {
      const sessionErrors = errorsBySession.get(sessionId);
      const failedSegments = sessionErrors == null || sessionErrors.count == null ? 0 : sessionErrors.count;
      const sentCount = sentBySession.get(sessionId);
      const sent = sentCount == null ? 0 : sentCount;
      const reason = sessionErrors == null || sessionErrors.firstReason == null ? null : sessionErrors.firstReason;
      if (failedSegments === 0) setSession(sessionId, BackfillSessionStatus.ACCEPTED);
      else if (failedSegments >= sent) setSession(sessionId, BackfillSessionStatus.REJECTED, reason);
      else setSession(sessionId, BackfillSessionStatus.PARTIAL, reason);
    }
  };

  // One chunk, one verdict. Returns true to continue the run, false to halt it.
  const sendChunk = async (chunk, depth = 0) => {
    // THE FINAL WIRE MEASUREMENT, taken once, on the body that is about to go out.
    //
    // planChunks packs on each group's own `bytes`, which is an estimate by construction: it omits
    // the envelope and the commas, and a caller may hand over a cached figure taken before its
    // payload grew. That estimate is fine for deciding where boundaries FALL and useless as a
    // guarantee, so the real serialized length is computed here — and it GATES the send rather
    // than merely being recorded. A chunk over the budget is divided and re-measured instead of
    // being posted and answered with a 413 that costs the whole chunk's sessions a run.
    const body = bodyFor(chunk);
    if (Buffer.byteLength(JSON.stringify(body), 'utf-8') > maxBytes && depth < MAX_BISECT_DEPTH) {
      const parts = splitChunk(chunk);
      if (parts) {
        const goOn = await sendChunk(parts[0], depth + 1);
        if (!goOn) return false;
        return sendChunk(parts[1], depth + 1);
      }
      // One session, one report, still too big: send it and let the server refuse it definitely.
    }

    const attemptPost = async () => {
      let attempt = await post(body);
      if (attempt.status === 401) {
        const next = await renewToken();
        if (next) attempt = await post(body);
      }
      return attempt;
    };

    // A thrown fetch or a 5xx gets ONE immediate in-run retry after a short backoff before the
    // chunk is written off as FAILED for this run.
    let res;
    let transportError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      transportError = null;
      try {
        res = await attemptPost();
      } catch (error) {
        // A timeout and a socket reset need different follow-up (a 60s stall points at the
        // server, a reset at the connection) — keep them apart in the ledger and summary.
        transportError = error != null && error.name === 'AbortError' ? 'timeout' : 'network';
        if (attempt === 0) await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      if (res.status >= 500 && attempt === 0) {
        // Drain the body so the pooled socket is clean before the retry.
        try { await res.text(); } catch { /* best-effort */ }
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      break;
    }
    if (transportError) {
      markChunk(chunk, BackfillSessionStatus.FAILED, transportError);
      result.retryableFailures += 1;
      result.lastError = transportError;
      return true;
    }

    if (res.status >= 200 && res.status < 300) {
      const { body } = await readResponseBody(res);
      if (!body || !Array.isArray(body.errors)) {
        // The server accepted the chunk but we cannot attribute it — never ledger an outcome
        // we did not receive, and never seal on top of one.
        markChunk(chunk, BackfillSessionStatus.UNATTRIBUTED, 'unreadable-response');
        result.unattributed += 1;
        result.lastError = 'unreadable-response';
        return true;
      }
      mergeChunkResponse(chunk, body);
      return true;
    }

    const { code, message, raw } = await readResponseBody(res);

    if (res.status === 401) {
      // Still unauthenticated after a renewal attempt — never judged, so retryable.
      markChunk(chunk, BackfillSessionStatus.FAILED, `HTTP ${res.status}`);
      result.retryableFailures += 1;
      result.lastError = `HTTP ${res.status}`;
      return true;
    }

    if (res.status === 403) {
      // Only the coded 403s are actionable; a code-less 403 (seat revoked, deactivated user)
      // must never read as "the pull is done" or "tracking is off".
      if (code === 'BACKFILL_ALREADY_COMPLETED') {
        result.halt = BackfillHalt.ALREADY_COMPLETED;
      } else if (code === 'BACKFILL_NOT_ALLOWED' || code === 'TRACKING_DISABLED') {
        // TRACKING_DISABLED should be unreachable here (the backfill routes are ungated);
        // defensively treat it as not-allowed rather than inventing a new state.
        result.halt = BackfillHalt.NOT_ALLOWED;
      } else {
        markChunk(chunk, BackfillSessionStatus.FAILED, message == null ? `HTTP ${res.status}` : message);
        result.retryableFailures += 1;
        result.halt = BackfillHalt.FORBIDDEN;
      }
      result.lastError = message == null ? `HTTP ${res.status}` : message;
      return false;
    }

    if (res.status === 404 || res.status === 405) {
      // Old server without the backfill routes — nothing may be ledgered off this run.
      markChunk(chunk, BackfillSessionStatus.FAILED, `HTTP ${res.status}`);
      result.retryableFailures += 1;
      result.halt = BackfillHalt.UNSUPPORTED_SERVER;
      result.lastError = `HTTP ${res.status}`;
      return false;
    }

    if (res.status === 400 && chunk.timelines != null && chunk.timelines.length && raw.includes('timelines')) {
      // A server predating the in-band timelines 400s the whole chunk on the unknown field
      // (forbidNonWhitelisted). Retry once without them — losing timelines beats losing the
      // usage, and the next login (post-deploy) delivers nothing new only because the ledger
      // already sealed these sessions; acceptable for a deploy-order violation.
      result.timelinesDropped += chunk.timelines.length;
      return sendChunk({ ...chunk, timelines: [] }, depth);
    }

    if (res.status === 400 && new Set(chunk.sessionIds).size > 1 && depth < MAX_BISECT_DEPTH) {
      // Whole-chunk validation failure: one malformed field anywhere 400s all 50 sessions.
      // Split at the session boundary nearest the midpoint and isolate the poison session
      // instead of losing (or endlessly resending) the innocent ones.
      const [first, second] = splitChunk(chunk);
      const goOn = await sendChunk(first, depth + 1);
      if (!goOn) return false;
      return sendChunk(second, depth + 1);
    }

    if (res.status < 500) {
      // 400 single-session floor, 413, and the rest of the permanent 4xx family.
      let rejectionReason = message;
      if (rejectionReason == null) rejectionReason = raw.slice(0, 200);
      if (rejectionReason == null) rejectionReason = `HTTP ${res.status}`;
      markChunk(chunk, BackfillSessionStatus.REJECTED, rejectionReason);
      result.permanentRejections += 1;
      result.lastError = message == null ? `HTTP ${res.status}` : message;
      return true;
    }

    markChunk(chunk, BackfillSessionStatus.FAILED, `HTTP ${res.status}`);
    result.retryableFailures += 1;
    result.lastError = `HTTP ${res.status}`;
    return true;
  };

  for (const chunk of chunks) {
    result.chunks += 1;
    const goOn = await sendChunk(chunk);
    onChunk({ ...result, sent: result.chunks, total: chunks.length });
    if (!goOn) break;
  }

  return result;
}

// Seal this user's pull for the calling tool. Idempotent server-side (snapshot_taken_at is
// COALESCEd), so retrying a lost response is safe.
export async function completeBackfill(token, deps = {}, options = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_BACKFILL_TIMEOUT_MS : options.timeoutMs;
  const url = `${apiBase()}${ENDPOINTS.sessionsBackfillComplete}`;
  try {
    const res = await postJsonImpl(url, token, {}, { fetchImpl, timeoutMs });
    if (res.status >= 200 && res.status < 300) return { completed: true, code: null };
    const { code, message } = await readResponseBody(res);
    return { completed: false, code, reason: message == null ? `HTTP ${res.status}` : message };
  } catch {
    return { completed: false, code: null, reason: 'network' };
  }
}
