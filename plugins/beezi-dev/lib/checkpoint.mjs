import fs from 'fs';
import path from 'path';
import { computeDelta as _computeDelta, BILLING_POOL, dedupeEvents } from './delta-cursor.mjs';
import { claimIntervals, mergeIntervals, subtractIntervals, totalMs } from './active-time.mjs';
import { correlateSubagents, subagentIntervals } from './subagents-cursor.mjs';
import { countEvents as _countEvents, readEventsFrom } from './sidecar-read.mjs';
import { authEpoch as _authEpoch, forceRefresh as _forceRefresh, getAccessToken as _getAccessToken } from './token.mjs';
import { pendingBatchFile, queueDir, sessionStateFile } from './paths-cursor.mjs';
import {
  git, currentBranch, resolveOriginRemote, localRemoteFromRoot,
  clampBranch, UNATTRIBUTED_REMOTE,
} from './git.mjs';
import { currentAccountKey, isLiveTrackingAllowed } from './tracking.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { POST_TIMEOUT_MS } from './http.mjs';
import { HOOK_TIMEOUT_SEC } from './hooks-install.mjs';
import { HOOK_GUARD_MARGIN_MS } from './hook-runner.mjs';
import { safeName } from './sidecar.mjs';
import { lazyRecordIssue } from './diagnostics-sink.mjs';
import { sessionLockPath, withLock } from './lock.mjs';
import { deliverQueue } from './queue-delivery.mjs';
import { postSessionError } from './session-error-report.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline-cursor.mjs';
import {
  drainTimelineOutbox, dropTimelineOutbox, readTimelineOutbox, takeAuthSnapshot, timelineSigOf,
  timelineStatusOf, writeTimelineOutbox,
} from './timeline-outbox.mjs';
import { withCliSubagents } from './cli-subagents-cursor.mjs';
import { cursorVersionAt } from './sidecar-events.mjs';
import { planAttributionRuns } from './attribution-cursor.mjs';
import { detectBillingSource } from './billing.mjs';
import {
  readBillingConfig, subscriptionReportFields, thirdPartyReportFields, normalizeAccountAnchor,
} from './billing-config.mjs';
import { resolveSessionName } from './session-name-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// Where one conversation's state lives, or null when its id cannot be made into a filename.
//
// `session_id` is Cursor's `conversation_id` and arrives from a hook payload, so it is UNTRUSTED
// INPUT ON A PATH. lib/sidecar.mjs has always run the identical value through `safeName` before
// touching the disk; this module built `state/<id>.json` and the queue filename straight from it,
// and that inconsistency was the bug. Two verified failures on Windows, where `path.join` treats
// `\` as a separator:
//
//   `..\..\..\evil` — the state file lands OUTSIDE the data root entirely.
//   `a\b`           — `state/a/` is silently created and `b.json` written inside it. `readJson` on
//                     `state/a\b.json` then returns null every hook, so the cursor resets to 0,
//                     `flushQueue` never sees the segment, and lib/prune.mjs:23's `unlinkSync`
//                     throws EISDIR on the directory — so the segment is lost forever AND the mess
//                     is never cleaned up.
//
// The old queue filename used a `[:/\s]` blacklist, which happens to produce exactly what `safeName`
// produces for a well-formed `conv-1:0-4` — so no existing queue file changes shape — but it missed
// `\` and `..`, and the segmentId is derived from the same untrusted id.
//
// One sanitizer for one value: a second, subtly different implementation is how one of these paths
// ends up escaping its directory again. The SHAPE of the path — `<name>.json` under stateDir() —
// has one owner too, `sessionStateFile` in lib/paths-cursor.mjs, which the backfill's live-cursor
// belt reads through as well; it takes an already-sanitized name, because paths-cursor cannot
// import the sanitizer (lib/sidecar.mjs imports paths-cursor, so the arrow only points one way).
function stateFile(id) {
  const name = safeName(id);
  return name === null ? null : sessionStateFile(name);
}

function loadState(id) {
  const fresh = { cursor: 0, sentSessionName: null, anchor: null };
  const file = stateFile(id);
  return file === null ? fresh : readJson(file, fresh);
}

function saveState(id, state) {
  const file = stateFile(id);
  // An id with no safe filename has no lock either (`sessionLockPath` returns null for one), so the
  // guarded section never runs and this is unreachable in practice. It is here so the load/save pair
  // cannot drift into writing somewhere `loadState` would not read back.
  if (file === null) return;
  writeJsonSecure(file, state);
}

// The one place a queued report's filename is derived, so the writer, the pre-existence check and
// the pending batch's recovery cannot disagree about which file a segmentId names. Null when the id
// has no safe filename at all.
function queueFileFor(segmentId) {
  const name = safeName(segmentId);
  return name === null ? null : path.join(queueDir(), `${name}.json`);
}

function enqueue(payload) {
  // 0600: these payloads carry session_name (prompt text), remote, and branch.
  const file = queueFileFor(payload == null ? undefined : payload.segmentId);
  // Throwing rather than silently skipping: every caller of `enqueue` is already wrapped in a
  // try/catch that declines to advance the cursor, which is the behaviour an unusable segmentId
  // needs — the window is re-examined next checkpoint instead of being reported into a path that
  // is not the queue.
  if (file === null) throw new Error('beezi: segmentId cannot be made into a filename');
  writeJsonSecure(file, payload);
}

// `enqueue` that refuses to overwrite. The pending batch replays its items after a crash, and an
// item whose queue file already exists is ALREADY the identical bytes under the identical id — the
// payloads were frozen before the first write. What that file may additionally carry is `_retry`
// (attempts, nextAttemptAt, firstQueuedAt) from a send that already failed, and rewriting it would
// reset the backoff and the age the retention sweep measures. Skipping satisfies "requeue identical
// ids and bytes" at no cost; overwriting silently un-ages a record that has been failing for days.
//
// Returns whether it wrote, so a caller can tell a fresh enqueue from a replay of one.
function enqueueIfAbsent(payload) {
  const file = queueFileFor(payload == null ? undefined : payload.segmentId);
  if (file === null) throw new Error('beezi: segmentId cannot be made into a filename');
  // `isFile`, not `existsSync`. A directory at the queue path is a real field failure — an earlier
  // build could create one, and the subagent tests manufacture it — and `existsSync` would read it
  // as "already queued" and skip the item forever. Anything that is not a plain file falls through
  // to `writeJsonSecure`, whose rename then throws, which is the honest answer: this item is NOT
  // queued, so the batch must not commit.
  let queuedAlready = false;
  try { queuedAlready = fs.statSync(file).isFile(); } catch { queuedAlready = false; }
  if (queuedAlready) return false;
  writeJsonSecure(file, payload);
  return true;
}

// ── the pending batch
//
// `state/<id>.json` is COMMITTED TRUTH — cursor, cursorBytes, usageSnapshot, coveredIntervals,
// anchor. A pending batch is UNCOMMITTED INTENT. They are two files because one atomic write
// cannot carry both: a crash between "the batch is durable" and "the state is committed" would be
// indistinguishable from "neither happened", which is the exact ambiguity this record exists to
// remove. With it, the disk always says which of the two it is.
//
// The ordering contract, and every step of it is load-bearing:
//
//   1. build the payloads and the proposed `next`   — nothing durable yet
//   2. write this record, atomically, BEFORE the first enqueue
//   3. `enqueueIfAbsent` every item, in order
//   4. only then apply `next` and save the state
//   5. only then unlink this record
//
// A crash at any point leaves either no record (nothing happened) or a record whose `next.cursor`
// against the live `state.cursor` says exactly which half landed.
const PENDING_VERSION = 1;

// What a recovered record means for this run.
const PENDING = Object.freeze({
  // No record, or nothing to do.
  NONE: 'none',
  // Items may not all be queued and `next` is not committed: replay steps 3-4-5 and STOP. The
  // frozen window is what gets committed, never a re-read of a sidecar that has grown since.
  RESUME: 'resume',
  // `next` is already committed; only the unlink was lost. Delete and carry on normally.
  DONE: 'done',
  // Another account's batch, an unknown version, or a malformed record. Do NOT enqueue and do NOT
  // commit: putting another tenant's payloads on the wire under these credentials, or advancing
  // this account's cursor over work reported to a different one, are both worse than one orphaned
  // file. lib/prune.mjs's 14-day sweep collects it.
  FOREIGN: 'foreign',
});

function pendingFile(id) {
  const name = safeName(id);
  return name === null ? null : pendingBatchFile(name);
}

function loadPendingBatch(id) {
  const file = pendingFile(id);
  return file === null ? null : readJson(file, null);
}

function savePendingBatch(id, batch) {
  const file = pendingFile(id);
  // Unreachable in practice: an id with no safe filename has no session lock either, so the guarded
  // section this is called from never runs. Here so the writer cannot drift from `loadPendingBatch`.
  if (file === null) throw new Error('beezi: session id cannot be made into a filename');
  writeJsonSecure(file, batch);
}

function dropPendingBatch(id) {
  const file = pendingFile(id);
  if (file === null) return;
  try { fs.unlinkSync(file); } catch { /* already gone — the delete is idempotent by design */ }
}

// `account` is the stamp THIS run reports under; `cursor` is the live `state.cursor`.
function classifyPendingBatch(batch, sessionId, account, cursor) {
  if (batch == null || typeof batch !== 'object') return PENDING.NONE;
  // Every one of these is "a record this build cannot reason about", and the answer to all of them
  // is the same: leave it alone. A version bump is how a future shape announces itself.
  if (batch.version !== PENDING_VERSION) return PENDING.FOREIGN;
  if (batch.sessionId !== sessionId) return PENDING.FOREIGN;
  if (!Array.isArray(batch.items)) return PENDING.FOREIGN;
  if (batch.next == null || typeof batch.next !== 'object') return PENDING.FOREIGN;
  // A cursor-less commit is legitimate, not malformed: the session-name replay stages the anchor
  // again with a corrected name and commits `{ sentSessionName }` alone, leaving the cursor exactly
  // where it was. Reading that as FOREIGN would strand a perfectly ordinary record — never
  // enqueued, never committed — until the 14-day sweep, and lose the rename with it.
  if (batch.next.cursor !== undefined && !Number.isFinite(batch.next.cursor)) return PENDING.FOREIGN;
  // Strict equality, null included: a batch built before any login recorded an email carries
  // `account: null`, and it is this machine's own only while that is still true.
  if ((batch.account == null ? null : batch.account) !== (account == null ? null : account)) {
    return PENDING.FOREIGN;
  }
  // With no cursor in the commit there is nothing to compare, so "has this already landed?" cannot
  // be answered from the cursor. RESUME is the safe answer: `enqueueIfAbsent` will not rewrite a
  // queue file that is already there, and re-applying a `sentSessionName` is idempotent.
  if (batch.next.cursor === undefined) return PENDING.RESUME;
  return cursor >= batch.next.cursor ? PENDING.DONE : PENDING.RESUME;
}

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone == null ? null : timeZone;
  } catch {
    return null;
  }
}

// How long a checkpoint run may spend before it must be finished. A host that kills a hook at its
// registered timeout reports the kill as a failed hook — which is what "hook failed (exit code 1)"
// alongside perfectly good analytics means: the work landed, the process was still running. The
// margin covers what is not network here (git shell-outs, sidecar parsing, state writes) plus
// node's own startup.
// The margin is `HOOK_GUARD_MARGIN_MS`, not a literal: lib/hook-runner.mjs subtracts the same
// number for the same reason, and while they were equal only by agreement, changing one would move
// the runner's per-hook deadline and leave this budget aimed at the old margin with nothing failing.
export const HOOK_BUDGET_MS = HOOK_TIMEOUT_SEC * 1000 - HOOK_GUARD_MARGIN_MS;

// Cursor never sees a token count. The model call is proxied through Cursor's backend, so no
// `usage` block reaches this machine — confirmed three ways (no hook payload carries tokens or
// cost; the shipped client's setTokenUsage is an in-memory telemetry span that is never persisted;
// cache read/write tokens are server-side by construction). Reporting zeros is the honest answer:
// spend for Cursor is carried by `cost_usd` + `billing_pool` per model entry, and activity is
// carried by `operations`/`est_tokens`. Estimating tokens from transcript text was rejected in
// design — transcripts exclude tool outputs and cache reads, so estimates are systematically low
// in a way users cannot see.
//
// This is also, permanently, a SUBAGENT segment's answer. The two events that do carry a turn's
// usage key it to a generation, and nothing anywhere in Cursor attributes a generation to the worker
// that made it — which is why a subagent segment carries time and identity and nothing else.
const NO_TOKENS = Object.freeze({
  token_total: 0,
  token_input: 0,
  token_output: 0,
  token_cache: 0,
});

