import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hookBudgetMs, HOOK_KIND_GATE } from '../lib/hook-runner.mjs';

// scripts/prompt-submit.mjs, run the way Cursor runs it: payload on stdin, its own process,
// `--via plugin-hooks`, and a throwaway home.
//
// `beforeSubmitPrompt` is the hook that says when a turn STARTED. Without it a CLI turn that calls
// no tool leaves only `gen` + `stop` in the sidecar, and the session timeline drew such a session
// as almost nothing but "User input" (verified on a real CLI session). What is pinned here is the
// part only a real process can show:
//
//   - the answer. Cursor's contract is `{"continue": true|false, "user_message"?}` on stdout; the
//     hook is synchronous and holds the user's Send until it answers. This script answers exactly
//     `{"continue":true}` on EVERY path, and nothing else, ever.
//   - the line. Exactly one `{ev:'prompt'}` line, carrying the generation id when the host sent one
//     and NO prompt text, attachment or other payload field — and the `ts` the GATE took when it
//     started, not the moment the recorder got round to writing.
//   - capture. With BEEZI_CURSOR_DUMP_HOOKS on, the prompt text never reaches the capture file, no
//     replay spill is written at all, and the hook's own line is still written.
//   - the exit. `beforeSubmitPrompt` holds Send until the hook PROCESS ends, not until it answers
//     (Codex review, BLOCKING, twice). The second finding: a 300 ms timer cannot interrupt
//     SYNCHRONOUS I/O, so a 900 ms synchronous append stub kept the process alive 914 ms after
//     answering. The gate now writes nothing itself: it hands the ids to a detached recorder
//     process and exits. Pinned below with the recorder stalled SYNCHRONOUSLY, measured from the
//     answer to the gate's exit and to its pipes closing.
//
// THE LINE ARRIVES LATER THAN THE PROCESS ENDS. The recorder is a separate, detached process, so
// every test that expects a line polls for it, and every test that expects none waits a short grace
// before looking — a line from a recorder nobody expected would otherwise land after the assertion.
// Every test also waits for the recorder before deleting the home, or the recorder's lazy mkdir
// would recreate it behind the cleanup.
//
// Broken-module paths live in test/hook-bootstrap.test.mjs with every other hook.

const SCRIPT = fileURLToPath(new URL('../scripts/prompt-submit.mjs', import.meta.url));
const ANSWER = '{"continue":true}';
const SECRET = 'refactor the zebra module please';

const PAYLOAD = {
  session_id: 'conv-prompt',
  generation_id: 'gen-1',
  hook_event_name: 'beforeSubmitPrompt',
  prompt: SECRET,
  attachments: [{ type: 'file', file_path: '/home/me/zebra.ts' }],
};

// How long a test waits for the recorder's line before calling it lost, and how long it waits to be
// sure no line is coming. The first is generous (a cold node start on a loaded CI box); the second
// only has to outlast a recorder that should not exist at all.
const LINE_WAIT_MS = 10_000;
const NO_LINE_GRACE_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envFor(home, env) {
  return {
    ...process.env,
    BEEZI_CURSOR_HOME: home,
    CURSOR_CONFIG_DIR: path.join(home, 'cursor'),
    CURSOR_PROJECT_DIR: home,
    BEEZI_API_URL: 'http://127.0.0.1:1',
    BEEZI_CURSOR_DUMP_HOOKS: '',
    NODE_ENV: '',
    ...env,
  };
}

function readLines(home) {
  const eventsFile = path.join(home, 'events', 'conv-prompt.jsonl');
  const text = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf-8') : '';
  return { text, lines: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

// Poll until `ready()` is true or the wait runs out. Returns whether it became true.
async function until(ready, ms = LINE_WAIT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ready()) return true;
    if (Date.now() > deadline) return false;
    await sleep(15);
  }
}

// One gate run. `expect` says what the test is waiting for after the gate has exited:
//   'line'    — the recorder's prompt line;
//   'capture' — the recorder's prompt line AND its capture record;
//   'none'    — nothing; a grace period, then whatever is on disk.
async function run(input, { env = {}, preload = null, expect = 'line' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-'));
  const args = preload == null ? [] : ['--import', preload];
  args.push(SCRIPT, '--via', 'plugin-hooks');
  const startedAt = Date.now();
  // spawnSync returns when the gate's stdout and stderr pipes CLOSE, not merely when it exits — so
  // a recorder that inherited either pipe would hold this call for as long as it lives. `gateMs`
  // is the same free inheritance check the timed tests below make explicitly.
  const result = spawnSync(process.execPath, args, {
    input,
    encoding: 'utf-8',
    timeout: 20_000,
    env: envFor(home, env),
  });
  const gateMs = Date.now() - startedAt;
  const captureFile = path.join(home, 'capture', 'hooks.jsonl');
  if (expect === 'line') await until(() => readLines(home).lines.length > 0);
  else if (expect === 'capture') await until(() => readLines(home).lines.length > 0 && fs.existsSync(captureFile));
  else await sleep(NO_LINE_GRACE_MS);
  const { text, lines } = readLines(home);
  return { home, result, lines, eventsText: text, gateMs, startedAt };
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

test('a prompt answers {"continue":true} and writes one prompt line with no text', async () => {
  const { home, result, lines, eventsText, startedAt } = await run(JSON.stringify(PAYLOAD));
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ANSWER);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ev, 'prompt');
    assert.equal(lines[0].eid, 'gen-1');
    assert.equal(typeof lines[0].ts, 'number');
    assert.ok(lines[0].ts >= startedAt, 'the line is stamped before the gate was even started');
    // The sidecar is a plain-text file that outlives the session. Nothing the user typed goes in it.
    for (const key of Object.keys(lines[0])) {
      assert.ok(['ts', 'ev', 'eid', 'cwd'].includes(key), `the prompt line carries ${key}`);
    }
    assert.equal(eventsText.includes('zebra'), false, 'prompt or attachment text reached the sidecar');
    // And no `gen` line: that is stop.mjs's and postToolUse's to write, and a second writer here
    // would bill a generation Cursor has not started yet.
    assert.equal(lines.some((l) => l.ev === 'gen'), false);
    // Exactly one line, EVENTUALLY: a second recorder, or a recorder plus an in-process append,
    // would show up here given a moment.
    await sleep(NO_LINE_GRACE_MS);
    assert.equal(readLines(home).lines.length, 1);
  } finally {
    cleanup(home);
  }
});

