import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_CHECKIN_ENDPOINT,
  CHECKIN_HEARTBEAT_MS,
  CheckInOutcome,
  CHECKIN_PAYLOAD_FIELDS,
  buildCheckInPayload,
  normalizeCheckInPayload,
  validateCheckInPayload,
  hashCheckInPayload,
  accountSyncStateFile,
  readAccountSyncState,
  writeAccountSyncState,
  isCheckInDue,
  summarizeChargedCost,
  planWriteback,
  checkInAccount,
} from '../lib/account-sync.mjs';
import { BILLING_POOL } from '../lib/delta-cursor.mjs';
import { ENDPOINTS } from '../lib/config.mjs';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
// The check-in scope is (environment, Beezi account) and NOTHING else. `cursorAccount` is carried
// on the object the call sites build for cost-reconcile and must be IGNORED here - see the
// flip-back tests below for the bug that keying on it causes.
const SCOPE = { env: '', beeziAccount: 'tenant-1|user-1' };
const SCOPE_WITH_CURSOR = { ...SCOPE, cursorAccount: 'dev@example.com' };

// The server's vocabulary, not ours: camelCase, and every name declared by
// CliAgentAccountSyncRequestDto. Under forbidNonWhitelisted one wrong name 400s the whole request.
const PAYLOAD = Object.freeze({
  accountUuid: 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T',
  email: 'dev@example.com',
  subscriptionType: 'pro',
});

const SUB1 = PAYLOAD;
const SUB2 = Object.freeze({ ...PAYLOAD, accountUuid: 'auth0|user_02ZZZZZZZZZZZZZZZZZZZZZZZZ', subscriptionType: 'ultra' });

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-acct-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeAuth(overrides) {
  const state = { epoch: 'prod|t1|u1|3', token: 'tok', ...(overrides == null ? {} : overrides) };
  return {
    getToken: async () => { if (state.onTokenRead) state.onTokenRead(); return state.token; },
    authEpoch: async () => state.epoch,
    _set: (next) => Object.assign(state, next),
  };
}

// Injected, test-only. Nothing here asserts that any particular server path exists.
const FAKE_ENDPOINT = '/test-only-not-a-real-route';

function deps(overrides) {
  return {
    enabled: true,
    endpoint: FAKE_ENDPOINT,
    postJson: async () => ({ ok: true, status: 200, body: {} }),
    now: NOW,
    ...(overrides == null ? {} : overrides),
  };
}

// ── payload: non-secret only ──────────────────────────────────────────────────────────────────

test('the payload allowlist carries no key material or environment secrets', () => {
  for (const field of CHECKIN_PAYLOAD_FIELDS) {
    assert.equal(/key|token|secret|fingerprint|credential/i.test(field), false, `${field} looks like a secret`);
  }
});

test('an unknown or secret-looking field is a schema failure, not a silent drop', () => {
  assert.equal(validateCheckInPayload(PAYLOAD).ok, true);
  assert.equal(validateCheckInPayload({ ...PAYLOAD, apiKeyFingerprint: 'abc' }).ok, false);
  // The OLD allowlist's names are now unknown fields. Sending one would 400 the whole check-in
  // server-side, so it must fail here first.
  assert.equal(validateCheckInPayload({ ...PAYLOAD, plan: 'pro' }).ok, false);
  assert.equal(validateCheckInPayload({ ...PAYLOAD, cursorAccountEmail: 'dev@example.com' }).ok, false);
  assert.equal(validateCheckInPayload({ ...PAYLOAD, subscriptionType: 'sk-not-a-plan' }).ok, false);
  assert.equal(validateCheckInPayload(null).ok, false);
  assert.equal(validateCheckInPayload([]).ok, false);
});

