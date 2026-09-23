import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit, runSync, parseSyncArgs, SYNC_MODE, SyncHalt } from '../lib/session-audit.mjs';
import { BackfillSessionStatus, BackfillHalt, AuditEndpoint } from '../lib/audit-flush.mjs';
import { sessionLockPath, withLock } from '../lib/lock.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The repeatable sync (`beezi-sync`).
//
// Everything here is about NOT counting the same work twice. The one-time backfill can be
// conservative by skipping whole sessions; sync deliberately re-visits sessions the backfill has
// already imported, so its only protection is the server's coverage answer plus a per-session lock
// that holds from the coverage query through the acknowledgment. Every test below pins one of the
// ways that protection can be lost.

const CLOCK = 40 * 24 * 60 * 60 * 1000;

// Twenty days back: quiet (past the 1-day active window) and inside the 30-day retention floor,
// which skips anything older. The retention test picks its own explicit age.
const T0 = CLOCK - 20 * 24 * 60 * 60 * 1000;

const conversation = (sessionId, mtimeMs = T0 + 1000) => ({
  sessionId,
  eventsPath: `C:/home/.beezi-cursor/events/${sessionId}.jsonl`,
  mtimeMs,
  size: 1024,
});

const report = (sessionId, over = {}) => ({
  segmentId: `${sessionId}:2-5`,
  sessionId,
  remote: 'r',
  branch: 'main',
  from_line: 2,
  to_line: 5,
  token_total: 100,
  models: [{ model: 'claude-4.5-sonnet', billing_pool: 'subscription', requests: 1 }],
  duration_sec: 10,
  ...over,
});

const flushResult = (over = {}) => ({
  chunks: 1,
  stored: 0,
  skipped: 0,
  timelines: 0,
  timelinesDropped: 0,
  itemErrors: 0,
  retryableFailures: 0,
  permanentRejections: 0,
  unattributed: 0,
  bySession: new Map(),
  halt: null,
  lastError: null,
  ...over,
});

// A lock double that actually serializes and can be made to miss, so "the lock was held across the
// coverage query and the send" is observable rather than assumed.
function fakeLock(order) {
  const held = new Set();
  const contended = new Set();
  const impl = async (sessionId, fn, { miss } = {}) => {
    if (contended.has(sessionId) || held.has(sessionId)) return miss;
    held.add(sessionId);
    order.push(`lock:${sessionId}`);
    try {
      return await fn();
    } finally {
      held.delete(sessionId);
      order.push(`unlock:${sessionId}`);
    }
  };
  return { impl, order, contended, held };
}

function makeDeps(overrides = {}) {
  const order = [];
  const lock = fakeLock(order);
  const saved = [];
  const syncState = { version: 1, account: 'acct-a', sessions: {}, updatedAt: null };
  const deps = {
    now: () => CLOCK,
    getAccessToken: async () => 'tok',
    authEpoch: async () => 'prod|t|u|1',
    readTrackingStateImpl: () => ({ email: 'me@example.com' }),
    statImpl: () => { throw new Error('ENOENT'); },
    listConversations: () => [conversation('s1')],
    lastActivityOfImpl: (entry) => entry.mtimeMs,
    firstRecordedCwd: () => 'C:/work/app',
    createCheckpointCachesImpl: () => ({ rootCache: new Map(), remoteCache: new Map(), timelineCache: new Map(), map: { version: 1, roots: {} } }),
    flushQueueImpl: async () => { order.push('drain'); return { flushed: 0, failed: 0 }; },
    readQueueImpl: () => ({ sessionIds: [], unidentifiable: 0 }),
    fetchCoverageImpl: async (ids) => {
      order.push(`coverage:${ids.join(',')}`);
      return new Map(ids.map((id) => [id, 2]));
    },
    sidecarSnapshotImpl: () => ({ lines: 5, fingerprint: 'v1:abc' }),
    withSessionLock: lock.impl,
    inflight: { acquire: async () => true, release: () => {} },
    extractAuditReports: async (input, _d, options) => {
      order.push(`extract:${input.session_id}@${options.startCursor}`);
      return { reports: [report(input.session_id)], sessionErrors: [], deltaFailed: false };
    },
    flushBackfillChunksImpl: async (groups, _token, _d, options) => {
      order.push(`flush:${groups.map((g) => g.sessionId).join(',')}:${options.endpoint}`);
      return flushResult({
        stored: groups.reduce((n, g) => n + g.reports.length, 0),
        bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }])),
      });
    },
    loadSyncStateImpl: () => syncState,
    saveSyncStateImpl: (s) => { order.push('save'); saved.push(JSON.parse(JSON.stringify(s))); },
    // Guards: sync must never reach any of these.
    completeBackfillImpl: async () => { throw new Error('sync called /complete'); },
    markBackfillCompletedImpl: () => { throw new Error('sync marked completion'); },
    saveLedgerImpl: () => { throw new Error('sync wrote the one-time ledger'); },
    loadLedgerImpl: () => { throw new Error('sync read the one-time ledger'); },
    runCheckpointImpl: () => { throw new Error('sync must not nest runCheckpoint under its own lock'); },
    // The real timeline reads the real sidecar dir (and the real CLI chat store); no test here wants
    // that unless it says so.
    computeSessionTimelineImpl: () => null,
    ...overrides,
  };
  return { deps, order, lock, saved, syncState };
}

