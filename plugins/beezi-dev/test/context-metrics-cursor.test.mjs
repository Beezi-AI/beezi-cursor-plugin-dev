import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceContextMetrics,
  reduceEffortBuckets,
  normalizeEffort,
  KNOWN_EFFORTS,
  UNKNOWN_EFFORT,
} from '../lib/context-metrics-cursor.mjs';

// DATA-01 / DATA-02: peak and final context, and the per-model effort split.
//
// ── FIXTURE SEMANTICS, AND THE ASSUMPTION THEY GATE ─────────────────────────────────────────────
// Every record below spells a Cursor `stop` / `afterAgentResponse` generation the way
// lib/sidecar-events.mjs writes it: `token_input`, `token_output`, `token_cache_read`,
// `token_cache_write`, keyed to a `gen_id`.
//
// These fixtures TREAT THOSE FOUR FIELDS AS PER-GENERATION COUNTS — what this one turn sent and
// received — and NOT as a cumulative account or conversation total. That reading is what makes
// `token_input + token_cache_read + token_cache_write` a context size at all: the three are assumed
// to be DISJOINT components of one prompt (fresh input, replayed cache, newly written cache), so
// adding them describes the window the model saw rather than double-counting it.
//
// THIS IS AN ASSUMPTION, NOT AN OBSERVATION. It is consistent with the aiserver.v1.TokenUsage shape
// Cursor sends and with how the delta engine has always summed these fields (a cumulative reading
// would have made every reported total grow quadratically, which is not what the field reports look
// like) — but nobody has run this against a real Cursor install and confirmed the semantics with a
// sanitized capture. Until that capture exists:
//   • no context metric may be EMITTED to the backend (the emission gate is DATA-09 anyway);
//   • an incomplete snapshot is OMITTED rather than zero-filled, so a build with different
//     semantics degrades to "no answer" instead of a confident wrong one;
//   • this comment is the record of what would have to be re-checked if the numbers look wrong.
// Closing evidence: one sanitized stop/generation capture from a real install showing the four
// counters for a turn whose prompt size is known independently.

const gen = (fields) => ({ ev: 'gen', model: 'gpt-5', ...fields });
const full = (gen_id, input, out, read, write, extra = {}) => gen({
  gen_id,
  token_input: input,
  token_output: out,
  token_cache_read: read,
  token_cache_write: write,
  ...extra,
});

// ---------------------------------------------------------------------------
// reduceContextMetrics
// ---------------------------------------------------------------------------

test('no generations at all means no metric', () => {
  assert.equal(reduceContextMetrics([]), null);
  assert.equal(reduceContextMetrics(null), null);
  assert.equal(reduceContextMetrics('nope'), null);
});

test('context is input plus both cache directions', () => {
  const metrics = reduceContextMetrics([full('g1', 100, 10, 40, 2)]);
  assert.deepEqual(metrics, { peak: 142, final: 142 });
});

test('an unknown input count omits the snapshot rather than reading it as zero', () => {
  // The whole point of the omission: a build that does not report input would otherwise produce a
  // confident "context: 42" out of two cache fields.
  assert.equal(reduceContextMetrics([gen({ gen_id: 'g1', token_cache_read: 40, token_cache_write: 2 })]), null);
  assert.equal(reduceContextMetrics([gen({ gen_id: 'g1', token_input: 100, token_cache_read: 40 })]), null);
  assert.equal(reduceContextMetrics([gen({ gen_id: 'g1' })]), null);
});

test('a genuinely zero context is a snapshot, not an absence', () => {
  assert.deepEqual(reduceContextMetrics([full('g1', 0, 0, 0, 0)]), { peak: 0, final: 0 });
});

test('negative, fractional and non-finite counters disqualify a snapshot', () => {
  for (const bad of [-1, NaN, Infinity, '100', null]) {
    assert.equal(reduceContextMetrics([full('g1', bad, 0, 0, 0)]), null, `input: ${String(bad)}`);
    assert.equal(reduceContextMetrics([full('g1', 10, 0, bad, 0)]), null, `cache_read: ${String(bad)}`);
  }
});

test('peak is the largest complete snapshot, final is the latest one', () => {
  const metrics = reduceContextMetrics([
    full('g1', 100, 1, 0, 0, { ts: 1 }),
    full('g2', 900, 1, 0, 0, { ts: 2 }),
    full('g3', 300, 1, 0, 0, { ts: 3 }),
  ]);
  assert.deepEqual(metrics, { peak: 900, final: 300 });
});

