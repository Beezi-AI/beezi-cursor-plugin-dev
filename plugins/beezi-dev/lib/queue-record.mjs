// Reading ONE record out of the report queue, shared by lib/queue-delivery.mjs and
// lib/queue-maintenance.mjs.
//
// This module imports nothing — not even `fs`. The filesystem arrives as a parameter and the path
// arrives already joined, which is what keeps `scripts/check-node-floor.mjs` happy: that script
// walks `lib/` off the filesystem and `import()`s every module it finds in an isolated child
// process, so a module with no imports and no top-level work cannot have an import-time side
// effect.

// Read and parse separately, because they are different verdicts. A file that vanished between the
// readdir and here was delivered by a concurrent flush and is nobody's problem; a file whose BYTES
// are not JSON is corrupt. lib/fs-store.mjs's readJson collapses both into null and takes no fs
// seam, so the two steps are spelled out here instead.
//
// Returns { stat, raw, payload, verdict } where `verdict` is exactly one of:
//
//   'ok'           — `payload` is whatever the JSON parsed to (which MAY be a non-object: a bare
//                    null, a number, a string). Judging that is the CALLER's, because the two
//                    callers judge it differently, and a fourth verdict here would silently move
//                    maintenance's non-object records out of `kept` and into `corrupt`.
//   'read-failed'  — gone between the readdir and here: delivered by a concurrent flush, or pruned.
//                    Not a corrupt record. `raw` and `payload` are null.
//   'parse-failed' — the bytes are not JSON. `raw` holds them, `payload` is null. What the caller
//                    does about that is deliberately NOT shared: delivery quarantines by rename,
//                    maintenance counts and walks on.
//
// `stat` is null when the stat itself failed; the callers already treat that as "no mtime clock".
export function readQueueRecord(fsImpl, filePath) {
  let stat = null;
  try { stat = fsImpl.statSync(filePath); } catch { stat = null; }

  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf-8');
  } catch {
    return { stat, raw: null, payload: null, verdict: 'read-failed' };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { stat, raw, payload: null, verdict: 'parse-failed' };
  }

  return { stat, raw, payload, verdict: 'ok' };
}
