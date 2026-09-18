import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, sanitizeServerMessage, LOGIN_TOOL, STATUS_TOOL } from '../lib/mcp-bridge.mjs';

// Authentication is not authorization. A missing token, an unreadable store, a refresh in progress,
// an expired sign-in, a rejected token and a refused ACCOUNT are six different situations, and the
// bridge used to answer four of them with "this machine is not linked" — which sends the user to
// relink a session that was never broken, deleting credentials to fix a problem they never had.
const URL_UNDER_TEST = 'https://api.test/api/mcp';
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_ticket' } };
const CALL_RESULT = { jsonrpc: '2.0', id: 1, result: { content: [] } };
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// CONTRACTS §2 shapes, faked until lib/token.mjs grows the real ones. `getAuthState` never throws
// and never deletes credentials; `forceRefresh` is locked and one-per-caller.
function fakeAuth(options = {}) {
  const stats = { reads: 0, refreshes: 0 };
  const ready = { state: 'ready', reason: 'none', token: 'tok', generation: 1, epoch: 'env|t|u|1', account: null };
  return {
    stats,
    getAuthState: async () => {
      stats.reads += 1;
      if (typeof options.getAuthState === 'function') return options.getAuthState(stats.reads);
      return options.state == null ? ready : options.state;
    },
    forceRefresh: async () => {
      stats.refreshes += 1;
      if (typeof options.forceRefresh === 'function') return options.forceRefresh(stats.refreshes);
      return { ok: true, token: 'tok2', state: 'ready', reason: 'none', epoch: 'env|t|u|1', generation: 2 };
    },
  };
}

function bridgeWith({ responses = [], auth, ...rest } = {}) {
  const calls = [];
  const out = [];
  const stats = { invalidated: 0 };
  const bridge = createBridge({
    url: URL_UNDER_TEST,
    auth,
    getAccessToken: async () => 'tok',
    invalidateTokenCache: () => { stats.invalidated += 1; },
    fetchImpl: async (url, init) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (next == null) throw new Error('no response queued');
      if (next instanceof Error) throw next;
      return next;
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
    ...rest,
  });
  return { bridge, calls, out, stats };
}

// ---------------------------------------------------------------------------
// Typed auth states
// ---------------------------------------------------------------------------

const stateCases = [
  ['unlinked', { state: 'unlinked', reason: 'missing', token: null }, /not linked/i, new RegExp(LOGIN_TOOL.name)],
  ['reauth_required', { state: 'reauth_required', reason: 'invalid_grant', token: null }, /expired/i, new RegExp(LOGIN_TOOL.name)],
  ['refreshing', { state: 'refreshing', reason: 'locked', token: null }, /refreshing/i, /retry/i],
  ['unavailable', { state: 'unavailable', reason: 'unreadable', token: null }, /could not read/i, /does not mean the machine was unlinked/i],
  ['forbidden', { state: 'forbidden', reason: 'none', token: null }, /not allowed/i, /will not change/i],
];

for (const [name, state, first, second] of stateCases) {
  test(`auth state ${name} gets its own answer, and never reaches the network`, { timeout: 5000 }, async () => {
    const auth = fakeAuth({ state });
    const { bridge, calls, out, stats } = bridgeWith({ auth });
    await bridge.handleMessage(CALL);

    assert.equal(calls.length, 0);
    assert.equal(out.length, 1);
    assert.match(out[0].error.message, first);
    assert.match(out[0].error.message, second);
    assert.equal(auth.stats.refreshes, 0, 'nothing here is fixed by a refresh');
    assert.equal(stats.invalidated, 0, 'and nothing here justifies dropping a credential');
  });

  test(`auth state ${name} still answers initialize and lists the local tools`, { timeout: 5000 }, async () => {
    const { bridge, out } = bridgeWith({ auth: fakeAuth({ state }) });
    await bridge.handleMessage(INIT);
    await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(out[0].result.capabilities.tools.listChanged, true);
    assert.deepEqual(out[1].result.tools.map((t) => t.name), [LOGIN_TOOL.name, STATUS_TOOL.name]);
  });

  test(`the local tools are callable in auth state ${name}`, { timeout: 5000 }, async () => {
    const { bridge, out } = bridgeWith({
      auth: fakeAuth({ state }),
      linkStatus: async () => ({ state: 'linked', account: 'Dev', apiBase: 'https://api.test/api', hooks: { bundled: true, user: { state: 'installed', registered: ['x'] } } }),
    });
    await bridge.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: STATUS_TOOL.name } });
    assert.equal(out[0].result.isError, undefined, 'status is how a user finds out which state they are in');
  });
}

