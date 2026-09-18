import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { pendingDir, queueDir, stateDir } from '../lib/paths-cursor.mjs';
import { sessionLockPath, withLock } from '../lib/lock.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { safeName } from '../lib/sidecar.mjs';

// C-10 — the immutable pending batch, and the crash matrix it exists to satisfy (handoff-repo P3,
// cases T1-T8).
//
// The ambiguity being removed: `state/<id>.json` is COMMITTED TRUTH and the queue is what has been
// handed on, and between "the segments are queued" and "the cursor says so" there used to be no
// record of which half had landed. A process killed in that gap either lost the window (the cursor
// never moved, but a later run derived a DIFFERENT segmentId over a sidecar that had grown, so the
// server's idempotency key could not collapse the overlap) or double-billed it. The pending record
// is the third file that makes the two states distinguishable: build everything, make the intent
// durable, queue it all, commit once, then delete the intent.
//
// Every test here drives the real `runCheckpoint` and asserts on the real files. A crash point is
// manufactured by blocking exactly one write — `writeJsonSecure` renames a temp file over its
// target, and renaming onto a DIRECTORY throws on every platform this ships to. That is not an
// artificial failure: a queue write really does fail in the field (a Windows AV scanner or backup
// agent holding a handle is the usual cause), which is why the blocked path is a directory rather
// than a monkey-patched fs.

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// One window: a generation whose counts arrive at the turn end, an edit, a ten-minute subagent, a
// stop. Two items come out of it — the main segment and one subagent segment — which is the minimum
// that can distinguish "some items queued" from "all items queued".
const SESSION = [
  { ts: T0, ev: 'prompt' },
  { ts: T0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
  { ts: T0 + 2000, ev: 'edit', path: 'src/a.ts', added: 12, removed: 3, eid: 'e1' },
  { ts: T0 + 3000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit the parser' },
  { ts: T0 + 603000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'audit the parser' },
  { ts: T0 + 604000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 1957, token_output: 18 },
  { ts: T0 + 604000, ev: 'stop' },
];

// What arrives AFTER the crash, for T6: more lines and a bigger cumulative usage reading. Neither
// may reach the recovered window.
const LATER = SESSION.concat([
  { ts: T0 + 700000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g2', token_input: 40 },
  { ts: T0 + 701000, ev: 'stop' },
]);

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-pending-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
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

const turnEnd = { emitTimeline: true };

function writeSidecar(home, events) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

function queueFile(segmentId) {
  return path.join(queueDir(), `${safeName(segmentId)}.json`);
}

function queued() {
  let names;
  try { names = fs.readdirSync(queueDir()); } catch { return []; }
  return names
    .map((name) => path.join(queueDir(), name))
    // A manufactured crash point is a DIRECTORY at a queue path, so "a file that is there" and
    // "a queued report" are not the same thing here.
    .filter((file) => file.endsWith('.json') && fs.statSync(file).isFile())
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf-8')))
    .sort((a, b) => a.segmentId.localeCompare(b.segmentId));
}

function stateOf(id) {
  const file = path.join(stateDir(), `${safeName(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

function pendingOf(id) {
  const file = path.join(pendingDir(), `${safeName(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

// Make one write fail, the way a held handle or a stray directory does in the field.
function block(file) {
  fs.mkdirSync(file, { recursive: true });
  return () => fs.rmSync(file, { recursive: true, force: true });
}

const MAIN = 'conv-1:0-7';
const SUB = 'conv-1:sa-1:0-7';

// ─── the shape of the record ─────────────────────────────────────────────────────────────────────

test('the record names the account, the frozen window and the single commit', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  // Crash before the state commit by blocking it, so the record survives to be read.
  const unblock = block(path.join(stateDir(), 'conv-1.json'));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const batch = pendingOf('conv-1');
  assert.ok(batch, 'a window with items must leave a record');
  assert.equal(batch.version, 1, 'an unknown version is how a future shape announces itself');
  assert.equal(batch.sessionId, 'conv-1');
  assert.equal(typeof batch.createdAt, 'number');
  // No login has recorded an email in this home, so the batch belongs to the null account — and
  // strictly so: a batch built under one account must not be enqueued under another.
  assert.equal(batch.account, null);
  assert.deepEqual(batch.window, { from: 0, to: 7, byte: batch.next.cursorBytes });
  assert.deepEqual(batch.items.map((item) => item.segmentId), [MAIN, SUB]);
  assert.equal(batch.items[0].payload.segmentId, MAIN, 'the items carry finished payloads');
  // The commit is a SUPERSET block applied in one step. Never per item: a per-item write is exactly
  // the ambiguity this record removes.
  assert.equal(batch.next.cursor, 7);
  assert.ok(Array.isArray(batch.next.coveredIntervals));
  assert.deepEqual(batch.next.anchor.segmentId, MAIN);
  unblock();
});

// ─── T1 — crash BEFORE the pending write ─────────────────────────────────────────────────────────

test('T1: nothing durable, the cursor is unmoved, and the retry produces the same ids', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(path.join(pendingDir(), 'conv-1.json'));

  const first = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.equal(first.enqueued, 0, 'the batch never became durable, so nothing was queued');
  assert.deepEqual(queued(), [], 'and the queue is empty');
  assert.equal(stateOf('conv-1').cursor, 0, 'the cursor did not move');

  unblock();
  const second = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(second.enqueued, 2);
  assert.deepEqual(queued().map((payload) => payload.segmentId), [MAIN, SUB],
    'the retry derives the SAME segmentIds — an id that shifted would defeat the server dedupe');
  assert.equal(pendingOf('conv-1'), null, 'and the record is gone once it committed');
});

// ─── T2 — crash after the pending write, before any enqueue ──────────────────────────────────────

test('T2: all items are queued on recovery, byte-identical, and the state advances exactly once', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(queueFile(MAIN));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const frozen = pendingOf('conv-1');
  assert.ok(frozen, 'the record is durable before the first enqueue');
  assert.deepEqual(queued(), [], 'and not one item was written');

  unblock();
  const recovered = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.equal(recovered.enqueued, 2);
  assert.deepEqual(
    queued(),
    frozen.items.map((item) => item.payload),
    'the queued bytes are the frozen bytes, not a re-derivation',
  );
  const state = stateOf('conv-1');
  assert.deepEqual(state.cursor, frozen.next.cursor);
  assert.deepEqual(state.coveredIntervals, frozen.next.coveredIntervals);
  assert.equal(pendingOf('conv-1'), null);
});

// ─── T3 — crash after k of n enqueues ────────────────────────────────────────────────────────────

test('T3: the items already queued are left untouched, backoff and age included', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(queueFile(SUB));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.deepEqual(queued().map((payload) => payload.segmentId), [MAIN], 'one of two got through');
  const frozen = pendingOf('conv-1');
  assert.ok(frozen);

  // Now the first item has ALREADY FAILED A SEND, so its queue file carries `_retry`. This is the
  // rule the whole step turns on: `enqueueIfAbsent` must not rewrite it. Overwriting would reset
  // `firstQueuedAt` — which is the age the 14-day retention sweep measures — and `attempts`, which
  // is the head-of-line backoff. A record that has been failing for days would silently start over,
  // and a test that only COUNTS queue files would never notice.
  // Real wall clock, not the fixture's T0: `deliverQueue` expires a record whose `firstQueuedAt` is
  // more than two weeks old, so a fixture timestamp would have the flush delete the very file this
  // test is about.
  const retry = { attempts: 3, nextAttemptAt: Date.now() + 90_000, firstQueuedAt: Date.now() - 60_000 };
  const withRetry = JSON.parse(fs.readFileSync(queueFile(MAIN), 'utf-8'));
  withRetry._retry = retry;
  fs.writeFileSync(queueFile(MAIN), JSON.stringify(withRetry));

  unblock();
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const all = queued();
  assert.deepEqual(all.map((payload) => payload.segmentId), [MAIN, SUB], 'both items are present');
  const main = all.find((payload) => payload.segmentId === MAIN);
  assert.deepEqual(main._retry, retry, 'the pre-existing file was not rewritten');
  // And the item that had not been written is the frozen payload, not a fresh derivation.
  assert.deepEqual(
    all.find((payload) => payload.segmentId === SUB),
    frozen.items.find((item) => item.segmentId === SUB).payload,
  );
});

// ─── T4 — crash after all enqueues, before the state commit ──────────────────────────────────────

test('T4: next is applied exactly once and no item is queued twice', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(path.join(stateDir(), 'conv-1.json'));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const frozen = pendingOf('conv-1');
  assert.deepEqual(queued().map((payload) => payload.segmentId), [MAIN, SUB], 'every item landed');
  assert.ok(frozen, 'but the commit did not, so the record stays');

  unblock();
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const state = stateOf('conv-1');
  assert.equal(state.cursor, frozen.next.cursor);
  assert.deepEqual(state.usageSnapshot, frozen.next.usageSnapshot);
  assert.deepEqual(state.coveredIntervals, frozen.next.coveredIntervals);
  assert.deepEqual(state.attribution, frozen.next.attribution);
  assert.equal(state.cursorBytes, frozen.next.cursorBytes);
  assert.equal(queued().length, 2, 'and nothing was queued a second time');
  assert.equal(pendingOf('conv-1'), null);
});

// ─── T5 — crash after the state commit, before the pending delete ────────────────────────────────

test('T5: a committed batch is deleted, never re-applied', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const committed = stateOf('conv-1');
  assert.equal(pendingOf('conv-1'), null);

  // Put the record back exactly as it was at the moment before the unlink, with a `next` that would
  // be VISIBLE if it were re-applied: a rewound cursor and a wrong baseline. `state.cursor >=
  // next.cursor` is the only thing standing between this and a re-billed window.
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(path.join(pendingDir(), 'conv-1.json'), JSON.stringify({
    version: 1,
    sessionId: 'conv-1',
    createdAt: T0,
    account: null,
    window: { from: 0, to: 7, byte: 0 },
    runs: null,
    items: [{ segmentId: MAIN, payload: { segmentId: MAIN, sessionId: 'conv-1' } }],
    next: { cursor: committed.cursor, usageSnapshot: { poisoned: true }, coveredIntervals: [] },
  }));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.equal(pendingOf('conv-1'), null, 'the stale record is collected');
  const after = stateOf('conv-1');
  assert.notDeepEqual(after.usageSnapshot, { poisoned: true }, 'next was NOT applied again');
  assert.deepEqual(after.usageSnapshot, committed.usageSnapshot);
  assert.ok(after.cursor >= committed.cursor, 'and the cursor never went backwards');
});

// ─── T6 — the sidecar grew and usageData rose before the retry ───────────────────────────────────

test('T6: recovery commits the FROZEN window and baseline, and the new lines wait their turn', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(path.join(stateDir(), 'conv-1.json'));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const frozen = pendingOf('conv-1');
  assert.ok(frozen);

  // The crash is over and the world moved on: two more lines and a larger cumulative reading. A
  // recovery that re-parsed instead of replaying would widen the window, produce a segmentId the
  // server has never seen for lines it already holds, and baseline away the difference.
  unblock();
  writeSidecar(home, LATER);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.deepEqual(
    queued(),
    frozen.items.map((item) => item.payload),
    'byte-identical to the frozen batch — no line of the new activity is in it',
  );
  const state = stateOf('conv-1');
  assert.equal(state.cursor, frozen.window.to, 'the committed cursor is the frozen window');
  assert.deepEqual(state.usageSnapshot, frozen.next.usageSnapshot, 'and the frozen baseline');
  assert.equal(pendingOf('conv-1'), null);

  // The new lines are the NEXT window's, under their own id, and only now.
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const later = queued().find((payload) => payload.from_line === frozen.window.to);
  assert.ok(later, 'the following window starts exactly where the frozen one ended');
  assert.equal(stateOf('conv-1').cursor, LATER.length);
});

