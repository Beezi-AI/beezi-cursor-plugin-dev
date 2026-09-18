import crypto from 'crypto';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// Recoverable cumulative-cost reconciliation (BILL-01).
//
// A queued report that expires or is lost takes its segment's cost with it forever: the next delta
// is measured against a usage snapshot that already moved past it, and `usageData` is CUMULATIVE,
// so the increment cannot be recomputed. This module is the repair path — it rebuilds an
// authoritative cumulative statement from what the host can still be read for, and tracks
// separately what it ATTEMPTED to scan and what the server ACKNOWLEDGED.
//
// ─── WHAT IS NOT HERE, ON PURPOSE ────────────────────────────────────────────────────────────
// There is no route. Replaying cumulative totals into an additive segment ingest double-bills, so
// the server must first specify replacement/max/revision semantics, identity (account AND
// environment, not just conversation/model/pool), reset and decreasing-total handling, and how a
// cumulative statement reconciles with segments already reported. Until that contract exists and
// is deployed, `COST_RECONCILE_ENDPOINT` is null and the sender refuses to post. An invented URL
// plus a mocked 200 would close nothing.
export const COST_RECONCILE_ENDPOINT = null;

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const COST_STATE_VERSION = 1;

// At most hourly, from a non-permission lifecycle tail. A manual sync passes `force`.
export const MIN_SCAN_INTERVAL_MS = 60 * 60 * 1000;

// How far BEHIND the acknowledged floor a scan still looks. A wall-clock watermark alone skips a
// conversation whose cost the vendor updated late: its `updatedAt` is older than the floor even
// though its usage is not. Overlap is cheap because the statement is cumulative and idempotent by
// construction; a gap is not recoverable at all.
export const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

// How long one worker's claim on a scan is honored. Shorter than a scan is bad (two workers), much
// longer is bad too (a killed worker holds the gate), so it sits well above a scan and well below
// the schedule.
export const ATTEMPT_LEASE_MS = 10 * 60 * 1000;

export const SnapshotStatus = Object.freeze({
  OK: 'ok',
  UNREADABLE: 'unreadable',
});

// ── the pure snapshot builder ─────────────────────────────────────────────────────────────────

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

// One `{ [model]: { amount, costInCents } }` map, keeping only records we can actually read.
// Returns `{ models, complete }`: `complete` is false when a record was dropped, because a record
// we could not interpret is an UNKNOWN and must not be summed as a zero.
function readModels(usage) {
  const models = {};
  let complete = true;
  for (const key of Object.keys(usage)) {
    const record = usage[key];
    if (record == null || typeof record !== 'object' || Array.isArray(record)) { complete = false; continue; }
    const amount = finiteNumber(record.amount);
    const costInCents = finiteNumber(record.costInCents);
    if (amount === null || costInCents === null) { complete = false; continue; }
    models[key] = { amount, costInCents };
  }
  return { models, complete };
}

// Build the authoritative cumulative statement from whatever the host could be read for.
//
//   readableUsage — `[{ conversationId, usage, updatedAt }]`, where `usage` is exactly what
//                   `readUsageData` returns: null (unreadable), {} (read, nothing priced), or the
//                   per-model map. The reader is injected by the caller; this function is pure.
//
// The three outcomes are kept apart deliberately. `unreadable` is a FAILURE — it must never be
// presented as a successful scan that found no cost, because the server would then believe the
// machine spent nothing. `{}` is a real zero. A partial read is a success with `totals.complete`
// false, so the server can see that the total is a floor rather than the whole truth.
export function buildUsageSnapshot(readableUsage, options) {
  const opts = options == null ? {} : options;
  const now = opts.now == null ? Date.now() : opts.now;
  const base = {
    version: SNAPSHOT_SCHEMA_VERSION,
    scope: opts.account == null ? null : opts.account,
    scannedAt: new Date(now).toISOString(),
    entries: [],
    unknownConversations: [],
    totals: { costInCents: null, requests: null, complete: false, knownConversations: 0, unknownConversations: 0 },
  };

  if (!Array.isArray(readableUsage)) {
    return { ...base, status: SnapshotStatus.UNREADABLE, reason: 'source-unreadable' };
  }

  const entries = [];
  const unknown = [];
  let costInCents = 0;
  let requests = 0;
  let complete = true;

  for (const item of readableUsage) {
    if (item == null || typeof item !== 'object') { complete = false; continue; }
    const id = typeof item.conversationId === 'string' && item.conversationId !== '' ? item.conversationId : null;
    if (id === null) { complete = false; continue; }
    const usage = item.usage;
    if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) {
      unknown.push(id);
      complete = false;
      continue;
    }
    const read = readModels(usage);
    if (!read.complete) complete = false;
    for (const key of Object.keys(read.models)) {
      costInCents += read.models[key].costInCents;
      requests += read.models[key].amount;
    }
    entries.push({ conversationId: id, models: read.models, updatedAt: item.updatedAt == null ? null : item.updatedAt });
  }

  // Entries existed and not one of them could be read: that is the source failing, not a machine
  // with no spend.
  if (entries.length === 0 && readableUsage.length > 0) {
    return {
      ...base,
      status: SnapshotStatus.UNREADABLE,
      reason: 'no-conversation-readable',
      unknownConversations: unknown,
      totals: { ...base.totals, unknownConversations: unknown.length },
    };
  }

  return {
    ...base,
    status: SnapshotStatus.OK,
    entries,
    unknownConversations: unknown,
    totals: {
      costInCents,
      requests,
      complete,
      knownConversations: entries.length,
      unknownConversations: unknown.length,
    },
  };
}

