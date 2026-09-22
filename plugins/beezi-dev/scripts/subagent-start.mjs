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

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
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
    // The routing rule — which conversation's sidecar a subagent line belongs in — and the
    // subagent-only filter both live in lib/sidecar-events.mjs, because the stop hook is required to
    // apply the IDENTICAL rule and two copies of one required-identical rule is one copy that
    // eventually is not. Read `appendSubagentEvents` there before changing anything here.
    events.appendSubagentEvents(sidecar, ctx.payload, ctx.input.session_id, ctx.cwd);
  },
});
