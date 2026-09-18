import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta, ACTIVITY_EVENTS, TIMING_ANCHOR_EVENTS, MAX_CARRIED_GENERATIONS } from '../lib/delta-cursor.mjs';

// DATA-04 / DATA-V01: what a window CONSUMED, what it may time itself against, and what is worth
// reporting are three different questions. A bare `session_end` answers the first and neither of
// the others — it is a boundary marker, not work.

const CONV = 'conv-work';
const at = (min) => Date.parse(`2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`);
const gen = (model, min = 0, fields = {}) => ({ ts: at(min), ev: 'gen', model, ...fields });
const tool = (name, bytes, min = 0) => ({ ts: at(min), ev: 'tool', tool: name, bytes });
const edit = (file, added, removed, min = 0) => ({ ts: at(min), ev: 'edit', path: file, added, removed });

function resolvers(events, usage = {}, extra = {}) {
  return {
    readEvents: () => events,
    readUsageData: () => usage,
    aiCodeTrackingDbFile: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// consumed — always advances, even when nothing is worth reporting
// ---------------------------------------------------------------------------

test('consumed names the raw lines read, identical to from/to on a normal window', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5'), tool('read_file', 40, 1)]));
  assert.deepEqual(delta.consumed, { from: 0, to: 2 });
  assert.equal(delta.consumed.from, delta.from);
  assert.equal(delta.consumed.to, delta.to);
});

test('a window holding only session_end consumes its range and reports no work', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(1), ev: 'session_end' }]));
  assert.deepEqual(delta.consumed, { from: 0, to: 1 });
  assert.equal(delta.hasReportableWork, false);
  assert.deepEqual(delta.entries, []);
  // Segment identity is unchanged: from/to still index raw lines, markers included.
  assert.equal(delta.segmentId, `${CONV}:0-1`);
  assert.equal(delta.nextCursor, 1);
});

test('stop followed by session_end is still only a boundary', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(1), ev: 'stop' }, { ts: at(1), ev: 'session_end' }]));
  assert.equal(delta.hasReportableWork, false);
  assert.deepEqual(delta.consumed, { from: 0, to: 2 });
});

test('an empty window reports no work and consumes nothing', () => {
  const delta = computeDelta(CONV, 0, resolvers([]));
  assert.equal(delta.hasReportableWork, false);
  assert.deepEqual(delta.consumed, { from: 0, to: 0 });
});

// ---------------------------------------------------------------------------
// hasReportableWork — what justifies a billed segment
// ---------------------------------------------------------------------------

test('the carried generation set makes a straddling generation ONE request', () => {
  // A generation's opening line and its turn-end line land in different windows whenever a
  // checkpoint runs mid-turn. Each window collapses only its own lines, so without the carry the
  // same generation is billed twice - and `requests` is what the seat-covered bucket is computed
  // against (`covered = requests - usageData.amount`).
  const events = [
    gen('gpt-5', 0, { gen_id: 'g1' }),
    tool('read_file', 40, 1),
    gen('gpt-5', 2, { gen_id: 'g1', token_input: 100, token_output: 10 }),
  ];
  const first = computeDelta(CONV, 0, resolvers(events.slice(0, 2)));
  assert.equal(first.entries[0].requests, 1);
  assert.deepEqual(first.countedGenerations, ['gpt-5\ng1']);

  const carried = computeDelta(CONV, 2, resolvers(events, {}, { countedGenerations: first.countedGenerations }));
  const requests = carried.entries.reduce((sum, e) => sum + e.requests, 0);
  assert.equal(requests, 0, 'the second window bills no second request for the same generation');
  // …and the counts that only the turn-end line carries still travel, on a zero-request row.
  assert.equal(carried.tokens.token_input, 100);
  assert.equal(carried.entries.length, 1);
  assert.equal(carried.entries[0].requests, 0);
  assert.equal(carried.entries[0].token_input, 100);

  // Without the carry, the same window bills a second request - the behaviour the integration wiring
  // in handoff P2 removes.
  const uncarried = computeDelta(CONV, 2, resolvers(events));
  assert.equal(uncarried.entries.reduce((sum, e) => sum + e.requests, 0), 1);
});

