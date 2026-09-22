import fs from 'fs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import {
  telemetryConsentFile,
  noticeFile,
  consentLockDir,
  CONSENT_LOCK_STALE_MS,
  countPending,
  purgeAllPending,
  purgeCorrelatedPending,
  withTelemetryLockSync,
} from './telemetry-store.mjs';

// Explicit consent for the plugin's own crash diagnostics. Nothing in this plugin records, keeps
// or sends a diagnostic without a grant that came from a user typing one of four words.
//
// The record stays at version 1 forever. Correlation arrived later and is carried as an extra
// FIELD, not a new record version, because `readConsent` denies on any version it does not
// recognise: bumping the record to 2 on `correlate` would make every correlated machine read as
// denied on the first client that had not caught up — a silent total opt-out, and the one failure
// mode this module exists to prevent. What version 2 names is the CORRELATION consent, which is a
// number the binding route is told about (see lib/telemetry-installation.mjs) and never a gate.
export const CONSENT_RECORD_VERSION = 1;
export const CORRELATION_CONSENT_VERSION = 2;

export const CONSENT_MODES = Object.freeze(['on', 'off', 'correlate', 'anonymous']);

const GRANTED = 'granted';
const DENIED = 'denied';

// Absent, malformed, unreadable, or any version this client does not know: all of them deny.
// There is deliberately no salvage path — a half-parsed grant is not a grant.
export function readConsent() {
  const raw = readJson(telemetryConsentFile());
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== CONSENT_RECORD_VERSION) return null;
  return raw;
}

export function isTelemetryGranted() {
  const record = readConsent();
  return record !== null && record.consent === GRANTED;
}

// A second, independent gate. Correlation without diagnostics is meaningless, so it reads as "no"
// whenever basic diagnostics are off: an old correlation field can never silently re-grant itself
// when someone turns diagnostics back on.
export function isCorrelationGranted() {
  const record = readConsent();
  return record !== null && record.consent === GRANTED && record.correlation === GRANTED;
}

// Did the user actually decide? Distinct from "was the notice shown" — a displayed prompt, a
// timeout and silence are none of them consent, and only an explicit `setConsent` stamps this.
export function hasBeenAsked() {
  const record = readConsent();
  return record !== null && record.decidedAt != null;
}

// Read from its own file: see `noticeFile` in lib/telemetry-store.mjs for why the stamp does not
// live on the consent record.
export function hasNoticeBeenShown() {
  const raw = readJson(noticeFile());
  return raw != null && typeof raw === 'object' && raw.shownAt != null;
}

// Read-modify-write of the consent record, under a mutex of its own.
//
// `setConsent` is the record's ONLY writer — the one-time notice stamp deliberately lives in a
// separate file (see `noticeFile`), because a second writer merging onto a record it read moments
// ago is precisely how a withdrawn grant comes back. What is left for the lock to do is keep two
// concurrent DECISIONS from interleaving into a torn merge, which it does at a cost of two file
// operations.
//
// Deliberately NOT the delivery lock. The worker holds that one for the length of a batch, and a
// user typing `beezi telemetry off` must never wait on a network round trip to have their denial
// recorded. A missed lock here still writes, for the same reason: a denial that went unrecorded
// because some other process was mid-write would be far worse than a torn merge between two
// decisions made in the same millisecond, where either answer is one the user just gave.
function patch(fields, deps) {
  const write = deps != null && deps.write != null ? deps.write : writeJsonSecure;
  // `deps.consentLock`, not `deps.lock` — the latter belongs to the queue purge in `setConsent`,
  // and one key steering two different mutexes is how a test ends up asserting the wrong one.
  const lock = Object.assign(
    { lockPath: consentLockDir(), staleMs: CONSENT_LOCK_STALE_MS },
    deps == null ? null : deps.consentLock,
  );

  const apply = () => {
    const record = readConsent();
    const base = record === null ? {} : record;
    const next = Object.assign({}, base, fields, { version: CONSENT_RECORD_VERSION });
    write(telemetryConsentFile(), next);
    return next;
  };

  try {
    const MISS = Symbol('miss');
    let next = withTelemetryLockSync(apply, Object.assign({}, lock, { miss: MISS }));
    // Nobody can hold this for longer than a couple of file operations, so a miss means a crashed
    // holder whose lock has not yet aged out. The decision still has to land.
    if (next === MISS) next = apply();
    return { ok: true, record: next };
  } catch {
    // A write that failed changed nothing, and the caller must never say otherwise.
    return { ok: false, record: null };
  }
}