test('the hash covers the allowlisted fields and ignores key order', () => {
  const reordered = { subscriptionType: 'pro', email: 'dev@example.com', accountUuid: 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T' };
  assert.equal(hashCheckInPayload(PAYLOAD), hashCheckInPayload(reordered));
  assert.notEqual(hashCheckInPayload(PAYLOAD), hashCheckInPayload({ ...PAYLOAD, subscriptionType: 'ultra' }));
  assert.match(hashCheckInPayload(PAYLOAD), /^[0-9a-f]{64}$/);
});

// ── heartbeat state ───────────────────────────────────────────────────────────────────────────

test('check-in state is scoped by environment and Beezi account ONLY', (t) => {
  tempHome(t);
  const files = [
    accountSyncStateFile(SCOPE),
    accountSyncStateFile({ ...SCOPE, env: '-dev' }),
    accountSyncStateFile({ ...SCOPE, beeziAccount: 'tenant-2|user-2' }),
  ];
  assert.equal(new Set(files).size, 3, 'environment and Beezi account each separate the state');
  // And the Cursor account does NOT separate it. With the Cursor account in the key, a machine
  // that goes sub1 -> sub2 -> sub1 inside one heartbeat window lands back on sub1's own file, finds the
  // matching hash and SKIPS - the re-map to sub1 never happens. One file per (env, Beezi account)
  // makes the state mean "the last identity this machine sent".
  assert.equal(accountSyncStateFile(SCOPE_WITH_CURSOR), accountSyncStateFile(SCOPE));
  assert.equal(accountSyncStateFile({ ...SCOPE, cursorAccount: 'other@example.com' }), accountSyncStateFile(SCOPE));
});

test('a changed payload is due immediately; an unchanged one waits out the heartbeat', (t) => {
  tempHome(t);
  const hash = hashCheckInPayload(PAYLOAD);
  const HOUR = 60 * 60 * 1000;
  const state = { lastHash: hash, lastSuccessAt: NOW - HOUR };
  assert.equal(isCheckInDue(state, hash, NOW), false);
  assert.equal(isCheckInDue(state, hashCheckInPayload({ ...PAYLOAD, subscriptionType: 'ultra' }), NOW), true);
  assert.equal(isCheckInDue(state, hash, NOW - HOUR + CHECKIN_HEARTBEAT_MS), true);
  assert.equal(isCheckInDue({ lastHash: null, lastSuccessAt: null }, hash, NOW), true);
});

// DAILY, not weekly. A server that lost this machine's `cli_agent_accounts` row cannot say so to a
// client that never asks, and session reports only LINK an existing row — so every day of heartbeat
// is a day of sessions mapped to no subscription. An old server with no `cliAgentAccountKnown` flag
// heals within a day; a new one heals on the next session start (see lib/session-start.mjs).
test('a matching hash older than 24 hours is due again', () => {
  const hash = hashCheckInPayload(PAYLOAD);
  assert.equal(CHECKIN_HEARTBEAT_MS, DAY);
  assert.equal(isCheckInDue({ lastHash: hash, lastSuccessAt: NOW - DAY - 1 }, hash, NOW), true);
  assert.equal(isCheckInDue({ lastHash: hash, lastSuccessAt: NOW - 2 * DAY }, hash, NOW), true);
  assert.equal(isCheckInDue({ lastHash: hash, lastSuccessAt: NOW - DAY + 60 * 1000 }, hash, NOW), false);
});

test('state round-trips and a foreign scope reads as never checked in', (t) => {
  tempHome(t);
  const file = accountSyncStateFile(SCOPE);
  writeAccountSyncState(file, { lastHash: 'abc', lastSuccessAt: NOW }, SCOPE);
  assert.equal(readAccountSyncState(file, SCOPE).lastHash, 'abc');
  // A foreign scope is a different Beezi account or environment. The Cursor account is not part
  // of the scope, so varying it must read the SAME state rather than an empty one.
  assert.equal(readAccountSyncState(file, { ...SCOPE, beeziAccount: 'tenant-2|user-2' }).lastHash, null);
  assert.equal(readAccountSyncState(file, SCOPE_WITH_CURSOR).lastHash, 'abc');
});

// ── charged-cost summary ──────────────────────────────────────────────────────────────────────

const seg = (segmentId, models) => ({ segmentId, models });

// The per-ROW pool vocabulary is lib/delta-cursor.mjs's BILLING_POOL, whose credits member is
// spelled `credits`. It is NOT the report-level BillingSource enum, whose member is
// `cursor_credits`. Branching on the wrong one silently turns every charged row into an unknown.
test('the summary reads the pool vocabulary the delta actually emits', () => {
  assert.deepEqual(Object.keys(BILLING_POOL).sort(), ['CREDITS', 'SUBSCRIPTION', 'UNKNOWN']);
  const s = summarizeChargedCost([seg('a', [{ model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 1, cost_usd: 7 }])]);
  assert.equal(s.chargedCostUsd, 7);
  assert.equal(s.complete, true);
  // The report-level spelling is a different vocabulary and must not be accepted as a pool.
  assert.equal(summarizeChargedCost([seg('b', [{ model: 'm1', billing_pool: 'cursor_credits', requests: 1, cost_usd: 7 }])]).chargedCostUsd, null);
});

test('charged cost means vendor-charged overage, not seat allocation', () => {
  const s = summarizeChargedCost([
    seg('a', [
      { model: 'm1', billing_pool: BILLING_POOL.SUBSCRIPTION, requests: 10, cost_usd: 4.2 },
      { model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 2, cost_usd: 0.5 },
    ]),
  ]);
  // The seat row's notional dollars are a list-rate estimate of covered usage; adding them to a
  // charged total would tell the user they paid for their own allowance.
  assert.equal(s.chargedCostUsd, 0.5);
  assert.equal(s.complete, true);
  assert.equal(s.seatCoveredEntries, 1);
});

test('an unknown pool is unknown, never zero', () => {
  const s = summarizeChargedCost([seg('a', [{ model: 'm1', billing_pool: BILLING_POOL.UNKNOWN, requests: 3 }])]);
  assert.equal(s.chargedCostUsd, null, 'a machine with no readable pool has not been shown to owe nothing');
  assert.equal(s.complete, false);
  assert.equal(s.unknownEntries, 1);
});

test('a partially known total keeps the known part and says so', () => {
  const s = summarizeChargedCost([
    seg('a', [{ model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 1, cost_usd: 1.25 }]),
    seg('b', [{ model: 'm2', billing_pool: BILLING_POOL.UNKNOWN, requests: 1 }]),
  ]);
  assert.equal(s.chargedCostUsd, 1.25);
  assert.equal(s.complete, false);
});

test('a credits row with no cost figure is unknown, not free', () => {
  const s = summarizeChargedCost([seg('a', [{ model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 4 }])]);
  assert.equal(s.chargedCostUsd, null);
  assert.equal(s.complete, false);
});

test('a session that really spent nothing on credits is an honest zero', () => {
  const s = summarizeChargedCost([seg('a', [{ model: 'm1', billing_pool: BILLING_POOL.SUBSCRIPTION, requests: 9, cost_usd: 3 }])]);
  assert.equal(s.chargedCostUsd, 0);
  assert.equal(s.complete, true);
  assert.equal(summarizeChargedCost([]).chargedCostUsd, 0);
});

test('an unreadable segment list is unknown, not zero', () => {
  assert.equal(summarizeChargedCost(null).chargedCostUsd, null);
  assert.equal(summarizeChargedCost('nope').complete, false);
});

// The REAL shapes checkpoint.mjs emits. Main segment ids are `<sessionId>:<from>-<to>` and
// subagent ids are `<sessionId>:<agentId>:<from>-<to>`, so the two NEVER collide and an id-only
// dedupe cannot separate them. `subagentModelsFrom` mirrors the parent's model and pool with every
// count zeroed and NO `cost_usd` key at all - that is its signature, and it must be recognised as
// a mirror rather than counted as a conversation whose price we failed to read.
const MAIN = seg('sess-1:0-10', [
  { model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 2, cost_usd: 2 },
  { model: 'm1', billing_pool: BILLING_POOL.SUBSCRIPTION, requests: 8, cost_usd: 0 },
]);
const SUBAGENT_MIRROR = seg('sess-1:agent-7:0-10', [
  { model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 0, token_input: 0, token_output: 0 },
  { model: 'm1', billing_pool: BILLING_POOL.SUBSCRIPTION, requests: 0, token_input: 0, token_output: 0 },
]);

test('a zeroed subagent mirror is a mirror, not a conversation we failed to price', () => {
  const s = summarizeChargedCost([MAIN, SUBAGENT_MIRROR]);
  assert.equal(s.chargedCostUsd, 2);
  // Before this was recognised, every session that spawned a subagent while spending credits came
  // back `complete: false` - the summary was unusable on exactly the sessions that cost money.
  assert.equal(s.complete, true);
  assert.equal(s.unknownEntries, 0);
  assert.equal(s.mirrorEntries, 2);
  assert.equal(s.chargedEntries, 1);
  assert.equal(s.seatCoveredEntries, 1);
});

test('a replayed main segment cannot add its money twice', () => {
  // The anchor replay re-sends the SAME main segment id; the server upserts on it and so must this.
  assert.equal(summarizeChargedCost([MAIN, SUBAGENT_MIRROR, MAIN]).chargedCostUsd, 2);
});

test('a real credits row with zero requests but a price is not mistaken for a mirror', () => {
  // computeDelta emits `cost > 0, amount === 0` when the priced count under-counted; the row still
  // carries cost_usd, which is what tells it apart from a zeroed mirror.
  const s = summarizeChargedCost([seg('sess-2:0-4', [{ model: 'm1', billing_pool: BILLING_POOL.CREDITS, requests: 0, cost_usd: 0.75 }])]);
  assert.equal(s.chargedCostUsd, 0.75);
  assert.equal(s.complete, true);
  assert.equal(s.mirrorEntries, 0);
});

// ── plan writeback ────────────────────────────────────────────────────────────────────────────

const anchor = (email, accountId) => ({ email, accountId: accountId === undefined ? null : accountId, subscriptionId: null, source: 'state_vscdb' });
// Every response fixture carries `planSource: 'manual'`, because that is now the ONLY provenance a
// writeback is allowed to act on; a response without it is refused before any other rule is
// reached, which would make each of these tests pass for the wrong reason.
const served = (over) => ({ account: { email: 'dev@example.com' }, plan: 'ultra', planSource: 'manual', observedAt: '2026-05-31T00:00:00.000Z', ...(over == null ? {} : over) });
const record = (over) => ({
  version: 3, source: 'subscription', plan: 'pro', subscriptionType: 'pro', subscriptionStatus: 'active',
  capturedAt: '2026-05-30T00:00:00.000Z', identityCheckedAt: null, migratedAt: null,
  accountAnchor: anchor('dev@example.com'), capturedBy: 'login', selfReported: false,
  rateLimitTier: 'local-tier',
  ...(over == null ? {} : over),
});

test('a writeback for another account is refused', () => {
  const r = planWriteback(served({ account: { email: 'someone@else.com' } }),
    { anchor: anchor('dev@example.com'), existing: record(), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'account-mismatch');
});

test('an accountUuid decides the match whenever both sides have one', () => {
  const ctx = { anchor: anchor('dev@example.com', 'auth0|seat-1'), existing: record(), now: NOW };
  // Same address, different seat: two people can share an address inside a tenant, and only the
  // uuid says the server answered about the row we asked about.
  assert.equal(planWriteback(served({ account: { email: 'dev@example.com', accountUuid: 'auth0|seat-2' } }), ctx).reason, 'account-mismatch');
  // Same seat: accepted even though the served address is a different one.
  const ok = planWriteback(served({ account: { email: 'other@example.com', accountUuid: 'auth0|seat-1' } }), ctx);
  assert.equal(ok.accepted, true);
  // One side missing an id falls back to the email rather than refusing outright.
  assert.equal(planWriteback(served(), ctx).accepted, true);
  assert.equal(planWriteback(served({ account: { email: 'dev@example.com', accountUuid: 'auth0|seat-1' } }),
    { ...ctx, anchor: anchor('dev@example.com') }).accepted, true);
});

test('a plan the server merely echoed back is refused, and an absent provenance is its own refusal', () => {
  const ctx = { anchor: anchor('dev@example.com'), existing: record({ selfReported: true }), now: NOW };
  // An old server, or a tenant that has not received the provenance field, says nothing at all.
  // That is NOT the same fact as "reported", and it must not be silently folded into one.
  const absent = planWriteback({ account: { email: 'dev@example.com' }, plan: 'ultra', observedAt: '2026-05-31T00:00:00.000Z' }, ctx);
  assert.equal(absent.accepted, false);
  assert.equal(absent.reason, 'plan-source-unknown');
  assert.equal(planWriteback(served({ planSource: null }), ctx).reason, 'plan-source-unknown');
  // The echo. The server returns what this very check-in reported, always with a newer timestamp,
  // so the staleness rule can never refuse it; accepting it makes billing.json oscillate against
  // the next vscdb read forever.
  for (const source of ['reported', 'agent', 'inferred', 'MANUAL']) {
    const r = planWriteback(served({ planSource: source }), ctx);
    assert.equal(r.accepted, false, `planSource ${source} must not be authoritative`);
    assert.equal(r.reason, 'plan-source-reported');
  }
  assert.equal(planWriteback(served(), ctx).accepted, true, 'only a portal-manual plan is authoritative');
});

test('a writeback with no confirmable account is refused, not assumed to match', () => {
  assert.equal(planWriteback(served({ account: { email: null } }), { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).reason, 'account-unknown');
  assert.equal(planWriteback(served(), { anchor: anchor(null), existing: record(), now: NOW }).reason, 'account-unknown');
});

test('a plan outside the local vocabulary is refused rather than stored raw', () => {
  const r = planWriteback(served({ plan: 'platinum' }), { anchor: anchor('dev@example.com'), existing: record(), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'unsupported-plan');
});

test('a stale response never replaces a fresher local observation', () => {
  const r = planWriteback(served({ plan: 'free', observedAt: '2026-05-01T00:00:00.000Z' }),
    { anchor: anchor('dev@example.com'), existing: record({ selfReported: true }), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'stale');
});

test('a fresher server observation for the current account is accepted', () => {
  const r = planWriteback(served(), { anchor: anchor('dev@example.com'), existing: record({ selfReported: true }), now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(r.record.plan, 'ultra');
  assert.equal(r.record.version, 3);
  assert.equal(r.record.subscriptionStatus, 'active', 'a v3 status the check-in just learned is not dropped by a writeback');
  assert.equal(r.record.capturedBy, 'server');
  assert.equal(r.record.selfReported, false);
  assert.equal(r.record.capturedAt, '2026-05-31T00:00:00.000Z', 'freshness is the server observation, not the moment we read it');
  assert.equal(r.record.rateLimitTier, 'local-tier', 'a locally observed tier is not a field the server was asked about');
});

test('a response with no plan changes nothing', () => {
  assert.equal(planWriteback({ account: { email: 'dev@example.com' }, planSource: 'manual' }, { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).reason, 'no-plan');
  assert.equal(planWriteback(null, { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).accepted, false);
});

// ── the client ────────────────────────────────────────────────────────────────────────────────

test('the check-in endpoint is the shared cli-agent route, not an invented cursor one', () => {
  // Vendor-generic on purpose: the agent axis is the X-Beezi-Agent header machineHeaders() sends,
  // not the path. A `/me/cursor/account` spelling exists nowhere server-side and would 404.
  assert.equal(ACCOUNT_CHECKIN_ENDPOINT, '/me/cli-agent/account');
  assert.equal(ACCOUNT_CHECKIN_ENDPOINT, ENDPOINTS.accountSync);
});

test('an explicit kill switch still posts nothing', async (t) => {
  tempHome(t);
  // The default is now ON - whether anything is sent is the call sites' decision (Phase B3) - but
  // the switch itself is still here and still honoured.
  const res = await checkInAccount(PAYLOAD, fakeAuth(), { enabled: false, postJson: () => { throw new Error('must not post'); } });
  assert.equal(res.outcome, CheckInOutcome.DISABLED);
  assert.equal(res.successful, false);
});

test('a client with no configured endpoint still posts nothing', async (t) => {
  tempHome(t);
  const res = await checkInAccount(PAYLOAD, fakeAuth(), { endpoint: null, postJson: () => { throw new Error('must not post'); } });
  assert.equal(res.outcome, CheckInOutcome.UNCONFIGURED);
  assert.equal(res.successful, false);
});

test('an invalid payload is a schema failure and is never marked successful', async (t) => {
  tempHome(t);
  const res = await checkInAccount({ ...PAYLOAD, apiKeyFingerprint: 'x' }, fakeAuth(), deps({ postJson: () => { throw new Error('must not post'); } }));
  assert.equal(res.outcome, CheckInOutcome.SCHEMA);
  assert.equal(res.successful, false);
});

test('a successful check-in records the hash so the next unchanged run is skipped', async (t) => {
  tempHome(t);
  const first = await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope: SCOPE }));
  assert.equal(first.outcome, CheckInOutcome.SENT);
  assert.equal(first.successful, true);

  let posted = 0;
  const second = await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope: SCOPE, postJson: async () => { posted += 1; return { ok: true, status: 200, body: {} }; } }));
  assert.equal(second.outcome, CheckInOutcome.SKIPPED);
  assert.equal(posted, 0);

  const changed = await checkInAccount({ ...PAYLOAD, subscriptionType: 'ultra' }, fakeAuth(), deps({ scope: SCOPE }));
  assert.equal(changed.outcome, CheckInOutcome.SENT);
});

test('force skips the due gate and nothing else', async (t) => {
  tempHome(t);
  assert.equal((await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope: SCOPE }))).outcome, CheckInOutcome.SENT);
  // Unchanged and well inside the heartbeat: the ordinary path skips.
  assert.equal((await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope: SCOPE }))).outcome, CheckInOutcome.SKIPPED);

  let posted = 0;
  const forced = await checkInAccount(PAYLOAD, fakeAuth(), deps({
    scope: SCOPE,
    force: true,
    postJson: async () => { posted += 1; return { ok: true, status: 200, body: {} }; },
  }));
  assert.equal(forced.outcome, CheckInOutcome.SENT);
  assert.equal(posted, 1);

  // Force is a due-gate bypass, NOT a bypass of the schema, scope or auth rules.
  const badSchema = await checkInAccount({ ...PAYLOAD, plan: 'pro' }, fakeAuth(), deps({ scope: SCOPE, force: true, postJson: () => { throw new Error('must not post'); } }));
  assert.equal(badSchema.outcome, CheckInOutcome.SCHEMA);
  const badScope = await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope: { env: '' }, force: true, postJson: () => { throw new Error('must not post'); } }));
  assert.equal(badScope.outcome, CheckInOutcome.SCHEMA);
});