test('the stamped cwd is the one stampableCwd derives, carried through the recorder', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-ws-'));
  const { home, lines } = await run(JSON.stringify({ ...PAYLOAD, cwd: workspace }));
  try {
    assert.equal(lines.length, 1);
    assert.equal(lines[0].cwd, workspace);
  } finally {
    cleanup(home);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a payload with no generation id writes the line without an eid, never an invented one', async () => {
  const { home, result, lines } = await run(JSON.stringify({ session_id: 'conv-prompt', prompt: SECRET }));
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(lines.length, 1);
    assert.equal('eid' in lines[0], false);
  } finally {
    cleanup(home);
  }
});

test('the camelCase generation id is read too', async () => {
  const { home, lines } = await run(JSON.stringify({ sessionId: 'conv-prompt', generationId: 'gen-cc' }));
  try {
    assert.equal(lines.length, 1);
    assert.equal(lines[0].eid, 'gen-cc');
  } finally {
    cleanup(home);
  }
});

test('an unattributable or unreadable payload still answers, exits 0 and writes nothing', async () => {
  for (const input of ['', 'not json', '{"no":"session"}', '﻿{"session_id":', '{"session_id":']) {
    const { home, result, lines } = await run(input, { expect: 'none' });
    try {
      assert.equal(result.stdout, ANSWER, `stdout on ${JSON.stringify(input)}`);
      assert.equal(result.status, 0, `exit on ${JSON.stringify(input)}`);
      assert.equal(lines.length, 0);
    } finally {
      cleanup(home);
    }
  }
});

test('a clock that throws at the start of the gate still answers once, exits 0 and records nothing', async () => {
  // The gate takes the line's `ts` right after the guards, BEFORE the answer — so an unguarded throw
  // there would be a gate that never answered. It is read inside a try/catch, and a gate with no
  // start time records nothing rather than let the recorder invent a later one.
  const boom = 'data:text/javascript,Date.now=()=>{throw new Error("boom")}';
  const { home, result, lines } = await run(JSON.stringify(PAYLOAD), { preload: boom, expect: 'none' });
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines.length, 0);
  } finally {
    cleanup(home);
  }
});

test('an uncaught throw after the answer still leaves exactly one answer and exit 0', async () => {
  // A preload that arms on the answer itself (the one fd-1 writeSync) and throws from the next tick
  // — after the script's top level has finished, outside every try/catch in it, and before any stdin
  // I/O can complete. Only the process guards can answer for it, and exit 2 would block the user's
  // prompt outright.
  //
  // It used to arm on the first synchronous stdin read and fire from the next `Promise.all`; the
  // gate reads stdin through events now, so that trigger would never fire and the test would pass
  // for the wrong reason.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-preload-'));
  const preload = path.join(dir, 'uncaught.mjs');
  fs.writeFileSync(
    preload,
    'import fs from "fs";\n'
      + 'const realWrite = fs.writeSync;\n'
      + 'fs.writeSync = function (...args) {\n'
      + '  const out = realWrite.apply(this, args);\n'
      + '  if (args[0] === 1) process.nextTick(() => { throw new Error("beezi-test: uncaught after the answer"); });\n'
      + '  return out;\n'
      + '};\n',
    'utf-8',
  );
  const { home, result, lines } = await run(JSON.stringify(PAYLOAD), { preload: pathToFileURL(preload).href, expect: 'none' });
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(result.status, 0, result.stderr);
    // Proof the throw really fired rather than the patch silently not applying: it lands before
    // stdin is even read, so the guards exit ahead of the recorder and no line is ever written.
    assert.equal(lines.length, 0);
  } finally {
    cleanup(home);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a BOM-prefixed payload (Windows PowerShell, sometimes twice) is still read', async () => {
  // The pipeline Cursor builds on Windows prepends U+FEFF, and a nested stage can add a second one
  // (lib/hook-input-cursor.mjs, decodeHookPayload). The gate reads stdin itself, so it has to go
  // through the same decoder or every Windows prompt line is lost.
  const { home, result, lines } = await run(`﻿﻿${JSON.stringify(PAYLOAD)}`);
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].eid, 'gen-1');
  } finally {
    cleanup(home);
  }
});

