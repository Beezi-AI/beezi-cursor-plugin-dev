import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushQueue, HOOK_BUDGET_MS } from '../lib/checkpoint.mjs';
import { HOOK_TIMEOUT_SEC } from '../lib/hooks-install.mjs';
import { HOOK_GUARD_MARGIN_MS } from '../lib/hook-runner.mjs';
import { queueDir } from '../lib/paths-cursor.mjs';
import { BASE_DELAY_MS } from '../lib/queue-backoff.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';
import http from 'node:http';
import { forceRefresh } from '../lib/token.mjs';

// Cursor kills a hook at its registered timeout and reports the kill as a failed hook. The queue
// flush is a serial loop with a per-request bound but no overall one, so N pending reports against
// a stalled API cost N × the per-request timeout: six queued reports measured 24.9s against a 10s
// budget. The reports that landed before the kill were tracked, which is why this surfaced as
// "hook exited with code 1" *and* working analytics.
function tmpHome(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-flush-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  fs.mkdirSync(queueDir(), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(path.join(queueDir(), `seg-${i}.json`), JSON.stringify({ segmentId: `s:${i}` }));
  }
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// A clock the test drives: every request "costs" the full per-request timeout, the way a stalled
// server does. No real waiting, so the assertion is about the budget, not about timing luck.
function stalledClock(costMs = 3000) {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    fetchImpl: async () => { nowMs += costMs; return { status: 200, json: async () => ({}) }; },
  };
}

test('the flush stops at its deadline and leaves the rest queued for next time', async (t) => {
  tmpHome(t, 6);
  const { now, fetchImpl } = stalledClock();

  const result = await flushQueue('tok', { fetchImpl, now, deadline: now() + 8000 });

  assert.equal(result.flushed, 3, 'three 3s requests fit in an 8s budget');
  assert.equal(result.deferred, 3, 'the rest are reported as deferred, not failed');
  assert.equal(fs.readdirSync(queueDir()).length, 3, 'deferred reports stay on disk for the retry');
});

test('a deferred report is not counted as failed or rejected', async (t) => {
  tmpHome(t, 4);
  const { now, fetchImpl } = stalledClock();
  const result = await flushQueue('tok', { fetchImpl, now, deadline: now() + 3500 });
  assert.equal(result.failed, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.flushed + result.deferred, 4);
});

test('without a deadline the flush drains the whole queue, as before', async (t) => {
  tmpHome(t, 5);
  const { fetchImpl } = stalledClock();
  const result = await flushQueue('tok', { fetchImpl });
  assert.equal(result.flushed, 5);
  assert.equal(result.deferred, 0);
  assert.equal(fs.readdirSync(queueDir()).length, 0);
});

test('no request is allowed to outlive the deadline it was started under', async (t) => {
  tmpHome(t, 3);
  let nowMs = 1_000_000;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.signal ? 'bounded' : 'unbounded');
    nowMs += 3000;
    return { status: 200, json: async () => ({}) };
  };
  // 4.5s of budget: the first request may take its full 3s, the second only has 1.5s left.
  const timeouts = [];
  await flushQueue('tok', {
    fetchImpl,
    now: () => nowMs,
    deadline: nowMs + 4500,
    onRequestTimeout: (ms) => timeouts.push(ms),
  });
  assert.deepEqual(seen, ['bounded', 'bounded']);
  assert.ok(timeouts[1] <= 1500, `second request was given ${timeouts[1]}ms of a 1500ms remainder`);
});

// ─── head-of-line starvation ────────────────────────────────────────────────────────────────────
//
// Every test above measures ONE flush. The failure below only exists across two, which is why it
// survived: `fs.readdirSync` order is lexicographic on NTFS and queue filenames start with the
// conversation id, so the same file is attempted first on every flush, deterministically, forever.
// Three permanently-failing head files consume the entire 7500ms budget every time and everything
// behind them is never attempted once — until prune.mjs deletes it at 14 days.
//
// readdirSync is sorted here rather than trusted, so the test pins NTFS's order on every platform
// (ext4 hands back hash order, which would make this pass or fail by luck).
function lexicographicReaddir(t) {
  const real = fs.readdirSync;
  fs.readdirSync = (...args) => {
    const out = real.apply(fs, args);
    return Array.isArray(out) ? [...out].sort() : out;
  };
  t.after(() => { fs.readdirSync = real; });
}

function seed(name, payload) {
  fs.writeFileSync(path.join(queueDir(), name), JSON.stringify(payload));
}

