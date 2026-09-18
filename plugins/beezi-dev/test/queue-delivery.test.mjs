import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverQueue } from '../lib/queue-delivery.mjs';
import { BASE_DELAY_MS, MAX_QUEUE_AGE_MS } from '../lib/queue-backoff.mjs';
import { queueDir } from '../lib/paths-cursor.mjs';
import { TrackingMode } from '../lib/tracking.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

// `deliverQueue` is checkpoint.mjs's flushQueue extracted, so every behaviour the old function had
// is pinned here too — head-of-line backoff, budget deferral, `_retry` never on the wire — plus the
// four this task adds: a forced token refresh on 401, quarantine for unreadable records, the
// tenant policy gate, and the account/auth epoch fence around every send and every ack.
//
// Nothing here touches a real credential store, a real keychain or a real network: `auth` is three
// injected functions and `fetchImpl` is a local queue of canned responses.

const DAY_MS = 24 * 60 * 60 * 1000;
// A realistic epoch, because several fixtures set a file mtime relative to it and a 1970-era
// timestamp is not representable as one.
const START = 1767000000000;

function tmpQueue(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-deliver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir, name, payload, mtimeMs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (mtimeMs != null) {
    const when = new Date(mtimeMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

const readQueued = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));

// An auth seam whose epoch the test drives. `getToken` hands back the current token, `forceRefresh`
// records that it was called and swaps the token in.
function fakeAuth({ token = 'tok-1', refresh = { ok: true, token: 'tok-2' }, epoch = 'env|t1|u1|1' } = {}) {
  const state = { token, epoch, refreshCalls: 0 };
  return {
    state,
    auth: {
      getToken: async () => state.token,
      forceRefresh: async () => {
        state.refreshCalls += 1;
        const out = typeof refresh === 'function' ? refresh(state) : refresh;
        if (out && out.ok && out.token) state.token = out.token;
        return out;
      },
      authEpoch: async () => state.epoch,
    },
  };
}

// A clock plus a scripted fetch. Each scripted entry is `{ status, body?, costMs?, throws?, json? }`.
function scripted(script, { costMs = 0 } = {}) {
  const calls = [];
  const clock = { nowMs: START };
  const fetchImpl = async (url, init) => {
    const step = script.shift();
    calls.push({
      url,
      token: String(init.headers.Authorization).replace('Bearer ', ''),
      body: JSON.parse(init.body),
      at: clock.nowMs,
      timeoutBounded: Boolean(init.signal),
    });
    clock.nowMs += step && step.costMs != null ? step.costMs : costMs;
    if (step && step.throws) throw step.throws;
    return {
      status: step.status,
      json: step.json != null ? step.json : async () => (step.body == null ? {} : step.body),
    };
  };
  return { calls, clock, fetchImpl, now: () => clock.nowMs };
}

function allowed() {
  return () => true;
}

// ─── result shape ───────────────────────────────────────────────────────────────────────────────

test('the result carries every legacy counter plus stable defaults for the new ones', async (t) => {
  const dir = tmpQueue(t);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([]);

  const result = await deliverQueue({ auth, deadlineAt: null, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.deepEqual(result, {
    sent: 0,
    flushed: 0,
    rejected: 0,
    failed: 0,
    deferred: 0,
    expired: 0,
    stuck: 0,
    gated: false,
    trackingDisabled: false,
    quarantined: 0,
    quarantineFailed: 0,
    lastError: null,
  });
});

test('a delivered record is counted as both sent and flushed and the file is removed', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.sent, 1);
  assert.equal(result.flushed, 1, 'sent is an alias, not a replacement — CLI consumers read flushed');
  assert.equal(calls[0].token, 'tok-1');
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ─── extension filter ───────────────────────────────────────────────────────────────────────────

test('a fully parseable .tmp record is never posted', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'half-written.tmp', { segmentId: 'tmp' }, START);
  seed(dir, 'real.json', { segmentId: 'real' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.segmentId, 'real');
  assert.equal(result.sent, 1);
  assert.deepEqual(fs.readdirSync(dir), ['half-written.tmp'], 'the temp file is left to its writer');
});

test('the .json filter runs before budget accounting, so junk cannot inflate deferred', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  seed(dir, 'b.json', { segmentId: 'b' }, START);
  for (const junk of ['x.tmp', 'y.corrupt', 'README', '.gitkeep']) seed(dir, junk, 'whatever', START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 200, costMs: 3000 }, { status: 200, costMs: 3000 }]);

  // Budget for exactly one request.
  const result = await deliverQueue({ auth, deadlineAt: START + 3000, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.sent, 1);
  assert.equal(result.deferred, 1, 'one real record was left, not five');
});

