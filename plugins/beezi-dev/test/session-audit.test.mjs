import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runAudit, shouldFinalize } from '../lib/session-audit.mjs';
import { BackfillSessionStatus, BackfillHalt } from '../lib/audit-flush.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

// Fixed test clock, far past every fixture mtime + the 1-day activity window.
const CLOCK = 40 * 24 * 60 * 60 * 1000;

const conversation = (sessionId, mtimeMs = 1_000) => ({
  sessionId,
  eventsPath: `C:/home/.beezi-cursor/events/${sessionId}.jsonl`,
  mtimeMs,
  size: 1024,
});

// A segment carrying real, billable usage — which is what every test in this file means by "a
// report" unless it says otherwise. The usage fields are not decoration: the zero-usage skip below
// holds back a session whose reports are ALL barren, so a fixture of `{segmentId, sessionId}`
// alone would take that branch and quietly turn most of this file into assertions about the wrong
// path.
const report = (sessionId) => ({
  segmentId: `${sessionId}:0-1`,
  sessionId,
  remote: 'r',
  branch: 'main',
  token_total: 1_200,
  models: [{ model: 'claude-4.5-sonnet', billing_pool: 'subscription', requests: 1 }],
  duration_sec: 42,
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

// Sibling of flushResult for the other shape the audit consumes: a test states only the field it
// is about, and a new one costs one edit here instead of one per test.
const checkpointResult = (over = {}) => ({
  enqueued: 0,
  flush: null,
  sessionErrors: [],
  deltaFailed: false,
  ...over,
});

// A flush double that accepts everything it is handed and records the call.
function fakeFlush(statusFor = () => BackfillSessionStatus.ACCEPTED) {
  const calls = [];
  const impl = async (groups, _token, _deps, options) => {
    calls.push({ groups, options });
    const bySession = new Map();
    let stored = 0;
    let retryableFailures = 0;
    for (const g of groups) {
      const status = statusFor(g.sessionId);
      bySession.set(g.sessionId, { status, reason: null });
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        stored += g.reports.length;
      }
      if (status === BackfillSessionStatus.FAILED) retryableFailures += 1;
    }
    return flushResult({ stored, retryableFailures, bySession });
  };
  return { impl, calls };
}

function makeDeps(overrides = {}) {
  const events = [];
  const saved = [];
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
  const deps = {
    now: () => CLOCK,
    getAccessToken: async () => 'tok',
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listConversations: () => [conversation('s1')],
    // Real activity == mtime unless a test says otherwise; the restamp cases override this.
    lastActivityOfImpl: (entry) => entry.mtimeMs,
    // No credentials file on the test machine — the linkedAt fallback must never stat the real
    // home directory of whoever runs the suite.
    statImpl: () => { throw new Error('ENOENT'); },
    firstRecordedCwd: () => 'C:/work/app',
    liveCursorOfImpl: () => 0,
    // The real one loads the persisted repo map off disk; the suite must never read the home
    // directory of whoever runs it.
    createCheckpointCachesImpl: () => ({
      rootCache: new Map(),
      remoteCache: new Map(),
      timelineCache: new Map(),
      map: { version: 1, roots: {} },
    }),
    readTrackingStateImpl: () => null,
    markBackfillCompletedImpl: () => events.push('mark-completed'),
    completeBackfillImpl: async () => {
      events.push('complete');
      return { completed: true, code: null };
    },
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
    flushBackfillChunksImpl: async (groups) => {
      events.push('flush');
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({
        stored: groups.length,
        timelines: groups.filter((g) => g.timeline).length,
        bySession,
      });
    },
    loadLedgerImpl: () => ledger,
    saveLedgerImpl: (l) => saved.push(JSON.parse(JSON.stringify(l))),
    computeSessionTimelineImpl: () => ({ periods: [{ state: 'working' }], plan_events: [], subagents: [] }),
    postSessionErrorImpl: async () => { events.push('error'); return { reported: true }; },
    ...overrides,
  };
  return { deps, events, saved, ledger };
}

// ─── parseArgs ──────────────────────────────────────────────────────────────

test('parses all three flags', () => {
  const args = parseArgs(['--force', '--dry-run', '--since', '2026-01-31']);

  assert.equal(args.force, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.since, '2026-01-31');
  assert.equal(args.sinceMs, Date.parse('2026-01-31'));
});

test('defaults to no flags', () => {
  assert.deepEqual(parseArgs([]), {});
});

test('rejects a malformed --since with a user-facing error', () => {
  assert.throws(() => parseArgs(['--since', 'last tuesday']), (error) => {
    assert.equal(error.userFacing, true);
    assert.match(error.message, /--since expects a date/);
    return true;
  });
});

test('rejects a well-formatted but impossible --since date', () => {
  assert.throws(() => parseArgs(['--since', '2026-13-45']), /--since expects a date/);
});

// ─── candidate selection ────────────────────────────────────────────────────

test('bails without a token and never scans', async () => {
  const { deps } = makeDeps({ getAccessToken: async () => null, listConversations: () => { throw new Error('scanned'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'no-token');
  assert.equal(result.ok, false);
});

test('excludes sessions already in the ledger', async () => {
  const { deps, ledger } = makeDeps({ listConversations: () => [conversation('s1'), conversation('s2')] });
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, {});

  assert.equal(result.alreadyImported, 1);
  assert.equal(result.candidates, 1);
});

test('--force ignores the ledger', async () => {
  const flush = fakeFlush();
  const { deps, ledger } = makeDeps({ flushBackfillChunksImpl: flush.impl });
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, { force: true });

  assert.equal(result.alreadyImported, 0);
  assert.equal(result.candidates, 1);
  assert.equal(flush.calls.length, 1);
});

// A conversation with real activity inside the window is probably OPEN in another window —
// backfilling it would re-segment lines its next live checkpoint also reports. This is also what
// excludes the conversation the login skill itself runs in.
test('skips recently-active conversations', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('old', 1_000), conversation('open', CLOCK - 60_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.candidates, 1);
});

// Cursor re-fires session_end for every still-open tab on restart, so a tab forgotten for a week
// has a fresh mtime on every launch. The window keys on real activity, not the file mtime — or
// such a session reads as active forever and never uploads.
test('a freshly-restamped sidecar whose real activity is old is a candidate, not active', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('forgotten-tab', CLOCK - 60_000)], // mtime: 1 min ago
    lastActivityOfImpl: () => CLOCK - 6 * 24 * 60 * 60 * 1000, // last gen/stop: six days ago
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 0);
  assert.equal(result.candidates, 1);
  assert.equal(result.sessionsImported, 1);
});

