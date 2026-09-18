import fs from 'fs';
import path from 'path';
import { removeSync } from './fs-compat.mjs';

// Read + parse a JSON file, or return `fallback` on any read/parse failure.
export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// Set once, by whoever is willing to depend on the telemetry stack (the hook bootstrap or
// session-start). Absent, every write failure is silent exactly as it is today.
//
// INJECTED rather than imported: this module is on the startup path of every hook, and importing
// lib/telemetry.mjs here would drag child_process and http along with it — onto
// scripts/tool-event.mjs, which fires on every tool call.
let reportWriteFailure = () => {};
export function setWriteFailureReporter(fn) {
  reportWriteFailure = typeof fn === 'function' ? fn : () => {};
}

// Write a file without ever leaving a half-written one behind.
//
// `writeFileSync` opens with O_TRUNC: the old contents are gone before the new ones land, so a
// crash, a full disk, or Cursor's hard 10s hook kill landing inside the write leaves a truncated
// file. Not hypothetical — every file written through here is read back by a later process that
// treats a parse failure as "absent":
//
//   state/<id>.json        truncated ⇒ the cursor resets to 0 ⇒ the whole sidecar is re-reported
//                          under a segmentId the server has never seen, so its dedupe cannot catch
//                          the overlap, and the usage baseline is re-billed from zero
//   ~/.cursor/hooks.json   truncated ⇒ the user's OWN hooks stop loading, and the installer's
//                          refuse-on-unparseable guard then makes the damage permanent
//   .cursor/settings.json  truncated ⇒ every project setting they have, in a file usually committed
//
// Writing a sibling temp file and renaming over the target is atomic on NTFS and on POSIX, so a
// reader sees either the old file or the new one. The temp file goes in the SAME directory: rename
// is only atomic within one filesystem.
export function writeFileAtomic(filePath, contents, { mode, dirMode = 0o700 } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
    // writeFileSync only applies `mode` when it creates the file, and a temp name can survive a
    // previous crash — force it so an overwrite cannot widen the permissions.
    if (mode !== undefined) {
      try { fs.chmodSync(tmp, mode); } catch { /* no-op on Windows */ }
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { removeSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    // Best-effort diagnostic, and deliberately the LAST thing before the rethrow: a reporter that
    // throws must never mask the write failure the caller is about to see.
    try { reportWriteFailure(error); } catch { /* never mask the real failure */ }
    throw error;
  }
}

// Write JSON to a 0600 file, creating parent dirs.
export function writeJsonSecure(filePath, obj, { dirMode = 0o700 } = {}) {
  writeFileAtomic(filePath, JSON.stringify(obj), { mode: 0o600, dirMode });
}
