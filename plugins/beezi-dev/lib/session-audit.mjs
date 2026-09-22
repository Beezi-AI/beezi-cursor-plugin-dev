import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import {
  runCheckpoint as _runCheckpoint,
  createCheckpointCaches as _createCheckpointCaches,
  flushQueue as _flushQueue,
  CheckpointMode,
} from './checkpoint.mjs';
import {
  listAllConversations as _listAllConversations,
  firstRecordedCwd as _firstRecordedCwd,
  liveCursorOf as _liveCursorOf,
  lastActivityTs as _lastActivityTs,
  sidecarSnapshot as _sidecarSnapshot,
} from './sidecar-index.mjs';
import {
  loadLedger as _loadLedger,
  saveLedger as _saveLedger,
  loadSyncState as _loadSyncState,
  saveSyncState as _saveSyncState,
  syncProgressFor as _syncProgressFor,
  recordSyncProgress as _recordSyncProgress,
  isImported,
  markImported,
  markUnreadable,
  wasUnreadable,
  markComplete,
  isComplete,
  hasImports,
} from './audit-ledger.mjs';
import {
  flushBackfillChunks as _flushBackfillChunks,
  completeBackfill as _completeBackfill,
  planChunks,
  AuditEndpoint,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
} from './audit-flush.mjs';
import { fetchCoverage as _fetchCoverage } from './session-coverage.mjs';
import { BILLING_POOL } from './delta-cursor.mjs';
import { queueDir } from './paths-cursor.mjs';
import { sessionLockPath, withHeldLock } from './lock.mjs';
import { computeSessionTimeline as _computeSessionTimeline } from './session-timeline-cursor.mjs';
import { postSessionError as _postSessionError } from './session-error-report.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import { whoami as _whoami } from './whoami.mjs';
import {
  readTrackingState,
  matchesIdentity,
  isLiveTrackingAllowed,
  markBackfillCompleted,
  recordWhoami,
  linkedAtMs,
  currentAccountKey,
  TrackingMode,
} from './tracking.mjs';
import { UserError } from './friendly-error.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// A sidecar this big is read several times over (delta, timeline) and would put the process into
// the hundreds of MB. Report it rather than let node die mid-run. In practice pruneStale()'s
// 14-day horizon keeps sidecars far below this.
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;

// Error posts are single small upserts, so a little parallelism is free — but not unbounded,
// or a 200-session run opens 200 sockets at once.
const FOLLOWUP_CONCURRENCY = 4;

const AUDIT_TIMEOUT_MS = 60_000;

// A conversation whose last REAL activity is this recent is probably still OPEN in another
// window: its hooks are mid-flight between checkpoints, and backfilling it would re-segment the
// same lines on different boundaries than the next live report — double-counted spend. Skip and
// let a later login pick it up. This is also what excludes the login conversation itself:
// running the login skill is a tool call, and the hook it fires appends to this conversation's
// sidecar moments before the backfill lists the directory — so there is no need to guess a
// "current session id" the way the Claude plugin does from its env.
//
// Keyed on the last non-session_end event, NOT the file mtime: Cursor re-fires session_end for
// every still-open tab when the app quits or restarts, so a tab forgotten for a week has a fresh
// mtime on every launch and would read as active forever (and, worse, as "tracked live" once its
// restamp lands after the machine link). A day with no real activity is the line between "open
// and possibly resumed" and "forgotten".
const ACTIVE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// The repeatable sync mode. `options.mode === SYNC_MODE` selects `runSync` below, which shares the
// audit's candidate vocabulary and none of its one-time-seal machinery.
export const SYNC_MODE = 'sync';

// Run-ending conditions that belong to sync alone — the backfill has no equivalent, and folding
// them into BackfillHalt would let a backfill caller branch on a state it can never reach. Every
// one of them means NOTHING was uploaded and NOTHING local was changed.
export const SyncHalt = Object.freeze({
  // The server could not (or would not) say how far each session already reaches. Sending anyway
  // means re-sending windows the server holds under different segment ids, which double-bills.
  COVERAGE_UNAVAILABLE: 'coverage-unavailable',
  // The audit-only extraction seam (`deps.extractAuditReports`, an integration patch on
  // lib/checkpoint.mjs) is not wired. Sync cannot resume a session without it.
  EXTRACTION_UNAVAILABLE: 'extraction-unavailable',
  // A pending live-queue file could not be parsed, so the sessions it covers cannot be identified
  // and no session can be proven free of pending overlapping windows.
  QUEUE_UNREADABLE: 'queue-unreadable',
  // Neither a `deps.authEpoch` probe nor an epoch on the typed auth result. Without one the fence
  // is a constant, `fenceHolds()` is always true, and a relink mid-run would go unnoticed — the
  // one failure that puts an old account's history under a new account's credentials.
  EPOCH_UNAVAILABLE: 'epoch-unavailable',
});

// ── typed authentication (CONTRACTS §2)
//
// The values are mirrored here rather than imported from `lib/auth-state.mjs`: that module is the
// auth lane's and does not exist on this branch yet, and an import of a missing file would take
// every backfill down. Integration replaces this block with the real import — the strings are the
// contract, so the swap is name-for-name.
const AuditAuthState = Object.freeze({
  READY: 'ready',
  UNLINKED: 'unlinked',
});

// Why a held store is NOT "not linked".
//
// Every credential error used to collapse into `no-token`, which tells the user to run the login
// skill again — a full OAuth round trip — because another process held the keychain for a second,
// or because a refresh was in flight. The typed result separates the two: only an EXPLICIT
// `unlinked` means there is nothing to sign in with. Everything else (a locked store, an
// unreadable file, a refresh in flight, a revoked grant) is a condition the caller waits out, and
// this run must leave the ledger, the completion flags and the credentials exactly as it found
// them — which is why the check sits ahead of every read below.
const AUTH_UNAVAILABLE = 'auth-unavailable';

// A reason is a wire-ish string from another module, so it is echoed into a summary only if it is
// short and looks like an enum. A path, a stack or 4 KB of vendor text never reaches the user.
const MAX_AUTH_DETAIL = 40;
const AUTH_DETAIL_SHAPE = /^[a-z0-9][a-z0-9_.-]*$/;

export function boundedAuthDetail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '' || trimmed.length > MAX_AUTH_DETAIL) return null;
  return AUTH_DETAIL_SHAPE.test(trimmed) ? trimmed : null;
}