test('a credential read that throws is unavailable, not an unlinking', { timeout: 5000 }, async () => {
  const auth = fakeAuth({ getAuthState: () => { throw new Error('keychain locked'); } });
  const { bridge, out, stats } = bridgeWith({ auth });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /could not read/i);
  assert.ok(!/not linked/i.test(out[0].error.message));
  assert.equal(stats.invalidated, 0);
  assert.equal(auth.stats.refreshes, 0);
});

// ---------------------------------------------------------------------------
// 401: authentication. One forced refresh, one retry, same id.
// ---------------------------------------------------------------------------

test('an explicit 401 forces one refresh and retries the same request once', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, calls, out } = bridgeWith({
    auth,
    responses: [new Response(null, { status: 401 }), jsonRes(CALL_RESULT)],
  });
  await bridge.handleMessage(CALL);

  assert.equal(auth.stats.refreshes, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].headers.Authorization, 'Bearer tok2', 'the retry uses the refreshed token');
  assert.deepEqual(calls[1].body, CALL, 'same request, same JSON-RPC id');
  assert.deepEqual(out, [CALL_RESULT], 'one reply, not two');
});

test('a second 401 stops: no second refresh, no retry loop, one reply', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, calls, out } = bridgeWith({
    auth,
    responses: [new Response(null, { status: 401 }), new Response(null, { status: 401 })],
  });
  await bridge.handleMessage(CALL);

  assert.equal(auth.stats.refreshes, 1);
  assert.equal(calls.length, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /rejected this machine/i);
});

test('a refresh that cannot produce a token gives truthful reauth guidance, not a loop', { timeout: 5000 }, async () => {
  const auth = fakeAuth({ forceRefresh: () => ({ ok: false, token: null, state: 'reauth_required', reason: 'invalid_grant', epoch: 'e', generation: null }) });
  const { bridge, calls, out } = bridgeWith({ auth, responses: [new Response(null, { status: 401 })] });
  await bridge.handleMessage(CALL);

  assert.equal(calls.length, 1, 'retrying with a token that was never issued is just a second 401');
  assert.equal(auth.stats.refreshes, 1);
  assert.equal(out.length, 1);
  assert.match(out[0].error.message, /expired/i);
  assert.match(out[0].error.message, new RegExp(LOGIN_TOOL.name));
});

test('a refresh that fails transiently does not invalidate anything', { timeout: 5000 }, async () => {
  const auth = fakeAuth({ forceRefresh: () => ({ ok: false, token: null, state: 'unavailable', reason: 'http_5xx', epoch: 'e', generation: null }) });
  const { bridge, out, stats } = bridgeWith({ auth, responses: [new Response(null, { status: 401 })] });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /could not read|temporar/i);
  assert.equal(stats.invalidated, 0, 'a store that could not be refreshed is not a store to be emptied');
});

test('concurrent 401s share one refresh, and each retries once', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const auth = fakeAuth({
    forceRefresh: async () => {
      await gate;
      return { ok: true, token: 'tok2', state: 'ready', reason: 'none', epoch: 'e', generation: 2 };
    },
  });
  const { bridge, calls, out } = bridgeWith({
    auth,
    responses: [
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
      jsonRes(CALL_RESULT),
      jsonRes({ jsonrpc: '2.0', id: 2, result: { content: [] } }),
    ],
  });

  const a = bridge.handleMessage(CALL);
  const b = bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'draft_ticket' } });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);

  assert.equal(auth.stats.refreshes, 1, 'two rejected requests must not each start their own OAuth refresh');
  assert.equal(calls.length, 4);
  assert.deepEqual(out.map((m) => m.id).sort(), [1, 2]);
});

test('a network timeout is never retried — it is no evidence the tool did not run', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, calls, out } = bridgeWith({ auth, responses: [new Error('socket hang up')] });
  await bridge.handleMessage(CALL);
  assert.equal(calls.length, 1);
  assert.equal(auth.stats.refreshes, 0);
  assert.equal(out.length, 1);
});

