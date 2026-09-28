import { POST_TIMEOUT_MS } from './http.mjs';
import { computeSessionTimeline, postSessionTimeline } from './session-timeline-cursor.mjs';
import {
  dropTimelineOutbox, readTimelineOutbox, timelineSigOf, timelineStatusOf, writeTimelineOutbox,
} from './timeline-outbox.mjs';

// The activity timeline is whole-session, so it's re-derived from the full sidecar and shipped
// only at turn-ends (stop / sessionEnd) — not on the frequent afterShellExecution path. Skip the
// POST when the derived content is identical to the last one we sent (a stop with no new
// activity), so we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must
// never break the checkpoint.
//
// This is the turn-end tail of lib/checkpoint.mjs's `runCheckpoint`, below the state commit. It
// mutates `state` in place (`sentTimelineSig`, `timelineLastStatus`) and leaves persisting it to
// the caller, which owns the state file and knows whether this run may write it back. What it
// returns is what the caller cannot read off `state`:
//
//   timelineDirty       — `state` changed here and wants its own write.
//   timelineOutboxSkip  — the session whose POST this run made and lost (for any reason but a
//                         401), or null. The caller hands it to the flush so the outbox drain
//                         does not repeat that POST moments later.
//
// `isEnrichmentComplete` is a getter, not a boolean, on purpose: `computeSessionTimeline` runs the
// CLI subagent enrichment again through `cliDeps.onEnrichment`, which can clear the flag DURING this
// call. A value captured by the caller would miss exactly that cut-short second listing. `timeLeft`
// is the caller's own budget clock, read at the moment of the POST.
export async function reconcileSessionTimeline({
  sessionId: session_id, dedupedEvents, state, accountStamp, isEnrichmentComplete, cliDeps,
  onSubagentDiagnostics, token, fetchImpl, now, timeLeft, allowBreakState,
}) {
  let timelineDirty = false;
  let timelineOutboxSkip = null;
  try {
    const timeline = computeSessionTimeline(
      session_id,
      dedupedEvents
        // Already collapsed by runCheckpoint, so the collapse here is the identity — this hands
        // over the same array the subagent segments were billed from rather than paying for a
        // second full pass inside the same 7.5 s budget. NOT `dedupeEvents: null`, which that module
        // reads as "no collapse is available" and answers by withholding the subagent list
        // entirely; the two look alike and mean opposite things.
        //
        // `cliDeps` carries the deadline (and the store seams) to the CLI subagent enrichment the
        // timeline runs; on the first branch the array is already enriched and that is a no-op.
        ? { readEvents: () => dedupedEvents, dedupeEvents: (events) => ({ events }), onSubagentDiagnostics, ...cliDeps }
        : { onSubagentDiagnostics, ...cliDeps },
      // GATED (CAPABILITIES.breakState, which lib/checkpoint.mjs passes in). The flag is ON, so a
      // wait on the human past BREAK_MS is labelled `break` rather than `waiting_user`. That module
      // defaults to the same when the argument is omitted (`allowBreakState !== false`); passing it
      // explicitly keeps CAPABILITIES the one switch that can turn it off.
      { allowBreakState },
    );
    if (timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0)) {
      const sig = timelineSigOf(timeline);
      if (sig !== state.sentTimelineSig && !isEnrichmentComplete()) {
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
          // The flush runCheckpoint runs after this drains the outbox too. A 401 is the one
          // failure it should retry straight away, because it can force a token refresh and this
          // POST cannot; anything else would just repeat against the same unhappy server inside
          // the same budget.
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
  return { timelineDirty, timelineOutboxSkip };
}
