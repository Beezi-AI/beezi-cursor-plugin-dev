import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COST_RECONCILE_ENDPOINT,
  SNAPSHOT_SCHEMA_VERSION,
  LOOKBACK_MS,
  MIN_SCAN_INTERVAL_MS,
  SnapshotStatus,
  buildUsageSnapshot,
  costStateFile,
  readCostState,
  writeCostState,
  isScanDue,
  claimScanAttempt,
  releaseScanAttempt,
  selectConversations,
  applyAcknowledgement,
  sendUsageSnapshot,
} from '../lib/cost-reconcile.mjs';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SCOPE = { env: '', beeziAccount: 'tenant-1|user-1', cursorAccount: 'dev@example.com' };

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cost-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const entry = (id, usage, updatedAt) => ({ conversationId: id, usage, updatedAt });

// ── the pure snapshot builder ─────────────────────────────────────────────────────────────────

test('an unreadable source is a failure, never an empty successful scan', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    const snap = buildUsageSnapshot(bad, { account: SCOPE, env: '', now: NOW });
    assert.equal(snap.status, SnapshotStatus.UNREADABLE);
    assert.deepEqual(snap.entries, []);
    // A zero here would tell the server that nothing was spent, which is the double-loss this
    // whole task exists to prevent.
    assert.equal(snap.totals.costInCents, null);
  }
});

test('a source that yields entries but reads none of them is unreadable, not empty', () => {
  const snap = buildUsageSnapshot([entry('a', null, NOW), entry('b', null, NOW)], { account: SCOPE, env: '', now: NOW });
  assert.equal(snap.status, SnapshotStatus.UNREADABLE);
  assert.equal(snap.unknownConversations.length, 2);
  assert.equal(snap.totals.costInCents, null);
});

test('an explicitly empty source is an honest empty success', () => {
  const snap = buildUsageSnapshot([], { account: SCOPE, env: '', now: NOW });
  assert.equal(snap.status, SnapshotStatus.OK);
  assert.deepEqual(snap.entries, []);
  assert.equal(snap.totals.costInCents, 0);
  assert.equal(snap.totals.complete, true);
});

test('a conversation read with nothing priced is zero, not unknown', () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  assert.equal(snap.status, SnapshotStatus.OK);
  assert.equal(snap.entries.length, 1);
  assert.deepEqual(snap.entries[0].models, {});
  assert.equal(snap.totals.costInCents, 0);
  assert.equal(snap.totals.complete, true);
});

test('a partial read keeps known cost and says the total is incomplete', () => {
  const snap = buildUsageSnapshot([
    entry('a', { 'gpt-5': { amount: 3, costInCents: 120 } }, NOW - HOUR),
    entry('b', null, NOW),
    entry('c', { 'gpt-5': { amount: 1, costInCents: 30 }, 'claude-x': { amount: 2, costInCents: 0 } }, NOW),
  ], { account: SCOPE, env: '', now: NOW });

  assert.equal(snap.status, SnapshotStatus.OK);
  assert.equal(snap.entries.length, 2);
  assert.deepEqual(snap.unknownConversations, ['b']);
  assert.equal(snap.totals.costInCents, 150);
  assert.equal(snap.totals.complete, false, 'an unreadable conversation must not vanish from the total silently');
  assert.equal(snap.version, SNAPSHOT_SCHEMA_VERSION);
  assert.deepEqual(snap.scope, SCOPE);
});

test('snapshot entries drop unusable model records rather than inventing numbers', () => {
  const snap = buildUsageSnapshot([
    entry('a', { good: { amount: 1, costInCents: 10 }, bad: { amount: 'x', costInCents: null } }, NOW),
  ], { account: SCOPE, env: '', now: NOW });
  assert.deepEqual(Object.keys(snap.entries[0].models), ['good']);
  assert.equal(snap.totals.costInCents, 10);
  assert.equal(snap.totals.complete, false, 'a record we could not read is an unknown, not a zero');
});

