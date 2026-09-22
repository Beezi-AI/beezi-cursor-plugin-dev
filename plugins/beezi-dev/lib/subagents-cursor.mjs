// Subagent spans for one Cursor conversation, correlated at READ time from the sidecar's
// `subagent_start` / `subagent_stop` lines.
//
// THE CENTRAL PROBLEM, and it is the host's: `subagentStop` carries NO `subagent_id`. It is a
// CONFIRMED HOST BUG (see lib/sidecar-events.mjs, which records the payloads verbatim and refuses to
// invent the field). `subagentStart` has an id, `subagentStop` has nothing to join on, so there is
// no key anywhere that pairs the two halves of one worker. Everything below is the consequence of
// that: correlation here is a heuristic with named failure modes, not a lookup.
//
// WHY READ TIME. Nothing about a subagent is persisted, no cursor is kept and no correlation state
// is written. The session timeline is whole-session by contract — re-derived from the entire sidecar
// on every checkpoint and upserted by `sessionId` — so a guess made from a partial stream is
// re-made, and corrected, from the fuller stream next time. A start that had to be closed
// synthetically in one window is closed for real in the next one, with no migration and nothing to
// invalidate. Write-time correlation would have to be right the first time, from inside a hook that
// sees one event and has no idea what else is open.
//
// WHAT IS NOT AVAILABLE, all confirmed host bugs, none of which may be "fixed" by reaching for the
// documented field — it is not there:
//   • no per-subagent token usage anywhere in Cursor, so a span carries time and identity only;
//   • `subagent_type` always reads "general-purpose" whatever actually ran (forum 156647), so
//     `agent_type` is recorded as what the host said and is never used to tell two workers apart;
//   • `agent_transcript_path` is always null — there is no sub-transcript to read, ever;
//   • `description` on the stop event holds the PARENT's task title, so it is not read here;
//   • a BACKGROUND subagent fires `subagentStart` and never fires `subagentStop` (forum 166681).
//     A start with no stop is the normal case, not a dropped event, and nothing here waits for the
//     pair.
//
// Pure and dependency-free on purpose: this is the one module in the subagent path with no I/O, no
// clock of its own and no host imports, so its failure modes are testable by construction. The
// caller hands it an event array — deduped, see the note on correlateSubagents — and gets spans and
// diagnostics back.

const START_EVENT = 'subagent_start';
const STOP_EVENT = 'subagent_stop';

// How long an unclosed subagent may be assumed to still be running. Background workers never report
// a stop, so without a cap one background start would stretch its lane to the end of a session that
// ran for hours after the worker had finished — a bar that says "this agent ran for six hours" is a
// worse lie than a bar that says "at least thirty minutes". Thirty minutes is chosen to be longer
// than essentially every real subagent and shorter than a working day.
export const SYNTHETIC_CLOSE_MS = 30 * 60 * 1000;

// The backend's column widths. Exceeding either is a validation failure that rejects the WHOLE
// timeline — periods included — so they are enforced here, at the point the value is produced,
// rather than trusted to whatever assembles the payload.
export const MAX_AGENT_ID_CHARS = 200;
export const MAX_AGENT_TYPE_CHARS = 100;

// What `agent_type` says when the host said nothing at all. Deliberately NOT "general-purpose":
// that string is the value of a host bug, and writing it ourselves when Cursor sent nothing would
// make a fabricated value indistinguishable from a reported one the day the bug is fixed.
export const UNKNOWN_AGENT_TYPE = 'unknown';

