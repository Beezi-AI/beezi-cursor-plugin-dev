import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKIN_TIMEOUT_MS, REVOKE_CHECK_TIMEOUT_MS, runSessionStart } from '../lib/session-start.mjs';
import { ensureInstalled } from '../lib/plugin-install.mjs';
import { eventsFileFor, safeName } from '../lib/sidecar.mjs';
import { POST_TIMEOUT_MS } from '../lib/http.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

// CURSOR_CONFIG_DIR is redirected as well as BEEZI_CURSOR_HOME, and it is not optional: session
// start now calls ensureInstalled, which merges Beezi's entries into `<cursorConfigDir>/hooks.json`.
// Without this the suite would rewrite the developer's real ~/.cursor/hooks.json on every run — the
// same rule test/hooks-install.test.mjs states outright, now that a lifecycle path reaches there too.
function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-session-start-'));
  const prev = { home: process.env.BEEZI_CURSOR_HOME, cursor: process.env.CURSOR_CONFIG_DIR };
  process.env.BEEZI_CURSOR_HOME = dir;
  process.env.CURSOR_CONFIG_DIR = path.join(dir, 'cursor');
  t.after(() => {
    for (const [name, value] of [['BEEZI_CURSOR_HOME', prev.home], ['CURSOR_CONFIG_DIR', prev.cursor]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Everything a linked session needs that this file is not currently asserting about. Each test
// overrides only the dep it is interested in.
function linkedDeps(overrides = {}) {
  return {
    getAccessToken: async () => 'tok',
    gitImpl: gitNotARepo,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    whoami: async () => ({ valid: true }),
    ensureInstalled: () => ({ source: 'launcher', actions: [] }),
    detectBillingSource: () => 'subscription',
    readBillingConfig: () => ({}),
    isStale: () => false,
    // NOT OPTIONAL, and not a convenience. Both defaults read the DEVELOPER'S OWN Cursor state —
    // `readExtensibility` opens state.vscdb and `readCursorAccount` scans it for `cursorAuth/` —
    // and neither lives under BEEZI_CURSOR_HOME, so tmpHome cannot redirect them. A case that
    // forgets one reads the machine running the suite, and its result then depends on whether that
    // developer happens to have third-party extensibility switched on.
    readExtensibility: () => null,
    readCursorAccount: () => ({ source: 'no-source', plan: null }),
    // `isDue` gates the deterministic plan read. Defaulted off so no case pays for the reconcile
    // path unless it is the thing being tested.
    isDue: () => false,
    // The account check-in, stubbed for the same reason `readCursorAccount` is: the real one reads
    // the machine's own tracking cache and, on a machine that has one, would reach a socket. A
    // suite must never depend on whether the developer running it happens to be signed in.
    syncAccount: async () => null,
    ...overrides,
  };
}

async function waitFor(predicate, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

// A file old enough for pruneStale's 14-day rule, in the sidecar directory nothing else on the
// machine ever deletes from.
function staleSidecarFile(home) {
  const dir = path.join(home, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old-conversation.jsonl');
  fs.writeFileSync(file, '{"ts":0}\n');
  const thirtyDaysAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(file, thirtyDaysAgo, thirtyDaysAgo);
  return file;
}

function gitWithOrigin(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return '/repo';
  return '';
}

function gitWithoutOrigin(args) {
  if (args[0] === 'remote') throw new Error("error: No such remote 'origin'");
  if (args[0] === 'rev-parse') return '/repo';
  return '';
}

function gitNotARepo() {
  throw new Error('fatal: not a git repository');
}

test('unlinked machine warns that analytics are not tracked', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    { getAccessToken: async () => null, gitImpl: gitWithOrigin, fetchImpl: async () => ({ ok: true }) },
  );
  assert.match(msg, /not linked/i);
});

test('no origin still announces local tracking', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({ gitImpl: gitWithoutOrigin }),
  );
  assert.match(msg, /no "origin" remote/i);
  assert.match(msg, /tracking as a local repo/i);
});

test('not linked to a Beezi project still says analytics are tracked', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithOrigin,
      fetchImpl: async () => ({ ok: true, json: async () => ({ connected: false }) }),
    }),
  );
  assert.match(msg, /not linked to a Beezi project/i);
  assert.match(msg, /still tracked/i);
  assert.doesNotMatch(msg, /No analytics tracked/i);
});

test('connected repo announces tracking', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithOrigin,
      fetchImpl: async () => ({ ok: true, json: async () => ({ connected: true, projectName: 'Acme' }) }),
    }),
  );
  assert.match(msg, /connected to "Acme"/);
  assert.match(msg, /Session analytics are tracked/);
});

test('a non-git cwd stays silent about repo status', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/not-a-repo' },
    linkedDeps({ gitImpl: gitNotARepo }),
  );
  assert.equal(msg, null);
});

// ── The reorder: local work must not be hostage to the network ──────────────────────────────────

test('a revocation check that never answers cannot stop the prune', async (t) => {
  // This is the whole point of moving pruneStale ahead of the network, and it was untested.
  //
  // The check used to be awaited serially at the very top of the hook, on an inherited 10s read
  // default, under Cursor's hard 10s kill. On a machine whose portal was persistently slow the hook
  // was killed before it ever reached the prune — and pruneStale is the ONLY caller of lib/prune.mjs
  // anywhere on the machine. "The API is slow" therefore meant "state/, queue/ and the append-only
  // events/ sidecar grow forever", silently, for as long as the slowness lasted.
  const home = tmpHome(t);
  const stale = staleSidecarFile(home);

  let settle;
  const neverAnswers = new Promise((resolve) => { settle = resolve; });
  // Release it however the test ends, so a failed assertion cannot leave node --test hanging.
  t.after(() => settle({ valid: true }));

  let finished = false;
  const done = runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ whoami: () => neverAnswers }),
  ).then((msg) => { finished = true; return msg; });

  assert.ok(
    await waitFor(() => !fs.existsSync(stale)),
    'the 14-day sweep never ran — pruneStale is behind the network again',
  );
  assert.equal(finished, false, 'the hook should still be waiting on the stalled revocation check');

  settle({ valid: true });
  await done;
});

