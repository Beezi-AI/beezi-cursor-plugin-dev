import { readEvents } from './sidecar-read.mjs';
import { correlateSubagents, subagentIntervals, timestampOf } from './subagents-cursor.mjs';
import { withCliSubagents } from './cli-subagents-cursor.mjs';
import { countCliTurnStarts } from './cli-chats-cursor.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import * as hostDelta from './delta-cursor.mjs';
import * as hostTiming from './timing.mjs';
import * as hostConfig from './config.mjs';
import * as hostHttp from './http.mjs';

// Whole-session activity timeline for a Cursor conversation, derived from the sidecar. Same output
// contract as the Claude and Codex engines ({ periods, plan_events, subagents, started_at, ended_at,
// generated_at }), so the server upsert is unchanged.
//
// `plan_events` is ALWAYS empty: Cursor has no plan permission mode and no update_plan tool, so
// there is nothing to derive.
//
// `subagents` is derived from the sidecar's `subagent_start` / `subagent_stop` lines — see
// lib/subagents-cursor.mjs for the correlation and its failure modes. It is NOT derived from
// sub-transcripts the way the Claude engine's is: `agent_transcript_path` is always null in Cursor
// (a confirmed host bug) and no sub-transcript exists anywhere on disk, so the hook events are the
// only evidence a subagent ever ran. Five shipped portal surfaces read this array — the Tool
// Attribution tree, the tokens-by-mode bar, the Session detail Subagents card, the Overview
// "Tokens by Subagent" panel and this timeline's own gantt lanes. The one exception is the Cursor
// CLI, which fires no subagent hooks at all: its lines are rebuilt from the CLI's own chat store
// (lib/cli-subagents-cursor.mjs) before correlation.
//
// The turn END is `stop`; the turn START is the `prompt` line scripts/prompt-submit.mjs writes on
// `beforeSubmitPrompt` (see buildPeriods). Staff once said `afterAgentResponse` /
// `afterAgentThought` / `beforeSubmitPrompt` do not fire in the CLI, and that is no longer the whole
// picture: receptron/mulmoterminal#2064 observed them firing in the INTERACTIVE CLI on 2026.09.10,
// and not in headless `agent -p`. So the prompt line is used when it is there and nothing here
// depends on it: a turn without one (`-p`, an older build, a sidecar written before the hook
// existed) falls back to the `stop` rule it has always had.

// `dedupeEvents` is REQUIRED for the subagent list and merely tidy for the periods.
//
// Both hook registries are permanently installed now, so on a machine that has both — which is every
// machine — one host event writes two sidecar lines about seven milliseconds apart. Two anchors that
// close together change no period classification, which is why this file survived without the
// collapse. Two `subagent_start` lines are a different matter entirely: they open two spans, close
// with two stops, and every subagent on every machine is drawn twice, billed twice and counted twice.
//
// All four siblings above (delta-cursor, timing, config, http) were bound through a guarded
// top-level `await import` until the plugin's Node floor moved to 13.2, which has no top-level
// await. They are plain static imports now, and that is the only restructuring available here: the
// three consts below are evaluated during module evaluation, so an `import(...).then()` that flips a
// module-level binding would land a microtask too late and pin every one of them to its fallback
// permanently — silently, since two of the fallbacks equal the real value. Every one of the four is
// a sibling in this same package, so "not present" was only ever a broken install.
//
// The withheld-subagents contract the guard existed for is unchanged in the way that matters: when
// there is no collapse the subagent list is EMPTY rather than doubled, because an empty card is a
// visible absence and a doubled one is a confident lie. What changed is how it is reached — only
// through the `dedupeEvents` deps seam now (see computeSessionTimeline), never through a failed
// import. That seam is what pins the contract in test/session-timeline-cursor.test.mjs, which passes
// `dedupeEvents: null` explicitly, so the branch is still covered.
const dedupeEvents =
  typeof hostDelta.dedupeEvents === 'function' ? hostDelta.dedupeEvents : null;

// Shared with the delta engine so "working" means the same gap threshold in both places.
const IDLE_GAP_SEC =
  typeof hostTiming.IDLE_GAP_SEC === 'number' ? hostTiming.IDLE_GAP_SEC : 300;

// THE VOCABULARY, and which side of the conversation each word belongs to. Getting this wrong is
// not a cosmetic mislabel: the portal charts these bands, excludes `break` from tracked session
// time, and reads `idle` as the agent waiting on something of its own.
//
//   working       the agent is doing something, and the evidence is events closer together than
//                 the idle threshold.
//   idle          the AGENT is waiting, mid-turn: a background script, a long shell command, a
//                 fan-out of subagents it is blocked on. Nobody has handed the turn back to the
//                 human, so this is never the user's time however long it runs.
//   waiting_user  the turn ENDED and the next thing is the human: the next instruction, or an
//                 approval prompt (`waiting_subtype`). Length alone never takes a gap out of this
//                 state — only BREAK_MS does.
//   break         a wait on the human long enough that the person plainly left. Only reachable
//                 from a turn end, for the reason above.
const STATE = {
  WORKING: 'working',
  WAITING_USER: 'waiting_user',
  IDLE: 'idle',
  BREAK: 'break',
};

