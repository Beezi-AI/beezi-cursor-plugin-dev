import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, CheckpointMode } from '../lib/checkpoint.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-cursor.mjs';
import { clearCliChatCache } from '../lib/cli-chats-cursor.mjs';
import { childOwnerFile, readChildOwner, writeChildOwner } from '../lib/cli-child-owner.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';
import { TrackingMode, currentAccountKey, writeTrackingState } from '../lib/tracking.mjs';

// A Cursor CLI worker's OWN work, folded into the parent's `is_subagent` row for it.
//
// Since CLI 2026.09.23 a worker's tool calls and edits land in a sidecar of its own, under its own
// conversation_id, and the ownership guard (test/cli-child-sessions.test.mjs) no longer reports that
// sidecar as a session. Without the fold its edits and tool calls would reach the server nowhere at
// all. The parent's row is the one place they can go without being counted twice: the worker's lines
// are never in the parent's stream, and the row is upserted by a stable segmentId, so it carries the
// worker's CUMULATIVE figures and is re-sent only when they change.

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;
const PARENT = '90000000-0000-4000-8000-000000000001';
const KID = '11111111-2222-4333-8444-555555555555';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-fold-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  clearCliChatCache();
  // A linked machine with a known account. A stored fold is reused only under the account it was
  // staged under (fix round 3), and a machine that knows no account reuses none.
  writeTrackingState({ trackingMode: TrackingMode.LIVE, email: 'me@example.com' });
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeStore(file, meta, blobs = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  blobs.forEach((blob, i) => ins.run(`b${i}`, Buffer.from(JSON.stringify(blob), 'utf8')));
  db.close();
}

const T0 = Date.now() - 10 * 60_000;

// The parent names its worker in a CallDynamicTool result; the worker's store points back at it.
function chats(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-chats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentDir = path.join(root, 'h', PARENT);
  writeStore(path.join(parentDir, 'store.db'), { name: 'Parent', createdAt: T0 }, [{
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'CallDynamicTool', result: `done\nAgent ID: ${KID}` }],
  }]);
  fs.writeFileSync(path.join(parentDir, 'meta.json'), JSON.stringify({ title: 'Parent' }));
  writeStore(path.join(root, 'h', KID, 'store.db'), {
    name: 'New Agent',
    createdAt: T0 + 60_000,
    subagentInfo: { parentAgentId: PARENT, rootParentAgentId: PARENT, toolCallId: 'toolu_1', typeName: 'explore' },
  });
  return root;
}

function writeLines(home, id, events, { append = false } = {}) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const file = path.join(home, 'events', `${id}.jsonl`);
  if (append) fs.appendFileSync(file, text);
  else fs.writeFileSync(file, text);
}

// A parent that edited nothing itself, so any line count on the wire is provably the worker's.
function writeParent(home) {
  writeLines(home, PARENT, [
    { ts: T0, ev: 'session_start' },
    { ts: T0 + 1000, ev: 'prompt' },
    { ts: T0 + 2000, ev: 'gen', model: 'claude-opus-5', gen_id: 'g1' },
    { ts: T0 + 3000, ev: 'tool', tool: 'Task', bytes: 10 },
    { ts: T0 + 300_000, ev: 'gen', model: 'claude-opus-5', gen_id: 'g2' },
    { ts: T0 + 301_000, ev: 'stop' },
  ]);
}

function writeKid(home) {
  writeLines(home, KID, [
    { ts: T0 + 61_000, ev: 'gen', model: 'claude-opus-5', gen_id: 'k1' },
    { ts: T0 + 62_000, ev: 'tool', tool: 'Read', bytes: 100 },
    { ts: T0 + 63_000, ev: 'tool', tool: 'Grep', bytes: 50 },
    { ts: T0 + 64_000, ev: 'edit', path: '/repo/src/a.ts', added: 5, removed: 1 },
    { ts: T0 + 65_000, ev: 'shell', command: 'ls' },
  ]);
}

