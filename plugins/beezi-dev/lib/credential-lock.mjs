import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { removeSync } from './fs-compat.mjs';
import { base64url } from './base64url.mjs';

// The one mutation lock for this machine's credential store.
//
// It replaces the age-only mkdir lock in lib/token.mjs, which only refresh ever took. Login, logout
// and refresh all mutate the same store, and the old scheme could not tell "the holder crashed"
// from "the holder is slow": anything older than 30s was broken open, so a Windows keyring write
// that outran the timer had its lock stolen mid-write. Worse, nothing ever checked afterwards
// whether the lock was still the caller's, so the loser of a reclaim race went on to publish.
//
// Three things are different here:
//   - the holder DESCRIBES itself ({pid, processStartTime, nonce}), so liveness is a question that
//     can be asked rather than inferred from a timestamp;
//   - a verified-live holder is never reclaimed, whatever its age;
//   - the holder can re-verify ownership immediately before it publishes or deletes, so a caller
//     that did lose a reclaim race refuses to commit instead of racing the winner.

// How long an ownerless lock directory (created, but never described — a process killed between the
// mkdir and the owner write) may sit before the next caller reclaims it. It is the only age-based
// rule left, and it applies solely to a lock with no identifiable owner.
export const LOCK_ORPHAN_MS = 30_000;

const POLL_MS = 25;

// This process's start instant, resolved once. `process.uptime()` is seconds of wall time since the
// process started, so this is stable for the life of the process to within its own measurement —
// which is all pid-reuse detection needs: a recycled pid belongs to a process that started later.
const PROCESS_START_TIME = Math.round(Date.now() - process.uptime() * 1000);

// One nonce per process, minted lazily. Two runs that somehow shared a pid AND a start time still
// differ here, and it is what `verify()` compares so a reclaimed-then-recovered lock is not
// mistaken for the one this process took.
let ownerNonce = null;

export function lockOwner() {
  if (ownerNonce === null) ownerNonce = base64url(crypto.randomBytes(9));
  return { pid: process.pid, processStartTime: PROCESS_START_TIME, nonce: ownerNonce };
}

export function lockDirFor(home) {
  return path.join(home == null ? beeziCursorHome() : home, 'credentials.lock');
}

const ownerFile = (dir) => path.join(dir, 'owner.json');

// The lock's current record, or `{ owner: null }` when there is none to read. Never throws: an
// unreadable record is indistinguishable from an absent one for every decision below.
export function readLockOwner(dir = lockDirFor()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile(dir), 'utf-8'));
    if (parsed == null || typeof parsed !== 'object' || parsed.owner == null) return { owner: null };
    return { owner: parsed.owner, acquiredAt: parsed.acquiredAt };
  } catch {
    return { owner: null };
  }
}

