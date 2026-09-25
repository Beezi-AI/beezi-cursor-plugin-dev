import crypto from 'crypto';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { CURSOR_PLANS } from './cursor-account.mjs';
import { BILLING_POOL } from './delta-cursor.mjs';
import { BILLING_SCHEMA_VERSION, normalizeAccountEmail, normalizeAccountIdentifier } from './billing-config.mjs';
import { ENDPOINTS } from './config.mjs';

// One authenticated account check-in client, serving AUTH-15 (machine/account identity) and
// BILL-06 (billing-account facts) from a single implementation, plus the BILL-09 cost summary.
//
// ─── WHAT IS WIRED, AND WHAT IS STILL UNPROVEN ───────────────────────────────────────────────
// The route IS known and IS set: `POST /api/me/cli-agent/account`, vendor-generic, with the tool
// axis carried by the `X-Beezi-Agent: cursor` header `machineHeaders()` already sends. The older
// claim in this header — that an unknown `cursor` header is folded onto Claude Code — was stale:
// `BeeziAgent.CURSOR = 'cursor'` exists in the portal tree (62610eb) and resolves correctly; only
// an ABSENT header falls back to Claude Code. The transcribed acceptance matrix, field by field,
// lives in `test/fixtures/backend-contract.json` → `me/cli-agent/account`, and
// `test/report-contract.test.mjs` asserts this module's allowlist is a subset of it.
//
// What remains unproven is DEPLOYMENT, not shape. `docs/gate-record.md` records the whole Cursor
// API surface as source-proof-only, uncommitted on `feature/cursor-provider-analytics` and not
// deployed to any environment this session could reach. So:
//
//   * `ACCOUNT_CHECKIN_ENDPOINT` is set and `deps.enabled` defaults to true, but this module still
//     posts nothing on its own — Phase B3 owns the call sites and none exists yet.
//   * `subscriptionStatus` is ON the allowlist and must NOT be POPULATED until plan §4 E3's
//     migration and code release are verified per tenant. Under the server's global
//     `forbidNonWhitelisted` pipe an undeployed property 400s the WHOLE check-in, so an early
//     status field does not degrade the request, it destroys it. `buildCheckInPayload` therefore
//     omits it unless a caller opts in.
//
// ─── WHITESPACE IN `subscriptionType` (plan §2 C9) ───────────────────────────────────────────
// `SECRET_LIKE` rejects any value containing whitespace, so a raw Cursor tier such as
// `"Teams Premium"` would fail the check-in CLIENT-SIDE and never reach the server's
// alias-discovery loop. Whitespace runs in `subscriptionType` are collapsed to `_` BEFORE
// validation, hashing and sending, so what is validated is exactly what is posted. Nothing is lost
// for alias matching — the server's own `canonicalize` does `[-\s]+ → '_'` anyway — but the
// discovery loop sees `Teams_Premium`, not the original spelling. That is the accepted trade.
export const ACCOUNT_CHECKIN_ENDPOINT = ENDPOINTS.accountSync;

export const CHECKIN_STATE_VERSION = 1;

// Re-check in at least DAILY even when nothing changed, so a server that lost the row recovers
// without waiting for the user's plan to move.
//
// It was weekly, and a week is what losing the row actually cost: the server's session upsert only
// LINKS an existing `cli_agent_accounts` row and never creates one, so from the moment the row went
// missing every session report mapped to no subscription until the heartbeat came round again, and
// nothing told the client in between. A newer server now says so in whoami
// (`cliAgentAccountKnown: false`) and session start forces a check-in on it; this bound is the belt
// for an older server that cannot say. One small POST per machine per day is the price.
export const CHECKIN_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

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

// ── the payload

