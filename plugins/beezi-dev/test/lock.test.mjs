import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock, withHeldLock, sessionLockPath, LOCK_STALE_MS } from '../lib/lock.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-lock-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

function tmpHome(t) {
  const dir = tmpDir(t);
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
  });
  return dir;
}

// ─── acquisition ────────────────────────────────────────────────────────────

test('runs the callback and returns its value while holding the lock', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');

  const result = await withLock(lock, () => {
    assert.equal(fs.existsSync(lock), true, 'lock must be held during the callback');
    return 'value';
  });

  assert.equal(result, 'value');
});

test('releases on the happy path — no lock file is left behind', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');

  await withLock(lock, () => 'ok');

  assert.equal(fs.existsSync(lock), false, 'a leftover lock would make the next hook a miss');
});

test('awaits an async callback before releasing', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  let heldAtResolve = null;

  const result = await withLock(lock, async () => {
    await new Promise((r) => setImmediate(r));
    heldAtResolve = fs.existsSync(lock);
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(heldAtResolve, true, 'a bare `return fn()` would have released before the await');
  assert.equal(fs.existsSync(lock), false);
});

// ─── contention ─────────────────────────────────────────────────────────────

test('contention returns the miss value and does not run the callback', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  fs.mkdirSync(lock, { recursive: true }); // another hook process holds it
  let ran = false;

  const result = await withLock(lock, () => { ran = true; return 'ran'; }, { miss: 'skipped' });

  assert.equal(result, 'skipped');
  assert.equal(ran, false);
  assert.equal(fs.existsSync(lock), true, 'the loser must not remove the winner\'s lock');
});

test('contention does not sleep — it returns immediately', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  fs.mkdirSync(lock, { recursive: true });

  // token.mjs sleeps 750ms under contention; this module must not, because the sleep would be spent
  // out of the same 7500ms hook budget the checkpoint needs.
  const started = Date.now();
  await withLock(lock, () => 'ran', { miss: null });
  assert.ok(Date.now() - started < 250, 'contention must skip, not wait');
});

test('miss value defaults to undefined', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  fs.mkdirSync(lock, { recursive: true });

  assert.equal(await withLock(lock, () => 'ran'), undefined);
});

test('a second caller is locked out while the first is inside the callback', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  let inner;

  const outer = await withLock(lock, async () => {
    inner = await withLock(lock, () => 'inner ran', { miss: 'inner skipped' });
    return 'outer ran';
  });

  assert.equal(outer, 'outer ran');
  assert.equal(inner, 'inner skipped');
});

// ─── staleness ──────────────────────────────────────────────────────────────

test('a stale lock is broken after LOCK_STALE_MS', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  fs.mkdirSync(lock, { recursive: true }); // a hook that was killed mid-critical-section

  const later = Date.now() + LOCK_STALE_MS + 1_000;
  const result = await withLock(lock, () => 'broke in', { now: () => later, miss: 'skipped' });

  assert.equal(result, 'broke in');
  assert.equal(fs.existsSync(lock), false, 'and released again afterwards');
});

test('a lock younger than LOCK_STALE_MS is respected', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');
  fs.mkdirSync(lock, { recursive: true });

  // One second short of stale: Cursor kills a hook at 10s, so anything inside this window may still
  // be a live holder and must not have its lock stolen.
  const later = Date.now() + LOCK_STALE_MS - 1_000;
  const result = await withLock(lock, () => 'broke in', { now: () => later, miss: 'skipped' });

  assert.equal(result, 'skipped');
});

// ─── directory creation ─────────────────────────────────────────────────────

test('creates a missing parent directory instead of failing with ENOENT', async (t) => {
  const dir = tmpDir(t);
  // The state directory does not exist yet — the first checkpoint of a fresh install locks before
  // anything has written a state file. token.mjs lost a day of analytics to exactly this.
  const lock = path.join(dir, 'state', 'never-created', 'conv.lock');

  const result = await withLock(lock, () => 'acquired', { miss: 'skipped' });

  assert.equal(result, 'acquired');
  assert.equal(fs.existsSync(path.dirname(lock)), true);
});

// ─── release on throw ───────────────────────────────────────────────────────

test('a throwing callback still releases the lock, and the error propagates', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');

  await assert.rejects(
    () => withLock(lock, () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(fs.existsSync(lock), false, 'a stranded lock would block the next 30 seconds');

  // And the lock is immediately usable again.
  assert.equal(await withLock(lock, () => 'reacquired', { miss: 'skipped' }), 'reacquired');
});

test('a rejecting async callback also releases', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'a.lock');

  await assert.rejects(
    () => withLock(lock, async () => { throw new Error('async boom'); }),
    /async boom/,
  );
  assert.equal(fs.existsSync(lock), false);
});

// ─── path resolution ────────────────────────────────────────────────────────

test('sessionLockPath sits beside the state file it guards', (t) => {
  const home = tmpHome(t);
  assert.equal(sessionLockPath('conv-123'), path.join(home, 'state', 'conv-123.lock'));
});

test('sessionLockPath sanitises a traversal attempt out of the id', (t) => {
  const home = tmpHome(t);
  const stateDir = path.join(home, 'state');

  for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', '.']) {
    const p = sessionLockPath(hostile);
    // This path is handed to a recursive rmSync, so it must resolve to a single entry directly
    // inside state/ no matter what the hook payload said.
    assert.equal(path.dirname(path.resolve(p)), path.resolve(stateDir), hostile);
    assert.ok(!/[\\/]/.test(path.basename(p)), `separator survived: ${p}`);
  }
});