// The idle threshold in milliseconds, as the comparison actually uses it.
//
// The comparison is `>=`, which is the whole of DATA-05: lib/active-time.mjs drops a gap when
// `gap >= idleGapMs`, so a gap of EXACTLY five minutes is billed as nothing while this module used
// to chart it as activity. One threshold, one direction, both sides — a period drawn as work that
// no second of duration backs is the kind of disagreement nobody can debug from a dashboard.
export const IDLE_GAP_MS = IDLE_GAP_SEC * 1000;

// Three hours, and it applies to ONE kind of gap: a wait on the human. Past this the session was
// not being waited on, it was left — the person went home, into a meeting, onto something else —
// and charting three hours of that as `waiting_user` says a human sat in front of the editor all
// afternoon.
//
// DELIBERATELY NOT the Claude engine's six (beezi-claude-plugins, lib/session-timeline.mjs). The
// two numbers answer slightly different questions here: this one only ever splits user waits,
// because an agent-side gap of any length stays `idle` (see buildPeriods), so it can be tighter
// without swallowing a long background run.
export const BREAK_MS = 3 * 60 * 60 * 1000;

// The only `waiting_subtype` this module can honestly emit, and only from a marker the CALLER
// validated against a real host signal.
//
// The SPELLING is the backend's, not ours: `command_approval` is what CliAgentWaitingSubtype calls a
// wait on a tool permission prompt (portal commit 871a788,
// domain/enums/cli-agent-waiting-subtype.enum.ts). Inventing a synonym would store a label no
// reader renders, in a field that is a bounded string precisely so it does not 400 — which is the
// worst combination: accepted, stored, and invisible.
//
// Deliberately NOT inferred from an event name. Cursor exposes no permission-mode or approval event
// this plugin has ever observed, so a classifier that guessed from a name would invent a measurement
// out of a spelling. Nothing supplies markers today, which is what keeps the field off the wire
// until there is something real behind it.
export const WAITING_SUBTYPE = Object.freeze({ COMMAND_APPROVAL: 'command_approval' });

// Events that end the agent's turn — the gap that follows one is time the user owns.
//
// `subagent_stop` is deliberately NOT in here, and must never be added. It is matched by exact
// equality, so it is already excluded; adding it would classify the gap after a fan-out finishes as
// `waiting_user` and bill the parent's own think-time to the user on every delegation.
//
// That prohibition got STRONGER with the classification order in buildPeriods. A turn end now
// outranks the idle threshold, so a mistaken member here no longer mislabels gaps under five
// minutes only — it mislabels every gap up to BREAK_MS, six hours of parent work drawn as the user
// sitting there.
//
// `session_start` IS in here, although it ends no turn: it is the boundary after which the first
// move is the human's. A session is opened (the CLI's `agent`, an IDE composer) before anyone types,
// and the gap up to the first tool or generation is the user reading, thinking, writing a prompt.
// Left out, that gap was an agent-side gap, and one over five minutes drew as `idle` — which the
// portal labels "Subagents working" — at the very start of a session that had delegated nothing.
// Billing is unaffected: delta-cursor's SESSION_LIFECYCLE_EVENTS keeps `session_start` out of the
// timing anchors, so this only decides how the gap is DRAWN, never whether it is billed. When the
// session's first real anchor is a prompt the lead-in is dropped altogether — see periodAnchors.
//
// `end` / `session_end` USED to be members. They are not anchors at all any more (CLOSING_EVENTS
// below), so they could never be the `prev` of a gap and listing them here would be dead weight.
const TURN_END_EVENTS = new Set(['stop', 'session_start']);

// Turn STARTS: the human pressed Send. scripts/prompt-submit.mjs writes `prompt` on
// `beforeSubmitPrompt`; the three aliases are the spellings delta-cursor and
// lib/session-name-cursor.mjs have always recognised for the same line.
//
// Why this exists (verified on a real CLI session): a turn that calls no tool leaves nothing in the
// sidecar but the `gen` + `stop` pair stop.mjs writes at its END. With only turn ends to go on,
// every gap in such a session followed a `stop`, so every gap drew as `waiting_user`, the first turn
// (which happened before the first line) was never drawn at all, and the portal showed a session of
// almost nothing but "User input". A prompt line is the other edge of the turn: the gap BEFORE it
// is the user's, the gap AFTER it is the agent's.
const PROMPT_EVENTS = new Set(['prompt', 'user', 'user_message', 'user_prompt']);

// Session CLOSE lines, which are not period anchors at all.
//
// `sessionEnd` fires when the user closes the CLI or the composer, which is whenever they get round
// to it — minutes or hours after the last turn ended. As an anchor it drew that whole stretch as a
// trailing "User input" band (the gap after the last `stop`) and stretched the axis to it, so every
// session ENDED on the human, however much work it did. The last thing that actually happened in a
// session is its last turn's end, and that is where the timeline now stops. Billing never used it
// as an anchor either (delta-cursor, SESSION_LIFECYCLE_EVENTS).
const CLOSING_EVENTS = new Set(['end', 'session_end']);

