// Context size and per-effort aggregates, derived from generation evidence. Pure: no filesystem, no
// clock, no host calls — everything it knows arrives in the array.
//
// WHAT A CONTEXT NUMBER MEANS HERE. `token_input + token_cache_read + token_cache_write` for ONE
// generation, read as three disjoint components of one prompt: fresh input, replayed cache, newly
// written cache. That reading is an ASSUMPTION about Cursor's aiserver.v1.TokenUsage, not something
// anyone has confirmed against a real install (see the fixture note at the top of
// test/context-metrics-cursor.test.mjs, which records exactly what evidence would close it), and the
// metrics are therefore gated: nothing here reaches the wire until DATA-09 accepts the field AND a
// sanitized capture backs the semantics.
//
// Two rules follow from that gate and neither is negotiable:
//   • a snapshot missing any of the three counters is OMITTED, never zero-filled. Unknown input is
//     the exact case where a zero would manufacture a confident wrong answer out of two cache
//     fields.
//   • context is a LEVEL, not a total. Two generations are two snapshots; summing them would report
//     a 300k context for two ordinary turns.

// The four counters a Cursor turn-end line carries. Same spellings the sidecar writer uses and the
// delta engine bills on — one vocabulary, or the two disagree about what a turn cost.
const TOKEN_FIELDS = ['token_input', 'token_output', 'token_cache_read', 'token_cache_write'];

// The three that make up the context window. `token_output` is what the model wrote, not what it
// read, so it is deliberately not one of them.
const CONTEXT_FIELDS = ['token_input', 'token_cache_read', 'token_cache_write'];

const GEN_EVENTS = new Set(['gen', 'generation']);
const MODEL_FIELDS = ['model', 'model_name', 'modelName'];
// `model_variant` is NOT read as an effort anywhere in this module. A variant spelling
// ("kimi-k3-max") is evidence that Cursor priced a run differently, not evidence of a reasoning-tier
// vocabulary (DATA-02), and putting one in a bucket named "effort" would assert the tier the review
// explicitly refused to guess.
const EFFORT_FIELDS = ['effort', 'reasoning_effort', 'reasoningEffort'];

export const UNKNOWN_MODEL = 'unknown';
export const UNKNOWN_POOL = 'unknown';

// The bucket a generation lands in when the host said nothing about effort.
//
// Deliberately not `medium`: an unobserved setting is unknown, and defaulting it to the middle of a
// scale nobody has proven exists would put real requests into a tier they were never run at.
export const UNKNOWN_EFFORT = 'unknown';

// The proven effort vocabulary. EMPTY, and that is the finding rather than a placeholder: no host
// fixture establishes a reasoning-effort label set for Cursor, so no observed string is normalized
// into a canonical tier. Raw labels are preserved exactly as the host wrote them and carry
// `known: false`. Filling this list requires a sanitized capture showing the field and its values.
export const KNOWN_EFFORTS = Object.freeze([]);

