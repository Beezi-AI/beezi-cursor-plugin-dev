import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCheckpoint, createCheckpointCaches, CheckpointMode, extractAuditReports,
} from '../lib/checkpoint.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-cursor.mjs';
import { TrackingMode, writeTrackingState } from '../lib/tracking.mjs';
import { sessionLockPath, withLock } from '../lib/lock.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';

// The seam between the host (this task) and the parser half. Everything asserted here is a promise
// the report payload makes to the Beezi API, so a change in delta-cursor's return shape has to
// break something in this file rather than land as a wrong number in analytics.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-checkpoint-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// A git that reports one repo with an origin, so segments are attributable.
function fakeGit(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function delta(overrides = {}) {
  return {
    conversationId: 'conv-1',
    segmentId: 'conv-1:0-4',
    from: 0,
    to: 4,
    nextCursor: 4,
    repoRoot: '/repo',
    branch: 'feature/task-42',
    entries: [
      { model: 'claude-4.5-sonnet', billing_pool: 'credits', requests: 2, cost_usd: 0.34 },
      { model: 'claude-4.5-sonnet', billing_pool: 'subscription', requests: 5, cost_usd: 0 },
    ],
    rateLimitEvents: [],
    operations: { file: { count: 1, est_tokens: 10 } },
    est_tokens: 10,
    code_changes: { files_changed: 1, lines_added: 12, lines_removed: 3, by_extension: { '.ts': 1 } },
    duration_ms: 92_000,
    started_at: '2026-07-31T10:00:00.000Z',
    ended_at: '2026-07-31T10:01:32.000Z',
    usage_snapshot: { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } },
    diagnostics: { schemaMiss: false },
    ...overrides,
  };
}

// Never flush: the assertions are about what was queued, and a real POST is not this test's job.
const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

function queued() {
  // The queue dir is created on first write, so "nothing enqueued" is an absent directory.
  let files;
  try { files = fs.readdirSync(queueDir()); } catch { return []; }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));
}

function stateOf(id) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));
}

// The sidecar the real parser reads. Only the tests below that exercise the REAL `computeDelta`
// need one — everything above injects a delta and never touches the disk.
function writeSidecar(home, events) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

test('one entry per (model, pool) becomes one models list entry, model id intact', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  const [payload] = queued();
  // A list, not a record keyed by model: one model in one segment legitimately has two rows, and
  // the pool that separates them belongs in a field of its own — welding it onto the key is what
  // used to leave "claude-4.5-sonnet#subscription" sitting where a model name was expected.
  assert.ok(Array.isArray(payload.models));
  assert.deepEqual(
    payload.models.map((m) => [m.model, m.billing_pool]),
    [
      ['claude-4.5-sonnet', 'credits'],
      ['claude-4.5-sonnet', 'subscription'],
    ],
  );
  assert.equal(payload.models[0].cost_usd, 0.34);
  assert.equal(payload.models[0].requests, 2);
  assert.equal(payload.models[1].requests, 5);
});

test('a segment that spent credits reports billing_source cursor_credits', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  const [payload] = queued();
  assert.equal(payload.billing_source, 'cursor_credits');
});

test('a wholly seat-covered segment still reports billing_source subscription', async (t) => {
  tmpHome(t);
  const seatOnly = () =>
    delta({
      entries: [
        { model: 'claude-4.5-sonnet', billing_pool: 'subscription', requests: 5, cost_usd: 0 },
      ],
    });
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: seatOnly }));

  const [payload] = queued();
  assert.equal(payload.billing_source, 'subscription');
});

test('token counts are reported as zero, honestly — Cursor never sees one', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  const [payload] = queued();
  assert.equal(payload.token_total, 0);
  assert.equal(payload.token_input, 0);
  assert.equal(payload.token_output, 0);
  assert.equal(payload.token_cache, 0);
  for (const usage of Object.values(payload.models)) {
    assert.equal(usage.token_input, 0);
    assert.equal(usage.token_output, 0);
    assert.equal(usage.token_cache_read, 0);
    assert.equal(usage.token_cache_creation, 0);
  }
});

test('the payload carries only fields the ingest DTO accepts', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  const [payload] = queued();
  const allowed = new Set([
    'segmentId', 'sessionId', 'remote', 'branch', 'from_line', 'to_line', 'models',
    'token_total', 'token_input', 'token_output', 'token_cache', 'duration_sec',
    'session_name', 'billing_source', 'subscription_type', 'rate_limit_tier', 'subscription_plan',
    'third_party_provider', 'timezone', 'started_at', 'ended_at', 'code_changes', 'operations',
    'is_subagent', 'agent_id', 'agent_type', 'agent_name', 'spawn_depth',
  ]);
  for (const key of Object.keys(payload)) {
    assert.ok(allowed.has(key), `${key} is not a SessionReportRequestDto field`);
  }
  // est_tokens has no top-level home on the wire; it rides inside operations.
  assert.equal(payload.est_tokens, undefined);
});

