import {
  forceRefresh as _forceRefresh,
  getAccessToken as _getAccessToken,
  getAuthState as _getAuthState,
  invalidateTokenCache as _invalidateTokenCache,
} from './token.mjs';
import { AuthReason, AuthState, authStateShape } from './auth-state.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { apiBase } from './config.mjs';
import { performLogin as _performLogin } from './login.mjs';
import { linkStatus as _linkStatus, describeLink, describeReporting } from './link-status.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Cursor runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// login credentials the hooks use (refresh included). Server→client push (the
// standing GET stream) is not bridged: the drafting tools are strictly
// request/response.
//
// This process outlives every request it serves: Cursor spawns it once per session and reads its
// stdout as the JSON-RPC channel for hours. So the invariant that matters more than any single
// answer is that EVERY accepted request id gets EXACTLY ONE terminal reply and the process stays
// usable afterwards — through a sleeping laptop, a portal restart, a revoked credential and a
// sign-in performed in another terminal.

// Bounds a hung tool request, not normal tool latency (board writes take seconds). SSE progress
// re-arms it, so this is an idle budget rather than a wall clock.
const DEFAULT_TIMEOUT_MS = 120000;
// The handshake is not tool latency: nothing about `initialize` should take twenty seconds, and a
// client that never gets its handshake answered shows the user a broken plugin rather than a slow
// one. Absolute, never re-armed — an infinite stream of progress notifications must not hold the
// handshake open forever.
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;
// How often a degraded bridge asks whether the world came back. Unref'd, single-flight, and
// stopped the moment it succeeds or stdin closes.
const RECOVERY_INTERVAL_MS = 15000;
// Probing costs a credential-store read, and on Windows that is a PowerShell spawn (a measured
// median of half a second). Fifteen seconds is the right cadence for a linked machine waiting for
// the portal, and the wrong one for a machine that is simply not signed in — nothing there changes
// on its own, and an hour of that is 240 spawns. Unlinked probes therefore back off to sixteen
// ticks (four minutes) and snap back to every tick the moment a credential can be read.
const MAX_RECOVERY_BACKOFF_TICKS = 16;
// Server-supplied prose that reaches the model is bounded and stripped of control characters: it
// is attacker-influenced input being rendered into a tool result.
const MAX_SERVER_MESSAGE_CHARS = 300;

const SESSION_HEADER = 'mcp-session-id';

// Cursor spawns this server eagerly at the start of every session, so an unlinked machine must not
// make the handshake fail — that reads to the user as "the plugin is broken" and takes the skill
// down with it. Unlinked, the bridge answers `initialize` locally and serves exactly one tool:
// signing in. That is also the whole auto-login story — Cursor's native MCP OAuth only covers
// streamable-HTTP servers, and using it would put the token in Cursor's store while the analytics
// hooks read ~/.beezi-cursor/credentials.json, so the machine would have to be linked twice.
const PROTOCOL_VERSION = '2025-06-18';

// CONTRACTS §2's vocabulary comes FROM lib/auth-state.mjs now (integration step 4, M-1). It used to
// be a local copy of the same strings, written because the auth lane's module did not exist yet —
// and a copy of an enum is a copy that can fall behind: AuthReason has grown CORRUPT, CONFLICT,
// LOCKED, INVALID_GRANT, BACKOFF, TRANSPORT and HTTP_5XX since, every one of which the real typed
// accessor can now hand this bridge.

