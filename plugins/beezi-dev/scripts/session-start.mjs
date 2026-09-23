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

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// The stand-down this line used to perform assumed a live bundled registry made the launcher
// redundant, and the Cursor CLI then ran no plugin-bundled hook at all (Cursor staff, forum 163890;
// 2026.09.18 does) — so on a machine that used both, the queue flush and prune below stopped
// running under `cursor-agent` entirely, for as long as the IDE kept being used.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

runHook({
  name: 'session-start',
  stdin,
  // lib/session-start.mjs reaches the checkpoint graph, the credential store and the network, and
  // any of those can throw while being evaluated. Dynamic, so that failure is a contained exit 0
  // rather than a failed hook in Cursor's execution log on every session the user opens.
  load: () => import('../lib/session-start.mjs'),
  // `sessionStartLine` is the timeline's first sidecar anchor. Its `ts` is the runner's occurrence
  // instant (an ISO string, so parsed back to the epoch ms every sidecar line carries), taken before
  // runSessionStart spends seconds on the token and the network; its `cwd` is the stampable one
  // every other hook stamps, so the two registries' copies collapse. See lib/session-start.mjs.
  handle: (mod, ctx) =>
    mod.runSessionStart(ctx.input, {
      sessionStartLine: { ts: Date.parse(ctx.occurredAt), cwd: ctx.cwd },
    }).then((msg) => {
      // The banner is the only stdout this plugin emits, and it is best-effort: Cursor forum #155689
      // reports that a hook's return value is validated and then dropped, so nothing may depend on
      // it. Routed through ctx.emit so the runner owns the stream — see lib/hook-runner.mjs.
      if (msg) ctx.emit({ systemMessage: msg });
    }),
});
