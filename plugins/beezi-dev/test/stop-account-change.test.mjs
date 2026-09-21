import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountChangeOutcome,
  CHECKIN_BUDGET_FLOOR_MS,
  ChangeReason,
  PENDING_RETRY_MS,
  detectChange,
  payloadEmailMismatch,
  readPendingCheckIn,
  runStopAccountCheck,
  writePendingCheckIn,
} from '../lib/stop-account-change.mjs';
import { CheckInOutcome, accountSyncStateFile } from '../lib/account-sync.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { billingConfigFile } from '../lib/paths-cursor.mjs';
import { AccountSource } from '../lib/cursor-account.mjs';

// Phase C — change detection on the `stop` hook.
//
// These tests drive `runStopAccountCheck` directly rather than spawning the hook, for one concrete
// reason: the budget floor. `ctx.remainingMs()` is derived inside `runHook` from a fixed
// `hookBudgetMs(false)`, and nothing in the environment moves it, so "the budget was under the
// floor" is unreachable from a spawned process without burning six seconds of wall clock per case.
// The hook's own wiring — that this runs at all, and that it cannot cost the user their checkpoint
// — is covered by spawn tests in test/turn-end-events.test.mjs.
//
// What is NOT stubbed is deliberate: `syncAccountIfNeeded`, `checkInAccount`, `reconcilePlan`, the
// scope builder, the state file and billing.json are all real. Only the host read (`readAccount`),
// the transport (`postJson`), the credential store (`getAccessToken`/`authEpoch`) and the two
// identity seams the scope is built from are injected — so a rename or a shape change anywhere in
// lib/cursor-account, lib/billing-capture, lib/account-checkin or lib/account-sync fails here.

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const SCOPE = Object.freeze({ env: '', beeziAccount: 'tenant-1|user-1' });

// Two DIFFERENT addresses, on purpose. billing.json legitimately stores the address Cursor's own
// database reported — that is the account anchor. What must never appear on disk is the one that
// arrived on the hook payload, so the privacy assertion below has something to look for that a
// legitimate write cannot supply.
const VSCDB_EMAIL = 'seat@example.com';
const PAYLOAD_EMAIL = 'intruder@example.net';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-stop-account-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function account(over) {
  return {
    plan: 'pro',
    rawPlan: 'pro',
    source: AccountSource.STATE_VSCDB,
    email: VSCDB_EMAIL,
    accountId: 'auth0|user_AAA',
    subscriptionId: 'auth0|user_AAA',
    status: 'active',
    ...(over == null ? {} : over),
  };
}

// The record a previous run would have left for `account()`. Written through the real writer so the
// shape is the one production reads back.
function seedBilling(over) {
  const record = {
    version: 3,
    source: 'subscription',
    plan: 'pro',
    subscriptionType: 'pro',
    rateLimitTier: null,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    identityCheckedAt: new Date(NOW - 60_000).toISOString(),
    lastPlanReadAttemptAt: new Date(NOW - 60_000).toISOString(),
    migratedAt: null,
    accountAnchor: {
      email: VSCDB_EMAIL,
      accountId: 'auth0|user_AAA',
      subscriptionId: 'auth0|user_AAA',
      source: AccountSource.STATE_VSCDB,
    },
    subscriptionStatus: 'active',
    capturedBy: 'stop',
    selfReported: false,
    ...(over == null ? {} : over),
  };
  writeBillingConfig(record);
  return record;
}

function harness(over) {
  const posts = [];
  const writes = [];
  const deps = {
    now: NOW,
    // The same two seams the marker's scope and the check-in's scope are BOTH built from. They
    // have to agree, or a marker lands beside the state file the send actually used.
    envName: () => SCOPE.env,
    currentAccountKey: () => SCOPE.beeziAccount,
    getAccessToken: async () => 'token',
    authEpoch: async () => 'epoch-1',
    readAccount: () => account(),
    postJson: async (endpoint, body, token) => {
      posts.push({ endpoint, body, token });
      return { ok: true, status: 200, body: {} };
    },
    ...(over == null ? {} : over),
  };
  const writeConfig = deps.writeConfig;
  deps.writeConfig = (record) => {
    writes.push(record);
    return writeConfig == null ? writeBillingConfig(record) : writeConfig(record);
  };
  return { deps, posts, writes };
}