export const LOGIN_TOOL = Object.freeze({
  name: 'beezi_login',
  title: 'Sign in to Beezi',
  description:
    'Link this machine to Beezi. Opens a browser to sign in with the user’s Beezi account and ' +
    'stores the credentials locally. Call this when Beezi reports that the machine is not linked, ' +
    'or when the user asks to sign in, log in, or connect to Beezi. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

// Answering "am I linked / why is nothing reported" has to happen here, not in a script the model
// shells out to: this server is spawned by Cursor and inherits BEEZI_API_URL and the credential
// store, while a sandboxed shell command may see neither — which is exactly how the login tool and
// a status script ended up contradicting each other.
export const STATUS_TOOL = Object.freeze({
  name: 'beezi_status',
  title: 'Beezi status',
  description:
    'Report whether this machine is linked to Beezi, which account it is linked as, which Beezi ' +
    'API it is talking to, and whether the analytics hooks are installed. Call this when the user ' +
    'asks about their Beezi link or connection status, or asks why their Beezi analytics are ' +
    'empty or not being tracked. Prefer this over running any status script. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

export const LOCAL_TOOLS = Object.freeze([LOGIN_TOOL, STATUS_TOOL]);

const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Call the beezi_login tool to relink.";
const UNANSWERED_MESSAGE =
  'Beezi MCP did not return a response for this request. The request was not confirmed as run — retry it if it is safe to repeat.';

// What the bridge says for each authentication state. Authentication is not authorization and
// neither is a transport failure: telling a linked user they are "not linked" sends them to relink,
// which deletes a working session to fix a problem it never had.
// Deliberately NOT lib/auth-state.mjs's `describeAuthState`: these sentences have to tell an agent
// which TOOL to call next, which is bridge-specific and not something a shared describer can know.
// The states and their meanings are shared; the call-to-action is local.
function authMessage(state) {
  if (state === AuthState.REAUTH_REQUIRED) {
    return `This machine's Beezi sign-in has expired. Call the ${LOGIN_TOOL.name} tool to sign in again, then retry.`;
  }
  if (state === AuthState.REFRESHING) {
    return 'Beezi is refreshing this machine’s credentials — retry in a moment. The sign-in is still valid.';
  }
  if (state === AuthState.UNAVAILABLE) {
    return 'Beezi could not read this machine’s stored credentials right now; this is temporary and does not mean the machine was unlinked. Retry in a moment, or call the beezi_status tool.';
  }
  if (state === AuthState.FORBIDDEN) {
    return 'This Beezi account is not allowed to use this tool. Signing in again will not change that.';
  }
  return `This machine is not linked to Beezi. Call the ${LOGIN_TOOL.name} tool first, then retry.`;
}

export function mcpUrl() {
  return process.env.BEEZI_MCP_URL == null ? `${apiBase()}/mcp` : process.env.BEEZI_MCP_URL;
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Server prose on its way into a tool result: strip control characters (they corrupt the line
// protocol), collapse whitespace and truncate. Anything that is not a non-empty string is not a
// message, and the caller falls back to the generic HTTP wording.
export function sanitizeServerMessage(value, maxChars) {
  if (typeof value !== 'string') return null;
  const limit = maxChars == null ? MAX_SERVER_MESSAGE_CHARS : maxChars;
  let cleaned = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    cleaned += code < 32 || code === 127 ? ' ' : value.charAt(i);
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

// Connects the bridge's `deps.recordIssue` to the consent-gated telemetry facade, for the stdio
// entry point that has no dependency injection of its own. Everything that decides whether anything
// is collected lives behind `load()`; this side only guarantees two things the bridge cannot do
// without it:
//
//   - it is asynchronous and fully caught, so a diagnostic can never change how a request
//     completed, and a telemetry module that throws cannot take the server down;
//   - a machine with no telemetry module installed looks the module up once and stays silent
//     forever after, because absence of those files is the documented "off" state.
//
// The flush trigger fires once per process: the worker does its own throttling, and one launch per
// failure would be its own outage.
export function createIssueRecorder(deps = {}) {
  const load = typeof deps.load === 'function' ? deps.load : () => import('./telemetry.mjs');
  const onError = typeof deps.onError === 'function' ? deps.onError : function () {};
  let loaded = null;
  let launched = false;
  return function record(code, fields) {
    try {
      if (loaded == null) loaded = Promise.resolve().then(load).catch(() => null);
      loaded
        .then((mod) => {
          if (mod == null || typeof mod.recordIssue !== 'function') return;
          mod.recordIssue(code, fields);
          if (launched || typeof mod.maybeLaunchWorker !== 'function') return;
          launched = true;
          mod.maybeLaunchWorker();
        })
        .catch(onError);
    } catch (error) {
      onError(error);
    }
  };
}

// Incremental SSE framing: fed chunks by whoever owns the reader, so cancelling the stream stays
// possible. A `for await` over the body would lock it and make `cancel()` throw on exactly the
// path that needs it — the stall.
function createSseParser() {
  const decoder = new TextDecoder();
  let buf = '';
  return function push(chunk) {
    buf += decoder.decode(chunk, { stream: true });
    const events = [];
    let match;
    while ((match = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) events.push(data);
    }
    return events;
  };
}

// One reader over a response body, whichever transport produced it: a WHATWG stream from native
// fetch, or the IncomingMessage the Node-13 fallback in fetch-compat.mjs hands back. Holding the
// reader (rather than iterating the body) is what makes cancellation available.
function openBody(res) {
  const body = res == null ? null : res.body;
  if (body == null) return null;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    return {
      read: () => reader.read(),
      cancel: () => {
        try {
          const done = reader.cancel();
          if (done != null && typeof done.catch === 'function') done.catch(() => {});
        } catch (error) {
          /* a body that refuses to be cancelled must not replace the real failure */
        }
      },
    };
  }
  const iterate = body[Symbol.asyncIterator];
  if (typeof iterate !== 'function') return null;
  const iterator = iterate.call(body);
  return {
    read: () => iterator.next(),
    // The fallback transport's bufferText() never learns about the abort signal, so the only way
    // to interrupt a half-delivered body there is to destroy the socket underneath it.
    cancel: () => {
      try {
        if (typeof body.destroy === 'function') body.destroy();
      } catch (error) {
        /* see above */
      }
    },
  };
}

export function createBridge(deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  // getToken() memoizes for up to a minute (see lib/token.mjs) so that a long stdio session does
  // not re-read the OS keyring on every JSON-RPC message. That memo is only safe because this file
  // tells it when the credential it describes has stopped being the truth.
  const invalidateToken = deps.invalidateTokenCache == null ? _invalidateTokenCache : deps.invalidateTokenCache;
  const url = deps.url == null ? mcpUrl() : deps.url;
  const write = deps.write;
  const logError = deps.logError == null ? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`)) : deps.logError;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  // Capped by the request timeout: an injected 5s budget means the handshake cannot outlive it.
  const handshakeMs = Math.min(
    deps.handshakeTimeoutMs == null ? DEFAULT_HANDSHAKE_TIMEOUT_MS : deps.handshakeTimeoutMs,
    timeoutMs,
  );
  const recoveryMs = deps.recoveryIntervalMs == null ? RECOVERY_INTERVAL_MS : deps.recoveryIntervalMs;
  const performLogin = deps.performLogin == null ? _performLogin : deps.performLogin;
  const linkStatus = deps.linkStatus == null ? _linkStatus : deps.linkStatus;
  const setTimeoutImpl = deps.setTimeoutImpl == null ? setTimeout : deps.setTimeoutImpl;
  const clearTimeoutImpl = deps.clearTimeoutImpl == null ? clearTimeout : deps.clearTimeoutImpl;
  const setIntervalImpl = deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl;
  const clearIntervalImpl = deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl;
  const now = deps.now == null ? Date.now : deps.now;
  const recordIssue = typeof deps.recordIssue === 'function' ? deps.recordIssue : function () {};

  let sessionId = null;
  let initializeMsg = null;
  let reinit = null; // in-flight transparent re-initialize, shared by concurrent 404s
  let refreshing = null; // in-flight forced token refresh, shared by concurrent 401s
  // Has an `initialize` reached the portal? False while unlinked (we answered it ourselves), so a
  // machine linked mid-session hands the portal its handshake before the first real request.
  let upstreamReady = false;
  let disposed = false;

  // ---- authentication ------------------------------------------------------

  const authShape = (state, reason, token) => authStateShape(state, reason, { token: token == null ? null : token });

  // The TYPED accessor (CONTRACTS §2) is the default now. It is what lets this bridge tell a user
  // the truth: `forbidden` is an entitlement refusal that signing in again cannot fix,
  // `reauth_required` is a dead grant, `refreshing` is another process mid-rotation and
  // `unavailable` is a store that did not answer. The adapter below could only ever produce
  // "linked" or "not linked" from a bare token, and "not linked" is the reading that sends a user
  // to relink — which replaces a credential that was never the problem.
  //
  // `getAuthState` and `forceRefresh` never throw and never delete, so the try/catch here is belt
  // rather than policy; a rejection still has to become UNAVAILABLE and not UNLINKED.
  function typedAuth() {
    const readState = deps.getAuthState == null ? _getAuthState : deps.getAuthState;
    const renew = deps.forceRefresh == null ? _forceRefresh : deps.forceRefresh;
    return {
      getAuthState: async (options) => {
        try {
          // `fresh` means "a sign-in may have happened in another process". lib/token.mjs's memo is
          // keyed on (service, generation), so a new generation misses it by construction — but a
          // logout/login pair that lands back on the same generation would not, and the watcher
          // that passes this flag exists for exactly the cases we cannot reason about.
          if (options != null && options.fresh === true) invalidateToken();
          const state = await readState(
            options == null || options.deadlineMs == null ? {} : { deadlineMs: options.deadlineMs },
            {},
          );
          return state;
        } catch (error) {
          return authShape(AuthState.UNAVAILABLE, AuthReason.UNREADABLE, null);
        }
      },
      forceRefresh: async (options) => {
        try {
          return await renew(options == null || options.deadlineMs == null ? {} : { deadlineMs: options.deadlineMs }, {});
        } catch (error) {
          return { ok: false, token: null, state: AuthState.UNAVAILABLE, reason: AuthReason.UNREADABLE, epoch: '', generation: null };
        }
      },
    };
  }

  // The bare-accessor adapter, kept for the one case that still needs it: a caller (and a suite)
  // that injects `deps.getAccessToken` is describing a token source, not an auth policy, and has no
  // typed states to offer. A read that THROWS is unavailable, never unlinked — a locked keychain is
  // not evidence that the user signed out.
  function adaptedAuth() {
    return {
      getAuthState: async (options) => {
        try {
          if (options != null && options.fresh) invalidateToken();
          const token = await getToken();
          return token
            ? authShape(AuthState.READY, AuthReason.NONE, token)
            : authShape(AuthState.UNLINKED, AuthReason.MISSING, null);
        } catch (error) {
          return authShape(AuthState.UNAVAILABLE, AuthReason.UNREADABLE, null);
        }
      },
      forceRefresh: async () => {
        try {
          invalidateToken();
          // `forceRefresh` and not a plain read: the stored access token still looks healthy by its
          // own `expires_at` — the portal's 401 is the only evidence it is not — so an ordinary read
          // hands back the very token that was just rejected and the retry 401s by construction.
          // lib/token.mjs's flag is what makes it exchange the refresh token instead.
          const token = await getToken({}, { forceRefresh: true });
          if (token) return { ok: true, token, state: AuthState.READY, reason: AuthReason.NONE, epoch: '', generation: null };
          return { ok: false, token: null, state: AuthState.REAUTH_REQUIRED, reason: AuthReason.MISSING, epoch: '', generation: null };
        } catch (error) {
          return { ok: false, token: null, state: AuthState.UNAVAILABLE, reason: AuthReason.UNREADABLE, epoch: '', generation: null };
        }
      },
    };
  }

  function defaultAuth() {
    return deps.getAccessToken == null ? typedAuth() : adaptedAuth();
  }

  const authApi = deps.auth == null ? defaultAuth() : deps.auth;

  // One forced refresh, however many requests hit a 401 at the same time. Each of them then retries
  // once with whatever this produced; the memo is cleared in `finally`, so a later 401 can refresh
  // again instead of being stuck behind a settled promise. Concurrent refreshes would each register
  // their own token exchange and race on the credential store.
  function refreshOnce() {
    if (refreshing == null) {
      refreshing = (async () => {
        const deadline = startDeadline(handshakeMs, false);
        try {
          const result = await guard(deadline, Promise.resolve(authApi.forceRefresh({ deadlineMs: handshakeMs })), null);
          if (result == null || typeof result !== 'object') {
            return { ok: false, token: null, state: AuthState.UNAVAILABLE, reason: AuthReason.UNREADABLE };
          }
          return result;
        } catch (error) {
          // A refresh that could not be completed is not a refresh that proved anything about the
          // stored credential, so nothing is deleted and the caller is told it was temporary.
          return { ok: false, token: null, state: AuthState.UNAVAILABLE, reason: AuthReason.UNREADABLE };
        } finally {
          deadline.dispose();
        }
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function readAuthState(fresh) {
    const deadline = startDeadline(handshakeMs, false);
    try {
      const state = await guard(deadline, Promise.resolve(authApi.getAuthState({ deadlineMs: handshakeMs, fresh: fresh === true })), null);
      if (state == null || typeof state !== 'object' || typeof state.state !== 'string') {
        return authShape(AuthState.UNAVAILABLE, AuthReason.UNREADABLE, null);
      }
      return state;
    } catch (error) {
      return authShape(AuthState.UNAVAILABLE, error != null && error.timedOut ? AuthReason.TIMEOUT : AuthReason.UNREADABLE, null);
    } finally {
      deadline.dispose();
    }
  }

  // ---- deadlines -----------------------------------------------------------

  function timeoutError(budgetMs) {
    const error = new Error(`timed out after ${budgetMs}ms`);
    error.timedOut = true;
    return error;
  }

  // A deadline owns one abort controller and one timer. `idleResettable` is the whole difference
  // between tool latency and a handshake: a tool call may take as long as it likes provided the
  // server keeps talking, while the handshake gets an absolute cap no amount of progress extends.
  function startDeadline(budgetMs, idleResettable) {
    const AbortControllerImpl = resolveAbortController();
    const controller = new AbortControllerImpl();
    const state = { expired: false, timer: null, done: false };
    const fire = () => {
      state.timer = null;
      state.expired = true;
      try {
        controller.abort();
      } catch (error) {
        /* an abort that throws must not replace the failure it was reporting */
      }
    };
    const arm = () => {
      const timer = setTimeoutImpl(fire, budgetMs);
      if (timer != null && typeof timer.unref === 'function') timer.unref();
      state.timer = timer;
    };
    arm();
    return {
      budgetMs,
      signal: controller.signal,
      get expired() {
        return state.expired;
      },
      touch() {
        if (!idleResettable || state.expired || state.done) return;
        if (state.timer != null) clearTimeoutImpl(state.timer);
        arm();
      },
      dispose() {
        state.done = true;
        if (state.timer != null) clearTimeoutImpl(state.timer);
        state.timer = null;
      },
    };
  }

  // Runs `promise` under a deadline. The cancellation hook is what keeps a body read interruptible:
  // native fetch honours the signal, but the Node-13 fallback transport does not, so the reader is
  // torn down explicitly. The original promise always has both handlers attached, so a late
  // settlement after the deadline can never surface as an unhandled rejection.
  function guard(deadline, promise, cancel) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (typeof cancel === 'function') {
          try {
            cancel();
          } catch (error) {
            /* bounded cleanup failure */
          }
        }
        reject(timeoutError(deadline.budgetMs));
      };
      if (deadline.signal.aborted) {
        onAbort();
        return;
      }
      deadline.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          deadline.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          deadline.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  // ---- message shapes ------------------------------------------------------

  // `JSON.parse('null')` and `JSON.parse('7')` both succeed, so handleLine's guard lets non-objects
  // through — and these run before the token check, on the very path that exists to keep an
  // unlinked server alive. An unguarded deref here throws outside handleMessage's try/catch and
  // takes the whole bridge down with an unhandled rejection.
  const methodOf = (msg) => (msg && !Array.isArray(msg) ? msg.method : undefined);
  const isInitialize = (msg) => methodOf(msg) === 'initialize';
  const isToolsList = (msg) => methodOf(msg) === 'tools/list';
  // Which locally-served tool, if any, a message is calling.
  const localToolCall = (msg) => {
    if (methodOf(msg) !== 'tools/call') return null;
    const params = msg.params;
    const called = params == null ? undefined : params.name;
    const tool = LOCAL_TOOLS.find((t) => t.name === called);
    return tool == null ? null : tool.name;
  };

  // Ids of the requests in the message (single or legacy batch); responses and notifications carry
  // none and get no synthesized error. A null id is not a request id in JSON-RPC 2.0 — answering
  // one would put a reply on the wire that no client is waiting for.
  function requestIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.id !== null && m.method !== undefined)
      .map((m) => m.id);
  }

  function writeMessage(obj) {
    write(JSON.stringify(obj));
  }

  // The per-message bookkeeping that makes "exactly one terminal reply per accepted id" true.
  // Everything written while handling a message goes through here: an upstream response that
  // already answered an id closes it out, a second reply for that id is dropped rather than
  // duplicated, and anything still open when handling ends is answered rather than abandoned.
  function createReply(ids) {
    const pending = new Set(ids);
    const settled = new Set();

    const terminalId = (m) => {
      if (m == null || typeof m !== 'object' || Array.isArray(m)) return undefined;
      if (m.id === undefined || m.id === null) return undefined;
      if (!hasOwn(m, 'result') && !hasOwn(m, 'error')) return undefined;
      return m.id;
    };

    // false => this message must not be written (it would be a second answer for that id).
    const claim = (m) => {
      const id = terminalId(m);
      if (id === undefined) return true;
      if (settled.has(id)) return false;
      if (pending.has(id)) {
        pending.delete(id);
        settled.add(id);
      }
      return true;
    };

    return {
      send(obj) {
        if (Array.isArray(obj)) {
          const kept = obj.filter(claim);
          if (kept.length) writeMessage(kept);
          return;
        }
        if (!claim(obj)) {
          logError('suppressed a duplicate response for an already-answered request');
          return;
        }
        writeMessage(obj);
      },
      error(id, message) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
      },
      // Answers every id this message accepted that has not been answered yet. Ids already
      // answered upstream are skipped, which is what keeps a late transport failure from
      // duplicating a response that already went out.
      errorAll(message) {
        for (const id of Array.from(pending)) this.error(id, message);
      },
      finish() {
        for (const id of Array.from(pending)) this.error(id, UNANSWERED_MESSAGE);
      },
    };
  }

  // ---- transport -----------------------------------------------------------

  async function post(msg, token, deadline) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
      ...machineHeaders(),
    };
    return guard(
      deadline,
      Promise.resolve(fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
        signal: deadline.signal,
      })),
      null,
    );
  }

  async function readAll(stream, deadline) {
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const step = await guard(deadline, Promise.resolve(stream.read()), stream.cancel);
      if (step == null || step.done) break;
      if (step.value != null) text += decoder.decode(step.value, { stream: true });
    }
    return text + decoder.decode();
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so each lands as one
  // line. `silent` drains instead — used for the transparent re-initialize, whose response the
  // client must not see twice. `transform` rewrites each message on the way out. The deadline stays
  // live for the whole body: clearing it at headers is how a hung stream used to strand an id.
  async function emit(res, deadline, options) {
    const opts = options == null ? {} : options;
    const silent = opts.silent === true;
    const transform = opts.transform == null ? ((m) => m) : opts.transform;
    const out = (m) => {
      if (silent) return;
      // Every visible message goes through the reply, which is what keeps one terminal answer per
      // id true. A non-silent emit with no reply channel would write around that bookkeeping, so it
      // is a programming error rather than a fallback.
      if (opts.reply == null) throw new Error('emit: a visible response needs a reply channel');
      opts.reply.send(m);
    };

    const newSession = res.headers.get(SESSION_HEADER);
    if (newSession) sessionId = newSession;
    if (res.status === 202 || res.status === 204) return;

    const contentType = res.headers.get('content-type');
    const isSse = (contentType == null ? '' : contentType).includes('text/event-stream');
    const stream = openBody(res);
    if (stream == null) return;

    try {
      if (!isSse) {
        const text = await readAll(stream, deadline);
        if (text) out(transform(JSON.parse(text)));
        return;
      }
      const push = createSseParser();
      for (;;) {
        const step = await guard(deadline, Promise.resolve(stream.read()), stream.cancel);
        if (step == null || step.done) break;
        // Progress is progress: it re-arms a tool's idle budget. A handshake deadline ignores this
        // (it was created non-resettable), so no amount of streaming extends the handshake.
        deadline.touch();
        if (step.value == null) continue;
        for (const data of push(step.value)) out(transform(JSON.parse(data)));
      }
    } catch (error) {
      stream.cancel();
      throw error;
    }
  }

  // The portal serves neither of the local tools — it authenticates by bearer token and knows
  // nothing about this machine's hooks — so the bridge appends them to every tool listing. Without
  // this, a link revoked mid-session leaves the model with no listed way to recover, and "why is
  // nothing being tracked?" has no answer that does not involve a sandboxed shell.
  const withLocalTools = (msg) => {
    const result = msg == null ? undefined : msg.result;
    const listed = result == null ? undefined : result.tools;
    if (!Array.isArray(listed)) return msg;
    const missing = LOCAL_TOOLS.filter((t) => !listed.some((u) => u != null && u.name === t.name));
    return missing.length
      ? { ...msg, result: { ...msg.result, tools: [...msg.result.tools, ...missing] } }
      : msg;
  };

  // The portal's MCP sessions are in-memory; an API restart between turns loses them (HTTP 404).
  // Rebuild one transparently — replay initialize (response hidden) and the initialized
  // notification — so the client never notices. Its own deadline, so one request's cancellation
  // cannot cut short a handshake other requests are waiting on; and the memo is cleared in
  // `finally`, so a failed rebuild does not poison the next request.
  function reinitialize(token) {
    if (reinit == null) {
      reinit = (async () => {
        const deadline = startDeadline(handshakeMs, false);
        try {
          sessionId = null;
          const res = await post(initializeMsg, token, deadline);
          if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
          await emit(res, deadline, { silent: true });
          const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, deadline);
          // Silent as well: a replayed handshake's acknowledgement is not the client's to see.
          await emit(ack, deadline, { silent: true });
          upstreamReady = true;
          clearIssueMemo();
        } finally {
          deadline.dispose();
        }
      })().finally(() => {
        reinit = null;
      });
    }
    return reinit;
  }

  // ---- diagnostics (consent-gated recorder is injected; default is a no-op) --

  const recordedIssues = new Set();
  const clearIssueMemo = () => recordedIssues.clear();

  // Structured only: a code, where it happened, the HTTP status, a reason and how long it took.
  // No RPC arguments, no response bodies, no URLs, no token. Deduped until the outage clears, and
  // wrapped so a failing recorder can never change how the request completes.
  function noteIssue(code, status, reason, startedAt) {
    try {
      const key = `${code}|${status}|${reason}`;
      if (recordedIssues.has(key)) return;
      recordedIssues.add(key);
      recordIssue(code, { source: 'mcp_bridge', status, reason, durationMs: now() - startedAt });
    } catch (error) {
      /* diagnostics are best-effort by construction */
    }
  }

  // Only a real upstream failure is a defect. Not being signed in is a state, not an incident, and
  // recording it would turn every fresh install into a diagnostic report.
  function noteHandshakeFailure(error, status, startedAt) {
    if (error != null && error.timedOut) {
      noteIssue('mcp_handshake_timeout', status, 'timeout', startedAt);
      return;
    }
    noteIssue('mcp_startup_failed', status, status ? 'http_error' : 'transport', startedAt);
  }

  // ---- recovery watcher ----------------------------------------------------

  let watcher = null;
  let probing = false;
  // Consecutive probes that found no usable credential, and how many ticks have passed since the
  // last one ran. Together they are the backoff: 1, 2, 4, 8 then 16 ticks.
  let notReadyStreak = 0;
  let ticksWaited = 0;

  function ticksPerProbe() {
    let ticks = 1;
    for (let i = 0; i < notReadyStreak && ticks < MAX_RECOVERY_BACKOFF_TICKS; i += 1) ticks *= 2;
    return ticks;
  }

  // Armed when the bridge is degraded — upstream unreachable, or credentials not usable yet — and
  // only once the client has handshaken, since the saved initialize is the only thing worth
  // replaying. Unref'd: a bridge waiting for the world to come back must not be the reason the
  // process stays alive.
  function watchForRecovery() {
    if (disposed || watcher != null || initializeMsg == null || upstreamReady) return;
    ticksWaited = 0;
    watcher = setIntervalImpl(() => {
      ticksWaited += 1;
      if (ticksWaited < ticksPerProbe()) return;
      ticksWaited = 0;
      probe().catch(() => {});
    }, recoveryMs);
    if (watcher != null && typeof watcher.unref === 'function') watcher.unref();
  }

  function stopWatching() {
    if (watcher == null) return;
    clearIntervalImpl(watcher);
    watcher = null;
  }

  // One probe at a time, each with its own deadline: a hung probe that never cleared its flag would
  // wedge recovery permanently — the exact failure the watcher exists to undo. Replays the saved
  // initialize and nothing else: replaying a tool call would run it a second time.
  async function probe() {
    if (disposed || probing) return;
    probing = true;
    try {
      // A request of its own may have rebuilt the session between the interval firing and this
      // probe running; there is nothing left to recover and nothing to announce.
      if (upstreamReady) {
        stopWatching();
        return;
      }
      const auth = await readAuthState(true);
      if (auth.state !== AuthState.READY) {
        // Not signed in, or the store could not be read. Nothing here changes without the user
        // doing something, so ask less often until it does.
        notReadyStreak += 1;
        return;
      }
      notReadyStreak = 0;
      if (disposed || initializeMsg == null) return;
      // Through the SHARED replay, never a second copy of it: a probe racing a request's own
      // reinitialize would null the session id twice, and one of the two would then acknowledge a
      // session the other had already replaced. It carries its own deadline and sets upstreamReady.
      await reinitialize(auth.token);
      if (disposed) return;
      stopWatching();
      // Announced once per recovery: the tools the client could not see are there now. A later
      // outage re-arms the watcher, and its recovery announces again.
      writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch (error) {
      logError(`recovery probe failed: ${error == null || error.message == null ? error : error.message}`);
    } finally {
      probing = false;
    }
  }

  // ---- local tools ---------------------------------------------------------

  const toolText = (reply, id, text, isError = false) => {
    reply.send({ jsonrpc: '2.0', id, result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] } });
  };

  async function runLocalTool(name, id, reply) {
    if (name === STATUS_TOOL.name) return runStatusTool(id, reply);
    return runLoginTool(id, reply);
  }

  // One sign-in at a time. performLogin binds a loopback port, registers an OAuth client and opens
  // a browser; a second concurrent run registers a second client, opens a second window, and races
  // the first on the credential store — whichever setCredentials lands last silently wins, and the
  // loser's registered client is orphaned server-side. Refused rather than queued: the user is
  // looking at a browser tab right now, and queueing would open another one behind it.
  let loginInFlight = false;

  // How long the login tool waits for the whole browser round-trip before answering with the URL
  // and letting the rest finish in the background. Short enough to beat any client-side request
  // timeout, long enough that an already-authenticated user (whose browser round-trip takes a
  // second) still gets the plain "signed in" answer.
  const GRACE_MS = deps.loginGraceMs == null ? 25000 : deps.loginGraceMs;

  // Sign in, then tell the client its tool list changed so the drafting tools appear without a
  // restart. The flow is silent by design: this process's stdout is the JSON-RPC channel, so the
  // authorize URL travels back inside the tool result instead of being printed.
  async function runLoginTool(id, reply) {
    if (loginInFlight) {
      toolText(
        reply,
        id,
        'A Beezi sign-in is already in progress — finish it in the browser window that opened, then retry.',
        true,
      );
      return;
    }
    loginInFlight = true;
    let authorizeUrl = null;
    let browserFailed = null;
    const onStep = (s) => {
      if (s.type === 'authorize-url') authorizeUrl = s.url;
      if (s.type === 'browser-failed') browserFailed = s;
    };

    const login = performLogin({ onStep });
    // performLogin rewrites the credential store either way it lands: it stores a fresh token on
    // success, and on the already-linked check it *deletes* the stored one when the portal rejects
    // it (lib/login.mjs). So the memo in lib/token.mjs is stale the moment this settles, however it
    // settles. Hung off the promise rather than the answer paths below because the grace period can
    // answer the client long before the browser round-trip finishes — and it is registered first so
    // the memo is already gone by the time those paths run. Both handlers return normally, so the
    // derived promise never rejects and cannot become an unhandled rejection of its own.
    login.then(invalidateToken, invalidateToken);
    // Never let the background continuation surface as an unhandled rejection — Node makes those
    // fatal, and this server has to survive a failed sign-in for the rest of the session.
    login.catch(() => {});

    const settled = await Promise.race([
      login.then((result) => ({ result })).catch((error) => ({ error })),
      // The whole point of the grace period: the rest of this flow waits on a human in a browser.
      // Blocking the JSON-RPC request for that is what showed up as a tool call that never returns
      // — the client spins with no output, and if the browser never opened there is nothing on
      // screen to act on. Answer with the URL instead, and let the link complete in the background.
      new Promise((resolve) => {
        const graceTimer = setTimeoutImpl(() => resolve({ pending: true }), GRACE_MS);
        if (graceTimer != null && typeof graceTimer.unref === 'function') graceTimer.unref();
      }),
    ]);

    if (settled.pending) {
      const lines = browserFailed
        ? [`Could not open a browser automatically${browserFailed.detail ? ` (${browserFailed.detail})` : ''}.`]
        : ['A browser window was opened for you to sign in.'];
      if (authorizeUrl) lines.push(`Open this URL to finish signing in: ${authorizeUrl}`);
      lines.push('The sign-in is still running here — once you have finished in the browser, call beezi_status to confirm the machine is linked.');
      toolText(reply, id, lines.join('\n'));
      // The link still completes (or fails) on its own; announce the new tool list when it lands.
      login
        .then(() => writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
        .catch((error) => logError(`background sign-in failed: ${error == null || error.message == null ? error : error.message}`))
        .finally(() => { loginInFlight = false; });
      return;
    }

    loginInFlight = false;
    if (settled.error) {
      const detail = settled.error == null || settled.error.message == null
        ? String(settled.error)
        : settled.error.message;
      const fallback = authorizeUrl ? ` Open this URL to finish signing in: ${authorizeUrl}` : '';
      toolText(reply, id, `Beezi sign-in failed: ${detail}.${fallback}`, true);
      return;
    }
    const { result } = settled;
    const account = result.account ? ` as ${result.account}` : '';
    const where = result.apiBase ? ` (API: ${result.apiBase})` : '';
    const text = result.type === 'already-linked'
      ? `This machine is already linked to Beezi${account}${where}.`
      : `Signed in to Beezi${account}. This machine is now linked; the Beezi tools are available.`;
    toolText(reply, id, text);
    writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  async function runStatusTool(id, reply) {
    try {
      const status = await linkStatus();
      const reporting = describeReporting(status);
      toolText(reply, id, [describeLink(status), reporting].filter(Boolean).join('\n'));
    } catch (error) {
      toolText(reply, id, `Beezi status check failed: ${error == null || error.message == null ? String(error) : error.message}`, true);
    }
  }

  // ---- local answers -------------------------------------------------------

  // Answering `initialize` ourselves is what keeps Cursor's session alive when the portal is not
  // reachable or the machine is not linked. `unavailable` is the distinction that matters: a
  // handshake that timed out says nothing about whether the user is signed in, and telling them
  // they are "not linked" sends them to relink a session that was never broken.
  function localInitialize(msg, reply, unavailable) {
    reply.send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion:
          msg.params != null && msg.params.protocolVersion != null
            ? msg.params.protocolVersion
            : PROTOCOL_VERSION,
        // listChanged: the tool set grows the moment the machine is linked, or the moment the
        // portal answers again.
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: 'beezi',
          title: unavailable ? 'Beezi (unavailable)' : 'Beezi (not linked)',
          version: '0.0.0',
        },
        instructions: unavailable
          ? 'The Beezi service is unavailable from this machine right now, so only the local sign-in and status tools are listed. This machine’s Beezi link is unaffected; the remaining tools appear on their own once the service answers again.'
          : 'This machine is not linked to Beezi. Call beezi_login to link it; the remaining tools appear once it is.',
      },
    });
  }

  // Unlinked, refreshing, unreadable or rejected: keep the server alive and useful. `initialize`
  // succeeds locally, the tool list holds the local tools so the model has an obvious way out,
  // notifications are dropped, and any other request is refused with the reason — which is never
  // "you are not linked" unless that is what the auth API actually said.
  async function handleWithoutUpstream(msg, reply, state) {
    if (isInitialize(msg)) {
      localInitialize(msg, reply, state !== AuthState.UNLINKED && state !== AuthState.REAUTH_REQUIRED);
      watchForRecovery();
      return;
    }
    if (isToolsList(msg)) {
      reply.send({ jsonrpc: '2.0', id: msg.id, result: { tools: [...LOCAL_TOOLS] } });
      return;
    }
    reply.errorAll(authMessage(state));
  }

  async function serverErrorMessage(res, deadline) {
    try {
      const stream = openBody(res);
      const text = stream == null ? '' : await readAll(stream, deadline);
      const body = text ? JSON.parse(text) : null;
      const err = body == null ? undefined : body.error;
      // `body.error.message` first, then `body.message` — both are shapes the portal emits, and
      // neither is trusted prose.
      const message = sanitizeServerMessage(err == null ? undefined : err.message)
        || sanitizeServerMessage(body == null ? undefined : body.message);
      if (message) return `Beezi MCP error: ${message}`;
    } catch (error) {
      /* non-JSON body, or a body that stopped arriving: the status is still worth reporting */
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
  }

  // The refusal a 403 carries, if the portal sent one: `body.error.message` first, then
  // `body.message`, both sanitized and truncated, both read under the request's own deadline so a
  // body that stops arriving cannot hold the request open. Always ends with why signing in again
  // will not help — that is the wrong move this whole branch exists to prevent.
  async function forbiddenMessage(res, deadline) {
    const message = await serverErrorMessage(res, deadline);
    const detail = message.indexOf('Beezi MCP error:') === 0
      ? message
      : `Beezi refused this request for this account (HTTP ${res.status}).`;
    return `${detail} This is a permission or plan restriction, not a sign-in problem — signing in again will not change it.`;
  }

  // ---- the request path ----------------------------------------------------

  async function forward(msg, initialToken, reply, startedAt) {
    const handshake = isInitialize(msg);
    let token = initialToken;
    let retried = false;
    // One transparent session rebuild per MESSAGE, not per attempt: a portal that answers 404 to a
    // session it just handed out is not a session problem, and a retried request must not double
    // the rebuilds.
    let rebuilt = false;

    for (;;) {
      // Fresh budget per attempt: the retry of a rejected request is a new request on the wire.
      const deadline = startDeadline(handshake ? handshakeMs : timeoutMs, !handshake);
      try {
        if (!upstreamReady && initializeMsg != null && !handshake) await reinitialize(token);
        let res = await post(msg, token, deadline);
        if (res.status === 404 && !rebuilt && initializeMsg != null && !handshake) {
          rebuilt = true;
          await reinitialize(token);
          res = await post(msg, token, deadline);
        }

        if (res.ok) {
          if (handshake) {
            upstreamReady = true;
            clearIssueMemo();
            stopWatching();
          }
          await emit(res, deadline, { reply, transform: isToolsList(msg) ? withLocalTools : undefined });
          return;
        }

        // An explicit 401 is the server saying THIS TOKEN is not valid — the one case where a
        // forced refresh and a single retry are justified. It is also the only thing that drops
        // the token memo (forceRefresh goes back to the credential store), so a link revoked
        // mid-session recovers without restarting Cursor. Network timeouts and ambiguous
        // completions get neither: they are no evidence the tool did not already run.
        if (res.status === 401) {
          if (!retried) {
            const refreshed = await refreshOnce();
            if (refreshed != null && refreshed.ok && refreshed.token) {
              retried = true;
              token = refreshed.token;
              continue;
            }
            // No usable token came back. Retrying with the one the server just rejected would only
            // produce a second 401, so say which of the two it was and stop.
            if (handshake) {
              localInitialize(msg, reply, false);
              watchForRecovery();
              return;
            }
            const state = refreshed == null || typeof refreshed.state !== 'string'
              ? AuthState.REAUTH_REQUIRED
              : refreshed.state;
            reply.errorAll(authMessage(state));
            return;
          }
          // Rejected again with a freshly refreshed token: relinking is the only way out, and a
          // second refresh would be a loop.
          if (handshake) {
            localInitialize(msg, reply, false);
            watchForRecovery();
            return;
          }
          reply.errorAll(REJECTED_MESSAGE);
          return;
        }
        // 403 is authorization: the credentials were ACCEPTED and the account was refused. No
        // refresh, no OAuth, and nothing invalidated — relinking cannot grant a plan, and
        // discarding a working credential to "fix" it destroys a session that was never wrong.
        if (res.status === 403) {
          const refusal = await forbiddenMessage(res, deadline);
          if (handshake) {
            localInitialize(msg, reply, true);
            watchForRecovery();
            return;
          }
          reply.errorAll(refusal);
          return;
        }

        const message = await serverErrorMessage(res, deadline);
        if (handshake) {
          noteHandshakeFailure(null, res.status, startedAt);
          localInitialize(msg, reply, true);
          watchForRecovery();
          return;
        }
        reply.errorAll(message);
        return;
      } catch (error) {
        // A failed handshake must never fail the handshake: Cursor treats that as a broken plugin
        // and takes the skill down with it. Answer locally, and start watching for the portal.
        if (handshake) {
          noteHandshakeFailure(error, 0, startedAt);
          localInitialize(msg, reply, true);
          watchForRecovery();
          return;
        }
        if (!upstreamReady) watchForRecovery();
        throw error;
      } finally {
        deadline.dispose();
      }
    }
  }

  async function handleMessage(msg) {
    const reply = createReply(requestIds(msg));
    const startedAt = now();
    try {
      // Remembered even while unlinked, so a link acquired mid-session — or a portal that comes
      // back — can replay the client's own handshake rather than inventing one.
      if (isInitialize(msg)) {
        initializeMsg = msg;
        sessionId = null;
        upstreamReady = false;
      }

      // Local tools answer in EVERY auth state, including the ones where the credential store
      // could not be read: they are the only way out of those states.
      const local = localToolCall(msg);
      if (local) {
        await runLocalTool(local, msg.id, reply);
        return;
      }

      const auth = await readAuthState();
      if (auth.state !== AuthState.READY || !auth.token) {
        await handleWithoutUpstream(msg, reply, auth.state);
        return;
      }
      await forward(msg, auth.token, reply, startedAt);
    } catch (error) {
      reply.errorAll(`Beezi MCP request failed: ${error == null || error.message == null ? String(error) : error.message}`);
    } finally {
      // Whatever happened above, no accepted id is left without an answer.
      reply.finish();
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  // Called when stdin closes: nothing this bridge scheduled may keep the process alive or write to
  // a stdout nobody is reading any more.
  function dispose() {
    disposed = true;
    stopWatching();
  }

  return { handleLine, handleMessage, dispose };
}
