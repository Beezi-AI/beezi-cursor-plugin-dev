import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { stateDir } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { removeSync } from './fs-compat.mjs';
import { acquireMkdirLock, releaseMkdirLock } from './mkdir-lock.mjs';

// A per-session mutex for the read-modify-write in lib/checkpoint.mjs.
//
// `runCheckpoint` does loadState → (await network / git / sidecar work) → saveState with nothing in
// between guarding the file, and Cursor fires `afterShellExecution`, `stop` and `sessionEnd` as
// SEPARATE OS PROCESSES that land together at a turn boundary. Two distinct damages come out of
// that, in ascending order of how expensive they are:
//
//   1. Both processes read `cursor=100`. A enqueues `conv:100-150`, B enqueues `conv:100-160`.
//      Those are different segmentIds, so the server's idempotency key — which is the segmentId —
//      cannot collapse them. The tokens, cost and code changes for lines 100-150 are billed twice
//      and there is no later pass that notices.
//   2. `state.usageSnapshot` is the CUMULATIVE-credits baseline. The last writer wins, so a stale
//      write rewinds it and the next checkpoint re-bills the whole difference. checkpoint.mjs says
//      of this figure: "it can never be recovered — usageData is cumulative, so the increment is
//      gone." The same sentence is the reason this lock exists.
//
// The scheme was not invented here: `mkdir` is atomic on NTFS and on POSIX (it either creates the
// directory or fails because someone else holds it), it needs no daemon, no fcntl and no cleanup on
// reboot beyond the staleness rule below, and it is already proven in this plugin — the credential
// store arbitrates the same way, in lib/credential-lock.mjs `tryAcquire`. (It used to be lifted from
// token.mjs; token.mjs no longer locks for itself, and its first 45 lines are now imports and
// constants.) Two things are deliberately different here — see `sessionLockPath` for the first
// (per-session, not machine-wide) and `withLock` for the second (contention SKIPS).
//
// The mkdir mechanics themselves are no longer duplicated: lock.mjs and lib/pulse-cursor.mjs both
// call lib/mkdir-lock.mjs, which takes the staleness threshold and the fs implementation as
// parameters so neither caller's tuning leaks into the other. The credential path is still NOT
// folded in, and deliberately so: credential-lock.mjs reclaims on holder LIVENESS rather than on
// age, and that is a different primitive wearing the same mkdir.

// How long a lock may sit before the next caller treats it as abandoned and breaks it.
//
// 30s is chosen against the host, not against the work: Cursor kills a hook at 10s, so a process
// that died mid-critical-section cannot possibly still be running by the time this elapses, and its
// lock therefore self-breaks without anyone having to reap it. Lowering this below the hook kill
// would let a live-but-slow hook have its lock stolen, which is the one thing the lock exists to
// prevent.
export const LOCK_STALE_MS = 30_000;

// Where one conversation's lock lives: `state/<id>.lock`, alongside the `state/<id>.json` it guards.
//
// Per-session on purpose. lib/credential-lock.mjs holds ONE lock for the machine — `lockDirFor`
// puts it at `<home>/credentials.lock` — because there is one credential store that login, logout
// and refresh all mutate; here a machine-wide lock would make two unrelated conversations — a hook in repo A and a
// hook in repo B — serialize against each other, and under the SKIP semantics below that is not a
// wait, it is a dropped checkpoint for a session that had no conflict at all.
//
// The id runs through `safeName` because it arrives from a hook payload: an id containing `../`
// would otherwise place the lock (and its recursive `removeSync`) outside the state directory.
// Returns null for an id that cannot be made into a filename — such an id has no sidecar and no
// state file either, so there is nothing for a caller to checkpoint.
//
// Nothing else in the plugin trips over the extra directory entry: active-conversation.mjs filters
// on `.json`, and prune.mjs's `unlinkSync` refuses directories and skips them (a lock older than
// the retention horizon cannot exist anyway — the next caller breaks it at 30s).
export function sessionLockPath(sessionId) {
  const name = safeName(sessionId);
  return name === null ? null : path.join(stateDir(), `${name}.lock`);
}

// Take the lock, or report that someone else holds a live one. The mkdir mechanics — including the
// parent-directory guard and the ENOENT incident behind it — live in lib/mkdir-lock.mjs.
function acquire(lockPath, now) {
  return acquireMkdirLock(lockPath, { fsImpl: fs, now, staleMs: LOCK_STALE_MS });
}

function release(lockPath) {
  releaseMkdirLock(lockPath);
}

// Run `fn` while holding `lockPath`; return `options.miss` instead if the lock is already held.
//
// CONTENTION SKIPS — it does not sleep and proceed. The credential refresh WAITS under contention:
// token.mjs asks credential-lock.mjs for the lock with a 1000ms budget capped at 3000ms
// (LOCK_WAIT_MS / LOCK_WAIT_MAX_MS, spent by `lockWait`), credential-lock.mjs polls for it every
// 25ms (POLL_MS), and a refresh that still loses reports REFRESHING/LOCKED while serving the token
// it already holds. That is right there (any valid access token will do, so the loser can just
// re-read what the winner stored) and wrong here for two reasons:
//
//   - The whole checkpoint runs inside a 7500ms budget (HOOK_BUDGET_MS). A sleep spends that budget
//     to arrive at a state the other process has already changed underneath us, so the loser then
//     has to redo the read anyway. It is pure loss.
//   - Skipping is safe BY THIS MODULE'S OWN DESIGN. The cursor simply does not advance, and
//     checkpoint.mjs already documents standing still as the safe failure: "the window is
//     re-examined next checkpoint, and the same segmentId is produced once the blocker clears." The
//     hook that won the race is covering exactly this window right now.
//
// `fn` may be async: the await lives INSIDE the try so `finally` runs after the promise settles.
// Written as `return await` for that reason and not by accident — a bare `return fn()` releases the
// lock the moment the promise is created, i.e. before any of the guarded work has happened, which
// is the same unguarded read-modify-write this module exists to remove. A throwing `fn` still
// releases, so a callback that blows up cannot strand the lock for the next 30 seconds.
//
// A null `lockPath` (an unusable session id, see `sessionLockPath`) returns the miss value: this
// never runs guarded work unguarded.
export async function withLock(lockPath, fn, { now = Date.now, miss = undefined } = {}) {
  if (typeof lockPath !== 'string' || lockPath === '') return miss;
  if (!acquire(lockPath, now)) return miss;
  try {
    return await fn();
  } finally {
    // Removed on the happy path too. A lock file left behind would be indistinguishable from a
    // crashed holder for the next 30 seconds, which would make every rapid second hook a miss.
    release(lockPath);
  }
}