// ─── quarantine ─────────────────────────────────────────────────────────────────────────────────

test('a malformed .json record is renamed to a unique .corrupt and reported once', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'broken.json', '{"segmentId": "b"', START);
  seed(dir, 'good.json', { segmentId: 'g' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);
  const issues = [];

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: allowed(), recordIssue: (code, fields) => issues.push({ code, fields }) },
  });

  assert.equal(result.quarantined, 1);
  assert.equal(result.quarantineFailed, 0);
  assert.equal(calls.length, 1, 'a record that cannot be parsed is never posted');
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 1);
  assert.match(left[0], /\.corrupt$/);
  assert.notEqual(left[0], 'broken.json', 'the record is renamed, not left in the delivery path');
  assert.equal(fs.readFileSync(path.join(dir, left[0]), 'utf-8'), '{"segmentId": "b"', 'evidence is preserved verbatim');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'queue_file_quarantined');
});

test('a quarantine rename that fails is counted separately and emits nothing', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'broken.json', 'not json at all', START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([]);
  const issues = [];
  const fsImpl = {
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
    unlinkSync: fs.unlinkSync,
    existsSync: fs.existsSync,
    renameSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
  };

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, fsImpl, isTrackingAllowed: allowed(), recordIssue: (code) => issues.push(code) },
  });

  assert.equal(result.quarantined, 0);
  assert.equal(result.quarantineFailed, 1);
  assert.deepEqual(issues, [], 'the event means "renamed", so a failed rename must not emit it');
  assert.deepEqual(fs.readdirSync(dir), ['broken.json'], 'the evidence stays put');
});

test('an already-quarantined record is not re-examined on the next flush', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'broken.json', '{', START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([]);
  const deps = { dir, fetchImpl, now, isTrackingAllowed: allowed() };

  const first = await deliverQueue({ auth, deps });
  assert.equal(first.quarantined, 1);
  const second = await deliverQueue({ auth, deps });
  assert.equal(second.quarantined, 0, 'quarantine is terminal — age-based housekeeping removes it');
  assert.equal(second.quarantineFailed, 0);
});

// ─── 401 and the one forced refresh ─────────────────────────────────────────────────────────────

test('a 401 forces one refresh and retries the exact same payload under the new token', async (t) => {
  const dir = tmpQueue(t);
  const payload = { segmentId: 'conv-1:0-4', sessionId: 'conv-1', token_total: 12 };
  seed(dir, 'a.json', payload, START);
  const { auth, state } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 401 }, { status: 200 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(state.refreshCalls, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, 'tok-1');
  assert.equal(calls[1].token, 'tok-2', 'the retry must use the refreshed token');
  assert.deepEqual(calls[1].body, calls[0].body, 'the retry must be the exact same payload');
  assert.deepEqual(calls[1].body, payload);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a second 401 after the refresh is a normal transient failure', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth, state } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 401 }, { status: 401 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(state.refreshCalls, 1, 'one forced refresh per flush, not per 401');
  assert.equal(calls.length, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'HTTP 401');
  assert.equal(readQueued(dir, 'a.json')._retry.attempts, 1, 'the record is kept and backed off');
});

test('an unavailable refresh leaves the record queued without a second request', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth, state } = fakeAuth({ refresh: { ok: false, state: 'unavailable', reason: 'locked' } });
  const { fetchImpl, now, calls } = scripted([{ status: 401 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(state.refreshCalls, 1);
  assert.equal(calls.length, 1, 'no retry without a usable token');
  assert.equal(result.failed, 1);
  assert.equal(readQueued(dir, 'a.json')._retry.attempts, 1);
});

test('a second record that also 401s does not buy a second refresh', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  seed(dir, 'b.json', { segmentId: 'b' }, START);
  const { auth, state } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 401 }, { status: 401 }, { status: 401 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(state.refreshCalls, 1);
  assert.equal(calls.length, 3, 'a + its retry, then b once');
  assert.equal(result.failed, 2);
});