test('segmentId indexes our sidecar lines, and duration converts to seconds', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  const [payload] = queued();
  assert.equal(payload.segmentId, 'conv-1:0-4');
  assert.equal(payload.sessionId, 'conv-1');
  assert.equal(payload.from_line, 0);
  assert.equal(payload.to_line, 4);
  assert.equal(payload.duration_sec, 92);
});

test('the cursor advances so the same lines are never re-billed', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  assert.equal(stateOf('conv-1').cursor, 4);
});

test('the usageData baseline is persisted and handed back on the next call', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  assert.deepEqual(stateOf('conv-1').usageSnapshot, { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } });

  // usageData is cumulative for the whole conversation while every checkpoint gets a fresh
  // segmentId — without the baseline the same overage re-reports under a new sourceRef every turn
  // and the credits bucket compounds.
  let seen;
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: (_id, _from, resolvers) => {
        seen = resolvers.priorUsage;
        return delta({ from: 4, to: 8, nextCursor: 8, segmentId: 'conv-1:4-8' });
      },
    }),
  );
  assert.deepEqual(seen, { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } });
});

test('a checkout without origin still queues under a local: remote and advances the baseline', async (t) => {
  tmpHome(t);
  const noRemote = (args) => {
    if (args[0] === 'remote') throw new Error('no origin');
    if (args[0] === 'rev-parse') return 'main';
    return '';
  };
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ gitImpl: noRemote, computeDelta: () => delta() }),
  );
  const [payload] = queued();
  assert.ok(payload);
  assert.equal(payload.remote, 'local:repo', 'only the folder name reaches the wire');
  assert.deepEqual(stateOf('conv-1').usageSnapshot, { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } });
});

test('a null usage_snapshot leaves the previous baseline in place', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  // usageData unreadable this run (no node:sqlite, WAL contention) — the baseline must not jump
  // past spend we failed to observe.
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ from: 4, to: 8, nextCursor: 8, segmentId: 'conv-1:4-8', usage_snapshot: null }) }),
  );
  assert.deepEqual(stateOf('conv-1').usageSnapshot, { 'claude-4.5-sonnet': { amount: 2, costInCents: 34 } });
});

test('a window with no new lines queues nothing', async (t) => {
  tmpHome(t);
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ from: 4, to: 4, nextCursor: 4, entries: [] }) }),
  );
  assert.equal(res.enqueued, 0);
  assert.equal(queued().length, 0);
});

test('a schema miss is said out loud rather than reported as zero activity', async (t) => {
  tmpHome(t);
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = real; });

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: () => delta({
        entries: [],
        diagnostics: { schemaMiss: true, windowEvents: 9, unrecognizedEvents: ['generation'] },
      }),
    }),
  );
  assert.match(written.join(''), /schema mismatch/);
  assert.match(written.join(''), /generation/);
});

test('an unlinked machine does no work at all', async (t) => {
  tmpHome(t);
  let called = false;
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ getAccessToken: async () => null, computeDelta: () => { called = true; return delta(); } }),
  );
  assert.deepEqual(res, { enqueued: 0, flush: null, sessionErrors: [], deltaFailed: false });
  assert.equal(called, false, 'the sidecar must not even be parsed on an unlinked machine');
});

test('a payload with no conversation id is refused', async (t) => {
  tmpHome(t);
  const res = await runCheckpoint({ session_id: null, cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  assert.deepEqual(res, { enqueued: 0, flush: null, sessionErrors: [], deltaFailed: false });
});

test('a throwing delta never escapes the checkpoint', async (t) => {
  tmpHome(t);
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => { throw new Error('sidecar unreadable'); } }),
  );
  // deltaFailed is what lets the backfill classify this session as unreadable, not empty.
  assert.deepEqual(res, { enqueued: 0, flush: null, sessionErrors: [], deltaFailed: true });
});

// ─── the conversation id is untrusted input on a path ────────────────────────────────────────────
//
// `session_id` is Cursor's `conversation_id`, straight off a hook payload. lib/sidecar.mjs has
// always run it through `safeName` before touching the disk; this module used to build
// `state/<id>.json` and the queue filename out of the raw value, and the queue filename's `[:/\s]`
// blacklist missed both `\` and `..`. On Windows `path.join` treats `\` as a separator, so both
// holes were reachable.
//
// The home is nested a few levels deep so an escape has somewhere to land that the test can check.
function nestedHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-traversal-'));
  const home = path.join(root, 'a', 'b', 'c', 'home');
  fs.mkdirSync(home, { recursive: true });
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home };
}

// Every path anything was written to, relative to nothing — used to prove nothing escaped.
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...walk(full));
  }
  return out;
}

test('a traversal-shaped conversation id writes nothing outside the data root', async (t) => {
  const { root, home } = nestedHome(t);
  // `..\..\..\evil` from `<home>/state/` resolves to `<root>/a/b/evil.json` on Windows.
  await runCheckpoint(
    { session_id: '..\\..\\..\\evil', cwd: '/repo' },
    deps({ computeDelta: () => delta({ segmentId: null }) }),
  );

  const escaped = walk(root).filter((p) => !p.startsWith(home + path.sep) && p !== home);
  // Only the directories that lead to the home may exist above it.
  const unexpected = escaped.filter((p) => !home.startsWith(p + path.sep));
  assert.deepEqual(unexpected, [], `these landed outside the data root: ${unexpected.join(', ')}`);
});

