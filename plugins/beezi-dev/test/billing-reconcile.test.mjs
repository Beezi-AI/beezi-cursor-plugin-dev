import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_SCHEMA_VERSION,
  RECHECK_MS,
  migrateBillingRecord,
  normalizeAccountEmail,
  normalizeAccountAnchor,
  isDue,
  isStale,
} from '../lib/billing-config.mjs';
import {
  ReconcileOutcome,
  ChangeKind,
  IdentityMatch,
  compareAnchors,
  observationFromArgs,
  observationFromAccount,
  reconcilePlan,
  parseArgs,
} from '../lib/billing-capture.mjs';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function v1(overrides) {
  return {
    version: 1,
    source: 'subscription',
    subscriptionType: 'pro',
    rateLimitTier: null,
    plan: 'pro',
    credentialsExpiresAt: 1234,
    capturedAt: '2025-01-01T00:00:00.000Z',
    capturedBy: 'cursor-command',
    selfReported: true,
    ...overrides,
  };
}

// ── schema + migration ────────────────────────────────────────────────────────────────────────

test('one schema version constant, value 3', () => {
  assert.equal(BILLING_SCHEMA_VERSION, 3);
});

test('v1 migration preserves capturedAt and stamps migratedAt separately', () => {
  const { record, migrated } = migrateBillingRecord(v1(), { now: NOW });
  assert.equal(migrated, true);
  assert.equal(record.version, 3);
  assert.equal(record.capturedAt, '2025-01-01T00:00:00.000Z', 'observation freshness must survive a schema rewrite');
  assert.equal(record.migratedAt, NOW_ISO);
  assert.equal(record.identityCheckedAt, null);
  assert.equal(record.plan, 'pro');
  assert.equal(record.selfReported, true);
  assert.equal(record.accountAnchor, null);
});

test('migration drops the credential-expiry staleness input', () => {
  const { record } = migrateBillingRecord(v1(), { now: NOW });
  assert.equal('credentialsExpiresAt' in record, false);
});

test('a current-version record is not re-migrated and keeps its stamps', () => {
  const current = migrateBillingRecord(v1(), { now: NOW }).record;
  const again = migrateBillingRecord(current, { now: NOW + 10 * DAY });
  assert.equal(again.migrated, false);
  assert.equal(again.record.migratedAt, NOW_ISO);
  assert.equal(again.record.capturedAt, '2025-01-01T00:00:00.000Z');
});

// A v2 record on disk is a machine that has been running this plugin and has real history. The
// v2 -> v3 step ADDS three identity fields and must touch nothing else. The stamp assertions are
// the point of this test, not decoration: reusing the v1 branch, which nulls `identityCheckedAt`
// and `lastPlanReadAttemptAt` because a v1 record never had them, would silently erase two records
// of things that actually happened — and a migration test that only checked the new fields would
// stay green while it did.
function v2(overrides) {
  return {
    version: 2,
    source: 'cursor_credits',
    plan: 'ultra',
    subscriptionType: 'Ultra',
    rateLimitTier: 'tier-x',
    capturedAt: '2026-05-20T00:00:00.000Z',
    identityCheckedAt: '2026-05-21T00:00:00.000Z',
    lastPlanReadAttemptAt: '2026-05-22T00:00:00.000Z',
    migratedAt: '2026-01-01T00:00:00.000Z',
    accountAnchor: { email: 'dev@example.com', source: 'state_vscdb' },
    capturedBy: 'session-start',
    selfReported: true,
    ...overrides,
  };
}

test('v2 -> v3 adds the identity fields as null and preserves everything else', () => {
  const { record, migrated } = migrateBillingRecord(v2(), { now: NOW });
  assert.equal(migrated, true);
  assert.equal(record.version, 3);

  // The three new fields exist and claim nothing.
  assert.equal(record.subscriptionStatus, null);
  assert.equal(record.accountAnchor.accountId, null);
  assert.equal(record.accountAnchor.subscriptionId, null);

  // Everything a v2 record already knew survives, stamps included.
  assert.equal(record.source, 'cursor_credits');
  assert.equal(record.plan, 'ultra');
  assert.equal(record.subscriptionType, 'Ultra');
  assert.equal(record.rateLimitTier, 'tier-x');
  assert.equal(record.capturedAt, '2026-05-20T00:00:00.000Z');
  assert.equal(record.identityCheckedAt, '2026-05-21T00:00:00.000Z', 'a real identity check must not be erased by a schema rewrite');
  assert.equal(record.lastPlanReadAttemptAt, '2026-05-22T00:00:00.000Z', 'nor the back-off stamp that keeps the host read off every session start');
  assert.equal(record.accountAnchor.email, 'dev@example.com');
  assert.equal(record.accountAnchor.source, 'state_vscdb');
  assert.equal(record.capturedBy, 'session-start');
  assert.equal(record.selfReported, true);

  // Only the rewrite stamp moves, and a second pass is a no-op.
  assert.equal(record.migratedAt, NOW_ISO);
  assert.equal(migrateBillingRecord(record, { now: NOW + 10 * DAY }).migrated, false);
});

