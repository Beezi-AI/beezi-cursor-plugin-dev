import fs from 'fs';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { removeSync } from './fs-compat.mjs';
import { AuthReason } from './auth-state.mjs';
import { namespaceSuffix } from './keyring-namespace.mjs';
import { resolveServiceName } from './credentials.mjs';

// Refresh state that has to outlive the process that learned it.
//
// Hooks are separate, short-lived processes. Before this file existed, each one met a failing token
// endpoint with no memory of the last twenty that met it: every Cursor event re-attempted the same
// refresh, so an authorization server having a bad ten minutes was asked once per hook, and an
// invalid_grant was rediscovered — and acted on — over and over.
//
// Everything here is scoped to a GENERATION. A marker describes one specific stored credential; the
// moment a commit publishes a new generation, the old marker is about a credential that no longer
// exists, and applying it would tell a user who has just signed in successfully that they need to
// sign in again.

export const MARKERS_VERSION = 1;

// The reference schedule. Five steps, then hold at the last one — an unbounded schedule silently
// becomes "never retry", and a hook that gives up permanently cannot recover when the provider does.
export const REFRESH_BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);

// Scoped to the NAMESPACE, like the control record. Keyed by home alone, a staging build and a
// production build sharing one home would have shared one set of markers — so one namespace's
// invalid_grant would have told the other's perfectly good credential to re-authenticate, and its
// backoff would have suppressed the other's refresh.
export function markersFile(deps = {}) {
  return path.join(beeziCursorHome(), `auth-markers${namespaceSuffix(resolveServiceName(deps))}.json`);
}

const EMPTY = Object.freeze({
  version: MARKERS_VERSION,
  generation: 0,
  reauthRequired: false,
  reason: AuthReason.NONE,
  attempts: 0,
  backoffUntil: 0,
  inflight: null,
});

export function readAuthMarkers(deps = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markersFile(deps), 'utf-8'));
    if (parsed == null || typeof parsed !== 'object' || parsed.version !== MARKERS_VERSION) return { ...EMPTY };
    return {
      version: MARKERS_VERSION,
      generation: typeof parsed.generation === 'number' ? parsed.generation : 0,
      reauthRequired: parsed.reauthRequired === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : AuthReason.NONE,
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
      backoffUntil: typeof parsed.backoffUntil === 'number' ? parsed.backoffUntil : 0,
      inflight: parsed.inflight == null ? null : parsed.inflight,
    };
  } catch {
    // Absent or unreadable both mean "nothing is known", which is the permissive direction: it costs
    // one extra refresh attempt, where the restrictive one would lock a machine out of refreshing.
    return { ...EMPTY };
  }
}

function write(markers, deps) {
  try { writeJsonSecure(markersFile(deps), markers); } catch { /* best-effort: markers are an optimisation */ }
}

// Markers that belong to `generation`, or a clean slate when they describe an older one.
function scoped(generation, deps) {
  const markers = readAuthMarkers(deps);
  return markers.generation === generation ? markers : { ...EMPTY, generation };
}

// The provider confirmed this credential's grant is dead. The credential itself is NOT deleted:
// only an explicit logout deletes, and a user who signs in again replaces it by committing a new
// generation, which retires this marker automatically.
export function markReauthRequired(generation, reason = AuthReason.INVALID_GRANT, deps = {}) {
  write({ ...scoped(generation, deps), reauthRequired: true, reason, attempts: 0, backoffUntil: 0 }, deps);
}

// A refresh failed for a reason that might not repeat. Advances the backoff one step and holds at
// the last one.
export function markRefreshFailure(generation, reason, deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const current = scoped(generation, deps);
  const attempts = current.attempts + 1;
  const step = REFRESH_BACKOFF_MS[Math.min(attempts, REFRESH_BACKOFF_MS.length) - 1];
  write({ ...current, reason, attempts, backoffUntil: now() + step }, deps);
}

// A refresh succeeded — or the credential was replaced. Everything remembered about the old one is
// now wrong, so it goes.
export function clearAuthMarkers(deps = {}) {
  try { removeSync(markersFile(deps), { force: true }); } catch { /* best-effort */ }
}

// Is this generation inside a backoff window? An older generation's window never applies.
export function inBackoff(generation, deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const markers = readAuthMarkers(deps);
  return markers.generation === generation && markers.backoffUntil > now();
}

export function reauthRequiredFor(generation, deps = {}) {
  const markers = readAuthMarkers(deps);
  return markers.generation === generation && markers.reauthRequired === true;
}
