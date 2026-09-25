import { readCursorAccount as _readCursorAccount } from './cursor-account.mjs';
import {
  BILLING_SCHEMA_VERSION,
  migrateBillingRecord,
  normalizeAccountAnchor,
  normalizeAccountEmail,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
} from './billing-config.mjs';
import { IdentityMatch, compareAnchors, observationFromAccount, reconcilePlan } from './billing-capture.mjs';
import {
  CHECKIN_STATE_VERSION,
  CheckInOutcome,
  accountSyncStateFile,
  checkInScopeKey,
} from './account-sync.mjs';
import {
  buildCheckInScope,
  syncAccountIfNeeded as _syncAccountIfNeeded,
} from './account-checkin.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { POST_TIMEOUT_MS } from './http.mjs';

// Change detection for the `stop` hook — plan §4 Phase C (C1–C4).
//
// ─── WHY THIS IS A READ AND NOT A TRIPWIRE ───────────────────────────────────────────────────
// An earlier draft guarded this work behind an mtime check on `state.vscdb`. It was measured on a
// live machine and it is wrong in BOTH directions: the database runs `journal_mode=wal`, so the
// main file's mtime moves only on a checkpoint (it MISSES the writes that land in `-wal` first),
// while `-wal`'s mtime moves constantly (it would fire on nearly every stop). The same measurement
// priced the thing the tripwire was protecting: a `?mode=ro` open plus a three-key read is 1–4 ms
// with Cursor running, and the snapshot-copy fallback is 78–91 ms. The stop hook ALREADY opens
// this database twice per turn — lib/checkpoint.mjs → resolveSessionName → readComposerData, and
// lib/delta-cursor.mjs → readUsageData. There is nothing to optimise away, so this just reads.
//
// ─── WHY IT LIVES IN lib/ AND NOT IN scripts/stop.mjs ────────────────────────────────────────
// Two reasons, both structural. The hook entries keep their STATIC imports down to the four
// bootstrap modules and reach everything else through `runHook`'s `load` callback (see the header
// of lib/hook-runner.mjs): a change-detection engine inlined into stop.mjs would put cursor-account,
// billing-capture, account-sync, http and token on the import graph that is evaluated BEFORE
// `installHookGuards` can contain anything. And `lib/session-start.mjs` is the other half of the
// `pendingCheckIn` drain; lib may not import from scripts/ (test/node-floor.test.mjs), so a marker
// written by a function that only exists inside a script could never be drained anywhere else.
//
// ─── INLINE, NOT QUEUED ──────────────────────────────────────────────────────────────────────
// The check-in is POSTed from here, synchronously, inside the hook's remaining budget. It is NOT
// enqueued, and that is load-bearing rather than a shortcut: lib/queue-delivery.mjs builds exactly
// ONE destination — `apiBase() + ENDPOINTS.sessionsReport` — and posts every queue file to it. A
// check-in record dropped into that queue would be POSTed to `/sessions/report`, where its fields
// are non-whitelisted, so the server's `forbidNonWhitelisted` pipe 400s it and the delivery path
// quarantines it. Silently. Forever. A second queue kind is out of scope for this plan.
//
// ─── THE DEGRADE IS "LATE", NEVER "WRONG" ────────────────────────────────────────────────────
// billing.json is written BEFORE the POST is attempted, so the very next session report carries
// the new identity whether or not the check-in itself got through. When the budget is too short to
// post, or the post fails, a `pendingCheckIn` marker goes into the account-sync state file and the
// next stop (or session start) drains it. Nothing waits on the network to be correct.

// Below this much remaining hook budget the POST is skipped entirely. A request started with less
// than this cannot finish, and what it would actually cost is the checkpoint that runs after us —
// `runCheckpoint` is handed the SAME `ctx.remainingMs()` and is the thing the user is here for.
export const CHECKIN_BUDGET_FLOOR_MS = 1500;

// How long a re-armed marker waits before the next attempt. A check-in that failed because the
// machine is offline will fail again one turn later, and a drain that retries on EVERY stop costs
// the user a connection attempt per turn — out of the same budget `runCheckpoint` is handed
// immediately afterwards, which is the queue flush they actually care about. The marker exists to
// make a missed check-in LATE; without this it makes every following turn slower instead.
//
// A deferral for BUDGET is not backed off: it did not fail, it never ran, and the next stop may
// have all the budget in the world.
export const PENDING_RETRY_MS = 15 * 60 * 1000;

