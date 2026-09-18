// Fetch shim for Node < 18, which has no global `fetch`. `resolveFetch()` is what call
// sites use; it hands back the real global when present so behavior on Node 18+ is
// untouched, and falls back to `httpsFetch` — a minimal `http`/`https` client
// covering only the surface this codebase actually exercises:
// GET/POST/DELETE with string/URLSearchParams bodies, abort, redirects, streamed body.
// It is not a general-purpose fetch polyfill. Ported verbatim from the Claude plugin
// (beezi-claude-plugins), same floor story: the declared engines floor matches that
// plugin's, and this shim plus abort-compat are what make fetch-less interpreters viable.
// Bare specifiers (not `node:`-prefixed) on purpose: the `node:` prefix needs Node
// 12.20 / 14.13.1+ in ESM, while bare `http`/`https` resolve on every Node version
// this shim could plausibly run under.
import http from 'http';
import https from 'https';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function resolveFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch : httpsFetch;
}

export async function httpsFetch(url, init = {}) {
  let currentUrl = new URL(url);
  let method = init.method == null ? 'GET' : init.method;
  let body = init.body;
  let headers = { ...(init.headers == null ? {} : init.headers) };
  const signal = init.signal;

  for (let hop = 0; ; hop++) {
    const res = await sendOnce(currentUrl, method, headers, body, signal);
    const location = REDIRECT_STATUSES.has(res.statusCode) ? res.headers.location : null;
    if (!location) return toResponse(res, signal);

    // Discard the redirect response body — nothing reads it. A late socket error on an
    // already-decided response must not crash the process as an unhandled 'error' event.
    res.on('error', () => {});
    res.resume();
    // `redirect: 'error'` is honoured by the real fetch on Node 18+, and this shim used to drop it
    // silently — so the one request that asks not to be redirected was the one request that
    // followed redirects on old Node. A redirect is how an unexpected header gets onto a request
    // that deliberately carries none. A TypeError matches what WHATWG fetch throws, which the
    // caller already treats as a transport failure and therefore as preserve-and-retry.
    if (init.redirect === 'error') {
      throw new TypeError(`Redirect refused fetching ${url}`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) fetching ${url}`);
    }

    const nextUrl = new URL(location, currentUrl);
    if (res.statusCode === 303) {
      method = 'GET';
      body = undefined;
    }
    if (nextUrl.origin !== currentUrl.origin) {
      headers = stripAuthorization(headers);
    }
    currentUrl = nextUrl;
  }
}

function transportFor(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new TypeError(`Unsupported protocol: ${url.protocol}`);
}

function stripAuthorization(headers) {
  const kept = {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'authorization') kept[key] = headers[key];
  }
  return kept;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function makeAbortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

// Sends one request (no redirect handling) and resolves with the IncomingMessage once
// response headers arrive. The body stream is left untouched for the caller to consume.
//
// THE ABORT DOES NOT END AT THE HEADERS. This used to `cleanup()` inside the 'response'
// handler, which removed the only abort listener the moment the status line arrived — so a
// caller that went on to await `res.json()` against a server that answers and then stalls
// mid-body had no bound at all: its AbortController fired into nothing and the promise stayed
// pending for the life of the process. On Node <18 this shim IS fetch, and OAuth, the MCP
// bridge and diagnostics all read a body after the headers. The listener therefore lives until
// the response stream closes, and firing it destroys BOTH the request and the response.
function sendOnce(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }

    // Real fetch sends Content-Length for string bodies; without it Node falls back to
    // Transfer-Encoding: chunked, which some proxies/gateways reject or mishandle.
    // Built fresh per hop (not stored on the caller's `headers`) so a 303's dropped
    // body doesn't leave a stale Content-Length on the follow-up GET.
    const payload = body !== undefined ? String(body) : undefined;
    const requestHeaders = { ...headers };
    if (payload !== undefined && !hasHeader(requestHeaders, 'content-length')) {
      requestHeaders['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const transport = transportFor(url);
    const req = transport.request(url, { method, headers: requestHeaders });

    let response = null;
    // The promise settles at the HEADERS; the abort listener outlives that, so it must never
    // try to settle again — after headers its whole job is to tear the sockets down.
    let settled = false;

    // `{ once: true }` plus explicit removal on every terminal path keeps a long-lived signal
    // (e.g. a shared AbortController across a redirect chain) from accumulating listeners.
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      req.destroy();
      if (response !== null) response.destroy();
      if (!settled) {
        settled = true;
        reject(makeAbortError());
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('response', (res) => {
      response = res;
      // A response destroyed with no 'error' listener emits an unhandled 'error' (ECONNRESET on
      // some platforms) and takes the process down — and the abort path above destroys exactly
      // such a response, possibly one nobody is reading. bufferText adds its own listener when
      // someone IS reading; this no-op is the floor under the case where nobody is.
      res.on('error', () => {});
      // The stream is done — nothing is left for an abort to cancel.
      res.on('close', cleanup);
      settled = true;
      resolve(res);
    });
    req.on('error', (err) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(err); // preserve the original Node error, including .code
    });

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Buffers the whole response body, bounded by the same signal the request was made under.
//
// Three terminal events, ONE settlement. 'end' is success. 'error' is the socket failing under
// us. 'close' without a prior 'end' is a destroyed stream — which is what an abort produces —
// and reads as an AbortError rather than a silent hang. Every listener, the abort one included,
// comes off on whichever of them lands first, so a shared controller does not grow a listener
// per body read.
function bufferText(res, signal) {
  return new Promise((resolve, reject) => {
    // Already aborted before anyone asked for the body: do not attach handlers to a stream that
    // is going nowhere, and do not leave its socket open behind the rejection.
    if (signal && signal.aborted) {
      try { res.destroy(); } catch { /* already gone */ }
      reject(makeAbortError());
      return;
    }

    const chunks = [];
    let settled = false;

    const detach = () => {
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
      res.removeListener('close', onClose);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onError = (err) => settle(() => reject(err));
    const onClose = () => settle(() => reject(makeAbortError()));
    const onAbort = () => {
      try { res.destroy(); } catch { /* already gone */ }
      settle(() => reject(makeAbortError()));
    };

    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
    res.on('close', onClose);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toResponse(res, signal) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage,
    headers: {
      // Node already lower-cases incoming header names; lower-case the lookup key too.
      get: (name) => {
        const value = res.headers[String(name).toLowerCase()];
        return value == null ? null : value;
      },
    },
    // The signal is threaded through so a body read is bounded by the caller's deadline too —
    // headers are only half the wait.
    text: () => bufferText(res, signal),
    json: async () => JSON.parse(await bufferText(res, signal)),
    body: res,
  };
}
