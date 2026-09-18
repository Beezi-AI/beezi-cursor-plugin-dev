import crypto from 'crypto';
import { apiBase } from './config.mjs';
import { postJson } from './http.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isCorrelationGranted, CORRELATION_CONSENT_VERSION } from './telemetry-consent.mjs';
import { installationFile, unlinkQuietly, DIAGNOSTICS_PATHS } from './telemetry-store.mjs';

// The diagnostic installation identity: a random correlation identifier, never a credential.
//
// It is NOT the machine identity. Reusing that would break the whole point of anonymous
// diagnostics — a report sent with `on` rather than `correlate` would still be traceable to the
// machine that sent it. This value exists only behind an explicit correlation grant, and the next
// process that needs one after a rotation mints a completely new one.
//
// This module deliberately imports nothing from lib/token.mjs. Binding may use an access token a
// caller ALREADY has; it must never refresh OAuth merely to send diagnostics, and the absent
// import is what makes that structural rather than a rule somebody has to remember.

const RECORD_VERSION = 1;

// Seven days, not the ninety the original module suggested: the server's binding row is refreshed
// on every successful bind, so reasserting well inside any expiry sweep keeps an active machine
// bound without turning binding into a per-session call.
export const REBIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A v4 UUID from random bytes with the version and variant bits set by hand.
//
// The obvious call is not available: `crypto.randomUUID` landed in Node 14.17 and this plugin's
// declared floor is 13.2, so even a guarded call would be a branch the floor job could not take.
// Sixteen random bytes with nibble 6 forced to 4 and the top two bits of byte 8 forced to `10` is
// the same value by a longer road, and it runs everywhere.
export function randomUuid() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readInstallationRecord() {
  const raw = readJson(installationFile());
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== RECORD_VERSION) return null;
  if (typeof raw.id !== 'string' || !UUID_V4.test(raw.id)) return null;
  return raw;
}

// Mints on first need, and ONLY behind the correlation grant: a machine that never opted in never
// has an identifier to leak. Returns null when correlation is off or the write fails.
export function ensureInstallationId(now = Date.now()) {
  if (!isCorrelationGranted()) return null;
  const existing = readInstallationRecord();
  if (existing !== null) return existing.id;
  const record = {
    version: RECORD_VERSION,
    id: randomUuid(),
    createdAt: new Date(now).toISOString(),
    boundAt: null,
    consentVersion: CORRELATION_CONSENT_VERSION,
  };
  try {
    writeJsonSecure(installationFile(), record);
  } catch {
    return null;
  }
  return record.id;
}

// What an event may be stamped with. Deliberately requires a CONFIRMED binding: an installation
// the server has never associated with an account carries no correlation value, and sending it
// anyway would only build a fleet-wide identifier out of nothing.
export function currentInstallationId() {
  if (!isCorrelationGranted()) return null;
  const record = readInstallationRecord();
  return record === null || record.boundAt == null ? null : record.id;
}

// True when authenticated activity should (re)assert the binding: never bound, or bound long
// enough ago to be worth refreshing.
export function needsBinding(now = Date.now()) {
  if (!isCorrelationGranted()) return false;
  const record = readInstallationRecord();
  if (record === null || record.boundAt == null) return true;
  const boundMs = Date.parse(record.boundAt);
  return !Number.isFinite(boundMs) || now - boundMs > REBIND_AFTER_MS;
}

export function markBound(now = Date.now()) {
  const record = readInstallationRecord();
  if (record === null) return false;
  try {
    writeJsonSecure(installationFile(), Object.assign({}, record, {
      boundAt: new Date(now).toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

// Discards the current identifier. The next process that needs one mints a fresh one, so a missing
// file IS the rotated state — there is deliberately nothing to write here. Used by logout and by a
// 409 binding conflict, which must never reassign an ID to a second account.
export function rotateInstallation() {
  return unlinkQuietly(installationFile());
}

// Asserts the binding against the authenticated identity route.
//
// `deps.token` is a token the CALLER already had. There is no refresh path and no token store
// import: a machine that cannot authenticate right now simply stays unbound, keeps recording
// anonymously, and tries again the next time something authenticated happens.
//
// Returns `{ status }` where status is one of `no-consent`, `no-token`, `bound`, `conflict`,
// `unauthorized`, `unavailable`.
export async function bindInstallation(deps = {}) {
  const record = (code, fields) => {
    const recordIssue = deps.recordIssue;
    if (recordIssue == null) return;
    try { recordIssue(code, fields); } catch { /* never the reason a binding fails */ }
  };

  if (!isCorrelationGranted()) return { status: 'no-consent' };
  const token = typeof deps.token === 'string' && deps.token !== '' ? deps.token : null;
  if (token === null) return { status: 'no-token' };

  const id = ensureInstallationId(deps.now == null ? Date.now() : deps.now());
  if (id === null) return { status: 'unavailable' };

  const post = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const url = `${apiBase()}${DIAGNOSTICS_PATHS.installation}`;
  // Exactly the two fields `BindDiagnosticInstallationRequestDto` declares. The user and tenant
  // come from the verified principal; a body carrying either is a 400 from the global pipe.
  const body = { installationId: id, consentVersion: CORRELATION_CONSENT_VERSION };

  let status;
  try {
    const res = await post(url, token, body, deps);
    status = res == null ? 0 : res.status;
  } catch {
    status = 0;
  }

  if (status >= 200 && status < 300) {
    if (!markBound(deps.now == null ? Date.now() : deps.now())) {
      return { status: 'unavailable' };
    }
    return { status: 'bound' };
  }
  if (status === 409) {
    // The server already owns this ID for a different account. Keeping it would eventually
    // attribute this machine's failures to somebody else.
    rotateInstallation();
    record('installation_binding_failed', {
      source: 'login', status: 409, reason: 'binding_conflict',
    });
    return { status: 'conflict' };
  }
  if (status === 401 || status === 403) {
    record('installation_binding_failed', {
      source: 'login', status, reason: status === 401 ? 'unauthorized' : 'forbidden',
    });
    return { status: 'unauthorized' };
  }
  record('installation_binding_failed', {
    source: 'login', status: status === 0 ? null : status, reason: 'probe_unreachable',
  });
  return { status: 'unavailable' };
}