test('the revocation check is given an explicit budget, never a default it inherited', async (t) => {
  tmpHome(t);
  let opts = null;
  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ whoami: async (_token, o) => { opts = o; return { valid: true }; } }),
  );
  assert.equal(opts.timeoutMs, REVOKE_CHECK_TIMEOUT_MS);
  // The number matters less than the fact that it is stated here: the acute failure was this call
  // site silently inheriting whoami's 10s read default and spending more than the hook's whole
  // budget on an identity lookup that is not the turn's purpose.
  assert.ok(opts.timeoutMs < 10_000, 'a hook-path check must not be able to outlast the hook');
});

test('a rejected token owns the banner outright — and the credential is KEPT', async (t) => {
  // REVERSED ASSERTION, deliberately (integration step 5, S-1 / AUTH-03). This used to assert that
  // the hook DELETED the credential. No hook may: deletion is what an explicit logout does, and a
  // sign-in replaces the credential by committing a new generation. The old behaviour meant a
  // portal answering 401 for any reason — including a brief misconfiguration — destroyed a link the
  // user then had to rebuild through a browser.
  //
  // What did not change: the warning owns the message outright. "Repo connected, session analytics
  // are tracked" is a lie on a machine whose token the portal has just refused, so neither the repo
  // announcement nor the plan nudge may survive.
  tmpHome(t);
  let deleted = 0;
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      deleteCredentials: async () => { deleted += 1; },
      gitImpl: gitWithOrigin,
      fetchImpl: async () => ({ ok: true, json: async () => ({ connected: true, projectName: 'Acme' }) }),
      whoami: async () => ({ valid: false }),
      isStale: () => true,
    }),
  );
  assert.equal(deleted, 0, 'a hook must never delete a credential');
  assert.match(msg, /rejected/i);
  assert.doesNotMatch(msg, /Acme/);
  assert.doesNotMatch(msg, /plan/i);
});

test('a rejected machine is still pruned before it is told', async (t) => {
  // The old code returned on revocation before initSessionState, the prune or the repo-map ever ran.
  // A machine whose link was refused is precisely one nothing else will ever sweep.
  const home = tmpHome(t);
  const stale = staleSidecarFile(home);
  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ whoami: async () => ({ valid: false }) }),
  );
  assert.equal(fs.existsSync(stale), false);
});

test('a stalled repo-status body degrades to silence instead of holding the hook open', async (t) => {
  // postJson's abort timer is cleared when the HEADERS arrive, so `await res.json()` used to run
  // with nothing but undici's 300s bodyTimeout underneath it — inside a Promise.all, under a 10s
  // kill. readJsonBounded turns that into the same outcome as being offline.
  tmpHome(t);
  const startedAt = Date.now();
  // withLoopAlive: a real stalled body stalls on a ref'd socket; this fake holds nothing, which
  // leaves readJsonBounded's unref'd abandon timer as the only handle. See helpers/loop-alive.mjs.
  const msg = await withLoopAlive(() => runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithOrigin,
      fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    }),
  ));
  assert.equal(msg, null);
  // The seconds this test spends ARE the assertion: the body is abandoned on the request's own
  // budget. Before, this call did not settle at all.
  assert.ok(Date.now() - startedAt < POST_TIMEOUT_MS * 2, 'the body read outlived the budget it shares');
});

test('a session id that would escape the state directory is sanitized, not obeyed', async (t) => {
  // session_id arrives in a hook payload — untrusted input spliced into a path. The state directory
  // is also what pruneStale deletes from on an mtime rule, so a file placed outside it by a `../`
  // is both an escape and something nothing will ever clean up.
  const home = tmpHome(t);
  const id = '../../escape';
  await runSessionStart({ session_id: id, cwd: null }, linkedDeps());

  assert.ok(fs.existsSync(path.join(home, 'state', `${safeName(id)}.json`)));
  assert.equal(fs.existsSync(path.join(path.dirname(home), 'escape.json')), false);
});

// ── CLI readiness: the registry cursor-agent needs, written from a path the CLI machine reaches ──

test('session start installs the user-scope registry, and skips the work once it is there', async (t) => {
  // ensureInstalled used to run from scripts/mcp.mjs's startup and nowhere else. That is the IDE's
  // MCP server — a separately disableable subsystem — so `~/.cursor/hooks.json` could go unwritten
  // indefinitely, and it is the ONLY registry older `cursor-agent` builds read (Cursor staff, forum
  // 163890).
  const home = tmpHome(t);
  let calls = 0;
  let actions = null;
  // The real installer, wrapped: the env redirection above keeps every path it writes inside `home`.
  const spy = () => { calls += 1; const r = ensureInstalled(); actions = r.actions; return r; };

  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps({ ensureInstalled: spy }));
  assert.equal(calls, 1, 'session start never called ensureInstalled');
  assert.ok(actions.some((a) => a.startsWith('user-hooks-installed')), actions.join(','));
  assert.ok(fs.existsSync(path.join(home, 'cursor', 'hooks.json')), 'the CLI registry was not written');

  // Cheap on every session after the first: the shim is only rewritten when its content differs, and
  // an already-`installed` status short-circuits the install. This has to hold — it is what makes it
  // acceptable to put on a per-session hot path at all.
  await runSessionStart({ session_id: 'conv-2', cwd: null }, linkedDeps({ ensureInstalled: spy }));
  assert.equal(calls, 2);
  assert.deepEqual(actions, [], 'a correct registry must not be rewritten every session');
});

