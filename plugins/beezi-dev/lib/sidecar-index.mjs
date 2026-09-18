import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { eventsDir, sessionStateFile } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { readEvents, readEventsDetailed as _readEventsDetailed } from './sidecar-read.mjs';
import { readJson } from './fs-store.mjs';

// Bumped whenever the material below changes shape, so a stored fingerprint from an older client
// can never compare equal to a differently-derived one.
const FINGERPRINT_VERSION = 'v1';

// Index of every past conversation this machine has recorded — the Cursor analog of the Claude
// plugin's transcript-index. The sidecar (not Cursor's own storage) is what gets enumerated:
// the hook scripts append to it unconditionally, linked or not, so an unlinked machine
// accumulates exactly the history the login-time backfill exists to upload. The horizon is
// pruneStale()'s 14 days — anything older is gone, which is also why the audit ledger lives
// outside the pruned dirs.

// Every recorded conversation: ~/.beezi-cursor/events/<conversation>.jsonl.
//
// Sorted oldest-first so an interrupted import advances chronologically. Best-effort throughout:
// an unreadable root yields [], an unreadable entry is skipped, nothing throws.
//
// The stem IS the conversation id for every id Cursor actually mints (UUID-shaped, already inside
// safeName's alphabet). An id that needed sanitizing cannot be recovered from its filename; the
// stem is used as-is, which still reads and reports the right file — at worst under the sanitized
// spelling of its own id.
export function listAllConversations({ dir = eventsDir() } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    // isFile() also stops a *directory* named "x.jsonl" from being read as a sidecar.
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    // A filename is only trusted as a conversation id when it ROUND-TRIPS: safeName is idempotent
    // over its own output, so `eventsFileFor(stem)` resolves back to the very file the stem was
    // read from — the same property the Claude plugin's SESSION_ID regex guarantees. A stem that
    // fails this (hand-planted junk, a stray temp file) is skipped rather than reported under an
    // identity the writer would never have produced. This is the whole check: an `^[A-Za-z0-9._-]+$`
    // regex used to guard it first, and was strictly weaker — it PASSES a leading-dot stem like
    // `.hidden`, which the round-trip catches, and says nothing about length or emptiness either.
    if (safeName(sessionId) !== sessionId) continue;
    const eventsPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      continue;
    }
    found.push({ sessionId, eventsPath, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// The cwd this conversation actually ran in.
//
// Not optional for the import: runCheckpoint attributes a segment with no resolvable repo root
// through its cwd, and with a null cwd there is no remote at all, so every such segment is
// silently dropped. A past session has no live hook payload to ask, so the sidecar is the only
// source — two generations of it:
//
//   1. The `cwd` field the hook scripts stamp on every event they append (added alongside this
//      module). First one wins.
//   2. History written before the stamp existed carries no cwd anywhere, but an `edit` line's
//      `path` is the absolute file Cursor reported editing — its directory is inside the
//      workspace, and resolveRepoRoot walks up from there. First absolute one wins.
//
// Returns null when neither exists (a conversation that edited nothing, recorded pre-stamp) —
// the audit reports those as unattributable rather than silently dropping them.
export function firstRecordedCwd(sessionId, deps = {}) {
  const read = deps.readEvents == null ? ((id) => readEvents(id)) : deps.readEvents;
  let events;
  try {
    events = read(sessionId);
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event != null && typeof event.cwd === 'string' && event.cwd !== '') return event.cwd;
  }
  for (const event of events) {
    if (event == null || event.ev !== 'edit' || typeof event.path !== 'string') continue;
    if (!path.isAbsolute(event.path)) continue;
    return path.dirname(event.path);
  }
  return null;
}

// When this conversation was last actually USED — the ts of its last event that is not
// `session_end`.
//
// Cursor re-fires session_end for every still-open tab when the app quits or restarts, and each
// firing appends a line here: a conversation forgotten in a background tab for a week is
// restamped (file mtime AND tail ts) on every launch. Any "is this session still in use" check
// keyed on the mtime therefore never expires. This scans for the last line recording real work
// (gen/tool/shell/edit/stop/subagent_*, anything the writer stamps except the lifecycle marker).
//
// Null when the sidecar holds nothing but lifecycle noise — such a session has no usage either,
// so misreading it costs nothing. The writer stamps ts on every event; a line without one is
// torn or foreign and is skipped rather than allowed to mask the timestamped activity before it.
export function lastActivityTs(sessionId, deps = {}) {
  const read = deps.readEvents == null ? ((id) => readEvents(id)) : deps.readEvents;
  let events;
  try {
    events = read(sessionId);
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event == null || event.ev === 'session_end') continue;
    if (Number.isFinite(event.ts)) return event.ts;
  }
  return null;
}