test('a payload past the stdin cap answers, exits 0 and writes nothing', async () => {
  // The read is capped so a pasted novel cannot hold Send while it is buffered. A payload the cap
  // cut short cannot be parsed, so it is dropped whole rather than guessed at: that turn falls back
  // to the timeline's turn-end rule, exactly like a build that does not fire this hook. Only status
  // and stdout are asserted: the gate stops reading at the cap, so the rest of this write may end
  // in EPIPE on our side, which is the trade the script states.
  const huge = JSON.stringify({ ...PAYLOAD, prompt: 'x'.repeat(2 * 1024 * 1024) });
  const { home, result, lines } = await run(huge, { expect: 'none' });
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(result.status, 0);
    assert.equal(lines.length, 0);
  } finally {
    cleanup(home);
  }
});

test('the hand-off to the recorder carries the ids, the cwd and the start time, and no prompt text', async () => {
  // What crosses the process boundary, read off the spawn call itself. A preload replaces
  // child_process.spawn (and re-syncs the named ESM export the script imports), writes down what it
  // was asked for, and then spawns for real so the line still lands.
  //
  // Env, never argv: argv is what every process listing on the machine shows. And the ids only —
  // the recorder does not need the prompt, so the prompt never leaves the gate.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-spawn-'));
  const preload = path.join(dir, 'spy.mjs');
  const log = path.join(dir, 'spawn.json');
  fs.writeFileSync(
    preload,
    'import cp from "child_process";\n'
      + 'import fs from "fs";\n'
      + 'import { syncBuiltinESMExports } from "module";\n'
      + 'const real = cp.spawn;\n'
      + 'cp.spawn = function (file, args, options) {\n'
      + `  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, options: { ...options, env: {\n`
      + '    BEEZI_PROMPT_RECORD: options.env.BEEZI_PROMPT_RECORD,\n'
      + '    BEEZI_PROMPT_CAPTURE: options.env.BEEZI_PROMPT_CAPTURE } } }));\n'
      + '  return real.apply(this, arguments);\n'
      + '};\n'
      + 'syncBuiltinESMExports();\n',
    'utf-8',
  );
  const { home, result, lines } = await run(JSON.stringify(PAYLOAD), { preload: pathToFileURL(preload).href });
  try {
    assert.equal(result.stdout, ANSWER);
    assert.equal(lines.length, 1);
    const call = JSON.parse(fs.readFileSync(log, 'utf-8'));
    // The recorder is this same script, in its own mode, with no payload on its command line.
    assert.deepEqual(call.args, ['--no-warnings', SCRIPT, '--record']);
    // Detached, no console window, and NO stdio handle of ours: Cursor may wait for the gate's pipes
    // to close as well as for its exit, so a recorder holding one would hold Send just the same.
    assert.equal(call.options.detached, true);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'ignore']);
    const record = JSON.parse(call.options.env.BEEZI_PROMPT_RECORD);
    assert.deepEqual(Object.keys(record).sort(), ['cwd', 'eid', 'sid', 'ts']);
    assert.equal(record.sid, 'conv-prompt');
    assert.equal(record.eid, 'gen-1');
    assert.equal(record.ts, lines[0].ts, 'the line carries the gate\'s start time');
    assert.equal(JSON.stringify(call).includes('zebra'), false, 'prompt or attachment text crossed to the recorder');
    // Capture is off, so there is nothing to capture and no variable for it.
    assert.equal(call.options.env.BEEZI_PROMPT_CAPTURE, undefined);
  } finally {
    cleanup(home);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The recorder, run directly: `--record` mode with the hand-off already in its environment. It has
// no stdin and no stdout of its own in production (all three are 'ignore'), so what is pinned is
// that it writes the line it was handed, validates what it was handed, and never fails.
function runRecorder(record, { preload = null, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-rec-'));
  const args = preload == null ? [] : ['--import', preload];
  args.push(SCRIPT, '--record');
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout: 20_000,
    env: envFor(home, { BEEZI_PROMPT_RECORD: record, ...env }),
  });
  return { home, result, ...readLines(home) };
}

test('the recorder writes the handed-off line: the gate\'s ts, its eid and cwd, and nothing on stdout', () => {
  const ts = 1_700_000_000_123;
  const { home, result, lines } = runRecorder(JSON.stringify({ sid: 'conv-prompt', eid: 'gen-9', cwd: '/w/proj', ts }));
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { ts, cwd: '/w/proj', ev: 'prompt', eid: 'gen-9' });
  } finally {
    cleanup(home);
  }
});

test('the recorder refuses a malformed hand-off: no line, no stdout, exit 0', () => {
  for (const record of [
    undefined,
    '',
    'not json',
    '[]',
    JSON.stringify({ eid: 'gen-1', ts: 1 }),
    JSON.stringify({ sid: '', ts: 1 }),
    JSON.stringify({ sid: 'conv-prompt' }),
    JSON.stringify({ sid: 'conv-prompt', ts: 'soon' }),
    JSON.stringify({ sid: 'conv-prompt', ts: 1, eid: 7 }),
  ]) {
    const { home, result, lines } = runRecorder(record);
    try {
      assert.equal(result.status, 0, `exit on ${record}`);
      assert.equal(result.stdout, '', `stdout on ${record}`);
      assert.equal(lines.length, 0, `a line on ${record}`);
    } finally {
      cleanup(home);
    }
  }
});