function ctx(remaining, payload) {
  return { payload: payload === undefined ? { session_id: 's1' } : payload, remainingMs: () => remaining };
}

// ── C2: the steady state ──────────────────────────────────────────────────────────────────────

test('an unchanged account writes nothing and posts nothing', async (t) => {
  tmpHome(t);
  seedBilling();
  const before = fs.readFileSync(billingConfigFile(), 'utf-8');
  const { deps, posts, writes } = harness();

  const result = await runStopAccountCheck(ctx(8000), deps);

  // Asserted on the OUTCOME, not just on the absence of a post: "nothing was posted" passes
  // trivially when the whole path short-circuits for an unrelated reason (an unreadable host, a
  // scope with no Beezi account, a swallowed throw), and a test that cannot tell those apart from
  // the steady state is a test that will keep passing after the feature stops working.
  assert.equal(result.outcome, AccountChangeOutcome.UNCHANGED);
  assert.equal(result.reason, null);
  assert.deepEqual(posts, []);
  assert.deepEqual(writes, []);
  assert.equal(fs.readFileSync(billingConfigFile(), 'utf-8'), before);
  assert.equal(fs.existsSync(accountSyncStateFile(SCOPE)), false);
});

// The positive control for the test above: same fixture, one field moved, and the path that was
// silent must now do all of its work.
test('a changed plan reconciles, persists and forces a check-in', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts, writes } = harness({ readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }) });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.reason, ChangeReason.PLAN);
  assert.equal(result.outcome, AccountChangeOutcome.CHECKED_IN);
  assert.equal(result.checkIn, CheckInOutcome.SENT);
  assert.equal(result.persisted, true);
  assert.equal(readBillingConfig().plan, 'ultra');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, '/me/cli-agent/account');
  assert.equal(posts[0].body.subscriptionType, 'ultra');
  assert.equal(writes.length, 1);
});

test('a changed subscription status forces the same path', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({ readAccount: () => account({ status: 'past_due' }) });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.reason, ChangeReason.STATUS);
  assert.equal(result.checkIn, CheckInOutcome.SENT);
  assert.equal(readBillingConfig().subscriptionStatus, 'past_due');
  assert.equal(posts.length, 1);
});

// ── C3: a switch ──────────────────────────────────────────────────────────────────────────────

test('a different accountId is a switch: the record moves to the new seat and is checked in', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({
    readAccount: () => account({ accountId: 'auth0|user_BBB', subscriptionId: 'auth0|user_BBB', email: 'other@example.com' }),
  });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.reason, ChangeReason.SWITCH);
  assert.equal(result.outcome, AccountChangeOutcome.CHECKED_IN);
  assert.equal(result.checkIn, CheckInOutcome.SENT);
  const stored = readBillingConfig();
  assert.equal(stored.accountAnchor.accountId, 'auth0|user_BBB');
  // billing.json is written BEFORE the POST, which is what makes a lost check-in "late" rather than
  // "wrong": the next session report carries the new identity either way.
  assert.equal(posts[0].body.accountUuid, 'auth0|user_BBB');
});

test('a seat moving between subscriptions is a switch even with the same accountId', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps } = harness({ readAccount: () => account({ subscriptionId: 'auth0|user_TEAM' }) });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.reason, ChangeReason.SWITCH);
  assert.equal(readBillingConfig().accountAnchor.subscriptionId, 'auth0|user_TEAM');
});

// ── C3: the budget bound ──────────────────────────────────────────────────────────────────────