test('a session holding only lifecycle noise is a candidate and reads as empty', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('noise-only', CLOCK - 60_000)],
    lastActivityOfImpl: () => null, // nothing but session_end lines
    runCheckpointImpl: async () => checkpointResult(),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 0);
  assert.equal(result.candidates, 1);
  assert.equal(result.empty, 1);
});

// Live-tracking tenants: everything after the machine link was tracked live; re-sending it
// through the audit would re-segment on different boundaries and double-count.
test('live-mode tenants only upload conversations predating the machine link', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: false }),
    statImpl: () => ({ mtimeMs: 5_000 }),
    listConversations: () => [conversation('before-link', 1_000), conversation('after-link', 9_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.candidates, 1);
});

// The stamp is the real signal; the credentials mtime is only a fallback for links made before it
// existed. On real-credential-store machines that file never exists, so a stat-only cutoff
// returned null and the guard above silently never fired.
test('the link cutoff comes from the tracking stamp, not the credentials file', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(5_000).toISOString(),
    }),
    // No credentials file on this machine — a stat-only implementation gives up here.
    statImpl: () => { throw new Error('ENOENT'); },
    listConversations: () => [conversation('before-link', 1_000), conversation('after-link', 9_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.candidates, 1);
});

// The link comparison keys on activity too — a restart restamp must not promote pre-link work
// into "tracked live" and skip it forever (mtime lands after linkedAt, the actual work before).
test('a restamped pre-link session is not classified live-tracked off its mtime', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(CLOCK - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    listConversations: () => [conversation('restamped', CLOCK - 60_000)], // mtime after the link
    lastActivityOfImpl: () => CLOCK - 6 * 24 * 60 * 60 * 1000, // work before the link, long quiet
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 0);
  assert.equal(result.active, 0);
  assert.equal(result.candidates, 1);
});

// The belt also outranks the active window: a session live tracking already queued can never be
// backfilled, so it must read as live-tracked (permanent), not active (a phantom seal-blocker
// for a day after its last message).
test('a recently-active session with an advanced live cursor counts live-tracked, not active', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(CLOCK - 60_000).toISOString(),
    }),
    liveCursorOfImpl: () => 3,
    listConversations: () => [conversation('open-tracked', CLOCK - 60 * 60 * 1000)], // pre-link activity
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.active, 0);
  assert.equal(result.activePreLink, 0);
});

// The ledger is bound to the ACCOUNT when one is known: the pull is per (tenant, user, tool)
// and the client id changes on every login, so binding to the id would wipe the pull's progress
// on every same-account re-login.
test('the ledger binds to the account, with the client id only as fallback', async () => {
  let askedIdentity = 'unset';
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false, email: 'Me@X.io' }),
    loadLedgerImpl: (identity) => {
      askedIdentity = identity;
      return { version: 1, identity, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
    },
  });

  await runAudit(deps, {});

  assert.match(askedIdentity, /\|me@x\.io$/);
});