test('an ambiguous completion is never retried either', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  // 202 for a request: accepted, no result. Retrying would run the tool a second time.
  const { bridge, calls, out } = bridgeWith({ auth, responses: [new Response(null, { status: 202 })] });
  await bridge.handleMessage(CALL);
  assert.equal(calls.length, 1);
  assert.equal(auth.stats.refreshes, 0);
  assert.equal(out.length, 1);
  assert.match(out[0].error.message, /not confirmed as run/i);
});

test('a 401 on the handshake refreshes once and still answers the client', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, calls, out } = bridgeWith({
    auth,
    responses: [new Response(null, { status: 401 }), new Response(null, { status: 401 })],
  });
  await bridge.handleMessage(INIT);
  assert.equal(auth.stats.refreshes, 1);
  assert.equal(calls.length, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].error, undefined, 'a rejected credential must not fail the handshake');
  assert.match(out[0].result.serverInfo.title, /not linked/i);
});

// ---------------------------------------------------------------------------
// 403: authorization. No refresh, no invalidation, no OAuth.
// ---------------------------------------------------------------------------

test('403 explains the refusal and changes nothing about the credentials', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  let loginStarted = 0;
  const { bridge, calls, out, stats } = bridgeWith({
    auth,
    performLogin: async () => { loginStarted += 1; return { type: 'linked' }; },
    responses: [jsonRes({ error: { message: 'Ticket drafting is not included in your plan.' } }, { status: 403 })],
  });
  await bridge.handleMessage(CALL);

  assert.equal(calls.length, 1, 'a plan denial is not retried');
  assert.equal(auth.stats.refreshes, 0, 'relogin cannot fix a plan denial');
  assert.equal(stats.invalidated, 0);
  assert.equal(loginStarted, 0);
  assert.match(out[0].error.message, /Ticket drafting is not included in your plan\./);
  assert.match(out[0].error.message, /not a sign-in problem/i);
});

test('403 falls back from body.error.message to body.message, then to the status', { timeout: 5000 }, async () => {
  const shaped = await (async () => {
    const { bridge, out } = bridgeWith({ auth: fakeAuth(), responses: [jsonRes({ message: 'quota exhausted' }, { status: 403 })] });
    await bridge.handleMessage(CALL);
    return out[0].error.message;
  })();
  assert.match(shaped, /quota exhausted/);

  for (const body of [{ error: { message: { nested: true } } }, { error: {} }, { error: null }, 'not-json-object']) {
    const { bridge, out } = bridgeWith({ auth: fakeAuth(), responses: [jsonRes(body, { status: 403 })] });
    await bridge.handleMessage(CALL);
    assert.match(out[0].error.message, /HTTP 403/, `a non-string message is not a message: ${JSON.stringify(body)}`);
    assert.match(out[0].error.message, /not a sign-in problem/i);
  }
});

test('an oversized or control-laden server message is truncated and flattened', { timeout: 5000 }, async () => {
  const { bridge, out } = bridgeWith({
    auth: fakeAuth(),
    responses: [jsonRes({ error: { message: `${'x'.repeat(5000)}\ndrop\ttable` } }, { status: 403 })],
  });
  await bridge.handleMessage(CALL);
  const text = out[0].error.message;
  assert.ok(text.length < 500, `a server string must not become an unbounded tool result (${text.length})`);
  assert.ok(!/[ -]/.test(text), 'control characters would corrupt the line protocol');
});

test('sanitizeServerMessage keeps only bounded, printable strings', { timeout: 5000 }, () => {
  assert.equal(sanitizeServerMessage(undefined), null);
  assert.equal(sanitizeServerMessage(42), null);
  assert.equal(sanitizeServerMessage({ message: 'x' }), null);
  assert.equal(sanitizeServerMessage('   '), null);
  assert.equal(sanitizeServerMessage(' plan\tdenied\n'), 'plan denied');
  assert.equal(sanitizeServerMessage('abcdef', 3), 'abc…');
});