function fakeGit(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return 'main';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

const deps = (chatsDir, over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  chatsDir,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

function queued() {
  let files;
  try { files = fs.readdirSync(queueDir()); } catch { return []; }
  return files.filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf8')));
}
const clearQueue = () => { for (const f of fs.readdirSync(queueDir())) fs.rmSync(path.join(queueDir(), f)); };
const kidRow = (payloads) => payloads.find((p) => p.is_subagent === true && p.agent_id === KID);
const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf8'));

// The worker's whole-stream figures, computed independently of the checkpoint.
function kidWork() {
  const d = realComputeDelta(KID, 0, { readUsageData: () => null, cliStoreFacts: null, cliMeta: null, aiCodeTrackingDbFile: null });
  return JSON.parse(JSON.stringify({ code_changes: d.code_changes, operations: d.operations }));
}

const TURN = { emitTimeline: true, budgetMs: 60_000 };

test("the parent's subagent row for a CLI worker carries the worker's own code changes and operations", { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chats(t)), TURN);

  const row = kidRow(queued());
  assert.ok(row, 'the worker is reported as a subagent row of the parent');
  assert.deepEqual(row.code_changes, { files_changed: 1, lines_added: 5, lines_removed: 1, by_extension: { '.ts': 1 } });
  assert.deepEqual(row.operations, kidWork().operations);
  assert.ok(Object.values(row.operations).some((b) => b != null && b.count > 0), 'the fixture has operations to fold');
  // Supersede-safe (A4): the window covers every earlier row of this worker.
  assert.equal(row.from_line, 0);
  // Tokens, models and duration are exactly what an unfolded row carries.
  assert.equal(row.token_total, 0);
  assert.ok(row.models.every((m) => m.requests === 0 && m.token_input === 0));
  // The worker's lines are nowhere in the parent's own segment.
  const main = queued().find((p) => p.is_subagent !== true);
  assert.equal(main.code_changes.lines_added, 0);
  // No new top-level keys: the fold uses the two the main segment already sends.
  const unfoldedKeys = Object.keys(row).filter((k) => k !== 'code_changes' && k !== 'operations');
  assert.equal(unfoldedKeys.includes('mcpAliases'), false);
  assert.equal(JSON.stringify(row).includes('mcpAliases'), false);
});

test('an unchanged worker is not re-queued; a worker whose sidecar grew is, with cumulative figures', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  assert.ok(kidRow(queued()));
  clearQueue();

  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  assert.equal(kidRow(queued()), undefined, 'same duration and same work: nothing to say');

  writeLines(home, KID, [{ ts: T0 + 70_000, ev: 'edit', path: '/repo/src/b.ts', added: 7, removed: 0 }], { append: true });
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const row = kidRow(queued());
  assert.ok(row, 'the worker did more: the row is sent again');
  assert.deepEqual(row.code_changes, { files_changed: 2, lines_added: 12, lines_removed: 1, by_extension: { '.ts': 2 } });
  assert.equal(row.from_line, 0);
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].code_changes.lines_added, 12);
});

test('a fold that cannot run re-sends the last folded figures, never fewer, and records nothing new', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const first = stateOf(PARENT).sentSubagentWork[KID];
  assert.ok(first && typeof first.sig === 'string');
  clearQueue();

  // The row has to go out again (the duration on record is forgotten), but the worker's delta throws.
  // The server REPLACES a subagent row's values on upsert, so a row without its fold would wipe it.
  const st = stateOf(PARENT);
  delete st.sentSubagents[KID];
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  writeLines(home, KID, [{ ts: T0 + 70_000, ev: 'edit', path: '/repo/src/b.ts', added: 7, removed: 0 }], { append: true });
  const failingFold = (id, from, r) => {
    if (id === KID) throw new Error('child sidecar unreadable');
    return realComputeDelta(id, from, r);
  };
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { computeDelta: failingFold }), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.deepEqual(row.code_changes, first.code_changes, 'the stored fold, not an empty row');
  assert.deepEqual(row.operations, first.operations);
  assert.equal(row.from_line, 0);
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].sig, first.sig, 'nothing new was learned, so nothing new is recorded');
});

// The worker's sidecar is pruned (14 days after its last line) while the parent goes on, so its
// ownership can no longer be proven this run. A row that once carried a fold must still carry it:
// the stored fold IS the proof, and a bare row on the same sourceRef would wipe it server-side.
test('a row that once carried a fold keeps carrying it when the worker can no longer be proven', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const first = stateOf(PARENT).sentSubagentWork[KID];
  assert.ok(first);
  clearQueue();

  const st = stateOf(PARENT);
  delete st.sentSubagents[KID];
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const row = kidRow(queued());
  assert.ok(row, 'the span still comes from the parent\'s store, so the row is re-sent');
  assert.deepEqual(row.code_changes, first.code_changes);
  assert.deepEqual(row.operations, first.operations);
  assert.equal(row.from_line, 0);
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].sig, first.sig);
});

