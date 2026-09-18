import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSessionTimeline,
  postSessionTimeline,
  timestampOf,
  fitSubagentsToBudget,
  TIMELINE_BODY_BUDGET_BYTES,
  MAX_SUBAGENTS,
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

test('a long gap is idle even when it follows a stop', () => {
  const tl = timelineOf([gen(0), stop(1), gen(30)]);
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'idle']);
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

test('the break state stays off unless the caller opts in — an old server rejects the enum', () => {
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)]), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], {}), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], { allowBreakState: false }), ['idle']);
});

test('one millisecond below six hours is idle, at and above it is a break', () => {
  const opts = { allowBreakState: true };
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS - 1)], opts), ['idle']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS)], opts), ['break']);
  assert.deepEqual(statesOf([atMs(0), atMs(BREAK_MS + 1)], opts), ['break']);
});

test('a break outranks waiting_user — an overnight gap after a stop is not the user thinking', () => {
  const events = [atMs(0), stopAtMs(1000), atMs(1000 + BREAK_MS)];
  assert.deepEqual(statesOf(events, { allowBreakState: true }), ['working', 'break']);
  assert.deepEqual(statesOf(events), ['working', 'idle']);
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
