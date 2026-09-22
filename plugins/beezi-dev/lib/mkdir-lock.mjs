import fs from 'fs';
import path from 'path';
import { removeSync } from './fs-compat.mjs';

// The mkdir-as-mutex primitive, shared by the session lock (lib/lock.mjs) and the mid-turn pulse
// claim (lib/pulse-cursor.mjs). Both had their own copy of the same eleven lines; this is that copy,
// once. `mkdir` is atomic on NTFS and on POSIX — it either creates the directory or fails because
// someone else holds it — so it needs no daemon, no fcntl and no cleanup on reboot beyond the
// staleness rule the caller supplies.
//
// Two things are parameters rather than constants, and both deliberately:
//
//   `staleMs`   because the two callers guard different things. lock.mjs's LOCK_STALE_MS is set
//               against Cursor's 10s hook kill; pulse-cursor.mjs's PULSE_CLAIM_STALE_MS is set
//               against the 7.5s hook budget a pulse may hold its claim for. They happen to be the
//               same number today and either may be retuned without the other, so there is no
//               default here — a default is how two independent tunings quietly become one.
//   `fsImpl`    because maybeRunPulse takes an injected fs so a test can make the claim mkdir fail
//               on demand, while lock.mjs uses the real module. `removeSync` is NOT routed through
//               the seam: both callers reach for the real one, and the break-a-stale-lock path is
//               filesystem work the injected impl was never standing in for.
//
// `now` is a function, not an instant, so it is only called on the contended branch — a caller
// driving an injected clock sees the same number of reads it saw before this was extracted.
//
// Contention is reported, never handled: this returns false and the caller decides. withLock skips
// and returns its miss value; maybeRunPulse returns reason 'contended' and leaves the window due.
//
// No import-time side effects — scripts/check-node-floor.mjs imports every module under lib/ in a
// child process with a throwaway HOME, and a leaf that touched the filesystem on load would fail it.

// Take `lockPath`, breaking it first if its holder has been gone longer than `staleMs`.
export function acquireMkdirLock(lockPath, { fsImpl = fs, now, staleMs } = {}) {
  // The lock mkdir stays non-recursive — that is what makes it atomic — so the PARENT has to exist
  // first. This is the ENOENT that already cost this plugin an outage once, back when the credential
  // refresh had a mkdir lock of its own: nothing had written to the data root yet, so `mkdir` failed
  // with ENOENT, the lock was never acquired, and every caller took the contention branch forever.
  // (token.mjs has no mkdirSync at all now — it locks through credential-lock.mjs, whose
  // `tryAcquire` carries the same parent-first guard.) The state directory the session lock lives in
  // is normally created by writeJsonSecure — but the FIRST checkpoint of a fresh install locks
  // before it ever writes, so on that one run the directory genuinely does not exist.
  try { fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  try {
    fsImpl.mkdirSync(lockPath, { recursive: false });
    return true;
  } catch {
    try {
      if (now() - fsImpl.statSync(lockPath).mtimeMs > staleMs) {
        removeSync(lockPath, { recursive: true, force: true });
        fsImpl.mkdirSync(lockPath, { recursive: false });
        return true;
      }
    } catch { /* someone else broke it first, or it vanished — either way we did not get it */ }
    return false;
  }
}

export function releaseMkdirLock(lockPath) {
  try { removeSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