// Stamped by whichever surface ACTUALLY emitted the one-time notice, after it emitted it. Hook
// stdout may be dropped by Cursor without anyone noticing, so the stamp belongs to the emitter,
// not to the decision to emit.
//
// Its own file, and not a field on the consent record: this writer carries no decision, so if it
// merged onto a record it had read a moment earlier it could write a stale `consent` back over a
// denial made in between. Nothing here can touch the user's answer because nothing here reads it.
export function markNoticeShown(now = new Date(), deps = {}) {
  const write = deps.write == null ? writeJsonSecure : deps.write;
  try {
    write(noticeFile(), { version: 1, shownAt: new Date(now).toISOString() });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ─── the one entry point

// Apply one of the four user-visible settings.
//
// Returns `{ ok, mode, changed, purged, removed, error }`. `changed` is true only when the record
// on disk now says what the user asked for, and `purged` only when the destructive half actually
// ran — a caller printing "pending reports were deleted" needs both to be true, and a lock held by
// an in-flight worker makes the second one false without making the first one a lie.
//
// Order is load-bearing: the DECISION is written first and the queue is emptied second. A worker
// that wakes between the two rechecks consent, finds a denial and purges the queue itself; the
// reverse order would leave a window where the queue is empty but the grant still stands, and the
// very next hook would start refilling it.
export function setConsent(mode, deps = {}) {
  if (CONSENT_MODES.indexOf(mode) === -1) {
    return { ok: false, mode: null, changed: false, purged: false, removed: 0, error: 'invalid-mode' };
  }
  const nowIso = new Date(deps.now == null ? Date.now() : deps.now()).toISOString();
  const decision = { decidedAt: nowIso, askedAt: nowIso };

  let fields;
  let destructive = null;
  if (mode === 'on') {
    // Basic diagnostics only. Correlation is left exactly as it was — which after `off` is
    // `denied`, so re-enabling never revives a grant the user has not re-given.
    fields = Object.assign({ consent: GRANTED }, decision);
  } else if (mode === 'off') {
    fields = Object.assign({ consent: DENIED, correlation: DENIED }, decision, {
      correlationDecidedAt: nowIso,
    });
    destructive = purgeAllPending;
  } else if (mode === 'correlate') {
    fields = Object.assign({ consent: GRANTED, correlation: GRANTED }, decision, {
      correlationDecidedAt: nowIso, correlationConsentVersion: CORRELATION_CONSENT_VERSION,
    });
  } else {
    // anonymous: correlation off, basic diagnostics untouched in either direction.
    fields = Object.assign({ correlation: DENIED }, decision, { correlationDecidedAt: nowIso });
    destructive = purgeCorrelatedPending;
  }

  const written = patch(fields, deps);
  if (!written.ok) {
    return { ok: false, mode, changed: false, purged: false, removed: 0, error: 'write-failed' };
  }
  if (destructive === null) {
    return { ok: true, mode, changed: true, purged: false, removed: 0, error: null };
  }

  // The same mutex the worker takes around a batch, so a purge can never delete a report the
  // sender is about to acknowledge (nor race a rename mid-seal).
  const removed = withTelemetryLockSync(destructive, Object.assign({ miss: null }, deps.lock));
  if (removed === null) {
    return { ok: true, mode, changed: true, purged: false, removed: 0, error: 'purge-deferred' };
  }
  return { ok: true, mode, changed: true, purged: true, removed, error: null };
}

// What the status surfaces print. Counts and booleans only: this never opens a credential, a
// token store or a queued report's contents.
export function consentSummary() {
  const record = readConsent();
  return {
    enabled: record !== null && record.consent === GRANTED,
    correlated: record !== null && record.consent === GRANTED && record.correlation === GRANTED,
    decided: record !== null && record.decidedAt != null,
    noticeShown: hasNoticeBeenShown(),
    pending: countPending(),
  };
}

// Kept for the surfaces that only need to know whether the directory has ever been written.
export function consentFileExists() {
  try {
    return fs.statSync(telemetryConsentFile()).isFile();
  } catch {
    return false;
  }
}
