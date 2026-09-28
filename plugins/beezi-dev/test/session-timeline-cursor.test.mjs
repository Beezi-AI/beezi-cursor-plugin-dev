import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSessionTimeline,
  postSessionTimeline,
  timestampOf,
  fitSubagentsToBudget,
  fitPeriodsToBudget,
  buildPeriods,
  TIMELINE_BODY_BUDGET_BYTES,
  SUBAGENT_RESERVE_BYTES,
  MAX_SUBAGENTS,
  MAX_PERIODS,
  BREAK_MS,
  IDLE_GAP_MS,
} from '../lib/session-timeline-cursor.mjs';
import { buildActiveIntervals } from '../lib/active-time.mjs';

const at = (min) => Date.parse(`2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`);
const gen = (min) => ({ ts: at(min), ev: 'gen', model: 'gpt-5' });
const tool = (min) => ({ ts: at(min), ev: 'tool', tool: 'read_file', bytes: 10 });
const stop = (min) => ({ ts: at(min), ev: 'stop' });
const subStart = (min, fields = {}) => ({ ts: at(min), ev: 'subagent_start', ...fields });
const subStop = (min, fields = {}) => ({ ts: at(min), ev: 'subagent_stop', ...fields });

const timelineOf = (events) => computeSessionTimeline('conv-1', { readEvents: () => events });

test('consecutive activity inside the idle threshold is one working period', () => {
  const tl = timelineOf([gen(0), tool(1), tool(2)]);
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].state, 'working');
  assert.equal(tl.periods[0].started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(tl.periods[0].ended_at, '2026-01-01T00:02:00.000Z');
});

test('the gap after a stop is time the user owns', () => {
  const tl = timelineOf([gen(0), stop(1), gen(3)]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'waiting_user']);
  assert.equal(tl.periods[1].started_at, '2026-01-01T00:01:00.000Z');
  assert.equal(tl.periods[1].ended_at, '2026-01-01T00:03:00.000Z');
});

test('a long gap after a stop is the user, not idle', () => {
  // Thirty minutes between a turn end and the next generation is a human reading a diff, and it
  // stays the human's however far past the idle threshold it runs. Classifying it `idle` — which is
  // what the old ordering did for anything over five minutes — charted a quarter of an hour of the
  // user's own time as nobody's.
  const tl = timelineOf([gen(0), stop(1), gen(30)]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'waiting_user']);
});

test('a user wait past the break threshold is a break', () => {
  // Three hours after a stop is a person who left, not a person thinking. What must never happen is
  // a 14-hour `waiting_user` band claiming someone sat there all night.
  const overnight = { ts: at(1) + BREAK_MS + 1000, ev: 'gen', model: 'gpt-5' };
  const tl = timelineOf([gen(0), stop(1), overnight]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'break']);
});

test('a long gap MID-TURN is the agent waiting, and stays idle at any length', () => {
  // No turn end in front of it: a background script or a fan-out the agent is blocked on. However
  // long it runs it is never the human's time, so BREAK_MS does not apply to it.
  const later = { ts: at(0) + BREAK_MS * 2, ev: 'gen', model: 'gpt-5' };
  const tl = timelineOf([gen(0), later]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['idle']);
});

test('a long gap between two work events is idle', () => {
  const tl = timelineOf([gen(0), gen(20)]);
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].state, 'idle');
});

test('adjacent periods of the same state are merged', () => {
  const tl = timelineOf([gen(0), tool(1), tool(2), tool(3)]);
  assert.equal(tl.periods.length, 1);
});

test('plan_events is always empty — Cursor has no plan mode', () => {
  const tl = timelineOf([gen(0), stop(1), gen(2)]);
  assert.deepEqual(tl.plan_events, []);
});

test('a session that delegated nothing still sends subagents, empty', () => {
  // The DTO REQUIRES the key. Omitting it fails validation and takes the periods with it.
  const tl = timelineOf([gen(0), stop(1), gen(2)]);
  assert.deepEqual(tl.subagents, []);
});

test('a correlated subagent ships as the four keys the backend accepts, and no others', () => {
  const tl = timelineOf([
    gen(0),
    subStart(1, { sid: 'sa_01', stype: 'general-purpose', task: 'audit' }),
    subStop(3, { stype: 'general-purpose', status: 'completed', task: 'audit' }),
    stop(4),
  ]);
  assert.deepEqual(tl.subagents, [{
    agent_id: 'sa_01',
    agent_type: 'general-purpose',
    started_at: '2026-01-01T00:01:00.000Z',
    ended_at: '2026-01-01T00:03:00.000Z',
  }]);
  // The rich span carries task/ambiguous/synthetic/millis; an unknown key here is rejected by the
  // DTO and the rejection takes the whole timeline down.
  assert.deepEqual(Object.keys(tl.subagents[0]), ['agent_id', 'agent_type', 'started_at', 'ended_at']);
});