test('a throw inside the recorder\'s append is swallowed: exit 0, no stdout, no line', () => {
  // The append itself failing — a full disk, a permission error — is the recorder's to absorb. Nobody
  // is waiting on it, and nobody would see its failure but a user's process list. The append is the
  // ASYNCHRONOUS `fs.appendFile` now (Codex review, MAJOR — see the deadline test below), so both of
  // its ways to fail are stubbed: a synchronous throw, and an error handed to the callback.
  for (const stub of [
    'fs.appendFile=()=>{throw new Error("boom")}',
    'fs.appendFile=(f,d,o,cb)=>setImmediate(()=>cb(Object.assign(new Error("boom"),{code:"EACCES"})))',
  ]) {
    const boom = `data:text/javascript,import fs from "fs";${stub}`;
    const { home, result, lines } = runRecorder(JSON.stringify({ sid: 'conv-prompt', ts: 1 }), { preload: boom });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(lines.length, 0, stub);
    } finally {
      cleanup(home);
    }
  }
});

test('the recorder\'s line is byte-identical to the one lib/sidecar.mjs appendEvent writes', () => {
  // The recorder no longer goes through appendEvent (its write is synchronous; see the deadline test
  // below), so the bytes it produces are pinned against appendEvent's own output. The reader
  // collapses the two registries' copies on line CONTENT (dedupeEvents, lib/delta-cursor.mjs), and
  // one registry may still be running a build whose recorder used appendEvent — so a drift in
  // shape here would stop the collapse and double every prompt line.
  const ts = 1_700_000_000_123;
  for (const record of [
    { sid: 'conv-prompt', eid: 'gen-9', cwd: '/w/proj', ts },
    { sid: 'conv-prompt', ts },
  ]) {
    const { home, result, text } = runRecorder(JSON.stringify(record));
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-ctl-'));
    try {
      assert.equal(result.status, 0, result.stderr);
      // appendEvent, run in a child with the same home layout, is the reference.
      const sidecarUrl = pathToFileURL(fileURLToPath(new URL('../lib/sidecar.mjs', import.meta.url))).href;
      const line = record.eid == null ? { ts, ev: 'prompt' } : { ts, ev: 'prompt', eid: record.eid };
      const reference = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import * as s from ${JSON.stringify(sidecarUrl)};s.appendEvent('conv-prompt', s.withCwd(${JSON.stringify(line)}, ${JSON.stringify(record.cwd == null ? null : record.cwd)}));`,
      ], { encoding: 'utf-8', timeout: 20_000, env: envFor(control) });
      assert.equal(reference.status, 0, reference.stderr);
      assert.equal(text, readLines(control).text);
      assert.ok(text.endsWith('\n') && text.split('\n').length === 2, 'one newline-terminated line');
    } finally {
      cleanup(home);
      cleanup(control);
    }
  }
});

// The recorder's hard ceiling, read from the script so the test pins the value that ships.
const RECORD_WALL_MS = Number((/const RECORD_WALL_MS = ([\d\s*]+);/.exec(fs.readFileSync(SCRIPT, 'utf-8')) || [])[1]
  .split('*').reduce((acc, n) => acc * Number(n.trim()), 1));

test('a recorder whose append never completes still exits by its deadline', () => {
  // Codex review, MAJOR: the recorder's timer could not interrupt appendEvent's synchronous
  // `appendFileSync`, so a wedged sidecar left one stuck node process per prompt per registry, with
  // nothing left to kill it. The append is asynchronous now, so the deadline timer can fire while it
  // is outstanding. The stub stands for the wedged write: `fs.appendFile` (and `fs.mkdir`, the other
  // step on the path) never call back, and a long-lived handle stands for the threadpool request that
  // would keep the loop alive — so the only way out is the deadline itself.
  assert.ok(RECORD_WALL_MS > 0, 'RECORD_WALL_MS could not be read from the script');
  const hang = 'data:text/javascript,import fs from "fs";'
    + 'fs.appendFile=()=>{setInterval(()=>{},1<<30)};fs.mkdir=()=>{setInterval(()=>{},1<<30)}';
  const startedAt = Date.now();
  const { home, result, lines } = runRecorder(JSON.stringify({ sid: 'conv-prompt', ts: 1 }), { preload: hang });
  const ms = Date.now() - startedAt;
  try {
    assert.equal(result.error, undefined, `the recorder was killed by the test's timeout after ${ms} ms`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lines.length, 0, 'the hang did not engage: a line was written');
    // At the deadline, not before (the hang engaged) and not long after (the deadline fired).
    assert.ok(ms >= RECORD_WALL_MS - 50, `the recorder left after ${ms} ms, before its ${RECORD_WALL_MS} ms deadline`);
    assert.ok(ms < RECORD_WALL_MS + 5000, `the recorder outlived its ${RECORD_WALL_MS} ms deadline: ${ms} ms`);
  } finally {
    cleanup(home);
  }
});

// Capture in the recorder. Codex review, MAJOR: with BEEZI_CURSOR_DUMP_HOOKS on, the recorder still
// called lib/hook-dump.mjs's dumpHookPayload, whose retention sweep and append are synchronous — so a
// stalled capture filesystem blocked the one thread and the deadline could not fire (a 12 s stall
// kept the recorder alive 12,086 ms). The capture line is now appended asynchronously, like the
// prompt line, and the sweep is left to the other hooks.
const CAPTURE_HANDOFF = (bytes, argv = ['--via', 'plugin-hooks']) => JSON.stringify({
  argv,
  ...(bytes == null ? {} : { raw_b64: Buffer.from(bytes).toString('base64') }),
});
const CAPTURE_STALL_MS = 18_000;
// Stalls BOTH spellings of the capture append, and only that file: the synchronous one the old
// recorder used blocks the thread (Atomics.wait), the asynchronous one never calls back and holds
// the loop open. The prompt line's append goes to the sidecar and is left alone, so it must land.
const CAPTURE_HANG = 'data:text/javascript,' + encodeURIComponent([
  'import fs from "fs";',
  'const isCapture = (f) => String(f).endsWith("hooks.jsonl");',
  'const appendFileSync = fs.appendFileSync;',
  'fs.appendFileSync = function (f, ...rest) {',
  `  if (isCapture(f)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${CAPTURE_STALL_MS});`,
  '  return appendFileSync.call(this, f, ...rest);',
  '};',
  'const appendFile = fs.appendFile;',
  'fs.appendFile = function (f, ...rest) {',
  '  if (isCapture(f)) { setInterval(() => {}, 1 << 30); return; }',
  '  return appendFile.call(this, f, ...rest);',
  '};',
].join('\n'));

test('a recorder whose capture append never completes still exits by its deadline, and the line still lands', () => {
  assert.ok(RECORD_WALL_MS > 0, 'RECORD_WALL_MS could not be read from the script');
  const startedAt = Date.now();
  const { home, result, lines } = runRecorder(JSON.stringify({ sid: 'conv-prompt', eid: 'gen-1', ts: 1 }), {
    preload: CAPTURE_HANG,
    env: { BEEZI_CURSOR_DUMP_HOOKS: '1', BEEZI_PROMPT_CAPTURE: CAPTURE_HANDOFF('{"generation_id":"gen-1"}') },
  });
  const ms = Date.now() - startedAt;
  try {
    assert.equal(result.error, undefined, `the recorder was killed by the test's timeout after ${ms} ms`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(home, 'capture', 'hooks.jsonl')), false, 'the hang did not engage: a capture line was written');
    assert.equal(lines.length, 1, 'a stalled capture must not cost the prompt line');
    assert.ok(ms >= RECORD_WALL_MS - 50, `the recorder left after ${ms} ms, before its ${RECORD_WALL_MS} ms deadline`);
    assert.ok(ms < RECORD_WALL_MS + 4000, `the recorder outlived its ${RECORD_WALL_MS} ms deadline: ${ms} ms`);
  } finally {
    cleanup(home);
  }
});