test('an installer that throws never takes the session down with it', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ ensureInstalled: () => { throw new Error('hooks.json is not writable'); } }),
  );
  assert.equal(msg, null);
});


// ═══ the four-writer merge (integration step 5) ═════════════════════════════════════════════════
//
// `runSessionStart` is the one function four lanes all had to change, and two of those changes
// directly contradicted each other. What follows pins the merged shape rather than any lane's
// branch: auth's semantics (nothing is ever deleted), pipe's ordering (one serial probe, persisted
// before anything is posted or announced), M09-03's message model (built from TrackingMode, not
// from a boolean) and bill's plan read (bounded, and re-budgeted so the reordering does not
// silently disable it).

import { commitCredentials, readCredentialRecord } from '../lib/credentials.mjs';
import { flushQueue as realFlushQueue, HOOK_BUDGET_MS } from '../lib/checkpoint.mjs';
import { TrackingMode, readTrackingState } from '../lib/tracking.mjs';
import { EXTENSIBILITY_SETTING } from '../lib/extensibility.mjs';

// The plain-file credential backend: no keyring, no subprocess, nothing machine-specific. A suite
// must never touch the real credential store.
const FILE_STORE = { platform: 'sunos' };

async function storeCredential() {
  const committed = await commitCredentials({
    client_id: 'cid',
    token_endpoint: 'https://example.test/oauth/token',
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: Date.now() + 3_600_000,
  }, FILE_STORE);
  assert.equal(committed.status, 'committed', `commit failed: ${JSON.stringify(committed)}`);
  const before = await readCredentialRecord(FILE_STORE);
  assert.equal(before.status, 'ok');
  return before;
}

// ── AUTH-03: neither refusal may destroy a credential ───────────────────────────────────────────

test('startup against a 403 leaves the stored credential at ok, on the same generation', async (t) => {
  // THE AUTH-03 GATE CLOSER, and the reason it is asserted against the REAL store rather than
  // against an injected `deleteCredentials` spy: the old code called a function, but what matters is
  // the credential, and a future refactor could destroy it by some other route.
  //
  // 403 is authentication succeeding and authorization failing. Signing in again cannot grant a
  // seat, so wiping the credential loses a link that may well come back — and then tells the user to
  // rebuild it through a browser for nothing.
  tmpHome(t);
  const before = await storeCredential();

  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ whoami: async () => ({ valid: false, forbidden: true }) }),
  );

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, 'ok', 'the credential survives a 403');
  assert.equal(after.generation, before.generation, 'and it is the same generation, not a new one');
  assert.match(msg, /not permitted/i);
  assert.match(msg, /link was kept/i);
  assert.doesNotMatch(msg, /not linked/i, 'a 403 is not an unlinked machine');
  assert.doesNotMatch(msg, /beezi-login/i, 'and signing in again cannot fix it');
});

test('startup against a 401 deletes nothing either', async (t) => {
  tmpHome(t);
  const before = await storeCredential();

  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({ whoami: async () => ({ valid: false }) }),
  );

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, 'ok', 'the credential survives a 401 too');
  assert.equal(after.generation, before.generation);
  // A 401 IS worth a re-sign-in, unlike a 403 — the next sign-in is what replaces the credential.
  assert.match(msg, /rejected/i);
  assert.match(msg, /beezi-login/i);
});

// ── ordering: the local block, then one probe, then everything that depends on it ──────────────

test('the prune AND the hold sweep both complete when whoami never resolves', async (t) => {
  // pruneStale was already asserted here. `sweepHeldQueue` is the other half and had no call site
  // at all before this merge: the three-day hold was implemented and never scheduled. pruneStale
  // cannot substitute — it deletes at 14 days on mtime, and recording a retry rewrites the file,
  // which refreshes the mtime.
  const home = tmpHome(t);
  const stale = staleSidecarFile(home);
  let sweptAt = null;

  let settle;
  const neverAnswers = new Promise((resolve) => { settle = resolve; });
  t.after(() => settle({ valid: true }));

  const done = runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: () => neverAnswers,
      sweepHeldQueue: ({ now }) => { sweptAt = now; },
    }),
  );

  assert.ok(await waitFor(() => !fs.existsSync(stale) && sweptAt !== null), 'the local block is behind the network again');
  assert.equal(typeof sweptAt, 'number', 'the sweep is given the hook clock, not its own');
  settle({ valid: true });
  await done;
});

test('policy is persisted BEFORE the first flush and the first repo announcement', async (t) => {
  // Asserted on CALL ORDER through one shared array, never on timing. Before this merge the whoami
  // verdict resolved inside the same Promise.all as the flush and the announcement, so it landed
  // after both — and a disabled tenant got one more report and one more "analytics are tracked"
  // claim on every session start, forever.
  tmpHome(t);
  const order = [];
  await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithOrigin,
      whoami: async () => { order.push('whoami'); return { valid: true, trackingMode: TrackingMode.LIVE }; },
      recordWhoami: () => { order.push('recordWhoami'); },
      flushQueue: async () => { order.push('flush'); return { flushed: 0 }; },
      fetchImpl: async () => { order.push('reposStatus'); return { ok: true, json: async () => ({ connected: false }) }; },
    }),
  );

  assert.equal(order[0], 'whoami');
  assert.equal(order[1], 'recordWhoami');
  assert.ok(order.indexOf('flush') > order.indexOf('recordWhoami'), 'the flush must not start before the verdict is stored');
  assert.ok(order.indexOf('reposStatus') > order.indexOf('recordWhoami'), 'nor the announcement');
  assert.equal(order.filter((e) => e === 'whoami').length, 1, 'ONE probe — a second would spend the budget twice on one question');
});

