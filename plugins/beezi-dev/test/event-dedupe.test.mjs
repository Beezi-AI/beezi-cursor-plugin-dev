import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelta, dedupeEvents } from '../lib/delta-cursor.mjs';
import { eventsFromHookPayload } from '../lib/sidecar-events.mjs';

// The highest-severity bug this plugin has had, and the shape of its fix.
//
// Beezi reaches a machine two ways: the bundled `hooks/hooks.json` inside the installed plugin, and
// the launchers merged into `~/.cursor/hooks.json`. They used to be de-duplicated at WRITE time — a
// launcher run stood down for a fortnight after any bundled run was recorded, and the self-installer
// deleted the user-scope registry outright once a bundled hook had been seen to fire. Both rested on
// "bundled registry alive ⇒ launcher redundant".
//
// That premise is false. Older `cursor-agent` builds (Jun–Aug 2026) ran no hook that came from an
// installed plugin — only `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json` fired under the
// CLI (Cursor staff, forum 163890). So on any machine that used both the IDE and such a CLI, one IDE
// session deleted the CLI's only registry and every CLI session afterwards reported nothing at all,
// silently, while the plugin's own status output said the hooks were installed and working.
//
// Both registries now stay installed forever and the duplicate lines they write are collapsed here,
// at read time, on the identity of the event itself. CLI 2026.09.18 fires both as well — twice per
// event, three times when run from the home directory — and the same collapse covers it (observed
// on Windows; docs/host-boundaries.md, "The Cursor CLI").

const CONV = 'conv-dedupe';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const delta = (events) =>
  computeDelta(CONV, 0, { readEvents: () => events, readUsageData: () => null, aiCodeTrackingDbFile: null });

// What the second registry writes: the same line, from a second process that stamped its own clock.
const copy = (event, skewMs = 7) => ({ ...event, ts: event.ts + skewMs });

// ---------------------------------------------------------------------------
// Identified events — the fact, not the guess
// ---------------------------------------------------------------------------

test('two registries handling one tool call report one tool call', () => {
  const tool = { ts: T0, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 'toolu_01' };
  const { events, dropped } = dedupeEvents([tool, copy(tool)]);
  assert.equal(events.length, 1);
  assert.equal(dropped, 1);
  assert.equal(events[0].ts, T0, 'the first copy is the one kept');
});

test('an id makes a duplicate a duplicate however far apart the copies land', () => {
  // No time bound on this path: `eid` names one host event, so a second line carrying that id AND
  // the same content cannot be a second real event, whatever the gap. A hook that was slow to start
  // — a cold node, a .cmd shim, a busy machine — must not sneak a second copy through.
  const tool = { ts: T0, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 'toolu_01' };
  assert.equal(dedupeEvents([tool, copy(tool, 45_000)]).events.length, 1);
});

test('events that differ only in their id are two events, not one', () => {
  // Two identical reads of the same file in the same second are two real tool calls. The id is the
  // only thing that says so, and it is exactly why it is worth stamping.
  const a = { ts: T0, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 'toolu_01' };
  const b = { ...a, ts: T0 + 3, eid: 'toolu_02' };
  const { events, dropped } = dedupeEvents([a, b]);
  assert.equal(events.length, 2);
  assert.equal(dropped, 0);
});

test('the same id on two event kinds is two events', () => {
  // `afterFileEdit` stamps the edit call's id on the edit lines, and a tool line from the same
  // payload carries it too. They describe different things.
  const eid = 'toolu_01';
  const { events } = dedupeEvents([
    { ts: T0, ev: 'tool', tool: 'edit_file', bytes: 0, ms: 4, eid },
    { ts: T0, ev: 'edit', path: 'src/a.ts', added: 3, removed: 1, eid },
  ]);
  assert.equal(events.length, 2);
});

