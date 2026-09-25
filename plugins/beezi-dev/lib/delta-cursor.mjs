import { readEventsFrom } from './sidecar-read.mjs';
import { readUsageData as _readUsageData } from './vscdb.mjs';
import { computeOperations, totalEstTokens } from './operations-cursor.mjs';
import { computeCodeChanges } from './code-changes-cursor.mjs';
import { buildActiveIntervals, totalMs } from './active-time.mjs';
import * as hostTiming from './timing.mjs';
// One `timestampOf`, owned by the dependency-free module. This file used to carry an identical
// copy; lib/subagents-cursor.mjs imports nothing, so reading it from there cannot make a cycle.
import { timestampOf } from './subagents-cursor.mjs';
import { pickString } from './pick-field.mjs';
import { baseModelId, isPlaceholderModel } from './model-name-cursor.mjs';
import { readCliChatMeta, readCliStoreFacts } from './cli-chats-cursor.mjs';

// Turn the sidecar into one reportable segment and split its requests across the two money streams.
//
// Why the sidecar and not a Cursor transcript: `segmentId` indexes OUR event lines, so idempotency
// survives Cursor moving its storage format (it has moved four times in a year, twice taking user
// history with it). A Cursor upgrade costs cost-attribution, never the segment.
//
// One window produces ONE segment. Cursor's sidecar carries no per-event cwd — the repo context for
// the window comes from the hook payload — so there is nothing to split on the way the Codex engine
// splits a rollout that cd's mid-session.
//
// THE COST SPLIT. Cursor writes `usageData` only for usage-priced requests, and it carries `amount`
// (how many requests were priced) next to `costInCents`. So per (conversation, model) we know both
// the priced count and the total count:
//
//   pool          requests                    cost
//   credits       amount                      costInCents / 100
//   subscription  total_requests − amount     0
//   unknown       total_requests              0        (usageData could not be read AT ALL)
//
// `unknown` is not a rounding of `subscription`. Absence of a price record is *presumed* in-allowance
// but is equally consistent with write lag, a schema move, or no node:sqlite — and a row we call
// `subscription` inflates the seat-covered bucket with spend nobody can see. Never guess.

// lib/timing.mjs is imported statically at the top of this file. It used to be bound through a
// guarded top-level `await import`, which the Node 13.2 floor rules out; the module is a sibling in
// this package, and the 300 below survives as the literal the shared constant is pinned to.
const IDLE_GAP_SEC =
  typeof hostTiming.IDLE_GAP_SEC === 'number' ? hostTiming.IDLE_GAP_SEC : 300;

export const BILLING_POOL = Object.freeze({
  SUBSCRIPTION: 'subscription',
  CREDITS: 'credits',
  UNKNOWN: 'unknown',
});

// TODO(P0): unverified — see lib/hook-dump.mjs
const GEN_EVENTS = new Set(['gen', 'generation']);
const MODEL_FIELDS = ['model', 'model_name', 'modelName'];
// The user-facing spelling of the same model — the id with its `model_params` folded in
// ("kimi-k3-max"). Requests bucket under the model id so one model stays one model, but Cursor
// prices per variant, so the variant is what `usageData` is keyed by.
const VARIANT_FIELDS = ['model_variant', 'modelVariant'];
const KNOWN_EVENTS = new Set([
  'gen',
  'generation',
  'tool',
  'tool_call',
  'tool_error',
  'tool_failed',
  'edit',
  'file_edit',
  'edits',
  'shell',
  'prompt',
  'user',
  'user_message',
  'user_prompt',
  'stop',
  'start',
  'session_start',
  'end',
  'session_end',
  // The three kinds lib/sidecar-events.mjs added for `beforeMCPExecution`, `subagentStart` and
  // `subagentStop`. They are listed here for ONE reason and it is not counting: `schemaMiss` below
  // fires when a window contains events and recognises none of them, and it is surfaced to the host
  // as a writer/reader schema mismatch. A window that happened to hold only MCP side-channel or
  // subagent lines — a turn that did nothing but fan out to workers is exactly that — would
  // otherwise be reported as a broken sidecar on a machine where nothing is broken.
  //
  // None of the three is counted anywhere. `mcp_server` is a side channel that deliberately carries
  // no bytes and no duration, because `postToolUse` already writes the countable `tool` line for the
  // same MCP call; it is excluded from computeOperations by construction, since TOOL_EVENTS in
  // operations-cursor.mjs does not contain it. The two subagent kinds are records of what the host
  // reported, not requests — Cursor exposes no per-subagent token usage at all, so there is nothing
  // about them to bill.
  'mcp_server',
  'subagent_start',
  'subagent_stop',
]);

// SESSION-level lifecycle lines: the host opening or closing a conversation. They carry no work of
// their own, they may not move the segment's clock, and they cannot justify a billed segment.
//
// Why this is not pedantry (DATA-04): `session_end` fires on every normal shutdown, so a window
// holding nothing else used to produce an empty point segment with a `started_at`, a `duration_sec`
// of 0 and a place in every per-session count. A session closed hours after its last turn would
// also stretch that turn's span to the shutdown.
const SESSION_LIFECYCLE_EVENTS = new Set(['start', 'session_start', 'end', 'session_end']);

// TURN-end markers. `stop` is where the assistant's work actually finished, so it IS a timing
// anchor: the seconds between the last tool call and the end of the turn are real work, and a
// whole-history window (which holds every turn of a session at once) has a `stop` in the MIDDLE of
// it, where dropping it merges the gaps either side into one idle stretch and deletes minutes that
// really happened. Measured on `tool@0s, tool@10s, stop@200s, tool@400s`: 400 s of span becomes 10 s.
//
// It is still not ACTIVITY: a window containing nothing but turn ends describes no work of its own,
// which is why the two sets below are separate rather than one.
//
// TURN STARTS sit in the same set, for the same two reasons in the other direction. The `prompt`
// line scripts/prompt-submit.mjs writes on `beforeSubmitPrompt` is the instant the human pressed
// Send; the seconds from there to the first tool call or the turn's `stop` are the agent's, and a
// CLI turn that calls no tool has NOTHING else in the sidecar before its `gen` + `stop` pair — so
// without the prompt anchoring the clock that whole turn bills as a point. But a prompt is not work
// either: a window holding only prompt lines is a turn the user aborted before the agent did
// anything, and letting it justify a segment would bill a keypress. The three aliases are the
// spellings the reader has always recognised (KNOWN_EVENTS, lib/session-name-cursor.mjs), kept
// together so one of them cannot drift back into ACTIVITY on its own.
const TURN_END_EVENTS = new Set(['stop', 'prompt', 'user', 'user_message', 'user_prompt']);

// The timing-anchor allowlist: every kind this reader understands EXCEPT the session lifecycle.
//
// Positive, not negative, and that is deliberate: a window whose lines are all unrecognised reports
// null bounds and zero duration beside `diagnostics.schemaMiss`, rather than a confident span
// derived from events nothing could read. A blanked span next to a schema-mismatch warning is a
// legible failure; a plausible one is not.
//
// `subagent_start` / `subagent_stop` ARE anchors. Their timestamps are real delegated wall clock,
// and the active intervals built from them are what the checkpoint claims as covered — narrowing
// them here would let a subagent segment re-bill minutes the parent already reported.
export const TIMING_ANCHOR_EVENTS = new Set(
  [...KNOWN_EVENTS].filter((ev) => !SESSION_LIFECYCLE_EVENTS.has(ev)),
);

// What counts as WORK when deciding whether a segment is worth emitting: the anchors minus the turn
// boundaries (ends AND starts). A `stop` + `session_end` window anchors a span and still reports
// nothing billable, and so does a window of bare `prompt` lines.
export const ACTIVITY_EVENTS = new Set(
  [...TIMING_ANCHOR_EVENTS].filter((ev) => !TURN_END_EVENTS.has(ev)),
);

const UNKNOWN_MODEL = 'unknown';

// How many generation identities a window hands to the next one. A generation writes many lines and
// a window boundary can fall between them, so the next window has to know which generations it has
// already billed a request for - without it a mid-turn checkpoint (the pulse, or the frequent
// `afterShellExecution` path) counts one generation twice and inflates the seat-covered bucket,
// which is what `covered = requests - usageData.amount` is computed from.
//
// Bounded because it is persisted per session: only generations near the boundary can still be
// straddled, so a short tail is enough and an unbounded list would grow for the life of a
// conversation. Oldest entries fall off the front.
export const MAX_CARRIED_GENERATIONS = 200;

// How many consumed-line identities a window hands to the next one (see consumedKeysOf). A late
// copy from the other hook registry lands milliseconds after its original, so only the lines nearest
// the boundary can still have a copy outstanding; a short tail is enough, and like the generation
// carry above it is persisted per session, so it is bounded and the oldest entries fall off the front.
export const MAX_CARRIED_EVENT_KEYS = 256;

