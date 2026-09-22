import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { readJson } from './fs-store.mjs';
import { removeSync } from './fs-compat.mjs';

// Where self-diagnostics live, and the one mutex that guards destructive transitions over them.
//
// Deliberately a module of its own rather than three lines inside telemetry-consent.mjs: the
// consent gate, the recorder, the transport, the identity and the worker all need these paths and
// this lock, and the recorder needs the gate. Putting the paths where the gate is would make the
// import graph a cycle; putting them here makes it a tree.
//
// Everything sits under `<home>/telemetry/` and NOT under `state/`, `queue/` or `events/`. Those
// three are swept by lib/prune.mjs on a 14-day mtime rule, and a consent record that expired would
// read as "absent", which this plugin's own contract defines as DENY — a user who opted in would
// be silently opted out a fortnight later, and (worse) a user who opted OUT would have their
// denial forgotten. Diagnostics carry their own retention instead; see lib/telemetry-recorder.mjs.

export function telemetryDir(home) {
  return path.join(home == null ? beeziCursorHome() : home, 'telemetry');
}

// The consent record. One file, one version, read by every path that could emit anything.
export function telemetryConsentFile(home) {
  return path.join(telemetryDir(home), 'consent.json');
}

// Pending events, one JSON per folded event. A subdirectory rather than the telemetry root so
// "delete everything pending" is a bounded readdir of files nobody else writes — the consent
// record and the installation identity are siblings of this directory, not members of it, and a
// purge must not take either with it by accident.
export function telemetryQueueDir(home) {
  return path.join(telemetryDir(home), 'pending');
}

// Records that could not be parsed. Kept (briefly) rather than deleted: an event file that
// consistently fails to parse is itself evidence about the writer, and the recorder's retention
// sweep expires this directory on the same 14-day clock as the queue.
export function telemetryQuarantineDir(home) {
  return path.join(telemetryDir(home), 'corrupt');
}

// Attempt counter and next-attempt time for the sender. Separate from the events so a backoff
// write cannot corrupt a report and a purge cannot lose the backoff.
export function telemetrySendStateFile(home) {
  return path.join(telemetryDir(home), 'send-state.json');
}

// The consented correlation identity. A sibling of the queue directory, not a member: `off`
// removes it explicitly (see rotateInstallation in lib/telemetry-installation.mjs), and a queue
// purge that happened to also delete it would make that explicitness a coincidence.
export function installationFile(home) {
  return path.join(telemetryDir(home), 'installation.json');
}

// The two diagnostics routes, verified against the controller at portal commit 871a788
// (`api/src/api/controllers/cli-agent-public-diagnostics.controller.ts`). They live here, in the
// module with no dependencies of its own, so the identity module and the transport can both name
// them without importing each other — lib/config.mjs is integration-owned and has no diagnostics
// entries yet, and the handoff carries that ENDPOINTS patch.
export const DIAGNOSTICS_PATHS = Object.freeze({
  public: '/cli-agent/plugin-diagnostics/public',
  installation: '/cli-agent/plugin-diagnostics/installation',
});

export function telemetryLockDir(home) {
  return path.join(telemetryDir(home), 'telemetry.lock');
}

// A SECOND, much shorter-lived mutex, held only around a read-modify-write of the consent record.
//
// Deliberately not the delivery lock. The worker holds that one for the length of a batch, and a
// user typing `beezi telemetry off` must never be made to wait on a network round trip to have
// their denial recorded — deferring the queue purge is safe (the worker rechecks consent and
// purges it itself), deferring the DECISION is not. Nothing that sends anything takes this lock, so
// the only contention it ever sees is one sub-millisecond write against another.
export function consentLockDir(home) {
  return path.join(telemetryDir(home), 'consent.lock');
}

// The consent writers are two file operations long. A holder older than this crashed.
export const CONSENT_LOCK_STALE_MS = 5 * 1000;

