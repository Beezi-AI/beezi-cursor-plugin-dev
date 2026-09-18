import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge, LOGIN_TOOL, STATUS_TOOL, LOCAL_TOOLS } from '../lib/mcp-bridge.mjs';
import { httpsFetch } from '../lib/fetch-compat.mjs';

// Every deadline in the bridge runs on injected timers, so a stall is a test that fires a timer
// rather than a test that waits. The counters are the point: the failure this module exists to
// prevent is a path that arms a deadline and forgets to dispose it, and only a per-test
// "nothing outstanding" assertion catches the ONE path someone missed.
function fakeTimers() {
  let seq = 0;
  const live = new Map();
  const created = [];
  const state = {
    now: 0,
    get outstanding() { return live.size; },
    createdWith(ms) { return created.filter((c) => c.ms === ms && c.kind === 'timeout').length; },
    intervals() { return Array.from(live.values()).filter((t) => t.kind === 'interval'); },
    fireTimeouts() {
      const due = Array.from(live.entries()).filter(([, t]) => t.kind === 'timeout');
      for (const [id, t] of due) {
        live.delete(id);
        state.now += t.ms;
        t.fn();
      }
      return due.length;
    },
    fireIntervals() {
      const due = Array.from(live.values()).filter((t) => t.kind === 'interval');
      for (const t of due) t.fn();
      return due.length;
    },
  };
  const make = (kind) => (fn, ms) => {
    const id = (seq += 1);
    live.set(id, { fn, ms, kind });
    created.push({ id, ms, kind });
    return { id, unrefd: false, unref() { this.unrefd = true; return this; } };
  };
  const drop = (handle) => { if (handle != null) live.delete(handle.id); };
  return {
    state,
    deps: {
      setTimeoutImpl: make('timeout'),
      clearTimeoutImpl: drop,
      setIntervalImpl: make('interval'),
      clearIntervalImpl: drop,
      now: () => state.now,
    },
  };
}

const URL_UNDER_TEST = 'https://api.test/api/mcp';
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draft_ticket' } };
const CALL_RESULT = { jsonrpc: '2.0', id: 1, result: { content: [] } };
const INIT_RESULT = { jsonrpc: '2.0', id: 0, result: { capabilities: {} } };

// Lets a pending handler reach its next await before the test fires a timer at it.
//
// setImmediate, not setTimeout(0): Windows clamps a 0ms timer to the ~15ms system tick, and the
// backoff tests below spend 120+ ticks apiece — 1.9s of their 5s budget on an idle machine, and
// past it once `node --test` is running one file per core, which is how they timed out in CI.
// setImmediate yields the same thing a 0ms timer does here (a full event-loop turn with the
// microtask queue drained) for microseconds. Nothing under test waits on a real timer: every
// deadline in the bridge runs on the injected fake timers above.
const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function harness(overrides = {}) {
  const timers = fakeTimers();
  const out = [];
  const calls = [];
  const logged = [];
  const issues = [];
  const bridge = createBridge({
    url: URL_UNDER_TEST,
    getAccessToken: async () => 'tok',
    invalidateTokenCache: () => {},
    fetchImpl: async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal }); throw new Error('no transport configured'); },
    write: (line) => out.push(JSON.parse(line)),
    logError: (m) => logged.push(m),
    recordIssue: (code, fields) => issues.push({ code, fields }),
    ...timers.deps,
    ...overrides,
  });
  return { bridge, out, calls, logged, issues, timers: timers.state };
}