test('the flush is given the hook budget anchored at ENTRY, not a fresh one after the probe', async (t) => {
  tmpHome(t);
  let deadline = null;
  const before = Date.now();
  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: async () => ({ valid: true }),
      flushQueue: async (token, options) => { deadline = options.deadline; return { flushed: 0 }; },
    }),
  );
  const after = Date.now();

  assert.ok(deadline >= before + HOOK_BUDGET_MS, 'the deadline is absolute, measured from entry');
  assert.ok(deadline <= after + HOOK_BUDGET_MS, 'and the probe did not grant the flush a new one');
});

test('a probe that eats the whole budget leaves the queue alone and starts no late POST', async (t) => {
  // Driven through the REAL delivery loop, not a stub: the hook hands over the deadline it anchored
  // at entry, the loop finds it already spent, and the queued file is deferred rather than becoming
  // a request that cannot finish inside Cursor's hard kill. The clock the loop sees is the only
  // thing this test fakes.
  const home = tmpHome(t);
  const queue = path.join(home, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'seg.json'), JSON.stringify({ segmentId: 's:1' }));
  const posts = [];
  let flush = null;

  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: async () => ({ valid: true }),
      flushQueue: async (token, options) => {
        flush = await realFlushQueue(token, { ...options, now: () => Date.now() + HOOK_BUDGET_MS + 1000 });
        return flush;
      },
      fetchImpl: async (url) => { posts.push(String(url)); return { ok: true, json: async () => ({}) }; },
    }),
  );

  assert.equal(flush.deferred, 1, 'the spent budget defers the file');
  assert.equal(flush.sent, 0);
  assert.deepEqual(posts.filter((u) => u.includes('/sessions/report')), [], 'no report was posted');
  assert.deepEqual(fs.readdirSync(queue), ['seg.json'], 'the queued segment is untouched');
});

// ── M09-03: the message model ───────────────────────────────────────────────────────────────────

test('a disabled tenant posts no report and never claims analytics are tracked', async (t) => {
  tmpHome(t);
  const urls = [];
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithOrigin,
      whoami: async () => ({ valid: true, trackingMode: TrackingMode.DISABLED }),
      flushQueue: async () => { urls.push('/sessions/report'); return { flushed: 0 }; },
      fetchImpl: async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ connected: true, projectName: 'Acme' }) }; },
    }),
  );

  // The policy the message describes is the policy that was persisted, not a second derivation.
  assert.equal(readTrackingState().trackingMode, TrackingMode.DISABLED);
  assert.match(msg, /turned off for this workspace/i);
  assert.doesNotMatch(msg, /analytics are tracked/i, 'the tracked claim must be suppressed');
  assert.doesNotMatch(msg, /still tracked/i);
  // SUPERSEDED BY A3, replaced rather than dropped. This line used to require `connected to "Acme"`
  // — "the repo fact is still true and still worth saying". It was only ever knowable because the
  // hook POSTed the repository's `origin` URL to /repos/status, which is the thing a disabled
  // tenant must not do. There is no server answer to quote now, so the requirement inverts: the
  // banner may not contain one, and the absence is proved by the request never being made.
  assert.doesNotMatch(msg, /connected to "Acme"/, 'nothing was asked, so nothing may be quoted');
  assert.deepEqual(
    urls.filter((u) => u.includes('/repos/status')),
    [],
    'a disabled tenant does not announce its repo remote',
  );
});

test('a backfill_only tenant gets the HELD wording, never the disabled wording', async (t) => {
  // The distinction a boolean cannot carry, and the reason M09-03 asks for the mode. `backfill_only`
  // means the work is recorded and held and will reach the server later; `disabled` means it will
  // not. Promising the first when it is the second promises delivery that never happens.
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: async () => ({ valid: true, trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false }),
      flushQueue: async () => ({ flushed: 0 }),
    }),
  );

  assert.match(msg, /paused/i);
  assert.match(msg, /held/i);
  assert.doesNotMatch(msg, /turned off/i);
  assert.doesNotMatch(msg, /nothing from this session is reported/i);
  // Audit/history policy is a separate decision, and the one-time import is still offered.
  assert.match(msg, /beezi-login/i);
});

test('a completed backfill on a paused tenant does not re-offer the import', async (t) => {
  tmpHome(t);
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: async () => ({ valid: true, trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: true }),
      flushQueue: async () => ({ flushed: 0 }),
    }),
  );
  assert.match(msg, /paused/i);
  assert.match(msg, /nothing is lost/i);
  assert.doesNotMatch(msg, /beezi-login/i, 'the one-time pull is sealed — offering it again is a dead end');
});