// One answer for "may this run send anything": `{ outcome, token, state, reason }` where outcome is
// 'ready', 'no-token' or 'auth-unavailable'.
//
// `deps.getAuthState` is the typed probe. Without it the legacy `getAccessToken()` adapter stands
// in, and keeps its historical meaning exactly: a null token is `no-token`. That fallback is a
// compatibility bridge, not a second policy — once integration wires the real probe in, the only
// way to reach `no-token` is an explicit unlinked state.
export async function resolveAuditAuth(deps = {}, { deadlineMs } = {}) {
  const getAuthState = deps.getAuthState;
  if (typeof getAuthState !== 'function') {
    const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
    const token = await getAccessToken().catch(() => null);
    // No epoch: the legacy accessor has no notion of one. Callers that need a fence must say so
    // rather than read `null` as "unchanged" — see SyncHalt.EPOCH_UNAVAILABLE.
    return token
      ? { outcome: 'ready', token, state: AuditAuthState.READY, reason: null, epoch: null }
      : { outcome: 'no-token', token: null, state: AuditAuthState.UNLINKED, reason: null, epoch: null };
  }

  let auth;
  try {
    auth = await getAuthState({ deadlineMs, interactive: false });
  } catch {
    // A probe that throws told us nothing about whether credentials exist. Guessing "unlinked"
    // here is the exact bug this task removes.
    return { outcome: AUTH_UNAVAILABLE, token: null, state: 'unavailable', reason: 'unreadable', epoch: null };
  }

  const state = auth == null ? null : auth.state;
  // Carried through rather than dropped: CONTRACTS §2 puts the request-identity epoch ON the typed
  // result, and a sender with no separate `authEpoch` probe wired has nowhere else to get it.
  const epoch = auth == null || typeof auth.epoch !== 'string' || auth.epoch === '' ? null : auth.epoch;
  // AuthReason.NONE is the absence of a reason, not a reason named "none" — carrying it forward
  // would print "(none)" at the user and, worse, mask the `missing` verdict below.
  const declared = boundedAuthDetail(auth == null ? null : auth.reason);
  const reason = declared === 'none' ? null : declared;
  if (state === AuditAuthState.UNLINKED) {
    return { outcome: 'no-token', token: null, state, reason, epoch };
  }
  const token = auth == null ? null : auth.token;
  if (state === AuditAuthState.READY && typeof token === 'string' && token !== '') {
    return { outcome: 'ready', token, state, reason, epoch };
  }
  // A `ready` with no usable token is a broken probe, not an authorization: it is held, not gone.
  return {
    outcome: AUTH_UNAVAILABLE,
    token: null,
    state: boundedAuthDetail(state) == null ? 'unavailable' : state,
    reason: state === AuditAuthState.READY && reason == null ? 'missing' : reason,
    epoch,
  };
}

// Same shape as lib/billing-capture.mjs: a plain loop, `argv[++i]` for valued flags, UserError for
// anything malformed so the script surfaces it verbatim.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--force') out.force = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--since') out.since = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
  }
  if (out.since != null) {
    const since = String(out.since);
    if (!SINCE_FORMAT.test(since) || Number.isNaN(Date.parse(since))) {
      throw new UserError('Beezi: --since expects a date like 2026-01-31.');
    }
    out.sinceMs = Date.parse(since);
  }
  return out;
}

// The sync command's flags. Deliberately its own parser rather than a post-hoc check on parseArgs'
// output: `--since garbage` would otherwise be rejected by parseArgs' date validation first, and
// the user would be told to fix the format of a flag this command does not accept at all.
//
// Neither flag is a missing feature. `--since` filters on when a session last RAN, which says
// nothing about what Beezi is missing — it would silently exclude exactly the old session whose
// upload died halfway, which is the case sync exists to repair. `--force` has nothing to force
// past: there is no one-time seal on this path.
export function parseSyncArgs(argv) {
  for (const flag of argv) {
    if (flag === '--since') {
      throw new UserError(
        'Beezi: the beezi-sync skill does not take --since — it uploads exactly what Beezi is '
          + 'missing, whenever those sessions ran. Run it with no flags.',
      );
    }
    if (flag === '--force') {
      throw new UserError(
        'Beezi: the beezi-sync skill does not take --force — there is no one-time seal to force past.',
      );
    }
  }
  const options = parseArgs(argv);
  // Read-only discovery: what history exists on this machine, from the sidecar AND from Cursor's
  // own store, counted and never uploaded (lib/history-index.mjs). It is a flag on this command
  // rather than a command of its own because it answers the question this one raises — "is that
  // really all of it?" — and because 08-C's upload half is contract-blocked.
  if (argv.indexOf('--history') !== -1) options.history = true;
  options.mode = SYNC_MODE;
  return options;
}