// The belt is account-scoped (liveCursorOf): the audit must hand it the account this run
// reports under, or a workspace switch keeps skipping history the new tenant never received.
test('the belt receives the account this run reports under', async () => {
  let seenAccount = 'unset';
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false, email: 'Me@X.io' }),
    liveCursorOfImpl: (_id, opts) => { seenAccount = opts?.account; return 0; },
  });

  await runAudit(deps, {});

  assert.match(seenAccount, /\|me@x\.io$/);
});

// The Cursor-specific belt: a session whose state cursor ever advanced has queued live segments,
// whatever the tracking mode says — a backfilled `id:0-M` beside a live `id:0-N` has a different
// segmentId, so the server's idempotency upsert cannot collapse the overlap.
test('a session with an advanced live cursor is skipped even without a tracking state', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => null,
    liveCursorOfImpl: (id) => (id === 'tracked-live' ? 7 : 0),
    listConversations: () => [conversation('tracked-live'), conversation('never-tracked')],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.liveTracked, 1);
  assert.equal(result.candidates, 1);
});

// Every candidate that yields no report used to vanish between `candidates` and
// `sessionsImported` with nothing printed. Each cause has its own counter.
test('a candidate with no usage data counts as empty, not as a loss', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('has-usage'), conversation('no-usage')],
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'has-usage') options.sink(report(input.session_id));
      return checkpointResult();
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 2);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.empty, 1);
  assert.equal(result.zeroUsage, 0);
  assert.equal(result.unreadable, 0);
  // Nothing to upload is not a failure — it must not hold the one-time pull open.
  assert.equal(result.finalized, true);
});

// ─── the zero-usage skip ────────────────────────────────────────────────────
//
// A conversation that was opened, restamped by session_end on a few app restarts and closed does
// parse into a report — it just has nothing on it. Uploading one creates a session row with no
// usage, no models and no time: an afternoon in the user's history that they never spent.

const zeroReport = (sessionId, over = {}) => ({
  ...report(sessionId),
  token_total: 0,
  models: [],
  duration_sec: 0,
  ...over,
});

test('a session whose every report is barren is skipped, not uploaded', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('lifecycle-only'), conversation('real', 2_000)],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(
        input.session_id === 'lifecycle-only'
          ? zeroReport(input.session_id)
          : { ...report(input.session_id), token_total: 900, models: [{ model: 'm' }], duration_sec: 30 },
      );
      return checkpointResult({ enqueued: 1 });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.zeroUsage, 1);
  assert.equal(result.empty, 0);
  assert.equal(result.sessionsImported, 1);
  assert.deepEqual(flush.calls[0].groups.map((g) => g.sessionId), ['real']);
  // Nothing a re-run could deliver, so it must not hold the one-time pull open.
  assert.equal(result.finalized, true);
});

// Duration is deliberately NOT part of the verdict for a main segment: session_end restamps can
// stretch a lifecycle shell across days of wall clock, and that span is not model usage.
test('a shell session with a long wall-clock span but zero model usage is still skipped', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('week-old-tab')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(zeroReport(input.session_id, { duration_sec: 6 * 24 * 60 * 60 }));
      return checkpointResult({ enqueued: 1 });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.zeroUsage, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(flush.calls.length, 0);
});

// Cursor proxies every model call through its own backend, so a segment that cost real money
// reports ZERO tokens and carries its spend in the models rows instead. Skipping on tokens alone
// would drop nearly every paid session on the machine.
test('a zero-token report with models rows is real spend and uploads', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('paid')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(
        zeroReport(input.session_id, {
          models: [{ model: 'claude-4.5-sonnet', billing_pool: 'credits', requests: 4, cost_usd: 0.34 }],
        }),
      );
      return checkpointResult({ enqueued: 1 });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.zeroUsage, 0);
  assert.equal(result.sessionsImported, 1);
});

// A subagent segment is zero-token by construction and, on a replay with no anchor to fall back
// on, can be zero-models too. Its `duration_sec` is the delegated time the backfill exists to
// recover — the whole point of teaching audit mode to correlate subagents at all.
test('a zero-token zero-models report that bills duration still uploads', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('delegated')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(zeroReport(input.session_id, { duration_sec: 600, is_subagent: true }));
      return checkpointResult({ enqueued: 1 });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.zeroUsage, 0);
  assert.equal(result.sessionsImported, 1);
});

