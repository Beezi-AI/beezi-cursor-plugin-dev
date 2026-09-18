import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { computeDelta } from '../lib/delta-cursor.mjs';
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