// THE FLIP-BACK GUARANTEE (plan §2 C8, §5). This is the test that fails if the state file is ever
// re-keyed by the Cursor account: the third call would land back on sub1's own file, find the
// matching hash and return SKIPPED, and the re-map to sub1 would silently never happen. The scope
// object deliberately CARRIES a cursorAccount on each leg - call sites build one scope for both
// this module and cost-reconcile - so the test proves the field is ignored rather than absent.
test('sub1 to sub2 and back to sub1 sends three times, with three distinct payloads', async (t) => {
  tempHome(t);
  const hashes = new Set();
  const outcomes = [];
  let posted = 0;
  const legs = [
    [SUB1, 'dev@example.com'],
    [SUB2, 'other@example.com'],
    [SUB1, 'dev@example.com'],
  ];
  for (const [payload, cursorAccount] of legs) {
    hashes.add(hashCheckInPayload(payload));
    const res = await checkInAccount(payload, fakeAuth(), deps({
      scope: { ...SCOPE, cursorAccount },
      now: NOW,
      postJson: async () => { posted += 1; return { ok: true, status: 200, body: {} }; },
    }));
    outcomes.push(res.outcome);
  }
  assert.deepEqual(outcomes, [CheckInOutcome.SENT, CheckInOutcome.SENT, CheckInOutcome.SENT]);
  assert.equal(posted, 3, 'the return to sub1 is itself a change and must re-map the machine');
  // Two distinct identities, so two distinct hashes - and the third leg re-sends because the state
  // remembers sub2, not because sub1 hashes to something new.
  assert.equal(hashes.size, 2);
  assert.notEqual(hashCheckInPayload(SUB1), hashCheckInPayload(SUB2));
});