test('a v2 record with no anchor migrates without inventing one', () => {
  const { record } = migrateBillingRecord(v2({ accountAnchor: null }), { now: NOW });
  assert.equal(record.accountAnchor, null);
  assert.equal(record.subscriptionStatus, null);
});

test('migration is tolerant of junk', () => {
  assert.equal(migrateBillingRecord(null, { now: NOW }).record, null);
  assert.equal(migrateBillingRecord('nope', { now: NOW }).record, null);
  assert.equal(migrateBillingRecord([], { now: NOW }).record, null);
  const { record } = migrateBillingRecord({ version: 1, plan: 42, source: 7 }, { now: NOW });
  assert.equal(record.plan, null);
  assert.equal(record.source, 'subscription');
});

// ── anchors ───────────────────────────────────────────────────────────────────────────────────

test('normalizeAccountEmail lowercases, trims and rejects malformed values', () => {
  assert.equal(normalizeAccountEmail('  Dev@Example.COM '), 'dev@example.com');
  assert.equal(normalizeAccountEmail('not-an-email'), null);
  assert.equal(normalizeAccountEmail('a@'), null);
  assert.equal(normalizeAccountEmail('@b.com'), null);
  assert.equal(normalizeAccountEmail('a b@c.com'), null);
  assert.equal(normalizeAccountEmail(''), null);
  assert.equal(normalizeAccountEmail(null), null);
  assert.equal(normalizeAccountEmail(new Array(251).join('x') + '@e.com'), null);
});

test('an anchor always carries a source; a malformed email becomes unknown identity', () => {
  assert.deepEqual(normalizeAccountAnchor({ email: 'A@b.com', source: 'state_vscdb' }), { email: 'a@b.com', accountId: null, subscriptionId: null, source: 'state_vscdb' });
  assert.deepEqual(normalizeAccountAnchor({ email: 'garbage', source: 'cli_config' }), { email: null, accountId: null, subscriptionId: null, source: 'cli_config' });
  assert.equal(normalizeAccountAnchor(null), null);
  assert.equal(normalizeAccountAnchor({ email: 'a@b.com' }), null, 'no source is not an anchor');
});

test('unknown identity is neither a match nor a switch', () => {
  const a = { email: 'a@b.com', source: 'state_vscdb' };
  const b = { email: 'c@d.com', source: 'state_vscdb' };
  const none = { email: null, source: 'state_vscdb' };
  assert.equal(compareAnchors(a, a), IdentityMatch.MATCH);
  assert.equal(compareAnchors(a, b), IdentityMatch.SWITCH);
  assert.equal(compareAnchors(none, a), IdentityMatch.UNKNOWN);
  assert.equal(compareAnchors(a, none), IdentityMatch.UNKNOWN);
  assert.equal(compareAnchors(a, null), IdentityMatch.UNKNOWN);
});

// ── id-first identity ─────────────────────────────────────────────────────────────────────────

const idAnchor = (over) => ({ email: null, accountId: null, subscriptionId: null, source: 'state_vscdb', ...over });

test('an equal accountId is a match no matter what the email says', () => {
  // Cursor's id is opaque and does not move when a user renames their address; treating a rename
  // as a hand-over would blank a perfectly good plan.
  const before = idAnchor({ email: 'old@example.com', accountId: 'auth0|seat_1' });
  const after = idAnchor({ email: 'new@example.com', accountId: 'auth0|seat_1' });
  assert.equal(compareAnchors(after, before), IdentityMatch.MATCH);
});