test('a forward-slash traversal is refused the same way', async (t) => {
  const { root, home } = nestedHome(t);
  await runCheckpoint(
    { session_id: '../../../evil', cwd: '/repo' },
    deps({ computeDelta: () => delta({ segmentId: null }) }),
  );

  const escaped = walk(root).filter((p) => !p.startsWith(home + path.sep) && p !== home);
  const unexpected = escaped.filter((p) => !home.startsWith(p + path.sep));
  assert.deepEqual(unexpected, [], `these landed outside the data root: ${unexpected.join(', ')}`);
});

test('a separator in the conversation id does not silently create a subdirectory', async (t) => {
  const { home } = nestedHome(t);
  // `a\b` used to create `state/a/` and write `b.json` inside it. `readJson` on `state/a\b.json`
  // then returned null every hook, so the cursor reset to 0 and the segment was reported forever;
  // `flushQueue` never saw the queue file for the same reason; and lib/prune.mjs:23's `unlinkSync`
  // throws EISDIR on a directory, so the mess was never cleaned up either.
  await runCheckpoint(
    { session_id: 'a\\b', cwd: '/repo' },
    deps({ computeDelta: () => delta({ segmentId: null }) }),
  );

  for (const dir of ['state', 'queue']) {
    const entries = fs.readdirSync(path.join(home, dir), { withFileTypes: true });
    assert.ok(entries.length > 0, `${dir}/ should have one entry`);
    for (const entry of entries) {
      assert.ok(entry.isFile(), `${dir}/${entry.name} is a directory, not a state or report file`);
    }
  }
});

test('a sanitized state file is read back, so the cursor is not stuck at zero forever', async (t) => {
  nestedHome(t);
  const hostile = 'a\\b';
  await runCheckpoint({ session_id: hostile, cwd: '/repo' }, deps({ computeDelta: () => delta({ segmentId: null }) }));

  // The point of writing to a path we can read: the second checkpoint must see the first one's
  // cursor. When the write went into a subdirectory this came back as 0 every single time.
  let seenCursor = null;
  await runCheckpoint(
    { session_id: hostile, cwd: '/repo' },
    deps({
      computeDelta: (_id, cursor) => {
        seenCursor = cursor;
        return delta({ from: 4, to: 8, nextCursor: 8, segmentId: null });
      },
    }),
  );
  assert.equal(seenCursor, 4, 'the state written under the sanitized name was not read back');
});

test('a queue filename stays a direct child of the queue directory', async (t) => {
  const { home } = nestedHome(t);
  // The segmentId falls back to `<session_id>:<from>-<to>`, so a hostile id reaches the queue
  // filename too — and that filename used to be built with a blacklist that missed `\`.
  await runCheckpoint(
    { session_id: '..\\..\\evil', cwd: '/repo' },
    deps({ computeDelta: () => delta({ segmentId: null }) }),
  );

  const files = fs.readdirSync(path.join(home, 'queue'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('\\') && !files[0].includes('/'), `queue filename kept a separator: ${files[0]}`);
  const payload = JSON.parse(fs.readFileSync(path.join(home, 'queue', files[0]), 'utf-8'));
  // Only the FILENAME is sanitized. The segmentId on the wire is the server's idempotency key and
  // must stay exactly what delta-cursor produced, or the same window reports under two identities.
  assert.equal(payload.segmentId, '..\\..\\evil:0-4');
});

// ─── the backfill's seams ─────────────────────────────────────────────────────────────────────
//
// scripts/backfill.mjs drives this same function once per past session, and asks for the whole
// historical-replay posture with ONE option: `mode: 'audit'`. It used to thread four booleans that
// were only ever passed together, which is how the fifth behaviour it needed (the whole-sidecar
// parse the subagent correlation is gated on) stayed switched off unnoticed. Each assertion below
// pins one of the behaviours that word now selects, so a regression breaks here rather than as a
// double-billed, unbilled or lost session in production.

const audit = (over = {}) => ({ sink: () => {}, mode: CheckpointMode.AUDIT, ...over });

test('audit mode: sink collects payloads, nothing lands in the queue', async (t) => {
  tmpHome(t);
  const reports = [];
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
    audit({ sink: (p) => reports.push(p) }),
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0].segmentId, 'conv-1:0-4');
  assert.deepEqual(queued(), [], 'a sinked payload must never also hit the disk queue');
  assert.equal(res.flush, null, 'audit mode must suppress the queue drain');
  assert.equal(res.enqueued, 1);
});

