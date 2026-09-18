import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTurnOutcome, TURN_STATUS } from '../lib/turn-outcome-cursor.mjs';

// DATA-08: the `stop` payload says how the turn ended and how many loops it took, and the bare stop
// marker threw both away.
//
// The rule that shapes every case below: a turn outcome is what the HOST said, narrowed to an
// allowlist. It is not a tool failure, it is not a rate limit, and a status nobody recognises is
// `unknown` rather than a guess at which of the four it resembles.

test('the four allowed statuses pass through', () => {
  assert.deepEqual([...TURN_STATUS], ['completed', 'aborted', 'error', 'unknown']);
  for (const status of TURN_STATUS) {
    assert.equal(normalizeTurnOutcome({ status }).status, status);
  }
});

test('case and surrounding space do not change the outcome', () => {
  assert.equal(normalizeTurnOutcome({ status: '  Completed ' }).status, 'completed');
  assert.equal(normalizeTurnOutcome({ status: 'ABORTED' }).status, 'aborted');
});

test('an unrecognised status is unknown, never mapped onto a neighbour', () => {
  // `cancelled` looks like `aborted` and `failed` looks like `error`. Both are guesses about a
  // vocabulary nobody has captured, and a guess here is indistinguishable downstream from an
  // observation.
  for (const status of ['cancelled', 'failed', 'success', 'ok', 'rate_limited', 'timeout', '']) {
    assert.equal(normalizeTurnOutcome({ status }).status, 'unknown', `status: ${status}`);
  }
});

test('a non-string status is unknown rather than coerced', () => {
  for (const status of [0, 1, true, false, null, {}, ['completed']]) {
    assert.equal(normalizeTurnOutcome({ status, loop_count: 1 }).status, 'unknown');
  }
});

test('a failed status is a turn outcome, never a rate-limit signal', () => {
  const outcome = normalizeTurnOutcome({ status: 'error', loop_count: 2 });
  assert.deepEqual(Object.keys(outcome).sort(), ['loopCount', 'status']);
  assert.equal(outcome.status, 'error');
});

test('loop_count is carried when it is a finite non-negative integer', () => {
  assert.equal(normalizeTurnOutcome({ status: 'completed', loop_count: 0 }).loopCount, 0);
  assert.equal(normalizeTurnOutcome({ status: 'completed', loop_count: 7 }).loopCount, 7);
  assert.equal(normalizeTurnOutcome({ status: 'completed', loopCount: 7 }).loopCount, 7);
});

test('a malformed loop count is omitted rather than repaired', () => {
  for (const loop_count of [-1, 1.5, NaN, Infinity, -Infinity, '3', null, {}, []]) {
    const outcome = normalizeTurnOutcome({ status: 'completed', loop_count });
    assert.equal('loopCount' in outcome, false, `loop_count: ${String(loop_count)}`);
  }
});

test('a payload that says nothing about the turn is null', () => {
  for (const payload of [null, undefined, 'stop', 42, [], {}, { session_id: 's1' }]) {
    assert.equal(normalizeTurnOutcome(payload), null, `payload: ${JSON.stringify(payload)}`);
  }
});

test('a loop count alone is still an outcome, with an unknown status', () => {
  assert.deepEqual(normalizeTurnOutcome({ loop_count: 3 }), { status: 'unknown', loopCount: 3 });
});

test('nothing but the two allowlisted fields ever comes out', () => {
  // The real payload carries free text, an email and whatever the host felt like adding. None of it
  // is an outcome, and an unbounded string on a validated wire field fails the whole report.
  const outcome = normalizeTurnOutcome({
    status: 'error',
    loop_count: 2,
    error: 'x'.repeat(10000),
    message: 'the model said something',
    user_email: 'someone@example.com',
    input_tokens: 19570,
  });
  assert.deepEqual(outcome, { status: 'error', loopCount: 2 });
  assert.equal(JSON.stringify(outcome).includes('example.com'), false);
  assert.equal(JSON.stringify(outcome).length < 100, true);
});

test('normalizing the same stop twice gives the same answer — a duplicate stop is idempotent', () => {
  const payload = { status: 'completed', loop_count: 4 };
  assert.deepEqual(normalizeTurnOutcome(payload), normalizeTurnOutcome({ ...payload }));
});