// What the design above says was impossible turns out to be available on exactly two events.
// Cursor's `stop` and `afterAgentResponse` hook payloads carry that turn's
// aiserver.v1.TokenUsage — input_tokens, output_tokens, cache_read_tokens, cache_write_tokens —
// keyed to a generation_id. Every other event carries none, which is why the zeros above remain the
// answer whenever a window contains no turn-end: reporting a real zero for an unobserved figure is
// the mistake this plugin was built to avoid, so the fields are only replaced when a generation in
// the window actually reported them.
//
// `token_cache` is the sum of the two cache directions, because that is the only cache field the
// ingest route accepts. The read/write split still reaches the server inside `models`, which is
// stored opaquely — the top level is a fixed DTO and is NOT the place to add fields.
//
// This route is a frozen contract shared with the Claude Code and Codex plugins, and the server
// validates it as a whitelist: two extra top-level keys (`token_cache_read`, `token_cache_write`)
// made every report 400 with `BadRequestException` from Nest's ValidationPipe, throwing away the
// segment's tokens, cost, code changes and operations together. See the payload-shape test.
// `token_total` INCLUDES cache. That is the Claude Code plugin's definition
// (`token_input + token_output + token_cache`, where token_cache is read + creation) and the
// server's own (`usageTokenTotal`, which is what actually lands in `tokensTotal`). This field is a
// shared column across agents, so a second definition would make the two incomparable in exactly
// the reports that are meant to be compared.
function tokenFields(tokens) {
  if (!tokens) return NO_TOKENS;
  const input = tokens.token_input == null ? 0 : tokens.token_input;
  const output = tokens.token_output == null ? 0 : tokens.token_output;
  const cacheRead = tokens.token_cache_read == null ? 0 : tokens.token_cache_read;
  const cacheWrite = tokens.token_cache_write == null ? 0 : tokens.token_cache_write;
  const cache = cacheRead + cacheWrite;
  return {
    token_total: input + output + cache,
    token_input: input,
    token_output: output,
    token_cache: cache,
  };
}

// One `models` entry per (model, pool), from delta-cursor's entries.
//
// A LIST, not the record keyed by model that Claude Code and Codex send. Cursor is the only agent
// whose one model in one segment can legitimately have two rows — the seat covered part of it and
// paid credits covered the rest — and a record keyed by model cannot hold both. It used to hold
// them by appending the pool to the key (`"claude-4.5-sonnet#subscription"`), which meant the model
// id was no longer a model id: every consumer had to know to strip the suffix before showing,
// pricing or grouping it, and any one that forgot showed users a pool name welded to their model.
// The pool has a field of its own here, so the id stays clean the whole way through.
//
// A straight rename-and-default, with no merging of its own: computeDelta emits at most one entry
// per (model, pool) by construction, and the server collapses any that do collide anyway
// (SessionReportService.aggregateByModelAndPool, on the resolved identity — strictly coarser than
// anything this side could match). A second merge identity here would only be one more thing to
// keep in step with the one that actually decides the row.
function modelsFrom(entries) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry != null && typeof entry.model === 'string' && entry.model !== '')
    .map((entry) => ({
      model: entry.model,
      billing_pool: entry.billing_pool,
      requests: count(entry.requests),
      ...(Number.isFinite(entry.cost_usd) ? { cost_usd: entry.cost_usd } : {}),
      // The per-model half of the token counts Cursor gives a turn-end hook. Zero stays zero when
      // the window carried no turn-end, so a row never claims a figure that was not observed.
      token_input: count(entry.token_input),
      token_output: count(entry.token_output),
      token_cache_read: count(entry.token_cache_read),
      token_cache_creation: count(entry.token_cache_write),
    }));
}

// The backend's column width for `agent_name`. The value is the subagent's `task` — a free-text
// description written by whoever spawned it — so it is the one subagent field with no natural bound.
// Enforced here rather than trusted: an over-long string is a validation failure, and a validation
// failure takes the WHOLE report with it, not the field.
const MAX_AGENT_NAME_CHARS = 200;

// ── who this session belongs to (plan §4 D)
//
// The two identity keys the backend resolves a session to a subscription row with:
//
//     account_uuid   <- accountAnchor.accountId    (this SEAT's signed-in Cursor identity)
//     account_email  <- accountAnchor.email
//
// Both are already declared on `SessionReportRequestDto`, so the frozen /sessions/report route does
// not change — this only starts filling two columns that were always there and always null.
//
// WHY THIS IS NOT PART OF `subscriptionReportFields`. That helper takes `billingSource` as its first
// argument and returns `{}` for a source `isPlanBearing` rejects, because WHICH PLAN THE SEAT IS ON
// is a fact about who pays. WHICH SEAT THIS IS is not: the account is the same account whether the
// window was covered by the seat's included allowance or by on-demand credits, and it would still be
// the same account on a source that pays for no plan at all. Folding these two keys into a
// plan-bearing gate would mean "we spent credits this window" silently also meant "we will not say
// whose session this was", which is exactly the resolution the server needs most.
//
// Measured, so the argument above is not only reasoning: `detectBillingSource` in lib/billing.mjs can
// only ever return SUBSCRIPTION or CURSOR_CREDITS for Cursor, and `PLAN_BEARING` contains both — so
// on THIS fork there is no source today that would discriminate the two helpers. The separation is
// held on the coupling argument and on the sibling forks, where THIRD_PARTY and OPENAI_API_KEY are
// reachable and are precisely the sources that would drop an identity they still have.
//
// The anchor is read through `normalizeAccountAnchor` rather than off the raw JSON: billing.json is
// a file on disk that a rolled-back client, a half-finished write or a hand edit can leave in any
// shape, and an anchor whose `source` is missing cannot say which read produced the identity — that
// is the pairing the reconciler must never invent, and it must not be invented on the wire either.
//
// Ids are never TRUNCATED. An Auth0 enterprise connection mints `samlp|<connection>|<nameId>` well
// past 64 chars, and a truncated id is not a shorter id, it is a WRONG id that mints a phantom
// subscription row nothing will ever match again. Contrast `agent_name` above, which IS capped —
// free text losing its tail costs a prettier label.
//
// But an over-length id is OMITTED rather than emitted, until the widening migration (plan §4 E5)
// is deployed. The deployed DTO still declares `@MaxLength(64)` on `account_uuid`, and a length
// violation is not a field-level failure: the global ValidationPipe rejects the WHOLE request, so
// one SSO seat would lose every session report it ever sends — all its tokens, cost, timeline and
// repo attribution — not merely its account column. "Rejected loudly" is only recoverable when the
// rejection is small; this one is total, and it lands on Team/SSO seats, which is exactly the
// population E5 exists to serve.
//
// Omission is not mis-attribution. A report with no `account_uuid` falls through to the server's
// email-anchored resolution and lands on a provisional row, which the next check-in that carries a
// short-enough id absorbs — sessions, credentials and links relinked, provisional row deleted. So
// the degraded path is "attributed a little later", never "attributed to the wrong subscription".
//
// Delete this cap when E5 is deployed and the fixture's `deployed_maxLength` for `account_uuid`
// reads 255. The plan's §6 ordering (migration, verify every tenant, then code) is what retires it.
const WIRE_ACCOUNT_ID_MAX = 64;

function accountReportFields(config) {
  if (!config) return {};
  const anchor = normalizeAccountAnchor(config.accountAnchor);
  if (anchor == null) return {};
  // Same omit-never-null rule as `subscriptionReportFields`, for the same reason: absent says "I
  // have nothing to say about this column", null says "set this column to null". A machine whose
  // Cursor has not cached an address must not blank an email the backend learned from the check-in.
  const fields = {};
  if (anchor.accountId != null && anchor.accountId.length <= WIRE_ACCOUNT_ID_MAX) {
    fields.account_uuid = anchor.accountId;
  }
  if (anchor.email != null) fields.account_email = anchor.email;
  // `anchor.subscriptionId` is READ here and deliberately NOT emitted, under any key. It is the
  // subscription the seat belongs to, and on a Team plan it is the PAYING OWNER's id — putting it on
  // the wire would upsert every member of a team onto one account row, churn that row's email to
  // whoever reported last, and absorb-and-DELETE each member's own row (plan §3.1). It stays local,
  // as a switch signal for `compareAnchors`, until a server field exists that means what it means.
  return fields;
}

