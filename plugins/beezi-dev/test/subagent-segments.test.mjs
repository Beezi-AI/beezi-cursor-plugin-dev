import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint, CheckpointMode } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';
import { safeName } from '../lib/sidecar.mjs';

// One report segment per correlated subagent, and the arithmetic that stops it double-billing the
// user's day.
//
// The premise every test here rests on: a subagent's wall clock OVERLAPS the parent's. The parent is
// blocked on the Task call while the worker runs, and with `is_parallel_worker` several workers
// overlap each other too. Cursor exposes no per-subagent token usage anywhere — no sub-transcript,
// no usage block, no per-agent cost — so `duration_sec` is the ONLY quantitative field one of these
// segments carries, which makes it the only thing that can be wrong and the only thing worth
// testing. Sum the spans instead of taking their union and a fan-out of six reports 4x the user's
// real day; the backend makes that worse than it sounds, because it stamps `duration_api_ms` once
// per SEGMENT and every duration query sums across segments with no `is_subagent` filter — the
// inflated figure lands in the overview time tile, the daily activity graph and the session list's
// sort key alike.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-subagent-'));
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
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

// The real delta, the real reader, the real correlation. The point of this file is the payload that
// actually goes on the wire, so nothing between the sidecar and the queue file is stubbed.
const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: fakeGit,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

function writeSidecar(home, id, events) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// Read back what was written to disk, which is a real JSON round-trip and therefore the honest test
// of what the wire would carry.
function queued() {
  let entries;
  try { entries = fs.readdirSync(queueDir(), { withFileTypes: true }); } catch { return []; }
  // Directories are skipped because one test deliberately parks one on a queue path to make that
  // segment's write fail; everything else in here is a report.
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => JSON.parse(fs.readFileSync(path.join(queueDir(), entry.name), 'utf-8')));
}

