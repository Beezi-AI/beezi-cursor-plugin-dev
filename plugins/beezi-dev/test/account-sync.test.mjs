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

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SCOPE = { env: '', beeziAccount: 'tenant-1|user-1', cursorAccount: 'dev@example.com' };

const PAYLOAD = Object.freeze({
  environment: '',
  cursorAccountEmail: 'dev@example.com',
  cursorAccountSource: 'state_vscdb',
  plan: 'pro',
  planSource: 'state_vscdb',
  planObservedAt: '2026-05-30T00:00:00.000Z',
  billingSource: 'subscription',
});

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
  assert.equal(validateCheckInPayload({ ...PAYLOAD, plan: 'sk-not-a-plan' }).ok, false);
  assert.equal(validateCheckInPayload(null).ok, false);
  assert.equal(validateCheckInPayload([]).ok, false);
});

test('the hash covers the allowlisted fields and ignores key order', () => {
  const reordered = { billingSource: 'subscription', plan: 'pro', environment: '', cursorAccountEmail: 'dev@example.com', cursorAccountSource: 'state_vscdb', planSource: 'state_vscdb', planObservedAt: '2026-05-30T00:00:00.000Z' };
  assert.equal(hashCheckInPayload(PAYLOAD), hashCheckInPayload(reordered));
  assert.notEqual(hashCheckInPayload(PAYLOAD), hashCheckInPayload({ ...PAYLOAD, plan: 'ultra' }));
  assert.match(hashCheckInPayload(PAYLOAD), /^[0-9a-f]{64}$/);
});

// ── heartbeat state ───────────────────────────────────────────────────────────────────────────

test('check-in state is scoped by environment, Beezi account and Cursor account', (t) => {
  tempHome(t);
  const files = [
    accountSyncStateFile(SCOPE),
    accountSyncStateFile({ ...SCOPE, env: '-dev' }),
    accountSyncStateFile({ ...SCOPE, beeziAccount: 'tenant-2|user-2' }),
    accountSyncStateFile({ ...SCOPE, cursorAccount: 'other@example.com' }),
  ];
  assert.equal(new Set(files).size, 4);
});

test('a changed payload is due immediately; an unchanged one waits out the heartbeat', (t) => {
  tempHome(t);
  const hash = hashCheckInPayload(PAYLOAD);
  const state = { lastHash: hash, lastSuccessAt: NOW - DAY };
  assert.equal(isCheckInDue(state, hash, NOW), false);
  assert.equal(isCheckInDue(state, hashCheckInPayload({ ...PAYLOAD, plan: 'ultra' }), NOW), true);
  assert.equal(isCheckInDue(state, hash, NOW - DAY + CHECKIN_HEARTBEAT_MS), true);
  assert.equal(isCheckInDue({ lastHash: null, lastSuccessAt: null }, hash, NOW), true);
  assert.equal(CHECKIN_HEARTBEAT_MS, 7 * DAY);
});