test('the recorder\'s capture record has the shape dumpHookPayload writes for every other hook', () => {
  // The recorder builds the record itself now (hook-dump's builder is private to that module), so it
  // is pinned against dumpHookPayload's own output, run in a child with the same home layout. Only
  // the fields that describe the writing process or the instant differ by construction: `ts`, `iso`,
  // `pid`, and `script` — a `-e` child has no script path, the recorder is prompt-submit.mjs.
  const dumpUrl = pathToFileURL(fileURLToPath(new URL('../lib/hook-dump.mjs', import.meta.url))).href;
  const argv = ['--via', 'plugin-hooks'];
  for (const bytes of [
    Buffer.from('﻿{"generation_id":"gen-1","prompt":"[redacted by beezi]"}', 'utf-8'),
    Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]), // UTF-16LE: not UTF-8, so raw_b64 is added
    null, // a run with no bytes
  ]) {
    const label = bytes === null ? 'no bytes' : bytes.toString('hex').slice(0, 16);
    const { home, result } = runRecorder(undefined, {
      env: { BEEZI_CURSOR_DUMP_HOOKS: '1', BEEZI_PROMPT_CAPTURE: CAPTURE_HANDOFF(bytes, argv) },
    });
    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-ctl-'));
    try {
      assert.equal(result.status, 0, result.stderr);
      const arg = bytes === null ? 'undefined' : `Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64')`;
      const reference = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { dumpHookPayload } from ${JSON.stringify(dumpUrl)};dumpHookPayload(${arg}, ${JSON.stringify(argv)});`,
      ], { encoding: 'utf-8', timeout: 20_000, env: envFor(control, { BEEZI_CURSOR_DUMP_HOOKS: '1' }) });
      assert.equal(reference.status, 0, reference.stderr);
      const read = (dir) => fs.readFileSync(path.join(dir, 'capture', 'hooks.jsonl'), 'utf-8');
      const ours = read(home);
      const theirs = read(control);
      assert.ok(ours.endsWith('\n') && ours.split('\n').length === 2, `${label}: one newline-terminated line`);
      const mine = JSON.parse(ours);
      const ref = JSON.parse(theirs);
      assert.deepEqual(Object.keys(mine), Object.keys(ref), `${label}: the same fields in the same order`);
      for (const key of Object.keys(ref)) {
        if (key === 'ts' || key === 'iso' || key === 'pid' || key === 'script') continue;
        assert.deepEqual(mine[key], ref[key], `${label}: ${key}`);
      }
      assert.equal(mine.script, 'prompt-submit.mjs');
      assert.equal(typeof mine.ts, 'number');
      assert.equal(new Date(mine.iso).toISOString(), mine.iso);
    } finally {
      cleanup(home);
      cleanup(control);
    }
  }
});

// The gate, timed from the moment the answer reaches stdout to the moment the process is gone AND
// to the moment its pipes close — the window in which Cursor is still holding the user's Send
// although it already has its answer. Then, separately, how long the recorder's line took.
//
// `workspace`, when given, is the project directory the gate enters, kept apart from the home the
// recorder writes into, and the test tries to delete it the moment the gate's pipes close — while a
// stalled recorder is still alive. On Windows a process's working directory cannot be removed, so
// that delete fails if the recorder is sitting in the user's workspace.
//
// `preload`, when given, is an `--import` module for the GATE process only — the recorder is spawned
// with its own argv and does not inherit it.
function runTimed(input, env, { workspace = null, preload = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-timed-'));
  return new Promise((resolve, reject) => {
    const spawnedAtWall = Date.now();
    const spawnedAt = process.hrtime.bigint();
    const args = preload == null ? [] : ['--import', preload];
    args.push(SCRIPT, '--via', 'plugin-hooks');
    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envFor(home, workspace === null ? env : { CURSOR_PROJECT_DIR: workspace, ...env }),
    });
    let stdout = '';
    let answeredAt = null;
    child.stdout.on('data', (chunk) => {
      if (answeredAt === null) answeredAt = process.hrtime.bigint();
      stdout += chunk;
    });
    const kill = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    // 'exit' is the process ending; 'close' is every stdio pipe reaching EOF. They differ exactly
    // when something else still holds a pipe end — which is what a recorder that inherited one
    // would do, and what a host waiting for EOF would wait on.
    let exitedAt = null;
    let exitedAtWall = null;
    child.on('exit', () => { exitedAt = process.hrtime.bigint(); exitedAtWall = Date.now(); });
    child.on('close', async (code) => {
      clearTimeout(kill);
      const closedAt = process.hrtime.bigint();
      const ms = (a, b) => (a === null || b === null ? null : Number(b - a) / 1e6);
      let workspaceRemoval = null;
      if (workspace !== null) {
        try {
          fs.rmSync(workspace, { recursive: true, force: true });
          workspaceRemoval = 'removed';
        } catch (error) {
          workspaceRemoval = error.code;
        }
      }
      await until(() => readLines(home).lines.length > 0);
      const lineAt = process.hrtime.bigint();
      const { lines } = readLines(home);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({
        code,
        stdout,
        lines,
        spawnedAtWall,
        exitedAtWall,
        spawnToExitMs: ms(spawnedAt, exitedAt),
        answerToExitMs: ms(answeredAt, exitedAt),
        answerToCloseMs: ms(answeredAt, closedAt),
        spawnToLineMs: lines.length === 0 ? null : ms(spawnedAt, lineAt),
        workspaceRemoval,
      });
    });
    child.stdin.end(input);
  });
}

const STALL_MS = 1500;

test('a stalled synchronous append cannot hold Send: the gate exits and closes its pipes inside the budget', async () => {
  // The Codex repro, made synchronous this time: the recorder blocks its only thread in
  // Atomics.wait for STALL_MS before appending, which no timer in any process could interrupt. The
  // seam is honoured only under NODE_ENV=test. The gate must not care — it has no append to stall.
  const res = await runTimed(JSON.stringify(PAYLOAD), { NODE_ENV: 'test', BEEZI_TEST_PROMPT_CHILD_STALL_MS: String(STALL_MS) });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, ANSWER);
  assert.ok(res.answerToExitMs !== null, 'the answer never reached stdout');
  const budget = hookBudgetMs(HOOK_KIND_GATE);
  assert.ok(res.answerToExitMs < budget, `the gate lived ${res.answerToExitMs.toFixed(0)} ms after answering`);
  assert.ok(res.answerToCloseMs < budget, `the gate's pipes closed ${res.answerToCloseMs.toFixed(0)} ms after answering`);
  // And the line still lands — later, from the recorder, which is what proves the recorder and not
  // the gate wrote it — stamped with the gate's own start rather than the recorder's late write.
  assert.equal(res.lines.length, 1, 'the stalled recorder never wrote its line');
  assert.ok(res.spawnToLineMs >= STALL_MS, `the line appeared ${res.spawnToLineMs.toFixed(0)} ms in, before the stall ended`);
  assert.ok(res.lines[0].ts >= res.spawnedAtWall && res.lines[0].ts <= res.exitedAtWall, 'the line is not stamped with the gate\'s start');
  assert.equal(res.lines[0].eid, 'gen-1');
});

