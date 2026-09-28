import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, extractAuditReports } from '../lib/checkpoint.mjs';
import { clearCliChatCache } from '../lib/cli-chats-cursor.mjs';
import { childOwnerFile, readChildOwner, writeChildOwner } from '../lib/cli-child-owner.mjs';
import { maybeRunPulse, pulseStateFile, PULSE_INTERVAL_MS } from '../lib/pulse-cursor.mjs';
import { pendingDir, queueDir, stateDir, timelineOutboxDir } from '../lib/paths-cursor.mjs';

// A Cursor CLI subagent chat is never a session of its own.
//
// CLI 2026.09.23 fires postToolUse, afterShellExecution and afterFileEdit inside a subagent chat under
// the CHILD's conversation_id, so the child gets its own sidecar and the mid-turn pulse checkpointed
// it like any session: each child reached /sessions/report and the timeline as a nameless top-level
// session, while its parent already reported the same worker as an `is_subagent` row. These tests
// drive the real checkpoint over a real chat-store fixture: the ownership guard must stop a child
// before it reads, writes or posts anything, remember the ownership durably, and DEFER (retryably)
// when it cannot tell.

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;
const PARENT = '90000000-0000-4000-8000-000000000001';
const KID = '11111111-2222-4333-8444-555555555555';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-child-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  clearCliChatCache();
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeStore(file, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  db.close();
}

// The child's store as observed on CLI 2026.09.23: a back-pointer, no meta.json.
function childChats(t, { garbage = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-chats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'h', KID, 'store.db');
  if (garbage) {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'not a database at all. '.repeat(64));
  } else {
    writeStore(store, {
      name: 'New Agent',
      createdAt: Date.now() - 60_000,
      blobEncryptionKey: 'CHILD-SECRET',
      subagentInfo: { parentAgentId: PARENT, rootParentAgentId: PARENT, toolCallId: 'toolu_1', typeName: 'explore' },
    });
  }
  return root;
}

// What a child's sidecar holds: work lines only, no session_start / prompt / stop.
function writeChildSidecar(home) {
  const t0 = Date.now() - 50_000;
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(path.join(home, 'events', `${KID}.jsonl`), [
    { ts: t0, ev: 'gen', model: 'claude-opus-5', gen_id: 'g1' },
    { ts: t0 + 1000, ev: 'tool', tool: 'Read', bytes: 10 },
    { ts: t0 + 2000, ev: 'edit', path: '/repo/src/a.ts', added: 5, removed: 1 },
    { ts: t0 + 3000, ev: 'shell', command: 'ls' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function fakeGit(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return 'main';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function deps(chatsDir, calls) {
  return {
    getAccessToken: async () => 'tok',
    gitImpl: fakeGit,
    chatsDir,
    fetchImpl: async (url) => { calls.push(String(url)); throw new Error('network disabled in test'); },
  };
}

const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

test('a CLI child is not reported: no report, no timeline, no state, and the ownership is recorded', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  const calls = [];
  const result = await runCheckpoint(
    { session_id: KID, cwd: '/repo' },
    deps(childChats(t), calls),
    { emitTimeline: true, budgetMs: 60_000 },
  );

  assert.equal(result.skippedChild, true);
  assert.equal(result.enqueued, 0);
  assert.deepEqual(list(queueDir()), [], 'nothing queued for /sessions/report');
  assert.deepEqual(list(timelineOutboxDir()), [], 'no timeline outbox entry');
  assert.equal(calls.some((u) => /timeline/i.test(u)), false, 'no timeline POST');
  assert.equal(fs.existsSync(path.join(stateDir(), `${KID}.json`)), false, 'no state or cursor written');
  assert.deepEqual(readChildOwner(KID), { parent: PARENT, root: PARENT });
  // The marker is ids only: nothing from the store's meta row travels with it.
  assert.equal(fs.readFileSync(childOwnerFile(KID), 'utf8').includes('SECRET'), false);
  // The queue of OTHER sessions is still drained, exactly as on the tracking gate's early return.
  assert.ok(result.flush != null, 'the machine-wide flush still ran');
});

test('a recorded child stays a child once its chat store is gone, and the marker is refreshed', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  const calls = [];
  const chats = childChats(t);
  await runCheckpoint({ session_id: KID, cwd: '/repo' }, deps(chats, calls), { emitTimeline: true, budgetMs: 60_000 });
  assert.ok(readChildOwner(KID));

  // The store disappears and the process-local caches with it: only the marker can still say so.
  fs.rmSync(chats, { recursive: true, force: true });
  clearCliChatCache();
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  fs.utimesSync(childOwnerFile(KID), old / 1000, old / 1000);

  const result = await runCheckpoint({ session_id: KID, cwd: '/repo' }, deps(chats, calls), { emitTimeline: true, budgetMs: 60_000 });
  assert.equal(result.skippedChild, true);
  assert.deepEqual(list(queueDir()), []);
  assert.equal(fs.existsSync(path.join(stateDir(), `${KID}.json`)), false);
  // Rewritten on every guard hit, so it ages with the child's activity (prune's clock).
  assert.ok(fs.statSync(childOwnerFile(KID)).mtimeMs > old + 1000);
});

test('a child pending batch is never recovered onto the queue', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  // A batch left by a build that did report children. Recovery lives below the guard.
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(path.join(pendingDir(), `${KID}.json`), JSON.stringify({
    version: 1, sessionId: KID, account: null, items: [{ segmentId: `${KID}:0-4`, payload: { segmentId: `${KID}:0-4`, sessionId: KID } }], next: { cursor: 4 },
  }));
  await runCheckpoint({ session_id: KID, cwd: '/repo' }, deps(childChats(t), []), { budgetMs: 60_000 });
  assert.deepEqual(list(queueDir()), []);
  assert.equal(fs.existsSync(path.join(stateDir(), `${KID}.json`)), false);
});

test('a chat that cannot be classified yet defers: nothing reported, nothing recorded, retryable', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  const result = await runCheckpoint(
    { session_id: KID, cwd: '/repo' },
    deps(childChats(t, { garbage: true }), []),
    { emitTimeline: true, budgetMs: 60_000 },
  );
  assert.equal(result.deferred, true);
  assert.notEqual(result.skippedChild, true);
  assert.equal(result.enqueued, 0);
  assert.deepEqual(list(queueDir()), []);
  assert.equal(fs.existsSync(path.join(stateDir(), `${KID}.json`)), false, 'the cursor does not move');
  assert.equal(readChildOwner(KID), null, 'an unknown is never written down');
});

test('the pulse stamps a deferred checkpoint as a failure, so it retries in a minute', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  const chats = childChats(t, { garbage: true });
  const T = Date.now();
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(pulseStateFile(KID), JSON.stringify({ v: 1, lastAt: T - PULSE_INTERVAL_MS - 1, ok: true }));
  const outcome = await maybeRunPulse({ session_id: KID, cwd: '/repo' }, {
    now: () => T,
    runCheckpoint: (input, _d, options) => runCheckpoint(input, deps(chats, []), options),
  }, 5_000);
  assert.equal(outcome.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(pulseStateFile(KID), 'utf8')).ok, false);
});