function pickString(record, fields) {
  for (const field of fields) {
    const value = record == null ? undefined : record[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// A counter is usable only when it is a finite, non-negative whole number. A float, a numeric string
// or a NaN is a schema surprise, and a schema surprise must not become a measurement.
function counter(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value) === value ? value : null;
}

// The observed effort label, normalized only where a proven vocabulary says so.
export function normalizeEffort(raw) {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label === '') return { effort: UNKNOWN_EFFORT, known: false };
  const lower = label.toLowerCase();
  for (const known of KNOWN_EFFORTS) {
    if (known === lower) return { effort: known, known: true };
  }
  // Preserved verbatim — it is diagnostic evidence about what this host sends, and rewriting it is
  // how the evidence gets lost before anyone can read it.
  return { effort: label, known: false };
}

function isGeneration(record) {
  if (record == null || typeof record !== 'object') return false;
  const ev = record.ev;
  // A caller may hand over records it has already selected; only an explicit foreign `ev` is
  // rejected, so a plain `{ model, token_input, ... }` still counts.
  return typeof ev !== 'string' || GEN_EVENTS.has(ev);
}

// Collapse a stream of generation lines into one record per generation.
//
// A generation writes many lines — ten from postToolUse, one from the turn end — and only the last
// carries the counts. Merging by MAX per field is the same rule lib/delta-cursor.mjs bills on, and
// the two must stay identical: a context peak derived from a different merge than the billed tokens
// would disagree with the report it sits beside, for the same turn, with no way to tell which is
// right. A line without an id is its own generation, which is the delta's behaviour too.
//
// Order: by timestamp where one is given, input order otherwise, with an untimestamped line
// inheriting the position of the last timestamped one. Cursor's lines arrive in stream order and a
// resumed read can interleave, so "latest" has to be defined rather than assumed.
function mergeGenerations(records) {
  if (!Array.isArray(records)) return [];
  const ordered = [];
  let lastTs = -Infinity;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isGeneration(record)) continue;
    const raw = record.ts == null ? record.timestamp : record.ts;
    const ts = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (ts !== null) lastTs = ts;
    ordered.push({ record, sortKey: lastTs, index: i });
  }
  ordered.sort((a, b) => a.sortKey - b.sortKey || a.index - b.index);

  const merged = new Map();
  let anonymous = 0;
  for (const item of ordered) {
    const record = item.record;
    const model = pickString(record, MODEL_FIELDS);
    const genId = typeof record.gen_id === 'string' && record.gen_id !== '' ? record.gen_id : null;
    const key = genId === null
      ? `#${anonymous++}\u001f${model === null ? '' : model}`
      : `${genId}\u001f${model === null ? '' : model}`;
    let bucket = merged.get(key);
    if (bucket === undefined) {
      bucket = {
        model: model === null ? UNKNOWN_MODEL : model,
        // FIRST label wins. One generation ran at one setting; letting a later line move the
        // request between buckets would make the totals depend on read order.
        effort: normalizeEffort(pickString(record, EFFORT_FIELDS)),
        pool: pickString(record, ['billing_pool', 'billingPool']),
        requests: null,
        cost: 0,
        tokens: {},
        order: merged.size,
      };
      merged.set(key, bucket);
    }
    if (bucket.pool === null) bucket.pool = pickString(record, ['billing_pool', 'billingPool']);
    const requests = counter(record.requests);
    if (requests !== null) bucket.requests = (bucket.requests === null ? 0 : bucket.requests) + requests;
    if (typeof record.cost_usd === 'number' && Number.isFinite(record.cost_usd) && record.cost_usd > 0) {
      bucket.cost += record.cost_usd;
    }
    for (const field of TOKEN_FIELDS) {
      const value = counter(record[field]);
      if (value === null) continue;
      const prior = bucket.tokens[field];
      bucket.tokens[field] = Math.max(prior == null ? 0 : prior, value);
    }
  }
  return [...merged.values()].sort((a, b) => a.order - b.order);
}

// The context size of one merged generation, or null when the snapshot is incomplete.
function contextOf(generation) {
  let total = 0;
  for (const field of CONTEXT_FIELDS) {
    const value = generation.tokens[field];
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

// `{ peak, final }` over the complete snapshots in the window, or null when there are none.
//
// `peak` is the largest context any generation reported; `final` is the context of the LAST
// generation that both named a model and reported a complete snapshot — a line with no model is not
// a turn this can attribute, and a partial one is not a measurement.
export function reduceContextMetrics(generations) {
  const merged = mergeGenerations(generations);
  let peak = null;
  let final = null;
  for (const generation of merged) {
    const context = contextOf(generation);
    if (context === null) continue;
    if (peak === null || context > peak) peak = context;
    if (generation.model !== UNKNOWN_MODEL) final = context;
  }
  if (peak === null || final === null) return null;
  return { peak, final };
}

function emptyBucket(known) {
  return {
    requests: 0,
    cost_usd: 0,
    token_input: 0,
    token_output: 0,
    token_cache_read: 0,
    token_cache_write: 0,
    known,
    // The parent (model, pool) rows, kept inside the effort split so the money and the request
    // counts still add up per pool after the split — the pools divide the same requests, and an
    // effort breakdown that forgot them would report seat-covered spend as credits or the reverse.
    pools: {},
  };
}

// `{ [model]: { [effort]: bucket } }`, conserving requests, tokens and cost.
//
// CONSERVATION IS THE CONTRACT. Summing every effort bucket of a model reproduces that model's
// requests and tokens exactly, and summing `pools[p]` across the buckets reproduces the (model,
// pool) row the report already carries. Nothing is estimated, pro-rated or moved between buckets.
export function reduceEffortBuckets(generations) {
  const merged = mergeGenerations(generations);
  const out = {};
  for (const generation of merged) {
    const byEffort = out[generation.model] == null ? {} : out[generation.model];
    out[generation.model] = byEffort;
    const label = generation.effort.effort;
    const bucket = byEffort[label] == null ? emptyBucket(generation.effort.known) : byEffort[label];
    byEffort[label] = bucket;

    // One merged generation is one request unless the caller supplied a count of its own (the priced
    // `amount` a pool row carries, for instance). Lines are never requests.
    const requests = generation.requests === null ? 1 : generation.requests;
    bucket.requests += requests;
    bucket.cost_usd += generation.cost;
    for (const field of TOKEN_FIELDS) {
      const value = generation.tokens[field];
      if (value !== undefined) bucket[field] += value;
    }

    const pool = generation.pool === null ? UNKNOWN_POOL : generation.pool;
    const pools = bucket.pools[pool] == null ? { requests: 0, cost_usd: 0 } : bucket.pools[pool];
    bucket.pools[pool] = pools;
    pools.requests += requests;
    pools.cost_usd += generation.cost;
  }
  return out;
}
