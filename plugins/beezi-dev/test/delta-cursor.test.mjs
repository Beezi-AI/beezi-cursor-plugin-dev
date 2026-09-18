import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta, BILLING_POOL } from '../lib/delta-cursor.mjs';

const CONV = 'conv-abc';
const at = (min) => Date.parse(`2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`);

const gen = (model, min = 0) => ({ ts: at(min), ev: 'gen', model });
const tool = (name, bytes, min = 0) => ({ ts: at(min), ev: 'tool', tool: name, bytes });
const edit = (file, added, removed, min = 0) => ({ ts: at(min), ev: 'edit', path: file, added, removed });

// Every external effect is injected, so nothing here needs a Cursor install or node:sqlite — and
// `aiCodeTrackingDbFile: null` keeps the run identical on a machine that DOES have Cursor.
function resolvers(events, usage, extra = {}) {
  return {
    readEvents: () => events,
    readUsageData: () => usage,
    aiCodeTrackingDbFile: null,
    ...extra,
  };
}

const entryFor = (delta, pool) => delta.entries.find((e) => e.billing_pool === pool);

test('segmentId indexes our sidecar lines, not Cursor storage', () => {
  const events = [gen('claude-4.5-sonnet'), tool('read_file', 40), gen('claude-4.5-sonnet', 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}));
  assert.equal(delta.segmentId, `${CONV}:0-3`);
  assert.equal(delta.from, 0);
  assert.equal(delta.to, 3);
  assert.equal(delta.nextCursor, 3);
});

test('two consecutive calls with the same cursor are byte-identical — the delta is pure', () => {
  const events = [gen('gpt-5'), tool('grep', 8, 1)];
  const usage = { 'gpt-5': { amount: 1, costInCents: 25 } };
  const first = computeDelta(CONV, 0, resolvers(events, usage));
  const second = computeDelta(CONV, 0, resolvers(events, usage));
  assert.deepEqual(second.entries, first.entries);
  assert.equal(second.segmentId, first.segmentId);
  assert.equal(second.duration_ms, first.duration_ms);
});

test('advancing the cursor to `to` yields an empty follow-up segment, not a replay', () => {
  const events = [gen('gpt-5'), gen('gpt-5', 1)];
  const first = computeDelta(CONV, 0, resolvers(events, {}));
  const second = computeDelta(CONV, first.nextCursor, resolvers(events, {}));
  assert.equal(second.segmentId, `${CONV}:2-2`);
  assert.deepEqual(second.entries, []);
  assert.equal(second.duration_ms, 0);
});

test('a cursor beyond the stream clamps instead of producing a negative window', () => {
  const delta = computeDelta(CONV, 99, resolvers([gen('gpt-5')], {}));
  assert.equal(delta.from, 1);
  assert.equal(delta.to, 1);
  assert.deepEqual(delta.entries, []);
});

// ---------------------------------------------------------------------------
// The two-row split
// ---------------------------------------------------------------------------

test('a partly-priced model splits into a credits row and a subscription row', () => {
  const events = [gen('claude-4.5-sonnet'), gen('claude-4.5-sonnet', 1), gen('claude-4.5-sonnet', 2)];
  const delta = computeDelta(
    CONV,
    0,
    resolvers(events, { 'claude-4.5-sonnet': { amount: 1, costInCents: 42 } }),
  );

  assert.equal(delta.entries.length, 2);
  const credits = entryFor(delta, BILLING_POOL.CREDITS);
  const subscription = entryFor(delta, BILLING_POOL.SUBSCRIPTION);

  assert.equal(credits.requests, 1);
  assert.equal(credits.cost_usd, 0.42);
  // The model id stays a model id on both rows — the pool travels in its own field, never welded
  // onto the name.
  assert.equal(credits.model, 'claude-4.5-sonnet');

  assert.equal(subscription.requests, 2); // 3 total − 1 priced
  assert.equal(subscription.cost_usd, 0);
  assert.equal(subscription.model, 'claude-4.5-sonnet');
});

test('amount === total emits only a credits row', () => {
  const events = [gen('gpt-5'), gen('gpt-5', 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 2, costInCents: 130 } }));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.CREDITS);
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.entries[0].cost_usd, 1.3);
});

test('amount === 0 emits only a subscription row', () => {
  const events = [gen('gpt-5'), gen('gpt-5', 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 0, costInCents: 0 } }));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.entries[0].cost_usd, 0);
});

test('an empty usageData object means the seat covered everything', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5'), gen('gpt-5', 1)], {}));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.diagnostics.usageRead, true);
});

// ---------------------------------------------------------------------------
// The `unknown` pool — the property this whole design exists to protect
// ---------------------------------------------------------------------------

test('an unreadable usageData record produces ONE unknown row, never subscription', () => {
  const events = [gen('claude-4.5-sonnet'), gen('claude-4.5-sonnet', 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, null));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.UNKNOWN);
  assert.equal(delta.entries[0].model, 'claude-4.5-sonnet');
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.entries[0].cost_usd, 0);
  assert.equal(delta.diagnostics.usageRead, false);
});