// A response whose body is a stream the test drives by hand, so "the server stopped talking
// mid-body" is reproducible without a socket.
function streamRes(contentType, initialChunks = [], resHeaders = {}) {
  const encoder = new TextEncoder();
  const cancels = { count: 0 };
  let ctrl = null;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
      for (const chunk of initialChunks) c.enqueue(encoder.encode(chunk));
    },
    cancel() { cancels.count += 1; },
  });
  const res = new Response(stream, { status: 200, headers: { 'content-type': contentType, ...resHeaders } });
  return {
    res,
    cancels,
    push: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

const sseChunk = (msg) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// ---------------------------------------------------------------------------
// Bounded handshake
// ---------------------------------------------------------------------------

test('a handshake whose headers never arrive is bounded, and the client still gets a usable server', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) });
  const work = h.bridge.handleMessage(INIT);
  await tick();
  assert.equal(h.timers.createdWith(20000) > 0, true, 'the handshake is armed with the 20s budget, not the 120s tool budget');
  h.timers.fireTimeouts();
  await work;

  assert.equal(h.out.length, 1);
  assert.equal(h.out[0].id, 0);
  assert.equal(h.out[0].error, undefined, 'a dead portal must not fail the handshake — that takes the plugin down');
  assert.equal(h.out[0].result.capabilities.tools.listChanged, true);
  assert.match(h.out[0].result.serverInfo.title, /unavailable/i);
  assert.ok(!/not linked/i.test(h.out[0].result.serverInfo.title), 'the user is linked; do not claim otherwise');
  assert.equal(h.timers.outstanding, h.timers.intervals().length, 'every request deadline was disposed');
});

test('the handshake budget is capped by an injected request timeout', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}), timeoutMs: 5000 });
  const work = h.bridge.handleMessage(INIT);
  await tick();
  assert.equal(h.timers.createdWith(20000), 0);
  assert.ok(h.timers.createdWith(5000) > 0);
  h.timers.fireTimeouts();
  await work;
});

test('a tool call whose headers never arrive gets exactly one error on the 120s budget', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) });
  const work = h.bridge.handleMessage(CALL);
  await tick();
  assert.equal(h.timers.createdWith(120000), 1, 'tool latency keeps the 120s idle budget');
  h.timers.fireTimeouts();
  await work;

  assert.equal(h.out.length, 1);
  assert.equal(h.out[0].id, 1);
  assert.match(h.out[0].error.message, /timed out/i);
  assert.equal(h.timers.outstanding, h.timers.intervals().length);
});

test('a JSON body that never ends is bounded and the reader is cancelled', { timeout: 5000 }, async () => {
  const stalled = streamRes('application/json', ['{"jsonrpc":"2.0",']);
  const h = harness({ fetchImpl: async () => stalled.res });
  const work = h.bridge.handleMessage(CALL);
  await tick();
  h.timers.fireTimeouts();
  await work;

  assert.equal(h.out.length, 1);
  assert.match(h.out[0].error.message, /timed out/i);
  assert.equal(stalled.cancels.count, 1, 'the response stream must be cancelled, not left hanging');
  assert.equal(h.timers.outstanding, h.timers.intervals().length);
});

test('an SSE stream that goes quiet is bounded, and progress resets the idle budget for tools only', { timeout: 5000 }, async () => {
  const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  const stalled = streamRes('text/event-stream', [sseChunk(progress)]);
  const h = harness({ fetchImpl: async () => stalled.res });
  const work = h.bridge.handleMessage(CALL);
  await tick();
  stalled.push(sseChunk(progress));
  await tick();

  assert.equal(h.timers.createdWith(120000), 3, 'each chunk of progress re-arms the tool idle budget');
  h.timers.fireTimeouts();
  await work;

  assert.deepEqual(h.out.map((m) => m.method), ['notifications/progress', 'notifications/progress', undefined]);
  assert.equal(h.out[2].id, 1);
  assert.match(h.out[2].error.message, /timed out/i);
  assert.equal(stalled.cancels.count, 1);
});

test('SSE progress cannot extend the handshake past its absolute cap', { timeout: 5000 }, async () => {
  const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  const stalled = streamRes('text/event-stream', [sseChunk(progress), sseChunk(progress)]);
  const h = harness({ fetchImpl: async () => stalled.res });
  const work = h.bridge.handleMessage(INIT);
  await tick();
  assert.equal(h.timers.createdWith(20000), 2, 'one deadline for the credential read, one for the handshake — and no re-arming');
  h.timers.fireTimeouts();
  await work;

  const answers = h.out.filter((m) => m.id === 0);
  assert.equal(answers.length, 1, 'the handshake is answered exactly once');
  assert.match(answers[0].result.serverInfo.title, /unavailable/i);
});

