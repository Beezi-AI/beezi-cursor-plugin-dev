import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCliSubagents } from '../lib/cli-subagents-cursor.mjs';
import { correlateSubagents } from '../lib/subagents-cursor.mjs';

// Epoch MILLISECONDS throughout: timestampOf reads any number below 1e12 as SECONDS, so a fixture
// written as `startMs: 1000` would land in 1970 ×1000 and test nothing real.
const T = 1790000000000;

const kids = [
  { agentId: 'a1', typeName: 'generalPurpose', toolCallId: 't1', startMs: T + 1000, endMs: T + 5000 },
  { agentId: 'a2', typeName: 'explore', toolCallId: 't2', startMs: T + 1100, endMs: T + 3000 },
];

test('CLI children become start/stop pairs that correlate to the right lanes', () => {
  const events = [{ ts: T + 900, ev: 'gen', model: 'm', gen_id: 'g' }, { ts: T + 6000, ev: 'stop' }];
  const merged = withCliSubagents('p', events, { listCliSubagents: () => kids });
  const { subagents, diagnostics } = correlateSubagents(merged);
  assert.equal(subagents.length, 2);
  assert.equal(diagnostics.ambiguous, 0);
  assert.equal(diagnostics.synthetic, 0);
  const a1 = subagents.find((s) => s.agent_id === 'a1');
  const a2 = subagents.find((s) => s.agent_id === 'a2');
  assert.equal(a1.agent_type, 'generalPurpose');
  assert.equal(a2.agent_type, 'explore');
  // a2 finishes first although it started second: LIFO would have swapped the two ends.
  assert.equal(a1.ended_ms, T + 5000);
  assert.equal(a2.ended_ms, T + 3000);
});

test('the added lines carry the shape the hooks would have written', () => {
  const events = [{ ts: T, ev: 'gen' }];
  const merged = withCliSubagents('p', events, { listCliSubagents: () => [kids[0]] });
  assert.notEqual(merged, events);
  assert.deepEqual(events, [{ ts: T, ev: 'gen' }], 'the input array is never mutated');
  assert.deepEqual(merged.slice(1), [
    { ts: T + 1000, ev: 'subagent_start', sid: 'a1', stype: 'generalPurpose', tool_call_id: 't1' },
    { ts: T + 5000, ev: 'subagent_stop', sid: 'a1', stype: 'generalPurpose', status: 'completed' },
  ]);
});

test('a child with no type or tool call id writes no such keys', () => {
  const merged = withCliSubagents('p', [{ ts: T, ev: 'gen' }], {
    listCliSubagents: () => [{ agentId: 'a9', typeName: null, toolCallId: null, startMs: T + 1, endMs: T + 2 }],
  });
  assert.deepEqual(merged.slice(1), [
    { ts: T + 1, ev: 'subagent_start', sid: 'a9' },
    { ts: T + 2, ev: 'subagent_stop', sid: 'a9', status: 'completed' },
  ]);
});

test('a stream that already has hook subagent lines is left alone, and the store is never read', () => {
  const events = [{ ts: T + 1, ev: 'subagent_start', sid: 'x', stype: 'y' }];
  let calls = 0;
  const merged = withCliSubagents('p', events, { listCliSubagents: () => { calls += 1; return kids; } });
  assert.equal(merged, events);
  assert.equal(calls, 0);
  // A lone stop counts too: any subagent line means the hooks own this session's lanes.
  const stopOnly = [{ ts: T + 1, ev: 'subagent_stop' }];
  assert.equal(withCliSubagents('p', stopOnly, { listCliSubagents: () => { calls += 1; return kids; } }), stopOnly);
  assert.equal(calls, 0);
});

test('the lister gets exactly (sessionId, deps), deadline included', () => {
  const seen = [];
  const deps = { deadline: T + 42, listCliSubagents: (...args) => { seen.push(args); return []; } };
  withCliSubagents('parent-id', [{ ts: T, ev: 'gen' }], deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], 'parent-id');
  assert.equal(seen[0][1], deps);
  assert.equal(seen[0][1].deadline, T + 42);
});

