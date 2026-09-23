import { listCliSubagents as _listCliSubagents } from './cli-chats-cursor.mjs';

// Subagents for a Cursor CLI session.
//
// The CLI fires neither subagentStart nor subagentStop, and no postToolUse for the Task call that
// spawns a worker (evidence E6), so the sidecar of a CLI session holds no trace of its subagents at
// all. The CLI does persist every worker as its own chat with a back-pointer to the parent
// (`subagentInfo.parentAgentId`), and this module turns those records into the same
// `subagent_start` / `subagent_stop` lines the hooks would have written — at READ time, so sessions
// recorded before this existed are repaired too, and nothing is ever appended out of order.
//
// Only when the stream has no subagent line of its own. An IDE session carries real hook lines; a
// second, disk-derived copy of the same workers would draw every lane twice. The check also means an
// IDE session with delegation never pays for a single chat-store read here.
//
// The stop line carries the worker's `sid`, which a hook stop never does. That is what lets
// lib/subagents-cursor.mjs pair it with its own start (its precedence 0) instead of by LIFO, which
// would swap the ends of two parallel workers that finish out of order. Its time is APPROXIMATE —
// the child store's last write, see listCliSubagents — because the CLI records no end for a worker.
//
// Never throws: this sits on the checkpoint's turn-end path and the timeline builder, and a chat
// store it cannot read is simply a session with no recoverable subagents.

function hasSubagentLines(events) {
  for (const event of events) {
    if (event != null && typeof event.ev === 'string' && event.ev.indexOf('subagent_') === 0) return true;
  }
  return false;
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// Whether a listing that has just returned could have been cut short by the hook deadline. The
// lister answers [] when the deadline has passed at entry and stops between child opens once it
// passes mid-way, and in both cases its answer looks exactly like "this session has fewer workers".
// Measured from the deadline itself, right after the listing, on the same clock the chat-store
// reader uses (`deps.now` when injected, else the wall clock): if the deadline has passed NOW, the
// listing may have been truncated; if it has not, every check inside the listing passed too.
function listingComplete(d) {
  if (typeof d.deadline !== 'number') return true;
  const now = typeof d.now === 'function' ? d.now() : Date.now();
  return now < d.deadline;
}

// Tell the caller whether the lanes it is about to draw are the whole set. Codex review (DO NOT
// SHIP): an exhausted checkpoint's timeline came back with zero lanes and overwrote a queued one-lane
// timeline in the outbox, which a later drain then delivered. Only a caller that KNOWS the listing
// was cut short can refuse to do that. Reported only when the store was actually consulted: a
// stream whose hooks own the lanes left nothing out. A throwing callback is swallowed — this module
// never throws.
function report(d, complete) {
  if (typeof d.onEnrichment !== 'function') return;
  try { d.onEnrichment({ complete }); } catch { /* the caller's problem, never the hook's */ }
}

// `deps` is handed to the lister untouched: `deadline`, `chatsDir` and `sqlite` are the chat-store
// adapter's own seams, and `listCliSubagents` is this module's (a test double for the whole reader).
// `onEnrichment({ complete })` is the caller's, see `report` above.
export function withCliSubagents(sessionId, events, deps) {
  if (!Array.isArray(events) || events.length === 0 || hasSubagentLines(events)) return events;
  // A default parameter does not cover an explicit null, and "never throws" has to.
  const d = deps == null ? {} : deps;
  const list = d.listCliSubagents == null ? _listCliSubagents : d.listCliSubagents;
  let kids;
  try {
    kids = list(sessionId, d);
  } catch {
    // A store that cannot be read is a session with no recoverable workers (the header), not a
    // truncated listing: calling it incomplete would park its timeline until prune, for good.
    report(d, true);
    return events;
  }
  report(d, listingComplete(d));
  if (!Array.isArray(kids) || kids.length === 0) return events;
  const added = [];
  for (const kid of kids) {
    // A record the adapter should never produce is skipped, not repaired: a lane with an invented
    // id or time would be indistinguishable from a real one.
    if (kid == null || nonEmpty(kid.agentId) === null) continue;
    if (!Number.isFinite(kid.startMs) || !Number.isFinite(kid.endMs)) continue;
    const stype = nonEmpty(kid.typeName);
    const toolCallId = nonEmpty(kid.toolCallId);
    // Keys omitted rather than nulled, matching the hook writer (lib/sidecar-events.mjs).
    added.push({
      ts: kid.startMs,
      ev: 'subagent_start',
      sid: kid.agentId,
      ...(stype === null ? {} : { stype }),
      ...(toolCallId === null ? {} : { tool_call_id: toolCallId }),
    });
    added.push({
      ts: kid.endMs,
      ev: 'subagent_stop',
      sid: kid.agentId,
      ...(stype === null ? {} : { stype }),
      status: 'completed',
    });
  }
  // Appended at the end: every consumer (correlateSubagents, buildPeriods, the min/max span) sorts by
  // timestamp, so position in the array means nothing.
  return added.length === 0 ? events : events.concat(added);
}
