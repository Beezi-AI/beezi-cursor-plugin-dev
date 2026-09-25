import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  syncAccountIfNeeded,
  buildCheckInScope,
  makeCheckInTransport,
  checkInPayloadFromRecord,
  identifiesAnAccount,
  reportRefreshedAccount,
  CheckInSkip,
  CheckInVia,
} from '../lib/account-checkin.mjs';
import { CheckInOutcome } from '../lib/account-sync.mjs';
import { readCursorAccount } from '../lib/cursor-account.mjs';
import { observationFromAccount, observationFromArgs, reconcilePlan, ReconcileOutcome } from '../lib/billing-capture.mjs';
import { ENDPOINTS } from '../lib/config.mjs';

// The wiring between `lib/account-sync.mjs` (the protocol) and the three call sites (plan §4 B3).
// Everything here is injected: no socket is opened and no file outside a temp home is touched.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const RECORD = {
  version: 3,
  source: 'subscription',
  plan: 'pro',
  subscriptionType: 'pro',
  rateLimitTier: null,
  capturedAt: '2026-09-20T00:00:00.000Z',
  accountAnchor: {
    email: 'seat@example.com',
    accountId: 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T',
    subscriptionId: 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T',
    source: 'state_vscdb',
  },
  subscriptionStatus: 'active',
};

// A spy standing in for `checkInAccount` itself: the protocol has 32 tests of its own, and what
// this file is about is what the wiring HANDS it.
function spyCheckIn(result) {
  const calls = [];
  const fn = async (payload, auth, deps) => {
    calls.push({ payload, auth, deps });
    return result === undefined ? { outcome: CheckInOutcome.SENT, successful: true, writeback: null } : result;
  };
  fn.calls = calls;
  return fn;
}

function deps(over) {
  return {
    checkInAccount: spyCheckIn(),
    // A named Beezi account without going anywhere near the tracking cache on disk.
    currentAccountKey: () => 'beezi-user',
    envName: () => 'staging',
    // Stubbed so no case ever reaches the real credential store, which on Windows means the OS
    // keyring — a suite must never depend on whether the developer running it is signed in.
    getAccessToken: async () => 'resolved-tok',
    record: RECORD,
    postJson: async () => ({ ok: true, status: 200, body: {} }),
    ...(over == null ? {} : over),
  };
}

test('the payload is built from the reconciled record, and carries no subscriptionStatus', () => {
  const payload = checkInPayloadFromRecord(RECORD);
  // `subscriptionType` is the RAW plan the server's alias-discovery loop needs, which is where
  // `reconcilePlan` puts it — not the normalized `plan`.
  assert.deepEqual(Object.keys(payload).sort(), ['accountUuid', 'email', 'subscriptionType']);
  assert.equal(payload.accountUuid, RECORD.accountAnchor.accountId);
  assert.equal(payload.email, 'seat@example.com');
  // Plan §4 E3 is undeployed and one unknown key 400s the WHOLE check-in under
  // `forbidNonWhitelisted`. The record HAS a status; the payload must not.
  assert.equal(RECORD.subscriptionStatus, 'active');
  assert.equal('subscriptionStatus' in payload, false);
});

test('an empty environment name is prod, not an absent scope', (t) => {
  tmpHome(t);
  // `envName` answers '' for production. A truthiness guard anywhere on this path would make every
  // production machine on earth answer SCHEMA/incomplete-scope, silently, while every test with a
  // named environment passed.
  const built = buildCheckInScope({ envName: () => '', currentAccountKey: () => 'beezi-user' });
  assert.equal(built.ok, true);
  assert.equal(built.scope.env, '');
  assert.equal(built.scope.beeziAccount, 'beezi-user');
});

test('a prod machine still reaches the check-in with its empty env', async (t) => {
  tmpHome(t);
  const d = deps({ envName: () => '' });
  const res = await syncAccountIfNeeded('tok', { via: CheckInVia.LOGIN }, d);
  assert.equal(d.checkInAccount.calls.length, 1);
  assert.deepEqual(d.checkInAccount.calls[0].deps.scope, { env: '', beeziAccount: 'beezi-user' });
  assert.equal(res.outcome, CheckInOutcome.SENT);
});

