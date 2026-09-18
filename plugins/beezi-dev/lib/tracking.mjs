import fs from 'fs';
import { apiBase } from './config.mjs';
import { trackingStateFile } from './paths-cursor.mjs';
import { controlFile } from './credentials.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { removeSync } from './fs-compat.mjs';

const STATE_VERSION = 1;

// Mirror of the server's TrackingMode enum — the whoami contract, never string-matched inline.
export const TrackingMode = Object.freeze({
  LIVE: 'live',
  BACKFILL_ONLY: 'backfill_only',
  DISABLED: 'disabled',
});

// Cached tenant tracking state, refreshed from whoami at login. Lives at the beeziCursorHome()
// ROOT (beside billing.json) — pruneStale() sweeps state/, queue/ and events/ only, and an
// expiring cache would silently forget that the one-time pull already completed.
//
// The gate is deliberately FAIL-OPEN: a missing/corrupt file or a server that sends no
// trackingMode means "allow" — the server is the actual boundary, and failing closed would
// dark-mode every fresh install until its first whoami.
export function readTrackingState(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(trackingStateFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

export function writeTrackingState(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  // 0600 like every other beeziCursorHome() root file; best-effort — a disk failure must never
  // break a hook.
  try {
    write(trackingStateFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

export function isLiveTrackingAllowed(state = readTrackingState()) {
  const mode = state == null || state.trackingMode == null ? null : state.trackingMode;
  if (mode === TrackingMode.BACKFILL_ONLY || mode === TrackingMode.DISABLED) return false;
  return true;
}

// The DISABLED mode specifically, as distinct from "live tracking is not allowed" — `backfill_only`
// answers false to isLiveTrackingAllowed but is not disabled, and the two produce different
// user-facing claims (a held queue that will drain later versus one that never will). A boolean
// cannot carry that difference, which is why CONTRACTS §3 asks for both predicates rather than one.
//
// Fail-open like its neighbour: no cached state is not "disabled".
export function isTrackingDisabled(state = readTrackingState()) {
  const mode = state == null || state.trackingMode == null ? null : state.trackingMode;
  return mode === TrackingMode.DISABLED;
}

// Mirrors the server's derivation: every mode except `disabled` is offered the one-time pull
// until it completes — paid tenants included, not just audit ones. A null mode means a server
// without the backfill routes: it has nothing to pull into, so no hint.
export function shouldBackfill(state = readTrackingState()) {
  if (!state) return false;
  if (state.trackingMode == null) return false;
  if (state.backfillCompleted === true) return false;
  return state.trackingMode !== TrackingMode.DISABLED;
}

// The state is machine-global but the server's pull record is per (tenant, user, tool): a
// logout→login into another workspace must not inherit the previous one's flags. The OAuth
// client id changes on every login (dynamic registration), so it is the natural binding key;
// email is the fallback for states recorded before the id was known.
export function matchesIdentity(state, identity) {
  if (state == null || !state.identity || !identity) return true;
  return state.identity === identity;
}

// Merge `patch` over the stored state. Every mutator below goes through this: writing a bare
// object instead drops whatever fields the caller did not know about, which is exactly how a
// whoami refresh would clobber the linkedAt stamp written at login.
function patchTrackingState(patch, deps = {}) {
  const current = readTrackingState(deps);
  writeTrackingState({ ...(current == null ? {} : current), ...patch }, deps);
}

// When this machine was linked, as an ISO instant. The backfill uses it to skip sidecars that
// live tracking already owns. Stamped explicitly at login rather than approximated from the
// credentials file's mtime — that file is only written by the DPAPI/plaintext fallbacks, so on
// any machine with a real credential store it never exists and the guard would never fire.
export function markLinked(deps = {}) {
  patchTrackingState({ linkedAt: new Date().toISOString() }, deps);
}

// Takes the already-read state so callers that hold one don't re-read the file — and so the audit
// can feed it the same state its other gates key off.
//
// The credentials file's mtime is the fallback for links made before the stamp existed — the
// weaker signal, since that file only exists under the DPAPI/plaintext credential fallbacks and
// token refresh rewrites it. It lives HERE rather than at a call site: two consumers of "the link
// instant" that disagree on a pre-stamp install is two different cutoffs for the same machine, and
// the audit's live-tracked rule and its active-pre-link rule both key off this one number.
// `statImpl` is the test seam — a suite must never stat the home directory of whoever runs it.
export function linkedAtMs(state, { statImpl } = {}) {
  const at = state == null ? undefined : state.linkedAt;
  if (at) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) return ms;
  }
  // The CONTROL RECORD, not `credentials.json`. Committed values live in
  // `credential-store.g<N>.json` now and the legacy slot is retired on first migration, so statting
  // the old path returns null on every migrated store. The record is rewritten on every committed
  // mutation, which makes it a strictly better proxy for "when was this machine last linked" than
  // the file it replaces.
  const stat = statImpl == null ? ((p) => fs.statSync(p)) : statImpl;
  try {
    const mtimeMs = stat(controlFile()).mtimeMs;
    return mtimeMs == null ? null : mtimeMs;
  } catch {
    return null;
  }
}

// One string naming the account this machine reports under: portal base + login email. The
// backfill's live-cursor belt is scoped by it — segments queued under a DIFFERENT account went
// to a different tenant, so skipping "already tracked" there would rob the current tenant of
// its history. The OAuth client id is deliberately NOT the key: dynamic registration mints a
// new one on every login, so keying on it would read a same-workspace re-login as a tenant
// switch and double-bill everything the previous login already delivered.
export function accountKey(email, base = apiBase()) {
  if (typeof email !== 'string' || email === '') return null;
  return `${base}|${email.toLowerCase()}`;
}

// Which account this machine reports under RIGHT NOW — the one derivation of it, for everyone.
//
// Freshest wins: a whoami that actually answered and validated names the account, and only when it
// did not does the cached email stand in. Both halves were being spelled out separately at three
// call sites (the checkpoint, the audit, the login's same-account comparison), which is three
// chances for one of them to disagree with the belt it is feeding.
//
// The checkpoint calls this with no `who` and that is deliberate, not an omission: a hook must not
// touch the network, so the cached email is the only answer available to it. Null until some login
// or audit has recorded one — every consumer reads null as "unknowable" and stays conservative.
export function currentAccountKey({ who = null, tracking = readTrackingState() } = {}) {
  const fromWhoami = who != null && who.valid === true ? who.email : null;
  if (fromWhoami != null) return accountKey(fromWhoami);
  const cached = tracking == null ? undefined : tracking.email;
  return accountKey(cached == null ? null : cached);
}

// Persist the whoami verdict. `identity` is the current login's binding key (client id or email).
//
// `linkedAt` restores a previous link instant in the SAME patch write (see performLogin): a
// same-account re-login must keep counting the liveTracked cutoff from the ORIGINAL link, or
// everything live-tracked between the two logins reads as backfillable and double-bills the same
// tenant. Folded in here rather than written after, because a wipe-then-restore pair is two chances
// to leave the cache holding the fresh stamp. Non-string or empty is refused, so a caller with
// nothing to restore can pass what it has.
//
// `deps` stays LAST behind the options bag: no caller injects it, while `linkedAt` is the argument
// callers actually reach for.
export function recordWhoami(who, identity, { linkedAt } = {}, deps = {}) {
  if (!who || who.valid !== true) return;
  patchTrackingState(
    {
      trackingMode: who.trackingMode == null ? null : who.trackingMode,
      tenantTier: who.tenantTier == null ? null : who.tenantTier,
      backfillCompleted: who.backfillCompleted === true,
      // For accountKey — the hooks stamp it into session state without any network of their own.
      email: who.email == null ? null : who.email,
      identity: identity == null ? null : identity,
      fetchedAt: new Date().toISOString(),
      reason: null,
      ...(typeof linkedAt === 'string' && linkedAt !== '' ? { linkedAt } : {}),
    },
    deps,
  );
}

// A live endpoint answered 403 TRACKING_DISABLED: the server has spoken — go dark until the
// next whoami says otherwise.
export function markTrackingDisabled(reason, deps = {}) {
  patchTrackingState(
    {
      trackingMode: TrackingMode.DISABLED,
      fetchedAt: new Date().toISOString(),
      reason: reason == null ? null : reason,
    },
    deps,
  );
}

// The pull sealed (locally observed or server-confirmed) — the backfill fast path keys off this.
export function markBackfillCompleted(deps = {}) {
  patchTrackingState({ backfillCompleted: true, fetchedAt: new Date().toISOString() }, deps);
}

export function clearTrackingState(deps = {}) {
  try {
    // An injected fsImpl is a test double, so it keeps being driven through rmSync; the real
    // module has no rmSync below 14.14, so the default path goes through the fs-compat shim.
    if (deps.fsImpl != null) deps.fsImpl.rmSync(trackingStateFile(), { force: true });
    else removeSync(trackingStateFile(), { force: true });
  } catch { /* best-effort */ }
}