// Fix round 2 restores this test's ORIGINAL contract. Round 1 withheld the row (Codex re-review:
// that can drop a legitimate worker's duration row for good, to protect metrics that do not exist).
// A worker with no fold on record anywhere — state or marker — was never folded, so its bare row
// overwrites nothing; it goes out exactly as it did before the fold existed.
test('a short budget sends the row bare and records no fold; the next turn-end sends it folded', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  // A pinned clock: the checkpoint's own budget is always 500 ms from now, while the chat-store
  // listing (wall clock) sees a deadline ten minutes out and lists the worker normally.
  const pinned = Date.now() + 10 * 60_000;
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { now: () => pinned }), { emitTimeline: true, budgetMs: 500 });
  const bare = kidRow(queued());
  assert.ok(bare, 'the row is sent, as it always was');
  assert.equal('code_changes' in bare, false);
  assert.equal('operations' in bare, false);
  const st = stateOf(PARENT);
  assert.equal(st.sentSubagentWork == null || st.sentSubagentWork[KID] == null, true, 'no signature, so the next turn-end folds');
  assert.equal(readChildOwner(KID).work, undefined, 'no fold on the marker either');
  clearQueue();

  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const row = kidRow(queued());
  assert.ok(row, 'sent again once the fold can run');
  assert.equal(row.code_changes.lines_added, 5);
});

// ─── fix round 1 (Codex review): a fold is never replaced or dropped by a failed read ──────────

const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

// Folds once, then forgets the duration on record so the next turn-end has to send the row again.
async function foldOnceThenForceResend(t, home) {
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const first = stateOf(PARENT).sentSubagentWork[KID];
  assert.ok(first && first.code_changes.lines_added === 5);
  clearQueue();
  const st = stateOf(PARENT);
  delete st.sentSubagents[KID];
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  return { chatsDir, first };
}

test('an unreadable worker sidecar never replaces the stored fold with zeros', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const { chatsDir, first } = await foldOnceThenForceResend(t, home);
  // The sidecar is there (the stat passes) but reading it fails: the delta engine answers an EMPTY
  // stream rather than throwing, which used to read as a fresh fold of zeros.
  const unreadable = (id, from, r) => realComputeDelta(id, from, id === KID ? { ...r, readFile: () => { throw eacces(); } } : r);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { computeDelta: unreadable }), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.deepEqual(row.code_changes, first.code_changes);
  assert.deepEqual(row.operations, first.operations);
  assert.deepEqual(stateOf(PARENT).sentSubagentWork[KID], first, 'the stored work is unchanged');
});

// Rewritten in fix round 2: it used to assert the row was withheld. A zero fold from a failed read
// is still not a fold (the round-1 guard), but with no fold on record anywhere the row goes out
// bare, as it did before the fold existed.
test('an unreadable worker sidecar with no fold on record sends the bare row, never zeros', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  // The worker's own guard already recorded it; this parent has never folded it.
  writeChildOwner(KID, { parent: PARENT, root: PARENT });
  const unreadable = (id, from, r) => realComputeDelta(id, from, id === KID ? { ...r, readFile: () => { throw eacces(); } } : r);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chats(t), { computeDelta: unreadable }), TURN);
  const row = kidRow(queued());
  assert.ok(row, 'the duration row is not withheld');
  assert.equal('code_changes' in row, false, 'a zero fold from a failed read is not a fold');
  assert.equal('operations' in row, false);
  const st = stateOf(PARENT);
  assert.equal(st.sentSubagentWork == null || st.sentSubagentWork[KID] == null, true);
  assert.equal(readChildOwner(KID).work, undefined);
});

test('a worker sidecar that shrank never lowers the stored fold', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const { chatsDir, first } = await foldOnceThenForceResend(t, home);
  // Recreated or truncated: append-only means cumulative figures can only grow, so fewer is a bad read.
  writeLines(home, KID, [{ ts: T0 + 61_000, ev: 'gen', model: 'claude-opus-5', gen_id: 'k1' }]);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.deepEqual(row.code_changes, first.code_changes);
  assert.deepEqual(stateOf(PARENT).sentSubagentWork[KID], first);
});