const readQueued = (name) => JSON.parse(fs.readFileSync(path.join(queueDir(), name), 'utf-8'));

test('a permanently-failing head file steps aside so the next flush reaches the rest', async (t) => {
  tmpHome(t, 0);
  lexicographicReaddir(t);
  seed('a-stuck.json', { segmentId: 'stuck' });
  seed('b-fresh.json', { segmentId: 'fresh' });

  let nowMs = 1_000_000;
  const sent = [];
  // The head file answers 500 and, like a real stalled request, costs the full per-request bound.
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.segmentId);
    nowMs += 3000;
    return { status: body.segmentId === 'stuck' ? 500 : 200, json: async () => ({}) };
  };
  const now = () => nowMs;

  // One request's worth of budget, which the head file takes in full.
  const first = await flushQueue('tok', { fetchImpl, now, deadline: nowMs + 3000 });
  assert.deepEqual(sent, ['stuck'], 'the head file goes first, as the filesystem orders it');
  assert.equal(first.failed, 1);
  assert.equal(first.deferred, 1, 'the newer file never got a turn');

  // A second hook, a second later — well inside the 30s backoff the failure just recorded.
  nowMs += 1000;
  const second = await flushQueue('tok', { fetchImpl, now, deadline: nowMs + 3000 });

  assert.deepEqual(sent, ['stuck', 'fresh'], 'the second flush must reach past the stuck file');
  assert.equal(second.flushed, 1);
  assert.equal(second.deferred, 1, 'the stuck file is deferred, not retried and not failed');
  assert.equal(second.failed, 0);
  assert.deepEqual(fs.readdirSync(queueDir()), ['a-stuck.json'], 'the delivered file is gone; the stuck one is kept');
});

test('a deferred file costs the budget nothing, so it cannot starve what is behind it', async (t) => {
  tmpHome(t, 0);
  lexicographicReaddir(t);
  let nowMs = 1_000_000;
  const notDue = { attempts: 1, nextAttemptAt: nowMs + BASE_DELAY_MS, firstQueuedAt: nowMs };
  for (const n of ['a', 'b', 'c']) seed(`${n}-stuck.json`, { segmentId: n, _retry: notDue });
  seed('z-fresh.json', { segmentId: 'z' });

  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body).segmentId);
    nowMs += 3000;
    return { status: 200, json: async () => ({}) };
  };

  // One request's worth of budget against three not-due files ahead of the one real segment. Before
  // the skip, all of it went to the head of the list and `z` was never attempted.
  const res = await flushQueue('tok', { fetchImpl, now: () => nowMs, deadline: nowMs + 3500 });
  assert.deepEqual(sent, ['z']);
  assert.equal(res.flushed, 1);
  assert.equal(res.deferred, 3, 'three skipped files, counted honestly');
});

test('_retry never reaches the wire — one unknown key 400s the whole report', async (t) => {
  tmpHome(t, 0);
  lexicographicReaddir(t);
  seed('conv-1_0-4.json', { segmentId: 'conv-1:0-4', sessionId: 'conv-1', token_total: 12 });

  let nowMs = 1_000_000;
  const bodies = [];
  const statuses = [503, 200];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { status: statuses.shift() ?? 200, json: async () => ({}) };
  };
  const now = () => nowMs;

  await flushQueue('tok', { fetchImpl, now });
  // The retry state is on disk...
  assert.equal(readQueued('conv-1_0-4.json')._retry.attempts, 1);

  // ...and stays there when the file is finally sent. The ingest route runs a global
  // ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }): ONE unknown top-level key
  // rejects the entire report, not the key. checkpoint.mjs already lost every report to exactly
  // this once (token_cache_read / token_cache_write), and the queue file was deleted as a permanent
  // rejection on the way out.
  nowMs += BASE_DELAY_MS;
  await flushQueue('tok', { fetchImpl, now });

  assert.equal(bodies.length, 2, 'the file should have been retried once the backoff elapsed');
  for (const body of bodies) {
    assert.equal('_retry' in body, false, `_retry went on the wire: ${JSON.stringify(body)}`);
  }
  assert.deepEqual(bodies[1], { segmentId: 'conv-1:0-4', sessionId: 'conv-1', token_total: 12 });
  assert.deepEqual(fs.readdirSync(queueDir()), []);
});