test('an unbuildable scope is reported, not handed to the protocol as a silent SCHEMA', async (t) => {
  tmpHome(t);
  const issues = [];
  const d = deps({ currentAccountKey: () => null, recordIssue: (code, f) => issues.push([code, f.reason]) });
  const res = await syncAccountIfNeeded('tok', {}, d);
  assert.equal(d.checkInAccount.calls.length, 0);
  assert.equal(res.skipped, CheckInSkip.NO_SCOPE);
  assert.equal(res.reason, 'no-beezi-account');
  assert.deepEqual(issues, [['account_checkin_scope_failed', 'no-beezi-account']]);
});

test('an invalid BEEZI_CURSOR_ENV is a reported scope failure, never a thrown login', async (t) => {
  tmpHome(t);
  const issues = [];
  const d = deps({
    envName: () => { throw new Error('invalid BEEZI_CURSOR_ENV: "qa"'); },
    recordIssue: (code, f) => issues.push([code, f.reason]),
  });
  const res = await syncAccountIfNeeded('tok', {}, d);
  assert.equal(res.skipped, CheckInSkip.NO_SCOPE);
  assert.equal(res.reason, 'invalid-env');
  assert.equal(issues.length, 1);
});

test('nothing is sent when there is nothing to report', async (t) => {
  tmpHome(t);
  // A record with no identity at all: `buildCheckInPayload` produces `{}`, which validates and
  // hashes and would POST perfectly happily. An empty forced check-in on every plan-less machine is
  // pure noise, so the floor is an accountUuid or an email.
  const blank = { ...RECORD, accountAnchor: null, subscriptionType: null };
  assert.equal(identifiesAnAccount(checkInPayloadFromRecord(blank)), false);
  const d = deps({ record: blank });
  const res = await syncAccountIfNeeded('tok', { force: true }, d);
  assert.equal(d.checkInAccount.calls.length, 0);
  assert.equal(res.skipped, CheckInSkip.NOTHING_TO_REPORT);

  const none = deps({ record: null });
  const res2 = await syncAccountIfNeeded('tok', { force: true }, none);
  assert.equal(none.checkInAccount.calls.length, 0);
  assert.equal(res2.skipped, CheckInSkip.NO_RECORD);
});

test('an unlinked machine resolves no token and attempts nothing', async (t) => {
  tmpHome(t);
  const d = deps({ getAccessToken: async () => null });
  const res = await syncAccountIfNeeded(null, { force: true }, d);
  assert.equal(d.checkInAccount.calls.length, 0);
  assert.equal(res.skipped, CheckInSkip.NO_TOKEN);
});

test('force is passed through, and defaults to false', async (t) => {
  tmpHome(t);
  const forced = deps();
  await syncAccountIfNeeded('tok', { force: true, via: CheckInVia.BILLING_CAPTURE }, forced);
  assert.equal(forced.checkInAccount.calls[0].deps.force, true);

  const steady = deps();
  await syncAccountIfNeeded('tok', { via: CheckInVia.SESSION_START }, steady);
  assert.equal(steady.checkInAccount.calls[0].deps.force, false);
});

test('`via` never reaches the wire', async (t) => {
  tmpHome(t);
  const d = deps();
  await syncAccountIfNeeded('tok', { force: true, via: CheckInVia.LOGIN }, d);
  const sent = d.checkInAccount.calls[0].payload;
  // One key the server's DTO does not declare 400s the entire check-in under
  // `forbidNonWhitelisted`, so `via` is for local reasoning and nothing else.
  assert.equal('via' in sent, false);
  assert.deepEqual(Object.keys(sent).sort(), ['accountUuid', 'email', 'subscriptionType']);
});

test('the anchor and the existing record travel with the call, so a writeback means something', async (t) => {
  tmpHome(t);
  const d = deps();
  await syncAccountIfNeeded('tok', {}, d);
  const passed = d.checkInAccount.calls[0].deps;
  assert.deepEqual(passed.anchor, RECORD.accountAnchor);
  assert.equal(passed.existingBillingRecord, RECORD);
});