test('a different accountId is a switch no matter what the email says', () => {
  const before = idAnchor({ email: 'shared@example.com', accountId: 'auth0|seat_1' });
  const after = idAnchor({ email: 'shared@example.com', accountId: 'auth0|seat_2' });
  assert.equal(compareAnchors(after, before), IdentityMatch.SWITCH);
});

// The event this whole feature exists to notice: one seat moving between subscriptions.
test('the same seat on a changed subscription is a switch', () => {
  const before = idAnchor({ accountId: 'auth0|seat_1', subscriptionId: 'sub_a' });
  const after = idAnchor({ accountId: 'auth0|seat_1', subscriptionId: 'sub_b' });
  assert.equal(compareAnchors(after, before), IdentityMatch.SWITCH);
});

// LEARNING an id is not the seat moving. Every record written before v3 stores
// `subscriptionId: null`, so if `null -> something` counted as a switch, the first run after this
// upgrade would take the switch branch on every installed machine — and any machine whose plan
// happened to read `unknown` that moment would have its stored plan destroyed by
// `blankedForSwitch`. Data loss, once, everywhere, on upgrade day.
test('learning a subscriptionId for the first time is NOT a switch', () => {
  const before = idAnchor({ accountId: 'auth0|seat_1', subscriptionId: null });
  const after = idAnchor({ accountId: 'auth0|seat_1', subscriptionId: 'sub_a' });
  assert.equal(compareAnchors(after, before), IdentityMatch.MATCH);
  assert.equal(compareAnchors(before, after), IdentityMatch.MATCH, 'and losing sight of it is not one either');
});

test('with an id absent on either side the comparison falls back to email', () => {
  const stored = idAnchor({ email: 'dev@example.com' });
  const withId = idAnchor({ email: 'dev@example.com', accountId: 'auth0|seat_1' });
  const other = idAnchor({ email: 'other@example.com', accountId: 'auth0|seat_1' });
  assert.equal(compareAnchors(withId, stored), IdentityMatch.MATCH, 'one side has no id: emails decide');
  assert.equal(compareAnchors(other, stored), IdentityMatch.SWITCH);
  assert.equal(compareAnchors(idAnchor({ accountId: 'auth0|seat_1' }), stored), IdentityMatch.UNKNOWN,
    'no id on one side and no email on the other is no identity at all');
});

test('a newly learned accountId is persisted, not recomputed and discarded', () => {
  // `anchorsEqual` drives `persist` in the KEPT branch. If it ignored the ids, the id would be
  // read on every run and written on none.
  const first = reconcilePlan(VSCDB('pro', 'dev@example.com'), null, { now: NOW }).record;
  assert.equal(first.accountAnchor.accountId, null);
  const withId = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_a' };
  const r = reconcilePlan(withId, first, { now: NOW + 60 * 1000 });
  assert.equal(r.outcome, ReconcileOutcome.KEPT);
  assert.equal(r.persist, true, 'inside the recheck window, but the anchor genuinely changed');
  assert.equal(r.record.accountAnchor.accountId, 'auth0|seat_1');
  assert.equal(r.record.accountAnchor.subscriptionId, 'sub_a');
});