test('a 403 during the handshake leaves the server usable rather than failing it', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, out } = bridgeWith({ auth, responses: [jsonRes({ error: { message: 'account suspended' } }, { status: 403 })] });
  await bridge.handleMessage(INIT);
  assert.equal(auth.stats.refreshes, 0);
  assert.equal(out[0].error, undefined);
  assert.match(out[0].result.serverInfo.title, /unavailable/i);
});

test('a 5xx leaves the stored credentials alone', { timeout: 5000 }, async () => {
  const auth = fakeAuth();
  const { bridge, out, stats } = bridgeWith({
    auth,
    responses: [jsonRes({ jsonrpc: '2.0', error: { code: -32005, message: 'session limit reached' }, id: null }, { status: 503 })],
  });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /session limit reached/);
  assert.equal(auth.stats.refreshes, 0);
  assert.equal(stats.invalidated, 0);
});

// The 401 path creates more deadlines than any other in this file — the credential read, the first
// attempt, the refresh and the retry — and every one of them is unref'd, so a leaked timer would
// not hang a test run. Only counting them catches the path someone forgot to dispose.
function countingTimers() {
  let seq = 0;
  const live = new Map();
  const make = (kind) => (fn, ms) => {
    const id = (seq += 1);
    live.set(id, { fn, ms, kind });
    return { id, unref() { return this; } };
  };
  const drop = (handle) => { if (handle != null) live.delete(handle.id); };
  return {
    outstanding: () => live.size,
    deps: {
      setTimeoutImpl: make('timeout'),
      clearTimeoutImpl: drop,
      setIntervalImpl: make('interval'),
      clearIntervalImpl: drop,
    },
  };
}

test('the 401 refresh-and-retry path disposes every deadline it armed', { timeout: 5000 }, async () => {
  const timers = countingTimers();
  const { bridge, out } = bridgeWith({
    auth: fakeAuth(),
    responses: [new Response(null, { status: 401 }), jsonRes(CALL_RESULT)],
    ...timers.deps,
  });
  await bridge.handleMessage(CALL);
  assert.deepEqual(out, [CALL_RESULT]);
  assert.equal(timers.outstanding(), 0);
});

test('the 403 path disposes every deadline it armed', { timeout: 5000 }, async () => {
  const timers = countingTimers();
  const { bridge, out } = bridgeWith({
    auth: fakeAuth(),
    responses: [jsonRes({ error: { message: 'not in your plan' } }, { status: 403 })],
    ...timers.deps,
  });
  await bridge.handleMessage(CALL);
  assert.match(out[0].error.message, /not in your plan/);
  assert.equal(timers.outstanding(), 0);
});

test('a rejected handshake leaves only the recovery watcher scheduled', { timeout: 5000 }, async () => {
  const timers = countingTimers();
  const { bridge } = bridgeWith({
    auth: fakeAuth(),
    responses: [new Response(null, { status: 401 }), new Response(null, { status: 401 })],
    ...timers.deps,
  });
  await bridge.handleMessage(INIT);
  assert.equal(timers.outstanding(), 1, 'the watcher, and nothing else');
  bridge.dispose();
  assert.equal(timers.outstanding(), 0);
});

// Without the compat adapter forcing the exchange, the retry is guaranteed to fail: the stored
// access token still looks healthy by its own expires_at — the portal's 401 is the ONLY evidence it
// is not — so a plain read hands back the token that was just rejected.
test('the default adapter refreshes the token rather than re-reading the rejected one', { timeout: 5000 }, async () => {
  const reads = [];
  const { bridge, calls, out } = bridgeWith({
    auth: undefined, // the compat adapter over getAccessToken/invalidateTokenCache
    getAccessToken: async (deps, options) => {
      const forced = options != null && options.forceRefresh === true;
      reads.push(forced);
      return forced ? 'refreshed-tok' : 'stale-tok';
    },
    responses: [new Response(null, { status: 401 }), jsonRes(CALL_RESULT)],
  });
  await bridge.handleMessage(CALL);

  assert.deepEqual(reads, [false, true], 'the ordinary read, then a forced exchange');
  assert.equal(calls[0].headers.Authorization, 'Bearer stale-tok');
  assert.equal(calls[1].headers.Authorization, 'Bearer refreshed-tok', 'the retry must carry a different token');
  assert.deepEqual(out, [CALL_RESULT]);
});


