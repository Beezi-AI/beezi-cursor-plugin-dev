# Beezi plugin for Cursor

A Cursor plugin that hooks into Cursor's session lifecycle and reports per-branch session analytics
to your Beezi workspace.

It also carries the stdio bridge to the Beezi MCP server, so whatever tools your plan exposes there
— ticket drafting among them, where you have it — stay reachable from the agent. The plugin itself
ships no skill for them: every skill it installs is an analytics or account entry point.

This is the Cursor port of the Beezi Codex plugin. Auth, the MCP stdio bridge, the queue/flush
engine and repo/branch attribution are shared logic; the host layer — paths, hook payloads, the
event sidecar, cost and plan capture — is reimplemented for Cursor.

## What is different about Cursor

Two properties break the assumptions the Claude Code and Codex plugins are built on.

**Token counts reach the machine on exactly two events.** Cursor proxies the model call through its
own backend, so there is no `usage` block to scrape and nothing to estimate honestly (transcripts
exclude tool outputs and cache reads). But the `stop` and `afterAgentResponse` hook payloads carry
that turn's `aiserver.v1.TokenUsage` — `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens` — keyed to a `generation_id`. Those are recorded and reported. Every other
event carries none, so a segment whose window contains no turn-end reports **no** token figure
rather than a zero: an unobserved number reported as zero is indistinguishable from a real one.

Spend is still carried by `cost_usd` per model, and activity by `operations` / `est_tokens`, which
the sidecar measures exactly.

The counts are **per turn**, not cumulative for the conversation, so a segment sums the distinct
generations in its window. This mirrors the Claude Code plugin, which sums each assistant message's
own `usage` block and dedupes on the message id; here the dedup key is `generation_id`, because
Cursor stamps model and generation on every hook payload and one generation writes one `gen` line
per tool call.

`token_total` includes cache — `token_input + token_output + token_cache`, matching both the Claude
Code plugin's definition and the server's own `usageTokenTotal`. It is a shared column across
agents, so a second definition would make the two incomparable in exactly the reports meant to be
compared.

> This plugin originally asserted that no usage data ever reached the client and hard-coded
> `token_* = 0` into every report. That was wrong as of Cursor 3.14.7, and it was invisible: the
> reports looked well-formed and simply said zero.

**Cursor's local storage is unstable** — the format moved four times in a year and chat history was
wiped across two upgrades. So the plugin does not scrape it. Cursor emits 21 typed lifecycle events;
the plugin records its own append-only stream and treats Cursor's storage as optional enrichment.

## Install

Add the marketplace in Cursor and enable the plugin. There is no install command.

Cursor clones the marketplace into `~/.cursor/plugins/cache/<marketplace>/<plugin>/<git-sha>/` and
loads three components from the manifest at `.cursor-plugin/plugin.json`:

| Component | Path | What Cursor does with it |
| --- | --- | --- |
| skills | `skills/*/SKILL.md` | every user-invoked entry point (sign-in, status, tracking, history, diagnostics) |
| hooks | `hooks/hooks.json` | the ten analytics hooks, addressed by `${CURSOR_PLUGIN_ROOT}` |
| MCP | `mcp.json` | the stdio bridge to the Beezi MCP server |

Cursor substitutes `${CURSOR_PLUGIN_ROOT}` in an MCP server's `command`, `args`, `env` and `cwd`,
and in a hook's `command`. It has to be used there: the shared MCP process starts servers with the
user's home directory as the working directory, so a relative `./scripts/mcp.mjs` fails with
`MODULE_NOT_FOUND` on `~/scripts/mcp.mjs`.

**It is NOT substituted in a skill.** A skill reaches the model as

```
Skill Name: beezi-track
Path: …/plugins/cache/beezi/beezi/<sha>/skills/beezi-track/SKILL.md
SKILL.md content:
<the body, byte for byte>
```

so a `${CURSOR_PLUGIN_ROOT}` in that body arrives as a literal. The model reads it as a shell
variable, writes `$env:CURSOR_PLUGIN_ROOT` or `$CURSOR_PLUGIN_ROOT`, the shell expands it to
nothing, and Node reports `Cannot find module 'C:\scripts\track.mjs'`. What a skill *can* rely on
is the `Path:` line above it: the skills say `<BEEZI>`, and each states the rule for turning that
path into a plugin root by dropping its own trailing `skills/<name>/SKILL.md`.

**Restart Cursor** after enabling — hook registries are read when the app starts.

### Why there are no commands

`commands/` is a documented plugin component and this plugin used to ship five. It does not any more.
In `loadAllCommands`, plugin commands are loaded only when

```js
allowExtensibilityCommands = thirdPartyExtensibilityEnabled && featureGate("enable_cc_plugin_import")
```

— a user setting AND a server-side feature gate. With either off, `loadPluginCommands` is never
called, and a plugin's commands silently do not exist. Skills are loaded on a path with no such gate,
so the entry points ship as skills with `disable-model-invocation: true`, which gives back the
user-invoked-only property a command had. They address their scripts relative to their own file
path, so they work from the first session, before anything has been written to disk.

### The setting that makes a correct install look broken

**Settings → Rules, Skills, Subagents → third-party extensibility** gates plugin hooks as well.
`CursorHooksService.reloadHooks` loads them inside that flag's `if`; the `else` calls
`pluginHooks.clear()` and logs, into the *Cursor Hooks* output channel and nowhere else:

```
Claude Code hooks disabled (thirdPartyExtensibilityEnabled off)
```

The plugin loads, the skill appears, and the bundled `hooks/hooks.json` is read and thrown away. The
user-scope registry below is not a workaround for a hypothetical — it is the path that carries
analytics on any machine with that setting off, *and* on every `cursor-agent` session whatever the
setting says. `install status` names the setting so the state is legible.

### What a marketplace install cannot carry

Both are handled by `ensureInstalled` in `lib/plugin-install.mjs`, which runs from **two** places:
the MCP server's startup and the `sessionStart` hook. Either alone knows where the plugin lives —
both are started by Cursor from the installed directory, which is what a git-sha-named path requires
— but the MCP server is a subsystem the user can disable on its own, and it is spawned by the IDE. A
machine that leans on `cursor-agent` could therefore go indefinitely without ever writing
`~/.cursor/hooks.json`, which is the only registry the CLI reads. Running it from the hook too means
an ordinary IDE session — the thing that does happen on such a machine — installs and keeps repairing
the registry the CLI depends on. It is cheap enough for a per-session path by construction: the shim
is rewritten only when its content differs, and `hooksStatus` short-circuits the install once the
state is `installed`, so a no-op run is a handful of stats.