// The anchors buildPeriods classifies, sorted, each tagged with the one fact the classifier needs.
//
// Two rules live here rather than in the loop, because the session span (computeSessionTimeline)
// has to be measured over exactly the same list — otherwise the axis runs past the first or last
// drawn period and the portal shows a blank tail:
//
//   - CLOSING_EVENTS are dropped. See above.
//   - Leading `session_start` anchors are dropped when the first real anchor is a prompt. This is
//     the Claude plugin's `dropLeadIn` (beezi-claude-plugins, lib/session-timeline.mjs): the
//     timeline starts when the human first speaks. The minutes between opening the CLI and typing
//     are not a turn, and once a prompt says exactly when the first turn began there is nothing
//     left for that band to mean. Without a prompt (`-p`, an older build, an old sidecar) the
//     session_start stays, and the lead-in draws as the user's wait exactly as it did before.
function periodAnchors(events) {
  const anchors = [];
  for (const event of events) {
    const ts = timestampOf(event);
    if (ts === null) continue;
    const ev = event == null ? undefined : event.ev;
    if (CLOSING_EVENTS.has(ev)) continue;
    anchors.push({
      ts,
      prompt: PROMPT_EVENTS.has(ev),
      endsTurn: TURN_END_EVENTS.has(ev),
      sessionStart: ev === 'session_start',
    });
  }
  anchors.sort((a, b) => a.ts - b.ts);
  let lead = 0;
  while (lead < anchors.length && anchors[lead].sessionStart) lead += 1;
  if (lead > 0 && lead < anchors.length && anchors[lead].prompt) return anchors.slice(lead);
  return anchors;
}

// Re-exported from the dependency-free module that owns it — same function, one implementation. See
// the note there for why it lives on that side of the import.
export { timestampOf };

// The backend's own caps on the timeline document.
export const MAX_SUBAGENTS = 1000;
export const MAX_PERIODS = 5000;

// The cap that actually binds, and it is not either of the two above: Express's default JSON body
// limit is ~100 KB and nobody has overridden it on this route. 1000 subagent entries at ~150 bytes
// each is ~150 KB, and a long session's periods run well past that on their own — a period is drawn
// for every working/idle/waiting_user/break transition, so a session that ran for hours produces
// thousands of them, MAX_PERIODS notwithstanding (5000 periods at ~90 bytes each is ~450 KB). A 413
// rejects the ENTIRE timeline — periods, plan events, session span, the lot — for a session whose
// only sin was running a long time or delegating a lot of work. 90 KB leaves room for the envelope
// (`sessionId`, the timestamps) and for the difference between a byte count and whatever the proxy
// in front of the API counts.
export const TIMELINE_BODY_BUDGET_BYTES = 90 * 1024;

// The most periods will ever be asked to give up to make room for subagents that have not been
// fitted yet — see fitPeriodsToBudget's use of it in computeSessionTimeline. Capped, not flat: a
// session with no subagents (or a handful of tiny ones) must not lose 20 KB of periods for a reserve
// nothing will ever fill. computeSessionTimeline narrows this to `Math.min(SUBAGENT_RESERVE_BYTES,
// actualSubagentBytes)` before it ever reaches the budget passed in here.
export const SUBAGENT_RESERVE_BYTES = 20 * 1024;

// Drop the lowest-value subagent entries until the serialized body fits the budget.
//
// "LOWEST VALUE" IS SHORTEST WALL-CLOCK SPAN FIRST, ties broken by dropping the LATER start. Both
// halves are deliberate:
//   • duration is what every one of the five dashboards actually renders — a gantt lane's width, the
//     denominator of the tool-attribution tree, the ordering of the Subagents card — so the entry
//     that contributes least is the one that draws as a hairline. A zero-width span (a background
//     worker that started as the session ended) is the first thing to go and costs nothing visible.
//   • on a tie, the tail of a fan-out is the most repetitive part of it: ten workers given near
//     identical slices of one task differ least at the end. Keeping the earlier one keeps the entry
//     whose span anchors the shape of the fan-out.
// Deliberately NOT dropped by "synthetic first": a synthetic close marks a BACKGROUND subagent,
// which is the delegation a user cannot see any other way, and preferring to drop those would make
// the guard bite hardest on exactly the workers this feature exists to reveal.
//
// Sizes are measured once per entry rather than by re-serializing the whole document each round —
// this runs inside a hook against a 7.5 s budget, and the naive loop is 1000 stringifies of a 150 KB
// document.
export function fitSubagentsToBudget(entries, baseBytes, budget = TIMELINE_BODY_BUDGET_BYTES) {
  if (entries.length === 0) return entries;
  const sized = entries.map((entry, index) => {
    let bytes;
    try {
      // +1 for the comma that joins it to its neighbour. `[]` is already in baseBytes.
      bytes = Buffer.byteLength(JSON.stringify(entry), 'utf-8') + 1;
    } catch {
      bytes = 0;
    }
    const started = Date.parse(entry.started_at);
    const ended = Date.parse(entry.ended_at);
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : 0;
    return { index, bytes, durationMs, started: Number.isFinite(started) ? started : 0 };
  });

  let total = baseBytes;
  for (const s of sized) total += s.bytes;
  if (total <= budget) return entries;

  const order = [...sized].sort(
    (a, b) => a.durationMs - b.durationMs || b.started - a.started || b.index - a.index,
  );
  const dropped = new Set();
  for (const s of order) {
    if (total <= budget) break;
    dropped.add(s.index);
    total -= s.bytes;
  }
  return entries.filter((_, index) => !dropped.has(index));
}