// ─── T7 — an item whose file does not exist is never skipped ─────────────────────────────────────

test('T7: the item that was missing is written, and nothing is assumed from a count', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(queueFile(SUB));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  unblock();
  // Delete the item that DID land, so the recovery has to write both. A recovery that resumed from
  // a count, or that trusted "the first one exists so the rest must too", queues neither.
  fs.unlinkSync(queueFile(MAIN));
  assert.deepEqual(queued(), []);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.deepEqual(queued().map((payload) => payload.segmentId), [MAIN, SUB]);
});

// ─── T8 — two checkpoints at the same turn boundary ──────────────────────────────────────────────

test('T8: recovery happens inside the session lock, and the loser observes the applied batch', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  const unblock = block(queueFile(MAIN));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const frozen = pendingOf('conv-1');
  assert.ok(frozen, 'there is a batch to race over');
  assert.deepEqual(queued(), [], 'and not one of its items is queued yet');
  unblock();

  // A checkpoint that arrives while another holds this session's lock must not recover the batch:
  // two processes replaying the same record is how one item gets written by both and the cursor is
  // committed twice. Contention SKIPS (see lib/lock.mjs) — it does not wait — so the loser does no
  // state work at all and leaves the record exactly as it found it.
  const contended = await withLock(sessionLockPath('conv-1'), async () => {
    return runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  }, { now: Date.now });

  assert.equal(contended.enqueued, 0, 'the loser did no state work');
  assert.ok(pendingOf('conv-1'), 'and the record is still there for the winner');
  assert.deepEqual(queued(), [], 'nothing was queued from outside the lock');

  // The next hook is uncontended: it recovers, commits, and the one after that sees the T5 path.
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.deepEqual(queued().map((payload) => payload.segmentId), [MAIN, SUB]);
  assert.equal(stateOf('conv-1').cursor, frozen.next.cursor);
  assert.equal(pendingOf('conv-1'), null);
});