// Every `usageData` key that prices one model, matched case-insensitively — a case difference
// between the hook payload's spelling and Cursor's own would otherwise move an entire model's spend
// into `subscription` silently.
//
// A LIST, not a single key, for two reasons. Cursor prices per model *variant* while requests are
// bucketed per model id, so "kimi-k3" legitimately owns the price records for "kimi-k3" and
// "kimi-k3-max" at once; and the observed KEYS are what the caller marks consumed, so a record that
// belongs to a model must not be left behind to be re-reported by the leftover pass under its
// variant spelling as if it were a model of its own.
function matchUsageKeys(usage, candidates) {
  if (!usage) return [];
  const wanted = new Set();
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') wanted.add(candidate.toLowerCase());
  }
  if (wanted.size === 0) return [];
  return Object.keys(usage).filter((key) => wanted.has(key.toLowerCase()));
}

// The priced count and cost carried by a set of usageData keys. Used for both the current snapshot
// and the baseline, over the SAME keys, so the increment can never be taken between two different
// price records.
function sumUsage(store, keys) {
  let amount = 0;
  let costInCents = 0;
  if (!store) return { amount, costInCents };
  for (const key of keys) {
    const record = store[key];
    if (!record) continue;
    amount += num(record.amount);
    costInCents += num(record.costInCents);
  }
  return { amount, costInCents };
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
// Cents are integers; dividing by 100 in binary floating point is not. Round at the cent's precision
// so a reported cost never carries 1e-17 noise into the database.
const centsToUsd = (cents) => Math.round(cents) / 100;

export const TOKEN_KEYS = Object.freeze([
  'token_input',
  'token_output',
  'token_cache_read',
  'token_cache_write',
]);

// Bucket key for one generation of one model. A model id can contain most characters but never a
// newline, so this pairs them unambiguously and splits back apart without a scan.
const GEN_KEY_SEP = '\n';
const genKey = (model, id) => `${model}${GEN_KEY_SEP}${id}`;
const modelOfGenKey = (key) => key.slice(0, key.indexOf(GEN_KEY_SEP));

// A generation's id, or null for a line that has none (an older sidecar, or an unstamped event).
const genIdOf = (event) => (typeof event.gen_id === 'string' && event.gen_id !== '' ? event.gen_id : null);

// A carried key with its model half reduced to the base id. State written by the previous release
// holds the raw slug ("claude-opus-5-thinking-high\ng1"); normalizing on the way through keeps the
// persisted list from growing a second spelling of the same identity. The format itself stays
// `model\ngen_id`, so a downgraded plugin can still read what this one wrote. A key with no
// separator names no generation and passes through untouched.
function normalizeCarriedKey(key) {
  const cut = key.indexOf(GEN_KEY_SEP);
  if (cut < 0) return key;
  const base = baseModelId(key.slice(0, cut));
  return `${base === null ? key.slice(0, cut) : base}${key.slice(cut)}`;
}

// Only the CLI-reader deps the caller actually set: an absent key must stay absent, because
// lib/cli-chats-cursor.mjs reads `sqlite: undefined` as "use the real one and cache" and anything
// else as an injected reader.
function cliReaderDeps(resolvers) {
  const deps = {};
  for (const name of ['deadline', 'chatsDir', 'sqlite']) {
    if (resolvers[name] !== undefined) deps[name] = resolvers[name];
  }
  return deps;
}

// Cursor's Auto: a generation whose every line said `default` (plan evidence E3), with no concrete
// line of the same generation in this window or an earlier one to fold it into. The IDE's usageData
// names the routed model per price record, but a CLI chat has none; the CLI's own chat store names it
// per reply. Plan Revision 3 (R3) steps 2-4, in order:
//
//   1. unanimous replies  every `modelName` in a COMPLETE scan has one base id. Complete matters: a
//                          scan the caps or the deadline cut short may have skipped the one reply
//                          that was routed elsewhere, so a partial agreement is not an answer.
//   2. lastUsedModel       only when concrete, the scan is complete, and no reply named a model.
//   3. nothing             null; the caller keeps `default` and counts it as `unresolvedAuto`.
//
// No per-turn mapping and no majority vote: the store carries no reply→generation link we have
// verified, and a guessed model is worse than an honest `default`. Mixed routing within one session
// is a recorded limitation (plan Follow-ups).
//
// KNOWN LIMITATION: the store puts `modelName` only on a reply's REASONING parts, so a reply that did
// no reasoning is invisible here. "Unanimous" therefore means "every reply that reasoned", and an
// empty `replyModels` can mean "no reply reasoned" rather than "no reply" — which is why step 2 also
// requires `lastUsedModel` to be a concrete pick of the user's rather than the router's `default`.
//
// `resolvers.cliStoreFacts` / `resolvers.cliMeta` are the test seams: undefined reads the store from
// disk, null means "no store". Never cli-config.json: that is the user's model NOW, not the one this
// session ran on. The deadline is forwarded so a slow store cannot run the hook past its budget.
function resolveAutoModel(conversationId, resolvers) {
  const deps = cliReaderDeps(resolvers);
  const facts = resolvers.cliStoreFacts !== undefined
    ? resolvers.cliStoreFacts
    : readCliStoreFacts(conversationId, deps);
  if (facts == null || facts.complete !== true || !Array.isArray(facts.replyModels)) return null;
  if (facts.replyModels.length > 0) {
    let agreed = null;
    for (const raw of facts.replyModels) {
      const base = baseModelId(raw);
      if (base === null || isPlaceholderModel(base)) return null;
      if (agreed === null) agreed = base;
      else if (agreed !== base) return null;
    }
    return agreed;
  }
  const meta = resolvers.cliMeta !== undefined ? resolvers.cliMeta : readCliChatMeta(conversationId, deps);
  const last = meta == null ? null : meta.lastUsedModel;
  if (typeof last !== 'string' || isPlaceholderModel(last)) return null;
  return baseModelId(last);
}

// Keep the largest value seen for each count within one generation.
//
// The same generation can be described by several sidecar lines, and only the turn-end one carries
// token counts — so "last write wins" would let a trailing tool-call line erase them. Taking the
// maximum is also the safe answer if Cursor ever reports a turn's usage more than once as it grows:
// the final figure is the complete one.
function mergeTokens(byGeneration, key, event) {
  let bucket = byGeneration.get(key);
  for (const field of TOKEN_KEYS) {
    const value = event[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (!bucket) { bucket = {}; byGeneration.set(key, bucket); }
    const prior = bucket[field];
    bucket[field] = Math.max(prior == null ? 0 : prior, Math.round(value));
  }
}

// Whether a line carries at least one usable token count. The same test mergeTokens applies field by
// field, asked once about the whole line: it is what decides WHICH run a generation's tokens are
// billed to when the window is split, and "the line that had them" must mean the same thing in both
// places.
function hasTokenCounts(event) {
  for (const field of TOKEN_KEYS) {
    const value = event == null ? undefined : event[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return true;
  }
  return false;
}

// Per-generation counts summed across the window, or null when no generation in it reported any.
// Null is load-bearing: it is what keeps "this Cursor build tells us nothing about tokens" distinct
// from "this segment genuinely used none", and the report omits the fields entirely in that case
// rather than asserting zeros.
function sumTokens(byGeneration) {
  if (byGeneration.size === 0) return null;
  const totals = { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_write: 0 };
  let seen = false;
  for (const bucket of byGeneration.values()) {
    for (const field of TOKEN_KEYS) {
      if (typeof bucket[field] !== 'number') continue;
      totals[field] += bucket[field];
      seen = true;
    }
  }
  return seen ? totals : null;
}

// Smallest and largest timestamp in one pass. See the call site for why this is not Math.min/max
// with a spread.
function boundsOf(timestamps) {
  if (!timestamps.length) return { startedMs: null, endedMs: null };
  let min = timestamps[0];
  let max = timestamps[0];
  for (const t of timestamps) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { startedMs: min, endedMs: max };
}

// The window's active stretches, as the half-open [startMs, endMs) pairs lib/active-time.mjs works
// in. This used to be a scalar `activeMs` that summed the sub-threshold gaps inline; the intervals
// are the same arithmetic (`buildActiveIntervals` skips a gap when `gap <= 0 || gap >= idleGapMs`,
// which is the identical `gap > 0 && gap < idleGapMs` test), so `duration_ms` is unchanged to the
// millisecond — but the host now needs the SHAPE, not just the total.
//
// Why: a subagent segment bills `subtractIntervals(ownSpan, covered)`, and `covered` has to be what
// the main segment actually worked, NOT its outer [started_at, ended_at] envelope. A subagent that
// ran for ten minutes writes only two lines (start and stop), so from the parent's point of view
// those ten minutes are one idle gap and the parent bills ~0 for them. Claiming the envelope would
// mark that gap covered and the subagent would bill 0 too — the ten real minutes would vanish from
// the session entirely, which is the exact opposite of the double-billing this model exists to stop.
function activeIntervalsOf(timestamps) {
  return buildActiveIntervals(timestamps, IDLE_GAP_SEC * 1000);
}

// ---------------------------------------------------------------------------
// Duplicate collapse
// ---------------------------------------------------------------------------
//
// One machine can be reached by two hook registries at once: the bundled `hooks/hooks.json` inside
// the installed plugin, and the launchers merged into `~/.cursor/hooks.json`. Both fire for the same
// host event and each writes its own sidecar line, so every tool call, generation and edit is
// recorded twice.
//
// That used to be arbitrated at WRITE time — a launcher run stood down whenever a bundled run had
// been recorded in the last fortnight, and the self-installer deleted the user-scope registry
// outright once a bundled hook had been seen to fire. Both rested on the premise "the bundled
// registry is alive, so the launcher is redundant", and the premise is false: older `cursor-agent`
// builds (Jun–Aug 2026) ran no hook that came from an installed plugin, only `~/.cursor/hooks.json`
// and `<project>/.cursor/hooks.json` (Cursor staff, forum 163890). A single IDE session was therefore
// enough to delete the CLI's only registry, after which every CLI session on that machine reported
// nothing — silently, and for as long as the IDE kept being used.
//
// So the copies are collapsed here instead, on the event's own identity. That is a fact about the
// event rather than a guess about which host is running, so both registries can now stay installed
// forever and no host can be switched off by the other's success.
//
// The window for lines the host gave no id for. Two registries handling one host event start two
// processes at the same moment, so their lines land milliseconds apart; a second is comfortably
// wider than that, and far narrower than the gap between two genuinely repeated `shell` / `stop` /
// `session_end` events, which are the kinds that carry no id.
//
// This path may end up carrying EVERYTHING. Whether Cursor really stamps `tool_use_id` on
// `postToolUse` and `generation_id` on `stop` is unverified — no one has run this against a real
// Cursor install — and if it does not, no line gets an `eid` and every one of them is collapsed by
// content and time alone. The cost of that is bounded and worth naming: two genuinely separate tool
// calls that agree in every recorded field (same tool, same output byte count, same duration) and
// fall inside the same second read as one call, and one of them is not counted. Under-counting a
// repeat is the direction to fail in — the alternative is counting a whole machine's activity twice
// — but it is a real cost, and it goes away the moment an id turns up in the payload.
const DEDUPE_WINDOW_MS = 1000;

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserializable)';
  }
}