// ─── dispatch and the never-seals guarantee ─────────────────────────────────

test('runAudit dispatches SYNC_MODE to runSync before anything else runs', async () => {
  const { deps } = makeDeps({});

  const result = await runAudit(deps, { mode: SYNC_MODE });

  assert.equal(result.ok, true);
  assert.equal(result.mode, SYNC_MODE);
});

test('sync never seals, never calls /complete and never writes the one-time ledger', async () => {
  const { deps } = makeDeps({});

  const result = await runSync(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.finalized, undefined);
  assert.equal(result.sessionsImported, 1);
});

test('sync never advances live state', async () => {
  const touched = [];
  const { deps } = makeDeps({ saveStateImpl: (...args) => touched.push(args) });

  await runSync(deps, {});

  assert.deepEqual(touched, []);
});

// ─── gates, in order ────────────────────────────────────────────────────────

test('an unlinked machine stops before the drain and before any HTTP', async () => {
  const { deps, order } = makeDeps({
    getAuthState: async () => ({ state: 'unlinked', reason: 'missing', token: null }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.reason, 'no-token');
  assert.deepEqual(order, []);
});

test('a held credential store advises a retry and touches nothing', async () => {
  const { deps, order } = makeDeps({
    getAuthState: async () => ({ state: 'unavailable', reason: 'locked', token: null }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.retryAdvised, true);
  assert.deepEqual(order, []);
});

test('without the extraction seam the run halts before it drains or asks for coverage', async () => {
  const { deps, order } = makeDeps({ extractAuditReports: undefined });

  const result = await runSync(deps, {});

  assert.equal(result.halt, SyncHalt.EXTRACTION_UNAVAILABLE);
  assert.equal(result.ok, false);
  assert.deepEqual(order, []);
});

// ─── live queue ─────────────────────────────────────────────────────────────

test('the live queue is drained first, then coverage is asked', async () => {
  const { deps, order } = makeDeps({});

  await runSync(deps, {});

  assert.equal(order[0], 'drain');
  assert.equal(order[1], 'coverage:s1');
});

test('a session with anything left in the queue is ineligible this run', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('s1'), conversation('s2')],
    readQueueImpl: () => ({ sessionIds: ['s2'], unidentifiable: 0 }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.queueHeld, 1);
  assert.equal(result.sessionsImported, 1);
});

test('a queue file that cannot be attributed to a session halts the run', async () => {
  const { deps, order } = makeDeps({ readQueueImpl: () => ({ sessionIds: [], unidentifiable: 1 }) });

  const result = await runSync(deps, {});

  assert.equal(result.halt, SyncHalt.QUEUE_UNREADABLE);
  assert.equal(result.sessionsImported, 0);
  assert.equal(order.includes('coverage:s1'), false);
});

test('a failed drain does not stop the run — the queue scan bounds it anyway', async () => {
  const { deps } = makeDeps({ flushQueueImpl: async () => { throw new Error('offline'); } });

  const result = await runSync(deps, {});

  assert.equal(result.ok, true);
});

// ─── coverage ───────────────────────────────────────────────────────────────

test('an unavailable coverage answer halts the whole run and sends nothing', async () => {
  const { deps, order } = makeDeps({ fetchCoverageImpl: async () => null });

  const result = await runSync(deps, {});

  assert.equal(result.halt, SyncHalt.COVERAGE_UNAVAILABLE);
  assert.equal(result.ok, false);
  assert.equal(order.some((o) => o.startsWith('flush')), false);
});

test('coverage is never allowed to fall back to cursor zero', async () => {
  const { deps } = makeDeps({ fetchCoverageImpl: async () => null });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 0);
  assert.equal(result.candidates, 0);
});

test('a session the server does not mention is skipped, not resent from zero', async () => {
  const { deps, order } = makeDeps({ fetchCoverageImpl: async () => new Map() });

  const result = await runSync(deps, {});

  assert.equal(result.coverageMissing, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('a fully covered unchanged session is up to date, not re-sent', async () => {
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 5])),
  });

  const result = await runSync(deps, {});

  assert.equal(result.upToDate, 1);
  assert.equal(result.candidates, 0);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('a newly appended suffix after a completed ledger item still syncs', async () => {
  // The one-time ledger says "imported"; the sidecar has grown since. Coverage — not the ledger —
  // decides, which is the whole reconciliation of section 10.2's "skips sessions already in ledger".
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 3])),
    sidecarSnapshotImpl: () => ({ lines: 9, fingerprint: 'v1:abc' }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.ok(order.includes('extract:s1@3'));
});