// ─── a batch that is not this account's, or not this build's ─────────────────────────────────────

test('a batch built under another account is neither enqueued nor committed', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  fs.mkdirSync(pendingDir(), { recursive: true });
  const foreign = {
    version: 1,
    sessionId: 'conv-1',
    createdAt: T0,
    // A different tenant entirely. Enqueuing these payloads under THIS machine's credentials would
    // report one account's work to another; advancing this cursor over them would call work
    // delivered that this tenant never received. One orphaned file is cheaper than either.
    account: 'beezi|tenant-9|someone@else.io',
    window: { from: 0, to: 900, byte: 0 },
    runs: null,
    items: [{ segmentId: 'conv-1:0-900', payload: { segmentId: 'conv-1:0-900', sessionId: 'conv-1' } }],
    next: { cursor: 900 },
  };
  fs.writeFileSync(path.join(pendingDir(), 'conv-1.json'), JSON.stringify(foreign));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.equal(
    queued().some((payload) => payload.segmentId === 'conv-1:0-900'),
    false,
    'the foreign items never reached the queue',
  );
  assert.notEqual(stateOf('conv-1').cursor, 900, 'and the foreign commit was never applied');

  // This window's OWN progress, asserted over two checkpoints rather than one. The foreign
  // assertions above are unconditional and are what this test is for; the cursor reaching 7 is
  // ordinary progress, and on a loaded machine an ordinary write can transiently fail — in which
  // case nothing commits and the next hook re-examines the same window, which is this module's
  // documented safe failure. Asserting convergence pins that contract instead of assuming the first
  // attempt always wins; a cursor that never reaches 7 is still a failure.
  if (stateOf('conv-1').cursor !== 7) {
    await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  }
  assert.equal(stateOf('conv-1').cursor, 7, 'this window is reported, under its own ids');

  // What is left on disk is THIS window's own record, already committed and deleted. The orphan is
  // gone, and not because this module collected it: `pendingBatchFile` is keyed on the session id
  // alone, so a session that checkpoints again writes its own batch over the foreign one. That
  // still satisfies the rule that matters — not enqueued, not committed — but it means prune is
  // not always the collector the handoff assumes. Asserted rather than left as a surprise.
  assert.equal(pendingOf('conv-1'), null, 'the orphan was replaced by this window\'s own record');
});

