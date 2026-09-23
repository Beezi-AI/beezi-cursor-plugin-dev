// The session-timeline outbox: the newest undelivered timeline body per conversation, kept on disk
// until the server confirms it.
//
// WHY IT EXISTS (plan Task 8, E11). The activity timeline is whole-session and is POSTed only at a
// turn-end (stop / sessionEnd). A failed POST used to be retried by "the next turn-end of the same
// session" and nothing else. The IDE gets a turn-end every turn, so that was enough there. The Cursor
// CLI does not: `agent -p` fires exactly one sessionEnd, and an interactive exit may fire none. So one
// failure — a network blip, a 401 under a token minted for another environment, the API down, the
// hook killed at exit — lost the session's timeline for good. Sessions 323cf93b and 4dea8842 were
// exactly that: attempted, never confirmed, no `sentTimelineSig`, and the portal drew no period
// lines and no subagent lanes for them.
//
// THE CONTRACT
//
//   write    lib/checkpoint.mjs writes `timelines/<safeName(id)>.json` BEFORE the POST, whenever the
//            derived signature differs from the last one confirmed. Overwritten, never appended:
//            the server upserts the timeline by sessionId, so the newest body is the only one worth
//            delivering. Atomic (temp + rename, via writeJsonSecure), so a hook killed mid-write
//            leaves the previous entry or the new one, never half of either.
//   confirm  a 2xx at the POST site deletes it.
//   drain    every flushQueue (every hook, and session start) sends up to OUTBOX_DRAIN_MAX of what
//            is left, oldest first, inside the same tracking gate, account fence and deadline as the
//            report queue — under the ONE auth snapshot flushQueue took before report delivery.
//   partial  a checkpoint whose deadline cut the CLI subagent listing short writes its timeline
//            flagged `partial: true`, and only when no entry exists (an existing one is never
//            overwritten by a timeline that may be missing lanes). The drain rebuilds a partial
//            entry from the sidecar before sending it, and sends only a rebuild that was complete.
//   expire   lib/prune.mjs sweeps `timelines/` on the same clock as the queue.
//
// This module must NOT import lib/checkpoint.mjs (which imports it): it builds the state path and
// takes the session lock itself, through the same owners checkpoint uses. No top-level work: the
// node-floor check imports every lib module in isolation.
import fs from 'fs';
import path from 'path';
import { sessionStateFile, timelineOutboxDir, timelineOutboxFile } from './paths-cursor.mjs';
import { safeName } from './sidecar.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { sessionLockPath, withLock } from './lock.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline-cursor.mjs';
import { POST_TIMEOUT_MS } from './http.mjs';
import { currentAccountKey } from './tracking.mjs';

// A version bump is how a future entry shape announces itself; this build leaves one it cannot read.
// `partial` is an optional flag on the same shape, not a new version: a build that predates it reads
// a partial entry as an ordinary one and sends it, which is exactly what it did before the flag.
export const OUTBOX_VERSION = 1;

// How many directory entries one drain may STAT. Codex review (DO NOT SHIP): the listing stat'ed the
// whole directory before the first budget check, so 10,000 stranded entries under an expired
// deadline cost 10,000 stats on a hook path. The names come from one `readdirSync`; only this many
// are stat'ed, the deadline checked between each, and the drain picks the oldest of those. Ten times
// OUTBOX_DRAIN_MAX, so foreign or contended entries in the window rarely starve the sends.
export const OUTBOX_LIST_MAX = 50;

// The signature the checkpoint compares against `state.sentTimelineSig`, in ONE place: the drain now
// rebuilds partial entries and records the rebuilt signature, and two copies of the formula would
// let the two sites disagree about what "already sent" means.
export function timelineSigOf(timeline) {
  return `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}`;
}

function currentAccountOf(deps) {
  const read = deps == null || deps.currentAccountKey == null ? () => currentAccountKey() : deps.currentAccountKey;
  try { return read(); } catch { return null; }
}

// The login a flush acts for, read ONCE: the auth epoch first (the queue's fence order), then the
// token, then the account key. Codex review (DO NOT SHIP), the blocking finding: flushQueue kept
// account A's token while the drain read a FRESH epoch and account after report delivery, so a
// login switch to B between the two stages let B's entries pass the account check and go out as
// `Bearer token-A` (and be deleted). Everything the drain compares against now comes from here.
// `deps.currentAccountKey` is the same seam the drain reads.
export async function takeAuthSnapshot(auth, deps = {}) {
  const epoch = await auth.authEpoch();
  const token = await auth.getToken();
  return { epoch, token, account: currentAccountOf(deps) };
}