test('a budget under the floor skips the POST entirely and leaves a pendingCheckIn marker', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({
    readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }),
    postJson: () => { throw new Error('must not post below the budget floor'); },
  });

  const result = await runStopAccountCheck(ctx(CHECKIN_BUDGET_FLOOR_MS - 1), deps);

  assert.equal(result.outcome, AccountChangeOutcome.DEFERRED);
  assert.equal(result.checkIn, null);
  assert.deepEqual(posts, []);
  // The degrade is LATE, not WRONG: the record is already on disk, so the next session report is
  // correct regardless of whether the check-in ever lands.
  assert.equal(result.persisted, true);
  assert.equal(readBillingConfig().plan, 'ultra');
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), SCOPE), true);
});

test('exactly the floor is enough to attempt the POST', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({ readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }) });

  const result = await runStopAccountCheck(ctx(CHECKIN_BUDGET_FLOOR_MS), deps);

  assert.equal(result.outcome, AccountChangeOutcome.CHECKED_IN);
  assert.equal(posts.length, 1);
});

// ── C3: draining ──────────────────────────────────────────────────────────────────────────────

test('a marker left by a previous stop is drained on the next one, with nothing else changed', async (t) => {
  tmpHome(t);
  seedBilling();
  writePendingCheckIn(accountSyncStateFile(SCOPE), SCOPE);
  const { deps, posts, writes } = harness();

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.outcome, AccountChangeOutcome.DRAINED);
  assert.equal(result.checkIn, CheckInOutcome.SENT);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.accountUuid, 'auth0|user_AAA');
  // A drain sends; it does not reconcile. Nothing about the record was observed to have moved.
  assert.deepEqual(writes, []);
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), SCOPE), false);
});

test('a failed send re-arms the marker instead of losing the check-in', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps } = harness({
    readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }),
    postJson: async () => { throw new Error('offline'); },
  });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.checkIn, CheckInOutcome.OFFLINE);
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), SCOPE), true);
});

test('a marker written under one Beezi account is not drained under another', (t) => {
  tmpHome(t);
  const other = { env: '', beeziAccount: 'tenant-2|user-2' };
  writePendingCheckIn(accountSyncStateFile(SCOPE), SCOPE);
  // Same file, different scope: the state file is named by a digest of the scope, so this only
  // matters when the two collide — but the scope guard is what makes that collision safe, and
  // `readAccountSyncState` applies the same rule to the heartbeat fields.
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), other), false);
});

// ── C1: the host read is guarded ──────────────────────────────────────────────────────────────

test('readCursorAccount throwing leaves the record untouched and the run intact', async (t) => {
  tmpHome(t);
  seedBilling();
  const before = fs.readFileSync(billingConfigFile(), 'utf-8');
  const { deps, posts, writes } = harness({
    readAccount: () => { throw new Error('state.vscdb is a directory'); },
  });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.outcome, AccountChangeOutcome.UNCHANGED);
  assert.deepEqual(posts, []);
  assert.deepEqual(writes, []);
  assert.equal(fs.readFileSync(billingConfigFile(), 'utf-8'), before);
});

test('an ENOENT host read is the same answer, not a switch', async (t) => {
  tmpHome(t);
  seedBilling();
  const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  const { deps, writes } = harness({ readAccount: () => { throw enoent; } });

  const result = await runStopAccountCheck(ctx(8000), deps);

  // A host that could not be read says NOTHING about who the account is. Reading the absent read as
  // a switch would blank a perfectly good plan on every `cursor-agent`-only turn.
  assert.equal(result.outcome, AccountChangeOutcome.UNCHANGED);
  assert.deepEqual(writes, []);
});

test('a CLI-config account carries no identity and is not mistaken for a switch', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, writes } = harness({
    readAccount: () => ({
      plan: 'pro', rawPlan: 'pro', source: AccountSource.CLI_CONFIG,
      email: null, accountId: null, subscriptionId: null, status: null,
    }),
  });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.outcome, AccountChangeOutcome.UNCHANGED);
  assert.deepEqual(writes, []);
});

// ── C4: the hook payload's user_email ─────────────────────────────────────────────────────────