// `every`, never `some`. A barren main segment beside a subagent segment carrying real seconds is
// exactly the shape a delegating session takes, and a `some` here would throw that time away.
test('a barren main segment does not drag a billable subagent segment down with it', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('mixed')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(zeroReport(input.session_id));
      options.sink(zeroReport(input.session_id, { duration_sec: 600, is_subagent: true }));
      return checkpointResult({ enqueued: 2 });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.zeroUsage, 0);
  assert.equal(result.sessionsImported, 1);
  assert.equal(flush.calls[0].groups[0].reports.length, 2);
});

// The seal is one-time per account and tool, and --force skips only the local caches. Sealing
// over a sidecar we merely failed to READ loses that session permanently.
test('an unreadable sidecar is counted and keeps the pull open', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('unreadable')],
    runCheckpointImpl: async () => checkpointResult({ deltaFailed: true }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.empty, 0);
  assert.equal(result.finalized, false);
});

test('a throwing checkpoint counts as unreadable and keeps the pull open', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('boom')],
    runCheckpointImpl: async () => { throw new Error('ENOENT'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(result.finalized, false);
});

// EACCES reads exactly like transient I/O at the call site. Without a bound, one such file would
// hold the pull open on every future login and the summary would tell the user to re-run forever.
test('a sidecar that fails twice stops blocking the seal on the second run', async () => {
  // Another session already imported: the pull exists, so only the unreadable file's retry
  // status decides whether the seal may fire.
  const ledger = {
    version: 1,
    identity: null,
    sessions: { imported: { outcome: 'accepted' } },
    unreadable: {},
    complete: false,
    updatedAt: null,
  };
  const make = () =>
    makeDeps({
      listConversations: () => [conversation('always-broken')],
      runCheckpointImpl: async () => { throw new Error('EACCES'); },
      loadLedgerImpl: () => ledger,
      saveLedgerImpl: () => {},
    }).deps;

  const first = await runAudit(make(), {});
  assert.equal(first.unreadable, 1);
  assert.equal(first.retriableUnreadable, 1);
  assert.equal(first.finalized, false, 'first failure earns a retry');

  const second = await runAudit(make(), {});
  assert.equal(second.unreadable, 1, 'still reported to the user');
  assert.equal(second.retriableUnreadable, 0, 'but no longer blocking');
  assert.equal(second.finalized, true, 'the pull can seal');
});

test('--since drops conversations older than the cutoff', async () => {
  const { deps } = makeDeps({
    listConversations: () => [conversation('old', 1_000), conversation('new', 9_000)],
  });

  const result = await runAudit(deps, { sinceMs: 5_000 });

  assert.equal(result.candidates, 1);
});

test('skips a sidecar too large to parse safely', async () => {
  const { deps } = makeDeps({
    listConversations: () => [{ ...conversation('huge'), size: 128 * 1024 * 1024 }],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.oversize, 1);
  assert.equal(result.candidates, 0);
});

test('an unreadable sidecar is skipped without ending the run', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listConversations: () => [conversation('bad'), conversation('good')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'bad') throw new Error('unreadable');
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.deepEqual(flush.calls[0].groups.map((g) => g.sessionId), ['good']);
});

// ─── identity binding ───────────────────────────────────────────────────────

// A ledger recorded under another login must be ignored — replaying it would find zero
// candidates and seal the NEW tenant's pull empty.
test('a foreign-identity ledger is discarded, never trusted into a seal', async () => {
  let askedIdentity = 'unset';
  const { deps, events } = makeDeps({
    loadLedgerImpl: (identity) => {
      askedIdentity = identity;
      // loadLedger's contract: a mismatched identity yields a FRESH ledger.
      return { version: 1, identity, sessions: {}, complete: false, updatedAt: null };
    },
    listConversations: () => [conversation('s1')],
  });

  const result = await runAudit(deps, {});

  assert.notEqual(askedIdentity, 'unset');
  assert.equal(result.candidates, 1);
  assert.ok(events.includes('flush'));
});

// ─── server-side already-used verification ─────────────────────────

// The server is the authority: wiping ~/.beezi-cursor (or a fresh reinstall) must not let the
// pull run again once it was used. Nothing is scanned — the run stops on the whoami verdict.
test('a server-sealed pull stops before scanning and heals the local cache', async () => {
  const events = [];
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'backfill_only', backfillCompleted: true }),
    markBackfillCompletedImpl: () => events.push('mark-completed'),
    listConversations: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already-completed');
  assert.equal(result.upgradeAdvised, true, 'a dark workspace gets the upgrade suggestion');
  assert.deepEqual(events, ['mark-completed']);
});

test('--force never bypasses the server verdict', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'backfill_only', backfillCompleted: true }),
    listConversations: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, { force: true });

  assert.equal(result.reason, 'already-completed');
});

test('a live-tracking tenant with a sealed pull gets no upgrade nag', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: true }),
    listConversations: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'already-completed');
  assert.equal(result.upgradeAdvised, false);
});

