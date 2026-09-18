import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta, BILLING_POOL, TOKEN_KEYS } from '../lib/delta-cursor.mjs';

// One window, several repositories. The repo lane plans the runs (lib/attribution-cursor.mjs); this
// file is the other half of that contract — the delta splitting its own arithmetic along them
// WITHOUT changing what the unsplit segment totals.
//
// The property under test everywhere below is conservation: re-summing the segments reproduces the
// unsplit delta exactly. A split that quietly gains or loses a request, a token or a second is a
// billing error that no dashboard can show, because both halves look plausible.

const CONV = 'conv-runs';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (sec) => T0 + sec * 1000;
const gen = (model, sec, fields = {}) => ({ ts: at(sec), ev: 'gen', model, ...fields });
const tool = (name, bytes, sec) => ({ ts: at(sec), ev: 'tool', tool: name, bytes });
const edit = (file, added, removed, sec) => ({ ts: at(sec), ev: 'edit', path: file, added, removed });
// A line the delta recognises as a line but attributes nothing to: the sidecar carries event kinds
// this arithmetic has no opinion about, and a run made only of them is the real "run with no work
// in it". It is a proper, non-zero-width range, which is the only shape the planner emits.
const noise = (sec) => ({ ts: at(sec), ev: 'other' });

function resolvers(events, usage = {}, extra = {}) {
  return { readEvents: () => events, readUsageData: () => usage, aiCodeTrackingDbFile: null, ...extra };
}

const run = (from, to, repoRoot, branch) => ({ from, to, repoRoot, branch });

// Sum a field across segments for one (model, pool) pair.
function requestsFor(segments, model, pool) {
  return segments.reduce((sum, seg) => sum + seg.entries
    .filter((e) => e.model === model && e.billing_pool === pool)
    .reduce((acc, e) => acc + e.requests, 0), 0);
}

function costFor(segments, model, pool) {
  return segments.reduce((sum, seg) => sum + seg.entries
    .filter((e) => e.model === model && e.billing_pool === pool)
    .reduce((acc, e) => acc + e.cost_usd, 0), 0);
}

// Every conservation law in one place, asserted against the delta's own unsplit totals.
function assertConserved(delta) {
  const segments = delta.segments;
  assert.ok(Array.isArray(segments) && segments.length > 0, 'segments must exist to be conserved');

  for (const entry of delta.entries) {
    assert.equal(
      requestsFor(segments, entry.model, entry.billing_pool),
      entry.requests,
      `requests for ${entry.model}/${entry.billing_pool}`,
    );
    assert.equal(
      Math.round(costFor(segments, entry.model, entry.billing_pool) * 100) / 100,
      entry.cost_usd,
      `cost for ${entry.model}/${entry.billing_pool}`,
    );
  }
  // No segment may invent a (model, pool) the unsplit delta does not have.
  for (const seg of segments) {
    for (const entry of seg.entries) {
      assert.ok(
        delta.entries.some((e) => e.model === entry.model && e.billing_pool === entry.billing_pool),
        `segment invented ${entry.model}/${entry.billing_pool}`,
      );
    }
  }

  if (delta.tokens === null) {
    assert.deepEqual(segments.filter((s) => s.tokens !== null), [], 'no segment may report tokens the window did not');
  } else {
    for (const field of TOKEN_KEYS) {
      const summed = segments.reduce(
        (sum, seg) => sum + (seg.tokens == null || seg.tokens[field] == null ? 0 : seg.tokens[field]),
        0,
      );
      assert.equal(summed, delta.tokens[field], `token field ${field}`);
    }
  }

  // Every token a segment reports must be carried by one of its own rows. A segment whose top-level
  // tokens exceed what its `models` account for is accepted by the ingest service and written
  // nowhere, which is the quietest way to lose a turn's counts.
  for (const seg of segments) {
    for (const field of TOKEN_KEYS) {
      const onRows = seg.entries.reduce((sum, e) => sum + (e[field] == null ? 0 : e[field]), 0);
      const onSegment = seg.tokens == null || seg.tokens[field] == null ? 0 : seg.tokens[field];
      assert.equal(onRows, onSegment, `${seg.segmentId} rows must carry ${field}`);
    }
  }

  assert.equal(
    segments.reduce((sum, seg) => sum + seg.duration_ms, 0),
    delta.duration_ms,
    'duration union',
  );
  assert.equal(
    segments.reduce((sum, seg) => sum + seg.est_tokens, 0),
    delta.est_tokens,
    'est_tokens',
  );
  assert.equal(
    segments.reduce((sum, seg) => sum + seg.operations.file.count + seg.operations.shell.count, 0),
    delta.operations.file.count + delta.operations.shell.count,
    'operation counts',
  );
  // Contiguous, gapless and exactly the consumed range.
  assert.equal(segments[0].from, delta.consumed.from);
  assert.equal(segments[segments.length - 1].to, delta.consumed.to);
  for (let i = 1; i < segments.length; i++) assert.equal(segments[i].from, segments[i - 1].to);
}