// The `models` list for a SUBAGENT segment: the parent's model identity and billing pool, with every
// count zeroed.
//
// This exists because of a backend behaviour that makes the obvious implementation silently do
// nothing. The ingest service checks each report for a storable signal before it writes: a report
// whose model entries are all unpriced, all zero-token and carry no `billing_pool` is answered
// `200 {status:"stored"}` and NO ROW IS WRITTEN. A subagent segment is zero-token by construction —
// Cursor exposes no per-subagent usage anywhere, which is why `duration_sec` is the only quantitative
// thing one of these segments can say — so the naive `models: []` version lands exactly on that path:
// accepted, apparently fine, permanently invisible. Carrying the pool (and the model id beside it, so
// the row is not a nameless placeholder) is what gives the entry something to be stored for.
//
// EVERY COUNT IS ZERO AND THAT IS NOT A PLACEHOLDER — it is the only honest value. The parent's
// requests, tokens and cost are already reported on the main segment for this same window; repeating
// any of them here would bill the same spend twice under a second segmentId, which is precisely the
// failure the interval union below exists to prevent for time. So the row names WHICH model was in
// play while the subagent ran and contributes nothing to any sum.
//
// The model identity is the PARENT's, because Cursor never says what a subagent ran on. It is an
// inference, not an observation — a defensible one (a Cursor subagent runs on the account's selected
// model, and there is no other candidate on the machine), but it is the reason a subagent row must
// never carry a figure that could be mistaken for a measurement.
function subagentModelsFrom(entries) {
  const seen = new Set();
  const out = [];
  // U+001F (ASCII Unit Separator) joins the two halves of the key, so a model id ending in the
  // pool name cannot collide with a different split. It is deliberately NOT a NUL, which was here
  // first: ripgrep treats a NUL byte as proof the file is binary and skips it entirely, so every
  // grep over this file - the longest in the plugin - silently returned nothing.
  for (const entry of modelsFrom(entries)) {
    const key = `${entry.model}${entry.billing_pool == null ? '' : entry.billing_pool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      model: entry.model,
      billing_pool: entry.billing_pool,
      requests: 0,
      token_input: 0,
      token_output: 0,
      token_cache_read: 0,
      token_cache_creation: 0,
    });
  }
  return out;
}

// Which of the Cursor account's two money streams paid for this segment. Coarser than the per-entry
// `billing_pool` by construction — one segment can be part seat and part credits, and only the
// entries can say how much of each — so it is deliberately derived from them rather than tracked
// separately: any credit-funded request in the window makes the segment a credits segment.
function usedCredits(entries) {
  return (Array.isArray(entries) ? entries : []).some(
    (entry) => entry != null && entry.billing_pool === BILLING_POOL.CREDITS,
  );
}

// What `withLock` hands back when another hook process already holds this session's lock. A symbol
// rather than null or a plain object, because the guarded callback legitimately returns both — null
// means "abandon the checkpoint entirely" and an object means "done, now flush" — and a value that
// could be confused with either is how a contended run would silently take the wrong branch.
const CONTENDED = Symbol('beezi.checkpoint.contended');

// Outbound fields and behaviours that are WRITTEN but must not be emitted yet, each with the one
// piece of external evidence that flips it. Every key is `false`, and every key must stay `false`
// until the named gate closes: the ingest route runs a global
// `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, so ONE unknown top-level
// property 400s the ENTIRE report and the segment's tokens, cost, code changes and operations are
// thrown away together. A field that "looks harmless" is therefore not a small risk; it is the loss
// of the whole segment.
//
// One frozen object at module scope rather than per-site literals, so the set of unshipped fields
// reads in one place and a test can assert that every one of them is still off.
const CAPABILITIES = Object.freeze({
  // C-4 / data P3. Flips when SessionReportRequestDto gains a host-version property — none exists
  // at portal 871a788, at any level. The VALUE is already observed and stored on every sidecar line.
  cursorVersion: false,
  // C-5 / data P4. `claude_md_lines` + `project_instructions_status` DO exist in the DTO, so this is
  // a naming-and-deployment gate: it flips when a deployed ingest is confirmed to accept the two
  // spellings this client would send.
  rulesLines: false,
  // C-5 / data P4. `context_peak_tokens` / `context_final_tokens` / `context_final_model`, same gate.
  contextMetrics: false,
  // C-5 / data P4. `models[].by_effort`. Same gate, its own flag: effort is per-model and could ship
  // without the two above.
  effortBreakdown: false,
  // C-7 / data P7. `computeSessionTimeline`'s `allowBreakState`. FLIPPED ON: `break` is a member of
  // CliAgentActivityState, the portal client renders it as "Session break" and its analytics
  // exclude it from tracked session time, and the sibling Claude plugin has always emitted it to
  // this same ingest. The DTO's `state` is a bounded string rather than a closed enum for exactly
  // this case, so an older reader shows an unknown word instead of rejecting the document.
  breakState: true,
  // M04 / data P5 / G15. The per-run attribution split: `computeDelta` PRODUCES `delta.segments`
  // whenever the planner returns runs, and this module deliberately emits one unsplit main payload
  // anyway. It is the largest unshipped thing in the file, so it belongs in the object that claims
  // to be the one place they read — even though nothing branches on the flag yet, because the
  // emission it would gate has not been written. Flips when a deployed route accepts several
  // segments per window AND the M03/M04 conservation fixtures are green against it; until then the
  // split is computed, recorded in the pending batch as `runs` for provenance, and not sent.
  perRunSegments: false,
});

// `cursor_version` is ABSENT rather than null when the version is unknown: a null would assert that
// the host reported no version, which is a different statement from "this path never looked".
const versionField = (v) => (v === undefined ? {} : { cursor_version: v });

// What the MAIN segment bills and claims: this window's active wall clock MINUS what earlier
// checkpoints of this conversation already billed (`covered`, the persisted `coveredIntervals`).
//
// Codex review, MAJOR. On a dual-registry install one copy of an event can land before a checkpoint
// and its late duplicate — carrying the ORIGINAL timestamp — after it. dedupeEvents collapses copies
// only within one window, so the late one anchored the next window's first stretch back over time
// the previous segment had already reported: 10,000 ms, then 20,995 ms where 1,000 ms was right.
// Subagent segments have always billed "residual after covered"; this puts the main segment under
// the same rule. The copy itself is removed by the delta, by identity (`consumedEventKeys`, carried
// below); this subtraction is the second line of defence, for what identity cannot prove — a late
// `gen` copy, a state file written before the carry existed — and it never removes an ANCHOR, only
// already-billed seconds. (An earlier version dropped every anchor inside covered wall clock, and
// Codex review, MAJOR, again: coverage can legitimately extend past the sidecar snapshot — a CLI
// subagent's store-dated end — so a genuinely new prompt there was dropped with the gap it anchored.)
//
// Returned as the OVERLAP taken off `delta.duration_ms`, not as a total recomputed from intervals:
// with no overlap — every normal window, the first window, the audit/backfill's fresh parse with no
// coverage, and an injected delta that reports no intervals at all — the result is `duration_ms`
// itself, to the millisecond, whatever that delta's intervals look like. Only the duration and the
// claim move; `started_at` / `ended_at` stay the delta's envelope over every anchor.
function mainSegmentBilling(delta, covered) {
  const durationMs = delta.duration_ms == null ? 0 : delta.duration_ms;
  const active = Array.isArray(delta.activeIntervals) ? delta.activeIntervals : [];
  const intervals = subtractIntervals(active, covered);
  const overlapMs = totalMs(mergeIntervals(active)) - totalMs(intervals);
  return { durationMs: Math.max(0, durationMs - Math.max(0, overlapMs)), intervals };
}

// The named execution modes `options.mode` accepts. One value today; a constant rather than a bare
// string so the caller and the behaviours it selects cannot drift apart on a typo — a misspelled
// mode would silently run the LIVE path over a historical session, which advances the real cursor
// and posts a duplicate timeline.
export const CheckpointMode = Object.freeze({
  AUDIT: 'audit',
});

// The git-fact caches one checkpoint uses, in a bag the caller may keep across many of them:
// dir→root, root→remote, root→reflog/HEAD, plus the persisted known-root map that seeds and is
// refreshed by the second.
//
// Every checkpoint used to build these fresh, which is right for a hook (one session, one process)
// and pure waste for the login backfill, which drives runCheckpoint once per past session inside
// ONE process. Those sessions overwhelmingly share a handful of checkouts, so sessions 2..N were
// re-answering `rev-parse --show-toplevel`, `remote get-url origin`, `branch --show-current` and
// `reflog` for roots the run had already resolved — four git spawns and ~99 ms per session, paid
// once per session rather than once per root, which is 20-40 s of pure repetition on a machine
// with 200-400 sessions.
//
// The map travels IN the bag so the whole run shares one instance: `upsertRoot` mutates it and the
// checkpoint that learned something saves it, but with a shared `remoteCache` only the FIRST
// session to see a given root ever reaches `upsertRoot` at all — so the save is rare by
// construction rather than by any bookkeeping here.
export function createCheckpointCaches() {
  return {
    rootCache: new Map(),
    remoteCache: new Map(),
    timelineCache: new Map(),
    // A best-effort hint — a load failure yields an empty map, not a throw.
    map: loadRepoMap(),
  };
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush, sessionErrors, deltaFailed } — flush is the flushQueue summary (or
// null when it never ran); sessionErrors is populated only in audit mode, where error reports are
// buffered rather than POSTed; deltaFailed says the sidecar could not be parsed at all, which is
// what lets the backfill report a session as unreadable rather than as one that genuinely held no
// usage. Nothing else can now explain a run that produced no report — see `deltaFailed` below.
//
// ── options
//
// `budgetMs` bounds the network work: hooks pass it, the CLI (track.mjs) does not, because a user
// waiting at a terminal would rather see the whole queue drained than a partial flush.
//
// `emitTimeline` is the TURN-END path (stop / afterAgentResponse). It does two separable things,
// and the split matters: it parses the whole sidecar once and shares that array with the delta and
// the subagent correlation, AND it derives and POSTs the session timeline.
//
// `mode: CheckpointMode.AUDIT` is the login-time backfill (lib/session-audit.mjs) replaying one
// past session. It used to be four booleans the caller threaded one by one, always all together;
// they are now derived here, next to the reasoning for each, so the audit states its intent once:
//
//   no flush          — the audit owns its own batched delivery, so draining the live queue
//                       per session would add unrelated HTTP mid-import and muddy its summary.
//   fresh state       — parse from line 0 with no usage baseline. A candidate either was never
//                       tracked here or was tracked under a DIFFERENT account, whose consumed
//                       cursor would upload an empty tail while calling the session imported.
//                       This also implies NOT writing state back (see the save guard), which is
//                       why there is no separate "don't persist" flag: the backfill route, not
//                       the cursor, decides what was delivered.
//   buffered errors   — API-error reports are collected for the caller instead of POSTed one at
//                       a time; hundreds of awaited single POSTs is minutes of dead time.
//   whole-sidecar parse — WITHOUT the timeline POST. Verified gap: the subagent segment block is
//                       gated on that shared parse, so an audit that skipped it emitted ZERO
//                       is_subagent rows and every past session's delegated time went unbilled.
//                       The POST half stays off because the audit computes timelines itself and
//                       ships them inside its chunk payloads — enabling `emitTimeline` wholesale
//                       would send each one twice, over a route that is gated off for the very
//                       tenants the audit exists to serve.
//
// One consequence worth naming: with a fresh state there is no `state.anchor`, so a subagent
// segment in a window whose delta found no model entries falls back to `models: []` — which the
// ingest service answers `200 {status:"stored"}` and writes nowhere. A whole-session parse almost
// always has entries, so this is rare, and inventing a model id for the row would be worse.
//
// `sink` stays an option of its own rather than folding into the mode: it is a destination value,
// not a behaviour, and the tests that pin every one of these behaviours need it independently.
// `caches` is the same kind of thing — see createCheckpointCaches.
//
// A checkpoint that loses the race for this session's lock returns `{ enqueued: 0, flush }`: it does
// no state work at all, but it still drains the queue, which is machine-wide and had nothing to do
// with the contention.
export async function runCheckpoint(input, deps = {}, options = {}) {
  const { session_id, cwd } = input;
  const auditMode = options.mode === CheckpointMode.AUDIT;
  const freshState = auditMode;
  const skipFlush = auditMode;
  const collectSessionErrors = auditMode;
  // The two halves of what `emitTimeline` used to mean, so the audit can take one without the
  // other. See the options comment above for why that is not an optimisation but the fix for a
  // whole class of missing reports.
  const parseWholeHistory = auditMode || options.emitTimeline === true;
  const postTimeline = !auditMode && options.emitTimeline === true;
  const collectedErrors = [];
  // The one reason a candidate session can produce no report that is worth reporting: the sidecar
  // could not be parsed. Everything else that yields nothing IS "no usage" — a window with no new
  // lines, or one whose lines carry no billable activity — and the backfill says so.
  //
  // This used to be a `skipped` bag with two more counters, both of which were unreachable or
  // unread. `noRemote` counted an attribution with no remote, which `attributionOf` below can no
  // longer produce (it falls through the workspace folder to a catch-all identity). `emitFailed`
  // counted a throwing sink: the default `enqueue` genuinely can throw, but the hook that owns it
  // discards this whole result, and the only caller that READS the count is the audit — whose sink
  // is a `reports.push` that cannot throw. So the number was written where nobody looked and
  // looked for where it could never be written.
  let deltaFailed = false;
  // The session whose timeline POST this run just made and lost (for any reason but a 401), handed
  // to the flush so its outbox drain does not repeat that POST moments later. See the POST site.
  let timelineOutboxSkip = null;
  const emptyResult = () => ({ enqueued: 0, flush: null, sessionErrors: collectedErrors, deltaFailed });
  // session_id here is Cursor's `conversation_id` — normalizeHookInput maps it. Nothing downstream
  // needs a transcript: the sidecar is keyed on this id and is the source of truth.
  if (!session_id) return emptyResult();
  const now = deps.now == null ? Date.now : deps.now;
  const deadline = options.budgetMs ? now() + options.budgetMs : null;
  const timeLeft = () => (deadline === null ? null : deadline - now());
  // The Cursor CLI chat-store reads (session name, Auto model, subagents) all run inside this hook's
  // budget, so each one is handed the same deadline and stops opening stores once it has passed.
  // An absolute epoch-ms instant, compared against the wall clock by lib/cli-chats-cursor.mjs.
  const deadlineDeps = deadline === null ? {} : { deadline };
  // `sqlite` and `chatsDir` are the chat-store reader's own seams (a test spy, a fixture root) and
  // go ONLY to the subagent enrichment and the timeline, which read nothing but the CLI store. The
  // name and delta readers also open the IDE's state.vscdb through a `sqlite` of the same name, so
  // handing it to them would point a spy meant for one store at the other.
  //
  // `onEnrichment` collects whether every CLI subagent listing in THIS run ran to the end. The
  // enrichment can run twice (the shared stream below, then inside computeSessionTimeline when the
  // first found nobody), and one cut short by the deadline is enough to make the lanes suspect: it
  // answers exactly like a session with fewer workers. Codex review (DO NOT SHIP): an exhausted
  // checkpoint's zero-lane timeline overwrote a queued one-lane outbox entry, and a later drain
  // delivered it. See the timeline POST site for what an incomplete run may and may not do.
  let enrichmentComplete = true;
  const cliDeps = {
    ...deadlineDeps,
    ...(deps.sqlite === undefined ? {} : { sqlite: deps.sqlite }),
    ...(typeof deps.chatsDir === 'string' ? { chatsDir: deps.chatsDir } : {}),
    onEnrichment: (info) => { if (info == null || info.complete !== true) enrichmentComplete = false; },
  };
  const resolveSessionNameImpl = deps.resolveSessionName == null ? resolveSessionName : deps.resolveSessionName;
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const gitImpl = deps.gitImpl == null ? git : deps.gitImpl;
  const computeDelta = deps.computeDelta == null ? _computeDelta : deps.computeDelta;
  const countEvents = deps.countEvents == null ? _countEvents : deps.countEvents;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  // Where a built payload goes. The backfill collects them in memory and batches them itself;
  // letting it fall through to the disk queue would drip-feed hundreds of segments to the
  // single-report endpoint on the next hook, bypassing the batch route's whole-session dedupe.
  const emit = options.sink == null ? enqueue : options.sink;
  // Whether this run owns a durable queue AND a durable state file, which is what the pending
  // batch protects. A caller-supplied sink has no queue at all, so there is nothing to make
  // atomic and no `enqueueIfAbsent` to dedupe against; `freshState` means nothing is written back
  // either. Both are the audit/backfill, which ships its reports in its own batched route and is
  // governed by the server's one-time-pull rules rather than by this file's cursor.
  const durable = !freshState && options.sink == null;

  // The login this run acts for, read ONCE, here, alongside the token: the auth epoch first (the
  // queue's fence order — a same-account refresh inside getAccessToken does not move the epoch, only
  // a login or logout does, lib/token.mjs `authEpoch`), then the token, then the account key. The
  // flush at the end of this run is handed THIS snapshot rather than taking its own: `token` is
  // resolved here, a whole hook budget before the flush, and a snapshot of the epoch taken only at
  // flush time would pair a login switch's NEW epoch and account with this OLD token — Codex's
  // cross-tenant finding, with the whole checkpoint as the window. An epoch that cannot be read
  // leaves the flush to take its own, exactly as before.
  let loginEpoch = null;
  let epochRead = false;
  try {
    loginEpoch = await (deps.auth == null ? _authEpoch({}) : deps.auth.authEpoch());
    epochRead = true;
  } catch { epochRead = false; }
  let token = null;
  try { token = await getAccessToken(); } catch { return emptyResult(); }
  if (!token) return emptyResult();
  let loginAccount = null;
  try { loginAccount = currentAccountKey(); } catch { loginAccount = null; }
  const authSnapshot = epochRead ? { epoch: loginEpoch, token, account: loginAccount } : null;
  const snapshotDeps = authSnapshot === null ? {} : { authSnapshot };

  // The tenant policy gate, deliberately ABOVE every line that reads a sidecar, computes a delta or
  // writes a queue file. Refusing to DELIVER is not enough on its own: without this, a tenant with
  // tracking switched off still accumulates queue records that nothing is ever allowed to send, and
  // the disk fills with data the user was told was not being collected.
  //
  // Fails OPEN. `isLiveTrackingAllowed` reads a cached policy, and a cache that is missing or
  // unreadable must not silently stop tracking a tenant that is entitled to it — a policy this
  // machine has never been told is not the same as a policy that says no.
  //
  // AUDIT mode is exempt, and that is not an oversight. The backfill is governed by history
  // authorization — the server's one-time-pull rules — not by the live gate, and folding the two
  // together would leave a disabled tenant unable to complete an import it is entitled to.
  //
  // The queue is still DRAINED: flushQueue answers `gated: true` without posting, so a CLI run can
  // say truthfully that the records are HELD rather than reporting "nothing new". `emptyResult()`
  // is deliberately not reused for that reason — it returns `flush: null`.
  //
  // One consequence worth naming: a pending batch written before the policy arrived is not
  // recovered while the gate is shut, because recovery lives below this line. Its items were never
  // queued, nothing is committed over them, and prune's 14-day sweep collects the record — which
  // is the same answer the gate gives everything else.
  if (!auditMode && !isLiveTrackingAllowed()) {
    const flush = await flushQueue(token, {
      fetchImpl, now, ...(deadline === null ? {} : { deadline }), ...snapshotDeps,
    });
    return { enqueued: 0, flush, sessionErrors: collectedErrors, deltaFailed: false };
  }

  // Both below the token gate: skip this work entirely on an unlinked machine.
  let resolvedSessionName = null;
  try { resolvedSessionName = resolveSessionNameImpl(session_id, deadlineDeps); } catch { /* enrichment only */ }

  // The account this machine reports under right now (portal base + login email, from the local
  // tracking cache — currentAccountKey is called with no whoami because a hook must not touch the
  // network). Stamped into the session state below so the backfill's live-cursor belt can tell
  // WHOSE tenant the queued segments went to: a later login into a different workspace must not
  // read this session as "already tracked live" for a tenant that never received it. Null until a
  // login/audit has recorded an email — the belt then stays conservative, exactly as for pre-stamp
  // state files. Read ONCE per run, and only inside the lock is it consumed.
  const accountStamp = currentAccountKey();

  // Memoized git shell-outs: dir→root, root→remote, root→reflog/HEAD, plus the persisted
  // known-root map that seeds resolution (prefix match) and gets refreshed with any root→origin we
  // learn. Built fresh per call unless the caller supplies a bag to share across a whole run —
  // byte-identical behaviour for every hook, which supplies none. See createCheckpointCaches.
  const { rootCache, remoteCache, timelineCache, map } =
    options.caches == null ? createCheckpointCaches() : options.caches;
  let mapDirty = false;

  const repoRootOf = (dir) => resolveRepoRoot(gitImpl, dir, rootCache, map);

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      let timeline = null;
      let headBranch = '(unknown)';
      try { timeline = buildBranchTimeline(readCheckoutEvents(gitImpl, root)); } catch { /* no reflog */ }
      // Always resolve current HEAD too: it's the fallback for any segment lacking a
      // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
      try { headBranch = currentBranch(root, gitImpl) || '(unknown)'; } catch { /* keep '(unknown)' */ }
      entry = { timeline, headBranch };
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). A checkout with no origin still
    // reports under a stable local: identity so analytics are not dropped.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    if (!r) r = knownOrigin(root, map);
    if (!r) r = localRemoteFromRoot(root);
    if (r) { upsertRoot(map, root, r); mapDirty = true; }
    remoteCache.set(root, r);
    return r;
  };

  // ── the guarded read-modify-write
  //
  // Everything from `loadState` to `saveState` is one read-modify-write on `state/<id>.json`, and
  // Cursor fires `afterShellExecution`, `stop` and `sessionEnd` as SEPARATE OS PROCESSES that land
  // together at a turn boundary. Unguarded, two of them read the same cursor and both report the
  // same window. Two damages come out of that, in ascending order of cost:
  //
  //   1. A enqueues `conv:100-150` while B enqueues `conv:100-160`. Those are different segmentIds,
  //      so the server's idempotency key — which IS the segmentId — cannot collapse them, and that
  //      activity is billed twice with no later pass that notices.
  //   2. `state.usageSnapshot` is the cumulative-credits baseline, and last writer wins. A stale
  //      write rewinds it and the next checkpoint re-bills the difference. This file says of that
  //      figure, where it is assigned below: "it can never be recovered — usageData is cumulative,
  //      so the increment is gone."
  //
  // CONTENTION SKIPS, it does not wait (see lib/lock.mjs). The whole checkpoint runs inside a
  // 7500ms budget, so sleeping would spend that budget to arrive at a state the winner has already
  // changed underneath us. Skipping is safe by this module's own design: the cursor simply does not
  // advance, and the hook that won the race is covering exactly this window right now. The
  // monotonic-cursor guard further down is now a SECOND line of defence rather than the only one.
  //
  // `flushQueue` stays deliberately OUTSIDE the lock. It is network-bound and the slowest thing in
  // the hook, so holding a lock across it would serialize every hook on the machine behind one slow
  // POST; and it drains a machine-wide queue, so a checkpoint that lost the race on one session
  // still has a backlog to clear that has nothing to do with the session it lost on.
  //
  // The callback returns `null` for the two whole-checkpoint abandonments that used to be written
  // as an early `return { enqueued: 0, flush: null }` — a throwing computeDelta and a null delta.
  // Those still skip the flush, so callers can go on telling "there was nothing to report" apart
  // from "we reported nothing" by looking at `flush`. Every other throw still propagates: `withLock`
  // releases in `finally` and rethrows, so a caller that expected a rejection still gets one.
  const guardedPass = async () => {
    // The backfill parses a session AS IF this machine had never seen it: from line 0, with no
    // usage baseline. The live state must not leak in — a session live-tracked under a PREVIOUS
    // account left a consumed cursor behind, and honoring it would upload an empty tail to the
    // new tenant while calling the session imported. Symmetrically, nothing computed off a fresh
    // parse may be written back (enforced again at the save below).
    // `startCursor` (sync) replaces the locally-tracked read position with the SERVER's verified
    // coverage for this session. It is only ever combined with `freshState`, so nothing computed
    // off it is written back (see the save guard) and no live byte offset is reused at a different
    // cursor. The caller has already checked the value against the sidecar's own bounds.
    const state = freshState
      ? { cursor: options.startCursor == null ? 0 : options.startCursor, sentSessionName: null, anchor: null }
      : loadState(session_id);
    // When the conversation record is unreadable (name resolves to null), keep the last name we sent
    // rather than overwriting the stored name with null.
    const sessionName =
      resolvedSessionName != null ? resolvedSessionName
        : state.sentSessionName != null ? state.sentSessionName
          : null;
    // The session timeline and the subagent correlation are both whole-session by definition, so a
    // turn-end hook has to parse the entire sidecar anyway. Parse it ONCE here and hand the same
    // array to every consumer, rather than reading and parsing the same file two or three times
    // inside one 7.5 s budget. On every other hook nothing needs the history, so the delta resumes
    // from the byte offset the last one recorded and its cost is proportional to new activity
    // instead of to the size of the conversation.
    //
    // The audit takes this parse and NOT the timeline POST below — a distinction the single
    // `emitTimeline` flag could not express, which is exactly how the backfill ended up shipping
    // no subagent segments at all.
    // ── C-10 recovery: finish whatever the last run left half-done
    //
    // Inside the session lock and before `computeDelta`, because both halves matter: the lock is
    // what stops two hooks recovering the same batch, and being before the delta is what stops the
    // recovered window being widened by sidecar lines that arrived after the batch was frozen.
    if (durable) {
      const pending = loadPendingBatch(session_id);
      const verdict = classifyPendingBatch(pending, session_id, accountStamp, state.cursor);
      if (verdict === PENDING.DONE) {
        // The state commit landed and only the unlink was lost. Deleting it is the whole of the
        // work; `next` must NOT be applied a second time — `state.cursor >= next.cursor` is what
        // distinguishes this from a batch that never committed.
        dropPendingBatch(session_id);
      } else if (verdict === PENDING.RESUME) {
        // Steps 3-4-5 over the FROZEN record, then stop. Returning here rather than falling
        // through is the point: a resumed run must not read one newly appended sidecar line and
        // must not observe a larger cumulative `usageData`, or the baseline it commits would jump
        // past spend that the queued payloads do not carry. The new lines are the NEXT window's.
        let replayed = 0;
        try {
          for (const item of pending.items) {
            // `enqueueIfAbsent` answers whether it WROTE. An item whose queue file survived the
            // crash was queued by the run that crashed, not by this one, and counting it here would
            // report the same segment as enqueued twice across the two runs.
            if (item != null && item.payload != null && enqueueIfAbsent(item.payload)) {
              replayed += 1;
            }
          }
        } catch {
          // Still not durable. The record stays exactly as it is and the next hook tries again;
          // nothing is committed, so no cursor moves over an unqueued item.
          return { enqueued: 0 };
        }
        for (const key of Object.keys(pending.next)) state[key] = pending.next[key];
        if (accountStamp != null) state.account = accountStamp;
        try { saveState(session_id, state); } catch {
          // The items are queued and the commit is not. That is precisely the state this record
          // describes, so leave it in place and let the next hook re-run this same branch.
          return { enqueued: replayed };
        }
        dropPendingBatch(session_id);
        return { enqueued: replayed };
      }
      // PENDING.NONE falls through to the normal path. PENDING.FOREIGN does too, and deliberately
      // leaves the file: see the constant. One caveat worth naming — the record is keyed on the
      // session id alone, so if this same session checkpoints again under the new account it will
      // write its own batch over the orphan. That still satisfies "not enqueued, not committed";
      // it just means prune is not always the one that collects it.
    }

    let sharedEvents = null;
    if (parseWholeHistory) {
      try {
        const full = readEventsFrom(session_id, null);
        if (full.exists) sharedEvents = { events: full.events, nextByte: full.nextByte };
      } catch { /* fall back to the delta reading for itself */ }
    }

    // The duplicate collapse, run ONCE over the whole stream and shared by everything downstream of
    // it. Both hook registries are installed on every machine now, so one host event writes two
    // sidecar lines about seven milliseconds apart; correlating the raw stream would open two
    // `subagent_start`s per worker and close them with two stops, and every subagent would be drawn
    // twice, counted twice and billed twice into the interval union.
    //
    // Deliberately NOT handed to `computeDelta`: the cursor indexes RAW sidecar lines, so the delta
    // slices its window out of the raw array by absolute index and does its own collapse afterwards.
    // The server's idempotency contract is that a segmentId names a range of the log rather than a
    // count of what survived analysis, so a collapsed array here would shift every segment boundary.
    //
    // `computeSessionTimeline` collapses for itself when nobody hands it one; below it is handed
    // this array with an identity collapse so the second full pass does not happen inside the same
    // 7.5 s budget. That is "already collapsed", which is a different statement from the explicit
    // `null` that module accepts to mean "there is no collapse available" — that one withholds the
    // subagent list entirely rather than risk doubling it.
    //
    // Cursor CLI sessions: the workers come from the CLI's chat store, not from hooks
    // (lib/cli-subagents-cursor.mjs). Added to the collapsed stream so the subagent segments AND the
    // timeline lanes both see them; a no-op on any stream that already has hook subagent lines.
    // Never to the raw `sharedEvents`: the delta slices that by absolute line index.
    const dedupedEvents = sharedEvents
      ? withCliSubagents(session_id, dedupeEvents(sharedEvents.events).events, cliDeps)
      : null;

    let delta;
    try {
      delta = computeDelta(session_id, state.cursor, {
        cwd,
        repoRootOf,
        branchAt: branchOf,
        ...(sharedEvents
          ? { events: sharedEvents.events }
          : { start: { line: state.cursor, byte: state.cursorBytes == null ? 0 : state.cursorBytes } }),
        // Tool→server pairs learned in EARLIER windows. `beforeMCPExecution` fires before the call
        // and `postToolUse` after it, so the `mcp_server` line naming a server lands in window N
        // while the `tool` line it names lands in N+1 — and the join in N+1 sees no side channel at
        // all, so it falls back to splitting `mcp_<server>_<tool>` at the first underscore, which is
        // wrong for every server whose name contains one. The FIRST call to a server is the one most
        // likely to straddle a boundary, so the miss is systematic rather than random.
        //
        // Carried on session state and never anywhere near the wire: see where it is written back.
        mcpAliases: state.mcpAliases == null ? null : state.mcpAliases,
        // The overage baseline. `composerData.usageData` is CUMULATIVE for the whole conversation
        // while every checkpoint gets a fresh segmentId, so without handing back the last snapshot the
        // same overage is re-reported under a new sourceRef every turn and the credits bucket
        // compounds. This is the one figure the design promises is exact, so it is not optional.
        priorUsage: state.usageSnapshot == null ? null : state.usageSnapshot,
        // Generations already billed a request in an EARLIER window of this conversation. One
        // generation writes many sidecar lines and a pulse routinely splits them across two
        // checkpoints; without the carry the same generation is counted twice and the seat-covered
        // request bucket inflates. Bounded at 200 by delta-cursor; anonymous keys never carried.
        countedGenerations: Array.isArray(state.countedGenerations) ? state.countedGenerations : null,
        // The identities of the identified lines EARLIER windows consumed, so a late registry copy
        // that crossed the checkpoint boundary is dropped as the duplicate it provably is
        // (dropCarriedDuplicates in lib/delta-cursor.mjs; Codex review, MAJOR). Bounded at 256 by
        // delta-cursor. Absent under `freshState`, whose state object has no carry, so the
        // audit/backfill's whole-history parse — which collapses both copies in its one window — is
        // unaffected; and absent on a state file from before the carry, which drops nothing.
        consumedEventKeys: Array.isArray(state.consumedEventKeys) ? state.consumedEventKeys : null,
        // The per-run attribution split. A seam rather than a pre-computed input because the planner
        // needs `{ index, event }` pairs over ABSOLUTE line numbers, and those exist only inside
        // computeDelta — the frequent (non-turn-end) path materialises no event array at all.
        planRuns: planAttributionRuns,
        // The run this conversation was last attributed to, so a window whose own lines carry no
        // repo signal continues where the previous one left off instead of falling back to the
        // hook's cwd.
        //
        // Withheld for a historical replay: `freshState` means the session is parsed AS IF this
        // machine had never seen it, and the state file it would read may have been written under a
        // DIFFERENT account. Seeding one tenant's import from another tenant's carry would
        // attribute imported work to a checkout the importing account never told us about.
        previousAttribution: (freshState || state.attribution == null) ? null : state.attribution,
        // The hook budget, for the CLI chat-store reads that resolve an Auto (`default`) model.
        ...deadlineDeps,
      });
    } catch {
      // Abandon the whole checkpoint, flush included — `null` is the sentinel for that, and it is
      // the same outcome as before the lock: `{ enqueued: 0, flush: null }`. The flag is what
      // lets the backfill report the session as unreadable instead of empty.
      deltaFailed = true;
      return null;
    }
    if (!delta) return null;

    // After the delta, not before it: for Cursor the billing source IS a property of the window's
    // spend (seat allowance vs. on-demand credits), so there is nothing to detect until the pools are
    // known. The other two forks read it from the environment and can resolve it earlier.
    const billingSource = detectBillingSource({ usedCredits: usedCredits(delta.entries) });
    // One read, two answers: the plan fields (gated on the billing source) and the identity fields
    // (not gated on it — see `accountReportFields`). Reading billing.json twice would let a
    // concurrent `reconcilePlan` land between them and emit a plan and an account from two
    // different observations of the machine.
    const billingConfig = readBillingConfig();
    const subscriptionFields = subscriptionReportFields(billingSource, billingConfig);
    const accountFields = accountReportFields(billingConfig);
    const thirdPartyFields = thirdPartyReportFields(billingSource);

    // A window of sidecar lines none of which the parser recognises is a writer/reader schema
    // mismatch — it reports as zero activity, which is invisible in production unless it is said out
    // loud. Cursor's storage has moved format four times in a year; silent-empty is the exact failure
    // mode this design is built against. stderr, not a throw: a hook must still complete.
    if (delta.diagnostics != null && delta.diagnostics.schemaMiss) {
      try {
        const unrecognized = delta.diagnostics.unrecognizedEvents;
        process.stderr.write(
          `[beezi] sidecar schema mismatch for ${session_id}: ${delta.diagnostics.windowEvents} events, none recognised`
          + ` (saw: ${(unrecognized == null ? [] : unrecognized).join(', ') || 'nothing'})\n`,
        );
      } catch { /* stderr closed — nothing to do about it */ }
    }

    // The subagent correlation's own failure modes, said out loud for the same reason the schema
    // miss above is: every one of them is SILENT by nature. `subagentStop` carries no `subagent_id`
    // (a confirmed host bug), so the pairing is a heuristic — an `ambiguous` match is a swapped
    // label between two workers that both really ran, and a `synthetic` close is a background worker
    // that will never report a stop. Neither looks wrong from outside.
    //
    // `orphaned` is the one to watch, and it is the reason this is a field signal rather than a
    // debug aid: a stop with no start in front of it means the START WAS WRITTEN TO A DIFFERENT
    // SIDECAR FILE. That is the open question about whether a subagent's events are routed under the
    // parent's conversation_id or the worker's own, and if it is the latter the starts land in a
    // file nothing ever flushes and subagent tracking is blind no matter what this module does.
    // A nonzero count here is how that shows up on a real machine.
    //
    // Reported at most ONCE per checkpoint: the correlation below and `computeSessionTimeline` are
    // handed the same collapsed array and therefore compute the identical numbers, so letting both
    // speak would only print the same line twice.
    let subagentDiagnosticsSaid = false;
    const onSubagentDiagnostics = (d) => {
      if (subagentDiagnosticsSaid || !d) return;
      subagentDiagnosticsSaid = true;
      if (!d.ambiguous && !d.orphaned && !d.synthetic) return;
      try {
        process.stderr.write(
          `[beezi] subagent correlation for ${session_id}: ${d.ambiguous} ambiguous, `
          + `${d.orphaned} orphaned, ${d.synthetic} synthetic (of ${d.starts} starts, ${d.stops} stops)\n`,
        );
      } catch { /* stderr closed — nothing to do about it */ }
    };

    // The cursor indexes OUR sidecar lines, so the delta's own `nextCursor`/`to` is authoritative;
    // countEvents is the fallback for a delta that reports only what it consumed.
    let nextCursor = [delta.nextCursor, delta.to].find(Number.isFinite);
    if (nextCursor === undefined) {
      nextCursor = state.cursor;
      try { nextCursor = Math.max(state.cursor, countEvents(session_id)); } catch { /* keep */ }
    }

    let enqueued = 0;
    // What this checkpoint intends to queue, in enqueue order, built before ANY of it is durable.
    // The payloads are finished objects: recovery replays these exact bytes rather than re-deriving
    // them, which is what makes a crashed window produce the same segmentIds and the same numbers
    // on the retry instead of a second, differently-bounded report of the same work.
    const items = [];
    // The single state commit. Every key here answers "this much has been reported", and every one
    // of them is applied EXACTLY ONCE, after the whole batch is durably queued — never per item.
    // A per-item write is what re-introduces the ambiguity the batch exists to remove: a crash
    // halfway would leave a cursor that had advanced over segments still sitting unqueued.
    const next = {};
    const commitNext = () => {
      for (const key of Object.keys(next)) state[key] = next[key];
      if (Object.keys(next).length > 0) stateDirty = true;
    };
    // Build-time, not commit-time. An unusable segmentId is the one failure the queue write used to
    // discover, and discovering it HERE preserves today's behaviour — skip this payload, do not
    // advance over it — instead of writing a batch whose enqueue can never succeed.
    const stage = (payload) => {
      if (durable && queueFileFor(payload == null ? undefined : payload.segmentId) === null) {
        throw new Error('beezi: segmentId cannot be made into a filename');
      }
      items.push(payload);
    };
    // The last staged MAIN payload becomes the "anchor" we can replay to push a later rename.
    // Subagent payloads are deliberately never eligible: the anchor is replayed verbatim with a
    // corrected name, and replaying a zero-token subagent row in place of the segment that carries
    // the window's cost would put the rename on the wrong row.
    let lastPayload = null;
    const timezone = detectTimezone();

    // Wall clock this session has already billed, as merged [startMs, endMs) pairs.
    //
    // A subagent's span sits INSIDE the parent's by construction — the parent is blocked on the Task
    // call while the worker runs — and with `is_parallel_worker` several subagents overlap each
    // other as well. Summing their durations bills one second once per agent; in the sibling plugin
    // six agents over 520 s of wall clock reported 2204 s, a 4.24x overstatement of the user's day.
    // Worse here than there, because the backend stamps `duration_api_ms` once per SEGMENT and every
    // duration query sums across segments with no `is_subagent` filter — the inflated figure lands
    // in the overview time tile, the daily activity graph and the session list's sort key alike.
    //
    // Persisted across checkpoints because a subagent's span and the main lines covering the same
    // minutes routinely land in different windows: a worker that is still open gets a synthetic
    // close at the last activity in THIS window and a longer one next window, and only coverage
    // stops the overlap being billed again.
    let covered = mergeIntervals(Array.isArray(state.coveredIntervals) ? state.coveredIntervals : []);
    let coveredDirty = false;

    // `agent_id` -> the `duration_sec` this conversation has already REPORTED for that worker.
    //
    // It is two things at once, deliberately: the cumulative total a re-sent row must carry, and the
    // record of what was last sent, which is what keeps a stable `segmentId` from re-queueing the
    // same unchanged row at every turn-end for the rest of the conversation. One map rather than a
    // total plus a sent-flag, because two of them can disagree and this one cannot - the same shape
    // `sentSessionName` and `sentTimelineSig` already use.
    //
    // A key is `agent_id`, which lib/subagents-cursor.mjs guarantees is stable across re-derivations
    // of the same session, so the map holds one small entry per worker the conversation actually
    // delegated to and nothing else. DELIBERATELY UNCAPPED, unlike `coveredIntervals` beside it:
    // that list grows with idle gaps, which a long session produces by the thousand, while this one
    // grows only with delegations. Note that `MAX_SUBAGENTS` is NOT a bound here — it is applied in
    // lib/session-timeline-cursor.mjs to the timeline document, and the loop below walks every span
    // the correlation returns. If a session is ever seen delegating on a scale where this matters,
    // cap it the way coverage is capped (oldest first); do not assume something upstream already
    // did.
    const sentSubagents = state.sentSubagents != null && typeof state.sentSubagents === 'object'
      && !Array.isArray(state.sentSubagents) ? { ...state.sentSubagents } : {};
    let sentSubagentsDirty = false;

    // delta-cursor returns ONE main segment per checkpoint — the sidecar is a single ordered stream
    // per conversation, so there is no per-turn cwd to re-segment on the way Codex's rollout has.
    // Repo and branch therefore come from the hook's own cwd, refined by anything the delta chose to
    // resolve, and every subagent segment below is attributed the same way.
    //
    // Repo, branch and remote for everything this checkpoint queues, resolved AT MOST ONCE and only
    // if something is actually going to be queued. Lazy on purpose: `repoRootOf`, `branchOf` and
    // `resolveRemote` all shell out to git on their first call for a root, and a checkpoint with
    // nothing to report used to skip them entirely — spending a git process per hook on a session
    // that has no new lines and no billable subagent would be a straight regression against the
    // 7.5 s budget.
    //
    // Shared with the subagent segments below because a subagent has no cwd of its own anywhere in
    // Cursor's payloads (`agent_transcript_path` is always null and no sub-transcript exists on
    // disk), so it is attributed to the parent's repo and branch — which is also the only thing that
    // is true, since it was working on the parent's checkout.
    let attribution = null;
    const attributionOf = () => {
      if (attribution === null) {
        const repoRoot = delta.repoRoot == null ? repoRootOf(cwd) : delta.repoRoot;
        const endedMs = delta.ended_at ? Date.parse(delta.ended_at) : null;
        // A cwd outside any git repo still names the work: the workspace folder itself, under
        // the same local: rule as a checkout without an origin (git.mjs). No cwd at all —
        // pre-stamp history that edited nothing — lands in the one catch-all bucket rather
        // than being dropped: the usage is real even when its home is unknowable.
        //
        // Both resolvers shell out to git, so the second is reached only when the first came back
        // empty — the same short-circuit the nullish chain here used to express.
        const originRemote = resolveRemote(repoRoot);
        const localRemote = originRemote != null ? null : localRemoteFromRoot(cwd);
        attribution = {
          // The backend's `branch` column is 255 chars and an over-long value is a PERMANENT 4xx,
          // which DELETES the queue record — the segment's tokens, cost and code changes go with
          // it. Clamped HERE, at the one place every payload's branch comes from, so the live path,
          // the subagent segments and the audit/backfill replay all share one sanitizer. Both
          // inputs need it: `branchOf` can hand back a 300-character name verbatim, and
          // `delta.branch` is caller-supplied.
          branch: clampBranch(delta.branch == null
            ? branchOf(repoRoot, Number.isFinite(endedMs) ? endedMs : null)
            : delta.branch),
          remote: originRemote != null ? originRemote
            : localRemote != null ? localRemote
              : UNATTRIBUTED_REMOTE,
        };
      }
      return attribution;
    };

    // The range this window CONSUMED always advances; whether any of it is worth billing is a
    // separate question, and conflating the two is what produced the point segments this gate
    // removes. A bare `session_end` consumes its line and produces no segment (DATA-04): the cursor
    // moves past it and nothing is enqueued, which is "consume once, bill nothing".
    //
    // `delta.consumed` is absent on an older or injected delta, so it falls back to the reported
    // window — byte-identical to the previous expression for every such caller.
    const consumed = delta.consumed == null ? { from: delta.from, to: delta.to } : delta.consumed;
    const hasRange = Number.isFinite(consumed.from) && Number.isFinite(consumed.to)
      && consumed.to > consumed.from;
    // `!== false` and not a truthiness test: a delta that reports no flag at all keeps exactly
    // today's behaviour rather than silently becoming "no work".
    const hasWork = hasRange && delta.hasReportableWork !== false;
    if (hasWork) {
      // No "cannot name this work" branch exists any more, and the double `attributionOf()` call
      // that used to test for one is gone with it: `remote` falls through origin → .git/config →
      // the persisted map → the workspace folder's local: id → UNATTRIBUTED_REMOTE, so it is
      // unconditionally truthy. A guard on it read as a real skip path and was dead code.
      const { branch, remote } = attributionOf();
      const mainBilling = mainSegmentBilling(delta, covered);
      // A single write failure must not abort the checkpoint (which would leave the cursor
      // unadvanced and re-process everything forever) — skip and continue.
      try {
        const payload = {
          segmentId: delta.segmentId == null
            ? `${session_id}:${delta.from}-${delta.to}`
            : delta.segmentId,
          sessionId: session_id,
          remote,
          branch,
          from_line: delta.from,
          to_line: delta.to,
          models: modelsFrom(delta.entries),
          ...tokenFields(delta.tokens),
          duration_sec: Math.max(0, Math.round(mainBilling.durationMs / 1000)),
          billing_source: billingSource,
          ...subscriptionFields,
          ...accountFields,
          ...thirdPartyFields,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          ...(delta.started_at ? { started_at: delta.started_at } : {}),
          ...(delta.ended_at ? { ended_at: delta.ended_at } : {}),
          ...(delta.code_changes ? { code_changes: delta.code_changes } : {}),
          ...(delta.operations ? { operations: delta.operations } : {}),
          // GATED (CAPABILITIES.cursorVersion). No `cursor_version` exists in
          // SessionReportRequestDto at portal 871a788, so emitting one 400s the whole report.
          // `sharedEvents.events` is the RAW array, which is what makes `delta.to` a valid bound -
          // the deduplicated array is not indexed by line. On the frequent path
          // (`sharedEvents === null`) the field is simply omitted: unknown stays unknown.
          ...(CAPABILITIES.cursorVersion && sharedEvents
            ? versionField(cursorVersionAt(sharedEvents.events, delta.to))
            : {}),
          // GATED (CAPABILITIES.rulesLines / contextMetrics / effortBreakdown) — data P4's
          // `claude_md_lines`, `project_instructions_status`, the three `context_*` figures and
          // `models[].by_effort`. Deliberately NOT written as dead builders here: each needs a
          // per-checkpoint read keyed by the resolved repo root, and a reader that runs while the
          // field cannot be sent would spend a hook's budget producing a value nothing consumes.
          // The flags above are the single place that records they are owed.
        };
        stage(payload);
        // The main segment goes FIRST and keeps its FULL span, then claims what it worked. Both
        // halves are deliberate: first-and-full is deterministic (it does not depend on how many
        // workers happened to be correlated this window) and it puts the time on the thread that was
        // blocked for the whole fan-out, which is the thread the user was waiting on.
        //
        // "Full" is this window's span, NOT time an EARLIER checkpoint already billed: the duration
        // above and the claim below are both mainSegmentBilling's, which leaves out covered wall
        // clock (Codex review, MAJOR — a late duplicate line across a checkpoint boundary). With no
        // overlap, which is every normal window, it is exactly `delta.activeIntervals` and
        // `delta.duration_ms`.
        //
        // What it claims is the ACTIVE intervals, never the [started_at, ended_at] envelope. A
        // subagent that ran ten minutes writes two lines, so those ten minutes look to the parent
        // like one idle gap it bills nothing for; claiming the envelope would mark the gap covered
        // and the subagent would bill nothing either, and ten real minutes would leave the session
        // altogether. A computeDelta that reports no intervals (an injected double) claims nothing,
        // which is exactly the pre-subagent behaviour.
        if (mainBilling.intervals.length > 0) {
          covered = claimIntervals(covered, mainBilling.intervals);
          coveredDirty = true;
        }
        lastPayload = payload;
        enqueued += 1;
      } catch { /* keep going; the cursor deliberately does NOT advance below (see `advanceable`) */ }
    }

    // ── one report segment per correlated subagent
    //
    // Cursor exposes NO per-subagent token usage anywhere — no sub-transcript, no usage block, no
    // per-agent cost — so `duration_sec` is the only quantitative thing one of these segments can
    // carry, and getting it right is the whole feature. It is the residual: the part of this
    // worker's span that neither the main segment nor an earlier-billed sibling already claimed.
    //
    // Only on the turn-end path, because correlation is whole-session by contract. A worker's start
    // and its stop routinely land in different windows and `subagentStop` carries no id to join on
    // (a confirmed host bug), so the pairing is re-derived from the entire stream every time — which
    // is also why a synthetic close made from a partial stream corrects itself for free next turn.
    // The frequent `afterShellExecution` checkpoints deliberately read no history at all; their
    // subagent time is not lost, it is billed by the next turn-end, and coverage is what makes that
    // safe to do twice.
    //
    // No `code_changes` and no `operations`: Cursor gives no way to attribute an edit or a tool call
    // to the worker that made it (whether a subagent's own tool calls even reach `postToolUse` under
    // the parent's conversation_id is UNVERIFIED), and the backend stamps both once per segment and
    // sums them session-wide with no `is_subagent` filter — so a guess here would double the
    // session's line counts, not enrich them.
    if (dedupedEvents) {
      const { subagents, diagnostics } = correlateSubagents(dedupedEvents);
      onSubagentDiagnostics(diagnostics);
      // The parent's model identity, zeroed — see `subagentModelsFrom` for why the row has to exist
      // at all. THIS window's entries first; the last main segment this conversation queued when it
      // has none. That fallback is not a nicety: a subagent's residual seconds are by definition the
      // stretch where the parent was quiet, so the very window that has a subagent worth billing is
      // the one most likely to contain no generation line — and `models: []` is accepted with a
      // `200 {status:"stored"}` and written nowhere. The anchor is the most recent main segment of
      // this same conversation, so its model is the parent's by construction.
      const models = (() => {
        const fromWindow = subagentModelsFrom(delta.entries);
        if (fromWindow.length > 0) return fromWindow;
        const anchorModels = state.anchor == null ? undefined : state.anchor.models;
        return subagentModelsFrom(Array.isArray(anchorModels) ? anchorModels : []);
      })();
      // Ascending by start, which correlateSubagents already guarantees. Order decides who bills an
      // overlap when two parallel workers share seconds, so it has to be a property of the data and
      // not of iteration order: the earlier worker takes the shared seconds, every later one takes
      // only what is left, and the sum is the wall clock exactly once.
      for (const span of subagents) {
        const own = subagentIntervals([span]);
        if (own.length === 0) continue;
        // The RESIDUAL for this window: the part of the worker's span that neither the main segment
        // nor an earlier-billed sibling has claimed. Routinely ZERO, and that is the normal case
        // rather than a defect - the parent goes on emitting generation lines all the way through a
        // fan-out it is blocked on, so the main segment's own active intervals already cover every
        // second the workers ran in.
        const residualSec = Math.round(totalMs(subtractIntervals(own, covered)) / 1000);
        const alreadySent = sentSubagents[span.agent_id];
        // CUMULATIVE, never this window's residual alone. The row is upserted by a `segmentId` that
        // no longer names a window (see below), so the value on the wire has to be the whole of what
        // this worker has billed: a later turn-end that finds ten more residual seconds sends the
        // total, and the server's upsert lands on the right number instead of replacing the earlier
        // figure with the increment.
        const durationSec = (alreadySent == null ? 0 : alreadySent) + residualSec;
        // Nothing new to say: this worker has already been reported with exactly this duration.
        //
        // THIS is what stops the re-derivation from re-queueing, and it is deliberately NOT the
        // `durationSec <= 0` test that used to stand here. That one skipped a fully-covered worker
        // ENTIRELY, so a fan-out the parent stayed noisy through produced no `is_subagent` row at
        // all: the portal's Subagents card, its per-worker tree and the Tokens-by-Subagent panel all
        // read those rows, and a session that ran fifteen workers showed none of them while the
        // timeline's own gantt lanes (a different endpoint, derived straight from the spans) drew
        // all fifteen. A zero-duration row is the honest shape here - Cursor exposes no per-subagent
        // tokens, and the seconds are already billed on the parent.
        if (alreadySent != null && durationSec === alreadySent) continue;
        // Only now is a git shell-out worth spending: a session that delegated nothing must not pay
        // for one. Memoized inside `attributionOf`, so a fifteen-worker fan-out costs exactly one.
        const { branch, remote } = attributionOf();
        try {
          const payload = {
            // `<sessionId>:<agentId>`, and the omission of a line range is the point. The agent id
            // keeps this from colliding with the main segment's `<sessionId>:<from>-<to>` on the
            // server's idempotency upsert, and the id is stable across re-derivations of the same
            // session (lib/subagents-cursor.mjs), so every later report about this worker UPSERTS
            // onto the one row.
            //
            // It used to carry `:<from>-<to>`, the window it was derived in, so a still-open worker
            // that billed more residual seconds next turn landed on a second row. That was only
            // survivable while the old `<= 0` skip made such rows rare; now that a worker is
            // reported whether or not it has seconds left, a window-scoped id would add one row per
            // worker per turn-end. One row per worker carrying the cumulative duration is the shape
            // the Subagents card and the duration sums both want.
            segmentId: `${session_id}:${span.agent_id}`,
            sessionId: session_id,
            remote,
            branch,
            from_line: delta.from,
            to_line: delta.to,
            models,
            ...NO_TOKENS,
            duration_sec: durationSec,
            billing_source: billingSource,
            ...subscriptionFields,
            ...accountFields,
            ...thirdPartyFields,
            session_name: sessionName,
            ...(timezone ? { timezone } : {}),
            started_at: span.started_at,
            ended_at: span.ended_at,
            is_subagent: true,
            agent_id: span.agent_id,
            agent_type: span.agent_type,
            // The worker's own task description. Truncated here rather than trusted: it is free text
            // from whoever spawned the agent, and an over-long value fails validation for the whole
            // report. Null when the host sent none — a fabricated name would be indistinguishable
            // from a real one.
            agent_name: span.task === null ? null : span.task.slice(0, MAX_AGENT_NAME_CHARS),
            // `spawn_depth` is DELIBERATELY ABSENT and must stay absent. Cursor's payloads expose
            // `parent_conversation_id`, which only separates depth-1 from depth-≥2, and a subagent's
            // own conversation id is never exposed, so the graph cannot be walked. The field is an
            // integer on the wire: writing 1 would be a fabricated measurement that no later fix
            // could tell apart from an observed one.
          };
          stage(payload);
          // Claimed only here, after the payload is staged. A payload that cannot be staged at all
          // must not swallow the window for every later segment as well — that would silently zero
          // the next worker's duration on the strength of a report nobody will receive. The whole
          // batch is then either queued or not, together, so the claim can no longer outlive it.
          covered = claimIntervals(covered, own);
          coveredDirty = true;
          // Recorded on the same condition and for the same reason: a duration nobody was told about
          // must not count as reported, or the next turn-end would compute this worker's cumulative
          // total from a figure the server never received. Committed with the rest of `next` - one
          // commit or none - so a batch that fails to become durable leaves the worker looking
          // unreported, which is the safe direction: the row is simply sent again.
          sentSubagents[span.agent_id] = durationSec;
          sentSubagentsDirty = true;
          enqueued += 1;
        } catch { /* keep going; an unqueued subagent claims nothing and retries next turn-end */ }
      }
    }

    let stateDirty = false;
    let timelineDirty = false;
    if (accountStamp != null && state.account !== accountStamp) {
      state.account = accountStamp;
      stateDirty = true;
    }


    // Cursor names a conversation from its first prompt and can retitle it afterwards (composerData
    // .name). The new name normally rides on the next billable segment (each report re-reads it), but
    // a conversation whose rename lands with no further activity would keep the first-prompt title
    // forever. So: remember the anchor segment and the name we last sent; when the name changes but
    // no new segment carried it, replay the anchor with the corrected name. The server upserts by
    // segmentId (idempotent cost/usage) and takes the latest non-null session_name, so this only
    // fixes the name.
    //
    // `lastPayload` is the MAIN segment and only ever the main segment, so the two things that are
    // properties of the main window — the replayable anchor and the cumulative-usage baseline — are
    // gated on it rather than on `enqueued`, which now also counts subagent segments. A turn-end
    // where the main write failed but a subagent segment landed must not advance either: the anchor
    // would become a row that carries none of the window's cost, and the baseline would move past
    // spend that was never reported.
    const mainEnqueued = lastPayload !== null;
    if (mainEnqueued) {
      next.anchor = lastPayload;
      // Advance the overage baseline ONLY once the segment carrying that spend is queued. Advancing
      // it on a segment we declined to enqueue (a write failure) would baseline away money we never
      // reported, and it can never be recovered — usageData is cumulative, so the increment is gone.
      // Null means usageData was unreadable this run; keeping the old snapshot stops the baseline
      // from jumping past spend we failed to observe.
      if (delta.usage_snapshot != null) next.usageSnapshot = delta.usage_snapshot;
      // The tool→server pairs to carry into the next window, seed included, coldest first and capped
      // at 64 by lib/operations-cursor.mjs. Stored beside the cursor and on the same condition, so
      // "what has been reported" and "what was learned reporting it" can never disagree.
      //
      // THIS KEY MUST NEVER REACH THE WIRE. The ingest route runs a global
      // ValidationPipe({whitelist:true, forbidNonWhitelisted:true}): one unknown top-level property
      // 400s the ENTIRE report and the segment's tokens, cost, code changes and operations are
      // thrown away together — the scar this file already carries at the NO_TOKENS comment above.
      // Two things keep it off: it is stored on `state`, which is never spread into a payload, and
      // `operations.mcpAliases` is defined non-enumerable so even the `operations` object that IS
      // sent cannot serialize it. A later refactor of that property to a plain one would be silent
      // and catastrophic, which is why test/subagent-segments.test.mjs pins the round-trip.
      const aliases = delta.operations == null ? undefined : delta.operations.mcpAliases;
      if (Array.isArray(aliases)) next.mcpAliases = aliases;
      // The two carries that belong to the reported window, committed on the same condition as the
      // cursor and the overage baseline: "what has been reported" and "what was learned reporting
      // it" can never be allowed to disagree. Both are optional keys, read with a
      // backwards-compatible default above, so a state file from an older client behaves exactly as
      // it does today.
      //
      // NEITHER MAY REACH THE WIRE. Like `mcpAliases`, they live on `state`, which is never spread
      // into a payload.
      if (Array.isArray(delta.countedGenerations)) next.countedGenerations = delta.countedGenerations;
      if (delta.nextAttribution !== undefined) next.attribution = delta.nextAttribution;
    }
    if (enqueued > 0) {
      next.sentSessionName = sessionName;
    } else if (sessionName != null && sessionName !== state.sentSessionName && state.anchor) {
      try {
        stage({ ...state.anchor, session_name: sessionName });
        next.sentSessionName = sessionName;
      } catch { /* best-effort; retry next checkpoint */ }
    }

    // The cursor is the only record of what has already been reported, and it may move FORWARD only,
    // and only over data that was actually handed on.
    //
    // Two ways this used to lose or duplicate work:
    //
    //   backwards — computeDelta derives `to` from the events it managed to read, and a read that
    //     fails for any reason (a Windows AV scanner holding the file, a pruned sidecar) reads as
    //     "zero events". Assigning that back with `!==` rewound the cursor, and the next checkpoint
    //     re-reported everything under a segmentId the server had never seen, so its dedupe could
    //     not catch the overlap.
    //   over unsent work — when the segment was not enqueued (no repo root to attribute, or the
    //     queue write threw) the cursor advanced anyway, and those lines were never reported by anyone.
    //
    // Standing still is the safe failure: the window is re-examined next checkpoint, and the same
    // segmentId is produced once the blocker clears.
    //
    // This guard used to be the ONLY defence against a concurrent hook too, and it never was one:
    // it compares against the cursor THIS process read, so two processes that both read 100 both
    // see their own value as an advance. The per-session lock above is what actually stops that;
    // this stays as the second line of defence, for the single-process failures listed above.
    //
    // Gated on the MAIN segment, not on `enqueued`. Since `enqueued` began counting subagent
    // segments too, a window whose main write failed while a subagent segment succeeded would have
    // advanced the cursor over lines nobody reported — the exact "over unsent work" loss above,
    // reintroduced by a counter quietly changing meaning.
    const advanceable = !hasWork || mainEnqueued;
    if (advanceable && nextCursor > state.cursor) {
      next.cursor = nextCursor;
      // Recorded in the same step as the cursor, never separately: the offset is only meaningful as
      // "where the event at index `cursor` begins", so a half-updated pair would resume mid-history.
      const byte = sharedEvents ? sharedEvents.nextByte : delta.nextByte;
      if (Number.isFinite(byte) && byte >= 0) next.cursorBytes = byte;
      // The consumed-line carry, on the same step and for the same reason: it names lines the cursor
      // has moved PAST. Committed on any other condition — beside `countedGenerations`, on the main
      // segment being queued — it would be wrong in both directions: a window whose segment could
      // not be queued is re-read next checkpoint, and a carry naming its lines would make that re-read
      // drop every one of them as a "duplicate"; and a marker-only window that consumes identified
      // lines without queueing anything would lose their identities. NEVER REACHES THE WIRE: it
      // lives on `state`, which is not spread into any payload.
      if (Array.isArray(delta.consumedEventKeys)) next.consumedEventKeys = delta.consumedEventKeys;
    }
    // Remember where this conversation lives. The cwd drifts (cd, worktree switches) while the
    // conversation id is fixed, so track.mjs reads this mapping instead of relying on process.cwd().
    // Only recorded once the sidecar has content, so an empty conversation writes no state.
    if (nextCursor > 0 && state.cwd !== cwd) {
      state.cwd = cwd == null ? null : cwd;
      state.updatedAt = new Date().toISOString();
      stateDirty = true;
    }
    // The billed wall clock, carried to the next checkpoint. Bounded by `claimIntervals` at
    // MAX_COVERED_INTERVALS (oldest dropped first, which is safe because activity only moves forward
    // and an entry that far back can no longer overlap an incoming window) — without that bound a
    // long conversation with thousands of idle gaps grows this state file for its whole life.
    if (coveredDirty) {
      next.coveredIntervals = covered;
    }
    // What each subagent has been reported as having billed. Same commit gate as the coverage it is
    // derived from - between them they answer one question ("which seconds are spoken for, and by
    // whom"), and a state where one landed and the other did not is a worker that either bills twice
    // or never bills again.
    //
    // NEVER REACHES THE WIRE: like `mcpAliases`, it lives on `state`, which is not spread into any
    // payload.
    if (sentSubagentsDirty) {
      next.sentSubagents = sentSubagents;
    }
    // ── C-10 steps 2-3: the batch becomes durable before a single item is queued
    //
    // Nothing above this line touched the queue or the state. If any of it fails the run is over
    // and NOTHING is committed: the cursor stands still, the record (if it was written) is
    // recovered by the next hook, and the same ids and bytes are re-queued. Standing still is the
    // safe failure; a partial commit is the one that loses or duplicates money.
    let pendingWritten = false;
    let committable = true;
    if (durable) {
      if (items.length > 0) {
        try {
          savePendingBatch(session_id, Object.freeze({
            version: PENDING_VERSION,
            sessionId: session_id,
            createdAt: now(),
            // The account this batch was BUILT under. Recovery refuses a batch whose account no
            // longer matches: those segments belong to a different tenant.
            account: accountStamp == null ? null : accountStamp,
            // The FROZEN raw window, for provenance and for the crash regressions. Recovery never
            // re-derives it from a sidecar that may have grown since.
            window: {
              from: Number.isFinite(consumed.from) ? consumed.from : null,
              to: Number.isFinite(consumed.to) ? consumed.to : null,
              byte: next.cursorBytes === undefined ? null : next.cursorBytes,
            },
            // The attribution split the planner produced, recorded for provenance. The payloads
            // below are the ones that will be queued, so recovery never re-plans.
            runs: Array.isArray(delta.segments)
              ? delta.segments.map((segment) => ({
                from: segment.from,
                to: segment.to,
                repoRoot: segment.repoRoot == null ? null : segment.repoRoot,
                branch: segment.branch == null ? null : segment.branch,
              }))
              : null,
            items: items.map((payload) => ({ segmentId: payload.segmentId, payload })),
            next: { ...next },
          }));
          pendingWritten = true;
          for (const item of items) enqueueIfAbsent(item);
        } catch {
          committable = false;
        }
      }
    } else {
      // No durable queue to make atomic: hand each payload straight to the sink, exactly as before
      // the batch existed. A sink that throws loses that one report and nothing else — the audit
      // owns its own delivery and its own ledger.
      let delivered = 0;
      for (const item of items) {
        try { emit(item); delivered += 1; } catch { /* keep going */ }
      }
      enqueued = delivered;
      // The same gate `advanceable` used to be, restated for this path — and it covers EVERY item,
      // not only the main one. `mainEnqueued` now means "a main payload was BUILT", because staging
      // happens before any of it is durable, so on its own it no longer answers the question the
      // cursor needs answered: was this window handed on. The durable path answers that with
      // `committable`; this one has to answer it here.
      //
      // ALL of them, and that is the correction rather than a nicety. `covered` is claimed during
      // the BUILD, right after each `stage()`, so by the time anything is emitted `next
      // .coveredIntervals` already contains every subagent's span. Committing it when one of those
      // reports was refused marks seconds covered that nobody was told about, and coverage is
      // subtractive: the next turn-end sees them already claimed and bills them to no one, forever.
      // Unlike a queue failure there is no pending record left behind to say so.
      //
      // Unreachable today, because every caller that supplies a sink also supplies
      // `CheckpointMode.AUDIT`, which means `freshState`, which means nothing is written back at
      // all. That is a coupling, not a guarantee, and it is the same coupling that made the main
      // half look safe.
      if (delivered !== items.length) committable = false;
    }
    // ── C-10 step 4: one commit, or none
    if (committable) commitNext();
    else enqueued = 0;
    // A historical parse must not rewrite this session's live state: the backfill route, not the
    // cursor, decides what was delivered, and advancing the cursor here would consume the sidecar's
    // lines before the server ever accepted them — a failed delivery would leave the session
    // unledgered AND unreadable, and the re-run would find nothing left to send.
    //
    // One condition, not two: "parsed from scratch" and "must not write back" are the same fact
    // about a historical replay, and the separate persistState flag that used to say the second
    // half was never passed without the first.
    let committed = committable;
    if (stateDirty && !freshState) {
      try { saveState(session_id, state); } catch { committed = false; }
    }
    // ── C-10 step 5: and only now
    //
    // The record is the authority right up to the moment the state commit is on disk. Unlinking it
    // before that would turn a lost commit into a lost window.
    if (pendingWritten && committed) dropPendingBatch(session_id);

    // ── best-effort network, deliberately BELOW the commit
    //
    // Both of the calls below can spend the rest of the hook's budget, and a host that kills a hook
    // at its registered timeout kills it mid-POST. Above the commit that would throw away a window
    // this run had already fully derived; below it, the queue file and the cursor are durable before
    // a single packet leaves, and a killed hook loses only the POST. The cost is one extra state
    // write on the turn-ends where the timeline signature changes — the cheaper side of the trade,
    // because losing the signature costs one duplicate upsert and the server upserts.
    // postSessionError swallows its own failures (never rejects), so a limit-report problem can't
    // break the checkpoint. Cursor exposes no rate-limit signal locally today; the loop stays so a
    // delta that learns to emit one needs no change here.
    for (const event of delta.rateLimitEvents == null ? [] : delta.rateLimitEvents) {
      const errorPayload = {
        sessionId: session_id,
        error: 'rate_limit',
        errorDetails: null,
        lastAssistantMessage: event.text,
        occurredAt: event.occurredAt == null ? new Date().toISOString() : event.occurredAt,
      };
      // The backfill buffers these instead: one awaited POST per event across hundreds of
      // sessions is minutes of dead time, and follow-ups only make sense for sessions the server
      // accepted.
      if (collectSessionErrors) {
        collectedErrors.push(errorPayload);
        continue;
      }
      await postSessionError(errorPayload, token, { fetchImpl });
    }
    // The activity timeline is whole-session, so it's re-derived from the full sidecar and shipped
    // only at turn-ends (stop / sessionEnd) — not on the frequent afterShellExecution path. Skip the
    // POST when the derived content is identical to the last one we sent (a stop with no new
    // activity), so we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must
    // never break the checkpoint.
    //
    // Deliberately NOT reached in audit mode, which shares the parse above but ships its timelines
    // in its own chunk payloads: posting here as well would send each one twice, on a route that
    // is tracking-gated and therefore 403s for audit-only tenants anyway.
    if (postTimeline) {
      try {
        const timeline = computeSessionTimeline(
          session_id,
          dedupedEvents
            // Already collapsed above, so the collapse here is the identity — this hands over the
            // same array the subagent segments were billed from rather than paying for a second
            // full pass inside the same 7.5 s budget. NOT `dedupeEvents: null`, which that module
            // reads as "no collapse is available" and answers by withholding the subagent list
            // entirely; the two look alike and mean opposite things.
            //
            // `cliDeps` carries the deadline (and the store seams) to the CLI subagent enrichment the
            // timeline runs; on the first branch the array is already enriched and that is a no-op.
            ? { readEvents: () => dedupedEvents, dedupeEvents: (events) => ({ events }), onSubagentDiagnostics, ...cliDeps }
            : { onSubagentDiagnostics, ...cliDeps },
          // GATED (CAPABILITIES.breakState). `false` is what that module already assumes when the
          // third argument is omitted, so this is a no-op today — the seam is wired now rather than
          // added later under time pressure.
          { allowBreakState: CAPABILITIES.breakState },
        );
        if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
          const sig = timelineSigOf(timeline);
          if (sig !== state.sentTimelineSig && !enrichmentComplete) {
            // The deadline cut the CLI subagent listing short, so this timeline may be missing
            // lanes it would otherwise have. It is NEVER POSTed: the server upserts by sessionId,
            // so a lane-less body would erase lanes an earlier turn-end already delivered, whether
            // or not an outbox entry exists. It never overwrites an existing entry either (the
            // Codex reproduction: one lane became zero, and a later drain sent that). With no
            // entry it is kept flagged `partial`, and the drain rebuilds it with a fresh deadline
            // and sends only a complete rebuild — for a CLI session this sessionEnd may be the
            // only turn-end there is. `sentTimelineSig` is untouched: nothing was sent.
            // An incomplete listing means the deadline has passed, so this is the budget talking.
            const queued = readTimelineOutbox(session_id);
            if (queued === null) {
              writeTimelineOutbox(session_id, { sig, body: { sessionId: session_id, ...timeline }, account: accountStamp, partial: true }, { now });
            } else if (queued.partial !== true) {
              // An entry queued by an EARLIER turn keeps its lanes, but it is now older than the
              // session: this checkpoint saw later activity it could not finish enriching. Left as
              // it was, the drain would send that stale body and delete it — the final stretch of
              // the timeline lost (Codex re-review: delivered timeline ended 16 s before the
              // session did). Marking it partial makes the drain rebuild from the sidecar first.
              writeTimelineOutbox(session_id, { sig: queued.sig, body: queued.body, account: queued.account, partial: true }, { now });
            }
            state.timelineLastStatus = 'no-budget';
            timelineDirty = true;
          } else if (sig !== state.sentTimelineSig) {
            const body = { sessionId: session_id, ...timeline };
            // The outbox entry goes to disk BEFORE the POST (lib/timeline-outbox.mjs, plan E11).
            // "Retried at the next turn-end" is no retry at all for a Cursor CLI session, which gets
            // one sessionEnd at most, so a failed or killed POST must leave the body where ANY later
            // hook's flush can deliver it. Written even when the budget skips the POST below: a
            // sessionEnd that ran out of time is exactly the CLI's one chance.
            writeTimelineOutbox(session_id, { sig, body, account: accountStamp }, { now });
            let status = 'no-budget';
            // Skipped rather than started when the budget is already gone. The signature is only
            // recorded on a confirmed send, so the entry above stays for the next flush.
            if (timeLeft() === null || timeLeft() > 0) {
              const remaining = timeLeft();
              const outcome = await postSessionTimeline(
                body,
                token,
                { fetchImpl, ...(remaining === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, remaining) }) },
              );
              status = timelineStatusOf(outcome);
              if (outcome.reported) {
                state.sentTimelineSig = sig;
                dropTimelineOutbox(session_id);
              }
              // The flush below drains the outbox too. A 401 is the one failure it should retry
              // straight away, because it can force a token refresh and this POST cannot; anything
              // else would just repeat against the same unhappy server inside the same budget.
              if (!outcome.reported && status !== 401) timelineOutboxSkip = session_id;
            }
            // Always recorded, the answer as well as the attempt: the status used to be discarded,
            // which is why E11 ("attempted, never confirmed") took a simulation to diagnose. A local
            // key only — nothing spreads session state onto a wire payload.
            state.timelineLastStatus = status;
            timelineDirty = true;
          }
        }
      } catch { /* best-effort */ }
    }
    // The timeline signature is the only thing below the commit that wants persisting, so it pays
    // for its own write rather than holding the commit open across a network call.
    if (timelineDirty && !freshState) {
      try { saveState(session_id, state); } catch { /* best-effort; re-derived and retried next turn */ }
    }
    if (mapDirty) {
      try { saveRepoMap(map); } catch { /* best-effort */ }
    }

    return { enqueued };
  };

  // `lockHeld` is the audit/sync extraction path: the CALLER holds this session's lock across the
  // coverage query, the extraction and the acknowledgment, so taking it again here would lose the
  // race against ourselves — `withLock` SKIPS on contention — and yield zero reports, which is
  // indistinguishable in a sync summary from "everything is already covered".
  const guarded = options.lockHeld === true
    ? await guardedPass()
    : await withLock(sessionLockPath(session_id), guardedPass, { now, miss: CONTENDED });

  if (guarded === null) return emptyResult();
  const enqueuedCount = guarded === CONTENDED ? 0 : guarded.enqueued;

  // The backfill owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  //
  // `auth` is forwarded only when a caller injected one (tests); otherwise flushQueue builds the real
  // seam from lib/token.mjs exactly as before.
  const flush = skipFlush
    ? null
    : await flushQueue(token, {
      fetchImpl,
      now,
      ...(deadline === null ? {} : { deadline }),
      ...(deps.auth == null ? {} : { auth: deps.auth }),
      ...(timelineOutboxSkip === null ? {} : { timelineOutboxSkip }),
      ...snapshotDeps,
    });
  return { enqueued: enqueuedCount, flush, sessionErrors: collectedErrors, deltaFailed };
}