test('the carry is bounded and never carries an anonymous generation', () => {
  const events = [gen('gpt-5', 0), gen('gpt-5', 1)];
  const delta = computeDelta(CONV, 0, resolvers(events));
  assert.deepEqual(delta.countedGenerations, [], 'a line with no gen_id is window-local');
  assert.equal(MAX_CARRIED_GENERATIONS, 200);

  const many = [];
  for (let i = 0; i < MAX_CARRIED_GENERATIONS + 10; i++) many.push(gen('gpt-5', 0, { gen_id: `g${i}` }));
  const big = computeDelta(CONV, 0, resolvers(many));
  assert.equal(big.countedGenerations.length, MAX_CARRIED_GENERATIONS);
  assert.equal(big.countedGenerations[big.countedGenerations.length - 1], `gpt-5\ng${MAX_CARRIED_GENERATIONS + 9}`);
});

test('a generation with no known tokens is still real work', () => {
  const delta = computeDelta(CONV, 0, resolvers([gen('gpt-5'), { ts: at(1), ev: 'stop' }]));
  assert.equal(delta.hasReportableWork, true);
  assert.equal(delta.tokens, null, 'nonzero tokens are not the emit criterion');
});

test('a tool-only window is work', () => {
  const delta = computeDelta(CONV, 0, resolvers([tool('read_file', 400), { ts: at(1), ev: 'session_end' }]));
  assert.equal(delta.hasReportableWork, true);
});

test('a code-only window is work', () => {
  const delta = computeDelta(CONV, 0, resolvers([edit('src/a.ts', 12, 3), { ts: at(1), ev: 'stop' }]));
  assert.equal(delta.hasReportableWork, true);
  assert.equal(delta.code_changes.lines_added, 12);
});

test('priced usage with no generation line in the window is work — a dropped hook is not zero spend', () => {
  const delta = computeDelta(CONV, 0, resolvers(
    [{ ts: at(1), ev: 'session_end' }],
    { 'gpt-5': { amount: 2, costInCents: 30 } },
  ));
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.hasReportableWork, true);
});

test('active wall clock alone justifies a segment', () => {
  // Two subagent markers a minute apart: no generation, no tool, no edit — but a real minute of
  // delegated work the parent was blocked for.
  const delta = computeDelta(CONV, 0, resolvers([
    { ts: at(0), ev: 'subagent_start', sid: 'sa-1', task: 'audit' },
    { ts: at(1), ev: 'subagent_stop', task: 'audit' },
  ]));
  assert.equal(delta.duration_ms, 60_000);
  assert.equal(delta.hasReportableWork, true);
});

test('a subagent window whose span exceeds the idle gap reports no MAIN work, and still consumes', () => {
  // The worker ran for ten minutes and the parent wrote nothing, so the parent bills ~0 for it. The
  // subagent's own segment is derived separately from the same lines by the checkpoint and is NOT
  // gated on this flag — the range must still be consumed.
  const delta = computeDelta(CONV, 0, resolvers([
    { ts: at(0), ev: 'subagent_start', sid: 'sa-1', task: 'audit' },
    { ts: at(10), ev: 'subagent_stop', task: 'audit' },
  ]));
  assert.equal(delta.duration_ms, 0);
  assert.equal(delta.hasReportableWork, false);
  assert.deepEqual(delta.consumed, { from: 0, to: 2 });
});

// ---------------------------------------------------------------------------
// Timing anchors — only genuine activity may move the segment's clock
// ---------------------------------------------------------------------------

test('session lifecycle markers are not timing anchors; a turn end is', () => {
  for (const kind of ['gen', 'tool', 'edit', 'shell']) {
    assert.equal(TIMING_ANCHOR_EVENTS.has(kind), true, kind);
    assert.equal(ACTIVITY_EVENTS.has(kind), true, kind);
  }
  // `stop` anchors the clock - it is where the assistant's work finished - but it is not itself
  // work, so it cannot make a window billable on its own.
  assert.equal(TIMING_ANCHOR_EVENTS.has('stop'), true);
  assert.equal(ACTIVITY_EVENTS.has('stop'), false);
  for (const marker of ['start', 'session_start', 'end', 'session_end']) {
    assert.equal(TIMING_ANCHOR_EVENTS.has(marker), false, `${marker} must not anchor the clock`);
    assert.equal(ACTIVITY_EVENTS.has(marker), false, marker);
  }
});

