import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// SAFETY-CRITICAL: this script must never write to the standard output stream and must never exit
// non-zero.
//
// `subagentStart` is a PERMISSION hook, exactly like `beforeMCPExecution`. Cursor reads a successful
// run's output as JSON, so a `{"permission":"deny"}` there refuses to start a subagent the user
// asked for; exit 2 blocks it outright, and any other non-zero code logs a failed hook. An analytics
// plugin has no business expressing an opinion on either, so it expresses none: nothing written on
// any path, and exit 0 on every one.
//
// `installHookGuards` is the FIRST STATEMENT so that nothing after it — including a throw while one
// of the business modules below is being evaluated — escapes as an exit 1 with a stack trace in
// Cursor's execution log. `permission: true` selects the immediate fail-open path: no dispatcher
// drain, no network, no telemetry flush, five-second host budget. See lib/hook-runner.mjs.
installHookGuards({ name: 'subagent-start', permission: true });

// `subagentStart` — one sidecar line per delegated worker.
//
// This event is where the parent/child relationship comes from. A subagent's own tool calls do fire
// `postToolUse`, so its activity lands in the sidecar — but flat, with nothing saying it belongs to a
// delegated task, which is why a session that fans out to five workers used to read as one long turn
// with a strange tool mix. The line written here is the start of the span
// lib/subagents-cursor.mjs correlates, and the span is what fills five portal surfaces that sit empty
// for every Cursor user today.
//
// Read the confirmed host bugs in lib/sidecar-events.mjs before touching the event builder: the stop
// event carries no id to join on, `subagent_type` is always "general-purpose", and a background
// worker never reports a stop at all.

// Read stdin once, for the dump and for the hook, before anything can consume it. Returns null and
// touches nothing unless BEEZI_CURSOR_DUMP_HOOKS is set — see lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records which registry started this run, for the status surfaces. Always true; nothing is
// arbitrated in a hook process any more — a machine with both registries writes both lines and the
// reader collapses them (dedupeEvents in lib/delta-cursor.mjs). See lib/hook-source.mjs.
if (!claimHookRun()) process.exit(0);

// Cursor starts most plugin hooks inside the plugin directory, which is itself a git clone —
// attribute the user's repository, not this one. See lib/hook-cwd.mjs.
enterProjectDir();

// Draining the pipe is not optional even when the result is unused: a permission hook that exits
// without reading the pipe Cursor is writing to leaves the writer with a broken one, and on Windows
// that surfaces as a PowerShell error in the execution log. The runner reads it once.
runHook({
  name: 'subagent-start',
  permission: true,
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar] = mods;
    // WHICH CONVERSATION'S SIDECAR. `parent_conversation_id` wins over the payload's own session id.
    //
    // Only a TOP-LEVEL `stop` / `sessionEnd` ever checkpoints, and a checkpoint reads exactly one
    // conversation's sidecar. If Cursor stamps this payload with the CHILD's id, the line lands in a
    // file nothing will ever flush — the subagent is recorded, perfectly, into a void. Routing to the
    // parent is what makes the span reachable by the hook that reports it. When the two are the same
    // id (or the parent field is absent, which is the documented shape today) this is a no-op.
    //
    // The stop hook applies the identical rule, so both halves of a span land in the same file. When
    // the stop payload carries no parent field and its session id IS the child's, the two halves land
    // apart — the start stays open and is closed synthetically, which is the designed fallback rather
    // than a lost worker. Whether that happens is a capture-session question, not a design one.
    const payload = ctx.payload;
    const parent =
      payload == null ? undefined
        : payload.parent_conversation_id != null ? payload.parent_conversation_id
          : payload.parentConversationId;
    const target = typeof parent === 'string' && parent !== '' ? parent : ctx.input.session_id;
    // Subagent lines ONLY. `eventsFromHookPayload` is field-driven and this payload can carry a
    // `tool_name` or a `model` too — emitting those would write a second `tool`/`gen` line for a call
    // `postToolUse` has already recorded, and because the two lines differ in content (this one has no
    // bytes and no timing) the reader's duplicate collapse cannot merge them. That double-counts the
    // parent's operations and its request count for every delegation.
    for (const event of events.eventsFromHookPayload(payload)) {
      if (typeof event.ev === 'string' && event.ev.startsWith('subagent_')) {
        sidecar.appendEvent(target, sidecar.withCwd(event, ctx.cwd));
      }
    }
  },
});