test('the recorder does not sit in the user\'s workspace while it works', async () => {
  // The gate enters the project directory (every hook entry does), and a child inherits its parent's
  // working directory. A recorder left there would, on Windows, lock the user's workspace against
  // deletion or rename for as long as it lives — which, with a stalled append, is as long as the
  // stall. So the recorder starts somewhere neutral and is not told where the project is.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-ws-'));
  const res = await runTimed(
    JSON.stringify({ ...PAYLOAD, cwd: workspace }),
    { NODE_ENV: 'test', BEEZI_TEST_PROMPT_CHILD_STALL_MS: String(STALL_MS) },
    { workspace },
  );
  fs.rmSync(workspace, { recursive: true, force: true });
  assert.equal(res.workspaceRemoval, 'removed', `the workspace could not be removed under a live recorder: ${res.workspaceRemoval}`);
  // And the line still names the workspace: the cwd crossed in the hand-off, not through the
  // recorder's own directory.
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].cwd, workspace);
});

test('the recorder-stall seam is inert outside NODE_ENV=test', async () => {
  // A stray variable in a user's environment must not be able to delay their prompt lines.
  const res = await runTimed(JSON.stringify(PAYLOAD), { NODE_ENV: '', BEEZI_TEST_PROMPT_CHILD_STALL_MS: String(STALL_MS) });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, ANSWER);
  assert.equal(res.lines.length, 1);
  assert.ok(res.spawnToLineMs < STALL_MS, `the line took ${res.spawnToLineMs.toFixed(0)} ms: the seam applied`);
  assert.ok(res.answerToExitMs < hookBudgetMs(HOOK_KIND_GATE), `${res.answerToExitMs} ms after answering`);
});