test('no attribution runs means no segments key — the split is opt-in', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5', 0), tool('read_file', 40, 1)]));
  assert.equal('segments' in delta, false);
});

test('one run covering the whole window reproduces the unsplit segment', () => {
  const events = [gen('gpt-5', 0), tool('read_file', 400, 1), edit('src/a.ts', 12, 3, 2)];
  const delta = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 1, costInCents: 42 } }, {
    attributionRuns: [run(0, 3, '/repo', 'main')],
  }));
  assert.equal(delta.segments.length, 1);
  const [seg] = delta.segments;
  assert.equal(seg.repoRoot, '/repo');
  assert.equal(seg.branch, 'main');
  assert.equal(seg.duration_ms, delta.duration_ms);
  assert.equal(seg.est_tokens, delta.est_tokens);
  assert.deepEqual(seg.code_changes.by_extension, delta.code_changes.by_extension);
  assertConserved(delta);
});

test('operations and code changes land in the run their own event belongs to', () => {
  const events = [
    tool('read_file', 400, 0),
    edit('src/a.ts', 10, 0, 1),
    tool('run_terminal_cmd', 80, 2),
    edit('src/b.ts', 5, 2, 3),
  ];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main'), run(2, 4, '/repo-b', 'dev')],
  }));
  const [a, b] = delta.segments;
  assert.equal(a.operations.file.count, 1);
  assert.equal(a.operations.shell.count, 0);
  assert.equal(b.operations.shell.count, 1);
  assert.equal(a.code_changes.lines_added, 10);
  assert.equal(b.code_changes.lines_added, 5);
  assert.equal(b.code_changes.lines_removed, 2);
  assertConserved(delta);
});

test("a generation's tokens are billed once, to its FINAL token-bearing line", () => {
  // The eleven lines one generation writes: only the turn-end one carries the counts, and it can
  // land in a different run than the line that opened the generation.
  const events = [
    gen('gpt-5', 0, { gen_id: 'g1' }),
    tool('read_file', 40, 1),
    gen('gpt-5', 2, { gen_id: 'g1', token_input: 100, token_output: 10 }),
    gen('gpt-5', 3, { gen_id: 'g1', token_input: 120, token_output: 12 }),
  ];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main'), run(2, 4, '/repo-b', 'dev')],
  }));
  const [a, b] = delta.segments;
  assert.equal(a.tokens, null, 'the opening line carried no counts, so it bills none');
  assert.deepEqual(b.tokens, { token_input: 120, token_output: 12, token_cache_read: 0, token_cache_write: 0 });
  // One generation, one request — counted where it began, never twice.
  assert.equal(requestsFor(delta.segments, 'gpt-5', BILLING_POOL.SUBSCRIPTION), 1);
  assert.equal(a.entries.length, 1);
  // And run B gets a ZERO-REQUEST row for the same model, because its tokens landed here and a
  // report whose `models` cannot account for its own top-level tokens is stored as nothing at all.
  assert.equal(b.entries.length, 1);
  assert.equal(b.entries[0].requests, 0);
  assert.equal(b.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION, 'the pool the unsplit delta used');
  assert.equal(b.entries[0].token_input, 120);
  assert.equal(b.entries[0].token_output, 12);
  assertConserved(delta);
});

test('priced overage lands whole in the run of the last matching generation', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), gen('gpt-5', 2, { gen_id: 'g2' })];
  const delta = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 1, costInCents: 42 } }, {
    attributionRuns: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev')],
  }));
  const [a, b] = delta.segments;
  const creditsOf = (seg) => seg.entries.find((e) => e.billing_pool === BILLING_POOL.CREDITS);
  assert.equal(creditsOf(a), undefined, 'money is never split across runs — cents do not divide');
  assert.equal(creditsOf(b).cost_usd, 0.42);
  assert.equal(creditsOf(b).requests, 1);
  assert.equal(a.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
  assert.equal(a.entries[0].requests, 1);
  assertConserved(delta);
});

test('priced usage with no generation anywhere in the window falls to the final run', () => {
  const delta = computeDelta(CONV, 0, resolvers(
    [tool('read_file', 40, 0), tool('grep', 8, 1)],
    { 'gpt-5': { amount: 2, costInCents: 30 } },
    { attributionRuns: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev')] },
  ));
  const [a, b] = delta.segments;
  assert.deepEqual(a.entries, []);
  assert.equal(b.entries.length, 1);
  assert.equal(b.entries[0].cost_usd, 0.3);
  assertConserved(delta);
});

test('an unreadable usageData splits as unknown, never as subscription', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), gen('gpt-5', 2, { gen_id: 'g2' })];
  const delta = computeDelta(CONV, 0, resolvers(events, null, {
    attributionRuns: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev')],
  }));
  for (const seg of delta.segments) {
    assert.equal(seg.entries[0].billing_pool, BILLING_POOL.UNKNOWN);
    assert.equal(seg.entries[0].requests, 1);
  }
  assertConserved(delta);
});

