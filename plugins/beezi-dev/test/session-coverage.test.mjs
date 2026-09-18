import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCoverage,
  planCoverageBatches,
  halfOpenPrefix,
  MAX_COVERAGE_IDS,
  SPARSE_ZERO_CONFIRMED,
} from '../lib/session-coverage.mjs';

// How far Beezi already reaches into each session, in THIS plugin's raw-line coordinates.
//
// Every assertion here exists because the alternative silently double-bills. A coverage answer the
// client half-believes is worse than none: it authorizes a resend of lines the server already
// holds under a different segmentId, which its idempotency key cannot collapse. So the module has
// exactly two answers — a Map that was fully validated, or `null` meaning "do not send".

function fakePost(replies) {
  const calls = [];
  let i = 0;
  const impl = async (url, token, body, deps) => {
    calls.push({ url, token, body, deps });
    const reply = typeof replies === 'function' ? replies(body, calls.length) : replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply.throws) throw new Error('network');
    return {
      status: reply.status == null ? 200 : reply.status,
      json: async () => {
        if (reply.unparseable) throw new Error('bad json');
        return reply.body;
      },
    };
  };
  return { impl, calls };
}

const ok = (coverage) => ({ status: 200, body: { coverage } });

// ─── batching ───────────────────────────────────────────────────────────────

test('batches at 200 ids', () => {
  const ids = Array.from({ length: 450 }, (_u, i) => `s${i}`);

  const batches = planCoverageBatches(ids);

  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50]);
  assert.equal(MAX_COVERAGE_IDS, 200);
});

test('the batch size is a caller option', async () => {
  const post = fakePost([ok({ a: 1 }), ok({ b: 2 })]);

  const coverage = await fetchCoverage(['a', 'b'], 'tok', { postJsonImpl: post.impl }, { batchSize: 1 });

  assert.equal(post.calls.length, 2);
  assert.deepEqual([...coverage], [['a', 1], ['b', 2]]);
});

test('no ids means no request and an empty answer', async () => {
  const post = fakePost([ok({})]);

  const coverage = await fetchCoverage([], 'tok', { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 0);
  assert.equal(coverage.size, 0);
});

test('a non-array argument is refused outright', async () => {
  const post = fakePost([ok({})]);

  assert.equal(await fetchCoverage(null, 'tok', { postJsonImpl: post.impl }), null);
  assert.equal(await fetchCoverage('s1', 'tok', { postJsonImpl: post.impl }), null);
  assert.equal(post.calls.length, 0);
});

test('posts the session ids to the coverage route', async () => {
  const post = fakePost([ok({ s1: 3 })]);

  await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl });

  assert.match(post.calls[0].url, /\/sessions\/coverage$/);
  assert.deepEqual(post.calls[0].body, { sessionIds: ['s1'] });
  assert.equal(post.calls[0].token, 'tok');
});

// ─── half-open, source-aware prefix ─────────────────────────────────────────

test('half-open intervals [0,2),[3,4) reach prefix 2, not 4', () => {
  // The portal advances inclusive-style coverage unless fromLine > reached + 1, which would call
  // this 4 and skip raw line 2 forever. Cursor's delta indexes half-open [from,to) windows, so the
  // contiguous prefix stops at the first hole.
  assert.equal(halfOpenPrefix([[0, 2], [3, 4]]), 2);
});

test('contiguous and overlapping half-open intervals coalesce', () => {
  assert.equal(halfOpenPrefix([[0, 2], [2, 5]]), 5);
  assert.equal(halfOpenPrefix([[0, 4], [2, 9]]), 9);
  assert.equal(halfOpenPrefix([[3, 9], [0, 3]]), 9);
});

test('a prefix that does not start at line 0 is zero', () => {
  assert.equal(halfOpenPrefix([[1, 5]]), 0);
});