// The writer may stamp epoch millis, epoch seconds or an ISO string; all three are accepted so a
// change of convention costs nothing.
//
// It lives HERE, in the dependency-free module, and lib/session-timeline-cursor.mjs re-exports it.
// The timeline needs it and so does this file, and the timeline imports this file — putting the
// implementation the other way round would make the two modules a cycle. That used to be an outright
// deadlock, because the timeline reached its siblings through a top-level `await import`; those are
// static imports now (Node 13.2 has no top-level await), so a cycle would degrade to a TDZ error on
// whichever binding was read first instead. Neither is a style problem, and this direction avoids
// both.
export function timestampOf(event) {
  const raw = event == null ? undefined : (event.ts == null ? event.timestamp : event.ts);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Anything below ~2001 in millis is far more plausibly a seconds stamp.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function trimmedString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// The most recent activity of ANY kind in the stream. This is the ceiling on a synthetic close: the
// parent's own tool calls and generations are the evidence that the session was still alive, and a
// background worker cannot be assumed to have outlived the last thing that happened in the
// conversation it belongs to.
function lastActivityOf(events) {
  let last = null;
  for (const event of events) {
    const ts = timestampOf(event);
    if (ts !== null && (last === null || ts > last)) last = ts;
  }
  return last;
}

// Which still-open start does this stop belong to?
//
// PRECEDENCE, and the reasoning for the order:
//   1. Exact `task` match. Primary because a parallel fan-out gets distinct tasks BY CONSTRUCTION —
//      that is what makes a fan-out a fan-out — so on the case that actually breaks LIFO (several
//      workers open at once, finishing out of order) the task string is exactly the discriminator
//      the missing id would have been.
//   2. The sole open start. With one candidate there is nothing else it could be, whatever the
//      strings say.
//   3. LIFO among the candidates, flagged `ambiguous`. Only reachable on a genuine task collision
//      (two workers given the identical task) or on a stop that carried no task at all. The failure
//      mode is a SWAPPED LABEL between two agents that both really ran — not a lost agent and not a
//      duplicated one — which is the direction to fail in: the gantt keeps the right number of lanes
//      with the right spans, and only which name sits on which lane is a coin toss.
//   4. Nothing open — an orphan stop. Dropped and counted; see the note at the call site.
//
// Returns { index, ambiguous } or null.
function matchOpenStart(open, stopTask) {
  if (stopTask !== null) {
    const candidates = [];
    for (let i = 0; i < open.length; i++) if (open[i].task === stopTask) candidates.push(i);
    if (candidates.length === 1) return { index: candidates[0], ambiguous: false };
    // More than one open start carries this exact task: LIFO, and say so. Nothing in the payload can
    // do better — this is the collision the missing `subagent_id` leaves behind.
    if (candidates.length > 1) return { index: candidates[candidates.length - 1], ambiguous: true };
  }
  if (open.length === 0) return null;
  if (open.length === 1) return { index: 0, ambiguous: false };
  return { index: open.length - 1, ambiguous: true };
}

// A stable, deterministic id for a span.
//
// Stability is not cosmetic: the timeline is re-derived and re-upserted on every checkpoint, and the
// portal keys its gantt lanes and its Subagents card on `agent_id`. An id that changed between two
// derivations of the same session would draw the same worker twice, once per checkpoint, for the
// life of the conversation. So the id is a function of the start event alone — never of the position
// in the output, never of the wall clock, never of a counter that depends on how much of the stream
// happened to be readable this time.
function agentIdFor(span, used) {
  // `sid` is the host's own id and the only one that survives a re-read verbatim. `tool_call_id`
  // names the Task call that spawned the worker, which is just as stable. The last resort encodes
  // the start timestamp, which is a fact about the event rather than about this derivation.
  const base = span.sid == null
    ? (span.toolCallId == null ? `sa-${span.startedMs}` : span.toolCallId)
    : span.sid;
  // Whitespace collapsed to a single space, because Cursor's own ids CONTAIN A NEWLINE: a live
  // `subagent_start` carries `sid` (and `tool_call_id`, and `eid`) as the tool call id, a LF, and
  // the function-call id — "call-07fdcd0c-…-3\nfc_2d0c19a8-…_0". The id is not just displayed, it
  // is half of the report segment's idempotency key, so it travels through a queue filename, an
  // HTTP body and a database column; a raw control character in it is the sort of thing that
  // survives every layer until one of them silently mangles it. Collapsing keeps the whole value —
  // both halves still distinguish two workers — and makes it a single line.
  const head = base.replace(/\s+/g, ' ').slice(0, MAX_AGENT_ID_CHARS);
  if (!used.has(head)) {
    used.add(head);
    return head;
  }
  // Two distinct starts that hash to the same id — same millisecond, neither carrying an id of its
  // own. Suffixed rather than dropped: they are two real workers, and merging them would under-count
  // a fan-out. Still deterministic, because the walk is in stream order.
  for (let n = 2; ; n++) {
    const suffix = `#${n}`;
    const candidate = `${head.slice(0, MAX_AGENT_ID_CHARS - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

// Correlate a conversation's subagent events into spans.
//
// `events` MUST already be deduped. On a machine with both hook registries installed — which is now
// every machine, since the write-time stand-down was removed — one `subagentStart` fires twice and
// writes two sidecar lines about seven milliseconds apart. Correlating the raw stream would open two
// starts and close them with two stops, and every subagent on every machine would appear twice: two
// lanes on the gantt, two rows on the Subagents card, double the wall clock into the interval union.
// Deduping is the caller's job because the caller (lib/session-timeline-cursor.mjs) also needs the
// deduped array for its periods and must not parse and collapse the same file twice in one hook.
//
// Returns { subagents, diagnostics }:
//   subagents   ascending by start. Each span is
//               { agent_id, agent_type, started_at, ended_at, started_ms, ended_ms,
//                 task, ambiguous, synthetic }.
//               `started_ms` / `ended_ms` are the half-open [start, end) pair the interval union in
//               lib/active-time.mjs consumes; the ISO strings are what the timeline DTO ships.
//   diagnostics { starts, stops, matched, ambiguous, orphaned, synthetic, undated }.
//               Returned rather than logged so the failure modes above are OBSERVABLE. Every one of
//               them is silent by nature — a swapped label looks like a correct one, and an orphan
//               stop looks like a session that never delegated.
export function correlateSubagents(events, options = {}) {
  const diagnostics = {
    starts: 0,
    stops: 0,
    matched: 0,
    ambiguous: 0,
    orphaned: 0,
    synthetic: 0,
    undated: 0,
  };
  if (!Array.isArray(events) || events.length === 0) return { subagents: [], diagnostics };

  const maxOpenMs = Number.isFinite(options.maxOpenMs) ? options.maxOpenMs : SYNTHETIC_CLOSE_MS;
  const lastActivityMs = Number.isFinite(options.lastActivityMs)
    ? options.lastActivityMs
    : lastActivityOf(events);

  // Sorted by timestamp, ties broken by stream order. The sidecar is appended by concurrent hook
  // processes, so two events can share a millisecond and arrive in either physical order; the
  // stream order is the only tie-break that is stable across re-reads.
  const marks = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const ev = event == null ? undefined : event.ev;
    if (ev !== START_EVENT && ev !== STOP_EVENT) continue;
    const isStart = ev === START_EVENT;
    if (isStart) diagnostics.starts += 1;
    else diagnostics.stops += 1;
    const ts = timestampOf(event);
    if (ts === null) {
      // Undated: it cannot be placed on a time axis at all, and a span with an invented start would
      // be a bar drawn at a time nothing happened. Counted, so a writer that stops stamping `ts` is
      // visible as something other than "this user stopped delegating".
      diagnostics.undated += 1;
      continue;
    }
    marks.push({ isStart, ts, order: i, event });
  }
  if (marks.length === 0) return { subagents: [], diagnostics };
  marks.sort((a, b) => a.ts - b.ts || a.order - b.order);

  const open = [];
  const closed = [];
  for (const mark of marks) {
    if (mark.isStart) {
      open.push({
        sid: trimmedString(mark.event.sid),
        toolCallId: trimmedString(mark.event.tool_call_id),
        stype: trimmedString(mark.event.stype),
        task: trimmedString(mark.event.task),
        parallel: mark.event.parallel === true,
        startedMs: mark.ts,
        order: mark.order,
      });
      continue;
    }

    const match = matchOpenStart(open, trimmedString(mark.event.task));
    if (match === null) {
      // An orphan stop: a completion with no start anywhere in front of it. Dropped rather than
      // turned into a span, because the only thing it could produce is a bar whose start is a guess
      // (`duration_ms` is present on some payloads and absent on others, and a span invented from a
      // duration nobody sent would be indistinguishable from a real one). In practice this means the
      // start was written to a DIFFERENT sidecar file — see the routing note in
      // scripts/subagent-start.mjs — so counting them is how that shows up.
      diagnostics.orphaned += 1;
      continue;
    }
    const span = open.splice(match.index, 1)[0];
    // Clamped, not trusted: a stop stamped before its own start is clock skew between two hook
    // processes, and a negative-width bar is a rendering bug in five dashboards rather than a fact.
    span.endedMs = Math.max(span.startedMs, mark.ts);
    span.stopStype = trimmedString(mark.event.stype);
    span.ambiguous = match.ambiguous;
    span.synthetic = false;
    if (match.ambiguous) diagnostics.ambiguous += 1;
    diagnostics.matched += 1;
    closed.push(span);
  }

  // Everything still open never reported a stop. That is the normal end of a BACKGROUND subagent
  // (confirmed host bug, forum 166681), not a dropped event.
  //
  // DECISION: these ARE emitted, with a synthesized close. The alternative — emit only correlated
  // pairs — would make every background subagent permanently invisible, and background subagents are
  // exactly the delegation a user cannot see any other way: they leave no bar, no lane and no row,
  // and the Subagents card would confidently show "none" for a session that ran six of them. A span
  // whose end is a bounded estimate is wrong by minutes; an omitted span is wrong by the whole
  // feature. The estimate is also self-correcting: the timeline is rebuilt and re-sent every
  // checkpoint, so a real stop arriving in a later window replaces the synthetic close on the same
  // `agent_id`, and the dedupe signature in lib/checkpoint.mjs already covers `subagents`, so the
  // corrected timeline is actually sent rather than skipped as unchanged.
  for (const span of open) {
    const capped = span.startedMs + maxOpenMs;
    const end = lastActivityMs === null ? span.startedMs : Math.min(lastActivityMs, capped);
    span.endedMs = Math.max(span.startedMs, end);
    span.ambiguous = false;
    span.synthetic = true;
    diagnostics.synthetic += 1;
    closed.push(span);
  }

  closed.sort((a, b) => a.startedMs - b.startedMs || a.order - b.order);

  const used = new Set();
  const subagents = closed.map((span) => ({
    agent_id: agentIdFor(span, used),
    // The start's type wins; the stop's is the fallback for a start that carried none. Both are
    // "general-purpose" today whatever ran — a confirmed host bug — and it is shipped anyway,
    // because the field becomes correct for free the day Cursor fixes it.
    agent_type: (span.stype == null
      ? (span.stopStype == null ? UNKNOWN_AGENT_TYPE : span.stopStype)
      : span.stype).slice(0, MAX_AGENT_TYPE_CHARS),
    started_at: new Date(span.startedMs).toISOString(),
    ended_at: new Date(span.endedMs).toISOString(),
    started_ms: span.startedMs,
    ended_ms: span.endedMs,
    task: span.task,
    parallel: span.parallel,
    ambiguous: span.ambiguous,
    synthetic: span.synthetic,
  }));

  return { subagents, diagnostics };
}

// The [startMs, endMs) pairs for a correlated span list, for lib/active-time.mjs.
//
// Separate from correlateSubagents so the billing path never has to know the DTO shape and the DTO
// path never has to know about interval arithmetic. Zero-width spans are dropped: a subagent that
// started and had nothing after it bills no seconds, and an empty interval in a union is noise the
// merge would have to filter anyway.
export function subagentIntervals(subagents) {
  const out = [];
  for (const span of subagents == null ? [] : subagents) {
    if (span != null && Number.isFinite(span.started_ms) && Number.isFinite(span.ended_ms) && span.ended_ms > span.started_ms) {
      out.push([span.started_ms, span.ended_ms]);
    }
  }
  return out;
}