// A cheap 64-bit digest of everything on the line except its timestamp — the one field two copies of
// one host event are guaranteed to differ in, because each writer stamps its own `Date.now()`.
//
// Not node:crypto: this runs once per event over windows that reach ~130k lines (see the comment on
// boundsOf for how a machine gets one that size), and the digest is only ever compared with digests
// this same function produced in this same process. It has to be stable and well spread, not secure.
// Two independent 32-bit accumulators rather than one because a single 32-bit hash collides by
// birthday about twice in a 130k window, and a collision here deletes a real event.
function contentKey(event) {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  const feed = (text) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      fnv = Math.imul(fnv ^ code, 0x01000193);
      djb = Math.imul(djb, 33) + code;
    }
  };
  // Sorted, so two writers that emit the same fields in a different order still collapse. The
  // arrays are five or six entries long, which is why this is affordable per event.
  for (const field of Object.keys(event).sort()) {
    if (field === 'ts' || field === 'timestamp') continue;
    const value = event[field];
    feed(field);
    // Separators no field name and no JSON value can contain, so {a:'bc'} and {ab:'c'}
    // cannot digest to the same string.
    feed('\u0001');
    feed(typeof value === 'object' && value !== null ? safeJson(value) : String(value));
    feed('\u0002');
  }
  return `${fnv >>> 0}:${djb >>> 0}`;
}

// Drop the second and later copies of an event, keeping the first.
//
// O(n): one digest and one Map probe per event, no scan back over what has been kept. The window can
// hold ~130k lines and everything else in this file is deliberately linear for the same reason.
//
// The whole line takes part in the key, not the id alone. That is what keeps the eleven `gen` lines
// one generation writes — ten from postToolUse, one from stop — from collapsing onto the first: only
// the turn-end line carries the turn's token counts, and keying on `(ev, eid)` alone would drop the
// one line in the window that knows what the turn cost. Lines that differ in content are different
// facts about the same event and all of them survive; identical lines are copies.
export function dedupeEvents(events, { windowMs = DEDUPE_WINDOW_MS } = {}) {
  const kept = [];
  // content key -> the timestamp of the copy we KEPT. Dropped copies deliberately do not move it
  // forward: a burst of identical lines 900ms apart would otherwise ratchet the window along and
  // swallow an event arriving an hour later.
  const seen = new Map();
  let dropped = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      kept.push(event);
      continue;
    }
    const key = contentKey(event);
    const prior = seen.get(key);
    if (prior !== undefined) {
      // An identified line is a duplicate wherever in the window it turns up: `eid` names one host
      // event, and the rest of the line matches too, so nothing else could have written it.
      //
      // An unidentified one is only assumed to be a copy while it is close enough in time to be the
      // other registry's version of the same moment. `shell`, `stop` and `session_end` have no id to
      // key on, and two identical shell commands a minute apart are two real commands.
      const identified = typeof event.eid === 'string' && event.eid !== '';
      const ts = timestampOf(event);
      if (identified || (ts !== null && prior !== null && Math.abs(ts - prior) <= windowMs)) {
        dropped += 1;
        continue;
      }
    }
    seen.set(key, timestampOf(event));
    kept.push(event);
  }
  return { events: kept, dropped };
}

// ---------------------------------------------------------------------------
// Duplicates across a checkpoint boundary
// ---------------------------------------------------------------------------
//
// dedupeEvents collapses the registries' copies only WITHIN one window. When a checkpoint falls
// between the two copies of one event, the late copy lands in the next window still carrying the
// ORIGINAL timestamp — for a `prompt` line, the gate's start — and as a timing anchor it stretched the
// new window's first active stretch back to that instant. Codex review, MAJOR: 10,000 ms billed, then
// 20,995 ms where 1,000 ms was right.
//
// The copy is recognised by IDENTITY, and only by identity. The previous fix dropped every anchor
// whose timestamp fell inside wall clock earlier checkpoints had covered, and Codex review, MAJOR,
// again: coverage legitimately reaches PAST what the sidecar held at a checkpoint — the CLI subagent
// enrichment dates a worker's end from its chat store's last write, and the checkpoint claims the
// worker's residual — so a genuinely new prompt landing in that stretch was thrown away as a copy,
// and the gap it anchored with it (1 s billed where 15 s of uncovered work had happened). Time says
// nothing about whether a line is a copy; its identity does.
//
// So each window hands the next one the identities of the identified lines it consumed, and the next
// window drops a line whose identity is among them, before anything reads the window.
//
// WHAT the identity is: `contentKey` — the whole line bar its timestamp — and only for a line with a
// non-empty `eid`. That is exactly dedupeEvents' own rule for an identified line ("a duplicate
// wherever in the window it turns up"), extended across the boundary, so a line is dropped here only
// when it would have been dropped had the checkpoint not split the two copies. The bare `eid` is NOT
// enough, because it is not unique per line: one edit call stamps every file it touched with the same
// id, the `mcp_server` side channel shares the tool-call id with the `tool` line of the same call, and
// an edit and the tool line of one call can share `tool_use_id`. A set of bare ids would delete the
// second half of any such pair that straddles a boundary. A line with no `eid` (`shell`, `stop`,
// `session_end`) is never dropped this way: two identical ones a window apart can be two real events,
// and nothing proves otherwise.
//
// `gen` lines are neither carried nor dropped. Their `eid` is the generation id (lib/sidecar-events.mjs
// sets it to `gen_id`), which names a generation rather than a line: one generation writes a `gen`
// line on every postToolUse envelope and one on its stop, and those lines legitimately continue into
// the next window, where their timestamps anchor real time and the turn-end line's token counts are
// merged. A request is already counted once across windows by the generation carry
// (`countedGenerations`). The residual this leaves is named: a late COPY of a `gen` line can still
// anchor backwards, and the host's coverage subtraction (lib/checkpoint.mjs, mainSegmentBilling)
// keeps that from re-billing any covered second — it can only bridge an uncovered gap, which is time
// the unsplit session bills too.
//
// A carried key from an older release that digests differently simply never matches, which is the
// safe direction: nothing is dropped that is not proven a copy.
const isCarriedLine = (event) => event != null && typeof event === 'object'
  && typeof event.eid === 'string' && event.eid !== ''
  && !(typeof event.ev === 'string' && GEN_EVENTS.has(event.ev));

// The window with every proven cross-boundary copy removed. `carried` is the host's persisted list;
// absent, or not an array (a state file written before the carry existed), drops nothing.
function dropCarriedDuplicates(window, carried) {
  if (!Array.isArray(carried) || carried.length === 0) return { events: window, dropped: 0 };
  const known = new Set(carried.filter((key) => typeof key === 'string'));
  if (known.size === 0) return { events: window, dropped: 0 };
  const kept = window.filter((event) => !(isCarriedLine(event) && known.has(contentKey(event))));
  return { events: kept, dropped: window.length - kept.length };
}

