import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// SAFETY-CRITICAL: this script must never write to the output stream and must never exit non-zero.
//
// `beforeMCPExecution` is a PERMISSION hook. Cursor reads a successful run's output as JSON and
// obeys it, so a stray `{"permission":"deny"}` — or anything it can coerce into one — blocks a tool
// call the user asked for, inside their editor, with no explanation. The exit code carries the same
// authority: 0 means "success, read my output", 2 means "block the action", and anything else means
// "the hook failed" and the action proceeds (fail-open) unless the entry declares `failClosed`.
//
// Both are pinned. Nothing below writes anything — not on a valid payload, not on a malformed one,
// not on an internal throw — and the process leaves by exit 0 on every path. `installHookGuards`
// is the FIRST STATEMENT so that nothing after it escapes, and `permission: true` is what tells the
// runner to take the immediate fail-open path: no dispatcher drain, no network, no telemetry flush,
// and a five-second host budget instead of the analytics ten (lib/hook-runner.mjs).
installHookGuards({ name: 'mcp-before', permission: true });

// `beforeMCPExecution` — the ONLY place an MCP server's identity is observable.
//
// `postToolUse` already fires for MCP tools, so the calls themselves are counted; what it does not
// say is WHICH server answered — and "the user spent 40% of this session in the Linear MCP" is the
// whole value of the feature. This event sees the call before it is dispatched, and its payload is
// `{tool_name, tool_input}` plus EITHER `{url}` for a remote server OR `{command}` for a stdio one.
// There is no server NAME field in it at all; lib/mcp-identity.mjs is the derivation, and its header
// explains why a null answer from it is a result rather than a failure.
//
// What lands in the sidecar is one `mcp_server` line: the tool name, the derived server, and the
// call id to join on. NO `bytes`, NO `ms`, nothing any counter reads — see mcpServerEvent in
// lib/sidecar-events.mjs. A countable line here would report every MCP call twice, once from this
// hook and once from `postToolUse`.
//
// The raw `url`/`command` NEVER travels. A stdio server's argv routinely carries its own credentials
// (`npx some-mcp --api-key sk-…`) and a remote server's URL can carry a token in its query string;
// the sidecar is a plain-text file that outlives the session, so the caller derives the name and the
// input is dropped here.
//
// `afterMCPExecution` is deliberately NOT registered anywhere: `postToolUse` already fires for MCP
// tools, so a second handler on the completion side would count every MCP call twice.
//
// Unverified in the `cursor-agent` CLI — staff have confirmed sessionStart, sessionEnd, stop,
// postToolUse, beforeShellExecution, afterShellExecution and afterFileEdit there, and said nothing
// about this one. That is why the reader keeps its fallback: `mcpServerOf` in
// lib/operations-cursor.mjs still infers a server from the flattened tool name for every tool this
// hook has not named, and stays the only path at all if this event never fires.

// Read stdin once, for the dump and for the hook, before anything can consume it. Returns null and
// touches nothing unless BEEZI_CURSOR_DUMP_HOOKS is set — see lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records which registry started this run, for the status surfaces. Always true; nothing is
// arbitrated in a hook process any more. See lib/hook-source.mjs.
if (!claimHookRun()) process.exit(0);

// Cursor starts most plugin hooks inside the plugin directory, which is itself a git clone —
// attribute the user's repository, not this one. See lib/hook-cwd.mjs.
enterProjectDir();

// Draining the pipe is not optional: a permission hook that exits without reading the pipe Cursor is
// writing to leaves the writer with a broken one, and on Windows that surfaces as a PowerShell error
// in the execution log — on a hook that gates the user's MCP calls. The runner reads it once.
runHook({
  name: 'mcp-before',
  permission: true,
  stdin,
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
    import('../lib/mcp-identity.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar, identity] = mods;
    // `hook_event_name` is stamped, not trusted. This script is registered on `beforeMCPExecution`
    // and runs for nothing else, so the payload IS one whatever the host has taken to calling it —
    // and that name is what makes `eventsFromHookPayload` suppress both the countable `tool` line
    // (which would double-count the call against `postToolUse`) and the `shell` line (which would
    // write a stdio server's launch argv, credentials and all, into the sidecar). Without the stamp,
    // a build that renames the event AND a payload we could derive no server name from would produce
    // exactly those two lines.
    const stamped = { ...ctx.payload, hook_event_name: 'beforeMCPExecution' };
    const mcpServer = identity.mcpServerFrom(ctx.payload);
    for (const line of events.eventsFromHookPayload(stamped, { mcpServer })) {
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(line, ctx.cwd));
    }
  },
});