test('one payload’s edits keep one line per file even though they share an id', () => {
  const [a, b] = eventsFromHookPayload(
    {
      tool_use_id: 'toolu_01',
      edits: [{ path: 'src/a.ts', added: 3, removed: 1 }, { path: 'src/b.ts', added: 9, removed: 0 }],
    },
    // Only the afterFileEdit script opens this gate; see the allowEdits tests in sidecar.test.mjs.
    { allowEdits: true },
  ).map((event, index) => ({ ts: T0 + index, ...event }));
  assert.equal(a.eid, 'toolu_01');
  assert.equal(b.eid, 'toolu_01');
  assert.equal(dedupeEvents([a, b]).events.length, 2, 'two files edited, not one file recorded twice');
});

// ---------------------------------------------------------------------------
// The fallback — which may end up carrying every event
// ---------------------------------------------------------------------------
//
// Whether Cursor really puts `tool_use_id` on `postToolUse` and `generation_id` on `stop` is
// UNVERIFIED — nobody has run this against a real Cursor install. If it does not, nothing is
// stamped, nothing takes the identified path, and this window is the only thing collapsing the
// duplicates. It has to be right on its own.

test('id-less duplicates collapse inside the one-second window', () => {
  // `shell`, `stop` and `session_end` never carry an id: two registries writing one of them produce
  // two lines from two processes started at the same instant, milliseconds apart.
  const shell = { ts: T0, ev: 'shell', cmd: 'git commit -m ok' };
  assert.equal(dedupeEvents([shell, copy(shell)]).events.length, 1);

  const stop = { ts: T0, ev: 'stop' };
  assert.equal(dedupeEvents([stop, copy(stop, 120)]).events.length, 1);

  const end = { ts: T0, ev: 'session_end' };
  assert.equal(dedupeEvents([end, copy(end, 999)]).events.length, 1);
});

test('id-less events do NOT collapse across the window', () => {
  // Two identical shell commands a minute apart are two commands. Without an id there is nothing to
  // prove otherwise, so time is the only evidence available and it says these are separate.
  const shell = { ts: T0, ev: 'shell', cmd: 'git status' };
  const { events, dropped } = dedupeEvents([shell, copy(shell), copy(shell, 60_000)]);
  assert.equal(events.length, 2);
  assert.equal(dropped, 1, 'the 7ms copy is the other registry; the one a minute later is not');
  assert.deepEqual(events.map((e) => e.ts), [T0, T0 + 60_000]);

  // The boundary itself: a second is the edge of the doubt, not the middle of it.
  assert.equal(dedupeEvents([shell, copy(shell, 1000)]).events.length, 1);
  assert.equal(dedupeEvents([shell, copy(shell, 1001)]).events.length, 2);
});

test('a run of identical lines cannot ratchet the window forward for ever', () => {
  // The window is measured from the copy we KEPT, not from the last one we saw. Measured from the
  // last one seen, a line repeated every 900ms would drop every event after the first, for hours.
  const shell = { ts: T0, ev: 'shell', cmd: 'npm test' };
  const events = [shell, copy(shell, 900), copy(shell, 1800), copy(shell, 2700)];
  assert.deepEqual(dedupeEvents(events).events.map((e) => e.ts), [T0, T0 + 1800]);
});

test('a line with no timestamp is kept rather than guessed at', () => {
  // Every line appendEvent writes is stamped, so this is a hand-edited or truncated sidecar. With no
  // time and no id there is no evidence of duplication at all, and inventing some deletes real work.
  const bare = { ev: 'shell', cmd: 'ls' };
  assert.equal(dedupeEvents([bare, { ...bare }]).events.length, 2);
});

// ---------------------------------------------------------------------------
// What the collapse must not break
// ---------------------------------------------------------------------------

test('the turn-end line survives the ten postToolUse lines of its own generation', () => {
  // ONE generation writes eleven `gen` lines — ten from postToolUse, one from stop — and only the
  // last carries the turn's token counts. Keying on `(ev, eid)` alone would keep the first and drop
  // the only line in the window that knows what the turn cost, which is why the whole line takes
  // part in the key.
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push({ ts: T0 + i * 1000, ev: 'gen', model: 'm', gen_id: 'g1', eid: 'g1' });
    events.push({ ts: T0 + i * 1000, ev: 'tool', tool: 'read_file', bytes: 10 + i, ms: 1, eid: `toolu_${i}` });
  }
  events.push({ ts: T0 + 20_000, ev: 'gen', model: 'm', gen_id: 'g1', eid: 'g1', token_input: 500, token_output: 20 });

  const result = delta(events);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].requests, 1, 'eleven lines, one generation, one request');
  assert.equal(result.tokens.token_input, 500);
  assert.equal(result.tokens.token_output, 20);
  assert.equal(result.operations.file.count, 10, 'ten real tool calls, none of them collapsed');
});