// Everything this client may send. It is an ALLOWLIST, not a filter: a field outside it is a schema
// failure rather than a quietly dropped key, because the way secrets leak is one caller adding a
// field that everything downstream happily forwards.
//
// Deliberately absent: API-key fingerprints (`keys`) and `rateLimitTier`. Both are declared by the
// server DTO; `keys` is a Claude Code mechanism with no Cursor equivalent, and Cursor has no
// rate-limit tier to report. Also absent, and load-bearing: `subscriptionId`. It is the
// SUBSCRIPTION the seat belongs to, kept in billing.json as a local switch signal only, and there
// is no server field that means it — sending it under `accountUuid` would collapse every member of
// a Team plan onto the paying owner's row (plan §3.1).
//
// THESE NAMES ARE THE SERVER'S, NOT OURS. The route runs under a global
// `ValidationPipe({whitelist: true, forbidNonWhitelisted: true})`, so a single name this DTO does
// not declare 400s the entire check-in rather than dropping one field. The previous allowlist
// (`environment`, `cursorAccountEmail`, `plan`, …) was wrong in every entry and would have failed
// whole. See `test/fixtures/backend-contract.json` → `me/cli-agent/account.accepted_properties`.
export const CHECKIN_PAYLOAD_FIELDS = Object.freeze([
  'accountUuid',
  'email',
  'subscriptionType',
  'subscriptionStatus',
]);

const SECRET_LIKE = /sk-|\s/;

// The one field whose value may legitimately contain spaces (`"Teams Premium"`). Collapsing happens
// here, once, on the object that is then validated, hashed AND posted — collapsing inside the
// validator would validate one string and send another, and hash a third.
export function normalizeCheckInPayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const type = payload.subscriptionType;
  if (typeof type !== 'string') return payload;
  const collapsed = type.trim().replace(/\s+/g, '_');
  if (collapsed === type) return payload;
  return { ...payload, subscriptionType: collapsed };
}

// Map the local facts onto the server's vocabulary. One place does this mapping so a call site
// cannot invent a field name, and so the `subscriptionId` rule above has exactly one enforcement
// point. Null/absent facts are OMITTED rather than sent as null: an empty body is a valid,
// meaningful check-in ("this agent could identify nothing").
//
//   sources.anchor  — billing.json's `accountAnchor` {email, accountId, subscriptionId, source}
//   sources.account — `readCursorAccount()`'s {plan, rawPlan, ..., status}; `rawPlan` is what the
//                     server's alias-discovery loop needs, not the normalized plan.
//   sources.record  — the billing.json record, for `subscriptionStatus` (spelled `status` on the
//                     account object and `subscriptionStatus` on the record — not the same name).
//   options.includeSubscriptionStatus — OFF by default; see the E3 deployment gate in the header.
export function buildCheckInPayload(sources, options) {
  const s = sources == null ? {} : sources;
  const opts = options == null ? {} : options;
  const anchor = s.anchor == null ? {} : s.anchor;
  const account = s.account == null ? {} : s.account;
  const record = s.record == null ? {} : s.record;
  const payload = {};

  const accountUuid = normalizeAccountIdentifier(anchor.accountId);
  if (accountUuid !== null) payload.accountUuid = accountUuid;

  const email = normalizeAccountEmail(anchor.email);
  if (email !== null) payload.email = email;

  const rawPlan = typeof account.rawPlan === 'string' && account.rawPlan.trim() !== '' ? account.rawPlan.trim() : null;
  if (rawPlan !== null) payload.subscriptionType = rawPlan;

  if (opts.includeSubscriptionStatus === true) {
    const status = typeof record.subscriptionStatus === 'string' && record.subscriptionStatus.trim() !== ''
      ? record.subscriptionStatus.trim()
      : null;
    if (status !== null) payload.subscriptionStatus = status;
  }

  return normalizeCheckInPayload(payload);
}

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

// ── heartbeat state

export function accountSyncStateDir() {
  return path.join(beeziCursorHome(), 'account-sync');
}