test('no children, or a reader that throws, returns the input unchanged', () => {
  const events = [{ ts: T + 1, ev: 'stop' }];
  assert.equal(withCliSubagents('p', events, { listCliSubagents: () => [] }), events);
  assert.equal(withCliSubagents('p', events, { listCliSubagents: () => null }), events);
  assert.equal(withCliSubagents('p', events, { listCliSubagents: () => { throw new Error('x'); } }), events);
});

test('an empty or non-array stream is returned as-is without reading anything', () => {
  let calls = 0;
  const lister = () => { calls += 1; return kids; };
  const empty = [];
  assert.equal(withCliSubagents('p', empty, { listCliSubagents: lister }), empty);
  assert.equal(withCliSubagents('p', null, { listCliSubagents: lister }), null);
  assert.equal(calls, 0);
});

test('malformed child records are skipped, never thrown on', () => {
  const merged = withCliSubagents('p', [{ ts: T, ev: 'gen' }], {
    listCliSubagents: () => [null, { agentId: '', startMs: T, endMs: T }, { agentId: 'ok', startMs: 'x', endMs: T }, kids[0]],
  });
  assert.equal(merged.length, 3);
  assert.equal(merged[1].sid, 'a1');
});

test('with no deps at all it reads the real store and degrades to the input for an unknown id', () => {
  const events = [{ ts: T, ev: 'gen' }];
  // An id the chat-store adapter refuses outright (path characters), so this touches no disk.
  assert.equal(withCliSubagents('../nope', events), events);
});

// Codex review: an expired deadline makes the lister answer [] exactly like "this session has no
// workers", and the checkpoint then overwrote a queued one-lane timeline with a zero-lane one. The
// caller can only refuse to do that if it is TOLD the listing was cut short.
test('onEnrichment says complete when the listing finished inside the deadline', () => {
  const seen = [];
  withCliSubagents('p', [{ ts: T, ev: 'gen' }], {
    deadline: T + 1000,
    now: () => T,
    listCliSubagents: () => [kids[0]],
    onEnrichment: (info) => seen.push(info),
  });
  assert.deepEqual(seen, [{ complete: true }]);
});

test('onEnrichment says incomplete when the deadline had passed by the end of the listing', () => {
  let clock = T;
  const seen = [];
  const events = [{ ts: T, ev: 'gen' }];
  // Stopped early between child opens: the lister returned what it had when time ran out.
  const merged = withCliSubagents('p', events, {
    deadline: T + 1000,
    now: () => clock,
    listCliSubagents: () => { clock += 5000; return [kids[0]]; },
    onEnrichment: (info) => seen.push(info),
  });
  assert.deepEqual(seen, [{ complete: false }]);
  assert.equal(merged.length, 3, 'what WAS found is still added');
  // Expired at entry: the lister answers [] without looking.
  seen.length = 0;
  withCliSubagents('p', events, { deadline: T - 1, now: () => T, listCliSubagents: () => [], onEnrichment: (info) => seen.push(info) });
  assert.deepEqual(seen, [{ complete: false }]);
});

test('onEnrichment is complete with no deadline, and silent when the store is never read', () => {
  const seen = [];
  withCliSubagents('p', [{ ts: T, ev: 'gen' }], { listCliSubagents: () => [], onEnrichment: (info) => seen.push(info) });
  assert.deepEqual(seen, [{ complete: true }]);
  seen.length = 0;
  withCliSubagents('p', [{ ts: T, ev: 'subagent_start', sid: 'x' }], { deadline: T - 1, onEnrichment: (info) => seen.push(info) });
  assert.deepEqual(seen, [], 'hook lines own the lanes; nothing was left out');
});

test('a throwing onEnrichment never escapes', () => {
  const events = [{ ts: T, ev: 'gen' }];
  const merged = withCliSubagents('p', events, { listCliSubagents: () => [kids[0]], onEnrichment: () => { throw new Error('x'); } });
  assert.equal(merged.length, 3);
});

test('a null deps object is treated as no deps, never thrown on', () => {
  assert.equal(withCliSubagents('../nope', [{ ts: T, ev: 'gen' }], null).length, 1);
});