// ── account-scoped pending state ──────────────────────────────────────────────────────────────

test('pending state is scoped: two accounts never share a file', (t) => {
  tempHome(t);
  const a = costStateFile(SCOPE);
  const b = costStateFile({ ...SCOPE, cursorAccount: 'other@example.com' });
  const c = costStateFile({ ...SCOPE, beeziAccount: 'tenant-2|user-9' });
  const d = costStateFile({ ...SCOPE, env: '-staging' });
  assert.equal(new Set([a, b, c, d]).size, 4);
  assert.equal(path.dirname(a), path.dirname(b));
});

test('a missing, corrupt or foreign-version state reads as a safe empty state', (t) => {
  const home = tempHome(t);
  const file = costStateFile(SCOPE);
  assert.deepEqual(readCostState(file, SCOPE).acknowledgedScanAt, null);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(readCostState(file, SCOPE).acknowledgedScanAt, null);

  fs.writeFileSync(file, JSON.stringify({ version: 99, acknowledgedScanAt: 1 }));
  assert.equal(readCostState(file, SCOPE).acknowledgedScanAt, null, 'an unknown version rescans, it never claims progress');
  assert.ok(home);
});

test('state round-trips and refuses a file written for a different scope', (t) => {
  tempHome(t);
  const file = costStateFile(SCOPE);
  writeCostState(file, { ...readCostState(file, SCOPE), acknowledgedScanAt: NOW }, SCOPE);
  assert.equal(readCostState(file, SCOPE).acknowledgedScanAt, NOW);
  assert.equal(readCostState(file, { ...SCOPE, cursorAccount: 'someone@else.com' }).acknowledgedScanAt, null);
});

// ── scheduling and the single-worker attempt gate ─────────────────────────────────────────────

test('a scan runs at most hourly', () => {
  const fresh = { attemptedScanAt: NOW - 10 * 60 * 1000 };
  assert.equal(isScanDue(fresh, NOW), false);
  assert.equal(isScanDue({ attemptedScanAt: NOW - MIN_SCAN_INTERVAL_MS }, NOW), true);
  assert.equal(isScanDue({ attemptedScanAt: null }, NOW), true);
  // A manual sync asks for the same recovery path and must not be throttled by the schedule.
  assert.equal(isScanDue(fresh, NOW, { force: true }), true);
  assert.equal(MIN_SCAN_INTERVAL_MS, HOUR);
});

test('only one worker holds the attempt at a time, and a dead lease expires', () => {
  const empty = { attemptedScanAt: null, attempt: null };
  const first = claimScanAttempt(empty, { now: NOW, workerId: 'w1' });
  assert.equal(first.claimed, true);
  assert.equal(first.state.attempt.workerId, 'w1');
  assert.equal(first.state.attemptedScanAt, NOW, 'the ATTEMPT is recorded separately from the acknowledged floor');
  assert.equal(first.state.acknowledgedScanAt, null);

  assert.equal(claimScanAttempt(first.state, { now: NOW + 1000, workerId: 'w2' }).claimed, false);
  const later = claimScanAttempt(first.state, { now: NOW + 3 * HOUR, workerId: 'w2' });
  assert.equal(later.claimed, true, 'a worker that died must not hold the gate forever');

  const released = releaseScanAttempt(later.state);
  assert.equal(released.attempt, null);
  assert.equal(released.acknowledgedScanAt, null, 'releasing an attempt is not an acknowledgement');
});

// ── acknowledgement-only floor + lookback ─────────────────────────────────────────────────────

