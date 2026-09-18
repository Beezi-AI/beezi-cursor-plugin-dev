import fs from 'fs';
import path from 'path';

// Bounds for the hook-payload capture harness (lib/hook-dump.mjs).
//
// Capture is opt-in and is the least redacted thing this plugin ever writes — full tool output,
// shell command text, file paths, and whatever a payload carries that nobody has looked at yet. It
// is also unbounded by construction: `hooks.jsonl` is appended once per hook run, and a killed
// hook leaves its raw stdin replay behind in `capture/stdin/`. A capture session left on over a
// weekend is a multi-gigabyte file of exactly the material that should not be lying around.
//
// lib/prune.mjs cannot do this job. It unlinks immediate files on a flat 14-day mtime rule, so it
// can neither reach the nested `stdin/` directory nor cap a file that is appended to continuously
// — a log written all week is never 14 days old. Hence a separate, deliberately recursive-by-one
// -level sweep that only ever touches validated descendants of the capture root.
//
// EVERY NUMBER BELOW IS PROPOSED CLIENT POLICY. None of it is a server requirement, and nothing
// here is ever uploaded: capture output stays on the machine that produced it and is not read by
// the self-diagnostics path (see lib/telemetry-recorder.mjs, which records no paths and no file
// contents at all).

// One log may reach 8 MiB before it is rolled aside.
export const ROTATE_AT_BYTES = 8 * 1024 * 1024;
// At most four logs exist at once — the active one plus three rotations, so a full capture
// directory costs 32 MiB rather than a disk.
export const MAX_LOG_FILES = 4;
// The same fortnight lib/prune.mjs uses for analytics, so a machine has one retention story.
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// A replay file exists only for the microseconds between a hook reading stdin and parsing it. An
// hour is generous for a host that killed the hook mid-turn, and short enough that raw payloads do
// not outlive the session.
export const REPLAY_MAX_AGE_MS = 60 * 60 * 1000;
// A ceiling on the work one sweep may do, per directory. A capture root with a pathological number
// of entries must cost a hook a bounded amount of time, not a proportional one.
export const MAX_ENTRIES_SCANNED = 500;
// How often the throttled call site actually sweeps.
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const RETENTION_MARKER = '.retention';

const LOG_BASENAME = 'hooks.jsonl';
const ROTATED = /^hooks\.jsonl\.(\d+)$/;
const REPLAY_DIR = 'stdin';

function resolveFs(fsImpl) {
  return fsImpl == null ? fs : fsImpl;
}

// The guarantee: nothing outside the capture root is ever named, let alone unlinked. `path.relative`
// answers with a `..` prefix within one root and with the absolute target across two (a drive
// letter, a UNC share), so both cases fail the same check.
function contains(root, target) {
  const rel = path.relative(root, target);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).indexOf('..') === -1;
}

// One directory listing, bounded, with each entry resolved and contained. Returns
// `{ entries: [{ name, filePath, stat }], skipped }`; a symlink or reparse point is counted as
// skipped and never returned — following one is how a sweep deletes something it was never
// pointed at.
function listBounded(impl, root, dir) {
  const out = { entries: [], skipped: 0 };
  let names;
  try { names = impl.readdirSync(dir); } catch { return out; }
  if (!Array.isArray(names)) return out;
  for (const name of names.slice(0, MAX_ENTRIES_SCANNED)) {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..') continue;
    const filePath = path.join(dir, name);
    if (!contains(root, filePath)) { out.skipped += 1; continue; }
    let stat;
    try { stat = impl.lstatSync(filePath); } catch { continue; }
    if (stat == null) continue;
    // Junctions and reparse points surface here as symbolic links on Windows too.
    if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) { out.skipped += 1; continue; }
    if (typeof stat.isFile === 'function' && !stat.isFile()) { out.skipped += 1; continue; }
    out.entries.push({ name, filePath, stat });
  }
  return out;
}

function removeQuietly(impl, filePath) {
  try {
    impl.unlinkSync(filePath);
    return true;
  } catch {
    // Already gone (another hook beat us), locked by a concurrent append on Windows, or refused by
    // permissions. All three mean "not this pass", never "fail the hook".
    return false;
  }
}

const ageOf = (stat, nowMs) => (stat == null || !Number.isFinite(stat.mtimeMs)
  ? 0
  : nowMs - stat.mtimeMs);

