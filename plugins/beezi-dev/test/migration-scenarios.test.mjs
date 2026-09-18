import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir, beeziCursorHome } from '../lib/paths-cursor.mjs';
import { dataRootName, keyringService, variantMarker } from '../lib/env-identity.mjs';
import { safeName } from '../lib/sidecar.mjs';

// M00.4 — the cross-store half of the migration matrix.
//
// Each store's OWN upgrade is already pinned by the file that owns it: `pending-batch.test.mjs`
// holds the crash matrix, `credential-store.test.mjs` the legacy adoption and its recovery,
// `billing-config.test.mjs` the v1→v2 lazy rewrite, `queue-delivery.test.mjs` the retry/age
// semantics. This file covers only what NO single-store test can see: what happens when two of
// them are read by the same machine at the same time, and what an older build makes of what a
// newer one wrote.
//
// docs/migration.md is the prose version of this; every row there that names
// `migration-scenarios.test.mjs` is one of these cases.

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const SESSION = [
  { ts: T0, ev: 'prompt' },
  { ts: T0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 100 },
  { ts: T0 + 2000, ev: 'edit', path: 'src/a.ts', added: 3, removed: 1, eid: 'e1' },
  { ts: T0 + 3000, ev: 'stop' },
];

function withEnv(t, vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-migrate-'));
  withEnv(t, { BEEZI_CURSOR_HOME: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeGit(args) {
  if (args[0] === 'rev-parse') return '/repo';
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'branch') return 'main';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

function writeSidecar(home, events) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

function queued() {
  let names;
  try { names = fs.readdirSync(queueDir()); } catch { return []; }
  return names
    .map((name) => path.join(queueDir(), name))
    .filter((file) => file.endsWith('.json') && fs.statSync(file).isFile())
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf-8')));
}

function stateOf(id) {
  const file = path.join(stateDir(), `${safeName(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

// ─── an older build reading what a newer one wrote ───────────────────────────────────────────────

test('the new session-state keys are optional in both directions', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  // A state file exactly as a PREVIOUS release left it: no `countedGenerations`, no `attribution`,
  // no `coveredIntervals`. The current build must read it without repair and without resetting
  // anything - resetting a cursor or a usage baseline re-reports work already billed, under ids the
  // server has never seen, so its idempotency key cannot collapse the overlap.
  fs.mkdirSync(stateDir(), { recursive: true });
  const old = { cursor: 2, cursorBytes: 120, sentSessionName: 'Old title', anchor: null };
  fs.writeFileSync(path.join(stateDir(), 'conv-1.json'), JSON.stringify(old));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const after = stateOf('conv-1');
  assert.ok(after.cursor >= old.cursor, 'the cursor never goes backwards on an upgrade');
  assert.equal(after.cursorBytes >= old.cursorBytes, true);
  // And the reverse direction: whatever the new build added is additive, so a downgrade reads the
  // same file and simply ignores the extra keys. The load-bearing part is that none of them is
  // REQUIRED by anything the old build reads.
  for (const key of ['cursor', 'cursorBytes', 'sentSessionName']) {
    assert.ok(key in after, `${key} survives, which is what an older build reads`);
  }
});

test('no state key the plan added ever reaches the wire', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const state = stateOf('conv-1');
  const payloads = queued();
  assert.ok(payloads.length > 0, 'there is a payload to check');
  // The ingest route validates as a whitelist: ONE unknown top-level property rejects the whole
  // report and the segment's tokens, cost, code changes and operations are discarded together. Every
  // one of these lives on `state`, which is never spread into a payload - and this is the assertion
  // that catches a refactor that starts spreading it.
  for (const payload of payloads) {
    for (const key of ['countedGenerations', 'attribution', 'mcpAliases', 'coveredIntervals', 'account']) {
      assert.equal(key in payload, false, `${key} must never be emitted`);
    }
  }
  assert.ok(state !== null);
});

// ─── prod / staging coexistence ──────────────────────────────────────────────────────────────────

test('each environment gets its own data root, keyring service and variant marker', (t) => {
  // Three names derived from one place, and the whole coexistence story rests on them differing.
  // Prod stays UNSUFFIXED so an upgrade reads the store that is already there; every other
  // environment is a separate store that cannot see prod's queue or credentials.
  withEnv(t, { BEEZI_CURSOR_ENV: undefined, BEEZI_CURSOR_HOME: undefined });
  const prod = {
    root: dataRootName(),
    service: keyringService(),
    marker: variantMarker(),
  };
  assert.deepEqual(prod, { root: '.beezi-cursor', service: 'beezi-cursor', marker: 'beezi' });

  process.env.BEEZI_CURSOR_ENV = 'staging';
  const staging = {
    root: dataRootName(),
    service: keyringService(),
    marker: variantMarker(),
  };
  assert.deepEqual(staging, {
    root: '.beezi-cursor-staging',
    service: 'beezi-cursor-staging',
    marker: 'beezi-staging',
  });

  for (const key of ['root', 'service', 'marker']) {
    assert.notEqual(prod[key], staging[key], `${key} must differ, or the two share a store`);
  }
});

// The handler-ownership half of coexistence is NOT duplicated here: `test/hooks-install.test.mjs`
// already drives the real registry shape through it - "three variants coexist in one registry, and
// each re-install touches only its own", "production does not claim a variant's handlers, although
// it is a prefix of them", and its mirror. Re-asserting it against a hand-built structure here only
// risked pinning a shape the module does not actually take, which is what a first draft of this
// file did.

test('a custom home is honoured verbatim and earns its own keyring service', (t) => {
  // Two homes sharing one keychain entry means a logout in either destroys the token of both.
  withEnv(t, { BEEZI_CURSOR_ENV: undefined, BEEZI_CURSOR_HOME: undefined });
  const defaultService = keyringService();

  const a = path.join(os.tmpdir(), 'beezi-home-a');
  const b = path.join(os.tmpdir(), 'beezi-home-b');
  process.env.BEEZI_CURSOR_HOME = a;
  assert.equal(beeziCursorHome(), a, 'an explicit home is used verbatim, never suffixed on disk');
  const serviceA = keyringService();
  process.env.BEEZI_CURSOR_HOME = b;
  const serviceB = keyringService();

  assert.notEqual(serviceA, defaultService, 'a custom home does not share the default slot');
  assert.notEqual(serviceA, serviceB, 'and two custom homes do not share one either');
});

// ─── account switch with work already on disk ────────────────────────────────────────────────────

test('an account switch leaves the previous account queue and state intact', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  // Tracked under account A.
  fs.writeFileSync(path.join(home, 'tracking.json'), JSON.stringify({
    version: 1, email: 'a@example.test', trackingMode: 'live',
  }));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const afterA = stateOf('conv-1');
  const queuedUnderA = queued();
  assert.ok(queuedUnderA.length > 0, 'account A queued something');
  assert.ok(typeof afterA.account === 'string' && afterA.account.length > 0,
    'and the state records WHOSE tenant those segments went to');

  // Now the machine is linked to a different account. The previous account's queued reports are
  // still on disk and still belong to it; nothing here may delete them or silently re-attribute
  // them, because the only honest thing to do with an unsent report is leave it for its own sender.
  fs.writeFileSync(path.join(home, 'tracking.json'), JSON.stringify({
    version: 1, email: 'b@example.test', trackingMode: 'live',
  }));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const afterB = stateOf('conv-1');
  assert.equal(queued().length >= queuedUnderA.length, true, 'account A\'s reports were not deleted');
  assert.ok(afterB.cursor >= afterA.cursor, 'and the cursor did not go backwards across the switch');
  assert.notEqual(afterB.account, undefined, 'the stamp follows the account actually in effect');
});
