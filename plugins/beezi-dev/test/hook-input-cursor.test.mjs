import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeHookPayload,
  isGitCheckpointCommand,
  normalizeHookInput,
  readHookInput,
  shellCommandsOf,
  stampableCwd,
} from '../lib/hook-input-cursor.mjs';

// Windows delivery: Cursor writes the payload to a temp file and pipes it through PowerShell with
// `$OutputEncoding = [System.Text.Encoding]::UTF8`, the BOM-carrying encoding. The hook therefore
// receives a mark the temp file does not contain — sometimes two — and JSON.parse rejects it.
function payloadFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hookin-')), 'payload.json');
  fs.writeFileSync(file, text);
  return file;
}

test('a payload prefixed with a UTF-8 BOM still parses', () => {
  const file = payloadFile('﻿{"session_id":"s1","tool_name":"read_file"}');
  assert.deepEqual(readHookInput(file), { session_id: 's1', tool_name: 'read_file' });
});

test('two BOMs parse too — the pipeline can add one per stage', () => {
  const file = payloadFile('﻿﻿{"session_id":"s1"}\r\n');
  assert.deepEqual(readHookInput(file), { session_id: 's1' });
});

test('a UTF-16 payload is decoded rather than rejected', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hookin-')), 'p.json');
  fs.writeFileSync(file, Buffer.from(`﻿{"session_id":"s1"}`, 'utf16le'));
  assert.deepEqual(readHookInput(file), { session_id: 's1' });
});

test('trailing CRLF and surrounding whitespace do not break the parse', () => {
  assert.deepEqual(readHookInput(payloadFile('  {"session_id":"s1"}\r\n\r\n')), { session_id: 's1' });
});

test('empty and unparseable input are still null, never a throw', () => {
  assert.equal(readHookInput(payloadFile('')), null);
  assert.equal(readHookInput(payloadFile('﻿')), null);
  assert.equal(readHookInput(payloadFile('not json')), null);
  assert.equal(readHookInput(path.join(os.tmpdir(), 'beezi-does-not-exist-9f3a.json')), null);
});

test('decodeHookPayload leaves a clean payload untouched', () => {
  assert.equal(decodeHookPayload(Buffer.from('{"a":1}', 'utf-8')), '{"a":1}');
});

test('isGitCheckpointCommand matches commit/switch/checkout only', () => {
  assert.ok(isGitCheckpointCommand('git commit -m "x"'));
  assert.ok(isGitCheckpointCommand('git switch main'));
  assert.ok(isGitCheckpointCommand('git checkout -b feat'));
  assert.ok(!isGitCheckpointCommand('git status'));
  assert.ok(!isGitCheckpointCommand('ls -la'));
});

test('session_id is the identity, and it wins — Cursor already resolved it', () => {
  // executeHookForStep computes `session_id ?? conversation_id` and writes the result back onto
  // the payload as `session_id` before spawning the hook. Reading anything else means disagreeing
  // with the host about which session this is.
  const input = normalizeHookInput({ conversation_id: 'conv-1', session_id: 'sess-9', cwd: '/r' });
  assert.equal(input.session_id, 'sess-9');
});

test('a payload carrying only session_id is attributed, not dropped', () => {
  // The real shape. Cursor's `stop` payload is { status, loop_count, input_tokens, …, session_id,
  // hook_event_name, cursor_version, workspace_roots, user_email, transcript_path } — and no
  // conversation_id at all. Requiring one made every hook a no-op: they fired, read stdin, found
  // no identity, and exited without writing a single sidecar line.
  assert.equal(normalizeHookInput({ session_id: 'sess-9', cwd: '/r' }).session_id, 'sess-9');
});

test('conversation_id still works, for the events that carry only that', () => {
  assert.equal(normalizeHookInput({ conversation_id: 'conv-1' }).session_id, 'conv-1');
  assert.equal(normalizeHookInput({ conversationId: 'conv-2' }).session_id, 'conv-2');
  assert.equal(normalizeHookInput({ sessionId: 'sess-2' }).session_id, 'sess-2');
});

test('a payload with no identity at all is refused rather than half-attributed', () => {
  assert.equal(normalizeHookInput({ cwd: '/r' }), null);
  assert.equal(normalizeHookInput({ session_id: '', conversation_id: '' }), null);
  assert.equal(normalizeHookInput(null), null);
  assert.equal(normalizeHookInput('nope'), null);
});