// How far live tracking has already read this conversation's sidecar (state/<id>.json's cursor),
// 0 when it was never checkpointed. state files are written only below runCheckpoint's token
// gate, so a nonzero cursor is proof the session queued at least one live segment — and the
// backfill must skip it: a backfilled `id:0-M` beside a live `id:0-N` has a different segmentId,
// so the server's idempotency upsert cannot collapse them and the overlap double-bills.
//
// This is a Cursor-specific belt on top of the ported linkedAt/trackingMode rule: it holds even
// if the server does not (yet) return a trackingMode for Cursor tenants.
//
// Scoped by `account` (tracking.mjs accountKey): the checkpoint stamps the account it reported
// under into the state, and the belt fires only when that stamp NAMES THE CURRENT ACCOUNT —
// segments queued under a different (or unknowable) one went to a different tenant, and the
// pull is per (tenant, user, tool), so skipping would rob the current tenant of history it
// never received. The same-tenant re-login case that used to lean on this belt is covered at
// its source instead: performLogin preserves the original linkedAt across a same-account
// re-login, so the audit's time rule keeps owning everything live-tracked since.
export function liveCursorOf(sessionId, { account = null } = {}) {
  const name = safeName(sessionId);
  if (name === null) return 0;
  // Through the shared builder, never a second `path.join(stateDir(), …)` spelled out here: a
  // reader whose path drifts from the writer's reads `cursor: 0` forever, and the belt then
  // silently stops firing — see lib/checkpoint.mjs stateFile().
  const state = readJson(sessionStateFile(name), null);
  const cursor = state == null ? undefined : state.cursor;
  if (!Number.isFinite(cursor) || cursor <= 0) return 0;
  if (state.account == null || account == null || state.account !== account) return 0;
  return cursor;
}

// How many events this conversation holds right now, and a fingerprint of the first `prefixLines`
// of them. `{ lines, fingerprint }`, or null when the sidecar cannot be read at all.
//
// WHY A FINGERPRINT AND NOT A SIZE. The repeatable sync records "I have delivered up to line N" and
// resumes from there on a later run. That cursor is only meaningful while line N still names the
// same line, and the cheap proxies do not establish it:
//
//   size   a sidecar truncated and re-appended reaches the same byte count with a completely
//          different history — and resuming from the old cursor then uploads a window that
//          overlaps what the server already holds, under a segmentId the server has never seen, so
//          its idempotency key cannot collapse the two.
//   mtime  moves on every append, including the appends that are exactly what makes resuming
//          legitimate. It is evidence of nothing in either direction.
//
// The prefix is hashed over the PARSED events, in the same coordinate system segment ids use
// (lib/sidecar-read.mjs's `countEvents` — a malformed record is consumed without shifting the
// meaning of a previously reported `to`). Hashing the whole prefix rather than a fixed-size head
// is deliberate: a head-only digest cannot see a rewrite past its own window, which is precisely
// the "same line space" masquerade this exists to catch.
//
// A `prefixLines` longer than the file yields `fingerprint: null` — there is no such prefix to
// identify, and the caller must treat that as "rescan", never as a match.
//
// A NULL `prefixLines` is the LINE-COUNT-ONLY form, and callers that only need `lines` should use
// it: the hash is a full parse plus a sha256 over the prefix, and paying for one that is then
// discarded is the same class of waste `createCheckpointCaches` exists to remove from the audit.
export function sidecarSnapshot(sessionId, prefixLines, deps = {}) {
  const read = deps.readEventsDetailed == null ? ((id) => _readEventsDetailed(id)) : deps.readEventsDetailed;
  let detailed;
  try {
    detailed = read(sessionId);
  } catch {
    return null;
  }
  if (detailed == null || detailed.exists !== true || !Array.isArray(detailed.events)) return null;
  const lines = detailed.events.length;
  const wanted = Number.isInteger(prefixLines) && prefixLines >= 0 ? prefixLines : -1;
  if (wanted < 0 || wanted > lines) return { lines, fingerprint: null };

  const hash = crypto.createHash('sha256');
  // The version prefix is part of the hashed material as well as the printed value: changing how
  // an event is serialised here must invalidate every stored fingerprint rather than silently
  // compare two different digests of the same file.
  hash.update(`${FINGERPRINT_VERSION}\n`);
  for (let i = 0; i < wanted; i += 1) {
    try {
      hash.update(`${JSON.stringify(detailed.events[i])}\n`);
    } catch {
      // An event that cannot be re-serialised cannot be fingerprinted, and a digest over "the
      // parts that happened to serialise" would compare equal across genuinely different files.
      return { lines, fingerprint: null };
    }
  }
  return { lines, fingerprint: `${FINGERPRINT_VERSION}:${hash.digest('hex').slice(0, 32)}` };
}