test('the gap after a subagent stops is the parent working, not the user thinking', () => {
  // `subagent_stop` must never join TURN_END_EVENTS: a fan-out would then bill the parent's own
  // think-time to the user as waiting_user on every delegation.
  const tl = timelineOf([
    gen(0),
    subStart(1, { sid: 'sa_01', task: 'a' }),
    subStop(2, { task: 'a' }),
    gen(3),
  ]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working']);
});

test('a doubled event stream produces the same subagents as a single one', () => {
  // THE "every machine" BUG. Both hook registries are permanently installed, so one subagentStart
  // fires twice and writes two sidecar lines milliseconds apart. Correlating the raw stream opens two
  // spans per worker and draws every subagent twice, forever, on every machine.
  const single = [
    gen(0),
    subStart(1, { sid: 'sa_01', stype: 'general-purpose', task: 'audit', eid: 'toolu_1' }),
    subStop(3, { stype: 'general-purpose', status: 'completed', task: 'audit', duration_ms: 120000 }),
    stop(4),
  ];
  // Interleaved the way two registries actually write: the same line again, a few millis later.
  const doubled = single.flatMap((event) => [event, { ...event, ts: event.ts + 7 }]);

  const one = timelineOf(single);
  const two = timelineOf(doubled);
  assert.equal(one.subagents.length, 1);
  assert.equal(two.subagents.length, 1, 'the second registry must not mint a second worker');
  assert.deepEqual(two.subagents[0].agent_id, one.subagents[0].agent_id);
});

test('withholding the collapse withholds the subagents rather than doubling them', () => {
  const doubled = [
    subStart(1, { sid: 'sa_01', task: 'audit' }),
    { ...subStart(1, { sid: 'sa_01', task: 'audit' }), ts: at(1) + 7 },
    gen(4),
  ];
  const tl = computeSessionTimeline('conv-1', {
    readEvents: () => doubled,
    dedupeEvents: null,
  });
  assert.deepEqual(tl.subagents, [], 'an empty card is a visible absence; a doubled one is a lie');
});

test('three parallel workers each get their own lane', () => {
  const tl = timelineOf([
    subStart(1, { sid: 'a', stype: 'general-purpose', task: 'alpha', parallel: true }),
    subStart(1, { sid: 'b', stype: 'general-purpose', task: 'bravo', parallel: true }),
    subStart(1, { sid: 'c', stype: 'general-purpose', task: 'charlie', parallel: true }),
    subStop(5, { stype: 'general-purpose', task: 'charlie' }),
    subStop(7, { stype: 'general-purpose', task: 'alpha' }),
    subStop(9, { stype: 'general-purpose', task: 'bravo' }),
    stop(10),
  ]);
  assert.deepEqual(tl.subagents.map((s) => s.agent_id).sort(), ['a', 'b', 'c']);
});

test('diagnostics reach the caller by callback, never as a key on the payload', () => {
  const seen = [];
  const tl = computeSessionTimeline('conv-1', {
    readEvents: () => [
      subStart(1, { sid: 'a', task: 'same' }),
      subStart(2, { sid: 'b', task: 'same' }),
      subStop(5, { task: 'same' }),
      subStop(6, { task: 'same' }),
      subStop(7, { task: 'nobody started me' }),
      gen(8),
    ],
    onSubagentDiagnostics: (d) => seen.push(d),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ambiguous, 1);
  assert.equal(seen[0].orphaned, 1);
  assert.deepEqual(
    Object.keys(tl).sort(),
    ['ended_at', 'generated_at', 'periods', 'plan_events', 'started_at', 'subagents'],
  );
});

test('a throwing diagnostics sink never breaks the timeline', () => {
  const tl = computeSessionTimeline('conv-1', {
    readEvents: () => [subStart(1, { sid: 'a' }), gen(2)],
    onSubagentDiagnostics: () => { throw new Error('sink is on fire'); },
  });
  assert.equal(tl.subagents.length, 1);
});

test('1000 subagents do not produce a body Express would reject', () => {
  // The binding limit is NOT the DTO's max of 1000 — it is Express's ~100 KB default body cap, which
  // nobody has overridden. A 413 rejects the ENTIRE timeline, periods included, so the guard drops
  // the least valuable entries rather than eating the rejection.
  const events = [gen(0)];
  for (let i = 0; i < 1200; i++) {
    events.push(subStart(1, { sid: `sa_${String(i).padStart(4, '0')}`, stype: 'general-purpose', task: `task ${i}` }));
    events.push(subStop(2 + (i % 50), { stype: 'general-purpose', status: 'completed', task: `task ${i}` }));
  }
  events.push(stop(59));

  const tl = timelineOf(events);
  const body = JSON.stringify({ sessionId: 'conv-1', ...tl });
  assert.ok(tl.subagents.length > 0, 'the guard must not empty the list on a normal fan-out');
  assert.ok(tl.subagents.length <= MAX_SUBAGENTS, `${tl.subagents.length} exceeds the DTO cap`);
  assert.ok(
    Buffer.byteLength(body, 'utf-8') < 100 * 1024,
    `body was ${Buffer.byteLength(body, 'utf-8')} bytes`,
  );
});

test('the size guard drops the shortest spans first, then the latest start', () => {
  const entry = (id, fromMs, toMs) => ({
    agent_id: id,
    agent_type: 'general-purpose',
    started_at: new Date(fromMs).toISOString(),
    ended_at: new Date(toMs).toISOString(),
  });
  const base = at(0);
  const entries = [
    entry('long', base, base + 30 * 60_000),
    entry('hairline', base, base + 1000),
    entry('early-tie', base + 5 * 60_000, base + 6 * 60_000),
    entry('late-tie', base + 9 * 60_000, base + 10 * 60_000),
  ];
  const bytes = (list) => list.reduce((acc, e) => acc + Buffer.byteLength(JSON.stringify(e), 'utf-8') + 1, 0);

  // Room for three of the four: the one-second bar nobody can see goes first.
  const kept = fitSubagentsToBudget(entries, 0, bytes(entries) - 1).map((e) => e.agent_id);
  assert.deepEqual(kept, ['long', 'early-tie', 'late-tie']);

  // Room for two: of the two equal-length spans, the later start goes — the tail of a fan-out is its
  // most repetitive part.
  const two = fitSubagentsToBudget(entries, 0, bytes([entries[0], entries[2]])).map((e) => e.agent_id);
  assert.deepEqual(two, ['long', 'early-tie']);
});

test('the size guard leaves a list that already fits completely alone', () => {
  const entries = [{ agent_id: 'a', agent_type: 'general-purpose', started_at: 'x', ended_at: 'y' }];
  assert.equal(fitSubagentsToBudget(entries, 0, TIMELINE_BODY_BUDGET_BYTES), entries);
  assert.deepEqual(fitSubagentsToBudget([], 0, 10), []);
});

test('the session span covers the first and last timestamped event', () => {
  const tl = timelineOf([gen(2), gen(0), gen(1)]);
  assert.equal(tl.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(tl.ended_at, '2026-01-01T00:02:00.000Z');
  assert.ok(Date.parse(tl.generated_at) > 0);
});

test('out-of-order events are sorted before classification', () => {
  const tl = timelineOf([gen(3), stop(1), gen(0)]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'waiting_user']);
});

test('an empty sidecar yields no timeline', () => {
  assert.equal(timelineOf([]), null);
});

test('events with no timestamp yield null rather than a zero-length timeline', () => {
  // Events exist, so this is a writer/reader schema mismatch — reporting an empty timeline would
  // hide it behind something that looks like an idle session.
  assert.equal(timelineOf([{ ev: 'gen', model: 'gpt-5' }, { ev: 'stop' }]), null);
});

test('a throwing reader yields null instead of breaking the hook', () => {
  assert.equal(
    computeSessionTimeline('conv-1', {
      readEvents: () => {
        throw new Error('unreadable');
      },
    }),
    null,
  );
});

test('epoch seconds, epoch millis and ISO timestamps are all accepted', () => {
  assert.equal(timestampOf({ ts: at(1) }), at(1));
  assert.equal(timestampOf({ ts: Math.floor(at(1) / 1000) }), at(1));
  assert.equal(timestampOf({ ts: '2026-01-01T00:01:00.000Z' }), at(1));
  assert.equal(timestampOf({ timestamp: at(1) }), at(1));
  assert.equal(timestampOf({ ts: 'not a date' }), null);
  assert.equal(timestampOf({}), null);
});

test('postSessionTimeline refuses an incomplete payload and a missing token', async () => {
  assert.deepEqual(await postSessionTimeline({ periods: [] }, 't'), {
    reported: false,
    reason: 'missing-fields',
  });
  assert.deepEqual(await postSessionTimeline({ sessionId: 's' }, 't'), {
    reported: false,
    reason: 'missing-fields',
  });
  assert.deepEqual(await postSessionTimeline({ sessionId: 's', periods: [] }, null), {
    reported: false,
    reason: 'no-token',
  });
});

test('postSessionTimeline posts to the timeline endpoint and reports the status', async () => {
  const calls = [];
  const result = await postSessionTimeline({ sessionId: 's', periods: [] }, 'token', {
    apiBase: () => 'https://api.test',
    endpoints: { sessionsTimeline: '/sessions/timeline' },
    postJson: (url, token, body, opts) => {
      calls.push({ url, token, body, opts });
      return { status: 204 };
    },
    timeoutMs: 1200,
  });
  assert.deepEqual(result, { reported: true, status: 204 });
  assert.equal(calls[0].url, 'https://api.test/sessions/timeline');
  assert.equal(calls[0].token, 'token');
  assert.equal(calls[0].opts.timeoutMs, 1200);
});

test('a non-2xx response is reported as not sent', async () => {
  const result = await postSessionTimeline({ sessionId: 's', periods: [] }, 'token', {
    apiBase: () => 'https://api.test',
    endpoints: { sessionsTimeline: '/sessions/timeline' },
    postJson: () => ({ status: 503 }),
  });
  assert.deepEqual(result, { reported: false, status: 503 });
});

test('a transport failure is swallowed into a result, never thrown at the hook', async () => {
  const result = await postSessionTimeline({ sessionId: 's', periods: [] }, 'token', {
    apiBase: () => 'https://api.test',
    endpoints: { sessionsTimeline: '/sessions/timeline' },
    postJson: () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.deepEqual(result, { reported: false, reason: 'network' });
});

// ---------------------------------------------------------------------------
// M03.3 — idle boundary, long breaks, and validated waiting subtypes
// ---------------------------------------------------------------------------

const atMs = (ms) => ({ ts: 1700000000000 + ms, ev: 'tool', tool: 'read_file', bytes: 10 });
const stopAtMs = (ms) => ({ ts: 1700000000000 + ms, ev: 'stop' });
const statesOf = (events, options) =>
  computeSessionTimeline('conv-1', { readEvents: () => events }, options).periods.map((p) => p.state);

test('a gap one millisecond below the idle threshold is still working', () => {
  assert.deepEqual(statesOf([atMs(0), atMs(299999)]), ['working']);
});

test('a gap of exactly the idle threshold is idle — the same boundary active-time bills at', () => {
  // active-time.mjs drops a gap when `gap >= idleGapMs`, so 300000 ms contributes no billed
  // duration. Charting it as activity made exactly five minutes visible-but-unbilled.
  assert.deepEqual(statesOf([atMs(0), atMs(IDLE_GAP_MS)]), ['idle']);
});

test('a gap one millisecond above the idle threshold is idle', () => {
  assert.deepEqual(statesOf([atMs(0), atMs(300001)]), ['idle']);
});

test('the idle boundary agrees with the billed duration to the millisecond', () => {
  // Both sides of the same boundary, asserted against the arithmetic that bills it.
  assert.equal(buildActiveIntervals([0, IDLE_GAP_MS - 1], IDLE_GAP_MS).length, 1);
  assert.equal(buildActiveIntervals([0, IDLE_GAP_MS], IDLE_GAP_MS).length, 0);
  assert.deepEqual(statesOf([atMs(0), atMs(IDLE_GAP_MS - 1)]), ['working']);
  assert.deepEqual(statesOf([atMs(0), atMs(IDLE_GAP_MS)]), ['idle']);
});

test('an agent-side gap is idle whatever the caller asked for', () => {
  // No turn end in front of these, so the break threshold is not theirs to cross under any option.
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)]), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], {}), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], { allowBreakState: false }), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], { allowBreakState: true }), ['idle']);
});