test('the pulse still stamps success for a checkpoint that answered normally, or answered nothing', async (t) => {
  tmpHome(t);
  const T = Date.now();
  fs.mkdirSync(stateDir(), { recursive: true });
  for (const answer of [{ enqueued: 0, flush: null, skippedChild: true }, undefined]) {
    fs.writeFileSync(pulseStateFile(KID), JSON.stringify({ v: 1, lastAt: T - PULSE_INTERVAL_MS - 1, ok: true }));
    const outcome = await maybeRunPulse({ session_id: KID }, { now: () => T, runCheckpoint: async () => answer }, 5_000);
    assert.equal(outcome.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(pulseStateFile(KID), 'utf8')).ok, true);
  }
});

test('audit extraction of a child yields no reports; of an unknown, a deferral the caller can see', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  const child = await extractAuditReports({ session_id: KID, cwd: '/repo' }, deps(childChats(t), []), {});
  assert.deepEqual(child.reports, []);
  assert.equal(child.deferred, false);
  // The backfill never uploads a child, and it records the ownership too.
  assert.deepEqual(readChildOwner(KID), { parent: PARENT, root: PARENT });

  fs.rmSync(childOwnerFile(KID));
  clearCliChatCache();
  const unknown = await extractAuditReports({ session_id: KID, cwd: '/repo' }, deps(childChats(t, { garbage: true }), []), {});
  assert.deepEqual(unknown.reports, []);
  assert.equal(unknown.deferred, true);
});

test('a top-level CLI chat and an IDE conversation are reported exactly as before', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  // The same sidecar under an id with no chat dir at all: an IDE conversation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-chats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runCheckpoint({ session_id: KID, cwd: '/repo' }, deps(root, []), { budgetMs: 60_000 });
  assert.equal(result.skippedChild, undefined);
  assert.equal(result.deferred, undefined);
  assert.equal(list(queueDir()).length, 1, 'the main segment is queued');
  assert.equal(readChildOwner(KID), null);
});

test('a marker written by an earlier run wins over a store that would now say top-level', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeChildSidecar(home);
  writeChildOwner(KID, { parent: PARENT, root: PARENT });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-chats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runCheckpoint({ session_id: KID, cwd: '/repo' }, deps(root, []), { budgetMs: 60_000 });
  assert.equal(result.skippedChild, true);
  assert.deepEqual(list(queueDir()), []);
});