test('a foreign batch on a session with nothing new is left for prune', async (t) => {
  const home = tmpHome(t);
  // No sidecar at all, so this checkpoint stages nothing and writes no record of its own — which
  // is the case where the orphan really does survive until the 14-day sweep.
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(path.join(home, 'events', 'conv-1.jsonl'), '');
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(path.join(pendingDir(), 'conv-1.json'), JSON.stringify({
    version: 1,
    sessionId: 'conv-1',
    createdAt: T0,
    account: 'beezi|tenant-9|someone@else.io',
    window: { from: 0, to: 900, byte: 0 },
    runs: null,
    items: [{ segmentId: 'conv-1:0-900', payload: { segmentId: 'conv-1:0-900', sessionId: 'conv-1' } }],
    next: { cursor: 900 },
  }));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  assert.deepEqual(queued(), [], 'the foreign items never reached the queue');
  assert.ok(pendingOf('conv-1'), 'and the record is still there');

  fs.utimesSync(path.join(pendingDir(), 'conv-1.json'), new Date(T0), new Date(T0));
  pruneStale(T0 + 15 * 24 * 3600 * 1000);
  assert.equal(pendingOf('conv-1'), null, 'prune collects it in the end');
});

test('a record from an unknown build is left alone rather than guessed at', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  fs.mkdirSync(pendingDir(), { recursive: true });
  for (const record of [
    { version: 2, sessionId: 'conv-1', account: null, items: [], next: { cursor: 900 } },
    { version: 1, sessionId: 'conv-other', account: null, items: [], next: { cursor: 900 } },
    { version: 1, sessionId: 'conv-1', account: null, items: 'nonsense', next: { cursor: 900 } },
    { version: 1, sessionId: 'conv-1', account: null, items: [], next: null },
    { version: 1, sessionId: 'conv-1', account: null, items: [], next: { cursor: 'soon' } },
  ]) {
    fs.rmSync(queueDir(), { recursive: true, force: true });
    fs.rmSync(stateDir(), { recursive: true, force: true });
    fs.writeFileSync(path.join(pendingDir(), 'conv-1.json'), JSON.stringify(record));

    await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

    assert.equal(stateOf('conv-1').cursor, 7, `cursor for ${JSON.stringify(record).slice(0, 40)}`);
  }
});

