// Delivery of the on-disk report queue: read each record, POST it, and decide what its answer means
// for the file. Extracted from checkpoint.mjs's `flushQueue`, which stays as a thin compatibility
// wrapper so `scripts/track.mjs` and the hook path keep their existing result shape.
//
// Everything the old function did is here unchanged — the per-file backoff that stops a head-of-line
// file from starving the queue, the absolute deadline that stops a serial loop from outliving the
// hook, `stripRetry` on the way to the wire — plus four things it could not do:
//
//   ONE FORCED REFRESH PER FLUSH. A 401 used to mean "wait 30s and try the same expired token
//   again". token.mjs hands back a possibly-expired token on purpose and lets the server judge, so
//   the FIRST 401 of a flush is the natural moment to renew, and the same serialized payload then
//   goes out under the new token. One refresh, not one per file: a machine whose credentials are
//   genuinely gone would otherwise spend the whole hook budget renewing.
//
//   QUARANTINE, NOT SILENCE. An unparseable `.json` record used to be skipped — every flush,
//   forever, invisibly, until prune deleted it at 14 days. It is now RENAMED to `.corrupt`, which
//   takes it out of the delivery path while preserving the bytes: a record nobody can read is the
//   only evidence of whatever wrote it, and deleting evidence is how the bug that produced it stays
//   unfindable. Renaming is also the only honest reading of "malformed" — salvaging a JSON prefix
//   would invent a payload the client never built.
//
//   THE TENANT POLICY GATE. A tenant with tracking off must not have its queue delivered, and a
//   403 whose body carries the exact code `TRACKING_DISABLED` persists that mode locally and stops
//   the flush. Only the EXACT code: a code-less 403 (seat revoked, deactivated user) is a transient
//   refusal and keeps its existing retry handling, because reading it as "tracking is off" would
//   darken a machine over an unrelated permissions change.
//
//   THE REQUEST EPOCH FENCE. A queued payload belongs to the account that built it. Logout/relink
//   can land between the fence and the send, or inside a refresh, or during a body read — so the
//   epoch is rechecked before every send, after every refresh, and before any response-derived
//   state is applied. Mismatch defers: it is never permission to deliver the old account's payload
//   under the new account's credentials, and never permission to write the old account's policy.
//
// `.tmp` is ignored even when it parses cleanly: it is a half-written record whose writer still
// owns it, and posting one would deliver a payload that was never finished.
import fs from 'fs';
import path from 'path';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, POST_TIMEOUT_MS, readJsonBounded } from './http.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { queueDir } from './paths-cursor.mjs';
import { isDue, isExpired, isRetryableStatus, recordFailure, stripRetry } from './queue-backoff.mjs';
import { seedFirstQueuedAt } from './queue-maintenance.mjs';
import { isLiveTrackingAllowed, markTrackingDisabled } from './tracking.mjs';
import { sanitizeQueuedPayloadRemote } from './git.mjs';

// The one 403 body code that means the tenant turned tracking off, as the server spells it. Shared
// with lib/audit-flush.mjs's reading of the same field; a second spelling is how the gate and the
// backfill end up disagreeing about the same response.
export const TRACKING_DISABLED_CODE = 'TRACKING_DISABLED';

// Did this request cost the budget, or did it fail for free? (Carried over from checkpoint.mjs.)
//
// The backoff exists to protect the hook budget from a file that eats it. A POST aborted at
// POST_TIMEOUT_MS spent 3000ms of it and is precisely the file that starves everything behind it,
// so it has to step aside. A POST that failed instantly — DNS, ECONNREFUSED, a laptop on a train —
// cost nothing, starves nobody, and every other file is failing the same way: backing those off
// would delay the whole queue by 30s for a machine that is merely offline, and would do it by
// rewriting every queue file on every hook.
//
// Node's fetch surfaces an abort as a DOMException named AbortError, and some versions wrap it as
// the `cause` of a TypeError, so both positions are checked.
function timedOut(error) {
  const cause = error == null ? undefined : error.cause;
  const names = [
    error == null ? undefined : error.name,
    cause == null ? undefined : cause.name,
  ];
  return names.includes('AbortError') || names.includes('TimeoutError');
}

function bodyCode(body) {
  if (body == null || typeof body !== 'object') return null;
  return typeof body.code === 'string' ? body.code : null;
}

function bodyMessage(body) {
  if (body == null || typeof body !== 'object') return null;
  const message = body.message;
  if (Array.isArray(message)) return typeof message[0] === 'string' ? message[0] : null;
  return typeof message === 'string' ? message : null;
}

