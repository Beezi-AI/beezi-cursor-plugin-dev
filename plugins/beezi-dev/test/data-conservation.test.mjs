import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, CheckpointMode } from '../lib/checkpoint.mjs';
import { computeDelta } from '../lib/delta-cursor.mjs';
import { subtractIntervals, totalMs } from '../lib/active-time.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';
import { safeName } from '../lib/sidecar.mjs';

// M03.6 — the DATA lane as a CONSUMER of two things it does not own: the mid-turn pulse (M02.2) and
// the server coverage client (SYNC-03). There is deliberately no second implementation of either
// here; these are acceptance tests that say what the data side requires of them, driven through the
// real checkpoint, the real delta and the real state files.
//
// Both halves are about the same failure: a range that is reported twice is money charged twice,
// and a range that is skipped is money that vanishes. Neither shows up in any dashboard.

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// A whole session: a generation whose counts arrive at the turn end, tool and file work either side
// of a ten-minute subagent, and a stop.
const SESSION = [
  { ts: T0, ev: 'prompt' },
  { ts: T0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
  { ts: T0 + 2000, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 't1' },
  { ts: T0 + 3000, ev: 'edit', path: 'src/a.ts', added: 12, removed: 3, eid: 't2' },
  { ts: T0 + 4000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit the parser' },
  { ts: T0 + 604000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'audit the parser' },
  { ts: T0 + 605000, ev: 'tool', tool: 'grep', bytes: 80, ms: 4, eid: 't3' },
  { ts: T0 + 606000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 19570, token_output: 181, token_cache_read: 19152, token_cache_write: 3 },
  { ts: T0 + 606000, ev: 'stop' },
];

// Where the pulse falls: mid-turn, after the subagent has started and long before the stop.
const PULSE_AT = 6;

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-conserve-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeSidecar(home, events) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

function fakeGit(args) {
  if (args[0] === 'rev-parse') return '/repo';
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'branch') return 'main';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

const deps = () => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
});

function queued() {
  let names;
  try { names = fs.readdirSync(queueDir()); } catch { return []; }
  return names.map((name) => JSON.parse(fs.readFileSync(path.join(queueDir(), name), 'utf-8')));
}

