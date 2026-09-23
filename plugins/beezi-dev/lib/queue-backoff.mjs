// Per-file retry state for the report queue: when a queued segment may next be attempted, and when
// it has failed for so long that it should be dropped.
//
// THE FAILURE THIS FIXES — head-of-line starvation, and it is deterministic, not probabilistic.
// `flushQueue` iterates `fs.readdirSync(queueDir())` in the order the filesystem hands back. On NTFS
// that order is lexicographic, and queue filenames are `<conversationId>_<from>-<to>.json`, so the
// SAME file is attempted first on every single flush, forever. The hook budget is 7500ms and each
// POST is bounded at POST_TIMEOUT_MS (3000ms), so one flush completes two or three requests: three
// permanently-failing files at the head of the list consume the entire budget on every flush and
// everything behind them is never attempted at all. Those segments are not retried and then given
// up on — they are never tried once — until prune.mjs deletes them at the retention horizon. The user's analytics
// simply stop, with a queue directory that is visibly full and a flush that reports "failed: 3".
//
// The fix is retry state on the payload itself, so a file that just failed is NOT DUE and is skipped
// cheaply (a read and a comparison, no network), which lets the rest of the queue through.
//
// ┌─ THE TRAP, AND IT HAS ALREADY HAPPENED ONCE ──────────────────────────────────────────────────┐
// │ `_retry` MUST be stripped before the POST body is built — call `stripRetry`.                   │
// │                                                                                                │
// │ The ingest route is validated by a global Nest `ValidationPipe({ whitelist: true,              │
// │ forbidNonWhitelisted: true })`. ONE unknown top-level key 400s the ENTIRE report — not the key, │
// │ the report. checkpoint.mjs carries the scar: two extra top-level fields (`token_cache_read`,    │
// │ `token_cache_write`) made every report fail with BadRequestException, throwing away each        │
// │ segment's tokens, cost, code changes and operations together, and the queue file was deleted as │
// │ a permanent rejection on the way out. Storing retry state on the payload is only safe because   │
// │ the key never reaches the wire. See the payload-shape test.                                    │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘

// Roughly the interval between turn-end hooks at the low end, growing to something that costs a
// stalled queue nothing. 30s / 1m / 2m / 4m / 8m / 16m / 30m: a 401 (routine — token.mjs hands back
// a possibly-expired token on purpose and lets the server judge) clears on the next flush, while a
// genuinely dead file is out of the way within minutes and stays out.
export const BASE_DELAY_MS = 30_000;
export const MAX_DELAY_MS = 30 * 60_000;

// Matches prune.mjs's FOURTEEN_DAYS_MS. Kept as its own constant rather than imported so that a
// change to the disk-space policy cannot silently change the give-up policy.
export const MAX_QUEUE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Statuses that mean "not now", not "never" — the same set flushQueue already applies, exported here
// so the decision to retry and the recording of the retry cannot drift apart.
//
// 401 is routine (see above) and 429 is the server explicitly asking for a retry; deleting a queued
// report on either throws away a segment that would have been accepted a minute later, and the queue
// file is the ONLY copy — the sidecar cursor has already moved past it.
const RETRYABLE_STATUS = new Set([401, 403, 408, 425, 429]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

// How long to wait after `attempts` consecutive failures. `attempts` is 1 on the first failure.
export function backoffDelay(attempts) {
  const n = Number.isFinite(attempts) && attempts > 1 ? Math.floor(attempts) : 1;
  // 2 ** 30 and beyond is still finite, but clamp the exponent anyway: an `attempts` that got
  // corrupted on disk should produce the cap, not Infinity.
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(n - 1, 20));
}

// May this file be attempted now?
//
// A payload with no `_retry` has never failed and is always due — that is every file on its first
// flush, which is the common case and costs one property read.
export function isDue(payload, now = Date.now()) {
  const retry = payload == null ? undefined : payload._retry;
  const next = retry == null ? undefined : retry.nextAttemptAt;
  if (!Number.isFinite(next)) return true;
  // A `nextAttemptAt` further out than the largest delay we are capable of writing is not a delay we
  // wrote — it is a clock that moved. The machine's clock jumping forward (NTP correction after a
  // VM resume, a dual-boot RTC offset) stamps a far-future timestamp that then never arrives once
  // the clock is corrected, and `firstQueuedAt` came from the same wrong clock so the 14-day drop
  // below cannot rescue it either. Treat an impossible deadline as due and let the server decide.
  if (next - now > MAX_DELAY_MS) return true;
  return next <= now;
}

// Record one failed attempt: returns a NEW payload carrying the bumped `_retry`. Pure — the input is
// not mutated, so a caller that fails to persist the result has not corrupted the in-memory copy.
//
// `firstQueuedAt` is stamped on the FIRST failure and never moved afterwards; it is the clock that
// `isExpired` reads.
export function recordFailure(payload, now = Date.now()) {
  const prev = payload == null ? undefined : payload._retry;
  const priorAttempts = prev == null ? undefined : prev.attempts;
  const priorFirstQueuedAt = prev == null ? undefined : prev.firstQueuedAt;
  const prevAttempts = Number.isFinite(priorAttempts) ? priorAttempts : 0;
  const attempts = prevAttempts + 1;
  return {
    ...stripRetry(payload),
    _retry: {
      attempts,
      nextAttemptAt: now + backoffDelay(attempts),
      firstQueuedAt: Number.isFinite(priorFirstQueuedAt) ? priorFirstQueuedAt : now,
    },
  };
}

// The payload as the server must see it. ALWAYS call this on the way into the POST body — `_retry`
// is a local bookkeeping key and the ingest route rejects the whole report over one unknown
// top-level field. See the box at the top of this file.
export function stripRetry(payload) {
  if (payload === null || typeof payload !== 'object') return payload;
  const { _retry, ...rest } = payload;
  return rest;
}

// Has this file been failing long enough to give up on?
//
// Keyed off `_retry.firstQueuedAt` and NOT off file mtime, and that is the whole point. prune.mjs
// deletes on mtime (lib/prune.mjs:22-23) — but recording a retry REWRITES the queue file, which
// refreshes its mtime. A file that fails forever would therefore be touched every flush, never grow
// older than a few minutes by prune's reckoning, and become immortal: the one file in the queue that
// can never be deleted would be the one file that can never be sent. `firstQueuedAt` is copied
// forward across rewrites and is the only age that survives them.
//
// A payload with no `_retry` has never failed, so there is no recorded age and this returns false;
// prune.mjs's mtime rule is correct for those files precisely because nothing ever rewrites them.
export function isExpired(payload, now = Date.now(), maxAgeMs = MAX_QUEUE_AGE_MS) {
  const retry = payload == null ? undefined : payload._retry;
  const first = retry == null ? undefined : retry.firstQueuedAt;
  if (!Number.isFinite(first)) return false;
  return now - first > maxAgeMs;
}