// `<name>.<ts>.corrupt`, uniquified so a second quarantine of the same basename in the same
// millisecond cannot overwrite the first one's evidence.
function corruptName(fsImpl, dir, file, ts) {
  const base = path.basename(file, '.json');
  let candidate = `${base}.${ts}.corrupt`;
  let n = 1;
  while (fsImpl.existsSync(path.join(dir, candidate))) {
    candidate = `${base}.${ts}-${n}.corrupt`;
    n += 1;
  }
  return candidate;
}

// Drain the report queue.
//
// `auth` is the injected typed-auth seam — `{ getToken(), forceRefresh(), authEpoch() }` (CONTRACTS
// §2). `deadlineAt` is an ABSOLUTE epoch-ms instant after which no further request may begin; null
// drains everything, which is the CLI path, because a user waiting at a terminal would rather see
// the whole queue go than a partial flush.
//
// Returns { sent, flushed, rejected, failed, deferred, expired, stuck, gated, trackingDisabled,
// quarantined, quarantineFailed, lastError }. `sent` is an ALIAS of `flushed`, not a replacement:
// CONTRACTS §6 names the new field and scripts/track.mjs reads the old one, so both are emitted and
// they are always equal.
export async function deliverQueue({ auth, deadlineAt = null, deps = {} } = {}) {
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  const now = deps.now == null ? Date.now : deps.now;
  const dir = deps.dir == null ? queueDir() : deps.dir;
  const fetchImpl = deps.fetchImpl;
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const readBody = deps.readBodyImpl == null ? readJsonBounded : deps.readBodyImpl;
  const writeJson = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  const onRequestTimeout = deps.onRequestTimeout == null ? (() => {}) : deps.onRequestTimeout;
  // No-op until M07 wires real telemetry; the codes are the allowlisted ones from CONTRACTS §8.
  const recordIssue = deps.recordIssue == null ? (() => {}) : deps.recordIssue;
  // The tenant policy writer. Defaults to the real cache so a 403 darkens the machine for every
  // later hook, not just this process.
  const recordPolicy = deps.recordPolicy == null ? markTrackingDisabled : deps.recordPolicy;
  // Fail-open by design: a missing or corrupt cache means "allow". The server is the actual
  // boundary, and failing closed would dark-mode every fresh install until its first whoami.
  const isTrackingAllowed = deps.isTrackingAllowed == null ? (() => isLiveTrackingAllowed()) : deps.isTrackingAllowed;
  const reportUrl = deps.reportUrl == null ? `${apiBase()}${ENDPOINTS.sessionsReport}` : deps.reportUrl;

  const result = {
    sent: 0,
    flushed: 0,
    rejected: 0,
    failed: 0,
    deferred: 0,
    expired: 0,
    stuck: 0,
    gated: false,
    trackingDisabled: false,
    quarantined: 0,
    quarantineFailed: 0,
    lastError: null,
  };

  // Gate BEFORE any network work and before the directory is even read: a disabled tenant's queue
  // is held, not delivered and not discarded. lib/queue-maintenance.mjs ages the hold out.
  if (!isTrackingAllowed()) {
    result.gated = true;
    return result;
  }

  // The account/environment/auth identity this whole flush belongs to. Every send and every applied
  // response is checked against it.
  const fence = await auth.authEpoch();
  const sameAccount = async () => (await auth.authEpoch()) === fence;

  let token = await auth.getToken();
  if (token == null || token === '') return result;

  const outOfBudget = () => deadlineAt !== null && now() >= deadlineAt;
  // Recomputed from the ABSOLUTE deadline every time, including after a refresh: reusing a value
  // taken before the refresh is how the retry overruns the hook's kill.
  const perRequestMs = () => (deadlineAt === null ? undefined : Math.max(1, Math.min(POST_TIMEOUT_MS, deadlineAt - now())));
  // Bounded by what is LEFT of the budget rather than a fresh allowance. lib/http.mjs unrefs its
  // abort timer instead of clearing it (H-1), so the POST's own allowance does still reach a body
  // read — but it is the SAME allowance, already partly spent on the headers, and it surfaces as a
  // thrown AbortError rather than a soft `null`. Passing the remainder here keeps both phases inside
  // the deadline and keeps a stall soft; `undefined` is the CLI path, where readJsonBounded applies
  // its own 10s default.
  const bodyBudgetMs = () => (deadlineAt === null ? undefined : Math.max(0, deadlineAt - now()));

  // Record one failed attempt ON the record, so the next flush skips it cheaply instead of spending
  // the budget on it again. `seedFirstQueuedAt` runs first and only matters once: this write
  // refreshes the file's mtime, and mtime is the only enqueue clock a never-failed record has.
  // Best-effort — failing to write the retry state costs one wasted retry, never the segment.
  const backOff = (filePath, payload, stat) => {
    try { writeJson(filePath, recordFailure(seedFirstQueuedAt(payload, stat), now())); } catch { /* retries sooner */ }
  };

  const post = async (body) => {
    const timeoutMs = perRequestMs();
    if (timeoutMs !== undefined) onRequestTimeout(timeoutMs);
    return postJsonImpl(reportUrl, token, body, {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };

  let files;
  try {
    files = fsImpl.readdirSync(dir);
  } catch {
    return result;
  }
  // The extension filter runs BEFORE any accounting, so a README or a leftover `.tmp` cannot inflate
  // the deferred count that track.mjs prints to the user.
  files = files.filter((file) => path.extname(file) === '.json');

  // One forced refresh for the whole flush, not one per record.
  let refreshed = false;

  for (let index = 0; index < files.length; index += 1) {
    if (outOfBudget()) {
      // Everything from here on is untouched. Added rather than assigned: records skipped EARLIER
      // in this same loop for not being due were already counted as deferred.
      result.deferred += files.length - index;
      break;
    }
    const file = files[index];
    const filePath = path.join(dir, file);

    let stat = null;
    try { stat = fsImpl.statSync(filePath); } catch { stat = null; }

    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf-8');
    } catch {
      // Gone between the readdir and here — delivered by a concurrent flush, or pruned. Not a
      // corrupt record and not this flush's problem.
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      const target = corruptName(fsImpl, dir, file, now());
      try {
        fsImpl.renameSync(filePath, path.join(dir, target));
        result.quarantined += 1;
        // Emitted ONLY after the rename succeeded: the code means "this record was quarantined",
        // and reporting it for a record still sitting in the delivery path would be a lie.
        recordIssue('queue_file_quarantined', { source: 'queue-delivery', reason: 'malformed_json' });
      } catch {
        result.quarantineFailed += 1;
      }
      continue;
    }
    if (payload == null || typeof payload !== 'object') {
      // Valid JSON, but not a record — a bare `null`, a number, a string. Same verdict as malformed:
      // it can never be delivered, so it leaves the delivery path with its bytes intact.
      const target = corruptName(fsImpl, dir, file, now());
      try {
        fsImpl.renameSync(filePath, path.join(dir, target));
        result.quarantined += 1;
        recordIssue('queue_file_quarantined', { source: 'queue-delivery', reason: 'not_an_object' });
      } catch {
        result.quarantineFailed += 1;
      }
      continue;
    }

    // Give up on a record that has been failing for two weeks, keyed off `_retry.firstQueuedAt` and
    // NOT off mtime: recording a retry rewrites the file, which refreshes its mtime, so the one
    // record that can never be sent would otherwise also be the one prune.mjs can never delete.
    if (isExpired(payload, now())) {
      result.expired += 1;
      try { fsImpl.unlinkSync(filePath); } catch { result.stuck += 1; }
      continue;
    }

    // Not due yet — skipped WITHOUT spending any of the budget, which is the entire point of the
    // backoff. See lib/queue-backoff.mjs for the starvation this prevents.
    if (!isDue(payload, now())) {
      result.deferred += 1;
      continue;
    }

    // The fence, immediately before the send. A relink between the flush starting and this record's
    // turn means the payload belongs to an account these credentials no longer represent.
    if (!(await sameAccount())) {
      result.deferred += files.length - index;
      break;
    }

    // Serialized ONCE. The 401 retry below re-sends this exact object, so the server sees the same
    // payload and the same segmentId, not a rebuilt one.
    //
    // stripRetry is NOT optional and NOT cosmetic: the ingest route runs a global
    // ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }), so ONE unknown top-level key
    // 400s the ENTIRE report. `_retry` is local bookkeeping and must never reach the wire.
    //
    // sanitizeQueuedPayloadRemote migrates a legacy `local://<absolute path>` remote to
    // `local:<folder>` IN MEMORY ONLY — the queue file on disk is left byte-identical, because its
    // `_retry.firstQueuedAt` is the only enqueue clock a failed record has and rewriting the file
    // would reset the backoff. A record queued by an older build otherwise puts the user's account
    // name and their private folder names on the wire, and lands under a second repository key
    // that no later report ever joins.
    //
    // THIS IS THE ONLY LIVE SITE. It used to sit beside the POST in lib/checkpoint.mjs; the
    // extraction that moved delivery here deleted that line, so if the sanitizer is not applied
    // right here it is applied nowhere and nothing fails to say so.
    const wire = stripRetry(sanitizeQueuedPayloadRemote(payload));

    let res;
    try {
      res = await post(wire);
    } catch (error) {
      result.failed += 1;
      if (timedOut(error)) backOff(filePath, payload, stat);
      continue;
    }

    // ── 401: one forced refresh per flush, then the exact same payload again ────────────────────
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      let renewal = null;
      try { renewal = await auth.forceRefresh(); } catch { renewal = null; }

      if (!(await sameAccount())) {
        // The refresh landed on a DIFFERENT account. Deferring is the only safe answer: this
        // payload is the previous tenant's and must not be delivered under the new credentials.
        result.deferred += files.length - index;
        break;
      }

      const usable = renewal != null && renewal.ok === true && typeof renewal.token === 'string' && renewal.token !== '';
      if (usable && !outOfBudget()) {
        token = renewal.token;
        try {
          res = await post(wire);
        } catch (error) {
          result.failed += 1;
          if (timedOut(error)) backOff(filePath, payload, stat);
          continue;
        }
      } else {
        // No usable token, or the refresh itself spent the budget. Keep the record and back it off;
        // the next flush gets its own refresh.
        result.failed += 1;
        result.lastError = `HTTP ${res.status}`;
        backOff(filePath, payload, stat);
        continue;
      }
    }

    if (res.status >= 200 && res.status < 300) {
      result.flushed += 1;
      result.sent += 1;
      // Its own try: the report IS delivered, and on Windows a scanner or backup agent holding a
      // handle makes the unlink throw. Counting that as `failed` would tell the user the send
      // failed when it had succeeded, and re-send it forever.
      //
      // Deliberately NOT fenced: the payload was accepted while the fence still held, so removing
      // its file records a delivery that happened. Leaving it would re-send the previous account's
      // segment to the new one, which is the outcome the fence exists to prevent.
      try { fsImpl.unlinkSync(filePath); } catch { result.stuck += 1; }
      continue;
    }

    // ── 403: parse the bounded body BEFORE generic retry classification ─────────────────────────
    if (res.status === 403) {
      const body = await readBody(res, bodyBudgetMs());
      const code = bodyCode(body);
      const message = bodyMessage(body);
      if (code === TRACKING_DISABLED_CODE) {
        // The policy is account-scoped state derived from a response, so it is fenced: a logout
        // that completed while this body was being read must not write the previous account's
        // verdict over the new one.
        if (!(await sameAccount())) {
          result.deferred += files.length - index;
          break;
        }
        try { recordPolicy(TRACKING_DISABLED_CODE); } catch { /* best-effort */ }
        result.trackingDisabled = true;
        result.lastError = message == null ? `HTTP ${res.status}` : message;
        // Stop the flush. The record is NOT backed off: a policy hold is not a transient failure,
        // and stamping a 30s retry on it would misreport why it is sitting there. The hold sweep in
        // lib/queue-maintenance.mjs owns its age from here.
        result.deferred += files.length - index;
        break;
      }
      // Any other 403 — code-less, seat revoked, deactivated user — keeps its EXISTING handling,
      // status string included: the old flush reported `HTTP 403` for every retryable status and
      // scripts/track.mjs prints that string, so reading the body must not change what the user is
      // told about an outcome whose meaning did not change.
      result.failed += 1;
      result.lastError = `HTTP ${res.status}`;
      backOff(filePath, payload, stat);
      continue;
    }

    if (isRetryableStatus(res.status)) {
      // Recoverable — the server is unhappy with the moment, not the payload. Keep the record, and
      // still record why, so a CLI run can say "401" rather than "could not reach the server".
      result.failed += 1;
      result.lastError = `HTTP ${res.status}`;
      if (res.status >= 500) recordIssue('queue_flush_http_error', { source: 'queue-delivery', status: res.status });
      backOff(filePath, payload, stat);
      continue;
    }

    // Permanent rejection — the server will never accept this payload. Drop it, but say why.
    const body = await readBody(res, bodyBudgetMs());
    const message = bodyMessage(body);
    result.rejected += 1;
    result.lastError = message == null ? `HTTP ${res.status}` : message;
    try { fsImpl.unlinkSync(filePath); } catch { result.stuck += 1; }
  }

  return result;
}