test('the body of a permanent rejection is read against what is left of the budget', async (t) => {
  tmpHome(t, 0);
  seed('conv-1_0-4.json', { segmentId: 'conv-1:0-4' });

  let nowMs = 1_000_000;
  // A server that answers headers and then never finishes the body. `bounded()` in lib/http.mjs
  // clears its abort timer when the HEADERS arrive, so a bare `await res.json()` here had no bound
  // at all — undici's 300s bodyTimeout was the only backstop, forty times the hook's whole budget.
  // withLoopAlive: a stalled body stalls on a socket, and a socket is a ref'd handle; this fake
  // holds nothing, which leaves readJsonBounded's unref'd abandon timer as the only handle in the
  // loop. See test/helpers/loop-alive.mjs — the 50ms budget below is still what bounds the read.
  const res = await withLoopAlive(() => flushQueue('tok', {
    now: () => nowMs,
    deadline: nowMs + 50,
    fetchImpl: async () => ({ status: 422, json: () => new Promise(() => {}) }),
  }));

  assert.equal(res.rejected, 1);
  assert.equal(res.lastError, 'HTTP 422', 'an unreadable body falls back to the status, it does not hang');
  assert.deepEqual(fs.readdirSync(queueDir()), []);
});

test('the hook budget leaves room inside the timeout Cursor registers', () => {
  assert.ok(
    HOOK_BUDGET_MS < HOOK_TIMEOUT_SEC * 1000,
    `budget ${HOOK_BUDGET_MS}ms must finish before Cursor kills the hook at ${HOOK_TIMEOUT_SEC}s`,
  );
  // Enough margin for the work that is not network: git shell-outs, transcript parsing, state writes.
  assert.ok(HOOK_TIMEOUT_SEC * 1000 - HOOK_BUDGET_MS >= 1500, 'too little margin before the kill');
  // And the margin is the runner's margin, by construction rather than by agreement: before C-1
  // this file subtracted a literal 2500 and changing HOOK_GUARD_MARGIN_MS moved the runner's
  // per-hook deadline while leaving the flush budget aimed at the old one, with nothing failing.
  assert.equal(HOOK_TIMEOUT_SEC * 1000 - HOOK_BUDGET_MS, HOOK_GUARD_MARGIN_MS);
});


// ─── the wrapper over deliverQueue (integration step 4: C-11) ───────────────────────────────────
//
// `flushQueue` is a compatibility boundary now (CONTRACTS §6): every test above drives it and
// therefore pins that the extraction preserved behaviour. These two pin the wiring itself.

test('flushQueue surfaces the new counters, and sent is an ALIAS of flushed', async (t) => {
  tmpHome(t, 2);
  const { now, fetchImpl } = stalledClock(0);

  const result = await flushQueue('tok', { fetchImpl, now, deadline: null });

  assert.equal(result.flushed, 2);
  assert.equal(result.sent, result.flushed, 'sent is an alias — a CLI reading flushed must not break');
  // The keys downstream reads, all present, so a consumer cannot get `undefined` for a counter.
  for (const key of ['sent', 'flushed', 'rejected', 'failed', 'deferred', 'expired', 'stuck', 'gated', 'trackingDisabled', 'quarantined', 'quarantineFailed', 'lastError']) {
    assert.ok(key in result, `${key} missing from the wrapper's result`);
  }
});

test('the wrapper wires the REAL epoch fence, so an account change mid-flush defers the rest', async (t) => {
  // THE POINT OF THIS TEST. The extraction shipped with inert fallbacks — `authEpoch: () => 'static'`
  // — which make `sameAccount()` always true and the fence structurally unable to fire. With the
  // real lib/token.mjs seam the fence is derived from (apiBase, tenant, user, control epoch), so a
  // login as someone else between two sends is seen, and the remaining files are DEFERRED rather
  // than delivered under the new account's credentials.
  //
  // Against the inert fallback this test fails: both files are sent.
  const home = tmpHome(t, 0);
  fs.mkdirSync(queueDir(), { recursive: true });
  // `a.json` before `b.json` — the delivery order is the directory order.
  for (const name of ['a.json', 'b.json']) {
    fs.writeFileSync(path.join(queueDir(), name), JSON.stringify({ segmentId: name }));
  }
  const writeAccount = (email) => fs.writeFileSync(
    path.join(home, 'tracking.json'),
    JSON.stringify({ version: 1, email, tenantTier: 'pro' }),
  );
  writeAccount('first@example.test');

  const posted = [];
  const result = await flushQueue('tok', {
    now: () => 1_000_000,
    deadline: null,
    postJsonImpl: async (url, token, body) => {
      posted.push(body.segmentId);
      // Someone signs in as a different account while this flush is mid-way through the queue.
      writeAccount('second@example.test');
      return { status: 200, json: async () => ({}) };
    },
  });

  assert.deepEqual(posted, ['a.json'], 'only the send that started under the original account');
  assert.equal(result.sent, 1);
  assert.equal(result.deferred, 1, 'the rest is held, not delivered under the new identity');
  assert.deepEqual(fs.readdirSync(queueDir()), ['b.json'], 'and it is still on disk for next time');
});