// Drop the OLDEST periods until the serialized body fits the budget — finding D1: MAX_PERIODS caps
// the array's length, never its byte size, and a session that ran long enough produces periods well
// under that cap whose JSON still blows well past TIMELINE_BODY_BUDGET_BYTES on its own. Where
// fitSubagentsToBudget picks its drops by value (shortest span first), periods have no such axis —
// every one is a real, equally-true slice of the timeline — so the only defensible rule left is the
// one the existing MAX_PERIODS trim already applies inside computeSessionTimeline (unchanged by
// this function): newest first, drop from the front. A user re-opening a long session cares about
// what just happened, not what happened four hours ago, and the trimmed periods still leave
// `started_at`/`ended_at` at the full span (see the caller) so the axis does not lie about how
// long the session ran.
//
// `envelopeBytes` is everything in the body that is NOT periods — the caller measures that once
// itself, the same way baseBytes is measured below for fitSubagentsToBudget. `budget` is the ceiling
// this call is held to, which the caller narrows by whatever it is reserving for something else (see
// SUBAGENT_RESERVE_BYTES); this function has no opinion on that and only ever compares against what
// it is given.
//
// Sizes are measured once per period, same technique as fitSubagentsToBudget above: a naive loop that
// re-stringifies the whole array on every drop is O(n^2) against an array that can be thousands long.
export function fitPeriodsToBudget(periods, envelopeBytes, budget = TIMELINE_BODY_BUDGET_BYTES) {
  if (periods.length === 0) return periods;
  const sized = periods.map((period) => {
    try {
      // +1 for the comma that joins it to its neighbour, matching fitSubagentsToBudget's accounting.
      // `[]` itself is already inside envelopeBytes.
      return Buffer.byteLength(JSON.stringify(period), 'utf-8') + 1;
    } catch {
      return 0;
    }
  });

  let total = envelopeBytes;
  for (const bytes of sized) total += bytes;
  if (total <= budget) return periods;

  // Drop from the front (oldest) until it fits, then keep the rest in their existing order — no
  // reordering, no per-period value judgement, just the newest tail of what still fits.
  let dropCount = 0;
  while (dropCount < sized.length && total > budget) {
    total -= sized[dropCount];
    dropCount += 1;
  }
  return periods.slice(dropCount);
}

// The permission-wait windows the caller has VERIFIED, normalized to [startMs, endMs) pairs.
// Anything malformed is dropped rather than repaired: a marker is an assertion that the host said
// the agent was blocked on a human, and a half-readable one asserts nothing.
function validMarkers(markers) {
  if (!Array.isArray(markers)) return [];
  const out = [];
  for (const marker of markers) {
    if (marker == null || typeof marker !== 'object') continue;
    const startMs = marker.startMs;
    const endMs = marker.endMs;
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) continue;
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    out.push({ startMs, endMs });
  }
  return out;
}

// A subtype is attached only when a marker covers the WHOLE gap. A partial overlap means part of
// that wait was something else, and labelling the period anyway would report time the host never
// said anything about as permission waiting.
function subtypeFor(markers, startMs, endMs) {
  for (const marker of markers) {
    if (marker.startMs <= startMs && marker.endMs >= endMs) return WAITING_SUBTYPE.COMMAND_APPROVAL;
  }
  return null;
}

// The time some subagent was running, as sorted, merged [startMs, endMs] pairs — the shape
// lib/subagents-cursor.mjs's subagentIntervals returns. Merged so two workers that overlap cover the
// gap between them together; malformed pairs are dropped, the same rule as validMarkers.
function mergedIntervals(intervals) {
  if (!Array.isArray(intervals)) return [];
  const valid = [];
  for (const pair of intervals) {
    if (!Array.isArray(pair)) continue;
    const [startMs, endMs] = pair;
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) continue;
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    valid.push([startMs, endMs]);
  }
  valid.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const pair of valid) {
    const last = out[out.length - 1];
    if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
    else out.push(pair.slice());
  }
  return out;
}

// Whether workers were running for the WHOLE gap. Only full cover counts, the same rule as a
// permission marker: a gap half inside a worker's run was half something else. In practice a gap
// never straddles a worker edge anyway — every span's start and stop are lines in the stream, so
// they are anchors, and the gaps are already cut at them.
function coveredBy(intervals, startMs, endMs) {
  for (const [from, to] of intervals) {
    if (from <= startMs && to >= endMs) return true;
  }
  return false;
}

