import fs from 'fs';
import path from 'path';
import { eventsDir, pendingDir, queueDir, stateDir } from './paths-cursor.mjs';
import { captureDir } from './hook-dump.mjs';
import { applyCaptureRetention } from './capture-retention.mjs';
import { RETENTION_WINDOW_MS } from './retention-window.mjs';

// Deletes files in the state, queue and events dirs whose mtime is older than maxAgeMs.
// Best-effort: never throws. `now` injectable for deterministic tests.
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
export function pruneStale(now = Date.now(), maxAgeMs = RETENTION_WINDOW_MS) {
  for (const dir of [stateDir(), queueDir(), eventsDir(), pendingDir()]) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; } // dir missing → skip
    for (const file of files) {
      const p = path.join(dir, file);
      try {
        const { mtimeMs } = fs.statSync(p);
        if (now - mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* skip unreadable/racing file */ }
    }
  }
  // `capture/` is deliberately NOT in the list above. This loop unlinks immediate files on an mtime
  // rule, which can neither reach nested `capture/stdin/` nor cap a log that is appended to
  // continuously — a file written all week is never 14 days old. Its own bounded sweep runs here so
  // a machine that turned capture off still has its raw payloads expire.
  try { applyCaptureRetention(captureDir(), { now: () => now }); } catch { /* never fails a prune */ }
}