test('sessionLockPath returns null for an unusable id', (t) => {
  tmpHome(t);
  assert.equal(sessionLockPath(''), null);
  assert.equal(sessionLockPath(null), null);
  assert.equal(sessionLockPath(42), null);
});

test('a null lock path never runs the guarded work unguarded', async () => {
  let ran = false;
  const result = await withLock(null, () => { ran = true; return 'ran'; }, { miss: 'skipped' });
  assert.equal(result, 'skipped');
  assert.equal(ran, false);
});

// ─── withHeldLock: long-held sections (08-B) ────────────────────────────────
//
// `withLock` is built for a hook: take it, do millisecond work, drop it, and let the NEXT caller
// break a lock older than 30 s because Cursor has already killed any hook that old. The repeatable
// sync breaks both halves of that: its guarded section spans a 60 s coverage query, a full parse
// and a 60 s upload with its own retry and bisection, so
//
//   1. a live hook legitimately steals the lock at 30 s and enqueues an overlapping window — the
//      exact double-billing the lock exists to prevent, and
//   2. sync's own `finally` then deletes the hook's lock, because release was ownership-blind.
//
// `withHeldLock` adds the two things a minutes-long section needs: a heartbeat that keeps the lock
// visibly alive, and an owner token so a release only ever removes its own lock.

const ageLock = (lock) => {
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
  fs.utimesSync(lock, old, old);
};

test('CONTROL: an un-renewed held lock older than LOCK_STALE_MS is stolen by a hook', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');
  let stolen = null;

  await withHeldLock(lock, async () => {
    ageLock(lock);
    stolen = await withLock(lock, () => 'stolen', { miss: 'missed' });
  }, { renewMs: 0 });

  // This is the bug the heartbeat exists to remove: a long section is indistinguishable from a
  // dead one, so a live hook takes the lock and enqueues an overlapping window.
  assert.equal(stolen, 'stolen');
});

test('a renewed lock is not stolen once it is older than LOCK_STALE_MS', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');
  let stolen = null;

  await withHeldLock(lock, async (held) => {
    ageLock(lock);
    // The heartbeat: what a long section does on an interval.
    assert.equal(held.renew(), true);
    stolen = await withLock(lock, () => 'stolen', { miss: 'missed' });
  }, { renewMs: 0 });

  assert.equal(stolen, 'missed', 'a renewed lock must not be stolen');
});

test('release never removes a lock it does not own', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');

  await withHeldLock(lock, async () => {
    // Someone else broke and re-took the lock while we were working — their token is in it now.
    fs.writeFileSync(path.join(lock, 'owner'), 'somebody-else', 'utf-8');
  }, { renewMs: 0 });

  assert.equal(fs.existsSync(lock), true, "sync's finally deleted another holder's lock");
  assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf-8'), 'somebody-else');
});

test('a held lock that was taken from us reports itself lost', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');
  const seen = [];

  await withHeldLock(lock, async (held) => {
    seen.push(held.stillHeld());
    fs.writeFileSync(path.join(lock, 'owner'), 'somebody-else', 'utf-8');
    seen.push(held.stillHeld());
  }, { renewMs: 0 });

  assert.deepEqual(seen, [true, false]);
});

test('a vanished lock also reports itself lost', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');

  await withHeldLock(lock, async (held) => {
    fs.rmSync(lock, { recursive: true, force: true });
    assert.equal(held.stillHeld(), false);
    assert.equal(held.renew(), false);
  }, { renewMs: 0 });
});

test('withHeldLock releases its own lock on the happy path and on a throw', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');

  await withHeldLock(lock, async () => 'done', { renewMs: 0 });
  assert.equal(fs.existsSync(lock), false);

  await assert.rejects(() => withHeldLock(lock, async () => { throw new Error('boom'); }, { renewMs: 0 }), /boom/);
  assert.equal(fs.existsSync(lock), false);
});

test('withHeldLock contends with a plain withLock in both directions', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');

  const heldOut = await withHeldLock(lock, async () => {
    return withLock(lock, () => 'inner', { miss: 'missed' });
  }, { renewMs: 0 });
  assert.equal(heldOut, 'missed');

  const plainOut = await withLock(lock, async () => {
    return withHeldLock(lock, async () => 'inner', { miss: 'missed', renewMs: 0 });
  });
  assert.equal(plainOut, 'missed');
});

test('withHeldLock returns the miss value rather than racing, and never runs the work', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');
  fs.mkdirSync(lock);
  let ran = false;

  const out = await withHeldLock(lock, async () => { ran = true; }, { miss: 'missed', renewMs: 0 });

  assert.equal(out, 'missed');
  assert.equal(ran, false);
});

test('a heartbeat keeps the lock alive without the callback doing anything', async (t) => {
  const dir = tmpDir(t);
  const lock = path.join(dir, 'held.lock');

  const stolen = await withHeldLock(lock, async () => {
    ageLock(lock);
    // Let the interval fire at least once.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return withLock(lock, () => 'stolen', { miss: 'missed' });
  }, { renewMs: 5 });

  assert.equal(stolen, 'missed');
});

test('an unusable lock path runs nothing, exactly like withLock', async () => {
  let ran = false;
  const out = await withHeldLock(null, async () => { ran = true; }, { miss: 'missed', renewMs: 0 });

  assert.equal(out, 'missed');
  assert.equal(ran, false);
});
