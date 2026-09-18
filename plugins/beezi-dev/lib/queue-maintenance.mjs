// Housekeeping for report-queue records that delivery cannot move: how OLD a queued record is,
// and when a policy hold has held it long enough to drop.
//
// ── WHY THE AGE NEEDS A MIGRATION, AND WHY IT LIVES HERE ────────────────────────────────────────
//
// `_retry.firstQueuedAt` (lib/queue-backoff.mjs) is a FAILURE clock, not an enqueue clock: it is
// stamped the first time a POST for that record is refused and is absent before then. That is the
// right clock for the 14-day give-up rule, because a record only gets there by failing.
//
// A policy hold is the opposite case. When the tenant's tracking mode is `disabled`, nothing in the
// queue is attempted AT ALL — so no record ever earns a stamp, and a hold sweep keyed only off
// `firstQueuedAt` would find nothing to sweep, ever. Those records would sit until prune.mjs's
// unrelated 14-day mtime rule happened to reach them, four times longer than the hold.
//
// The fallback is the file's original mtime, and the reason it cannot simply be read at sweep time
// is the one trap in this file: recording a retry REWRITES the queue file, which refreshes its
// mtime. The moment a held record is attempted once, its mtime becomes "now" and the only surviving
// record of when it was enqueued is gone. So the delivery path calls `seedFirstQueuedAt` to persist
// the mtime ONTO the record before the first retry rewrite, and `recordFailure` carries that value
// forward untouched from then on. Read plus write, in that order, once.
//
// What this module deliberately does NOT do: delete anything it could not parse. A record whose
// JSON is malformed is evidence and belongs to lib/queue-delivery.mjs's quarantine, which renames
// it rather than erasing it. The sweep counts those and walks on.
import fs from 'fs';
import path from 'path';
import { queueDir } from './paths-cursor.mjs';

// Three days of QUEUE age, and its own constant rather than an import of queue-backoff's 14-day
// MAX_QUEUE_AGE_MS: those two numbers answer different questions ("the server keeps refusing this"
// versus "the tenant has tracking off"), and sharing one constant is how a change to either policy
// silently becomes a change to both.
export const QUEUE_HOLD_MS = 3 * 24 * 60 * 60 * 1000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstQueuedAtOf(payload) {
  const retry = payload == null || typeof payload !== 'object' ? undefined : payload._retry;
  const first = retry == null || typeof retry !== 'object' ? undefined : retry.firstQueuedAt;
  return finite(first) ? first : null;
}

function mtimeOf(stat) {
  const mtimeMs = stat == null || typeof stat !== 'object' ? undefined : stat.mtimeMs;
  return finite(mtimeMs) ? mtimeMs : null;
}

// How long this record has been in the queue, in ms, or null when neither clock is readable.
//
// The result may be NEGATIVE, and that is load-bearing: a machine whose clock jumped forward (an
// NTP correction after a VM resume, a dual-boot RTC offset) stamps timestamps in the future, and
// the caller must read that as "not expired" rather than as an enormous age. Returning the raw
// difference keeps that decision at the one comparison below instead of hiding it in a clamp.
export function queueAgeMs(payload, stat, now) {
  const first = firstQueuedAtOf(payload);
  const from = first === null ? mtimeOf(stat) : first;
  if (from === null) return null;
  return now - from;
}

// Persist the mtime fallback onto a record that has never failed, so the first retry rewrite — which
// refreshes the mtime — cannot erase the only clock the hold sweep has. Pure: a caller that fails to
// write the result has not corrupted its in-memory copy.
//
// `attempts: 0` / `nextAttemptAt: 0` say plainly that nothing has been attempted yet: `isDue` reads
// a nextAttemptAt of 0 as due (it is <= any now), and `recordFailure` starts counting from 0, so
// seeding costs the record neither a retry nor a delay.
export function seedFirstQueuedAt(payload, stat) {
  if (payload == null || typeof payload !== 'object') return payload;
  if (firstQueuedAtOf(payload) !== null) return payload;
  const mtimeMs = mtimeOf(stat);
  if (mtimeMs === null) return payload;
  return { ...payload, _retry: { attempts: 0, nextAttemptAt: 0, firstQueuedAt: mtimeMs } };
}

// Drop queued records that have been held past `maxAgeMs`.
//
// Returns { swept, kept, stuck, corrupt }: swept = deleted, kept = still inside the hold (or of
// unknowable age, which is always kept), stuck = expired but the unlink failed, corrupt = could not
// be parsed and was left for the delivery path to quarantine.
export function sweepHeldQueue({ now, maxAgeMs = QUEUE_HOLD_MS, fsImpl = fs, dir = null } = {}) {
  const result = { swept: 0, kept: 0, stuck: 0, corrupt: 0 };
  const at = typeof now === 'number' ? now : Date.now();
  const target = dir == null ? queueDir() : dir;

  let files;
  try {
    files = fsImpl.readdirSync(target);
  } catch {
    // No queue directory yet, or an unreadable one — nothing to sweep and nothing to report.
    return result;
  }

  for (const file of files) {
    // `.tmp` is a half-written record whose writer still owns it, and `.corrupt` is quarantined
    // evidence with its own retention. Neither is a deliverable record, so neither is this sweep's
    // to age out. Same filter, same reasoning, as lib/queue-delivery.mjs.
    if (path.extname(file) !== '.json') continue;
    const filePath = path.join(target, file);

    let stat = null;
    try { stat = fsImpl.statSync(filePath); } catch { stat = null; }

    // Read and parse separately, because they are different verdicts. A file that vanished between
    // the readdir and here was delivered by a concurrent flush and is nobody's problem; a file whose
    // BYTES are not JSON is corrupt. lib/fs-store.mjs's readJson collapses both into null and takes
    // no fs seam, so the two steps are spelled out.
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      // NOT deleted: a record that cannot be parsed is the only evidence of whatever wrote it, and
      // erasing it here would beat the quarantine to it.
      result.corrupt += 1;
      continue;
    }

    const age = queueAgeMs(payload, stat, at);
    // Unknowable age and future timestamps both land here. Keeping is the conservative answer: the
    // queue file is the only copy of that segment, and prune.mjs still bounds the directory.
    if (age === null || age <= maxAgeMs) {
      result.kept += 1;
      continue;
    }

    try {
      fsImpl.unlinkSync(filePath);
      result.swept += 1;
    } catch {
      result.stuck += 1;
    }
  }

  return result;
}