// "The one-time notice has been shown", in a file of its OWN rather than a field on the consent
// record.
//
// That separation is the fix for a real race, not tidiness. When the stamp lived on the consent
// record, a hook reading the record on its way to stamping the notice, a `beezi telemetry off`
// landing in between, and the hook then writing back what it had read, would reinstate a grant the
// user had just withdrawn — a read-modify-write on a record whose only other writer is the user's
// decision. With the stamp somewhere else, `setConsent` is the ONLY writer of the consent record,
// so there is no merge to lose and nothing for a notice to resurrect.
export function noticeFile(home) {
  return path.join(telemetryDir(home), 'notice.json');
}

// ─── the lock

// Long enough that a worker doing four bounded round trips plus its 30s watchdog cannot have its
// lock stolen while it is still alive, short enough that a machine that hard-powered-off mid-batch
// is not locked out for a working day.
export const LOCK_STALE_MS = 90 * 1000;

// A per-PROCESS marker, minted once at import. PIDs are reused — aggressively so on Windows, where
// a freshly spawned worker can be handed the number a dead one had minutes ago — and a lock whose
// ownership is "pid 4812" alone cannot tell "I still hold this" from "somebody else is 4812 now".
// The pair (pid, instance) can: a successor has the same pid and a different instance, so the
// token check in `releaseTelemetryLock` refuses to remove a lock it did not take.
const INSTANCE = crypto.randomBytes(8).toString('hex');

export function lockOwnerToken() {
  return `${process.pid}:${INSTANCE}`;
}

function ownerFile(lockPath) {
  return path.join(lockPath, 'owner.json');
}

function readOwner(lockPath) {
  const raw = readJson(ownerFile(lockPath));
  if (raw == null || typeof raw !== 'object') return null;
  return raw;
}

function ownerTokenOf(raw) {
  if (raw == null) return null;
  if (typeof raw.instance !== 'string' || !Number.isInteger(raw.pid)) return null;
  return `${raw.pid}:${raw.instance}`;
}

// `process.kill(pid, 0)` sends no signal; it only asks whether the process can be signalled.
// EPERM means it exists and belongs to somebody else — which is still "alive", so the lock stands.
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error != null && error.code === 'EPERM';
  }
}

