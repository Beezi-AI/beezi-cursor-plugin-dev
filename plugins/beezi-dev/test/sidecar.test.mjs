import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, eventsFileFor } from '../lib/sidecar.mjs';
import { eventsFromHookPayload, lineCount } from '../lib/sidecar-events.mjs';
import { computeCodeChanges } from '../lib/code-changes-cursor.mjs';
import { eventsDir } from '../lib/paths-cursor.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sidecar-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readLines(conversationId) {
  return fs
    .readFileSync(eventsFileFor(conversationId), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('appendEvent writes one JSON object per line, append-only', (t) => {
  tmpHome(t);
  assert.equal(appendEvent('conv-1', { ev: 'gen', model: 'claude-4.5-sonnet' }), true);
  assert.equal(appendEvent('conv-1', { ev: 'tool', tool: 'read_file', bytes: 4210, ms: 120 }), true);
  const lines = readLines('conv-1');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ev, 'gen');
  assert.equal(lines[1].tool, 'read_file');
});

test('every line carries a timestamp, so segments have bounds', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'shell', cmd: 'git commit -m x' });
  const [line] = readLines('conv-1');
  assert.equal(typeof line.ts, 'number');
  // A caller replaying a batched payload keeps its own stamp.
  appendEvent('conv-1', { ts: 42, ev: 'shell', cmd: 'ls' });
  assert.equal(readLines('conv-1')[1].ts, 42);
});

test('the file is per conversation, named for the conversation id', (t) => {
  const home = tmpHome(t);
  appendEvent('conv-a', { ev: 'gen', model: 'm' });
  appendEvent('conv-b', { ev: 'gen', model: 'm' });
  assert.equal(eventsFileFor('conv-a'), path.join(home, 'events', 'conv-a.jsonl'));
  assert.deepEqual(fs.readdirSync(eventsDir()).sort(), ['conv-a.jsonl', 'conv-b.jsonl']);
});

test('a conversation id cannot escape the events directory', (t) => {
  const home = tmpHome(t);
  // conversation_id arrives from a hook payload — untrusted input on a path.
  const file = eventsFileFor('../../evil');
  assert.ok(file.startsWith(path.join(home, 'events') + path.sep), `${file} escaped the events dir`);
  appendEvent('../../evil', { ev: 'gen', model: 'm' });
  assert.ok(!fs.existsSync(path.join(home, '..', 'evil.jsonl')));
});

test('appendEvent never throws — a telemetry write must not break the user’s hook', (t) => {
  tmpHome(t);
  const circular = { ev: 'tool' };
  circular.self = circular;
  assert.equal(appendEvent('conv-1', circular), false);
  assert.equal(appendEvent(null, { ev: 'gen' }), false);
  assert.equal(appendEvent('conv-1', null), false);
  assert.equal(appendEvent('conv-1', 'not-an-object'), false);
});

test('eventsFromHookPayload derives gen/tool/shell/edit lines from one payload', () => {
  const events = eventsFromHookPayload({
    conversation_id: 'c',
    model: 'claude-4.5-sonnet',
    tool_name: 'read_file',
    tool_output: 'x'.repeat(400),
    duration_ms: 120,
  });
  assert.deepEqual(events.map((e) => e.ev), ['gen', 'tool']);
  assert.equal(events[1].bytes, 400);
  assert.equal(events[1].ms, 120);
});

test('a failed tool call is marked, so postToolUseFailure is distinguishable', () => {
  const [event] = eventsFromHookPayload({ tool_name: 'run_terminal_cmd', error: 'boom' });
  assert.equal(event.failed, true);
  const [ok] = eventsFromHookPayload({ tool_name: 'run_terminal_cmd' });
  assert.equal(ok.failed, undefined);
});

test('afterFileEdit edits[] become one edit line per file', () => {
  const events = eventsFromHookPayload(
    {
      edits: [
        { path: 'src/a.ts', added: 12, removed: 3 },
        { file_path: 'src/b.ts', lines_added: 1 },
      ],
    },
    { allowEdits: true },
  );
  assert.deepEqual(events, [
    { ev: 'edit', path: 'src/a.ts', added: 12, removed: 3 },
    // `removed` is OMITTED, not zeroed — the payload never reported one. See the false-zero tests
    // below for what a literal 0 here used to cost.
    { ev: 'edit', path: 'src/b.ts', added: 1 },
  ]);
});

test('a file edit reported without edits[] still records the touch', () => {
  // files_changed must be right even when the line counts are only available from
  // ai-code-tracking.db.
  assert.deepEqual(eventsFromHookPayload({ file_path: 'src/c.ts' }, { allowEdits: true }), [
    { ev: 'edit', path: 'src/c.ts' },
  ]);
});