test('a user_email that does not match the anchor forces the change path', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness();

  const result = await runStopAccountCheck(ctx(8000, { session_id: 's1', user_email: PAYLOAD_EMAIL }), deps);

  assert.equal(result.reason, ChangeReason.PAYLOAD_EMAIL);
  assert.equal(result.checkIn, CheckInOutcome.SENT);
  // vscdb has not caught up, so the observation still describes the OLD seat and the check-in
  // re-sends the old tuple. That is the intended degrade: the payload is corroboration, not the
  // identity authority, and it must never be able to blank a plan on its own.
  assert.equal(posts[0].body.accountUuid, 'auth0|user_AAA');
  assert.equal(readBillingConfig().plan, 'pro');
});

test('a repeated user_email mismatch does not post on every single turn', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness();
  const payload = { session_id: 's1', user_email: PAYLOAD_EMAIL };

  const first = await runStopAccountCheck(ctx(8000, payload), deps);
  const second = await runStopAccountCheck(ctx(8000, payload), deps);

  // The payload-email trigger compares against an anchor no reconcile can move, so it re-fires on
  // every stop until vscdb catches up. It is therefore the one trigger that is NOT forced past
  // `isCheckInDue`'s hash gate: the first stop sends, and the second finds the same tuple already
  // sent. Forcing it would be one POST per turn — two, since both hook registries fire — for as
  // long as the mismatch lasts, which on a renamed address is forever.
  assert.equal(first.checkIn, CheckInOutcome.SENT);
  assert.equal(second.checkIn, CheckInOutcome.SKIPPED);
  assert.equal(posts.length, 1);
  // And a SKIPPED must not arm the marker: there is nothing owed.
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), SCOPE), false);
});

test('a real switch is still forced past the heartbeat gate', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({ readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }) });

  await runStopAccountCheck(ctx(8000), deps);
  // Same tuple a second time, but now arriving as a switch: force must still get it out, because
  // the seven-day heartbeat exists to suppress redundant traffic, not to delay a subscription
  // change by a week.
  seedBilling({ accountAnchor: { email: VSCDB_EMAIL, accountId: 'auth0|user_OLD', subscriptionId: 'auth0|user_OLD', source: AccountSource.STATE_VSCDB } });
  const second = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(second.reason, ChangeReason.SWITCH);
  assert.equal(second.checkIn, CheckInOutcome.SENT);
  assert.equal(posts.length, 2);
});

test('a re-armed marker backs off instead of retrying on every stop', async (t) => {
  tmpHome(t);
  seedBilling();
  let posts = 0;
  const offline = harness({
    now: NOW,
    readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }),
    postJson: async () => { posts += 1; throw new Error('offline'); },
  });

  await runStopAccountCheck(ctx(8000), offline.deps);
  assert.equal(posts, 1);

  // The very next stop, milliseconds later. An offline machine fails again, and a drain that
  // retried unconditionally would spend a connection attempt out of every turn's budget — the same
  // budget runCheckpoint is handed immediately afterwards.
  const file = accountSyncStateFile(SCOPE);
  assert.equal(readPendingCheckIn(file, SCOPE, { now: NOW + 1000 }), false);
  // And it does come back, once the backoff has matured.
  assert.equal(readPendingCheckIn(file, SCOPE, { now: NOW + PENDING_RETRY_MS }), true);

  const soon = await runStopAccountCheck(ctx(8000, undefined), { ...offline.deps, now: NOW + 1000 });
  assert.equal(soon.outcome, AccountChangeOutcome.UNCHANGED);
  assert.equal(posts, 1);
});

test('a budget deferral is retried on the next stop, not backed off', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({ readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }) });

  const deferred = await runStopAccountCheck(ctx(CHECKIN_BUDGET_FLOOR_MS - 1), deps);
  assert.equal(deferred.outcome, AccountChangeOutcome.DEFERRED);

  // Nothing failed — the POST never ran. The next stop may have the whole budget, so it drains
  // immediately rather than waiting out a backoff meant for a network that is down.
  const drained = await runStopAccountCheck(ctx(8000), { ...deps, now: NOW + 1000 });
  assert.equal(drained.outcome, AccountChangeOutcome.DRAINED);
  assert.equal(posts.length, 1);
  assert.equal(readPendingCheckIn(accountSyncStateFile(SCOPE), SCOPE), false);
});