// Run `worker` over `items` with at most `limit` in flight.
async function mapLimited(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// A report with no model usage on it — nothing a bill could be drawn from.
//
// The two conditions are a CONJUNCTION on purpose; either alone is a routine property of
// genuinely billed work and would silently drop paid activity:
//
//   token_total === 0    is the normal case for Cursor, not the exception. Every model call is
//                        proxied through Cursor's own backend, so no usage block ever reaches this
//                        machine; a segment that cost real money reports zero tokens and carries
//                        its spend in `models[].cost_usd` and `models[].requests` instead. On its
//                        own this condition would skip nearly every session on the machine.
//   models === []        is what a lifecycle-only slice looks like: no generation line ever landed
//                        in the window, so there is no model row to carry requests or cost.
//
// Subagent segments are exempt BEFORE the conjunction: they are zero-token with empty models by
// construction (Cursor exposes no per-subagent usage anywhere; the parent's model identity is the
// only thing they could carry, and a fresh-parse replay has no anchor to take it from), and their
// `duration_sec` is precisely the delegated time the backfill exists to recover. Judging them by
// model usage would re-lose what the audit-mode parse just recovered.
//
// What remains — a main segment with zero tokens and no model rows — is the shape of a
// conversation that was opened, restamped by a few `session_end`s across app restarts, and
// closed. Its duration is deliberately NOT consulted: those restamps can stretch a shell session
// across days of wall clock, and uploading it would put a session row in the user's history that
// reports an afternoon they never spent.
function isZeroUsage(report) {
  if (report.is_subagent === true) return false;
  return (report.token_total == null ? 0 : report.token_total) === 0
    && (report.models == null ? [] : report.models).length === 0;
}

// Seal only when a re-run could not improve the outcome, and only when the run covered
// everything: any retryable failure, unattributable chunk, whole-chunk rejection, halt or scope
// flag leaves the pull open. Per-item errors[] (unconnected repos on platform tenants) and
// oversize/unreadable sidecars deliberately do NOT block — a re-run cannot help them, and
// blocking would deadlock the seal forever.
export function shouldFinalize(result, options = {}) {
  if (!result.ok) return false;
  if (options.dryRun === true) return false;
  if (options.sinceMs != null) return false;
  if (result.halt !== null) return false;
  if (result.reportsFailed > 0) return false;
  if (result.unattributed > 0) return false;
  if (result.permanentRejections > 0) return false;
  // A sidecar we could not read is a retryable failure like any other, and sealing over it
  // loses that session for good — the seal is one-time per account and tool, and --force skips
  // only the LOCAL caches, never the server's verdict. So the first failure holds the pull open.
  //
  // Only the FIRST failure, though: a permission error is indistinguishable from transient I/O at
  // the call site, so gating on every occurrence would let one permanently unreadable file block
  // the seal forever and tell the user to re-run login on a loop.
  //
  // `empty` and `zeroUsage` never block: neither has anything a re-run could deliver.
  if (result.retriableUnreadable > 0) return false;
  // A recently-active session recorded BEFORE the machine link gets exactly one chance to
  // upload — a later login, once it has gone quiet for a day. Sealing now would take that
  // chance away. Post-link actives never block: live tracking owns them from here on.
  if (result.activePreLink > 0) return false;
  return true;
}

// Backfill every past session on this machine into Beezi via the chunked backfill route, then
// seal the one-time pull. Timelines ride IN the chunk payload (the tracking-gated standalone
// timeline route is unreachable for audit tenants); only rate-limit error reports remain a
// live-only follow-up — and only for sessions the server judged accepted, so a failed session
// stays fully retryable. (Cursor's delta emits no rate-limit events today; the phase is inert
// but kept so a delta that learns to emit one needs no change here.)
export async function runAudit(deps = {}, options = {}) {
  // FIRST statement, before any binding is resolved. Sync and the one-time import share a command
  // vocabulary and almost nothing else, and the split is what makes "sync never seals" structural:
  // runSync has no finalize, no /complete and no completion write anywhere in it. A mode that fell
  // through to the code below would run the sealing path over a resumed suffix.
  if (options.mode === SYNC_MODE) return runSync(deps, options);
  const listConversations = deps.listConversations == null ? _listAllConversations : deps.listConversations;
  const recordedCwd = deps.firstRecordedCwd == null ? _firstRecordedCwd : deps.firstRecordedCwd;
  const lastActivityOf = deps.lastActivityOfImpl == null ? ((entry) => _lastActivityTs(entry.sessionId)) : deps.lastActivityOfImpl;
  const liveCursorOf = deps.liveCursorOfImpl == null ? _liveCursorOf : deps.liveCursorOfImpl;
  const runCheckpoint = deps.runCheckpointImpl == null ? _runCheckpoint : deps.runCheckpointImpl;
  const createCheckpointCaches = deps.createCheckpointCachesImpl == null ? _createCheckpointCaches : deps.createCheckpointCachesImpl;
  const flushBackfillChunks = deps.flushBackfillChunksImpl == null ? _flushBackfillChunks : deps.flushBackfillChunksImpl;
  const completeBackfill = deps.completeBackfillImpl == null ? _completeBackfill : deps.completeBackfillImpl;
  const loadLedger = deps.loadLedgerImpl == null ? _loadLedger : deps.loadLedgerImpl;
  const saveLedger = deps.saveLedgerImpl == null ? _saveLedger : deps.saveLedgerImpl;
  const computeSessionTimeline = deps.computeSessionTimelineImpl == null ? _computeSessionTimeline : deps.computeSessionTimelineImpl;
  const postSessionError = deps.postSessionErrorImpl == null ? _postSessionError : deps.postSessionErrorImpl;
  const readTracking = deps.readTrackingStateImpl == null ? readTrackingState : deps.readTrackingStateImpl;
  const markCompleted = deps.markBackfillCompletedImpl == null ? markBackfillCompleted : deps.markBackfillCompletedImpl;
  const whoamiImpl = deps.whoamiImpl == null ? _whoami : deps.whoamiImpl;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onProgress = deps.onProgress == null ? (() => {}) : deps.onProgress;
  const now = deps.now == null ? (() => Date.now()) : deps.now;

  const result = {
    ok: false,
    reason: null,
    // The typed auth verdict behind a `no-token` / `auth-unavailable` reason, bounded to an
    // enum-shaped token so a summary can name the condition without echoing vendor text.
    authState: null,
    authReason: null,
    // Whether waiting and re-running is the right advice. True only for a held/busy credential
    // store — never for an explicit unlinked machine, where waiting achieves nothing.
    retryAdvised: false,
    halt: null,
    scanned: 0,
    active: 0,
    // Active sessions whose activity predates the machine link — the only actives the seal must
    // wait for (see shouldFinalize).
    activePreLink: 0,
    liveTracked: 0,
    alreadyImported: 0,
    oversize: 0,
    candidates: 0,
    plannedChunks: 0,
    // Reports built and handed to the flush — in a dry run, what WOULD have been sent. Counted in
    // both modes so "stored" has something to be compared against: without it a server that
    // quietly stores fewer than it was sent is undetectable.
    plannedReports: 0,
    sessionsImported: 0,
    // Candidates that produced no upload, split by cause — every one of these would otherwise
    // vanish between `candidates` and `sessionsImported` with nothing printed. `empty` is the
    // benign one: the sidecar genuinely carries no usage.
    empty: 0,
    // Reports were built, but none of them says anything billable — see the zero-usage guard in
    // the candidate loop for why that is a distinct outcome from `empty`.
    zeroUsage: 0,
    // A sidecar we could not read, whether the throw escaped runCheckpoint or was caught
    // inside it — the user-visible fact is the same, so it is one number.
    unreadable: 0,
    // Unreadable sessions this run is willing to hold the pull open for: the ones we had not
    // already tried. A file that fails on the retry too is deterministic (a permission error is
    // indistinguishable from a transient one at the call site), and blocking on it forever would
    // trade silent loss for a pull that can never seal.
    retriableUnreadable: 0,
    // Sessions, not reports: the summary talks about sessions the server refused, and a parallel
    // per-report count of the same refusals was only ever written, never printed.
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    itemErrors: 0,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
    finalized: false,
    // Whether anything was EVER delivered under this pull (this run or a ledgered earlier one).
    // False means the server never opened a pull, so there is nothing to seal — the summary uses
    // it to say the pull has not started rather than promising a retry that will never help.
    pullOpened: false,
    // Set when the server said the pull is sealed AND the workspace has no live tracking — the
    // audit window is the only reason to run again, so the summary points at an upgrade.
    upgradeAdvised: false,
    followupsAllowed: true,
    timelines: 0,
    // Client-side twin of `timelines` (which is purely the server's number), so a gap between
    // what we sent and what landed is attributable instead of a bare unexplained difference.
    timelinesOffered: 0,
    timelinesDropped: 0,
    lastError: null,
  };

  // The three ways this run can learn the one-time pull is already used — the server said so, the
  // local tracking cache said so while the server was unreachable, or the ledger did. All three
  // answer the caller identically; the upgrade hint is the only thing that varies, so it is the
  // only parameter. `mode` is the tracking mode of whichever source knew, or null when that source
  // has none to offer: the ledger records no tracking mode, and guessing one would either nag a
  // live workspace to upgrade to what it already has or hide the suggestion from one that needs it.
  const alreadyCompleted = (mode) => {
    result.ok = true;
    result.reason = 'already-completed';
    result.upgradeAdvised = mode != null && mode !== TrackingMode.LIVE;
    return result;
  };

  // Ahead of every local read on purpose: an unavailable store must leave the ledger, the tracking
  // cache and the one-time completion flags untouched, and the cheapest way to guarantee that is
  // to return before any of them is opened.
  const auth = await resolveAuditAuth(deps, { deadlineMs: AUDIT_TIMEOUT_MS });
  result.authState = auth.state;
  result.authReason = auth.reason;
  if (auth.outcome !== 'ready') {
    result.reason = auth.outcome;
    result.retryAdvised = auth.outcome === AUTH_UNAVAILABLE;
    return result;
  }
  const token = auth.token;

  // getAccessToken primed the machine client id — the binding key for the machine-global
  // ledger and tracking cache (a new login mints a new id, so a workspace switch invalidates
  // both instead of sealing the new tenant's pull empty).
  const identity = getMachineClientId();
  const tracking = readTracking();
  const trackingValid = matchesIdentity(tracking, identity);

  // The server is the authority on "has this pull been used", and it is asked FIRST: local
  // caches can be deleted (a reinstall never had them) — and they can also be WRONG the other
  // way. A /complete POSTed against a pull that was never opened is ignored server-side while
  // still answering 2xx, and the completed flags written off that hollow success would skip the
  // backfill forever on a machine whose history was never uploaded at all. So a reachable server
  // that answers "not completed" overrides every local cache and the run proceeds (re-sending is
  // idempotent; a genuinely sealed pull still halts on the chunk-level ALREADY_COMPLETED). The
  // caches below are trusted only when the server cannot answer.
  const who = await whoamiImpl(token, { fetchImpl, timeoutMs: 10_000 }).catch(() => null);
  const serverKnows = who != null && who.valid === true;
  if (serverKnows) {
    try { recordWhoamiImpl(who, identity); } catch { /* best-effort */ }
    if (who.backfillCompleted === true) {
      try { markCompleted(); } catch { /* best-effort */ }
      return alreadyCompleted(who.trackingMode);
    }
  }

  // Offline/old-server fast paths. --force skips the LOCAL caches only — the server verdict
  // above is never bypassed.
  if (!serverKnows && !options.force && trackingValid && tracking != null && tracking.backfillCompleted === true) {
    return alreadyCompleted(tracking.trackingMode);
  }

  // The pull is per (tenant, user, tool): bind the ledger to the ACCOUNT when it is known — a
  // same-account re-login keeps its progress (the client id changes on every login), while a
  // different account discards it rather than sealing the new tenant's pull empty. The client
  // id stays the fallback for a machine that has never recorded an email.
  //
  // `tracking` is passed explicitly rather than left to currentAccountKey's default: it came from
  // the injectable `readTracking()` above, and letting the default re-read the file would give the
  // audit a second, unmockable answer to a question it has already asked.
  const currentAccount = currentAccountKey({ who, tracking });
  const ledger = loadLedger(currentAccount == null ? identity : currentAccount);
  // Null mode: the ledger records the pull's progress, never the tenant's tracking mode.
  if (!serverKnows && !options.force && isComplete(ledger)) return alreadyCompleted(null);

  const all = listConversations();
  result.scanned = all.length;

  // Live-tracking tenants: everything since the machine link was tracked live; re-sending it
  // would double-count once its per-session cursor was pruned. On top of the ported rule sits a
  // Cursor-specific belt: a session whose state cursor ever advanced has queued live segments
  // whatever the tracking mode says — see liveCursorOf.
  const liveMode = trackingValid && tracking != null && tracking.trackingMode === TrackingMode.LIVE;
  // The machine's link instant serves two comparisons: in live mode everything with activity
  // after it is (or will be) tracked live, and an ACTIVE session with activity BEFORE it is the
  // one thing the seal must wait for.
  // The whole deps bag goes through: linkedAtMs destructures `statImpl` out of it, which is how a
  // suite keeps the credentials-mtime fallback off the home directory of whoever runs it.
  const machineLinkedAtMs = linkedAtMs(tracking, deps);
  const linkCutoffMs = liveMode ? machineLinkedAtMs : null;
  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;

  // Every time gate below keys on the session's last REAL activity, not the file mtime — Cursor
  // restamps every still-open tab with session_end on restart, so the mtime tracks the last
  // restart. Null activity (lifecycle noise only) is never "active": there is no usage to
  // double-count, and the parse classifies it as empty.
  const candidates = [];
  for (const entry of all) {
    // Size first: reading activity means reading the file, and the cap exists precisely so a
    // pathological sidecar is never read.
    if (entry.size > MAX_SIDECAR_BYTES) { result.oversize += 1; continue; }
    // The cursor belt outranks the active window: a session live tracking already queued will
    // never be backfilled no matter when it goes quiet, so counting it "active" would only make
    // it a phantom seal-blocker for a day after its last message.
    if (liveCursorOf(entry.sessionId, { account: currentAccount }) > 0) { result.liveTracked += 1; continue; }
    const activityMs = lastActivityOf(entry);
    if (activityMs != null && activityMs > activeCutoffMs) {
      result.active += 1;
      // With no link instant at all (a pre-stamp install on a real credential store), every
      // active would read pre-link and the login conversation itself would deadlock the seal —
      // that legacy case stays non-blocking, as in the Claude plugin.
      if (machineLinkedAtMs != null && activityMs < machineLinkedAtMs) result.activePreLink += 1;
      continue;
    }
    if (linkCutoffMs != null && activityMs != null && activityMs >= linkCutoffMs) { result.liveTracked += 1; continue; }
    if (!options.force && isImported(ledger, entry.sessionId)) { result.alreadyImported += 1; continue; }
    if (options.sinceMs != null && (activityMs == null ? entry.mtimeMs : activityMs) < options.sinceMs) continue;
    candidates.push(entry);
  }
  result.candidates = candidates.length;

  const finalize = async () => {
    // No pull, no seal. The server opens the pull on the first stored chunk; /complete against a
    // pull that was never opened is ignored server-side ("Backfill complete ignored — no pull
    // was ever opened") while answering 2xx — and marking completion off that answer is how a
    // machine that uploaded NOTHING gets every future backfill skipped. The run stays repeatable
    // until something is actually delivered.
    result.pullOpened =
      result.sessionsImported > 0 || result.sessionsRejected > 0 || hasImports(ledger);
    if (!result.pullOpened) return;
    if (!shouldFinalize(result, options)) return;
    const sealed = await completeBackfill(token, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    if (sealed.completed || sealed.code === 'BACKFILL_ALREADY_COMPLETED') {
      result.finalized = true;
      markComplete(ledger);
      try { saveLedger(ledger); } catch { /* best-effort */ }
      try { markCompleted(); } catch { /* best-effort */ }
    } else {
      result.lastError = sealed.reason == null ? result.lastError : sealed.reason;
    }
  };

  if (candidates.length === 0) {
    result.ok = true;
    // A previous run delivered everything but its finalize POST was lost: retry the seal here,
    // or the pull stays IN_PROGRESS forever while every rerun early-returns.
    await finalize();
    return result;
  }

  // Rate-limit error follow-ups hit a tracking-gated route: a dark-mode tenant would take one
  // 403 per session. Timelines are exempt — they ride inside the backfill chunks themselves.
  const followupsAllowed = !trackingValid || isLiveTrackingAllowed(tracking);
  result.followupsAllowed = followupsAllowed;

  // Accumulated but not yet delivered. Bounded by the same caps the request planner uses, so
  // peak memory stays at roughly one request's worth of payloads regardless of session count.
  let pending = [];
  let pendingBytes = 0;
  let pendingItems = 0;
  // sessionId → what the follow-up phase needs once the server confirms the session landed.
  const followups = new Map();
  let processed = 0;
  let halted = false;

  const dispatchBatch = async (batch) => {
    result.plannedReports += batch.reduce((sum, g) => sum + g.reports.length, 0);
    if (options.dryRun) {
      const chunks = planChunks(batch);
      result.plannedChunks += chunks.length;
      for (const group of batch) followups.delete(group.sessionId);
      return;
    }

    const flushed = await flushBackfillChunks(batch, token, { fetchImpl }, { timeoutMs: AUDIT_TIMEOUT_MS });
    result.plannedChunks += flushed.chunks;
    result.timelinesDropped += flushed.timelinesDropped == null ? 0 : flushed.timelinesDropped;
    result.reportsStored += flushed.stored;
    result.reportsSkipped += flushed.skipped;
    result.timelines += flushed.timelines;
    result.itemErrors += flushed.itemErrors;
    result.unattributed += flushed.unattributed;
    result.permanentRejections += flushed.permanentRejections;
    if (flushed.lastError) result.lastError = flushed.lastError;

    // Follow-ups only for sessions the server accepted — a failed one must stay unledgered so a
    // re-run retries it, and posting a timeline for it would create a session row with no usage.
    const landed = [];
    for (const group of batch) {
      const verdict = flushed.bySession.get(group.sessionId);
      const status = verdict == null || verdict.status == null ? BackfillSessionStatus.FAILED : verdict.status;
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        result.sessionsImported += 1;
        landed.push(group.sessionId);
      }
      if (status === BackfillSessionStatus.REJECTED) result.sessionsRejected += 1;
      if (status === BackfillSessionStatus.FAILED) result.reportsFailed += group.reports.length;
      // Anything the server judged is ledgered, including a rejection: an unconnected repository
      // will reject on every future run too. Failures and unattributed chunks stay eligible.
      if (
        status === BackfillSessionStatus.ACCEPTED ||
        status === BackfillSessionStatus.PARTIAL ||
        status === BackfillSessionStatus.REJECTED
      ) {
        markImported(ledger, group.sessionId, { outcome: status, reports: group.reports.length });
      } else {
        followups.delete(group.sessionId);
      }
    }
    // Written per dispatch, not once at the end, so Ctrl-C keeps the progress made so far.
    try { saveLedger(ledger); } catch { /* best-effort */ }

    if (flushed.halt) {
      result.halt = flushed.halt;
      halted = true;
      if (flushed.halt === BackfillHalt.ALREADY_COMPLETED) {
        markComplete(ledger);
        try { saveLedger(ledger); } catch { /* best-effort */ }
        try { markCompleted(); } catch { /* best-effort */ }
      }
      return;
    }

    if (followupsAllowed) {
      await mapLimited(landed, FOLLOWUP_CONCURRENCY, async (sessionId) => {
        const followup = followups.get(sessionId);
        followups.delete(sessionId);
        if (!followup) return;
        // Fire-and-observe-nothing on purpose: postSessionError never rejects, and the summary
        // has nothing to say about a rate-limit follow-up that landed — so counting them was a
        // number written and never read.
        for (const errorPayload of followup.sessionErrors) {
          // The audit's own budget, not postJson's 3s hook default (CONTRACTS ss8: postSessionError
          // honors deps.timeoutMs). A foreground command that inherits the hook bound reports a
          // merely slow server as unreachable.
          await postSessionError(errorPayload, token, { fetchImpl, timeoutMs: AUDIT_TIMEOUT_MS });
        }
      });
    }

    onProgress({ processed, total: candidates.length, ...result });
  };

  // One-deep pipeline: at most one batch in flight while the loop parses the next sessions —
  // the run would otherwise alternate CPU-bound parsing (network idle) with awaiting the upload
  // (CPU idle). Dispatches stay strictly sequential (await the previous flight before starting
  // the next), so the ledger writes and the never-two-POSTs invariant are untouched, and peak
  // memory grows by exactly one pending batch.
  let inFlight = null;
  const dispatch = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    pendingItems = 0;
    if (inFlight) await inFlight;
    // A halt discovered by the previous flight drops this batch — its sessions stay
    // unledgered and eligible, exactly like the loop break below.
    if (halted) return;
    inFlight = dispatchBatch(batch);
  };

  // First failure earns a retry and holds the pull open; a second one does not, so a permanently
  // unreadable file costs one extra login rather than sealing the pull never.
  let unreadableDirty = false;
  const noteUnreadable = (sessionId) => {
    if (!wasUnreadable(ledger, sessionId)) result.retriableUnreadable += 1;
    markUnreadable(ledger, sessionId);
    unreadableDirty = true;
  };

  // ONE bag of git facts for the whole run, not one per session. Past sessions overwhelmingly
  // share a handful of checkouts, and without this every candidate re-spawned git four times to
  // re-answer questions the run had already answered — measured at ~99 ms per session, so 20-40 s
  // of nothing on a machine with 200-400 of them. See createCheckpointCaches.
  const caches = createCheckpointCaches();

  // Parsing itself stays strictly sequential. The checkpoint reads and JSON.parses the whole
  // sidecar, so parsing sessions in parallel multiplies peak memory with no gain on a
  // single thread.
  for (const entry of candidates) {
    if (halted) break;
    const reports = [];
    let sessionErrors = [];
    let deltaFailed = false;
    try {
      const checkpoint = await runCheckpoint(
        { session_id: entry.sessionId, cwd: recordedCwd(entry.sessionId) },
        { getAccessToken: async () => token, fetchImpl },
        {
          sink: (payload) => reports.push(payload),
          // One word for the whole historical-replay posture — no flush, a from-line-0 parse that
          // is never written back, buffered error reports, and the whole-sidecar read the subagent
          // correlation needs. runCheckpoint's options comment carries the reasoning for each.
          mode: CheckpointMode.AUDIT,
          caches,
        },
      );
      sessionErrors = checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors;
      deltaFailed = checkpoint != null && checkpoint.deltaFailed === true;
    } catch {
      // One unreadable sidecar must not end the run — but it is not silent either.
      result.unreadable += 1;
      noteUnreadable(entry.sessionId);
      processed += 1;
      continue;
    }
    processed += 1;
    if (reports.length === 0) {
      // Classify rather than drop on the floor: telling a user that a session we FAILED to read
      // "held no usage data" is the silent loss this exists to end. Only one failure can reach
      // here now — the checkpoint's other no-report causes were unreachable branches — so `empty`
      // is the answer once an unreadable sidecar has been ruled out.
      if (deltaFailed) {
        result.unreadable += 1;
        noteUnreadable(entry.sessionId);
      } else result.empty += 1;
      continue;
    }

    // Reports were built, and not one of them says anything billable — see isZeroUsage. Held back
    // rather than uploaded, because the server would answer them with a session row carrying no
    // usage, no models and no time.
    //
    // `every`, never `some`: a session whose main segment is barren but which delegated real work
    // has a subagent segment in this array carrying that worker's seconds, and skipping the whole
    // session on the strength of the barren one would lose exactly the time this pass was fixed to
    // recover.
    //
    // NOT ledgered, for the same reason `empty` is not: the verdict is deterministic for a given
    // sidecar but a sidecar can still GROW — a conversation resumed tomorrow becomes a candidate
    // again and must be reconsidered on its new content. And it must not hold the seal open either
    // (see shouldFinalize): there is nothing here a re-run could deliver.
    if (reports.every(isZeroUsage)) {
      result.zeroUsage += 1;
      continue;
    }

    // Timeline travels with the session's own chunk. Best-effort: a timeline that fails to
    // compute never blocks the usage upload.
    let timeline = null;
    try {
      const computed = computeSessionTimeline(entry.sessionId);
      if (
        computed &&
        (computed.periods.length > 0 || computed.subagents.length > 0 || computed.plan_events.length > 0)
      ) {
        timeline = { sessionId: entry.sessionId, ...computed };
        result.timelinesOffered += 1;
      }
    } catch { /* best-effort */ }

    followups.set(entry.sessionId, { sessionErrors });
    // Serialized once, here, and carried ON the group. This number decides when THIS loop
    // dispatches, and planChunks needs the same figure to decide where the request boundaries
    // fall — discarding it there meant re-serializing the whole growing chunk once per session.
    const bytes = Buffer.byteLength(JSON.stringify({ reports, timeline }), 'utf-8');
    pending.push({ sessionId: entry.sessionId, reports, timeline, bytes });
    pendingBytes += bytes;
    pendingItems += reports.length;
    if (pendingBytes >= MAX_BODY_BYTES || pendingItems >= MAX_CHUNK_ITEMS) await dispatch();
  }
  await dispatch();
  if (inFlight) await inFlight;

  // A run can hit unreadable sidecars and dispatch nothing at all, so this cannot ride on the
  // per-dispatch save — without it the retry marker is lost and the next run blocks again.
  if (unreadableDirty) {
    try { saveLedger(ledger); } catch { /* best-effort */ }
  }

  result.ok = true;
  await finalize();
  return result;
}