test('audit mode: leaves no state file behind', async (t) => {
  tmpHome(t);
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
    audit(),
  );

  // The cursor is the only record of what was reported; a historical parse must not advance it —
  // the backfill route, not the cursor, decides what was delivered.
  assert.throws(() => stateOf('conv-1'), 'no state file may be written for an audited session');
});

test('audit mode: rate-limit reports are buffered instead of posted', async (t) => {
  tmpHome(t);
  let posted = 0;
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: () => delta({ rateLimitEvents: [{ text: 'limit hit', occurredAt: '2026-07-31T10:00:00.000Z' }] }),
      fetchImpl: async () => { posted += 1; return { status: 200, json: async () => ({}) }; },
    }),
    audit(),
  );

  assert.equal(posted, 0, 'no network call may happen for a buffered error');
  assert.equal(res.sessionErrors.length, 1);
  assert.equal(res.sessionErrors[0].error, 'rate_limit');
  assert.equal(res.sessionErrors[0].sessionId, 'conv-1');
});

// A backfill candidate either was never tracked here or was tracked under a DIFFERENT account:
// its stored cursor belongs to that other tenant. Audit mode parses from line 0 with no usage
// baseline — and the live state file survives untouched for the account that owns it.
test('audit mode: parses from cursor 0 and never writes the live state back', async (t) => {
  tmpHome(t);
  fs.mkdirSync(stateDir(), { recursive: true });
  const liveState = { cursor: 999, usageSnapshot: { 'claude-4.5-sonnet': { amount: 9, costInCents: 1 } } };
  fs.writeFileSync(path.join(stateDir(), 'conv-1.json'), JSON.stringify(liveState), 'utf-8');
  let seenCursor = 'unset';
  let seenPrior = 'unset';

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: (_id, cursor, opts) => {
        seenCursor = cursor;
        seenPrior = opts.priorUsage;
        return delta();
      },
    }),
    audit(),
  );

  assert.equal(seenCursor, 0, 'the stored cursor must not leak into a fresh parse');
  assert.equal(seenPrior, null, 'no usage baseline either');
  assert.deepEqual(stateOf('conv-1'), liveState, 'the live state file is untouched');
});

// The audit ships timelines inside its own chunk payloads. If the mode also switched on the live
// timeline POST — the other half of what `emitTimeline` means — every one would be sent twice, on
// a route that 403s for the audit-only tenants this whole path exists to serve.
test('audit mode: shares the whole-sidecar parse but never posts a timeline', async (t) => {
  tmpHome(t);
  const urls = [];
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      computeDelta: () => delta(),
      fetchImpl: async (url) => { urls.push(String(url)); return { status: 200, json: async () => ({}) }; },
    }),
    audit(),
  );

  assert.deepEqual(urls, [], 'audit mode must make no HTTP call of its own');
});

// The same local: rule as a checkout without an origin, one step further out: a cwd outside
// any git repo still names the work by its folder. Only a session with no cwd at all is dropped.
test('a cwd outside any git repo still queues under a local: remote', async (t) => {
  tmpHome(t);
  const queued = [];
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: 'C:/scratch/notes' },
    deps({
      computeDelta: () => delta({ repoRoot: null, branch: null }),
      gitImpl: () => { throw new Error('not a repo'); },
    }),
    audit({ sink: (p) => queued.push(p) }),
  );

  assert.equal(res.enqueued, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].remote, 'local:notes', 'the folder, never the path around it');
  assert.equal(queued[0].branch, '(unknown)');
});

// The belt that skips "already live-tracked" sessions is scoped by account (see sidecar-index):
// the checkpoint records which account its queued segments were reported under.
test('a checkpoint stamps the current account onto the session state', async (t) => {
  const dir = tmpHome(t);
  fs.writeFileSync(
    path.join(dir, 'tracking.json'),
    JSON.stringify({ version: 1, email: 'User@Example.io', trackingMode: 'live' }),
    'utf-8',
  );

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));

  assert.match(stateOf('conv-1').account, /\|user@example\.io$/);
});

// Even a session with no cwd anywhere carries real usage: it lands in the one catch-all
// local://unknown bucket instead of being dropped as unattributable.
test('a window with no cwd at all still queues under local://unknown', async (t) => {
  tmpHome(t);
  const queued = [];
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: null },
    deps({
      computeDelta: () => delta({ repoRoot: null, branch: '(unknown)' }),
      gitImpl: () => { throw new Error('no repo anywhere'); },
    }),
    audit({ sink: (p) => queued.push(p) }),
  );

  assert.equal(res.enqueued, 1);
  assert.equal(queued[0].remote, 'local://unknown');
});