// Is the process described by `owner` still running?
//
// Signal 0 does not deliver anything — it only asks the kernel whether the pid exists and whether
// we may signal it. EPERM therefore means the process is ALIVE and owned by someone else, and
// reading it as "gone" (which a bare catch does) is precisely the misread that reclaims a live
// owner's lock. Only ESRCH is evidence of death.
export function ownerIsLive(owner, deps = {}) {
  const kill = deps.kill == null ? ((pid, sig) => process.kill(pid, sig)) : deps.kill;
  if (owner == null || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  // Our own pid with a different start time is a RECYCLED pid: that process is gone even though the
  // number is live. (Our own pid with our own start time is handled by the re-entrancy guard.)
  if (owner.pid === process.pid && typeof owner.processStartTime === 'number'
    && owner.processStartTime !== PROCESS_START_TIME) {
    return false;
  }
  try {
    kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}

function writeOwner(dir, owner, now) {
  // Written straight rather than through a temp+rename: the directory IS the lock, so a reader that
  // catches this file half-written sees `{ owner: null }` and falls back to the orphan grace, which
  // is the conservative branch. A rename here would need its own temp in the same directory anyway.
  fs.writeFileSync(ownerFile(dir), JSON.stringify({ owner, acquiredAt: now() }), 'utf-8');
}

function dirAgeMs(dir, now) {
  try { return now() - fs.statSync(dir).mtimeMs; } catch { return 0; }
}

// How long a lock directory must have been UNTOUCHED, on top of looking dead, before it is
// reclaimed. Reclaiming on the content of `owner.json` alone is not safe: after a holder exits and
// its directory is removed and recreated by a reclaimer, another process can still read the
// DEPARTED holder's record from that path, and "two observations 25ms apart" is no bound at all on
// how long a filesystem or attribute cache may serve it.
//
// So the rule keys on the DIRECTORY, not on the file inside it. A live holder's directory was
// created when it took the lock; a reclaimer's brand-new directory likewise. Requiring the same
// directory identity (birth/change time) across an observation window that is long relative to any
// plausible cache means a directory a live process just created cannot qualify, whatever a stale
// `owner.json` says about it.
export const RECLAIM_SETTLE_MS = 1000;

function dirIdentity(dir) {
  try {
    const st = fs.statSync(dir);
    // birthtimeMs is not reliable on every filesystem; ctimeMs moves on any metadata change, and
    // together they are enough to tell "the same directory" from "a new one in its place".
    return `${st.birthtimeMs || 0}:${st.ctimeMs || 0}:${st.ino || 0}`;
  } catch {
    return null;
  }
}

async function confirmDead(dir, record, now, kill, sleep) {
  const firstOwner = record.owner;
  const firstIdentity = dirIdentity(dir);
  if (firstIdentity == null) return false;
  // Age is checked against the directory, which only a real holder or reclaimer creates. Guarded:
  // the directory can vanish between the two calls, and an exception here would escape
  // acquireAndRun and withCredentialLock — outside every caller's try/catch — and reject at the
  // caller. A lock that is already gone is simply not ours to reclaim.
  let age;
  try { age = now() - fs.statSync(dir).mtimeMs; } catch { return false; }
  if (age < RECLAIM_SETTLE_MS) return false;

  await sleep(RECLAIM_SETTLE_MS);

  if (dirIdentity(dir) !== firstIdentity) return false; // somebody replaced it: not ours to reclaim
  const again = readLockOwner(dir);
  if (again.owner == null) return dirAgeMs(dir, now) > LOCK_ORPHAN_MS;
  if (firstOwner == null || again.owner.nonce !== firstOwner.nonce) return false;
  return !ownerIsLive(again.owner, { kill });
}

// A single attempt at the directory. Returns 'acquired' | 'held' | 'reclaimable'.
function tryAcquire(dir, owner, now, kill) {
  try { fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  try {
    // Non-recursive mkdir is the atomic arbiter: it either creates the directory or fails because
    // someone else already has. Recursive would succeed against an existing one and hand the lock
    // to two callers at once.
    fs.mkdirSync(dir, { recursive: false });
    writeOwner(dir, owner, now);
    // Confirm the record we just wrote is still the one there. Two processes that both found a DEAD
    // owner can both remove the directory and both succeed at mkdir — the second removal takes the
    // first one's fresh lock with it. Reading our own nonce back turns "we both think we hold it"
    // into "one of us loops", instead of leaving the loser to discover it at publish time.
    const confirmed = readLockOwner(dir);
    return confirmed.owner != null && confirmed.owner.nonce === owner.nonce ? 'acquired' : 'held';
  } catch {
    const record = readLockOwner(dir);
    if (record.owner == null) {
      return dirAgeMs(dir, now) > LOCK_ORPHAN_MS ? 'reclaimable' : 'held';
    }
    // 'suspect' rather than 'reclaimable': a single dead-looking reading has to be confirmed.
    return ownerIsLive(record.owner, { kill }) ? 'held' : { suspect: record };
  }
}

// In-process serialization. The file lock arbitrates between PROCESSES; inside one process the MCP
// bridge can have two awaited callers in flight at once, and they would both find the directory
// they themselves created, so the chain makes them queue.
//
// Re-entrancy is granted by PASSING THE HANDLE, never by a module-global depth counter. The counter
// version was wrong in a way no same-tick test could show: it said "someone in this process is
// inside a critical section", which is true both of a helper called BY that section and of a
// completely unrelated caller that arrived 40ms later — and the unrelated caller was then let
// straight in, so two critical sections ran at once. The long-lived bridge is exactly where a
// second caller arrives mid-section.
let mutexTail = Promise.resolve();

const TAKEN = { turn: true };
const EXPIRED = { turn: false };
const LOCKED = { ok: false, reason: 'locked' };

// Take this process's turn, or report that the wait ran out.
//
// BOUNDED, and that is the whole point. A plain FIFO chain deadlocks the moment anything inside a
// critical section calls back in without the lease: it queues behind a turn that cannot finish
// until it returns, and waits forever instead of reporting `locked`.
//
// The tail is `ahead.then(() => mine)`, so the next caller waits for everyone ahead of us AND for
// us. A turn we abandon on the timeout therefore cannot let the next caller past the real holder —
// it still has to wait out `ahead` first.
async function withInProcessTurn(waitMs, fn) {
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const ahead = mutexTail;
  mutexTail = ahead.then(() => mine, () => mine);

  let timer = null;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, waitMs));
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });
  const turn = await Promise.race([ahead.then(() => TAKEN, () => TAKEN), expired]);
  clearTimeout(timer);
  if (turn === EXPIRED) {
    release();
    return LOCKED;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

function handleFor(dir, owner) {
  return {
    dir,
    owner,
    // Marks this object as a real lease rather than something a caller constructed. Set false when
    // the section ends, so a handle retained past its critical section cannot be handed back in to
    // grant an UNLOCKED one — which is the failure mode the depth counter had, in another costume.
    held: true,
    // Ownership as of RIGHT NOW — the check a writer makes immediately before it publishes or
    // deletes, so a caller whose lock was reclaimed underneath it refuses to act on stale state.
    verify() {
      const record = readLockOwner(dir);
      return record.owner != null && record.owner.nonce === owner.nonce;
    },
  };
}

async function acquireAndRun(fn, options) {
  const now = options.now == null ? Date.now : options.now;
  const sleep = options.sleep == null
    ? ((ms) => new Promise((r) => setTimeout(r, ms)))
    : options.sleep;
  const waitMs = options.waitMs == null ? 5000 : options.waitMs;
  const dir = options.dir == null ? lockDirFor(options.home) : options.dir;
  const owner = lockOwner();
  const kill = options.kill;

  const deadline = now() + waitMs;
  for (;;) {
    let outcome = tryAcquire(dir, owner, now, kill);
    if (outcome === 'acquired') break;
    if (outcome !== 'held' && outcome.suspect != null) {
      outcome = (await confirmDead(dir, outcome.suspect, now, kill, sleep)) ? 'reclaimable' : 'held';
    }
    if (outcome === 'reclaimable') {
      // Fenced reclaim: remove, then let the next iteration's mkdir decide the winner. Both racers
      // can reach here, only one mkdir succeeds, and the loser's `verify()` will say so before it
      // ever publishes. The jitter is not decoration — without it, processes woken by the same dead
      // owner reclaim in lockstep and keep taking each other's fresh lock.
      await sleep(Math.floor(Math.random() * POLL_MS));
      try { removeSync(dir, { recursive: true, force: true }); } catch { /* someone else got there */ }
      if (now() >= deadline) return { ok: false, reason: 'locked' };
      continue;
    }
    if (now() >= deadline) return { ok: false, reason: 'locked' };
    await sleep(POLL_MS);
  }

  const handle = handleFor(dir, owner);
  try {
    return await fn(handle);
  } finally {
    handle.held = false;
    // Only ever delete a lock that is still ours. Removing one we lost would strand the winner's
    // critical section unguarded, which is the failure this whole module exists to prevent.
    if (handle.verify()) {
      try { removeSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// Run `fn(handle)` holding the credential mutation lock. Resolves `{ ok: false, reason: 'locked' }`
// — never throws — when the lock could not be taken inside `waitMs`; anything `fn` throws
// propagates, with the lock released first.
export function withCredentialLock(fn, options = {}) {
  // Already holding the lease? Then this is a nested call on the SAME critical section and it must
  // reuse that lease rather than queue behind itself. The handle is the proof; nothing else is.
  if (options.lock != null && options.lock.held === true) {
    // Re-entering someone else's lease: it must still be theirs. `held` says the section has not
    // ended; `verify()` says the lock has not been reclaimed underneath it. Neither alone is enough.
    if (!options.lock.verify()) return Promise.resolve({ ok: false, reason: 'locked' });
    return Promise.resolve().then(() => fn(options.lock));
  }
  const waitMs = options.waitMs == null ? 5000 : options.waitMs;
  const startedAt = Date.now();
  return withInProcessTurn(waitMs, () => {
    // One budget for both halves: waiting for this process's turn and then waiting for the
    // directory. Giving each a full `waitMs` would cost a caller twice what it asked for.
    const remaining = Math.max(0, waitMs - (Date.now() - startedAt));
    return acquireAndRun(fn, { ...options, waitMs: remaining });
  });
}
