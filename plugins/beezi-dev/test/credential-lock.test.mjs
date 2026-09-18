import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lockOwner,
  ownerIsLive,
  withCredentialLock,
  readLockOwner,
  LOCK_ORPHAN_MS,
  RECLAIM_SETTLE_MS,
} from '../lib/credential-lock.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

// A REAL sleep. Every reclaim test used `sleep: async () => {}`, which collapses the settle window
// into a single tick — so the mechanism that is supposed to make reclaiming safe was never actually
// exercised by the suite that certified it.
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credlock-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const lockDir = (home) => path.join(home, 'credentials.lock');

// Plant a lock as though another process holds it.
function plant(home, owner, { at = Date.now() } = {}) {
  const dir = lockDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ owner, acquiredAt: at }), 'utf-8');
  fs.utimesSync(dir, new Date(at), new Date(at));
}

const foreign = (over = {}) => ({ pid: 999_999, processStartTime: 1, nonce: 'foreign', ...over });

test('the owner identifies this process by pid, start time and a nonce', () => {
  const owner = lockOwner();
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.processStartTime, 'number');
  assert.ok(owner.processStartTime > 0);
  assert.match(owner.nonce, /^[A-Za-z0-9_-]{10,}$/);
  assert.deepEqual(lockOwner(), owner, 'stable for the life of the process');
});

test('a live owner is never reclaimed, however old its timestamp', async (t) => {
  const home = tmpHome(t);
  plant(home, foreign(), { at: Date.now() - LOCK_ORPHAN_MS * 10 });

  const result = await withCredentialLock(
    () => 'ran',
    { waitMs: 30, kill: () => {}, sleep: async () => {} },
  );
  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.equal(readLockOwner(lockDir(home)).owner.nonce, 'foreign', 'the live holder still owns it');
});

// A pid is only 15 bits of namespace on some hosts and wraps quickly under load, so "the number
// answers signal 0" is not on its own evidence that the process that took the lock is still there.
test('a recycled pid is not mistaken for the process that took the lock', async (t) => {
  const home = tmpHome(t);
  // This process's own pid, but stamped with a start time that is not this process's: whatever is
  // answering to that number now, it is not the holder.
  plant(home, foreign({ pid: process.pid, processStartTime: 1 }), { at: Date.now() - RECLAIM_SETTLE_MS * 3 });
  assert.equal(
    await withCredentialLock(() => 'ran', { waitMs: RECLAIM_SETTLE_MS * 6, sleep: realSleep }),
    'ran',
  );
});

// A handle kept past the end of its critical section must not readmit anyone.
test('a retained handle cannot grant an unlocked critical section', async (t) => {
  tmpHome(t);
  let escaped = null;
  await withCredentialLock((handle) => { escaped = handle; }, { waitMs: 200, sleep: realSleep });
  assert.equal(escaped.held, false, 'the lease is marked spent when the section ends');

  let ran = false;
  const result = await withCredentialLock(() => { ran = true; }, { waitMs: 50, sleep: realSleep, lock: escaped });
  // Not re-entered: it went through normal acquisition, which succeeds because the lock is free.
  assert.equal(ran, true);
  assert.equal(result, undefined);
});

test('ownerIsLive treats EPERM as alive and ESRCH as dead', () => {
  const eperm = () => { const e = new Error('x'); e.code = 'EPERM'; throw e; };
  const esrch = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };
  assert.equal(ownerIsLive(foreign(), { kill: eperm }), true);
  assert.equal(ownerIsLive(foreign(), { kill: esrch }), false);
  assert.equal(ownerIsLive(foreign(), { kill: () => {} }), true);
  assert.equal(ownerIsLive(null, { kill: () => {} }), false);
  assert.equal(ownerIsLive({ pid: 'nope' }, { kill: () => {} }), false);
});

