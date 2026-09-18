import fs from 'fs';
import os from 'os';
import path from 'path';
import * as hostSidecar from './sidecar.mjs';

// Reader half of the event sidecar. The writer (lib/sidecar.mjs) appends one JSON object per line to
// ~/.beezi-cursor/events/<conversation_id>.jsonl from inside a live hook, so this reader must assume
// it is racing an append: the final line can be a partial write.
//
// Bind to the writer's own path function rather than re-deriving the location. A writer/reader
// disagreement about where the stream lives is indistinguishable in production from "the user did no
// work", which is the single failure mode this plugin cannot afford.
//
// The binding used to be a guarded `await import`, so that a missing writer left this module (and
// its tests) loadable against a contract-pinned fallback. Top-level await needs Node 14.8 and the
// plugin's floor is 13.2, and there is no version of that guard that both keeps the sync readers
// below working and survives the rewrite: the two consts are evaluated during module evaluation, so
// a `.then()` that flips them lands a microtask too late and pins them to the fallback forever. The
// import is therefore static — the writer is a sibling in this same package, so "absent" was only
// ever a broken install, which a static import reports honestly instead of degrading past.
//
// The writer exports its sanitizer, so the fallback below borrows it instead of keeping a
// byte-identical private copy. Two implementations of the rule that decides whether an untrusted id
// may become a filename is how one of them ends up a character behind the other.
const hostEventsFileFor =
  typeof hostSidecar.eventsFileFor === 'function' ? hostSidecar.eventsFileFor : null;
const hostSafeName = typeof hostSidecar.safeName === 'function' ? hostSidecar.safeName : null;

// Contract: `~/.beezi-cursor`, BEEZI_HOME deliberately NOT honored (one data root per agent).
const CONTRACT_HOME = '.beezi-cursor';
const EVENTS_SUBDIR = 'events';

// Reached only when the writer did not hand over a path function. With the static import above that
// takes a writer whose `eventsFileFor` export has been renamed or removed, not a writer that failed
// to load — but the branch is kept rather than deleted, because it is the contract the two halves
// are pinned to and the cost of keeping it is a dead `if`.
//
// If the writer did not hand over its sanitizer either, this refuses every id, and that is the safe
// answer rather than a functional loss: inventing a second sanitizer to cover an export that is
// missing is exactly the duplicate this borrows its way out of. A copy of that rule used to live
// here, byte-identical to the writer's, which is how one of the two ends up a character behind the
// other and reads outside the events directory.
function contractEventsFile(conversationId) {
  const name = hostSafeName === null ? null : hostSafeName(conversationId);
  return name === null || name === undefined
    ? null
    : path.join(os.homedir(), CONTRACT_HOME, EVENTS_SUBDIR, `${name}.jsonl`);
}

// Absolute path of a conversation's event log, or null when the id cannot be turned into one. A null
// from the writer's own resolver is authoritative — it means the id was rejected as a filename, and
// re-deriving a path here would reintroduce exactly the traversal the writer refused.
export function eventsFile(conversationId, deps = {}) {
  if (typeof deps.eventsFile === 'function') return deps.eventsFile(conversationId);
  if (hostEventsFileFor) {
    try {
      const resolved = hostEventsFileFor(conversationId);
      return typeof resolved === 'string' && resolved !== '' ? resolved : null;
    } catch {
      return null;
    }
  }
  return contractEventsFile(conversationId);
}

// Every read of the stream, with the provenance a caller needs to tell "no events" from
// "no file" — the two look identical in an empty array and mean opposite things upstream.
// { events, exists, lineCount, skipped, truncatedTail }
export function readEventsDetailed(conversationId, deps = {}) {
  const empty = { events: [], exists: false, lineCount: 0, skipped: 0, truncatedTail: false };
  if (!conversationId) return empty;

  const file = eventsFile(conversationId, deps);
  if (file === null) return empty;

  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  let content;
  try {
    content = readFile(file);
  } catch {
    // ENOENT is the normal "this conversation has no sidecar yet" case; any other read failure is
    // equally un-actionable inside a hook. Both surface as exists:false, never as a throw.
    return empty;
  }
  if (typeof content !== 'string' || content === '') {
    return { ...empty, exists: true };
  }

  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');
  const events = [];
  let skipped = 0;
  let truncatedTail = false;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The writer appends concurrently, so an unparseable LAST line is a half-written record that
      // will be complete on the next read. Dropping it (rather than counting it) is what keeps the
      // segment bound stable: the next window picks the record up once it is whole.
      skipped += 1;
      if (i === raw.length - 1) truncatedTail = true;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    events.push(parsed);
  }

  return { events, exists: true, lineCount: raw.length, skipped, truncatedTail };
}

export function readEvents(conversationId, deps = {}) {
  return readEventsDetailed(conversationId, deps).events;
}