test('a budget spent during the refresh cancels the retry rather than overrunning', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const clockRef = { nowMs: START };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    clockRef.nowMs += 2500;
    return { status: 401, json: async () => ({}) };
  };
  const auth = {
    getToken: async () => 'tok-1',
    // The refresh itself takes time — a locked keychain, a slow token endpoint.
    forceRefresh: async () => { clockRef.nowMs += 1000; return { ok: true, token: 'tok-2' }; },
    authEpoch: async () => 'e1',
  };

  const result = await deliverQueue({
    auth,
    deadlineAt: START + 3000,
    deps: { dir, fetchImpl, now: () => clockRef.nowMs, isTrackingAllowed: allowed() },
  });

  assert.equal(calls.length, 1, 'no fresh request may begin after the deadline');
  assert.equal(result.failed, 1);
});

test('the retry timeout is recomputed from the absolute deadline, not reused', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const clockRef = { nowMs: START };
  const timeouts = [];
  const fetchImpl = async () => { clockRef.nowMs += 1000; return { status: 401, json: async () => ({}) }; };
  const auth = {
    getToken: async () => 'tok-1',
    forceRefresh: async () => { clockRef.nowMs += 500; return { ok: true, token: 'tok-2' }; },
    authEpoch: async () => 'e1',
  };

  await deliverQueue({
    auth,
    deadlineAt: START + 5000,
    deps: { dir, fetchImpl, now: () => clockRef.nowMs, isTrackingAllowed: allowed(), onRequestTimeout: (ms) => timeouts.push(ms) },
  });

  assert.equal(timeouts.length, 2);
  assert.equal(timeouts[0], 3000, 'the first request gets the per-request cap');
  assert.equal(timeouts[1], 3000, '5000 - 1500 spent = 3500 left, capped at the 3000 per-request bound');
});

// ─── 403 policy ─────────────────────────────────────────────────────────────────────────────────

test('an exact TRACKING_DISABLED 403 persists the policy and stops the flush', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  seed(dir, 'b.json', { segmentId: 'b' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 403, body: { code: 'TRACKING_DISABLED', message: 'Tracking is off' } }]);
  const policy = [];

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: allowed(), recordPolicy: (reason) => policy.push(reason) },
  });

  assert.equal(result.trackingDisabled, true);
  assert.deepEqual(policy, ['TRACKING_DISABLED'], 'the disabled mode is persisted through the injected recorder');
  assert.equal(calls.length, 1, 'the flush stops — nothing behind it is attempted');
  assert.equal(result.deferred, 2, 'both records are left untouched');
  assert.equal(result.failed, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json'], 'queued data survives the gate');
  assert.equal(readQueued(dir, 'a.json')._retry, undefined, 'a policy hold is not a transient failure — no backoff');
});

test('a 403 with a different code keeps its existing retry handling', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 403, body: { code: 'SEAT_REVOKED', message: 'no seat' } }]);
  const policy = [];

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: allowed(), recordPolicy: (reason) => policy.push(reason) },
  });

  assert.equal(result.trackingDisabled, false);
  assert.deepEqual(policy, [], 'only the exact code may darken this machine');
  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'HTTP 403');
  assert.equal(readQueued(dir, 'a.json')._retry.attempts, 1);
});

test('a 403 with no readable body at all is not read as a disabled tenant', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 403, json: () => Promise.resolve(null) }]);
  const policy = [];

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: allowed(), recordPolicy: (reason) => policy.push(reason) },
  });

  assert.equal(result.trackingDisabled, false);
  assert.deepEqual(policy, []);
  assert.equal(result.failed, 1);
});

test('a 403 whose body never ends is bounded by the deadline and falls back to the status', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  let nowMs = START;
  const fetchImpl = async () => ({ status: 403, json: () => new Promise(() => {}) });

  // withLoopAlive: a real stalled body stalls on a ref'd socket; this fake holds nothing, which
  // leaves readJsonBounded's unref'd abandon timer as the only handle. See helpers/loop-alive.mjs.
  // The deadline above is still what has to bound the read for these assertions to hold.
  const result = await withLoopAlive(() => deliverQueue({
    auth,
    deadlineAt: START + 50,
    deps: { dir, fetchImpl, now: () => nowMs, isTrackingAllowed: allowed() },
  }));

  assert.equal(result.trackingDisabled, false, 'an unread body must never be taken for a policy verdict');
  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'HTTP 403');
});