// ─── byte stability across a full read and a byte-resumed read ───────────────────────────────────

test('a full read and a byte-resumed read produce the same ids, bytes and run boundaries', async (t) => {
  // The unit half is pinned in test/attribution-cursor.test.mjs; this is the half that proves the
  // checkpoint seam preserved it. A frequent hook resumes from a byte offset while a turn-end
  // parses the whole file, and if those two disagreed about where a window starts the same activity
  // would be reported under two different segmentIds and billed twice.
  const home = tmpHome(t);

  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const wholeRead = queued();
  const wholeState = stateOf('conv-1');
  const wholeRuns = pendingOf('conv-1');
  assert.equal(wholeRuns, null, 'the record is deleted on a clean commit');

  fs.rmSync(queueDir(), { recursive: true, force: true });
  fs.rmSync(stateDir(), { recursive: true, force: true });
  writeSidecar(home, SESSION);

  // The frequent path first (no shared parse, so the delta records a byte offset), then a turn-end
  // that resumes from it.
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), {});
  const mid = stateOf('conv-1');
  assert.ok(mid.cursorBytes > 0, 'the resume offset really was recorded');
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const resumed = queued();

  assert.deepEqual(
    resumed.map((payload) => [payload.from_line, payload.to_line]).sort(),
    [...new Set(resumed.map((payload) => JSON.stringify([payload.from_line, payload.to_line])))]
      .map((value) => JSON.parse(value)).sort(),
    'no window is reported twice',
  );
  // The union of the resumed segments covers exactly the same lines as the single whole-read one,
  // and every segmentId is a function of that range and nothing else.
  assert.equal(stateOf('conv-1').cursor, wholeState.cursor);
  const wholeMain = wholeRead.find((payload) => !payload.is_subagent);
  const resumedLines = resumed
    .filter((payload) => !payload.is_subagent)
    .reduce((sum, payload) => sum + (payload.to_line - payload.from_line), 0);
  assert.equal(resumedLines, wholeMain.to_line - wholeMain.from_line);
  for (const payload of resumed) {
    assert.equal(payload.segmentId.startsWith('conv-1:'), true);
    assert.equal(payload.branch, wholeMain.branch, 'attribution is identical either way');
    assert.equal(payload.remote, wholeMain.remote);
  }
});

