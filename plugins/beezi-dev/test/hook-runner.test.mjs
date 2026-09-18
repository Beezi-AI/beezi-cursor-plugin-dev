import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOOK_GUARD_MARGIN_MS,
  HOOK_TIMEOUTS,
  PERMISSION_ALLOW_OUTPUT,
  PERMISSION_FAILURE_OUTPUT,
  hookBudgetMs,
  hookOccurredAt,
  installHookGuards,
  runHook,
} from '../lib/hook-runner.mjs';

// The bootstrap every hook entry runs before it touches a business module.
//
// What is under test is containment: a business module that throws while it is being EVALUATED, a
// handler that throws, a handler that rejects, and a diagnostics callback that throws must all end
// as "exit 0, protocol-safe stdout" — because the alternative is a host failure entry in Cursor's
// execution log for work that was only ever best-effort analytics.
//
// The subprocess half of this lives in test/hook-bootstrap.test.mjs: it runs the real ten scripts
// the way Cursor does. Here everything is injected, so the assertions are about the runner's own
// decisions rather than about any one hook.

const PAYLOAD = Object.freeze({ session_id: 'conv-1', cwd: '/w' });

// A stand-in for lib/hook-input-cursor.mjs. Injected rather than stubbed through a loader so the
// decode step can be made to fail without touching the module every other test imports.
function decoderOf(payload = PAYLOAD, overrides = {}) {
  return {
    readHookInput: overrides.readHookInput == null ? (() => payload) : overrides.readHookInput,
    normalizeHookInput: overrides.normalizeHookInput == null
      ? ((p) => (p == null ? null : { session_id: p.session_id, transcript_path: null, cwd: p.cwd }))
      : overrides.normalizeHookInput,
    stampableCwd: overrides.stampableCwd == null ? ((p) => (p == null ? null : p.cwd)) : overrides.stampableCwd,
  };
}

function recorder() {
  const out = { exits: [], stdout: '', issues: [] };
  return {
    out,
    deps: {
      exit: (code) => { out.exits.push(code); },
      write: (text) => { out.stdout += text; },
      recordIssue: (code, fields) => { out.issues.push([code, fields]); },
      decoder: decoderOf(),
      shutdown: { exitClean: (code) => { out.exits.push(code); return null; } },
      on: () => {},
    },
  };
}

test('the timeout table is the one both registries and the budget derive from', () => {
  assert.deepEqual(HOOK_TIMEOUTS, { analytics: 10000, permission: 5000 });
  // A permission hook is smaller than the analytics path by construction, not by convention.
  assert.ok(HOOK_TIMEOUTS.permission < HOOK_TIMEOUTS.analytics);
  assert.equal(hookBudgetMs(false), 10000 - HOOK_GUARD_MARGIN_MS);
  assert.equal(hookBudgetMs(true), 5000 - HOOK_GUARD_MARGIN_MS);
  assert.ok(hookBudgetMs(true) > 0, 'a permission hook still needs room to do its one append');
});

test('a business module that throws while being evaluated is contained', async () => {
  const { out, deps } = recorder();
  await runHook({
    name: 'tool-event',
    deps,
    load: () => Promise.reject(new Error('boom during evaluation')),
    handle: () => { throw new Error('unreachable'); },
  });
  assert.deepEqual(out.exits, [0]);
  assert.equal(out.stdout, '');
  assert.deepEqual(out.issues.map((i) => i[0]), ['hook_import_failed']);
});

