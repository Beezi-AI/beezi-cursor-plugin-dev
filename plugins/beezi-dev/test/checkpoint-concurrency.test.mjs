import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';

// Cursor fires `afterShellExecution`, `stop` and `sessionEnd` as SEPARATE OS PROCESSES that land
// together at a turn boundary, and every one of them runs a checkpoint. `loadState` → … →
// `saveState` is a read-modify-write with awaits in the middle, so unguarded they interleave:
//
//   1. Both read `cursor = 0`. A enqueues `conv-1:0-4`, B enqueues `conv-1:0-6`. Different
//      segmentIds, so the server's idempotency key — which IS the segmentId — cannot collapse them.
//      Lines 0-4 are billed twice, and no later pass notices.
//   2. `state.usageSnapshot` is the cumulative-credits baseline and the last writer wins. A stale
//      write rewinds it and the next checkpoint re-bills the difference — a figure checkpoint.mjs
//      says "can never be recovered, usageData is cumulative, so the increment is gone".
//
// Every other checkpoint test in this suite is await-serialized, so none of them could ever have
// caught this. These are the only overlapping runs in the suite, which is why they are in a file of
// their own rather than appended to checkpoint.test.mjs.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-concurrency-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeGit(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return 'feature/task-42';
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function delta(overrides = {}) {
  return {
    conversationId: 'conv-1',
    segmentId: 'conv-1:0-4',
    from: 0,
    to: 4,
    nextCursor: 4,
    repoRoot: '/repo',
    branch: 'feature/task-42',
    entries: [{ model: 'm', billing_pool: 'subscription', requests: 1, cost_usd: 0 }],
    rateLimitEvents: [],
    operations: {},
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    duration_ms: 1000,
    usage_snapshot: { m: { amount: 1, costInCents: 10 } },
    diagnostics: { schemaMiss: false },
    ...overrides,
  };
}

const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

const queued = () => {
  let files;
  try { files = fs.readdirSync(queueDir()); } catch { return []; }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));
};

const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));

// A sidecar with two timestamped events, which is the minimum `computeSessionTimeline` needs to
// produce a period. It exists so the `emitTimeline` POST below actually happens.
function writeSidecar(home) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: 1700000000000, ev: 'gen', model: 'm' }),
      JSON.stringify({ ts: 1700000001000, ev: 'stop' }),
    ].join('\n') + '\n',
  );
}

// The only way two `runCheckpoint` calls can genuinely overlap is for one of them to be parked on an
// `await` INSIDE the guarded section — JavaScript is single-threaded, so without one the second call
// simply runs to completion after the first. The session-timeline POST is that await: it is inside
// the lock (it writes `state.sentTimelineSig`), it goes through the injected `fetchImpl`, and it
// happens AFTER the segment has been enqueued, which is precisely the window where a second process
// would read the not-yet-saved cursor.
//
// Call 1 parks at the gate. Every later call throws, standing in for "no network in this test" —
// which also means the queue file stays on disk for the assertions.
function gatedFetch() {
  let arrived;
  const atGate = new Promise((resolve) => { arrived = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      arrived();
      await gate;
      return { status: 200, json: async () => ({}) };
    }
    throw new Error('network disabled in test');
  };
  return { fetchImpl, atGate, open: () => release() };
}

test('two overlapping checkpoints enqueue one segment, not two', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const gate = gatedFetch();

  const runA = runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: gate.fetchImpl, computeDelta: () => delta() }),
    { emitTimeline: true },
  );
  await gate.atGate; // A holds the lock, has enqueued 0-4, and has not yet saved state.

  // B is the second hook process. Unguarded it would read `cursor = 0` — A has not written it yet —
  // and enqueue `conv-1:0-6`, a segmentId the server cannot dedupe against `conv-1:0-4`.
  let bDeltaCalls = 0;
  const b = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: () => {
        bDeltaCalls += 1;
        return delta({ to: 6, nextCursor: 6, segmentId: 'conv-1:0-6', usage_snapshot: { m: { amount: 9, costInCents: 90 } } });
      },
    }),
  );

  gate.open();
  const a = await runA;

  assert.equal(bDeltaCalls, 0, 'the loser must not do the guarded work at all, not even parse');
  assert.equal(b.enqueued, 0);
  assert.equal(a.enqueued, 1);
  assert.deepEqual(queued().map((p) => p.segmentId), ['conv-1:0-4'], 'lines 0-4 would have been billed twice');
});

