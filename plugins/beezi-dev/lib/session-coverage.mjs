import { apiBase, ENDPOINTS, AGENT } from './config.mjs';
import { postJson, readJsonBounded } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// How far Beezi already reaches into each session, in THIS plugin's raw sidecar-line coordinates.
//
// The repeatable sync exists because a sessionId/segmentId upsert alone does not deduplicate two
// DIFFERENT overlapping windows: a resend of `conv:0-200` beside a stored `conv:0-150` produces a
// segmentId the server has never seen, and the same 150 lines are billed twice. The only safe way
// to resume is to ask where the stored prefix ends and send strictly beyond it — which makes this
// module's answer load-bearing, and its failure mode the thing to get right.
//
// So there are exactly TWO answers:
//
//   Map   every batch came back in the documented shape and every value validated. Absent keys are
//         absent from the Map; they are NOT zero (see SPARSE_ZERO_CONFIRMED).
//   null  anything else — an older server without the route, a transport failure, a partial batch,
//         a 2xx whose body is not the documented shape, or a single value that does not validate.
//         `null` means "do not send". An empty Map would mean "the server holds nothing", which is
//         the one wrong answer: it authorizes a full resend of everything.
//
// Note what is deliberately NOT here: the Claude plugin's helper coerces (`typeof value === 'number'
// && value > 0`, silently dropping zero, silently ignoring every other shape). That permissiveness
// turns a schema move into a full resend. Here a value the module does not recognize invalidates
// the whole answer.

// The route caps sessionIds per request; a machine with a year of history scans thousands.
export const MAX_COVERAGE_IDS = 200;

// Whether the deployed contract guarantees that a requested id missing from the response means
// "zero lines stored". It does NOT today, and it cannot be assumed: a server that omits a session
// because it failed to look it up is indistinguishable, on the wire, from one that omits it
// because it holds nothing. Until a backend fixture proves the sparse-zero semantics, a missing
// key means "unknown" and the caller skips that session. Flipping this to true is a backend-gated
// change, not a client decision.
export const SPARSE_ZERO_CONFIRMED = false;

// lib/config.mjs is integration-owned and its ENDPOINTS map has no coverage entry yet; the path is
// pinned here until that patch lands (see handoff-sync.md), and read from ENDPOINTS the moment it
// does so the two cannot drift.
const COVERAGE_ROUTE_FALLBACK = '/sessions/coverage';

// Same reasoning as the flush timeout: a foreground command, and the server folds many segment
// rows per session. postJson's 3s default exists only to protect the 10s hook budget.
const DEFAULT_COVERAGE_TIMEOUT_MS = 60000;

export function planCoverageBatches(sessionIds, size = MAX_COVERAGE_IDS) {
  const step = Number.isInteger(size) && size > 0 ? size : MAX_COVERAGE_IDS;
  const batches = [];
  for (let i = 0; i < sessionIds.length; i += step) batches.push(sessionIds.slice(i, i + step));
  return batches;
}

function isLineNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// The contiguous half-open prefix of a set of `[from, to)` windows, or null when the list is not
// a set of windows this plugin could have produced.
//
// Half-open is not a detail. lib/delta-cursor.mjs indexes raw windows as `[from, to)`, while the
// portal's coverage advance is written inclusive-style: it extends the reached line unless
// `fromLine > reached + 1`. Fed Cursor's `[0,2)` and `[3,4)` that rule answers 4 — and raw line 2,
// which is in NEITHER window, is then never sent again. The rule here stops at the first hole:
// `[0,2),[3,4)` is a prefix of 2, and line 2 stays eligible.
export function halfOpenPrefix(intervals) {
  if (!Array.isArray(intervals)) return null;
  const windows = [];
  for (const interval of intervals) {
    if (!Array.isArray(interval) || interval.length !== 2) return null;
    const from = interval[0];
    const to = interval[1];
    if (!isLineNumber(from) || !isLineNumber(to)) return null;
    // Empty and inverted windows are both nonsense in this coordinate system, and accepting either
    // would let a malformed answer read as progress.
    if (to <= from) return null;
    windows.push([from, to]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  let reached = 0;
  for (const [from, to] of windows) {
    // The first window that does not start at or before the reached line is the hole. Everything
    // after it is unreachable from line 0, whatever it covers.
    if (from > reached) break;
    if (to > reached) reached = to;
  }
  return reached;
}

// One session's entry, as a prefix. Three outcomes, and they are distinct on purpose:
//   { prefix: n }   a validated Cursor prefix
//   { skip: true }  a record that is not Cursor's (another tool reported this id) — not ours to
//                   resume from, and not a protocol error either
//   null            a value this module does not recognize: the whole answer is unusable
function readEntry(value) {
  if (isLineNumber(value)) return { prefix: value };
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  // The source-aware form. `source` is REQUIRED: a record with intervals and no source could
  // belong to any tool reporting under this session id, and guessing "cursor" is how another
  // agent's coverage ends up authorizing (or suppressing) a Cursor send.
  if (typeof value.source !== 'string' || value.source === '') return null;
  if (value.source !== AGENT) return { skip: true };
  const prefix = halfOpenPrefix(value.intervals);
  return prefix === null ? null : { prefix };
}

// How far each session already reaches. See the module comment for what the two answers mean.
export async function fetchCoverage(sessionIds, token, deps = {}, options = {}) {
  if (!Array.isArray(sessionIds)) return null;
  if (sessionIds.length === 0) return new Map();
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const readBody = deps.readJsonBoundedImpl == null ? readJsonBounded : deps.readJsonBoundedImpl;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_COVERAGE_TIMEOUT_MS : options.timeoutMs;
  const batchSize = options.batchSize == null ? MAX_COVERAGE_IDS : options.batchSize;
  const route = ENDPOINTS.sessionsCoverage == null ? COVERAGE_ROUTE_FALLBACK : ENDPOINTS.sessionsCoverage;
  const url = `${apiBase()}${route}`;

  const coverage = new Map();
  for (const batch of planCoverageBatches(sessionIds, batchSize)) {
    let res;
    try {
      res = await postJsonImpl(url, token, { sessionIds: batch }, { fetchImpl, timeoutMs });
    } catch {
      return null;
    }
    if (res == null || !(res.status >= 200 && res.status < 300)) return null;
    // Bounded, like every other body read in this plugin: a server that answers headers and then
    // stalls mid-body must cost the request, not the command.
    const body = await readBody(res, timeoutMs);
    if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
    const entries = body.coverage;
    if (entries == null || typeof entries !== 'object' || Array.isArray(entries)) return null;

    const requested = new Set(batch);
    for (const sessionId of Object.keys(entries)) {
      // A key nobody asked about means the server is answering a different question — a stale
      // cache, a mismatched account scope, a route that ignores the request body. Any of those
      // makes every OTHER value in the same response untrustworthy.
      if (!requested.has(sessionId)) return null;
      const entry = readEntry(entries[sessionId]);
      if (entry === null) return null;
      if (entry.skip === true) continue;
      coverage.set(sessionId, entry.prefix);
    }
  }
  return coverage;
}
