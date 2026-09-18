import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBackfillSummary, renderSyncSummary } from '../lib/audit-summary.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';

// What the user actually reads.
//
// `scripts/backfill.mjs` and `scripts/sync.mjs` are thin: they parse flags, drive the run and
// print what these renderers return. The wording IS the deliverable of 08-A ("print oversize
// whenever nonzero", "truthful completion wording"), so it is asserted here rather than through a
// subprocess that would have to be given a whole fake credential store to say anything at all.

const auditResult = (over = {}) => ({
  ok: true,
  reason: null,
  authState: null,
  authReason: null,
  retryAdvised: false,
  halt: null,
  scanned: 3,
  active: 0,
  activePreLink: 0,
  liveTracked: 0,
  alreadyImported: 0,
  oversize: 0,
  candidates: 1,
  plannedChunks: 1,
  plannedReports: 1,
  sessionsImported: 1,
  empty: 0,
  zeroUsage: 0,
  unreadable: 0,
  retriableUnreadable: 0,
  sessionsRejected: 0,
  reportsStored: 1,
  reportsSkipped: 0,
  itemErrors: 0,
  reportsFailed: 0,
  unattributed: 0,
  permanentRejections: 0,
  finalized: false,
  pullOpened: true,
  upgradeAdvised: false,
  followupsAllowed: true,
  timelines: 0,
  timelinesOffered: 0,
  timelinesDropped: 0,
  lastError: null,
  ...over,
});

const text = (rendered) => rendered.lines.join('\n');

// ─── typed auth outcomes (08-A) ─────────────────────────────────────────────

test('an unlinked machine is told to sign in', () => {
  const rendered = renderBackfillSummary(auditResult({ ok: false, reason: 'no-token' }), {});

  assert.match(rendered.error, /not linked/);
  assert.equal(rendered.lines.length, 0);
});

test('a held credential store advises a retry and promises nothing was changed', () => {
  const rendered = renderBackfillSummary(
    auditResult({ ok: false, reason: 'auth-unavailable', authState: 'unavailable', authReason: 'locked', retryAdvised: true }),
    {},
  );

  assert.doesNotMatch(rendered.error, /not linked/);
  assert.match(rendered.error, /try again|again in a moment/i);
  assert.match(rendered.error, /nothing was changed|no history was/i);
  assert.match(rendered.error, /locked/);
});

test('an auth state with no safe reason still names the state', () => {
  const rendered = renderBackfillSummary(
    auditResult({ ok: false, reason: 'auth-unavailable', authState: 'refreshing', authReason: null, retryAdvised: true }),
    {},
  );

  assert.match(rendered.error, /refreshing/);
});

// ─── oversize (08-A) ────────────────────────────────────────────────────────

test('oversize sessions are printed whenever nonzero, even with nothing else to upload', () => {
  const rendered = renderBackfillSummary(auditResult({ candidates: 0, oversize: 2, sessionsImported: 0 }), {});

  assert.match(text(rendered), /2 sessions/);
  assert.match(text(rendered), /too large/);
});

test('oversize sessions are printed alongside a successful upload', () => {
  const rendered = renderBackfillSummary(auditResult({ oversize: 1 }), {});

  assert.match(text(rendered), /1 session was too large/);
  // The supported repair path does not make a >64 MiB sidecar readable, and the summary says so
  // rather than implying a re-run will pick them up.
  assert.match(text(rendered), /re-running will not/i);
});

test('a finalized pull that skipped oversize sessions says so instead of claiming everything', () => {
  const rendered = renderBackfillSummary(auditResult({ oversize: 3, finalized: true }), {});

  const line = rendered.lines.find((l) => /finalized/.test(l));
  assert.ok(line, 'expected a finalization line');
  assert.match(line, /without/);
  assert.match(line, /3 sessions/);
});

test('a finalized pull with no oversize sessions keeps the plain wording', () => {
  const rendered = renderBackfillSummary(auditResult({ finalized: true }), {});

  const line = rendered.lines.find((l) => /finalized/.test(l));
  assert.ok(line);
  assert.doesNotMatch(line, /without/);
});

test('the 14-day horizon and the plan caveat are always stated', () => {
  const rendered = renderBackfillSummary(auditResult({}), {});

  assert.match(text(rendered), /14 days/);
  assert.match(text(rendered), /Plan and billing/);
});

// ─── existing behaviour preserved ───────────────────────────────────────────

test('an already-used one-time import is a success line under --via login and an error otherwise', () => {
  const done = auditResult({ reason: 'already-completed', candidates: 0 });

  assert.equal(renderBackfillSummary(done, { via: 'login' }).error, null);
  assert.match(renderBackfillSummary(done, {}).error, /one-time import/);
});

test('an already-completed halt reads the same as the already-completed reason', () => {
  const halted = auditResult({ halt: BackfillHalt.ALREADY_COMPLETED });

  assert.match(renderBackfillSummary(halted, {}).error, /one-time import/);
});

test('a run that reached nobody reports the transport failure', () => {
  const rendered = renderBackfillSummary(
    auditResult({ sessionsImported: 0, reportsFailed: 2, lastError: 'timeout' }),
    {},
  );

  assert.match(rendered.error, /timeout/);
});

test('a dry run says what it would have sent and sends nothing', () => {
  const rendered = renderBackfillSummary(auditResult({ plannedReports: 7, plannedChunks: 2 }), { dryRun: true });

  assert.equal(rendered.error, null);
  assert.match(text(rendered), /dry run/);
  assert.match(text(rendered), /7 reports/);
});

// ─── sync summary (08-B) ────────────────────────────────────────────────────