test('a dead owner is reclaimed and the critical section runs', async (t) => {
  const home = tmpHome(t);
  // Older than the settle window, so the directory itself has had time to look abandoned.
  plant(home, foreign(), { at: Date.now() - RECLAIM_SETTLE_MS * 3 });
  const esrch = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };

  let ran = false;
  const result = await withCredentialLock(
    () => { ran = true; return 'value'; },
    { waitMs: RECLAIM_SETTLE_MS * 6, kill: esrch, sleep: realSleep },
  );
  assert.equal(ran, true);
  assert.equal(result, 'value');
  assert.equal(fs.existsSync(lockDir(home)), false, 'released on the way out');
});

// The window is the point. A directory that only JUST appeared is not reclaimable however dead its
// owner record looks — that is exactly the stale-read case that let two processes in at once.
test('a freshly created lock directory is never reclaimed, even with a dead-looking owner', async (t) => {
  const home = tmpHome(t);
  plant(home, foreign(), { at: Date.now() });
  const esrch = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };

  const result = await withCredentialLock(
    () => 'ran',
    { waitMs: 150, kill: esrch, sleep: realSleep },
  );
  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.equal(readLockOwner(lockDir(home)).owner.nonce, 'foreign', 'the young lock survived');
});

// A reclaim in flight is abandoned when the directory is replaced under it: the observation that
// started against the dead holder says nothing about the live racer now holding the lock. This is
// the exact shape that let two processes into the section — B removing A's fresh lock.
test('a lock directory replaced mid-observation is not reclaimed by the observer', async (t) => {
  const home = tmpHome(t);
  plant(home, foreign(), { at: Date.now() - RECLAIM_SETTLE_MS * 3 });
  // Says every owner is dead, so ONLY the directory-identity rule can save the racer's lock.
  const esrch = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };

  const replace = setTimeout(() => {
    fs.rmSync(lockDir(home), { recursive: true, force: true });
    plant(home, foreign({ nonce: 'winner' }), { at: Date.now() });
  }, Math.floor(RECLAIM_SETTLE_MS / 2));
  t.after(() => clearTimeout(replace));

  // Budgeted to expire while the racer's lock is still inside its own settle window. Given longer,
  // a lock whose owner really is dead SHOULD eventually be reclaimed — that is the recovery path,
  // not a bug — so the assertion is about the window, not about never reclaiming.
  const result = await withCredentialLock(
    () => 'ran',
    { waitMs: Math.floor(RECLAIM_SETTLE_MS * 1.4), kill: esrch, sleep: realSleep },
  );
  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.equal(readLockOwner(lockDir(home)).owner.nonce, 'winner', "the racer's lock was not stolen");
});

test('an ownerless lock directory is only reclaimed after the orphan grace', async (t) => {
  const home = tmpHome(t);
  // No owner.json: a holder that has created the directory but not yet described itself.
  fs.mkdirSync(lockDir(home), { recursive: true });

  const tooSoon = await withCredentialLock(() => 'ran', { waitMs: 20, sleep: realSleep });
  assert.deepEqual(tooSoon, { ok: false, reason: 'locked' });

  const old = Date.now() - LOCK_ORPHAN_MS - 1000;
  fs.utimesSync(lockDir(home), new Date(old), new Date(old));
  assert.equal(
    await withCredentialLock(() => 'ran', { waitMs: RECLAIM_SETTLE_MS * 6, sleep: realSleep }),
    'ran',
  );
});

test('the critical section can verify it still owns the lock, and notices a steal', async (t) => {
  tmpHome(t);
  const seen = [];
  await withCredentialLock(
    (handle) => {
      seen.push(handle.verify());
      // Someone reclaimed it behind our back — a fenced writer must refuse to commit.
      fs.writeFileSync(
        path.join(handle.dir, 'owner.json'),
        JSON.stringify({ owner: foreign(), acquiredAt: Date.now() }),
        'utf-8',
      );
      seen.push(handle.verify());
    },
    { waitMs: 200, sleep: async () => {} },
  );
  assert.deepEqual(seen, [true, false]);
});