// Rewritten in fix round 2: it used to assert the row was withheld. The fold is now recovered from
// the owner marker, which keeps the last one staged beside the ids.
test('a live turn-end with no fold in state recovers it from the marker once the sidecar is gone', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const { chatsDir, first } = await foldOnceThenForceResend(t, home);
  assert.deepEqual(readChildOwner(KID).work, first, 'the staged fold is on the marker');
  const st = stateOf(PARENT);
  delete st.sentSubagentWork;
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.deepEqual(row.code_changes, first.code_changes);
  assert.deepEqual(row.operations, first.operations);
  assert.equal(row.from_line, 0);
});

test('a worker never folded, with a marker and no sidecar, still gets its bare duration row', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  // Recorded by its own guard once, then its sidecar was pruned: no fold was ever staged anywhere.
  writeChildOwner(KID, { parent: PARENT, root: PARENT });
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chats(t)), TURN);
  const row = kidRow(queued());
  assert.ok(row, 'a known worker is never dropped');
  assert.equal('code_changes' in row, false);
  assert.equal(typeof row.duration_sec, 'number');
});

test('an audit-mode fold is recovered from the marker by a later run with no state and no sidecar', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  const reports = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), { mode: CheckpointMode.AUDIT, sink: (p) => reports.push(p) });
  const audited = kidRow(reports);
  assert.equal(audited.code_changes.lines_added, 5);
  assert.equal(fs.existsSync(path.join(stateDir(), `${PARENT}.json`)), false, 'the audit keeps no state');
  assert.equal(readChildOwner(KID).work.code_changes.lines_added, 5, 'but the marker keeps its fold');

  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  clearCliChatCache();
  // A later sync of the same session: no state, no worker sidecar.
  const again = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), { mode: CheckpointMode.AUDIT, sink: (p) => again.push(p) });
  const row = kidRow(again);
  assert.ok(row);
  assert.deepEqual(row.code_changes, audited.code_changes);
  assert.deepEqual(row.operations, audited.operations);
  assert.equal(row.from_line, 0);
});

test('every parent turn-end that sees the worker refreshes its marker, sidecar or not, fold kept', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const first = readChildOwner(KID).work;
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  fs.utimesSync(childOwnerFile(KID), old / 1000, old / 1000);
  // Nothing changed for this worker, so its row is not even re-queued — the marker is refreshed anyway.
  clearQueue();
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  assert.equal(kidRow(queued()), undefined);
  assert.ok(fs.statSync(childOwnerFile(KID)).mtimeMs > old + 1000, 'aged with the parent, not pruned');
  assert.deepEqual(readChildOwner(KID).work, first);
});

test('the backfill carries the stored fold from the account-matched live state once the sidecar is gone', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeTrackingState({ trackingMode: TrackingMode.LIVE, email: 'me@example.com' });
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const first = stateOf(PARENT).sentSubagentWork[KID];
  assert.equal(stateOf(PARENT).account, currentAccountKey(), 'the live state is stamped with this account');
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  const before = fs.readFileSync(path.join(stateDir(), `${PARENT}.json`), 'utf8');
  // The marker's copy stripped, so only the live state can be the source here.
  fs.writeFileSync(childOwnerFile(KID), JSON.stringify({ v: 1, parent: PARENT, root: PARENT }));

  const reports = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), { mode: CheckpointMode.AUDIT, sink: (p) => reports.push(p) });
  const row = kidRow(reports);
  assert.ok(row);
  assert.deepEqual(row.code_changes, first.code_changes);
  assert.deepEqual(row.operations, first.operations);
  assert.equal(row.from_line, 0);
  assert.equal(fs.readFileSync(path.join(stateDir(), `${PARENT}.json`), 'utf8'), before, 'the audit never writes the live state');
});