test('out-of-order timestamps are ordered before final is taken', () => {
  const metrics = reduceContextMetrics([
    full('g3', 300, 1, 0, 0, { ts: 3 }),
    full('g1', 100, 1, 0, 0, { ts: 1 }),
    full('g2', 900, 1, 0, 0, { ts: 2 }),
  ]);
  assert.deepEqual(metrics, { peak: 900, final: 300 });
});

test('repeated lines for one generation are merged, largest count per field', () => {
  // A generation writes eleven lines; only the turn-end one carries counts, and Cursor may report a
  // turn's usage more than once as it grows. Same rule the delta engine bills on.
  const metrics = reduceContextMetrics([
    gen({ gen_id: 'g1', ts: 1 }),
    full('g1', 100, 10, 40, 2, { ts: 2 }),
    full('g1', 120, 12, 50, 2, { ts: 3 }),
  ]);
  assert.deepEqual(metrics, { peak: 172, final: 172 });
});

test('two generations are two snapshots, never a sum', () => {
  // Context is a level, not a total. Summing the snapshots would report a 300k context for two
  // ordinary turns.
  const metrics = reduceContextMetrics([full('g1', 100, 0, 0, 0, { ts: 1 }), full('g2', 150, 0, 0, 0, { ts: 2 })]);
  assert.deepEqual(metrics, { peak: 150, final: 150 });
});

test('final comes from the latest generation that names a model', () => {
  const metrics = reduceContextMetrics([
    full('g1', 100, 0, 0, 0, { ts: 1 }),
    { ev: 'gen', gen_id: 'g2', ts: 2, token_input: 999, token_output: 0, token_cache_read: 0, token_cache_write: 0 },
  ]);
  // The nameless line is still a COMPLETE snapshot, so it counts towards the peak — the counters
  // were observed whether or not the host said which model reported them. It cannot be the final
  // one, because `final` is read beside a model everywhere it is shown.
  assert.deepEqual(metrics, { peak: 999, final: 100 });
});

test('a model change mid-session does not reset the peak', () => {
  const metrics = reduceContextMetrics([
    full('g1', 900, 0, 0, 0, { ts: 1 }),
    { ...full('g2', 100, 0, 0, 0, { ts: 2 }), model: 'claude-4.5-sonnet' },
  ]);
  assert.deepEqual(metrics, { peak: 900, final: 100 });
});

// ---------------------------------------------------------------------------
// reduceEffortBuckets
// ---------------------------------------------------------------------------

test('no proven effort vocabulary exists yet, so nothing is normalized into one', () => {
  // DATA-02: variant spellings alone do not prove a reasoning-effort vocabulary. The allowlist is
  // empty on purpose and a fixture is what fills it.
  assert.deepEqual([...KNOWN_EFFORTS], []);
  assert.deepEqual(normalizeEffort('max'), { effort: 'max', known: false });
  assert.deepEqual(normalizeEffort('  high  '), { effort: 'high', known: false });
  assert.deepEqual(normalizeEffort(''), { effort: UNKNOWN_EFFORT, known: false });
  assert.deepEqual(normalizeEffort(undefined), { effort: UNKNOWN_EFFORT, known: false });
  assert.deepEqual(normalizeEffort({ level: 'high' }), { effort: UNKNOWN_EFFORT, known: false });
});

test('an unrecognized effort is preserved raw and NEVER relabeled medium', () => {
  const buckets = reduceEffortBuckets([gen({ gen_id: 'g1', effort: 'ludicrous' })]);
  assert.deepEqual(Object.keys(buckets['gpt-5']), ['ludicrous']);
  assert.equal(buckets['gpt-5'].ludicrous.known, false);
  assert.equal('medium' in buckets['gpt-5'], false);
});

test('a generation with no effort label lands in the unknown bucket, not in a guessed tier', () => {
  const buckets = reduceEffortBuckets([gen({ gen_id: 'g1' })]);
  assert.deepEqual(Object.keys(buckets['gpt-5']), [UNKNOWN_EFFORT]);
  assert.equal(buckets['gpt-5'][UNKNOWN_EFFORT].requests, 1);
});

test('a model variant is not an effort — it must not become a bucket', () => {
  const buckets = reduceEffortBuckets([gen({ gen_id: 'g1', model_variant: 'gpt-5-max' })]);
  assert.deepEqual(Object.keys(buckets['gpt-5']), [UNKNOWN_EFFORT]);
});

test('an empty input is an empty record, not null', () => {
  assert.deepEqual(reduceEffortBuckets([]), {});
  assert.deepEqual(reduceEffortBuckets(null), {});
});