// Manage one capture directory: rotate the active log, cap the number of logs, expire old ones,
// and delete orphan stdin replays.
//
// Never throws, and never touches anything that is not a validated plain file directly inside the
// capture root or its `stdin/` child. Returns counters so a caller can log or test them; no caller
// may branch on them, because no hook may behave differently when capture is on.
export function applyCaptureRetention(root, options = {}) {
  const result = { rotated: 0, removedLogs: 0, removedReplays: 0, skipped: 0 };
  if (typeof root !== 'string' || root === '') return result;
  const impl = resolveFs(options.fsImpl);
  const nowMs = (options.now == null ? Date.now : options.now)();

  try {
    // ── the active log: rotate when it is full ──
    const active = path.join(root, LOG_BASENAME);
    try {
      const stat = impl.lstatSync(active);
      const isLink = typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
      const isFile = typeof stat.isFile !== 'function' || stat.isFile();
      if (isLink) {
        result.skipped += 1;
      } else if (isFile && Number.isFinite(stat.size) && stat.size >= ROTATE_AT_BYTES) {
        // Renamed, not truncated: a concurrent `appendFileSync` holding the old descriptor keeps
        // writing to the rotated file rather than into a hole at the head of the new one.
        try {
          impl.renameSync(active, path.join(root, `${LOG_BASENAME}.${nowMs}`));
          result.rotated = 1;
        } catch { /* another hook rotated first, or the file is locked; next pass */ }
      }
    } catch { /* no log yet — the first append creates it */ }

    // ── the capture root: expire, then cap ──
    const top = listBounded(impl, root, root);
    result.skipped += top.skipped;
    const rotations = [];
    for (const entry of top.entries) {
      const isActive = entry.name === LOG_BASENAME;
      const match = ROTATED.exec(entry.name);
      if (!isActive && match === null) continue; // the marker, and anything else, is not ours
      if (ageOf(entry.stat, nowMs) > LOG_MAX_AGE_MS) {
        if (removeQuietly(impl, entry.filePath)) result.removedLogs += 1;
        continue;
      }
      if (match !== null) rotations.push({ filePath: entry.filePath, at: Number(match[1]) });
    }
    // Newest first by the stamp in the NAME, not by mtime: a rotated file's mtime can be touched
    // by a backup or a sync client, and the name is what this module wrote.
    rotations.sort((a, b) => b.at - a.at);
    for (const extra of rotations.slice(MAX_LOG_FILES - 1)) {
      if (removeQuietly(impl, extra.filePath)) result.removedLogs += 1;
    }

    // ── stdin replays: orphans only ──
    //
    // Age alone decides, deliberately. The files are named `<pid>-<ms>.bin`, so the ACTIVE run's
    // replay is seconds old and the one-hour rule already preserves it; a liveness probe on the
    // pid would instead preserve a dead run's payload whenever the number had been reused, which
    // is precisely the file that must not survive.
    // The replay DIRECTORY is checked before anything inside it is listed. Skipping symlinked
    // entries is not enough on its own: replacing `capture/stdin` itself with a link to somewhere
    // else would have every name inside it resolve, `path.join(root, 'stdin', name)` would still
    // pass the containment check (the link is genuinely inside the root), and the unlink would land
    // on the target directory's files. A junction is the Windows spelling of the same trick and
    // surfaces here the same way.
    const replayDir = path.join(root, REPLAY_DIR);
    let replayDirOk = false;
    try {
      const stat = impl.lstatSync(replayDir);
      const isLink = typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
      const isDir = typeof stat.isDirectory !== 'function' || stat.isDirectory();
      if (isLink || !isDir) result.skipped += 1;
      else replayDirOk = true;
    } catch { /* no replays have ever been written */ }
    if (!replayDirOk) return result;

    const replays = listBounded(impl, root, replayDir);
    result.skipped += replays.skipped;
    for (const entry of replays.entries) {
      if (ageOf(entry.stat, nowMs) <= REPLAY_MAX_AGE_MS) continue;
      if (removeQuietly(impl, entry.filePath)) result.removedReplays += 1;
    }
  } catch {
    // A sweep that cannot run is a sweep that did nothing, not a hook that failed in front of the
    // user. This is the outermost of several guards on purpose: capture is a diagnostic aid and
    // must never be the reason ten working hooks look broken.
  }
  return result;
}

function markerAgeMs(impl, root, nowMs) {
  try {
    const stat = impl.lstatSync(path.join(root, RETENTION_MARKER));
    return Number.isFinite(stat.mtimeMs) ? nowMs - stat.mtimeMs : Infinity;
  } catch {
    return Infinity; // never swept
  }
}

function touchMarker(impl, root, nowMs) {
  const marker = path.join(root, RETENTION_MARKER);
  try {
    impl.writeFileSync(marker, String(nowMs), { encoding: 'utf-8', mode: 0o600 });
    const at = new Date(nowMs);
    try { impl.utimesSync(marker, at, at); } catch { /* an injected clock is a test concern only */ }
  } catch { /* an unwritable marker means the sweep runs again next hook: correct, just costlier */ }
}

// What the hook path calls. `dumpHookPayload` runs on EVERY tool call, and a full listing of two
// directories per hook run would undo the whole reason lib/hook-dump.mjs is written the way it is.
//
// So the cheap question is asked first: one lstat of the active log. A log at the rotation size
// sweeps immediately whatever the interval says — a file that is already full cannot wait fifteen
// minutes — and otherwise the sweep runs at most once per SWEEP_INTERVAL_MS, tracked by a marker
// file because hooks are separate processes and an in-memory timestamp would never survive one.
export function maybeApplyCaptureRetention(root, options = {}) {
  if (typeof root !== 'string' || root === '') return { ran: false };
  const impl = resolveFs(options.fsImpl);
  const nowMs = (options.now == null ? Date.now : options.now)();
  try {
    let due = false;
    try {
      const stat = impl.lstatSync(path.join(root, LOG_BASENAME));
      due = Number.isFinite(stat.size) && stat.size >= ROTATE_AT_BYTES;
    } catch { /* no log yet */ }
    if (!due) due = markerAgeMs(impl, root, nowMs) >= SWEEP_INTERVAL_MS;
    if (!due) return { ran: false };
    const result = applyCaptureRetention(root, { now: () => nowMs, fsImpl: impl });
    touchMarker(impl, root, nowMs);
    return Object.assign({ ran: true }, result);
  } catch {
    return { ran: false };
  }
}