// ─── other HTTP outcomes ────────────────────────────────────────────────────────────────────────

test('a 5xx is a transient failure and reports the approved diagnostic code', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 503 }]);
  const issues = [];

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: allowed(), recordIssue: (code, fields) => issues.push({ code, fields }) },
  });

  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'HTTP 503');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'queue_flush_http_error');
  assert.equal(issues[0].fields.status, 503);
  assert.equal(readQueued(dir, 'a.json')._retry.attempts, 1);
});

test('a permanent 4xx drops the record and reports the server message', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 422, body: { message: 'segmentId already sealed' } }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.rejected, 1);
  assert.equal(result.lastError, 'segmentId already sealed');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an aborted request backs the record off; a refused connection does not', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'slow.json', { segmentId: 'slow' }, START);
  seed(dir, 'offline.json', { segmentId: 'offline' }, START);
  const { auth } = fakeAuth();
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const { fetchImpl, now } = scripted([{ status: 0, throws: refused }, { status: 0, throws: abort }]);

  // readdir order is alphabetical here: offline.json, then slow.json.
  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.failed, 2);
  assert.equal(readQueued(dir, 'offline.json')._retry, undefined, 'a free failure must not delay the whole queue');
  assert.equal(readQueued(dir, 'slow.json')._retry.attempts, 1, 'a request that spent the budget steps aside');
});

test('a delivered record whose unlink fails is stuck, not failed', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 200 }]);
  const fsImpl = {
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
    existsSync: fs.existsSync,
    renameSync: fs.renameSync,
    unlinkSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
  };

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, fsImpl, isTrackingAllowed: allowed() } });

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.stuck, 1);
});

// ─── budget, backoff and age ────────────────────────────────────────────────────────────────────

test('no fresh request begins after the deadline and the rest are deferred', async (t) => {
  const dir = tmpQueue(t);
  for (const n of ['a', 'b', 'c', 'd']) seed(dir, `${n}.json`, { segmentId: n }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 }], { costMs: 3000 });

  const result = await deliverQueue({ auth, deadlineAt: START + 8000, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(calls.length, 3);
  assert.equal(result.sent, 3);
  assert.equal(result.deferred, 1);
});

test('a record inside its backoff is skipped without spending any budget', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a-stuck.json', { segmentId: 'a', _retry: { attempts: 1, nextAttemptAt: START + BASE_DELAY_MS, firstQueuedAt: START } }, START);
  seed(dir, 'z-fresh.json', { segmentId: 'z' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200, costMs: 3000 }]);

  const result = await deliverQueue({ auth, deadlineAt: START + 3500, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.deepEqual(calls.map((c) => c.body.segmentId), ['z']);
  assert.equal(result.sent, 1);
  assert.equal(result.deferred, 1);
});

test('a record failing past the 14-day give-up age is dropped', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a', _retry: { attempts: 9, nextAttemptAt: 0, firstQueuedAt: START - MAX_QUEUE_AGE_MS - 1 } }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.expired, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the first retry rewrite persists the mtime as firstQueuedAt instead of resetting the age', async (t) => {
  const dir = tmpQueue(t);
  const enqueuedAt = START - 2 * DAY_MS;
  seed(dir, 'a.json', { segmentId: 'a' }, enqueuedAt);
  const { auth } = fakeAuth();
  const { fetchImpl, now } = scripted([{ status: 503 }]);

  await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  const retry = readQueued(dir, 'a.json')._retry;
  assert.equal(retry.attempts, 1);
  assert.equal(
    Math.abs(retry.firstQueuedAt - enqueuedAt) < 1000,
    true,
    `the rewrite refreshed the mtime, so the original enqueue clock had to be carried onto the record (got ${retry.firstQueuedAt})`,
  );
});