test('one millisecond below the threshold is still the user, at and above it is a break', () => {
  // Both sides of the boundary, measured from a TURN END, which is the only place it applies.
  const after = (ms) => [atMs(0), stopAtMs(1000), atMs(1000 + ms)];
  assert.deepEqual(statesOf(after(BREAK_MS - 1)), ['working', 'waiting_user']);
  assert.deepEqual(statesOf(after(BREAK_MS)), ['working', 'break']);
  assert.deepEqual(statesOf(after(BREAK_MS + 1)), ['working', 'break']);
});

test('a break outranks waiting_user — an overnight gap after a stop is not the user thinking', () => {
  const events = [atMs(0), stopAtMs(1000), atMs(1000 + BREAK_MS)];
  assert.deepEqual(statesOf(events), ['working', 'break']);
  // Opting OUT returns the pre-break vocabulary, and the gap stays the user's — never `idle`, which
  // would claim the agent was busy with something of its own.
  assert.deepEqual(statesOf(events, { allowBreakState: false }), ['working', 'waiting_user']);
});

test('periods merge only when state AND subtype agree', () => {
  const marked = computeSessionTimeline(
    'conv-1',
    { readEvents: () => [atMs(0), stopAtMs(1000), atMs(2000), stopAtMs(3000), atMs(4000)] },
    { permissionMarkers: [{ startMs: 1700000003000, endMs: 1700000004000 }] },
  );
  // Two waiting_user gaps in a row (1000→2000 and 3000→4000) with only the second one covered by a
  // permission marker: merging them would put a subtype on time nothing observed.
  assert.deepEqual(marked.periods.map((p) => p.state), ['working', 'waiting_user', 'working', 'waiting_user']);
  assert.equal('waiting_subtype' in marked.periods[1], false);
  assert.equal(marked.periods[3].waiting_subtype, 'command_approval', 'the backend vocabulary, not a synonym');
});

test('two adjacent waits with the same subtype do merge', () => {
  const tl = computeSessionTimeline(
    'conv-1',
    { readEvents: () => [stopAtMs(0), stopAtMs(1000), stopAtMs(2000)] },
    { permissionMarkers: [{ startMs: 1700000000000, endMs: 1700000002000 }] },
  );
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].waiting_subtype, 'command_approval');
});

test('no marker means no key at all — an undefined subtype would churn the timeline signature', () => {
  const tl = computeSessionTimeline('conv-1', { readEvents: () => [atMs(0), stopAtMs(1000), atMs(2000)] });
  for (const period of tl.periods) assert.equal('waiting_subtype' in period, false);
});

test('a subtype is never inferred from an event name — only a validated marker supplies one', () => {
  // `permission`, `approval` and friends are not Cursor event kinds this plugin has ever observed.
  // A classifier that guessed from a name would invent a measurement.
  const tl = computeSessionTimeline('conv-1', {
    readEvents: () => [{ ts: 1700000000000, ev: 'permission_request' }, atMs(1000)],
  });
  for (const period of tl.periods) assert.equal('waiting_subtype' in period, false);
});