// A STALLED FILESYSTEM, as the gate process sees it. Codex review, BLOCKING, the third time round:
// the gate still called `enterProjectDir()` — an `fs.existsSync` of the workspace and a
// `process.chdir` into it — and a timer cannot interrupt either, so a 900 ms existsSync stall kept
// the gate, and the user's Send, alive 916 ms. The gate now touches no file at all, and this
// preload is what proves it at runtime rather than by grep: EVERY synchronous `fs` call in the
// process, and `process.chdir`, blocks the only thread for FS_STALL_MS before doing its work.
//
// Exempt are the one synchronous call the gate is allowed — `writeSync` to fd 1 (the answer) or
// fd 2 — and node's own ESM loader, which reads every module's SOURCE through the public `fs`
// object's openSync/readSync/closeSync (verified by tracing on node 24). Those reads are of the
// plugin's own install directory, not the user's workspace, and no script can avoid them: they are
// how node runs a script at all. A call with one of the loader's SOURCE-reading frames on its stack
// (esm/load, esm/resolve, esm/translators, package_json_reader) is therefore passed through. The
// match is that narrow on purpose: a module's top-level code runs under esm/module_job and
// esm/loader, so a broader
// `node:internal/modules/` match would exempt a top-level `enterProjectDir()` — the very call this
// test exists to catch. Everything the plugin's code calls itself is stalled.
// `syncBuiltinESMExports` carries the patch to named imports (`import { existsSync } from 'fs'`)
// as well as to the default-export object, so neither spelling can slip past. The preload is
// test-only by construction — it exists only on this file's command lines, and only on the GATE's
// (the recorder is spawned with its own argv) — so production carries no seam for it.
const FS_STALL_MS = 900;
const FS_STALL = 'data:text/javascript,' + encodeURIComponent([
  'import fs from "fs";',
  'import { syncBuiltinESMExports } from "module";',
  `const stall = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${FS_STALL_MS});`,
  'for (const name of Object.keys(fs)) {',
  '  const real = fs[name];',
  '  if (!/Sync$/.test(name) || typeof real !== "function") continue;',
  '  fs[name] = function (...args) {',
  '    const answer = name === "writeSync" && (args[0] === 1 || args[0] === 2);',
  // `[/]`, not `\/`: a backslash does not survive the data: URL (node's URL parse turns it into a
  // slash, which ends the regex literal early). The `:` that follows the module name matters too:
  // without it `esm/load` also matches `esm/loader`, which is on the stack of every module's
  // top-level code.
  '    const loader = /node:internal[/]modules[/](esm[/](load|resolve|translators)|package_json_reader):/;',
  '    if (!answer && !loader.test(String(new Error().stack))) stall();',
  '    return real.apply(this, args);',
  '  };',
  '}',
  'const chdir = process.chdir;',
  'process.chdir = function (...args) { stall(); return chdir.apply(this, args); };',
  'syncBuiltinESMExports();',
].join('\n'));