// Offline or old server: the check is advisory — the run proceeds and the chunk-level
// ALREADY_COMPLETED guard remains the backstop.
test('an unreachable whoami never blocks the run', async () => {
  const { deps } = makeDeps({ whoamiImpl: async () => { throw new Error('offline'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.finalized, true);
});

// ─── delivery + follow-ups ──────────────────────────────────────────────────

// Timelines ride IN the chunk payload: the flush sees them attached to their session group,
// and the run still finalizes off the flush verdicts alone.
test('attaches the computed timeline to its session group, then finalizes', async () => {
  let seenGroups = null;
  const { deps, events } = makeDeps();
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.deepEqual(events, ['flush', 'complete', 'mark-completed']);
  assert.equal(seenGroups.length, 1);
  assert.equal(seenGroups[0].timeline.sessionId, 's1');
  assert.deepEqual(seenGroups[0].timeline.periods, [{ state: 'working' }]);
  assert.equal(result.timelines, 1);
});

test('an empty timeline is not attached at all', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => ({ periods: [], plan_events: [], subagents: [] }),
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.timelines, 0);
  assert.equal(result.sessionsImported, 1);
});

test('posts buffered rate-limit errors after the flush', async () => {
  const { deps, events } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }] };
    },
  });

  const result = await runAudit(deps, {});

  // Order is the whole assertion: a follow-up may only be posted for a session the server has
  // already accepted, or it would attach an error to a session row that does not exist.
  assert.deepEqual(events.slice(0, 2), ['flush', 'error']);
  assert.equal(result.sessionsImported, 1);
});

// Dark-mode tenants: the errors route is tracking-gated — their audit is usage-only.
test('follow-ups are skipped entirely when tracking is not live', async () => {
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'backfill_only', backfillCompleted: false }),
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }] };
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('error'));
  assert.equal(result.followupsAllowed, false);
  assert.equal(result.sessionsImported, 1);
});

// A broken sidecar's timeline must never block the usage upload: the group ships without it.
test('a timeline that fails to compute never blocks the upload', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => { throw new Error('unparseable sidecar'); },
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.finalized, true);
});

// The one-deep pipeline: while a batch is in flight, the loop keeps parsing the next
// sessions instead of idling on the upload.
test('parsing continues while a dispatched batch is in flight', async () => {
  const order = [];
  const sessions = Array.from({ length: 51 }, (_u, i) => conversation(`s${i}`));
  const { deps } = makeDeps({
    listConversations: () => sessions,
    runCheckpointImpl: async (input, _d, options) => {
      order.push(`parse:${input.session_id}`);
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
    flushBackfillChunksImpl: async (groups) => {
      order.push(`flush-start:${groups.length}`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`flush-end:${groups.length}`);
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({ stored: groups.length, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 51);
  assert.equal(result.finalized, true);
  const firstStart = order.indexOf('flush-start:50');
  const firstEnd = order.indexOf('flush-end:50');
  assert.ok(firstStart >= 0 && firstEnd > firstStart, 'first batch was dispatched');
  const overlapped = order
    .slice(firstStart + 1, firstEnd)
    .some((event) => event.startsWith('parse:'));
  assert.ok(overlapped, 'no session was parsed while the first batch was in flight');
});

test('drives runCheckpoint in audit mode with the recorded cwd', async () => {
  let seen = null;
  const { deps } = makeDeps({
    firstRecordedCwd: (id) => (id === 's1' ? 'C:/work/app' : null),
    runCheckpointImpl: async (input, _d, options) => {
      seen = { input, options };
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
  });

  await runAudit(deps, {});

  assert.equal(seen.input.session_id, 's1');
  assert.equal(seen.input.cwd, 'C:/work/app');
  // ONE word, not the four booleans this used to thread. The behaviours it selects — no flush, a
  // from-line-0 parse that is never written back, buffered error reports, and the whole-sidecar
  // read the subagent correlation needs — are pinned in test/checkpoint.test.mjs, next to the code
  // that derives them. Threading them from here is what let the fifth one stay switched off.
  assert.equal(seen.options.mode, 'audit');
});

// One bag of git facts for the whole run. Without it every candidate re-spawned git to re-answer
// questions the run had already answered — ~99 ms per session, so 20-40 s of nothing on a machine
// with a few hundred of them.
test('every candidate shares one git-fact cache bag', async () => {
  const bags = new Set();
  const { deps } = makeDeps({
    listConversations: () => [conversation('s1'), conversation('s2', 2_000), conversation('s3', 3_000)],
    runCheckpointImpl: async (input, _d, options) => {
      bags.add(options.caches);
      options.sink(report(input.session_id));
      return { enqueued: 1, flush: null, sessionErrors: [] };
    },
  });

  await runAudit(deps, {});

  assert.equal(bags.size, 1, 'a per-session bag caches nothing across sessions');
  assert.ok([...bags][0] != null, 'and the bag is really passed, not merely undefined every time');
});

// ─── ledger ─────────────────────────────────────────────────────────────────

test('ledgers a rejected session so it is not resent every run', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.REJECTED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1).sessions['s1'].outcome, BackfillSessionStatus.REJECTED);
});

test('does NOT ledger a session the server never judged', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.FAILED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1)?.sessions['s1'], undefined);
});