test('malformed markers are ignored rather than trusted', () => {
  const events = [atMs(0), stopAtMs(1000), atMs(2000)];
  for (const markers of [
    null,
    'permission',
    [{ startMs: 'x', endMs: 1700000002000 }],
    [{ startMs: 1700000002000, endMs: 1700000001000 }],
    [{ startMs: NaN, endMs: NaN }],
    [{ startMs: 1700000001000 }],
    [null],
  ]) {
    const tl = computeSessionTimeline('conv-1', { readEvents: () => events }, { permissionMarkers: markers });
    for (const period of tl.periods) assert.equal('waiting_subtype' in period, false, `markers: ${JSON.stringify(markers)}`);
  }
});

test('a marker that only partly covers a wait does not label it', () => {
  const tl = computeSessionTimeline(
    'conv-1',
    { readEvents: () => [atMs(0), stopAtMs(1000), atMs(5000)] },
    { permissionMarkers: [{ startMs: 1700000001000, endMs: 1700000003000 }] },
  );
  assert.equal('waiting_subtype' in tl.periods[1], false);
});

test('classification is timezone independent — the same instants classify the same way', () => {
  const prev = process.env.TZ;
  const run = () => statesOf([atMs(0), stopAtMs(1000), atMs(1000 + BREAK_MS)], { allowBreakState: true });
  process.env.TZ = 'UTC';
  const utc = run();
  process.env.TZ = 'Pacific/Kiritimati';
  const plus14 = run();
  if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  assert.deepEqual(plus14, utc);
  assert.deepEqual(utc, ['working', 'break']);
});

// ─── Cursor CLI: subagents recovered from the chat store (A6) ───────────────
//
// The CLI fires no subagent hooks; lib/cli-subagents-cursor.mjs rebuilds the lines from the CLI's
// own chat store. The timeline enriches too — not only the checkpoint — so backfill and sync, which
// call this with the raw reader, draw the lanes as well. Epoch MILLISECONDS (timestampOf reads a
// number below 1e12 as seconds).
const T = 1790000000000;
const cliKids = [
  { agentId: 'k1', typeName: 'generalPurpose', toolCallId: 't1', startMs: T + 2000, endMs: T + 9000 },
  { agentId: 'k2', typeName: 'generalPurpose', toolCallId: 't2', startMs: T + 2100, endMs: T + 6000 },
];
const cliStream = [
  { ts: T, ev: 'gen', model: 'claude-opus-5', gen_id: 'g1' },
  { ts: T + 1000, ev: 'tool', tool: 'Read', bytes: 10 },
  { ts: T + 10000, ev: 'stop' },
];

test('a CLI session gets its subagent lanes from the chat store', () => {
  const seen = [];
  const tl = computeSessionTimeline('parent', {
    readEvents: () => cliStream,
    deadline: T + 123,
    listCliSubagents: (id, deps) => { seen.push([id, deps.deadline]); return cliKids; },
  });
  assert.deepEqual(tl.subagents.map((s) => [s.agent_id, s.agent_type]), [['k1', 'generalPurpose'], ['k2', 'generalPurpose']]);
  assert.equal(tl.subagents[0].ended_at, new Date(T + 9000).toISOString());
  assert.equal(tl.subagents[1].ended_at, new Date(T + 6000).toISOString());
  // The deps (and the checkpoint's deadline in them) reach the chat-store reader.
  assert.deepEqual(seen, [['parent', T + 123]]);
});