test('coverage beyond what this machine still holds is an explicit source mismatch, never a clamp', async () => {
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 99])),
  });

  const result = await runSync(deps, {});

  assert.equal(result.sourceMismatch, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('only the uncovered suffix is extracted', async () => {
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 2])),
  });

  await runSync(deps, {});

  assert.ok(order.includes('extract:s1@2'));
});

test('a one-line coverage hole is respected: the prefix stops at the hole', async () => {
  // fetchCoverage itself answers 2 for [0,2),[3,4); this asserts the audit sends from 2 and not 4.
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 2])),
    sidecarSnapshotImpl: () => ({ lines: 4, fingerprint: 'v1:abc' }),
  });

  await runSync(deps, {});

  assert.ok(order.includes('extract:s1@2'));
});

// ─── the per-session protocol ───────────────────────────────────────────────

test('coverage is re-fetched under the lock and the lock is held through the acknowledgment', async () => {
  const { deps, order } = makeDeps({});

  await runSync(deps, {});

  const lockAt = order.indexOf('lock:s1');
  const unlockAt = order.indexOf('unlock:s1');
  const recheckAt = order.lastIndexOf('coverage:s1');
  const flushAt = order.findIndex((o) => o.startsWith('flush:s1'));
  assert.ok(lockAt !== -1 && unlockAt !== -1);
  assert.ok(lockAt < recheckAt, 'coverage must be re-fetched under the lock');
  assert.ok(recheckAt < flushAt, 'the authorizing coverage query must precede the send');
  assert.ok(flushAt < unlockAt, 'the lock must be held through the acknowledgment');
});