test('state round-trips and a foreign scope reads as never checked in', (t) => {
  tempHome(t);
  const file = accountSyncStateFile(SCOPE);
  writeAccountSyncState(file, { lastHash: 'abc', lastSuccessAt: NOW }, SCOPE);
  assert.equal(readAccountSyncState(file, SCOPE).lastHash, 'abc');
  assert.equal(readAccountSyncState(file, { ...SCOPE, cursorAccount: 'x@y.z' }).lastHash, null);
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

const anchor = (email) => ({ email, source: 'state_vscdb' });
const record = (over) => ({
  version: 2, source: 'subscription', plan: 'pro', subscriptionType: 'pro',
  capturedAt: '2026-05-30T00:00:00.000Z', identityCheckedAt: null, migratedAt: null,
  accountAnchor: anchor('dev@example.com'), capturedBy: 'login', selfReported: false,
  rateLimitTier: 'local-tier',
  ...(over == null ? {} : over),
});

test('a writeback for another account is refused', () => {
  const r = planWriteback({ account: { email: 'someone@else.com' }, plan: 'ultra', observedAt: '2026-05-31T00:00:00.000Z' },
    { anchor: anchor('dev@example.com'), existing: record(), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'account-mismatch');
});

test('a writeback with no confirmable account is refused, not assumed to match', () => {
  const response = { account: { email: null }, plan: 'ultra', observedAt: '2026-05-31T00:00:00.000Z' };
  assert.equal(planWriteback(response, { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).reason, 'account-unknown');
  assert.equal(planWriteback({ ...response, account: { email: 'dev@example.com' } }, { anchor: anchor(null), existing: record(), now: NOW }).reason, 'account-unknown');
});

test('a plan outside the local vocabulary is refused rather than stored raw', () => {
  const r = planWriteback({ account: { email: 'dev@example.com' }, plan: 'platinum', observedAt: '2026-05-31T00:00:00.000Z' },
    { anchor: anchor('dev@example.com'), existing: record(), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'unsupported-plan');
});

test('a stale response never replaces a fresher local observation', () => {
  const r = planWriteback({ account: { email: 'dev@example.com' }, plan: 'free', observedAt: '2026-05-01T00:00:00.000Z' },
    { anchor: anchor('dev@example.com'), existing: record({ selfReported: true }), now: NOW });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'stale');
});

test('a fresher server observation for the current account is accepted', () => {
  const r = planWriteback({ account: { email: 'dev@example.com' }, plan: 'ultra', observedAt: '2026-05-31T00:00:00.000Z' },
    { anchor: anchor('dev@example.com'), existing: record({ selfReported: true }), now: NOW });
  assert.equal(r.accepted, true);
  assert.equal(r.record.plan, 'ultra');
  assert.equal(r.record.capturedBy, 'server');
  assert.equal(r.record.selfReported, false);
  assert.equal(r.record.capturedAt, '2026-05-31T00:00:00.000Z', 'freshness is the server observation, not the moment we read it');
  assert.equal(r.record.rateLimitTier, 'local-tier', 'a locally observed tier is not a field the server was asked about');
});

test('a response with no plan changes nothing', () => {
  assert.equal(planWriteback({ account: { email: 'dev@example.com' } }, { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).reason, 'no-plan');
  assert.equal(planWriteback(null, { anchor: anchor('dev@example.com'), existing: record(), now: NOW }).accepted, false);
});

// ── the client ────────────────────────────────────────────────────────────────────────────────

test('no account check-in route is invented by this client', () => {
  assert.equal(ACCOUNT_CHECKIN_ENDPOINT, null);
});

test('the client is disabled by default and posts nothing', async (t) => {
  tempHome(t);
  const res = await checkInAccount(PAYLOAD, fakeAuth(), { postJson: () => { throw new Error('must not post'); } });
  assert.equal(res.outcome, CheckInOutcome.DISABLED);
  assert.equal(res.successful, false);
});

test('an enabled client with no configured endpoint still posts nothing', async (t) => {
  tempHome(t);
  const res = await checkInAccount(PAYLOAD, fakeAuth(), { enabled: true, postJson: () => { throw new Error('must not post'); } });
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

  const changed = await checkInAccount({ ...PAYLOAD, plan: 'ultra' }, fakeAuth(), deps({ scope: SCOPE }));
  assert.equal(changed.outcome, CheckInOutcome.SENT);
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
  // Two Beezi accounts on one machine would otherwise share a file keyed on the Cursor email
  // alone, which is exactly the mis-attribution the scoping exists to prevent.
  for (const scope of [undefined, { env: '', cursorAccount: 'dev@example.com' }, { env: '', beeziAccount: 'tenant-1|user-1' }]) {
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
    postJson: async () => { auth._set({ epoch: 'prod|t2|u2|1' }); return { ok: true, status: 200, body: { plan: 'ultra', account: { email: 'dev@example.com' }, observedAt: '2026-05-31T00:00:00.000Z' } }; },
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
    postJson: async () => ({ ok: true, status: 200, body: { plan: 'ultra', account: { email: 'dev@example.com' }, observedAt: '2026-05-31T00:00:00.000Z' } }),
  }));
  assert.equal(res.outcome, CheckInOutcome.SENT);
  assert.equal(res.writeback.accepted, true);
  assert.equal(res.writeback.record.plan, 'ultra');
});