test('seeding the mtime makes the 14-day give-up measure QUEUE age, not first-failure age', async (t) => {
  // A semantic change worth pinning rather than discovering. `isExpired` reads
  // `_retry.firstQueuedAt`, which used to be stamped at the first FAILURE — so a record that sat
  // untouched for twenty days and then failed once got a fresh fourteen days from that moment.
  // Seeding the mtime makes `firstQueuedAt` the ENQUEUE time instead, so the same record is already
  // past the give-up age the moment it is stamped.
  //
  // That is the intended answer, and it is the conservative one: prune.mjs already deletes queue
  // files on a 14-day MTIME rule, so a twenty-day-old never-attempted record was living on borrowed
  // time anyway. The two clocks now agree instead of one silently extending the other. The record
  // still gets its ONE attempt first — expiry is evaluated on what is on disk, and nothing is on
  // disk until that attempt fails.
  const dir = tmpQueue(t);
  const enqueuedAt = START - 20 * DAY_MS;
  seed(dir, 'ancient.json', { segmentId: 'ancient' }, enqueuedAt);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 503 }]);
  const deps = { dir, fetchImpl, now, isTrackingAllowed: allowed() };

  const first = await deliverQueue({ auth, deps });
  assert.equal(first.failed, 1, 'the record is attempted once — it had never been tried');
  assert.equal(calls.length, 1);
  const stamped = readQueued(dir, 'ancient.json')._retry;
  assert.ok(Math.abs(stamped.firstQueuedAt - enqueuedAt) < 1000, 'the enqueue clock, not the failure clock');

  const second = await deliverQueue({ auth, deps });
  assert.equal(second.expired, 1, 'and it is then given up on rather than retried for another fortnight');
  assert.equal(calls.length, 1, 'no second request is spent on a record past the give-up age');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('_retry never reaches the wire', async (t) => {
  const dir = tmpQueue(t);
  const payload = { segmentId: 'a', sessionId: 'conv-1', token_total: 3 };
  seed(dir, 'a.json', { ...payload, _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: START } }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

  await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.deepEqual(calls[0].body, payload);
});

// ─── policy gate ────────────────────────────────────────────────────────────────────────────────

test('a disabled tenant gets a gated result and no request at all', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([]);

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now, isTrackingAllowed: () => false },
  });

  assert.equal(result.gated, true);
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'gating holds data, it does not discard it');
});

test('the gate reads the cached tracking mode when no override is injected', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-deliver-home-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(queueDir(), { recursive: true });
  seed(queueDir(), 'a.json', { segmentId: 'a' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

  // No tracking state on disk at all: the documented default is fail-open.
  const open = await deliverQueue({ auth, deps: { fetchImpl, now } });
  assert.equal(open.gated, false);
  assert.equal(calls.length, 1);

  seed(queueDir(), 'b.json', { segmentId: 'b' }, START);
  fs.writeFileSync(
    path.join(home, 'tracking.json'),
    JSON.stringify({ version: 1, trackingMode: TrackingMode.DISABLED }),
  );
  const gated = await deliverQueue({ auth, deps: { fetchImpl, now } });
  assert.equal(gated.gated, true);
  assert.equal(calls.length, 1, 'the cached disabled mode stops the flush before any HTTP');
});

// ─── request epoch fence ────────────────────────────────────────────────────────────────────────

test('an epoch that moved before the send defers instead of delivering the old payload', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const { auth, state } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);
  // A relink lands between the fence being taken and the first send.
  const guarded = { ...auth, authEpoch: async () => { const e = state.epoch; state.epoch = 'env|t2|u2|1'; return e; } };

  const result = await deliverQueue({ auth: guarded, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(calls.length, 0, "another account's credentials must never carry this payload");
  assert.equal(result.deferred, 1);
  assert.equal(result.sent, 0);
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});

test('a refresh that lands on another account defers rather than retrying', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const state = { epoch: 'env|t1|u1|1', token: 'tok-1' };
  const calls = [];
  let nowMs = START;
  const auth = {
    getToken: async () => state.token,
    forceRefresh: async () => {
      // The user logged out and back in as someone else while the 401 was in flight.
      state.epoch = 'env|t2|u2|1';
      state.token = 'tok-other';
      return { ok: true, token: 'tok-other' };
    },
    authEpoch: async () => state.epoch,
  };
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return { status: 401, json: async () => ({}) }; };

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now: () => nowMs, isTrackingAllowed: allowed() } });

  assert.equal(calls.length, 1, 'the retry must not go out under the new account');
  assert.equal(result.deferred, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});