// ─── shared git-fact caches ───────────────────────────────────────────────────────────────────
//
// The backfill drives one checkpoint per past session in ONE process, and those sessions
// overwhelmingly share a handful of checkouts. Without a shared bag every session re-spawned git
// to re-answer questions the run had already answered — four spawns and ~99 ms each, which is
// 20-40 s of pure repetition on a machine with 200-400 sessions.
test('a shared cache bag answers each git question once across checkpoints', async (t) => {
  tmpHome(t);
  const calls = [];
  const countingGit = (args, dir) => {
    calls.push(args[0]);
    return fakeGit(args, dir);
  };
  // repoRoot:null forces `repoRootOf(cwd)` too, so rev-parse is part of what must be memoized.
  const run = (caches) =>
    runCheckpoint(
      { session_id: 'conv-1', cwd: '/repo' },
      deps({ gitImpl: countingGit, computeDelta: () => delta({ repoRoot: null, branch: null }) }),
      audit({ caches }),
    );

  const caches = createCheckpointCaches();
  await run(caches);
  const afterFirst = [...calls];
  await run(caches);

  assert.deepEqual(calls, afterFirst, 'the second checkpoint must spawn no git at all');
  // And each question really was asked — otherwise the assertion above passes on an empty list.
  assert.ok(afterFirst.includes('rev-parse'), 'the repo root was resolved');
  assert.ok(afterFirst.includes('remote'), 'the origin was resolved');
  assert.ok(afterFirst.includes('reflog'), 'the branch timeline was built');
  assert.ok(afterFirst.includes('branch'), 'HEAD was resolved');
});

test('with no bag supplied each checkpoint resolves for itself, exactly as a hook does', async (t) => {
  tmpHome(t);
  const calls = [];
  const countingGit = (args, dir) => {
    calls.push(args[0]);
    return fakeGit(args, dir);
  };
  const run = () =>
    runCheckpoint(
      { session_id: 'conv-1', cwd: '/repo' },
      deps({ gitImpl: countingGit, computeDelta: () => delta({ repoRoot: null, branch: null }) }),
      audit(),
    );

  await run();
  const afterFirst = calls.length;
  await run();

  assert.equal(calls.length, afterFirst * 2, 'a hook must keep its own per-process caches');
});

// ── C-8: the branch is clamped at the one site every payload's branch comes from ──────────────

test('a 255-char branch reaches the payload untouched, and 256 arrives at exactly 255', async (t) => {
  tmpHome(t);
  // The backend's `branch` column is 255 chars and an over-long value is a PERMANENT 4xx, which
  // DELETES the queue record — the segment's tokens, cost, code changes and operations go with it.
  // So this is not cosmetic truncation; it is the difference between a reported segment and a lost
  // one. Both boundaries in one test, because an off-by-one here silently loses every segment on a
  // long branch name and nothing else in the payload would look wrong.
  const at255 = 'b'.repeat(255);
  const at256 = 'c'.repeat(256);

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ branch: at255 }) }),
  );
  const [ok] = queued();
  assert.equal(ok.branch, at255, '255 is legal and must not be touched');

  const reference = { ...ok };
  fs.rmSync(queueDir(), { recursive: true, force: true });
  fs.rmSync(stateDir(), { recursive: true, force: true });

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ branch: at256 }) }),
  );
  const [clamped] = queued();
  assert.equal(clamped.branch.length, 255);
  assert.equal(clamped.branch, 'c'.repeat(255));
  // Nothing ELSE moved. A sanitizer that reached any other field would be a data change dressed up
  // as a length fix, and every one of these is a billed quantity.
  for (const key of Object.keys(reference)) {
    if (key === 'branch') continue;
    assert.deepEqual(clamped[key], reference[key], key);
  }
  assert.deepEqual(Object.keys(clamped), Object.keys(reference), 'no key added or dropped');
});

test('a detached HEAD still serializes (unknown) rather than being clamped away', async (t) => {
  tmpHome(t);
  // `branchOf` answers '(unknown)' for a detached HEAD and for a checkout with no reflog. The clamp
  // must pass that through verbatim: an empty string or a null here would fail DTO validation and
  // take the whole report with it.
  const detachedGit = (args) => {
    if (args[0] === 'remote') return 'https://example.com/acme/app.git';
    if (args[0] === 'rev-parse') return '/repo';
    if (args[0] === 'branch') return '';
    if (args[0] === 'reflog') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ gitImpl: detachedGit, computeDelta: () => delta({ branch: null, repoRoot: null }) }),
  );
  const [payload] = queued();
  assert.equal(payload.branch, '(unknown)');
});

test('a subagent segment is clamped by the same call as the main one', async (t) => {
  tmpHome(t);
  // One site covers main, subagent and the audit replay because they all read `attributionOf()`.
  // Asserting it on the SECOND queued payload is what proves that, rather than a second clamp
  // having been added beside the first.
  const over = 'd'.repeat(300);
  const events = [
    { ts: 1, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit' },
    { ts: 60_000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'audit' },
  ];
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ branch: over }), countEvents: () => 4 }),
    { emitTimeline: false },
  );
  // The subagent loop needs the shared whole-history parse, so drive it through a sidecar.
  const home = process.env.BEEZI_CURSOR_HOME;
  writeSidecar(home, events);
  fs.rmSync(queueDir(), { recursive: true, force: true });
  fs.rmSync(stateDir(), { recursive: true, force: true });
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ branch: over }) }),
    { emitTimeline: true },
  );

  const payloads = queued();
  const subagent = payloads.find((payload) => payload.is_subagent === true);
  assert.ok(subagent, 'the subagent segment must exist for this assertion to mean anything');
  assert.equal(subagent.branch.length, 255);
  assert.equal(payloads.find((payload) => !payload.is_subagent).branch.length, 255);
});

