import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIssueRecorder, createBridge } from '../lib/mcp-bridge.mjs';

// The recorder is the whole of this bridge's telemetry surface. Everything that decides whether
// anything is collected — consent, correlation, the allowlist, the flush — lives in
// lib/telemetry.mjs; this side only has to be incapable of breaking the server it reports on, and
// incapable of collecting anything on a machine where that module is not installed.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTelemetry(overrides = {}) {
  const recorded = [];
  const launches = { count: 0 };
  return {
    recorded,
    launches,
    module: {
      recordIssue: (code, fields) => {
        recorded.push({ code, fields });
        if (overrides.throwOnRecord) throw new Error('telemetry exploded');
      },
      maybeLaunchWorker: () => { launches.count += 1; },
    },
  };
}

test('the recorder forwards the code and fields to the telemetry facade', { timeout: 5000 }, async () => {
  const tel = fakeTelemetry();
  const record = createIssueRecorder({ load: async () => tel.module });
  record('mcp_handshake_timeout', { source: 'mcp_bridge', status: 0, reason: 'timeout', durationMs: 20000 });
  await flush();

  assert.deepEqual(tel.recorded, [{
    code: 'mcp_handshake_timeout',
    fields: { source: 'mcp_bridge', status: 0, reason: 'timeout', durationMs: 20000 },
  }]);
});

test('the flush trigger fires at most once per process', { timeout: 5000 }, async () => {
  const tel = fakeTelemetry();
  const record = createIssueRecorder({ load: async () => tel.module });
  record('mcp_startup_failed', { source: 'mcp_bridge', status: 0, reason: 'transport', durationMs: 5 });
  record('mcp_handshake_timeout', { source: 'mcp_bridge', status: 0, reason: 'timeout', durationMs: 6 });
  await flush();
  assert.equal(tel.recorded.length, 2);
  assert.equal(tel.launches.count, 1, 'a worker per failure would be its own outage');
});

test('a machine without the telemetry module collects nothing and never throws', { timeout: 5000 }, async () => {
  let loads = 0;
  const errors = [];
  const record = createIssueRecorder({
    load: async () => { loads += 1; throw new Error("Cannot find module '../lib/telemetry.mjs'"); },
    onError: (error) => errors.push(error),
  });
  record('mcp_startup_failed', { source: 'mcp_bridge', status: 0, reason: 'transport', durationMs: 1 });
  record('mcp_startup_failed', { source: 'mcp_bridge', status: 0, reason: 'transport', durationMs: 2 });
  await flush();

  assert.equal(loads, 1, 'the absent module is looked for once, not once per failure');
  assert.deepEqual(errors, [], 'absence is the documented "off" state, not an error to report');
});

test('a telemetry module that throws cannot escape the recorder', { timeout: 5000 }, async () => {
  const tel = fakeTelemetry({ throwOnRecord: true });
  const errors = [];
  const record = createIssueRecorder({ load: async () => tel.module, onError: (error) => errors.push(error) });
  record('mcp_startup_failed', { source: 'mcp_bridge', status: 0, reason: 'transport', durationMs: 1 });
  await flush();
  assert.equal(tel.recorded.length, 1);
  assert.equal(errors.length, 1, 'reported on stderr, never rethrown');
});

test('recording is asynchronous, so it cannot sit in the RPC path', { timeout: 5000 }, async () => {
  const order = [];
  const record = createIssueRecorder({
    load: async () => ({ recordIssue: () => order.push('recorded') }),
  });
  const out = [];
  const bridge = createBridge({
    url: 'https://api.test/api/mcp',
    getAccessToken: async () => 'tok',
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    write: (line) => { out.push(JSON.parse(line)); order.push('answered'); },
    logError: () => {},
    recordIssue: record,
  });

  await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.deepEqual(order, ['answered'], 'the client is answered before any diagnostic work happens');
  await flush();
  assert.deepEqual(order, ['answered', 'recorded']);
  bridge.dispose();
});