// Audit-only extraction: parse one past session from `options.startCursor` and hand the caller its
// reports, WITHOUT taking the session lock and WITHOUT writing any state. `lib/session-audit.mjs`'s
// runSync consumes this as `deps.extractAuditReports`.
//
// The lock is the whole reason this exists as a separate entry point. `runSync` holds
// `sessionLockPath(id)` across the coverage query, the extraction and the acknowledgment, because
// its guarded section legitimately runs for minutes; a plain `runCheckpoint` call from inside would
// try to take that same lock, lose, and return nothing. Hence `lockHeld: true` — and hence the
// test that asserts these reports come back WHILE the caller holds the lock.
export async function extractAuditReports(input, deps = {}, options = {}) {
  const reports = [];
  const checkpoint = await runCheckpoint(input, deps, {
    ...options,
    mode: CheckpointMode.AUDIT,
    lockHeld: true,
    sink: (payload) => reports.push(payload),
  });
  return {
    reports,
    sessionErrors: checkpoint == null || checkpoint.sessionErrors == null ? [] : checkpoint.sessionErrors,
    deltaFailed: checkpoint != null && checkpoint.deltaFailed === true,
  };
}

// Delivery lives in lib/queue-delivery.mjs now — the retry classification, the head-of-line
// backoff, the budget deferral, the quarantine of an unparseable record and the reasoning for each
// moved there whole. This wrapper is the compatibility boundary CONTRACTS §6 requires:
// scripts/track.mjs, lib/session-start.mjs and test/flush-budget.test.mjs all call
// `flushQueue(token, deps)` and read `flushed` / `rejected` / `failed` / `deferred` / `lastError`,
// and deliverQueue returns every one of those plus `sent` / `gated` / `trackingDisabled` /
// `quarantined` / `quarantineFailed`. `sent` is an ALIAS of `flushed`, not a replacement, so
// nothing downstream had to change on the same commit.
//
// One key is added on top, `timelines`: the outbox drain's counts (sent / dropped / kept / foreign
// / contended / skipped / deferred). Additive, and absent when the flush was gated, so every reader
// of the fields above sees exactly what it saw before.
//
// `token` is already resolved by the caller, so `getToken` hands it straight back. `forceRefresh`
// and `authEpoch` are the REAL seams from lib/token.mjs (CONTRACTS §2) — not the inert fallbacks
// the extraction shipped with. That is what makes two of deliverQueue's guarantees live rather
// than theoretical: a 401 renews once per flush and retries the exact same payload, and the epoch
// fence defers instead of delivering one account's queued report under another's credentials.
export async function flushQueue(token, deps = {}) {
  const auth = deps.auth == null
    ? {
        getToken: async () => token,
        forceRefresh: (options) => _forceRefresh(options == null ? {} : options, {}),
        authEpoch: () => _authEpoch({}),
      }
    : deps.auth;
  const deadlineAt = deps.deadline == null ? null : deps.deadline;
  // ONE snapshot of the login — epoch, token, account — taken before anything is sent, and used by
  // BOTH stages. Codex review (DO NOT SHIP), the blocking finding: the report stage kept account
  // A's token while the timeline drain took a FRESH epoch and account after it, so a login switch
  // to B in between let B's queued timelines pass the account check and go out as `Bearer token-A`.
  // The drain now fences against this snapshot and never re-reads it (lib/timeline-outbox.mjs).
  // A snapshot that cannot be taken leaves the report stage exactly as before and skips the drain:
  // a drain with no fence to hold is the leak this exists to close.
  //
  // `deps.authSnapshot` is runCheckpoint's, read where its token was resolved (see there): a caller
  // whose token is older than this call must hand over the epoch and account read WITH it.
  let snapshot = deps.authSnapshot == null ? null : deps.authSnapshot;
  if (snapshot === null) {
    try {
      snapshot = await takeAuthSnapshot(auth, deps.currentAccountKey == null ? {} : { currentAccountKey: deps.currentAccountKey });
    } catch { snapshot = null; }
  }
  // The report stage runs under the same snapshot. deliverQueue (lib/queue-delivery.mjs, not ours
  // to change here) takes its fence from its FIRST `authEpoch()` call and its token from its one
  // `getToken()` call, so pinning those two answers to the snapshot is what makes it one snapshot
  // rather than two taken a few awaits apart. Every later `authEpoch()` is live: those are its
  // fence CHECKS, and a pinned answer there would blind them. This depends on that call order; if
  // deliverQueue ever reads the epoch before its fence, this pin moves with it.
  let fencePinned = false;
  const reportAuth = snapshot === null
    ? auth
    : {
        getToken: async () => snapshot.token,
        forceRefresh: (options) => auth.forceRefresh(options),
        authEpoch: () => {
          if (!fencePinned) { fencePinned = true; return snapshot.epoch; }
          return auth.authEpoch();
        },
      };
  const result = await deliverQueue({
    auth: reportAuth,
    deadlineAt,
    // The diagnostics sink. Lazy on purpose: lib/telemetry.mjs pulls child_process and http, and
    // this default must not put them on the import graph of a module a hook evaluates. A machine
    // that has not consented has nothing to load and the recorder stays silent.
    deps: deps.recordIssue == null ? { ...deps, recordIssue: lazyRecordIssue } : deps,
  });
  // Then the session-timeline outbox (lib/timeline-outbox.mjs, plan E11): here because every hook
  // and session start already calls this, and a Cursor CLI session gets no later turn-end of its own
  // to retry at. AFTER the reports, which carry the billing, and behind the same gates: a tenant
  // with tracking off has its timelines held exactly like its reports, and the deadline is the same
  // absolute instant. `outboxDir`, not `dir` — `deps.dir` is the REPORT queue's directory.
  if (!result.gated && !result.trackingDisabled && snapshot !== null) {
    try {
      result.timelines = await drainTimelineOutbox({
        auth,
        snapshot,
        deadlineAt,
        skipSessionId: deps.timelineOutboxSkip == null ? null : deps.timelineOutboxSkip,
        // A partial entry is rebuilt by the drain; it must classify exactly as this module's own
        // timeline does, and every caller of flushQueue (hooks, track, session start) gets that.
        timelineOptions: { allowBreakState: CAPABILITIES.breakState },
        deps: {
          ...(deps.now == null ? {} : { now: deps.now }),
          ...(deps.fetchImpl == null ? {} : { fetchImpl: deps.fetchImpl }),
          ...(deps.outboxDir == null ? {} : { outboxDir: deps.outboxDir }),
          ...(deps.currentAccountKey == null ? {} : { currentAccountKey: deps.currentAccountKey }),
        },
      });
    } catch { /* best-effort: the drain never throws, and this flush's result must not either */ }
  }
  return result;
}