test('an already-enriched stream (the checkpoint path) is not enriched twice', () => {
  let calls = 0;
  const enriched = [
    ...cliStream,
    { ts: T + 2000, ev: 'subagent_start', sid: 'k1', stype: 'generalPurpose' },
    { ts: T + 9000, ev: 'subagent_stop', sid: 'k1', stype: 'generalPurpose', status: 'completed' },
  ];
  const tl = computeSessionTimeline('parent', {
    readEvents: () => enriched,
    dedupeEvents: (events) => ({ events }),
    listCliSubagents: () => { calls += 1; return cliKids; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(tl.subagents.map((s) => s.agent_id), ['k1']);
});

test('with the collapse withheld the chat store is not read either', () => {
  let calls = 0;
  const tl = computeSessionTimeline('parent', {
    readEvents: () => cliStream,
    dedupeEvents: null,
    listCliSubagents: () => { calls += 1; return cliKids; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(tl.subagents, []);
});

test('a chat-store reader that throws leaves the timeline as it was', () => {
  const tl = computeSessionTimeline('parent', {
    readEvents: () => cliStream,
    listCliSubagents: () => { throw new Error('locked'); },
  });
  assert.deepEqual(tl.subagents, []);
  assert.ok(tl.periods.length > 0);
});

// ─── session_start is a boundary: the gap after it is the user's ───────────
//
// The CLI (and an IDE composer) opens a session before anyone types. Without this, a user who thinks
// for more than five minutes before the first prompt got an `idle` period, which the portal draws as
// "Subagents working".
const sessionStart = (ms) => ({ ts: T + ms, ev: 'session_start' });
const toolAt = (ms) => ({ ts: T + ms, ev: 'tool', tool: 'Read', bytes: 10 });

test('the gap after session_start is waiting_user', () => {
  const tl = computeSessionTimeline('s', { readEvents: () => [sessionStart(0), toolAt(17000)] });
  assert.deepEqual(tl.periods, [{
    state: 'waiting_user',
    started_at: new Date(T).toISOString(),
    ended_at: new Date(T + 17000).toISOString(),
  }]);
});

test('a long gap after session_start is waiting_user, never idle', () => {
  const tl = computeSessionTimeline('s', { readEvents: () => [sessionStart(0), toolAt(400000)] });
  assert.ok(400000 > IDLE_GAP_MS);
  assert.deepEqual(tl.periods.map((p) => p.state), ['waiting_user']);
  assert.equal(tl.started_at, new Date(T).toISOString());
});

// ─── turn STARTS: the `prompt` line beforeSubmitPrompt writes ───────────────
//
// Verified on a real CLI session: a turn that calls no tool leaves only `gen` + `stop` in the
// sidecar, so every gap after a stop was `waiting_user`, the first turn (before the first line) was
// never drawn, and the trailing `session_end` added one more "User input" band at the end. The
// portal showed almost nothing but "User input". scripts/prompt-submit.mjs now writes a `prompt`
// line when the human presses Send, and the classifier reads it as the turn's start.
//
// Every prompt carries its own `eid` (the generation id the hook reads), the way real lines do, so
// the default duplicate collapse keeps each one.
const promptAt = (ms, eid) => ({ ts: T + ms, ev: 'prompt', eid });
const stopAt = (ms) => ({ ts: T + ms, ev: 'stop' });
const genAt = (ms, genId) => ({ ts: T + ms, ev: 'gen', model: 'claude-opus-5', gen_id: genId, eid: genId });
const sessionEndAt = (ms) => ({ ts: T + ms, ev: 'session_end' });
const iso = (ms) => new Date(T + ms).toISOString();
const shape = (tl) => tl.periods.map((p) => [p.state, Date.parse(p.started_at) - T, Date.parse(p.ended_at) - T]);
const promptStates = (events, options) =>
  computeSessionTimeline('conv-1', { readEvents: () => events }, options).periods.map((p) => p.state);

test('a CLI turn is User input then Agent working, and the timeline ends on the agent', () => {
  const tl = computeSessionTimeline('cli', {
    readEvents: () => [promptAt(0, 'g1'), stopAt(20000), promptAt(60000, 'g2'), stopAt(75000), sessionEndAt(300000)],
  });
  assert.deepEqual(shape(tl), [
    ['working', 0, 20000],
    ['waiting_user', 20000, 60000],
    ['working', 60000, 75000],
  ]);
  // The axis starts at the first prompt and ends at the last turn's stop: no trailing "User input"
  // band from session_end, and no blank tail after the last drawn period either.
  assert.equal(tl.started_at, iso(0));
  assert.equal(tl.ended_at, iso(75000));
});

test('the shape stop.mjs really writes (gen, then stop) draws the same way', () => {
  // stop.mjs appends the turn's `gen` line a millisecond before its `stop`, so a no-tool CLI turn is
  // prompt, gen, stop — not prompt, stop.
  const tl = computeSessionTimeline('cli', {
    readEvents: () => [
      promptAt(0, 'g1'), genAt(20000, 'g1'), stopAt(20001),
      promptAt(60000, 'g2'), genAt(75000, 'g2'), stopAt(75001),
      sessionEndAt(300000),
    ],
  });
  assert.deepEqual(shape(tl), [
    ['working', 0, 20001],
    ['waiting_user', 20001, 60000],
    ['working', 60000, 75001],
  ]);
  assert.equal(tl.ended_at, iso(75001));
});

test('a stream with no prompt lines classifies exactly as before', () => {
  // `-p`, builds that do not fire beforeSubmitPrompt, and every sidecar written before the hook
  // existed. The only change is that session_end no longer draws a trailing wait.
  const tl = computeSessionTimeline('legacy', {
    readEvents: () => [genAt(0, 'a'), toolAt(10000), stopAt(20000), genAt(80000, 'b'), stopAt(90000)],
  });
  assert.deepEqual(shape(tl), [
    ['working', 0, 20000],
    ['waiting_user', 20000, 80000],
    ['working', 80000, 90000],
  ]);
});

test('turns with and without a prompt line mix in one stream', () => {
  // A registry that started firing mid-session, or one lost prompt line: the prompted turn draws as
  // working from its Send, the unprompted one falls back to the stop rule.
  const tl = computeSessionTimeline('mixed', {
    readEvents: () => [
      promptAt(0, 'g1'), stopAt(20000),
      genAt(50000, 'g2'), stopAt(55000),
      promptAt(90000, 'g3'), toolAt(100000), stopAt(110000),
    ],
  });
  assert.deepEqual(shape(tl), [
    ['working', 0, 20000],
    ['waiting_user', 20000, 50000],
    ['working', 50000, 55000],
    ['waiting_user', 55000, 90000],
    ['working', 90000, 110000],
  ]);
});

test('session_start followed by a prompt drops the lead-in: the timeline starts when the human speaks', () => {
  // The Claude plugin's dropLeadIn: the minutes between opening the CLI and typing the first prompt
  // are not a turn, and a "User input" band there is time nobody was asked to account for.
  const tl = computeSessionTimeline('s', {
    readEvents: () => [sessionStart(0), promptAt(40000, 'g1'), stopAt(60000)],
  });
  assert.deepEqual(shape(tl), [['working', 40000, 60000]]);
  assert.equal(tl.started_at, iso(40000));
  assert.equal(tl.ended_at, iso(60000));
});

test('session_start with no prompt keeps the lead-in as the user wait it always was', () => {
  const tl = computeSessionTimeline('s', {
    readEvents: () => [sessionStart(0), toolAt(17000), stopAt(20000)],
  });
  assert.deepEqual(shape(tl), [['waiting_user', 0, 17000], ['working', 17000, 20000]]);
  assert.equal(tl.started_at, iso(0));
});

test('a prompt followed by five silent minutes is idle, never the user', () => {
  // Documented, not accidental: after Send the turn is the agent's, so a long gap with no tool call
  // is the agent waiting on something of its own (a long think, a slow model), at the same
  // threshold billing uses. It is never `waiting_user`, and never a break however long it runs.
  const tl = computeSessionTimeline('slow', {
    readEvents: () => [promptAt(0, 'g1'), stopAt(IDLE_GAP_MS)],
  });
  assert.deepEqual(shape(tl), [['idle', 0, IDLE_GAP_MS]]);
  assert.deepEqual(promptStates([promptAt(0, 'g1'), stopAt(IDLE_GAP_MS - 1)]), ['working']);
  assert.deepEqual(promptStates([promptAt(0, 'g1'), stopAt(BREAK_MS * 2)]), ['idle']);
});

test('the gap before a prompt is the user, and a break past BREAK_MS', () => {
  const events = [promptAt(0, 'g1'), stopAt(1000), promptAt(1000 + BREAK_MS, 'g2'), stopAt(2000 + BREAK_MS)];
  assert.deepEqual(promptStates(events), ['working', 'break', 'working']);
  // Opting out of break keeps the long wait the user's, as it always has.
  assert.deepEqual(promptStates(events, { allowBreakState: false }), ['working', 'waiting_user', 'working']);
  // A prompt that follows a tool call with no stop in between (an aborted turn) still ends a wait.
  assert.deepEqual(
    promptStates([promptAt(0, 'g1'), toolAt(5000), promptAt(30000, 'g2'), stopAt(40000)]),
    ['working', 'waiting_user', 'working'],
  );
});

test('a validated permission marker still labels the wait before a prompt', () => {
  const tl = computeSessionTimeline(
    'm',
    { readEvents: () => [promptAt(0, 'g1'), stopAt(1000), promptAt(5000, 'g2'), stopAt(6000)] },
    { permissionMarkers: [{ startMs: T + 1000, endMs: T + 5000 }] },
  );
  assert.equal(tl.periods[1].state, 'waiting_user');
  assert.equal(tl.periods[1].waiting_subtype, 'command_approval');
});

test('subagents inside a prompted turn keep their lanes and the turn stays working', () => {
  const tl = computeSessionTimeline('fan', {
    readEvents: () => [
      promptAt(0, 'g1'),
      { ts: T + 1000, ev: 'subagent_start', sid: 'sa_01', stype: 'general-purpose', task: 'a' },
      { ts: T + 30000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'a' },
      stopAt(40000),
      sessionEndAt(100000),
    ],
  });
  assert.deepEqual(tl.subagents, [{
    agent_id: 'sa_01',
    agent_type: 'general-purpose',
    started_at: iso(1000),
    ended_at: iso(30000),
  }]);
  assert.deepEqual(shape(tl), [['working', 0, 40000]]);
  assert.equal(tl.ended_at, iso(40000));
});

// The session span is widened by any subagent lane, because a lane is drawn on the same axis as the
// periods. Codex review (MAJOR): the widening loop read `startedMs` / `endedMs`, but the spans
// correlateSubagents returns spell them `started_ms` / `ended_ms` — so the loop never widened
// anything, and a background subagent whose missing stop was synthetically closed at session_end
// was drawn as a lane running 58 seconds past the end of its own timeline.
test('a lane that outlives the last period widens the session span to cover it', () => {
  const tl = computeSessionTimeline('bg', {
    readEvents: () => [
      promptAt(0, 'g1'),
      // No subagent_stop at all: the background-subagent host bug. The correlator closes it at the
      // last activity, which is the trailing session_end.
      { ts: T + 1000, ev: 'subagent_start', sid: 'sa_bg', stype: 'general-purpose', task: 'bg' },
      stopAt(2000),
      sessionEndAt(60000),
    ],
  });
  assert.equal(tl.subagents.length, 1);
  assert.equal(tl.subagents[0].started_at, iso(1000));
  assert.equal(tl.subagents[0].ended_at, iso(60000));
  // The axis reaches the lane's end, so the lane is drawn inside it rather than past it.
  assert.equal(tl.started_at, iso(0));
  assert.equal(tl.ended_at, iso(60000));
  // The periods themselves are untouched: widening moves the axis, never a period's state.
  assert.deepEqual(shape(tl), [['working', 0, 2000]]);
});

test('a lane inside the turn widens nothing', () => {
  const tl = computeSessionTimeline('inner', {
    readEvents: () => [
      promptAt(0, 'g1'),
      { ts: T + 5000, ev: 'subagent_start', sid: 'sa_in', stype: 'general-purpose', task: 'in' },
      { ts: T + 15000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'in' },
      stopAt(20000),
      sessionEndAt(90000),
    ],
  });
  assert.equal(tl.subagents.length, 1);
  assert.equal(tl.subagents[0].ended_at, iso(15000));
  assert.equal(tl.started_at, iso(0));
  assert.equal(tl.ended_at, iso(20000));
});

test('a stream of nothing but session_end still yields a timeline, with no periods', () => {
  // Filtering session_end out of the anchors must not turn a real (if empty) session into null:
  // null means "schema mismatch", and a sidecar holding one shutdown line is not that.
  const tl = computeSessionTimeline('end-only', { readEvents: () => [sessionEndAt(0)] });
  assert.deepEqual(tl.periods, []);
  assert.equal(tl.started_at, iso(0));
  assert.equal(tl.ended_at, iso(0));
});

// ─── periods fit to the body budget (D1) ────────────────────────────────────
//
// MAX_PERIODS caps the array's LENGTH, never its byte size. A session that ran long enough produces
// periods well under that cap whose JSON still blows past TIMELINE_BODY_BUDGET_BYTES on its own — a
// 413 that drops the ENTIRE timeline (periods included) for a session whose only sin was running a
// long time, same as the subagent guard already exists for a session that delegated a lot.
const budgetBase = 1_820_000_000_000;
const budgetTool = (ms) => ({ ts: budgetBase + ms, ev: 'tool', tool: 'read_file', bytes: 10 });
const budgetStop = (ms) => ({ ts: budgetBase + ms, ev: 'stop' });

// `count` alternating working/waiting_user periods, none of which ever merge — adjacent states always
// differ — and none of which collide with delta-cursor's own-registry dedupe (any two identical-content
// lines land 1000 ms + IDLE_GAP_MS apart, well outside its 1000 ms window).
function manyPeriodsWindow(count) {
  const events = [budgetTool(0)];
  let ms = 0;
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      ms += 1000; // a short "working" gap: tool -> stop
      events.push(budgetStop(ms));
    } else {
      ms += IDLE_GAP_MS; // a turn ended, so the gap to the next anchor is "waiting_user"
      events.push(budgetTool(ms));
    }
  }
  return events;
}

test('a long session has its periods fit to the body budget instead of 413-dropped', () => {
  const events = manyPeriodsWindow(3000);
  const untrimmed = buildPeriods(events);
  assert.ok(untrimmed.length >= 3000, `expected >= 3000 periods, got ${untrimmed.length}`);
  assert.ok(untrimmed.length < MAX_PERIODS, 'this must exercise the budget fit, not the MAX_PERIODS cap');

  const tl = timelineOf(events);
  const body = Buffer.byteLength(JSON.stringify({ sessionId: 'conv-1', ...tl }), 'utf-8');
  assert.ok(body <= TIMELINE_BODY_BUDGET_BYTES, `body was ${body} bytes`);
  // Dropped OLDEST first, same direction as the existing MAX_PERIODS trim: the LAST period of the
  // untrimmed build is exactly the last period returned.
  assert.deepEqual(tl.periods[tl.periods.length - 1], untrimmed[untrimmed.length - 1]);
  // A session with no subagents must not lose the whole SUBAGENT_RESERVE_BYTES (20 KB) reserve for
  // nothing: an implementation that always carves out the flat constant (instead of Math.min-ing it
  // against what subagents actually need, here zero) would still pass every assertion above while
  // leaving ~20 KB of budget on the table.
  assert.ok(
    TIMELINE_BODY_BUDGET_BYTES - body < SUBAGENT_RESERVE_BYTES,
    `left ${TIMELINE_BODY_BUDGET_BYTES - body} bytes of budget unused with zero subagents to reserve for`,
  );
});

test('a small subagent list still ships alongside a body-budget-trimmed long session', () => {
  // Thousands of periods compete for the same 90 KB with a handful of subagent bytes. Without the
  // reserve, periods fill the budget right up to the envelope's edge and leave no room at all — the
  // single subagent below is dropped by fitSubagentsToBudget an instant later. With the reserve
  // (Math.min(SUBAGENT_RESERVE_BYTES, actual)) periods stop early enough that both ship.
  const periodEvents = manyPeriodsWindow(3000);
  const lastTs = periodEvents[periodEvents.length - 1].ts;
  const events = [
    ...periodEvents,
    { ts: lastTs + 1000, ev: 'subagent_start', sid: 'sa_01', stype: 'general-purpose', task: 'audit' },
    { ts: lastTs + 2000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'audit' },
  ];
  const tl = timelineOf(events);
  const body = Buffer.byteLength(JSON.stringify({ sessionId: 'conv-1', ...tl }), 'utf-8');
  assert.ok(body <= TIMELINE_BODY_BUDGET_BYTES, `body was ${body} bytes`);
  assert.deepEqual(tl.subagents.map((s) => s.agent_id), ['sa_01']);
});

test('fitPeriodsToBudget leaves a list that already fits completely alone', () => {
  const periods = [{ state: 'working', started_at: 'x', ended_at: 'y' }];
  assert.equal(fitPeriodsToBudget(periods, 0, TIMELINE_BODY_BUDGET_BYTES), periods);
  assert.deepEqual(fitPeriodsToBudget([], 0, 10), []);
});

test('fitPeriodsToBudget drops the OLDEST periods first and keeps the rest in order', () => {
  const period = (state, i) => ({ state, started_at: `s${i}`, ended_at: `e${i}` });
  const periods = [period('working', 0), period('idle', 1), period('working', 2), period('idle', 3)];
  const bytes = (list) =>
    list.reduce((acc, p) => acc + Buffer.byteLength(JSON.stringify(p), 'utf-8') + 1, 0);

  // Room for only the newest two.
  const kept = fitPeriodsToBudget(periods, 0, bytes(periods.slice(2)));
  assert.deepEqual(kept, periods.slice(2));

  // Room for only the newest one.
  const oneKept = fitPeriodsToBudget(periods, 0, bytes(periods.slice(3)));
  assert.deepEqual(oneKept, periods.slice(3));

  // The envelope counts against the same budget as the periods.
  const withEnvelope = fitPeriodsToBudget(periods, bytes(periods.slice(3)), bytes(periods.slice(2)));
  assert.deepEqual(withEnvelope, periods.slice(3));
});

// ─── a gap while subagents run is the agent's, even after a stop ───────────
//
// Seen on a real CLI session (2026.09.23-86fc751): the parent started six background `explore`
// workers, and its own turn ended with a `stop` 30 seconds later while all six were still running.
// The workers ran for nine more minutes. Nobody typed: the CLI resumed the parent on its own once
// they finished, with no prompt line. The stop rule drew those nine minutes as "User input", right
// above six lanes that said otherwise.
const bgKids = [20000, 23500, 27000, 30500, 34000, 38000].map((startMs, i) => ({
  agentId: `bg${i}`, typeName: 'explore', toolCallId: `tc${i}`, startMs: T + startMs, endMs: T + 580000 + i * 400,
}));

test('the wait after a stop while background workers run is idle, not the user', () => {
  const tl = computeSessionTimeline('bg-parent', {
    readEvents: () => [
      promptAt(0, 'g1'),
      genAt(20000, 'g1'),
      toolAt(20001),
      stopAt(58000),
      // The CLI's own resume once the workers are done: no prompt in front of it.
      genAt(625000, 'g2'),
      stopAt(625001),
      genAt(648000, 'g3'),
      toolAt(649000),
      stopAt(700000),
    ],
    listCliSubagents: () => bgKids,
  });
  assert.equal(tl.subagents.length, 6);
  assert.deepEqual(shape(tl).slice(0, 3), [
    ['working', 0, 58000],
    ['idle', 58000, 580000],
    ['working', 580000, 625001],
  ]);
});

test('a short wait after a stop while a worker runs is working, not the user', () => {
  // Covered gaps follow the mid-turn rule, threshold included: under IDLE_GAP_MS is working.
  const tl = computeSessionTimeline('bg-short', {
    readEvents: () => [promptAt(0, 'g1'), stopAt(5000), genAt(70000, 'g2'), stopAt(71000)],
    listCliSubagents: () => [{ agentId: 'k', typeName: 'explore', toolCallId: 't', startMs: T + 2000, endMs: T + 60000 }],
  });
  assert.deepEqual(shape(tl), [['working', 0, 71000]]);
});

test('a synthetically closed worker never turns a user wait into idle', () => {
  // The IDE's background-subagent bug: a start with no stop, closed by the correlator at the last
  // activity in the stream. That end is a guess, and counting it as coverage would draw every wait
  // on the human after it — up to the end of the session — as "Subagents working".
  const tl = computeSessionTimeline('bg-synthetic', {
    readEvents: () => [
      promptAt(0, 'g1'),
      { ts: T + 1000, ev: 'subagent_start', sid: 'sa_bg', stype: 'general-purpose', task: 'bg' },
      stopAt(2000),
      genAt(600000, 'g2'),
      stopAt(601000),
    ],
  });
  assert.equal(tl.subagents.length, 1);
  assert.equal(tl.subagents[0].ended_at, iso(601000));
  assert.deepEqual(shape(tl), [['working', 0, 2000], ['waiting_user', 2000, 600000], ['working', 600000, 601000]]);
});

test('running workers outrank a prompt typed while they run', () => {
  // The CLI takes a new prompt while background workers are still going. The workers were working
  // the whole time, and billing counts their interval as active either way, so the band says so.
  const tl = computeSessionTimeline('bg-prompt', {
    readEvents: () => [promptAt(0, 'g1'), stopAt(58000), promptAt(480000, 'g2'), stopAt(900500)],
    listCliSubagents: () => [{ agentId: 'k', typeName: 'explore', toolCallId: 't', startMs: T + 20000, endMs: T + 900000 }],
  });
  // One band: the prompt at 480000 splits nothing, both sides of it are covered.
  assert.deepEqual(shape(tl).slice(0, 2), [['working', 0, 58000], ['idle', 58000, 900000]]);
});

test('only a gap the workers cover end to end leaves the user column', () => {
  const events = [stop(0), gen(10)];
  assert.deepEqual(buildPeriods(events, { subagentIntervals: [[at(5), at(15)]] }).map((p) => p.state), ['waiting_user']);
  assert.deepEqual(buildPeriods(events, { subagentIntervals: [[at(0), at(10)]] }).map((p) => p.state), ['idle']);
  // Two workers that overlap cover the gap between them together.
  assert.deepEqual(buildPeriods(events, { subagentIntervals: [[at(0), at(6)], [at(4), at(10)]] }).map((p) => p.state), ['idle']);
  // Malformed entries are ignored, not repaired.
  assert.deepEqual(buildPeriods(events, { subagentIntervals: [null, [at(10), at(0)], ['x', 1]] }).map((p) => p.state), ['waiting_user']);
});

test('with the collapse withheld there are no lanes and so no coverage', () => {
  const tl = computeSessionTimeline('bg-nocollapse', {
    readEvents: () => [promptAt(0, 'g1'), stopAt(58000), genAt(600000, 'g2'), stopAt(601000)],
    dedupeEvents: null,
    listCliSubagents: () => bgKids,
  });
  assert.deepEqual(tl.subagents, []);
  assert.equal(shape(tl)[1][0], 'waiting_user');
});

// ─── a turn the host started itself is the agent's ─────────────────────────
//
// Seen on a real CLI session (2026.09.23, 68e34165): once its background workers finished, the CLI
// restarted the parent by itself — no Send, no beforeSubmitPrompt, so no prompt line — and the 22
// seconds between the previous stop and the restarted turn's first line drew as "User input". The
// chat store proves who started it (lib/cli-chats-cursor.mjs, countCliTurnStarts), and the rule is
// only switched on when it does (`hostResumes`).
const resumeStream = [promptAt(0, 'g1'), stopAt(60000), genAt(82000, 'g2'), toolAt(83000), stopAt(90000)];

test('with hostResumes, a stop followed by no prompt is the agent working', () => {
  const periods = buildPeriods(resumeStream, { hostResumes: true });
  assert.deepEqual(periods.map((p) => p.state), ['working']);
});

test('with hostResumes, a restart after hours of background work is idle, never a break', () => {
  const late = BREAK_MS + 60000;
  const periods = buildPeriods([promptAt(0, 'g1'), stopAt(1000), genAt(late, 'g2'), stopAt(late + 1000)], { hostResumes: true });
  assert.deepEqual(periods.map((p) => p.state), ['working', 'idle', 'working']);
});

test('without hostResumes the stop rule is unchanged', () => {
  assert.deepEqual(buildPeriods(resumeStream).map((p) => p.state), ['working', 'waiting_user', 'working']);
});

test('hostResumes never touches a stop that came before the first prompt', () => {
  // A sidecar started before the prompt hook existed, or a plugin upgraded mid-session: until the
  // hook has fired once there is no telling a missing prompt from a host restart.
  const periods = buildPeriods([genAt(0, 'g0'), stopAt(1000), genAt(60000, 'g1'), stopAt(61000), promptAt(120000, 'g2'), stopAt(121000)], { hostResumes: true });
  assert.deepEqual(periods.map((p) => p.state), ['working', 'waiting_user', 'working', 'waiting_user', 'working']);
});

test('hostResumes keeps a typed prompt and the session_start lead-in on the user side', () => {
  const typed = buildPeriods([promptAt(0, 'g1'), stopAt(1000), promptAt(60000, 'g2'), stopAt(61000)], { hostResumes: true });
  assert.deepEqual(typed.map((p) => p.state), ['working', 'waiting_user', 'working']);
  // `agent --resume` opens a new process: a session_start after an earlier prompt is still a boundary.
  const reopened = buildPeriods([promptAt(0, 'g1'), stopAt(1000), sessionStart(2000), genAt(60000, 'g2'), stopAt(61000)], { hostResumes: true });
  assert.deepEqual(reopened.map((p) => p.state), ['working', 'waiting_user', 'working']);
});

const resumeTimeline = (counts, extra = {}) => {
  let calls = 0;
  const tl = computeSessionTimeline('resume', {
    readEvents: () => extra.events || resumeStream,
    listCliSubagents: () => [],
    countCliTurnStarts: (id, deps) => { calls += 1; assert.equal(id, 'resume'); assert.equal(deps.deadline, extra.deadline); if (counts instanceof Error) throw counts; return counts; },
    ...(extra.deadline === undefined ? {} : { deadline: extra.deadline }),
    ...(extra.deps || {}),
  });
  return { states: tl.periods.map((p) => p.state), calls };
};

test('the store proves the restart: every typed send has its prompt line and a notification exists', () => {
  const { states, calls } = resumeTimeline({ human: 1, system: 1 }, { deadline: T + 5 });
  assert.equal(calls, 1);
  assert.deepEqual(states, ['working']);
});

test('a typed send with no prompt line switches the rule off for the whole session', () => {
  // Two human rows, one prompt line: a Send whose line was lost (a paste over the gate's 1 MiB cap,
  // the gate's wall guard, a recorder that failed). The unprompted turn may be that Send.
  assert.deepEqual(resumeTimeline({ human: 2, system: 1 }).states, ['working', 'waiting_user', 'working']);
});

test('no notification, no human row, an unreadable store or a throwing reader: the stop rule stands', () => {
  for (const counts of [{ human: 1, system: 0 }, { human: 0, system: 3 }, null, new Error('locked')]) {
    assert.deepEqual(resumeTimeline(counts).states, ['working', 'waiting_user', 'working'], String(JSON.stringify(counts)));
  }
});

test('the store is read only when the stream has an unprompted turn after a prompt', () => {
  const typedOnly = [promptAt(0, 'g1'), stopAt(1000), promptAt(60000, 'g2'), stopAt(61000)];
  assert.equal(resumeTimeline({ human: 2, system: 1 }, { events: typedOnly }).calls, 0);
  assert.equal(resumeTimeline({ human: 1, system: 1 }, { deps: { dedupeEvents: null } }).calls, 0);
});

// With hook subagent lines already in it, so the chat-store LISTING never runs and cannot be the
// one reporting: whatever onEnrichment hears comes from the turn-start count alone.
const hookedResumeStream = [
  ...resumeStream,
  { ts: T + 1000, ev: 'subagent_start', sid: 'h1', stype: 'explore' },
  { ts: T + 2000, ev: 'subagent_stop', sid: 'h1', stype: 'explore', status: 'completed' },
];

test('a store read the deadline cut short reports the timeline incomplete', () => {
  // The checkpoint must not post the stop-rule band over a queued timeline that had the evidence:
  // the same "could not look" the subagent listing reports (lib/cli-subagents-cursor.mjs).
  const seen = [];
  const tl = computeSessionTimeline('resume', {
    readEvents: () => hookedResumeStream,
    listCliSubagents: () => [],
    deadline: T + 10,
    now: () => T + 20,
    countCliTurnStarts: () => null,
    onEnrichment: (info) => seen.push(info.complete),
  });
  assert.ok(seen.includes(false));
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'waiting_user', 'working']);
});

test('a store that answered — evidence or not — never reports incomplete', () => {
  for (const counts of [{ human: 1, system: 0 }, { human: 1, system: 1 }, null]) {
    const seen = [];
    computeSessionTimeline('resume', {
      readEvents: () => hookedResumeStream,
      listCliSubagents: () => [],
      deadline: T + 10,
      now: () => T,
      countCliTurnStarts: () => counts,
      onEnrichment: (info) => seen.push(info.complete),
    });
    assert.equal(seen.includes(false), false, JSON.stringify(counts));
  }
  // A reader that throws is a store that cannot be read, not a cut: no evidence, and complete.
  const seen = [];
  computeSessionTimeline('resume', {
    readEvents: () => hookedResumeStream,
    listCliSubagents: () => [],
    countCliTurnStarts: () => { throw new Error('busy'); },
    onEnrichment: (info) => seen.push(info.complete),
  });
  assert.equal(seen.includes(false), false);
});