// ── long-held sections
//
// Everything above is built for a HOOK: take the lock, do millisecond work, drop it, and let the
// next caller break anything older than 30 s because Cursor has already killed a hook that old.
// The repeatable sync (lib/session-audit.mjs runSync) breaks both halves of that assumption. Its
// guarded section spans a 60 s coverage query, a whole-sidecar parse and a 60 s upload with its own
// retry and bisection — minutes, legitimately. Under `withLock` that produces two failures at once:
//
//   1. a live hook finds a 30-second-old lock, correctly concludes its holder is dead, breaks it,
//      and enqueues a window overlapping the one sync is about to send. Two segmentIds for the
//      same lines is precisely the double-billing this module exists to prevent.
//   2. sync's own `finally` then calls `release`, which was ownership-blind, and deletes the HOOK's
//      lock — handing the next process a free pass into the same race.
//
// Two additions fix both, and neither changes anything for the hook callers above:
//
//   an owner token   written inside the lock directory. A release only removes a lock whose token
//                    is still ours, so a holder that lost the lock cannot delete its successor's.
//   a heartbeat      that touches the lock's mtime on an interval, so "held for minutes" and
//                    "abandoned 30 seconds ago" stop being the same observation.
//
// The staleness rule itself is unchanged and MUST stay unchanged: a section that stops renewing —
// because the process died — still self-breaks at 30 s, which is what keeps a crash from stranding
// a conversation forever.

// How often a held section refreshes its lock. Comfortably inside LOCK_STALE_MS so a single missed
// tick (a blocked event loop, a slow disk) does not expose the lock to a steal.
export const HELD_LOCK_RENEW_MS = 10000;

// The token file lives INSIDE the lock directory, so it is created and destroyed atomically with
// the lock itself: there is no window where a lock exists without an owner it can be checked
// against, and no orphan file left behind when the directory is removed.
const OWNER_FILE = 'owner';

function mintToken() {
  // Not randomUUID: the plugin's floor is Node 13.2. randomBytes has been there since forever, and
  // the pid keeps two processes that somehow drew the same bytes apart.
  return `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
}

function writeOwner(lockPath, token) {
  try {
    fs.writeFileSync(path.join(lockPath, OWNER_FILE), token, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function ownerOf(lockPath) {
  try {
    return fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf-8');
  } catch {
    // No owner file at all is a lock taken by a plain `withLock` caller (a hook), or a lock that
    // has been removed. Either way it is not ours.
    return null;
  }
}

// Push the lock's mtime forward, but only while it is still ours. Returns false the moment it is
// not — which is the signal a long section needs to stop and defer rather than send under a lock
// somebody else now holds.
function renewOwned(lockPath, token) {
  if (ownerOf(lockPath) !== token) return false;
  try {
    const stamp = new Date();
    fs.utimesSync(lockPath, stamp, stamp);
    return true;
  } catch {
    return false;
  }
}

function releaseOwned(lockPath, token) {
  // The whole point: a holder that was broken and replaced must not remove its successor's lock.
  if (ownerOf(lockPath) !== token) return false;
  try { removeSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

// `withLock` for a section that legitimately runs for minutes.
//
// Same contention semantics as `withLock` — it SKIPS, returning `options.miss`, rather than waiting
// — and the same release-in-finally guarantee. The differences are the owner token and the
// heartbeat described above.
//
// `fn` receives a handle:
//   `stillHeld()`  is this lock still ours? A long section checks it immediately before anything
//                  irreversible (a send, a progress write) and defers if it is false.
//   `renew()`      force a heartbeat now; returns false once the lock is no longer ours.
//
// `renewMs: 0` disables the interval, for tests that drive `renew()` by hand.
export async function withHeldLock(lockPath, fn, options = {}) {
  const now = options.now == null ? Date.now : options.now;
  const miss = options.miss;
  const renewMs = options.renewMs == null ? HELD_LOCK_RENEW_MS : options.renewMs;
  if (typeof lockPath !== 'string' || lockPath === '') return miss;
  if (!acquire(lockPath, now)) return miss;

  const token = mintToken();
  if (!writeOwner(lockPath, token)) {
    // A lock we cannot stamp is a lock we cannot safely release or renew. Give it straight back
    // rather than hold something we cannot prove is ours.
    release(lockPath);
    return miss;
  }

  let timer = null;
  if (renewMs > 0) {
    timer = setInterval(() => { renewOwned(lockPath, token); }, renewMs);
    // The heartbeat must never be the reason a finished process stays alive.
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  }
  try {
    return await fn({
      stillHeld: () => ownerOf(lockPath) === token,
      renew: () => renewOwned(lockPath, token),
    });
  } finally {
    if (timer != null) clearInterval(timer);
    releaseOwned(lockPath, token);
  }
}