// Scoped by environment + Beezi account, and DELIBERATELY NOT by the Cursor account (plan §2 C8).
//
// This is the flip-back guarantee and it is load-bearing. With the Cursor account in the key,
// sub1 → sub2 → sub1 inside one heartbeat window lands back on sub1's OWN state file, finds
// `lastHash === hash`, and returns SKIPPED — the re-map to sub1 silently never happens. One file
// per (environment, Beezi account) makes the state mean "the last identity this machine sent", so
// any return to a previous tuple is itself a change and re-sends.
//
// The key is built here, from two named fields, rather than by reusing `accountScopeKey` from
// lib/cost-reconcile.mjs with one field left out: call sites build ONE scope object for both
// subsystems, and a shared helper would happily fold `cursorAccount` back into this key and
// reinstate the exact bug this exists to kill. Two segments also means a key written here can
// never collide with a three-segment cost-state key.
//
// UPGRADE NOTE: the digest is the FILENAME, so every state file written by the previous
// three-segment scoping is orphaned by this change. The first check-in after upgrade reads
// `state == null` → due → sends. One extra check-in per installed machine, once. Expected.
export function checkInScopeKey(scope) {
  const s = scope == null ? {} : scope;
  return [
    s.env == null ? '' : String(s.env),
    s.beeziAccount == null ? '' : String(s.beeziAccount),
  ].join('|');
}

export function checkInScopeDigest(scope) {
  return crypto.createHash('sha256').update(checkInScopeKey(scope)).digest('hex').slice(0, 16);
}

export function accountSyncStateFile(scope) {
  return path.join(accountSyncStateDir(), `${checkInScopeDigest(scope)}.json`);
}

function emptyState(scope) {
  return { version: CHECKIN_STATE_VERSION, scope: checkInScopeKey(scope), lastHash: null, lastSuccessAt: null };
}

export function readAccountSyncState(file, scope) {
  const raw = readJson(file);
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return emptyState(scope);
  if (raw.version !== CHECKIN_STATE_VERSION) return emptyState(scope);
  if (raw.scope !== checkInScopeKey(scope)) return emptyState(scope);
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
    scope: checkInScopeKey(scope),
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

// ── charged-cost summary (BILL-09)

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

// ── server plan writeback

// Whether a plan the server sent back may replace the local record.
//
// Source precedence, in the order the tests enforce it:
//   1. The response must name an account, and it must be the account we are CURRENTLY observing.
//      An unknown account on either side is a refusal, never an assumed match. An `accountUuid` is
//      preferred over the email whenever BOTH sides carry one: two people can share an address in
//      a tenant, and only the uuid says the server answered about the row we asked about.
//   2. The plan must carry SERVER AUTHORITY (plan §2 C10 / §4 E6). Only a plan a portal admin set
//      by hand — `planSource === 'manual'` — may replace a local observation. Anything else is the
//      server echoing back the plan this very check-in just reported, always with a newer
//      timestamp, so the freshness rule below can never refuse it; accepting it makes billing.json
//      oscillate against the next vscdb read forever.
//   3. The plan must be in the local vocabulary. Storing an unmapped string here would put a tier
//      with no seat rate into the record that prices the seat.
//   4. The response must be strictly fresher than the local observation it would replace. A stale
//      server row must never overwrite a plan the user typed five minutes ago.
export function planWriteback(response, context) {
  const ctx = context == null ? {} : context;
  const refuse = (reason) => ({ accepted: false, reason, record: null });
  if (response == null || typeof response !== 'object') return refuse('no-plan');
  if (typeof response.plan !== 'string' || response.plan === '') return refuse('no-plan');

  const account = response.account == null ? {} : response.account;
  const anchor = ctx.anchor == null ? {} : ctx.anchor;
  const servedId = normalizeAccountIdentifier(account.accountUuid);
  const localId = normalizeAccountIdentifier(anchor.accountId);
  if (servedId !== null && localId !== null) {
    // Both sides know an id: it decides, on its own, in both directions.
    if (servedId !== localId) return refuse('account-mismatch');
  } else {
    const served = normalizeAccountEmail(account.email);
    const local = normalizeAccountEmail(anchor.email);
    if (served === null || local === null) return refuse('account-unknown');
    if (served !== local) return refuse('account-mismatch');
  }

  // Written as two explicit refusals rather than one `!== 'manual'` comparison, on purpose. The
  // ABSENT case is a distinct fact — an old server, or a tenant that has not received E6, sends no
  // `planSource` at all — and it must be visible in the outcome, so that nobody later "simplifies"
  // this into a truthy check and silently re-enables the oscillation.
  if (typeof response.planSource !== 'string') return refuse('plan-source-unknown');
  if (response.planSource !== 'manual') return refuse('plan-source-reported');

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
      // The server was asked about a plan, not about a rate-limit tier or a Stripe subscription
      // status; a response that does not mention one is not evidence that the locally observed one
      // is gone. `subscriptionStatus` is a v3 record field and must survive a writeback — dropping
      // it would silently discard the status the check-in itself just learned.
      rateLimitTier: existing == null ? null : existing.rateLimitTier,
      subscriptionStatus: existing == null ? null : existing.subscriptionStatus,
      capturedAt: new Date(observedAt).toISOString(),
      identityCheckedAt: ctx.now == null ? null : new Date(ctx.now).toISOString(),
      migratedAt: existing == null ? null : existing.migratedAt,
      accountAnchor: ctx.anchor,
      capturedBy: 'server',
      selfReported: false,
    },
  };
}