test('malformed intervals make the whole answer unusable', () => {
  assert.equal(halfOpenPrefix([[0, 2], [2]]), null);
  assert.equal(halfOpenPrefix([[0, 0]]), null);
  assert.equal(halfOpenPrefix([[2, 1]]), null);
  assert.equal(halfOpenPrefix([[0, 1.5]]), null);
  assert.equal(halfOpenPrefix([[-1, 4]]), null);
  assert.equal(halfOpenPrefix('nope'), null);
});

test('an interval record is read through the same half-open rule', async () => {
  const post = fakePost([ok({ s1: { source: 'cursor', intervals: [[0, 2], [3, 4]] } })]);

  const coverage = await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl });

  assert.equal(coverage.get('s1'), 2);
});

test('a record from another source is not Cursor coverage and is left out entirely', async () => {
  const post = fakePost([ok({ s1: { source: 'claude-code', intervals: [[0, 99]] }, s2: 4 })]);

  const coverage = await fetchCoverage(['s1', 's2'], 'tok', { postJsonImpl: post.impl });

  assert.equal(coverage.has('s1'), false);
  assert.equal(coverage.get('s2'), 4);
});

// ─── strict validation ──────────────────────────────────────────────────────

test('zero is a real answer, not a missing one', async () => {
  const post = fakePost([ok({ s1: 0 })]);

  const coverage = await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl });

  assert.equal(coverage.get('s1'), 0);
});

test('a requested id absent from the response is absent from the Map', async () => {
  const post = fakePost([ok({ s1: 5 })]);

  const coverage = await fetchCoverage(['s1', 's2'], 'tok', { postJsonImpl: post.impl });

  assert.equal(coverage.get('s1'), 5);
  assert.equal(coverage.has('s2'), false);
  // Absence must never be read as zero until the deployed contract guarantees sparse-zero
  // semantics; the flag is the record that it does not.
  assert.equal(SPARSE_ZERO_CONFIRMED, false);
});

for (const [label, value] of [
  ['a negative value', -1],
  ['a fractional value', 2.5],
  ['an infinite value', Number.POSITIVE_INFINITY],
  ['a NaN', Number.NaN],
  ['a numeric string', '4'],
  ['a boolean', true],
  ['null', null],
  ['an array', [0, 4]],
  ['an object with no recognized shape', { reached: 4 }],
  ['an interval record with no source', { intervals: [[0, 4]] }],
]) {
  test(`${label} makes the whole answer null`, async () => {
    const post = fakePost([ok({ s1: value })]);

    assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null);
  });
}

test('coverage for a session nobody asked about makes the whole answer null', async () => {
  const post = fakePost([ok({ s1: 1, intruder: 9 })]);

  assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null);
});

test('a 2xx body that is not the documented shape is null, never "no coverage"', async () => {
  for (const body of [null, {}, { coverage: null }, { coverage: [] }, { coverage: 'none' }, []]) {
    const post = fakePost([{ status: 200, body }]);
    assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null, JSON.stringify(body));
  }
});

test('an unparseable body is null', async () => {
  const post = fakePost([{ status: 200, unparseable: true }]);

  assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null);
});

test('a non-2xx status is null — including the 404 of a server without the route', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    const post = fakePost([{ status, body: { coverage: {} } }]);
    assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null, String(status));
  }
});

test('a thrown request is null', async () => {
  const post = fakePost([{ throws: true }]);

  assert.equal(await fetchCoverage(['s1'], 'tok', { postJsonImpl: post.impl }), null);
});

test('one bad batch discards every good batch before it', async () => {
  const post = fakePost([ok({ s1: 1 }), { status: 500, body: {} }]);

  const coverage = await fetchCoverage(['s1', 's2'], 'tok', { postJsonImpl: post.impl }, { batchSize: 1 });

  assert.equal(coverage, null);
});

test('a bad batch stops the run instead of asking for the rest', async () => {
  const post = fakePost([{ status: 500, body: {} }, ok({ s2: 1 })]);

  await fetchCoverage(['s1', 's2'], 'tok', { postJsonImpl: post.impl }, { batchSize: 1 });

  assert.equal(post.calls.length, 1);
});