export function buildPeriods(events, options = {}) {
  // Opt-OUT, not opt-in. `break` is a member of CliAgentActivityState, the client renders it as
  // "Session break" and the backend excludes it from activity-breakdown totals; `state` is a
  // bounded string on the DTO precisely so a word a reader does not know cannot 400 the document.
  // A caller that has reason to distrust the deployment can still pass `false` and get the
  // pre-break vocabulary, where a long wait stays `waiting_user`.
  const allowBreakState = options.allowBreakState !== false;
  const markers = validMarkers(options.permissionMarkers);
  const running = mergedIntervals(options.subagentIntervals);
  // Rule 3a's switch. Evidence, not policy: computeSessionTimeline sets it only when the CLI's chat
  // store proves the session's unprompted turns were the host's (see hostStartedTurns there).
  const hostResumes = options.hostResumes === true;
  const anchors = periodAnchors(events);

  // A wait on the human: `break` past BREAK_MS when the caller allows it, `waiting_user` otherwise,
  // with the validated subtype when a marker covers the whole gap. One function because two rules
  // below reach it and a subtype honoured by one of them only would label a stop→prompt gap
  // differently from a stop→gen one for the same wait.
  const userWait = (prev, cur) => {
    if (allowBreakState && cur.ts - prev.ts >= BREAK_MS) return { state: STATE.BREAK, subtype: null };
    return { state: STATE.WAITING_USER, subtype: subtypeFor(markers, prev.ts, cur.ts) };
  };

  const merged = [];
  // Whether a prompt line has been seen at or before `prev` — the other half of rule 3a.
  let promptSeen = false;
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (prev.prompt) promptSeen = true;
    if (cur.ts <= prev.ts) continue;
    const gap = cur.ts - prev.ts;
    let judged;
    // WHO WAS WAITING decides the state; how long only ever splits a user wait into `break`. Each
    // gap is judged on its own two edges and the first rule that matches wins:
    //
    //   0. subagents were running for the whole gap: the agent is waiting on its own workers, so the
    //      gap is mid-turn — `idle` past the idle threshold, `working` under it — whatever its edges
    //      say. This outranks everything, because the edges can lie about it: the CLI ends the
    //      parent's turn with a `stop` while background workers are still running, then resumes the
    //      parent by itself when they finish. Judged by its edges, that wait drew as "User input"
    //      right above the lanes of the workers it was waiting on. It outranks a prompt too: a
    //      prompt typed while workers run was typed while the agent was busy, and billing already
    //      bills every second of a worker's run once — on the parent's segment, or as the worker's
    //      residual where the parent was quiet (lib/checkpoint.mjs over lib/active-time.mjs's
    //      interval union) — so the band now agrees with the bill.
    //   1. `cur` is a prompt: the human was composing it, so the gap is theirs. This outranks
    //      every rule below, including a `prev` that is a tool call — a turn the user aborted without a
    //      `stop` still ends when they type the next prompt.
    //   2. `prev` is a prompt: Send was pressed, the turn is the agent's. `idle` past the idle
    //      threshold (the agent waiting on a slow model or a long think, the same boundary billing
    //      drops the gap at), `working` under it — and NEVER `waiting_user`, which is exactly the
    //      mislabel that drew no-tool CLI turns as "User input" from end to end.
    //  3a. `prev` is a `stop`, `cur` is not a prompt, a prompt line came earlier, and the chat store
    //      proved the host restarts turns in this session (`hostResumes`): the CLI restarted the
    //      agent itself. When a background task finishes — a subagent or a shell job — the CLI files
    //      a notification and runs a new turn with no Send, so no beforeSubmitPrompt fires and no
    //      prompt line precedes it. The gap is the agent's: `idle` past the threshold, `working`
    //      under it, never `break` — a restart hours later is a background job that ran for hours.
    //      Each condition closes a hole. A prompt earlier in the stream proves the hook fires here, so
    //      a sidecar written before it existed, a `-p` run and a mid-session upgrade keep rule 3 until
    //      it does. `session_start` is left out: `agent --resume` opens a new process, and the gap in
    //      front of its first line is still the human's. And `hostResumes` itself is the guard
    //      against a LOST prompt line — a paste over the gate's stdin cap, a gate that hit its wall
    //      guard, a recorder that failed — which would otherwise put a typed turn's think-time here.
    //   3. `prev` is a turn end (`stop`, or the `session_start` boundary): the rule this module has
    //      always had, and now the FALLBACK for a turn with no prompt line — `-p`, older builds and
    //      every sidecar written before the hook existed classify exactly as they did.
    //   4. anything else is mid-turn: `idle` past the threshold, `working` under it.
    //
    // The turn boundary comes before the idle threshold, and that is the fix for the
    // misclassification this module shipped with: the threshold used to be tested first, so any
    // think-time over five minutes stopped being the user's. Sixteen real minutes of a person
    // reading a diff drew as `idle` — which the portal renders as "Subagents working" — in the
    // middle of a session where no subagent was running.
    //
    // Length never moves a gap OUT of the user's column except past BREAK_MS, and length never
    // moves an agent-side gap INTO it: a four-hour background script is the agent waiting, not the
    // human, so it stays `idle` whatever the clock says.
    if (coveredBy(running, prev.ts, cur.ts)) judged = { state: gap >= IDLE_GAP_MS ? STATE.IDLE : STATE.WORKING, subtype: null };
    else if (cur.prompt) judged = userWait(prev, cur);
    else if (prev.prompt) judged = { state: gap >= IDLE_GAP_MS ? STATE.IDLE : STATE.WORKING, subtype: null };
    else if (hostResumes && promptSeen && prev.endsTurn && !prev.sessionStart) judged = { state: gap >= IDLE_GAP_MS ? STATE.IDLE : STATE.WORKING, subtype: null };
    else if (prev.endsTurn) judged = userWait(prev, cur);
    else judged = { state: gap >= IDLE_GAP_MS ? STATE.IDLE : STATE.WORKING, subtype: null };
    const state = judged.state;
    const subtype = judged.subtype;

    const last = merged[merged.length - 1];
    // State AND subtype: merging a labelled wait into an unlabelled one would spread an observation
    // over time nothing was observed about, in whichever direction the merge happened to run.
    if (last && last.state === state && last.subtype === subtype) last.endMs = cur.ts;
    else merged.push({ state, subtype, startMs: prev.ts, endMs: cur.ts });
  }
  return merged.map((m) => ({
    state: m.state,
    started_at: new Date(m.startMs).toISOString(),
    ended_at: new Date(m.endMs).toISOString(),
    // Omitted, never undefined: the checkpoint's timeline signature is a JSON.stringify of this
    // array, and a key present on every period would re-POST every live session's timeline once
    // after upgrade for no change in content.
    ...(m.subtype === null ? {} : { waiting_subtype: m.subtype }),
  }));
}

