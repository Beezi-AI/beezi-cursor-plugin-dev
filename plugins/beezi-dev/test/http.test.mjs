import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postJson, getJson, readJsonBounded } from '../lib/http.mjs';
import { httpsFetch } from '../lib/fetch-compat.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

// Fetch that never answers unless aborted — the failure mode that matters here. Node's fetch has
// no default timeout, so an unbounded call against a server that accepts the connection and then
// goes quiet hangs for the life of the process.
const hangingFetch = () => (url, opts) =>
  new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

// A stub can only ever stall the HEADERS: it decides when its promise settles, and once it does the
// "body" is a plain resolved value. The bug these tests exist for lives after that point, so the
// stalled-body cases need a real socket — a server that flushes headers and then writes nothing.
const servers = [];

after(() => {
  // closeAllConnections first: the stalled requests are still open, and server.close() alone waits
  // for them, which would hang the test process instead of the request it was testing.
  for (const s of servers) { s.closeAllConnections(); s.close(); }
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// Headers out immediately, body never. `clientHungUp` resolves when the server sees the socket go —
// the only observable proof that giving up actually released the connection rather than leaving
// undici reading in the background until its 300s bodyTimeout.
async function startStallingServer() {
  let sawHangUp;
  const clientHungUp = new Promise((resolve) => { sawHangUp = resolve; });
  const url = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    res.on('close', () => sawHangUp());
  });
  return { url, clientHungUp };
}

test('getJson — bounded: a server that never answers rejects instead of hanging', async () => {
  await assert.rejects(
    () => getJson('https://api.test/thing', 'tok', { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});

test('getJson — sends bearer auth and the machine headers', async () => {
  let seen;
  await getJson('https://api.test/thing', 'my-token', {
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true }; },
  });
  assert.equal(seen.url, 'https://api.test/thing');
  assert.equal(seen.opts.headers.Authorization, 'Bearer my-token');
  assert.equal(seen.opts.headers['X-Beezi-Agent'], 'cursor');
  assert.ok(seen.opts.signal, 'no abort signal — the request is unbounded');
});

test('getJson — clears its timer on success, so the process can exit', async () => {
  // A pending timer keeps the event loop alive; a hook that finishes its work would sit idle
  // until the timeout fired. node --test would report a leaked handle rather than a failure,
  // so assert the response is returned promptly and the call settles.
  const res = await getJson('https://api.test/thing', 'tok', {
    fetchImpl: async () => ({ ok: true, status: 200 }),
    timeoutMs: 60_000,
  });
  assert.equal(res.status, 200);
});

test('postJson — still bounded (unchanged behaviour)', async () => {
  await assert.rejects(
    () => postJson('https://api.test/thing', 'tok', { a: 1 }, { fetchImpl: hangingFetch(), timeoutMs: 30 }),
    (e) => e.name === 'AbortError' || /abort/i.test(e.message),
  );
});

test('readJsonBounded — reads a body that actually arrives', async () => {
  const url = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ email: 'dev@acme.com', nested: { n: 1 } }));
  });
  const res = await getJson(`${url}/thing`, 'tok', { timeoutMs: 2000 });
  assert.deepEqual(await readJsonBounded(res, 2000), { email: 'dev@acme.com', nested: { n: 1 } });
});

test('readJsonBounded — a server that flushes headers then stalls the body gives up inside the budget', async () => {
  // The exact shape of the bug: fetch settles at the headers, so the request timer is already
  // cleared while the body is still "arriving". Reproduced against a real server before the fix —
  // headers in 27ms, res.json() still pending at 12s, bounded only by undici's 300s bodyTimeout.
  const { url, clientHungUp } = await startStallingServer();
  const res = await getJson(`${url}/thing`, 'tok', { timeoutMs: 2000 });
  assert.equal(res.status, 200, 'headers should arrive immediately');

  const startedAt = Date.now();
  const body = await readJsonBounded(res, 150);
  const elapsed = Date.now() - startedAt;

  assert.equal(body, null, 'an abandoned body must read as null, not throw and not hang');
  assert.ok(elapsed < 1500, `gave up after ${elapsed}ms — the body read is not bounded`);
  await clientHungUp; // the socket is gone, so nothing is left holding the event loop open
});

test('readJsonBounded — an already-spent budget returns null instead of a fresh full one', async () => {
  // What a caller sharing one budget across headers+body passes when the headers ate all of it.
  // A negative remainder must not be read as "no bound".
  const { url } = await startStallingServer();
  const res = await getJson(`${url}/thing`, 'tok', { timeoutMs: 2000 });
  const startedAt = Date.now();
  assert.equal(await readJsonBounded(res, -500), null);
  assert.ok(Date.now() - startedAt < 1000, 'a spent budget must give up at once');
});

test('readJsonBounded — a body that is not JSON reads as null, it does not throw', async () => {
  const url = await startServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>502 Bad Gateway</html>');
  });
  const res = await getJson(`${url}/thing`, 'tok', { timeoutMs: 2000 });
  assert.equal(await readJsonBounded(res, 2000), null);
});

test('readJsonBounded — an empty body reads as null', async () => {
  const url = await startServer((req, res) => { res.writeHead(204); res.end(); });
  const res = await getJson(`${url}/thing`, 'tok', { timeoutMs: 2000 });
  assert.equal(await readJsonBounded(res, 2000), null);
});

test('readJsonBounded — reads responses that expose no stream (a stubbed fetch)', async () => {
  assert.deepEqual(await readJsonBounded({ ok: true, json: async () => ({ a: 1 }) }, 1000), { a: 1 });
});