// What the POST is not allowed to eat. The checkpoint's flush is a per-request timeout per queued
// report, so leaving it nothing is how a backlog stops draining on exactly the turns an account
// moved.
const CHECKIN_BUDGET_RESERVE_MS = 1000;

export const AccountChangeOutcome = Object.freeze({
  // The host could not be read at all, or read nothing: no IDE globalStorage (a `cursor-agent`-only
  // machine), no node:sqlite, a locked database that also failed the snapshot copy.
  NO_ACCOUNT: 'no-account',
  // Read, compared, identical. The steady state: no writes, no network.
  UNCHANGED: 'unchanged',
  // billing.json was rewritten and the check-in went out.
  CHECKED_IN: 'checked-in',
  // billing.json was rewritten; the check-in did not go out and a marker was left for the next run.
  DEFERRED: 'deferred',
  // billing.json was rewritten; nothing could be checked in and nothing can be, so no marker.
  RECORDED: 'recorded',
  // Nothing moved, but a marker from a previous run was drained.
  DRAINED: 'drained',
  // The whole check threw. The hook continues; see `runStopAccountCheck`'s catch.
  FAILED: 'failed',
});

// Why we decided something moved. Returned for the tests and the diagnostics, never persisted.
export const ChangeReason = Object.freeze({
  SWITCH: 'account-switch',
  PLAN: 'plan-changed',
  STATUS: 'status-changed',
  PAYLOAD_EMAIL: 'payload-email-mismatch',
});

// ── the scope, the transport and the call are NOT built here
//
// `lib/account-checkin.mjs` is plan §4 B3's one production entry point for the check-in, and it
// already owns every piece of wiring this path would otherwise have to reinvent: the
// `{env, beeziAccount}` scope, the `postJson(url, token, body) -> Response` /
// `postJson(endpoint, body, token) -> {ok,status,body}` adapter, the token, the real auth-epoch
// fence, and the payload built from the reconciled record. Three call sites each assembling their
// own copy of that is three chances for one of them to be subtly wrong in a way that reads as a
// server being down — which is exactly why that module exists.
//
// So this file owns the DECISION (did anything move? is there budget? is a send owed?) and
// delegates the SENDING. The only thing it needs back from the wiring is the scope, because the
// `pendingCheckIn` marker lives in the state file that scope names.
//
// `via` is local-only — it is never a payload field — so passing a spelling `CheckInVia` does not
// yet declare is safe. Adding `STOP: 'stop'` to that enum is a one-line handoff to B3's owner.
const STOP_VIA = 'stop';

// What is LEFT of the hook's budget for one POST: the remainder minus the reserve the checkpoint
// needs, capped at the ordinary POST timeout. Never a fresh full budget — `runCheckpoint` is handed
// the SAME `ctx.remainingMs()` immediately afterwards.
function checkInTimeoutMs(remainingMs) {
  return Math.max(Math.min(remainingMs - CHECKIN_BUDGET_RESERVE_MS, POST_TIMEOUT_MS), 250);
}

// ── the pending marker
//
// `readAccountSyncState` normalizes the file down to four known fields and `writeAccountSyncState`
// writes exactly those, so neither can carry a marker. The marker is therefore read and written
// here, as a raw patch over whatever is on disk.
//
// READ-MODIFY-WRITE, never a fresh object: `checkInAccount` may have just written `lastHash` and
// `lastSuccessAt` into this same file, and rebuilding it from scratch would erase the heartbeat and
// cost a redundant send on the next run.
//
// The scope guard is applied here too. `readAccountSyncState` refuses a state file whose stored
// scope does not match, and a marker must be refused for the same reason: a pending check-in
// belonging to one Beezi account must not be drained under another's credentials.
//
// NOTHING IDENTIFYING GOES IN IT. The marker says that a send is owed, not who it is owed for —
// the facts are re-derived from billing.json when it is drained. In particular the hook payload's
// `user_email` never reaches this file; see `payloadEmailMismatch`.
export function readPendingCheckIn(file, scope, deps) {
  const d = deps == null ? {} : deps;
  const read = d.readJson == null ? readJson : d.readJson;
  const now = d.now == null ? Date.now() : d.now;
  const raw = read(file);
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.scope !== checkInScopeKey(scope)) return false;
  if (raw.pendingCheckIn !== true) return false;
  // An absent or unreadable stamp is a marker that is due now — a state file written by an older
  // build, or by the budget path, must not become permanently undrainable because a field it never
  // carried could not be parsed.
  const next = raw.pendingNextAt;
  if (typeof next !== 'number' || !Number.isFinite(next)) return true;
  return now >= next;
}

