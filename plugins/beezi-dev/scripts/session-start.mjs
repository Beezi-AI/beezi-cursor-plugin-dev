import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT. ESM evaluates every static import above before this line, so the four modules
// imported there are the bootstrap — small, dependency-light and long-proven — and lib/session-start
// (the reporting engine, the token store, the network) arrives through `load` below, after the
// handlers exist. See lib/hook-runner.mjs.
installHookGuards({ name: 'session-start' });

// Capture, when it is switched on; two environment reads and a return otherwise. Above claimHookRun
// so the record is of the run as Cursor started it. See lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records which registry started this run — and this is the run the record is FOR: `install
// status`, `me` and the banner below all report which registry has been seen doing the work, and
// "no bundled hook has ever run here" is what tells a CLI-only machine apart from a broken install.
//
// Always true. Both registries stay installed permanently and both fire; the duplicate lines are
// collapsed by the reader on the host's own event id (dedupeEvents in lib/delta-cursor.mjs). The
// stand-down this line used to perform assumed a live bundled registry made the launcher redundant,
// and the Cursor CLI runs no plugin-bundled hook at all (Cursor staff, forum 163890) — so on a
// machine that used both, the queue flush and prune below stopped running under `cursor-agent`
// entirely, for as long as the IDE kept being used. See lib/hook-source.mjs.
if (!claimHookRun()) process.exit(0);

// Cursor starts most plugin hooks inside the plugin directory, which is itself a git clone —
// attribute the user's repository, not this one. See lib/hook-cwd.mjs.
enterProjectDir();

runHook({
  name: 'session-start',
  stdin,
  // lib/session-start.mjs reaches the checkpoint graph, the credential store and the network, and
  // any of those can throw while being evaluated. Dynamic, so that failure is a contained exit 0
  // rather than a failed hook in Cursor's execution log on every session the user opens.
  load: () => import('../lib/session-start.mjs'),
  handle: (mod, ctx) =>
    mod.runSessionStart(ctx.input).then((msg) => {
      // The banner is the only stdout this plugin emits, and it is best-effort: Cursor forum #155689
      // reports that a hook's return value is validated and then dropped, so nothing may depend on
      // it. Routed through ctx.emit so the runner owns the stream — see lib/hook-runner.mjs.
      if (msg) ctx.emit({ systemMessage: msg });
    }),
});