test('an active interval straddling a boundary is clipped, never duplicated or dropped', () => {
  const events = [tool('a', 4, 0), tool('b', 4, 60), tool('c', 4, 120), tool('d', 4, 180)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main'), run(2, 4, '/repo-b', 'dev')],
  }));
  assert.equal(delta.duration_ms, 180_000);
  const [a, b] = delta.segments;
  // The cut is the first anchor of the next run (120 s), so the 60→120 stretch belongs to the run
  // that was running when it started.
  assert.equal(a.duration_ms, 120_000);
  assert.equal(b.duration_ms, 60_000);
  assertConserved(delta);
});

test('an idle gap that spans a boundary is billed by neither run', () => {
  const events = [tool('a', 4, 0), tool('b', 4, 30), tool('c', 4, 900), tool('d', 4, 930)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main'), run(2, 4, '/repo-b', 'dev')],
  }));
  assert.equal(delta.duration_ms, 60_000);
  assert.deepEqual(delta.segments.map((s) => s.duration_ms), [30_000, 30_000]);
  assertConserved(delta);
});

test('a run with no events of its own is still a segment, and bills nothing', () => {
  // The middle run spans a real line range that simply contains no events (line 1 carries an event kind the delta attributes nothing to).
  //
  // It used to be written as a ZERO-WIDTH run, `run(1, 1, ...)`, which made the same point about
  // billing but pinned a shape the producer cannot emit: `planAttributionRuns` answers `[]` for an
  // empty window precisely to keep its "every nonempty range has `to > from`" invariant
  // unconditional (attribution-cursor.mjs). A4 moved that shape to the refusal list below, so the
  // eventless-run case is expressed the way the planner would actually express it.
  const events = [tool('a', 4, 0), noise(1), tool('b', 4, 2)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev'), run(2, 3, '/repo-c', 'x')],
  }));
  assert.equal(delta.segments.length, 3);
  const empty = delta.segments[1];
  assert.equal(empty.from, 1);
  assert.equal(empty.to, 2);
  assert.notEqual(empty.from, empty.to, 'a segment still describes a real range');
  assert.equal(empty.duration_ms, 0);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.hasReportableWork, false);
  assertConserved(delta);
});

test('segments survive a byte-resumed read — runs index absolute lines, not array positions', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), tool('read_file', 40, 1), gen('gpt-5', 2, { gen_id: 'g2' })];
  const delta = computeDelta(CONV, 5, {
    readEventsFrom: () => ({ events, baseLine: 5, nextByte: 400, resumed: true }),
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
    start: { byte: 400, line: 5 },
    attributionRuns: [run(5, 6, '/repo-a', 'main'), run(6, 8, '/repo-b', 'dev')],
  });
  assert.deepEqual(delta.consumed, { from: 5, to: 8 });
  assert.deepEqual(delta.segments.map((s) => [s.from, s.to]), [[5, 6], [6, 8]]);
  assert.equal(delta.segments[0].entries[0].requests, 1);
  assert.equal(delta.segments[1].entries[0].requests, 1);
  assert.equal(delta.segments[1].operations.file.count, 1);
  assertConserved(delta);
});

test('a doubled stream splits the same way a single one does', () => {
  // Both hook registries write every line, so the window the split sees is the collapsed one while
  // the runs index the RAW lines. Getting that mapping wrong is how a run silently bills twice.
  const single = [gen('gpt-5', 0, { gen_id: 'g1' }), tool('read_file', 40, 1), gen('gpt-5', 2, { gen_id: 'g2' })];
  const doubled = single.flatMap((event) => [event, { ...event, ts: event.ts + 7 }]);
  const delta = computeDelta(CONV, 0, resolvers(doubled, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main'), run(2, 6, '/repo-b', 'dev')],
  }));
  assert.equal(delta.diagnostics.duplicateEvents, 3);
  assert.equal(requestsFor(delta.segments, 'gpt-5', BILLING_POOL.SUBSCRIPTION), 2);
  assertConserved(delta);
});