// The carry for the next window: the prior one, then this window's identified non-gen lines in
// stream order, de-duplicated and bounded to the newest MAX_CARRIED_EVENT_KEYS — the same shape as
// the generation carry. The host commits it WITH the cursor (lib/checkpoint.mjs), because it names
// lines the cursor has moved past.
function consumedKeysOf(window, carried) {
  const out = [];
  const seen = new Set();
  const push = (key) => {
    if (typeof key !== 'string' || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  if (Array.isArray(carried)) carried.forEach(push);
  for (const event of window) {
    if (isCarriedLine(event)) push(contentKey(event));
  }
  return out.length > MAX_CARRIED_EVENT_KEYS ? out.slice(-MAX_CARRIED_EVENT_KEYS) : out;
}

// The priced increment for every model in the window, taken ONCE against the reported baseline.
//
// Extracted so the unsplit segment and the per-run split cannot disagree about what was priced: the
// increment is a property of the conversation's cumulative `usageData`, not of a range of lines, so
// computing it twice is how a split starts inventing money.
function computePricing(requestsByModel, variantsByModel, usage, priorUsage) {
  const perModel = new Map();
  const leftovers = [];
  if (usage === null) return { perModel, leftovers };

  const pricedSeen = new Set();
  for (const model of requestsByModel.keys()) {
    // The model id and every variant spelling it was run under: Cursor writes one price record per
    // variant, and all of them are this model's spend.
    const knownVariants = variantsByModel.get(model);
    const pricedKeys = matchUsageKeys(usage, [model, ...(knownVariants == null ? [] : knownVariants)]);
    const priced = sumUsage(usage, pricedKeys);
    // Re-matched rather than indexed with the same keys: the baseline is a snapshot of an earlier
    // `usageData`, and a Cursor build that changed a record's capitalisation between the two would
    // otherwise read as a baseline of zero and re-report the whole conversation's overage.
    const prior = sumUsage(priorUsage, matchUsageKeys(priorUsage, pricedKeys));
    perModel.set(model, {
      amount: Math.max(0, priced.amount - prior.amount),
      cents: Math.max(0, priced.costInCents - prior.costInCents),
    });
    for (const key of pricedKeys) pricedSeen.add(key);
  }

  // Priced models with no observed `gen` event in this window - a dropped hook must not drop spend.
  //
  // Bucketed by base id (plan amendment A4). Cursor keys price records by slug, and a slug the window
  // never named would otherwise report as a model of its own: a delayed "kimi-k3-max" record beside
  // the "kimi-k3" row, or the routed slug of an Auto generation, whose rewritten line carries no slug
  // to match on. A leftover whose base id this window billed joins that model's priced increment;
  // the rest are summed into ONE row per base id. The baseline is still looked up by the raw key,
  // because that is the spelling the snapshot stored it under.
  const leftoverByModel = new Map();
  for (const key of Object.keys(usage)) {
    if (requestsByModel.has(key) || pricedSeen.has(key)) continue;
    const prior = sumUsage(priorUsage, matchUsageKeys(priorUsage, [key]));
    const record = usage[key];
    const amount = Math.max(0, num(record == null ? undefined : record.amount) - prior.amount);
    const cents = Math.max(0, num(record == null ? undefined : record.costInCents) - prior.costInCents);
    if (amount <= 0 && cents <= 0) continue;
    const base = baseModelId(key);
    const model = base === null ? key : base;
    const billed = perModel.get(model);
    if (billed !== undefined) {
      billed.amount += amount;
      billed.cents += cents;
      continue;
    }
    const pending = leftoverByModel.get(model);
    if (pending === undefined) {
      leftoverByModel.set(model, { model, amount, cents });
    } else {
      pending.amount += amount;
      pending.cents += cents;
    }
  }
  for (const leftover of leftoverByModel.values()) leftovers.push(leftover);
  return { perModel, leftovers };
}

// One row per (model, pool) for a set of observed requests, in the order the report sends them.
function poolRows(requestsByModel, usage, pricing, tokensByModel) {
  const rows = [];
  for (const [model, requests] of requestsByModel) {
    if (usage === null) {
      rows.push({ model, pool: BILLING_POOL.UNKNOWN, requests, costUsd: 0 });
      continue;
    }
    const priced = pricing.perModel.get(model);
    const amount = priced == null ? 0 : priced.amount;
    const cents = priced == null ? 0 : priced.cents;
    // Cost without a priced count still has to land somewhere: dropping it would lose real money
    // from the credits bucket, which is the one figure this design promises is exact.
    if (amount > 0 || cents > 0) {
      rows.push({ model, pool: BILLING_POOL.CREDITS, requests: amount, costUsd: centsToUsd(cents) });
    }
    // `amount` above the observed request count means we under-counted `gen` events, not that the
    // seat covered a negative number of requests.
    const covered = Math.max(0, requests - amount);
    if (covered > 0) rows.push({ model, pool: BILLING_POOL.SUBSCRIPTION, requests: covered, costUsd: 0 });
  }
  // A model whose tokens landed in this window while its request was counted in an earlier one (the
  // carry above). One zero-request row, so the counts have something to travel on: a report whose
  // `models` cannot account for its own top-level tokens is answered `200 {status:"stored"}` and
  // written nowhere.
  if (tokensByModel != null) {
    for (const model of tokensByModel.keys()) {
      if (requestsByModel.has(model)) continue;
      rows.push({
        model,
        // Unreadable usageData is the `unknown` pool for every row of the window, this one included:
        // presuming a seat covered it is the guess this design never makes.
        pool: usage === null ? BILLING_POOL.UNKNOWN : BILLING_POOL.SUBSCRIPTION,
        requests: 0,
        costUsd: 0,
      });
    }
  }
  for (const leftover of pricing.leftovers) {
    rows.push({
      model: leftover.model,
      pool: BILLING_POOL.CREDITS,
      requests: leftover.amount,
      costUsd: centsToUsd(leftover.cents),
    });
  }
  return rows;
}

// Turn (model, pool) rows into report entries, handing each row its share of the model's tokens.
//
// A model's tokens are exact; which pool paid for them is not a question tokens can answer, since
// the pools split the same requests. Handing each row its share by request count keeps the rows
// summing to the model's real total, and the remainder is given to the row that takes the rest so
// nothing is lost to rounding.
function makeEntries(rows, tokensByModel, requestsByModel) {
  const tokenRemainder = new Map();
  const shareOf = (model, requests) => {
    const total = tokensByModel.get(model);
    if (!total) return {};
    const observedRequests = requestsByModel.get(model);
    const modelRequests = observedRequests == null ? 0 : observedRequests;
    let left = tokenRemainder.get(model);
    if (!left) { left = { ...total }; tokenRemainder.set(model, left); }
    const out = {};
    for (const field of TOKEN_KEYS) {
      if (typeof total[field] !== 'number') continue;
      // `modelRequests <= 0` is the split-only case: a run can hold the line that CARRIED a
      // generation's counts without holding the line that OPENED it, so the model has tokens and no
      // counted request. Its counts go whole to the single row that names it — the alternative is a
      // report whose top-level tokens are real and whose `models` cannot account for any of them,
      // which the ingest service answers with `200 {status:"stored"}` and no row written.
      const share = modelRequests <= 0 || requests >= modelRequests
        ? left[field]
        : Math.min(left[field], Math.round((total[field] * requests) / modelRequests));
      out[field] = share;
      left[field] -= share;
    }
    return out;
  };
  // One entry per (model, pool). The pool used to be appended to a `sourceKey` because the report's
  // `models` was a record keyed by model and the two pools of one model collided in it; the report
  // now carries a LIST, so the pool travels in its own field and the model id stays a model id.
  return rows.map((row) => ({
    model: row.model,
    billing_pool: row.pool,
    requests: row.requests,
    cost_usd: row.costUsd,
    ...shareOf(row.model, row.requests),
  }));
}

// What justifies a BILLED segment, as opposed to a consumed range.
//
// Any of: a model entry (a generation, or priced usage with no generation line in the window - a
// dropped hook is not zero spend), a tool/MCP/file operation, a line changed, or a stretch of active
// wall clock. Deliberately NOT "nonzero tokens": a generation whose token counts this Cursor build
// never reported is still a request that cost money.
//
// Main-segment only. The checkpoint derives subagent segments from the same lines outside this gate,
// so a window whose only content is a ten-minute delegation still reports the worker's time even
// though the parent has nothing of its own to bill.
const OPERATION_KINDS = ['file', 'shell', 'mcp', 'skill', 'search', 'other'];

function reportableWork(entries, operations, codeChanges, activeIntervals, activityCount) {
  if (entries.length > 0) return true;
  // Active wall clock counts only when something in the window WORKED. Two turn ends a minute apart
  // anchor a minute of clock and describe nothing: `stop` says where work finished, never that any
  // happened here.
  if (activeIntervals.length > 0 && activityCount > 0) return true;
  for (const kind of OPERATION_KINDS) {
    const bucket = operations == null ? undefined : operations[kind];
    if (bucket != null && Number.isFinite(bucket.count) && bucket.count > 0) return true;
  }
  if (codeChanges == null) return false;
  return num(codeChanges.files_changed) + num(codeChanges.lines_added) + num(codeChanges.lines_removed) > 0;
}

// The attribution runs, checked against the range they claim to describe, or null.
//
// Refused rather than half-applied: a run list that does not cover exactly [from, to) contiguously
// would silently drop or double a stretch of lines, and a delta that reports fewer requests than it
// billed is worse than one that declines to split at all.
function normalizeRuns(value, from, to) {
  const list = Array.isArray(value) ? value : (value != null && Array.isArray(value.runs) ? value.runs : null);
  if (list === null || list.length === 0) return null;
  let cursor = from;
  for (const run of list) {
    if (run == null || typeof run !== 'object') return null;
    if (!Number.isInteger(run.from) || !Number.isInteger(run.to)) return null;
    // `run.to <= run.from`, not `<`: a ZERO-WIDTH run passes the contiguity check (the cursor
    // advances past it and still lands on `to`) but describes no part of the conversation, and the
    // segment built from it would carry a repo/branch attribution with every counter at zero.
    // `planAttributionRuns` cannot emit one; this refuses it anyway, because the cost of the guard
    // is a comparison and the cost of its absence is an invented segment in someone's dashboard.
    if (run.from !== cursor || run.to <= run.from) return null;
    cursor = run.to;
  }
  if (cursor !== to) return null;
  return list;
}

// The part of `intervals` inside [lo, hi). Clipping rather than rebuilding is what keeps the union
// exact: an active stretch that straddles a run boundary is cut in two and both halves are billed
// once, where rebuilding each run's intervals from its own anchors would lose the straddling gap
// from both sides.
function clipIntervals(intervals, lo, hi) {
  const out = [];
  for (const [start, end] of intervals) {
    const s = Math.max(start, lo);
    const e = Math.min(end, hi);
    if (e > s) out.push([s, e]);
  }
  return out;
}

// Split one window's arithmetic along the repo/branch runs the attribution planner produced.
//
// THE RULES, each chosen so that re-summing the segments reproduces the unsplit totals exactly:
//   requests        a generation is one request, counted in the run holding the line that OPENED it
//                   (the same line the unsplit pass counts), never once per line.
//   tokens          a generation's merged counts go WHOLE to the run of its final token-bearing
//                   line. Cursor sends the counts on the turn-end line, which can land in a
//                   different run than the line that opened the generation.
//   priced overage  whole, to the run containing the last generation of that model (the final run
//                   when the window holds none). Cents do not divide: pro-rating money across runs
//                   rounds, and a rounded split of a cumulative figure drifts every checkpoint.
//   operations,
//   code changes    to the run of the event they were derived from. The per-run code changes are
//                   EVENT-DERIVED: the unsplit figure may come from Cursor's tracking database
//                   (which is queried by time, not by line), so a caller that emits per-run segments
//                   must take every code-change figure from the segments and never mix the two.
//   duration        the window's active intervals, clipped at run boundaries. The boundary is the
//                   first activity anchor of the next run.
function buildRunSegments(params) {
  const runs = params.runs;
  const window = params.window;
  const absIndexOf = params.absIndexOf;
  const usage = params.usage;
  const pricing = params.pricing;

  const runOf = (index) => {
    for (let k = 0; k < runs.length; k++) {
      if (index >= runs[k].from && index < runs[k].to) return k;
    }
    return -1;
  };

  const perRun = runs.map(() => ({
    events: [],
    requestsByModel: new Map(),
    tokensByModel: new Map(),
    genBuckets: new Map(),
    credits: new Map(),
    costFor: new Set(),
    firstAnchor: Infinity,
    lastAnchor: -Infinity,
    activityCount: 0,
  }));

  for (const event of window) {
    const index = absIndexOf.get(event);
    if (index === undefined) continue;
    const k = runOf(index);
    if (k < 0) continue;
    perRun[k].events.push(event);
    const ev = event == null ? undefined : event.ev;
    const ts = timestampOf(event);
    // The same set the window's intervals were built from, or a run's cut would not line up with
    // the intervals it is clipping.
    if (ts !== null && typeof ev === 'string' && TIMING_ANCHOR_EVENTS.has(ev)) {
      if (ts < perRun[k].firstAnchor) perRun[k].firstAnchor = ts;
      if (ts > perRun[k].lastAnchor) perRun[k].lastAnchor = ts;
    }
    if (typeof ev === 'string' && ACTIVITY_EVENTS.has(ev)) perRun[k].activityCount += 1;
  }

  // Requests and tokens, from the trace the counting pass recorded.
  const lastGenRun = new Map();
  const tokenRunOfKey = new Map();
  for (const line of params.genTrace) {
    const k = runOf(line.idx);
    if (k < 0) continue;
    if (line.counted) {
      const prior = perRun[k].requestsByModel.get(line.model);
      perRun[k].requestsByModel.set(line.model, (prior == null ? 0 : prior) + 1);
    }
    if (line.tokens) tokenRunOfKey.set(line.key, k);
    lastGenRun.set(line.model, k);
  }
  for (const [key, bucket] of params.tokensByGeneration) {
    const k = tokenRunOfKey.get(key);
    if (k === undefined) continue;
    perRun[k].genBuckets.set(key, bucket);
    const model = modelOfGenKey(key);
    const existing = perRun[k].tokensByModel.get(model);
    const into = existing == null ? {} : existing;
    for (const field of TOKEN_KEYS) {
      if (typeof bucket[field] === 'number') {
        const prior = into[field];
        into[field] = (prior == null ? 0 : prior) + bucket[field];
      }
    }
    perRun[k].tokensByModel.set(model, into);
  }

  // The priced count, claimed run by run so the parts sum to the whole.
  if (usage !== null) {
    for (const [model, priced] of pricing.perModel) {
      if (priced.amount <= 0 && priced.cents <= 0) continue;
      const known = lastGenRun.get(model);
      const overage = known === undefined ? runs.length - 1 : known;
      perRun[overage].costFor.add(model);
      // The overage run first, then backwards, then forwards: the priced requests belong as close as
      // possible to the spend they paid for, and the order is a property of the data rather than of
      // iteration.
      const order = [overage];
      for (let k = overage - 1; k >= 0; k--) order.push(k);
      for (let k = overage + 1; k < runs.length; k++) order.push(k);
      let left = priced.amount;
      for (const k of order) {
        if (left <= 0) break;
        const observed = perRun[k].requestsByModel.get(model);
        const take = Math.min(left, observed == null ? 0 : observed);
        if (take <= 0) continue;
        perRun[k].credits.set(model, take);
        left -= take;
      }
      // Cursor priced more requests than we saw `gen` lines for. The remainder still has to be
      // reported, and the run that owns the spend is where it belongs.
      if (left > 0) {
        const prior = perRun[overage].credits.get(model);
        perRun[overage].credits.set(model, (prior == null ? 0 : prior) + left);
      }
    }
  }

  // Boundaries: the first anchor at or after each run, so the cuts are nondecreasing even when a run
  // holds no activity of its own.
  const cuts = new Array(runs.length);
  let suffix = Infinity;
  for (let k = runs.length - 1; k >= 0; k--) {
    suffix = Math.min(suffix, perRun[k].firstAnchor);
    cuts[k] = suffix;
  }

  return runs.map((run, k) => {
    const state = perRun[k];
    const rows = [];
    // Three ways a model belongs to this run: it opened a generation here (a request), it was handed
    // part of the priced count here, or its tokens landed here. The third is easy to miss and is the
    // one that silently drops a turn's counts — a generation's opening line and its token-bearing
    // line can be in different runs.
    const models = new Set([
      ...state.requestsByModel.keys(),
      ...state.credits.keys(),
      ...state.tokensByModel.keys(),
    ]);
    for (const model of models) {
      const observed = state.requestsByModel.get(model);
      const requests = observed == null ? 0 : observed;
      if (usage === null) {
        // Unreadable usageData is the `unknown` pool for every row of this window, zero-request ones
        // included — presuming a seat covered them is the one guess this design never makes.
        rows.push({ model, pool: BILLING_POOL.UNKNOWN, requests, costUsd: 0 });
        continue;
      }
      const claimed = state.credits.get(model);
      const credits = claimed == null ? 0 : claimed;
      const priced = pricing.perModel.get(model);
      const costUsd = state.costFor.has(model) && priced != null ? centsToUsd(priced.cents) : 0;
      if (credits > 0 || costUsd > 0) {
        rows.push({ model, pool: BILLING_POOL.CREDITS, requests: credits, costUsd });
      }
      const covered = Math.max(0, requests - credits);
      if (covered > 0) rows.push({ model, pool: BILLING_POOL.SUBSCRIPTION, requests: covered, costUsd: 0 });
      // Tokens with nothing to ride on: one zero-request row so the counts reach the report. The
      // pool is the one the UNSPLIT delta already used for this model, never a new one — a split
      // must not invent a (model, pool) pair the whole window does not have.
      if (credits === 0 && costUsd === 0 && covered === 0 && state.tokensByModel.has(model)) {
        rows.push({ model, pool: params.poolOfModel(model), requests: 0, costUsd: 0 });
      }
    }
    // Spend for a model with no generation anywhere in the window belongs to the final run — there
    // is no line to attribute it to, and dropping it would lose real money.
    if (k === runs.length - 1) {
      for (const leftover of pricing.leftovers) {
        rows.push({
          model: leftover.model,
          pool: BILLING_POOL.CREDITS,
          requests: leftover.amount,
          costUsd: centsToUsd(leftover.cents),
        });
      }
    }

    const entries = makeEntries(rows, state.tokensByModel, state.requestsByModel);
    const operations = computeOperations(state.events, { mcpAliases: params.resolvers.mcpAliases });
    const est_tokens = totalEstTokens(operations);
    let code_changes;
    try {
      // Deliberately no `window`: a per-run figure has to be derived from the run's own lines, and
      // the tracking database is queried by time for the whole segment.
      code_changes = params.codeChangesImpl(state.events, { ...params.resolvers, window: null });
    } catch {
      code_changes = { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} };
    }
    const lo = k === 0 ? -Infinity : cuts[k];
    const hi = k === runs.length - 1 ? Infinity : cuts[k + 1];
    const activeIntervals = clipIntervals(params.activeIntervals, lo, hi);
    const durationMs = totalMs(activeIntervals);
    entries.forEach((entry, index) => {
      entry.duration_ms = index === 0 ? durationMs : 0;
      entry.code_changes = index === 0 ? code_changes : null;
    });

    return {
      segmentId: `${params.conversationId}:${run.from}-${run.to}`,
      from: run.from,
      to: run.to,
      repoRoot: run.repoRoot === undefined ? null : run.repoRoot,
      branch: run.branch === undefined ? '(unknown)' : run.branch,
      entries,
      tokens: sumTokens(state.genBuckets),
      operations,
      est_tokens,
      code_changes,
      duration_ms: durationMs,
      duration_sec: Math.round(durationMs / 1000),
      activeIntervals,
      started_at: state.firstAnchor === Infinity ? null : new Date(state.firstAnchor).toISOString(),
      ended_at: state.lastAnchor === -Infinity ? null : new Date(state.lastAnchor).toISOString(),
      hasReportableWork: reportableWork(entries, operations, code_changes, activeIntervals, state.activityCount),
    };
  });
}

// `resolvers.priorUsage` is the usageData snapshot this conversation reported last time.
// composerData.usageData is CUMULATIVE per conversation, not per segment, so without a baseline
// every checkpoint would re-bill the whole conversation's overage under a fresh sourceRef. Same
// increment model the Codex engine uses for its cumulative token totals.
export function computeDelta(conversationId, fromLine, resolvers = {}) {
  // A caller that supplies `readEvents` is asking for the whole stream and gets it — that seam
  // predates the resume path and stays authoritative when present.
  const readEventsFromImpl = resolvers.readEventsFrom == null ? ((id, start) => {
    if (typeof resolvers.readEvents === 'function') {
      return { events: resolvers.readEvents(id), baseLine: 0, nextByte: null, resumed: false };
    }
    return readEventsFrom(id, start, resolvers);
  }) : resolvers.readEventsFrom;
  const readUsageDataImpl =
    resolvers.readUsageData == null ? ((id) => _readUsageData(id, resolvers)) : resolvers.readUsageData;
  const codeChangesImpl =
    resolvers.computeCodeChanges == null ? computeCodeChanges : resolvers.computeCodeChanges;
  const repoRootOf = resolvers.repoRootOf == null ? ((dir) => dir) : resolvers.repoRootOf;
  const branchAt = resolvers.branchAt == null ? null : resolvers.branchAt;

  // Three ways in, in cost order:
  //
  //   events   the caller already parsed the whole sidecar and is sharing it. `stop` needs the full
  //            stream anyway for the session timeline, so it reads once and both consumers use it
  //            instead of parsing the same file twice in one hook.
  //   start    resume from a byte offset recorded last time — the common path, and the only one
  //            whose cost is proportional to NEW activity rather than to the whole conversation.
  //   neither  full read, as before.
  //
  // `baseLine` is the absolute event index the array begins at, so segment bounds stay absolute and
  // a resumed read produces exactly the segmentId a full read would have.
  let events;
  let baseLine = 0;
  let nextByte = null;
  if (Array.isArray(resolvers.events)) {
    events = resolvers.events;
  } else if (resolvers.start && Number.isFinite(resolvers.start.byte) && resolvers.start.byte > 0) {
    try {
      const read = readEventsFromImpl(conversationId, resolvers.start);
      events = read.events;
      baseLine = read.resumed ? read.baseLine : 0;
      nextByte = read.nextByte;
    } catch {
      events = [];
    }
  } else {
    try {
      const read = readEventsFromImpl(conversationId, null);
      events = read.events;
      nextByte = read.nextByte;
    } catch {
      events = [];
    }
  }
  if (!Array.isArray(events)) events = [];

  const to = baseLine + events.length;
  const requested = Number.isFinite(fromLine) ? Math.trunc(fromLine) : 0;
  const from = Math.max(baseLine, Math.min(requested, to));
  const segmentId = `${conversationId}:${from}-${to}`;

  // Collapse the copies BEFORE anything counts them: requests, operations, est_tokens, code changes
  // and the active-duration gaps are all derived from this array, and a line recorded twice inflates
  // every one of them.
  //
  // The segment bounds above are deliberately NOT deduped. `from`/`to` index raw sidecar lines, and
  // the server's idempotency contract is that a segmentId names a range of the log — not a count of
  // what survived analysis. Dropping a duplicate must never move the cursor, or a re-read of the
  // same range would produce a different segmentId and the same work would report twice.
  const rawWindow = events.slice(from - baseLine, to - baseLine);
  // Absolute line index per event object, captured BEFORE the collapse. Attribution runs index raw
  // sidecar lines while the analysis runs over the deduplicated array, so position-in-window is not
  // a line number; `dedupeEvents` keeps the surviving objects by reference, which is what makes this
  // lookup exact. Built only when a split was asked for — it is one Map entry per line otherwise.
  // Attribution runs, either handed in whole or planned here from the window's own lines.
  //
  // The planner needs `{index, event}` pairs against ABSOLUTE line numbers, and this is the only
  // place they exist: the frequent (non-turn-end) checkpoint path never materialises an event array
  // of its own, so a caller outside this function has nothing to index. `resolvers.planRuns` is
  // therefore a seam rather than a pre-computed input - the repo lane's `planAttributionRuns` drops
  // straight into it, and the integration owner supplies `previous` from session state.
  let runs = normalizeRuns(resolvers.attributionRuns, from, to);
  let nextAttribution;
  if (runs === null && typeof resolvers.planRuns === 'function') {
    try {
      const indexedEvents = [];
      for (let i = 0; i < rawWindow.length; i++) {
        indexedEvents.push({ index: from + i, event: rawWindow[i] });
      }
      const planned = resolvers.planRuns(indexedEvents, {
        from,
        to,
        cwd: resolvers.cwd,
        repoRootOf,
        branchAt,
        previous: resolvers.previousAttribution == null ? null : resolvers.previousAttribution,
      });
      runs = normalizeRuns(planned, from, to);
      if (runs !== null && planned != null && !Array.isArray(planned)) {
        nextAttribution = planned.nextAttribution;
      }
    } catch {
      // A planner that throws costs the SPLIT, never the segment: the unsplit window is still
      // complete and correct, which is the whole reason `segments` is optional.
      runs = null;
    }
  }
  const absIndexOf = runs === null ? null : new Map();
  if (absIndexOf !== null) {
    for (let i = 0; i < rawWindow.length; i++) {
      const event = rawWindow[i];
      if (event !== null && typeof event === 'object' && !absIndexOf.has(event)) {
        absIndexOf.set(event, from + i);
      }
    }
  }
  const { events: deduped, dropped: duplicateEvents } = dedupeEvents(rawWindow);
  // Then the copies whose originals an EARLIER window consumed (see dropCarriedDuplicates). Before
  // anything reads the window — the clock, operations, code changes and the run split alike — so a
  // copy counts nowhere. `from`/`to` and `absIndexOf` still name the raw lines this call read.
  const { events: window, dropped: carriedDuplicateEvents } = dropCarriedDuplicates(deduped, resolvers.consumedEventKeys);

  const requestsByModel = new Map();
  // model id -> every variant spelling seen for it in this window, so the cost split can find the
  // per-variant price records Cursor wrote for a model that was run at more than one setting.
  const variantsByModel = new Map();
  const seenGenerations = new Set();
  // The ids behind `seenGenerations`: whether a line is a repeat is a question about the generation,
  // not about which model a line of it happened to name.
  const seenGenIds = new Set();
  // Generations the CALLER says were already billed a request in an earlier window. Absent (null) is
  // the pre-existing behaviour: every window counts for itself.
  //
  // Decided on the generation id ALONE. The model half of a carried key is whatever an earlier window
  // resolved, and a mid-turn pulse can see only a generation's `default` lines while the next window
  // sees its turn-end line with the real slug: comparing whole keys billed that turn twice. A carried
  // id that reappears under another model merges its tokens there with zero requests (poolRows gives
  // them a zero-request row). Keys from the previous release hold the raw slug; only their id half is
  // read here, so they are honoured as they are.
  const carriedIds = Array.isArray(resolvers.countedGenerations) ? new Set() : null;
  // id -> the concrete model an earlier window billed it under. What a placeholder line of a carried
  // generation resolves to, ahead of a second look at the CLI store: the store may have grown past
  // the scan caps, or gained a reply routed elsewhere, since the pulse that billed it — and one
  // generation must resolve the same in every window.
  const carriedModelOfId = new Map();
  if (carriedIds !== null) {
    for (const key of resolvers.countedGenerations) {
      if (typeof key !== 'string') continue;
      const cut = key.indexOf(GEN_KEY_SEP);
      if (cut < 0) continue;
      const id = key.slice(cut + 1);
      carriedIds.add(id);
      const carriedModel = baseModelId(key.slice(0, cut));
      if (carriedModel !== null && carriedModel !== UNKNOWN_MODEL && !isPlaceholderModel(carriedModel)) {
        carriedModelOfId.set(id, carriedModel);
      }
    }
  }
  // One generation, one model. The CLI stamps the same generation with `default` on some lines and a
  // concrete slug on others (plan evidence E2/E3), and every spelling used to be its own request. A
  // placeholder line is REWRITTEN to the concrete model another line of its generation named.
  const concreteModelOfGen = new Map();
  for (const event of window) {
    if (event == null || typeof event.ev !== 'string' || !GEN_EVENTS.has(event.ev)) continue;
    const id = genIdOf(event);
    const raw = pickString(event, MODEL_FIELDS);
    if (id === null || raw === null || concreteModelOfGen.has(id)) continue;
    // Tested on the base id, as the main loop does, so the two passes agree on what a placeholder is.
    const base = baseModelId(raw);
    if (base !== null && !isPlaceholderModel(base)) concreteModelOfGen.set(id, base);
  }
  // The CLI store's answer for Auto, asked at most once per window and only when a placeholder
  // survives everything above: the blob scan is the expensive part, and most windows never need it.
  let autoModel;
  const autoModelOnce = () => {
    if (autoModel !== undefined) return autoModel;
    try {
      autoModel = resolveAutoModel(conversationId, resolvers);
    } catch {
      autoModel = null;
    }
    return autoModel;
  };
  // Generations left as `default` because nothing could name them. Diagnostics only: the portal
  // still sees the `default` row, and the count says how often Auto went unresolved.
  const unresolvedGenIds = new Set();
  let unresolvedAnonymous = 0;
  // Identified generation keys this window saw, in order, to hand back for the next one. Anonymous
  // keys are deliberately NOT carried: `#0` means "the first generation in THIS window", and
  // carrying it would suppress an unrelated generation next time.
  const identifiedGenerations = [];
  const tokensByGeneration = new Map();
  // Every generation line, with the absolute line it sat on — the input the run split needs and the
  // unsplit path never looks at. Null (and unbuilt) when no split was asked for.
  const genTrace = runs === null ? null : [];
  let anonymousGen = 0;
  // TWO clocks, deliberately, and they answer different questions.
  //
  //   timestamps      timing anchors: activity AND turn ends. The segment's own span, its active
  //                   intervals and therefore its billed duration. Only the session lifecycle is
  //                   excluded, because only it describes no work of its own.
  //   allTimestamps   every timestamped line, markers included. The range handed to the code-changes
  //                   database query and to `branchAt`. Cursor writes an edit row when the file is
  //                   SAVED, which can be after the last `gen` line and before the trailing
  //                   `session_end`; narrowing the query to the anchor bound would silently drop
  //                   those line counts, which is a regression dressed up as a fix.
  //
  // `activityCount` is a third thing again: how many of the anchors were WORK. It is what stops a
  // window of bare turn ends from claiming a billable span.
  const timestamps = [];
  const allTimestamps = [];
  let activityCount = 0;
  let recognized = 0;
  const unrecognized = new Set();

  for (const event of window) {
    const ts = timestampOf(event);
    const ev = event == null ? undefined : event.ev;
    if (ts !== null) {
      allTimestamps.push(ts);
      if (typeof ev === 'string' && TIMING_ANCHOR_EVENTS.has(ev)) timestamps.push(ts);
    }
    if (typeof ev === 'string' && ACTIVITY_EVENTS.has(ev)) activityCount += 1;
    if (typeof ev === 'string' && KNOWN_EVENTS.has(ev)) recognized += 1;
    else if (typeof ev === 'string') unrecognized.add(ev);
    else unrecognized.add('(missing ev)');

    if (typeof ev !== 'string' || !GEN_EVENTS.has(ev)) continue;
    const genId = genIdOf(event);
    const pickedModel = pickString(event, MODEL_FIELDS);
    // The base id, applied again at read time so sidecars written before the writer did it (and IDE
    // builds that send no model_id, E4) collapse the same way.
    const pickedBase = pickedModel == null ? null : baseModelId(pickedModel);
    let model = pickedBase === null ? UNKNOWN_MODEL : pickedBase;
    if (isPlaceholderModel(model)) {
      // R3 step 1, this window and then earlier ones; after that, the CLI store.
      if (genId !== null && concreteModelOfGen.has(genId)) {
        model = concreteModelOfGen.get(genId);
      } else if (genId !== null && carriedModelOfId.has(genId)) {
        model = carriedModelOfId.get(genId);
      } else {
        const auto = autoModelOnce();
        if (auto !== null) model = auto;
        else if (genId !== null) unresolvedGenIds.add(genId);
        else unresolvedAnonymous += 1;
      }
    }
    // Filled only AFTER resolution, and never with a placeholder (plan amendment A4): a `default`
    // variant would pull a `default` price record into whatever model the line resolved to. The raw
    // slug stands in for a missing `model_variant`, because usageData prices per slug and a
    // slug-only line would otherwise leave its price record unmatched.
    const pickedVariant = pickString(event, VARIANT_FIELDS);
    const variant = pickedVariant !== null ? pickedVariant : pickedModel;
    if (variant !== null && variant !== model && !isPlaceholderModel(baseModelId(variant))) {
      const known = variantsByModel.get(model);
      const variants = known == null ? new Set() : known;
      variants.add(variant);
      variantsByModel.set(model, variants);
    }

    // Cursor stamps model and generation_id on the common hook envelope, so ONE generation that
    // makes ten tool calls writes eleven `gen` lines — ten from postToolUse and one from stop.
    // Counting lines would report eleven requests for one, and inflate the seat-covered bucket by
    // the difference against `usageData.amount`. Collapse on the id; a line without one (an older
    // sidecar, or an event Cursor did not stamp) is still counted on its own, which is the
    // pre-existing behaviour.
    // A line without an id is its own generation — that is the pre-existing behaviour, and the
    // counter runs in stream order so the keys are stable between this pass and any re-read.
    const key = genId === null ? genKey(model, `#${anonymousGen++}`) : genKey(model, genId);
    // A later line for the same generation may be the one carrying the token counts: `stop` has
    // them, `postToolUse` does not. It is merged, but it is not a second request. Keyed on the id,
    // like the carry below; the tokens still merge into the line's own (model, id) bucket.
    //
    // In print mode (`agent -p`) generation_id IS the conversation id (E7), so every turn of a
    // headless session shares one id and bills as one request. That is a host limitation (no
    // per-turn id), recorded in the plan rather than papered over with the model half of the key.
    const repeat = genId !== null && seenGenIds.has(genId);
    if (genId !== null) {
      seenGenIds.add(genId);
      if (!seenGenerations.has(key)) identifiedGenerations.push(key);
      seenGenerations.add(key);
    }
    // Already billed in an earlier window: merge whatever counts this line carries, count no second
    // request. The model can then end this window with tokens and zero requests, which `poolRows`
    // answers with a zero-request row rather than dropping the counts.
    const alreadyBilled = genId !== null && carriedIds !== null && carriedIds.has(genId);
    mergeTokens(tokensByGeneration, key, event);
    if (genTrace !== null) {
      genTrace.push({
        key,
        model,
        idx: absIndexOf.get(event),
        counted: !repeat && !alreadyBilled,
        tokens: hasTokenCounts(event),
      });
    }
    if (repeat || alreadyBilled) continue;
    const priorRequests = requestsByModel.get(model);
    requestsByModel.set(model, (priorRequests == null ? 0 : priorRequests) + 1);
  }

  const tokenTotals = sumTokens(tokensByGeneration);
  // Per model as well as per segment. A generation belongs to exactly one model, so this split is
  // exact — unlike the pool split below, which divides the same requests two ways.
  const tokensByModel = new Map();
  for (const [key, bucket] of tokensByGeneration) {
    const model = modelOfGenKey(key);
    const existing = tokensByModel.get(model);
    const into = existing == null ? {} : existing;
    for (const field of TOKEN_KEYS) {
      if (typeof bucket[field] === 'number') {
        const prior = into[field];
        into[field] = (prior == null ? 0 : prior) + bucket[field];
      }
    }
    tokensByModel.set(model, into);
  }

  // null here is load-bearing — it is the ONLY thing that produces the 'unknown' pool.
  let usage = null;
  try {
    usage = readUsageDataImpl(conversationId);
  } catch {
    usage = null;
  }
  if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage))) usage = null;
  const priorUsage =
    resolvers.priorUsage && typeof resolvers.priorUsage === 'object' ? resolvers.priorUsage : null;

  const activeIntervals = activeIntervalsOf(timestamps);
  const durationMs = totalMs(activeIntervals);
  // The alias LRU the host carried over from the last window. `beforeMCPExecution` fires before the
  // call and `postToolUse` after it, so the `mcp_server` line naming a server can land in window N
  // while the `tool` line it names lands in N+1 — and the FIRST call to every server is the one most
  // likely to straddle a boundary, so the miss is systematic rather than random. Passing the carry
  // through is the whole of the fix on this side; lib/checkpoint.mjs owns the persistence, and
  // `operations.mcpAliases` (non-enumerable, so `JSON.stringify` cannot leak it onto the wire) is
  // what it stores back.
  const operations = computeOperations(window, { mcpAliases: resolvers.mcpAliases });
  const est_tokens = totalEstTokens(operations);
  // One pass, not `Math.min(...timestamps)`: a spread passes every element as an argument, and a
  // window big enough to overflow the argument limit throws RangeError instead of returning a
  // number. runCheckpoint catches that and returns without advancing the cursor, so the window
  // only ever grows — the conversation reports nothing again, permanently and silently. A machine
  // that ran unlinked for a while reaches that size on its first checkpoint after signing in
  // (~130k events on this Node).
  const { startedMs, endedMs } = boundsOf(timestamps);
  // The wider bound — see the note where `allTimestamps` is filled.
  const { startedMs: rawStartedMs, endedMs: rawEndedMs } = boundsOf(allTimestamps);
  let code_changes;
  try {
    code_changes = codeChangesImpl(window, {
      ...resolvers,
      ...(rawStartedMs !== null && rawEndedMs !== null
        ? { window: { startMs: rawStartedMs, endMs: rawEndedMs } }
        : {}),
    });
  } catch {
    // Enrichment: losing the line counts must not lose the segment's requests and cost.
    code_changes = { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} };
  }

  const pricing = computePricing(requestsByModel, variantsByModel, usage, priorUsage);
  const entries = makeEntries(
    poolRows(requestsByModel, usage, pricing, tokensByModel),
    tokensByModel,
    requestsByModel,
  );
  // What the next window needs to know, bounded. The caller persists it and hands it back as
  // `resolvers.countedGenerations`; a caller that ignores it gets exactly today's behaviour.
  const countedGenerations = (function () {
    const out = [];
    const seen = new Set();
    const prior = Array.isArray(resolvers.countedGenerations) ? resolvers.countedGenerations : [];
    for (const raw of prior.concat(identifiedGenerations)) {
      if (typeof raw !== 'string') continue;
      const key = normalizeCarriedKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out.length > MAX_CARRIED_GENERATIONS ? out.slice(-MAX_CARRIED_GENERATIONS) : out;
  }());

  // Duration and code_changes belong to the segment, not to a model — the server stamps them on the
  // first row only so SUM() per session stays correct. Mirror that here so whichever entry the host
  // sends first is the one that carries them.
  entries.forEach((entry, index) => {
    entry.duration_ms = index === 0 ? durationMs : 0;
    entry.code_changes = index === 0 ? code_changes : null;
  });

  // Both resolvers shell out to git. A blocked or dubious-ownership repo must cost the attribution,
  // not the segment — the host would otherwise drop the whole window on the throw.
  let repoRoot = null;
  try {
    if (resolvers.cwd) {
      const resolvedRoot = repoRootOf(resolvers.cwd);
      repoRoot = resolvedRoot == null ? null : resolvedRoot;
    }
  } catch {
    repoRoot = null;
  }
  let branch = '(unknown)';
  try {
    if (branchAt) {
      // The window's last line, marker or not: this asks "which branch was checked out when this
      // window ended", and a shutdown marker is as good an answer to that as a tool call.
      const resolvedBranch = branchAt(repoRoot, rawEndedMs);
      branch = resolvedBranch == null ? '(unknown)' : resolvedBranch;
    }
  } catch {
    branch = '(unknown)';
  }

  // Optional, and only ever additive: the unsplit segment above is byte-identical with or without
  // it. A caller that emits per-run payloads takes every figure from here; one that does not sees
  // no change at all.
  // The pool the unsplit segment gave each model, so a run that holds only a model's tokens can name
  // the same pool rather than inventing one.
  const poolOfModel = (model) => {
    for (const entry of entries) {
      if (entry.model === model) return entry.billing_pool;
    }
    return BILLING_POOL.UNKNOWN;
  };
  const segments = runs === null ? null : buildRunSegments({
    conversationId,
    poolOfModel,
    runs,
    window,
    absIndexOf,
    genTrace,
    tokensByGeneration,
    usage,
    pricing,
    activeIntervals,
    codeChangesImpl,
    resolvers,
  });

  return {
    conversationId,
    segmentId,
    from,
    to,
    ...(segments === null ? {} : { segments }),
    // The planner's carry-forward state, when one planned these runs. The host persists it and hands
    // it back as `resolvers.previousAttribution`; absent when no planner ran.
    ...(nextAttribution === undefined ? {} : { nextAttribution }),
    from_line: from,
    to_line: to,
    // The raw lines this call READ. Identical to from/to today and kept as its own field because it
    // answers a different question: `consumed` may always advance, while `from`/`to` name the range
    // a segment would be billed for. A marker-only window consumes its lines and bills nothing.
    consumed: { from, to },
    // MUST be persisted by the host and handed back as `resolvers.countedGenerations` next window,
    // or a generation whose lines straddle the boundary is billed as two requests.
    countedGenerations,
    // MUST be persisted by the host WITH the cursor and handed back as `resolvers.consumedEventKeys`
    // next window, or a late registry copy that crosses the boundary anchors that window back over
    // time already billed (see dropCarriedDuplicates). Bounded at MAX_CARRIED_EVENT_KEYS.
    consumedEventKeys: consumedKeysOf(window, resolvers.consumedEventKeys),
    hasReportableWork: reportableWork(entries, operations, code_changes, activeIntervals, activityCount),
    // Derived from timing anchors only; `count` is how many of them anchored the clock,
    // and the two bounds are the same instants `started_at`/`ended_at` carry. Session markers are
    // absent from all three by construction — they remain available to the timeline, which reads the
    // event stream itself.
    timingAnchors: { count: timestamps.length, startedMs, endedMs },
    // The caller persists this as the next call's `fromLine`.
    nextCursor: to,
    // Where the next read can resume from. Null when this read could not establish one (a shared
    // array, or a stubbed reader), in which case the host simply keeps whatever it had.
    nextByte,
    // { token_input, token_output, token_cache_read, token_cache_write } summed over the distinct
    // generations in this window, or null when nothing in it reported any.
    tokens: tokenTotals,
    repoRoot,
    branch,
    entries,
    // Cursor exposes no local rate-limit signal today. The key exists so the host's report loop has
    // something to iterate without a shape check, and so a delta that learns to emit one needs no
    // change on the consuming side.
    rateLimitEvents: [],
    operations,
    est_tokens,
    code_changes,
    duration_ms: durationMs,
    duration_sec: Math.round(durationMs / 1000),
    // The same figure as `duration_ms`, kept as [startMs, endMs) pairs. The host claims these as
    // COVERED wall clock once the segment is queued, so every subagent segment that follows bills
    // only the part no earlier segment took. A caller that ignores it gets exactly the old scalar
    // behaviour, which is what the injected computeDelta doubles in the tests rely on.
    activeIntervals,
    started_at: startedMs === null ? null : new Date(startedMs).toISOString(),
    ended_at: endedMs === null ? null : new Date(endedMs).toISOString(),
    // MUST be persisted by the host and handed back as `resolvers.priorUsage` on the next call.
    // composerData.usageData is cumulative for the whole conversation while every checkpoint gets a
    // fresh segmentId — so without this baseline the same overage is re-reported under a new
    // sourceRef on every turn and the credits bucket compounds. Stays null when usageData was
    // unreadable, so the baseline never advances past spend we failed to observe.
    usage_snapshot: usage,
    diagnostics: {
      // What was analysed, after duplicate collapse — `to - from` is what the range held. The two
      // differing is the normal, healthy state on a machine that has both hook registries
      // installed, which is now every machine; it is only worth looking at when the ratio is not
      // roughly one duplicate per event.
      windowEvents: window.length,
      duplicateEvents,
      // Late copies dropped because an EARLIER window consumed their originals (dropCarriedDuplicates).
      // Counted apart from `duplicateEvents`, which is the within-window collapse.
      carriedDuplicateEvents,
      recognizedEvents: recognized,
      unrecognizedEvents: [...unrecognized],
      // A window full of events none of which we understand is a writer/reader schema mismatch. It
      // reports as zero activity, which is invisible in production unless it is said out loud.
      schemaMiss: window.length > 0 && recognized === 0,
      usageRead: usage !== null,
      // Generations that stayed `default` because neither the sidecar nor the CLI store could name
      // the model Auto routed them to (R3). Here and never on an entry: the report's schema has no
      // such key, and an unknown key 400s the report.
      unresolvedAuto: unresolvedGenIds.size + unresolvedAnonymous,
      operations: operations.diagnostics,
      code_changes: code_changes == null || code_changes.diagnostics == null
        ? null
        : code_changes.diagnostics,
    },
  };
}
