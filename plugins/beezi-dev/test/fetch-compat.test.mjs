import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import { resolveFetch, httpsFetch } from '../lib/fetch-compat.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('resolveFetch returns the global fetch when it exists', () => {
  assert.equal(typeof globalThis.fetch, 'function');
  assert.strictEqual(resolveFetch(), globalThis.fetch);
});

test('resolveFetch falls back to httpsFetch when no global fetch exists', (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = undefined;
  t.after(() => {
    globalThis.fetch = real;
  });
  assert.strictEqual(resolveFetch(), httpsFetch);
});

test('GET: status, ok, statusText, json(), text()', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 201;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ hello: 'world' }));
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.equal(res.statusText, 'Created');
  assert.deepEqual(await res.json(), { hello: 'world' });
});

test('text() buffers the response body as a string', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end('plain text body');
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(await res.text(), 'plain text body');
});

test('non-2xx status is reflected in ok/status, not thrown', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test('headers.get is case-insensitive and returns null when absent', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader('X-Custom-Header', 'abc123');
    res.end();
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  assert.equal(res.headers.get('x-custom-header'), 'abc123');
  assert.equal(res.headers.get('X-CUSTOM-HEADER'), 'abc123');
  assert.equal(res.headers.get('nonexistent'), null);
});

test('POST with a string body arrives verbatim with sent headers', async (t) => {
  const { server, url } = await startServer((req, res) => {
    let received = '';
    req.on('data', (chunk) => { received += chunk; });
    req.on('end', () => {
      res.end(JSON.stringify({
        method: req.method,
        body: received,
        contentType: req.headers['content-type'],
      }));
    });
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello beezi',
  });
  const payload = await res.json();
  assert.equal(payload.method, 'POST');
  assert.equal(payload.body, 'hello beezi');
  assert.equal(payload.contentType, 'text/plain');
});

test('POST sets Content-Length to the byte length of the body (multibyte-safe)', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end(String(req.headers['content-length']));
  });
  t.after(() => closeServer(server));

  const body = 'café'; // 4 chars, 5 UTF-8 bytes — .length would be wrong
  const res = await httpsFetch(url, { method: 'POST', body });
  assert.equal(await res.text(), String(Buffer.byteLength(body)));
});

test('POST with a URLSearchParams body is sent as its string form', async (t) => {
  const { server, url } = await startServer((req, res) => {
    let received = '';
    req.on('data', (chunk) => { received += chunk; });
    req.on('end', () => res.end(received));
  });
  t.after(() => closeServer(server));

  const params = new URLSearchParams({ a: '1', b: 'two words' });
  const res = await httpsFetch(url, { method: 'POST', body: params });
  assert.equal(await res.text(), String(params));
});

test('DELETE method is used when requested', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.end(req.method);
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url, { method: 'DELETE' });
  assert.equal(await res.text(), 'DELETE');
});

test('body is async-iterable as chunks arrive with delays', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('chunk-1-');
    setTimeout(() => {
      res.write('chunk-2-');
      setTimeout(() => {
        res.end('chunk-3');
      }, 20);
    }, 20);
  });
  t.after(() => closeServer(server));

  const res = await httpsFetch(url);
  const decoder = new TextDecoder();
  let assembled = '';
  for await (const chunk of res.body) {
    assembled += decoder.decode(chunk, { stream: true });
  }
  assembled += decoder.decode();
  assert.equal(assembled, 'chunk-1-chunk-2-chunk-3');
});

