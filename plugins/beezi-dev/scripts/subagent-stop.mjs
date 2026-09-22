import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs.
installHookGuards({ name: 'subagent-stop' });

// `subagentStop` — the closing half of the pair `subagent-start.mjs` opens.
//
// It carries the worker's duration, its outcome and its message/tool/loop counts. What it does NOT
// carry is a `subagent_id`: that is a CONFIRMED HOST BUG, still open, and it means there is no join
// key back to the start event at all. Correlation is therefore a read-time heuristic over the whole
// stream (lib/subagents-cursor.mjs), and the counts recorded here are load-bearing for a second
// reason — they are the only entropy that keeps two workers finishing in the same second from
// collapsing into one line in the reader's duplicate check. See lib/sidecar-events.mjs.
//
// It also carries no token usage: Cursor exposes no per-subagent spend anywhere, so a delegated
// turn's cost is only ever visible inside the parent's own `stop` totals. Nothing here may pretend
// otherwise by zeroing a field the host never sent.
//
// Not a permission hook, so unlike `subagent-start.mjs` a non-zero exit here would merely be logged
// rather than able to block anything. It still writes nothing to the standard output stream —
// Cursor forum #155689 reports that a hook's return value is validated and then dropped, so there is
// nothing to be gained by writing one and a hook-shaped failure to be had by writing it wrong.

// Read stdin once, for the dump and for the hook, before anything can consume it. Returns null and
// touches nothing unless BEEZI_CURSOR_DUMP_HOOKS is set — see lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
if (!claimHookRun()) process.exit(0);

// Cursor starts most plugin hooks inside the plugin directory, which is itself a git clone — and
// `stop`/`subagentStop` are the two Cursor starts in the workspace folder instead, so this call is
// a no-op here rather than a correction. It stays because "which hook runs where" is Cursor's
// choice to change, and because the launcher-invoked path inherits whatever directory the hook
// runner happened to use. See lib/hook-cwd.mjs.
enterProjectDir();

// Cursor pipes the payload in, and on Windows through a PowerShell pipeline
// (lib/hook-input-cursor.mjs); a hook that exits without draining that pipe leaves the writer with a
// broken one, which Cursor's execution log shows as a failed hook. The runner performs that read.
runHook({
  name: 'subagent-stop',
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar] = mods;
    // The same routing rule as the start hook, and it must stay the same rule: both halves of one
    // span have to land in the same conversation's sidecar or the correlation in
    // lib/subagents-cursor.mjs cannot see them together. That is why it is one function in
    // lib/sidecar-events.mjs rather than a copy here — see `appendSubagentEvents`, which also
    // carries the note on why a stray `tool`/`gen` line from this payload is filtered out.
    events.appendSubagentEvents(sidecar, ctx.payload, ctx.input.session_id, ctx.cwd);
  },
});