test('an anchor with an id but no email is never a payload mismatch', () => {
  // The v3 state.vscdb machine: `accountId` set, `email` null. If an absent address read as a
  // mismatch, the change path would fire on EVERY stop — and a change path that resolves to a
  // switch runs blankedForSwitch, which destroys the stored plan.
  const anchor = { email: null, accountId: 'auth0|user_AAA', subscriptionId: null, source: AccountSource.STATE_VSCDB };
  assert.equal(payloadEmailMismatch({ user_email: PAYLOAD_EMAIL }, anchor), false);
  assert.equal(payloadEmailMismatch({}, { email: VSCDB_EMAIL, accountId: null, subscriptionId: null, source: 'x' }), false);
  assert.equal(payloadEmailMismatch({ user_email: '  SEAT@EXAMPLE.COM ' }, {
    email: VSCDB_EMAIL, accountId: null, subscriptionId: null, source: 'x',
  }), false);
});

test('the stop path writes no plaintext payload email to disk', async (t) => {
  const home = tmpHome(t);
  seedBilling();
  const { deps } = harness({ readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }) });

  await runStopAccountCheck(ctx(8000, { session_id: 's1', user_email: PAYLOAD_EMAIL, model: 'gpt-5' }), deps);
  // And again on the deferred branch, which is the one that writes the marker.
  await runStopAccountCheck(ctx(200, { session_id: 's1', user_email: PAYLOAD_EMAIL }), deps);

  // `test/cursor-version.test.mjs` locks the NORMALIZER's refusal to carry `user_email`. It proves
  // nothing about this path, which reads the raw payload deliberately — so the whole data root is
  // swept, both for the plaintext address and for a hash of it.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(home);
  assert.ok(files.length > 0, 'nothing was written at all — the sweep would pass vacuously');
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf-8');
    assert.equal(body.includes(PAYLOAD_EMAIL), false, `${file} carries the payload email`);
    assert.equal(body.includes('intruder'), false, `${file} carries the payload local-part`);
    assert.equal(body.includes('example.net'), false, `${file} carries the payload domain`);
  }
});

// ── the scope ─────────────────────────────────────────────────────────────────────────────────

test('a machine with no recorded Beezi account reconciles but leaves no undrainable marker', async (t) => {
  tmpHome(t);
  seedBilling();
  const { deps, posts } = harness({
    currentAccountKey: () => null,
    readAccount: () => account({ plan: 'ultra', rawPlan: 'ultra' }),
  });

  const result = await runStopAccountCheck(ctx(8000), deps);

  assert.equal(result.outcome, AccountChangeOutcome.RECORDED);
  assert.equal(result.persisted, true);
  assert.equal(readBillingConfig().plan, 'ultra');
  assert.deepEqual(posts, []);
  assert.equal(fs.existsSync(accountSyncStateFile(SCOPE)), false);
});

// ── detectChange, directly ────────────────────────────────────────────────────────────────────

test('an unmapped plan string is not a plan change', () => {
  const anchor = { email: VSCDB_EMAIL, accountId: 'auth0|user_AAA', subscriptionId: 'auth0|user_AAA', source: AccountSource.STATE_VSCDB };
  const record = { plan: 'pro', subscriptionStatus: 'active', accountAnchor: anchor };
  // Cursor "Start" and anything else we do not map observes as `unknown`. `reconcilePlan` already
  // preserves the stored plan for it, so treating it as a change would force a check-in on every
  // single turn of every machine on an unmapped tier.
  const observation = { plan: 'unknown', status: 'active' };
  assert.equal(detectChange(anchor, record, observation, null), null);
});