test('a stalled re-initialize answers the waiting request and clears the shared memo', { timeout: 5000 }, async () => {
  let stallReinit = true;
  const h = harness({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize' && stallReinit) return new Promise(() => {});
      if (body.method === 'initialize') return jsonRes(INIT_RESULT, { headers: { 'mcp-session-id': 's2' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonRes(CALL_RESULT);
    },
  });
  // A client handshake the bridge could not complete upstream leaves a saved initialize to replay.
  const first = h.bridge.handleMessage(INIT);
  await tick();
  h.timers.fireTimeouts();
  await first;

  const work = h.bridge.handleMessage(CALL);
  await tick();
  h.timers.fireTimeouts();
  await work;
  const failed = h.out.filter((m) => m.id === 1);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error.message, /timed out|unavailable|failed/i);

  // The memo must not be poisoned by the cancelled attempt: the next request tries again.
  stallReinit = false;
  await h.bridge.handleMessage(CALL);
  const answered = h.out.filter((m) => m.id === 1);
  assert.equal(answered.length, 2, 'one terminal reply per request, and the second request got a real one');
  assert.deepEqual(answered[1].result, CALL_RESULT.result);
});

// ---------------------------------------------------------------------------
// Exactly one terminal reply per accepted id
// ---------------------------------------------------------------------------

test('an SSE response followed by a transport error does not produce a second reply', { timeout: 5000 }, async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  const stream = new ReadableStream({
    // Delivered first, then the socket dies: erroring the controller up front would discard the
    // queued chunk and prove nothing.
    pull(c) {
      pulls += 1;
      if (pulls === 1) { c.enqueue(encoder.encode(sseChunk(CALL_RESULT))); return; }
      c.error(new Error('socket hang up'));
    },
  });
  const h = harness({
    fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  await h.bridge.handleMessage(CALL);
  const forId1 = h.out.filter((m) => m.id === 1);
  assert.equal(forId1.length, 1, 'the id was already answered; the transport error must not answer it again');
  assert.deepEqual(forId1[0].result, CALL_RESULT.result);
});

test('a request answered with 202 still gets exactly one reply', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: async () => new Response(null, { status: 202 }) });
  await h.bridge.handleMessage(CALL);
  assert.equal(h.out.length, 1, 'an accepted id may never be left unanswered');
  assert.equal(h.out[0].id, 1);
  assert.ok(h.out[0].error);
});

test('a notification that fails upstream is still answered with nothing', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('socket hang up'); } });
  await h.bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(h.out.length, 0);
});

test('a request carrying a null id is not treated as an answerable request', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: async () => new Response(null, { status: 202 }) });
  await h.bridge.handleMessage({ jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'x' } });
  assert.equal(h.out.length, 0);
});

// ---------------------------------------------------------------------------
// Credential and local-tool failures happen inside the guarded path
// ---------------------------------------------------------------------------

test('a credential read that throws is temporary, not an unlinking', { timeout: 5000 }, async () => {
  const h = harness({ getAccessToken: async () => { throw new Error('keychain locked'); } });
  await h.bridge.handleMessage(CALL);
  assert.equal(h.out.length, 1);
  assert.ok(!/not linked/i.test(h.out[0].error.message), 'a locked keychain is not proof the machine is unlinked');
  assert.match(h.out[0].error.message, /could not read|unavailable|temporar/i);
});

test('a credential read that hangs is bounded and answered', { timeout: 5000 }, async () => {
  const h = harness({ getAccessToken: () => new Promise(() => {}) });
  const work = h.bridge.handleMessage(CALL);
  await tick();
  h.timers.fireTimeouts();
  await work;
  assert.equal(h.out.length, 1);
  assert.equal(h.out[0].id, 1);
  assert.equal(h.timers.outstanding, h.timers.intervals().length);
});