function claim(lockPath) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  try {
    // Non-recursive on purpose: that is what makes it atomic. Recursive mkdir succeeds on an
    // existing directory, which would hand the lock to everyone who asked.
    fs.mkdirSync(lockPath, { recursive: false });
  } catch {
    return null;
  }
  const token = lockOwnerToken();
  try {
    fs.writeFileSync(ownerFile(lockPath), JSON.stringify({
      pid: process.pid, instance: INSTANCE, at: Date.now(),
    }), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // A lock nobody can prove ownership of is worse than no lock: release it again rather than
    // leaving a directory that only the staleness rule can clear.
    try { removeSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
  return token;
}

// Take the lock, or return null. Breaks a lock whose owner is provably gone (dead pid) or whose
// claim is older than LOCK_STALE_MS; never breaks one held by a live process inside that window.
export function acquireTelemetryLock(lockPath, options = {}) {
  const now = options.now == null ? Date.now : options.now;
  const staleMs = options.staleMs == null ? LOCK_STALE_MS : options.staleMs;
  const isAlive = options.isAlive == null ? defaultIsAlive : options.isAlive;

  const token = claim(lockPath);
  if (token !== null) return token;

  const owner = readOwner(lockPath);
  // An owner file that is missing or unparseable can only mean a claim that crashed between the
  // mkdir and the write; the age of the directory decides.
  let stale = owner === null;
  if (!stale) {
    if (!isAlive(owner.pid)) stale = true;
    else if (!Number.isFinite(owner.at) || now() - owner.at > staleMs) stale = true;
  }
  if (!stale) {
    try {
      if (now() - fs.statSync(lockPath).mtimeMs > staleMs) stale = true;
    } catch {
      return null; // vanished under us: somebody else is mid-break, let them have it
    }
  }
  if (!stale) return null;

  try { removeSync(lockPath, { recursive: true, force: true }); } catch { return null; }
  return claim(lockPath);
}

// Token-checked release. A process that lost its lock to the staleness rule and then finished its
// work must NOT remove the successor's lock, so the owner file has to still name us.
export function releaseTelemetryLock(lockPath, token) {
  if (typeof token !== 'string' || token === '') return false;
  if (ownerTokenOf(readOwner(lockPath)) !== token) return false;
  try {
    removeSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Run `fn` holding the telemetry lock; return `options.miss` when somebody else holds a live one.
//
// Contention SKIPS rather than waits, for the same reason lib/lock.mjs does: every caller here is
// either a hook-budget-bounded process or a fire-and-forget worker, and the work is idempotent —
// the next run does it. `fn` may be async, and the await lives inside the try so the release in
// `finally` happens after the promise settles rather than after it is created.
export async function withTelemetryLock(fn, options = {}) {
  const lockPath = options.lockPath == null ? telemetryLockDir() : options.lockPath;
  const token = acquireTelemetryLock(lockPath, options);
  if (token === null) return options.miss;
  try {
    return await fn();
  } finally {
    releaseTelemetryLock(lockPath, token);
  }
}

// The synchronous twin, for callers (the consent CLI) that have no reason to be async.
export function withTelemetryLockSync(fn, options = {}) {
  const lockPath = options.lockPath == null ? telemetryLockDir() : options.lockPath;
  const token = acquireTelemetryLock(lockPath, options);
  if (token === null) return options.miss;
  try {
    return fn();
  } finally {
    releaseTelemetryLock(lockPath, token);
  }
}

// ─── queue primitives

// Only `.json` basenames are events. A `.tmp` left by an interrupted atomic write is not one, and
// neither is a directory — the same rule lib/queue-delivery.mjs applies to the analytics queue.
export function listQueueFiles(dir) {
  const target = dir == null ? telemetryQueueDir() : dir;
  let names;
  try { names = fs.readdirSync(target); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    out.push(name);
  }
  return out.sort();
}

export function unlinkQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function countPending(dir) {
  return listQueueFiles(dir).length;
}

// ─── the purges
//
// Here rather than in telemetry-consent.mjs because BOTH the consent CLI and the delivery worker
// have to run them — the worker rechecks consent before every batch and empties the queue itself
// when the answer has become no — and the worker must not import the CLI's module to do it.

// Every pending report, every quarantined one, the backoff state and the correlation identity.
// The user said no; what was already recorded must not survive the answer.
export function purgeAllPending() {
  let removed = 0;
  for (const name of listQueueFiles(telemetryQueueDir())) {
    if (unlinkQuietly(path.join(telemetryQueueDir(), name))) removed += 1;
  }
  for (const name of listQueueFiles(telemetryQuarantineDir())) {
    unlinkQuietly(path.join(telemetryQuarantineDir(), name));
  }
  unlinkQuietly(telemetrySendStateFile());
  unlinkQuietly(installationFile());
  return removed;
}

// Withdrawing correlation only: reports already stamped with the installation ID go, the anonymous
// ones stay and keep being sent, and the identity itself is dropped so later events are anonymous.
//
// A record that cannot be read counts as correlated. It may carry a stamp nobody can see any more,
// and one unreadable report deleted is a cheaper mistake than one correlated report sent after the
// user withdrew correlation.
export function purgeCorrelatedPending() {
  // Both directories, like `purgeAllPending`. A quarantined record is a report whose file could not
  // be parsed on the way back in — it is still a report, still on this machine, and can still carry
  // an installationId. Sweeping only `pending/` left `corrupt/` holding stamped records after the
  // one command whose whole purpose is that none remain.
  const sweep = (dir) => {
    let gone = 0;
    for (const name of listQueueFiles(dir)) {
      const filePath = path.join(dir, name);
      const value = readJson(filePath);
      const correlated = value == null || typeof value !== 'object' || value.installationId != null;
      if (correlated && unlinkQuietly(filePath)) gone += 1;
    }
    return gone;
  };

  const removed = sweep(telemetryQueueDir());
  // Swept, but deliberately NOT counted. The number travels into "N correlated report(s) were
  // deleted", which a user reads as reports that would otherwise have been sent — and a quarantined
  // record is never sent. `purgeAllPending` leaves its quarantine sweep uncounted for the same
  // reason.
  sweep(telemetryQuarantineDir());
  unlinkQuietly(installationFile());
  return removed;
}
