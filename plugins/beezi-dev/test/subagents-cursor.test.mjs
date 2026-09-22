import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correlateSubagents,
  subagentIntervals,
  SYNTHETIC_CLOSE_MS,
  UNKNOWN_AGENT_TYPE,
  MAX_AGENT_ID_CHARS,
} from '../lib/subagents-cursor.mjs';

const at = (min) => Date.parse('2026-01-01T00:00:00.000Z') + min * 60_000;
const iso = (min) => new Date(at(min)).toISOString();
const gen = (min) => ({ ts: at(min), ev: 'gen', model: 'gpt-5' });
const start = (min, fields = {}) => ({ ts: at(min), ev: 'subagent_start', ...fields });
const stop = (min, fields = {}) => ({ ts: at(min), ev: 'subagent_stop', ...fields });

// The type Cursor sends for EVERY subagent whatever actually ran (confirmed host bug, forum 156647).
const HOST_TYPE = 'general-purpose';

test('a foreground subagent is one span from its start to its stop', () => {
  const { subagents, diagnostics } = correlateSubagents([
    gen(0),
    start(1, { sid: 'sa_01', stype: HOST_TYPE, task: 'audit the parser' }),
    stop(3, { stype: HOST_TYPE, status: 'completed', task: 'audit the parser', duration_ms: 120_000 }),
    gen(4),
  ]);

  assert.equal(subagents.length, 1);
  assert.deepEqual(
    { ...subagents[0] },
    {
      agent_id: 'sa_01',
      agent_type: HOST_TYPE,
      started_at: iso(1),
      ended_at: iso(3),
      started_ms: at(1),
      ended_ms: at(3),
      task: 'audit the parser',
      parallel: false,
      ambiguous: false,
      synthetic: false,
    },
  );
  assert.equal(diagnostics.matched, 1);
  assert.equal(diagnostics.ambiguous, 0);
  assert.equal(diagnostics.orphaned, 0);
  assert.equal(diagnostics.synthetic, 0);
});

test('three parallel workers with distinct tasks pair on the task, not on arrival order', () => {
  // The stops arrive in an order none of them started in — which is exactly what LIFO gets wrong and
  // what the task string is there to fix. A fan-out gets distinct tasks by construction.
  const { subagents, diagnostics } = correlateSubagents([
    start(1, { sid: 'a', stype: HOST_TYPE, task: 'alpha', parallel: true }),
    start(1, { sid: 'b', stype: HOST_TYPE, task: 'bravo', parallel: true }),
    start(1, { sid: 'c', stype: HOST_TYPE, task: 'charlie', parallel: true }),
    stop(5, { stype: HOST_TYPE, task: 'charlie' }),
    stop(7, { stype: HOST_TYPE, task: 'alpha' }),
    stop(9, { stype: HOST_TYPE, task: 'bravo' }),
  ]);

  const byId = new Map(subagents.map((s) => [s.agent_id, s]));
  assert.equal(subagents.length, 3);
  assert.equal(byId.get('c').ended_at, iso(5));
  assert.equal(byId.get('a').ended_at, iso(7));
  assert.equal(byId.get('b').ended_at, iso(9));
  assert.equal(diagnostics.ambiguous, 0, 'a distinct-task fan-out is never a guess');
  assert.equal(diagnostics.matched, 3);
  assert.ok(subagents.every((s) => s.parallel === true));
});

test('two workers given the identical task are flagged ambiguous, not dropped or merged', () => {
  // The failure mode here is a SWAPPED LABEL between two agents that both really ran — which is why
  // this asserts the flag and the count, and deliberately not which id got which span.
  const { subagents, diagnostics } = correlateSubagents([
    start(1, { sid: 'first', stype: HOST_TYPE, task: 'same' }),
    start(2, { sid: 'second', stype: HOST_TYPE, task: 'same' }),
    stop(5, { stype: HOST_TYPE, task: 'same' }),
    stop(6, { stype: HOST_TYPE, task: 'same' }),
  ]);

  assert.equal(subagents.length, 2, 'both workers survive the collision');
  assert.deepEqual(subagents.map((s) => s.agent_id).sort(), ['first', 'second']);
  assert.equal(diagnostics.ambiguous, 1, 'the collided match says so');
  assert.equal(diagnostics.orphaned, 0);
  assert.equal(diagnostics.synthetic, 0);
  assert.ok(subagents.some((s) => s.ambiguous === true));
  // Both spans still end when the two stops did, so the gantt keeps the right shape either way.
  assert.deepEqual(subagents.map((s) => s.ended_at).sort(), [iso(5), iso(6)]);
});

