import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs.
installHookGuards({ name: 'checkpoint' });

// Capture, when it is switched on; two environment reads and a return otherwise. Above claimHookRun
// so the record is of the run as Cursor started it. See lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// What used to be here stood a launcher down whenever a bundled run had been recorded in the last
// fortnight, which under `cursor-agent` meant always and wrongly: the CLI runs no plugin-bundled
// hook at all (Cursor staff, forum 163890), so the branch-boundary checkpoint below simply stopped
// happening there.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

// `afterShellExecution`. Cursor supplies `command` directly, so there is no dual-surface
// `tool_input` parsing to do here — the Codex fork needed a JS-program regex for the same guard.
runHook({
  name: 'checkpoint',
  stdin,
  load: () => Promise.all([
    import('../lib/hook-input-cursor.mjs'),
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [hookInput, events, sidecar] = mods;
    // The shell call is recorded either way: a segment's operation counts are built from the
    // sidecar, so dropping non-checkpoint commands here would lose them permanently. The cwd stamp
    // is what lets the login-time backfill attribute a conversation recorded on an unlinked machine.
    for (const event of events.eventsFromHookPayload(ctx.payload)) {
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(event, ctx.cwd));
    }

    // Only checkpoint on branch-boundary git commands (commit / switch / checkout) — those are the
    // moments a session's activity needs attributing before the branch changes underfoot.
    const commands = hookInput.shellCommandsOf(ctx.payload);
    if (!commands.some(hookInput.isGitCheckpointCommand)) return null;

    // Imported past the guard on purpose: this hook is registered against every shell execution, and
    // the checkpoint engine pulls in ~25 modules that all but a few invocations discard. Inside the
    // handler, so a throw while that graph is being evaluated is contained rather than reported to
    // Cursor as a failed hook.
    return import('../lib/checkpoint.mjs').then((engine) =>
      // The remaining hook deadline, not a fresh full budget: node's startup and the sidecar append
      // above have already been spent, and an overrun here fails a hook in the middle of the user's
      // work.
      engine.runCheckpoint(ctx.input, {}, { budgetMs: ctx.remainingMs() }));
  },
});