// How many entries one flush may SEND. A cap on POSTs, not on files examined: a foreign-account
// entry, a contended session or an unreadable file costs no request, and counting them would let a
// handful of stranded entries (oldest on disk, so first in line on every flush) starve every
// current one. Small because the outbox rides on a flush that has already spent part of the hook's
// budget on the report queue, which matters more: reports carry the billing, timelines do not.
export const OUTBOX_DRAIN_MAX = 5;

// Answers that mean the server will never accept this body, whatever the token or the moment:
// malformed (400), too large (413), well-formed but invalid (422). Retrying one would spend a
// request on every hook until prune ages it out.
const PERMANENT_REJECTIONS = [400, 413, 422];

function isSuccess(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

// What `postSessionTimeline` answered, as one value for `state.timelineLastStatus`: the HTTP status
// when there was a response, otherwise the reason it gave (`network`, `no-token`, `no-transport`).
// The status used to be discarded, which is why E11 took a simulation to diagnose.
export function timelineStatusOf(result) {
  if (result == null) return null;
  if (typeof result.status === 'number') return result.status;
  return result.reason == null ? null : result.reason;
}

// The entry file for one conversation, or null when the id cannot be made into a filename — the
// same sanitizer the state file, the lock and the sidecar use, so all four agree on the name.
export function timelineOutboxFileFor(sessionId) {
  const name = safeName(sessionId);
  return name === null ? null : timelineOutboxFile(name);
}

// Record the body about to be POSTed. Returns whether it was written. Never throws: the outbox is a
// retry path, and a full disk must not cost the POST it is about to make.
export function writeTimelineOutbox(sessionId, { sig, body, account = null, partial = false }, { now = Date.now } = {}) {
  const file = timelineOutboxFileFor(sessionId);
  if (file === null) return false;
  try {
    writeJsonSecure(file, {
      v: OUTBOX_VERSION,
      sessionId,
      sig,
      body,
      // The account key the body was built under (lib/tracking.mjs `currentAccountKey`, the same
      // stamp pending batches carry). The drain refuses to send it under any other.
      account: account == null ? null : account,
      createdAt: now(),
      // Omitted rather than `false`, so a complete entry is byte-for-byte what it always was.
      ...(partial === true ? { partial: true } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

// The conversation's readable entry, or null. The checkpoint asks before writing a partial timeline:
// one that may be missing lanes must never replace an entry that has them.
export function readTimelineOutbox(sessionId) {
  const file = timelineOutboxFileFor(sessionId);
  if (file === null) return null;
  try { return readEntry(file); } catch { return null; }
}

// Delete one conversation's entry. Idempotent, never throws.
export function dropTimelineOutbox(sessionId) {
  const file = timelineOutboxFileFor(sessionId);
  if (file === null) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// A record this build can send. Anything else is left on disk for prune rather than deleted: an
// unreadable entry is the only evidence of whatever wrote it (the queue's quarantine reasoning).
// `periods` is checked because `postSessionTimeline` refuses a body without it, before any request.
function readEntry(filePath) {
  const entry = readJson(filePath, null);
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.v !== OUTBOX_VERSION) return null;
  if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return null;
  if (typeof entry.sig !== 'string') return null;
  const body = entry.body;
  if (body == null || typeof body !== 'object' || !Array.isArray(body.periods)) return null;
  return entry;
}

// Strict equality with null normalised, exactly as checkpoint's `classifyPendingBatch` compares a
// pending batch's account: an entry stamped before any login recorded an email carries `null`, and
// it is this machine's own only while that is still true.
function sameAccountKey(a, b) {
  return (a == null ? null : a) === (b == null ? null : b);
}

// Apply the drain's verdict to the session's state file, under the session lock the caller holds.
// Only an EXISTING state file is touched: creating one would plant `cursor: 0` for a session this
// machine may no longer track. Best-effort — losing `sentTimelineSig` costs one duplicate upsert at
// that session's next turn-end, and the server upserts.
//
// The file's mtime is PUT BACK after the write. lib/active-conversation.mjs ranks conversations by
// state-file mtime to decide which one `/beezi:track` saves, and the atomic rename stamps "now": a
// session-start drain delivering yesterday's CLI timeline would otherwise make yesterday's session
// the "active" one. It also keeps prune's clock on the session's own activity, not on our retries.
function markState(sessionId, patch) {
  const name = safeName(sessionId);
  if (name === null) return;
  const file = sessionStateFile(name);
  let stat = null;
  try { stat = fs.statSync(file); } catch { return; }
  const state = readJson(file, null);
  if (state == null || typeof state !== 'object' || Array.isArray(state)) return;
  try { writeJsonSecure(file, Object.assign(state, patch)); } catch { return; }
  try { fs.utimesSync(file, stat.atime, stat.mtime); } catch { /* ranking drifts by one entry at worst */ }
}

// The entry names on disk, from ONE directory read and nothing else. `.json` only: the atomic
// writer's temp file lives in the same directory and belongs to a writer that is still running.
function entryNames(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => path.extname(name) === '.json');
}

// At most OUTBOX_LIST_MAX of `names`, stat'ed with the deadline checked before each one, oldest
// first by mtime. The writer never rewrites an entry except to replace its body, so mtime is "when
// this session's newest undelivered timeline was built". `examined` is how many names were looked
// at, so the caller can count the rest as deferred.
//
// With more names than the window, the window starts at a random offset (wrapping): a fixed start
// would put the same 50 names first on every flush, and 50 entries that are never sent (another
// account's, left for prune) would then hide every current one behind them indefinitely.
function listEntries(dir, names, outOfBudget, random) {
  const total = names.length;
  const window = Math.min(total, OUTBOX_LIST_MAX);
  const start = total > OUTBOX_LIST_MAX ? Math.floor(random() * total) % total : 0;
  const files = [];
  let examined = 0;
  for (; examined < window; examined += 1) {
    if (outOfBudget()) break;
    const name = names[(start + examined) % total];
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) files.push({ filePath, name, mtimeMs: stat.mtimeMs });
    } catch { /* gone between readdir and stat */ }
  }
  files.sort((a, b) => (a.mtimeMs - b.mtimeMs) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, examined };
}

const CONTENDED = Symbol('contended');
const FENCED = Symbol('fenced');
const GONE = Symbol('gone');
const FOREIGN = Symbol('foreign');
const BUDGET = Symbol('budget');
const SENT = Symbol('sent');
const DROPPED = Symbol('dropped');
const KEPT = Symbol('kept');
const PARKED = Symbol('parked');

// Rebuild a partial entry's timeline from the sidecar, the way the checkpoint builds it, and say
// whether the CLI subagent listing inside it ran to the end. INCOMPLETE when it did not: the drain
// then keeps the entry instead of sending a body that may be missing lanes (Codex review, the
// "exhausted checkpoint destroys queued subagent lanes" finding). Null when there is nothing worth
// sending (no sidecar left, or an empty timeline, which the checkpoint would not POST either).
const INCOMPLETE = Symbol('incomplete');
function rebuildTimeline(sessionId, { deadlineAt, now, timelineOptions, deps }) {
  let complete = true;
  let timeline = null;
  try {
    timeline = computeSessionTimeline(
      sessionId,
      {
        // The chat-store reader stops opening stores at this instant, on this clock.
        ...(deadlineAt === null ? {} : { deadline: deadlineAt }),
        now,
        ...(deps.listCliSubagents == null ? {} : { listCliSubagents: deps.listCliSubagents }),
        onEnrichment: (info) => { if (info == null || info.complete !== true) complete = false; },
      },
      timelineOptions == null ? {} : timelineOptions,
    );
  } catch {
    return null;
  }
  if (!complete) return INCOMPLETE;
  if (timeline == null || (timeline.periods.length === 0 && timeline.subagents.length === 0 && timeline.plan_events.length === 0)) {
    return null;
  }
  return { body: { sessionId, ...timeline }, sig: timelineSigOf(timeline) };
}

// Drain the outbox. Called by checkpoint's `flushQueue` after report delivery, and only when that
// delivery was not gated by the tenant policy.
//
// `auth` is the same `{ getToken, forceRefresh, authEpoch }` seam the queue uses, and the rules are
// the queue's, restated for a per-session file:
//
//   SNAPSHOT   `snapshot` is `{ token, epoch, account }` from `takeAuthSnapshot`, taken by flushQueue
//              BEFORE report delivery and shared with it. The drain never re-reads any of the three
//              for itself (Codex review, the blocking cross-tenant finding: re-reading them after
//              report delivery let a login switch send B's entries under A's token). A direct caller
//              that passes none gets one taken here, at the start of the drain.
//   BUDGET     `deadlineAt` is absolute epoch ms. No POST starts once it has passed, and each one is
//              bounded by what is left of it: `max(1, min(POST_TIMEOUT_MS, remaining))`, the queue's
//              exact rule, so the two cannot disagree about what "out of budget" means. It is checked
//              before the directory is stat'ed at all, and between stats (OUTBOX_LIST_MAX).
//   401        one forced refresh per drain, then the same body again under the new token.
//   FENCE      before the first entry, before every send and after the refresh, the live auth epoch
//              AND the live account key are compared with the snapshot; either one moving stops the
//              drain. The account is checked on its own because an epoch is not guaranteed to move
//              with it. An entry whose stamped account differs from the snapshot's is never sent and
//              never deleted (pending batches get the same treatment; prune collects).
//   LOCK       each entry is handled under its session's lock, which is the lock the checkpoint holds
//              around its own timeline POST. Without it a drain overlapping that session's turn-end
//              could land an OLDER body on top of the newer one, delete the newer entry, or rewind
//              `sentTimelineSig`. Contention skips, like every other holder of that lock.
//   PARTIAL    an entry flagged `partial` is rebuilt (rebuildTimeline) before it is sent, under the
//              same lock and deadline, and sent only when the rebuild was complete. The rebuilt body
//              replaces the entry before the POST, exactly as the checkpoint writes before its own,
//              and a delivery records the REBUILT signature, never the partial one's.
//
// `skipSessionId` is the session the calling checkpoint JUST tried and failed with anything but a
// 401. Retrying it milliseconds later against the same stalled server would spend another request's
// worth of a 7.5 s budget on a near-certain repeat. A 401 is not skipped: the refresh is here.
//
// `timelineOptions` is what the checkpoint hands computeSessionTimeline (`allowBreakState`), so a
// rebuilt timeline classifies exactly as the checkpoint's would have.
//
// Never throws. Returns counts for the caller's diagnostics.
export async function drainTimelineOutbox({
  auth, snapshot = null, deadlineAt = null, skipSessionId = null, timelineOptions = null, deps = {},
} = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const dir = deps.outboxDir == null ? timelineOutboxDir() : deps.outboxDir;
  const random = deps.random == null ? Math.random : deps.random;
  const result = { sent: 0, dropped: 0, kept: 0, foreign: 0, contended: 0, skipped: 0, deferred: 0 };

  try {
    const snap = snapshot == null ? await takeAuthSnapshot(auth, deps) : snapshot;
    let token = snap.token;
    if (token == null || token === '') return result;
    const account = snap.account == null ? null : snap.account;

    const outOfBudget = () => deadlineAt !== null && now() >= deadlineAt;
    const perRequestMs = () => (deadlineAt === null ? undefined : Math.max(1, Math.min(POST_TIMEOUT_MS, deadlineAt - now())));
    const sameLogin = async () => (await auth.authEpoch()) === snap.epoch && sameAccountKey(currentAccountOf(deps), account);

    // One directory read, and then nothing more when the budget is already gone or the login has
    // already moved: every name is simply still waiting. No stat is spent on either.
    const names = entryNames(dir);
    if (names.length === 0) return result;
    if (outOfBudget() || !(await sameLogin())) {
      result.deferred += names.length;
      return result;
    }

    const { files, examined } = listEntries(dir, names, outOfBudget, random);
    // Names outside the stat window (or past a deadline that fell mid-listing) wait for a later flush.
    result.deferred += names.length - examined;
    if (files.length === 0) return result;

    let refreshed = false;
    let posts = 0;

    const post = (body) => {
      const timeoutMs = perRequestMs();
      return postSessionTimeline(body, token, {
        ...(deps.fetchImpl == null ? {} : { fetchImpl: deps.fetchImpl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    };

    // One entry, under its session's lock. Re-read INSIDE the lock: the checkpoint may have replaced
    // the body since the peek, and the newest one is the one to send.
    const deliverOne = async (filePath) => {
      const entry = readEntry(filePath);
      if (entry === null) return GONE;
      if (!sameAccountKey(entry.account, account)) return FOREIGN;
      if (!(await sameLogin())) return FENCED;
      if (outOfBudget()) return BUDGET;

      let body = entry.body;
      let sig = entry.sig;
      if (entry.partial === true) {
        const rebuilt = rebuildTimeline(entry.sessionId, { deadlineAt, now, timelineOptions, deps });
        // Cut short by the deadline: nothing else fits in this flush either.
        if (rebuilt === INCOMPLETE) return BUDGET;
        // Nothing to rebuild from. Kept, never sent as it stands; prune collects it.
        if (rebuilt === null) return PARKED;
        body = rebuilt.body;
        sig = rebuilt.sig;
        writeTimelineOutbox(entry.sessionId, { sig, body, account: entry.account }, { now });
        if (outOfBudget()) return BUDGET;
      }

      posts += 1;
      let res = await post(body);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        let renewal = null;
        try { renewal = await auth.forceRefresh(); } catch { renewal = null; }
        // The refresh landed on a different account: this body is the previous one's. Kept, not
        // sent, and the drain stops.
        if (!(await sameLogin())) return FENCED;
        const usable = renewal != null && renewal.ok === true && typeof renewal.token === 'string' && renewal.token !== '';
        if (usable && !outOfBudget()) {
          token = renewal.token;
          res = await post(body);
        }
      }

      const status = timelineStatusOf(res);
      if (isSuccess(status)) {
        // Deleted before the state write: a delivered body left on disk is re-sent on every hook,
        // while a lost signature costs one duplicate upsert at the next turn-end.
        try { fs.unlinkSync(filePath); } catch { /* scanner holding a handle; re-sent, upserted */ }
        markState(entry.sessionId, { sentTimelineSig: sig, timelineLastStatus: status });
        return SENT;
      }
      if (PERMANENT_REJECTIONS.indexOf(status) !== -1) {
        try { fs.unlinkSync(filePath); } catch { /* prune collects it */ }
        markState(entry.sessionId, { timelineLastStatus: status });
        return DROPPED;
      }
      // 401 after the refresh, 403, 5xx, network, timeout: the moment, not the body. Kept, and the
      // state is NOT rewritten: this branch repeats on every hook for as long as the server is down,
      // and the checkpoint's own POST site already recorded that session's last answer.
      return KEPT;
    };

    for (let index = 0; index < files.length; index += 1) {
      if (posts >= OUTBOX_DRAIN_MAX || outOfBudget()) {
        result.deferred += files.length - index;
        break;
      }
      const { filePath } = files[index];
      // A cheap peek OUTSIDE the lock, to learn which session's lock to take and to pass over what
      // will not be sent without taking any lock at all.
      const peek = readEntry(filePath);
      if (peek === null) { result.skipped += 1; continue; }
      if (skipSessionId != null && peek.sessionId === skipSessionId) { result.skipped += 1; continue; }
      if (!sameAccountKey(peek.account, account)) { result.foreign += 1; continue; }
      // The lock guards `timelines/<safeName(sessionId)>.json`; a file under any other name (copied
      // in by hand, or from a build that named them differently) would be sent unguarded.
      if (path.basename(filePath) !== `${safeName(peek.sessionId)}.json`) {
        result.skipped += 1;
        continue;
      }

      const verdict = await withLock(sessionLockPath(peek.sessionId), () => deliverOne(filePath), { now, miss: CONTENDED });
      if (verdict === CONTENDED) result.contended += 1;
      else if (verdict === SENT) result.sent += 1;
      else if (verdict === DROPPED) result.dropped += 1;
      else if (verdict === KEPT) {
        // Stop at the first transient failure. The queue backs off a record whose POST timed out so
        // one stalled server cannot eat every hook's budget (test/flush-budget.test.mjs); the outbox
        // keeps no retry state, and `postSessionTimeline` reports an instant refusal and a 3 s
        // timeout alike as `network`, so the cheap equivalent is not to try the next entry against
        // the same unhappy server. Without this a stall costs up to 5 x 3 s on every tool hook.
        result.kept += 1;
        result.deferred += files.length - index - 1;
        break;
      } else if (verdict === FOREIGN) result.foreign += 1;
      else if (verdict === GONE || verdict === PARKED) result.skipped += 1;
      else if (verdict === FENCED || verdict === BUDGET) {
        result.deferred += files.length - index;
        break;
      }
    }
  } catch { /* best-effort: never out of a hook path */ }

  return result;
}