// Parse a JSONL buffer that starts on a line boundary.
//
// Returns the byte offset one past the last COMPLETE line, which is what makes resuming possible:
// a trailing partial write has no newline yet, so it is naturally excluded and will be read whole
// next time. Unparseable-but-complete lines are consumed byte-wise while contributing no event —
// the same rule readEventsDetailed already follows, so the byte offset and the event count always
// advance together.
function parseChunk(text, byteBase) {
  const events = [];
  let skipped = 0;
  let lineCount = 0;
  let truncatedTail = false;
  let consumed = 0;

  let cut = text.lastIndexOf('\n');
  const complete = cut === -1 ? '' : text.slice(0, cut + 1);
  const tail = cut === -1 ? text : text.slice(cut + 1);
  if (tail.trim() !== '') truncatedTail = true;
  consumed = Buffer.byteLength(complete, 'utf-8');

  for (const line of complete.split('\n')) {
    if (line === '') continue;
    lineCount += 1;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    events.push(parsed);
  }

  return { events, skipped, lineCount, truncatedTail, nextByte: byteBase + consumed };
}

// Read only what has been appended since a previous read.
//
// The sidecar is append-only and one file per conversation, so a byte offset recorded alongside the
// event cursor stays meaningful: everything before it has already been parsed and reported. Without
// this every checkpoint re-read and re-parsed the entire history to throw away the prefix — 56 ms
// at 50k events, 158 ms at 200k, paid against a 7.5 s hook budget, and growing for the life of the
// conversation.
//
// `start` is trusted only after it is checked against the file: the offset must not exceed the
// current size, and the byte before it must be a newline. A sidecar that was pruned and recreated,
// or truncated, fails one of those and falls back to a full read — correctness never depends on the
// offset being right, only speed does.
//
// Returns { events, exists, baseLine, nextByte, resumed, skipped, truncatedTail }, where `baseLine`
// is the event index the returned array starts at (0 on a full read).
export function readEventsFrom(conversationId, start = null, deps = {}) {
  const absent = { events: [], exists: false, baseLine: 0, nextByte: 0, resumed: false, skipped: 0, truncatedTail: false };
  if (!conversationId) return absent;

  const file = eventsFile(conversationId, deps);
  if (file === null) return absent;

  const startByte = start == null ? undefined : start.byte;
  const startLine = start == null ? undefined : start.line;
  const fromByte = Number.isFinite(startByte) ? Math.trunc(startByte) : 0;
  const fromLine = Number.isFinite(startLine) ? Math.trunc(startLine) : 0;
  const wantsResume = fromByte > 0 && fromLine >= 0 && typeof deps.readFile !== 'function';

  if (wantsResume) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const { size } = fs.fstatSync(fd);
      if (size >= fromByte) {
        // The byte before the offset must terminate a line, or the offset does not mean what it
        // meant when it was written (a different file now lives at this path).
        let boundaryOk = true;
        const probe = Buffer.alloc(1);
        if (fs.readSync(fd, probe, 0, 1, fromByte - 1) !== 1 || probe[0] !== 0x0a) boundaryOk = false;

        if (boundaryOk) {
          const length = size - fromByte;
          if (length === 0) {
            return { events: [], exists: true, baseLine: fromLine, nextByte: fromByte, resumed: true, skipped: 0, truncatedTail: false };
          }
          const buf = Buffer.alloc(length);
          const read = fs.readSync(fd, buf, 0, length, fromByte);
          const chunk = parseChunk(buf.subarray(0, read).toString('utf-8'), fromByte);
          return { ...chunk, exists: true, baseLine: fromLine, resumed: true };
        }
      }
    } catch {
      /* fall through to the full read */
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
  }

  const full = readEventsDetailed(conversationId, deps);
  if (!full.exists) return absent;
  // A full read has to report the byte offset too, or the next checkpoint cannot resume from it.
  let nextByte = 0;
  try {
    const raw = typeof deps.readFile === 'function' ? deps.readFile(file) : fs.readFileSync(file, 'utf-8');
    const cut = typeof raw === 'string' ? raw.lastIndexOf('\n') : -1;
    nextByte = cut === -1 ? 0 : Buffer.byteLength(raw.slice(0, cut + 1), 'utf-8');
  } catch { /* leave 0 — the next read is simply a full one again */ }
  return {
    events: full.events,
    exists: true,
    baseLine: 0,
    nextByte,
    resumed: false,
    skipped: full.skipped,
    truncatedTail: full.truncatedTail,
  };
}

// Segment bounds index THIS array, not the file's physical lines — a malformed record must not shift
// the meaning of a previously reported `to`, so the count is deliberately the parsed-event count.
export function countEvents(conversationId, deps = {}) {
  return readEventsDetailed(conversationId, deps).events.length;
}