test('a shell command is recorded and bounded', () => {
  const [event] = eventsFromHookPayload({ command: 'git commit -m ok' });
  assert.deepEqual(event, { ev: 'shell', cmd: 'git commit -m ok' });
  const [big] = eventsFromHookPayload({ command: 'x'.repeat(5000) });
  assert.equal(big.cmd.length, 2000, 'a pasted heredoc must not land whole in the event log');
});

test('a payload carrying nothing worth recording yields no lines', () => {
  assert.deepEqual(eventsFromHookPayload({ conversation_id: 'c' }), []);
  assert.deepEqual(eventsFromHookPayload(null), []);
});

// ---------------------------------------------------------------------------
// afterFileEdit — line counts derived from the replaced text
// ---------------------------------------------------------------------------
//
// Cursor's afterFileEdit payload is `{file_path, edits:[{old_string, new_string}]}` and carries no
// line numbers, no ranges and no counts at all — those live only on the Tab-only afterTabFileEdit.
// Counting the lines on each side of the replacement is the only measurement available.

test('lineCount tolerates exactly one trailing newline', () => {
  assert.equal(lineCount('a\nb\nc'), 3);
  assert.equal(lineCount('a\nb\nc\n'), 3, 'a file that ends in a newline is not three-and-a-bit lines');
  // A SECOND trailing newline is a real empty line and is counted. This is the sibling plugin's
  // `.replace(/\n$/, '').split('\n').length` behaviour, reproduced exactly.
  assert.equal(lineCount('a\nb\nc\n\n'), 4);
  assert.equal(lineCount('one line'), 1);
  assert.equal(lineCount('\n'), 1);
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount(undefined), 0);
  assert.equal(lineCount(null), 0);
});

test('an edit with no counts derives them from old_string / new_string', () => {
  const [event] = eventsFromHookPayload(
    { file_path: 'src/a.ts', edits: [{ old_string: 'a\nb\n', new_string: 'a\nB\nc\nd\n' }] },
    { allowEdits: true },
  );
  assert.deepEqual(event, { ev: 'edit', path: 'src/a.ts', added: 4, removed: 2 });
});

test('a pure insertion and a pure deletion are both real observations', () => {
  const [insert] = eventsFromHookPayload(
    { file_path: 'a.ts', edits: [{ old_string: '', new_string: 'x\ny\n' }] },
    { allowEdits: true },
  );
  assert.deepEqual(insert, { ev: 'edit', path: 'a.ts', added: 2, removed: 0 });
  const [remove] = eventsFromHookPayload(
    { file_path: 'a.ts', edits: [{ old_string: 'x\ny\nz\n', new_string: '' }] },
    { allowEdits: true },
  );
  assert.deepEqual(remove, { ev: 'edit', path: 'a.ts', added: 0, removed: 3 });
});

test('reported counts win wholesale over the text', () => {
  // Mixing an observation with a derivation produces two numbers from two different accountings of
  // one edit. code-changes-cursor's applyEdit makes the same all-or-nothing choice.
  const [event] = eventsFromHookPayload(
    { file_path: 'a.ts', edits: [{ added: 9, old_string: 'a\nb\nc\n', new_string: 'q\n' }] },
    { allowEdits: true },
  );
  assert.deepEqual(event, { ev: 'edit', path: 'a.ts', added: 9 });
});

test('a multi-megabyte edit is counted without allocating an array', (t) => {
  // `new_string` is whatever the model wrote — a whole-file rewrite of a lockfile or a generated
  // bundle is routinely megabytes. `.split('\n')` on that allocates one string object per line,
  // hundreds of thousands of them, inside a hook Cursor kills at a 10s deadline.
  //
  // Asserted by BANNING the allocation rather than by timing it: a busy CI box is not a benchmark,
  // and "it was fast enough today" is not the property under test.
  const line = 'const x = 1;';
  const big = `${line}\n`.repeat(200_000); // ~2.6 MB, 200k lines
  const realSplit = String.prototype.split;
  String.prototype.split = function banned() {
    throw new Error('line counting must not allocate — see lineCount in lib/sidecar-events.mjs');
  };
  let events;
  try {
    events = eventsFromHookPayload(
      { file_path: 'dist/bundle.js', edits: [{ old_string: '', new_string: big }] },
      { allowEdits: true },
    );
  } finally {
    String.prototype.split = realSplit;
  }
  t.diagnostic(`counted ${big.length} chars`);
  assert.deepEqual(events, [{ ev: 'edit', path: 'dist/bundle.js', added: 200_000, removed: 0 }]);
});

// ---------------------------------------------------------------------------
// The false zero
// ---------------------------------------------------------------------------

test('an unobserved count is omitted, never written as a zero', () => {
  // `nonNegativeInt(undefined)` is 0, so this used to write `"added":0,"removed":0` on every edit
  // whose payload carried no counts.
  const [event] = eventsFromHookPayload({ edits: [{ path: 'src/a.ts' }] }, { allowEdits: true });
  assert.deepEqual(event, { ev: 'edit', path: 'src/a.ts' });
  assert.ok(!('added' in event), 'a zero we did not observe is a claim we cannot back');
  assert.ok(!('removed' in event));
});