test('the auth fence is a primitive, checked the way the protocol compares it', async (t) => {
  tmpHome(t);
  const d = deps({ authEpoch: async () => 'https://api.test||user|3' });
  await syncAccountIfNeeded('tok', {}, d);
  const auth = d.checkInAccount.calls[0].auth;
  assert.equal(await auth.getToken(), 'tok');
  const a = await auth.authEpoch();
  const b = await auth.authEpoch();
  // Two reads of an unchanged epoch must be `===`. An object here would make every production
  // check-in answer EPOCH_CHANGED while a stubbed string in a test passed.
  assert.equal(a, b);
  assert.equal(typeof a, 'string');
});

test('a check-in that throws is swallowed whole', async (t) => {
  tmpHome(t);
  const d = deps({ checkInAccount: async () => { throw new Error('boom'); } });
  const res = await syncAccountIfNeeded('tok', { force: true }, d);
  assert.equal(res.skipped, CheckInSkip.ERROR);

  const rejects = deps({ checkInAccount: () => Promise.reject(new Error('nope')) });
  assert.equal((await syncAccountIfNeeded('tok', {}, rejects)).skipped, CheckInSkip.ERROR);
});

// ── the transport adapter ─────────────────────────────────────────────────────────────────────

test('the transport reorders, absolutizes and PARSES — a Response handed back would look like success', async () => {
  const seen = [];
  const post = async (url, token, body, opts) => {
    seen.push({ url, token, body, opts });
    return { ok: true, status: 200, json: async () => ({ plan: 'pro', planSource: 'manual' }) };
  };
  const transport = makeCheckInTransport({ postJson: post, timeoutMs: 1234 });
  const res = await transport(ENDPOINTS.accountSync, { email: 'a@b.c' }, 'tok');

  // `lib/http.mjs` is (url, token, body); the protocol calls (endpoint, body, token). A swap sends
  // `Bearer [object Object]`.
  assert.equal(seen[0].token, 'tok');
  assert.deepEqual(seen[0].body, { email: 'a@b.c' });
  // A bare path makes fetch throw, which the protocol reads as OFFLINE.
  assert.ok(seen[0].url.endsWith(ENDPOINTS.accountSync));
  assert.ok(/^https?:\/\//.test(seen[0].url));
  assert.equal(seen[0].opts.timeoutMs, 1234);
  // The body must be PARSED. Handing back the Response leaves a ReadableStream here, and the
  // outcome is SENT with `successful: true` while the writeback silently refuses `no-plan`.
  assert.deepEqual(res, { ok: true, status: 200, body: { plan: 'pro', planSource: 'manual' } });
});

test('a 2xx whose body cannot be read is still a check-in that landed', async () => {
  const transport = makeCheckInTransport({
    postJson: async () => ({ ok: true, status: 204, json: async () => { throw new Error('empty'); } }),
  });
  const res = await transport(ENDPOINTS.accountSync, {}, 'tok');
  // `{}`, not null: null makes the protocol answer SCHEMA, leave the heartbeat unwritten, and
  // re-send the same payload forever against a server whose body reads are slow.
  assert.deepEqual(res, { ok: true, status: 204, body: {} });
});

test('a non-2xx keeps its status so the protocol can tell a 403 from a 400', async () => {
  const transport = makeCheckInTransport({
    postJson: async () => ({ ok: false, status: 403, json: async () => ({ message: 'no seat' }) }),
  });
  const res = await transport(ENDPOINTS.accountSync, {}, 'tok');
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test('end to end through the REAL protocol: a parsed writeback, not merely a SENT', async (t) => {
  tmpHome(t);
  // No `checkInAccount` override — this is the genuine article, with only the socket stubbed.
  const res = await syncAccountIfNeeded('tok', { force: true }, {
    currentAccountKey: () => 'beezi-user',
    envName: () => 'staging',
    authEpoch: async () => 'epoch-1',
    record: RECORD,
    postJson: makeCheckInTransport({
      postJson: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          plan: 'ultra',
          planSource: 'manual',
          observedAt: '2026-09-21T00:00:00.000Z',
          account: { accountUuid: RECORD.accountAnchor.accountId, email: 'seat@example.com' },
        }),
      }),
    }),
  });
  assert.equal(res.outcome, CheckInOutcome.SENT);
  assert.notEqual(res.writeback, null);
  assert.equal(res.writeback.accepted, true);
  assert.equal(res.writeback.record.plan, 'ultra');
});

