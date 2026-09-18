// Bounded POST of a JSON body with bearer auth. Returns the fetch Response so callers
// own the status/body handling; throws on network error or timeout (caller catches).
// The timeout guards the hook's 10s budget — a hung server must not stall the turn.
import { machineHeaders } from './machine-identity.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

// Exported so a caller working against a deadline can shrink it to what the budget has left,
// rather than discovering the overrun after the fact.
export const POST_TIMEOUT_MS = 3000;
const DEFAULT_TIMEOUT_MS = POST_TIMEOUT_MS;

// Interactive reads (whoami, repo status) are not on the hook's 3s budget, but they must still be
// bounded: Node's fetch has no default timeout, so a server that accepts the connection and then
// goes quiet — an API paused in a debugger, one mid-restart, a proxy holding the socket — leaves
// the promise pending for the life of the process. That is what stranded a *completed* login: the
// credentials were already stored and the browser round-trip was done, but the display-name lookup
// that runs afterwards never settled, so the MCP tool call never returned a result.
const DEFAULT_READ_TIMEOUT_MS = 10_000;

async function bounded(fetchImpl, url, init, timeoutMs) {
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    // UNREF, not clearTimeout (H-1). `fetch` settles when the HEADERS arrive, not at the end of the
    // body, so clearing here left `res.json()` running with no bound at all: measured against a real
    // server, headers in 27 ms and the body still pending at 12 s, with undici's 300 s `bodyTimeout`
    // the only backstop underneath — thirty times the budget a Cursor hook gets before it is killed.
    // `unref` keeps the ONE timer bounding the headers AND the body while still letting a finished
    // hook's event loop empty, which is what `clearTimeout` was really there for.
    //
    // `unref` stops a timer HOLDING the loop open; it does not stop it FIRING. In a hook that stays
    // alive after a fast POST (git shell-outs, sidecar parsing, state writes) it fires at
    // `timeoutMs` and aborts a response that may never have been read — `announceRepo` and the
    // timeline/error POST never read one. Aborting an unconsumed undici response destroys the
    // socket, which could surface as an unhandled rejection on the body stream.
    //
    // That was the open question (G42) and it is now closed by experiment rather than by argument:
    // a process kept alive past the timeout, POSTing to a server that answers 200 immediately and
    // never reading the body, is a CLEAN no-op on Node 18.20.8, 22.19.0 and 24.11.1, against both
    // `globalThis.fetch` and this repo's `httpsFetch` shim. No unhandled rejection, no socket error,
    // no throw. The evidence is recorded in the M00.5 gate record under G42.
    if (typeof timeout.unref === 'function') timeout.unref();
    else clearTimeout(timeout);
  }
}

// The body is a SECOND wait, and it shares `bounded()`'s ONE allowance rather than getting one of
// its own. Since H-1 that timer is unref'd, not cleared, so it is still armed when a Response comes
// back: it fires at `timeoutMs` measured from the REQUEST and aborts a body read that is still in
// flight, on `globalThis.fetch` and on this repo's `httpsFetch` shim alike. Before H-1 it really
// was cleared at the headers and `res.json()` ran unbounded — measured against a real server,
// headers in 27ms and the body still pending at 12s, with undici's 300s `bodyTimeout` the only
// backstop underneath, thirty times the ~10s a Cursor hook gets before it is killed.
//
// This function is still what callers should use, for two reasons the shared timer does not cover.
// It turns that abort into `null` instead of a throw, and it applies a SECOND, tighter bound for a
// caller that has already spent part of the budget on the headers, or whose response exposes no
// abortable stream at all (a stubbed fetch in the tests).
//
// Resolves `null` instead of throwing on a stall, an unparseable body, or an empty one. Every caller
// already treats "no readable body" as a soft outcome (falling back to an empty object, or to
// "HTTP 500" instead of the server's message); making them wrap this in a try/catch to survive a
// slow server is how one of them would end up not having it.
export async function readJsonBounded(res, timeoutMs = DEFAULT_READ_TIMEOUT_MS) {
  if (!res || typeof res !== 'object') return null;

  const stream = res.body;
  // Take the lock ourselves rather than calling res.json() and cancelling the stream behind it: on a
  // locked stream `res.body.cancel()` rejects with a TypeError and the socket stays open, and an
  // open socket is precisely what keeps a hook process alive after its work is done. A reader we
  // hold can always cancel itself.
  const reader = stream != null && typeof stream.getReader === 'function' ? stream.getReader() : null;

  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        if (reader != null) {
          const cancelled = reader.cancel();
          if (cancelled != null && typeof cancelled.catch === 'function') cancelled.catch(() => {});
        }
      } catch { /* already released */ }
      try {
        if (stream != null && typeof stream.destroy === 'function') stream.destroy();
      } catch { /* not a Node stream */ }
      resolve(null);
      // Math.max, because a caller sharing one budget across headers+body hands us what is LEFT of
      // it, and that can be negative. A spent budget must mean "give up now", not "no bound".
    }, Math.max(0, timeoutMs));
    // The abandon timer must never be the reason the process stays up; it outlives a fast read by
    // whatever is left of the budget, and hooks exit as soon as they are done.
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });

  try {
    return await Promise.race([expired, reader ? drainJson(reader) : parseJson(res)]);
  } finally {
    clearTimeout(timer);
  }
}

// Drains the stream we hold the lock on and parses it. A cancel mid-read surfaces here as a rejected
// read(), which is the timeout path, not an error worth reporting.
async function drainJson(reader) {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// Responses that expose no stream — a stubbed fetch in the tests, or any impl handing back a plain
// object — still have to be read through something. Losing the race leaves this pending forever,
// hence the swallowed rejection: an abandoned body must not surface as an unhandled rejection and
// take the hook down with it.
function parseJson(res) {
  if (typeof res.json !== 'function') return Promise.resolve(null);
  try {
    return Promise.resolve(res.json()).then((v) => v, () => null);
  } catch {
    return Promise.resolve(null);
  }
}

export async function postJson(url, token, body, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  return bounded(fetchImpl, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...machineHeaders(),
    },
    body: JSON.stringify(body),
  }, timeoutMs);
}

// Bounded GET with bearer auth. Returns the fetch Response; throws on network error or timeout.
//
// `timeoutMs` is ONE allowance covering the headers and the body, measured from the request: the
// abort timer is unref'd rather than cleared (H-1), so it is still armed after this returns and
// will cut a body read that is still going at `timeoutMs`. It reads no body of its own, so a caller
// that wants one must read it with readJsonBounded — passing what is LEFT of the budget (see
// whoami), both so the two phases stay inside the one bound and so a stall reads as `null` rather
// than as an AbortError thrown from under the caller.
export async function getJson(url, token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_READ_TIMEOUT_MS : deps.timeoutMs;
  return bounded(fetchImpl, url, {
    headers: { 'Authorization': `Bearer ${token}`, ...machineHeaders() },
  }, timeoutMs);
}