test('a live mode and an unknown mode both produce the byte-identical pre-patch message', async (t) => {
  // The regression guard for the whole message model: the overwhelmingly common case must be
  // untouched, to the byte. An indeterminate probe must also not assert a fresh policy decision —
  // it says nothing, rather than inventing either reassurance or alarm.
  for (const who of [
    async () => ({ valid: true, trackingMode: TrackingMode.LIVE }),
    async () => ({ valid: true }),
    async () => null,
  ]) {
    const home = tmpHome(t);
    const urls = [];
    const msg = await runSessionStart(
      { session_id: 'conv-1', cwd: '/repo' },
      linkedDeps({
        gitImpl: gitWithOrigin,
        whoami: who,
        flushQueue: async () => { urls.push('flush'); return { flushed: 0 }; },
        fetchImpl: async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ connected: true, projectName: 'Acme' }) }; },
      }),
    );
    assert.equal(msg, 'Beezi: repo connected to "Acme". Session analytics are tracked.');
    assert.equal(urls.filter((u) => u === 'flush').length, 1, 'the same HTTP call set as before');
    assert.equal(urls.filter((u) => String(u).includes('/repos/status')).length, 1);
    assert.ok(home);
  }
});

// ── M09-03 step 4: the extensibility detector ───────────────────────────────────────────────────

test('extensibility false prints the existing guidance; true, null and a throw are silent', async (t) => {
  for (const [state, read] of [
    ['false', () => false],
    ['true', () => true],
    ['null', () => null],
    ['throws', () => { throw new Error('state.vscdb is locked'); }],
  ]) {
    tmpHome(t);
    const msg = await runSessionStart(
      { session_id: 'conv-1', cwd: null },
      linkedDeps({ readExtensibility: read, flushQueue: async () => ({ flushed: 0 }) }),
    );
    if (state === 'false') {
      assert.match(msg, /third-party extensibility is OFF/);
      assert.ok(msg.includes(EXTENSIBILITY_SETTING), 'the note names where the switch is');
    } else {
      assert.equal(msg, null, `${state} must be silent`);
    }
  }
});

// ── bill: the plan read is bounded, stamps its attempt, and still RUNS ─────────────────────────

test('the plan read still runs after the probe was made serial — conflict 4s regression', async (t) => {
  // THE POINT OF THIS TEST. bill's patch gated the read on `Date.now() - startedAt < 2000`, which
  // was right while the whoami probe ran concurrently. The probe is serial now, so on any machine
  // with a real network that elapsed time routinely exceeds 2000 ms and the read would never run
  // at all — a deterministic capture with no caller, again, which is the defect it was written to
  // remove. The budget is measured against what is LEFT instead.
  tmpHome(t);
  let read = 0;
  let persisted = null;
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      // A probe that costs real time, the way a slow portal does.
      whoami: async () => { await new Promise((r) => setTimeout(r, 60)); return { valid: true }; },
      isDue: () => true,
      readCursorAccount: () => { read += 1; return { source: 'cli-config', plan: 'pro' }; },
      reconcilePlan: (observation, config, options) => {
        assert.equal(options.attempted, true, 'attempted: true is not optional');
        return { persist: true, record: { plan: 'pro', lastPlanReadAttemptAt: options.now } };
      },
      writeBillingConfig: (record) => { persisted = record; },
      isStale: () => false,
      flushQueue: async () => ({ flushed: 0 }),
    }),
  );

  assert.equal(read, 1, 'the deterministic read ran');
  assert.equal(persisted.plan, 'pro');
  assert.ok(persisted.lastPlanReadAttemptAt, 'the attempt is stamped, so a fruitless read backs off');
  assert.equal(msg, null);
});

test('the plan read is skipped when the hook budget is nearly spent', async (t) => {
  // The other half of the guard. `isDue` bounds how OFTEN the read happens; the reserve bounds the
  // one run that does. readCursorAccount can fall through to copying state.vscdb plus its WAL to a
  // temp directory, and this whole function is inside Cursor's hard 10s kill — a plan refresh is
  // never worth a session start.
  tmpHome(t);
  let read = 0;
  // The first call anchors startedAt; every later one reports a budget with 500 ms left.
  let first = true;
  const base = Date.now();
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      now: () => {
        if (first) { first = false; return base; }
        return base + HOOK_BUDGET_MS - 500;
      },
      isDue: () => true,
      readCursorAccount: () => { read += 1; return { source: 'cli-config', plan: 'pro' }; },
      whoami: async () => ({ valid: true }),
      isStale: () => true,
      flushQueue: async () => ({ flushed: 0 }),
    }),
  );

  assert.equal(read, 0, '500 ms left is not enough to risk a WAL snapshot copy');
  // And the nudge still fires, naming the right verb: it used to send the user through a browser
  // sign-in to fix a plan.
  assert.match(msg, /beezi-refresh/);
  assert.doesNotMatch(msg, /beezi-login skill to refresh/);
});

// ── A3: a tenant that is not tracking live does not announce its repo remote ──────────────────

test('live tracking disallowed — the repo remote is never POSTed, on either non-live mode', async (t) => {
  // `liveAllowed` used to gate only the WORDING: a DISABLED tenant was told "nothing from this
  // session is reported" and its `origin` URL went to /repos/status in the same hook. Nothing is
  // recorded server-side from that call and no usage data is in it, but the remote is the name of
  // the user's repository and it left the machine after they were told it would not.
  for (const mode of [TrackingMode.DISABLED, TrackingMode.BACKFILL_ONLY]) {
    tmpHome(t);
    const urls = [];
    const msg = await runSessionStart(
      { session_id: 'conv-1', cwd: '/repo' },
      linkedDeps({
        gitImpl: gitWithOrigin,
        whoami: async () => ({ valid: true, trackingMode: mode }),
        flushQueue: async () => ({ flushed: 0 }),
        fetchImpl: async (url) => {
          urls.push(String(url));
          return { ok: true, json: async () => ({ connected: true, projectName: 'Acme' }) };
        },
      }),
    );
    assert.deepEqual(
      urls.filter((u) => u.includes('/repos/status')),
      [],
      `${mode}: the repo remote must not be announced`,
    );
    // The policy sentence is still the one the user reads, and it is unchanged.
    assert.ok(msg !== null && msg !== '', `${mode}: the policy sentence still speaks`);
    assert.doesNotMatch(msg, /Acme/, `${mode}: no server answer can be quoted when nothing was asked`);
  }
});