function stateOf(id) {
  const file = path.join(stateDir(), `${safeName(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

// Everything a session is billed, summed across every segment it produced.
function totals(payloads) {
  const models = new Map();
  for (const payload of payloads) {
    for (const entry of payload.models) {
      const key = `${entry.model}\u001f${entry.billing_pool}`;
      const prior = models.get(key);
      const into = prior == null ? { requests: 0, cost_usd: 0 } : prior;
      into.requests += entry.requests;
      into.cost_usd += entry.cost_usd == null ? 0 : entry.cost_usd;
      models.set(key, into);
    }
  }
  return {
    segments: payloads.length,
    segmentIds: payloads.map((p) => p.segmentId).sort(),
    token_total: payloads.reduce((sum, p) => sum + p.token_total, 0),
    token_input: payloads.reduce((sum, p) => sum + p.token_input, 0),
    token_output: payloads.reduce((sum, p) => sum + p.token_output, 0),
    token_cache: payloads.reduce((sum, p) => sum + p.token_cache, 0),
    duration_sec: payloads.reduce((sum, p) => sum + p.duration_sec, 0),
    subagentSec: payloads.filter((p) => p.is_subagent).reduce((sum, p) => sum + p.duration_sec, 0),
    lines_added: payloads.reduce((sum, p) => sum + (p.code_changes == null ? 0 : p.code_changes.lines_added), 0),
    models: [...models.entries()].sort(),
  };
}

// ---------------------------------------------------------------------------
// DATA-07 — a mid-turn pulse followed by the turn end
// ---------------------------------------------------------------------------

test('a pulse plus the resumed turn-end reports every token and dollar exactly once', async (t) => {
  const home = tmpHome(t);

  // The pulse: the sidecar as it stands mid-turn, checkpointed without the turn-end path.
  writeSidecar(home, SESSION.slice(0, PULSE_AT));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), {});
  const pulseCursor = stateOf('conv-1').cursor;

  // The turn end: the rest of the stream is appended and the same conversation is checkpointed
  // again, this time on the path that derives subagents and the timeline.
  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const split = totals(queued());

  // No range is reported twice: the pulse consumed [0, PULSE_AT) and the resume starts exactly
  // there. This is the whole of the idempotency contract — a segmentId names a range of the log.
  assert.equal(pulseCursor, PULSE_AT);
  const main = queued().filter((p) => !p.is_subagent).sort((a, b) => a.from_line - b.from_line);
  assert.deepEqual(main.map((p) => [p.from_line, p.to_line]), [[0, PULSE_AT], [PULSE_AT, SESSION.length]]);
  assert.equal(new Set(split.segmentIds).size, split.segmentIds.length, 'no segmentId repeats');

  // The control: the same session, read once at the turn end, with no pulse in the middle.
  const control = await (async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-control-'));
    const prev = process.env.BEEZI_CURSOR_HOME;
    process.env.BEEZI_CURSOR_HOME = other;
    writeSidecar(other, SESSION);
    await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
    const result = totals(queued());
    process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(other, { recursive: true, force: true });
    return result;
  })();

  // Tokens, money and code changes conserve EXACTLY across the split. Tokens arrive on the turn-end
  // line, which is in the resume window; the pulse reported none and claimed none.
  assert.equal(split.token_total, control.token_total);
  assert.equal(split.token_input, control.token_input);
  assert.equal(split.token_output, control.token_output);
  assert.equal(split.token_cache, control.token_cache);
  assert.equal(split.lines_added, control.lines_added);
  const cost = (rows) => rows.reduce((sum, [, row]) => sum + row.cost_usd, 0);
  assert.equal(cost(split.models), cost(control.models));

  // The subagent's residual time is billed once and identically: the pulse claimed the parent's
  // active intervals, and the coverage it persisted is what stops the worker re-billing them.
  assert.equal(split.subagentSec, control.subagentSec);
  assert.equal(split.subagentSec, 600);
});

test('a generation straddling the pulse boundary is ONE request, in the delta and on the live path', async (t) => {
  // A generation writes many lines (one per tool call, one at the turn end) and each window collapses
  // only its own. Split the window and the same generation is counted twice — which inflates
  // `requests` and, through `covered = requests - usageData.amount`, the seat-covered bucket.
  //
  // The delta carries the identities across the boundary (`countedGenerations` in and out) and
  // `lib/checkpoint.mjs` now persists them on session state (C-3). Both halves are asserted here:
  // the delta computed directly, and the same two windows driven through the live checkpoint.
  const home = tmpHome(t);
  const readEvents = () => SESSION;

  const pulse = computeDelta('conv-1', 0, {
    readEvents: () => SESSION.slice(0, PULSE_AT),
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
  });
  const resume = computeDelta('conv-1', PULSE_AT, {
    readEvents,
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
    countedGenerations: pulse.countedGenerations,
  });
  const requests = [pulse, resume].reduce(
    (sum, d) => sum + d.entries.reduce((acc, e) => acc + e.requests, 0),
    0,
  );
  assert.equal(requests, 1, 'ONE generation, ONE request, across the split');
  // And its counts still travel: the turn-end line is in the resume window, on a zero-request row.
  assert.equal(resume.tokens.token_input, 19570);
  assert.equal(resume.entries.reduce((sum, e) => sum + e.token_input, 0), 19570);

  // The live path agrees, because `state.countedGenerations` is written on the pulse and handed
  // back to `computeDelta` on the resume. This assertion read 2 before C-3 and is the one that
  // proves the wiring: without the state field the pulse and the turn end each bill a request.
  writeSidecar(home, SESSION.slice(0, PULSE_AT));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), {});
  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const live = queued()
    .filter((p) => !p.is_subagent)
    .reduce((sum, p) => sum + p.models.reduce((acc, m) => acc + m.requests, 0), 0);
  assert.equal(live, 1, 'the carry persisted on session state makes it ONE request live too');
});

test('a pulse never bills more wall clock than the session had, and loses only its own boundary gap', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION.slice(0, PULSE_AT));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), {});
  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const split = totals(queued());

  // The pulse window holds lines 0..5: anchors at 0 s → 4 s of activity, then a 600 s gap to the
  // `subagent_stop` at 604 s that is past the idle threshold and bills nothing. The resume window
  // holds 605 s → 606 s, one second. The second BETWEEN them — 604 s to 605 s — is inside neither
  // window, so nobody bills it.
  //
  // That asymmetry is the property worth pinning: a split window can only ever bill LESS than the
  // whole, never more. Losing a boundary second is a rounding cost; billing one twice is a charge
  // the user did not incur.
  assert.equal(split.duration_sec - split.subagentSec, 4 + 1);
  assert.ok(split.duration_sec <= 606, 'never more than the session had');
});

// ---------------------------------------------------------------------------
// Late duplicates across a checkpoint boundary — Codex review, MAJOR
// ---------------------------------------------------------------------------
//
// On a dual-registry install both registries append their own copy of every event, and the reader
// collapses them (dedupeEvents) — but only WITHIN one window. When a checkpoint falls between the two
// copies, the late one lands in the next window still carrying the ORIGINAL timestamp, and as a
// timing anchor it stretched the new segment backwards over wall clock the previous checkpoint had
// already billed. Codex's repro: the first checkpoint reported 10,000 ms and the next 20,995 ms,
// where 1,000 ms was right.

// Checkpoint `windows` in order, appending each to the sidecar first, and return the MAIN payload
// each checkpoint queued (null for one that queued none).
// `extraDeps` is spread over the default deps — the CLI chat-store root for the enrichment repro.
async function checkpointWindows(home, windows, options = {}, extraDeps = {}) {
  const lines = [];
  const mains = [];
  for (const window of windows) {
    lines.push(...window);
    writeSidecar(home, lines);
    const before = new Set(queued().map((p) => p.segmentId));
    await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, { ...deps(), ...extraDeps }, options);
    const fresh = queued().filter((p) => !p.is_subagent && !before.has(p.segmentId));
    assert.ok(fresh.length <= 1, 'one main segment per checkpoint');
    mains.push(fresh.length === 0 ? null : fresh[0]);
  }
  return mains;
}

const LATE_DUPLICATE = [
  [
    { ts: T0, ev: 'prompt', eid: 'p1' },
    { ts: T0 + 5000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't1' },
    { ts: T0 + 10000, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't2' },
    { ts: T0 + 10000, ev: 'stop' },
  ],
  [
    // The other registry's copy of the first prompt, late, with the gate's original `ts`.
    { ts: T0, ev: 'prompt', eid: 'p1' },
    { ts: T0 + 19995, ev: 'prompt', eid: 'p2' },
    { ts: T0 + 20495, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't3' },
    { ts: T0 + 20995, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't4' },
    { ts: T0 + 20995, ev: 'stop' },
  ],
];

test('a late duplicate across a checkpoint boundary does not re-bill already-reported time (Codex repro)', async (t) => {
  const home = tmpHome(t);
  const [first, second] = await checkpointWindows(home, LATE_DUPLICATE);
  assert.equal(first.duration_sec, 10);
  // Was 21 — 20,995 ms, Codex's figure: the late copy anchored T0, so [T0, T0 + 20.995 s) read as
  // one active stretch — the ten seconds the first checkpoint had already billed, the ten-second
  // gap between the turns that neither window billed without the copy, and the one real second of
  // new work.
  assert.equal(second.duration_sec, 1);
  // The same figures to the millisecond, from the delta the checkpoint computed for that window
  // with the carry the first checkpoint left behind. The copy is dropped by IDENTITY — the first
  // window consumed a line with the same eid and the same content — not because its timestamp falls
  // inside covered wall clock: that rule also dropped genuinely new lines (the enrichment repro below).
  const all = [...LATE_DUPLICATE[0], ...LATE_DUPLICATE[1]];
  const window = (extra) => computeDelta('conv-1', LATE_DUPLICATE[0].length, {
    readEvents: () => all,
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
    ...extra,
  });
  assert.equal(window({}).duration_ms, 20995, 'the unfixed figure');
  // The carry the FIRST checkpoint left: the state file's current one also names window 2's own lines.
  const firstCarry = computeDelta('conv-1', 0, {
    readEvents: () => LATE_DUPLICATE[0].slice(),
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
  }).consumedEventKeys;
  const carried = window({ consumedEventKeys: firstCarry });
  assert.equal(carried.duration_ms, 1000, 'the fixed one');
  assert.equal(totalMs(subtractIntervals(carried.activeIntervals, [[T0, T0 + 10000]])), 1000, 'and coverage takes nothing off it');
  // The copy is gone from the window, so the envelope no longer reaches back to it either.
  assert.equal(second.started_at, new Date(T0 + 19995).toISOString());
  assert.equal(second.ended_at, new Date(T0 + 20995).toISOString());
  // And what it claimed is what it billed: the between-turn gap is not marked covered, so a
  // subagent that ran in it would still bill its own time.
  assert.deepEqual(stateOf('conv-1').coveredIntervals, [[T0, T0 + 10000], [T0 + 19995, T0 + 20995]]);
});

test('the same session without the late copy bills the same total — the duplicate adds nothing', async (t) => {
  const home = tmpHome(t);
  const withoutCopy = [LATE_DUPLICATE[0], LATE_DUPLICATE[1].slice(1)];
  const mains = await checkpointWindows(home, withoutCopy);
  assert.deepEqual(mains.map((p) => p.duration_sec), [10, 1]);
});

test('a normal multi-window session with no duplicates bills exactly what each window computes on its own', async (t) => {
  // The conservation half: coverage only subtracts what an EARLIER checkpoint billed, and a normal
  // session's windows never reach back into it — so every main segment must bill exactly the figure
  // its own delta computes with no coverage at all, which is what it billed before the fix.
  //
  // The second window's first line shares the MILLISECOND of the first window's last anchor (a pulse
  // that fell between two lines written in the same instant). Coverage is half-open, [start, end),
  // so that line is not "already billed" and still anchors the second window's first stretch.
  const home = tmpHome(t);
  const windows = [
    [
      { ts: T0, ev: 'prompt', eid: 'p1' },
      { ts: T0 + 3000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't1' },
      { ts: T0 + 8000, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't2' },
    ],
    [
      { ts: T0 + 8000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't3' },
      { ts: T0 + 12000, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't4' },
      { ts: T0 + 12000, ev: 'stop' },
    ],
    [
      // After an idle gap: a new turn.
      { ts: T0 + 900000, ev: 'prompt', eid: 'p2' },
      { ts: T0 + 902000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't5' },
      { ts: T0 + 907000, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't6' },
      { ts: T0 + 907000, ev: 'stop' },
    ],
  ];
  const mains = await checkpointWindows(home, windows);
  const expected = [];
  let from = 0;
  const all = [];
  for (const window of windows) {
    all.push(...window);
    const own = computeDelta('conv-1', from, {
      readEvents: () => all.slice(),
      readUsageData: () => ({}),
      aiCodeTrackingDbFile: null,
    });
    expected.push(own.duration_sec);
    from = all.length;
  }
  assert.deepEqual(expected, [8, 4, 7], 'the fixture is what this test says it is');
  assert.deepEqual(mains.map((p) => p.duration_sec), expected);
  assert.deepEqual(mains.map((p) => [p.started_at, p.ended_at]), [
    [new Date(T0).toISOString(), new Date(T0 + 8000).toISOString()],
    [new Date(T0 + 8000).toISOString(), new Date(T0 + 12000).toISOString()],
    [new Date(T0 + 900000).toISOString(), new Date(T0 + 907000).toISOString()],
  ]);
});

test('the audit replay starts fresh, so the late copy is collapsed in its one window and nothing moves', async (t) => {
  // The backfill parses the whole sidecar as ONE window with no coverage, where dedupeEvents already
  // collapses the two copies. Its figure is the whole session's, untouched by coverage.
  const home = tmpHome(t);
  writeSidecar(home, [...LATE_DUPLICATE[0], ...LATE_DUPLICATE[1]]);
  const reports = [];
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps(),
    { mode: CheckpointMode.AUDIT, sink: (payload) => reports.push(payload) },
  );
  const main = reports.filter((p) => !p.is_subagent);
  assert.equal(main.length, 1);
  const whole = computeDelta('conv-1', 0, {
    readEvents: () => [...LATE_DUPLICATE[0], ...LATE_DUPLICATE[1]],
    readUsageData: () => ({}),
    aiCodeTrackingDbFile: null,
  });
  assert.equal(main[0].duration_sec, whole.duration_sec);
  // The turn gap is under the idle threshold, so the one window bills all of it: [T0, T0 + 20.995 s).
  assert.equal(main[0].duration_sec, 21);
});

// ---------------------------------------------------------------------------
// Coverage legitimately reaching PAST the sidecar snapshot — Codex review, MAJOR
// ---------------------------------------------------------------------------
//
// The previous fix for the late duplicate above dropped every anchor whose timestamp fell inside
// already-covered wall clock, on the theory that such an anchor could only be a copy. Coverage is not
// bounded by what the sidecar held when a checkpoint snapshotted it, though: the CLI subagent
// enrichment (lib/cli-subagents-cursor.mjs) dates a worker's end from its chat store's last write,
// and the checkpoint claims the worker's residual into coverage. A genuinely NEW prompt that lands
// after the snapshot but before that claimed end was then thrown away as a "duplicate", and the gap
// it anchored went with it: 1 s billed where 15 s of uncovered work had happened.
//
// Driven through the real delta, the real enrichment (a real CLI chat store on disk) and the real
// billing, because the defect is the interaction of the three.

const nodeSqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
const CLI_KID = '11111111-2222-4333-8444-555555555555';

function writeCliStore(file, meta, blobs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new nodeSqlite.DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'));
  const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  (blobs == null ? [] : blobs).forEach((blob, i) => ins.run(`b${i}`, Buffer.from(JSON.stringify(blob), 'utf8')));
  db.close();
}

// The parent chat `conv-1` naming one CLI subagent that ran [startMs, endMs). The CLI records no end
// for a worker; listCliSubagents reads it off the child store's last write, so that is what is set.
function cliChats(t, startMs, endMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-conserve-chats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeCliStore(path.join(root, 'h', 'conv-1', 'store.db'), { name: 'New Agent', createdAt: startMs - 1000 }, [{
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'CallDynamicTool', result: `done\nAgent ID: ${CLI_KID}` }],
  }]);
  const kidDir = path.join(root, 'h', CLI_KID);
  writeCliStore(path.join(kidDir, 'store.db'), {
    name: 'New Agent',
    createdAt: startMs,
    subagentInfo: { parentAgentId: 'conv-1', rootParentAgentId: 'conv-1', toolCallId: 'toolu_1', typeName: 'generalPurpose' },
  });
  // A non-empty WAL would date the worker instead (lastWriteMs); the fixture must not have one.
  const wal = path.join(kidDir, 'store.db-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'the fixture store left a WAL behind');
  fs.utimesSync(path.join(kidDir, 'store.db'), new Date(endMs), new Date(endMs));
  return root;
}

const ENRICHED = [
  [
    { ts: T0, ev: 'prompt', eid: 'p1' },
    { ts: T0 + 1000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't1' },
    { ts: T0 + 5000, ev: 'tool', tool: 'grep', bytes: 10, ms: 1, eid: 't2' },
    { ts: T0 + 5000, ev: 'stop' },
  ],
  [
    // A unique prompt, written after the first checkpoint's snapshot and before the worker's
    // store-dated end at 6 s — inside coverage, and not a copy of anything.
    { ts: T0 + 5500, ev: 'prompt', eid: 'p2' },
    { ts: T0 + 20000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1, eid: 't3' },
    { ts: T0 + 21000, ev: 'stop' },
  ],
];

test('a new anchor inside coverage the enrichment extended past the snapshot still bills (Codex repro)', { skip: !nodeSqlite }, async (t) => {
  const home = tmpHome(t);
  const chatsDir = cliChats(t, T0 + 2000, T0 + 6000);
  const [first, second] = await checkpointWindows(home, ENRICHED, { emitTimeline: true }, { chatsDir });
  assert.equal(first.duration_sec, 5);
  // The enrichment really did extend coverage past the sidecar: the worker's residual [5 s, 6 s) was
  // billed on its own row and claimed.
  const subagent = queued().find((p) => p.is_subagent === true);
  assert.ok(subagent, 'the CLI worker was recovered from the chat store');
  assert.equal(subagent.duration_sec, 1);
  // Was 1: the prompt at 5.5 s sat inside [T0, T0 + 6 s) and was dropped as if it were a copy. The
  // window's work is [5.5 s, 21 s); the half second already covered is not billed again, the rest is.
  assert.equal(second.duration_sec, 15);
  assert.deepEqual(stateOf('conv-1').coveredIntervals, [[T0, T0 + 21000]]);
});

test('a session restored from state written before the carry existed checkpoints normally, and starts carrying', async (t) => {
  // An upgrade mid-conversation: the state file has a cursor, coverage and generations, and no
  // `consumedEventKeys`. Nothing can be proven a duplicate, so nothing is dropped; the window bills
  // what it always did, and the checkpoint leaves the carry behind for the next one.
  const home = tmpHome(t);
  writeSidecar(home, [...LATE_DUPLICATE[0], ...LATE_DUPLICATE[1].slice(1)]);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${safeName('conv-1')}.json`), JSON.stringify({
    cursor: LATE_DUPLICATE[0].length,
    coveredIntervals: [[T0, T0 + 10000]],
    countedGenerations: [],
  }));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps());
  const mains = queued().filter((p) => !p.is_subagent);
  assert.equal(mains.length, 1);
  assert.equal(mains[0].duration_sec, 1);
  const state = stateOf('conv-1');
  assert.equal(state.cursor, LATE_DUPLICATE[0].length + LATE_DUPLICATE[1].length - 1);
  assert.ok(Array.isArray(state.consumedEventKeys), 'the carry was not written');
  assert.equal(state.consumedEventKeys.length, 3, 'p2, t3 and t4 — the identified lines of the window');
});

