import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DUMP_ENV_VAR,
  MAX_RAW_BYTES,
  captureDir,
  captureFile,
  captureHookStdin,
  dumpHookPayload,
  REDACTED,
  redactPayloadBytes,
} from '../lib/hook-dump.mjs';
import { readHookInput } from '../lib/hook-input-cursor.mjs';

// The capture harness is the thing that answers `TODO(P0): unverified`, so its own failure modes are
// the expensive ones: a capture that is silently off, a capture that mangles the bytes it exists to
// preserve, or a capture that takes a hook down with it. All three are here.

function tmpHome(t, { capturing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hook-dump-'));
  const prevHome = process.env.BEEZI_CURSOR_HOME;
  const prevDump = process.env[DUMP_ENV_VAR];
  process.env.BEEZI_CURSOR_HOME = dir;
  if (capturing) process.env[DUMP_ENV_VAR] = '1';
  else delete process.env[DUMP_ENV_VAR];
  t.after(() => {
    if (prevHome === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prevHome;
    if (prevDump === undefined) delete process.env[DUMP_ENV_VAR];
    else process.env[DUMP_ENV_VAR] = prevDump;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function records() {
  return fs.readFileSync(captureFile(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
}

test('with the switch off it writes nothing at all, not even a directory', (t) => {
  const home = tmpHome(t, { capturing: false });

  dumpHookPayload(Buffer.from('{"session_id":"c1"}'), ['--via', 'plugin-hooks']);

  // Not "an empty file" and not "a directory that exists" — nothing. This runs from postToolUse,
  // which fires on every tool call, so an off switch that still costs a mkdir per event is not off.
  assert.equal(fs.existsSync(captureDir(home)), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('one line per call, in the order the hooks ran', (t) => {
  tmpHome(t);

  dumpHookPayload(Buffer.from('{"n":1}'), ['--via', 'plugin-hooks']);
  dumpHookPayload(Buffer.from('{"n":2}'), ['--via', 'launcher']);

  const lines = records();
  assert.equal(lines.length, 2);
  assert.equal(lines[0].raw, '{"n":1}');
  assert.equal(lines[1].raw, '{"n":2}');
});

test('every record says when it happened, which registry sent it, and which hook produced it', (t) => {
  tmpHome(t);
  const before = Date.now();

  dumpHookPayload(Buffer.from('{"a":1}'), ['--via', 'plugin-hooks']);

  const [line] = records();
  assert.ok(line.ts >= before && line.ts <= Date.now());
  // Both stamps, because the two readers are different: `ts` is what a script sorts and joins on,
  // `iso` is what a human matches against Cursor's own execution log while the session is running.
  assert.ok(Math.abs(new Date(line.iso).getTime() - line.ts) < 1000);
  // `--via` verbatim, NOT run through hookVia — capture has to be able to show a registry passing a
  // flag nobody expected, and a normalizer maps exactly that onto `launcher`.
  assert.equal(line.via, 'plugin-hooks');
  assert.deepEqual(line.argv, ['--via', 'plugin-hooks']);
  // Identity comes from the process, not from the payload: whether Cursor even sends
  // `hook_event_name` is one of the things capture is here to establish.
  assert.equal(typeof line.script, 'string');
  assert.equal(line.pid, process.pid);
});

test('an unrecognised --via value is recorded as it arrived, and a missing one as null', (t) => {
  tmpHome(t);

  dumpHookPayload(Buffer.from('{}'), ['--via', 'something-new']);
  dumpHookPayload(Buffer.from('{}'), []);

  const lines = records();
  assert.equal(lines[0].via, 'something-new');
  assert.equal(lines[1].via, null);
});

test('a payload with a UTF-8 BOM is recorded with the BOM intact', (t) => {
  tmpHome(t);
  // The exact shape lib/hook-input-cursor.mjs:12-31 documents: Cursor spills the payload to a temp
  // file and pipes it back through Windows PowerShell's BOM-carrying UTF8 encoder, so the hook is
  // handed `﻿{"session_id":…}` even though the file starts with `{`. Every hook on every
  // Windows machine failed to parse that and exited having done nothing. A capture that stripped the
  // BOM before recording could never have shown it — so it does not strip.
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"session_id":"c1"}', 'utf-8')]);

  dumpHookPayload(raw, ['--via', 'plugin-hooks']);

  const [line] = records();
  assert.equal(line.raw.charCodeAt(0), 0xfeff, 'the BOM was stripped before it could be recorded');
  assert.equal(line.raw, '﻿{"session_id":"c1"}');
  // The hex head is the field that answers this without trusting any decoding at all.
  assert.ok(line.head_hex.startsWith('efbbbf'), line.head_hex);
  assert.equal(line.bytes, raw.length);
  // Nothing here parses, so a payload that JSON.parse would reject is still fully recorded — which
  // is the case worth having, since a hook receiving garbage is invisible from anywhere else.
  assert.throws(() => JSON.parse(line.raw));
});

test('bytes that are not UTF-8 keep an authoritative base64 copy alongside the readable one', (t) => {
  tmpHome(t);
  // decodeHookPayload also handles UTF-16LE, because that is another thing PowerShell has been seen
  // producing. Those bytes do not survive a utf-8 round trip, and a capture that quietly lost them
  // would be worse than no capture.
  const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]);

  dumpHookPayload(raw, []);

  const [line] = records();
  assert.equal(line.head_hex.slice(0, 4), 'fffe');
  assert.ok(line.raw_b64, 'lossy bytes were recorded with no authoritative copy');
  assert.ok(Buffer.from(line.raw_b64, 'base64').equals(raw));
});

test('a payload over the cap is truncated, and says so', (t) => {
  tmpHome(t);
  // postToolUse carries `tool_output` — the full text a tool produced. A `read_file` on a bundled
  // asset is megabytes and a capture session is thousands of hook runs, so unbounded lines are how
  // the capture file becomes the thing that fills the user's disk.
  const raw = Buffer.from('x'.repeat(MAX_RAW_BYTES + 1000), 'utf-8');

  dumpHookPayload(raw, []);

  const [line] = records();
  assert.equal(line.truncated, true);
  assert.equal(line.raw.length, MAX_RAW_BYTES);
  // The ORIGINAL length, so a clipped payload is never read back as a short one.
  assert.equal(line.bytes, MAX_RAW_BYTES + 1000);
});

test('a payload at exactly the cap is not marked truncated', (t) => {
  tmpHome(t);
  dumpHookPayload(Buffer.from('x'.repeat(MAX_RAW_BYTES), 'utf-8'), []);
  const [line] = records();
  assert.equal(line.truncated, false);
  assert.equal(line.bytes, MAX_RAW_BYTES);
});

test('a hook that received no readable bytes is still recorded', (t) => {
  tmpHome(t);
  // "This hook fired and got nothing" is a finding, not a non-event: it is what a registry that
  // starts the hook but pipes it nothing looks like, and dropping the line would make it
  // indistinguishable from a hook that never fired at all.
  dumpHookPayload(null, ['--via', 'plugin-hooks']);

  const [line] = records();
  assert.equal(line.raw, null);
  assert.equal(line.bytes, null);
  assert.equal(line.head_hex, null);
  assert.equal(line.via, 'plugin-hooks');
});

test('a write failure is swallowed — capture must never take down the hook it observes', (t) => {
  const home = tmpHome(t);
  // The capture directory's path is occupied by a file, so neither the append nor the mkdir that
  // follows it can succeed. This runs inside postToolUse; a throw here fails a hook in front of the
  // user, in the middle of their work, for telemetry about telemetry.
  fs.writeFileSync(captureDir(home), 'not-a-dir');

  assert.doesNotThrow(() => dumpHookPayload(Buffer.from('{"a":1}'), ['--via', 'plugin-hooks']));
});

test('an unserializable argv cannot throw either', (t) => {
  tmpHome(t);
  const circular = [];
  circular.push(circular);
  assert.doesNotThrow(() => dumpHookPayload(Buffer.from('{}'), circular));
});

test('the capture file is 0600 and its directory 0700', { skip: process.platform === 'win32' }, (t) => {
  const home = tmpHome(t);
  // The least redacted thing this plugin ever writes: full tool output, shell command text, file
  // paths, and whatever a payload carries that nobody has looked at yet.
  dumpHookPayload(Buffer.from('{"a":1}'), []);

  assert.equal(fs.statSync(captureFile()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(captureDir(home)).mode & 0o777, 0o700);
});

test('captureHookStdin does not read stdin at all when capture is off', (t) => {
  tmpHome(t, { capturing: false });
  // The call site is `readHookInput(stdin?.replay ?? 0)`, so null here is what leaves every hook
  // reading fd 0 exactly as it did before this harness existed.
  assert.equal(captureHookStdin(), null);
});

test('captureHookStdin hands back the bytes AND a replay the hook can still parse', (t) => {
  const home = tmpHome(t);
  // Stdin is single-shot: Cursor pipes the payload in, so reading it for the dump is reading it
  // instead of the hook. Without the replay every hook would dump a perfect payload and then do
  // none of its work — analytics silently off for the whole capture session, on the one machine
  // that finally has Cursor installed.
  const source = path.join(home, 'stdin-fixture.json');
  fs.writeFileSync(source, '{"session_id":"c1","cwd":"/repo"}');

  const stdin = captureHookStdin(source);
  assert.equal(stdin.raw.toString('utf-8'), '{"session_id":"c1","cwd":"/repo"}');
  assert.equal(readHookInput(stdin.replay).session_id, 'c1');

  dumpHookPayload(stdin.raw, ['--via', 'plugin-hooks']);
  assert.equal(records()[0].raw, '{"session_id":"c1","cwd":"/repo"}');
});

test('a replay of BOM-prefixed bytes is decoded by the hook’s own decoder, not by capture', (t) => {
  const home = tmpHome(t);
  const source = path.join(home, 'bom-fixture.bin');
  fs.writeFileSync(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"session_id":"c2"}')]));

  const stdin = captureHookStdin(source);

  // Capture records the BOM; readHookInput strips it. Both, from the same bytes — capture observes
  // the hook's input path, it does not stand in for it.
  dumpHookPayload(stdin.raw, []);
  assert.equal(records()[0].head_hex.slice(0, 6), 'efbbbf');
  assert.equal(readHookInput(stdin.replay).session_id, 'c2');
});

test('captureHookStdin reports an unreadable stdin rather than throwing', (t) => {
  const home = tmpHome(t);
  const stdin = captureHookStdin(path.join(home, 'does-not-exist'));
  assert.deepEqual(stdin, { raw: null, replay: null });
  // And the caller's `?? 0` still resolves, so the hook falls back to reading fd 0.
  assert.doesNotThrow(() => dumpHookPayload(stdin?.raw, []));
});

// ── redaction: the one payload capture must not record verbatim ──────────────────────────────────
//
// `beforeSubmitPrompt` hands its hook the user's prompt text and attachments. Capture's whole point
// is raw bytes, but those bytes are what the person typed to the model — and the capture file and
// its replay spill both outlive the run. So scripts/prompt-submit.mjs asks for those two fields to
// be replaced before anything is written. The SHAPE survives (the keys, the attachment count, every
// other field) because the shape is what a capture session is for.

const PROMPT_FIELDS = ['prompt', 'attachments'];
const SECRET = 'my secret prompt about project zebra';
const PROMPT_PAYLOAD = {
  session_id: 'c9',
  generation_id: 'gen-9',
  hook_event_name: 'beforeSubmitPrompt',
  prompt: SECRET,
  attachments: [{ type: 'file', file_path: '/home/me/zebra-notes.md' }, { type: 'rule', file_path: '/r' }],
  workspace_roots: ['/repo'],
};

test('redaction replaces the named fields, keeps their keys, and keeps everything else', () => {
  const out = redactPayloadBytes(Buffer.from(JSON.stringify(PROMPT_PAYLOAD)), PROMPT_FIELDS);
  const text = out.toString('utf-8');
  assert.equal(text.includes('zebra'), false, 'prompt or attachment text survived redaction');
  const parsed = JSON.parse(text);
  assert.equal(parsed.prompt, REDACTED);
  // Same length, so "how many attachments does a real payload carry" is still answerable.
  assert.deepEqual(parsed.attachments, [REDACTED, REDACTED]);
  assert.equal(parsed.session_id, 'c9');
  assert.equal(parsed.generation_id, 'gen-9');
  assert.deepEqual(parsed.workspace_roots, ['/repo']);
  // A field that is absent stays absent: redaction never invents a key.
  const bare = JSON.parse(redactPayloadBytes(Buffer.from('{"session_id":"c1"}'), PROMPT_FIELDS).toString('utf-8'));
  assert.deepEqual(bare, { session_id: 'c1' });
});

test('redaction keeps a UTF-8 BOM, so the capture still answers the BOM question', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(PROMPT_PAYLOAD))]);
  const out = redactPayloadBytes(bom, PROMPT_FIELDS);
  assert.equal(out.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(out.toString('utf-8').includes('zebra'), false);
});

test('redaction reads every encoding the hook decoder reads, and writes the same encoding back', (t) => {
  // A payload the decoder accepts but the redactor refused would lose its prompt line whenever
  // capture is on — so both UTF-16 forms Windows PowerShell has been seen producing are covered.
  const home = tmpHome(t);
  const json = JSON.stringify(PROMPT_PAYLOAD);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
  const be = Buffer.from(le).swap16();
  for (const [name, buf] of [['utf16le', le], ['utf16be', be]]) {
    const out = redactPayloadBytes(buf, PROMPT_FIELDS);
    assert.ok(Buffer.isBuffer(out), `${name} was refused`);
    assert.equal(out.subarray(0, 2).toString('hex'), buf.subarray(0, 2).toString('hex'), `${name} lost its mark`);
    const file = path.join(home, `${name}.bin`);
    fs.writeFileSync(file, out);
    const parsed = readHookInput(file);
    assert.equal(parsed.generation_id, 'gen-9', `${name} no longer decodes`);
    assert.equal(parsed.prompt, REDACTED);
    assert.equal(JSON.stringify(parsed).includes('zebra'), false);
  }
});

test('a payload redaction cannot read is refused rather than recorded', () => {
  // Not parseable means not redactable, and an unredacted prompt is the one thing this must not
  // write. The hook's own decoder rejects the same bytes, so nothing the hook could use is lost.
  for (const raw of ['not json', '{"prompt":', '["a prompt in an array"]', '"a bare string"']) {
    assert.equal(redactPayloadBytes(Buffer.from(raw), PROMPT_FIELDS), null, raw);
  }
});

test('captureHookStdin redacts both the dumped bytes and the replay spill', (t) => {
  const home = tmpHome(t);
  const source = path.join(home, 'prompt-fixture.json');
  fs.writeFileSync(source, JSON.stringify(PROMPT_PAYLOAD));

  const stdin = captureHookStdin(source, { redact: PROMPT_FIELDS });
  assert.equal(stdin.raw.toString('utf-8').includes('zebra'), false);
  // The replay is a plain-text file in the user's home that a killed hook leaves behind, so it must
  // not hold the prompt either — and it must still be the payload the hook parses.
  assert.equal(fs.readFileSync(stdin.replay, 'utf-8').includes('zebra'), false);
  const parsed = readHookInput(stdin.replay);
  assert.equal(parsed.session_id, 'c9');
  assert.equal(parsed.generation_id, 'gen-9');

  dumpHookPayload(stdin.raw, ['--via', 'plugin-hooks']);
  const line = fs.readFileSync(captureFile(), 'utf-8');
  assert.equal(line.includes('zebra'), false);
  assert.equal(JSON.parse(records()[0].raw).prompt, REDACTED);
});

test('captureHookStdin with redaction on an unreadable payload records no bytes and spills nothing', (t) => {
  const home = tmpHome(t);
  const source = path.join(home, 'garbage.bin');
  fs.writeFileSync(source, `prompt: ${SECRET}`);
  const stdin = captureHookStdin(source, { redact: PROMPT_FIELDS });
  assert.deepEqual(stdin, { raw: null, replay: null });
  assert.equal(fs.existsSync(path.join(captureDir(home), 'stdin')), false);
});

test('captureHookStdin with redaction still reads nothing when capture is off', (t) => {
  tmpHome(t, { capturing: false });
  assert.equal(captureHookStdin(0, { redact: PROMPT_FIELDS }), null);
});