// ── the repeatable sync

// Which pending queue files exist and which sessions they belong to.
//
// A queue file is a window that was measured, staged and not yet acknowledged. Sending a sync
// suffix for a session that still has one means the two windows can overlap in line space under
// DIFFERENT segment ids, which the server's idempotency key cannot collapse — the same
// double-billing the per-session lock exists to prevent, arriving by a slower route.
//
// The rule is deliberately a SUPERSET rather than a classification: any remaining file naming a
// session makes that session ineligible this run, whether it is backed off, failed, gated or
// simply not yet attempted. Classifying instead would mean inventing state the Cursor queue does
// not carry — there is no policy-hold marker on a queue FILE today (CONTRACTS §6 keeps `gated` and
// `trackingDisabled` as deliverQueue counters, not file state) — and every category we failed to
// recognize would read as "safe to send".
//
// The two failure modes are kept apart on purpose. A file that vanished between the listing and
// the read raced a concurrent flush that DELIVERED it: benign, and treating it as corruption would
// make every healthy concurrent flush halt the whole run. A file that is there and cannot be
// parsed, or carries no session id, is the case the brief calls unidentifiable: its session cannot
// be named, so no session can be proven free of pending windows, and the run halts.
export function readQueueSessions(deps = {}) {
  if (typeof deps.readQueueImpl === 'function') return deps.readQueueImpl();
  const dir = queueDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    // No queue directory at all is an EMPTY queue, not an unreadable one: a machine that has never
    // checkpointed has nothing pending.
    if (error != null && error.code === 'ENOENT') return { sessionIds: [], unidentifiable: 0 };
    return { sessionIds: [], unidentifiable: 1 };
  }
  const sessionIds = [];
  let unidentifiable = 0;
  for (const file of files) {
    // Only `*.json` is deliverable; `.tmp` is a half-written file the writer owns.
    if (!file.endsWith('.json')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch (error) {
      const code = error == null ? null : error.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue;
      unidentifiable += 1;
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      unidentifiable += 1;
      continue;
    }
    const sessionId = payload == null ? undefined : payload.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      unidentifiable += 1;
      continue;
    }
    sessionIds.push(sessionId);
  }
  return { sessionIds, unidentifiable };
}