test('pre-aborted signal rejects immediately with AbortError', async (t) => {
  const { server, url } = await startServer((req, res) => res.end('should not be reached'));
  t.after(() => closeServer(server));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    httpsFetch(url, { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('aborting mid-request rejects with AbortError', async (t) => {
  let resolveRequestSeen;
  const requestSeen = new Promise((resolve) => { resolveRequestSeen = resolve; });
  const { server, url } = await startServer((req, res) => {
    resolveRequestSeen();
    // Never respond — let the abort win the race.
  });
  t.after(() => closeServer(server));

  const controller = new AbortController();
  const pending = httpsFetch(url, { signal: controller.signal });
  const rejection = assert.rejects(pending, (err) => err.name === 'AbortError');
  await requestSeen;
  controller.abort();
  await rejection;
});

test('connection refused rejects with the original error code', async () => {
  const { server, url } = await startServer((req, res) => res.end());
  await closeServer(server); // port is now free and connection-refused

  await assert.rejects(
    httpsFetch(url),
    (err) => err.code === 'ECONNREFUSED',
  );
});

test('follows a 302 redirect to a 200', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end('redirected-body');
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'redirected-body');
});

test("redirect: 'error' refuses the hop instead of following it", async (t) => {
  // The real fetch honours this on Node 18+; the shim used to drop it silently, so the ONE request
  // that asks not to be redirected was the one request that WAS redirected on old Node.
  // `postDiagnostics` is that request: it carries no Authorization, no Cookie and no `X-Beezi-*`
  // header, and a redirect is how an unexpected header gets onto a request that carries none.
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end('must-not-be-reached');
  });
  t.after(() => closeServer(target));

  let hops = 0;
  const { server: origin, url: originUrl } = await startServer((req, res) => {
    hops += 1;
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  // A TypeError, which is what WHATWG fetch throws and what the caller already treats as a
  // transport failure — i.e. preserve the queued record and retry, never drop it.
  await assert.rejects(
    httpsFetch(originUrl, { redirect: 'error' }),
    (error) => error instanceof TypeError && /Redirect refused/.test(error.message),
  );
  assert.equal(hops, 1, 'the first request was made; the second was not');

  // The default is unchanged, so nothing that did not ask for the refusal gets one.
  const followed = await httpsFetch(originUrl);
  assert.equal(await followed.text(), 'must-not-be-reached');
});

test('303 redirect converts POST to GET and drops the body', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end(JSON.stringify({ method: req.method, contentLength: req.headers['content-length'] ?? null }));
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(303, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl, { method: 'POST', body: 'ignored-after-303' });
  const payload = await res.json();
  assert.equal(payload.method, 'GET');
  // The follow-up GET must not carry a stale Content-Length from the dropped POST body,
  // or a server expecting a body of that size will stall waiting for bytes that never come.
  assert.equal(payload.contentLength, null);
});

test('more than 5 redirect hops rejects', async (t) => {
  // Server redirects to itself with an incrementing counter in the query string,
  // producing a chain that needs 6 hops to reach 200 — one more than the shim allows.
  const { server, url } = await startServer((req, res) => {
    const count = Number(new URL(req.url, 'http://placeholder').searchParams.get('n') ?? '0');
    if (count >= 6) {
      res.end('done');
      return;
    }
    res.writeHead(302, { Location: `/?n=${count + 1}` });
    res.end();
  });
  t.after(() => closeServer(server));

  await assert.rejects(httpsFetch(url), /redirect/i);
});

test('cross-origin redirect drops the Authorization header', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => {
    res.end(JSON.stringify({ hasAuth: 'authorization' in req.headers }));
  });
  t.after(() => closeServer(target));

  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const res = await httpsFetch(originUrl, { headers: { Authorization: 'Bearer secret' } });
  const payload = await res.json();
  assert.equal(payload.hasAuth, false);
});

test('unsupported protocol rejects with a TypeError', async () => {
  await assert.rejects(httpsFetch('ftp://example.com/file'), TypeError);
});

// ─── the abort must survive past the headers (PIPE-08) ──────────────────────────────────────────
//
// `sendOnce` used to drop its abort listener the moment the response arrived, so a caller that
// awaited `res.json()` on a server which sends headers and then stalls mid-body had NO bound at
// all: the caller's AbortController fired into nothing and the promise stayed pending for the life
// of the process. OAuth, the MCP bridge and diagnostics all read a body after headers on Node <18,
// where this shim is the fetch.
//
// The fixture below is that server. Sockets are tracked and destroyed explicitly because
// `server.close()` waits for open connections and a never-ending body keeps one open forever —
// without this the test file hangs instead of failing.
function startStalledServer(prelude = '{"partial":') {
  return new Promise((resolve) => {
    const sockets = new Set();
    let sawRequest;
    const requestSeen = new Promise((r) => { sawRequest = r; });
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(prelude);
      sawRequest();
      // ...and never `res.end()`.
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        requestSeen,
        url: `http://127.0.0.1:${port}`,
        stop: () => {
          for (const socket of sockets) socket.destroy();
          return closeServer(server);
        },
      });
    });
  });
}

// The abort must free the CONNECTION, and that is the assertion worth making. `res.body.destroyed`
// is true here and is checked alongside — but it is a modern-Node fact, not the invariant: on the
// declared Node 13.2 floor `IncomingMessage.prototype.destroy()` tears the socket down without ever
// flagging the message object, so `destroyed` stays false while the teardown is perfectly healthy.
// The floor probe (test/floor/fetch-stalled-body-probe.mjs) asserts only the socket for that
// reason; this keeps the two in agreement about what "torn down" means. `socket` must be captured
// BEFORE the abort — a destroyed response may drop the reference.
function assertConnectionTornDown(res, socket, what) {
  assert.equal(socket != null, true, `${what}: no socket was captured`);
  assert.equal(socket.destroyed, true, `${what}: the socket carrying the response was left open`);
  assert.equal(res.body.destroyed, true, `${what}: the response stream must be destroyed, not left open`);
}