test('a session whose lock is held elsewhere is deferred, never raced', async () => {
  const { deps, lock, order } = makeDeps({});
  lock.contended.add('s1');

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('a queue flush worker holding the session through the in-flight barrier defers it', async () => {
  const { deps, order } = makeDeps({
    inflight: { acquire: async () => false, release: () => {} },
  });

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 1);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('the in-flight barrier is always released, even when the session fails', async () => {
  const released = [];
  const { deps } = makeDeps({
    inflight: { acquire: async () => true, release: (id) => released.push(id) },
    extractAuditReports: async () => { throw new Error('unreadable'); },
  });

  const result = await runSync(deps, {});

  assert.deepEqual(released, ['s1']);
  assert.equal(result.unreadable, 1);
});

test('a concurrent hook that enqueues between the scan and the lock takes the session out', async () => {
  let queued = [];
  const { deps, order } = makeDeps({
    readQueueImpl: () => ({ sessionIds: queued, unidentifiable: 0 }),
    withSessionLock: async (sessionId, fn) => {
      // The hook wins the race: its window lands after the eligibility scan, before the lock.
      queued = ['s1'];
      return fn();
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.queueHeld, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('sync skips sessions older than the retention window', async () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const { deps, order } = makeDeps({
    listConversations: () => [
      conversation('ancient', CLOCK - 31 * DAY_MS),
      conversation('recent', CLOCK - 29 * DAY_MS),
    ],
  });

  const result = await runSync(deps, {});

  assert.equal(result.tooOld, 1);
  assert.equal(order.some((o) => o.startsWith('extract:ancient')), false);
});

test('a session that became active again between the scan and the lock is left alone', async () => {
  let activity = T0 + 1000;
  const { deps } = makeDeps({
    lastActivityOfImpl: () => activity,
    withSessionLock: async (sessionId, fn) => { activity = CLOCK - 1000; return fn(); },
  });

  const result = await runSync(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.sessionsImported, 0);
});

test('coverage that becomes unavailable under the lock halts rather than sending', async () => {
  let calls = 0;
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => {
      calls += 1;
      return calls === 1 ? new Map(ids.map((id) => [id, 2])) : null;
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.halt, SyncHalt.COVERAGE_UNAVAILABLE);
  assert.equal(order.some((o) => o.startsWith('flush')), false);
});

test('coverage that advanced under the lock is what authorizes the send', async () => {
  let calls = 0;
  const { deps, order } = makeDeps({
    fetchCoverageImpl: async (ids) => {
      calls += 1;
      // Another checkpoint enqueued AND was acknowledged between the bulk query and the lock.
      return new Map(ids.map((id) => [id, calls === 1 ? 2 : 4]));
    },
  });

  await runSync(deps, {});

  assert.ok(order.includes('extract:s1@4'), `expected the re-fetched cursor, got ${order.join(' ')}`);
});

test('each session is sent inside its own lock, one dispatch at a time', async () => {
  const { deps, order } = makeDeps({ listConversations: () => [conversation('s1'), conversation('s2')] });

  await runSync(deps, {});

  assert.deepEqual(
    order.filter((o) => /^(lock|unlock|flush)/.test(o)),
    ['lock:s1', 'flush:s1:sync', 'unlock:s1', 'lock:s2', 'flush:s2:sync', 'unlock:s2'],
  );
});

test('sync posts to the sync route, never the one-time backfill route', async () => {
  const seen = [];
  const { deps } = makeDeps({
    flushBackfillChunksImpl: async (groups, _t, _d, options) => {
      seen.push(options.endpoint);
      return flushResult({ bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])) });
    },
  });

  await runSync(deps, {});

  assert.deepEqual(seen, [AuditEndpoint.SYNC]);
});

// ─── epoch fence ────────────────────────────────────────────────────────────

test('an account change before the send defers the session instead of uploading it', async () => {
  let epoch = 'prod|t|u|1';
  const { deps, order } = makeDeps({
    authEpoch: async () => epoch,
    withSessionLock: async (sessionId, fn) => { epoch = 'prod|t2|u2|1'; return fn(); },
  });

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 1);
  assert.equal(order.some((o) => o.startsWith('flush')), false);
});

test('a late acknowledgment for the old account cannot advance the new one progress', async () => {
  let epoch = 'prod|t|u|1';
  const { deps, saved } = makeDeps({
    authEpoch: async () => epoch,
    flushBackfillChunksImpl: async (groups) => {
      // The relink lands while the request is in flight; the ack arrives afterwards.
      epoch = 'prod|other|u|1';
      return flushResult({
        stored: 1,
        bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])),
      });
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 0);
  assert.equal(result.deferred, 1);
  assert.deepEqual(saved, [], 'a late old-account ack must not write progress');
});

test('a same-account token rotation does not defer anything', async () => {
  const { deps } = makeDeps({ authEpoch: async () => 'prod|t|u|1' });

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 0);
  assert.equal(result.sessionsImported, 1);
});

// ─── progress ───────────────────────────────────────────────────────────────

test('acknowledged progress records what was PROVABLY sent, not what was on disk', async () => {
  // The extraction reports how far it actually consumed (`to_line`), and the sidecar can have
  // grown between the snapshot and the parse — `appendEvent` is not lock-guarded. Recording the
  // snapshot's line count would claim delivery of lines no report covered.
  const { deps, saved } = makeDeps({
    sidecarSnapshotImpl: () => ({ lines: 7, fingerprint: 'v1:abc' }),
    extractAuditReports: async (input) => ({
      reports: [report(input.session_id, { from_line: 2, to_line: 5 })],
      sessionErrors: [],
      deltaFailed: false,
    }),
  });

  await runSync(deps, {});

  assert.equal(saved.length, 1);
  assert.deepEqual(
    { cursor: saved[0].sessions.s1.cursor, fingerprint: saved[0].sessions.s1.fingerprint },
    { cursor: 5, fingerprint: 'v1:abc' },
  );
});

test('a subagent segment does not drag the recorded cursor backwards', async () => {
  // Cursor's subagent segments carry the MAIN window's line range (checkpoint.mjs: "the range names
  // the window the segment was DERIVED in"), so they share the line space and the max is safe.
  const { deps, saved } = makeDeps({
    extractAuditReports: async (input) => ({
      reports: [
        report(input.session_id, { from_line: 2, to_line: 6 }),
        report(input.session_id, { from_line: 2, to_line: 6, is_subagent: true }),
      ],
      sessionErrors: [],
      deltaFailed: false,
    }),
  });

  await runSync(deps, {});

  assert.equal(saved[0].sessions.s1.cursor, 6);
});

test('reports with no usable line range fall back to the snapshot line count', async () => {
  const { deps, saved } = makeDeps({
    sidecarSnapshotImpl: () => ({ lines: 7, fingerprint: 'v1:abc' }),
    extractAuditReports: async (input) => ({
      reports: [{ segmentId: `${input.session_id}:x`, sessionId: input.session_id, models: [] }],
      sessionErrors: [],
      deltaFailed: false,
    }),
  });

  await runSync(deps, {});

  assert.equal(saved[0].sessions.s1.cursor, 7);
});

test('the extraction seam is called with exactly the options Patch A adds', async () => {
  // A parameter the call site passes and the patch does not add is silently dropped at merge time.
  let seen = null;
  const { deps } = makeDeps({
    extractAuditReports: async (input, _d, options) => {
      seen = options;
      return { reports: [report(input.session_id)], sessionErrors: [], deltaFailed: false };
    },
  });

  await runSync(deps, {});

  assert.deepEqual(Object.keys(seen).sort(), ['caches', 'startCursor']);
});

test('a failed dispatch records no progress at all', async () => {
  const { deps, saved } = makeDeps({
    flushBackfillChunksImpl: async (groups) => flushResult({
      bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.FAILED, reason: 'network' }])),
      retryableFailures: 1,
    }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.reportsFailed, 1);
  assert.deepEqual(saved, []);
});