test('a stop with no task falls to LIFO among several open starts, flagged', () => {
  const { subagents, diagnostics } = correlateSubagents([
    start(1, { sid: 'a', task: 'alpha' }),
    start(2, { sid: 'b', task: 'bravo' }),
    stop(4, { status: 'completed' }),
  ]);
  assert.equal(diagnostics.ambiguous, 1);
  const closed = subagents.find((s) => !s.synthetic);
  assert.equal(closed.agent_id, 'b', 'LIFO takes the most recently opened');
  assert.equal(closed.ended_at, iso(4));
});

test('a stop whose task matches nothing still pairs when exactly one start is open', () => {
  const { subagents, diagnostics } = correlateSubagents([
    start(1, { sid: 'only', task: 'alpha' }),
    stop(4, { task: 'a title that is not the task' }),
  ]);
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].ended_at, iso(4));
  assert.equal(diagnostics.ambiguous, 0, 'with one candidate there is nothing to be ambiguous about');
});

test('an orphan stop is dropped and counted, never turned into an invented span', () => {
  const { subagents, diagnostics } = correlateSubagents([
    gen(0),
    stop(2, { stype: HOST_TYPE, task: 'nobody started me', duration_ms: 60_000 }),
    gen(3),
  ]);
  assert.deepEqual(subagents, []);
  assert.equal(diagnostics.orphaned, 1);
  assert.equal(diagnostics.stops, 1);
});

test('a background start with no stop is closed synthetically at the last activity', () => {
  // Confirmed host bug (forum 166681): background subagents fire subagentStart and NEVER
  // subagentStop. Emitting them is the whole point — a background worker leaves no other trace.
  const { subagents, diagnostics } = correlateSubagents([
    start(1, { sid: 'bg', stype: HOST_TYPE, task: 'watch the build' }),
    gen(4),
    gen(9),
  ]);
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].synthetic, true);
  assert.equal(subagents[0].started_at, iso(1));
  assert.equal(subagents[0].ended_at, iso(9), 'the last thing that happened in the conversation');
  assert.equal(diagnostics.synthetic, 1);
});

test('a synthetic close is capped so one background start cannot claim the whole day', () => {
  const { subagents } = correlateSubagents([
    start(1, { sid: 'bg' }),
    gen(600), // ten hours later
  ]);
  assert.equal(subagents[0].ended_ms, at(1) + SYNTHETIC_CLOSE_MS);
});

test('a start that is the last event in the stream is a zero-length span, still emitted', () => {
  const { subagents } = correlateSubagents([gen(0), start(2, { sid: 'bg' })]);
  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].started_at, subagents[0].ended_at);
  assert.equal(subagents[0].synthetic, true);
});

test('a real stop in a later window overwrites the synthetic close on the same agent_id', () => {
  // The timeline is re-derived from the WHOLE sidecar every checkpoint and upserted by sessionId, so
  // "overwrite" is just the same derivation run over more of the stream. The id has to be stable
  // across the two runs or the portal draws two lanes for one worker.
  const prefix = [start(1, { sid: 'sa_09', stype: HOST_TYPE, task: 'long job' }), gen(6)];
  const later = [...prefix, stop(11, { stype: HOST_TYPE, task: 'long job' }), gen(12)];

  const first = correlateSubagents(prefix).subagents[0];
  const second = correlateSubagents(later).subagents[0];

  assert.equal(first.synthetic, true);
  assert.equal(first.ended_at, iso(6));
  assert.equal(second.agent_id, first.agent_id, 'same worker, same lane');
  assert.equal(second.synthetic, false);
  assert.equal(second.ended_at, iso(11));
});

test('agent_id falls back to the spawning tool call, then to the start timestamp', () => {
  const viaTool = correlateSubagents([start(1, { tool_call_id: 'toolu_77', task: 'x' })]).subagents[0];
  assert.equal(viaTool.agent_id, 'toolu_77');

  const viaTs = correlateSubagents([start(1, { task: 'x' })]).subagents[0];
  assert.equal(viaTs.agent_id, `sa-${at(1)}`, 'derived from the event, so it survives a re-read');
});

