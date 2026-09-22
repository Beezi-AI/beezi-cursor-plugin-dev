import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs. As in scripts/stop.mjs, lib/checkpoint.mjs was a static
// import here and its evaluation was therefore unprotected; unlike stop, this hook has no next
// chance, so a throw during that import lost the conversation's final segment outright.
installHookGuards({ name: 'report' });

// Capture, when it is switched on; two environment reads and a return otherwise. Above claimHookRun
// so the record is of the run as Cursor started it. See lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// A stand-down here was unrecoverable rather than merely lossy: `sessionEnd` is the LAST checkpoint
// a conversation gets, so a run that exited 0 because some IDE session had been recorded left that
// conversation's final segment in the sidecar with nothing ever coming back for it. Under
// `cursor-agent`, where no bundled hook runs at all (Cursor staff, forum 163890), that was every
// session on the machine.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

// `sessionEnd` — the final checkpoint for a conversation. Cursor genuinely implements this event
// (Codex declares it and silently drops the entry, which is why the Codex fork has no such script).
// It is the last chance to attribute a conversation whose final turn produced no shell command, and
// the last chance to drain the queue before the session is gone.
runHook({
  name: 'report',
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar.mjs'),
    import('../lib/checkpoint.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [sidecar, engine] = mods;
    // Closes the last turn — same boundary contract as `stop`, and for the same reason written
    // before the checkpoint: this is the LAST checkpoint the conversation will ever get, so a line
    // appended after it would sit in the sidecar that nothing ever reports again.
    sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd({ ev: 'session_end' }, ctx.cwd));
    return engine.runCheckpoint(ctx.input, {}, { emitTimeline: true, budgetMs: ctx.remainingMs() });
  },
});
