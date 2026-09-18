import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PULSE_INTERVAL_MS,
  PULSE_MIN_BUDGET_MS,
  PULSE_RETRY_MS,
  maybeRunPulse,
  pulseClaimPath,
  pulseStateFile,
} from '../lib/pulse-cursor.mjs';
import { appendEvent } from '../lib/sidecar.mjs';
import { sessionLockPath } from '../lib/lock.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-cursor.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';

// The mid-turn pulse: a long non-git turn reporting before it ends.
//
// `postToolUse` is the only event a long turn produces, and until now it only appended to the
// sidecar — so an abandoned or hours-long turn held every one of its segments unreported until the
// session ended. The pulse is the cheapest possible gate on that hot path: a stat and a small read
// on the calls that are not due, and at most one checkpoint per fifteen minutes on the one that is.
//
// The property that has to survive is conservation. The pulse advances the SAME cursor the stop hook
// advances, so a turn that pulsed and then stopped must report the same billable work as the same
// turn that only stopped — no line counted twice, and no line skipped because the cursor ran ahead
// of what was actually queued.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-pulse-'));
  const prevHome = process.env.BEEZI_CURSOR_HOME;
  const prevCursor = process.env.CURSOR_CONFIG_DIR;
  process.env.BEEZI_CURSOR_HOME = dir;
  process.env.CURSOR_CONFIG_DIR = path.join(dir, 'cursor');
  t.after(() => {
    if (prevHome === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prevHome;
    if (prevCursor === undefined) delete process.env.CURSOR_CONFIG_DIR;
    else process.env.CURSOR_CONFIG_DIR = prevCursor;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const INPUT = Object.freeze({ session_id: 'conv-pulse', transcript_path: null, cwd: '/repo' });

// A checkpoint that records the window it was asked to cover and nothing else.
function recordingCheckpoint(behaviour = {}) {
  const calls = [];
  const run = async (input, deps, options) => {
    calls.push({ session: input.session_id, options });
    if (behaviour.throws) throw new Error('checkpoint failed');
    return { enqueued: 1, flush: null };
  };
  return { calls, run };
}

const BUDGET = 7500;

test('the first event of a session establishes a baseline instead of checkpointing', async (t) => {
  tmpHome(t);
  const cp = recordingCheckpoint();
  const res = await maybeRunPulse(INPUT, { now: () => 1000, runCheckpoint: cp.run }, BUDGET);
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'baseline');
  assert.deepEqual(cp.calls, [], 'sessionStart has just run; there is nothing yet to report');
  assert.ok(fs.existsSync(pulseStateFile('conv-pulse')), 'the baseline is persisted');
});

test('an event inside the interval is a no-op', async (t) => {
  tmpHome(t);
  const cp = recordingCheckpoint();
  await maybeRunPulse(INPUT, { now: () => 1000, runCheckpoint: cp.run }, BUDGET);
  const res = await maybeRunPulse(INPUT, { now: () => 1000 + PULSE_INTERVAL_MS - 1, runCheckpoint: cp.run }, BUDGET);
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'not-due');
  assert.deepEqual(cp.calls, []);
});

test('an event past the interval checkpoints exactly once, then rearms', async (t) => {
  tmpHome(t);
  const cp = recordingCheckpoint();
  let clock = 1000;
  const deps = { now: () => clock, runCheckpoint: cp.run };
  await maybeRunPulse(INPUT, deps, BUDGET);

  clock = 1000 + PULSE_INTERVAL_MS;
  const due = await maybeRunPulse(INPUT, deps, BUDGET);
  assert.equal(due.ran, true);
  assert.equal(due.ok, true);
  assert.equal(cp.calls.length, 1);
  assert.equal(cp.calls[0].session, 'conv-pulse');
  // The whole-session timeline rides on the pulse for the same reason it rides on `stop`: a turn
  // that is reported mid-flight must not leave the timeline describing only the part before it.
  assert.equal(cp.calls[0].options.emitTimeline, true);
  // The REMAINING hook budget, not a fresh one. The append that preceded this call has already been
  // paid for out of the same deadline.
  assert.equal(cp.calls[0].options.budgetMs, BUDGET);

  // The very next event is not due again.
  clock += 1;
  assert.equal((await maybeRunPulse(INPUT, deps, BUDGET)).reason, 'not-due');
  assert.equal(cp.calls.length, 1);
});

test('a failed checkpoint retries in a minute, not in another quarter hour', async (t) => {
  // The point of the short retry: a transient failure must not buy a full reporting interval of
  // silence. A failure that persists still costs at most one checkpoint attempt a minute.
  tmpHome(t);
  const failing = recordingCheckpoint({ throws: true });
  let clock = 1000;
  const deps = { now: () => clock, runCheckpoint: failing.run };
  await maybeRunPulse(INPUT, deps, BUDGET);

  clock += PULSE_INTERVAL_MS;
  const failed = await maybeRunPulse(INPUT, deps, BUDGET);
  assert.equal(failed.ran, true);
  assert.equal(failed.ok, false);

  clock += PULSE_RETRY_MS - 1;
  assert.equal((await maybeRunPulse(INPUT, deps, BUDGET)).reason, 'not-due');

  clock += 1;
  const ok = recordingCheckpoint();
  const retried = await maybeRunPulse(INPUT, { now: () => clock, runCheckpoint: ok.run }, BUDGET);
  assert.equal(retried.ran, true);
  assert.equal(retried.ok, true);
});

test('a concurrent hook that loses the claim does not checkpoint and does not rearm', async (t) => {
  // Two hook PROCESSES can be inside the same due window — Cursor runs both registries, and tool
  // calls overlap. The loser must not run a second checkpoint over the same lines, and must not
  // stamp the interval either: the winner is covering this window right now, and if it fails the
  // loser's next event should still find the pulse due.
  tmpHome(t);
  const cp = recordingCheckpoint();
  let clock = 1000;
  const deps = { now: () => clock, runCheckpoint: cp.run };
  await maybeRunPulse(INPUT, deps, BUDGET);
  clock += PULSE_INTERVAL_MS;

  // The winner's claim, taken and held.
  fs.mkdirSync(path.dirname(pulseClaimPath('conv-pulse')), { recursive: true });
  fs.mkdirSync(pulseClaimPath('conv-pulse'));

  const lost = await maybeRunPulse(INPUT, deps, BUDGET);
  assert.equal(lost.ran, false);
  assert.equal(lost.reason, 'contended');
  assert.deepEqual(cp.calls, []);

  fs.rmSync(pulseClaimPath('conv-pulse'), { recursive: true, force: true });
  const after = await maybeRunPulse(INPUT, deps, BUDGET);
  assert.equal(after.ran, true, 'the window is still due once the claim clears');
});

test('the claim is released even when the checkpoint throws', async (t) => {
  tmpHome(t);
  let clock = 1000;
  const failing = recordingCheckpoint({ throws: true });
  await maybeRunPulse(INPUT, { now: () => clock, runCheckpoint: failing.run }, BUDGET);
  clock += PULSE_INTERVAL_MS;
  await maybeRunPulse(INPUT, { now: () => clock, runCheckpoint: failing.run }, BUDGET);
  assert.equal(fs.existsSync(pulseClaimPath('conv-pulse')), false);
});

test('the pulse claim is not the checkpoint lock, so nothing is ever nested', async (t) => {
  // `runCheckpoint` takes the session lock itself. Acquiring that same lock here would deadlock the
  // hook against its own checkpoint — the reason the claim is a separate, cheaper file.
  tmpHome(t);
  assert.notEqual(pulseClaimPath('conv-pulse'), sessionLockPath('conv-pulse'));

  // Empirically, with the real engine: the checkpoint must be able to take its lock while the pulse
  // holds the claim.
  let clock = 1000;
  let locked = null;
  const deps = {
    now: () => clock,
    runCheckpoint: async () => {
      locked = fs.existsSync(pulseClaimPath('conv-pulse'));
      // The session lock is free while the claim is held.
      fs.mkdirSync(sessionLockPath('conv-pulse'));
      fs.rmSync(sessionLockPath('conv-pulse'), { recursive: true, force: true });
      return { enqueued: 0, flush: null };
    },
  };
  await maybeRunPulse(INPUT, deps, BUDGET);
  clock += PULSE_INTERVAL_MS;
  await maybeRunPulse(INPUT, deps, BUDGET);
  assert.equal(locked, true);
});

test('a session id that cannot be made into a filename is skipped, not guessed at', async (t) => {
  // safeName sanitizes what it can and answers null only when nothing usable is left. An id with no
  // filename has no sidecar and no state file either, so there is nothing to pulse over — and
  // deriving a path from it anyway is how this plugin once wrote outside its own data root.
  tmpHome(t);
  const cp = recordingCheckpoint();
  const res = await maybeRunPulse(
    { session_id: '', cwd: '/repo' },
    { now: () => 1000, runCheckpoint: cp.run },
    BUDGET,
  );
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'no-session');
  assert.deepEqual(cp.calls, []);
});