1. **The user-scope hook registry.** Launchers are written to `~/.beezi-cursor/hooks` and merged
   into `~/.cursor/hooks.json`, and then **left there permanently** — it is the only registry the
   `cursor-agent` CLI reads. It is not a fallback for the bundled one; the two cover different
   hosts. See [Which registry runs](#which-registry-runs).
2. **`~/.beezi-cursor/bin/beezi.mjs`** — a shim that forwards to whichever copy is installed, so a
   human has one stable path to type. Nothing the plugin ships depends on it any more: the install
   directory is named after a git sha, so a shim that has not been written yet used to mean every
   entry point was dead on a machine where the MCP server had never started.

### Enabling it for a project

Cursor's plugins UI cannot: project install calls
`workspaceCollectionService.createWorkspaceReference()` before it touches the filesystem, and outside
a multi-workspace ("Glass") window that service is a stub whose every method throws
**"Workspace collection is not available"**. It fails for every plugin, not this one.

Project scope is a file — `<workspace>/.cursor/settings.json` — and the extension host reads it
directly, with no backend and no workspace collection involved:

```json
{
  "plugins": {
    "beezi/beezi": {
      "enabled": true,
      "gitUrl": "https://github.com/<owner>/<repo>",
      "gitRef": "main",
      "gitPath": "plugins/beezi"
    }
  }
}
```

The key is `"<marketplace>/<plugin>"`, split at the first slash. Entries carrying a `gitUrl` are
cloned straight from git; entries without one are resolved through Cursor's public plugin registry,
which a self-hosted marketplace is not in. Only `https://` (no credentials, query or fragment) and
`git@host:path` are accepted — a marketplace added from a local folder is dropped with a console
warning. `gitPath` is what points at a plugin that is not at the repository root; Cursor's own writer
drops that field, its reader honours it, which is one more reason to write the file rather than click.

### Repair

```bash
node "$HOME/.beezi-cursor/bin/beezi.mjs" install status
```

`$HOME` rather than `~`, and quoted: a tilde inside quotes is not expanded by any shell, and an
unquoted path breaks the moment the home directory has a space in it — `C:\Users\First Last` is an
ordinary Windows home. `$HOME` is spelled the same way in PowerShell, so one line covers both.

| Command | Effect |
| --- | --- |
| `… install status` | `installed` / `absent` / `stale` / `partial`, plus which registry has been *seen* firing — and the extensibility setting and the project entry |
| `… install install` | write the user-scope registry now |
| `… install uninstall` | remove Beezi's entries and launchers, leave yours alone |
| `… install project --git-url <url> [--git-ref <ref>]` | enable Beezi for the workspace in `.cursor/settings.json` |
| `… install project-remove` | take that entry back out |
| `… install install --scope plugin` | legacy: materialize a copy at `~/.cursor/plugins/local/beezi` |

Every scope is merge-preserving, and an unparseable registry or settings file is **refused** rather
than clobbered — merging onto `{}` would silently delete every hook, and every setting, you had.

### Which registry runs

**Both. Permanently.** They are not two copies of one thing — they cover different hosts:

> The Cursor CLI does not run hooks that come from an installed plugin, marketplace or local, even
> though it does load that plugin's rules and skills. Only `~/.cursor/hooks.json` and
> `<project>/.cursor/hooks.json` fire under `cursor-agent`. — Cursor staff,
> [forum 163890](https://forum.cursor.com/t/163890), still open as of Aug 2026.

So the bundled `hooks/hooks.json` covers the IDE (when third-party extensibility is on), the
user-scope launchers cover the CLI, and on a machine that uses both, each host needs its own.

This used to be arbitrated instead. A launcher run stood down and exited 0 whenever a bundled run
had been recorded within the last 14 days, and the next session's self-install deleted the
user-scope entries outright. Both rested on one premise — *the bundled registry is alive, so the
launcher is redundant* — and that premise is exactly what the quote above denies. One IDE session
was enough to switch the launchers off for a fortnight and have the installer remove them, and from
then on every `cursor-agent` session on that machine reported nothing at all: no sidecar line, no
segment, no cost. Silently, with `install status` still reporting the hooks as fine, for as long as
the IDE kept being used — which on a machine that uses both is forever.

**The duplicates are collapsed by the reader instead.** Both registries fire, both write, and
`lib/delta-cursor.mjs` drops the copies when the window is read:

- a sidecar line carries `eid`, the host's own id for the event that produced it — `tool_use_id` on
  `postToolUse`, `generation_id` on a generation. It is never fabricated: no id means the host gave
  us nothing to match on.
- `dedupeEvents` keys on the whole line, not on `eid` alone. Two writers handling one host event
  produce byte-identical lines (bar the timestamp each stamps itself), while the eleven `gen` lines
  one generation legitimately writes differ — only the turn-end line carries the turn's token
  counts, and keying on `(ev, eid)` would have dropped the one line that knows what the turn cost.
- lines the host gives no id for — `shell`, `stop`, `session_end`, `subagent_stop` — fall back to a
  content hash within a 1-second window. Two processes started by one host event land milliseconds
  apart; two genuinely repeated events do not. `subagent_stop` is the expensive case and is named
  here rather than buried: `stype` is a constant (the host always says `"general-purpose"`), so the
  only entropy separating two workers finishing in the same second is `task`, `status`,
  `duration_ms` and the message/tool/loop counts — which is why all of those are recorded. Two
  parallel workers given the IDENTICAL task that finish in the same second having agreed on every
  count WILL collapse into one, and nothing in the payload can prevent it. Under-counting a repeat
  is the direction this engine fails in everywhere; the alternative — exempting `subagent_stop` from
  collapse — doubles every subagent on every machine that has both registries, which is now every
  machine.

Identity is a fact about the event. "Which registry is alive" was a guess about the host, and a
wrong guess turned a whole host off.

`claimHookRun()` is still called first by every hook script, and now always returns `true`. What it
still does is record which registry started the run, in `~/.beezi-cursor/state/hook-source.json`,
with a separate entry per registry so one cannot overwrite the other's:

- the bundled registry passes `--via plugin-hooks`; a launcher passes nothing;
- `install status`, `me` and the session banner read that record to report which registry has
  actually been seen doing the work.

Nothing is gated on it. It is the difference between "nothing is installed" and "the CLI is the only
host on this machine", which is the one signal that tells a CLI-only install apart from a broken
one.

### Signing in

Run the **beezi-login** skill, or `node scripts/login.mjs` directly. A browser opens; credentials
land in the OS keyring. The MCP server also serves `beezi_login` and `beezi_status` tools, which is
where anything read-only about the link should go: that process is spawned by Cursor and inherits
`BEEZI_API_URL` and the credential store, while a shell command the model runs may see neither.

## Entry points

Everything a user invokes ships as a skill: Cursor can refuse to load a plugin *command* outright
(`thirdPartyExtensibilityEnabled` plus a server-side feature gate), so there is no command surface to
disagree with. These nine are the whole of it, and `test/entrypoints.test.mjs` asserts that the set
on disk is exactly this set — no more, no less.

| Skill | What it does |
| --- | --- |
| `beezi-analytics` | Print a short personal analytics summary for the last 7 or 30 days. |
| `beezi-install` | Install, repair, remove or check the analytics hooks, and add Beezi to a project. |
| `beezi-login` | Link this machine (browser sign-in), and run the one-time history import. |
| `beezi-logout` | Unlink this machine and stop reporting. |
| `beezi-me` | Show whether this machine is linked and whether analytics are being reported. |
| `beezi-refresh` | Re-read this machine's Cursor subscription plan, without signing in again. |
| `beezi-sync` | Upload past Cursor sessions, skipping whatever the server already has. |
| `beezi-telemetry` | Turn plugin crash reporting on or off, with or without account correlation. |
| `beezi-track` | Save analytics for the current conversation by hand. |

## Identity — distinct from the Claude Code and Codex plugins

| | Cursor plugin |
| --- | --- |
| data root | `~/.beezi-cursor` |
| keyring | service `beezi-cursor`, account `token` |
| agent header | `X-Beezi-Agent: cursor` |
| identity routes | `/me/cursor/whoami`, `/me/cursor/machine` |
| OAuth client | `Beezi Cursor plugin — <hostname>` |
| launchers | `~/.beezi-cursor/hooks/beezi-*.cmd\|.sh` |
| repair shim | `~/.beezi-cursor/bin/beezi.mjs` |

All three plugins write the same filenames — `queue/`, `state/`, `billing.json`, `repo-map.json`,
`credentials.json`. Sharing any root means one agent's queued segments flush under the other's
identity, and whichever plugin captured a plan last wins `billing.json` for both. **`BEEZI_HOME` is
deliberately not honored**: it is the single knob that would point every agent back at one
directory. Use `BEEZI_CURSOR_HOME` if you need to relocate this plugin — a per-agent variable cannot
merge two agents' stores no matter what it is set to.

Nothing is migrated out of `~/.beezi` or `~/.beezi-codex`; copying either in is precisely the mixing
this avoids.

## Hooks

Ten events, in `BEEZI_HOOKS` (`lib/hooks-install.mjs`) and in the bundled `hooks/hooks.json` — one
list, asserted equal by `test/plugin-manifest.test.mjs`, because a registry that covers nine of the
ten fails silently on whichever one it dropped.

| Cursor event | script | job | fires under `cursor-agent`? |
| --- | --- | --- | --- |
| `sessionStart` | `session-start.mjs` | banner, flush queue, prune, repo announce, self-install | staff-confirmed |
| `afterShellExecution` | `checkpoint.mjs` | record the command; checkpoint on `git commit/switch/checkout` | staff-confirmed |
| `postToolUse` | `tool-event.mjs` | append to the sidecar and exit — **never** loads the reporting engine | staff-confirmed |
| `stop` | `stop.mjs` | checkpoint + session timeline | staff-confirmed |
| `sessionEnd` | `report.mjs` | final checkpoint | staff-confirmed |
| `afterFileEdit` | `file-edit.mjs` | `edit` lines only — the sole source of `code_changes` without `ai-code-tracking.db` | staff-confirmed |
| `postToolUseFailure` | `stop-failure.mjs` | session-error report, free text redacted at the transport | unconfirmed |
| `beforeMCPExecution` | `mcp-before.mjs` | **permission hook.** one non-countable `mcp_server` identity line | unconfirmed |
| `subagentStart` | `subagent-start.mjs` | **permission hook.** opens a subagent span | unconfirmed |
| `subagentStop` | `subagent-stop.mjs` | closes one — carries no `subagent_id`, so the pairing is a read-time heuristic | unconfirmed |

The last column is about the EVENT, not about this plugin's registry: under `cursor-agent` a
plugin's bundled hooks never run at all, so every row there is carried by the user-scope launchers.
"staff-confirmed" is the list Cursor staff have said the CLI fires — `sessionStart`, `sessionEnd`,
`stop`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`. The four
marked unconfirmed are not known to be broken; nobody has said either way, and each one's reader has
a fallback that costs exactly what the plugin had before the hook existed. For MCP that fallback is
the `mcp_<server>_<tool>` prefix split in `lib/operations-cursor.mjs`; for subagents it is an empty
`subagents[]`, which is a visible absence rather than a wrong number.

`postToolUse` fires on every tool call, so `tool-event.mjs` is deliberately tiny. `afterFileEdit`
fires several times a turn and its `old_string`/`new_string` can be megabytes, so it is held to the
same rule: append and exit, no reporting engine, no SQLite, no network. `sessionEnd` and
`postToolUseFailure` exist here but not in the Codex fork: Codex has no equivalent events.

**`afterMCPExecution` is deliberately NOT registered.** `postToolUse` already fires for MCP tools, so
a handler on the completion side would count every MCP call twice — once in `operations`, once in
`est_tokens`. `beforeMCPExecution` is registered instead because it is the only event that sees the
server's `url`/`command`, and its line is a side channel that carries identity and nothing countable.

**Two of the ten are permission hooks.** Cursor reads the stdout of `beforeMCPExecution` and
`subagentStart` as a decision and obeys it, and exit code 2 blocks the user's action outright. Those
two scripts write nothing to stdout on any path — not on a valid payload, not on a malformed one, not
on an internal throw — and exit 0 always. `test/plugin-manifest.test.mjs` greps both for
`process.stdout`, `console.log` and any non-zero `process.exit`, because the branch that would ship a
stray byte is the one no test exercises.

**Adding an eleventh event is the one edit here that can cost the other ten.** An event Cursor does
not FIRE is harmless — the entry sits there and never runs, which is the expected state of the last
four under `cursor-agent`. An event name Cursor does not RECOGNISE is a different matter: if its
loader answers an unknown key by discarding the registry rather than the entry, every hook in the
list goes silent together. So the first thing to check after touching `BEEZI_HOOKS` is that Cursor's
own hook listing still shows all of them — see [Running a capture session](#running-a-capture-session).

The bundled `hooks/hooks.json` runs `node "${CURSOR_PLUGIN_ROOT}/scripts/<hook>.mjs" --via
plugin-hooks`. Three properties of Cursor's hook runner make that the only correct spelling:

- **`${CURSOR_PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}`) are substituted in a plugin hook's
  `command`**, and exported into its environment. This is the only way to name a directory whose
  last path segment is a git sha.
- **The working directory is the plugin root — except for `stop` and `subagentStop`, which run in
  the workspace folder.** A relative command would therefore work for eight hooks and fail for the
  two that close a session or a subagent.
- **The working directory is wrong for this plugin either way.** A marketplace install *is* a git
  clone, so a hook that shells out to git from the plugin root attributes the user's work to the
  Beezi plugin repository. Every hook calls `enterProjectDir()` first, which moves to
  `CURSOR_PROJECT_DIR` (Cursor's name for the workspace folder; `CLAUDE_PROJECT_DIR` carries the
  same value).

The `--via` flag is what lets a script record which registry started it. It decides nothing — see
[Which registry runs](#which-registry-runs).

None of that matters on a machine with third-party extensibility off: the bundled registry is
discarded before it is ever consulted, and the launcher registry is the only one that runs. That is
one of the two hosts the launchers exist for; the other is `cursor-agent`, which ignores a plugin's
bundled hooks whatever the setting says.

The user-scope registry uses a **launcher** instead — `~/.beezi-cursor/hooks/beezi-*.cmd|.sh`, one
absolute path baked in per hook. A launcher is a single-token executable, so that registry's
`command` field never depends on `node` resolving from `PATH`, and it is regenerated whenever the
plugin moves.

That field is a command *string*, though — the bundled registry above puts `node --no-warnings
"…" --via plugin-hooks` in the same field — so "one token" survives whitespace only if the path is
quoted. It is written **quoted when, and only when, it contains whitespace**:

```jsonc
"command": "/home/you/.beezi-cursor/hooks/beezi-stop.sh"                    // bare
"command": "\"C:\\Users\\First Last\\.beezi-cursor\\hooks\\beezi-stop.cmd\""  // quoted
```

A space-free path stays byte-identical to what every existing install already has on disk, so an
upgrade rewrites nothing. Both spellings are recognised as ours when the registry is read back, so a
registry written before this rule is stripped and replaced in place rather than gaining a second
handler beside the old one.

Recognition alone would not have repaired anybody, though. `ensureInstalled` rewrites the registry
only when `hooksStatus` reports something other than `installed`, so an entry that is ours, complete
and *wrong* would have been re-examined and left alone at every session start forever. `hooksStatus`
therefore also compares each entry against the command this version would write, and reports a
spelling it no longer produces as **`stale`** — the same word it already uses for a launcher left
behind by an upgrade, and for the same reason. The next session start *writes* the repair; Cursor
reads its hook registry at startup, so the session after that is the first one to run it. A
space-free path produces an identical string, so no machine that is not affected ever sees this.

### Windows delivers the payload through PowerShell, with a BOM

`$executeHookDirect` does not pipe the payload on Windows. It writes it to a temp file and rewrites
the command:

```powershell
$OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath '<payload>' -Raw |
  & { $input | <command> }
```

`[System.Text.Encoding]::UTF8` is the **BOM-carrying** instance, and Windows PowerShell emits that
preamble into the pipe. So a hook reads `﻿{"session_id":…}` — sometimes with the mark twice —
while the temp file it came from starts with a plain `{`. `JSON.parse` rejects that, and a hook that
treats a parse failure as "no input" then does nothing at all, quietly and with exit code 0.

That is what "the hooks run but nothing reaches the API" looks like from the outside: Cursor's own
execution log lists every registered hook firing, each with `(no output)`, and `~/.beezi-cursor`
never grows an `events/` or a `queue/` directory. `readHookInput` therefore decodes the byte stream itself —
UTF-8, UTF-16LE and UTF-16BE marks, repeated marks, trailing CRLF — rather than handing raw bytes to
`JSON.parse`.

### `workspace_roots` is a list of URIs, not of paths

Cursor builds it as `getWorkspace().folders.map(f => f.uri.path)` — `uri.path`, not `uri.fsPath`.
On Windows that is `/c:/Users/you/project`, with a leading slash before the drive letter, and it is
not a directory anything can run in: `spawnSync … cmd.exe ENOENT`.

Every git shell-out therefore failed, no repository could be resolved, and the segment was skipped
for having nothing to attribute it to. The session timeline needs no git and kept arriving, so the
server saw a steady stream of `/sessions/timeline` and not one `/sessions/report` — a plugin that
looked half-alive rather than broken. `toFilesystemPath` normalizes URI paths (and `file://` URIs)
before any of it is used as a working directory.

**Hook return values are never depended on.** [forum #155689](https://forum.cursor.com/t/155689)
(open since 2026-03-23) reports that `additional_context` is accepted and validated but never
injected into the model's context. The hooks read stdin and POST outward; the only stdout is
`session-start.mjs`'s banner, which is best-effort.

## How analytics work

The event sidecar is the source of truth:

```
~/.beezi-cursor/events/<session_id>.jsonl
  {"ts":…,"ev":"gen","model":"claude-4.5-sonnet","gen_id":"gen_01…","eid":"gen_01…"}
  {"ts":…,"ev":"tool","tool":"read_file","bytes":4210,"ms":120,"eid":"toolu_01…"}
  {"ts":…,"ev":"edit","path":"src/a.ts","added":12,"removed":3,"eid":"toolu_01…"}
  {"ts":…,"ev":"shell","cmd":"git commit -m …"}
  {"ts":…,"ev":"mcp_server","tool":"mcp_plugin_beezi_beezi_create_ticket","server":"beezi","eid":"toolu_01…"}
  {"ts":…,"ev":"subagent_start","sid":"sa_01…","stype":"general-purpose","task":"…","parent":"…"}
  {"ts":…,"ev":"subagent_stop","stype":"general-purpose","status":"completed","duration_ms":8123}
```

| `ev` | derived from | in practice written by | counted? |
| --- | --- | --- | --- |
| `gen` | `model_id`/`model` + `generation_id` on the common envelope | every hook that does not filter its lines — so all but `file-edit.mjs` and the two subagent scripts | one billable request per distinct `gen_id` |
| `tool` | `tool_name` | `postToolUse`, `postToolUseFailure` | yes — `operations` and `est_tokens` |
| `edit` | `edits[]` / `file_path` | `afterFileEdit` **only** | `code_changes`, when `ai-code-tracking.db` is absent |
| `shell` | `command` | `afterShellExecution` | yes, as a shell operation |
| `mcp_server` | `url` / `command`, via `lib/mcp-identity.mjs` | `beforeMCPExecution` | **no** — identity side channel |
| `subagent_start` / `subagent_stop` | `hook_event_name`, then `subagent_id` / `subagent_type` | `subagentStart` / `subagentStop` | **no** — timeline spans only |
| `stop` / `session_end` | nothing — written as bare markers | `stop.mjs` / `report.mjs` | turn and session boundaries for the timeline |

`eventsFromHookPayload` is **field-driven, not event-driven**: it reads whatever keys a payload
carries, so a renamed key degrades to "fewer events" rather than "no events". That is why the middle
column is the real contract and the third is only where each kind comes from today. It also has two
consequences a caller has to opt into or out of, both of them double-counting bugs waiting to happen:
`edit` lines are gated behind `allowEdits`, which only `file-edit.mjs` passes, because `postToolUse`
fires for a `Write` tool and its payload can carry a top-level `file_path`; and the subagent scripts
filter to `subagent_*` lines only, because a subagent payload can carry a `tool_name` or a `model`
that `postToolUse` has already recorded — and the two lines would differ in content, so duplicate
collapse could not merge them.

Three of the kinds are new, and two of the three carry a rule that is easy to break by accident.

**`mcp_server` is a side channel and must stay one.** `beforeMCPExecution` is the only event that
sees a server's `url` (remote) or `command` (stdio); `lib/mcp-identity.mjs` derives a name from it and
that name is all that reaches the sidecar — the raw url and argv never do, because a stdio server is
routinely launched as `npx some-mcp --api-key sk-…` and the sidecar is a plain-text file that
outlives the session. The line carries no `bytes` and no `ms` and appears in none of the counters'
event sets, because `postToolUse` already wrote the countable `tool` line for the same call; a
countable line here would report every MCP call twice. The old first-underscore split of
`mcp_<server>_<tool>` remains the fallback for every tool the side channel has not named — note the
resulting discontinuity across the cutover: `mcp_plugin_beezi_beezi_create_ticket` used to be
attributed to a server called `"plugin"`, so this plugin's own MCP rows change server name the first
time `beforeMCPExecution` fires on a machine.

**The two subagent kinds are records, not requests.** Cursor exposes no per-subagent token usage
anywhere, so there is nothing about them to bill; they exist to fill `subagents[]` on the session
timeline. The correlation happens at read time in `lib/subagents-cursor.mjs` and is a heuristic, for
the reason in [Known Cursor host bugs](#known-cursor-host-bugs-we-work-around): `subagentStop` carries
no `subagent_id`, so there is no join key. The order is exact `task` match → the sole open start →
LIFO among the remainder, flagged `ambiguous` → orphan. A start with no stop is the NORMAL end of a
background subagent rather than a dropped event, and those get a synthetic close bounded by the last
activity in the conversation.

All three kinds are also listed in `KNOWN_EVENTS` in `lib/delta-cursor.mjs`, which is not about
counting: a window that contains events and recognises none of them is reported to the host as a
writer/reader schema mismatch, and a turn that did nothing but fan out to workers is exactly such a
window. Every new `ev` string has to be added on both sides or every segment on every machine becomes
a false alarm.

`eid` is the host's own id for the event a line came from, copied never invented — it is what lets
the reader collapse the duplicate lines two registered hook registries write for one event, without
anything having to decide at write time which registry was allowed to run. `gen` lines carry the same
string twice on purpose: `gen_id` says which GENERATION the line belongs to, `eid` says which HOST
EVENT wrote it, and only the second is what duplicate collapse keys on. The `shell` and
`subagent_stop` lines carry no `eid` at all, because `afterShellExecution` and `subagentStop` are not
tool-use events and the host gives nothing to match on; those collapse on content within a one-second
window instead. See [Which registry runs](#which-registry-runs).

`segmentId = "<session_id>:<from>-<to>"` indexes **our** lines, so the server's idempotency contract
is preserved exactly while dependence on Cursor's format churn is eliminated.

The identity is **`session_id`**, and Cursor has already resolved it: `executeHookForStep` computes
`session_id ?? conversation_id` and stamps the result onto every payload it spawns a hook with,
except `workspaceOpen`. This plugin originally keyed off `conversation_id` and refused any payload
without one — which every real payload is. The hooks fired, read stdin, found no identity and
exited, so a fully installed plugin recorded nothing at all, in silence. Read the host's field;
do not re-derive it.

### Reading it costs what the turn cost, not what the session cost

`state/<session_id>.json` carries `cursor` (how many events have been reported) and `cursorBytes`
(the byte offset one past the last complete line at that point). A checkpoint resumes from that
offset and parses only what has been appended since, so its cost tracks new activity rather than the
size of the conversation:

| sidecar | full read | resumed read (20 new lines) |
| --- | --- | --- |
| 1k events | 6 ms | 3.8 ms |
| 10k | 19 ms | 2.0 ms |
| 50k | 72 ms | 3.3 ms |
| 200k | 296 ms | 4.6 ms |

The offset is a hint, never a source of truth. It is used only when the file is at least that long
*and* the byte before it is a newline; a sidecar that was pruned, recreated or truncated fails one
of those and falls back to a full read. A resumed read is asserted to produce the same segmentId,
bounds and timings a full read would.

Turn-ends are the exception: the session timeline is whole-session by definition, so `stop` and
`sessionEnd` read the file once and hand the same parsed array to both the delta and the timeline
instead of parsing it twice in one hook.

Cursor's `state.vscdb` is read at most once per process. `resolveSessionName` and `readUsageData`
both want the same `composerData:<id>` record, and each call used to open the database again —
falling back to copying the whole file, WAL included, whenever Cursor held a lock. Measured on a
6.7 MB store with Cursor running: 4.8 ms for the first read, 0.02 ms for the second; a `busy_timeout`
of 250 ms now absorbs a momentary lock instead of sending the read down the copy path.

| signal | source |
| --- | --- |
| duration, per-model requests, operations + `est_tokens`, code lines | sidecar — always available, IDE and CLI |
| `usageData` cost + billing pool, subscription plan, session name | `state.vscdb` / `ai-code-tracking.db` — enrichment, degrades to null |
| repo, branch-at-timestamp | git + reflog |
| transcript JSONL | **not an input** |

### Cost — seat plus overage, with an explicit pool marker

Cursor writes `usageData` only for usage-priced requests, carrying `amount` (how many requests were
priced) alongside `costInCents`. So one model's usage in a segment becomes up to two rows:

| pool | requests | cost |
| --- | --- | --- |
| `credits` | `usageData[model].amount` | `costInCents / 100` |
| `subscription` | `total_requests − amount` | 0 |

`models` is therefore a **list**, one entry per `(model, pool)`, not the record keyed by model id
that the Claude Code and Codex plugins send: a record has one slot per model and cannot hold both
rows. It used to hold them by appending the pool to the key (`"claude-4.5-sonnet#subscription"`),
which stopped the key being a model id — everything that priced, grouped or displayed it first had
to strip a suffix, and anything that forgot showed a pool name welded onto a model. The server ranks
the pools itself to build `sourceRef`, so idempotency does not depend on the plugin's key at all.

`unknown` is used when no price record could be read at all — rows we cannot classify say so rather
than silently inflating the seat-covered bucket.

The segment's `billing_source` summarises the same split at session level: `cursor_credits` when any
request in the window drew on credits, `subscription` otherwise. It is deliberately coarser than
`billing_pool` — one segment can be part seat and part credits, and only the rows can say how much
of each — but it is what the Billing Plan surfaces read, and reporting `subscription` unconditionally
called every credit-funded segment seat-covered. A credits session still holds a seat, so it still
reports its `subscription_plan`.

Cursor prices per model **variant** — the model id with its `model_params` folded in, e.g.
`kimi-k3-max` for `kimi-k3` at `reasoning=max`. Requests bucket under the id (`model_id` on the hook
payload) so one model stays one model, and every variant spelling seen in the window is carried
alongside so the matching price records can still be found and summed.

`usageData` is **cumulative per conversation**, so the host persists each `usage_snapshot` in
`~/.beezi-cursor/state/<conversation_id>.json` and hands it back as the next call's baseline. The
baseline only advances once the segment carrying that spend has been queued — advancing it on a
segment we declined to send would lose real money that cannot be recovered.

## History: the one-time import and the repeatable sync

Two different commands, and only one of them is one-time.

### What history exists at all

The plugin reads **its own event sidecar**, `~/.beezi-cursor/events/<conversation>.jsonl`, not
Cursor's storage. That has two consequences worth stating plainly:

- **History starts when the plugin was installed.** Nothing you did in Cursor before that was
  recorded by Beezi and none of it can be uploaded.
- **The horizon is 14 days.** The plugin's own retention deletes sidecars older than that, so a
  conversation from three weeks ago is gone from this machine and no command can bring it back.

Conversations that exist only in Cursor's own storage are *discoverable* but not uploadable — see
"What is still missing" below.

### The one-time import (`beezi-login`, step 4)

`node scripts/backfill.mjs [--dry-run] [--since YYYY-MM-DD] [--force] [--via login]`

Uploads the machine's recorded history into Beezi **once per account and tool**. The pull is sealed
when a clean full run finishes, and a sealed pull cannot be reopened — if you have Cursor history on
other machines, run `beezi-login` there *before* it seals.

It deliberately skips:

- **Sessions active in the last 24 hours**, measured on the last *real* activity (the last event
  that is not `session_end`), never the file's modification time — Cursor re-fires `session_end` for
  every open tab when the app restarts, so an mtime-based window would never expire for a forgotten
  tab. An active session recorded *before* this machine was linked holds the pull open for one more
  login; active sessions recorded after it are already tracked live.
- **Sessions already tracked live**, and sessions already in the account-scoped ledger
  (`~/.beezi-cursor/audit-ledger.json`, 0600, outside the pruned directories so it does not expire).
  `--force` re-sends ledgered sessions; it never bypasses the server's verdict that the pull is
  already sealed.
- **Sidecars over 64 MiB.** These are reported as skipped every run, and the final line says the
  pull finalized *without* them. There is no repair that makes an over-size sidecar readable.

`--dry-run` reports what would be sent and sends nothing. `--since` scopes a run and deliberately
never finalizes it.

### The repeatable sync (`beezi-sync`)

`node scripts/sync.mjs [--dry-run]`

Asks Beezi how far it already reaches into each session and uploads only the missing suffix, so
running it twice in a row uploads nothing the second time. It is safe to run at any time and it:

- **never finalizes, reopens or alters the one-time import**;
- **never advances live tracking state**;
- **stops instead of guessing.** If Beezi cannot say what it already holds, the run halts with
  nothing uploaded rather than re-sending from the start and counting the same work twice.

It skips sessions with anything still waiting in the local upload queue, and it takes each session's
existing checkpoint lock so a live hook and a sync can never report the same lines. While it holds
that lock a hook checkpoint for the same conversation does nothing and returns — the window is not
lost, the next hook re-examines it — and there is no wall-clock bound on how long the lock is held.

It takes no `--since` (that filters on when a session ran, which says nothing about what Beezi is
missing) and no `--force` (there is no seal on this path). Both are rejected with an explanation.

### What is still missing

Conversations from before the plugin was installed, or older than 14 days, exist only in Cursor's
own database. The plugin can count them but cannot upload them: Cursor records *priced overage* for
a conversation, not a total cost, token counts or a duration, and uploading a report built from that
would report numbers nobody measured.

Both routes (`/sessions/sync` and `/sessions/coverage`) are pinned client-side and have not been
exercised against a deployed backend — see the gate record in
[`docs/gate-record.md`](../../docs/gate-record.md).

## Degrade behaviour

Nothing hard-fails; fidelity drops.

| `node:sqlite` | behaviour |
| --- | --- |
| present | `ai-code-tracking.db` for AI-vs-human lines; `usageData` cost and `billing_pool`; plan from `state.vscdb` |
| absent | `afterFileEdit.edits[]` for `code_changes`; `billing_pool = 'unknown'`; plan via `--plan` self-report |

Beyond SQLite: no network → reports stay queued on disk and retry on the next checkpoint; no link →
no work is done at all. A Beezi project link (`/repos/status` connected) is optional — analytics are
tracked either way. Work with no git repo behind it is **not** skipped — see below.

### How a segment's repository is named

In order, first answer wins:

1. `git remote get-url origin` for the resolved repo root — a real HTTPS/SSH remote, with any
   embedded credentials stripped.
2. `[remote "origin"] url` parsed straight out of `.git/config`, for when the git binary cannot run
   (Windows dubious-ownership, git not on `PATH`, a 5 s timeout).
3. The persisted repo map (`repo-map.json`), seeded at session start from the launch directory and
   its immediate child repos.
4. `local:<folder>` — the folder name of the checkout, and **only** the folder name. No absolute
   path, no username, no parent directory ever reaches the wire. This is the same identity the
   sibling Claude plugin reports under, so one checkout worked on from both agents is one repo.
   Two different checkouts that share a folder name DO report as one repo; that is a limitation of
   the shared convention, not a uniqueness promise.
5. `local://unknown` — the one catch-all bucket, for a session that recorded no working directory
   at all. Such a session still carries real usage, so it is reported rather than dropped.

The branch is resolved from `git reflog` at the time of the activity, falls back to current `HEAD`,
and is `(unknown)` when neither can answer (detached HEAD, a repo with no commits, a blocked git).
It is clamped to 255 characters at payload construction, because the backend rejects a longer value
permanently — and a permanent rejection deletes the queued record, taking the segment's tokens,
cost and code changes with it.

### What attribution cannot tell you

- **Everything in one window is attributed to one repository and branch.** The per-run split that
  would change this is computed but not sent — see "What is computed but not sent" below.
- **Events with no timestamp** carry the branch of the preceding event forward. Cursor's own hook
  payloads occasionally omit one; guessing a branch from the window's end would be worse.
- **Cost is aggregate, not per-repo.** Cursor's `usageData` is a cumulative priced total per
  conversation with no per-event provenance. When a window spans two repositories, the priced
  overage is retained once — on the run holding the last generation that matched a price record, or
  on the final run when nothing supplies provenance. Splitting it proportionally would invent
  per-repo costs that no source supports.
- **Session-start discovery is one level deep**, and it scans a workspace folder's child repos only
  when the folder is not itself a checkout.

### What is computed but not sent

Some measurements are derived locally and deliberately withheld from every report, because the
ingest route validates as a whitelist: one property it does not declare rejects the **whole**
report, and the segment's tokens, cost, code changes and operations are discarded together. Each of
these is off until a deployed backend is shown to accept it, and none of them is a setting you can
turn on:

| Computed | Why it is not sent |
| --- | --- |
| The observed Cursor build | No host-version field exists in the report schema. |
| Always-applied rules count, project-instruction status | The fields exist; the naming and a deployed ingest that accepts them do not. |
| Context peak/final tokens, final model | Same. |
| Per-effort model breakdown | Same. |
| Timeline `break` periods | Schema-legal, unverified on the deployed reader. |
| Per-run (per-repository) segments | No deployed route is known to accept several segments for one window. The split is computed and recorded locally for provenance; one unsplit segment is sent. |

Nothing in this table is a partial or best-effort send. Either a field goes on the wire or it does
not, and today none of these does.

A window of sidecar lines none of which the parser recognises is reported to stderr as a schema
mismatch rather than passing as zero activity. That is the failure mode this design is built
against.

## Configuration

| Env var | Purpose |
| --- | --- |
| `BEEZI_API_URL` | Override the Beezi API base (default prod) |
| `BEEZI_MCP_URL` | Override the MCP endpoint |
| `BEEZI_CURSOR_HOME` | Override `~/.beezi-cursor` (queue / state / events / credentials) |
| `CURSOR_CONFIG_DIR` | Override `~/.cursor` (plugins, hooks.json) |
| `CURSOR_DATA_DIR` | Override the parent of `~/.cursor/projects` |
| `XDG_CONFIG_HOME` | Falls back to `$XDG_CONFIG_HOME/cursor` — **no OS guard**, see below |
| `BEEZI_CURSOR_DUMP_HOOKS` | Diagnostics only. Dumps every hook's raw stdin to `~/.beezi-cursor/capture/hooks.jsonl` — unredacted. See [Running a capture session](#running-a-capture-session) |

The `XDG_CONFIG_HOME` branch fires on Windows and macOS too. That is deliberate and matches Cursor:
a developer who exports it genuinely relocates Cursor's config, so guarding by platform would send
the plugin to a directory Cursor is not using. `ai-code-tracking.db` ignores both env vars and
always resolves against the real home directory, because Cursor's tracker writes it there
regardless.

## Tests

Zero runtime dependencies. Node built-ins only.

`"engines": { "node": ">=13.2" }`, mirroring the Claude Code plugin's floor — and, unlike a bare
declaration, held by construction: runtime code (`lib/` + `scripts/`) is ES2019 (no `?.`/`??`/`??=`,
no top-level `await`, bare builtin specifiers instead of `node:`-prefixed ones, which Node 13
cannot resolve), and the runtime APIs a Node 13 lacks are shimmed — `lib/fetch-compat.mjs`
(`resolveFetch()`: the real global on 18+, a minimal `http`/`https` client below),
`lib/abort-compat.mjs` (`resolveAbortController()` for < 15), `lib/fs-compat.mjs` (`removeSync()`
for the < 14.14 `fs.rmSync` gap — load-bearing in `lib/lock.mjs`, where a silent miss would strand
every session lock). Verified against a real v13.2.0 binary: every runtime file parse-checked, all
lib modules imported, and the sidecar write/read and lock acquire/release cycles exercised.

Known gaps below the floor: the browser sign-in (`login.mjs`/`oauth.mjs`) uses `base64url`
encoding, a 14.18+ runtime API — hooks and the backfill do not touch it, so an old-Node machine
records analytics but must be LINKED from a newer Node (the Claude plugin carries the identical
gap). The `node:sqlite` enrichment — `ai-code-tracking.db` code changes, `usageData` cost and the
plan tier — needs 22.5+ and degrades silently below it; see
[Degrade behaviour](#degrade-behaviour). Tests are exempt from all of this: `node:test` needs
modern Node, and the CI matrix runs 18/22/24.

```bash
node --test
```

## Running a capture session

The list below exists because nobody has ever seen a real Cursor hook payload. This is how to see
one. Set the variable and every registered hook appends the exact bytes it received to
`~/.beezi-cursor/capture/hooks.jsonl`:

```bash
BEEZI_CURSOR_DUMP_HOOKS=1        # or $env:BEEZI_CURSOR_DUMP_HOOKS = '1'
```

It is off by default and free when off: one environment read before anything is allocated, which is
what lets it sit on `postToolUse`. Each line carries `script`, `pid`, `via`, `platform`, `bytes`,
`head_hex` (the first eight bytes in hex — `efbbbf7b` is a UTF-8 BOM, `fffe` is UTF-16LE) and the raw
payload, truncated at 256 KB with `truncated: true` when it was.

> ⚠️ **`capture/hooks.jsonl` is the least redacted thing this plugin ever writes.** Full tool output,
> shell command text, file paths, MCP launch argv — including anything a credential happened to be
> sitting in. It is written 0600 in a 0700 directory and it is never uploaded, but it is a plain-text
> file in your home directory. **`rm -rf ~/.beezi-cursor/capture` when you are done**, and unset the
> variable. Do not attach the file to a ticket without reading it first.
>
> Capture output is **local only and is never uploaded** — not by analytics, and not by the plugin's
> own crash diagnostics, which record no file contents and no paths outside the plugin directory.
>
> It is bounded so a forgotten capture session cannot fill the disk, on client policy this plugin
> chose rather than any server requirement: the log rotates at 8 MiB, at most four logs are kept
> (32 MiB), anything older than 14 days is deleted, and a raw stdin replay left behind by a killed
> hook is deleted after an hour. The sweep runs before a capture append and again on every ordinary
> prune, so the bounds still apply after you switch capture back off. It only ever touches files
> inside `capture/`; symlinks and reparse points are skipped rather than followed.

### The first check, before driving anything

**Open Cursor's hook listing and count the entries. It must show 10, not 6.**

This is not a formality and it is not "does the plugin work" — it is the one failure this design
cannot detect from the inside. Four events were added to `BEEZI_HOOKS` on the strength of
documentation. If Cursor's loader answers an unknown event name by discarding the whole registry
rather than the offending entry, then adding `subagentStart` did not add a hook, it deleted the six
that were working, and every symptom of that is silence. A listing showing 6 means back the array out
to the six known-good events and add the new ones one at a time; a listing showing 10 means the names
are accepted and everything below is worth doing.

### The script

Once through in the **IDE**, once through under **`cursor-agent`**, because they are different hosts
with different registries and the whole point of the launchers is that the CLI does not run the
bundled ones. In one session each:

1. a plain question, no tools — a turn-end with no tool call at all;
2. a read and a grep — `postToolUse` on two different built-in tools;
3. a shell command, then `git commit` — `afterShellExecution`, and a checkpoint boundary;
4. one small file edit and one large one (a whole-file rewrite of something generated) —
   `afterFileEdit`, and whether `edits[]` really carries `old_string`/`new_string`;
5. a command that fails — `postToolUseFailure`, and what `error` / `tool_output` actually hold;
6. an MCP call to a **stdio** server, then one to a **remote** server — `beforeMCPExecution` with
   `command` and with `url`, which are the two shapes `lib/mcp-identity.mjs` is written against;
7. one foreground subagent;
8. three parallel subagents with **distinct** task strings — distinct because exact `task` match is
   the primary correlation key, and a fan-out with identical tasks is the case that degrades to LIFO;
9. one background subagent, and **confirm no `subagentStop` line appears for it** — that is the
   confirmed host bug the synthetic close exists for, and the capture is what turns "confirmed on the
   forum" into "confirmed on this machine";
10. close the session — `sessionEnd`.

### What to read out of it

- `head_hex` on the Windows runs: does the payload arrive with a BOM, once or twice?
- `hook_event_name` — present on every payload, or only some? Two pairs of payloads are
  indistinguishable without it (`beforeMCPExecution` vs a shell tool call; `subagentStop` vs `stop`).
- Which of `tool_use_id` / `generation_id` are really stamped. If neither is, every line dedupes on
  content and time alone, and that is a cost worth knowing about rather than discovering.
- Whether `subagent_id`, `subagent_type`, `summary`, `modified_files`, `agent_transcript_path` and
  `parent_conversation_id` are present, absent, or present-and-wrong.
- Whether the `--via` values are what the two registries were meant to pass. Capture records the flag
  verbatim rather than normalizing it, precisely so an unexpected value is visible.

Each answer retires one of the 29 `// TODO(P0): unverified` markers.

## Plugin crash diagnostics

Off until you turn them on, and there is no prompt that turns them on by timing out.

```bash
beezi telemetry            # show the current setting
beezi telemetry on         # anonymous crash reports about the plugin
beezi telemetry correlate  # the same reports, plus a random installation ID
beezi telemetry anonymous  # drop the ID again, keep the reports
beezi telemetry off        # send nothing, and delete what is pending
```

The `beezi-telemetry` skill runs the same command.

**What a report contains.** A fixed failure code (`hook_crash`, `queue_flush_http_error`,
`login_failed` and nine others), which plugin file and line failed, an HTTP status when there was
one, the plugin and Node versions, the OS and its release, and the architecture. Nothing else:
there is no field for an error message, a stack string, a prompt, tool output, a file path outside
the plugin directory, a repository name, your hostname or your account.

**Anonymous versus correlated.** The two settings are independent, and `on` only ever answers the
first one. `on` turns diagnostics on and leaves correlation exactly as it was: on a machine that has
never granted correlation that means anonymous reports, but on one that ran `correlate` earlier,
`on` does NOT take the correlation back. **`anonymous` is the way to withdraw it** — it turns
correlation off, deletes the installation ID and deletes every report already stamped with it, while
leaving diagnostics on. `off` does both at once.

`correlate` adds a random UUID minted on this machine, which is bound to the last Beezi account
linked here (the binding is asserted when you sign in) so support can find your report — it is a
correlation key, never a credential, it is never reused across accounts, and it is deleted on
logout, on `anonymous` and on `off`.

**Retention.** Reports are folded (the same failure increments a count rather than queuing again),
capped at 200 records, and expire locally after 14 days whether or not they were ever delivered. A
batch is at most 50 events and 28 KiB. Delivery happens in a detached background process, never in a
hook. `off` deletes everything pending; if a delivery is in flight the command says so rather than
claiming otherwise, and the next run deletes rather than sends.

The reports go to an unauthenticated endpoint on purpose: losing sign-in must not also lose the
evidence about losing sign-in. No token, no cookie and no `X-Beezi-*` header is sent with them.

**Two codes that cannot currently be delivered.** `hook_crash` and `hook_unhandled_rejection` are
recorded from a hook's process-level handlers, and those handlers leave through a synchronous
`process.exit`. The diagnostics facade is loaded lazily — deliberately, so that a hook standing in
front of your tool calls does not evaluate `child_process` and `http` on every run — and a lazy load
cannot resolve before a synchronous exit. Every other code on the list is delivered normally; these
two are recorded in the code and dropped. Nothing about this is silent by accident, and it is
tracked in [`docs/gate-record.md`](../../docs/gate-record.md).

**Delivery has never been verified against a deployed endpoint.** Everything above describes what
this client sends and stores; whether the receiving route exists and accepts it is an open gate.

## Unverified (P0)

**Cursor is not installed on the machine this plugin was written on** — no `~/.cursor`, no
`cursor-agent`, no `%APPDATA%\Cursor`. Every path, hook payload field and storage key below comes
from documentation, staff forum posts and decompiled binaries, and is marked in the source with
`// TODO(P0): unverified` — 29 markers across twelve files. Confirm each on a machine running Cursor
before trusting the numbers; [Running a capture session](#running-a-capture-session) is how, and one
session answers most of the list at once.

1. **Whether the bundled `hooks/hooks.json` fires in the IDE on a machine with third-party
   extensibility ON.** Discovery is confirmed — Cursor parses the registry and reports the plugin's
   hooks as a component — but every observation so far comes from a machine with the setting off,
   where the parsed hooks are cleared before they can run. (For `cursor-agent` the question is
   settled and the answer is no; see the table below.) *If it never fires anywhere:* nothing is
   needed from the user and nothing changes. The user-scope registry is written at the first
   session and left in place regardless, so it carries every host either way; the recorded hook
   source is diagnostics only.
2. **Whether Cursor's loader accepts all ten event names.** Six are known to be parsed. The four
   added since — `afterFileEdit`, `beforeMCPExecution`, `subagentStart`, `subagentStop` — come from
   documentation. An event Cursor does not FIRE costs nothing; an event name it does not RECOGNISE
   costs the other nine if the loader discards the registry rather than the entry. **This is the
   first thing a capture session checks, and it is checked by counting the entries in Cursor's own
   hook listing, not by driving the plugin** — the failure mode is silence.
3. **The per-event fields beyond the common envelope.** The envelope is settled — `session_id`,
   `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path`, plus
   the raw event's own keys — but which of `tool_name` / `tool_output` / `duration_ms` / `edits[]`
   / `model` each event actually carries is still read defensively rather than known. The registry
   schema is settled too: `version: 1`, handlers directly under the event, `command` / `timeout` /
   `matcher` / `failClosed` per handler.
4. **Whether `postToolUseFailure`, `beforeMCPExecution`, `subagentStart` and `subagentStop` fire
   under `cursor-agent`.** Staff have named seven CLI events and said nothing about these. *If they
   do not:* MCP calls fall back to the prefix split forever on CLI-only machines, and `subagents[]`
   stays empty there — both are the state the plugin was already in, and both are counted rather
   than assumed (`mcpAliased` / `mcpInferred` in `computeOperations`, and the subagent diagnostics
   in `correlateSubagents`).
5. **The string values `cursorAuth/stripeMembershipType` emits.** *If wrong:* the `--plan`
   self-report path is already built and is what the `beezi-login` skill uses.
6. **`composerData.usageData` shape, and the semantics of `amount`** — the split between the
   `credits` and `subscription` pools depends on it.
7. **`node:sqlite` is present** in the Node the launchers resolve. *If not:* the degrade table
   above applies.
8. **`ai-code-tracking.db` schema** matches the decompiled expectation, and lives at
   `~/.cursor/ai-code-tracking.db`.
9. **Whether `cursor-agent` CLI supplies a usable `transcript_path`.** Nothing depends on it; this
   is only to close the question.
10. **The flattened MCP tool-name format.** `mcp_<server>_<tool>` comes from documentation, and it
    is what `mcpServerOf` falls back to for every tool `beforeMCPExecution` has not named. The
    side-channel join does not depend on it; that function is the only thing that does.

The per-hook `timeout` field IS supported and the bundled registry declares 10s, matching the budget
the checkpoint derives.

### Settled since this list was written

On a machine that does run Cursor, and against the shipped bundle
(`resources/app/out/vs/workbench/workbench.desktop.main.js`,
`resources/app/extensions/cursor-agent-exec/dist/main.js`):

| | |
| --- | --- |
| manifest path | `.cursor-plugin/plugin.json` — a bare `<root>/plugin.json` is never read |
| MCP config | `mcp.json` or `.mcp.json`; `env_vars` is not a field, `cwd` is |
| install path | `~/.cursor/plugins/cache/<marketplace>/<plugin>/<git-sha>/`, not `plugins/local/` |
| MCP substitution | `${CURSOR_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` in `command`, `args`, `env`, `cwd`, then `${VAR}` from the environment |
| MCP cwd | the user's home directory unless `cwd` says otherwise |
| hook substitution | same two variables in `command`; both also exported to the hook |
| hook cwd | the plugin root, except `stop` / `subagentStop` → workspace folder |
| hook environment | `CURSOR_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, `CURSOR_VERSION`, `CURSOR_PLUGIN_ROOT`, and `CURSOR_TRANSCRIPT_PATH` when a transcript exists |
| hook handler fields | `command`, `type`, `timeout`, `matcher`, `failClosed`, `loop_limit` |
| plugin hook source | always reported as `claude-plugin`, whatever the marketplace |
| plugin hooks in the CLI | **never run.** `cursor-agent` loads a plugin's rules and skills but not its hooks, marketplace or local; only `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json` fire there (Cursor staff, [forum 163890](https://forum.cursor.com/t/163890), open) |
| skill substitution | **none** — a skill body is inlined verbatim under its `Path:` line, so `${CURSOR_PLUGIN_ROOT}` reaches the model as a literal |
| hook payload identity | `session_id`, which Cursor sets to `session_id ?? conversation_id` on every event but `workspaceOpen` |
| `workspace_roots` | **URI paths** (`folders.map(f => f.uri.path)`), so a Windows workspace reads `/c:/Users/you/project` and cannot be used as a cwd |
| token counts | on `stop` and `afterAgentResponse` only: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, per `generation_id` |
| `model` / `generation_id` | on the common envelope, so `postToolUse` repeats them once per tool call — count generations, not lines |
| Node's own stderr | Cursor puts a hook's stderr in its execution log, so `node:sqlite`'s ExperimentalWarning reads as a failing hook. Every launcher and bundled command passes `--no-warnings` |
| hook stdin, POSIX | the payload is piped to the process (`pipeStdin: true`) |
| hook stdin, Windows | **not piped.** The payload goes to a temp file and the command is rewritten into a PowerShell pipeline that re-reads it — see below |
| Windows hook shell | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` |
| plugin hooks gate | `thirdPartyExtensibilityEnabled`; off ⇒ `pluginHooks.clear()` |
| plugin commands gate | that flag AND the `enable_cc_plugin_import` server feature gate |
| skills gate | neither — they load whenever the plugin does |
| the flag on disk | `cursor/thirdPartyExtensibilityEnabled` in `globalStorage/state.vscdb`; absent ⇒ Cursor's default, which is on |
| `globalStorageDir()` | confirmed on Windows: `%APPDATA%\Cursor\User\globalStorage` |
| project scope | `<workspace>/.cursor/settings.json` → `plugins["<marketplace>/<plugin>"] = { enabled, gitUrl, gitRef, gitPath }` |
| project git URL | `https://` (no credentials/query/fragment) or `git@host:path`; anything else is dropped at load |
| project scope in the UI | throws `Workspace collection is not available` outside a Glass window — Cursor bug, every plugin |

## Known Cursor host bugs we work around

Every item here is a workaround for something Cursor does wrong, and every one of them looks like a
mistake if you meet it without this list. **Do not "fix" any of them by reaching for the documented
field — it is not there.** They are also all recorded in the source at the point that works around
them, so this table is a map rather than the only copy.

| | |
| --- | --- |
| **`subagentStop` carries no `subagent_id`** | There is no join key back to the start event at all, so pairing the two halves of one worker is a read-time heuristic — exact `task`, then the sole open start, then LIFO flagged `ambiguous`. `lib/subagents-cursor.mjs` refuses to invent the field; the failure mode is a swapped LABEL between two workers that both really ran, never a lost or duplicated one. |
| **A background subagent never fires `subagentStop`** | [forum 166681](https://forum.cursor.com/t/166681). A start with no stop is the NORMAL end of a background worker, not a dropped event, so nothing waits for the pair and unclosed spans get a synthetic close bounded by the last activity in the conversation (30 min ceiling). Emitting only correlated pairs would make background delegation permanently invisible, which is exactly the delegation a user cannot see any other way. |
| **`subagent_type` always reads `"general-purpose"`** | [forum 156647](https://forum.cursor.com/t/156647), whatever type actually ran. It is recorded as `stype` because it is what the host said, not because it is true, and nothing downstream may use it to tell two workers apart. When the host sends nothing at all the value is `"unknown"` and deliberately NOT `"general-purpose"` — writing the bug's own value ourselves would make a fabricated field indistinguishable from a reported one the day it is fixed. |
| **`subagent_model` does not exist** | Cursor exposes no per-subagent token usage anywhere. A delegated turn's spend is only ever visible inside the parent's own `stop` totals, so a subagent span carries time and identity and nothing else. Nothing may zero a token field the host never sent. |
| **`summary` and `modified_files` are documented and absent** | They are in the docs and not in real payloads. |
| **`agent_transcript_path` is always null** | There is no sub-transcript on disk, ever. The hook events are the only evidence a subagent ran — which is why this plugin's `subagents[]` is derived from them and not, like the Claude Code plugin's, from transcripts. |
| **`description` on `subagentStop` holds the PARENT's task title** | Not the subagent's. It is deliberately not recorded: a field named for the subagent that in fact describes its parent is worse than an absent field, because a later reader will believe it. |
| **A plugin's bundled hooks never fire under `cursor-agent`** | [forum 163890](https://forum.cursor.com/t/163890), still open. The CLI loads a plugin's rules and skills but not its hooks, marketplace or local; only `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json` run there. This is why the user-scope launchers are installed permanently and why nothing arbitrates between the two registries — see [Which registry runs](#which-registry-runs). |
| **Hook return values are validated and then discarded** | [forum 155689](https://forum.cursor.com/t/155689), open since 2026-03-23: `additional_context` is accepted and never injected. So there is nothing to be gained by writing a hook response and a hook-shaped failure to be had by writing it wrong. |
| **Windows delivers the payload through a BOM-carrying PowerShell pipeline** | See [above](#windows-delivers-the-payload-through-powershell-with-a-bom). `readHookInput` decodes the byte stream itself rather than handing raw bytes to `JSON.parse`. |
| **`workspace_roots` holds URI paths, not filesystem paths** | `/c:/Users/you/project` on Windows, which is not a directory anything can run in. `toFilesystemPath` normalizes before any of it is used as a cwd. |

## Known, not yet fixed

Found in a full review, judged real, and deliberately left for a follow-up because each is a
design change rather than a correction. Listed so they are not rediscovered as new:

| | |
| --- | --- |
| **A GUI Cursor with no `node` on `PATH` cannot bootstrap itself** | The bundled `hooks/hooks.json` and `mcp.json` both start `node` by NAME, and a GUI-launched Cursor inherits the desktop session's `PATH`, not the login shell's. On a machine where `node` exists only inside a version manager (nvm, fnm, volta), nothing this plugin ships ever spawns: no hook, and no MCP server. The launchers are immune — they bake `process.execPath`, an absolute interpreter path — but they are written by the MCP server's own startup (`lib/plugin-install.mjs`), which is precisely the thing that could not start. So such a machine needs exactly one manual `node "<plugin>/scripts/install.mjs" install` from a shell where `node` does resolve, after which every hook runs from the launcher registry regardless of `PATH`. Deliberately not fixed in code: the only in-repo fix is a hard-coded interpreter path in a file that ships to every other machine, where it would be wrong. |
| **Branch at a checkout boundary** | `afterShellExecution` fires *after* `git switch`, and the branch is resolved at the window's end timestamp, so a segment that ended with a switch is attributed to the branch just moved to. The reflog carries the `from` side; the delta does not use it yet. |
| **`models` is sent as a list and the server accepts only a record** | The single most important open item, and it predates every change on this list. `lib/checkpoint.mjs` emits `models` as an array (pinned by `test/checkpoint.test.mjs:86`), while the portal validates it with `@IsModelUsageRecord()`, whose first line is `if (typeof value !== 'object' \|\| value === null \|\| Array.isArray(value)) return false`. Verified on both `feature/cursor-provider-analytics` and `feature/codex-pugin-and-refactor`; the two branches agree and neither accepts an array. If that is what production runs, **every Cursor report 400s and nothing on this page has ever reached the server** — which is also why no dashboard has contradicted the plugin. Resolving it is a product decision, not a correction: either the plugin switches to the `{ "<model>": {…} }` record the sibling Claude Code plugin already sends, or the portal grows the list form it was documented as having. Confirm against a live portal before trusting any figure. |

### Fixed since this list was written

Six items have come off the list. Kept here with what each one actually cost, because the
workarounds are still in the code and read as over-engineering without them:

| | |
| --- | --- |
| **Subagent report segments** | `subagents[]` on the timeline was the whole feature for one round. `lib/checkpoint.mjs` now also emits one report segment per correlated span, carrying `is_subagent` / `agent_id` / `agent_type` / `agent_name` with every token count zeroed, because Cursor exposes no per-subagent usage and a fabricated one would be indistinguishable from a measurement. The interval union in `lib/active-time.mjs` landed in the same change rather than after it, which was the point: the main segment is enqueued first and keeps its full span, each subagent bills only `subtractIntervals(own, covered)`, and coverage is claimed only once the write has landed — so a three-worker fan-out cannot bill the same minute three times. |
| **The MCP alias carry-over** | `computeOperations(window, { mcpAliases })` is now fed from `state.mcpAliases`, so a tool→server mapping learned in one window still names the tool in the next. `beforeMCPExecution` fires before the call and `postToolUse` after it, so the two halves genuinely do land in different windows. The LRU is capped at 64 and rides on a **non-enumerable** property: an enumerable one would be serialized into the report body and 400 the whole thing on the DTO whitelist. |
| **Bounded body reads** | `bounded()` clears its abort timer the moment the headers arrive — fetch settles there, not at the end of the body — so `res.json()` ran with no bound at all. Measured against a real server: headers in 27 ms, `res.json()` still pending at 12 s, against undici's 300 s `bodyTimeout` and a hook Cursor kills at 10 s. `readJsonBounded` in `lib/http.mjs` holds the stream reader itself so it can cancel, and resolves `null` on a stall rather than throwing. `whoami` is bounded at 1500 ms rather than the generic 10 s read default, shares that one budget across headers and body, and has been moved off the serial session-start path so `pruneStale` is no longer hostage to the network. |
| **Flush backoff** | `flushQueue` iterates `readdir` order, which on NTFS is lexicographic, so the SAME file was attempted first on every flush forever. Three permanently-failing files at the head of the list consumed the whole 7500 ms budget on every flush and everything behind them was never attempted once — not retried and given up on, never tried — until `prune.mjs` deleted it at 14 days. `lib/queue-backoff.mjs` puts retry state on the payload (30 s doubling to 30 min). Two details are load-bearing: `_retry` is stripped before the POST body is built, because one unknown top-level key 400s the whole report; and expiry reads `firstQueuedAt` rather than file mtime, because recording a retry rewrites the file and refreshes its mtime — the one file that can never be sent would otherwise be the one file that can never be deleted. |
| **MCP credential cache** | `mcp-bridge` read the credential store on every JSON-RPC message, and on Windows a credential read is a synchronous PowerShell spawn costing ~532 ms. `lib/token.mjs` now memoizes in-process, and disables the cache whenever a store seam is injected so the tests still exercise the real path. |
| **Per-session state lock** | Two hooks could run `load → await → save` on one state file at once. That is not merely a duplicated segment: `usageSnapshot` is the cumulative-credits baseline, and an unlocked write can rewind it, which re-bills spend that cannot be recovered. `lib/lock.mjs` takes a per-session lock and SKIPS on contention rather than waiting — a hook that waits for a lock spends the budget it was going to do the work with. |

Also since: `safeName` is applied to state and queue paths (a `session_id` from a hook payload is
untrusted input on a path, and `lib/sidecar.mjs` had always run the identical value through it), and
outbound error text is redacted at the transport in `lib/session-error-report.mjs` rather than at
each call site.

## Notes

- **Surfaces are IDE agent/chat and `cursor-agent` CLI only.** Cursor Tab and cloud/background
  agents are out of scope.
- **`afterAgentResponse` / `afterAgentThought` do not fire in the CLI** (staff-acknowledged). The
  session timeline rides on `stop` instead, so this costs nothing.
- **The ingest routes are frozen** — `/sessions/report|errors|timeline`, `/repos/status` — because
  they are a contract with already-installed Claude Code and Codex plugins. Agent discrimination is
  the `X-Beezi-Agent` header. Only `/me/cursor/*` is per-agent.
- **`/sessions/report` is validated as a whitelist.** Nest's `ValidationPipe` rejects the whole
  request with `BadRequestException` when it carries a property `SessionReportRequestDto` does not
  declare — so an extra top-level field is not forward-compatible extra data, it is a 400 that
  discards the segment's tokens, cost, code changes and operations together, on every report, with
  nothing visible on the plugin side but a queue that never drains. Adding a field means changing
  the server first. `test/report-payload-shape.test.mjs` pins the accepted key set; anything that
  needs more detail goes inside `models`, which is stored opaquely.
- **Free text is scrubbed before it leaves the machine.** Two fields carry any — `errorDetails`
  (the output of the tool call that just failed) and `lastAssistantMessage` — and both are redacted
  in `lib/session-error-report.mjs`, at the transport, so no call site can ship text past it by
  forgetting to. A failed command is precisely where credentials surface: the `curl` that 401'd is
  echoed with its `Authorization` header intact, a refused `git push` quotes the remote URL with the
  token still in it, a driver that could not connect prints the DSN it parsed. Every rule in
  `lib/redact.mjs` anchors on something that is not plausibly prose — a token's own issuer prefix
  (`ghp_`, `xoxb-`, `eyJ`), a URL's userinfo colon, a key NAME containing a secret-ish word. Nothing
  is redacted for merely looking random: a bare 40-character hex string is a git SHA far more often
  than a secret. The negative table in `test/redact.test.mjs` is the real specification —
  `connection refused`, `TS2304`, an `ENOENT` carrying a Windows path, `npm ERR!` and stack traces
  must all come back byte-identical. A redactor that eats diagnostics is worse than none: the report
  still arrives, still looks fine, and is useless, and nobody finds out.
- **`total_cost_usd` means something different here.** For Claude Code and Codex on subscription it
  is *notional* — what those tokens would have cost at API list rates. For Cursor it is *actual*
  overage charged. `billing_pool` is what makes the distinction queryable.
- **No Cursor Admin API.** Local-machine data only.
