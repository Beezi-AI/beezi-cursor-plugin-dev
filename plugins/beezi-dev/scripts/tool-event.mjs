import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs. The sidecar modules this hook needs are loaded below,
// after the handlers exist, so a throw while one of them is being evaluated exits 0 silently instead
// of putting a failed hook in Cursor's log on every tool call the user makes.
installHookGuards({ name: 'tool-event' });

// Capture, when it is switched on. Free otherwise, which is the only reason it is allowed on this
// path: `captureHookStdin` and `dumpHookPayload` each read one environment variable and return.
// Placed here, above claimHookRun, so the record is of the run as Cursor started it and not of the
// work this script decided to do.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// On a machine where both registries fire, this hook really does run twice per tool call, and the
// stand-down this line used to perform rested on guessing which of them was alive: a launcher run
// exited 0 whenever a bundled run had been recorded in the last fortnight. The Cursor CLI does not
// run a plugin's bundled hooks at all (Cursor staff, forum 163890), so on a machine that used both
// the IDE and the CLI, one IDE session switched off every `cursor-agent` hook for two weeks — no
// sidecar line, no segment, no cost, and nothing anywhere saying so.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

// `postToolUse` — the hot path. This fires on EVERY tool call, so it appends to the sidecar and
// exits without ever touching the reporting engine (checkpoint.mjs pulls in ~25 modules, git
// shell-outs and the network). Keep it this small.
//
// The ONE exception is the pulse, and it is an exception that pays for itself. Outside git work this
// is the only event a long turn produces, so a turn that ran for an hour — or was abandoned halfway
// — held every segment it made until `stop` or `sessionEnd` finally came, which on an abandoned
// turn is never. `maybeRunPulse` is one small read on the calls that are not due, and at most one
// checkpoint per fifteen minutes on the one that is. See lib/pulse-cursor.mjs for the interval, the
// claim, and why it must never nest the checkpoint's own lock.
runHook({
  name: 'tool-event',
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
    import('../lib/pulse-cursor.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar, pulse] = mods;
    // The cwd stamp is what lets the login-time backfill attribute a conversation recorded on an
    // unlinked machine — registry-deterministic by contract, see stampableCwd.
    for (const event of events.eventsFromHookPayload(ctx.payload)) {
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(event, ctx.cwd));
    }
    // AFTER the append, always. The pulse checkpoints whatever the sidecar holds right now, so a
    // line written after it would fall outside the window this pulse just closed and wait for the
    // next one.
    return pulse.maybeRunPulse(ctx.input, {}, ctx.remainingMs());
  },
});