test('progress whose fingerprint no longer matches the file is discarded rather than trusted', async () => {
  const { deps, syncState, saved } = makeDeps({
    // The stored cursor (4) no longer names the lines it named: the sidecar was truncated and
    // re-appended, so hashing its first 4 events now gives something else.
    sidecarSnapshotImpl: (_id, prefix) => (prefix === 4
      ? { lines: 9, fingerprint: 'v1:DIFFERENT' }
      : { lines: 9, fingerprint: 'v1:abc' }),
    // No line range on the report, so the recorded cursor comes from the snapshot — which makes
    // the stale entry's survival visible rather than coincidentally overwritten.
    extractAuditReports: async (input) => ({
      reports: [{ segmentId: `${input.session_id}:x`, sessionId: input.session_id, models: [] }],
      sessionErrors: [],
      deltaFailed: false,
    }),
  });
  syncState.sessions.s1 = { cursor: 4, fingerprint: 'v1:stale' };

  // The stale entry is gone before anything is staged — not merely overwritten at the end.
  const staleSeen = [];
  const original = deps.extractAuditReports;
  deps.extractAuditReports = async (...args) => {
    staleSeen.push(JSON.stringify(syncState.sessions.s1 == null ? null : syncState.sessions.s1));
    return original(...args);
  };

  await runSync(deps, {});

  assert.deepEqual(staleSeen, ['null'], 'the mismatched entry must be dropped, not carried forward');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].sessions.s1, {
    cursor: 9,
    fingerprint: 'v1:abc',
    at: saved[0].sessions.s1.at,
  });
});

// ─── interrupted resume, oversize, actives ──────────────────────────────────

test('an interrupted upload resumes from the server coverage on the next run', async () => {
  const covered = { s1: 2 };
  const build = () => makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, covered[id]])),
    sidecarSnapshotImpl: () => ({ lines: 9, fingerprint: 'v1:abc' }),
  });

  const first = build();
  await runSync(first.deps, {});
  covered.s1 = 9;
  const second = build();
  const result = await runSync(second.deps, {});

  assert.ok(first.order.includes('extract:s1@2'));
  assert.equal(result.upToDate, 1);
});

test('an oversize sidecar is counted and never read', async () => {
  const { deps, order } = makeDeps({
    listConversations: () => [{ ...conversation('big'), size: 80 * 1024 * 1024 }],
  });

  const result = await runSync(deps, {});

  assert.equal(result.oversize, 1);
  assert.equal(order.some((o) => o.startsWith('extract')), false);
});

test('a session active in the last day is left to live tracking', async () => {
  const { deps } = makeDeps({ lastActivityOfImpl: () => CLOCK - 1000 });

  const result = await runSync(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.candidates, 0);
});