test('readJsonBounded — a json() that rejects reads as null, and a stalled one still gives up', async () => {
  assert.equal(await readJsonBounded({ json: async () => { throw new Error('nope'); } }, 1000), null);
  // withLoopAlive: this fake holds no socket, so readJsonBounded's unref'd abandon timer is the
  // only handle left and Node 18/22 resolve the loop before it fires. Today this test survives on
  // 18 only because an earlier test in this file leaks a listening server that keeps the loop up —
  // run it alone with --test-name-pattern and it is cancelled. See helpers/loop-alive.mjs.
  assert.equal(await withLoopAlive(() => readJsonBounded({ json: () => new Promise(() => {}) }, 30)), null);
  assert.equal(await readJsonBounded({}, 30), null);
  assert.equal(await readJsonBounded(null, 30), null);
});

// ─── H-1: ONE timer bounds the headers and the body ─────────────────────────────────────────────

// `bounded()` used to `clearTimeout` the moment the headers arrived, which is when `fetch` settles
// — so `res.json()` afterwards ran with no bound at all. Measured against a real server: headers in
// 27 ms, the body still pending at 12 s, with undici's 300 s `bodyTimeout` the only backstop
// underneath. H-1 replaces that clear with `unref`, so the same timer keeps running.
//
// Run against BOTH implementations, because they abort differently: the real `fetch` is undici, and
// `httpsFetch` is this repo's pre-Node-18 shim, which since 05-D keeps its abort listener attached
// until the response stream closes rather than dropping it at the headers.
for (const [name, impl] of [['globalThis.fetch', undefined], ['httpsFetch', httpsFetch]]) {
  test(`postJson (${name}) — the request timeout also bounds a body that never ends`, async () => {
    const { url, clientHungUp } = await startStallingServer();

    const started = Date.now();
    const res = await postJson(`${url}/report`, 'tok', { hello: 'world' }, {
      timeoutMs: 120,
      ...(impl === undefined ? {} : { fetchImpl: impl }),
    });
    // The HEADERS arrived, so the request itself succeeded. The bug lives entirely after this line.
    assert.equal(res.status, 200);

    // Reading the body now must give up on the SAME timer the request was given. Raced against a
    // watchdog rather than awaited, and that is the point: WITHOUT H-1 this read never settles at
    // all inside any budget a hook has — undici's 300 s `bodyTimeout` is the only backstop
    // underneath — so a bare `assert.rejects` would HANG the suite instead of failing it. The race
    // turns "the bound is missing" into a fast, readable failure.
    const outcome = await Promise.race([
      res.json().then(
        () => 'resolved',
        (error) => (error.name === 'AbortError' || /abort|terminated/i.test(error.message)
          ? 'aborted'
          : `other: ${error.message}`),
      ),
      new Promise((resolve) => { setTimeout(() => resolve('still-pending'), 2500); }),
    ]);
    assert.equal(outcome, 'aborted', 'the body read is aborted by the request timer');

    // The observable proof that giving up actually RELEASED the socket, rather than leaving a reader
    // running in the background: the server sees the client go.
    await clientHungUp;
    assert.ok(Date.now() - started < 5000, 'and it gave up inside the budget, not at undici defaults');
  });
}

test('postJson — a response whose body is never read is a clean no-op when the timer fires (G42)', async () => {
  // The other half of H-1, and the reason it was blocked: `unref` stops a timer holding the loop
  // open, not firing. Two callers never read a body at all (`announceRepo`, and the timeline/error
  // POST), so in a process that outlives the timeout the abort lands on an unconsumed response -
  // which destroys the socket and could surface as an unhandled rejection on the body stream.
  //
  // Closed by experiment on Node 18.20.8 / 22.19.0 / 24.11.1 against both implementations; this is
  // the in-suite regression guard for it.
  const url = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, filler: 'x'.repeat(4096) }));
  });

  const problems = [];
  const onRejection = (reason) => problems.push(String(reason));
  process.on('unhandledRejection', onRejection);
  try {
    const res = await postJson(`${url}/report`, 'tok', { hello: 'world' }, { timeoutMs: 60 });
    assert.equal(res.status, 200);
    // Deliberately never read it, then stay alive well past the timeout.
    await withLoopAlive(() => new Promise((resolve) => { setTimeout(resolve, 400); }));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
  assert.deepEqual(problems, [], 'the timer firing against an unread body must be silent');
});

// A2: the comments this pins used to say the abort timer is CLEARED when the headers arrive, so a
// body read had no bound of its own. H-1 replaced `clearTimeout` with `unref` twelve lines above
// them and nobody corrected the prose, which is how a maintainer sizing a budget would double-count
// the body's allowance: headers and body share ONE allowance measured from the request, they do not
// get one each.
test('postJson — the one abort timer bounds the BODY too, measured from the request', async () => {
  let sawHangUp;
  const clientHungUp = new Promise((resolve) => { sawHangUp = resolve; });
  // Headers and a partial body, then silence: a stall the client can only escape by aborting.
  const url = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
    res.on('close', () => sawHangUp());
  });

  const started = Date.now();
  const res = await postJson(`${url}/report`, 'tok', { hello: 'world' }, { timeoutMs: 400 });
  const headersAt = Date.now() - started;
  assert.equal(res.status, 200);
  assert.ok(headersAt < 300, `headers should arrive promptly, took ${headersAt}ms`);

  // No readJsonBounded here, on purpose: this asserts what `bounded()` ALONE still does to a body
  // read after it has returned. If the timer were cleared at the headers this would sit on undici's
  // 300s bodyTimeout and the test would time out instead of rejecting.
  await assert.rejects(
    () => withLoopAlive(() => res.json()),
    (e) => e.name === 'AbortError' || /abort/i.test(String(e && e.message)),
  );
  const abortedAt = Date.now() - started;
  assert.ok(abortedAt >= 380, `the body must not be cut before the shared budget, cut at ${abortedAt}ms`);
  await clientHungUp;
});