// ── C-2: a consumed range and a billable range are different questions ────────────────────

test('a session_end-only sidecar queues nothing and still advances state.cursor', async (t) => {
  const home = tmpHome(t);
  // DATA-04. A bare session marker is a boundary, not work. Before C-2 this window produced a point
  // segment with zero of everything; now the cursor consumes the line and nothing is enqueued.
  // Both halves matter: without the advance the same marker is re-examined on every later hook
  // forever, and with an enqueue the session list fills with empty rows.
  writeSidecar(home, [{ ts: Date.parse('2026-01-01T00:00:00.000Z'), ev: 'session_end' }]);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  assert.deepEqual(queued(), [], 'a marker-only window is not a billable segment');
  assert.equal(stateOf('conv-1').cursor, 1, 'and the line is consumed exactly once');
});

test('a window with real work is still enqueued through the same gate', async (t) => {
  const home = tmpHome(t);
  // The control for the test above: the gate must not be a blanket "enqueue nothing". A window
  // holding a generation and an edit is reportable work and goes out as before.
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  writeSidecar(home, [
    { ts: t0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 10, token_output: 2 },
    { ts: t0 + 1000, ev: 'edit', path: 'src/a.ts', added: 3, removed: 1, eid: 'e1' },
    { ts: t0 + 2000, ev: 'session_end' },
  ]);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const payloads = queued();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].models.length, 1);
  assert.equal(stateOf('conv-1').cursor, 3);
});

// ── C-3 / C-6: the two carries, and what wiring the planner must NOT change ─────────────

test('the generation carry and the attribution carry are persisted on session state', async (t) => {
  tmpHome(t);
  // Both are OPTIONAL keys read with a backwards-compatible default, and both are written only on
  // the same condition as the cursor. `mcpAliases` is asserted beside them because all three share
  // that condition and the rule that none of them may ever reach the wire.
  const withCarries = () => delta({
    countedGenerations: ['g1', 'g2'],
    nextAttribution: { root: '/repo-b', branch: 'dev' },
  });
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: withCarries }));

  const state = stateOf('conv-1');
  assert.deepEqual(state.countedGenerations, ['g1', 'g2']);
  assert.deepEqual(state.attribution, { root: '/repo-b', branch: 'dev' });
  const [payload] = queued();
  assert.equal('countedGenerations' in payload, false, 'a state key on the wire 400s the report');
  assert.equal('attribution' in payload, false);
});

test('the carries are handed back to computeDelta on the next window, and withheld from a replay', async (t) => {
  tmpHome(t);
  // The round trip is the whole point: a carry that is written and never read back is dead state.
  // And a HISTORICAL replay must be handed `null` — the state file it would read may have been
  // written under a DIFFERENT account, and seeding one tenant's import from another tenant's carry
  // attributes imported work to a checkout the importing account never told us about.
  const seen = [];
  const recording = (id, cursor, resolvers) => {
    seen.push({ counted: resolvers.countedGenerations, previous: resolvers.previousAttribution });
    return delta({ countedGenerations: ['g1'], nextAttribution: { root: '/repo-b' } });
  };

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: recording }));
  assert.equal(seen[0].counted, null, 'a first window has nothing to carry');
  assert.equal(seen[0].previous, null);

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: recording }),
    // A different segment id, or the second run enqueues nothing and the assertions read the first.
  );
  assert.deepEqual(seen[1].counted, ['g1'], 'the carry is read back');
  assert.deepEqual(seen[1].previous, { root: '/repo-b' });

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: recording }),
    { mode: CheckpointMode.AUDIT, sink: () => {} },
  );
  assert.deepEqual(seen[2].counted, null, 'a fresh-state replay reads no live carry');
  assert.equal(seen[2].previous, null, 'and is never seeded from another account\'s attribution');
});