const syncResult = (over = {}) => ({
  ok: true,
  reason: null,
  authState: null,
  authReason: null,
  retryAdvised: false,
  halt: null,
  scanned: 2,
  active: 0,
  oversize: 0,
  queueHeld: 0,
  candidates: 1,
  upToDate: 0,
  deferred: 0,
  sourceMismatch: 0,
  plannedReports: 1,
  plannedChunks: 1,
  sessionsImported: 1,
  reportsStored: 1,
  reportsSkipped: 0,
  itemErrors: 0,
  reportsFailed: 0,
  sessionsRejected: 0,
  unattributed: 0,
  permanentRejections: 0,
  unreadable: 0,
  empty: 0,
  overageUnavailable: 0,
  timelines: 0,
  lastError: null,
  ...over,
});

test('sync never claims a seal and says so in its own words', () => {
  const rendered = renderSyncSummary(syncResult({}), {});

  assert.equal(rendered.error, null);
  assert.doesNotMatch(text(rendered), /finaliz/i);
  assert.doesNotMatch(text(rendered), /one-time/i);
});

test('an unavailable coverage answer halts the sync run with a safe explanation', () => {
  const rendered = renderSyncSummary(syncResult({ ok: false, halt: 'coverage-unavailable', candidates: 0 }), {});

  assert.match(rendered.error, /could not confirm|coverage/i);
  assert.match(rendered.error, /nothing was uploaded/i);
});

test('sync prints oversize sessions too', () => {
  const rendered = renderSyncSummary(syncResult({ oversize: 2 }), {});

  assert.match(text(rendered), /2 sessions were too large/);
});

test('sessions held back by the live queue are named, not silently dropped', () => {
  const rendered = renderSyncSummary(syncResult({ queueHeld: 3 }), {});

  assert.match(text(rendered), /3 sessions/);
  assert.match(text(rendered), /queue/i);
});

test('a resumed suffix reports that overage cost is unavailable for it', () => {
  const rendered = renderSyncSummary(syncResult({ overageUnavailable: 2 }), {});

  assert.match(text(rendered), /overage|usage cost/i);
});

test('the extraction seam being absent is reported as a disabled capability, not a failure', () => {
  const rendered = renderSyncSummary(syncResult({ ok: false, halt: 'extraction-unavailable', candidates: 0 }), {});

  assert.match(rendered.error, /not enabled|not available/i);
});

test('sessions Beezi did not report coverage for are named, not silently treated as new', () => {
  const rendered = renderSyncSummary(syncResult({ coverageMissing: 2 }), {});

  assert.match(text(rendered), /2 sessions/);
  assert.match(text(rendered), /did not report|could not say/i);
});

test('a source mismatch is reported in sync output', () => {
  const rendered = renderSyncSummary(syncResult({ sourceMismatch: 1 }), {});

  assert.match(text(rendered), /more history/);
});

test('an unreadable queue stops sync with a repairable warning', () => {
  const rendered = renderSyncSummary(syncResult({ ok: false, halt: 'queue-unreadable', candidates: 0 }), {});

  assert.match(rendered.error, /queue/i);
  assert.match(rendered.error, /Nothing was uploaded/i);
});

test('sync does not claim completeness in the same breath as listing what it skipped', () => {
  // The 08-A failure, on the sync side: a ✓ headline that the very next line contradicts.
  for (const over of [
    { queueHeld: 3 },
    { coverageMissing: 2 },
    { sourceMismatch: 1 },
    { deferred: 1 },
    { active: 2 },
    { oversize: 1 },
    { unreadable: 1 },
  ]) {
    const rendered = renderSyncSummary(syncResult({ candidates: 0, sessionsImported: 0, ...over }), {});
    assert.doesNotMatch(
      text(rendered),
      /already holds everything/,
      `claimed completeness with ${JSON.stringify(over)}`,
    );
    assert.match(text(rendered), /nothing new was uploaded|nothing new to upload/i);
  }
});

test('a genuinely complete sync still says so', () => {
  const rendered = renderSyncSummary(syncResult({ candidates: 0, sessionsImported: 0 }), {});

  assert.match(text(rendered), /already holds everything/);
});

// ─── fix round 1, minor 8 ───────────────────────────────────────────────────

test('sessions whose suffix held nothing billable are accounted for', () => {
  const rendered = renderSyncSummary(syncResult({ empty: 2 }), {});

  assert.match(text(rendered), /2 sessions/);
  assert.match(text(rendered), /nothing new to upload|no new usage/i);
});

test('a partial acknowledgment is reported and explains why it will be retried', () => {
  const rendered = renderSyncSummary(syncResult({ partial: 1 }), {});

  assert.match(text(rendered), /1 session/);
  assert.match(text(rendered), /part/i);
});

test('a server that answers with the one-time seal is reported as a server-side refusal', () => {
  const rendered = renderSyncSummary(syncResult({ ok: false, halt: BackfillHalt.ALREADY_COMPLETED, candidates: 0 }), {});

  assert.notEqual(rendered.error, null);
  // Sync does not use the one-time import, so this cannot mean "your import is done" — saying so
  // would tell the user their history is complete when the sync route refused them.
  assert.doesNotMatch(rendered.error, /cannot run again|has been used/);
  assert.match(rendered.error, /refused|not accept/i);
  assert.match(rendered.error, /nothing was uploaded/i);
});

test('no epoch source is a safe stop, not a silent unfenced upload', () => {
  const rendered = renderSyncSummary(syncResult({ ok: false, halt: 'epoch-unavailable', candidates: 0 }), {});

  assert.match(rendered.error, /sign-in|account/i);
  assert.match(rendered.error, /nothing was uploaded/i);
});
