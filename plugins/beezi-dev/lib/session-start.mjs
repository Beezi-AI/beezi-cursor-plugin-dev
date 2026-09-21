import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { flushQueue as _flushQueue, HOOK_BUDGET_MS } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { stateDir } from './paths-cursor.mjs';
import { readJson, setWriteFailureReporter as _setWriteFailureReporter, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { sweepHeldQueue as _sweepHeldQueue } from './queue-maintenance.mjs';
import { safeName } from './sidecar.mjs';
import { ensureInstalled as _ensureInstalled } from './plugin-install.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, readJsonBounded, POST_TIMEOUT_MS } from './http.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { detectBillingSource as _detectBillingSource, isPlanBearing } from './billing.mjs';
import {
  isDue as _isDue,
  isStale as _isStale,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
} from './billing-config.mjs';
import { observationFromAccount as _observationFromAccount, reconcilePlan as _reconcilePlan } from './billing-capture.mjs';
import { readCursorAccount as _readCursorAccount } from './cursor-account.mjs';
import {
  syncAccountIfNeeded as _syncAccountIfNeeded,
  buildCheckInScope as _buildCheckInScope,
  CheckInOutcome,
  CheckInVia,
} from './account-checkin.mjs';
import { accountSyncStateFile as _accountSyncStateFile } from './account-sync.mjs';
import {
  readPendingCheckIn as _readPendingCheckIn,
  clearPendingCheckIn as _clearPendingCheckIn,
} from './stop-account-change.mjs';
import {
  TrackingMode,
  isLiveTrackingAllowed as _isLiveTrackingAllowed,
  readTrackingState as _readTrackingState,
  recordWhoami as _recordWhoami,
  shouldBackfill as _shouldBackfill,
} from './tracking.mjs';
import { extensibilityNote, readExtensibility as _readExtensibility } from './extensibility.mjs';
import { lazyRecordIssue } from './diagnostics-sink.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing conversation's cursor.
// Also records where the conversation lives (cwd) so track.mjs can find it after the session cd's
// away from its launch directory — the mapping is refreshed on every start (a conversation may be
// resumed from a different directory).
//
// No transcript path is recorded, unlike the Codex plugin: the sidecar is keyed on the conversation
// id and needs no file discovery, and `cursor-agent`'s transcript_path is unreliable anyway.
//
// Returns whether the state file was written, so a caller that cares can ask rather than assume.
export function initSessionState(conversationId, { cwd = null } = {}) {
  // safeName, not the raw id. `session_id` arrives in a hook payload, so it is untrusted input being
  // spliced into a path: a value carrying `../` writes this file outside the state directory
  // entirely, and `state/` is a directory pruneStale deletes from on an mtime rule. It is also the
  // plugin's ONE sanitizer (lib/sidecar.mjs) rather than a local copy — the sidecar log, the
  // per-session lock and this state file all name the same conversation, and a second, subtly
  // different implementation is exactly how one of those three ends up pointing somewhere else.
  const name = safeName(conversationId);
  if (name === null) return false; // no usable filename — write nothing rather than invent one
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${name}.json`);
  const state = readJson(p, { cursor: 0 });
  state.cwd = cwd;
  state.updatedAt = new Date().toISOString();
  writeJsonSecure(p, state);
  return true;
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs == null ? fs : deps.fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin == null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      const childRoot = resolveRepoRoot(gitImpl, child, cache, map);
      recordRoot(childRoot == null ? child : childRoot);
    }
  }
  return { map, dirty };
}

// `liveAllowed` is the resolved tenant policy, and it gates TWO things here: the request, and the
// clause that claims this session is being tracked. It is a boolean rather than the TrackingMode
// because neither question needs more; the difference between `backfill_only` (held, will drain)
// and `disabled` (will not) belongs to `describeTrackingPolicy`, which is the one place that
// difference is user-visible.
async function announceRepo(cwd, token, fetchImpl, gitImpl, { liveAllowed = true } = {}) {
  if (!cwd) return null;
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) {
    // Distinguish "not a git repo" (silent) from "git repo with no origin" (still tracked).
    const root = resolveRepoRoot(gitImpl, cwd, new Map());
    if (!root) return null;
    return liveAllowed
      ? 'Beezi: no "origin" remote — tracking as a local repo.'
      : 'Beezi: no "origin" remote — this repo would be tracked as a local repo.';
  }
  // A3: nothing about the repository leaves a machine that is not tracking live.
  //
  // This request records nothing server-side and carries no usage data, so it looked free — but its
  // body is the repository's `origin` URL, which names the user's repo, their host and often their
  // organisation. On a DISABLED tenant `describeTrackingPolicy` has just told the user that nothing
  // from this session is reported, and sending it anyway makes that sentence false in the one way a
  // user would care about. On `backfill_only` the remote reaches the server when the held sessions
  // drain, so declining here defers it rather than losing it.
  //
  // Local discovery above still runs, so the no-origin wording is unchanged; what is dropped is the
  // part of the banner that only a server answer could fill in, which is the same thing the offline
  // path below drops.
  if (!liveAllowed) return null;

  const startedAt = Date.now();
  try {
    // postJson, not a bare fetch: this runs inside the sessionStart hook's budget, and an unbounded
    // request against a stalled API would hold the whole turn open rather than degrading to the
    // silent "offline" path below.
    const res = await postJson(`${apiBase()}${ENDPOINTS.reposStatus}`, token, { remote }, { fetchImpl });
    if (!res.ok) return null;
    // readJsonBounded, not res.json(). Before H-1, postJson cleared its abort timer the moment the
    // HEADERS arrived — fetch settles there, not at the end of the body — so `await res.json()` ran
    // with nothing above undici's 300s bodyTimeout underneath it, thirty times the ~10s a Cursor
    // hook gets before it is killed. This call sits inside a Promise.all with the queue flush, so a
    // server that answers and then goes quiet mid-body kept that whole group pending: the hook was
    // killed and the session got no banner at all, rather than the silent "offline" degrade below.
    // The timer is now unref'd rather than cleared, so it does reach the body — but it throws where
    // this path needs a soft `null`, and it is the same allowance, not a second one.
    //
    // Headers and body share ONE budget. Handing the body a second full POST_TIMEOUT_MS would cost
    // twice what the request promised, which is the kind of overrun that only shows up on the slow
    // connection of the user who reports it.
    const body = await readJsonBounded(res, POST_TIMEOUT_MS - (Date.now() - startedAt));
    // A body we could not read is the same outcome as no answer at all: stay silent. Falling through
    // with `{}` would announce "this repo is not linked to a Beezi project yet" on the strength of a
    // stalled socket, which is a claim about the user's account made out of a network failure.
    if (!body) return null;
    const { connected, projectName } = body;
    const named = `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}.`;
    if (connected) return liveAllowed ? `${named} Session analytics are tracked.` : named;
    return liveAllowed
      ? 'Beezi: this repo is not linked to a Beezi project yet. Session analytics are still tracked.'
      : 'Beezi: this repo is not linked to a Beezi project yet.';
  } catch { return null; } // offline — silent
}

// Only attempt the deterministic plan read while this much of the hook budget is still UNSPENT.
//
// A reserve against the remaining budget, not a fixed spend from entry. bill's patch measured
// `Date.now() - startedAt < 2000`, which was correct when the probe below ran concurrently — but
// the probe is serial now (it has to be, so nothing posts under a stale policy), so on any machine
// with a real network the elapsed time at this point routinely exceeds 2000 ms and the read would
// never run at all. Measuring what is LEFT survives the reordering and keeps bill's intent: a plan
// refresh is never worth a session start. `readCursorAccount` can fall through to a WAL snapshot
// copy of state.vscdb, and this whole function is inside Cursor's hard 10s kill.
const PLAN_RECHECK_RESERVE_MS = 2000;

// The account check-in's own allowance, and the reserve that has to be UNSPENT before it is even
// attempted (plan §4 B3).
//
// Both numbers are spelled out here rather than inherited, for the reason the comment on
// REVOKE_CHECK_TIMEOUT_MS below gives: this file has already been burned once by a call site that
// took whatever default its callee happened to ship. The reserve is strictly larger than the
// timeout, which is what makes the await below PROVABLY bounded — the hook cannot start a request
// it does not have the budget to finish, and the request cannot outlive its own abort.
//
// NOT forced. The fingerprint gate plus the seven-day heartbeat is the intended steady state on a
// hot path: an unchanged account reads one small state file and sends nothing. Forcing here would
// POST on every single session start, which is the one thing a per-session path must not do.
export const CHECKIN_TIMEOUT_MS = 1500;
const CHECKIN_RESERVE_MS = 2500;

// What this machine's analytics policy actually allows, in one sentence, or null when there is
// nothing to add.
//
// Built from `TrackingMode` / `isLiveTrackingAllowed` / `shouldBackfill` and NOT from a parallel
// boolean, because a boolean cannot separate the two non-live modes — and they are the two a user
// would act on differently. `backfill_only` means the work is recorded and held and will reach the
// server later; `disabled` means it will not. Telling someone the first when it is the second
// promises delivery that never happens.
//
// M09-03 step 2 — "unknown/transient must not assert a fresh successful policy decision" — is
// satisfied structurally rather than by a branch: `live` and "nobody has told us yet" both produce
// NOTHING here, so there is no sentence for an indeterminate probe to wrongly make fresh. Only the
// two modes that change what happens to a user's work speak, and a DISABLED cache speaking is
// recorded truth rather than a new claim. Do not add an "unknown" message without re-reading that
// step and test/session-start.test.mjs's byte-identical live/unknown case.
function describeTrackingPolicy(tracking) {
  const mode = tracking == null || tracking.trackingMode == null ? null : tracking.trackingMode;
  if (mode === TrackingMode.DISABLED) {
    return 'Beezi: analytics are turned off for this workspace — nothing from this session is reported.'
      + ' Ask a Beezi administrator if that is unexpected.';
  }
  if (mode === TrackingMode.BACKFILL_ONLY) {
    // Audit/history policy is a SEPARATE decision from live policy, which is exactly why this mode
    // exists: the one-time import is still offered here. `beezi-sync` is deliberately not named —
    // its release gate is not satisfied yet (see INTEGRATION-PLAN §4).
    return _shouldBackfill(tracking)
      ? 'Beezi: live analytics are paused for this workspace. This session is recorded locally and held.'
        + ' History import is a separate policy and is still available — run the beezi-login skill.'
      : 'Beezi: live analytics are paused for this workspace. This session is recorded locally and held'
        + ' until that changes; nothing is lost.';
  }
  // `live`, or a mode nobody has told us yet: the repo announcement already covers the first and
  // there is nothing honest to say about the second.
  return null;
}

// 401 and 403 are different events, and one line used to collapse them.
//
// 401 says the token was not accepted. 403 says the caller IS authenticated and is not entitled —
// relinking cannot grant a seat. A hook must never delete on either: deletion is what an explicit
// logout does, and a sign-in replaces the credential by committing a new generation (CONTRACTS §2:
// getAuthState "never deletes credentials"). The previous code wiped the credential on both, which
// turned an entitlement refusal into a destroyed link and then advised a relink that could not
// restore it — AUTH-03.
//
// `unknown` is a probe that did not answer. It is not evidence of anything and changes nothing.
function probeLink(who) {
  if (who == null) return 'unknown';
  if (who.valid === true) return 'ok';
  return who.forbidden === true ? 'forbidden' : 'revoked';
}

// The revocation check's own budget, passed EXPLICITLY rather than inherited from whoami's default.
//
// It is spelled out here because this call site is the one that got burned by an inherited number:
// the check used to run serially ahead of everything else on a 10s read default, so a stalled portal
// cost 10s of a ~7.5s budget and the prune, the repo-map self-heal and the queue flush behind it
// never ran at all. whoami's default is 1500ms today, but "today's default happens to be small
// enough" is not a property this hook should depend on — it is under a hard 10s host kill.
export const REVOKE_CHECK_TIMEOUT_MS = 1500;

// Returns an optional systemMessage string (or null). Never throws for expected failures.
//
// The caller writes this to stdout, and that is the ONLY stdout this plugin emits. It is
// best-effort and non-load-bearing by design: Cursor forum #155689 (open since 2026-03-23) reports
// that a hook's return value is accepted and validated but never injected into the model's context.
// No Beezi behaviour may ever depend on a hook return value.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const gitImpl = deps.gitImpl == null ? _git : deps.gitImpl;
  const detectBillingSource = deps.detectBillingSource == null ? _detectBillingSource : deps.detectBillingSource;
  const readBillingConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const isStale = deps.isStale == null ? _isStale : deps.isStale;
  const ensureInstalled = deps.ensureInstalled == null ? _ensureInstalled : deps.ensureInstalled;
  const whoami = deps.whoami == null ? _whoami : deps.whoami;
  const sweepHeldQueue = deps.sweepHeldQueue == null ? _sweepHeldQueue : deps.sweepHeldQueue;
  const recordWhoami = deps.recordWhoami == null ? _recordWhoami : deps.recordWhoami;
  const readTrackingState = deps.readTrackingState == null ? _readTrackingState : deps.readTrackingState;
  const isLiveTrackingAllowed = deps.isLiveTrackingAllowed == null ? _isLiveTrackingAllowed : deps.isLiveTrackingAllowed;
  const isDue = deps.isDue == null ? _isDue : deps.isDue;
  const writeBillingConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const reconcilePlan = deps.reconcilePlan == null ? _reconcilePlan : deps.reconcilePlan;
  const observationFromAccount = deps.observationFromAccount == null ? _observationFromAccount : deps.observationFromAccount;
  const readCursorAccount = deps.readCursorAccount == null ? _readCursorAccount : deps.readCursorAccount;
  // The account check-in (plan §4 B3). Seamed like every other network caller in this hook so a
  // test can assert the force flag, the scope and the budget gate without a socket.
  const syncAccount = deps.syncAccount == null ? _syncAccountIfNeeded : deps.syncAccount;
  // The `pendingCheckIn` marker the stop hook leaves behind when its own budget ran out (plan §4
  // C3). That promise names TWO drainers — the next stop AND session start — and with only the
  // first of them wired, a machine that keeps finishing its turns with a nearly-spent budget sits
  // on an undelivered check-in indefinitely.
  const buildCheckInScope = deps.buildCheckInScope == null ? _buildCheckInScope : deps.buildCheckInScope;
  const accountSyncStateFile = deps.accountSyncStateFile == null ? _accountSyncStateFile : deps.accountSyncStateFile;
  const readPendingCheckIn = deps.readPendingCheckIn == null ? _readPendingCheckIn : deps.readPendingCheckIn;
  const clearPendingCheckIn = deps.clearPendingCheckIn == null ? _clearPendingCheckIn : deps.clearPendingCheckIn;
  // Reads Cursor's OWN state database. Seamed, and a test must always inject it: the default path
  // is the developer's real state.vscdb, which no suite may touch.
  const readExtensibility = deps.readExtensibility == null ? _readExtensibility : deps.readExtensibility;
  const setWriteFailureReporter = deps.setWriteFailureReporter == null ? _setWriteFailureReporter : deps.setWriteFailureReporter;
  const recordIssue = deps.recordIssue == null ? lazyRecordIssue : deps.recordIssue;
  // Seamed so the two properties that matter about the flush are assertable rather than inferred:
  // that it is given the hook's ABSOLUTE deadline (anchored at entry, never recomputed after the
  // probe), and that it is not started before the policy verdict has been persisted.
  const flushQueue = deps.flushQueue == null ? _flushQueue : deps.flushQueue;
  // The hook clock. Seamed so the budget arithmetic below is assertable without a test having to
  // spend seven real seconds proving that a nearly-spent budget skips the plan read.
  const now = deps.now == null ? Date.now : deps.now;

  // Anchored at entry, not at the flush. The budget is the HOOK's, not one call's: everything below
  // happens inside Cursor's hard 10s kill, and a deadline computed after the local work had already
  // run silently granted the flush a fresh 7.5s on top of whatever git and the prune had spent.
  const startedAt = now();

  // ONCE, early, and before anything writes. lib/fs-store.mjs is on the startup path of every hook
  // and cannot import the telemetry stack itself (child_process + http on every tool call), so the
  // reporter is injected from here — the one hook that already pays for the reporting engine. Every
  // atomic write on the machine goes through writeFileAtomic, and until now a failed one was
  // completely silent: a full disk or a permissions change showed up as analytics that stopped,
  // with nothing anywhere saying why.
  try {
    setWriteFailureReporter((error) => recordIssue('state_write_failed', { error }));
  } catch { /* diagnostics must never break a session start */ }

  let token = null;
  try { token = await getAccessToken(); } catch { token = null; }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run the beezi-login skill.';

  // ── Everything LOCAL first. Nothing on disk may be hostage to the network. ──────────────────
  //
  // The revocation check used to sit here, awaited serially, ahead of all of it. That ordering is
  // what made a slow portal a data-retention bug rather than a slow banner: `getAccessToken()` alone
  // costs ~530ms median on Windows, the check inherited a 10s read default on top, and the hook was
  // killed at 10s — so on a machine whose API was persistently slow, the prune below never ran once.
  // pruneStale is the ONLY caller of lib/prune.mjs anywhere on the machine, and it sweeps `state/`,
  // `queue/` AND the `events/` sidecar, which nothing else ever deletes from. "The API is slow"
  // therefore meant "this machine's sidecar grows without bound, forever", silently.
  initSessionState(input.session_id, { cwd: input.cwd == null ? null : input.cwd });
  try { pruneStale(); } catch { /* best-effort */ }
  // Local, cheap, and ahead of every network call for the same reason pruneStale is: a machine
  // whose API is slow must still age out its own held records. pruneStale cannot do this job — it
  // deletes on mtime at 14 days, and recording a retry rewrites the file, which refreshes the
  // mtime. See lib/queue-maintenance.mjs.
  try { sweepHeldQueue({ now: startedAt }); } catch { /* best-effort */ }

  // Write/repair the user-scope hook registry from the hook path, not only from the MCP server.
  //
  // ensureInstalled used to run exclusively from scripts/mcp.mjs's startup. The MCP server is a
  // separate subsystem the user can disable on its own, and it is spawned by the IDE — so a machine
  // that leans on `cursor-agent` could go indefinitely without ever writing `~/.cursor/hooks.json`,
  // which is the ONLY registry the CLI reads (Cursor staff, forum 163890: a plugin's bundled hooks
  // never fire under cursor-agent). Running it here means an ordinary IDE session — the thing that
  // does happen on such a machine — installs and keeps repairing the registry the CLI depends on.
  //
  // Cheap by construction, which is why it can sit on a per-session path: the shim is rewritten only
  // when its content differs, and hooksStatus short-circuits the install once the state is
  // `installed`. A no-op run is a handful of stats.
  try { ensureInstalled(); } catch { /* best-effort — a machine that cannot self-repair still tracks */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // ── Then the network: ONE bounded probe, then everything that depends on its verdict. ───────
  //
  // The probe and the revocation check are the SAME request. `isTokenRevoked` used to call whoami
  // and throw away everything except the validity bit, from inside a Promise.all with the flush and
  // the announcement — so the verdict landed AFTER the flush had already posted and the
  // announcement had already claimed analytics were tracked. A disabled tenant got one more round
  // of both on every session start, forever. Running a second probe for the policy would spend the
  // budget twice on one question, so there is exactly one.
  //
  // The cost: the wall clock grows by the probe's own bound. That bound is explicit and small
  // (REVOKE_CHECK_TIMEOUT_MS), and the deadline below stays ABSOLUTE and anchored at entry — the
  // probe spends the budget it costs, it does not grant the flush a fresh one.
  //
  // The local block above is deliberately NOT behind this. A probe that never answers must still
  // leave a machine pruned and its held records swept.
  let who = null;
  try { who = await whoami(token, { fetchImpl, timeoutMs: REVOKE_CHECK_TIMEOUT_MS }); } catch { who = null; }
  const link = probeLink(who);

  // Persist BEFORE the flush and the announcement, so both read this session's verdict rather than
  // the previous session's. recordWhoami ignores an invalid or indeterminate result by construction,
  // so a timed-out probe keeps whatever policy is already cached — and a missing cache keeps the
  // documented fail-open default. An indeterminate read is never "disabled".
  try { recordWhoami(who, null); } catch { /* best-effort — a cache write must not fail a hook */ }

  // Neither of these deletes anything. See probeLink.
  if (link === 'forbidden') {
    return '⚠ Beezi: this account is not permitted to report analytics here. The link was kept —'
      + ' signing in again cannot change it; ask a Beezi administrator.';
  }
  if (link === 'revoked') {
    return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run the beezi-login skill again.';
  }

  // Read back what was just persisted, so the policy the message describes is the policy the flush
  // and the gate are enforcing — one source, not two derivations of it.
  let tracking = null;
  try { tracking = readTrackingState(); } catch { tracking = null; }
  const liveAllowed = isLiveTrackingAllowed(tracking) !== false;

  // The flush deadline is the same budget the checkpoint uses. sessionStart is under Cursor's hard
  // 10s hook kill too, and an unbounded flush of a backlog against a stalled API costs N × the
  // per-request timeout. Deferring is free: the files stay on disk for the next hook.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl, deadline: startedAt + HOOK_BUDGET_MS }),
    announceRepo(input.cwd, token, fetchImpl, gitImpl, { liveAllowed }),
  ]);

  let message = systemMessage;
  const policy = describeTrackingPolicy(tracking);
  if (policy) message = message ? `${message}\n${policy}` : policy;
  // A plan is worth nagging about for any source that rides a seat. sessionStart has no delta to
  // read, so `detectBillingSource()` answers SUBSCRIPTION here by construction — the predicate is
  // what keeps that from silently becoming the only case anyone remembers to handle.
  if (isPlanBearing(detectBillingSource())) {
    let config = readBillingConfig();
    // TWO gates, both load-bearing. `isDue` bounds how OFTEN this happens — including on a machine
    // that has no plan at all, because `attempted: true` below makes a fruitless read back off
    // exactly like a successful one. The reserve bounds the one run that does happen.
    const remaining = startedAt + HOOK_BUDGET_MS - now();
    if (isDue(config, now()) && remaining > PLAN_RECHECK_RESERVE_MS) {
      try {
        const result = reconcilePlan(
          observationFromAccount(readCursorAccount(), 'session-start'),
          config,
          // `attempted: true` is NOT optional. Without it a machine with no plan re-reads the
          // host on every single session start.
          { now: now(), attempted: true },
        );
        if (result.persist && result.record != null) {
          writeBillingConfig(result.record);
          config = result.record;
        }
      } catch { /* a plan refresh must never break a session start */ }
    }

    // Tell the portal which Cursor account this machine is on — the steady-state heartbeat for the
    // whole feature, and the only path that runs without the user asking for anything.
    //
    // Unforced, so the normal case is one small state-file read and no request at all. The budget
    // is re-measured HERE rather than reused from the plan gate above: the reconcile may have just
    // spent up to PLAN_RECHECK_RESERVE_MS opening a WAL snapshot of state.vscdb, and deciding on a
    // stale number is how a bounded call becomes an unbounded one.
    //
    // `config` is the record the reconcile above settled, handed over directly — no second read of
    // billing.json, and no second `readCursorAccount()`, which on the snapshot path costs ~80 ms.
    // `who` is this session's own probe, so the scope does not depend on the best-effort
    // `recordWhoami` write having landed.
    if (config != null && startedAt + HOOK_BUDGET_MS - now() > CHECKIN_RESERVE_MS) {
      // Is an earlier run's check-in still owed? The marker lives INSIDE the heartbeat state file,
      // which the scope names, so the scope is built from exactly the seams the check-in below
      // will build its own from — a marker read beside a different file is a marker never drained.
      //
      // A scope that cannot be built is not an error here: it means no marker can exist for this
      // machine either (the stop hook refuses to write one it cannot name), so the check-in simply
      // runs unforced, the way it does on every ordinary session.
      let pending = false;
      let marker = null;
      try {
        const built = buildCheckInScope({ who, tracking: null });
        if (built.ok === true) {
          const file = accountSyncStateFile(built.scope);
          if (readPendingCheckIn(file, built.scope, { now: now() }) === true) {
            pending = true;
            marker = { file, scope: built.scope };
          }
        }
      } catch { pending = false; marker = null; }

      try {
        // FORCED only when a marker is due. A marker means an earlier run owed a send that never
        // left the machine, so the hash gate is not what stands between the server and the truth —
        // and on an ordinary start that gate plus the seven-day heartbeat is exactly the steady
        // state this hot path wants. One call either way: draining is a reason to force the
        // check-in that was going to happen anyway, never a second request.
        const result = await syncAccount(
          token,
          { force: pending, via: CheckInVia.SESSION_START },
          { record: config, who, tracking: null, fetchImpl, timeoutMs: CHECKIN_TIMEOUT_MS },
        );
        // Cleared on SENT and on nothing else. Every other answer — offline, a 400, a fence that
        // moved — is a send still owed, and the marker is what remembers that; the stop hook's own
        // backoff keeps an offline machine from retrying on every turn.
        if (marker != null && result != null && result.outcome === CheckInOutcome.SENT) {
          clearPendingCheckIn(marker.file, marker.scope, {});
        }
      } catch { /* an account check-in must never break a session start */ }
    }

    if (isStale(config)) {
      const nudge = 'Beezi: subscription plan info is missing or stale — run the beezi-refresh skill to update your Cursor plan.';
      message = message ? `${message}\n${nudge}` : nudge;
    }
  }

  // Best-effort, and LAST: `false` prints the existing UI-path guidance, `null` and a throw are
  // silent, and `true` is silent. Nothing here changes the user's Cursor setting — the note says
  // where the switch is and why it matters, because while the setting is off Cursor ignores every
  // plugin's bundled hooks and the fallback registry is the only thing still working.
  let extensibility = null;
  try { extensibility = readExtensibility(); } catch { extensibility = null; }
  if (extensibility === false) {
    const note = extensibilityNote(false);
    if (note) message = message ? `${message}\n${note}` : note;
  }
  return message;
}