// On the chat-store reader's clock: `deps.now` when injected, else the wall clock.
function deadlinePassed(deps) {
  if (typeof deps.deadline !== 'number') return false;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  return now >= deps.deadline;
}

// Whether the stream holds a gap rule 3a could judge: a `stop` after a prompt, followed by something
// that is not a prompt. The chat store is opened only when it can change a period — a session whose
// every turn was typed never pays for the read.
function hasUnpromptedTurn(anchors) {
  let promptSeen = false;
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (prev.prompt) promptSeen = true;
    if (promptSeen && prev.endsTurn && !prev.sessionStart && !cur.prompt && cur.ts > prev.ts) return true;
  }
  return false;
}

// The prompt lines in the stream, one per Send: the same generation id is one Send however many
// registries wrote it, and a line without an id counts on its own. `events` is already collapsed by
// the caller, so this only guards against a copy the collapse let through — which would inflate the
// count and weaken the check below, never tighten it.
function promptCount(events) {
  const ids = new Set();
  let anonymous = 0;
  for (const event of events) {
    if (event == null || !PROMPT_EVENTS.has(event.ev) || timestampOf(event) === null) continue;
    if (typeof event.eid === 'string' && event.eid !== '') ids.add(event.eid);
    else anonymous += 1;
  }
  return ids.size + anonymous;
}

// Rule 3a's evidence (buildPeriods): true only when the CLI's chat store PROVES that this session's
// unprompted turns were started by the host.
//
//   - at least one host notification: the CLI did restart a turn itself here;
//   - at least one typed send: a store that shows none while the sidecar holds prompt lines is a
//     format this reader does not know, and an unknown format proves nothing;
//   - a prompt line for EVERY typed send. This is the guard against a lost line. The prompt hook can
//     drop one while every other hook keeps writing (scripts/prompt-submit.mjs: a paste over its
//     stdin cap, its wall guard, a recorder that failed), and that typed turn would then look exactly
//     like a host restart. More typed sends than lines means one is missing somewhere, so the rule is
//     off for the WHOLE session: the store's rows carry minute-precision timestamps at best, which
//     cannot say which unprompted turn was the typed one. The same check fails closed on a sidecar
//     pruned under a store that kept everything.
//
// Only the CLI has this store; an IDE session's lookup finds no chat and returns null, so the IDE
// keeps the stop rule. Never throws: a store that cannot be read is no evidence.
//
// A read the DEADLINE cut short is not "no evidence", though: it answers exactly like one, and the
// timeline built from it would draw the stop rule's band over a queued one that had the evidence.
// So it is reported through `onEnrichment({ complete: false })`, the channel the subagent listing
// already uses for the same failure (lib/cli-subagents-cursor.mjs), and the checkpoint and the
// outbox then refuse to let it overwrite anything. Measured the same way — the deadline has passed
// right after the read — and ONLY that: a store that is locked, garbled or unreadable without
// node:sqlite stays unreadable, and calling it incomplete would park the timeline until prune.
function hostStartedTurns(conversationId, events, deps) {
  if (!hasUnpromptedTurn(periodAnchors(events))) return false;
  const count = deps.countCliTurnStarts == null ? countCliTurnStarts : deps.countCliTurnStarts;
  let turns;
  try {
    turns = count(conversationId, deps);
  } catch {
    return false;
  }
  if (turns == null && deadlinePassed(deps) && typeof deps.onEnrichment === 'function') {
    try { deps.onEnrichment({ complete: false }); } catch { /* the caller's problem, never the hook's */ }
  }
  if (turns == null || !Number.isInteger(turns.human) || !Number.isInteger(turns.system)) return false;
  return turns.system >= 1 && turns.human >= 1 && promptCount(events) >= turns.human;
}

// The four keys the backend's timeline DTO accepts on a subagent entry — and ONLY those four.
// Unknown keys are rejected, and a rejection takes the whole document with it, so the rich span
// lib/subagents-cursor.mjs returns (task, ambiguous, synthetic, the millisecond pair the interval
// union needs) is narrowed here rather than shipped and hoped for.
function toSubagentEntry(span) {
  return {
    agent_id: span.agent_id,
    agent_type: span.agent_type,
    started_at: span.started_at,
    ended_at: span.ended_at,
  };
}