test('a raw tier with a space survives validation instead of failing the whole check-in', async (t) => {
  tempHome(t);
  // SECRET_LIKE rejects any whitespace, so an uncollapsed "Teams Premium" would fail client-side
  // and never reach the server's alias-discovery loop. The collapse happens once, before
  // validation, hashing AND sending, so all three see the same string.
  const raw = { ...PAYLOAD, subscriptionType: 'Teams  Premium' };
  assert.equal(validateCheckInPayload(raw).ok, false, 'the raw form really is what the validator rejects');
  assert.equal(normalizeCheckInPayload(raw).subscriptionType, 'Teams_Premium');
  assert.equal(validateCheckInPayload(normalizeCheckInPayload(raw)).ok, true);

  let seen = null;
  const res = await checkInAccount(raw, fakeAuth(), deps({
    scope: SCOPE,
    postJson: async (_endpoint, body) => { seen = body; return { ok: true, status: 200, body: {} }; },
  }));
  assert.equal(res.outcome, CheckInOutcome.SENT);
  assert.equal(seen.subscriptionType, 'Teams_Premium', 'what was validated is what was posted');
  assert.equal(hashCheckInPayload(seen), hashCheckInPayload(normalizeCheckInPayload(raw)));
});

// The one field that must NEVER go on the wire: `subscriptionId` is the subscription the seat
// belongs to, and on a Team plan it is the paying owner's. Sending it under `accountUuid` would
// collapse every member of the team onto one row, and the server's absorb DELETES the row it
// merges - unrecoverable without hand-written SQL.
test('the local-only subscriptionId reaches no payload under any name', async (t) => {
  tempHome(t);
  const built = buildCheckInPayload({
    anchor: { email: 'dev@example.com', accountId: 'auth0|seat-1', subscriptionId: 'auth0|owner-9', source: 'state_vscdb' },
    account: { rawPlan: 'Teams Premium', status: 'active' },
    record: { subscriptionStatus: 'active' },
  });
  assert.deepEqual(built, { accountUuid: 'auth0|seat-1', email: 'dev@example.com', subscriptionType: 'Teams_Premium' });
  assert.equal(CHECKIN_PAYLOAD_FIELDS.includes('subscriptionId'), false);
  // The status is allowlisted but stays OFF the wire until E3 is deployed per tenant: under
  // forbidNonWhitelisted an undeployed property 400s the whole check-in.
  assert.equal('subscriptionStatus' in built, false);
  assert.equal(
    buildCheckInPayload({ record: { subscriptionStatus: 'active' } }, { includeSubscriptionStatus: true }).subscriptionStatus,
    'active',
  );
  // A machine that could identify nothing sends an empty body, which is a valid, meaningful call.
  assert.deepEqual(buildCheckInPayload(null), {});

  let seen = null;
  await checkInAccount(built, fakeAuth(), deps({
    scope: SCOPE,
    postJson: async (_endpoint, body) => { seen = body; return { ok: true, status: 200, body: {} }; },
  }));
  assert.equal(JSON.stringify(seen).includes('owner-9'), false);
});