// ---------------------------------------------------------------------------
// The TYPED accessor is the default (integration step 4: M-1)
// ---------------------------------------------------------------------------
//
// Before this, `defaultAuth()` adapted the bare `getAccessToken()` and could therefore only ever
// produce "linked" or "not linked" from a token-or-null. Every state in the table above was
// reachable only by a caller that injected a whole `auth` object — which production never did. So
// the bridge told a 403'd user, and a user whose keychain was merely locked, that their machine was
// not linked, and sent them to relink a credential that was never the problem.
//
// `getAccessToken` is deliberately NOT injected in these cases: its presence is what selects the
// legacy adapter, and the point here is the path production actually takes.

function typedBridge({ responses = [], ...rest } = {}) {
  const calls = [];
  const out = [];
  const stats = { invalidated: 0 };
  const bridge = createBridge({
    url: URL_UNDER_TEST,
    invalidateTokenCache: () => { stats.invalidated += 1; },
    fetchImpl: async (url, init) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      const next = responses.shift();
      if (next == null) throw new Error('no response queued');
      if (next instanceof Error) throw next;
      return next;
    },
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 1000,
    ...rest,
  });
  return { bridge, calls, out, stats };
}

const readyState = (token) => ({ state: 'ready', reason: 'none', token, generation: 1, epoch: 'env|t|u|1', account: null });

test('the default path reads the typed state, and a 401 renews through the typed seam', { timeout: 5000 }, async () => {
  const seen = { reads: 0, refreshes: 0 };
  const { bridge, calls, out } = typedBridge({
    getAuthState: async () => { seen.reads += 1; return readyState('tok-1'); },
    forceRefresh: async () => {
      seen.refreshes += 1;
      return { ok: true, token: 'tok-2', state: 'ready', reason: 'none', epoch: 'env|t|u|1', generation: 2 };
    },
    responses: [new Response(null, { status: 401 }), jsonRes(CALL_RESULT)],
  });

  await bridge.handleMessage(CALL);

  assert.equal(seen.refreshes, 1, 'exactly one forced renewal per 401');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[1].headers.Authorization, 'Bearer tok-2', 'the retry must carry the renewed token');
  assert.deepEqual(calls[0].body, calls[1].body, 'the retry is the same request, same id');
  assert.deepEqual(out, [CALL_RESULT]);
});

test('a FORBIDDEN state reaches the user as an entitlement refusal, and nothing is renewed', { timeout: 5000 }, async () => {
  // The state the adapter could not express. A 403 is authentication succeeding and authorization
  // failing: a refresh cannot help, a relink cannot grant a seat, and saying "not linked" is the
  // answer that destroys a working link to fix a problem it never had.
  const seen = { refreshes: 0 };
  const { bridge, calls, out } = typedBridge({
    getAuthState: async () => ({ state: 'forbidden', reason: 'none', token: null, generation: 1, epoch: 'e', account: null }),
    forceRefresh: async () => { seen.refreshes += 1; return { ok: false, token: null, state: 'forbidden', reason: 'none' }; },
  });

  await bridge.handleMessage(CALL);

  assert.equal(seen.refreshes, 0, 'nothing here is fixed by a refresh');
  assert.deepEqual(calls, [], 'and nothing is sent upstream');
  assert.equal(out.length, 1);
  const text = JSON.stringify(out[0]);
  assert.match(text, /not allowed/i);
  assert.doesNotMatch(text, /not linked/i, 'a 403 is not an unlinked machine');
});

test('an ordinary request read does NOT drop the token memo', { timeout: 5000 }, async () => {
  // The memo in lib/token.mjs is what keeps a long stdio session from spawning a credential read
  // per request (a PowerShell spawn on Windows, a measured half-second). Only the recovery probe
  // passes `fresh`; a request must not.
  const { bridge, out, stats } = typedBridge({
    getAuthState: async () => ({ state: 'unlinked', reason: 'missing', token: null, generation: null, epoch: '', account: null }),
  });

  await bridge.handleMessage(CALL);

  assert.equal(stats.invalidated, 0, 'an ordinary read must not throw the memo away');
  assert.match(JSON.stringify(out[0]), /not linked/i);
  bridge.dispose();
});
