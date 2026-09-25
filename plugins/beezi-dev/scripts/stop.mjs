import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs. lib/checkpoint.mjs used to be a STATIC import here, so
// a module anywhere in its ~25-module graph that threw while being evaluated took the whole hook
// down before a single line of this file ran: no turn boundary, no generation, no checkpoint, and a
// failed hook in Cursor's log at the end of every turn.
installHookGuards({ name: 'stop' });

// Capture, when it is switched on; two environment reads and a return otherwise. Above claimHookRun
// so the record is of the run as Cursor started it. This is the payload the model and the turn's
// token counts arrive on and nowhere else, so it is the one capture has most to confirm. See
// lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// This hook is the worst place the old stand-down could have fired, and under a `cursor-agent`
// build that runs no bundled hook (Cursor staff, forum 163890; 2026.09.18 does run them) it fired
// here every time, so a launcher that stood down because an IDE session had been recorded took the
// turn's token counts, the turn boundary and the checkpoint with it.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

runHook({
  name: 'stop',
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
    import('../lib/checkpoint.mjs'),
    import('../lib/stop-account-change.mjs'),
  ]),
  handle: async (mods, ctx) => {
    const [events, sidecar, engine, account] = mods;

    // The turn's generation, with the model and the token counts Cursor puts on this payload and on
    // no other event this plugin registers. Without it a turn that ran no tools — a plain question,
    // the "Ping request" case — reaches the API as `models: {}` with zeroed tokens, because
    // `postToolUse` (the only other producer of a `gen` line) never fired. Written before the
    // boundary marker so the generation belongs to the turn that is ending, and before the
    // checkpoint so it lands inside the segment that turn produced.
    for (const event of events.eventsFromHookPayload(ctx.payload)) {
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(event, ctx.cwd));
    }

    // The turn boundary itself. Nothing else in the plugin writes one — `postToolUse` only ever
    // derives gen/tool/shell/edit — so without this line `session-timeline-cursor` has no anchor
    // that ends a turn and can never classify the gap that follows as `waiting_user`.
    //
    // Written BEFORE the checkpoint, deliberately:
    //   - the checkpoint re-derives the whole-session timeline from the sidecar, so appending first
    //     is what puts this boundary in the timeline THIS hook ships rather than the next one's —
    //     and for the last turn of a session there is no next one;
    //   - the delta window closes at the sidecar's current length, so appending first keeps the
    //     boundary inside the segment that just ended. Appending after would carry it into the next
    //     window and bill the user's think-time gap as that segment's duration;
    //   - `runCheckpoint` may reject, be budget-truncated or be killed at the host's hook deadline,
    //     and a boundary written after it would then be lost for good.
    sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd({ ev: 'stop' }, ctx.cwd));

    // Cursor subscription change detection (plan §4 Phase C). Reads Cursor's own account tuple out
    // of state.vscdb, compares it against billing.json's anchor and, when something moved,
    // reconciles the record and sends one forced, inline, budget-bounded check-in. The steady state
    // — nothing moved — is a single small read and no writes at all. See lib/stop-account-change.mjs
    // for why this is a plain read rather than an mtime tripwire, why the check-in is not queued,
    // and what happens to `ctx.payload.user_email` (nothing that outlives one comparison).
    //
    // AFTER the boundary append and BEFORE the checkpoint, and wrapped in a try/catch of its own.
    // `runStopAccountCheck` already contains every failure internally, so this is the second fence
    // rather than the first: an await that threw out of `handle` would reach runHook's catch as
    // `hook_crash` and the checkpoint — the thing the user is actually here for — would never run.
    // A subscription reading one turn late is a cost nobody notices; a lost turn of analytics is.
    try {
      await account.runStopAccountCheck(ctx);
    } catch { /* the user's checkpoint is not forfeit to an account read */ }

    // Turn-end: emit the whole-session activity timeline alongside the segment checkpoint. The
    // timeline rides on `stop` rather than on `afterAgentResponse` / `afterAgentThought`: staff said
    // those never fire in the `cursor-agent` CLI, and although receptron/mulmoterminal#2064 saw them
    // fire in the interactive CLI on 2026.09.10, headless `agent -p` still does not. `stop` fires
    // in both.
    //
    // The REMAINING budget, because this is the hook that flushes the queue: a backlog against a
    // stalled API costs one per-request timeout per report, and the appends above have already spent
    // part of the deadline. Whatever does not fit stays queued for the next turn.
    return engine.runCheckpoint(ctx.input, {}, { emitTimeline: true, budgetMs: ctx.remainingMs() });
  },
});
