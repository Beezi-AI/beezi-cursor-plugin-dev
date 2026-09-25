import { apiBase, ENDPOINTS } from './config.mjs';
import { getJson, readJsonBounded } from './http.mjs';

// Exported for the same reason POST_TIMEOUT_MS is: a caller working against a deadline — the
// sessionStart hook, which has to answer Cursor inside ~10s and has other work to do — needs to see
// the number it is about to spend, and shrink it, rather than discovering the overrun afterwards.
//
// 1500ms, not the 10s read default: whoami is a single small lookup, and on the hook path it is not
// the turn's purpose, it is a check on the way to the turn's purpose. Inheriting the generic read
// default meant one stalled identity lookup could eat the entire hook budget on its own.
export const WHOAMI_TIMEOUT_MS = 1500;

// What the portal actually said about this token (CONTRACTS §2).
//
// The boolean version below could not tell these apart, and that mattered most where it hurt most:
// 401 ("this token is not accepted") and 403 ("you are authenticated and not entitled") both read
// as "invalid", the session-start hook deleted the credential on that reading, and a tenant that
// had merely run out of seats lost the machine's link — with the advice to relink, which cannot
// grant a seat. 429 and 5xx are not evidence about the token at all.
export const WhoamiOutcome = Object.freeze({
  AUTHORIZED: 'authorized',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INDETERMINATE: 'indeterminate',
});

// Probe the token against the portal. Never throws.
//
// Bounded end to end — headers AND body — and the two phases share ONE budget: the body read gets
// what the headers left, not a second full timeoutMs. A server that dribbles headers at the 1.4s
// mark and then goes quiet would otherwise cost 3s against a budget that promised 1.5s, which is
// the kind of overrun that only shows up on the slow connection of the user who reports it.
export async function probeWhoami(token, deps = {}) {
  const base = deps.base == null ? apiBase() : deps.base;
  const timeoutMs = deps.timeoutMs == null ? WHOAMI_TIMEOUT_MS : deps.timeoutMs;
  const startedAt = Date.now();
  let res;
  try {
    res = await getJson(`${base}${ENDPOINTS.whoami}`, token, { ...deps, timeoutMs });
  } catch {
    // Transport failure or a timeout. It says nothing about the token.
    return { outcome: WhoamiOutcome.INDETERMINATE, status: null, tenant: null, policy: null, bodyMissing: true };
  }
  const status = res == null || res.status == null ? null : res.status;

  if (status === 401) {
    return { outcome: WhoamiOutcome.UNAUTHORIZED, status, tenant: null, policy: null, bodyMissing: true };
  }
  if (status === 403) {
    // Access denied, credentials RETAINED. This is the outcome AUTH-08 exists for.
    return { outcome: WhoamiOutcome.FORBIDDEN, status, tenant: null, policy: null, bodyMissing: true };
  }
  if (res == null || !res.ok) {
    return { outcome: WhoamiOutcome.INDETERMINATE, status, tenant: null, policy: null, bodyMissing: true };
  }

  // The status already proved the token is accepted. An unreadable or abandoned body does not undo
  // that — but it must not be laundered into a confirmed tracking policy either, so `bodyMissing`
  // travels with the answer and `policy` stays null.
  const parsed = await readJsonBounded(res, timeoutMs - (Date.now() - startedAt));
  const bodyMissing = parsed == null;
  const body = bodyMissing ? {} : parsed;
  const tenant = {
    email: body.email == null ? null : body.email,
    name: body.name == null ? null : body.name,
    tenantTier: body.tenantTier == null ? null : body.tenantTier,
    backfillCompleted: body.backfillCompleted === true,
  };
  // Does the server hold a `cli_agent_accounts` row for this vendor, linked to the caller? A newer
  // server answers; an older one says nothing. Only a REAL boolean is carried, and the key is
  // otherwise absent rather than null: `false` makes session start force a check-in, so a
  // stringly `"false"`, a `0` or a missing field must never be able to read as one — and an
  // absent key keeps every existing consumer's view of this shape byte-for-byte unchanged.
  if (typeof body.cliAgentAccountKnown === 'boolean') tenant.cliAgentAccountKnown = body.cliAgentAccountKnown;
  return {
    outcome: WhoamiOutcome.AUTHORIZED,
    status,
    tenant,
    policy: body.trackingMode == null ? null : { mode: body.trackingMode },
    bodyMissing,
  };
}

// The shipped shape, kept exactly: { valid: true, email, name, tenantTier, trackingMode,
// backfillCompleted[, cliAgentAccountKnown] } | { valid: false } | null (offline/unknown). The
// bracketed key is present only when the server sent a boolean (see probeWhoami); absent = unknown. lib/link-status.mjs is a shared
// file and reads this, so the contract does not move — but a 403 additionally carries
// `forbidden: true`, which is what lets the callers that must not delete on it tell the two
// refusals apart without a second request.
export async function whoami(token, deps = {}) {
  const probe = await probeWhoami(token, deps);
  if (probe.outcome === WhoamiOutcome.UNAUTHORIZED) return { valid: false };
  if (probe.outcome === WhoamiOutcome.FORBIDDEN) return { valid: false, forbidden: true };
  if (probe.outcome === WhoamiOutcome.INDETERMINATE) return null;
  const out = {
    valid: true,
    email: probe.tenant.email,
    name: probe.tenant.name,
    tenantTier: probe.tenant.tenantTier,
    trackingMode: probe.policy == null ? null : probe.policy.mode,
    backfillCompleted: probe.tenant.backfillCompleted,
  };
  if (typeof probe.tenant.cliAgentAccountKnown === 'boolean') out.cliAgentAccountKnown = probe.tenant.cliAgentAccountKnown;
  return out;
}