test('a suffix that produced nothing to send counts as empty, not as a loss', async () => {
  const { deps } = makeDeps({
    extractAuditReports: async () => ({ reports: [], sessionErrors: [], deltaFailed: false }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.empty, 1);
  assert.equal(result.sessionsImported, 0);
});

test('a suffix whose sidecar could not be parsed counts as unreadable', async () => {
  const { deps } = makeDeps({
    extractAuditReports: async () => ({ reports: [], sessionErrors: [], deltaFailed: true }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.unreadable, 1);
});

// ─── cumulative money ───────────────────────────────────────────────────────

test('a resumed suffix never carries cumulative overage cost', async () => {
  let sent = null;
  const { deps } = makeDeps({
    extractAuditReports: async (input) => ({
      reports: [report(input.session_id, {
        models: [
          { model: 'm', billing_pool: 'credits', requests: 9, cost_usd: 4.2, token_input: 5 },
          { model: 'm', billing_pool: 'subscription', requests: 2 },
        ],
      })],
      sessionErrors: [],
      deltaFailed: false,
    }),
    flushBackfillChunksImpl: async (groups) => {
      sent = groups[0].reports[0];
      return flushResult({ bySession: new Map([[groups[0].sessionId, { status: BackfillSessionStatus.ACCEPTED }]]) });
    },
  });

  const result = await runSync(deps, {});

  const credits = sent.models.filter((m) => m.billing_pool === 'credits');
  assert.deepEqual(credits, [], 'a resumed suffix must not report cumulative credits spend');
  const unknown = sent.models.find((m) => m.billing_pool === 'unknown');
  assert.ok(unknown, 'the overage row must survive as explicitly unknown, not vanish');
  assert.equal(unknown.cost_usd, undefined);
  assert.equal(unknown.token_input, 5, 'event-derived token counts still sync');
  assert.equal(result.overageUnavailable, 1);
});

test('a session resumed from line 0 keeps its priced usage — there is no earlier baseline to double', async () => {
  let sent = null;
  const { deps } = makeDeps({
    fetchCoverageImpl: async (ids) => new Map(ids.map((id) => [id, 0])),
    extractAuditReports: async (input) => ({
      reports: [report(input.session_id, { models: [{ model: 'm', billing_pool: 'credits', requests: 9, cost_usd: 4.2 }] })],
      sessionErrors: [],
      deltaFailed: false,
    }),
    flushBackfillChunksImpl: async (groups) => {
      sent = groups[0].reports[0];
      return flushResult({ bySession: new Map([[groups[0].sessionId, { status: BackfillSessionStatus.ACCEPTED }]]) });
    },
  });

  const result = await runSync(deps, {});

  assert.equal(sent.models[0].billing_pool, 'credits');
  assert.equal(sent.models[0].cost_usd, 4.2);
  assert.equal(result.overageUnavailable, 0);
});

// ─── halts from the transport ───────────────────────────────────────────────

test('a server halt stops the run and leaves the remaining sessions eligible', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('s1'), conversation('s2')],
    flushBackfillChunksImpl: async (groups) => flushResult({
      halt: BackfillHalt.UNSUPPORTED_SERVER,
      bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.FAILED }])),
    }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.halt, BackfillHalt.UNSUPPORTED_SERVER);
  assert.equal(result.sessionsImported, 0);
});

// ─── flags ──────────────────────────────────────────────────────────────────

test('a dry run asks coverage but sends nothing and records no progress', async () => {
  const { deps, order, saved } = makeDeps({});

  const result = await runSync(deps, { dryRun: true });

  assert.equal(order.some((o) => o.startsWith('flush')), false);
  assert.deepEqual(saved, []);
  assert.equal(result.candidates, 1);
  assert.equal(result.plannedReports, 1);
});

// ─── flags ──────────────────────────────────────────────────────────────────

test('sync rejects --since explicitly, even when the date is malformed', () => {
  // The rejection has to come BEFORE parseArgs validates the value, or `--since garbage` answers
  // "expects a date like 2026-01-31" and sends the user off to fix a flag that does not exist here.
  for (const argv of [['--since', '2026-01-31'], ['--since', 'last tuesday'], ['--since']]) {
    assert.throws(() => parseSyncArgs(argv), (error) => {
      assert.equal(error.userFacing, true);
      assert.match(error.message, /--since/);
      assert.doesNotMatch(error.message, /expects a date/);
      return true;
    }, argv.join(' '));
  }
});

test('sync rejects --force explicitly', () => {
  assert.throws(() => parseSyncArgs(['--force']), (error) => {
    assert.equal(error.userFacing, true);
    assert.match(error.message, /--force/);
    return true;
  });
});

test('sync accepts --dry-run and sets its own mode', () => {
  assert.deepEqual(parseSyncArgs(['--dry-run']), { dryRun: true, mode: SYNC_MODE });
  assert.deepEqual(parseSyncArgs([]), { mode: SYNC_MODE });
});

// ─── lock ownership through the section (fix round 1, Critical) ─────────────

// A lock handle double: `withHeldLock` hands the guarded work one of these, and everything
// irreversible in the section is supposed to ask it first.
const heldHandle = (stillHeld) => ({ stillHeld, renew: () => stillHeld() });

test('a session whose lock was taken mid-section is deferred, not sent', async () => {
  const { deps, order } = makeDeps({
    withSessionLock: async (_sessionId, fn) => fn(heldHandle(() => false)),
  });

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 1);
  assert.equal(order.some((o) => o.startsWith('flush')), false);
});

test('a lock lost after the send records no progress', async () => {
  let lost = false;
  const { deps, saved } = makeDeps({
    withSessionLock: async (_sessionId, fn) => fn(heldHandle(() => !lost)),
    flushBackfillChunksImpl: async (groups) => {
      lost = true; // a hook broke the lock while the request was in flight
      return flushResult({
        stored: 1,
        bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])),
      });
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 0);
  assert.equal(result.deferred, 1);
  assert.deepEqual(saved, []);
});