// Rewritten in fix round 2: it used to assert the row was withheld. Another account's STATE is still
// never read; the fold comes from the marker, which records the worker's own figures.
test("the backfill ignores another account's state and recovers the fold from the marker", { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeTrackingState({ trackingMode: TrackingMode.LIVE, email: 'me@example.com' });
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const onMarker = readChildOwner(KID).work;
  const st = stateOf(PARENT);
  st.account = 'https://elsewhere|someone@else.com';
  // A state fold that must NOT be used: if it were, the row would say 999.
  st.sentSubagentWork[KID] = { ...st.sentSubagentWork[KID], sig: 'other', code_changes: { files_changed: 9, lines_added: 999, lines_removed: 0, by_extension: {} } };
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));

  const reports = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), { mode: CheckpointMode.AUDIT, sink: (p) => reports.push(p) });
  const row = kidRow(reports);
  assert.ok(row);
  assert.deepEqual(row.code_changes, onMarker.code_changes);
  assert.ok(reports.some((p) => p.is_subagent !== true), 'the main segment is unaffected');
});

// ─── fix round 3 (Codex re-review): a stored fold is scoped by account and freshness ──────────

test("an account-B run never reuses account A's stored fold, from the marker or the state", { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const { chatsDir } = await foldOnceThenForceResend(t, home);
  const accountA = currentAccountKey();
  assert.equal(readChildOwner(KID).work.account, accountA, 'the marker fold is stamped with its account');
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].account, accountA);
  // Account B signs in; the worker's sidecar is gone, so only a stored fold could fill the row.
  writeTrackingState({ trackingMode: TrackingMode.LIVE, email: 'b@example.com' });
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));

  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), TURN);
  const live = kidRow(queued());
  assert.ok(live, 'the duration row still goes, bare');
  assert.equal('code_changes' in live, false, "never A's figures under B");
  clearQueue();
  const reports = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir), { mode: CheckpointMode.AUDIT, sink: (p) => reports.push(p) });
  assert.equal('code_changes' in kidRow(reports), false);
  assert.equal(readChildOwner(KID).work.account, accountA, "A's fold is left where it was, not overwritten by B");
});

test('a newer audit fold on the marker beats an older live fold in state, and is kept', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const chatsDir = chats(t);
  const base = Date.now();
  // Live turn-end: the worker has 5 added lines, stored in state AND on the marker.
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { now: () => base }), TURN);
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].code_changes.lines_added, 5);
  // The worker does more, and a later backfill folds it: 10 lines, on the marker only.
  writeLines(home, KID, [{ ts: T0 + 70_000, ev: 'edit', path: '/repo/src/a.ts', added: 5, removed: 0 }], { append: true });
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { now: () => base + 60_000 }), {
    mode: CheckpointMode.AUDIT, sink: () => {},
  });
  assert.equal(readChildOwner(KID).work.code_changes.lines_added, 10);
  assert.equal(stateOf(PARENT).sentSubagentWork[KID].code_changes.lines_added, 5, 'the audit never writes state');
  // The sidecar is pruned; a live turn-end must re-send the NEWER fold, not the one its state holds.
  fs.rmSync(path.join(home, 'events', `${KID}.jsonl`));
  clearQueue();
  const st = stateOf(PARENT);
  delete st.sentSubagents[KID];
  fs.writeFileSync(path.join(stateDir(), `${PARENT}.json`), JSON.stringify(st));
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chatsDir, { now: () => base + 120_000 }), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.equal(row.code_changes.lines_added, 10, 'the newest same-account fold');
  assert.equal(readChildOwner(KID).work.code_changes.lines_added, 10, 'never an older fold written over it');
});

test('a worker recorded as someone else\'s child is not folded into this parent', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  writeChildOwner(KID, { parent: 'someone-else', root: 'someone-else' });
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chats(t)), TURN);
  const row = kidRow(queued());
  assert.ok(row);
  assert.equal('code_changes' in row, false);
});

test('the backfill folds too, from the same whole-sidecar parse', { skip: !sqlite }, async (t) => {
  const home = tmpHome(t);
  writeParent(home);
  writeKid(home);
  const reports = [];
  await runCheckpoint({ session_id: PARENT, cwd: '/repo' }, deps(chats(t)), {
    mode: CheckpointMode.AUDIT, sink: (p) => reports.push(p),
  });
  const row = kidRow(reports);
  assert.ok(row);
  assert.equal(row.code_changes.lines_added, 5);
  assert.equal(row.from_line, 0);
});