test('two id-less starts in the same millisecond stay two agents', () => {
  const { subagents } = correlateSubagents([
    start(1, { task: 'alpha' }),
    start(1, { task: 'bravo' }),
  ]);
  assert.equal(subagents.length, 2);
  assert.equal(new Set(subagents.map((s) => s.agent_id)).size, 2);
});

test('the newline Cursor puts inside its own sid does not reach agent_id', () => {
  // Verbatim shape from a live sidecar: the tool call id, a LF, then the function-call id. The
  // value is half of a report segment's idempotency key, so it travels through a queue filename, an
  // HTTP body and a database column — none of which want a raw control character.
  const { subagents } = correlateSubagents([
    start(1, { sid: 'call-07fdcd0c-3\nfc_2d0c19a8_0', task: 'audit' }),
    start(2, { sid: 'call-07fdcd0c-4\nfc_2d0c19a8_1', task: 'review' }),
  ]);
  assert.deepEqual(
    subagents.map((s) => s.agent_id),
    ['call-07fdcd0c-3 fc_2d0c19a8_0', 'call-07fdcd0c-4 fc_2d0c19a8_1'],
  );
  // Both halves are kept, which is what keeps two workers of one fan-out apart.
  assert.equal(new Set(subagents.map((s) => s.agent_id)).size, 2);
});

test('agent_id and agent_type are bounded to the columns the backend accepts', () => {
  const { subagents } = correlateSubagents([
    start(1, { sid: 'x'.repeat(400), stype: 'y'.repeat(400) }),
  ]);
  assert.equal(subagents[0].agent_id.length, MAX_AGENT_ID_CHARS);
  assert.equal(subagents[0].agent_type.length, 100);
});

test('agent_type comes from the stop when the start carried none, and is never invented', () => {
  const fromStop = correlateSubagents([
    start(1, { sid: 'a', task: 't' }),
    stop(2, { stype: HOST_TYPE, task: 't' }),
  ]).subagents[0];
  assert.equal(fromStop.agent_type, HOST_TYPE);

  const neither = correlateSubagents([start(1, { sid: 'a' })]).subagents[0];
  assert.equal(neither.agent_type, UNKNOWN_AGENT_TYPE, 'not "general-purpose" — the host said nothing');
});

test('a stop stamped before its own start is clamped, never a negative-width span', () => {
  const { subagents } = correlateSubagents([
    start(5, { sid: 'a', task: 't' }),
    { ts: at(3), ev: 'subagent_stop', task: 't' },
  ]);
  // Sorted by timestamp, so the stop is seen first and is an orphan; the start is then closed
  // synthetically at the last activity, which is its own start.
  assert.equal(subagents.length, 1);
  assert.ok(Date.parse(subagents[0].ended_at) >= Date.parse(subagents[0].started_at));
});

test('undated subagent events are counted rather than placed at an invented time', () => {
  const { subagents, diagnostics } = correlateSubagents([
    gen(0),
    { ev: 'subagent_start', sid: 'a' },
    { ev: 'subagent_stop', task: 'a' },
  ]);
  assert.deepEqual(subagents, []);
  assert.equal(diagnostics.undated, 2);
  assert.equal(diagnostics.starts, 1);
  assert.equal(diagnostics.stops, 1);
});

test('a stream with no subagent events yields nothing and says nothing went wrong', () => {
  const { subagents, diagnostics } = correlateSubagents([gen(0), gen(1)]);
  assert.deepEqual(subagents, []);
  assert.deepEqual(diagnostics, {
    starts: 0, stops: 0, matched: 0, ambiguous: 0, orphaned: 0, synthetic: 0, undated: 0,
  });
});

test('a non-array input is answered, not thrown at the hook', () => {
  assert.deepEqual(correlateSubagents(null).subagents, []);
  assert.deepEqual(correlateSubagents(undefined).subagents, []);
});

test('subagentIntervals hands the billing path half-open pairs and drops empty spans', () => {
  const { subagents } = correlateSubagents([
    start(1, { sid: 'a', task: 'alpha' }),
    stop(3, { task: 'alpha' }),
    start(4, { sid: 'b' }), // never stops, and nothing follows it — zero length
  ]);
  assert.deepEqual(subagentIntervals(subagents), [[at(1), at(3)]]);
  assert.deepEqual(subagentIntervals([]), []);
  assert.deepEqual(subagentIntervals(undefined), []);
});
