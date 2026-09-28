import fs from 'fs';
import path from 'path';
import { beeziCursorHome, eventsDir, pendingDir, queueDir, stateDir, timelineOutboxDir } from './paths-cursor.mjs';
import { captureDir } from './hook-dump.mjs';
import { applyCaptureRetention } from './capture-retention.mjs';
import { RETENTION_WINDOW_MS } from './retention-window.mjs';
import { CHILD_OWNER_EXT, CHILD_OWNER_RETENTION_MS } from './cli-child-owner.mjs';
// vscdb.mjs loads node:sqlite lazily, inside functions, never at import time (loadSqlite's `probed`
// starts undefined and is only set on a call) — so pulling in its sweeper here adds no sqlite work
// to the sessionStart path that does not already touch it.
import { sweepStaleSnapshots } from './vscdb.mjs';

// How often the sweep below actually runs. Below this, back-to-back sessionStart calls (a scripted
// CLI loop, several agents sharing a machine) each pay for stat-ing every file in five directories
// for no reason — nothing in those directories can have aged out of a 14/30-day horizon in the
// minutes between two hooks. Six hours buys a handful of sweeps a day, which is all this needs.
export const PRUNE_THROTTLE_MS = 6 * 60 * 60 * 1000;

// The stamp sits at the beeziCursorHome() ROOT, beside the audit ledger and tracking cache — NOT
// inside any directory this sweep itself walks, or the sweep would prune its own throttle.
function lastPruneStampFile() {
  return path.join(beeziCursorHome(), 'last-prune');
}

// The stamp holds the injected `now` from the run that wrote it, as `String(now)` — never the
// file's own mtime. Tests drive pruneStale on synthetic clocks (test/pending-batch.test.mjs and
// others), and an mtime is always the real wall clock no matter what `now` a caller passes in.
function readStamp(file, fsImpl) {
  try {
    const n = Number(fsImpl.readFileSync(file, 'utf-8'));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // never swept before, unreadable, or corrupt — all three mean "not throttled"
  }
}

function writeStamp(file, now, fsImpl) {
  // Best-effort: losing the stamp costs one extra sweep next time, not a broken hook.
  try { fsImpl.writeFileSync(file, String(now), { encoding: 'utf-8', mode: 0o600 }); } catch { /* best-effort */ }
}

// Deletes files in the state, queue and events dirs whose mtime is older than maxAgeMs.
// Best-effort: never throws. `now` injectable for deterministic tests.
//
// The whole sweep — this loop, the capture retention pass and the orphaned-snapshot sweep below —
// runs at most once every PRUNE_THROTTLE_MS (6h): a call whose `now` is within that window of the
// last recorded run is a no-op and returns immediately, before any directory is touched. `deps`
// carries two test seams, both defaulting to the real thing in production: `deps.fsImpl` (an `fs`
// stand-in threaded through every step, including the snapshot sweep) and `deps.tmpDir` (the
// directory the snapshot sweep scans — production always passes this through to `os.tmpdir()`,
// since `sweepStaleSnapshots` treats an omitted `tmpDir` that way; a test with a synthetic `now` MUST
// supply an isolated `deps.tmpDir`, or a clock that is not real wall-clock time can make a real,
// possibly still-in-use `beezi-cursor-db-*` directory elsewhere on the machine look arbitrarily
// stale and delete it).
//
// The sidecar has to be on this list. It is append-only, one JSONL per conversation, and nothing
// else ever deletes one — so without it `events/` grows for the life of the machine while its
// state file (which holds the read cursor) is pruned out from under it at the retention horizon. Reopening such
// a conversation would then start from cursor 0 against a full sidecar. Both directories age on
// the same clock, and the cursor is now monotonic, so neither half can strand the other.
// `pending/` joins the list for one reason the others do not have: a batch whose account no longer
// matches is deliberately LEFT in place by checkpoint recovery (enqueuing another tenant's payloads
// under the current credentials, or advancing this account's cursor over work reported to a
// different one, are both worse than one orphaned file) — so nothing else on the machine ever
// deletes it. It is a flat directory of immediate files, which is all this sweep can clean.
// `timelines/` (the session-timeline outbox) joins for the same reason: the drain deliberately
// leaves an entry recorded under a different account in place, and keeps one the server keeps
// answering 5xx, so without this a timeline that can never land would sit on disk forever. The
// drain never rewrites an entry, so its mtime is the age of the newest body for that session.
export function pruneStale(now = Date.now(), maxAgeMs = RETENTION_WINDOW_MS, deps = {}) {
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  const stampFile = lastPruneStampFile();
  const stamp = readStamp(stampFile, fsImpl);
  if (stamp !== null) {
    const elapsed = now - stamp;
    // A stamp in the future is a clock that moved backwards (a resync, a VM resume) — the same rule
    // pulseDecision uses. Re-run rather than wait out an interval that may never elapse.
    if (elapsed >= 0 && elapsed < PRUNE_THROTTLE_MS) return;
  }

  // One exception to the horizon: a Cursor CLI worker's ownership marker (`state/<id>.cli-owner`,
  // lib/cli-child-owner.mjs) is kept CHILD_OWNER_RETENTION_MS (180 days), or the caller's horizon if
  // that is longer. It is the only record of the fold its parent last sent, and a parent resumed
  // after the normal horizon still lists the worker from its chat store; without the marker that
  // resume sends the worker's row bare and wipes the server's fold (Codex re-review, fix round 3).
  const stateRoot = stateDir();
  const ownerMaxAgeMs = Math.max(maxAgeMs, CHILD_OWNER_RETENTION_MS);
  for (const dir of [stateRoot, queueDir(), eventsDir(), pendingDir(), timelineOutboxDir()]) {
    let files;
    try { files = fsImpl.readdirSync(dir); } catch { continue; } // dir missing → skip
    for (const file of files) {
      const p = path.join(dir, file);
      const horizon = dir === stateRoot && file.endsWith(CHILD_OWNER_EXT) ? ownerMaxAgeMs : maxAgeMs;
      try {
        const { mtimeMs } = fsImpl.statSync(p);
        if (now - mtimeMs > horizon) fsImpl.unlinkSync(p);
      } catch { /* skip unreadable/racing file */ }
    }
  }
  // `capture/` is deliberately NOT in the list above. This loop unlinks immediate files on an mtime
  // rule, which can neither reach nested `capture/stdin/` nor cap a log that is appended to
  // continuously — a file written all week is never 14 days old. Its own bounded sweep runs here so
  // a machine that turned capture off still has its raw payloads expire.
  try { applyCaptureRetention(captureDir(), { now: () => now, fsImpl }); } catch { /* never fails a prune */ }

  // Orphaned state.vscdb temp snapshots (lib/vscdb.mjs's openSnapshot, left behind by a hook killed
  // at its deadline before its own cleanup ran) live under os.tmpdir(), not under beeziCursorHome(),
  // so nothing above reaches them. Riding this same throttle keeps the added `readdirSync(tmpdir())`
  // off the unthrottled sessionStart path this sweep used to sit on.
  try { sweepStaleSnapshots({ now, fsImpl, tmpDir: deps.tmpDir }); } catch { /* never fails a prune */ }

  // Stamped AFTER the sweep, not before: a hook killed mid-sweep (the same deadline that orphans a
  // state.vscdb snapshot — see the sweep this throttle also gates) must not leave a stamp claiming
  // the sweep completed, which would silently suppress the next attempt for up to six hours. Losing
  // the stamp costs one extra sweep; a false one costs six hours of unswept retention.
  writeStamp(stampFile, now, fsImpl);
}
