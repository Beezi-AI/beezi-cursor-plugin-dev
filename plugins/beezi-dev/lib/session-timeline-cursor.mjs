import { readEvents } from './sidecar-read.mjs';
import { correlateSubagents, timestampOf } from './subagents-cursor.mjs';
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
// "Tokens by Subagent" panel and this timeline's own gantt lanes.
//
// The turn boundary is `stop`. `afterAgentResponse` / `afterAgentThought` are a staff-acknowledged
// bug in the CLI (they do not fire), so nothing here may depend on them.

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
const TURN_END_EVENTS = new Set(['stop', 'end', 'session_end']);

// Re-exported from the dependency-free module that owns it — same function, one implementation. See
// the note there for why it lives on that side of the import.
export { timestampOf };

// The backend's own caps on the timeline document.
export const MAX_SUBAGENTS = 1000;
export const MAX_PERIODS = 5000;

// The cap that actually binds, and it is not either of the two above: Express's default JSON body
// limit is ~100 KB and nobody has overridden it on this route. 1000 subagent entries at ~150 bytes
// each is ~150 KB, and a 413 rejects the ENTIRE timeline — periods, plan events, session span, the
// lot — for a session whose only sin was delegating a lot of work. 90 KB leaves room for the
// envelope (`sessionId`, the timestamps) and for the difference between a byte count and whatever
// the proxy in front of the API counts.
export const TIMELINE_BODY_BUDGET_BYTES = 90 * 1024;

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

export function buildPeriods(events, options = {}) {
  // Opt-OUT, not opt-in. `break` is a member of CliAgentActivityState, the client renders it as
  // "Session break" and the backend excludes it from activity-breakdown totals; `state` is a
  // bounded string on the DTO precisely so a word a reader does not know cannot 400 the document.
  // A caller that has reason to distrust the deployment can still pass `false` and get the
  // pre-break vocabulary, where a long wait stays `waiting_user`.
  const allowBreakState = options.allowBreakState !== false;
  const markers = validMarkers(options.permissionMarkers);
  const anchors = [];
  for (const event of events) {
    const ts = timestampOf(event);
    if (ts === null) continue;
    anchors.push({ ts, endsTurn: TURN_END_EVENTS.has(event == null ? undefined : event.ev) });
  }
  anchors.sort((a, b) => a.ts - b.ts);

  const merged = [];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1];
    const cur = anchors[i];
    if (cur.ts <= prev.ts) continue;
    const gap = cur.ts - prev.ts;
    let state;
    let subtype = null;
    // WHO WAS WAITING decides the state; how long only ever splits a user wait into `break`.
    //
    // The turn boundary comes FIRST, and that is the fix for the misclassification this module
    // shipped with: the idle threshold used to be tested before it, so any think-time over five
    // minutes stopped being the user's. Sixteen real minutes of a person reading a diff drew as
    // `idle` — which the portal renders as "Subagents working" — in the middle of a session where
    // no subagent was running.
    //
    // Length never moves a gap OUT of the user's column except past BREAK_MS, and length never
    // moves an agent-side gap INTO it: a four-hour background script is the agent waiting, not the
    // human, so it stays `idle` whatever the clock says.
    if (prev.endsTurn) {
      if (allowBreakState && gap >= BREAK_MS) state = STATE.BREAK;
      else {
        state = STATE.WAITING_USER;
        subtype = subtypeFor(markers, prev.ts, cur.ts);
      }
    } else if (gap >= IDLE_GAP_MS) state = STATE.IDLE;
    else state = STATE.WORKING;

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
  const window = dedupe ? dedupe(events).events : events;

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const event of window) {
    const ts = timestampOf(event);
    if (ts === null) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  // Events exist but none is timestamped: that is a writer/reader schema mismatch, not an idle
  // session, and reporting a zero-length timeline would hide it.
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
  // looking at, not the one from four hours ago.
  const periods = buildPeriods(window, options);
  const trimmedPeriods = periods.length > MAX_PERIODS ? periods.slice(-MAX_PERIODS) : periods;
  const capped = spans.length > MAX_SUBAGENTS ? spans.slice(-MAX_SUBAGENTS) : spans;
  const entries = capped.map(toSubagentEntry);

  const timeline = {
    periods: trimmedPeriods,
    plan_events: [],
    subagents: entries,
    started_at: new Date(minTs).toISOString(),
    ended_at: new Date(maxTs).toISOString(),
    generated_at: new Date().toISOString(),
  };

  // Measured against the body the caller actually sends — `sessionId` and all — because the limit
  // that rejects it is counted on the wire, not on the part of it this module happens to own.
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