test('aborting while the response body is stalled rejects json() with AbortError', { timeout: 10_000 }, async (t) => {
  const fixture = await startStalledServer();
  t.after(() => fixture.stop());

  const controller = new AbortController();
  const res = await httpsFetch(fixture.url, { signal: controller.signal });
  assert.equal(res.status, 200, 'headers arrive before the stall');
  const socket = res.body.socket;

  const pending = res.json();
  const rejection = assert.rejects(pending, (err) => err.name === 'AbortError');
  await fixture.requestSeen;
  controller.abort();
  await rejection;

  assertConnectionTornDown(res, socket, 'abort during a stalled json()');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort listeners must be removed');
});

test('aborting while the response body is stalled rejects text() with AbortError', { timeout: 10_000 }, async (t) => {
  const fixture = await startStalledServer('partial text');
  t.after(() => fixture.stop());

  const controller = new AbortController();
  const res = await httpsFetch(fixture.url, { signal: controller.signal });
  const socket = res.body.socket;
  const rejection = assert.rejects(res.text(), (err) => err.name === 'AbortError');
  await fixture.requestSeen;
  controller.abort();
  await rejection;
  assertConnectionTornDown(res, socket, 'abort during a stalled text()');
});

test('a body read on an already-aborted signal rejects immediately without reading', { timeout: 10_000 }, async (t) => {
  const fixture = await startStalledServer();
  t.after(() => fixture.stop());

  const controller = new AbortController();
  const res = await httpsFetch(fixture.url, { signal: controller.signal });
  const socket = res.body.socket;
  await fixture.requestSeen;
  // Abort AFTER the headers but BEFORE anyone asks for the body: the second call must not attach
  // data handlers to a stream that is already going nowhere.
  controller.abort();
  await assert.rejects(res.json(), (err) => err.name === 'AbortError');
  assertConnectionTornDown(res, socket, 'abort before the body read');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an aborted stalled body rejects exactly once', { timeout: 10_000 }, async (t) => {
  const fixture = await startStalledServer();
  t.after(() => fixture.stop());

  const controller = new AbortController();
  const res = await httpsFetch(fixture.url, { signal: controller.signal });
  let settlements = 0;
  const pending = res.text().then(() => { settlements += 1; }, () => { settlements += 1; });
  await fixture.requestSeen;
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settlements, 1, 'aborted / closed / error must not settle the same promise twice');
});

test('a complete request removes every abort listener from a shared signal', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => closeServer(server));

  const controller = new AbortController();
  for (let i = 0; i < 3; i += 1) {
    const res = await httpsFetch(url, { signal: controller.signal });
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'a long-lived controller must not accumulate one listener per call',
  );
});

test('a redirect chain leaves no abort listener behind on the shared signal', async (t) => {
  const { server: target, url: targetUrl } = await startServer((req, res) => res.end('final'));
  t.after(() => closeServer(target));
  const { server: origin, url: originUrl } = await startServer((req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  t.after(() => closeServer(origin));

  const controller = new AbortController();
  const res = await httpsFetch(originUrl, { signal: controller.signal });
  assert.equal(await res.text(), 'final');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a malformed JSON body rejects with a parse error, not an AbortError', async (t) => {
  const { server, url } = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"truncated":');
  });
  t.after(() => closeServer(server));

  const controller = new AbortController();
  const res = await httpsFetch(url, { signal: controller.signal });
  await assert.rejects(res.json(), (err) => err instanceof SyntaxError);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a response destroyed after headers does not crash on an unhandled stream error', { timeout: 10_000 }, async (t) => {
  const fixture = await startStalledServer();
  t.after(() => fixture.stop());

  const controller = new AbortController();
  const res = await httpsFetch(fixture.url, { signal: controller.signal });
  const socket = res.body.socket;
  await fixture.requestSeen;
  // Nobody is reading the body. An IncomingMessage destroyed with no 'error' listener emits an
  // unhandled 'error' (ECONNRESET on some platforms) and takes the process down with it.
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertConnectionTornDown(res, socket, 'abort with nobody reading the body');
});