// Strip cumulative, priced-overage money off a report that covers a RESUMED suffix.
//
// `credits` rows are derived from `composerData.usageData`, which is cumulative for the whole
// conversation: the delta subtracts a baseline (`state.usageSnapshot`) that an audit-mode parse
// does not have, so every credits row on a suffix carries the session's WHOLE priced spend, not
// the suffix's. Sending it beside what the server already stored for the covered prefix bills the
// same money twice.
//
// The row is not dropped — dropping it would silently turn paid work into nothing — it is marked
// with the pool this plugin already uses for "we could not establish what this cost"
// (`BILLING_POOL.UNKNOWN`, the same value lib/vscdb.mjs's null usage resolves to downstream), with
// the cumulative figures removed and the event-derived token counts kept. Unknown, explicitly,
// rather than zero.
function markOverageUnavailable(report) {
  const models = report == null ? null : report.models;
  if (!Array.isArray(models)) return { report, changed: false };
  let changed = false;
  const rewritten = models.map((entry) => {
    if (entry == null || entry.billing_pool !== BILLING_POOL.CREDITS) return entry;
    changed = true;
    const rest = {};
    for (const key of Object.keys(entry)) {
      if (key === 'cost_usd' || key === 'billing_pool' || key === 'requests') continue;
      rest[key] = entry[key];
    }
    // `requests` on a credits row is the cumulative `amount` from usageData, not an event count,
    // so it cannot be carried onto a suffix either.
    return { ...rest, billing_pool: BILLING_POOL.UNKNOWN, requests: 0 };
  });
  return changed ? { report: { ...report, models: rewritten }, changed: true } : { report, changed: false };
}