test('the local tools answer even when the credential read throws', { timeout: 5000 }, async () => {
  const h = harness({
    getAccessToken: async () => { throw new Error('keychain locked'); },
    linkStatus: async () => ({ state: 'linked', account: 'Dev', apiBase: 'https://api.test/api', hooks: { bundled: true, user: { state: 'installed', registered: ['x'] } } }),
  });
  await h.bridge.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: STATUS_TOOL.name } });
  assert.equal(h.out[0].id, 5);
  assert.equal(h.out[0].result.isError, undefined);
});

test('a local tool that throws is answered once, not left to crash the bridge', { timeout: 5000 }, async () => {
  const h = harness({ linkStatus: async () => { throw new Error('vscdb locked'); } });
  await h.bridge.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: STATUS_TOOL.name } });
  assert.equal(h.out.length, 1);
  assert.equal(h.out[0].result.isError, true);
  assert.match(h.out[0].result.content[0].text, /vscdb locked/);
});

// ---------------------------------------------------------------------------
// Recovery watcher
// ---------------------------------------------------------------------------

test('offline startup then recovery: the saved handshake is replayed and the tools are announced once', { timeout: 5000 }, async () => {
  let online = false;
  const h = harness({
    fetchImpl: async (url, init) => {
      if (!online) throw new Error('getaddrinfo ENOTFOUND');
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return jsonRes(INIT_RESULT, { headers: { 'mcp-session-id': 's1' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'draft_ticket' }] } });
    },
  });

  await h.bridge.handleMessage(INIT);
  assert.match(h.out[0].result.serverInfo.title, /unavailable/i);
  const intervals = h.timers.intervals();
  assert.equal(intervals.length, 1, 'a recovery watcher is armed');
  assert.equal(intervals[0].ms, 15000);

  // Still offline: the probe changes nothing and announces nothing.
  h.timers.fireIntervals();
  await tick();
  assert.equal(h.out.length, 1);

  online = true;
  h.timers.fireIntervals();
  await tick(8);
  assert.deepEqual(h.out[1], { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.equal(h.out.length, 2, 'exactly one announcement, and no replayed handshake on stdout');
  assert.equal(h.timers.intervals().length, 0, 'a recovered bridge stops probing');

  // And the session it rebuilt is the one real requests now use.
  await h.bridge.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  const listed = h.out.find((m) => m.id === 9);
  assert.deepEqual(listed.result.tools.map((t) => t.name), ['draft_ticket', ...LOCAL_TOOLS.map((t) => t.name)]);
});

test('a login performed outside this process is picked up by the watcher', { timeout: 5000 }, async () => {
  let token = null;
  const h = harness({
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return jsonRes(INIT_RESULT, { headers: { 'mcp-session-id': 's1' } });
      return new Response(null, { status: 202 });
    },
  });

  await h.bridge.handleMessage(INIT);
  assert.match(h.out[0].result.serverInfo.title, /not linked/i);
  assert.equal(h.timers.intervals().length, 1);

  token = 'tok';
  h.timers.fireIntervals();
  await tick(8);
  assert.deepEqual(h.out[1], { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.equal(h.timers.intervals().length, 0);
});

test('the watcher runs at most one probe at a time and never replays tool calls', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  let offline = true;
  const h = harness({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.method);
      if (offline) throw new Error('ENOTFOUND');
      if (body.method === 'initialize') { await gate; return jsonRes(INIT_RESULT); }
      return new Response(null, { status: 202 });
    },
  });

  // A failed tool call is what puts the bridge in recovery; it must never be replayed.
  await h.bridge.handleMessage(INIT);
  await h.bridge.handleMessage(CALL);
  offline = false;
  sent.length = 0;
  h.timers.fireIntervals();
  await tick();
  h.timers.fireIntervals();
  h.timers.fireIntervals();
  await tick();
  assert.deepEqual(sent, ['initialize'], 'one probe in flight, and no tools/call replay');
  release();
  await tick(8);
});