test('the planner runs INSIDE computeDelta, against absolute line indices', () => {
  // The repo lane's planner needs `{index, event}` pairs against absolute line numbers, and this is
  // the only place they exist: the frequent checkpoint path never materialises an event array of its
  // own, so nothing outside computeDelta has anything to index.
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), tool('read_file', 40, 1), gen('gpt-5', 2, { gen_id: 'g2' })];
  let seen = null;
  let opts = null;
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    cwd: '/repo-a',
    repoRootOf: (dir) => dir,
    branchAt: () => 'main',
    previousAttribution: { root: '/repo-a' },
    planRuns: (indexedEvents, options) => {
      seen = indexedEvents;
      opts = options;
      return {
        runs: [run(0, 2, '/repo-a', 'main'), run(2, 3, '/repo-b', 'dev')],
        nextAttribution: { root: '/repo-b' },
      };
    },
  }));

  assert.deepEqual(seen.map((e) => e.index), [0, 1, 2]);
  assert.equal(seen[0].event, events[0], 'the events themselves, by reference');
  assert.equal(opts.from, 0);
  assert.equal(opts.to, 3);
  assert.equal(opts.cwd, '/repo-a');
  assert.equal(typeof opts.repoRootOf, 'function');
  assert.equal(typeof opts.branchAt, 'function');
  assert.deepEqual(opts.previous, { root: '/repo-a' });
  assert.deepEqual(delta.segments.map((s) => [s.from, s.to, s.repoRoot]), [[0, 2, '/repo-a'], [2, 3, '/repo-b']]);
  // The planner's carry-forward state travels back out for the host to persist.
  assert.deepEqual(delta.nextAttribution, { root: '/repo-b' });
  assertConserved(delta);
});

test('a resumed read hands the planner absolute indices, not array positions', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), tool('read_file', 40, 1)];
  let seen = null;
  computeDelta(CONV, 5, {
    readEventsFrom: () => ({ events, baseLine: 5, nextByte: 400, resumed: true }),
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
    start: { byte: 400, line: 5 },
    planRuns: (indexedEvents) => {
      seen = indexedEvents;
      return [run(5, 7, '/repo-a', 'main')];
    },
  });
  assert.deepEqual(seen.map((e) => e.index), [5, 6]);
});

test('a planner that throws costs the split, never the segment', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1' }), tool('read_file', 40, 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    planRuns: () => { throw new Error('git exploded'); },
  }));
  assert.equal('segments' in delta, false);
  assert.equal(delta.entries[0].requests, 1, 'the unsplit window is still complete');
});

test('runs handed in whole outrank a planner', () => {
  const events = [tool('a', 4, 0), tool('b', 4, 1)];
  let planned = 0;
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: [run(0, 2, '/repo-a', 'main')],
    planRuns: () => { planned += 1; return [run(0, 2, '/repo-z', 'x')]; },
  }));
  assert.equal(planned, 0);
  assert.equal(delta.segments[0].repoRoot, '/repo-a');
});

test('runs may arrive as the planner returns them, wrapped in a result object', () => {
  const events = [tool('a', 4, 0), tool('b', 4, 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    attributionRuns: { runs: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev')], nextAttribution: {} },
  }));
  assert.equal(delta.segments.length, 2);
  assertConserved(delta);
});

test('runs that do not cover the window are refused rather than half-applied', () => {
  const events = [tool('a', 4, 0), tool('b', 4, 1)];
  for (const runs of [
    [],
    'nonsense',
    [run(1, 2, '/repo', 'main')],
    [run(0, 1, '/repo', 'main')],
    [run(0, 1, '/repo', 'main'), run(1, 3, '/repo', 'main')],
    [{ from: 0, to: 2 }, null],
    // A4: a ZERO-WIDTH run. It covers the window arithmetically — the cursor advances past it and
    // still lands on `to` — so the old contiguity check waved it through, and it would emit a
    // segment whose every counter is zero: a repo/branch attribution claiming a stretch of the
    // conversation in which nothing happened. `planAttributionRuns` cannot produce one today, which
    // is exactly why the guard belongs here rather than in a caller's head.
    [run(0, 0, '/repo', 'main'), run(0, 2, '/repo', 'main')],
    [run(0, 2, '/repo', 'main'), run(2, 2, '/repo-b', 'dev')],
  ]) {
    const delta = computeDelta(CONV, 0, resolvers(events, {}, { attributionRuns: runs }));
    assert.equal('segments' in delta, false, `runs: ${JSON.stringify(runs)}`);
  }
});

test('the unsplit segment is untouched by the presence of runs', () => {
  const events = [gen('gpt-5', 0, { gen_id: 'g1', token_input: 5 }), tool('read_file', 40, 1)];
  const plain = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 1, costInCents: 7 } }));
  const split = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 1, costInCents: 7 } }, {
    attributionRuns: [run(0, 1, '/repo-a', 'main'), run(1, 2, '/repo-b', 'dev')],
  }));
  for (const key of ['segmentId', 'from', 'to', 'duration_ms', 'est_tokens', 'started_at', 'ended_at', 'hasReportableWork']) {
    assert.deepEqual(split[key], plain[key], key);
  }
  assert.deepEqual(split.entries, plain.entries);
  assert.deepEqual(split.tokens, plain.tokens);
});