test('a due pulse with no budget left is declined rather than started and killed', async (t) => {
  tmpHome(t);
  const cp = recordingCheckpoint();
  let clock = 1000;
  const deps = { now: () => clock, runCheckpoint: cp.run };
  await maybeRunPulse(INPUT, deps, BUDGET);
  clock += PULSE_INTERVAL_MS;
  const res = await maybeRunPulse(INPUT, deps, PULSE_MIN_BUDGET_MS - 1);
  assert.equal(res.ran, false);
  assert.equal(res.reason, 'no-budget');
  assert.deepEqual(cp.calls, [], 'a checkpoint the host will kill mid-write is worse than none');
  // And the window stays due, so the next event with a real budget still reports.
  assert.equal((await maybeRunPulse(INPUT, deps, BUDGET)).ran, true);
});

test('a corrupt pulse state re-baselines rather than pulsing on every event', async (t) => {
  tmpHome(t);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(pulseStateFile('conv-pulse'), 'not json', 'utf-8');
  const cp = recordingCheckpoint();
  const res = await maybeRunPulse(INPUT, { now: () => 1000, runCheckpoint: cp.run }, BUDGET);
  assert.equal(res.reason, 'baseline');
  assert.deepEqual(cp.calls, []);
});

test('a clock that jumped backwards re-baselines instead of arming forever', async (t) => {
  tmpHome(t);
  const cp = recordingCheckpoint();
  await maybeRunPulse(INPUT, { now: () => 5_000_000, runCheckpoint: cp.run }, BUDGET);
  const res = await maybeRunPulse(INPUT, { now: () => 1000, runCheckpoint: cp.run }, BUDGET);
  assert.equal(res.ran, false);
  assert.deepEqual(cp.calls, []);
});