test('a seat that moves subscription is reconciled as a switch', () => {
  const before = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_a' };
  const first = reconcilePlan(before, null, { now: NOW }).record;
  const after = { ...VSCDB('team', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_b' };
  const r = reconcilePlan(after, first, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.plan, 'team');
  assert.equal(r.record.accountAnchor.subscriptionId, 'sub_b');
});

test('the subscription status rides along with the plan and is never inherited', () => {
  const observed = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', status: 'active' };
  const first = reconcilePlan(observed, null, { now: NOW }).record;
  assert.equal(first.subscriptionStatus, 'active');
  // A later read that saw no status says so, rather than replaying a stale 'active'.
  const quiet = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', status: null };
  assert.equal(reconcilePlan(quiet, first, { now: NOW + 10 * DAY }).record.subscriptionStatus, null);
});

// ── staleness / due ───────────────────────────────────────────────────────────────────────────

test('isStale uses isPlanBearing, not a subscription-only test', () => {
  const fresh = { version: 2, plan: 'pro', capturedAt: new Date(NOW - DAY).toISOString() };
  assert.equal(isStale({ ...fresh, source: 'cursor_credits' }, NOW), false);
  assert.equal(isStale({ ...fresh, source: 'cursor_credits', plan: 'unknown' }, NOW), true, 'credits still ride a seat and still need a plan');
  assert.equal(isStale({ ...fresh, source: 'openai_api_key' }, NOW), false, 'a non-plan-bearing source has no plan to nag about');
});

test('isStale ignores a migrated record credential expiry', () => {
  const old = v1({ capturedAt: new Date(NOW - DAY).toISOString(), selfReported: false, credentialsExpiresAt: NOW - 1 });
  assert.equal(isStale(old, NOW), false);
});

test('isDue rechecks even a self-reported plan after seven days', () => {
  const selfReported = migrateBillingRecord(v1({ capturedAt: new Date(NOW - 8 * DAY).toISOString() }), { now: NOW - 8 * DAY }).record;
  assert.equal(isStale(selfReported, NOW), false, 'the user-facing nudge still exempts a self-report');
  assert.equal(isDue(selfReported, NOW), true, 'but a cheap automatic recheck is due');
  assert.equal(isDue({ ...selfReported, identityCheckedAt: new Date(NOW - DAY).toISOString() }, NOW), false);
  assert.equal(isDue(null, NOW), true);
  assert.equal(RECHECK_MS, 7 * DAY);
});

// ── observations ──────────────────────────────────────────────────────────────────────────────

test('an observation is one atomic tuple: --email never anchors a --from-cursor read', () => {
  assert.throws(() => parseArgs(['--from-cursor', '--email', 'a@b.com']), /mutually exclusive/);
});

test('parseArgs reads --force and --email and deprecates --expires-at', () => {
  const args = parseArgs(['--plan', 'pro', '--force', '--email', 'A@B.com', '--expires-at', '123']);
  assert.equal(args.force, true);
  assert.equal(args.email, 'A@B.com');
  assert.deepEqual(args.deprecated, ['--expires-at']);
  assert.equal(args.expiresAt, undefined, 'the value is parsed away, never carried into a record');
});

test('observationFromArgs validates the seven-tier allowlist and normalizes the email', () => {
  const obs = observationFromArgs({ plan: 'pro_plus', email: ' Dev@Example.com ', via: 'cursor-command' });
  assert.deepEqual(obs, { plan: 'pro_plus', rawPlan: 'pro_plus', rateLimitTier: null, source: 'self_report', email: 'dev@example.com', accountId: null, subscriptionId: null, status: null, via: 'cursor-command' });
  assert.throws(() => observationFromArgs({ plan: 'plus' }), /Unknown plan/);
  assert.equal(observationFromArgs({}), null);
});

test('observationFromArgs refuses a token-like subscription type', () => {
  assert.throws(() => observationFromArgs({ subscriptionType: 'sk-abc123' }), /suspicious value/);
});

test('observationFromAccount carries the account email and source through', () => {
  const obs = observationFromAccount({ plan: 'ultra', rawPlan: 'Ultra', source: 'state_vscdb', email: 'Dev@Example.com' }, 'login');
  assert.deepEqual(obs, { plan: 'ultra', rawPlan: 'Ultra', rateLimitTier: null, source: 'state_vscdb', email: 'dev@example.com', accountId: null, subscriptionId: null, status: null, via: 'login' });
});

test('observationFromAccount carries the whole identity tuple through', () => {
  const obs = observationFromAccount({
    plan: 'team_premium', rawPlan: 'Teams Premium', source: 'state_vscdb', email: 'seat@example.com',
    accountId: 'auth0|seat_1', subscriptionId: 'auth0|owner_9', status: 'active',
  }, 'session-start');
  assert.equal(obs.accountId, 'auth0|seat_1');
  assert.equal(obs.subscriptionId, 'auth0|owner_9');
  assert.equal(obs.status, 'active');
});

// `safeField` refuses anything over 64 characters, and an SSO id is routinely longer than that.
// Routing ids through it would drop exactly the Team/SSO seats this feature exists for, so they
// take their own path — this asserts the long id is still there after the observation is built.
test('an over-64-character SSO id is not dropped on its way into an observation', () => {
  const samlpId = `samlp|${new Array(101).join('c')}|${new Array(82).join('u')}@example.com`;
  const obs = observationFromAccount({ plan: 'team', rawPlan: 'team', source: 'state_vscdb', email: null, accountId: samlpId, subscriptionId: null, status: null }, 'login');
  assert.equal(obs.accountId, samlpId);
  assert.equal(obs.accountId.length, 200);
  assert.equal(reconcilePlan(obs, null, { now: NOW }).record.accountAnchor.accountId, samlpId, 'and it reaches billing.json whole');
});

test('an observation from an account with no identity keys claims none', () => {
  const obs = observationFromAccount({ plan: 'pro', rawPlan: 'pro', source: 'state_vscdb', email: 'a@b.com' }, null);
  assert.equal(obs.accountId, null);
  assert.equal(obs.subscriptionId, null);
  assert.equal(obs.status, null);
});

test('an unsafe raw plan from the host falls back to the normalized plan instead of throwing', () => {
  const obs = observationFromAccount({ plan: 'pro', rawPlan: 'sk-leak pro', source: 'state_vscdb', email: null }, 'login');
  assert.equal(obs.rawPlan, 'pro');
});

// ── reconcile ─────────────────────────────────────────────────────────────────────────────────

const VSCDB = (plan, email) => ({ plan, rawPlan: plan, rateLimitTier: null, source: 'state_vscdb', email, via: 'refresh' });
const MANUAL = (plan, email) => ({ plan, rawPlan: plan, rateLimitTier: null, source: 'self_report', email: email == null ? null : email, via: 'cursor-command' });

test('no observation at all is no-source and never erases a useful record, even forced', () => {
  const existing = migrateBillingRecord(v1(), { now: NOW - DAY }).record;
  const r = reconcilePlan(null, existing, { now: NOW, force: true });
  assert.equal(r.outcome, ReconcileOutcome.NO_SOURCE);
  assert.equal(r.persist, false);
  assert.equal(r.record.plan, 'pro');
  assert.deepEqual(r.changes.map((c) => c.kind), [ChangeKind.UNAVAILABLE]);
});

test('no observation and no record is no-source with nothing to write', () => {
  const r = reconcilePlan(null, null, { now: NOW });
  assert.equal(r.outcome, ReconcileOutcome.NO_SOURCE);
  assert.equal(r.record, null);
  assert.equal(r.persist, false);
});

test('no observation still persists a pending v1 migration', () => {
  const r = reconcilePlan(null, v1(), { now: NOW });
  assert.equal(r.outcome, ReconcileOutcome.NO_SOURCE);
  assert.equal(r.persist, true);
  assert.equal(r.record.version, 3);
  assert.equal(r.record.capturedAt, '2025-01-01T00:00:00.000Z');
});

test('a first deterministic capture fills the plan', () => {
  const r = reconcilePlan(VSCDB('pro', 'dev@example.com'), null, { now: NOW });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.plan, 'pro');
  assert.equal(r.record.version, 3);
  assert.equal(r.record.selfReported, false);
  assert.deepEqual(r.record.accountAnchor, { email: 'dev@example.com', accountId: null, subscriptionId: null, source: 'state_vscdb' });
  assert.equal(r.record.capturedAt, NOW_ISO);
  assert.equal(r.record.identityCheckedAt, NOW_ISO);
  assert.equal(r.changes.some((c) => c.kind === ChangeKind.FILLED && c.field === 'plan'), true);
});

test('the same plan re-observed under the same account is kept, not changed', () => {
  const first = reconcilePlan(VSCDB('pro', 'dev@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('pro', 'dev@example.com'), first, { now: NOW + 10 * DAY });
  assert.equal(r.outcome, ReconcileOutcome.KEPT);
  assert.equal(r.record.plan, 'pro');
  assert.equal(r.record.capturedAt, new Date(NOW + 10 * DAY).toISOString(), 'the plan really was observed again');
  assert.equal(r.changes.some((c) => c.kind === ChangeKind.CHANGED), false);
});

test('a kept record inside the recheck window is not rewritten unless forced', () => {
  const first = reconcilePlan(VSCDB('pro', 'dev@example.com'), null, { now: NOW }).record;
  assert.equal(reconcilePlan(VSCDB('pro', 'dev@example.com'), first, { now: NOW + DAY }).persist, false);
  assert.equal(reconcilePlan(VSCDB('pro', 'dev@example.com'), first, { now: NOW + DAY, force: true }).persist, true);
});

test('a manual correction replaces an earlier manual plan without --force', () => {
  const first = reconcilePlan(MANUAL('ultra'), null, { now: NOW }).record;
  const r = reconcilePlan(MANUAL('pro'), first, { now: NOW + 60 * 1000 });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.plan, 'pro');
  assert.equal(r.record.selfReported, true);
  assert.equal(r.persist, true);
});

test('unknown identity with an unknown new plan preserves the manual value and its provenance', () => {
  const manual = reconcilePlan(MANUAL('ultra'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('unknown', null), manual, { now: NOW + 10 * DAY });
  assert.equal(r.outcome, ReconcileOutcome.UNVERIFIED);
  assert.equal(r.record.plan, 'ultra');
  assert.equal(r.record.selfReported, true, 'provenance survives');
  assert.equal(r.record.capturedAt, NOW_ISO, 'an unobserved plan must not look freshly observed');
  assert.equal(r.record.identityCheckedAt, NOW_ISO, 'nothing about the identity was confirmed either');
  assert.equal(r.changes.some((c) => c.kind === ChangeKind.PRESERVED), true);
});

test('same identity with an unknown new plan is kept and the identity check is stamped', () => {
  const manual = reconcilePlan(MANUAL('ultra', 'dev@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('unknown', 'dev@example.com'), manual, { now: NOW + 10 * DAY });
  assert.equal(r.outcome, ReconcileOutcome.KEPT);
  assert.equal(r.record.plan, 'ultra');
  assert.equal(r.record.capturedAt, NOW_ISO, 'plan freshness does not move on an unobserved plan');
  assert.equal(r.record.identityCheckedAt, new Date(NOW + 10 * DAY).toISOString());
  assert.equal(r.persist, true);
});

test('a confirmed account switch invalidates a protected manual plan', () => {
  const manual = reconcilePlan(MANUAL('ultra', 'old@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('unknown', 'new@example.com'), manual, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.NEEDS_USER);
  assert.equal(r.record.plan, null, 'the old account tier cannot be inherited');
  assert.equal(r.record.selfReported, false);
  assert.equal(r.record.capturedAt, null);
  assert.deepEqual(r.record.accountAnchor, { email: 'new@example.com', accountId: null, subscriptionId: null, source: 'state_vscdb' });
  assert.equal(r.persist, true);
});

test('a confirmed account switch accepts only the new account evidence', () => {
  const manual = reconcilePlan(MANUAL('ultra', 'old@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('free', 'new@example.com'), manual, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.plan, 'free');
  assert.deepEqual(r.record.accountAnchor, { email: 'new@example.com', accountId: null, subscriptionId: null, source: 'state_vscdb' });
});

test('a malformed observed email is unknown identity, not a switch', () => {
  const manual = reconcilePlan(MANUAL('ultra', 'old@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('unknown', 'not-an-email'), manual, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.UNVERIFIED);
  assert.equal(r.record.plan, 'ultra');
});

test('an anchor is rebuilt from the observation, never paired across sources', () => {
  const manual = reconcilePlan(MANUAL('ultra', 'dev@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('pro', null), manual, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.deepEqual(r.record.accountAnchor, { email: null, accountId: null, subscriptionId: null, source: 'state_vscdb' }, 'another source email must not ride along');
});

test('nothing observed and nothing stored asks the user', () => {
  const r = reconcilePlan(VSCDB('unknown', null), null, { now: NOW });
  assert.equal(r.outcome, ReconcileOutcome.NEEDS_USER);
  assert.equal(r.record.plan, null, 'no plan is claimed');
  // The only thing written is the attempt stamp, which is what stops the host read repeating on
  // every session start - see 'an attempt that found a source but no plan backs off too'.
  assert.equal(r.record.lastPlanReadAttemptAt, NOW_ISO);
});

test('credits plan-bearing records still reconcile', () => {
  const credits = {
    version: 2,
    source: 'cursor_credits',
    plan: 'pro',
    subscriptionType: 'pro',
    rateLimitTier: null,
    capturedAt: new Date(NOW - 10 * DAY).toISOString(),
    identityCheckedAt: null,
    migratedAt: null,
    accountAnchor: null,
    capturedBy: 'login',
    selfReported: false,
  };
  const r = reconcilePlan(VSCDB('ultra', null), credits, { now: NOW });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.plan, 'ultra');
});

test('every Cursor tier with a seat rate is accepted, free included', () => {
  for (const plan of ['free', 'pro', 'pro_plus', 'ultra', 'team', 'team_premium', 'enterprise']) {
    assert.equal(observationFromArgs({ plan }).plan, plan);
    assert.equal(reconcilePlan(observationFromArgs({ plan }), null, { now: NOW }).record.plan, plan);
  }
  // Cursor "Start" is non-USD and has no seat rate, so it must never be accepted as a tier.
  assert.throws(() => observationFromArgs({ plan: 'start' }), /Unknown plan/);
  assert.throws(() => observationFromArgs({ plan: 'Cursor Pro' }), /Unknown plan/);
});

test('--from-cursor and --plan stay mutually exclusive', () => {
  assert.throws(() => parseArgs(['--from-cursor', '--plan', 'pro']), /mutually exclusive/);
});

// ── backing off a fruitless read ──────────────────────────────────────────────────────────────

test('a machine with no plan at all still backs off after a fruitless read', () => {
  // NO_SOURCE and NEEDS_USER persist no plan, so without an attempt stamp `isDue` stays true on
  // EVERY session start and the host read (uncached, possibly a whole-database copy) runs every
  // time inside Cursor's 10s kill.
  const first = reconcilePlan(null, null, { now: NOW, attempted: true });
  assert.equal(first.outcome, ReconcileOutcome.NO_SOURCE);
  assert.equal(first.persist, true, 'the attempt itself is worth remembering');
  assert.equal(first.record.lastPlanReadAttemptAt, NOW_ISO);
  assert.equal(first.record.plan, null, 'nothing was learned, so nothing is claimed');

  assert.equal(isDue(first.record, NOW + 60 * 1000), false, 'we just looked');
  assert.equal(isDue(first.record, NOW + 8 * DAY), true, 'and we look again next week');
});

test('an attempt that found a source but no plan backs off too', () => {
  const r = reconcilePlan(VSCDB('unknown', null), null, { now: NOW, attempted: true });
  assert.equal(r.outcome, ReconcileOutcome.NEEDS_USER);
  assert.equal(r.persist, true);
  assert.equal(r.record.lastPlanReadAttemptAt, NOW_ISO);
  assert.equal(isDue(r.record, NOW + 60 * 1000), false);
});

test('a manual run that supplied nothing is not an attempt and writes nothing', () => {
  // `--via login` with no plan flags never looked at the host, so there is nothing to back off.
  const r = reconcilePlan(null, null, { now: NOW });
  assert.equal(r.persist, false);
  assert.equal(r.record, null);
});

test('a fruitless forced read never erases a useful record', () => {
  const existing = reconcilePlan(MANUAL('ultra', 'dev@example.com'), null, { now: NOW }).record;
  const r = reconcilePlan(null, existing, { now: NOW + 10 * DAY, force: true, attempted: true });
  assert.equal(r.outcome, ReconcileOutcome.NO_SOURCE);
  assert.equal(r.record.plan, 'ultra');
  assert.equal(r.record.capturedAt, existing.capturedAt);
  assert.equal(r.record.selfReported, true);
  assert.deepEqual(r.record.accountAnchor, existing.accountAnchor);
  // The ONLY thing that moved is the attempt stamp.
  assert.equal(r.record.lastPlanReadAttemptAt, new Date(NOW + 10 * DAY).toISOString());
});

// ── fields a re-observation must not quietly drop ─────────────────────────────────────────────

test('a stored plan-bearing source survives a re-observation', () => {
  // detectBillingSource() answers SUBSCRIPTION with no delta to read. Letting it overwrite a stored
  // cursor_credits record would tell every later report that a credit-funded machine rides only
  // its seat.
  const credits = { version: 2, source: 'cursor_credits', plan: 'pro', subscriptionType: 'pro', rateLimitTier: 'tier-x', capturedAt: new Date(NOW - 10 * DAY).toISOString(), identityCheckedAt: null, migratedAt: null, accountAnchor: null, capturedBy: 'login', selfReported: false };
  const r = reconcilePlan(VSCDB('ultra', null), credits, { now: NOW });
  assert.equal(r.record.source, 'cursor_credits');
  assert.equal(r.record.plan, 'ultra');
});

test('a locally stored rate limit tier survives an observation that carries none', () => {
  const stored = { version: 2, source: 'subscription', plan: 'pro', subscriptionType: 'pro', rateLimitTier: 'tier-x', capturedAt: new Date(NOW - 10 * DAY).toISOString(), identityCheckedAt: null, migratedAt: null, accountAnchor: { email: 'dev@example.com', source: 'state_vscdb' }, capturedBy: 'login', selfReported: false };
  assert.equal(reconcilePlan(VSCDB('pro', 'dev@example.com'), stored, { now: NOW }).record.rateLimitTier, 'tier-x');
  assert.equal(reconcilePlan(VSCDB('ultra', 'dev@example.com'), stored, { now: NOW }).record.rateLimitTier, 'tier-x');
  // An observation that DOES carry one still wins.
  const observed = { ...VSCDB('pro', 'dev@example.com'), rateLimitTier: 'tier-y' };
  assert.equal(reconcilePlan(observed, stored, { now: NOW }).record.rateLimitTier, 'tier-y');
});

// ── a record from a newer client ──────────────────────────────────────────────────────────────

test('a record written by a newer client is not silently downgraded', () => {
  const future = { version: 4, source: 'subscription', plan: 'pro', capturedAt: NOW_ISO, somethingNew: 'keep me' };
  assert.equal(migrateBillingRecord(future, { now: NOW }).record.somethingNew, 'keep me');

  const r = reconcilePlan(VSCDB('ultra', null), future, { now: NOW + 10 * DAY });
  assert.equal(r.outcome, ReconcileOutcome.KEPT);
  assert.equal(r.persist, false, 'rewriting it in the current shape would drop fields we do not understand');
  assert.equal(r.record.version, 4);
  assert.equal(r.changes.some((c) => c.kind === ChangeKind.PRESERVED && c.field === 'version'), true);

  // A deliberate manual override is the documented escape hatch for a rolled-back client.
  const forced = reconcilePlan(VSCDB('ultra', null), future, { now: NOW + 10 * DAY, force: true });
  assert.equal(forced.outcome, ReconcileOutcome.CHANGED);
  assert.equal(forced.record.version, 3);
});

// A read that could not SEE an id is not a read that says the id is gone: Cursor withholds one for
// entirely uninteresting reasons (a locked row, a partial WAL snapshot, a sign-out and back in).
// Writing the blank through would drop a known accountId, send the next check-in with no id, and
// mint a fresh email-only provisional row server-side — every time it happened.
test('a read that sees no id does not erase the id already stored for the same account', () => {
  const learned = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_a' };
  const stored = reconcilePlan(learned, null, { now: NOW }).record;

  const blind = reconcilePlan(VSCDB('pro', 'dev@example.com'), stored, { now: NOW + 10 * DAY });
  assert.equal(blind.record.accountAnchor.accountId, 'auth0|seat_1');
  assert.equal(blind.record.accountAnchor.subscriptionId, 'sub_a');
  assert.equal(blind.record.plan, 'pro');

  // It holds across the plan-changed branch too, which builds its record the same way.
  const upgraded = reconcilePlan(VSCDB('ultra', 'dev@example.com'), stored, { now: NOW + 10 * DAY });
  assert.equal(upgraded.record.plan, 'ultra');
  assert.equal(upgraded.record.accountAnchor.accountId, 'auth0|seat_1');
});

// The backfill is gated on MATCH, and that gate is its whole safety. Carrying the old seat's id
// onto a new account would attribute a stranger's sessions to it.
test('the id backfill never crosses an account switch', () => {
  const stored = reconcilePlan({ ...VSCDB('pro', 'old@example.com'), accountId: 'auth0|seat_1' }, null, { now: NOW }).record;
  const r = reconcilePlan(VSCDB('free', 'new@example.com'), stored, { now: NOW + DAY });
  assert.equal(r.outcome, ReconcileOutcome.CHANGED);
  assert.equal(r.record.accountAnchor.email, 'new@example.com');
  assert.equal(r.record.accountAnchor.accountId, null, 'the old seat id must not ride along');
});

test('a newly observed id still wins over the stored one for the same account', () => {
  const stored = reconcilePlan({ ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_a' }, null, { now: NOW }).record;
  const moved = { ...VSCDB('pro', 'dev@example.com'), accountId: 'auth0|seat_1', subscriptionId: 'sub_b' };
  const r = reconcilePlan(moved, stored, { now: NOW + DAY });
  assert.equal(r.record.accountAnchor.subscriptionId, 'sub_b');
});