// ---------------------------------------------------------------------------
// DATA-06 — server coverage, consumed. `null` is not an empty map.
// ---------------------------------------------------------------------------
//
// The client is SYNC-03's (`lib/session-coverage.mjs`, not in this lane) and the seam that feeds a
// start cursor into a replay is the integration owner's. What is frozen here is what the DATA side
// requires of both, exercised against the real checkpoint and the real per-session state:
//
//   fetchCoverage returns a Map only when EVERY batch answered validly. One bad batch, one
//   unreachable request, one unparseable id and the whole answer is `null` — "we do not know", which
//   is a different fact from an empty Map's "the server has nothing for these sessions".
//
// The consumer below is the specification, deliberately tiny, and the handoff carries it as the
// exact patch for the integration owner.
function replayWithCoverage(sessionId, coverage, liveCursor, run) {
  // Unknown coverage: do nothing at all. Not a full re-read (which re-reports everything the server
  // may already hold), not a skip-ahead (which loses everything it does not), and above all not an
  // advance of any cursor on the strength of an answer nobody gave.
  if (coverage === null) return { ran: false, reason: 'coverage-unavailable' };
  const covered = coverage.get(sessionId);
  // Absent from a VALID map means the server holds nothing for this session: start at the
  // beginning. Zero means the same thing explicitly, and both are answers.
  //
  // CLAMPED against the live cursor, always. Coverage describes what the SERVER holds; the live
  // cursor describes what this machine has already queued. A coverage answer below it is stale (or
  // narrower than the queue), and honouring it would re-report lines the live path already sent.
  const startLine = Math.max(covered === undefined ? 0 : covered, liveCursor);
  return { ran: true, startLine, result: run(startLine) };
}