// ─── finalization ───────────────────────────────────────────────────────────

test('a fully clean run calls /complete exactly once and marks completion', async () => {
  const { deps, events, saved } = makeDeps();

  const result = await runAudit(deps, {});

  assert.equal(events.filter((e) => e === 'complete').length, 1);
  assert.equal(result.finalized, true);
  assert.equal(saved.at(-1).complete, true);
});

test('a run with a retryable failure does not finalize', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.FAILED);
  const { deps, events } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('per-item rejections (unconnected repo) do NOT block finalization', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.REJECTED);
  const { deps, events } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  const result = await runAudit(deps, {});

  assert.ok(events.includes('complete'));
  assert.equal(result.finalized, true);
});

test('whole-chunk permanent rejections DO block finalization', async () => {
  const { deps, events } = makeDeps({
    flushBackfillChunksImpl: async (groups) => {
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.REJECTED, reason: 'HTTP 413' }]),
      );
      return flushResult({ permanentRejections: 1, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('an unattributed chunk blocks finalization', async () => {
  const { deps, events } = makeDeps({
    flushBackfillChunksImpl: async (groups) => {
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.UNATTRIBUTED, reason: 'unreadable-response' }]),
      );
      return flushResult({ unattributed: 1, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('--since never finalizes (a scoped run must not seal a partial dataset)', async () => {
  const { deps, events } = makeDeps({ listConversations: () => [conversation('new', 9_000)] });

  const result = await runAudit(deps, { sinceMs: 5_000 });

  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

// The seal is one-time. An ACTIVE session whose activity predates the link gets exactly one
// chance to upload — a later login, once it has gone quiet. Sealing now takes that chance away.
// A post-link active never blocks: live tracking owns it from here.
test('a pre-link active session holds the seal open; the clean import still uploads', async () => {
  const linkedAt = CLOCK - 30 * 60 * 1000;
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(linkedAt).toISOString(),
    }),
    listConversations: () => [
      conversation('quiet-old', 1_000),
      conversation('open-pre-link', CLOCK - 60 * 60 * 1000), // active AND pre-link
    ],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.activePreLink, 1);
  assert.equal(result.sessionsImported, 1, 'the quiet session still uploads');
  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

test('the login conversation (active, post-link) never blocks the seal', async () => {
  const linkedAt = CLOCK - 60 * 60 * 1000;
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({
      trackingMode: 'live',
      backfillCompleted: false,
      linkedAt: new Date(linkedAt).toISOString(),
    }),
    listConversations: () => [
      conversation('quiet-old', 1_000),
      conversation('login-convo', CLOCK - 60_000), // active, post-link
    ],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.activePreLink, 0);
  assert.equal(result.finalized, true);
  assert.ok(events.includes('complete'));
});

// Machines linked before the linkedAt stamp existed (and with no credentials file to stat) have
// no link instant. Parity with the Claude plugin: actives do not block there.
test('with no link instant anywhere, active sessions do not block the seal', async () => {
  const { deps } = makeDeps({
    readTrackingStateImpl: () => null,
    listConversations: () => [conversation('quiet-old', 1_000), conversation('open', CLOCK - 60_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.activePreLink, 0);
  assert.equal(result.finalized, true);
});

// ─── seal requires an opened pull ───────────────────────────────────────────

// Zero sessions ever stored → the server never opened a pull → /complete is ignored with a
// server-side warning while the 2xx it answers poisons every local cache into "completed".
// The seal must not be attempted at all until something was actually delivered.
test('complete is never POSTed when nothing was ever imported', async () => {
  const { deps, events } = makeDeps({
    runCheckpointImpl: async () => checkpointResult(), // parses fine, holds no usage
  });

  const result = await runAudit(deps, {});

  assert.equal(result.empty, 1);
  assert.ok(!events.includes('complete'));
  assert.ok(!events.includes('mark-completed'));
  assert.equal(result.finalized, false);
  assert.equal(result.pullOpened, false);
});

test('candidates=0 with an empty ledger does not retry the seal either', async () => {
  const { deps, events } = makeDeps({
    listConversations: () => [conversation('open', CLOCK - 60_000)], // only an active session
  });

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 0);
  assert.ok(!events.includes('complete'));
  assert.equal(result.finalized, false);
});

// ─── local-cache poisoning heal ─────────────────────────────────────────────

// A /complete POSTed against a never-opened pull was ignored server-side but answered 2xx — a
// machine that ran that sequence has completed=true in every local cache while the server holds
// nothing. The server's word beats the caches: reachable and "not completed" → rescan.
test('a reachable server saying not-completed overrides a poisoned local cache', async () => {
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: true }),
    loadLedgerImpl: () => ({
      version: 1,
      identity: null,
      sessions: {},
      unreadable: {},
      complete: true,
      updatedAt: null,
    }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, null);
  assert.equal(result.sessionsImported, 1);
  assert.ok(events.includes('flush'));
});

// One lost finalize POST must not strand the pull IN_PROGRESS forever.
test('a clean all-ledgered run retries /complete exactly once', async () => {
  const { deps, events, ledger } = makeDeps();
  ledger.sessions['s1'] = { outcome: 'accepted' };

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 0);
  assert.deepEqual(events, ['complete', 'mark-completed']);
  assert.equal(result.finalized, true);
});

// The local caches are trusted only when the server cannot answer — a reachable server that
// says "not completed" overrides them (see the poisoning heal above).
test('offline, the local completed cache still exits before scanning', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => { throw new Error('offline'); },
    readTrackingStateImpl: () => ({ trackingMode: 'backfill_only', backfillCompleted: true }),
    listConversations: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'already-completed');
  assert.equal(result.ok, true);
});

test('offline, a completed ledger still exits before scanning', async () => {
  const { deps } = makeDeps({
    whoamiImpl: async () => { throw new Error('offline'); },
    loadLedgerImpl: () => ({
      version: 1,
      identity: null,
      sessions: {},
      unreadable: {},
      complete: true,
      updatedAt: null,
    }),
    listConversations: () => { throw new Error('must not scan'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'already-completed');
  assert.equal(result.ok, true);
});

test('--force bypasses the fast path so the reinstall heal stays reachable', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: true }),
    flushBackfillChunksImpl: flush.impl,
  });

  const result = await runAudit(deps, { force: true });

  assert.equal(result.reason, null);
  assert.equal(flush.calls.length, 1);
});

// The reinstall path: server says the pull is sealed → heal the local ledger and stop.
test('ALREADY_COMPLETED halts, heals the ledger and marks completion', async () => {
  const { deps, events, saved } = makeDeps({
    listConversations: () => [conversation('s1'), conversation('s2')],
    flushBackfillChunksImpl: async () => {
      events.push('flush');
      return flushResult({ halt: BackfillHalt.ALREADY_COMPLETED, bySession: new Map() });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.halt, BackfillHalt.ALREADY_COMPLETED);
  assert.equal(saved.at(-1).complete, true);
  assert.ok(events.includes('mark-completed'));
  // Halted — the finalize POST must not fire on top of the server's own seal.
  assert.ok(!events.includes('complete'));
});

// ─── dry run ────────────────────────────────────────────────────────────────

test('--dry-run sends nothing, writes no ledger, never finalizes', async () => {
  const flush = fakeFlush();
  const { deps, saved, events } = makeDeps({
    flushBackfillChunksImpl: flush.impl,
    listConversations: () => [conversation('s1'), conversation('s2')],
  });

  const result = await runAudit(deps, { dryRun: true });

  assert.equal(flush.calls.length, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(saved, []);
  assert.equal(result.plannedReports, 2);
  assert.equal(result.plannedChunks, 1);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
});

test('a session that yields no reports is not sent', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async () => ({ enqueued: 0, flush: null, sessionErrors: [] }),
  });

  const result = await runAudit(deps, {});

  assert.equal(flush.calls.length, 0);
  assert.equal(result.sessionsImported, 0);
  assert.equal(result.ok, true);
});

// ─── shouldFinalize truth table ─────────────────────────────────────────────

test('shouldFinalize truth table', () => {
  const clean = {
    ok: true,
    halt: null,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
    retriableUnreadable: 0,
    activePreLink: 0,
  };
  assert.equal(shouldFinalize(clean, {}), true);
  assert.equal(shouldFinalize({ ...clean, ok: false }, {}), false);
  assert.equal(shouldFinalize({ ...clean, halt: BackfillHalt.NOT_ALLOWED }, {}), false);
  assert.equal(shouldFinalize({ ...clean, reportsFailed: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, unattributed: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, permanentRejections: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, retriableUnreadable: 1 }, {}), false);
  assert.equal(shouldFinalize({ ...clean, activePreLink: 1 }, {}), false);
  assert.equal(shouldFinalize(clean, { sinceMs: 123 }), false);
  assert.equal(shouldFinalize(clean, { dryRun: true }), false);
});

// ─── typed authentication (08-A) ────────────────────────────────────────────
//
// The audit consumes CONTRACTS §2's typed result through `deps.getAuthState`. Only an EXPLICIT
// unlinked state is "not linked"; every held/busy/unreadable state is a temporary condition that
// must advise a retry and leave every local record exactly as it found it.

const authState = (over = {}) => ({
  state: 'ready',
  reason: 'none',
  token: 'tok',
  generation: 1,
  epoch: 'prod|t|u|1',
  account: null,
  ...over,
});

// A deps bag whose ledger/completion seams THROW: any run that reaches them fails loudly rather
// than silently proving nothing.
function authDeps(getAuthState, overrides = {}) {
  return makeDeps({
    getAuthState,
    getAccessToken: async () => { throw new Error('getAccessToken must not be consulted'); },
    listConversations: () => { throw new Error('scanned'); },
    loadLedgerImpl: () => { throw new Error('ledger loaded'); },
    markBackfillCompletedImpl: () => { throw new Error('completion touched'); },
    whoamiImpl: async () => { throw new Error('whoami called'); },
    ...overrides,
  });
}

test('an explicit unlinked auth state is the only no-token outcome', async () => {
  const { deps } = authDeps(async () => authState({ state: 'unlinked', reason: 'missing', token: null }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'no-token');
  assert.equal(result.ok, false);
});

test('a temporarily unavailable credential store advises retry and touches nothing', async () => {
  const { deps } = authDeps(async () => authState({ state: 'unavailable', reason: 'locked', token: null }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authState, 'unavailable');
  assert.equal(result.authReason, 'locked');
  assert.equal(result.retryAdvised, true);
  assert.equal(result.finalized, false);
  assert.equal(result.scanned, 0);
});

test('an in-flight refresh is unavailable, not unlinked', async () => {
  const { deps } = authDeps(async () => authState({ state: 'refreshing', reason: 'backoff', token: null }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authState, 'refreshing');
  assert.equal(result.authReason, 'backoff');
});

test('a reauth-required state is unavailable too — credentials are never discarded here', async () => {
  const { deps } = authDeps(async () => authState({ state: 'reauth_required', reason: 'invalid_grant', token: null }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authState, 'reauth_required');
});

test('a ready state with no token is unavailable, never a silent success', async () => {
  const { deps } = authDeps(async () => authState({ token: null }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authReason, 'missing');
});

test('a throwing auth probe is unavailable, never unlinked', async () => {
  const { deps } = authDeps(async () => { throw new Error('keychain exploded'); });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authState, 'unavailable');
  assert.equal(result.authReason, 'unreadable');
});

test('an unbounded or unsafe auth reason is refused rather than echoed', async () => {
  const { deps } = authDeps(async () => authState({
    state: 'unavailable',
    reason: `C:/Users/me/.beezi-cursor/credentials.json ${'x'.repeat(4000)}`,
    token: null,
  }));

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'auth-unavailable');
  assert.equal(result.authReason, null);
});

test('a ready auth state runs the audit on its token', async () => {
  const seen = [];
  const { deps } = makeDeps({
    getAuthState: async () => authState({ token: 'typed-token' }),
    getAccessToken: async () => { throw new Error('getAccessToken must not be consulted'); },
    flushBackfillChunksImpl: async (groups, token) => {
      seen.push(token);
      return flushResult({
        stored: groups.length,
        bySession: new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }])),
      });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['typed-token']);
});

test('without an injected typed probe the legacy token accessor still drives the run', async () => {
  const { deps } = makeDeps({});

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('one oversize session among successful ones is counted and never blocks the seal', async () => {
  const huge = { ...conversation('big'), size: 80 * 1024 * 1024 };
  const { deps, events } = makeDeps({ listConversations: () => [huge, conversation('s1')] });

  const result = await runAudit(deps, {});

  assert.equal(result.oversize, 1);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.finalized, true);
  assert.ok(events.includes('complete'));
});

// ─── audit timeouts (07-E audit part) ───────────────────────────────────────

test('the audit hands its own 60s budget to the rate-limit follow-up posts', async () => {
  const seen = [];
  const { deps } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return checkpointResult({ enqueued: 1, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }] });
    },
    postSessionErrorImpl: async (_payload, _token, postDeps) => {
      seen.push(postDeps);
      return { reported: true };
    },
  });

  await runAudit(deps, {});

  assert.equal(seen.length, 1);
  // postJson's 3s default exists to protect a 10s hook budget; a foreground audit that inherits it
  // reports a healthy server as unreachable.
  assert.equal(seen[0].timeoutMs, 60000);
});