// ── account-scoped pending state ──────────────────────────────────────────────────────────────

// Exported because lib/account-sync.mjs scopes its heartbeat state by exactly the same three
// facts, and two spellings of one scope key mean two files that disagree about which account they
// belong to. A shared lib/account-scope.mjs is the eventual home; see the handoff.
export function accountScopeKey(scope) {
  const s = scope == null ? {} : scope;
  return [
    s.env == null ? '' : String(s.env),
    s.beeziAccount == null ? '' : String(s.beeziAccount),
    s.cursorAccount == null ? '' : String(s.cursorAccount).toLowerCase(),
  ].join('|');
}

export function accountScopeDigest(scope) {
  return crypto.createHash('sha256').update(accountScopeKey(scope)).digest('hex').slice(0, 16);
}

// One file per (environment, Beezi account, Cursor account). Scoping matters here more than
// anywhere else in the plugin: a floor carried across an account switch would tell the new account
// that the old account's conversations were already reconciled.
//
// The path SHAPE lives here rather than in lib/paths-cursor.mjs because that file is shared and
// frozen for this change; the handoff carries the patch that moves it there.
export function costStateDir() {
  return path.join(beeziCursorHome(), 'cost-state');
}

export function costStateFile(scope) {
  return path.join(costStateDir(), `${accountScopeDigest(scope)}.json`);
}

function emptyState(scope) {
  return {
    version: COST_STATE_VERSION,
    scope: accountScopeKey(scope),
    attemptedScanAt: null,
    acknowledgedScanAt: null,
    attempt: null,
  };
}

// A missing, corrupt, foreign-version or foreign-scope file reads as "nothing has been
// acknowledged". Every one of those is a reason to rescan; none is evidence of progress.
export function readCostState(file, scope) {
  const raw = readJson(file);
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return emptyState(scope);
  if (raw.version !== COST_STATE_VERSION) return emptyState(scope);
  if (raw.scope !== accountScopeKey(scope)) return emptyState(scope);
  return {
    version: COST_STATE_VERSION,
    scope: raw.scope,
    attemptedScanAt: finiteNumber(raw.attemptedScanAt),
    acknowledgedScanAt: finiteNumber(raw.acknowledgedScanAt),
    attempt: raw.attempt == null || typeof raw.attempt !== 'object' ? null : raw.attempt,
  };
}

export function writeCostState(file, state, scope) {
  writeJsonSecure(file, { ...state, version: COST_STATE_VERSION, scope: accountScopeKey(scope) });
}

// ── scheduling and the attempt gate ───────────────────────────────────────────────────────────

// The state transitions below all take a partial state (a caller may hold one built by hand, or a
// state file written before a field existed) and always hand back a complete one. A missing
// `acknowledgedScanAt` must read as `null` — "nothing acknowledged" — never as `undefined`, which
// would serialize away and make the next reader guess.
function normalizeState(state) {
  const s = state == null ? {} : state;
  return {
    ...s,
    version: COST_STATE_VERSION,
    attemptedScanAt: finiteNumber(s.attemptedScanAt),
    acknowledgedScanAt: finiteNumber(s.acknowledgedScanAt),
    attempt: s.attempt == null || typeof s.attempt !== 'object' ? null : s.attempt,
  };
}

export function isScanDue(state, now = Date.now(), options) {
  const opts = options == null ? {} : options;
  if (opts.force === true) return true;
  const last = state == null ? null : finiteNumber(state.attemptedScanAt);
  if (last === null) return true;
  return now - last >= MIN_SCAN_INTERVAL_MS;
}

// A scan is single-worker. Two scans of the same cumulative source are not harmful in themselves
// (the statement is idempotent), but they double the host reads inside a lifecycle tail that has a
// budget, so the gate exists. The lease is what stops a worker killed mid-scan from owning it.
export function claimScanAttempt(state, options) {
  const opts = options == null ? {} : options;
  const now = opts.now == null ? Date.now() : opts.now;
  const leaseMs = opts.leaseMs == null ? ATTEMPT_LEASE_MS : opts.leaseMs;
  const base = normalizeState(state);
  const current = base.attempt;
  if (current != null && finiteNumber(current.leaseUntil) !== null && current.leaseUntil > now) {
    return { claimed: false, state: base };
  }
  return {
    claimed: true,
    state: {
      ...base,
      // ATTEMPTED, not acknowledged. Advancing the floor here is exactly the bug: the report may
      // never arrive, and the next scan would start after cost nobody received.
      attemptedScanAt: now,
      attempt: { workerId: opts.workerId == null ? null : opts.workerId, claimedAt: now, leaseUntil: now + leaseMs },
    },
  };
}