test('a lock handle is optional — a caller that supplies none is treated as still holding', async () => {
  const { deps } = makeDeps({ withSessionLock: async (_sessionId, fn) => fn() });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 1);
});

// ─── the in-flight barrier contract (fix round 1, Important 2) ──────────────

test('a barrier that throws is a deferral, not a crashed run', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('s1'), conversation('s2')],
    inflight: {
      acquire: async (sessionId) => { if (sessionId === 's1') throw new Error('barrier exploded'); return true; },
      release: () => {},
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.deferred, 1);
  assert.equal(result.sessionsImported, 1, 'the other session must still run');
});

test('a barrier that refuses is never released', async () => {
  const released = [];
  const { deps } = makeDeps({
    inflight: { acquire: async () => false, release: (id) => released.push(id) },
  });

  await runSync(deps, {});

  assert.deepEqual(released, []);
});

// ─── epoch fence availability (fix round 1, Important 3) ────────────────────

test('with no epoch source at all the run halts rather than sending unfenced', async () => {
  const { deps, order } = makeDeps({ authEpoch: undefined });

  const result = await runSync(deps, {});

  assert.equal(result.halt, SyncHalt.EPOCH_UNAVAILABLE);
  assert.equal(result.ok, false);
  assert.deepEqual(order, [], 'the halt must precede the drain and every request');
});

test('the typed auth result carries the fence when no separate probe is wired', async () => {
  const { deps } = makeDeps({
    authEpoch: undefined,
    getAuthState: async () => ({ state: 'ready', reason: 'none', token: 'tok', generation: 1, epoch: 'prod|t|u|1', account: null }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.halt, null);
  assert.equal(result.sessionsImported, 1);
});

// ─── partial acknowledgment (fix round 1, minor 6) ──────────────────────────

test('a partial acknowledgment records no cursor — some of those reports never landed', async () => {
  const { deps, saved } = makeDeps({
    flushBackfillChunksImpl: async (groups) => flushResult({
      stored: 1,
      itemErrors: 1,
      bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.PARTIAL, reason: 'no repo' }])),
    }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.equal(result.partial, 1);
  assert.deepEqual(saved, [], 'a cursor spanning unacknowledged reports must not be recorded');
});

test('sync accepts --history, the read-only discovery surface', () => {
  assert.deepEqual(parseSyncArgs(['--history']), { history: true, mode: SYNC_MODE });
  assert.equal(parseSyncArgs(['--dry-run']).history, undefined);
});

// ── the ownership fence is a WIRING fact, not just a lock.mjs fact ──────────────────────

// `runSync`'s guarded section legitimately runs for MINUTES — a 60 s coverage query, a whole-sidecar
// parse and a 60 s upload — while `withLock` self-breaks at 30 s. Two failures come out of using the
// plain lock here, and both are silent:
//
//   1. a live hook finds a 30-second-old lock, correctly concludes its holder is dead, breaks it,
//      and enqueues a window overlapping the one sync is about to send. Two segmentIds for the same
//      lines is double-billed money that no dashboard can show.
//   2. sync's own `finally` then deletes what is now the HOOK's lock.
//
// `withHeldLock` fixes both with an owner token and a heartbeat, and `runSync` defaults to it. But
// the FIX IS INERT UNLESS IT IS WIRED: the section asks `held.stillHeld()` before the send, and a
// plain `withLock` hands the callback no handle at all, which the code treats as "still holding" —
// deliberately, so a test double does not read as a refusal to work. That leniency is exactly why
// the default needs an assertion of its own, and why this test injects `withLock` to prove the
// fence really does go dead when it is.
function realHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-syncfence-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Steal the lock the way a live hook does when it decides the holder is dead: remove the directory
// and take it again. The owner token inside is then somebody else's.
function stealLock(sessionId) {
  const lockPath = sessionLockPath(sessionId);
  fs.rmSync(lockPath, { recursive: true, force: true });
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), 'some-other-process');
}