test('a contended checkpoint advances the cursor once and keeps the winner\'s usage baseline', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const gate = gatedFetch();

  const runA = runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: gate.fetchImpl, computeDelta: () => delta() }),
    { emitTimeline: true },
  );
  await gate.atGate;

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ to: 6, nextCursor: 6, segmentId: 'conv-1:0-6', usage_snapshot: { m: { amount: 9, costInCents: 90 } } }) }),
  );

  gate.open();
  await runA;

  assert.equal(stateOf('conv-1').cursor, 4, 'one advance, over the window that was actually reported');
  // The rewind is the expensive half: usageData is cumulative, so a baseline that goes backwards
  // makes the next checkpoint re-report the whole difference as fresh credit spend.
  assert.deepEqual(stateOf('conv-1').usageSnapshot, { m: { amount: 1, costInCents: 10 } });
});

test('the loser still drains the queue — the backlog is machine-wide, the contention was not', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const gate = gatedFetch();

  const runA = runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: gate.fetchImpl, computeDelta: () => delta() }),
    { emitTimeline: true },
  );
  await gate.atGate;

  // Holding a per-session lock across `flushQueue` would serialize every hook on the machine behind
  // one slow POST, so the flush is deliberately outside it — including for the hook that lost.
  let posts = 0;
  const b = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: () => delta(),
      fetchImpl: async () => { posts += 1; throw new Error('network disabled in test'); },
    }),
  );

  gate.open();
  await runA;

  assert.notEqual(b.flush, null, 'a contended run must still report a flush summary');
  assert.equal(posts, 1, 'the queued segment A wrote should have been attempted by B');
});

test('the lock is released when the checkpoint finishes, so the next hook is not blocked', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  assert.equal(stateOf('conv-1').cursor, 4);

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ from: 4, to: 8, nextCursor: 8, segmentId: 'conv-1:4-8' }) }),
  );
  assert.equal(stateOf('conv-1').cursor, 8, 'a stranded lock would freeze this conversation for 30s');
  assert.deepEqual(fs.readdirSync(stateDir()), ['conv-1.json'], 'no lock directory left behind');
});

test('a throwing delta releases the lock instead of stranding it', async (t) => {
  tmpHome(t);

  // `withLock` releases in `finally`, and the abandonment paths inside the guarded section return a
  // sentinel rather than throwing — either way the next checkpoint must not find a held lock. A
  // stranded lock is invisible: it looks exactly like a live holder for LOCK_STALE_MS, so every
  // hook in the next 30 seconds silently does nothing.
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => { throw new Error('sidecar unreadable'); } }),
  );
  assert.deepEqual(
    res,
    { enqueued: 0, flush: null, sessionErrors: [], deltaFailed: true },
    'an abandoned checkpoint skips the flush, as before',
  );

  const after = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
  );
  assert.equal(after.enqueued, 1);
  assert.equal(stateOf('conv-1').cursor, 4);
});

test('two different conversations never wait on each other', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const gate = gatedFetch();

  // A machine-wide lock would make a hook in repo A and a hook in repo B serialize against each
  // other — and under SKIP semantics that is not a wait, it is a dropped checkpoint for a session
  // that had no conflict at all. lib/lock.mjs keys the lock per session for exactly this reason.
  const runA = runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: gate.fetchImpl, computeDelta: () => delta() }),
    { emitTimeline: true },
  );
  await gate.atGate;

  const other = await runCheckpoint(
    { session_id: 'conv-2', cwd: '/repo' },
    deps({ computeDelta: () => delta({ conversationId: 'conv-2', segmentId: 'conv-2:0-4' }) }),
  );

  gate.open();
  await runA;

  assert.equal(other.enqueued, 1, 'an unrelated conversation must not be skipped');
  assert.equal(stateOf('conv-2').cursor, 4);
});
