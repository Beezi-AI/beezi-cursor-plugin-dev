import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, flushQueue } from '../lib/checkpoint.mjs';
import { queueDir, stateDir, timelineOutboxDir } from '../lib/paths-cursor.mjs';
import { sessionLockPath, withLock } from '../lib/lock.mjs';
import { OUTBOX_DRAIN_MAX, drainTimelineOutbox } from '../lib/timeline-outbox.mjs';

// Task 8, fix D. A Cursor CLI session gets one turn-end at most: `agent -p` fires exactly one
// sessionEnd and an interactive exit may fire none. The timeline POST used to be retried only by
// "the next turn-end of the same session", so for the CLI a single failed POST (network, a 401
// under another environment's token, API down, the hook killed at exit) lost the timeline for good
// and the portal showed missing lines and lanes (E11: 323cf93b and 4dea8842 never got a
// `sentTimelineSig`). The outbox keeps the body on disk until ANY later hook delivers it.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-timeline-outbox-'));
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
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'rev-parse') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

// Epoch-ms timestamps, as the sidecar writes them. A generation, two tools and a turn-end: enough
// for computeSessionTimeline to produce periods, so the POST site is actually reached.
const T0 = Date.parse('2026-09-23T10:00:00.000Z');
function writeSidecar(home, id = 'conv-1') {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  const events = [
    { ts: T0, ev: 'prompt' },
    { ts: T0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 10, token_output: 2 },
    { ts: T0 + 2000, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 't1' },
    { ts: T0 + 3000, ev: 'edit', path: 'src/a.ts', added: 3, removed: 1, eid: 'e1' },
    { ts: T0 + 4000, ev: 'session_end' },
  ];
  fs.writeFileSync(
    path.join(home, 'events', `${id}.jsonl`),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

const isTimeline = (url) => String(url).endsWith('/sessions/timeline');

// A fetch that answers the timeline route with `timelineStatus` (a number, or a function of the
// call) and every other route with 200, and records what reached the timeline route.
function stubFetch(timelineStatus, { onTimeline } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (isTimeline(url)) {
      const call = { url, body: JSON.parse(init.body), authorization: init.headers.Authorization };
      calls.push(call);
      if (onTimeline) onTimeline(call);
      const status = typeof timelineStatus === 'function' ? timelineStatus(call) : timelineStatus;
      if (status instanceof Error) throw status;
      return { status, json: async () => ({}) };
    }
    return { status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const deps = (over = {}) => ({ getAccessToken: async () => 'tok', gitImpl: fakeGit, ...over });

function outboxFiles() {
  try { return fs.readdirSync(timelineOutboxDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
}
function readEntry(name = 'conv-1') {
  return JSON.parse(fs.readFileSync(path.join(timelineOutboxDir(), `${name}.json`), 'utf-8'));
}
function stateOf(id = 'conv-1') {
  return JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));
}

// An outbox entry written straight to disk, in the documented shape, so the drain tests pin the
// on-disk contract rather than whatever the writer happens to produce. `ageMs` back-dates the
// mtime, which is the drain's oldest-first clock.
function seedEntry(id, { sig = `sig-${id}`, account = null, ageMs = 0, body } = {}) {
  fs.mkdirSync(timelineOutboxDir(), { recursive: true });
  const file = path.join(timelineOutboxDir(), `${id}.json`);
  const entry = {
    v: 1,
    sessionId: id,
    sig,
    body: body == null ? { sessionId: id, periods: [{ kind: 'active' }], subagents: [], plan_events: [] } : body,
    account,
    createdAt: Date.now() - ageMs,
  };
  fs.writeFileSync(file, JSON.stringify(entry));
  if (ageMs > 0) {
    const sec = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, sec, sec);
  }
  return entry;
}
function seedState(id, over = {}) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${id}.json`), JSON.stringify({ cursor: 5, sentSessionName: null, anchor: null, ...over }));
}

// ── the POST site

test('a 503 on the timeline POST leaves an outbox entry, no sig, and the status on state', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const down = stubFetch(503);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: down.fetchImpl }), { emitTimeline: true });

  assert.equal(down.calls.length, 1, 'the checkpoint POSTed once, and its own flush did not hammer the same 503');
  const entry = readEntry();
  assert.equal(entry.v, 1);
  assert.equal(entry.sessionId, 'conv-1');
  assert.equal(typeof entry.sig, 'string');
  assert.equal(entry.account, null, 'stamped with this machine\'s account key (none recorded yet)');
  assert.equal(typeof entry.createdAt, 'number');
  assert.deepEqual(entry.body, down.calls[0].body, 'the entry holds exactly the body that was attempted');
  const state = stateOf();
  assert.equal(state.sentTimelineSig, undefined, 'a failed send records no signature');
  assert.equal(state.timelineLastStatus, 503);

  // Any later hook (session start, another session's turn-end) drains it.
  const up = stubFetch(200);
  const flush = await flushQueue('tok', { fetchImpl: up.fetchImpl });

  assert.equal(up.calls.length, 1);
  assert.deepEqual(up.calls[0].body, entry.body, 'the exact stored body is what reaches the timeline route');
  assert.deepEqual(outboxFiles(), [], 'a delivered entry is removed');
  assert.equal(stateOf().sentTimelineSig, entry.sig, 'and the session learns it was sent');
  assert.equal(stateOf().timelineLastStatus, 200);
  assert.equal(flush.timelines.sent, 1);
});

test('the outbox entry is on disk BEFORE the POST leaves', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  // A hook killed mid-POST must still leave the body behind; this is only true if the write came
  // first. Checked from inside the request, at the moment it is made.
  const seen = [];
  const stub = stubFetch(200, { onTimeline: () => seen.push(outboxFiles()) });

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true });

  assert.deepEqual(seen, [['conv-1.json']]);
});

test('the IDE happy path: a 200 on the first try leaves no entry behind', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const stub = stubFetch(200);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true });

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(outboxFiles(), []);
  assert.equal(typeof stateOf().sentTimelineSig, 'string');
  assert.equal(stateOf().timelineLastStatus, 200);
});

test('an unchanged timeline writes no entry and sends nothing', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const stub = stubFetch(200);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true });
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true });

  assert.equal(stub.calls.length, 1, 'the signature still suppresses a duplicate upsert');
  assert.deepEqual(outboxFiles(), []);
});

test('a network failure records its reason and keeps the entry', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const stub = stubFetch(new Error('ECONNREFUSED'));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true });

  assert.deepEqual(outboxFiles(), ['conv-1.json']);
  assert.equal(stateOf().timelineLastStatus, 'network');
});

test('a spent budget still writes the entry — the sessionEnd that ran out of time is the CLI loss case', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const stub = stubFetch(200);
  // Every clock read costs a second, so a 1ms budget is gone long before the POST site.
  let clock = T0;
  const now = () => { clock += 1000; return clock; };

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: stub.fetchImpl, now }),
    { emitTimeline: true, budgetMs: 1 },
  );

  assert.equal(stub.calls.length, 0, 'no POST is started without budget');
  assert.deepEqual(outboxFiles(), ['conv-1.json'], 'but the body is kept for the next hook');
  assert.equal(stateOf().timelineLastStatus, 'no-budget');
});

test('a 401 at the POST site is retried in the same run with one forced refresh', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  // The token for another environment: the checkpoint's own POST cannot refresh, but the flush that
  // follows it in the same hook can, so a 401 is the one failure NOT skipped by that flush.
  const stub = stubFetch((call) => (call.authorization === 'Bearer fresh' ? 200 : 401));
  const auth = {
    getToken: async () => 'tok',
    forceRefresh: async () => ({ ok: true, token: 'fresh' }),
    authEpoch: () => 'epoch-1',
  };
  const result = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ fetchImpl: stub.fetchImpl, auth }),
    { emitTimeline: true },
  );

  assert.deepEqual(stub.calls.map((c) => c.authorization), ['Bearer tok', 'Bearer tok', 'Bearer fresh']);
  assert.equal(result.flush.timelines.sent, 1);
  assert.deepEqual(outboxFiles(), []);
  assert.equal(stateOf().sentTimelineSig, readSigFrom(stub.calls[2].body));
  assert.equal(stateOf().timelineLastStatus, 200);
});

// The signature the checkpoint derives, recomputed from a sent body — the same three fields in the
// same order as lib/checkpoint.mjs.
function readSigFrom(body) {
  return `${JSON.stringify(body.periods)}|${JSON.stringify(body.subagents)}|${JSON.stringify(body.plan_events)}`;
}

// ── the drain

const auth = (over = {}) => ({
  getToken: async () => 'tok',
  forceRefresh: async () => ({ ok: false, token: null }),
  authEpoch: () => 'epoch-1',
  ...over,
});

for (const status of [400, 413, 422]) {
  test(`the drain drops an entry the server answers ${status} — it can never succeed`, async (t) => {
    tmpHome(t);
    seedEntry('conv-1');
    const stub = stubFetch(status);
    const flush = await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(outboxFiles(), []);
    assert.equal(flush.timelines.dropped, 1);
  });
}

for (const status of [500, 503]) {
  test(`the drain keeps an entry the server answers ${status}`, async (t) => {
    tmpHome(t);
    seedEntry('conv-1');
    const stub = stubFetch(status);
    const flush = await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(outboxFiles(), ['conv-1.json']);
    assert.equal(flush.timelines.kept, 1);
  });
}

test('the drain keeps an entry on a network failure', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const stub = stubFetch(new Error('ECONNRESET'));
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(outboxFiles(), ['conv-1.json']);
});

test('a 401 in the drain renews once and re-sends the same body under the new token', async (t) => {
  tmpHome(t);
  const entry = seedEntry('conv-1');
  seedState('conv-1');
  let refreshes = 0;
  const stub = stubFetch((call) => (call.authorization === 'Bearer fresh' ? 200 : 401));
  const flush = await flushQueue('tok', {
    fetchImpl: stub.fetchImpl,
    auth: auth({ forceRefresh: async () => { refreshes += 1; return { ok: true, token: 'fresh' }; } }),
  });
  assert.equal(refreshes, 1);
  assert.deepEqual(stub.calls.map((c) => c.authorization), ['Bearer tok', 'Bearer fresh']);
  assert.deepEqual(stub.calls[1].body, entry.body);
  assert.deepEqual(outboxFiles(), []);
  assert.equal(stateOf().sentTimelineSig, entry.sig);
  assert.equal(flush.timelines.sent, 1);
});

test('a 401 whose refresh fails keeps the entry', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const stub = stubFetch(401);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(outboxFiles(), ['conv-1.json']);
});

test('an entry recorded under another account is never sent under this one, and is left in place', async (t) => {
  tmpHome(t);
  seedEntry('conv-1', { account: 'https://api.beezi.example|someone-else@example.com' });
  const stub = stubFetch(200);
  const flush = await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(outboxFiles(), ['conv-1.json'], 'prune collects it; the drain does not delete evidence');
  assert.equal(flush.timelines.foreign, 1);
});

test('a foreign entry does not use up the per-flush cap', async (t) => {
  tmpHome(t);
  // Oldest on disk, so it is examined first on every flush for as long as prune lets it live. If
  // it counted toward the cap, enough of them would starve every current entry.
  for (let i = 0; i < OUTBOX_DRAIN_MAX; i += 1) {
    seedEntry(`foreign-${i}`, { account: 'someone-else', ageMs: 60_000 * (10 + i) });
  }
  seedEntry('mine', { ageMs: 1000 });
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['mine']);
});

test('an expired deadline sends nothing and keeps every entry', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const stub = stubFetch(200);
  let clock = T0;
  const flush = await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth(), now: () => clock, deadline: clock - 1 });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(outboxFiles(), ['conv-1.json']);
  assert.equal(flush.timelines.deferred, 1);
});

test('the drain stops at the deadline mid-way, like the queue', async (t) => {
  tmpHome(t);
  seedEntry('a', { ageMs: 3000 });
  seedEntry('b', { ageMs: 2000 });
  seedEntry('c', { ageMs: 1000 });
  let clock = T0;
  const stub = stubFetch(() => { clock += 3000; return 200; });
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth(), now: () => clock, deadline: clock + 5000 });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['a', 'b'], 'two 3s requests fit a 5s budget');
  assert.deepEqual(outboxFiles(), ['c.json']);
});

test(`the drain sends at most ${OUTBOX_DRAIN_MAX} entries per flush, oldest first`, async (t) => {
  tmpHome(t);
  const ids = ['g', 'f', 'e', 'd', 'c', 'b', 'a'];
  // `a` is the oldest, `g` the newest; filenames are in reverse so name order cannot fake it.
  ids.forEach((id, index) => seedEntry(id, { ageMs: 1000 * (index + 1) }));
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(outboxFiles().sort(), ['f.json', 'g.json']);
});

test('a delivered entry whose session has no state file does not create one', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(outboxFiles(), []);
  assert.equal(fs.existsSync(path.join(stateDir(), 'conv-1.json')), false);
});

test('the drain updates the signature without clobbering the rest of the state', async (t) => {
  tmpHome(t);
  const entry = seedEntry('conv-1');
  seedState('conv-1', { cursor: 42, account: null, anchor: { model: 'm' } });
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  const state = stateOf();
  assert.equal(state.cursor, 42);
  assert.deepEqual(state.anchor, { model: 'm' });
  assert.equal(state.sentTimelineSig, entry.sig);
});

test('a session whose lock is held is skipped, not raced', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  fs.mkdirSync(stateDir(), { recursive: true });
  const stub = stubFetch(200);
  // A turn-end checkpoint of the same session is mid-flight: it may be about to write a NEWER
  // entry. Sending the older one now could land it on top, and deleting after could erase the newer.
  await withLock(sessionLockPath('conv-1'), async () => {
    await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(outboxFiles(), ['conv-1.json']);
});

test('a tenant with tracking off has its outbox held, not delivered', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth(), isTrackingAllowed: () => false });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(outboxFiles(), ['conv-1.json']);
});

test('an account change mid-drain stops it', async (t) => {
  tmpHome(t);
  seedEntry('a', { ageMs: 2000 });
  seedEntry('b', { ageMs: 1000 });
  let epoch = 'epoch-1';
  const stub = stubFetch(() => { epoch = 'epoch-2'; return 200; });
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth({ authEpoch: () => epoch }) });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['a']);
  assert.deepEqual(outboxFiles(), ['b.json']);
});

test('a malformed entry is left for prune and does not stop the drain', async (t) => {
  tmpHome(t);
  fs.mkdirSync(timelineOutboxDir(), { recursive: true });
  const bad = path.join(timelineOutboxDir(), 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const sec = (Date.now() - 5000) / 1000;
  fs.utimesSync(bad, sec, sec);
  seedEntry('conv-1');
  const stub = stubFetch(200);
  await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['conv-1']);
  assert.deepEqual(outboxFiles(), ['bad.json']);
});

test('delivering an old session\'s timeline does not make it the most recent conversation', async (t) => {
  tmpHome(t);
  // lib/active-conversation.mjs ranks conversations by state-file mtime to pick the one
  // `/beezi:track` saves. A session-start drain that lands yesterday's CLI timeline must not
  // promote yesterday's session over the one the user is in.
  seedEntry('conv-1');
  seedState('conv-1');
  const file = path.join(stateDir(), 'conv-1.json');
  const yesterday = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(file, yesterday, yesterday);
  const before = fs.statSync(file).mtimeMs;

  await flushQueue('tok', { fetchImpl: stubFetch(200).fetchImpl, auth: auth() });

  assert.equal(typeof stateOf().sentTimelineSig, 'string', 'the state really was written');
  assert.equal(Math.round(fs.statSync(file).mtimeMs / 1000), Math.round(before / 1000));
});

test('a transient failure stops the drain — one stalled server costs one request, not five', async (t) => {
  tmpHome(t);
  seedEntry('a', { ageMs: 3000 });
  seedEntry('b', { ageMs: 2000 });
  seedEntry('c', { ageMs: 1000 });
  seedState('a');
  const before = fs.statSync(path.join(stateDir(), 'a.json')).mtimeMs;
  const stub = stubFetch(503);
  const flush = await flushQueue('tok', { fetchImpl: stub.fetchImpl, auth: auth() });
  assert.deepEqual(stub.calls.map((c) => c.body.sessionId), ['a']);
  assert.deepEqual(outboxFiles().sort(), ['a.json', 'b.json', 'c.json']);
  assert.equal(flush.timelines.kept, 1);
  assert.equal(flush.timelines.deferred, 2);
  // A kept entry repeats on every hook while the server is down; it must not rewrite state each time.
  assert.equal(fs.statSync(path.join(stateDir(), 'a.json')).mtimeMs, before);
  assert.equal(stateOf('a').timelineLastStatus, undefined);
});

// ── review fixes (Codex, DO NOT SHIP): one auth snapshot, lane-safe partial timelines, a bounded listing

// A report sitting in the queue, so the report stage really sends something and the login switch
// below has a request to ride on. The shape lib/queue-delivery.mjs accepts (test/flush-budget.test.mjs).
function seedReport() {
  fs.mkdirSync(queueDir(), { recursive: true });
  fs.writeFileSync(path.join(queueDir(), 'seg-0.json'), JSON.stringify({ segmentId: 's:0' }));
}

// Answers every route 200, records the timeline calls, and runs `onReport` inside the report POST:
// the moment a login switch lands between report delivery and the timeline drain.
function switchingFetch(onReport) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (isTimeline(url)) {
      calls.push({ body: JSON.parse(init.body), authorization: init.headers.Authorization });
    } else {
      onReport();
    }
    return { status: 200, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('a login switch during report delivery never sends the new account\'s timelines under the old token', async (t) => {
  tmpHome(t);
  seedReport();
  // Codex's exact reproduction: `b-session` belongs to account B. Before the fix the drain took its
  // fence and account AFTER report delivery, so both said "B" while the token was still A's, and
  // b-session went out as `Bearer token-A` and was deleted.
  seedEntry('a-session', { account: 'account-A', ageMs: 2000 });
  seedEntry('b-session', { account: 'account-B', ageMs: 1000 });
  let epoch = 'epoch-A';
  let account = 'account-A';
  const stub = switchingFetch(() => { epoch = 'epoch-B'; account = 'account-B'; });

  const flush = await flushQueue('token-A', {
    fetchImpl: stub.fetchImpl,
    auth: auth({ getToken: async () => 'token-A', authEpoch: () => epoch }),
    currentAccountKey: () => account,
  });

  assert.equal(flush.flushed, 1, 'the report stage really ran, and the switch happened inside it');
  assert.deepEqual(stub.calls, [], 'no timeline leaves under token A once the login is B\'s');
  assert.deepEqual(outboxFiles().sort(), ['a-session.json', 'b-session.json'], 'both entries are kept');
});

test('an account change with the SAME epoch still stops the drain', async (t) => {
  tmpHome(t);
  seedReport();
  // The account-vs-snapshot check is its own branch: an epoch that does not move (a cache written
  // without a bump) must not let B's entry through under A's token either.
  seedEntry('b-session', { account: 'account-B' });
  let account = 'account-A';
  const stub = switchingFetch(() => { account = 'account-B'; });

  await flushQueue('token-A', {
    fetchImpl: stub.fetchImpl,
    auth: auth({ getToken: async () => 'token-A', authEpoch: () => 'epoch-1' }),
    currentAccountKey: () => account,
  });

  assert.deepEqual(stub.calls, []);
  assert.deepEqual(outboxFiles(), ['b-session.json']);
});

test('a login switch DURING the checkpoint never sends the new account\'s timelines under the token it started with', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  // The same leak with a wider window: the hook path hands flushQueue the token runCheckpoint
  // resolved at its very start, so a snapshot of the epoch taken only at flushQueue would pair
  // B's epoch with A's token. The switch lands inside the checkpoint's own timeline POST.
  seedEntry('b-session', { account: null });
  let epoch = 'epoch-A';
  const stub = stubFetch(200, { onTimeline: (call) => { if (call.body.sessionId === 'conv-1') epoch = 'epoch-B'; } });

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({
      fetchImpl: stub.fetchImpl,
      getAccessToken: async () => 'token-A',
      auth: { getToken: async () => 'token-A', forceRefresh: async () => ({ ok: false, token: null }), authEpoch: () => epoch },
    }),
    { emitTimeline: true },
  );

  assert.deepEqual(stub.calls.filter((c) => c.body.sessionId === 'b-session').map((c) => c.authorization), []);
  assert.deepEqual(outboxFiles(), ['b-session.json']);
});

test('with no login switch the snapshot account still delivers its own entries', async (t) => {
  tmpHome(t);
  seedReport();
  seedEntry('a-session', { account: 'account-A' });
  const stub = switchingFetch(() => {});
  await flushQueue('token-A', {
    fetchImpl: stub.fetchImpl,
    auth: auth({ getToken: async () => 'token-A' }),
    currentAccountKey: () => 'account-A',
  });
  assert.deepEqual(stub.calls.map((c) => [c.body.sessionId, c.authorization]), [['a-session', 'Bearer token-A']]);
});

// One subagent lane, in the shape computeSessionTimeline emits, for an entry that already holds a
// complete timeline.
const ONE_LANE_BODY = {
  sessionId: 'conv-1',
  periods: [{ kind: 'active' }],
  subagents: [{ agent_id: 'kid-1', agent_type: 'explore', started_at: 'x', ended_at: 'y' }],
  plan_events: [],
};

test('an exhausted checkpoint does not overwrite a queued timeline with a lane-less one', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  // Codex's reproduction through runCheckpoint: an expired deadline makes the CLI enrichment return
  // no children, and the incomplete timeline used to overwrite this one-lane entry with zero lanes,
  // which a later drain then sent. `budgetMs: -1` is an expired deadline on the wall clock the
  // chat-store reader checks.
  seedEntry('conv-1', { sig: 'sig-one-lane', body: ONE_LANE_BODY });
  const stub = stubFetch(200);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true, budgetMs: -1 });

  assert.equal(stub.calls.length, 0, 'an incomplete timeline is never POSTed');
  const kept = readEntry();
  assert.equal(kept.sig, 'sig-one-lane', 'the stored body is kept, never replaced by a lane-less one');
  assert.equal(kept.body.subagents.length, 1);
  // …but it is now older than the session, so the drain must rebuild before sending it rather than
  // deliver a body that stops short of the session's end (Codex re-review).
  assert.equal(kept.partial, true);
});

test('an exhausted checkpoint with no entry writes one flagged partial', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  const stub = stubFetch(200);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stub.fetchImpl }), { emitTimeline: true, budgetMs: -1 });
  assert.equal(stub.calls.length, 0);
  assert.equal(readEntry().partial, true);
  assert.equal(stateOf().sentTimelineSig, undefined, 'nothing incomplete is ever recorded as sent');
});

// A worker the chat store would have reported, had the checkpoint had the time to ask.
const KID = { agentId: 'kid-1', typeName: 'explore', toolCallId: 'toolu_9', startMs: T0 + 1500, endMs: T0 + 2500 };

test('the drain rebuilds a partial entry and sends the complete timeline', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stubFetch(200).fetchImpl }), { emitTimeline: true, budgetMs: -1 });
  const partial = readEntry();
  assert.equal(partial.partial, true);
  assert.equal(partial.body.subagents.length, 0, 'the lane the expired checkpoint could not see');

  const stub = stubFetch(200);
  const result = await drainTimelineOutbox({
    auth: auth(),
    deps: { fetchImpl: stub.fetchImpl, listCliSubagents: () => [KID] },
  });

  assert.equal(result.sent, 1);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].body.subagents.map((s) => s.agent_id), ['kid-1'], 'the rebuilt body, with its lane');
  assert.deepEqual(outboxFiles(), []);
  assert.equal(stateOf().sentTimelineSig, readSigFrom(stub.calls[0].body), 'the signature of what was SENT, not of the partial body');
});

test('a partial entry whose rebuild runs out of time is kept, not sent', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ fetchImpl: stubFetch(200).fetchImpl }), { emitTimeline: true, budgetMs: -1 });
  const before = readEntry();
  assert.equal(before.partial, true);

  let clock = T0;
  const stub = stubFetch(200);
  const result = await drainTimelineOutbox({
    auth: auth(),
    deadlineAt: clock + 10_000,
    // The deadline passes while the chat store is being listed: the enrichment is cut short.
    deps: { fetchImpl: stub.fetchImpl, now: () => clock, listCliSubagents: () => { clock += 20_000; return []; } },
  });

  assert.equal(stub.calls.length, 0);
  assert.equal(result.sent, 0);
  assert.deepEqual(readEntry(), before, 'the partial entry is left exactly as it was');
});

// ── the listing honours the deadline

// Counts the stats the drain makes inside the outbox directory, and can pretend that directory holds
// `fakeNames` (so a 10,000-entry listing costs no disk). Other fs traffic passes through untouched.
function countOutboxFs(t, fakeNames = null) {
  const counts = { stats: 0, readdirs: 0 };
  const dir = path.resolve(timelineOutboxDir());
  const realStat = fs.statSync;
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'statSync', function (p, ...rest) {
    if (path.dirname(path.resolve(String(p))) === dir) counts.stats += 1;
    return realStat.call(fs, p, ...rest);
  });
  t.mock.method(fs, 'readdirSync', function (p, ...rest) {
    if (path.resolve(String(p)) === dir) {
      counts.readdirs += 1;
      if (fakeNames !== null) return fakeNames.slice();
    }
    return realReaddir.call(fs, p, ...rest);
  });
  return counts;
}

test('an expired deadline stats no outbox entry at all', async (t) => {
  tmpHome(t);
  seedEntry('conv-1');
  const counts = countOutboxFs(t);
  const clock = T0;
  const result = await drainTimelineOutbox({ auth: auth(), deadlineAt: clock - 1, deps: { now: () => clock, fetchImpl: stubFetch(200).fetchImpl } });
  assert.equal(counts.stats, 0, 'no stat is spent once the budget is gone');
  assert.equal(result.deferred, 1, 'the entry is still counted as waiting');
});

test('a 10,000-entry outbox costs a bounded number of stats', async (t) => {
  tmpHome(t);
  fs.mkdirSync(timelineOutboxDir(), { recursive: true });
  const names = [];
  for (let i = 0; i < 10_000; i += 1) names.push(`s-${i}.json`);
  const counts = countOutboxFs(t, names);
  await drainTimelineOutbox({ auth: auth(), deadlineAt: Date.now() + 60_000, deps: { fetchImpl: stubFetch(200).fetchImpl } });
  assert.equal(counts.readdirs, 1, 'one directory read');
  assert.ok(counts.stats > 0, 'the listing really went through the counted fs');
  assert.ok(counts.stats <= 50, `at most the listing bound's worth of stats, got ${counts.stats}`);
});