test('the script holds no filesystem call a timer cannot interrupt, in the gate or the recorder', () => {
  // The structural half of the two runtime tests around it. Codex review, BLOCKING (the gate's
  // existsSync + chdir) and MAJOR (the recorder's synchronous append): the gate makes no filesystem
  // call at all, and the recorder's are asynchronous, so both processes' timers can always fire.
  // The answer's one `writeSync` to fd 1 is pinned in test/plugin-manifest.test.mjs. Code only —
  // the comments name these calls to explain why they are gone.
  const body = fs.readFileSync(SCRIPT, 'utf-8').replace(/\/\/.*$/gm, '');
  // `dumpHookPayload(` and the retention sweep too (Codex review, MAJOR): both are synchronous, and
  // the recorder used to call the first for capture, which put its stall past the deadline.
  for (const blocking of ['existsSync', 'chdir(', 'enterProjectDir', 'mkdirSync', 'statSync', 'appendFileSync', 'appendEvent(',
    'dumpHookPayload(', 'CaptureRetention(']) {
    assert.equal(body.includes(blocking), false, `${blocking} is back in the gate script`);
  }
  // And no synchronous call of any other name: the answer's one `writeSync` is the only one.
  assert.deepEqual((body.match(/\w+Sync\(/g) || []).filter((call) => call !== 'writeSync('), []);
  assert.match(body, /fs\.appendFile\(/, 'the recorder\'s append is the asynchronous one');
  assert.match(body, /fs\.mkdir\(/, 'the recorder\'s mkdir is the asynchronous one');
});

test('the fs-stall preload really stalls: a positive control for the test below', () => {
  // Without this, a preload that silently failed to apply would let the stalled-filesystem test pass
  // for the wrong reason — the gate would be fast because nothing was stalled at all.
  // The third call is the exact code the gate used to run — hook-cwd's enterProjectDir, imported
  // as a module, so its stall has to survive the loader exemption.
  const hookCwd = pathToFileURL(fileURLToPath(new URL('../lib/hook-cwd.mjs', import.meta.url))).href;
  for (const call of [
    'import fs from "fs"; fs.existsSync(".");',
    'process.chdir(".");',
    `import { enterProjectDir } from ${JSON.stringify(hookCwd)}; enterProjectDir({ env: { CURSOR_PROJECT_DIR: process.cwd() } });`,
  ]) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['--import', FS_STALL, '--input-type=module', '-e', call], { encoding: 'utf-8', timeout: 20_000 });
    const ms = Date.now() - startedAt;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(ms >= FS_STALL_MS, `${call} took ${ms} ms: the preload did not stall it`);
  }
});

test('a stalled filesystem cannot hold Send: the gate makes no fs call, so it exits inside the budget', async () => {
  // The workspace is a real directory, so the old `existsSync` + `chdir` path would have run to
  // completion — slowly. The cwd on the line comes from the payload, not from the gate's own
  // working directory.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-ws-'));
  try {
    for (const env of [{}, { BEEZI_CURSOR_DUMP_HOOKS: '1' }]) {
      const res = await runTimed(JSON.stringify({ ...PAYLOAD, cwd: workspace }), env, { preload: FS_STALL });
      const label = env.BEEZI_CURSOR_DUMP_HOOKS ? 'with capture on' : 'with capture off';
      assert.equal(res.code, 0, label);
      assert.equal(res.stdout, ANSWER, label);
      assert.ok(res.answerToExitMs !== null, `${label}: the answer never reached stdout`);
      const budget = hookBudgetMs(HOOK_KIND_GATE);
      assert.ok(res.answerToExitMs < budget, `${label}: the gate lived ${res.answerToExitMs.toFixed(0)} ms after answering`);
      assert.ok(res.answerToCloseMs < budget, `${label}: the gate's pipes closed ${res.answerToCloseMs.toFixed(0)} ms after answering`);
      // Still in time to hand off: the recorder (unstalled — it has its own argv) wrote the line.
      assert.equal(res.lines.length, 1, `${label}: no line`);
      assert.equal(res.lines[0].cwd, workspace, label);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('with capture on, the prompt never reaches the capture file, nothing is spilled, and the line is still written', async () => {
  const { home, result, lines } = await run(JSON.stringify(PAYLOAD), { env: { BEEZI_CURSOR_DUMP_HOOKS: '1' }, expect: 'capture' });
  try {
    assert.equal(result.stdout, ANSWER);
    const captured = fs.readFileSync(path.join(home, 'capture', 'hooks.jsonl'), 'utf-8');
    assert.equal(captured.includes('zebra'), false, 'prompt or attachment text reached the capture file');
    // The shape survives: both keys are still there, so a capture session still shows what a real
    // payload carries.
    const records = captured.trim().split('\n');
    assert.equal(records.length, 1, 'one capture record per gate run');
    const record = JSON.parse(records[0]);
    const raw = JSON.parse(record.raw);
    assert.equal('prompt' in raw, true);
    assert.equal(raw.attachments.length, 1);
    assert.equal(raw.generation_id, 'gen-1');
    // The registry flag is the GATE's, handed over, not the recorder's own `--record`.
    assert.equal(record.via, 'plugin-hooks');
    assert.equal(record.script, 'prompt-submit.mjs');
    // The hook's line landed too.
    assert.equal(lines.length, 1);
    assert.equal(lines[0].eid, 'gen-1');
    // And no replay spill exists: the gate reads stdin once, into memory, so there is nothing for a
    // spill to replay — and a spill is a file a killed hook leaves behind.
    const spill = path.join(home, 'capture', 'stdin');
    assert.deepEqual(fs.existsSync(spill) ? fs.readdirSync(spill) : [], []);
  } finally {
    cleanup(home);
  }
});

test('with capture on, a payload too big to hand over is recorded as a run with no bytes', async () => {
  // The redacted payload travels to the recorder in an environment variable, and a variable has a
  // ceiling (32 767 characters on Windows). Past the hand-off cap the run is still captured, as
  // metadata only — never by writing a file from the gate, and never with the prompt in it.
  const big = JSON.stringify({ ...PAYLOAD, padding: 'p'.repeat(64 * 1024) });
  const { home, result, lines } = await run(big, { env: { BEEZI_CURSOR_DUMP_HOOKS: '1' }, expect: 'capture' });
  try {
    assert.equal(result.stdout, ANSWER);
    const record = JSON.parse(fs.readFileSync(path.join(home, 'capture', 'hooks.jsonl'), 'utf-8').trim());
    assert.equal(record.bytes, null);
    assert.equal(record.raw, null);
    assert.equal(lines.length, 1);
  } finally {
    cleanup(home);
  }
});

test('with capture on, an unattributable payload is still captured as a run, and writes no line', async () => {
  // Capture records runs, not only the ones this hook could use: "this hook fired with bytes nothing
  // could parse" is a finding. An unparseable payload cannot be redacted, so it carries no bytes.
  const captureFile = (home) => path.join(home, 'capture', 'hooks.jsonl');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-cap-'));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, '--via', 'plugin-hooks'], {
      input: `not json ${SECRET}`,
      encoding: 'utf-8',
      timeout: 20_000,
      env: envFor(home, { BEEZI_CURSOR_DUMP_HOOKS: '1' }),
    });
    assert.equal(result.stdout, ANSWER);
    assert.ok(await until(() => fs.existsSync(captureFile(home))), 'the run was not captured');
    await sleep(NO_LINE_GRACE_MS);
    const captured = fs.readFileSync(captureFile(home), 'utf-8');
    assert.equal(captured.includes('zebra'), false);
    assert.equal(JSON.parse(captured.trim()).bytes, null);
    assert.equal(readLines(home).lines.length, 0);
  } finally {
    cleanup(home);
  }
});