test('the watcher comes back for a later outage and announces the second recovery too', { timeout: 5000 }, async () => {
  let online = false;
  const h = harness({
    fetchImpl: async (url, init) => {
      if (!online) throw new Error('ENOTFOUND');
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return jsonRes(INIT_RESULT);
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} });
    },
  });
  await h.bridge.handleMessage(INIT);
  online = true;
  h.timers.fireIntervals();
  await tick(8);
  assert.equal(h.out.filter((m) => m.method === 'notifications/tools/list_changed').length, 1);

  // Second outage: a later handshake fails again, and recovery announces again.
  online = false;
  await h.bridge.handleMessage(INIT);
  assert.equal(h.timers.intervals().length, 1, 'the watcher is re-armed for the new outage');
  online = true;
  h.timers.fireIntervals();
  await tick(8);
  assert.equal(h.out.filter((m) => m.method === 'notifications/tools/list_changed').length, 2);
});

test('dispose stops the watcher so a closed stdin leaves nothing scheduled', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  await h.bridge.handleMessage(INIT);
  assert.equal(h.timers.intervals().length, 1);
  h.bridge.dispose();
  assert.equal(h.timers.outstanding, 0, 'nothing scheduled survives stdin closing');
});

test('a probe that hangs cannot wedge the watcher forever', { timeout: 5000 }, async () => {
  let phase = 'offline';
  const h = harness({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (phase === 'offline') throw new Error('ENOTFOUND');
      if (phase === 'hang' && body.method === 'initialize') return new Promise(() => {});
      if (body.method === 'initialize') return jsonRes(INIT_RESULT);
      return new Response(null, { status: 202 });
    },
  });
  await h.bridge.handleMessage(INIT);
  phase = 'hang';
  h.timers.fireIntervals();
  await tick();
  h.timers.fireTimeouts(); // the probe's own deadline expires
  await tick(6);
  phase = 'online';
  h.timers.fireIntervals();
  await tick(8);
  assert.equal(h.out.filter((m) => m.method === 'notifications/tools/list_changed').length, 1, 'the next probe still ran');
});

// ---------------------------------------------------------------------------
// The fallback HTTP transport (Node < 18) must be interruptible too
// ---------------------------------------------------------------------------

test('abort interrupts the fallback HTTP transport mid-body, not just native fetch', { timeout: 5000 }, async (t) => {
  const aborted = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"jsonrpc":"2.0",'); // headers and a partial body, then silence
    req.on('aborted', () => aborted.push('aborted'));
    res.on('close', () => aborted.push('close'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const out = [];
  const bridge = createBridge({
    url: `http://127.0.0.1:${port}/api/mcp`,
    getAccessToken: async () => 'tok',
    fetchImpl: httpsFetch,
    write: (line) => out.push(JSON.parse(line)),
    logError: () => {},
    timeoutMs: 120,
  });

  await bridge.handleMessage(CALL);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.match(out[0].error.message, /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(aborted.length > 0, 'the socket must actually be torn down, not left to the GC');
});

// ---------------------------------------------------------------------------
// Diagnostics (M10-03)
// ---------------------------------------------------------------------------

test('a handshake timeout is recorded once per outage, with no request content', { timeout: 5000 }, async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) });
  for (let i = 0; i < 2; i += 1) {
    const work = h.bridge.handleMessage(INIT);
    await tick();
    h.timers.fireTimeouts();
    await work;
  }
  assert.equal(h.issues.length, 1, 'repeated failures dedupe');
  assert.equal(h.issues[0].code, 'mcp_handshake_timeout');
  assert.equal(h.issues[0].fields.source, 'mcp_bridge');
  assert.equal(h.issues[0].fields.reason, 'timeout');
  assert.equal(typeof h.issues[0].fields.durationMs, 'number');
  assert.deepEqual(Object.keys(h.issues[0].fields).sort(), ['durationMs', 'reason', 'source', 'status']);
});