// `options` holds classification policy (`allowBreakState`, `permissionMarkers`); `deps` holds
// substitutable implementations. Separate parameters so a gated behaviour cannot arrive disguised
// as an injectable — and so a caller that passes neither gets exactly the pre-DATA-05 vocabulary.
export function computeSessionTimeline(conversationId, deps = {}, options = {}) {
  const readEventsImpl = deps.readEvents == null ? ((id) => readEvents(id, deps)) : deps.readEvents;
  let events;
  try {
    events = readEventsImpl(conversationId);
  } catch {
    return null;
  }
  if (!Array.isArray(events) || events.length === 0) return null;

  // Collapsed ONCE, and the same array feeds both builders. A turn-end hook already parses the whole
  // sidecar for this call; parsing is the expensive part and hashing it twice would be the second.
  //
  // `in` rather than a nullish fallback so a caller can pass an explicit null to mean "there is no
  // collapse here" — which is the case the withheld-subagents branch below exists for, and a
  // `== null` test would quietly replace it with the module's own.
  const dedupe = 'dedupeEvents' in deps ? deps.dedupeEvents : dedupeEvents;
  // Cursor CLI sessions: the workers come from the CLI's chat store, not from hooks (see
  // lib/cli-subagents-cursor.mjs). Enriched here, before the span is measured, so every caller —
  // the checkpoint, backfill, sync — draws the same lanes from the same stream. A no-op on a stream
  // that already has subagent lines, which covers every IDE session with delegation AND the
  // checkpoint, whose array arrives enriched already. Only with a collapse: with none the subagent
  // list is withheld below anyway, and reading the store for it would be pure cost.
  //
  // `deps` goes through whole: `deadline`, `chatsDir`, `sqlite` and the `listCliSubagents` seam are
  // the chat-store reader's, and the checkpoint forwards its hook deadline in them.
  const window = dedupe ? withCliSubagents(conversationId, dedupe(events).events, deps) : events;

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const event of window) {
    const ts = timestampOf(event);
    if (ts === null) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  // Events exist but none is timestamped: that is a writer/reader schema mismatch, not an idle
  // session, and reporting a zero-length timeline would hide it. Measured over EVERY line, not the
  // period anchors below: a sidecar holding nothing but `session_end` is a real session with no
  // drawable period, not a schema mismatch. The raw maximum is also the subagent correlator's
  // ceiling for a synthetic close, unchanged, so no worker's span moves because of how the
  // periods are anchored.
  if (minTs === Infinity) return null;

  // No collapse available means no subagents — never a doubled list. See the import note.
  let spans = [];
  if (dedupe) {
    const { subagents, diagnostics } = correlateSubagents(window, { lastActivityMs: maxTs });
    spans = subagents;
    // Diagnostics travel by callback and NOT in the returned object: every key of that object is
    // POSTed verbatim (`{ sessionId, ...timeline }`), and an unknown one fails validation for the
    // whole document. The caller decides what to do with an ambiguous match or an orphan stop; this
    // module's job is only to refuse to hide them.
    if (typeof deps.onSubagentDiagnostics === 'function') {
      try {
        deps.onSubagentDiagnostics(diagnostics);
      } catch { /* a diagnostic sink must never break the timeline */ }
    }
  }

  // Newest first, then truncate: when a session blows the cap it is the recent fan-out the user is
  // looking at, not the one from four hours ago. This bounds the ARRAY LENGTH only — the body-budget
  // fit below (fitPeriodsToBudget) bounds its BYTE SIZE, which a session well under MAX_PERIODS can
  // still blow past on its own (finding D1).
  //
  // The workers' runs go in with the events, so a wait on them is drawn as the agent's (buildPeriods,
  // rule 0). Every span, not just the ones that ship: a lane dropped for the body budget still ran.
  // Never a SYNTHETIC one: its end is the correlator's guess at the last activity in the stream, and
  // counting it would draw every wait on the human after an unclosed IDE worker as "Subagents
  // working" until the session ended.
  const running = subagentIntervals(spans.filter((span) => span != null && span.synthetic !== true));
  //
  // `hostResumes` is evidence too (buildPeriods, rule 3a), and like the lanes it needs the collapse:
  // an uncollapsed stream counts every prompt once per registry, which would pass the lost-line check
  // it exists for.
  const hostResumes = dedupe ? hostStartedTurns(conversationId, window, deps) : false;
  const periods = buildPeriods(window, { ...options, subagentIntervals: running, hostResumes });
  const trimmedPeriods = periods.length > MAX_PERIODS ? periods.slice(-MAX_PERIODS) : periods;
  const capped = spans.length > MAX_SUBAGENTS ? spans.slice(-MAX_SUBAGENTS) : spans;
  const entries = capped.map(toSubagentEntry);

  // The session span: the same anchors the periods were drawn from, widened by any subagent span.
  //
  // Not the raw min/max any more. The raw maximum is the trailing `session_end`, which is not a
  // period anchor (CLOSING_EVENTS), and the raw minimum is a `session_start` the lead-in rule may
  // have dropped — measured from those, the axis would run minutes or hours past the first or last
  // drawn period and the portal would show a blank tail at either end. Subagent spans widen it
  // because a lane is drawn on the same axis. Falls back to the raw bounds only when no anchor is
  // left at all (a sidecar holding nothing but a shutdown line).
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const anchor of periodAnchors(window)) {
    if (anchor.ts < spanStart) spanStart = anchor.ts;
    if (anchor.ts > spanEnd) spanEnd = anchor.ts;
  }
  // `started_ms` / `ended_ms`, the spelling correlateSubagents returns (lib/subagents-cursor.mjs).
  // Codex review, MAJOR: this loop once read `startedMs` / `endedMs` — the correlator's INTERNAL
  // names, which it never ships — so it widened nothing, and a background subagent synthetically
  // closed at session_end was drawn as a lane running past the end of the timeline's own axis.
  for (const span of spans) {
    if (Number.isFinite(span.started_ms) && span.started_ms < spanStart) spanStart = span.started_ms;
    if (Number.isFinite(span.ended_ms) && span.ended_ms > spanEnd) spanEnd = span.ended_ms;
  }
  if (spanStart === Infinity || spanEnd === -Infinity) {
    spanStart = minTs;
    spanEnd = maxTs;
  }

  const timeline = {
    periods: trimmedPeriods,
    plan_events: [],
    subagents: entries,
    started_at: new Date(spanStart).toISOString(),
    ended_at: new Date(spanEnd).toISOString(),
    generated_at: new Date().toISOString(),
  };

  // The envelope: everything the body carries that is NOT periods or subagents — `sessionId`, the
  // (always empty) plan events, the session span, the generated_at stamp. Measured once, zeroing both
  // arrays, so it costs one stringify regardless of how many periods or subagents there are.
  let envelopeBytes = 0;
  try {
    envelopeBytes = Buffer.byteLength(
      JSON.stringify({ sessionId: conversationId, ...timeline, periods: [], subagents: [] }),
      'utf-8',
    );
  } catch { /* unserializable is impossible here; a throw leaves this at 0 — the envelope counts as empty and the fit still runs */ }

  // Subagents get first claim on SUBAGENT_RESERVE_BYTES of whatever the envelope leaves, but never
  // more than they actually need — `entries`, not `spans`: the DTO's four narrowed keys are what
  // ships, and sizing the rich span instead (task, synthetic, the millisecond pair) would reserve for
  // bytes that never reach the wire. A session that delegated nothing sizes to `"[]"` (2 bytes), so
  // it reserves 2 bytes, not 20 KB: periods must not lose 20 KB to a reserve nothing will fill.
  let subagentBytes = 0;
  try {
    subagentBytes = Buffer.byteLength(JSON.stringify(entries), 'utf-8');
  } catch { /* unserializable is impossible here; a throw leaves this at 0, so the reserve below is 0 — none */ }
  const reserve = Math.min(SUBAGENT_RESERVE_BYTES, subagentBytes);

  // Not `started_at` / `ended_at`: those stay at the full span exactly as the MAX_PERIODS trim above
  // already leaves them (the axis, not the drawn periods, tells the portal how long the session ran).
  // Assigned onto the existing key rather than rebuilt, so `timeline`'s key order — and therefore its
  // signature — is unchanged for the common case where nothing here drops anything.
  timeline.periods = fitPeriodsToBudget(trimmedPeriods, envelopeBytes, TIMELINE_BODY_BUDGET_BYTES - reserve);

  // Measured against the body the caller actually sends — `sessionId` and all — because the limit
  // that rejects it is counted on the wire, not on the part of it this module happens to own. Against
  // `timeline.periods` as fitted just above, not the untrimmed array, so a subagent list that needed
  // the reserve is not charged for periods that already made room for it.
  let baseBytes = 0;
  try {
    baseBytes = Buffer.byteLength(
      JSON.stringify({ sessionId: conversationId, ...timeline, subagents: [] }),
      'utf-8',
    );
  } catch { /* unserializable is impossible here; treat as unbounded and let the fit run */ }
  timeline.subagents = fitSubagentsToBudget(entries, baseBytes);
  return timeline;
}

// POST the session timeline to Beezi. Session-scoped (upserted by sessionId), fire-and-forget by
// convention — callers swallow the result.
export async function postSessionTimeline(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !Array.isArray(payload.periods)) {
    return { reported: false, reason: 'missing-fields' };
  }
  if (!token) return { reported: false, reason: 'no-token' };

  const apiBase = deps.apiBase == null ? hostConfig.apiBase : deps.apiBase;
  const endpoints = deps.endpoints == null ? hostConfig.ENDPOINTS : deps.endpoints;
  const postJson = deps.postJson == null ? hostHttp.postJson : deps.postJson;
  if (typeof apiBase !== 'function' || endpoints == null || !endpoints.sessionsTimeline || typeof postJson !== 'function') {
    return { reported: false, reason: 'no-transport' };
  }

  try {
    // timeoutMs travels through: the caller may be running against a hook deadline and needs this
    // request bounded by what is left of it, not by the default.
    const res = await postJson(`${apiBase()}${endpoints.sessionsTimeline}`, token, payload, {
      fetchImpl,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