test('live tracking disallowed — local repo discovery and its wording are untouched', async (t) => {
  // The no-origin branch never made a request and must keep saying exactly what it said.
  tmpHome(t);
  const urls = [];
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: '/repo' },
    linkedDeps({
      gitImpl: gitWithoutOrigin,
      whoami: async () => ({ valid: true, trackingMode: TrackingMode.DISABLED }),
      flushQueue: async () => ({ flushed: 0 }),
      fetchImpl: async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({}) }; },
    }),
  );
  assert.deepEqual(urls.filter((u) => u.includes('/repos/status')), []);
  assert.match(msg, /no "origin" remote — this repo would be tracked as a local repo\./);
  assert.match(msg, /turned off for this workspace/i);
});

// ── plan §4 B3: the account check-in on the hot path ──────────────────────────────────────────

test('session start checks the account in UNFORCED, with the record the reconcile settled', async (t) => {
  tmpHome(t);
  const calls = [];
  const reconciled = { plan: 'pro', accountAnchor: { email: 'seat@example.com', accountId: 'auth0|x' } };
  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      isDue: () => true,
      readCursorAccount: () => ({ source: 'cli-config', plan: 'pro' }),
      reconcilePlan: () => ({ persist: true, record: reconciled }),
      writeBillingConfig: () => {},
      whoami: async () => ({ valid: true, email: 'dev@example.com' }),
      flushQueue: async () => ({ flushed: 0 }),
      syncAccount: async (token, options, deps) => { calls.push({ token, options, deps }); return null; },
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'tok', 'the token this hook already resolved — no second lookup');
  // The fingerprint gate plus the daily heartbeat IS the intended steady state here. Forcing on
  // a per-session path would POST on every single session start.
  assert.equal(calls[0].options.force, false);
  assert.equal(calls[0].options.via, 'session-start');
  // The record the reconcile just settled, handed over directly: re-reading billing.json would be
  // a second file read for an answer already in hand, and a second `readCursorAccount()` on the
  // WAL-snapshot path costs ~80 ms.
  assert.equal(calls[0].deps.record, reconciled);
  assert.equal(calls[0].deps.who.email, 'dev@example.com');
  assert.equal(calls[0].deps.tracking, null);
  // An EXPLICIT bound, not whatever default the callee happens to ship — this file has been burned
  // by an inherited timeout before (see REVOKE_CHECK_TIMEOUT_MS).
  assert.equal(calls[0].deps.timeoutMs, CHECKIN_TIMEOUT_MS);
  assert.equal(typeof calls[0].deps.fetchImpl, 'function', 'the hook’s own bounded transport');
});

test('the check-in is not attempted when the hook budget is nearly spent', async (t) => {
  tmpHome(t);
  let first = true;
  const base = Date.now();
  const calls = [];
  const msg = await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      now: () => {
        if (first) { first = false; return base; }
        return base + HOOK_BUDGET_MS - 500;
      },
      isDue: () => true,
      whoami: async () => ({ valid: true }),
      isStale: () => true,
      flushQueue: async () => ({ flushed: 0 }),
      syncAccount: async () => { calls.push(1); return null; },
    }),
  );
  // The reserve is strictly larger than the request's own timeout, which is what makes the await
  // provably bounded: the hook cannot start a request it has no budget to finish.
  assert.equal(calls.length, 0, '500 ms left is not enough to start a bounded POST');
  // And everything after it still runs.
  assert.match(msg, /beezi-refresh/);
});

test('a check-in that rejects, throws or hangs past its bound never breaks a session start', async (t) => {
  for (const sync of [
    () => { throw new Error('threw synchronously'); },
    () => Promise.reject(new Error('rejected')),
    async () => { throw new Error('rejected late'); },
  ]) {
    tmpHome(t);
    const msg = await runSessionStart(
      { session_id: 'conv-1', cwd: null },
      linkedDeps({
        isDue: () => true,
        isStale: () => true,
        whoami: async () => ({ valid: true }),
        flushQueue: async () => ({ flushed: 0 }),
        syncAccount: sync,
      }),
    );
    // The nudge below it still fires: the check-in is the LAST thing in the plan block and it is
    // not allowed to swallow the block.
    assert.match(msg, /beezi-refresh/);
  }
});

test('no plan-bearing source means no check-in at all', async (t) => {
  tmpHome(t);
  const calls = [];
  await runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      // An API-key machine rides no seat, so there is no subscription to report.
      detectBillingSource: () => 'third_party',
      whoami: async () => ({ valid: true }),
      flushQueue: async () => ({ flushed: 0 }),
      syncAccount: async () => { calls.push(1); return null; },
    }),
  );
  assert.equal(calls.length, 0);
});

// ── plan §4 C3: session start is the second drainer of the stop hook's pendingCheckIn marker ──