function stateOf(id) {
  // Null rather than a throw: "nothing was committed" is now an outcome a test asserts, not an
  // accident.
  const file = path.join(stateDir(), `${safeName(id)}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

const turnEnd = { emitTimeline: true };
const T0 = 1700000000000;

// A ten-minute foreground subagent, which is the shape that actually needs a segment.
//
// The parent writes nothing between the start and the stop, so from the parent's own point of view
// those ten minutes are ONE IDLE GAP — longer than the 300 s idle threshold — and its active time
// excludes them entirely. That is why the numbers below are 2 s of parent and 600 s of subagent
// rather than 602 and 600: the union is not an approximation here, it is the only way those ten
// minutes get reported at all.
//
// The parent's two seconds are `gen`→`subagent_start` and `subagent_stop`→`stop`. The turn end is a
// timing anchor (it is where the assistant's work finished); only the SESSION lifecycle is not.
const TEN_MINUTE_SUBAGENT = [
  { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
  { ts: T0 + 1_000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit the parser' },
  { ts: T0 + 601_000, ev: 'subagent_stop', task: 'audit the parser' },
  { ts: T0 + 602_000, ev: 'stop' },
];

test('a foreground subagent gets a segment of its own, distinct from the main one', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);

  const res = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(res.enqueued, 2);

  const payloads = queued();
  const main = payloads.find((p) => !p.is_subagent);
  const sub = payloads.find((p) => p.is_subagent);
  assert.ok(main, 'the main segment must still be queued');
  assert.ok(sub, 'the subagent must get a segment of its own');

  // Distinct segmentIds, or the server's idempotency upsert collapses the two onto one row and the
  // subagent's seconds overwrite the parent's instead of adding to them. The agent id is what
  // separates them.
  assert.notEqual(sub.segmentId, main.segmentId);
  assert.equal(main.segmentId, 'conv-1:0-4');
  // The subagent's id carries NO line range: the worker is re-derived from the whole stream at every
  // turn-end, and one row per worker is what lets a later, larger duration upsert onto itself
  // instead of adding a row.
  assert.equal(sub.segmentId, 'conv-1:sa-1');

  assert.equal(sub.is_subagent, true);
  assert.equal(sub.agent_id, 'sa-1');
  assert.equal(sub.agent_type, 'general-purpose');
  assert.equal(sub.agent_name, 'audit the parser');
  // The span is the worker's own, not the parent's window.
  assert.equal(sub.started_at, new Date(T0 + 1_000).toISOString());
  assert.equal(sub.ended_at, new Date(T0 + 601_000).toISOString());
  // Repo and branch are the parent's: a Cursor subagent has no cwd anywhere in any payload, and it
  // was working on the parent's checkout, so that is also the only true answer.
  assert.equal(sub.remote, main.remote);
  assert.equal(sub.branch, main.branch);
});

test('the subagent bills the minutes the parent could only see as idle', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const payloads = queued();
  const main = payloads.find((p) => !p.is_subagent);
  const sub = payloads.find((p) => p.is_subagent);

  // The parent's two active stretches: gen→subagent_start (1 s) and subagent_stop→stop (1 s). The
  // 600 s in between is one gap past the idle threshold, so its own duration excludes it.
  assert.equal(main.duration_sec, 2);
  // Which is exactly the stretch the subagent claims. If the main segment had claimed its
  // [started_at, ended_at] ENVELOPE instead of its active intervals, this would be 0 and ten real
  // minutes of the user's day would have left the session entirely.
  assert.equal(sub.duration_sec, 600);
  // And the two together are the session's real wall clock, once.
  assert.equal(main.duration_sec + sub.duration_sec, 602);
});

test('three parallel subagents cannot bill more wall clock than the session had', async (t) => {
  const home = tmpHome(t);
  // A fan-out: three workers opened within 200ms of each other and closed within 200ms of each
  // other, all three spanning the same ten minutes. This is the case that produced a 4.24x
  // overstatement in the sibling plugin before the interval union existed.
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 1_000, ev: 'subagent_start', sid: 'sa-a', stype: 'general-purpose', task: 'A', parallel: true },
    { ts: T0 + 1_100, ev: 'subagent_start', sid: 'sa-b', stype: 'general-purpose', task: 'B', parallel: true },
    { ts: T0 + 1_200, ev: 'subagent_start', sid: 'sa-c', stype: 'general-purpose', task: 'C', parallel: true },
    { ts: T0 + 601_000, ev: 'subagent_stop', task: 'A' },
    { ts: T0 + 601_100, ev: 'subagent_stop', task: 'B' },
    { ts: T0 + 601_200, ev: 'subagent_stop', task: 'C' },
    { ts: T0 + 602_000, ev: 'stop' },
  ]);

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const payloads = queued();
  const billed = payloads.reduce((sum, p) => sum + p.duration_sec, 0);
  // The session ran 602 s of wall clock end to end. Summing the spans instead would have reported
  // 2 + 600 + 600 + 600 = 1802 s — three times the user's real afternoon.
  const wallClockSec = 602;
  assert.ok(billed <= wallClockSec, `billed ${billed}s against ${wallClockSec}s of wall clock`);
  assert.equal(billed, wallClockSec, 'and none of it went missing either');

  // All three workers are REPORTED, and only the first one bills. B and C ran inside the stretch A
  // already claimed, so their residual is zero — but a worker that billed nothing still ran, and the
  // Subagents card, the per-worker tree and the Tokens-by-Subagent panel are all driven by these
  // rows. Suppressing the zero-duration ones (which is what this test used to assert) made a
  // fan-out of fifteen show as none.
  const subs = payloads.filter((p) => p.is_subagent);
  assert.deepEqual(subs.map((p) => p.agent_id), ['sa-a', 'sa-b', 'sa-c']);
  assert.deepEqual(subs.map((p) => p.duration_sec), [600, 0, 0]);
});

test('a subagent the parent already covered is still reported, billing nothing', async (t) => {
  const home = tmpHome(t);
  // A short worker: the parent is chatting either side of it, so its ten seconds are inside the
  // parent's own active time and were already reported on the main segment.
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 1_000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'quick lookup' },
    { ts: T0 + 11_000, ev: 'subagent_stop', task: 'quick lookup' },
    { ts: T0 + 12_000, ev: 'stop' },
  ]);

  const res = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(res.enqueued, 2);

  const main = queued().find((p) => !p.is_subagent);
  const sub = queued().find((p) => p.is_subagent);
  // The parent keeps all twelve seconds: the worker's ten are inside them and are billed once.
  assert.equal(main.duration_sec, 12);
  // And the worker's row exists anyway, saying exactly what is true — it ran, and it added no time
  // of its own. This is the COMMON case, not an edge one: a parent that goes on generating through
  // a fan-out covers every second of it, and the old `<= 0` skip turned that into an empty
  // Subagents card for the whole session.
  assert.equal(sub.duration_sec, 0);
  assert.equal(sub.agent_id, 'sa-1');
  assert.equal(sub.agent_name, 'quick lookup');
});

test('a reported subagent is not re-queued while nothing about it changed', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 1_000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'quick lookup' },
    { ts: T0 + 11_000, ev: 'subagent_stop', task: 'quick lookup' },
    { ts: T0 + 12_000, ev: 'stop' },
  ]);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(queued().filter((p) => p.is_subagent).length, 1);
  assert.deepEqual(stateOf('conv-1').sentSubagents, { 'sa-1': 0 });

  // Spans are re-correlated from the WHOLE stream at every turn-end. Without the sent-duration test
  // this worker would enqueue one more row per turn for the life of the conversation — which is the
  // failure the old `<= 0` skip was doing double duty to prevent.
  fs.appendFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: T0 + 13_000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g2' }),
      JSON.stringify({ ts: T0 + 14_000, ev: 'stop' }),
    ].join('\n') + '\n',
  );
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(queued().filter((p) => p.is_subagent).length, 1, 'no second row for the same worker');
});

test('the same subagent is not re-billed on the next turn-end', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const first = queued().length;

  // Correlation is whole-session by contract — every turn-end re-derives every span from the entire
  // stream — so without persisted coverage this worker would enqueue another 600 s segment at every
  // single turn for the rest of the conversation.
  fs.appendFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: T0 + 603_000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g2' }),
      JSON.stringify({ ts: T0 + 604_000, ev: 'stop' }),
    ].join('\n') + '\n',
  );
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 1, 'the second turn-end must not bill the same worker again');
  assert.equal(queued().length, first + 1, 'only the second main segment is new');
  // And the coverage that made that true survived the checkpoint boundary on disk.
  assert.ok(Array.isArray(stateOf('conv-1').coveredIntervals));
});

test('coverage is claimed only when the whole batch reached the queue', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);

  // Block the one queue path this subagent segment would use. `writeJsonSecure` renames a temp file
  // over the target, and renaming onto a directory throws on every platform this ships to. A queue
  // write really does fail in the field — a Windows AV scanner or backup agent holding a handle is
  // the usual cause — and the failure must not silently swallow the window for everyone behind it.
  const blocked = path.join(queueDir(), `${safeName('conv-1:sa-1')}.json`);
  fs.mkdirSync(blocked, { recursive: true });

  // This assertion used to read "only the main segment got through, and only its own two seconds are
  // covered". The pending batch (C-10) makes the window ALL-OR-NOTHING instead, which is strictly
  // stronger: the main segment's file is written, but because one item of the batch could not be
  // queued, nothing is committed at all — no cursor, no baseline, no coverage — and the pending
  // record is what says so. The property the old test protected is the one that matters and it
  // still holds: those 600 s are not marked covered, because nobody was told about them.
  const res = await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(res.enqueued, 0, 'a batch that could not be fully queued commits nothing');
  assert.deepEqual(queued().filter((p) => p.is_subagent), []);
  // The cwd→conversation mapping is written regardless: it is where this conversation lives, not a
  // claim about what was delivered, and it is deliberately outside the batch's single commit. Every
  // key that IS a delivery claim is absent.
  const halted = stateOf('conv-1');
  assert.equal(halted.cursor, 0, 'the cursor did not move over an unqueued item');
  assert.equal('coveredIntervals' in halted, false, 'nothing was marked covered');
  assert.equal('usageSnapshot' in halted, false, 'the overage baseline did not advance');
  assert.equal(halted.anchor, null, 'and no anchor was recorded');

  const pending = JSON.parse(fs.readFileSync(path.join(home, 'pending', 'conv-1.json'), 'utf-8'));
  assert.equal(pending.items.length, 2, 'the frozen batch still holds both segments');
  assert.equal(
    pending.items.filter((item) => item.payload.is_subagent === true).length,
    1,
    'including the one that could not be written',
  );

  // Which is the whole point: with the blockage gone the next turn-end recovers the FROZEN batch and
  // still has all 600 s to bill, under the same ids and the same bytes.
  fs.rmSync(blocked, { recursive: true, force: true });
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'the retry must find the seconds still unbilled');
  assert.equal(sub.duration_sec, 600);
  assert.deepEqual(
    sub,
    pending.items.find((item) => item.payload.is_subagent === true).payload,
    'byte-identical to what was frozen before the crash',
  );
  assert.equal(fs.existsSync(path.join(home, 'pending', 'conv-1.json')), false, 'and the record is gone');
  const covered = stateOf('conv-1').coveredIntervals;
  assert.equal(covered.reduce((sum, [from, to]) => sum + (to - from), 0), 602_000);
});

// ─── the wire contract ───────────────────────────────────────────────────────────────────────────

// A copy of SessionReportRequestDto's properties. The route is validated as a WHITELIST — Nest's
// ValidationPipe runs globally with `{whitelist:true, forbidNonWhitelisted:true}` — so a property
// the DTO does not declare is not forward-compatible extra data, it is a 400 that throws the whole
// segment away. test/report-payload-shape.test.mjs holds the authoritative copy of this list.
const DTO_PROPERTIES = new Set([
  'segmentId', 'sessionId', 'remote', 'branch', 'from_line', 'to_line', 'models',
  'token_total', 'token_input', 'token_output', 'token_cache', 'duration_sec',
  'session_name', 'billing_source', 'subscription_type', 'rate_limit_tier', 'subscription_plan',
  'third_party_provider', 'timezone', 'started_at', 'ended_at', 'code_changes', 'operations',
  'is_subagent', 'agent_id', 'agent_type', 'agent_name', 'spawn_depth',
]);

test('a subagent segment carries no property the server would reject', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const sub = queued().find((p) => p.is_subagent);
  const extra = Object.keys(sub).filter((k) => !DTO_PROPERTIES.has(k));
  assert.deepEqual(extra, [], `these keys would 400 the whole report: ${extra.join(', ')}`);

  // `is_subagent` must be a real boolean. `transform: true` is on but `enableImplicitConversion` is
  // not, so the string "true" is a 400 exactly like an unknown key.
  assert.equal(typeof sub.is_subagent, 'boolean');
  for (const field of ['from_line', 'to_line', 'token_total', 'token_input', 'token_output', 'token_cache', 'duration_sec']) {
    assert.ok(Number.isInteger(sub[field]) && sub[field] >= 0, `${field} must be a non-negative integer`);
  }
  assert.ok(sub.agent_id.length <= 200);
  assert.ok(sub.agent_type.length <= 100);
  assert.ok(sub.agent_name === null || sub.agent_name.length <= 200);
});

test('spawn_depth is omitted rather than fabricated', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  // The DTO accepts `spawn_depth` and the backend stores it, so sending 1 would validate and look
  // right. It would still be a lie: `parent_conversation_id` only separates depth-1 from depth-≥2,
  // and a subagent's own conversation id is never exposed anywhere, so the spawn graph cannot be
  // walked. An absent field is recoverable; a fabricated integer is indistinguishable from a
  // measured one forever after.
  const sub = queued().find((p) => p.is_subagent);
  assert.equal('spawn_depth' in sub, false);
});

test('a subagent segment carries a storable signal, and no figure that could be double-billed', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const sub = queued().find((p) => p.is_subagent);
  // THE HAZARD THIS PINS. The ingest service filters entries on
  //     pricingId !== null || usageTokenTotal(usage) > 0 || billingPool !== null
  // and returns EARLY when nothing survives — writing no analytics row and no session row, while the
  // controller still answers `200 {status:"stored"}`. A zero-token subagent entry with no pool lands
  // exactly there: accepted, apparently fine, permanently invisible. The pool is what rescues it,
  // and it only counts because the Cursor provider profile sets `splitsBilling` (the source comes
  // from the X-Beezi-Agent header this plugin sends).
  assert.ok(sub.models.length > 0, 'an empty models list is accepted and stored nowhere');
  for (const entry of sub.models) {
    assert.ok(typeof entry.billing_pool === 'string' && entry.billing_pool !== '');
    assert.ok(typeof entry.model === 'string' && entry.model !== '');
    // Every count zero, and not as a placeholder. The parent's requests, tokens and cost are already
    // reported on the main segment for this same window; repeating any of them here would bill the
    // same spend twice under a second segmentId — the money-side version of exactly the wall-clock
    // double-count the interval union exists to prevent.
    assert.equal(entry.requests, 0);
    assert.equal(entry.token_input, 0);
    assert.equal(entry.token_output, 0);
    assert.equal(entry.token_cache_read, 0);
    assert.equal(entry.token_cache_creation, 0);
    assert.equal('cost_usd' in entry, false, 'a subagent row must never carry money');
  }
  assert.equal(sub.token_total, 0);
  // No per-subagent attribution exists in Cursor for either of these, and the backend stamps both
  // once per segment and sums them session-wide with no `is_subagent` filter — so a guess would
  // double the session's line counts rather than enrich them.
  assert.equal('code_changes' in sub, false);
  assert.equal('operations' in sub, false);
});

test('the model identity survives a window that contains no generation line', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  // Block the first attempt so the segment is retried in a LATER window — one whose own slice holds
  // no `gen` line at all, which is the common case for a subagent worth billing (its residual
  // seconds are by definition the stretch where the parent was quiet).
  const blocked = path.join(queueDir(), `${safeName('conv-1:sa-1')}.json`);
  fs.mkdirSync(blocked, { recursive: true });
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  fs.rmSync(blocked, { recursive: true, force: true });

  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  const sub = queued().find((p) => p.is_subagent);
  // Falls back to the last main segment this conversation queued. Without it the row is `models: []`
  // — accepted with a 200 and written nowhere.
  assert.equal(sub.models[0].model, 'claude-4.5-sonnet');
  assert.ok(typeof sub.models[0].billing_pool === 'string');
});

// ─── the login backfill's replay ─────────────────────────────────────────────────────────────────
//
// A VERIFIED PRODUCTION GAP, pinned here so it cannot come back. Every test above drives the
// turn-end path, and the subagent block is gated on the whole-sidecar parse that path performs —
// which the audit did not ask for. So the login backfill emitted exactly ZERO is_subagent rows:
// every past session's delegated time, on every machine that has ever run the import, was silently
// unbilled. Nothing looked wrong from outside, because a session with no subagent segments is
// indistinguishable from a session that never delegated.
test('audit mode emits the subagent segment the backfill used to lose entirely', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  const reports = [];

  const res = await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps(),
    { sink: (p) => reports.push(p), mode: CheckpointMode.AUDIT },
  );

  assert.equal(res.enqueued, 2);
  const main = reports.find((p) => !p.is_subagent);
  const sub = reports.find((p) => p.is_subagent);
  assert.ok(sub, 'the audit must produce an is_subagent report');
  assert.equal(sub.agent_id, 'sa-1');
  assert.equal(sub.agent_type, 'general-purpose');
  assert.equal(sub.agent_name, 'audit the parser');

  // The SAME arithmetic the live path produces for this fixture — 2 s of parent, 600 s of worker,
  // 602 s of wall clock once. A replay parses the whole session in one window while a live run
  // converges over many, so an audit that billed different seconds than the turn-ends would have
  // billed would make an imported session incomparable with a tracked one.
  assert.equal(main.duration_sec, 2);
  assert.equal(sub.duration_sec, 600);

  // A fresh state has no anchor to fall back on, so the parent's model identity has to come from
  // the window itself — which a whole-session parse always contains if the session ran anything.
  assert.equal(sub.models[0].model, 'claude-4.5-sonnet');
  // Nothing reached the disk queue, and the state file was never written.
  assert.deepEqual(queued(), []);
  assert.equal(stateOf('conv-1'), null, 'no state file at all — stateOf says so rather than throwing');
});

// ─── the MCP alias LRU ───────────────────────────────────────────────────────────────────────────

const BEEZI_TOOL = 'mcp_plugin_beezi_beezi_create_ticket';

test('an alias learned in one window still names the tool in the next', async (t) => {
  const home = tmpHome(t);
  // Window N holds only the side channel. `beforeMCPExecution` fires BEFORE the call and
  // `postToolUse` after it, so a checkpoint boundary between them is not exotic — and the first call
  // to any server is the one most likely to straddle one, which makes the miss systematic.
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 500, ev: 'mcp_server', tool: BEEZI_TOOL, server: 'plugin_beezi' },
  ]);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps());
  assert.deepEqual(stateOf('conv-1').mcpAliases, [[BEEZI_TOOL, 'plugin_beezi']]);

  // Window N+1 holds the tool line alone. Without the carry-over the join has no side channel to
  // read and falls back to splitting `mcp_<server>_<tool>` at the FIRST underscore — which resolves
  // this plugin's own tools to a server called "plugin" that does not exist.
  fs.appendFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    JSON.stringify({ ts: T0 + 1_000, ev: 'tool', tool: BEEZI_TOOL, bytes: 40 }) + '\n',
  );
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps());

  const latest = queued().sort((a, b) => a.from_line - b.from_line).at(-1);
  assert.equal(latest.operations.mcp.by_server.plugin_beezi?.count, 1);
  assert.equal(latest.operations.mcp.by_server.plugin, undefined, 'the prefix split named a server that does not exist');
});

test('mcpAliases never reaches the wire', async (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 500, ev: 'mcp_server', tool: BEEZI_TOOL, server: 'plugin_beezi' },
    { ts: T0 + 1_000, ev: 'tool', tool: BEEZI_TOOL, bytes: 40 },
    { ts: T0 + 2_000, ev: 'stop' },
  ]);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  // The LRU is real state — it has to be, or the join above cannot survive a boundary.
  assert.ok(stateOf('conv-1').mcpAliases.length > 0);

  // And it must not appear anywhere in a payload. `operations.mcpAliases` is defined NON-ENUMERABLE
  // for exactly this reason, so `JSON.stringify` drops it; a later refactor to a plain property
  // would be silent here and catastrophic in production, because one unknown top-level key 400s the
  // ENTIRE report and takes the segment's tokens, cost, code changes and operations with it. The
  // queue files below have already been through a real round-trip, and the string search catches a
  // leak at any depth rather than only at the top level.
  for (const payload of queued()) {
    const wire = JSON.stringify(payload);
    assert.equal(wire.includes('mcpAliases'), false, 'the alias LRU leaked into a report payload');
    assert.equal(payload.operations?.mcpAliases, undefined);
    const extra = Object.keys(payload).filter((k) => !DTO_PROPERTIES.has(k));
    assert.deepEqual(extra, [], `these keys would 400 the whole report: ${extra.join(', ')}`);
  }
});

// ─── diagnostics ─────────────────────────────────────────────────────────────────────────────────

test('an orphan stop is said out loud rather than reported as a session that never delegated', async (t) => {
  const home = tmpHome(t);
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = real; });

  // A stop with no start in front of it. In the field this means the START WAS WRITTEN TO A
  // DIFFERENT SIDECAR FILE — i.e. a subagent's events are routed under its own conversation id
  // rather than the parent's, which would leave every start in a file nothing ever flushes and make
  // subagent tracking blind no matter what this module does. It is invisible from the outside: the
  // session simply looks like one that never delegated.
  writeSidecar(home, 'conv-1', [
    { ts: T0, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1' },
    { ts: T0 + 1_000, ev: 'subagent_stop', task: 'work that was started somewhere else' },
    { ts: T0 + 2_000, ev: 'stop' },
  ]);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);

  const said = written.join('');
  assert.match(said, /subagent correlation/);
  assert.match(said, /1 orphaned/);
  // Counts travel by callback and never as a key on the timeline object: every key of that object
  // is POSTed verbatim, so an extra one fails validation for the whole document.
  assert.deepEqual(queued().filter((p) => p.is_subagent), []);
});

test('a clean correlation says nothing at all', async (t) => {
  const home = tmpHome(t);
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = real; });

  writeSidecar(home, 'conv-1', TEN_MINUTE_SUBAGENT);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(), turnEnd);
  assert.equal(written.join('').includes('subagent correlation'), false);
});