function seedCursor(sessionId, line) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir(), `${safeName(sessionId)}.json`),
    JSON.stringify({ cursor: line, sentSessionName: null, anchor: null }),
  );
}

test('unknown coverage reports nothing and advances nothing — null is not an empty map', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  let checkpoints = 0;

  const decision = replayWithCoverage('conv-1', null, 0, (startLine) => {
    checkpoints += 1;
    seedCursor('conv-1', startLine);
    return startLine;
  });

  assert.deepEqual(decision, { ran: false, reason: 'coverage-unavailable' });
  assert.equal(checkpoints, 0, 'an unknown answer must not start a replay');
  assert.deepEqual(queued(), []);
  assert.equal(stateOf('conv-1'), null, 'and no cursor exists to have been advanced');
});

test('an empty coverage map is an answer: the session replays from the beginning', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  const decision = replayWithCoverage('conv-1', new Map(), 0, (startLine) => {
    seedCursor('conv-1', startLine);
    return startLine;
  });
  assert.equal(decision.ran, true);
  assert.equal(decision.startLine, 0);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const main = queued().find((p) => !p.is_subagent);
  assert.deepEqual([main.from_line, main.to_line], [0, SESSION.length]);
});

test('a covered prefix is half-open: coveredToLine N means the next segment starts at N', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  const decision = replayWithCoverage('conv-1', new Map([['conv-1', 6]]), 0, (startLine) => {
    seedCursor('conv-1', startLine);
    return startLine;
  });
  assert.equal(decision.startLine, 6);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const main = queued().find((p) => !p.is_subagent);
  // Line 6 is NOT re-reported: the server's prefix is [0, 6) and this segment is [6, 9).
  assert.deepEqual([main.from_line, main.to_line], [6, SESSION.length]);
  assert.equal(main.segmentId, 'conv-1:6-9');
});

test('after an unknown answer the next run still has the whole range to report', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);

  replayWithCoverage('conv-1', null, 0, () => { throw new Error('must not run'); });
  // …the server comes back, and now says it holds nothing for this session.
  replayWithCoverage('conv-1', new Map(), 0, (startLine) => seedCursor('conv-1', startLine));

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const main = queued().find((p) => !p.is_subagent);
  assert.deepEqual([main.from_line, main.to_line], [0, SESSION.length]);
  assert.equal(totals(queued()).token_total, 38906, 'nothing was consumed by the unknown answer');
});

test('coverage never moves a cursor backwards over work already reported', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, SESSION);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), { emitTimeline: true });
  const reported = stateOf('conv-1').cursor;
  assert.equal(reported, SESSION.length);

  // A stale or narrower coverage answer arrives afterwards. Replaying it from line 2 would re-report
  // every line the live path already queued, under the same segmentIds but a second time through the
  // flush. The clamp is what stops that, and it is asserted rather than described.
  const decision = replayWithCoverage('conv-1', new Map([['conv-1', 2]]), reported, (startLine) => startLine);
  assert.equal(decision.startLine, reported, 'a stale coverage start is clamped to the live cursor');
  assert.equal(decision.result, reported);
});