test('null and {} are NOT interchangeable — that conflation is the bug being designed against', () => {
  const events = [gen('gpt-5'), gen('gpt-5', 1)];
  const unreadable = computeDelta(CONV, 0, resolvers(events, null));
  const nothingPriced = computeDelta(CONV, 0, resolvers(events, {}));

  assert.equal(unreadable.entries[0].billing_pool, BILLING_POOL.UNKNOWN);
  assert.equal(nothingPriced.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
  assert.notEqual(unreadable.entries[0].billing_pool, nothingPriced.entries[0].billing_pool);
});

test('a usage reader that throws is treated as unreadable, not as nothing-priced', () => {
  const delta = computeDelta(CONV, 0, {
    readEvents: () => [gen('gpt-5')],
    readUsageData: () => {
      throw new Error('database is locked');
    },
  });
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.UNKNOWN);
});

test('a usageData value of the wrong type is treated as unreadable', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], ['not', 'an', 'object']));
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.UNKNOWN);
  assert.equal(delta.usage_snapshot, null);
});

// ---------------------------------------------------------------------------
// Cumulative usageData: the baseline
// ---------------------------------------------------------------------------

test('priorUsage bills only the increment, so a re-checkpointed conversation is not re-charged', () => {
  const events = [gen('gpt-5'), gen('gpt-5', 1), gen('gpt-5', 2)];
  const usage = { 'gpt-5': { amount: 3, costInCents: 90 } };
  const delta = computeDelta(CONV, 0, {
    ...resolvers(events, usage),
    priorUsage: { 'gpt-5': { amount: 1, costInCents: 30 } },
  });
  const credits = entryFor(delta, BILLING_POOL.CREDITS);
  assert.equal(credits.requests, 2);
  assert.equal(credits.cost_usd, 0.6);
});

test('usage_snapshot hands the host the baseline for the next call', () => {
  const usage = { 'gpt-5': { amount: 3, costInCents: 90 } };
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], usage));
  assert.deepEqual(delta.usage_snapshot, usage);
});

test('a baseline equal to the current total bills nothing further', () => {
  const usage = { 'gpt-5': { amount: 2, costInCents: 50 } };
  const delta = computeDelta(CONV, 0, {
    ...resolvers([gen('gpt-5'), gen('gpt-5', 1)], usage),
    priorUsage: usage,
  });
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
  assert.equal(delta.entries[0].requests, 2);
});

// ---------------------------------------------------------------------------
// Edge cases in the split
// ---------------------------------------------------------------------------

test('a priced model we never saw generate still reports its spend', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], {
    'gpt-5': { amount: 0, costInCents: 0 },
    'grok-4': { amount: 2, costInCents: 60 },
  }));
  const grok = delta.entries.find((e) => e.model === 'grok-4');
  assert.ok(grok, 'spend for an unobserved model must not be dropped');
  assert.equal(grok.billing_pool, BILLING_POOL.CREDITS);
  assert.equal(grok.cost_usd, 0.6);
});

test('a priced count above the observed request count never makes subscription negative', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], { 'gpt-5': { amount: 5, costInCents: 100 } }));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.CREDITS);
  assert.equal(delta.entries[0].requests, 5);
});

test('a model id that differs only in case still matches its price record', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('Claude-4.5-Sonnet')], {
    'claude-4.5-sonnet': { amount: 1, costInCents: 20 },
  }));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.CREDITS);
  assert.equal(delta.entries[0].cost_usd, 0.2);
});

test('several models each get their own pool rows', () => {
  const delta = computeDelta(CONV, 0, resolvers(
    [gen('gpt-5'), gen('gpt-5', 1), gen('claude-4.5-sonnet', 2)],
    { 'gpt-5': { amount: 1, costInCents: 10 } },
  ));
  assert.deepEqual(delta.entries.map((e) => [e.model, e.billing_pool]), [
    ['gpt-5', BILLING_POOL.CREDITS],
    ['gpt-5', BILLING_POOL.SUBSCRIPTION],
    ['claude-4.5-sonnet', BILLING_POOL.SUBSCRIPTION],
  ]);
});

test('a generation with no model name bills to "unknown" rather than vanishing', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(0), ev: 'gen' }], {}));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].model, 'unknown');
  assert.equal(delta.entries[0].billing_pool, BILLING_POOL.SUBSCRIPTION);
});

test('cost stays at cent precision instead of carrying float noise', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], { 'gpt-5': { amount: 1, costInCents: 3 } }));
  assert.equal(delta.entries[0].cost_usd, 0.03);
});

// ---------------------------------------------------------------------------
// Segment-level stats
// ---------------------------------------------------------------------------