test('a stream recorded twice reports what one recording of it reports', () => {
  const single = [];
  for (let i = 0; i < 6; i++) {
    const ts = T0 + i * 5_000;
    single.push({ ts, ev: 'gen', model: 'gpt-5', gen_id: `g${i}`, eid: `g${i}` });
    single.push({ ts, ev: 'tool', tool: 'read_file', bytes: 100 + i, ms: 3, eid: `toolu_${i}` });
    single.push({ ts, ev: 'edit', path: `src/f${i}.ts`, added: 2, removed: 1, eid: `toolu_${i}` });
  }
  single.push({ ts: T0 + 40_000, ev: 'shell', cmd: 'git commit -m done' });
  single.push({ ts: T0 + 41_000, ev: 'stop' });

  // Both registries fired, so the sidecar holds each line twice, interleaved the way two concurrent
  // hook processes append.
  const doubled = single.flatMap((event) => [event, copy(event)]);

  const one = delta(single);
  const two = delta(doubled);
  assert.equal(two.diagnostics.duplicateEvents, single.length);
  assert.equal(two.diagnostics.windowEvents, single.length);
  assert.deepEqual(two.entries.map((e) => [e.model, e.billing_pool, e.requests]),
    one.entries.map((e) => [e.model, e.billing_pool, e.requests]));
  assert.equal(two.est_tokens, one.est_tokens);
  assert.deepEqual(two.operations.file, one.operations.file);
  assert.deepEqual(two.operations.shell, one.operations.shell);
  assert.deepEqual(two.code_changes, one.code_changes);
});

test('collapsing a duplicate never moves the segment cursor', () => {
  // `from`/`to` index raw sidecar lines. If a dropped duplicate shortened the range, a re-read of
  // the same bytes would produce a different segmentId and the server would accept the same work
  // twice — the one property the whole sidecar design exists to hold.
  const line = { ts: T0, ev: 'shell', cmd: 'ls' };
  const result = delta([line, copy(line), copy(line, 14)]);
  assert.equal(result.segmentId, `${CONV}:0-3`);
  assert.equal(result.to, 3);
  assert.equal(result.nextCursor, 3);
  assert.equal(result.diagnostics.windowEvents, 1);
  assert.equal(result.diagnostics.duplicateEvents, 2);
});

test('an unrecognised event kind is still reported as unrecognised after collapse', () => {
  const line = { ts: T0, ev: 'model_call', model: 'gpt-5' };
  const result = delta([line, copy(line)]);
  assert.equal(result.diagnostics.schemaMiss, true);
  assert.deepEqual(result.diagnostics.unrecognizedEvents, ['model_call']);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('a large window collapses in one linear pass', () => {
  // A machine that ran unlinked for a while reaches ~130k events on its first checkpoint after
  // signing in, and every one of them is doubled on a machine with both registries. Anything
  // quadratic here would time the checkpoint out, which does not merely lose the segment: the cursor
  // never advances, so the window only grows and the conversation reports nothing again, for ever.
  //
  // No wall-clock assertion — a busy CI box is not a benchmark. Completing at all is the property;
  // a quadratic implementation does not return from 10k inside this suite's patience.
  const events = [];
  for (let i = 0; i < 5_000; i++) {
    const line = { ts: T0 + i * 100, ev: 'tool', tool: 'read_file', bytes: i, ms: 2, eid: `toolu_${i}` };
    events.push(line, copy(line));
  }
  const { events: kept, dropped } = dedupeEvents(events);
  assert.equal(kept.length, 5_000);
  assert.equal(dropped, 5_000);
});