export function releaseScanAttempt(state) {
  return { ...normalizeState(state), attempt: null };
}

// ── acknowledgement-only floor ────────────────────────────────────────────────────────────────

// The ONLY way the floor moves. A late acknowledgement for an older scan cannot rewind it, and an
// unacknowledged result leaves it exactly where it was so the next scan covers the same ground.
export function applyAcknowledgement(state, result, options) {
  const opts = options == null ? {} : options;
  const base = normalizeState(state);
  if (result == null || result.acknowledged !== true) return base;
  const scannedAt = finiteNumber(result.scannedAt) === null
    ? (opts.now == null ? Date.now() : opts.now)
    : result.scannedAt;
  const floor = base.acknowledgedScanAt;
  return { ...base, acknowledgedScanAt: floor === null ? scannedAt : Math.max(floor, scannedAt) };
}

// Which conversations a scan covers. `LOOKBACK_MS` of deliberate overlap below the floor, and an
// entry whose `updatedAt` we cannot read is always in scope — an unreadable timestamp is not
// evidence that the conversation is settled.
export function selectConversations(entries, state, options) {
  if (!Array.isArray(entries)) return [];
  const opts = options == null ? {} : options;
  const floor = state == null ? null : finiteNumber(state.acknowledgedScanAt);
  if (floor === null) return entries.slice();
  const cutoff = floor - (opts.lookbackMs == null ? LOOKBACK_MS : opts.lookbackMs);
  return entries.filter((e) => {
    if (e == null) return false;
    const updated = typeof e.updatedAt === 'number' ? e.updatedAt : Date.parse(String(e.updatedAt));
    if (!Number.isFinite(updated)) return true;
    return updated >= cutoff;
  });
}

// ── the sender (gated off) ────────────────────────────────────────────────────────────────────

// Sends an authoritative cumulative statement. Default-off and route-less: both gates have to be
// opened deliberately, by a caller that has the deployed contract in hand.
//
//   deps.enabled   — false unless the caller says otherwise. No caller says otherwise yet.
//   deps.endpoint  — defaults to COST_RECONCILE_ENDPOINT, which is null.
//   deps.postJson  — `(endpoint, body, token) -> { ok, status, body }`. Injected, so this module
//                    builds no URL of its own.
//   auth           — `{ getToken(), authEpoch() }` (CONTRACTS §2, injected until the auth lane
//                    lands). The epoch is checked immediately before the send and again before the
//                    response is applied, so an old account's payload is never sent under new
//                    credentials and a late answer is never applied to a machine that moved on.
export async function sendUsageSnapshot(snapshot, auth, deps) {
  const d = deps == null ? {} : deps;
  const refuse = (reason) => ({ ok: false, sent: false, acknowledged: false, reason });

  if (d.enabled !== true) return refuse('disabled');
  const endpoint = d.endpoint === undefined ? COST_RECONCILE_ENDPOINT : d.endpoint;
  if (endpoint == null) return refuse('endpoint-unconfigured');
  if (snapshot == null || snapshot.status !== SnapshotStatus.OK) return refuse('unreadable');

  let fence;
  try {
    fence = await auth.authEpoch();
  } catch {
    return refuse('auth-unavailable');
  }
  // The caller may have built this payload under an earlier epoch; if so it belongs to an account
  // this machine is no longer linked to.
  if (d.fenceAtBuild != null && d.fenceAtBuild !== fence) return refuse('epoch-changed');

  let token = null;
  try {
    token = await auth.getToken();
  } catch {
    token = null;
  }
  if (token == null) return refuse('unlinked');
  // Recheck IMMEDIATELY before the request, not only at build time: `getToken` is an await, and a
  // relink landing inside it would send this account's cumulative statement under another
  // account's credentials.
  try {
    if (await auth.authEpoch() !== fence) return refuse('epoch-changed');
  } catch {
    return refuse('auth-unavailable');
  }

  let response;
  try {
    response = await d.postJson(endpoint, snapshot, token);
  } catch {
    return { ok: false, sent: false, acknowledged: false, reason: 'transport' };
  }

  let after;
  try {
    after = await auth.authEpoch();
  } catch {
    after = null;
  }
  if (after !== fence) {
    return { ok: true, sent: true, acknowledged: false, reason: 'epoch-changed' };
  }

  if (response == null || response.ok !== true) {
    return { ok: false, sent: true, acknowledged: false, reason: 'http', status: response == null ? null : response.status };
  }
  const body = response.body;
  const acknowledged = body != null && typeof body === 'object' && body.acknowledged === true;
  return {
    ok: true,
    sent: true,
    acknowledged,
    reason: acknowledged ? 'acknowledged' : 'unacknowledged',
    scannedAt: Date.parse(snapshot.scannedAt),
  };
}
