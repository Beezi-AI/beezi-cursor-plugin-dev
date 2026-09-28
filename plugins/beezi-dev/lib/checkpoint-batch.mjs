import fs from 'fs';
import { pendingBatchFile } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// The pending-batch record lib/checkpoint.mjs writes around every durable report window: its
// format, where it lives, and how a recovered one is read. The ordering contract below is the one
// `runCheckpoint`'s "C-10" steps follow; the steps themselves stay in that function, because they
// interleave with the state commit it owns. This module decides nothing about WHEN a batch is
// written, only what one is.

// ── the pending batch
//
// `state/<id>.json` is COMMITTED TRUTH — cursor, cursorBytes, usageSnapshot, coveredIntervals,
// anchor. A pending batch is UNCOMMITTED INTENT. They are two files because one atomic write
// cannot carry both: a crash between "the batch is durable" and "the state is committed" would be
// indistinguishable from "neither happened", which is the exact ambiguity this record exists to
// remove. With it, the disk always says which of the two it is.
//
// The ordering contract, and every step of it is load-bearing:
//
//   1. build the payloads and the proposed `next`   — nothing durable yet
//   2. write this record, atomically, BEFORE the first enqueue
//   3. `enqueueIfAbsent` every item, in order
//   4. only then apply `next` and save the state
//   5. only then unlink this record
//
// A crash at any point leaves either no record (nothing happened) or a record whose `next.cursor`
// against the live `state.cursor` says exactly which half landed.
export const PENDING_VERSION = 1;

// What a recovered record means for this run.
export const PENDING = Object.freeze({
  // No record, or nothing to do.
  NONE: 'none',
  // Items may not all be queued and `next` is not committed: replay steps 3-4-5 and STOP. The
  // frozen window is what gets committed, never a re-read of a sidecar that has grown since.
  RESUME: 'resume',
  // `next` is already committed; only the unlink was lost. Delete and carry on normally.
  DONE: 'done',
  // Another account's batch, an unknown version, or a malformed record. Do NOT enqueue and do NOT
  // commit: putting another tenant's payloads on the wire under these credentials, or advancing
  // this account's cursor over work reported to a different one, are both worse than one orphaned
  // file. lib/prune.mjs's 14-day sweep collects it.
  FOREIGN: 'foreign',
});

function pendingFile(id) {
  const name = safeName(id);
  return name === null ? null : pendingBatchFile(name);
}

export function loadPendingBatch(id) {
  const file = pendingFile(id);
  return file === null ? null : readJson(file, null);
}

export function savePendingBatch(id, batch) {
  const file = pendingFile(id);
  // Unreachable in practice: an id with no safe filename has no session lock either, so the guarded
  // section this is called from never runs. Here so the writer cannot drift from `loadPendingBatch`.
  if (file === null) throw new Error('beezi: session id cannot be made into a filename');
  writeJsonSecure(file, batch);
}

export function dropPendingBatch(id) {
  const file = pendingFile(id);
  if (file === null) return;
  try { fs.unlinkSync(file); } catch { /* already gone — the delete is idempotent by design */ }
}

// `account` is the stamp THIS run reports under; `cursor` is the live `state.cursor`.
export function classifyPendingBatch(batch, sessionId, account, cursor) {
  if (batch == null || typeof batch !== 'object') return PENDING.NONE;
  // Every one of these is "a record this build cannot reason about", and the answer to all of them
  // is the same: leave it alone. A version bump is how a future shape announces itself.
  if (batch.version !== PENDING_VERSION) return PENDING.FOREIGN;
  if (batch.sessionId !== sessionId) return PENDING.FOREIGN;
  if (!Array.isArray(batch.items)) return PENDING.FOREIGN;
  if (batch.next == null || typeof batch.next !== 'object') return PENDING.FOREIGN;
  // A cursor-less commit is legitimate, not malformed: the session-name replay stages the anchor
  // again with a corrected name and commits `{ sentSessionName }` alone, leaving the cursor exactly
  // where it was. Reading that as FOREIGN would strand a perfectly ordinary record — never
  // enqueued, never committed — until the 14-day sweep, and lose the rename with it.
  if (batch.next.cursor !== undefined && !Number.isFinite(batch.next.cursor)) return PENDING.FOREIGN;
  // Strict equality, null included: a batch built before any login recorded an email carries
  // `account: null`, and it is this machine's own only while that is still true.
  if ((batch.account == null ? null : batch.account) !== (account == null ? null : account)) {
    return PENDING.FOREIGN;
  }
  // With no cursor in the commit there is nothing to compare, so "has this already landed?" cannot
  // be answered from the cursor. RESUME is the safe answer: `enqueueIfAbsent` will not rewrite a
  // queue file that is already there, and re-applying a `sentSessionName` is idempotent.
  if (batch.next.cursor === undefined) return PENDING.RESUME;
  return cursor >= batch.next.cursor ? PENDING.DONE : PENDING.RESUME;
}