test('a stolen lock is not deleted by the process that lost it', async (t) => {
  const home = tmpHome(t);
  await withCredentialLock(
    (handle) => {
      fs.writeFileSync(
        path.join(handle.dir, 'owner.json'),
        JSON.stringify({ owner: foreign(), acquiredAt: Date.now() }),
        'utf-8',
      );
    },
    { waitMs: 200, sleep: async () => {} },
  );
  assert.equal(fs.existsSync(lockDir(home)), true, 'the new owner keeps its lock');
  assert.equal(readLockOwner().owner.nonce, 'foreign');
});

test('a throwing critical section still releases the lock', async (t) => {
  const home = tmpHome(t);
  await assert.rejects(
    withCredentialLock(() => { throw new Error('boom'); }, { waitMs: 200, sleep: async () => {} }),
    /boom/,
  );
  assert.equal(fs.existsSync(lockDir(home)), false);
});

// Re-entrancy is granted by PASSING THE HANDLE. A nested helper that also locks gets the caller's
// lease and runs inside the same critical section.
test('a nested call that is handed the lease re-enters instead of deadlocking', async (t) => {
  tmpHome(t);
  const inner = await withCredentialLock(
    (handle) => withCredentialLock(() => 'inner', { waitMs: 50, sleep: async () => {}, lock: handle }),
    { waitMs: 200, sleep: async () => {} },
  );
  assert.equal(inner, 'inner');
});

test('a nested call WITHOUT the lease is not re-entrant — it queues', async (t) => {
  tmpHome(t);
  const order = [];
  // The queued inner call has nothing pending but the unref'd wait timer at
  // lib/credential-lock.mjs:202 — see test/helpers/loop-alive.mjs. Its 20ms wait is unchanged and
  // still has to expire on its own for `{ ok: false, reason: 'locked' }` to be the answer.
  const result = await withLoopAlive(() => withCredentialLock(
    async () => {
      order.push('outer-in');
      // No `lock`, so this is an ordinary caller as far as the lock is concerned: it cannot get in
      // while the outer section holds the directory, and with a short wait it reports that.
      const nested = await withCredentialLock(() => { order.push('inner'); }, { waitMs: 20, sleep: async () => {} });
      order.push('outer-out');
      return nested;
    },
    { waitMs: 200, sleep: async () => {} },
  ));
  assert.deepEqual(result, { ok: false, reason: 'locked' });
  assert.deepEqual(order, ['outer-in', 'outer-out'], 'the nested body never ran');
});

// The regression the depth counter could not catch. Two UNRELATED callers, staggered so the second
// arrives while the first is mid-section — which is precisely the long-lived MCP bridge's shape.
// Under the counter, the second was mistaken for a nested call and let straight in.
test('an unrelated caller arriving mid-section waits; two sections never overlap', async (t) => {
  tmpHome(t);
  let inside = 0;
  let maxConcurrent = 0;
  const section = async () => {
    inside += 1;
    maxConcurrent = Math.max(maxConcurrent, inside);
    await new Promise((r) => setTimeout(r, 80));
    inside -= 1;
    return 'done';
  };

  const first = withCredentialLock(section, { waitMs: 5000, sleep: async () => {} });
  // 40ms later, not the same tick: a fresh call stack with no relationship to the first.
  await new Promise((r) => setTimeout(r, 40));
  const second = withCredentialLock(section, { waitMs: 5000, sleep: async () => {} });

  assert.deepEqual(await Promise.all([first, second]), ['done', 'done']);
  assert.equal(maxConcurrent, 1, 'two critical sections ran at once');
});

test('two in-process callers are serialized, not run concurrently', async (t) => {
  tmpHome(t);
  const order = [];
  const slow = withCredentialLock(
    async () => { order.push('a-in'); await new Promise((r) => setTimeout(r, 30)); order.push('a-out'); },
    { waitMs: 2000, sleep: async () => {} },
  );
  const fast = withCredentialLock(() => { order.push('b'); }, { waitMs: 2000, sleep: async () => {} });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-in', 'a-out', 'b']);
});