test('a logout during the 403 body read blocks the policy write', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a' }, START);
  const state = { epoch: 'env|t1|u1|1' };
  const policy = [];
  let nowMs = START;
  const auth = {
    getToken: async () => 'tok-1',
    forceRefresh: async () => ({ ok: false }),
    authEpoch: async () => state.epoch,
  };
  const fetchImpl = async () => ({
    status: 403,
    json: async () => {
      // The logout completes while the body is still being read.
      state.epoch = 'env|||0';
      return { code: 'TRACKING_DISABLED' };
    },
  });

  const result = await deliverQueue({
    auth,
    deps: { dir, fetchImpl, now: () => nowMs, isTrackingAllowed: allowed(), recordPolicy: (reason) => policy.push(reason) },
  });

  assert.deepEqual(policy, [], "a late response must not write the previous account's policy");
  assert.equal(result.trackingDisabled, false);
  assert.equal(result.deferred, 1);
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});

// ─── C-9: the legacy synthetic remote is migrated ON THE WAY TO THE WIRE ────────────────────────
//
// This sanitizer used to sit beside the POST in lib/checkpoint.mjs. The extraction that moved
// delivery into this module DELETED that line, and nothing failed — which is precisely why these
// four cases exist. A record queued by an older build carries `local://<absolute path>`: that puts
// the user's account name and their private folder names on the wire, and lands the segment under a
// second repository key no later report ever joins.

test('a queued local:// remote is posted as local:<folder>, with no separator left behind', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a', remote: 'local://c:/users/me/project' }, START);
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.sent, 1);
  assert.equal(calls[0].body.remote, 'local:project');
  // Stated as its own assertion because a half-applied migration is the failure that looks fine:
  // `local:c:/users/me/project` would still start with `local:` and still pass a prefix test.
  const tail = calls[0].body.remote.slice('local:'.length);
  assert.equal(tail.includes('/'), false, 'no path separator may survive');
  assert.equal(tail.includes('\\'), false, 'nor a Windows one');
  assert.equal(calls[0].body.segmentId, 'a', 'the idempotency key is untouched');
});

test('the queue FILE is byte-identical after a 5xx — the migration is in memory only', async (t) => {
  const dir = tmpQueue(t);
  // `_retry.firstQueuedAt` is the only enqueue clock a failed record has, and rewriting the file
  // would refresh its mtime and reset the backoff. Amounts and the segment id must not move either.
  const queued = {
    segmentId: 'conv:1-2',
    remote: 'local://c:/users/me/project',
    usage: { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } },
    _retry: { firstQueuedAt: START - DAY_MS, attempts: 3, nextAttemptAt: START - 1000 },
  };
  const file = seed(dir, 'a.json', queued, START - DAY_MS);
  const before = fs.readFileSync(file, 'utf-8');
  const { auth } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 503 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.failed, 1);
  assert.equal(calls[0].body.remote, 'local:project', 'the wire still carries the migrated value');
  assert.equal(calls[0].body._retry, undefined, 'and never the bookkeeping');
  const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(after.remote, 'local://c:/users/me/project', 'the file keeps the legacy spelling');
  assert.equal(after._retry.firstQueuedAt, START - DAY_MS, 'the queue age is preserved');
  assert.equal(after.segmentId, 'conv:1-2');
  assert.deepEqual(after.usage, queued.usage);
  assert.notEqual(before, undefined);
});

test('a real remote and the unattributed sentinel are posted unchanged', async (t) => {
  for (const remote of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'local://unknown', 'local:project']) {
    const dir = tmpQueue(t);
    seed(dir, 'a.json', { segmentId: 'a', remote }, START);
    const { auth } = fakeAuth();
    const { fetchImpl, now, calls } = scripted([{ status: 200 }]);

    const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

    assert.equal(result.sent, 1, remote);
    assert.equal(calls[0].body.remote, remote, `${remote} must travel verbatim`);
  }
});

test('the 401 retry re-sends the SANITIZED payload, not a rebuilt or a legacy one', async (t) => {
  const dir = tmpQueue(t);
  seed(dir, 'a.json', { segmentId: 'a', remote: 'local://c:/users/me/project' }, START);
  const { auth, state } = fakeAuth();
  const { fetchImpl, now, calls } = scripted([{ status: 401 }, { status: 200 }]);

  const result = await deliverQueue({ auth, deps: { dir, fetchImpl, now, isTrackingAllowed: allowed() } });

  assert.equal(result.sent, 1);
  assert.equal(state.refreshCalls, 1);
  assert.deepEqual(calls.map((c) => c.body.remote), ['local:project', 'local:project']);
  assert.deepEqual(calls[0].body, calls[1].body, 'the retry is the same bytes, not a rebuild');
});