test('an unreachable portal is recorded as a startup failure, and a logged-out machine is not', { timeout: 5000 }, async () => {
  const offline = harness({ fetchImpl: async () => { throw new Error('ENOTFOUND api.test'); } });
  await offline.bridge.handleMessage(INIT);
  assert.deepEqual(offline.issues.map((i) => i.code), ['mcp_startup_failed']);
  assert.equal(offline.issues[0].fields.reason, 'transport');
  assert.ok(!JSON.stringify(offline.issues[0]).includes('api.test'), 'no message, host or URL leaves the process');

  const loggedOut = harness({ getAccessToken: async () => null });
  await loggedOut.bridge.handleMessage(INIT);
  await loggedOut.bridge.handleMessage(CALL);
  assert.deepEqual(loggedOut.issues, [], 'not being signed in is not a defect');
});

test('a diagnostics recorder that throws cannot change the RPC answer', { timeout: 5000 }, async () => {
  const h = harness({
    fetchImpl: async () => jsonRes(CALL_RESULT),
    recordIssue: () => { throw new Error('telemetry exploded'); },
  });
  await h.bridge.handleMessage(CALL);
  assert.deepEqual(h.out, [CALL_RESULT]);

  const failing = harness({
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    recordIssue: () => { throw new Error('telemetry exploded'); },
  });
  await failing.bridge.handleMessage(INIT);
  assert.equal(failing.out.length, 1);
  assert.equal(failing.out[0].id, 0);
  assert.ok(failing.out[0].result, 'the local fallback handshake still answered');
});

test('the login tool stays reachable while the portal is unavailable', { timeout: 5000 }, async () => {
  const h = harness({
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    performLogin: async () => ({ type: 'linked', account: 'Dev', storedIn: '/c' }),
  });
  await h.bridge.handleMessage(INIT);
  await h.bridge.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: LOGIN_TOOL.name } });
  const answer = h.out.find((m) => m.id === 4);
  assert.equal(answer.result.isError, undefined);
});

// The watcher and an ordinary request can want the same thing at the same time. Two independent
// replays would each null the session id and one would then acknowledge a session the other had
// already replaced — which is the single-flight rule the 404 rebuild has always had, applied to the
// path that runs on a timer.
test('a probe racing a request shares one session rebuild', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  let offline = true;
  const h = harness({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.method);
      if (offline) throw new Error('ENOTFOUND');
      if (body.method === 'initialize') { await gate; return jsonRes(INIT_RESULT, { headers: { 'mcp-session-id': 's1' } }); }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonRes(CALL_RESULT);
    },
  });

  await h.bridge.handleMessage(INIT); // offline: answered locally, watcher armed
  offline = false;
  sent.length = 0;

  const work = h.bridge.handleMessage(CALL); // needs the upstream handshake first, and blocks on it
  await tick();
  h.timers.fireIntervals(); // the probe fires while that rebuild is still in flight
  await tick();
  assert.equal(sent.filter((m) => m === 'initialize').length, 1, 'one rebuild, not one per waiter');

  release();
  await work;
  await tick(8);
  assert.equal(h.out.filter((m) => m.method === 'notifications/tools/list_changed').length, 1);
  assert.deepEqual(h.out.filter((m) => m.id === 1).map((m) => m.result), [CALL_RESULT.result]);
});

// Every probe costs a credential-store read, and on Windows that read spawns PowerShell. On a
// machine that is simply not signed in there is nothing for a probe to find until the user acts, so
// the cadence has to decay — otherwise an idle unlinked editor spends the afternoon spawning shells.
test('an unlinked machine backs the recovery probe off instead of spawning a read every 15s', { timeout: 5000 }, async () => {
  let reads = 0;
  const h = harness({
    getAccessToken: async () => { reads += 1; return null; },
    fetchImpl: async () => { throw new Error('must not reach the network'); },
  });
  await h.bridge.handleMessage(INIT);
  const before = reads;

  const at = [];
  for (let tickIndex = 1; tickIndex <= 31; tickIndex += 1) {
    h.timers.fireIntervals();
    await tick();
    if (reads > before + at.length) at.push(tickIndex);
  }
  // 1, 2, 4, 8 then a 16-tick (four-minute) ceiling.
  assert.deepEqual(at, [1, 3, 7, 15, 31]);
  assert.equal(h.timers.outstanding, h.timers.intervals().length, 'every probe deadline was disposed');
});