test('only an acknowledgement advances the scan floor', () => {
  let state = claimScanAttempt({ attemptedScanAt: null, attempt: null }, { now: NOW, workerId: 'w1' }).state;
  state = applyAcknowledgement(state, { acknowledged: false }, { now: NOW });
  assert.equal(state.acknowledgedScanAt, null, 'an attempted scan is not a delivered scan');

  state = applyAcknowledgement(state, { acknowledged: true, scannedAt: NOW }, { now: NOW });
  assert.equal(state.acknowledgedScanAt, NOW);

  // A late acknowledgement for an older scan must never rewind the floor.
  state = applyAcknowledgement(state, { acknowledged: true, scannedAt: NOW - DAY }, { now: NOW + 1000 });
  assert.equal(state.acknowledgedScanAt, NOW);
});

test('the selection overlaps the floor so a late-updated old conversation is not skipped', () => {
  const state = { acknowledgedScanAt: NOW };
  const entries = [
    entry('old-and-quiet', {}, NOW - 30 * DAY),
    entry('old-but-just-updated', {}, NOW - LOOKBACK_MS + HOUR),
    entry('new', {}, NOW + HOUR),
  ];
  const picked = selectConversations(entries, state, { now: NOW + 2 * HOUR }).map((e) => e.conversationId);
  assert.deepEqual(picked, ['old-but-just-updated', 'new']);
  assert.ok(LOOKBACK_MS >= DAY);
});

test('with no acknowledged floor every conversation is in scope', () => {
  const entries = [entry('a', {}, NOW - 400 * DAY), entry('b', {}, NOW)];
  assert.equal(selectConversations(entries, { acknowledgedScanAt: null }, { now: NOW }).length, 2);
});

test('an entry with no usable updatedAt is scanned rather than skipped', () => {
  const entries = [entry('a', {}, null), entry('b', {}, 'nonsense')];
  assert.equal(selectConversations(entries, { acknowledgedScanAt: NOW }, { now: NOW }).length, 2);
});

// ── the sender: gated off, and no route invented ──────────────────────────────────────────────

test('no cumulative-cost route is invented by this client', () => {
  // Integration fills this in from deployed backend evidence. An invented URL plus a mocked 200
  // cannot close BILL-01, so the constant ships null and the sender refuses.
  assert.equal(COST_RECONCILE_ENDPOINT, null);
});

test('the sender is disabled by default', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  const res = await sendUsageSnapshot(snap, fakeAuth(), {});
  assert.equal(res.ok, false);
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'disabled');
});

test('an enabled sender with no configured endpoint still refuses', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  const res = await sendUsageSnapshot(snap, fakeAuth(), { enabled: true, postJson: () => { throw new Error('must not post'); } });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'endpoint-unconfigured');
});

function fakeAuth(overrides) {
  const state = { epoch: 'prod|t1|u1|3', token: 'tok', ...(overrides == null ? {} : overrides) };
  return {
    getToken: async () => state.token,
    authEpoch: async () => state.epoch,
    _set: (next) => Object.assign(state, next),
  };
}

// `endpoint` is INJECTED here and is a test-only placeholder. Nothing in this file asserts that any
// particular server path exists.
const FAKE_ENDPOINT = '/test-only-not-a-real-route';

test('an unreadable snapshot is never sent', async () => {
  const snap = buildUsageSnapshot(null, { account: SCOPE, env: '', now: NOW });
  const res = await sendUsageSnapshot(snap, fakeAuth(), {
    enabled: true, endpoint: FAKE_ENDPOINT, postJson: () => { throw new Error('must not post'); },
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'unreadable');
});

test('the send is fenced by the auth epoch on both sides', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  const auth = fakeAuth();
  const posts = [];
  const deps = {
    enabled: true,
    endpoint: FAKE_ENDPOINT,
    postJson: async (endpoint, body) => { posts.push({ endpoint, body }); auth._set({ epoch: 'prod|t2|u2|1' }); return { ok: true, status: 200, body: { acknowledged: true } }; },
  };
  const res = await sendUsageSnapshot(snap, auth, deps);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, FAKE_ENDPOINT);
  // The account changed while the request was in flight: the answer belongs to a machine state we
  // no longer have, so it must not be applied.
  assert.equal(res.acknowledged, false);
  assert.equal(res.reason, 'epoch-changed');
});