test('forbidden, offline and a malformed response are never successful', async (t) => {
  tempHome(t);
  const cases = [
    [deps({ scope: SCOPE, postJson: async () => ({ ok: false, status: 403, body: null }) }), CheckInOutcome.FORBIDDEN],
    [deps({ scope: SCOPE, postJson: async () => ({ ok: false, status: 500, body: null }) }), CheckInOutcome.FAILED],
    [deps({ scope: SCOPE, postJson: async () => { throw new Error('offline'); } }), CheckInOutcome.OFFLINE],
    [deps({ scope: SCOPE, postJson: async () => ({ ok: true, status: 200, body: 'not an object' }) }), CheckInOutcome.SCHEMA],
  ];
  for (const [d, expected] of cases) {
    const res = await checkInAccount(PAYLOAD, fakeAuth(), d);
    assert.equal(res.outcome, expected);
    assert.equal(res.successful, false, `${expected} must not be recorded as a check-in`);
    // Nothing was recorded, so the very next run tries again.
    assert.equal(readAccountSyncState(accountSyncStateFile(SCOPE), SCOPE).lastHash, null);
  }
});

test('an incomplete scope is refused rather than silently sharing one heartbeat file', async (t) => {
  tempHome(t);
  // A missing Beezi account would key two accounts on one machine to the same file, which is
  // exactly the mis-attribution the scoping exists to prevent - and it would fail silently, as a
  // check-in that looked successful. A missing environment is the same failure across variants.
  // A scope with both, and no Cursor account, is COMPLETE: the Cursor account is not part of it.
  for (const scope of [undefined, { env: '', cursorAccount: 'dev@example.com' }, { beeziAccount: 'tenant-1|user-1' }]) {
    const res = await checkInAccount(PAYLOAD, fakeAuth(), deps({ scope, postJson: () => { throw new Error('must not post'); } }));
    assert.equal(res.outcome, CheckInOutcome.SCHEMA);
    assert.equal(res.successful, false);
    assert.match(res.reason, /scope/);
  }
});

