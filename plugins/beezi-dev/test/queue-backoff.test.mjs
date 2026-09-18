import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDue,
  recordFailure,
  stripRetry,
  isExpired,
  backoffDelay,
  isRetryableStatus,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_QUEUE_AGE_MS,
} from '../lib/queue-backoff.mjs';

// A queue payload as checkpoint.mjs writes one (trimmed to the fields that matter here).
const PAYLOAD = Object.freeze({
  segmentId: 'conv-1:100-150',
  sessionId: 'conv-1',
  remote: 'github.com/acme/app',
  branch: 'dev',
  from_line: 100,
  to_line: 150,
  token_total: 12,
});

const T0 = 1_700_000_000_000;

// ─── isDue ──────────────────────────────────────────────────────────────────

test('a payload that has never failed is due', () => {
  assert.equal(isDue(PAYLOAD, T0), true);
});

test('a payload whose backoff has not elapsed is not due', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.equal(isDue(failed, T0), false);
  assert.equal(isDue(failed, T0 + BASE_DELAY_MS - 1), false);
});

test('a payload becomes due again once nextAttemptAt arrives', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.equal(isDue(failed, T0 + BASE_DELAY_MS), true);
  assert.equal(isDue(failed, T0 + BASE_DELAY_MS + 60_000), true);
});

test('a corrupt or missing nextAttemptAt is treated as due', () => {
  assert.equal(isDue({ ...PAYLOAD, _retry: {} }, T0), true);
  assert.equal(isDue({ ...PAYLOAD, _retry: { nextAttemptAt: 'soon' } }, T0), true);
  assert.equal(isDue({ ...PAYLOAD, _retry: { nextAttemptAt: null } }, T0), true);
  assert.equal(isDue(null, T0), true);
});

test('an impossible far-future deadline is treated as due, not as a permanent block', () => {
  // The clock jumped forward (NTP correction after a VM resume, a dual-boot RTC offset) while the
  // failure was recorded. `firstQueuedAt` came from the same wrong clock, so the 14-day drop cannot
  // rescue this file either — the only escape is refusing to believe a deadline we never write.
  const skewed = { ...PAYLOAD, _retry: { attempts: 1, nextAttemptAt: T0 + 400 * 24 * 3600_000, firstQueuedAt: T0 } };
  assert.equal(isDue(skewed, T0), true);
});

// ─── recordFailure ──────────────────────────────────────────────────────────

test('the first failure stamps attempts, nextAttemptAt and firstQueuedAt', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.deepEqual(failed._retry, {
    attempts: 1,
    nextAttemptAt: T0 + BASE_DELAY_MS,
    firstQueuedAt: T0,
  });
});

test('recordFailure does not mutate its input', () => {
  const input = { ...PAYLOAD };
  const failed = recordFailure(input, T0);
  assert.equal(input._retry, undefined);
  assert.notEqual(failed, input);
});

test('recordFailure preserves every report field', () => {
  assert.deepEqual(stripRetry(recordFailure(PAYLOAD, T0)), PAYLOAD);
});

test('successive failures back off exponentially and firstQueuedAt never moves', () => {
  let p = PAYLOAD;
  let at = T0;
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    p = recordFailure(p, at);
    delays.push(p._retry.nextAttemptAt - at);
    at = p._retry.nextAttemptAt;
  }
  assert.deepEqual(delays, [
    30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
  ]);
  assert.deepEqual(p._retry.attempts, 8);
  assert.equal(p._retry.firstQueuedAt, T0, 'the give-up clock must not restart on every retry');
});

test('the backoff is capped at 30 minutes', () => {
  assert.equal(backoffDelay(1), BASE_DELAY_MS);
  assert.equal(backoffDelay(99), MAX_DELAY_MS);
  assert.equal(backoffDelay(1e9), MAX_DELAY_MS);
  assert.ok(Number.isFinite(backoffDelay(Number.MAX_SAFE_INTEGER)));
  // Garbage from disk must degrade to the base delay, not to NaN.
  assert.equal(backoffDelay(undefined), BASE_DELAY_MS);
  assert.equal(backoffDelay(0), BASE_DELAY_MS);
  assert.equal(backoffDelay(-5), BASE_DELAY_MS);
});