// ─── the auth seam the wrapper hands to deliverQueue is the REAL one ────────────────────────────

// `flushQueue`'s whole job is to be the compatibility boundary over `deliverQueue`, and two of
// deliverQueue's guarantees are only real if the seam it is handed is: a 401 renews ONCE per flush
// and retries the same payload, and the epoch fence defers rather than delivering one account's
// queued report under another's credentials. The extraction shipped with INERT fallbacks for both
// (`forceRefresh: async () => ({ ok: false })`), which is indistinguishable from the real thing in
// every test that injects `deps.auth` - the flush simply gives up on the 401 and the record stays
// queued, which looks like ordinary backoff.
//
// So this test refuses to inject `deps.auth` at all and observes the seam from the OUTSIDE: a real
// credential on disk whose token endpoint is a local server. If `flushQueue` wires the real
// `forceRefresh` from lib/token.mjs, a 401 on the report drives a refresh_token POST to that
// endpoint. An inert fallback never touches it, and this assertion is the only thing on the machine
// that can tell the two apart.
test('a 401 drives a REAL token refresh, not an inert fallback', async (t) => {
  const home = tmpHome(t, 0);

  const tokenHits = [];
  const issued = [];
  const tokenServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      tokenHits.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      // A fresh pair per exchange, recorded, so the second request can be shown to carry what the
      // FIRST one issued - i.e. that the renewal really went THROUGH the credential store rather
      // than past it with a token it was handed.
      const issuedRefresh = `rt-issued-${tokenHits.length}`;
      issued.push(issuedRefresh);
      res.end(JSON.stringify({ access_token: `tok-issued-${tokenHits.length}`, refresh_token: issuedRefresh, expires_in: 3600 }));
    });
  });
  await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tokenServer.close(resolve)));
  const tokenEndpoint = `http://127.0.0.1:${tokenServer.address().port}/oauth/token`;

  // The legacy on-disk shape, which the credential store still adopts into generation 1. Written
  // rather than injected on purpose: the point is that `forceRefresh` resolves its own credential.
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    token: JSON.stringify({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:49152/callback',
      token_endpoint: tokenEndpoint,
      access_token: 'tok-1',
      refresh_token: 'rt-1',
      expires_at: Date.now() + 3_600_000,
    }),
  }));
  // ONE rotation first, and it is a fixture detail worth naming rather than hiding. Adopting a
  // legacy credential records this machine's identity for the first time, which legitimately MOVES
  // the auth epoch — and `deliverQueue` is right to defer rather than deliver across a moved fence.
  // Every machine that has rotated a token even once is past that point, which is the state under
  // test here; the adoption case is the fence working, not the seam failing.
  await forceRefresh({}, {});
  assert.equal(tokenHits.length, 1, 'the warm-up rotation is the first hit');

  fs.writeFileSync(path.join(queueDir(), 'seg-0.json'), JSON.stringify({ segmentId: 's:0' }));

  // 401 once, then accept. The retry is deliverQueue's; what is under test is that the renewal in
  // between reached the real credential path.
  let reportCalls = 0;
  const fetchImpl = async () => {
    reportCalls += 1;
    if (reportCalls === 1) {
      return { status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return { status: 200, headers: { get: () => null }, json: async () => ({ status: 'stored' }) };
  };

  const result = await flushQueue('tok-1', { fetchImpl });

  assert.equal(
    tokenHits.length,
    2,
    'the real forceRefresh POSTed to the token endpoint the credential itself names',
  );
  assert.match(tokenHits[1].body, /grant_type=refresh_token/, 'and it was a refresh exchange');
  assert.ok(
    tokenHits[1].body.includes(`refresh_token=${issued[0]}`),
    'carrying the refresh token the warm-up rotation stored, so the renewal went THROUGH the store',
  );
  assert.equal(reportCalls, 2, 'the same payload was retried once after the renewal');
  assert.equal(result.flushed, 1, 'and it was delivered');
  assert.equal(fs.existsSync(path.join(queueDir(), 'seg-0.json')), false, 'so the record is gone');
});
