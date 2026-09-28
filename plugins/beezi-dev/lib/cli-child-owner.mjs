import path from 'path';
import { stateDir } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// The durable ownership marker for a Cursor CLI subagent chat: "this conversation is a child of X".
//
// WHY IT EXISTS. The chat store is what proves a conversation is a CLI child (classifyCliChat in
// lib/cli-chats-cursor.mjs), and the chat store is not ours: the CLI can delete it, lock it, or move
// it, and a later hook, a backfill or a queue flush may run long after it is gone. Without a record of
// our own, a child's sidecar would come back as a standalone session the first time its store could
// not be read (Codex verification: "deleted/unavailable chat stores can later resurrect child
// sidecars as standalone sessions"). So the checkpoint writes this when the store proves a child,
// and every place that could report one reads it FIRST:
//
//   lib/checkpoint.mjs        the ownership guard, before any sidecar read, state write or POST
//   lib/queue-delivery.mjs    a queued non-subagent report under a child's id is dropped
//   lib/timeline-outbox.mjs   a child's queued timeline is dropped
//
// Only a POSITIVE fact is ever recorded. "Top-level" is never written down, because that answer can
// be wrong in a way this one cannot: an unreadable store that looked top-level today is a child
// tomorrow, while a store that named a parent will not un-name it.
//
// `<stateDir>/<safeName(id)>.cli-owner`, and NOT `.json`, which is load-bearing (controller amendment
// A1): lib/active-conversation.mjs treats every `state/*.json` as a conversation and would read a
// marker as a phantom session called `<id>.owner`. The pulse stamp (`.pulse`) follows the same rule.
// lib/prune.mjs sweeps every immediate file in the state dir, and gives this one its own, longer
// horizon (CHILD_OWNER_RETENTION_MS, below). The checkpoint REWRITES it on every guard hit and on
// every parent turn-end that sees the worker, so its mtime follows the activity of the child and of
// its parent rather than the first time it was seen.
//
// Content is `{ v: 1, parent, root, work? }`: ids, never a name, a title or anything from the store's
// meta row — plus, optionally, `work: { sig, code_changes, operations }`, the worker's own fold as
// last staged on its parent's subagent row (lib/checkpoint.mjs, the fold). Codex re-review (fix
// round 2): the backfill and sync keep no state, so a fold THEY sent was recorded nowhere, and once
// the worker's sidecar was pruned a later run sent the row bare and the server's upsert replaced
// the figures with nothing. This is the one record every mode can write and read. It is counts and
// extensions only, the same fields that go on the wire. Optional within version 1: a marker without
// it (every marker before this) is a valid marker with no fold on record, and a `work` that does
// not validate reads as none.
//
// A refresh that brings no fold KEEPS the one on record: the child's own checkpoint guard rewrites
// the marker with ids alone on every hit, and must not erase what its parent last sent.
//
// A fold also carries `account` (the key the checkpoint stamps into state, lib/tracking.mjs
// `currentAccountKey`) and `sentAt` (epoch ms when it was staged), because the marker is shared by
// every account and every mode on this machine (Codex re-review, fix round 3). The checkpoint reuses
// a fold only under the account that staged it, and picks the NEWEST across state and marker; here,
// a write never replaces a dated fold with an older or undated one. This module stores both and
// judges neither's meaning beyond that ordering. No import-time work: the node-floor check imports
// every lib module on its own.

const OWNER_VERSION = 1;

// How long lib/prune.mjs keeps an owner marker, far past the 30-day horizon of everything else in the
// state dir. A parent can be resumed long after its workers went quiet, and its chat store still
// lists them: without the marker (and the fold it keeps) such a resume would send each worker's row
// bare and wipe the fold the server holds (Codex re-review, fix round 3). A marker is a few hundred
// bytes per worker, so half a year of them costs nothing. The prune throttle is unchanged.
export const CHILD_OWNER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// The marker's file extension, shared with lib/prune.mjs so the two cannot drift apart.
export const CHILD_OWNER_EXT = '.cli-owner';

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A fold as the checkpoint stages it, or null. Copied through JSON, so what is stored is exactly the
// serialisable shape that went on the wire and nothing can alias the caller's objects.
// `account` and `sentAt` are kept when they are well-formed and omitted otherwise, so a fold staged
// before they existed reads back without them (and the checkpoint treats it as not ours).
function validWork(work) {
  if (!isPlainObject(work) || typeof work.sig !== 'string') return null;
  if (!isPlainObject(work.code_changes) || !isPlainObject(work.operations)) return null;
  try {
    return JSON.parse(JSON.stringify({
      sig: work.sig,
      code_changes: work.code_changes,
      operations: work.operations,
      ...(nonEmpty(work.account) === null ? {} : { account: work.account }),
      ...(Number.isFinite(work.sentAt) ? { sentAt: work.sentAt } : {}),
    }));
  } catch {
    return null;
  }
}

// Whether `incoming` may replace `existing`: never a dated fold by an older or undated one.
function mayReplace(existing, incoming) {
  if (existing === null || !Number.isFinite(existing.sentAt)) return true;
  return Number.isFinite(incoming.sentAt) && incoming.sentAt >= existing.sentAt;
}

// The marker path for one conversation, or null when the id cannot be made into a filename — the
// same sanitizer the state file, the lock and the sidecar use, so all of them agree on the name.
export function childOwnerFile(conversationId) {
  const name = safeName(conversationId);
  return name === null ? null : path.join(stateDir(), `${name}${CHILD_OWNER_EXT}`);
}

// `{ parent, root }` when this conversation is a recorded CLI child, else null, with `work` added
// only when a valid fold is on record (absent, not null, so an ids-only marker reads exactly as it
// always did). One small file read and no chat-store access at all, which is what lets the queue
// flush afford it per record. Never throws: an unreadable or foreign-shaped marker is no marker.
export function readChildOwner(conversationId) {
  const file = childOwnerFile(conversationId);
  if (file === null) return null;
  let raw = null;
  try { raw = readJson(file, null); } catch { raw = null; }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== OWNER_VERSION) return null;
  const parent = nonEmpty(raw.parent);
  const root = nonEmpty(raw.root);
  if (parent === null || root === null) return null;
  const work = validWork(raw.work);
  return work === null ? { parent, root } : { parent, root, work };
}

// Record (or refresh) that `conversationId` is a CLI child of `info.parent`, rooted at `info.root`.
// `root` falls back to `parent`: a child whose store names no root is a depth-1 worker, and its
// parent is its root. `info.work` replaces the fold on record when it is a valid one that is not
// older than it (see the header); otherwise the fold already on record is kept. Returns whether it
// wrote. Never throws — losing the marker costs one more chat-store read at the next checkpoint,
// never a report.
export function writeChildOwner(conversationId, info) {
  const file = childOwnerFile(conversationId);
  if (file === null || info == null) return false;
  const parent = nonEmpty(info.parent);
  if (parent === null) return false;
  const root = nonEmpty(info.root) === null ? parent : info.root;
  const existing = readChildOwner(conversationId);
  const kept = existing === null || existing.work === undefined ? null : existing.work;
  const incoming = validWork(info.work);
  const work = incoming !== null && mayReplace(kept, incoming) ? incoming : kept;
  try {
    writeJsonSecure(file, work === null ? { v: OWNER_VERSION, parent, root } : { v: OWNER_VERSION, parent, root, work });
    return true;
  } catch {
    return false;
  }
}