function patchAccountSyncState(file, scope, patch, deps) {
  const d = deps == null ? {} : deps;
  const read = d.readJson == null ? readJson : d.readJson;
  const write = d.writeJsonSecure == null ? writeJsonSecure : d.writeJsonSecure;
  const raw = read(file);
  const base = raw != null && typeof raw === 'object' && !Array.isArray(raw) && raw.scope === checkInScopeKey(scope)
    ? raw
    : { version: CHECKIN_STATE_VERSION, scope: checkInScopeKey(scope), lastHash: null, lastSuccessAt: null };
  write(file, { ...base, ...patch });
}

export function writePendingCheckIn(file, scope, deps, options) {
  const d = deps == null ? {} : deps;
  const opts = options == null ? {} : options;
  const now = d.now == null ? Date.now() : d.now;
  patchAccountSyncState(file, scope, {
    pendingCheckIn: true,
    pendingNextAt: opts.backoff === true ? now + PENDING_RETRY_MS : 0,
  }, deps);
}

export function clearPendingCheckIn(file, scope, deps) {
  patchAccountSyncState(file, scope, { pendingCheckIn: false, pendingNextAt: 0 }, deps);
}

// ── C4: the hook payload's `user_email`
//
// PRIVACY, AND IT IS NOT NEGOTIABLE. The live Cursor `stop` payload carries `user_email`.
// `lib/hook-input-cursor.mjs` refuses to carry it into the normalized input and
// `test/cursor-version.test.mjs` locks that refusal; both stay exactly as they are. This function
// is the ONLY thing on this path that looks at the value: it is read from the payload, lowercased
// through `normalizeAccountEmail`, compared, and dropped when this function returns. It is not
// assigned to anything that outlives the comparison — not normalized, not stamped on a sidecar
// line, not written to billing.json, not written to the marker, and not hashed into any stored
// value. `test/stop-account-change.test.mjs` asserts that with an address that appears nowhere
// else.
//
// ABSENT IS NOT A MISMATCH, and getting this wrong is the worst bug available here. A v3 machine
// read from state.vscdb routinely has `accountAnchor.email === null` and only an `accountId`;
// treating "one side has no email" as a mismatch would force the change branch on EVERY stop, and
// a forced change branch that resolves to a switch runs `blankedForSwitch`, which destroys the
// stored plan. So this applies `compareAnchors`' own rule: an identity missing on either side is
// `unknown` — not a match, and not a switch.
export function payloadEmailMismatch(payload, anchor) {
  if (payload == null || typeof payload !== 'object') return false;
  if (anchor == null) return false;
  const fromPayload = normalizeAccountEmail(payload.user_email);
  if (fromPayload === null) return false;
  const stored = normalizeAccountEmail(anchor.email);
  if (stored === null) return false;
  return fromPayload !== stored;
}

// ── C2: did anything move?
//
// `compareAnchors` first, because it is the only comparison that can tell a seat apart from
// another seat; then the plan and the status, which move under a seat that did not change at all
// (an upgrade, a cancellation). Then the payload email, which is corroboration only.
//
// On the payload-email trigger, note what the observation still says: vscdb has not caught up, so
// `observationFromAccount` describes the OLD account. `reconcilePlan` will compare it against the
// stored anchor and answer MATCH, so nothing is destroyed — what the trigger buys is a forced
// check-in that re-sends the tuple, and the next stop (by which point vscdb has caught up) sees
// the real switch. That is the whole intent: a mismatch must never be able to blank a plan on the
// strength of a hook payload field, because the payload is not the identity authority (plan §3.2).
export function detectChange(observedAnchor, record, observation, payload) {
  const storedAnchor = record == null ? null : record.accountAnchor;
  if (compareAnchors(observedAnchor, storedAnchor) === IdentityMatch.SWITCH) return ChangeReason.SWITCH;
  const storedPlan = record == null ? null : record.plan;
  const observedPlan = observation == null ? null : observation.plan;
  // `unknown` on the observed side is not a plan change: it is a read that learned nothing, and
  // `reconcilePlan` already preserves the stored plan for it. Acting on it would force a check-in
  // every turn on any machine whose tier string we do not map.
  if (observedPlan != null && observedPlan !== 'unknown' && storedPlan !== observedPlan) return ChangeReason.PLAN;
  const storedStatus = record == null ? null : record.subscriptionStatus;
  const observedStatus = observation == null ? null : observation.status;
  if (observedStatus != null && storedStatus !== observedStatus) return ChangeReason.STATUS;
  if (payloadEmailMismatch(payload, storedAnchor)) return ChangeReason.PAYLOAD_EMAIL;
  return null;
}