test('wiring the planner moves no metric on the unsplit main payload', async (t) => {
  const home = tmpHome(t);
  // CONSERVATION, at the level this step actually changed. `planRuns` is not an inert extra key:
  // the moment the planner returns runs, delta-cursor switches `absIndexOf` and `genTrace` from
  // null to live structures and the cost split takes a different route through the same arithmetic.
  // So the question is not whether the delta's own laws hold (delta-attribution-segments.test.mjs
  // owns those) but whether the payload this module EMITS is unchanged by the seam being wired.
  //
  // Driven through the real computeDelta both times, with the planner defeated on the baseline run
  // by the same wrapper the live path uses — so the only difference between the two is the seam.
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const session = [
    { ts: t0, ev: 'prompt' },
    { ts: t0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: t0 + 2000, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 't1' },
    { ts: t0 + 3000, ev: 'edit', path: 'src/a.ts', added: 12, removed: 3, eid: 't2' },
    { ts: t0 + 4000, ev: 'tool', tool: 'grep', bytes: 80, ms: 4, eid: 't3' },
    { ts: t0 + 5000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 1957, token_output: 18 },
    { ts: t0 + 6000, ev: 'stop' },
  ];
  writeSidecar(home, session);

  // The live path, planner wired (lib/checkpoint.mjs supplies `planRuns` itself).
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const withPlanner = queued();
  // Read before the baseline run clears it: the planner really did run, otherwise the equality
  // below is trivially true and this test proves nothing.
  const plannedCarry = stateOf('conv-1').attribution;

  fs.rmSync(queueDir(), { recursive: true, force: true });
  fs.rmSync(stateDir(), { recursive: true, force: true });
  writeSidecar(home, session);

  // The same run with the seam removed on the way through.
  const unplanned = (id, cursor, resolvers) =>
    realComputeDelta(id, cursor, { ...resolvers, planRuns: undefined, previousAttribution: null });
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: unplanned }),
    { emitTimeline: true },
  );
  const withoutPlanner = queued();

  assert.equal(withPlanner.length, withoutPlanner.length, 'the same number of segments');
  assert.deepEqual(withPlanner, withoutPlanner, 'byte-for-byte the same payloads');
  assert.notEqual(plannedCarry, undefined, 'the planner produced a carry, so the seam was live');
  assert.equal(stateOf('conv-1').attribution, undefined, 'and the baseline run really had none');
});

test('every gated capability is still off, and nothing it guards is on the wire', async (t) => {
  const home = tmpHome(t);
  // The gates are default-off by contract until the backend accepts the field. This is the assertion
  // that fails if one is flipped without the DTO evidence: the ingest route runs a global
  // `forbidNonWhitelisted` pipe, so a single unrecognised top-level property 400s the whole report
  // and the segment's tokens, cost, code changes and operations are discarded together.
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  writeSidecar(home, [
    // `cv` is the stamped host build — the value CAPABILITIES.cursorVersion would emit. It has to
    // really be present, or this test passes for the wrong reason: a flipped gate that finds nothing
    // to send also emits nothing.
    { ts: t0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', cv: '1.7.44' },
    { ts: t0 + 1000, ev: 'edit', path: 'src/a.ts', added: 3, removed: 1, eid: 'e1' },
    { ts: t0 + 2000, ev: 'stop' },
  ]);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });

  const [payload] = queued();
  assert.ok(payload, 'the window must have produced a segment');
  for (const field of [
    'cursor_version',
    'claude_md_lines',
    'project_instructions_status',
    'context_peak_tokens',
    'context_final_tokens',
    'context_final_model',
  ]) {
    assert.equal(field in payload, false, `${field} is gated and must not be emitted`);
  }
  for (const model of payload.models) {
    assert.equal('by_effort' in model, false, 'by_effort is gated too');
  }
});

// ── C-13: the tenant policy gate sits above every read, delta and queue write ──────────────

// A delta that must never be reached. It both COUNTS and throws, and both halves are needed: a
// throwing delta alone is not evidence, because `runCheckpoint` already swallows one and returns
// the same zeroes the gate does — the test would pass with no gate at all. The call count is what
// separates "the gate stopped it" from "it ran and failed".
function neverCalledDelta() {
  const spy = () => { spy.calls += 1; throw new Error('the gate let a delta computation through'); };
  spy.calls = 0;
  return spy;
}

test('live tracking enqueues and posts exactly as today', async (t) => {
  tmpHome(t);
  writeTrackingState({ trackingMode: TrackingMode.LIVE, email: 'me@example.com' });

  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
  );

  assert.equal(res.enqueued, 1);
  assert.equal(queued().length, 1);
  assert.equal(res.flush.gated, false, 'the flush was not held');
});

test('a missing tracking cache fails open and behaves exactly as today', async (t) => {
  tmpHome(t);
  // No tracking.json at all. The SERVER is the actual boundary; failing closed here would dark-mode
  // every fresh install until its first whoami, and a policy this machine has never been told is
  // not the same as a policy that says no.
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
  );

  assert.equal(res.enqueued, 1);
  assert.equal(queued().length, 1);
});

for (const mode of [TrackingMode.BACKFILL_ONLY, TrackingMode.DISABLED]) {
  test(`${mode} performs no delta computation, no enqueue and no POST`, async (t) => {
    tmpHome(t);
    writeTrackingState({ trackingMode: mode, email: 'me@example.com' });
    let posts = 0;
    const computeDelta = neverCalledDelta();

    const res = await runCheckpoint(
      { session_id: 'conv-1', cwd: '/repo' },
      deps({
        computeDelta,
        fetchImpl: async () => { posts += 1; throw new Error('network disabled in test'); },
      }),
    );

    assert.equal(computeDelta.calls, 0, 'the gate sits ABOVE every source and delta read');
    // And the run is gated rather than merely empty. Without this the assertions below all hold for
    // a checkpoint whose delta simply failed, which is a different outcome with the same shape.
    assert.equal(res.flush.gated, true);
    assert.equal(res.enqueued, 0);
    // An absent queue directory, not merely an empty read: refusing to DELIVER is not enough on its
    // own, because a disabled tenant would still accumulate records on disk that nothing may ever
    // send — data the user was told was not being collected.
    assert.equal(fs.existsSync(queueDir()), false, 'not one queue file was written');
    assert.equal(posts, 0, 'and nothing was posted');
    assert.equal(fs.existsSync(path.join(stateDir(), 'conv-1.json')), false, 'no state either');
  });
}

