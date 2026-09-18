import crypto from 'crypto';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { accountScopeKey, accountScopeDigest } from './cost-reconcile.mjs';
import { CURSOR_PLANS } from './cursor-account.mjs';
import { BILLING_POOL } from './delta-cursor.mjs';
import { BILLING_SCHEMA_VERSION, normalizeAccountEmail } from './billing-config.mjs';

// One authenticated account check-in client, serving AUTH-15 (machine/account identity) and
// BILL-06 (billing-account facts) from a single implementation, plus the BILL-09 cost summary.
//
// ─── WHAT IS NOT HERE, ON PURPOSE ────────────────────────────────────────────────────────────
// There is no route and no default-on path. The inspected backend snapshot has identity routes for
// Claude Code and Codex and maps an unknown `cursor` agent header onto Claude Code, so a request
// sent today would be attributed to the wrong tool; and nothing in it proves billing writeback
// support. Until the deployed contract is confirmed, `ACCOUNT_CHECKIN_ENDPOINT` is null,
// `deps.enabled` defaults to false, and this module posts nothing.
export const ACCOUNT_CHECKIN_ENDPOINT = null;

export const CHECKIN_STATE_VERSION = 1;

// Re-check in at least weekly even when nothing changed, so a server that lost the row recovers
// without waiting for the user's plan to move.
export const CHECKIN_HEARTBEAT_MS = 7 * 24 * 60 * 60 * 1000;

export const CheckInOutcome = Object.freeze({
  DISABLED: 'disabled',
  UNCONFIGURED: 'unconfigured',
  UNLINKED: 'unlinked',
  SKIPPED: 'skipped',
  SENT: 'sent',
  FORBIDDEN: 'forbidden',
  OFFLINE: 'offline',
  SCHEMA: 'schema',
  FAILED: 'failed',
  EPOCH_CHANGED: 'epoch-changed',
});

// ── the payload ───────────────────────────────────────────────────────────────────────────────

// Everything this client may send. It is an ALLOWLIST, not a filter: a field outside it is a schema
// failure rather than a quietly dropped key, because the way secrets leak is one caller adding a
// field that everything downstream happily forwards.
//
// Deliberately absent: API-key fingerprints and any environment-variable collection. Those are a
// Claude Code mechanism with no Cursor equivalent and no reason to exist here.
export const CHECKIN_PAYLOAD_FIELDS = Object.freeze([
  'environment',
  'cursorAccountEmail',
  'cursorAccountSource',
  'plan',
  'planSource',
  'planObservedAt',
  'billingSource',
]);

const SECRET_LIKE = /sk-|\s/;

export function validateCheckInPayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'not-an-object' };
  }
  for (const key of Object.keys(payload)) {
    if (!CHECKIN_PAYLOAD_FIELDS.includes(key)) return { ok: false, reason: `unknown-field:${key}` };
    const value = payload[key];
    if (value == null) continue;
    if (typeof value !== 'string') return { ok: false, reason: `non-string:${key}` };
    if (value.length > 254 || SECRET_LIKE.test(value)) return { ok: false, reason: `suspicious:${key}` };
  }
  return { ok: true, reason: null };
}