test('the not-due path is one read, no write and no checkpoint module', async (t) => {
  // The hot-path measurement, counted rather than timed: this runs on EVERY tool call, and what it
  // must not do is touch the disk more than once or reach for the ~25-module reporting engine. No
  // `runCheckpoint` is injected, so a call that decided it was due would try the real dynamic
  // import and be caught by the assertions below.
  tmpHome(t);
  await maybeRunPulse(INPUT, { now: () => 1000, runCheckpoint: () => { throw new Error('unreachable'); } }, BUDGET);

  const stamp = JSON.parse(fs.readFileSync(pulseStateFile('conv-pulse'), 'utf-8'));
  let reads = 0;
  let writes = 0;
  const counting = {
    now: () => 2000,
    readJsonImpl: () => { reads += 1; return stamp; },
    writeJsonImpl: () => { writes += 1; },
  };
  const res = await maybeRunPulse(INPUT, counting, BUDGET);
  assert.equal(res.reason, 'not-due');
  assert.equal(reads, 1, 'one small read is the whole cost of a tool call that is not due');
  assert.equal(writes, 0, 'and it writes nothing at all');

  // With the disk taken out of the picture, the decision itself is arithmetic. Deliberately loose:
  // the suite runs many processes at once, so this is a guard against an accidental import or a
  // whole-sidecar parse creeping in, not a benchmark.
  const started = process.hrtime.bigint();
  for (let i = 0; i < 500; i += 1) await maybeRunPulse(INPUT, counting, BUDGET);
  const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 500;
  assert.ok(perCallMs < 2, `not-due pulse cost ${perCallMs.toFixed(3)}ms per tool call`);
});

// ── conservation ─────────────────────────────────────────────────────────────────────────────────

// The real delta engine, with only the two host DATABASES stubbed out — Cursor's `state.vscdb` and
// `ai-code-tracking.db` belong to an installed IDE and have nothing to do with cursor arithmetic.
// Everything conservation depends on (the raw-line window, the duplicate collapse, the operation
// counts) is the shipping code.
function hermeticDeps(over = {}) {
  return {
    getAccessToken: async () => 'tok',
    gitImpl: (args) => {
      if (args[0] === 'remote') return 'https://example.com/acme/app.git';
      if (args[0] === 'rev-parse') return 'main';
      if (args[0] === 'reflog') return '';
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    fetchImpl: async () => { throw new Error('network disabled in test'); },
    computeDelta: (id, cursor, options) =>
      realComputeDelta(id, cursor, { ...options, readUsageData: () => null, aiCodeTrackingDbFile: null }),
    ...over,
  };
}

function queuedPayloads() {
  let files;
  try { files = fs.readdirSync(queueDir()); } catch { return []; }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));
}