test('an account change between the token and the POST defers instead of sending', async (t) => {
  tempHome(t);
  const auth = fakeAuth();
  // getToken is the last await before the request; a relink landing there must not send the old
  // account's facts under the new account's credentials.
  auth._set({ onTokenRead: () => auth._set({ epoch: 'prod|t2|u2|1' }) });
  const res = await checkInAccount(PAYLOAD, auth, deps({
    scope: SCOPE,
    postJson: () => { throw new Error('must not post'); },
  }));
  assert.equal(res.outcome, CheckInOutcome.EPOCH_CHANGED);
  assert.equal(res.successful, false);
});

test('an account change in flight fences the response out instead of applying it', async (t) => {
  tempHome(t);
  const auth = fakeAuth();
  const res = await checkInAccount(PAYLOAD, auth, deps({
    scope: SCOPE,
    postJson: async () => { auth._set({ epoch: 'prod|t2|u2|1' }); return { ok: true, status: 200, body: served() }; },
  }));
  assert.equal(res.outcome, CheckInOutcome.EPOCH_CHANGED);
  assert.equal(res.successful, false);
  assert.equal(res.writeback, null, 'a response for the previous account must not write a plan');
});

test('a served plan for the current account is offered back to the caller, never written here', async (t) => {
  tempHome(t);
  const res = await checkInAccount(PAYLOAD, fakeAuth(), deps({
    scope: SCOPE,
    existingBillingRecord: record({ selfReported: true }),
    anchor: anchor('dev@example.com'),
    postJson: async () => ({ ok: true, status: 200, body: served() }),
  }));
  assert.equal(res.outcome, CheckInOutcome.SENT);
  assert.equal(res.writeback.accepted, true);
  assert.equal(res.writeback.record.plan, 'ultra');
});

test('a served plan with no manual provenance is offered back as a refusal, not applied', async (t) => {
  tempHome(t);
  const res = await checkInAccount(PAYLOAD, fakeAuth(), deps({
    scope: SCOPE,
    existingBillingRecord: record({ selfReported: true }),
    anchor: anchor('dev@example.com'),
    // The shape an un-upgraded server returns: our own reported plan, echoed with a newer stamp.
    postJson: async () => ({ ok: true, status: 200, body: { plan: 'ultra', account: { email: 'dev@example.com' }, observedAt: '2026-05-31T00:00:00.000Z' } }),
  }));
  assert.equal(res.outcome, CheckInOutcome.SENT, 'the check-in itself landed');
  assert.equal(res.writeback.accepted, false);
  assert.equal(res.writeback.reason, 'plan-source-unknown');
  assert.equal(res.writeback.record, null);
});