test('a stop in the MIDDLE of a window keeps the minutes either side of it', () => {
  // The shape every whole-history and audit window has: each turn's `stop` sits mid-window. Dropping
  // it merges the gap before and the gap after into one stretch past the idle threshold, and the
  // segment loses every minute of both.
  const ms = (n) => ({ ts: at(0) + n, ev: 'tool', tool: 'read_file', bytes: 10 });
  const events = [ms(0), ms(10_000), { ts: at(0) + 200_000, ev: 'stop' }, ms(400_000)];
  const delta = computeDelta(CONV, 0, resolvers(events));
  // 0 -> 10s, 10s -> 200s and 200s -> 400s are each below the idle threshold, so the window is one
  // continuous 400 s of work. Without the `stop` anchor the 390 s gap reads as idle and 390 s vanish.
  assert.equal(delta.duration_ms, 400_000);
  assert.equal(delta.started_at, new Date(at(0)).toISOString());
  assert.equal(delta.ended_at, new Date(at(0) + 400_000).toISOString());
  assert.equal(delta.timingAnchors.count, 4);
});

test('a window of nothing but turn ends anchors a span and still bills nothing', () => {
  const events = [{ ts: at(0), ev: 'stop' }, { ts: at(1), ev: 'stop' }, { ts: at(2), ev: 'session_end' }];
  const delta = computeDelta(CONV, 0, resolvers(events));
  // The clock is anchored - two stops a minute apart really are a minute of wall clock - but nothing
  // in the window did any work, so there is no segment to bill.
  assert.equal(delta.duration_ms, 60_000);
  assert.equal(delta.hasReportableWork, false);
  assert.deepEqual(delta.consumed, { from: 0, to: 3 });
});

test('a missed stop hours later does not stretch the segment to it', () => {
  const events = [
    gen('gpt-5', 0),
    tool('read_file', 40, 1),
    { ts: at(0) + 3 * 60 * 60 * 1000, ev: 'session_end' },
  ];
  const delta = computeDelta(CONV, 0, resolvers(events));
  assert.equal(delta.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(delta.ended_at, '2026-01-01T00:01:00.000Z');
  assert.equal(delta.duration_ms, 60_000);
  assert.equal(delta.timingAnchors.count, 2);
  assert.equal(delta.timingAnchors.endedMs, at(1));
});

test('a normal shutdown produces no point segment — the session marker anchors nothing', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(4), ev: 'session_end' }]));
  assert.equal(delta.started_at, null);
  assert.equal(delta.ended_at, null);
  assert.equal(delta.duration_ms, 0);
  assert.deepEqual(delta.activeIntervals, []);
  assert.equal(delta.timingAnchors.count, 0);
});

test('a window nothing in it is recognised reports null bounds beside the schema miss', () => {
  const delta = computeDelta(CONV, 0, resolvers([{ ts: at(0), ev: 'wat' }, { ts: at(1), ev: 'wat' }]));
  assert.equal(delta.diagnostics.schemaMiss, true);
  assert.equal(delta.started_at, null, 'an unrecognised stream must not claim a span it cannot read');
  assert.equal(delta.duration_ms, 0);
});

test('the code-changes database window still spans every timestamped line, markers included', () => {
  // The tracking DB is queried by time, and Cursor writes an edit row when it saves the file — which
  // can be after the last `gen` line and before the trailing `session_end`. Narrowing the QUERY to
  // the activity bound would drop those line counts, so the two bounds are deliberately different.
  let seen = null;
  let branchTs = null;
  const events = [gen('gpt-5', 0), { ts: at(9), ev: 'session_end' }];
  const delta = computeDelta(CONV, 0, resolvers(events, {}, {
    computeCodeChanges: (window, deps) => {
      seen = deps.window;
      return { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} };
    },
    cwd: '/repo',
    repoRootOf: () => '/repo',
    branchAt: (root, ts) => { branchTs = ts; return 'main'; },
  }));
  assert.deepEqual(seen, { startMs: at(0), endMs: at(9) });
  assert.equal(branchTs, at(9));
  assert.equal(delta.ended_at, '2026-01-01T00:00:00.000Z');
});