// ── C1–C4: the whole check

// Called from the stop hook's handler, AFTER the turn boundary is appended and BEFORE
// `runCheckpoint`. It never throws: every failure inside it is caught and answered as FAILED, so a
// Cursor-less machine, an unreadable database or a broken credential store cannot cost the user
// their checkpoint. The caller wraps it a second time for the same reason — see scripts/stop.mjs.
//
//   ctx   — the hook context: `{ payload, remainingMs() }`.
//   deps  — seams, all optional. `{ readAccount, readConfig, writeConfig, now, floorMs, readJson,
//            writeJsonSecure }` are this module's own; `{ envName, currentAccountKey, postJson,
//            getAccessToken, authEpoch, fetchImpl, syncAccountIfNeeded }` are forwarded to
//            lib/account-checkin.mjs and must be the SAME two identity seams this module builds
//            the marker's scope from, or a marker would be written beside the state file the
//            check-in actually used.
//
// Returns `{ outcome, reason, checkIn, skipped, writeback, persisted, remainingMs }`. The return
// value is for tests and diagnostics; the hook ignores it.
export async function runStopAccountCheck(ctx, deps) {
  const c = ctx == null ? {} : ctx;
  const d = deps == null ? {} : deps;
  const now = d.now == null ? Date.now() : d.now;
  const remainingMs = typeof c.remainingMs === 'function' ? c.remainingMs() : 0;
  const floorMs = d.floorMs == null ? CHECKIN_BUDGET_FLOOR_MS : d.floorMs;
  const payload = c.payload;

  const answer = (outcome, extra) => ({
    outcome,
    reason: null,
    checkIn: null,
    skipped: null,
    writeback: null,
    persisted: false,
    remainingMs,
    ...(extra == null ? {} : extra),
  });

  // C1 — read the host. ENOENT on a `cursor-agent`-only machine with no IDE globalStorage, a throw
  // from a half-written database, a cli-config.json with no `authInfo` (it now carries the CLI's
  // email and auth id, but no plan): none of them may break the user's stop hook, so all of them
  // answer null.
  let account = null;
  try {
    account = (d.readAccount == null ? _readCursorAccount : d.readAccount)();
  } catch {
    account = null;
  }

  const readConfig = d.readConfig == null ? _readBillingConfig : d.readConfig;
  const writeConfig = d.writeConfig == null ? _writeBillingConfig : d.writeConfig;
  let config = null;
  try {
    config = readConfig();
  } catch {
    config = null;
  }
  const record = migrateBillingRecord(config, { now }).record;

  // The SAME scope `syncAccountIfNeeded` will build, from the same two seams, because the marker
  // lives in the file that scope names. A scope that cannot be built — no recorded whoami, an
  // invalid `BEEZI_CURSOR_ENV` — is refused rather than degraded: nothing is drained and nothing
  // is marked on such a machine, because a marker nobody can name is a marker nobody can drain.
  // billing.json is still reconciled below, which is the half that keeps the degrade "late".
  const built = buildCheckInScope({ envName: d.envName, currentAccountKey: d.currentAccountKey });
  const scoped = built.ok === true;
  const scope = scoped ? built.scope : null;
  const stateFile = scoped ? accountSyncStateFile(scope) : null;

  const observation = account == null ? null : observationFromAccount(account, 'stop');
  const observedAnchor = observation == null ? null : normalizeAccountAnchor({
    email: observation.email,
    accountId: observation.accountId,
    subscriptionId: observation.subscriptionId,
    source: observation.source,
  });

  // C2 — the steady state. Unchanged means no writes and no network, and the only thing that may
  // still happen is draining a marker an earlier run left behind.
  const reason = detectChange(observedAnchor, record, observation, payload);
  if (reason === null) {
    if (!scoped || !readPendingCheckIn(stateFile, scope, d)) return answer(AccountChangeOutcome.UNCHANGED);
    const drained = await attemptCheckIn({
      record,
      scope,
      stateFile,
      now,
      remainingMs,
      floorMs,
      // A marker means an earlier run owed a send that never landed, so the heartbeat gate is not
      // the thing standing between the server and the truth.
      force: true,
      deps: d,
    });
    return answer(AccountChangeOutcome.DRAINED, {
      checkIn: drained.checkIn, skipped: drained.skipped, writeback: drained.writeback,
    });
  }

  // C3 — reconcile, persist, then check in.
  //
  // `force` is deliberately NOT passed to `reconcilePlan`. The seven-day recheck gate it would
  // bypass only affects `persist` in the KEPT branch, and every branch that can be reached from a
  // detected change persists on its own; what `force` WOULD additionally do is let this hook
  // overwrite a billing.json written by a NEWER plugin version, unasked. That escape hatch belongs
  // to a user typing `--force`, not to a background turn boundary.
  let result;
  try {
    result = reconcilePlan(observation, config, { now, attempted: account != null });
  } catch {
    return answer(AccountChangeOutcome.FAILED, { reason });
  }

  // `persist` says whether the reconciled record differs from what is on disk in a way worth a
  // write. Honouring it is what stops a payload-email trigger — which frequently reconciles to
  // exactly the stored record — from rewriting the file on every turn.
  //
  // ONE EXCEPTION, and it is a real gap rather than a preference. `reconcilePlan`'s KEPT branch
  // computes `persist` from the plan, the anchor and the seven-day recheck gate; it does not
  // consider `subscriptionStatus` at all. So a seat whose plan string is unchanged but whose Stripe
  // status has gone `active -> past_due` reconciles to a record carrying the new status and then
  // refuses to write it — the exact event the status field was added to make visible. It is forced
  // through here, and only here, because lib/billing-capture.mjs is owned elsewhere this cycle.
  //
  // Not forced over a record written by a NEWER plugin: that branch returns `record === prior` and
  // rewriting it is a downgrade dressed as a status update. `--force` remains its escape hatch.
  const priorVersion = record == null || typeof record.version !== 'number' ? BILLING_SCHEMA_VERSION : record.version;
  const forStatus = reason === ChangeReason.STATUS && priorVersion <= BILLING_SCHEMA_VERSION;
  let persisted = false;
  if ((result.persist === true || forStatus) && result.record != null) {
    try {
      writeConfig(result.record);
      persisted = true;
    } catch {
      persisted = false;
    }
  }

  if (!scoped) return answer(AccountChangeOutcome.RECORDED, { reason, persisted });

  const attempt = await attemptCheckIn({
    record: result.record,
    scope,
    stateFile,
    now,
    remainingMs,
    floorMs,
    // Forced for the three triggers that describe a NEW tuple — a switch, a plan, a status. NOT
    // forced for the payload-email trigger: that one compares the hook payload against an anchor
    // the reconcile cannot move, so it re-fires on every turn until vscdb catches up. Forcing it
    // would turn "corroborating signal" into an unconditional POST on every stop, twice over (both
    // hook registries fire). Left unforced, the first one sends and the rest answer SKIPPED —
    // which is the honest answer: there is no new tuple to send.
    force: reason !== ChangeReason.PAYLOAD_EMAIL,
    deps: d,
  });

  return answer(attempt.deferred ? AccountChangeOutcome.DEFERRED : AccountChangeOutcome.CHECKED_IN, {
    reason,
    persisted,
    checkIn: attempt.checkIn,
    skipped: attempt.skipped,
    writeback: attempt.writeback,
  });
}

