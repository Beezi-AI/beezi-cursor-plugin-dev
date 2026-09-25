import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEvent, eventsFileFor } from '../lib/sidecar.mjs';
import { readEvents } from '../lib/sidecar-read.mjs';
import { computeSessionTimeline } from '../lib/session-timeline-cursor.mjs';

// The turn-end hooks are the ONLY writers of a boundary event — `postToolUse` derives gen/tool/
// shell/edit and nothing else — so `session-timeline-cursor` can never classify a gap as
// `waiting_user` unless these scripts emit one. They are therefore run the way Cursor runs them
// (payload on stdin, own process) rather than having their composition re-implemented in the test:
// a boundary that the real script does not write is exactly the failure this covers.
const SCRIPTS = {
  stop: fileURLToPath(new URL('../scripts/stop.mjs', import.meta.url)),
  sessionEnd: fileURLToPath(new URL('../scripts/report.mjs', import.meta.url)),
};

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-turn-end-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// BEEZI_API_URL points at a closed port on purpose: the checkpoint these hooks run is gated on this
// machine's own credentials, and a developer who has actually linked Cursor must not have a test run
// reach the real Beezi API.
function runHook(script, payload, home, extraEnv) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      BEEZI_CURSOR_HOME: home,
      BEEZI_API_URL: 'http://127.0.0.1:9/api',
      ...(extraEnv == null ? {} : extraEnv),
    },
  });
  assert.equal(result.error, undefined, `${script}: ${result.error?.message}`);
  // A hook that exits non-zero is reported by Cursor as a failed hook, whatever it managed to write.
  assert.equal(result.status, 0, `${script} exited ${result.status}: ${result.stderr}`);
  return result;
}