// ── the path with no durable queue at all ────────────────────────────────────────

test('a sink that refuses a SUBAGENT report does not commit its coverage either', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  // The twin of the case below, and the one that is easier to get wrong. `covered` is claimed during
  // the BUILD, immediately after each `stage()`, so by the time anything is emitted
  // `next.coveredIntervals` already holds every subagent's span. Committing it while one of those
  // reports was REFUSED marks seconds covered that nobody was told about — and coverage is
  // subtractive, so the next turn-end sees them claimed and bills them to no one, permanently.
  // Unlike a queue failure there is no pending record left behind to say what happened.
  const seen = [];
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps(),
    {
      emitTimeline: true,
      sink: (payload) => {
        if (payload.is_subagent === true) throw new Error('the sink refused the subagent report');
        seen.push(payload);
      },
    },
  );

  assert.equal(seen.length, 1, 'the main report still reached the sink');
  const state = stateOf('conv-1');
  assert.equal(state.cursor, 0, 'but the window was not consumed');
  assert.equal('coveredIntervals' in state, false, 'and the refused worker span is NOT covered');
  assert.equal('usageSnapshot' in state, false);
  assert.equal(state.anchor, null);
});

test('a sink that refuses the main report does not advance the cursor over it', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  // A sink means there is no queue to make atomic, so the batch does not apply — and that is
  // precisely where the cursor guard had to be restated. `mainEnqueued` used to mean "the main
  // payload was WRITTEN"; since C-10 stages every payload before any of it is durable, it means
  // "a main payload was BUILT", which is not the question the cursor needs answered.
  //
  // Every caller that supplies a sink today also supplies CheckpointMode.AUDIT, which means a fresh
  // state and no write-back at all — so this configuration is reachable only from a test. That is
  // exactly why it is pinned here: the safety of the live paths would otherwise rest on a coupling
  // between two options that nothing checks, and a future non-audit sink would silently advance the
  // cursor over a report its sink refused.
  const seen = [];
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps(),
    {
      emitTimeline: true,
      sink: (payload) => {
        if (payload.is_subagent === true) { seen.push(payload); return; }
        throw new Error('the sink refused the main report');
      },
    },
  );

  assert.equal(seen.length, 1, 'the subagent report still reached the sink');
  const state = stateOf('conv-1');
  assert.equal(state.cursor, 0, 'but the window was not consumed');
  assert.equal('coveredIntervals' in state, false, 'and nothing was marked covered');
  assert.equal('usageSnapshot' in state, false);
  assert.equal(state.anchor, null);
  assert.deepEqual(queued(), [], 'a sink run never touches the queue');
});