// What a session BILLED, summed across however many segments it was cut into.
function billable(payloads) {
  const total = { est_tokens: 0, requests: 0, cost_usd: 0, operations: {}, files_changed: 0 };
  for (const p of payloads) {
    total.est_tokens += p.est_tokens == null ? 0 : p.est_tokens;
    for (const m of p.models == null ? [] : p.models) {
      total.requests += m.requests == null ? 0 : m.requests;
      total.cost_usd += m.cost_usd == null ? 0 : m.cost_usd;
    }
    for (const [kind, op] of Object.entries(p.operations == null ? {} : p.operations)) {
      total.operations[kind] = (total.operations[kind] == null ? 0 : total.operations[kind]) + op.count;
    }
    if (p.code_changes != null) total.files_changed += p.code_changes.files_changed;
  }
  return total;
}

const TURN = [
  { ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
  { ev: 'tool', tool: 'read_file', bytes: 400, ms: 5, eid: 't1' },
  { ev: 'tool', tool: 'edit_file', bytes: 900, ms: 9, eid: 't2' },
  { ev: 'shell', cmd: 'npm test', ms: 40 },
  { ev: 'tool', tool: 'grep', bytes: 120, ms: 3, eid: 't3' },
  { ev: 'tool', tool: 'read_file', bytes: 700, ms: 4, eid: 't4' },
];

async function playSession(t, { pulseAfter }) {
  tmpHome(t);
  const cp = [];
  let clock = 1_700_000_000_000;
  const deps = {
    now: () => clock,
    runCheckpoint: async (input, _d, options) => {
      cp.push(options);
      return runCheckpoint(input, hermeticDeps(), options);
    },
  };
  // The baseline, as `sessionStart` would leave it.
  await maybeRunPulse(INPUT, deps, BUDGET);

  for (let i = 0; i < TURN.length; i += 1) {
    clock += 1000;
    appendEvent(INPUT.session_id, TURN[i]);
    if (pulseAfter != null && i === pulseAfter) clock += PULSE_INTERVAL_MS;
    await maybeRunPulse(INPUT, deps, BUDGET);
  }

  // The turn ends exactly as scripts/stop.mjs ends it.
  clock += 1000;
  appendEvent(INPUT.session_id, { ev: 'stop' });
  await runCheckpoint(INPUT, hermeticDeps(), { emitTimeline: true, budgetMs: BUDGET });

  return { pulses: cp.length, totals: billable(queuedPayloads()), payloads: queuedPayloads() };
}

test('a turn that pulsed mid-flight bills exactly what the same turn without a pulse bills', async (t) => {
  const reference = await playSession(t, { pulseAfter: null });
  assert.equal(reference.pulses, 0, 'the reference turn is never due');

  const interrupted = await playSession(t, { pulseAfter: 2 });
  assert.equal(interrupted.pulses, 1, 'exactly one mid-turn checkpoint');
  assert.ok(interrupted.payloads.length > reference.payloads.length, 'and it really did report early');

  assert.deepEqual(interrupted.totals, reference.totals);
});

test('the pulse never advances the cursor past work that was not queued', async (t) => {
  // The other half of conservation: a segment whose lines are covered by the cursor but whose
  // payload never reached the queue is silent, permanent data loss.
  const { payloads } = await playSession(t, { pulseAfter: 2 });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir(), 'conv-pulse.json'), 'utf-8'));
  const ranges = payloads
    .map((p) => {
      const at = p.segmentId.lastIndexOf(':');
      const [from, to] = p.segmentId.slice(at + 1).split('-').map(Number);
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);

  assert.equal(ranges[0].from, 0, 'the first segment starts at the first raw line');
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i].from, ranges[i - 1].to, 'segments are contiguous — no line skipped or doubled');
  }
  assert.equal(state.cursor, ranges[ranges.length - 1].to, 'the cursor stops where the queue does');
});