test('the refresh command reports FORCED — the one flag /beezi:refresh depends on', async (t) => {
  tmpHome(t);
  // `scripts/billing-capture.mjs` is a script and cannot be imported without running, so this
  // function is where the flag is locked. `/beezi:refresh` runs `--from-cursor --force --via
  // refresh`: the user has asked for a re-read precisely because they think the stored tier is
  // wrong, and the fingerprint gate would answer SKIPPED for the unchanged payload they are sitting
  // on. Without the force this command sends nothing on the run that most needs to.
  const d = deps();
  await reportRefreshedAccount(RECORD, d);
  assert.equal(d.checkInAccount.calls.length, 1);
  assert.equal(d.checkInAccount.calls[0].deps.force, true);
  assert.equal(d.checkInAccount.calls[0].deps.existingBillingRecord, RECORD);
});

test('the refresh report cannot have its record substituted by a caller bag', async (t) => {
  tmpHome(t);
  const other = { ...RECORD, accountAnchor: { email: 'someone-else@example.com', source: 'cli-config' } };
  const d = deps();
  await reportRefreshedAccount(other, d);
  // `deps()` carries RECORD. The record that was just reconciled wins.
  assert.equal(d.checkInAccount.calls[0].payload.email, 'someone-else@example.com');
});

test('the refresh report of a plan-less machine sends nothing', async (t) => {
  tmpHome(t);
  const d = deps();
  const res = await reportRefreshedAccount(null, d);
  assert.equal(d.checkInAccount.calls.length, 0);
  assert.equal(res.skipped, CheckInSkip.NO_RECORD);
});

// ── a CLI-only machine, end to end: cli-config.json → billing.json → the check-in body ─────────
//
// The failure this pins: `~/.cursor/cli-config.json` keeps the identity at `authInfo.email` /
// `authInfo.authId` and has no plan key, the reader returned null for want of a plan, reconcile had
// nothing to anchor, and the check-in answered NOTHING_TO_REPORT — so no session report from that
// machine ever carried an `account_uuid`. Chained through the REAL reader, observation, reconcile
// and payload builder, so a drop anywhere along the way fails here.
const CLI_AUTH_ID = 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T';
const CLI_SECRET = 'sk-cli-secret-0123456789';
const CLI_ONLY = {
  stateVscdbFile: '/fake/state.vscdb',
  readKeys: () => null,
  cliConfigFile: '/fake/cli-config.json',
  readFile: () => JSON.stringify({
    version: 1,
    authInfo: { email: 'Seat@Example.com', authId: CLI_AUTH_ID, accessToken: CLI_SECRET, refreshToken: CLI_SECRET },
  }),
};
const E2E_NOW = Date.parse('2026-09-24T00:00:00.000Z');

function cliOnlyRecord(prior) {
  const obs = observationFromAccount(readCursorAccount(CLI_ONLY), 'session-start');
  return reconcilePlan(obs, prior == null ? null : prior, { now: E2E_NOW, attempted: true });
}