// A stable digest of the allowlisted fields only, so "has anything changed?" never depends on key
// order and can never be answered by hashing something we do not send.
export function hashCheckInPayload(payload) {
  const canonical = {};
  for (const key of CHECKIN_PAYLOAD_FIELDS) {
    const value = payload == null ? null : payload[key];
    canonical[key] = value == null ? null : String(value);
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ── heartbeat state ───────────────────────────────────────────────────────────────────────────

export function accountSyncStateDir() {
  return path.join(beeziCursorHome(), 'account-sync');
}

// Scoped by environment + Beezi account + Cursor account, the same three facts the cost state uses.
// A heartbeat carried across any of those would tell the server this machine had already reported
// facts that belong to somebody else.
export function accountSyncStateFile(scope) {
  return path.join(accountSyncStateDir(), `${accountScopeDigest(scope)}.json`);
}

function emptyState(scope) {
  return { version: CHECKIN_STATE_VERSION, scope: accountScopeKey(scope), lastHash: null, lastSuccessAt: null };
}

export function readAccountSyncState(file, scope) {
  const raw = readJson(file);
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return emptyState(scope);
  if (raw.version !== CHECKIN_STATE_VERSION) return emptyState(scope);
  if (raw.scope !== accountScopeKey(scope)) return emptyState(scope);
  return {
    version: CHECKIN_STATE_VERSION,
    scope: raw.scope,
    lastHash: typeof raw.lastHash === 'string' ? raw.lastHash : null,
    lastSuccessAt: typeof raw.lastSuccessAt === 'number' && Number.isFinite(raw.lastSuccessAt) ? raw.lastSuccessAt : null,
  };
}

export function writeAccountSyncState(file, state, scope) {
  writeJsonSecure(file, {
    version: CHECKIN_STATE_VERSION,
    scope: accountScopeKey(scope),
    lastHash: state == null ? null : state.lastHash,
    lastSuccessAt: state == null ? null : state.lastSuccessAt,
  });
}

export function isCheckInDue(state, hash, now = Date.now(), heartbeatMs = CHECKIN_HEARTBEAT_MS) {
  if (state == null) return true;
  if (state.lastHash !== hash) return true;
  if (typeof state.lastSuccessAt !== 'number' || !Number.isFinite(state.lastSuccessAt)) return true;
  return now - state.lastSuccessAt >= heartbeatMs;
}

// ── charged-cost summary (BILL-09) ────────────────────────────────────────────────────────────

// The pool a row was actually billed against, taken from the vocabulary the delta EMITS rather than
// re-spelled here. `BILLING_POOL.CREDITS` is `'credits'`, which is NOT the report-level
// `BillingSource.CURSOR_CREDITS` (`'cursor_credits'`): two vocabularies, one row-level and one
// report-level. Branching on the wrong one turns every charged row into an unknown and makes the
// summary permanently null, which is safe but useless. Importing the constant is what stops a
// fourth spelling from appearing.
//
// The seat pool's `cost_usd` is a NOTIONAL list-rate valuation of covered usage - real information,
// but not money anybody was charged.
const CHARGED_POOL = BILLING_POOL.CREDITS;
const SEAT_POOL = BILLING_POOL.SUBSCRIPTION;

// A ZEROED MIRROR ROW. `subagentModelsFrom` in checkpoint.mjs emits one row per distinct
// (model, pool) of the PARENT segment with every count zeroed and no `cost_usd` key at all - it
// exists to name which model was in play while the subagent ran and deliberately contributes to no
// sum. Its segment id is `<sessionId>:<agentId>:<from>-<to>` while the parent's is
// `<sessionId>:<from>-<to>`, so the two never collide and an id-only dedupe cannot separate them.
//
// Left unrecognised, every such row landed in `unknownEntries` and set `complete: false`, which
// made the summary unusable on exactly the sessions that spent credits AND spawned a subagent.
// The absent `cost_usd` PLUS a zero request count is the mirror's signature: a genuine credits row
// always carries a price (computeDelta passes one on every pushEntry), including the real case of
// cost with a zero priced count.
function isZeroedMirror(row) {
  if (row.requests !== 0) return false;
  return !('cost_usd' in row);
}

// Actual vendor-charged overage across a set of segments.
//
// Three values that look alike are kept apart:
//   0    — the segments were read and none of them was billed to credits.
//   null — nothing chargeable could be determined at all.
//   partial — `chargedCostUsd` holds what IS known and `complete` is false.
//
// Segments are deduplicated by `segmentId` so a replayed anchor - which re-sends the SAME main
// segment id and is upserted server-side - cannot add its money twice.
export function summarizeChargedCost(segments) {
  const summary = {
    chargedCostUsd: null,
    complete: false,
    chargedEntries: 0,
    seatCoveredEntries: 0,
    unknownEntries: 0,
    mirrorEntries: 0,
  };
  if (!Array.isArray(segments)) return summary;

  const seen = new Set();
  let charged = 0;
  let complete = true;
  let chargedEntries = 0;
  let seatEntries = 0;
  let unknownEntries = 0;
  let mirrorEntries = 0;

  for (const segment of segments) {
    if (segment == null || typeof segment !== 'object') { complete = false; continue; }
    const id = typeof segment.segmentId === 'string' ? segment.segmentId : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const models = Array.isArray(segment.models) ? segment.models : null;
    if (models === null) { complete = false; unknownEntries += 1; continue; }
    for (const row of models) {
      if (row == null || typeof row !== 'object') { complete = false; unknownEntries += 1; continue; }
      if (isZeroedMirror(row)) { mirrorEntries += 1; continue; }
      if (row.billing_pool === SEAT_POOL) { seatEntries += 1; continue; }
      if (row.billing_pool !== CHARGED_POOL) { unknownEntries += 1; complete = false; continue; }
      const cost = row.cost_usd;
      if (typeof cost !== 'number' || !Number.isFinite(cost)) {
        // A credit-funded row whose price we could not read is money we know was spent and cannot
        // name. Calling it zero would understate a real charge.
        unknownEntries += 1;
        complete = false;
        continue;
      }
      charged += cost;
      chargedEntries += 1;
    }
  }

  const nothingKnown = chargedEntries === 0 && seatEntries === 0 && unknownEntries > 0;
  return {
    chargedCostUsd: nothingKnown ? null : charged,
    complete,
    chargedEntries,
    seatCoveredEntries: seatEntries,
    unknownEntries,
    mirrorEntries,
  };
}

// ── server plan writeback ─────────────────────────────────────────────────────────────────────

// Whether a plan the server sent back may replace the local record.
//
// Source precedence, in the order the tests enforce it:
//   1. The response must name an account, and it must be the account we are CURRENTLY observing.
//      An unknown account on either side is a refusal, never an assumed match.
//   2. The plan must be in the local vocabulary. Storing an unmapped string here would put a tier
//      with no seat rate into the record that prices the seat.
//   3. The response must be strictly fresher than the local observation it would replace. A stale
//      server row must never overwrite a plan the user typed five minutes ago.
export function planWriteback(response, context) {
  const ctx = context == null ? {} : context;
  const refuse = (reason) => ({ accepted: false, reason, record: null });
  if (response == null || typeof response !== 'object') return refuse('no-plan');
  if (typeof response.plan !== 'string' || response.plan === '') return refuse('no-plan');

  const served = normalizeAccountEmail(response.account == null ? null : response.account.email);
  const local = ctx.anchor == null ? null : normalizeAccountEmail(ctx.anchor.email);
  if (served === null || local === null) return refuse('account-unknown');
  if (served !== local) return refuse('account-mismatch');

  if (!CURSOR_PLANS.includes(response.plan) || response.plan === 'unknown') return refuse('unsupported-plan');

  const observedAt = Date.parse(response.observedAt == null ? '' : response.observedAt);
  if (Number.isNaN(observedAt)) return refuse('stale');
  const existing = ctx.existing == null ? null : ctx.existing;
  const localAt = existing == null ? NaN : Date.parse(existing.capturedAt == null ? '' : existing.capturedAt);
  if (!Number.isNaN(localAt) && observedAt <= localAt) return refuse('stale');

  return {
    accepted: true,
    reason: 'accepted',
    record: {
      version: BILLING_SCHEMA_VERSION,
      source: existing == null ? 'subscription' : existing.source,
      plan: response.plan,
      subscriptionType: response.plan,
      // The server was asked about a plan, not about a rate-limit tier; a response that does not
      // mention one is not evidence that the locally observed one is gone.
      rateLimitTier: existing == null ? null : existing.rateLimitTier,
      capturedAt: new Date(observedAt).toISOString(),
      identityCheckedAt: ctx.now == null ? null : new Date(ctx.now).toISOString(),
      migratedAt: existing == null ? null : existing.migratedAt,
      accountAnchor: ctx.anchor,
      capturedBy: 'server',
      selfReported: false,
    },
  };
}

// ── the client ────────────────────────────────────────────────────────────────────────────────

function result(outcome, extra) {
  return {
    outcome,
    successful: outcome === CheckInOutcome.SENT,
    writeback: null,
    ...(extra == null ? {} : extra),
  };
}

// Check this machine's billing account in with the server.
//
//   payload — allowlisted, non-secret facts only (CHECKIN_PAYLOAD_FIELDS).
//   auth    — `{ getToken(), authEpoch() }` (CONTRACTS §2), injected.
//   deps    — `{ enabled=false, endpoint=ACCOUNT_CHECKIN_ENDPOINT, postJson, scope, now,
//                existingBillingRecord, anchor }`.
//
// It returns `writeback` for the caller to apply; it never writes billing.json itself, so the one
// module that owns that file stays the only one that can change a plan.
//
// `successful` is true for exactly one outcome. A 403, an offline machine and a response we cannot
// parse all leave the heartbeat state untouched, so the next run tries again instead of believing
// the server has the current facts.
export async function checkInAccount(payload, auth, deps) {
  const d = deps == null ? {} : deps;
  const now = d.now == null ? Date.now() : d.now;
  if (d.enabled !== true) return result(CheckInOutcome.DISABLED);
  const endpoint = d.endpoint === undefined ? ACCOUNT_CHECKIN_ENDPOINT : d.endpoint;
  if (endpoint == null) return result(CheckInOutcome.UNCONFIGURED);

  const valid = validateCheckInPayload(payload);
  if (!valid.ok) return result(CheckInOutcome.SCHEMA, { reason: valid.reason });

  // The heartbeat is scoped by environment + Beezi account + Cursor account, and an incomplete
  // scope is REFUSED rather than degraded. Filling a missing `beeziAccount` with null would key two
  // Beezi accounts on one machine to the same file, which is the mis-attribution the scoping exists
  // to prevent - and it would fail silently, as a check-in that looks successful.
  const scope = d.scope;
  if (scope == null || typeof scope !== 'object'
    || scope.env == null || scope.beeziAccount == null || scope.cursorAccount == null) {
    return result(CheckInOutcome.SCHEMA, { reason: 'incomplete-scope' });
  }
  const file = accountSyncStateFile(scope);
  const state = readAccountSyncState(file, scope);
  const hash = hashCheckInPayload(payload);
  if (!isCheckInDue(state, hash, now)) return result(CheckInOutcome.SKIPPED);

  let fence;
  try {
    fence = await auth.authEpoch();
  } catch {
    return result(CheckInOutcome.UNLINKED);
  }
  let token = null;
  try {
    token = await auth.getToken();
  } catch {
    token = null;
  }
  if (token == null) return result(CheckInOutcome.UNLINKED);
  // Recheck IMMEDIATELY before the request. `getToken` is an await, and a relink landing inside it
  // would otherwise send the previous account's facts under the new account's credentials -
  // CONTRACTS section 2 requires the fence here as well as on the response.
  try {
    if (await auth.authEpoch() !== fence) return result(CheckInOutcome.EPOCH_CHANGED);
  } catch {
    return result(CheckInOutcome.UNLINKED);
  }

  let response;
  try {
    response = await d.postJson(endpoint, payload, token);
  } catch {
    return result(CheckInOutcome.OFFLINE);
  }

  // Fence BEFORE anything derived from the response is applied. A machine that was relinked while
  // the request was in flight must not take a plan meant for the previous account.
  let after;
  try {
    after = await auth.authEpoch();
  } catch {
    after = null;
  }
  if (after !== fence) return result(CheckInOutcome.EPOCH_CHANGED);

  if (response == null || typeof response !== 'object') return result(CheckInOutcome.SCHEMA, { reason: 'no-response' });
  if (response.ok !== true) {
    return result(response.status === 403 ? CheckInOutcome.FORBIDDEN : CheckInOutcome.FAILED, { status: response.status });
  }
  const body = response.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return result(CheckInOutcome.SCHEMA, { reason: 'unreadable-body' });
  }

  try {
    writeAccountSyncState(file, { lastHash: hash, lastSuccessAt: now }, scope);
  } catch {
    // The check-in DID land; failing to remember it only costs a redundant one next time.
  }

  return result(CheckInOutcome.SENT, {
    writeback: planWriteback(body, { anchor: d.anchor, existing: d.existingBillingRecord, now }),
  });
}