test('a corrupt attempts count restarts the ladder instead of producing NaN', () => {
  const failed = recordFailure({ ...PAYLOAD, _retry: { attempts: 'lots' } }, T0);
  assert.equal(failed._retry.attempts, 1);
  assert.equal(failed._retry.nextAttemptAt, T0 + BASE_DELAY_MS);
});

// ─── stripRetry — the ValidationPipe trap ───────────────────────────────────

test('stripRetry removes _retry so the whitelist validator cannot 400 the report', () => {
  // The ingest route runs a global ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }):
  // ONE unknown top-level key rejects the entire report, not the key. checkpoint.mjs already lost
  // every report to exactly this (token_cache_read / token_cache_write). `_retry` may never reach
  // the wire.
  const failed = recordFailure(PAYLOAD, T0);
  assert.ok('_retry' in failed);

  const body = stripRetry(failed);
  assert.equal('_retry' in body, false);
  assert.equal(Object.keys(body).includes('_retry'), false);
  assert.equal(JSON.stringify(body).includes('_retry'), false);
  assert.deepEqual(body, PAYLOAD);
});

test('stripRetry survives repeated failures — no _retry ever accumulates', () => {
  let p = PAYLOAD;
  for (let i = 0; i < 5; i += 1) p = recordFailure(p, T0 + i * 1_000_000);
  assert.deepEqual(stripRetry(p), PAYLOAD);
});

test('stripRetry is a no-op on a payload that never failed, and never throws', () => {
  assert.deepEqual(stripRetry(PAYLOAD), PAYLOAD);
  assert.equal(stripRetry(null), null);
  assert.equal(stripRetry(undefined), undefined);
});

// ─── isExpired — keyed off firstQueuedAt, never mtime ───────────────────────

test('a file failing for less than 14 days is kept', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.equal(isExpired(failed, T0 + MAX_QUEUE_AGE_MS - 1), false);
});

test('a file failing for more than 14 days is dropped', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.equal(isExpired(failed, T0 + MAX_QUEUE_AGE_MS + 1), true);
});

test('the give-up clock survives rewrites — a perpetually-failing file cannot become immortal', () => {
  // prune.mjs deletes on mtime, and rewriting the queue file to record a retry REFRESHES mtime. A
  // file that fails every hour for two weeks would look brand new to prune forever. firstQueuedAt is
  // the only age that survives the rewrite, so it is the one that decides.
  let p = PAYLOAD;
  let at = T0;
  const hour = 3600_000;
  for (let i = 0; i < 24 * 15; i += 1) {
    p = recordFailure(p, at);
    at += hour; // each iteration is a rewrite, i.e. a fresh mtime
  }
  assert.equal(p._retry.firstQueuedAt, T0);
  assert.equal(isExpired(p, at), true, '15 days of hourly retries must expire');
});

test('a payload that has never failed has no recorded age and is not expired', () => {
  // Nothing rewrites these files, so prune.mjs's mtime rule is correct for them.
  assert.equal(isExpired(PAYLOAD, T0 + MAX_QUEUE_AGE_MS * 10), false);
  assert.equal(isExpired({ ...PAYLOAD, _retry: {} }, T0), false);
  assert.equal(isExpired(null, T0), false);
});

test('isExpired honours a caller-supplied max age', () => {
  const failed = recordFailure(PAYLOAD, T0);
  assert.equal(isExpired(failed, T0 + 5_000, 1_000), true);
  assert.equal(isExpired(failed, T0 + 500, 1_000), false);
});

// ─── isRetryableStatus ──────────────────────────────────────────────────────

test('retryable statuses match the set flushQueue already applies', () => {
  for (const status of [401, 403, 408, 425, 429, 500, 502, 503, 504, 599]) {
    assert.equal(isRetryableStatus(status), true, `${status} must be retryable`);
  }
  for (const status of [200, 201, 204, 400, 404, 409, 410, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not be retryable`);
  }
});