test('a CLI-only machine with no plan anchors billing.json and checks in with its accountUuid', async (t) => {
  tmpHome(t);
  const r = cliOnlyRecord();
  // Still NEEDS_USER — no plan was read and none is claimed — but the identity is not thrown away.
  assert.equal(r.outcome, ReconcileOutcome.NEEDS_USER);
  assert.equal(r.persist, true);
  assert.equal(r.record.plan, null);
  assert.deepEqual(r.record.accountAnchor, { email: 'seat@example.com', accountId: CLI_AUTH_ID, subscriptionId: null, source: 'cli_config' });
  assert.equal(JSON.stringify(r.record).includes(CLI_SECRET), false, 'no cli-config credential reaches billing.json');

  const payload = checkInPayloadFromRecord(r.record);
  assert.deepEqual(payload, { accountUuid: CLI_AUTH_ID, email: 'seat@example.com' }, 'no plan, so no subscriptionType is invented');
  assert.equal(identifiesAnAccount(payload), true);

  const d = deps({ record: r.record });
  const res = await syncAccountIfNeeded('tok', { force: false, via: CheckInVia.SESSION_START }, d);
  assert.equal(res.skipped, undefined, 'not NOTHING_TO_REPORT any more');
  assert.equal(d.checkInAccount.calls[0].payload.accountUuid, CLI_AUTH_ID);
  assert.equal(JSON.stringify(d.checkInAccount.calls[0].payload).includes(CLI_SECRET), false);
});

test('a plan-less record written before the fix learns the CLI identity on the next read', () => {
  // What every CLI-only billing.json on disk looks like today: an attempt stamp and nothing else.
  const stale = reconcilePlan(null, null, { now: E2E_NOW - 8 * 24 * 60 * 60 * 1000, attempted: true }).record;
  assert.equal(stale.accountAnchor, null);
  const r = cliOnlyRecord(stale);
  assert.equal(r.persist, true, 'an anchor learned is worth writing');
  assert.equal(r.record.accountAnchor.accountId, CLI_AUTH_ID);
});

test('a CLI-only record with no plan keeps its anchor when nothing new is learned', () => {
  const first = cliOnlyRecord().record;
  // A read that observes nothing identifying must not blank what the previous read learned.
  const blind = reconcilePlan(
    observationFromAccount({ plan: 'unknown', rawPlan: null, source: 'cli_config', email: null, accountId: null }, 'session-start'),
    first,
    { now: E2E_NOW + 60 * 1000, attempted: true },
  );
  assert.equal(blind.record.accountAnchor.accountId, CLI_AUTH_ID);
});

test('a self-reported plan on a CLI-only machine checks in with the plan AND the cli-config identity', () => {
  // The reader-level merge (`deps.selfReportedPlan`): the plan from the user, the identity from cli-config.
  const obs = observationFromAccount(readCursorAccount({ ...CLI_ONLY, selfReportedPlan: 'pro' }), 'refresh');
  const r = reconcilePlan(obs, null, { now: E2E_NOW });
  assert.equal(r.record.plan, 'pro');
  assert.equal(r.record.selfReported, true);
  assert.deepEqual(checkInPayloadFromRecord(r.record), { accountUuid: CLI_AUTH_ID, email: 'seat@example.com', subscriptionType: 'pro' });
});

test('`/beezi:refresh --plan pro` on a CLI-only machine keeps the identity it already learned', () => {
  // The PRODUCTION self-report path is `observationFromArgs`, which carries no identity by
  // construction. Over a CLI-learned anchor, writing its empty anchor through would drop the
  // accountUuid — and, because the attempt stamp moves too, keep it dropped for a full recheck window.
  const anchored = cliOnlyRecord().record;
  const r = reconcilePlan(observationFromArgs({ plan: 'pro' }), anchored, { now: E2E_NOW + 60 * 1000 });
  assert.equal(r.record.plan, 'pro');
  assert.equal(r.record.selfReported, true);
  assert.equal(r.record.accountAnchor.accountId, CLI_AUTH_ID);
  assert.deepEqual(checkInPayloadFromRecord(r.record), { accountUuid: CLI_AUTH_ID, email: 'seat@example.com', subscriptionType: 'pro' });
});

test('a self-report that NAMES a different email is still a switch, never glued to the old id', () => {
  const anchored = cliOnlyRecord().record;
  const r = reconcilePlan(observationFromArgs({ plan: 'pro', email: 'other@example.com' }), anchored, { now: E2E_NOW + 60 * 1000 });
  assert.equal(r.record.accountAnchor.email, 'other@example.com');
  assert.equal(r.record.accountAnchor.accountId, null, 'the old seat id must not ride along');
});