test('duration and code_changes stamp on the first entry only', () => {
  const events = [gen('gpt-5', 0), gen('gpt-5', 1), edit('src/a.ts', 12, 3, 2)];
  const delta = computeDelta(CONV, 0, resolvers(events, { 'gpt-5': { amount: 1, costInCents: 10 } }));
  assert.equal(delta.entries.length, 2);
  assert.equal(delta.entries[0].duration_ms, delta.duration_ms);
  assert.ok(delta.entries[0].code_changes);
  assert.equal(delta.entries[1].duration_ms, 0);
  assert.equal(delta.entries[1].code_changes, null);
});

test('duration counts only gaps below the idle threshold', () => {
  // :00 -> :01 active, :01 -> :20 idle (> 5 min), :20 -> :22 active
  const events = [gen('gpt-5', 0), gen('gpt-5', 1), gen('gpt-5', 20), gen('gpt-5', 22)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}));
  assert.equal(delta.duration_ms, 3 * 60_000);
  assert.equal(delta.duration_sec, 180);
  assert.equal(delta.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(delta.ended_at, '2026-01-01T00:22:00.000Z');
});

test('est_tokens comes from real tool-output bytes in the sidecar', () => {
  const events = [gen('gpt-5'), tool('read_file', 400, 1), tool('run_terminal_cmd', 80, 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}));
  assert.equal(delta.est_tokens, 120); // (400 + 80) / 4
  assert.equal(delta.operations.file.count, 1);
  assert.equal(delta.operations.shell.count, 1);
});

test('code_changes falls back to the sidecar edit events', () => {
  const events = [gen('gpt-5'), edit('src/a.ts', 12, 3, 1), edit('src/b.js', 4, 0, 1)];
  const delta = computeDelta(CONV, 0, resolvers(events, {}));
  assert.equal(delta.code_changes.files_changed, 2);
  assert.equal(delta.code_changes.lines_added, 16);
  assert.equal(delta.code_changes.lines_removed, 3);
});

test('repo and branch come from the hook cwd through the injected resolvers', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5', 3)], {}, {
    cwd: '/work/repo/sub',
    repoRootOf: () => '/work/repo',
    branchAt: (root, ms) => (root === '/work/repo' && ms === at(3) ? 'feature/x' : '(wrong)'),
  }));
  assert.equal(delta.repoRoot, '/work/repo');
  assert.equal(delta.branch, 'feature/x');
});

test('with no cwd the segment reports no repo and an unknown branch', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], {}));
  assert.equal(delta.repoRoot, null);
  assert.equal(delta.branch, '(unknown)');
});

// ---------------------------------------------------------------------------
// Schema-miss signalling
// ---------------------------------------------------------------------------

test('a window of events we do not understand reports a schema miss, not zero activity', () => {
  const events = [
    { ts: at(0), kind: 'generation', model: 'gpt-5' },
    { ts: at(1), kind: 'toolCall', tool: 'read_file' },
  ];
  const delta = computeDelta(CONV, 0, resolvers(events, {}));
  assert.deepEqual(delta.entries, []);
  assert.equal(delta.diagnostics.schemaMiss, true);
  assert.equal(delta.diagnostics.recognizedEvents, 0);
  assert.deepEqual(delta.diagnostics.unrecognizedEvents, ['(missing ev)']);
});

test('a renamed event kind is named in the diagnostics', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(0), ev: 'model_call', model: 'gpt-5' }], {}));
  assert.equal(delta.diagnostics.schemaMiss, true);
  assert.deepEqual(delta.diagnostics.unrecognizedEvents, ['model_call']);
});

test('an empty window is not a schema miss', () => {
  const delta = computeDelta(CONV, 0, resolvers([], {}));
  assert.equal(delta.diagnostics.schemaMiss, false);
  assert.equal(delta.diagnostics.windowEvents, 0);
});

test('a throwing repo resolver costs the attribution, not the segment', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5')], { 'gpt-5': { amount: 1, costInCents: 10 } }, {
    cwd: '/work/repo',
    repoRootOf: () => {
      throw new Error('detected dubious ownership');
    },
    branchAt: () => {
      throw new Error('no reflog');
    },
  }));
  assert.equal(delta.repoRoot, null);
  assert.equal(delta.branch, '(unknown)');
  assert.equal(delta.entries[0].cost_usd, 0.1);
});

test('a throwing code-change reader still yields the segment with empty line counts', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5'), edit('a.ts', 1, 0, 1)], {}, {
    computeCodeChanges: () => {
      throw new Error('database is locked');
    },
  }));
  assert.equal(delta.entries.length, 1);
  assert.deepEqual(delta.code_changes, {
    files_changed: 0,
    lines_added: 0,
    lines_removed: 0,
    by_extension: {},
  });
});

test('a reader that throws yields an empty segment rather than breaking the hook', () => {
  const delta = computeDelta(CONV, 0, {
    readEvents: () => {
      throw new Error('unreadable');
    },
    readUsageData: () => null,
  });
  assert.equal(delta.segmentId, `${CONV}:0-0`);
  assert.deepEqual(delta.entries, []);
  assert.deepEqual(delta.rateLimitEvents, []);
});