// Upload whatever Beezi is missing from the sessions this machine still has on disk.
//
// This is NOT the one-time import, and every difference is load-bearing:
//
//   - it never seals. There is no `finalize` in this function, no `/complete`, no `markComplete`,
//     no `markBackfillCompleted`. That is a structural guarantee rather than a flag: the code path
//     that could seal does not exist here.
//   - it never advances live state. Nothing writes `state/<id>.json`; the audit-only extraction
//     seam parses from a requested cursor and persists nothing.
//   - it bypasses the completion caches, the post-link whole-session exclusion and the one-time
//     imported-session skip, because a session the ledger calls "imported" can still have grown a
//     suffix the server has never seen. A boolean cannot answer that; only coverage can.
//   - its only protection against double-billing is the server's coverage answer, so an
//     unavailable answer HALTS. It never falls back to cursor zero, and it never falls back to a
//     local cursor: a live cursor means the window was QUEUED, not that it was delivered.
export async function runSync(deps = {}, options = {}) {
  const listConversations = deps.listConversations == null ? _listAllConversations : deps.listConversations;
  const recordedCwd = deps.firstRecordedCwd == null ? _firstRecordedCwd : deps.firstRecordedCwd;
  const lastActivityOf = deps.lastActivityOfImpl == null ? ((entry) => _lastActivityTs(entry.sessionId)) : deps.lastActivityOfImpl;
  const createCheckpointCaches = deps.createCheckpointCachesImpl == null ? _createCheckpointCaches : deps.createCheckpointCachesImpl;
  const flushBackfillChunks = deps.flushBackfillChunksImpl == null ? _flushBackfillChunks : deps.flushBackfillChunksImpl;
  const flushQueueImpl = deps.flushQueueImpl == null ? _flushQueue : deps.flushQueueImpl;
  const fetchCoverage = deps.fetchCoverageImpl == null ? _fetchCoverage : deps.fetchCoverageImpl;
  const sidecarSnapshotOf = deps.sidecarSnapshotImpl == null ? _sidecarSnapshot : deps.sidecarSnapshotImpl;
  const loadSyncStateImpl = deps.loadSyncStateImpl == null ? _loadSyncState : deps.loadSyncStateImpl;
  const saveSyncStateImpl = deps.saveSyncStateImpl == null ? _saveSyncState : deps.saveSyncStateImpl;
  const readTracking = deps.readTrackingStateImpl == null ? readTrackingState : deps.readTrackingStateImpl;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const onProgress = deps.onProgress == null ? (() => {}) : deps.onProgress;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  // The per-session mutex. Default is the EXISTING checkpoint lock (lib/lock.mjs) on the same
  // path a live hook takes, which is the only thing that makes the two mutually exclusive.
  // `withHeldLock`, NOT `withLock`: this section legitimately runs for minutes (a 60 s coverage
  // query, a whole-sidecar parse, a 60 s upload with retry and bisection) and plain `withLock` has
  // no renewal and an ownership-blind release. Under it a live hook breaks the lock at 30 s and
  // enqueues an overlapping window — the double-billing the lock exists to prevent — and this
  // function's own `finally` then deletes the hook's lock. See lib/lock.mjs.
  const withSessionLock = deps.withSessionLock == null
    ? ((sessionId, fn, opts) => withHeldLock(sessionLockPath(sessionId), fn, opts))
    : deps.withSessionLock;
  // The delivery owner's per-session in-flight send/ack barrier — see handoff-sync.md for the
  // interface the pipe lane implements. The lock alone is not enough: a queue FLUSH worker holds
  // no session lock while it has a POST in flight, so a session with no pending file on disk can
  // still have an unacknowledged window on the wire.
  const inflight = deps.inflight == null ? { acquire: async () => true, release: () => {} } : deps.inflight;

  const result = {
    mode: SYNC_MODE,
    ok: false,
    reason: null,
    authState: null,
    authReason: null,
    retryAdvised: false,
    halt: null,
    scanned: 0,
    active: 0,
    oversize: 0,
    // Sessions with an unacknowledged window still in the live queue.
    queueHeld: 0,
    // Sessions the server did not mention at all. NOT zero — see SPARSE_ZERO_CONFIRMED.
    coverageMissing: 0,
    // Sessions the server reports further into than this machine still has on disk.
    sourceMismatch: 0,
    // Sessions another process was working on (lock contention, in-flight barrier, epoch change).
    deferred: 0,
    // Sessions the server already holds in full.
    upToDate: 0,
    // Sessions with a genuine uncovered suffix to send.
    candidates: 0,
    plannedChunks: 0,
    plannedReports: 0,
    sessionsImported: 0,
    // Sessions the server accepted only in part. Counted apart from `sessionsImported` because a
    // partial acknowledgment cannot advance a cursor: the reports that failed are inside the span
    // the cursor would claim.
    partial: 0,
    sessionsRejected: 0,
    reportsStored: 0,
    reportsSkipped: 0,
    itemErrors: 0,
    reportsFailed: 0,
    unattributed: 0,
    permanentRejections: 0,
    unreadable: 0,
    empty: 0,
    // Suffixes whose priced-overage cost was marked unknown rather than re-counted.
    overageUnavailable: 0,
    timelines: 0,
    coverageKnown: false,
    lastError: null,
  };

  const auth = await resolveAuditAuth(deps, { deadlineMs: AUDIT_TIMEOUT_MS });
  result.authState = auth.state;
  result.authReason = auth.reason;
  if (auth.outcome !== 'ready') {
    result.reason = auth.outcome;
    result.retryAdvised = auth.outcome === AUTH_UNAVAILABLE;
    return result;
  }
  const token = auth.token;

  // The audit-only extraction seam, checked BEFORE any network or queue work: a build that cannot
  // resume a session must make no request and touch no queue file. It is separate from
  // `runCheckpoint` on purpose — runCheckpoint takes this session's lock itself, and calling it
  // from inside the lock below would lose the race against itself and return no reports at all,
  // which is indistinguishable in the summary from "everything is already covered".
  const extractAuditReports = deps.extractAuditReports;
  if (typeof extractAuditReports !== 'function') {
    result.halt = SyncHalt.EXTRACTION_UNAVAILABLE;
    return result;
  }

  // The request identity epoch (CONTRACTS §2). It changes on account change and logout, NOT on a
  // same-account token rotation, which is exactly the distinction sync needs: a rotated token may
  // continue, a different account may not.
  //
  // A probe that throws answers `null`, and `null !== fence` for any real fence — so a fence that
  // cannot be re-read defers rather than waving the send through. What must NOT happen is a run
  // whose fence is null to begin with: then every comparison is `null === null`, the check is a
  // no-op, and a relink mid-run goes unnoticed. That case halts below instead.
  const epochOf = async () => {
    if (typeof deps.authEpoch !== 'function') return auth.epoch == null ? null : auth.epoch;
    try {
      return await deps.authEpoch();
    } catch {
      return null;
    }
  };
  const fence = await epochOf();
  if (fence == null) {
    result.halt = SyncHalt.EPOCH_UNAVAILABLE;
    return result;
  }
  const fenceHolds = async () => (await epochOf()) === fence;

  const tracking = readTracking();
  const account = currentAccountKey({ who: null, tracking });
  const syncState = loadSyncStateImpl(account);

  // A best-effort drain first: a window this machine is holding is one the server has not been
  // told about, so coverage taken before the drain is stale by construction. It is best-effort
  // because the queue scan below is what actually bounds the run — a failed drain simply leaves
  // more sessions ineligible.
  try {
    await flushQueueImpl(token, { fetchImpl });
  } catch { /* the queue scan below still bounds us */ }

  const queue = readQueueSessions(deps);
  if (queue.unidentifiable > 0) {
    // Conservative halt: a file we cannot attribute could belong to any session, so NO session can
    // be proven free of pending overlapping windows.
    result.halt = SyncHalt.QUEUE_UNREADABLE;
    return result;
  }
  let heldSessions = new Set(queue.sessionIds);

  const all = listConversations();
  result.scanned = all.length;
  const activeCutoffMs = now() - ACTIVE_SESSION_WINDOW_MS;

  const considered = [];
  for (const entry of all) {
    if (entry.size > MAX_SIDECAR_BYTES) { result.oversize += 1; continue; }
    if (heldSessions.has(entry.sessionId)) { result.queueHeld += 1; continue; }
    const activityMs = lastActivityOf(entry);
    if (activityMs != null && activityMs > activeCutoffMs) { result.active += 1; continue; }
    considered.push(entry);
  }
  if (considered.length === 0) {
    result.ok = true;
    return result;
  }

  // One bulk coverage query for the whole run, so a machine with hundreds of already-complete
  // sessions does not take a lock and a request each. It decides nothing on its own: every session
  // that survives it is re-asked under its own lock before anything is sent.
  const bulkCoverage = await fetchCoverage(considered.map((e) => e.sessionId), token, { fetchImpl });
  if (bulkCoverage == null) {
    result.halt = SyncHalt.COVERAGE_UNAVAILABLE;
    return result;
  }
  result.coverageKnown = true;

  // Classify one session against a coverage answer. `{ outcome, covered, lines }` — outcome is the
  // result-counter name, or null when the session genuinely has an uncovered suffix, in which case
  // the caller reuses the `covered`/`lines` this already established rather than re-reading.
  //
  // The snapshot is asked for with a NULL prefix: this only needs the line count, and a prefix
  // makes sidecarSnapshot hash every event up to it. That hash is real work (a full parse plus a
  // sha256 over the prefix) and it was being paid — and discarded — on every classification, for
  // every session, twice per run. The fingerprint is computed exactly twice per session that
  // actually delivers: once to validate stored progress, once to record new progress.
  const classify = (entry, coverage) => {
    if (!coverage.has(entry.sessionId)) return { outcome: 'coverageMissing' };
    const covered = coverage.get(entry.sessionId);
    const snapshot = sidecarSnapshotOf(entry.sessionId, null);
    if (snapshot == null) return { outcome: 'unreadable' };
    // The server reports further than this machine still holds. Clamping and calling the rest
    // imported would claim delivery of lines that no longer exist here; say so instead.
    if (snapshot.lines < covered) return { outcome: 'sourceMismatch' };
    if (snapshot.lines === covered) return { outcome: 'upToDate' };
    return { outcome: null, covered, lines: snapshot.lines };
  };

  const pending = [];
  for (const entry of considered) {
    const verdict = classify(entry, bulkCoverage);
    if (verdict.outcome == null) pending.push(entry);
    else result[verdict.outcome] += 1;
  }
  result.candidates = pending.length;
  if (pending.length === 0) {
    result.ok = true;
    return result;
  }

  const caches = createCheckpointCaches();
  let processed = 0;
  let halted = false;

  for (const entry of pending) {
    if (halted) break;
    const sessionId = entry.sessionId;
    // ONE session per dispatch, inside its own lock. Batching across sessions would mean holding
    // several locks at once — and the invariant that matters more than throughput is that this
    // session's lock is held from the authorizing coverage query through the acknowledgment, so
    // no checkpoint can enqueue an overlapping window in between.
    const outcome = await withSessionLock(
      sessionId,
      async (held) => {
        // `withHeldLock` hands the section a handle; a caller that supplies none (a test double, or
        // an integration that injected a plain lock) is treated as still holding, which is the
        // pre-existing behaviour rather than a silent refusal to work.
        const stillHeld = held == null || typeof held.stillHeld !== 'function'
          ? (() => true)
          : (() => held.stillHeld() === true);
        // The delivery owner's barrier, taken INSIDE the lock and released in `finally`. Declared
        // outside the try so the finally can see it whatever happens in between.
        let admitted = false;
        try {
          try {
            admitted = (await inflight.acquire(sessionId)) !== false;
          } catch {
            // The documented contract is that a throw means "not admitted". A barrier
            // implementation that blows up must cost one session, not the whole run.
            admitted = false;
          }
          if (!admitted) return 'deferred';

          // Rechecks, in the order that costs least first. Each one is a race the bulk pass could
          // not have seen: a hook enqueued, the user came back, the account changed.
          const rescan = readQueueSessions(deps);
          if (rescan.unidentifiable > 0) return 'queue-unreadable';
          heldSessions = new Set(rescan.sessionIds);
          if (heldSessions.has(sessionId)) return 'queueHeld';

          const activityMs = lastActivityOf(entry);
          if (activityMs != null && activityMs > now() - ACTIVE_SESSION_WINDOW_MS) return 'active';

          if (!(await fenceHolds())) return 'deferred';

          // THE AUTHORIZING QUERY. A coverage answer taken before this lock cannot authorize a
          // send: another checkpoint can enqueue a window AND receive its acknowledgment between
          // that query and this lock, leaving nothing pending on disk while making the old answer
          // stale by exactly the overlap that would be billed twice.
          const fresh = await fetchCoverage([sessionId], token, { fetchImpl });
          if (fresh == null) return 'coverage-unavailable';
          const verdict = classify(entry, fresh);
          if (verdict.outcome != null) return verdict.outcome;
          const covered = verdict.covered;

          // Stored progress is a local mirror of what was acknowledged, and it is only meaningful
          // while it still names the same lines. A fingerprint that no longer matches means the
          // sidecar was truncated or recreated, so the entry is dropped rather than trusted — the
          // server's coverage is the authority either way, and a size or mtime could not have told
          // the two apart.
          const previous = _syncProgressFor(syncState, sessionId);
          if (previous != null) {
            const atPrevious = sidecarSnapshotOf(sessionId, previous.cursor);
            if (atPrevious == null || atPrevious.fingerprint !== previous.fingerprint) {
              delete syncState.sessions[sessionId];
            }
          }

          let extracted;
          try {
            // `startCursor` and `caches` only. An option the seam does not implement (an end bound,
            // say) would be silently dropped at merge time and the caller would go on believing it
            // was honoured — see handoff-sync.md Patch A for the exact contract this matches.
            extracted = await extractAuditReports(
              { session_id: sessionId, cwd: recordedCwd(sessionId) },
              { getAccessToken: async () => token, fetchImpl },
              { startCursor: covered, caches },
            );
          } catch {
            return 'unreadable';
          }
          const reports = extracted == null || !Array.isArray(extracted.reports) ? [] : extracted.reports;
          if (reports.length === 0) {
            return extracted != null && extracted.deltaFailed === true ? 'unreadable' : 'empty';
          }

          // A resumed suffix carries no cumulative money — see markOverageUnavailable.
          let overageMarked = false;
          const staged = reports.map((report) => {
            if (!(covered > 0)) return report;
            const marked = markOverageUnavailable(report);
            if (marked.changed) overageMarked = true;
            return marked.report;
          });
          if (overageMarked) result.overageUnavailable += 1;

          const group = {
            sessionId,
            reports: staged,
            bytes: Buffer.byteLength(JSON.stringify({ reports: staged }), 'utf-8'),
          };
          result.plannedReports += staged.length;

          if (options.dryRun === true) {
            result.plannedChunks += planChunks([group]).length;
            return 'dry-run';
          }

          // Immediately before the send, after every await above. Both questions, not one: the
          // epoch says WHOSE data this is, the lock says whether anyone else may have staged an
          // overlapping window while we worked.
          if (!stillHeld()) return 'deferred';
          if (!(await fenceHolds())) return 'deferred';

          const flushed = await flushBackfillChunks(
            [group],
            token,
            { fetchImpl },
            { endpoint: AuditEndpoint.SYNC, timeoutMs: AUDIT_TIMEOUT_MS },
          );
          result.plannedChunks += flushed.chunks;
          result.reportsStored += flushed.stored;
          result.reportsSkipped += flushed.skipped;
          result.timelines += flushed.timelines;
          result.itemErrors += flushed.itemErrors;
          result.unattributed += flushed.unattributed;
          result.permanentRejections += flushed.permanentRejections;
          if (flushed.lastError) result.lastError = flushed.lastError;
          if (flushed.halt) {
            result.halt = flushed.halt;
            halted = true;
            return 'halted';
          }

          const judged = flushed.bySession.get(sessionId);
          const status = judged == null || judged.status == null ? BackfillSessionStatus.FAILED : judged.status;
          if (status === BackfillSessionStatus.REJECTED) {
            result.sessionsRejected += 1;
            return 'rejected';
          }
          if (status !== BackfillSessionStatus.ACCEPTED && status !== BackfillSessionStatus.PARTIAL) {
            result.reportsFailed += staged.length;
            return 'failed';
          }
          if (status === BackfillSessionStatus.PARTIAL) {
            // Some of these reports were refused, and the server's errors[] names segments rather
            // than telling us which lines survived. A cursor recorded here would span the reports
            // that never landed, and the next run — resuming from the server's own coverage — is
            // the thing that will actually establish where the session reaches.
            result.sessionsImported += 1;
            result.partial += 1;
            return 'partial';
          }

          // A late acknowledgment for an account that is no longer linked must not touch the
          // current one's state. The payload is already gone — that cannot be undone — but the
          // progress it would have advanced belongs to a tenant this machine no longer reports to.
          if (!(await fenceHolds())) return 'deferred';
          // A lock broken while the request was in flight means another checkpoint may already have
          // moved this session. Recording our cursor on top of that would claim a prefix nobody
          // verified; the next run re-asks coverage instead.
          if (!stillHeld()) return 'deferred';

          result.sessionsImported += 1;
          // The cursor recorded is the one the REPORTS reach, not the line count the snapshot saw:
          // `appendEvent` is not lock-guarded, so the sidecar can grow between the snapshot and the
          // parse, and the extraction is what says how far it actually consumed. Cursor's subagent
          // segments carry the main window's range (checkpoint.mjs: "the range names the window the
          // segment was DERIVED in"), so the maximum across all reports is in one line space.
          const delivered = deliveredCursor(staged, verdict.lines);
          _recordSyncProgress(syncState, sessionId, {
            cursor: delivered,
            fingerprint: sidecarFingerprintAt(sidecarSnapshotOf, sessionId, delivered),
          });
          // Written per session, not once at the end, so an interrupted run keeps what it proved.
          try { saveSyncStateImpl(syncState); } catch { /* best-effort */ }
          return 'imported';
        } finally {
          if (admitted) {
            try { inflight.release(sessionId); } catch { /* best-effort */ }
          }
        }
      },
      { miss: 'deferred' },
    );

    processed += 1;
    if (outcome === 'coverage-unavailable') {
      result.halt = SyncHalt.COVERAGE_UNAVAILABLE;
      halted = true;
      break;
    }
    if (outcome === 'queue-unreadable') {
      result.halt = SyncHalt.QUEUE_UNREADABLE;
      halted = true;
      break;
    }
    if (outcome === 'deferred') result.deferred += 1;
    else if (outcome === 'queueHeld') result.queueHeld += 1;
    else if (outcome === 'active') result.active += 1;
    else if (outcome === 'unreadable') result.unreadable += 1;
    else if (outcome === 'empty') result.empty += 1;
    else if (outcome === 'upToDate') result.upToDate += 1;
    else if (outcome === 'sourceMismatch') result.sourceMismatch += 1;
    else if (outcome === 'coverageMissing') result.coverageMissing += 1;
    onProgress({ processed, total: pending.length, ...result });
  }

  result.ok = result.halt === null;
  return result;
}

// How far the staged reports actually reach. Falls back to the snapshot's line count only when no
// report carries a usable `to_line` — a payload shape with no line range at all, which the current
// checkpoint never emits but which must not silently record a cursor of zero.
function deliveredCursor(reports, fallbackLines) {
  let reached = null;
  for (const report of reports) {
    const to = report == null ? undefined : report.to_line;
    if (Number.isInteger(to) && to >= 0 && (reached === null || to > reached)) reached = to;
  }
  return reached === null ? fallbackLines : reached;
}

// The fingerprint of the prefix a delivery just extended to. Taken from the SAME snapshot reader
// the rest of the protocol uses, so a caller substituting one substitutes both.
function sidecarFingerprintAt(snapshotOf, sessionId, lines) {
  const snapshot = snapshotOf(sessionId, lines);
  return snapshot == null ? null : snapshot.fingerprint;
}
