import fs from 'fs';
import path from 'path';
import { cursorProjectsDir } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { classifyTurnError } from './session-error-cursor.mjs';

// Cursor's agent transcript → the turn errors it records, and nothing else.
//
// WHY A TRANSCRIPT, in a plugin otherwise built on NOT reading one (lib/delta-cursor.mjs,
// lib/sidecar.mjs): the reason a turn ended badly exists nowhere else. No hook payload carries the
// text — "You've hit your usage limit…", "User aborted request", "Agent turn stopped after repeated
// resume attempts made no progress" — only the `{"type":"turn_ended","status":…,"error":…}` line
// Cursor appends to `<projects>/<slug>/agent-transcripts/<id>/<id>.jsonl`. Observed 2026-09-28 on
// IDE and CLI sessions alike (127 transcripts): those lines carry no timestamp and no id at all.
//
// WHAT IS READ. The file is searched for the literal `"type":"turn_ended"`, and only the lines that
// contain it are parsed. The marker cannot occur inside a message: in JSONL a quote inside a string
// is written `\"`, so a prompt that quotes such a line never matches. Prompts, replies and tool calls
// are therefore never parsed, and of a turn_ended line only `status` and `error` are kept. The
// `subagents/` folder beside the file is never opened — a worker's turn is its parent's to report.
//
// THE ANCHOR is a COUNT of turn_ended lines, because a count is all such a line allows: no stamp to
// compare and no id to remember. lib/checkpoint.mjs stores it per session as `turnEndsSeen`.

const TURN_ENDED_MARKER = '"type":"turn_ended"';

// A transcript holds no tool output, so a real one is kilobytes (the largest of the 127 observed was
// 114 KB). The cap is for a file that is not what it claims to be: a hook must not read a gigabyte to
// find that out, and an oversized file answers "unreadable", which leaves the anchor where it was.
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

// The id as a path segment, or null. `safeName` is the one sanitizer for ids that become paths, and
// the result must EQUAL the id: a mangled name would look for some other conversation's file.
function transcriptName(sessionId) {
  const name = safeName(sessionId);
  return name !== null && name === sessionId ? name : null;
}

function isFile(fsImpl, file) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

// This conversation's transcript file, or null.
//
// The payload's `transcript_path` first, when it names `<id>/<id>.jsonl`. It is NOT required to sit
// under cursorProjectsDir(): CURSOR_DATA_DIR can relocate one and not the other, and the name check
// is what stops a payload path from opening some other file.
//
// Otherwise a scan, and deliberately NOT a slug derived from the cwd: on one machine Cursor spelled
// the same home `C-Users-…` for one session and `c-Users-…` for another, and some project folders
// hold no transcripts at all. The conversation id is unique, so it is looked for under every project
// folder — one readdir and one stat per folder, on turn-end paths only.
export function locateTranscript(sessionId, options = {}) {
  const fsImpl = options.fsImpl == null ? fs : options.fsImpl;
  const name = transcriptName(sessionId);
  if (name === null) return null;
  const hinted = options.transcriptPath;
  if (typeof hinted === 'string' && hinted !== ''
    && path.basename(hinted) === `${name}.jsonl`
    && path.basename(path.dirname(hinted)) === name
    && isFile(fsImpl, hinted)) {
    return hinted;
  }
  let root = options.projectsDir;
  if (typeof root !== 'string' || root === '') {
    try { root = cursorProjectsDir(); } catch { return null; }
  }
  let entries;
  try { entries = fsImpl.readdirSync(root); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(root, String(entry), 'agent-transcripts', name, `${name}.jsonl`);
    if (isFile(fsImpl, candidate)) return candidate;
  }
  return null;
}

// One candidate line → `{ status, message }`, or null when it is not a whole turn_ended record. A
// line still being appended fails to parse and is simply not counted yet; the next read counts it.
function parseTurnEnded(line) {
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type !== 'turn_ended') return null;
  return {
    status: typeof parsed.status === 'string' ? parsed.status : null,
    message: typeof parsed.error === 'string' ? parsed.error : null,
  };
}