test('a linked machine waiting on the portal keeps probing every tick', { timeout: 5000 }, async () => {
  let attempts = 0;
  const h = harness({
    fetchImpl: async () => { attempts += 1; throw new Error('ENOTFOUND'); },
  });
  await h.bridge.handleMessage(INIT);
  const before = attempts;
  for (let i = 0; i < 3; i += 1) {
    h.timers.fireIntervals();
    await tick(6);
  }
  assert.equal(attempts - before, 3, 'the credential is readable, so only the portal is missing');
  assert.equal(h.timers.outstanding, h.timers.intervals().length, 'every probe deadline was disposed');
});

test('a machine linked mid-session snaps back to the fast cadence', { timeout: 5000 }, async () => {
  let token = null;
  let attempts = 0;
  const h = harness({
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      attempts += 1;
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') throw new Error('ENOTFOUND');
      return new Response(null, { status: 202 });
    },
  });
  await h.bridge.handleMessage(INIT);

  // Four unlinked probes take the backoff to its 8-tick step.
  for (let i = 1; i <= 15; i += 1) { h.timers.fireIntervals(); await tick(); }
  assert.equal(attempts, 0);

  token = 'tok';
  // The next probe is due 16 ticks after the fourth one; from there the streak resets.
  for (let i = 1; i <= 16; i += 1) { h.timers.fireIntervals(); await tick(4); }
  const afterFirstSuccess = attempts;
  assert.ok(afterFirstSuccess >= 1, 'the credential is readable again');
  h.timers.fireIntervals();
  await tick(6);
  assert.ok(attempts > afterFirstSuccess, 'and the very next tick probes again');
  assert.equal(h.timers.outstanding, h.timers.intervals().length, 'every probe deadline was disposed');
});


// ─── the recovery probe re-reads the store (integration step 4: M-1) ────────────────────────────

test('a sign-in performed outside this process is picked up: the probe asks for a FRESH read', { timeout: 5000 }, async () => {
  // The bridge outlives every request it serves — Cursor spawns it once and reads its stdout for
  // hours — so a user who signs in from a terminal must not have to restart Cursor to get their
  // tools back. `fresh` is how the recovery probe says "re-read the store", and on the typed path
  // it drops lib/token.mjs's memo first. Without that, the memo would keep answering with the
  // pre-login value for the life of the process.
  //
  // `getAccessToken` is deliberately absent: injecting it selects the legacy bare-token adapter,
  // and this is the path production takes.
  let linked = false;
  const invalidations = [];
  const h = harness({
    getAccessToken: undefined,
    getAuthState: async () => (linked
      ? { state: 'ready', reason: 'none', token: 'tok-after-login', generation: 2, epoch: 'e2', account: null }
      : { state: 'unlinked', reason: 'missing', token: null, generation: null, epoch: '', account: null }),
    invalidateTokenCache: () => { invalidations.push(1); },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return new Response(JSON.stringify(INIT_RESULT), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' } });
      return new Response(null, { status: 202 });
    },
  });

  await h.bridge.handleMessage(INIT);
  assert.ok(h.timers.intervals().length > 0, 'an unlinked machine arms the recovery watcher');
  const before = invalidations.length;

  linked = true;
  h.timers.fireIntervals();
  await tick(8);

  assert.ok(invalidations.length > before, 'the probe drops the memo before re-reading');
  assert.equal(h.timers.intervals().length, 0, 'and a recovered bridge stops probing');
  h.bridge.dispose();
});