test('requests, tokens and cost conserve against the model total', () => {
  const generations = [
    full('g1', 100, 10, 40, 2, { effort: 'high', billing_pool: 'credits', cost_usd: 0.42 }),
    full('g2', 50, 5, 20, 1, { effort: 'high', billing_pool: 'subscription' }),
    full('g3', 30, 3, 10, 0, { billing_pool: 'subscription' }),
    { ...full('g4', 7, 1, 0, 0, { effort: 'low', billing_pool: 'subscription' }), model: 'claude-4.5-sonnet' },
  ];
  const buckets = reduceEffortBuckets(generations);

  const sum = (model, field) => Object.values(buckets[model]).reduce((acc, b) => acc + b[field], 0);
  assert.equal(sum('gpt-5', 'requests'), 3);
  assert.equal(sum('gpt-5', 'token_input'), 180);
  assert.equal(sum('gpt-5', 'token_output'), 18);
  assert.equal(sum('gpt-5', 'token_cache_read'), 70);
  assert.equal(sum('gpt-5', 'token_cache_write'), 3);
  assert.equal(Math.round(sum('gpt-5', 'cost_usd') * 100) / 100, 0.42);
  assert.equal(sum('claude-4.5-sonnet', 'requests'), 1);
});

test('the (model, pool) split survives the effort split', () => {
  const buckets = reduceEffortBuckets([
    full('g1', 10, 0, 0, 0, { effort: 'high', billing_pool: 'credits', cost_usd: 0.42 }),
    full('g2', 10, 0, 0, 0, { effort: 'high', billing_pool: 'subscription' }),
    full('g3', 10, 0, 0, 0, { effort: 'low', billing_pool: 'credits', cost_usd: 0.1 }),
  ]);
  const high = buckets['gpt-5'].high;
  const low = buckets['gpt-5'].low;
  assert.equal(high.pools.credits.requests, 1);
  assert.equal(high.pools.credits.cost_usd, 0.42);
  assert.equal(high.pools.subscription.requests, 1);
  assert.equal(high.pools.subscription.cost_usd, 0);
  assert.equal(low.pools.credits.requests, 1);
  // Per (model, pool), across every effort bucket: exactly the counts the parent rows carry.
  const perPool = (pool) => Object.values(buckets['gpt-5'])
    .reduce((acc, b) => acc + (b.pools[pool] == null ? 0 : b.pools[pool].requests), 0);
  assert.equal(perPool('credits'), 2);
  assert.equal(perPool('subscription'), 1);
});

test('a generation with no pool is bucketed as unknown rather than assumed seat-covered', () => {
  const buckets = reduceEffortBuckets([full('g1', 10, 0, 0, 0, {})]);
  assert.deepEqual(Object.keys(buckets['gpt-5'][UNKNOWN_EFFORT].pools), ['unknown']);
});

test('repeated lines for one generation are one request with the largest counts', () => {
  const buckets = reduceEffortBuckets([
    gen({ gen_id: 'g1', effort: 'high' }),
    full('g1', 100, 10, 0, 0, { effort: 'high' }),
    full('g1', 120, 12, 0, 0, { effort: 'high' }),
  ]);
  const high = buckets['gpt-5'].high;
  assert.equal(high.requests, 1, 'eleven lines are one generation, not eleven requests');
  assert.equal(high.token_input, 120);
});

test('a generation without an id is its own request', () => {
  const buckets = reduceEffortBuckets([gen({ effort: 'high' }), gen({ effort: 'high' })]);
  assert.equal(buckets['gpt-5'].high.requests, 2);
});

test('a generation with no model name buckets under unknown rather than vanishing', () => {
  const buckets = reduceEffortBuckets([{ ev: 'gen', gen_id: 'g1', effort: 'high' }]);
  assert.equal(buckets.unknown.high.requests, 1);
});

test('missing and zero counters are both reported as zero contributions, never as absent tokens', () => {
  const buckets = reduceEffortBuckets([gen({ gen_id: 'g1', effort: 'high' }), full('g2', 0, 0, 0, 0, { effort: 'high' })]);
  assert.equal(buckets['gpt-5'].high.requests, 2);
  assert.equal(buckets['gpt-5'].high.token_input, 0);
});

test('an effort label that changes between two lines of one generation keeps the first', () => {
  // One generation ran at one setting. A later line disagreeing is a host inconsistency, and moving
  // the request between buckets would make the two sums depend on read order.
  const buckets = reduceEffortBuckets([
    full('g1', 10, 0, 0, 0, { effort: 'high' }),
    full('g1', 20, 0, 0, 0, { effort: 'low' }),
  ]);
  assert.equal(buckets['gpt-5'].high.requests, 1);
  assert.equal(buckets['gpt-5'].high.token_input, 20);
  assert.equal('low' in buckets['gpt-5'], false);
});