function markerDeps(pending, over) {
  const cleared = [];
  return {
    cleared,
    deps: {
      isDue: () => false,
      whoami: async () => ({ valid: true, email: 'dev@example.com' }),
      flushQueue: async () => ({ flushed: 0 }),
      buildCheckInScope: () => ({ ok: true, reason: null, scope: { env: '', beeziAccount: 'beezi-user' } }),
      accountSyncStateFile: (scope) => `/state/${scope.beeziAccount}.json`,
      readPendingCheckIn: () => pending,
      clearPendingCheckIn: (file, scope) => cleared.push([file, scope.beeziAccount]),
      ...(over == null ? {} : over),
    },
  };
}

test('a due marker forces the check-in and is cleared when the send lands', async (t) => {
  tmpHome(t);
  const calls = [];
  const m = markerDeps(true, {
    syncAccount: async (token, options) => {
      calls.push(options);
      return { outcome: 'sent', successful: true, writeback: null };
    },
  });
  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));

  assert.equal(calls.length, 1, 'ONE call — draining forces the check-in that was happening anyway');
  // A marker means an earlier run owed a send that never left the machine, so the hash gate is not
  // what stands between the server and the truth.
  assert.equal(calls[0].force, true);
  assert.deepEqual(m.cleared, [['/state/beezi-user.json', 'beezi-user']]);
});

test('a marker survives a check-in that did not land', async (t) => {
  for (const outcome of ['offline', 'failed', 'epoch-changed', 'skipped']) {
    tmpHome(t);
    const m = markerDeps(true, {
      syncAccount: async () => ({ outcome, successful: false, writeback: null }),
    });
    await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
    assert.deepEqual(m.cleared, [], `${outcome} is a send still owed — the marker must stay`);
  }
});

test('no marker means the ordinary unforced heartbeat, and nothing is cleared', async (t) => {
  tmpHome(t);
  const calls = [];
  const m = markerDeps(false, {
    syncAccount: async (token, options) => {
      calls.push(options);
      return { outcome: 'sent', successful: true, writeback: null };
    },
  });
  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
  assert.equal(calls[0].force, false);
  assert.deepEqual(m.cleared, []);
});

test('a marker read that throws leaves the session start — and the check-in — alone', async (t) => {
  tmpHome(t);
  const calls = [];
  const m = markerDeps(true, {
    readPendingCheckIn: () => { throw new Error('unreadable state file'); },
    syncAccount: async (token, options) => { calls.push(options); return { outcome: 'sent' }; },
  });
  const msg = await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
  assert.equal(msg, null);
  assert.equal(calls.length, 1, 'the heartbeat still runs');
  assert.equal(calls[0].force, false, 'a marker we could not read is not a marker');
  assert.deepEqual(m.cleared, []);
});

test('the marker is read from the file the check-in’s own scope names', async (t) => {
  tmpHome(t);
  const seen = [];
  const m = markerDeps(true, {
    readPendingCheckIn: (file, scope, d) => { seen.push({ file, scope, now: d.now }); return true; },
    syncAccount: async () => ({ outcome: 'sent' }),
  });
  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
  // A marker read beside a DIFFERENT file than the heartbeat state is a marker that is never
  // drained, so the scope comes from the same builder the check-in itself uses.
  assert.equal(seen[0].file, '/state/beezi-user.json');
  assert.deepEqual(seen[0].scope, { env: '', beeziAccount: 'beezi-user' });
  assert.equal(typeof seen[0].now, 'number', 'the due stamp is evaluated against the hook clock');
});

// ── self-heal: whoami says the server has no `cli_agent_accounts` row for this machine ────────
//
// The server's session upsert only LINKS an existing account row; it never creates one. Once the
// row is gone, every session maps to no subscription until the next check-in — and the hash gate
// plus the heartbeat keeps that check-in from happening, because nothing local changed. whoami is
// already fetched on this path (it is the revocation probe), so its `cliAgentAccountKnown: false`
// is a free signal: force the check-in that was going to run anyway. No new request is added.

const ANCHORED = { plan: 'pro', subscriptionType: 'pro', accountAnchor: { email: 'seat@example.com', accountId: 'auth0|seat', source: 'cli_config' } };

function selfHealRun(t, who, record) {
  tmpHome(t);
  const calls = [];
  const whoCalls = [];
  return runSessionStart(
    { session_id: 'conv-1', cwd: null },
    linkedDeps({
      whoami: async (...args) => { whoCalls.push(args); return who; },
      readBillingConfig: () => record,
      flushQueue: async () => ({ flushed: 0 }),
      buildCheckInScope: () => ({ ok: false, reason: 'no-beezi-account', scope: null }),
      syncAccount: async (token, options) => { calls.push(options); return { outcome: 'sent' }; },
    }),
  ).then(() => ({ calls, whoCalls }));
}

test('a server that says it has no account row, plus a local anchor, forces the check-in', async (t) => {
  const { calls, whoCalls } = await selfHealRun(t, { valid: true, email: 'dev@example.com', cliAgentAccountKnown: false }, ANCHORED);
  assert.equal(whoCalls.length, 1, 'the SAME whoami the revocation check made — no second probe');
  assert.equal(calls.length, 1, 'one check-in, forced — not an extra request');
  assert.equal(calls[0].force, true);
  assert.equal(calls[0].via, 'session-start');
});

test('an id-only or email-only anchor is still an anchor worth forcing for', async (t) => {
  for (const accountAnchor of [
    { email: null, accountId: 'auth0|seat', source: 'cli_config' },
    { email: 'seat@example.com', accountId: null, source: 'self_report' },
  ]) {
    const { calls } = await selfHealRun(t, { valid: true, cliAgentAccountKnown: false }, { plan: null, accountAnchor });
    assert.equal(calls[0].force, true, JSON.stringify(accountAnchor));
  }
});