test('a false zero used to suppress the code_changes fallback; an omitted field does not', () => {
  // The real cost of the bug, end to end. applyEdit in code-changes-cursor.mjs reaches for its
  // text-derived fallback only when BOTH counts are null — a literal 0 is a number, so it read as a
  // genuine "this edit changed nothing" and the segment reported every touched file with zero lines.
  const events = eventsFromHookPayload(
    { file_path: 'src/a.ts', edits: [{ old_string: 'a\nb\n', new_string: 'a\nb\nc\n' }] },
    { allowEdits: true },
  ).map((event) => ({ ts: 1, ...event }));

  const withFalseZero = computeCodeChanges(
    events.map((event) => ({ ...event, added: 0, removed: 0 })),
    { aiCodeTrackingDbFile: null },
  );
  assert.equal(withFalseZero.lines_added, 0, 'the shape of the old bug, pinned');

  const real = computeCodeChanges(events, { aiCodeTrackingDbFile: null });
  assert.equal(real.files_changed, 1);
  assert.equal(real.lines_added, 3);
  assert.equal(real.lines_removed, 2);
});

// ---------------------------------------------------------------------------
// allowEdits
// ---------------------------------------------------------------------------

test('allowEdits defaults to false, so no existing caller emits an edit line', () => {
  // postToolUse, afterShellExecution, stop and postToolUseFailure all call this with one argument.
  assert.deepEqual(eventsFromHookPayload({ file_path: 'src/a.ts' }), []);
  assert.deepEqual(eventsFromHookPayload({ edits: [{ path: 'src/a.ts', added: 3 }] }), []);
  assert.deepEqual(eventsFromHookPayload({ file_path: 'src/a.ts' }, {}), []);
  assert.deepEqual(eventsFromHookPayload({ file_path: 'src/a.ts' }, { allowEdits: 'yes' }), [],
    'only the boolean true opens the gate');
});

test('the guard is what stops afterFileEdit and postToolUse counting one write twice', () => {
  // postToolUse for a Write tool can carry a top-level `file_path`; afterFileEdit carries the real
  // edits[] for the same write. Both lines survive dedupeEvents — they differ in content — so
  // without the guard code_changes sees the file twice.
  const write = { tool_name: 'write', tool_use_id: 'toolu_01', file_path: 'src/a.ts' };
  const fromToolHook = eventsFromHookPayload(write);
  assert.deepEqual(fromToolHook.map((e) => e.ev), ['tool'], 'no edit line from the tool hook');

  const fromEditHook = eventsFromHookPayload(
    { tool_use_id: 'toolu_01', file_path: 'src/a.ts', edits: [{ old_string: '', new_string: 'a\n' }] },
    { allowEdits: true },
  );
  assert.deepEqual(fromEditHook, [
    { ev: 'edit', path: 'src/a.ts', added: 1, removed: 0, eid: 'toolu_01' },
  ]);

  const changes = computeCodeChanges(
    [...fromToolHook, ...fromEditHook].map((event) => ({ ts: 1, ...event })),
    { aiCodeTrackingDbFile: null },
  );
  assert.equal(changes.files_changed, 1);
  assert.equal(changes.lines_added, 1, 'one write, counted once');
});

// ---------------------------------------------------------------------------
// The model a generation line names: the base id, with the slug kept beside it
// ---------------------------------------------------------------------------

test('a slug-only payload writes the base id and keeps the slug as the variant', () => {
  // The Cursor CLI sends only `model` (plan evidence E2), so without this every effort level
  // became its own model downstream.
  const [gen] = eventsFromHookPayload({
    hook_event_name: 'postToolUse', model: 'claude-opus-5-thinking-high', generation_id: 'g1',
  }).filter((e) => e.ev === 'gen');
  assert.equal(gen.model, 'claude-opus-5');
  assert.equal(gen.model_variant, 'claude-opus-5-thinking-high');
});

test('model_id still wins when the payload carries it', () => {
  const [gen] = eventsFromHookPayload({
    model_id: 'kimi-k3', model: 'kimi-k3-max', generation_id: 'g1',
  }).filter((e) => e.ev === 'gen');
  assert.equal(gen.model, 'kimi-k3');
  assert.equal(gen.model_variant, 'kimi-k3-max');
});

test('the Auto placeholder is written as it came, with no variant', () => {
  // Resolving `default` needs the CLI store and belongs to the reader; the writer runs on the
  // postToolUse hot path and records only what the payload said.
  const [gen] = eventsFromHookPayload({ model: 'default', generation_id: 'g1' }).filter((e) => e.ev === 'gen');
  assert.equal(gen.model, 'default');
  assert.equal('model_variant' in gen, false);
});