// Every turn_ended record in the file, in file order, plus the file's mtime. Null — not zero turns —
// when the file cannot be read, so a transient failure never looks like a transcript that shrank.
export function readTurnEnds(file, options = {}) {
  const fsImpl = options.fsImpl == null ? fs : options.fsImpl;
  let stat;
  try { stat = fsImpl.statSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  let text;
  try { text = fsImpl.readFileSync(file, 'utf-8'); } catch { return null; }
  const turns = [];
  // `indexOf` over the whole text and a slice per hit: no split, so the message lines between hits
  // are never materialized as strings of their own.
  let at = text.indexOf(TURN_ENDED_MARKER);
  while (at !== -1) {
    const start = text.lastIndexOf('\n', at) + 1;
    const newline = text.indexOf('\n', at);
    const end = newline === -1 ? text.length : newline;
    const turn = parseTurnEnded(text.slice(start, end));
    if (turn !== null) turns.push(turn);
    at = newline === -1 ? -1 : text.indexOf(TURN_ENDED_MARKER, newline + 1);
  }
  return { turns, mtimeMs: stat.mtimeMs };
}

// The turns past the anchor, and the anchor to store next.
//
//   seen is a count         → everything after it. A file with FEWER lines than that was rewritten
//                             under us; its count is adopted and nothing is posted, because nothing
//                             in a rewritten file can be told apart from what was already reported.
//   no count, priorHistory  → only the LAST turn. A live run always passes priorHistory: true (see
//                             FIRST SIGHT in lib/checkpoint.mjs), so this is every session whose
//                             state has no turnEndsSeen yet — not only one tracked before this build
//                             read transcripts, but a fresh install, a session prune deleted, or one
//                             that predates this build too. Posting its whole history now would
//                             stamp every old abort with today's read.
//   no count, no priorHistory → every turn. Reached only by a backfill that could not borrow a live
//                             count (no live state yet, or one stamped with a different account); a
//                             live run never takes this branch.
export function unseenTurns(turns, seen, options = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const total = list.length;
  if (Number.isInteger(seen) && seen >= 0) {
    return { unseen: total < seen ? [] : list.slice(seen), seen: total };
  }
  if (options.priorHistory === true) {
    return { unseen: total === 0 ? [] : list.slice(total - 1), seen: total };
  }
  return { unseen: list.slice(), seen: total };
}

// The whole read for one session: locate, read, apply the anchor, classify. Null when there is no
// transcript to read, which the caller must treat as "leave the anchor alone".
//
// WHEN. A turn_ended line has no timestamp, so the stamp is the file's mtime, clamped to now. It is
// never earlier than the newest line and never later than the read, and it is EXACT when the error is
// the file's last line — the usage-limit turn that ends a session, where the sessionEnd that reads it
// may fire hours later and a hook clock would be hours wrong. An unchanged file also gives the same
// instant to every reader, so a live hook and a later backfill that both report one turn meet on the
// server's dedup key (session, code, minute) instead of making two rows.
//
// The cost, said out loud: every error found in ONE pass shares that minute, so repeats of one code in
// one pass become one row server-side (upsert). One pass per turn-end usually holds one new line; a
// backfill holds a session's whole history, so it lands as at most one row per code per session.
export function scanTurnErrors(sessionId, options = {}) {
  const file = locateTranscript(sessionId, options);
  if (file === null) return null;
  const read = readTurnEnds(file, options);
  if (read === null) return null;
  const next = unseenTurns(read.turns, options.seen, { priorHistory: options.priorHistory === true });
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const stampMs = Number.isFinite(read.mtimeMs) && read.mtimeMs <= nowMs ? read.mtimeMs : nowMs;
  const occurredAt = new Date(stampMs).toISOString();
  const payloads = [];
  for (const turn of next.unseen) {
    const classified = classifyTurnError(turn);
    if (classified === null) continue;
    // `lastAssistantMessage` is null by design: the text that explains the turn is the host's error,
    // not a reply, and it travels in `errorDetails` where the portal shows it.
    payloads.push({
      sessionId,
      error: classified.error,
      errorDetails: classified.errorDetails,
      lastAssistantMessage: null,
      occurredAt,
    });
  }
  return { seen: next.seen, payloads };
}