// ── the client

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
//   payload — allowlisted, non-secret facts only (CHECKIN_PAYLOAD_FIELDS), normally from
//             `buildCheckInPayload`.
//   auth    — `{ getToken(), authEpoch() }` (CONTRACTS §2), injected.
//   deps    — `{ enabled=true, endpoint=ACCOUNT_CHECKIN_ENDPOINT, postJson, scope, now,
//                existingBillingRecord, anchor, force=false }`.
//
// `force` skips the due gate ONLY (plan §2 C7). It is for the moments where the caller already
// knows something moved — a fresh link, an observed account switch, a server that says it has no
// row for us — and waiting out the heartbeat would leave the server holding the wrong subscription. It does not skip the schema
// check, the scope check or the auth fence, because none of those is a rate limit.
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
  // Default ON. The kill switch is still here and still explicit - a caller that has a reason to
  // stay quiet passes `enabled: false` - but "nothing is sent" is now the call sites' job (B3),
  // not a default this module hides behind.
  if (d.enabled === false) return result(CheckInOutcome.DISABLED);
  const endpoint = d.endpoint === undefined ? ACCOUNT_CHECKIN_ENDPOINT : d.endpoint;
  if (endpoint == null) return result(CheckInOutcome.UNCONFIGURED);

  // Normalize BEFORE validating, hashing or sending, so all three see one object (see
  // `normalizeCheckInPayload`: a `"Teams Premium"` collapsed only for validation would be posted
  // raw and hashed in a third form).
  const sent = normalizeCheckInPayload(payload);
  const valid = validateCheckInPayload(sent);
  if (!valid.ok) return result(CheckInOutcome.SCHEMA, { reason: valid.reason });

  // The heartbeat is scoped by environment + Beezi account, and an incomplete scope is REFUSED
  // rather than degraded. Filling a missing `beeziAccount` with null would key two Beezi accounts
  // on one machine to the same file, which is the mis-attribution the scoping exists to prevent -
  // and it would fail silently, as a check-in that looks successful. The Cursor account is NOT part
  // of the scope and its presence or absence is not checked: see `checkInScopeKey` for why keying
  // on it breaks flip-back.
  const scope = d.scope;
  if (scope == null || typeof scope !== 'object' || scope.env == null || scope.beeziAccount == null) {
    return result(CheckInOutcome.SCHEMA, { reason: 'incomplete-scope' });
  }
  const file = accountSyncStateFile(scope);
  const state = readAccountSyncState(file, scope);
  const hash = hashCheckInPayload(sent);
  if (d.force !== true && !isCheckInDue(state, hash, now)) return result(CheckInOutcome.SKIPPED);

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
    response = await d.postJson(endpoint, sent, token);
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