test('a handler that throws is contained', async () => {
  const { out, deps } = recorder();
  await runHook({
    name: 'stop',
    deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  assert.deepEqual(out.exits, [0]);
  assert.equal(out.stdout, '');
  assert.deepEqual(out.issues.map((i) => i[0]), ['hook_crash']);
});

test('a handler that rejects is contained', async () => {
  const { out, deps } = recorder();
  await runHook({
    name: 'report',
    deps,
    load: () => Promise.resolve({}),
    handle: () => Promise.reject(new Error('boom')),
  });
  assert.deepEqual(out.exits, [0]);
  assert.equal(out.stdout, '');
  assert.deepEqual(out.issues.map((i) => i[0]), ['hook_crash']);
});

test('a decode failure is contained before any business module is loaded', async () => {
  const { out, deps } = recorder();
  let loaded = false;
  deps.decoder = decoderOf(PAYLOAD, { readHookInput: () => { throw new Error('bad pipe'); } });
  await runHook({
    name: 'file-edit',
    deps,
    load: () => { loaded = true; return Promise.resolve({}); },
    handle: () => {},
  });
  assert.equal(loaded, false, 'the heavy import must not be reached on a payload we cannot read');
  assert.deepEqual(out.exits, [0]);
  assert.equal(out.stdout, '');
});

test('a payload with no session id exits cleanly without loading anything', async () => {
  const { out, deps } = recorder();
  let loaded = false;
  deps.decoder = decoderOf(null);
  await runHook({
    name: 'tool-event',
    deps,
    load: () => { loaded = true; return Promise.resolve({}); },
    handle: () => { throw new Error('unreachable'); },
  });
  assert.equal(loaded, false);
  assert.deepEqual(out.exits, [0]);
  assert.deepEqual(out.issues, [], 'an unattributable payload is not a crash');
});

test('a throwing diagnostics callback cannot change the hook outcome', async () => {
  const { out, deps } = recorder();
  deps.recordIssue = () => { throw new Error('telemetry is broken'); };
  await runHook({
    name: 'stop',
    deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  assert.deepEqual(out.exits, [0]);
  assert.equal(out.stdout, '');
});

test('a diagnostics callback that rejects is never awaited and never reported', async () => {
  const { out, deps } = recorder();
  deps.recordIssue = () => Promise.reject(new Error('telemetry is offline'));
  await runHook({
    name: 'stop',
    deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  // One turn of the microtask queue: an un-suppressed rejection would surface here.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(out.exits, [0]);
});

test('the handler is given the decoded input, the raw payload and the stampable cwd', async () => {
  const { out, deps } = recorder();
  let seen = null;
  await runHook({
    name: 'tool-event',
    deps,
    load: () => Promise.resolve({ marker: 1 }),
    handle: (loaded, ctx) => { seen = { loaded, ctx }; },
  });
  assert.deepEqual(seen.loaded, { marker: 1 });
  assert.equal(seen.ctx.input.session_id, 'conv-1');
  assert.equal(seen.ctx.payload, PAYLOAD);
  assert.equal(seen.ctx.cwd, '/w');
  assert.deepEqual(out.exits, [0]);
});

test('the remaining deadline is the hook budget, and it shrinks', async () => {
  const { deps } = recorder();
  let clock = 1000;
  deps.now = () => clock;
  let remaining = null;
  await runHook({
    name: 'stop-failure',
    deps,
    load: () => Promise.resolve({}),
    handle: (loaded, ctx) => { clock += 500; remaining = ctx.remainingMs(); },
  });
  assert.equal(remaining, hookBudgetMs(false) - 500);
});

// ── the permission path ──────────────────────────────────────────────────────────────────────────

test('a permission hook never drains a dispatcher on the way out', async () => {
  const { out, deps } = recorder();
  let drained = false;
  deps.shutdown = { exitClean: () => { drained = true; } };
  await runHook({
    name: 'mcp-before',
    permission: true,
    deps,
    load: () => Promise.resolve({}),
    handle: () => {},
  });
  assert.equal(drained, false, 'the permission path holds no socket and must not wait on one');
  assert.deepEqual(out.exits, [0]);
});

test('a failing permission hook stays silent by default', async () => {
  // Cursor READS AND OBEYS a permission hook's stdout. Silence is the fail-open answer this plugin
  // has always given and the one test/plugin-manifest.test.mjs pins; `{}` is the alternative
  // spelling of the same allow, available but not the default. See the module header.
  const { out, deps } = recorder();
  await runHook({
    name: 'subagent-start',
    permission: true,
    deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  assert.equal(out.stdout, PERMISSION_FAILURE_OUTPUT);
  assert.equal(out.stdout, '');
  assert.deepEqual(out.exits, [0]);
});

test('the explicit allow token is emitted only when a caller asks for it', async () => {
  const { out, deps } = recorder();
  await runHook({
    name: 'subagent-start',
    permission: true,
    failOutput: PERMISSION_ALLOW_OUTPUT,
    deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  assert.equal(out.stdout, '{}');
  assert.deepEqual(out.exits, [0]);
});

test('one run’s write does not suppress the next run’s fail-open token', async () => {
  // `wroteStdout` is module state, because a hook PROCESS runs exactly one hook and "has the stream
  // been committed to?" is one fact about it. A suite is the one place that is not true: without a
  // reset at the top of runHook, a run that emitted would leave the flag set and the NEXT run would
  // silently skip its fail-open token — passing or failing on test order rather than on behaviour.
  const first = recorder();
  await runHook({
    name: 'session-start',
    deps: first.deps,
    load: () => Promise.resolve({}),
    handle: (loaded, ctx) => { ctx.emit({ systemMessage: 'hi' }); },
  });
  assert.equal(first.out.stdout, '{"systemMessage":"hi"}');

  const second = recorder();
  await runHook({
    name: 'mcp-before',
    permission: true,
    failOutput: PERMISSION_ALLOW_OUTPUT,
    deps: second.deps,
    load: () => Promise.resolve({}),
    handle: () => { throw new Error('boom'); },
  });
  assert.equal(second.out.stdout, '{}', 'the previous run left the stream marked as written');
});

test('a failure after the handler has written cannot corrupt that write', async () => {
  // The banner hook writes one JSON object to stdout. Appending a second token behind it would hand
  // the host two concatenated objects — which is not "fail-open", it is malformed.
  const { out, deps } = recorder();
  await runHook({
    name: 'session-start',
    permission: true,
    failOutput: PERMISSION_ALLOW_OUTPUT,
    deps,
    load: () => Promise.resolve({}),
    handle: (loaded, ctx) => { ctx.emit({ systemMessage: 'hi' }); throw new Error('boom'); },
  });
  assert.equal(out.stdout, '{"systemMessage":"hi"}');
  assert.deepEqual(out.exits, [0]);
});

// ── the guards ───────────────────────────────────────────────────────────────────────────────────

test('installHookGuards registers both process handlers before anything else runs', () => {
  const events = [];
  installHookGuards({ name: 'stop', deps: { on: (ev) => events.push(ev), exit: () => {} } });
  assert.deepEqual(events, ['uncaughtException', 'unhandledRejection']);
});

test('an uncaught exception exits 0 and records one issue', () => {
  const handlers = {};
  const exits = [];
  const issues = [];
  installHookGuards({
    name: 'stop',
    deps: {
      on: (ev, fn) => { handlers[ev] = fn; },
      exit: (code) => exits.push(code),
      recordIssue: (code) => issues.push(code),
    },
  });
  handlers.uncaughtException(new Error('boom'));
  handlers.uncaughtException(new Error('again'));
  assert.deepEqual(exits, [0], 'the second failure must not double-exit');
  assert.deepEqual(issues, ['hook_crash']);
});

test('an unhandled rejection exits 0 under its own code', () => {
  const handlers = {};
  const exits = [];
  const issues = [];
  installHookGuards({
    name: 'tool-event',
    deps: {
      on: (ev, fn) => { handlers[ev] = fn; },
      exit: (code) => exits.push(code),
      recordIssue: (code) => issues.push(code),
    },
  });
  handlers.unhandledRejection(new Error('boom'));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(issues, ['hook_unhandled_rejection']);
});

test('the guards carry no message, stack or path into diagnostics', () => {
  const handlers = {};
  const issues = [];
  installHookGuards({
    name: 'stop',
    deps: {
      on: (ev, fn) => { handlers[ev] = fn; },
      exit: () => {},
      recordIssue: (code, fields) => issues.push(fields),
    },
  });
  handlers.uncaughtException(new Error('C:/Users/someone/secret.mjs blew up'));
  const serialized = JSON.stringify(issues);
  assert.ok(!serialized.includes('secret'), 'a stack or message must never reach the wire');
  assert.ok(!serialized.includes('Users'));
  assert.deepEqual(Object.keys(issues[0]).sort(), ['source']);
});


// ── occurrence time ──────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 6, 31, 10, 0, 0);

test('a captured ISO instant survives a delayed send', () => {
  // The whole point: the report may be queued, retried and delivered an hour later, and it must
  // still describe when the failure happened.
  assert.equal(
    hookOccurredAt({ occurred_at: '2026-07-31T09:12:34.500Z' }, NOW),
    '2026-07-31T09:12:34.500Z',
  );
});

test('a captured epoch in milliseconds is accepted', () => {
  assert.equal(hookOccurredAt({ occurred_at: Date.UTC(2026, 6, 31, 9, 0, 0) }, NOW), '2026-07-31T09:00:00.000Z');
});

test('a missing timestamp falls back to this run’s clock', () => {
  assert.equal(hookOccurredAt({}, NOW), new Date(NOW).toISOString());
  assert.equal(hookOccurredAt(null, NOW), new Date(NOW).toISOString());
});

test('an invalid timestamp falls back rather than being coerced', () => {
  for (const bad of ['', 'yesterday', 'July 2026', '1753952400', 0, -1, NaN, Infinity, {}, [], true]) {
    assert.equal(
      hookOccurredAt({ occurred_at: bad }, NOW),
      new Date(NOW).toISOString(),
      `${JSON.stringify(bad)} was believed`,
    );
  }
});

test('a seconds-epoch value is rejected, not multiplied by a thousand', () => {
  // 1753952400 is a perfectly real instant in SECONDS and lands in 1970 read as milliseconds.
  // Rescaling it would be inventing a unit the host never declared, so it falls back instead.
  assert.equal(hookOccurredAt({ occurred_at: 1753952400 }, NOW), new Date(NOW).toISOString());
});

test('an instant outside the plausible window is rejected at both ends', () => {
  assert.equal(hookOccurredAt({ occurred_at: '1999-12-31T23:59:59.000Z' }, NOW), new Date(NOW).toISOString());
  assert.equal(hookOccurredAt({ occurred_at: '2101-01-01T00:00:00.000Z' }, NOW), new Date(NOW).toISOString());
});

test('the handler is handed the occurrence time on ctx', async () => {
  const { out, deps } = recorder();
  deps.decoder = decoderOf(PAYLOAD, {
    normalizeHookInput: (p) => ({ session_id: p.session_id, cwd: p.cwd, occurred_at: '2026-07-31T09:12:34.500Z' }),
  });
  let seen = null;
  await runHook({
    name: 'stop-failure',
    deps,
    load: () => Promise.resolve({}),
    handle: (loaded, ctx) => { seen = ctx.occurredAt; },
  });
  assert.equal(seen, '2026-07-31T09:12:34.500Z');
  assert.deepEqual(out.exits, [0]);
});