test('an account change before the send defers instead of posting the old account payload', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  const auth = fakeAuth();
  const res = await sendUsageSnapshot(snap, auth, {
    enabled: true,
    endpoint: FAKE_ENDPOINT,
    fenceAtBuild: 'prod|t9|u9|1',
    postJson: () => { throw new Error('must not post'); },
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'epoch-changed');
});

test('a successful acknowledgement is reported so the caller can advance the floor', async () => {
  const snap = buildUsageSnapshot([entry('a', { m: { amount: 1, costInCents: 5 } }, NOW)], { account: SCOPE, env: '', now: NOW });
  const res = await sendUsageSnapshot(snap, fakeAuth(), {
    enabled: true,
    endpoint: FAKE_ENDPOINT,
    postJson: async () => ({ ok: true, status: 200, body: { acknowledged: true } }),
  });
  assert.equal(res.sent, true);
  assert.equal(res.acknowledged, true);
});

test('a server failure is not an acknowledgement', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  for (const outcome of [
    { ok: false, status: 500, body: null },
    { ok: false, status: 403, body: null },
    { ok: true, status: 200, body: { acknowledged: false } },
    { ok: true, status: 200, body: null },
  ]) {
    const res = await sendUsageSnapshot(snap, fakeAuth(), {
      enabled: true, endpoint: FAKE_ENDPOINT, postJson: async () => outcome,
    });
    assert.equal(res.acknowledged, false, `status ${outcome.status} must not advance the floor`);
  }
});

test('a transport failure is reported, not thrown', async () => {
  const snap = buildUsageSnapshot([entry('a', {}, NOW)], { account: SCOPE, env: '', now: NOW });
  const res = await sendUsageSnapshot(snap, fakeAuth(), {
    enabled: true, endpoint: FAKE_ENDPOINT, postJson: async () => { throw new Error('offline'); },
  });
  assert.equal(res.sent, false);
  assert.equal(res.acknowledged, false);
  assert.equal(res.reason, 'transport');
});

// ── the recovery sequence as a whole ──────────────────────────────────────────────────────────

test('a lost delivery is retried on the next scan, and only then does the floor move', async () => {
  let state = { version: 1, attemptedScanAt: null, acknowledgedScanAt: null, attempt: null };
  const entries = [entry('conv-1', { m: { amount: 2, costInCents: 200 } }, NOW)];

  // Scan 1: the server never answers.
  state = claimScanAttempt(state, { now: NOW, workerId: 'w1' }).state;
  const snap1 = buildUsageSnapshot(entries, { account: SCOPE, env: '', now: NOW });
  const lost = await sendUsageSnapshot(snap1, fakeAuth(), {
    enabled: true, endpoint: FAKE_ENDPOINT, postJson: async () => { throw new Error('offline'); },
  });
  state = releaseScanAttempt(applyAcknowledgement(state, lost, { now: NOW }));
  assert.equal(state.acknowledgedScanAt, null);
  assert.equal(state.attemptedScanAt, NOW);

  // Scan 2, an hour later: the same conversation is still in scope precisely because the floor
  // never moved.
  assert.equal(isScanDue(state, NOW + HOUR), true);
  assert.equal(selectConversations(entries, state, { now: NOW + HOUR }).length, 1);
  state = claimScanAttempt(state, { now: NOW + HOUR, workerId: 'w1' }).state;
  const ok = await sendUsageSnapshot(buildUsageSnapshot(entries, { account: SCOPE, env: '', now: NOW + HOUR }), fakeAuth(), {
    enabled: true, endpoint: FAKE_ENDPOINT, postJson: async () => ({ ok: true, status: 200, body: { acknowledged: true } }),
  });
  state = releaseScanAttempt(applyAcknowledgement(state, ok, { now: NOW + HOUR }));
  assert.equal(state.acknowledgedScanAt, NOW + HOUR);
});