// One forced, inline, budget-bounded check-in, plus the marker bookkeeping around it.
//
// `force: true` throughout: the caller has already established that something moved (or that an
// earlier run owed a send), and the heartbeat gate (24 h, lib/account-sync.mjs) exists to suppress
// redundant traffic, not to delay a subscription change by a day.
//
// The marker rules, in one place so they cannot drift:
//   * below the floor                 → no POST at all, marker written.
//   * SENT                            → marker cleared.
//   * anything else that was ATTEMPTED → marker written WITH A BACKOFF, so the next stop retries
//     but an offline machine does not spend a connection attempt on every turn of the day.
//   * DISABLED / UNCONFIGURED / SCHEMA / UNLINKED / SKIPPED → no marker. None of them gets better
//     by being retried (SKIPPED means the server already has this exact tuple), and a marker that
//     can never clear would force a doomed POST on every stop forever.
//
// `force` skips `isCheckInDue`'s hash gate, and it is NOT unconditional. See the call site: the
// payload-email trigger compares against a value no reconcile can change, so it fires on every
// turn until vscdb catches up — with `force` that would be an unconditional POST per turn, per
// registry, forever. Without it the hash gate answers SKIPPED the second time, which is the truth:
// there is no new tuple to send.
async function attemptCheckIn(args) {
  const d = args.deps;
  const sync = d.syncAccountIfNeeded == null ? _syncAccountIfNeeded : d.syncAccountIfNeeded;

  if (args.remainingMs < args.floorMs) {
    try {
      // No backoff: this did not fail, it never ran. The next stop may have the whole budget.
      writePendingCheckIn(args.stateFile, args.scope, d, { backoff: false });
    } catch { /* a marker we could not write costs one late check-in, nothing else */ }
    return { deferred: true, checkIn: null, skipped: null, writeback: null };
  }

  // The RECONCILED RECORD is the whole input. `checkInPayloadFromRecord` takes the raw tier string
  // from `record.subscriptionType` — which is where `reconcilePlan` puts the observation's
  // `rawPlan` — so the host is never read a second time and what is sent is exactly what was
  // stored. It is also what makes the DRAIN path work when the host could not be read at all: the
  // marker is about a send that is owed, not about a fresh read.
  let outcome;
  try {
    outcome = await sync(null, { force: args.force === true, via: STOP_VIA }, {
      record: args.record,
      now: args.now,
      timeoutMs: checkInTimeoutMs(args.remainingMs),
      envName: d.envName,
      currentAccountKey: d.currentAccountKey,
      postJson: d.postJson,
      getAccessToken: d.getAccessToken,
      authEpoch: d.authEpoch,
      fetchImpl: d.fetchImpl,
    });
  } catch {
    // `syncAccountIfNeeded` documents that it never throws. Belt and braces: this runs inside a
    // hook, and a rejection escaping here would reach runHook as `hook_crash`.
    outcome = { outcome: null, successful: false, writeback: null, skipped: 'error' };
  }

  const answered = outcome == null ? null : outcome.outcome;
  const sent = answered === CheckInOutcome.SENT;
  // No marker when no request could be built (`skipped` — no token, no record, no scope, nothing
  // to report) and none for the protocol answers that do not get better by being retried. SKIPPED
  // in particular means the server ALREADY has this exact tuple, so arming a marker for it would
  // schedule a POST whose only possible outcome is another SKIPPED, on every stop, forever.
  const noMarker = (outcome != null && outcome.skipped != null)
    || answered === CheckInOutcome.DISABLED
    || answered === CheckInOutcome.UNCONFIGURED
    || answered === CheckInOutcome.SCHEMA
    || answered === CheckInOutcome.UNLINKED
    || answered === CheckInOutcome.SKIPPED;
  try {
    if (sent) clearPendingCheckIn(args.stateFile, args.scope, d);
    else if (!noMarker) writePendingCheckIn(args.stateFile, args.scope, d, { backoff: true });
  } catch { /* see above */ }

  // `writeback` is RETURNED, not applied — the same rule lib/account-checkin.mjs states for its
  // own callers. A plan a portal admin set by hand is a user-visible change to the record this
  // plugin prices a seat from, and the interactive call sites (`/beezi:refresh`, session start,
  // login) are where it is applied and reported. A turn boundary silently rewriting the user's
  // tier is not a thing a stop hook should be able to do.
  return {
    deferred: false,
    checkIn: answered,
    skipped: outcome == null ? null : outcome.skipped,
    writeback: outcome == null ? null : outcome.writeback,
  };
}

// The schema version this module writes through `reconcilePlan`. Re-exported so a caller that
// wants to assert the record it got is the current shape does not have to import two modules.
export { BILLING_SCHEMA_VERSION };
