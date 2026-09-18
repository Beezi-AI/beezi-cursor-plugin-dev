import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs.
installHookGuards({ name: 'file-edit' });

// Capture, when it is switched on. Free otherwise — see the same block in scripts/tool-event.mjs
// for why it is allowed to sit on a hot path at all, and why it goes above claimHookRun: the record
// is of the run as Cursor started it, not of the work this script decided to do.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records which registry started this run. Always true; nothing is arbitrated in a hook process any
// more. Duplicate lines from a machine running both registries are dropped by the READER, on the
// `eid` the host stamped on the event — see lib/hook-source.mjs and dedupeEvents in
// lib/delta-cursor.mjs.
if (!claimHookRun()) process.exit(0);

// Cursor starts most plugin hooks inside the plugin directory, which is itself a git clone —
// attribute the user's repository, not this one. See lib/hook-cwd.mjs.
enterProjectDir();

// `afterFileEdit` — the only source of code-change data a `cursor-agent` machine has.
//
// This was a capture-only stub, and `code_changes` was near-empty for every CLI user because of it.
// lib/code-changes-cursor.mjs prefers Cursor's `ai-code-tracking.db` and falls back to the sidecar's
// `edit` events — but the database is written by the IDE and is usually ABSENT under `cursor-agent`
// (see that file's header), and the fallback was never fed, because nothing was registered to write
// an `edit` line. So the preferred source was missing, the fallback was empty, and every segment
// reported zero files changed while the agent rewrote the repository. Registering this hook and
// appending its lines is the whole of the fix.
//
// THE HOT PATH RULES APPLY HERE HARDER THAN ANYWHERE. This fires on every file edit the agent makes
// — several per turn — and `old_string`/`new_string` are whatever the model wrote, which for a
// whole-file rewrite of a lockfile or a generated bundle is several megabytes. So: no report engine
// (lib/checkpoint.mjs pulls in ~25 modules, git shell-outs and the network), no SQLite, no network,
// no second read of the payload. Append and exit, inside Cursor's 10s kill deadline.
runHook({
  name: 'file-edit',
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar] = mods;
    // `allowEdits: true` — this script is the ONE caller permitted to open that gate. It defaults to
    // false precisely so that `postToolUse`, which fires for a `Write` tool and whose payload can
    // carry a top-level `file_path`, does not record the same write a second time. See the option's
    // contract in lib/sidecar-events.mjs.
    for (const event of events.eventsFromHookPayload(ctx.payload, { allowEdits: true })) {
      // EDIT LINES ONLY, and the asymmetry is deliberate — it is the other half of the same
      // double-count that `allowEdits` guards.
      //
      // `eventsFromHookPayload` is field-driven: it reads whatever a payload carries, so a `model` on
      // the common hook envelope becomes a `gen` line and a `tool_name` becomes a `tool` line. Cursor
      // stamps that envelope on every hook event, and `postToolUse` ALREADY fired for the tool call
      // that produced this edit and already wrote those lines. A second `tool` line here would not
      // collapse in dedupeEvents — it carries no `tool_output`, so its `bytes` differs from the one
      // postToolUse wrote — and every agent file edit would then be counted twice in the operations
      // breakdown and twice in est_tokens. `afterFileEdit` is registered for exactly one fact that no
      // other event carries, and this is that fact.
      //
      // Whether Cursor even puts `tool_name` on an `afterFileEdit` payload is unverified (nobody has
      // run this against a real install — BEEZI_CURSOR_DUMP_HOOKS answers it). Filtering costs one
      // comparison per event and is correct either way, which is the right trade when the alternative
      // is silently inflating every CLI user's operation count.
      if (event.ev !== 'edit') continue;
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(event, ctx.cwd));
    }
  },
});