test('a server that knows the row, or cannot say, gets the ordinary unforced heartbeat', async (t) => {
  for (const who of [
    { valid: true, email: 'dev@example.com', cliAgentAccountKnown: true },
    { valid: true, email: 'dev@example.com' },
    // A probe that did not answer carries no verdict of any kind.
    null,
  ]) {
    const { calls } = await selfHealRun(t, who, ANCHORED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, false, `${JSON.stringify(who)} must not force`);
  }
});

test('no local anchor means nothing to heal with — not forced', async (t) => {
  // Forcing a body that identifies nobody would change nothing server-side: there is no row to
  // create without an `accountUuid` or an email, and account-checkin skips it as NOTHING_TO_REPORT.
  for (const record of [
    {},
    { plan: 'pro', subscriptionType: 'pro', accountAnchor: null },
    { plan: 'pro', accountAnchor: { email: null, accountId: null, source: 'self_report' } },
  ]) {
    const { calls } = await selfHealRun(t, { valid: true, cliAgentAccountKnown: false }, record);
    assert.equal(calls[0].force, false, JSON.stringify(record));
  }
});

test('a pending marker still forces on its own, flag or no flag', async (t) => {
  tmpHome(t);
  const calls = [];
  const m = markerDeps(true, {
    whoami: async () => ({ valid: true, email: 'dev@example.com', cliAgentAccountKnown: true }),
    syncAccount: async (token, options) => { calls.push(options); return { outcome: 'sent' }; },
  });
  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
  assert.equal(calls[0].force, true);
  assert.equal(m.cleared.length, 1);
});

test('the self-heal force never clears a marker that was not there', async (t) => {
  tmpHome(t);
  const m = markerDeps(false, {
    whoami: async () => ({ valid: true, email: 'dev@example.com', cliAgentAccountKnown: false }),
    readBillingConfig: () => ANCHORED,
    syncAccount: async () => ({ outcome: 'sent' }),
  });
  await runSessionStart({ session_id: 'conv-1', cwd: null }, linkedDeps(m.deps));
  assert.deepEqual(m.cleared, []);
});

// ── The session_start sidecar line: the timeline's first anchor ──
//
// Without it a session's activity timeline starts at its first tool call, and everything the user
// did before that — reading the prompt, thinking, typing — is simply missing (14–270 s on real CLI
// sessions). The line is timing-only, so the properties pinned here are the timing ones: the stamp
// is the one the hook was handed, the cwd is the stampable one, and nothing about it can fail a start.

function sessionStartLines(id) {
  const file = eventsFileFor(id);
  if (file === null || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.ev === 'session_start');
}

test('a session_start line is written with the hook-start ts and the stampable cwd', async (t) => {
  tmpHome(t);
  // A stamp far from the hook clock, so a line stamped at WRITE time cannot pass by coincidence:
  // the hook spends seconds before most of its work, and a late stamp would sort into the turn.
  const ts = Date.UTC(2026, 8, 18, 14, 12, 27);
  await runSessionStart(
    { session_id: 'conv-start', cwd: '/not-the-stampable-one' },
    linkedDeps({ sessionStartLine: { ts, cwd: '/repo' } }),
  );
  assert.deepEqual(sessionStartLines('conv-start'), [{ cwd: '/repo', ts, ev: 'session_start' }]);
});

test('an unlinked machine still records session_start, like every other sidecar line', async (t) => {
  // The sidecar is local and reporting is gated elsewhere: the login-time backfill attributes a
  // conversation recorded before the machine was linked, and it needs the same start anchor.
  tmpHome(t);
  const ts = Date.UTC(2026, 8, 18, 14, 12, 27);
  const msg = await runSessionStart(
    { session_id: 'conv-unlinked', cwd: '/repo' },
    linkedDeps({ getAccessToken: async () => null, sessionStartLine: { ts, cwd: '/repo' } }),
  );
  assert.match(msg, /not linked/i);
  assert.equal(sessionStartLines('conv-unlinked').length, 1);
});

test('without sessionStartLine nothing is written to the sidecar', async (t) => {
  tmpHome(t);
  await runSessionStart({ session_id: 'conv-none', cwd: '/repo' }, linkedDeps());
  assert.deepEqual(sessionStartLines('conv-none'), []);
});

test('a start stamp that is not a finite number falls back to the append-time stamp', async (t) => {
  // `{ ts: undefined }` spread over appendEvent's own stamp would erase it, and JSON.stringify
  // would then drop the key: a line with no time at all, which the timeline cannot place.
  tmpHome(t);
  const before = Date.now();
  await runSessionStart(
    { session_id: 'conv-nan', cwd: '/repo' },
    linkedDeps({ sessionStartLine: { ts: Number.NaN, cwd: '/repo' } }),
  );
  const lines = sessionStartLines('conv-nan');
  assert.equal(lines.length, 1);
  assert.equal(typeof lines[0].ts, 'number');
  assert.ok(lines[0].ts >= before);
});

test('an append that throws never breaks a session start', async (t) => {
  tmpHome(t);
  let appended = 0;
  const msg = await runSessionStart(
    { session_id: 'conv-throw', cwd: '/repo' },
    linkedDeps({
      sessionStartLine: { ts: Date.now(), cwd: '/repo' },
      appendEvent: () => { appended += 1; throw new Error('disk full'); },
      gitImpl: gitWithoutOrigin,
    }),
  );
  assert.equal(appended, 1, 'the seam was reached, so the throw really happened');
  // The whole hook ran on past it, to the banner at its end.
  assert.match(msg, /no "origin" remote/);
});