function readLines(conversationId) {
  return fs
    .readFileSync(eventsFileFor(conversationId), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('the stop hook records the turn boundary in the sidecar', (t) => {
  const home = tmpHome(t);
  runHook(SCRIPTS.stop, { conversation_id: 'conv-stop', cwd: home }, home);
  const lines = readLines('conv-stop');
  assert.deepEqual(lines.map((l) => l.ev), ['stop']);
  // Stamped by the writer, exactly as it is for every other event kind — an unstamped line is
  // invisible to the timeline, which drops events it cannot place.
  assert.equal(typeof lines[0].ts, 'number');
});

test('the sessionEnd hook records the closing boundary in the sidecar', (t) => {
  const home = tmpHome(t);
  runHook(SCRIPTS.sessionEnd, { conversation_id: 'conv-end', cwd: home }, home);
  const lines = readLines('conv-end');
  assert.deepEqual(lines.map((l) => l.ev), ['session_end']);
  assert.equal(typeof lines[0].ts, 'number');
});

test('the boundary a stop hook writes makes the gap that follows waiting_user', (t) => {
  const home = tmpHome(t);
  const id = 'conv-timeline';
  const start = Date.now() - 120_000;
  appendEvent(id, { ts: start, ev: 'gen', model: 'claude-4.5-sonnet' });
  appendEvent(id, { ts: start + 30_000, ev: 'tool', tool: 'read_file', bytes: 4210, ms: 120 });

  runHook(SCRIPTS.stop, { conversation_id: id, cwd: home }, home);

  const boundary = readEvents(id).find((event) => event.ev === 'stop');
  assert.ok(boundary, 'the stop hook wrote no turn boundary');

  // The user reads the answer and replies: the next turn's first generation, a minute later.
  appendEvent(id, { ts: boundary.ts + 60_000, ev: 'gen', model: 'claude-4.5-sonnet' });

  const timeline = computeSessionTimeline(id);
  assert.deepEqual(timeline.periods.map((p) => p.state), ['working', 'waiting_user']);
  assert.equal(timeline.periods[1].started_at, new Date(boundary.ts).toISOString());
  assert.equal(timeline.periods[1].ended_at, new Date(boundary.ts + 60_000).toISOString());
});

test('the closing boundary is recorded, but the session span ends at the last turn, not at it', (t) => {
  // This used to assert the opposite: that `session_end` stretched `ended_at` past the last tool
  // call. It did, and on a real CLI session that was the bug — sessionEnd fires whenever the user
  // gets round to closing the CLI, so the timeline ENDED on a "User input" band from the last stop
  // to the shutdown, and the axis ran on past the last drawn period. The worry the old assertion
  // answered (a final turn that touched no tool looking like it ended early) is answered by that
  // turn's own `stop` line now, which IS an anchor.
  const home = tmpHome(t);
  const id = 'conv-span';
  const start = Date.now() - 60_000;
  appendEvent(id, { ts: start, ev: 'gen', model: 'claude-4.5-sonnet' });
  appendEvent(id, { ts: start + 10_000, ev: 'tool', tool: 'read_file', bytes: 100, ms: 5 });
  appendEvent(id, { ts: start + 20_000, ev: 'stop' });

  runHook(SCRIPTS.sessionEnd, { conversation_id: id, cwd: home }, home);

  const boundary = readEvents(id).find((event) => event.ev === 'session_end');
  assert.ok(boundary, 'the sessionEnd hook wrote no closing boundary');
  const timeline = computeSessionTimeline(id);
  assert.equal(timeline.ended_at, new Date(start + 20_000).toISOString());
  // …and no trailing wait is drawn from the last stop to the shutdown.
  assert.deepEqual(timeline.periods.map((p) => p.state), ['working']);
});

// ── the stop hook's account check (plan §4 Phase C) ─────────────────────────────────────────────
//
// The decision logic is unit-tested in test/stop-account-change.test.mjs, which can move the hook
// budget and inject a transport. What can only be proved by running the script the way Cursor runs
// it is the part that actually threatens the user: that reading Cursor's own database on every stop
// cannot cost them the turn boundary or the checkpoint. Both of the hostile host states below are
// real — a `cursor-agent`-only machine has no IDE globalStorage at all, and a state.vscdb caught
// mid-write is not a database.
//
// `globalStorageDir()` is relocatable through APPDATA on Windows and XDG_CONFIG_HOME elsewhere;
// macOS resolves under ~/Library with no override, where the directory simply does not exist on a
// machine without Cursor — the same ENOENT, by a different route.
function hostEnv(dir) {
  return { APPDATA: dir, XDG_CONFIG_HOME: dir };
}

test('the stop hook completes when Cursor has no globalStorage at all', (t) => {
  const home = tmpHome(t);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-no-cursor-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));

  runHook(SCRIPTS.stop, { conversation_id: 'conv-no-host', cwd: home }, home, hostEnv(empty));

  // The boundary is written BEFORE the account check and the checkpoint runs after it, so its
  // presence is the proof that the account read neither threw out of the handler nor exited early.
  assert.deepEqual(readLines('conv-no-host').map((l) => l.ev), ['stop']);
  // Nothing was observed, so nothing may have been written about a plan.
  assert.equal(fs.existsSync(path.join(home, 'billing.json')), false);
});

test('the stop hook completes when state.vscdb is not a database', (t) => {
  const home = tmpHome(t);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-broken-vscdb-'));
  t.after(() => fs.rmSync(broken, { recursive: true, force: true }));
  const storage = path.join(broken, 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'state.vscdb'), 'not a sqlite file at all');

  // The live payload carries `user_email`, and this is the one place it reaches the real script.
  runHook(
    SCRIPTS.stop,
    { conversation_id: 'conv-broken-host', cwd: home, user_email: 'intruder@example.net' },
    home,
    hostEnv(broken),
  );

  assert.deepEqual(readLines('conv-broken-host').map((l) => l.ev), ['stop']);
  // The refusal in lib/hook-input-cursor.mjs covers the normalizer; this covers the whole process.
  // Nothing the stop hook writes may carry the address the host put on the payload.
  const walk = (dir, out) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };
  for (const file of walk(home, [])) {
    assert.equal(
      fs.readFileSync(file, 'utf-8').includes('example.net'), false,
      `${file} carries the payload email`,
    );
  }
});

test('a payload with no conversation id writes no boundary', (t) => {
  const home = tmpHome(t);
  // conversation_id is the session identity; without one there is no stream to append to, and the
  // hook must exit before it invents a filename.
  runHook(SCRIPTS.stop, { cwd: home }, home);
  assert.equal(fs.existsSync(path.join(home, 'events')), false);
});