test('the default session lock is the OWNED one: a stolen lock defers the send', async (t) => {
  realHome(t);
  // `withSessionLock: undefined` means the real default, which is what this test is about.
  const { deps, order } = makeDeps({
    withSessionLock: undefined,
    extractAuditReports: async (input, _d, options) => {
      order.push(`extract:${input.session_id}@${options.startCursor}`);
      // A hook broke in while we were parsing. Everything after this point is being done by a
      // process that no longer owns this session.
      stealLock(input.session_id);
      return { reports: [report(input.session_id)], sessionErrors: [], deltaFailed: false };
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.reportsStored, 0, 'the send was refused');
  assert.equal(
    order.some((step) => step.startsWith('flush:')),
    false,
    'nothing reached the upload at all',
  );
  assert.ok(order.includes('extract:s1@2'), 'and the extraction really did run first');
});

test('injecting a plain withLock drops the fence — which is why the default must not be one', async (t) => {
  realHome(t);
  // The regression this pins, stated as the failure it is: with the unowned lock the identical
  // theft goes UNNOTICED and the overlapping window is sent. If someone ever changes runSync's
  // default from `withHeldLock` to `withLock`, the test above starts reporting this behaviour and
  // fails, because a `withLock` section is handed no handle and `stillHeld()` becomes a constant.
  const { deps, order } = makeDeps({
    withSessionLock: async (sessionId, fn, options) =>
      withLock(sessionLockPath(sessionId), fn, options == null ? {} : options),
    extractAuditReports: async (input, _d, options) => {
      order.push(`extract:${input.session_id}@${options.startCursor}`);
      stealLock(input.session_id);
      return { reports: [report(input.session_id)], sessionErrors: [], deltaFailed: false };
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.reportsStored, 1, 'the plain lock cannot tell it was broken');
  assert.ok(order.some((step) => step.startsWith('flush:')), 'so the overlapping window went out');
});

// A known residual, recorded rather than fixed here: there is NO wall-clock bound on the held
// section. `withHeldLock` renews its lock for as long as the section runs, so a sync over hundreds
// of sessions holds each session's lock for as long as that session's coverage query, parse and
// upload take — and a live hook arriving in that window is a legitimate miss that reports nothing.
// The work is not lost (the cursor stands still and the next hook re-examines the window), but the
// checkpoint IS skipped, and no test here can turn that into a failure because it is the intended
// behaviour of both halves. Bounding the held section belongs to whoever owns sync's throughput.

// ─── the timeline rides with the group (R6 / R11) ───────────────────────────
//
// A session first seen by sync used to upload reports with no timeline, so it had no periods and no
// subagent lanes (Cursor CLI lanes included — those are recovered inside computeSessionTimeline)
// until some later live checkpoint happened to post one. Sync now carries it exactly as the
// one-time backfill does: best-effort, inside the group, counted in `bytes`.

const laneTimeline = {
  periods: [{ state: 'working', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z' }],
  plan_events: [],
  subagents: [{ agent_id: 'k1', agent_type: 'generalPurpose', started_at: '2026-01-01T00:00:10.000Z', ended_at: '2026-01-01T00:00:40.000Z' }],
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: '2026-01-01T00:01:00.000Z',
  generated_at: '2026-01-01T00:02:00.000Z',
};

test('the uploaded group carries the session timeline, lanes and all, and its bytes count it', async () => {
  const asked = [];
  let sent = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: (id) => { asked.push(id); return laneTimeline; },
    flushBackfillChunksImpl: async (groups) => {
      sent = groups;
      return flushResult({ bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])) });
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.equal(result.timelinesOffered, 1);
  assert.deepEqual(asked, ['s1']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].timeline, { sessionId: 's1', ...laneTimeline });
  assert.deepEqual(sent[0].timeline.subagents.map((s) => s.agent_id), ['k1']);
  assert.equal(
    sent[0].bytes,
    Buffer.byteLength(JSON.stringify({ reports: sent[0].reports, timeline: sent[0].timeline }), 'utf-8'),
  );
});

test('an empty timeline is not attached', async () => {
  let sent = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => ({ ...laneTimeline, periods: [], subagents: [] }),
    flushBackfillChunksImpl: async (groups) => {
      sent = groups;
      return flushResult({ bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])) });
    },
  });

  await runSync(deps, {});

  assert.equal(sent[0].timeline, null);
});

test('a timeline that throws never blocks the upload', async () => {
  let sent = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => { throw new Error('unparseable sidecar'); },
    flushBackfillChunksImpl: async (groups) => {
      sent = groups;
      return flushResult({ bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])) });
    },
  });

  const result = await runSync(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.equal(sent[0].reports.length, 1);
  assert.equal(sent[0].timeline, null);
});

test('a session that ships nothing never pays for a timeline', async () => {
  let calls = 0;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => { calls += 1; return laneTimeline; },
    extractAuditReports: async () => ({ reports: [], sessionErrors: [], deltaFailed: false }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.empty, 1);
  assert.equal(calls, 0);
});

test('timelines the server refused are counted, so a silent strip is visible', async () => {
  // audit-flush retries a chunk without its timelines when the route 400s on the field; the
  // usage still lands, and only this counter says the lanes did not.
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => laneTimeline,
    flushBackfillChunksImpl: async (groups) => flushResult({
      timelinesDropped: 1,
      bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED }])),
    }),
  });

  const result = await runSync(deps, {});

  assert.equal(result.timelinesOffered, 1);
  assert.equal(result.timelinesDropped, 1);
  assert.equal(result.timelines, 0);
});