test('a gated checkpoint still returns a flush result, and it says gated', async (t) => {
  tmpHome(t);
  writeTrackingState({ trackingMode: TrackingMode.DISABLED, email: 'me@example.com' });
  // Something already in the queue from before the policy arrived, so there is a drain to report on.
  fs.mkdirSync(queueDir(), { recursive: true });
  fs.writeFileSync(path.join(queueDir(), 'held.json'), JSON.stringify({ segmentId: 'held:0-1', sessionId: 'held' }));

  const computeDelta = neverCalledDelta();
  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta }),
  );

  assert.equal(computeDelta.calls, 0);
  // NOT `emptyResult()`, which returns `flush: null` — a CLI prints that as "nothing new", and the
  // whole point of this branch is to be able to say the records are HELD.
  assert.notEqual(res.flush, null, 'a gated run must still report a flush summary');
  assert.equal(res.flush.gated, true);
  assert.equal(res.flush.flushed, 0);
  assert.equal(fs.existsSync(path.join(queueDir(), 'held.json')), true, 'and the record is kept');
});

test('audit mode is unaffected by the live gate', async (t) => {
  tmpHome(t);
  writeTrackingState({ trackingMode: TrackingMode.DISABLED, email: 'me@example.com' });
  // The backfill is governed by HISTORY authorization — the server's one-time-pull rules — not by
  // the live policy. Folding the two together would leave a disabled tenant unable to complete an
  // import it is entitled to, which is the one import those tenants exist to run.
  const reports = [];

  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta() }),
    { mode: CheckpointMode.AUDIT, sink: (payload) => reports.push(payload) },
  );

  assert.equal(res.enqueued, 1);
  assert.equal(reports.length, 1, 'the audit produced its report through the sink');
  assert.equal(fs.existsSync(queueDir()), false, 'without touching the live queue');
});

// ── C-14 / C-15 / C-16: the extraction seam ─────────────────────────────────────

test('extractAuditReports returns reports WHILE the caller holds the session lock', async (t) => {
  tmpHome(t);
  // The assertion that catches the nesting regression. `runSync` holds `sessionLockPath(id)` across
  // the coverage query, the extraction and the acknowledgment — its guarded section legitimately
  // runs for minutes — so an extraction that took the lock for itself would lose the race against
  // its own caller. `withLock` SKIPS on contention, so the loss is silent: zero reports, which in a
  // sync summary is indistinguishable from "everything is already covered".
  const inside = await withLock(sessionLockPath('conv-1'), async () => {
    return extractAuditReports(
      { session_id: 'conv-1', cwd: '/repo' },
      deps({ computeDelta: () => delta() }),
      { startCursor: 0 },
    );
  }, { now: Date.now });

  assert.equal(inside.reports.length, 1, 'the extraction ran under the held lock');
  assert.equal(inside.deltaFailed, false);
  assert.deepEqual(inside.sessionErrors, []);
  assert.equal(fs.existsSync(queueDir()), false, 'and it never touched the live queue');
});

test('a startCursor run reports from that line and leaves the live state untouched', async (t) => {
  tmpHome(t);
  // Sync replaces the locally-tracked read position with the SERVER's verified coverage. It is only
  // ever combined with a fresh state, so nothing computed off it may be written back: the audit
  // route, not the cursor, decides what was delivered.
  fs.mkdirSync(stateDir(), { recursive: true });
  const before = { cursor: 99, cursorBytes: 4242, sentSessionName: 'live', anchor: null };
  fs.writeFileSync(path.join(stateDir(), 'conv-1.json'), JSON.stringify(before));

  const seen = [];
  const recording = (id, cursor) => {
    seen.push(cursor);
    return delta({ segmentId: 'conv-1:7-9', from: 7, to: 9, nextCursor: 9 });
  };

  const out = await extractAuditReports(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: recording }),
    { startCursor: 7 },
  );

  assert.deepEqual(seen, [7], 'the delta was asked to start at the server-verified line');
  assert.equal(out.reports[0].from_line, 7);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(stateDir(), 'conv-1.json'), 'utf-8')),
    before,
    'the live state file is byte-identical',
  );
});

test('startCursor defaults to zero, so an audit with no coverage replays the whole session', async (t) => {
  tmpHome(t);
  const seen = [];
  await extractAuditReports(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: (id, cursor) => { seen.push(cursor); return delta(); } }),
    {},
  );
  assert.deepEqual(seen, [0]);
});