test('an empty session_id falls through to conversation_id instead of failing', () => {
  assert.equal(normalizeHookInput({ session_id: '', conversation_id: 'c' }).session_id, 'c');
});

test('normalizeHookInput fills the { session_id, transcript_path, cwd } shape', () => {
  assert.deepEqual(
    normalizeHookInput({ session_id: 'c', transcript_path: '/t.jsonl', cwd: '/r' }),
    { session_id: 'c', transcript_path: '/t.jsonl', cwd: '/r' },
  );
  // transcript_path is optional and load-bearing nowhere — the sidecar is the source of truth, and
  // cursor-agent has no observed transcript write path at all.
  assert.deepEqual(
    normalizeHookInput({ session_id: 'c', cwd: '/r' }),
    { session_id: 'c', transcript_path: null, cwd: '/r' },
  );
});

test('a payload with no usable root falls back rather than reporting nowhere', () => {
  // A null cwd resolves no repo, so no remote, so the segment is silently never enqueued. Cursor
  // omits workspace_roots on some events and mangles it for UNC workspaces, but every hook script
  // has already chdir-ed into the workspace by the time this runs.
  const input = normalizeHookInput({ session_id: 'c' });
  assert.equal(input.cwd, process.cwd());
});

test('an explicit workspace root still wins over the fallback', () => {
  assert.equal(normalizeHookInput({ session_id: 'c', workspace_roots: ['/w'] }).cwd, '/w');
});

test('normalizeHookInput falls back to workspace_roots for cwd', () => {
  assert.equal(normalizeHookInput({ conversation_id: 'c', workspace_roots: ['/w'] }).cwd, '/w');
});

// normalizeHookInput derives its cwd THROUGH stampableCwd rather than re-deriving the same chain,
// and the process.cwd() tail is the only thing that may differ. That is the invariant the
// dual-registry duplicate collapse rests on: the reader keys on line content, so if the stamped
// value and the reported value could disagree on a payload that resolves at all, the two copies of
// every event would stop collapsing and the machine would count everything twice.
test('the two cwd derivations agree wherever the payload resolves at all', () => {
  const payloads = [
    { session_id: 'c', cwd: '/r' },
    { session_id: 'c', workspace_roots: ['/w'] },
    { session_id: 'c', workspaceRoots: ['/w2'] },
    // A Windows URI root: workspace_roots carries `uri.path`, so it arrives with a leading slash.
    { session_id: 'c', workspace_roots: ['/c:/Users/you/project'] },
    // payload.cwd outranks every root below it.
    { session_id: 'c', cwd: '/r', workspace_roots: ['/w'] },
  ];
  for (const payload of payloads) {
    const stamped = stampableCwd(payload);
    assert.ok(stamped, `stampableCwd resolved nothing for ${JSON.stringify(payload)}`);
    assert.equal(normalizeHookInput(payload).cwd, stamped, JSON.stringify(payload));
  }
});

// …and the tail is exactly where they part company. stampableCwd must stay per-EVENT (null rather
// than a per-PROCESS accident), while the reporting path needs some directory to attribute against.
test('only normalizeHookInput carries the process.cwd() tail', () => {
  const prev = { CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const payload = { session_id: 'c' };
    assert.equal(stampableCwd(payload), null, 'nothing per-event to stamp');
    assert.equal(normalizeHookInput(payload).cwd, process.cwd());
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('shellCommandsOf reads Cursor’s top-level command directly', () => {
  // Cursor's afterShellExecution supplies `command` as a plain string — no dual-surface tool_input
  // parsing, and no JS program to regex, unlike Codex.
  assert.deepEqual(shellCommandsOf({ command: 'git commit -m "x"' }), ['git commit -m "x"']);
  assert.deepEqual(shellCommandsOf({ command: '' }), []);
  assert.deepEqual(shellCommandsOf({}), []);
  assert.deepEqual(shellCommandsOf(null), []);
});

test('shellCommandsOf falls back to a nested tool_input.command', () => {
  assert.deepEqual(shellCommandsOf({ tool_input: { command: 'git switch dev' } }), ['git switch dev']);
});

test('a git checkpoint is detected from a real afterShellExecution shape', () => {
  const payload = { conversation_id: 'c', command: 'git checkout -b feat/x', cwd: '/r' };
  assert.ok(shellCommandsOf(payload).some(isGitCheckpointCommand));
  assert.ok(!shellCommandsOf({ ...payload, command: 'npm test' }).some(isGitCheckpointCommand));
});
