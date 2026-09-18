---
name: beezi-install
description: Install, repair, remove, or check the Beezi analytics hooks, and add Beezi to this project
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-install/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase, and do NOT edit
`~/.cursor/hooks.json`, `.cursor/settings.json` or any other config by hand — these commands merge
into those files and preserve what the user already had, which hand-editing does not.

Start with the status report, always. It reports two independent things, and only the second one is
installable:

`node "<BEEZI>/scripts/install.mjs" status`

Report the output verbatim, then act on what it says.

## Analytics hooks

| They want | Command |
| --- | --- |
| install or repair | `node "<BEEZI>/scripts/install.mjs" install` |
| remove | `node "<BEEZI>/scripts/install.mjs" uninstall` |

**Two registries, two hosts. Read both lines of the status output before saying anything.**

- The plugin's own **bundled** hooks cover the Cursor IDE. `✓ … the Cursor IDE is covered` is good
  news, and `•  … have not been seen firing` is not a fault — it is normal on a machine that only
  uses `cursor-agent`, and nothing can install it.
- The **user-scope registry** (`~/.cursor/hooks.json`) is the one `install` writes, and it is the
  ONLY registry the Cursor CLI reads: `cursor-agent` never runs hooks that came from an installed
  plugin, marketplace or local. Anything other than `✓ … are installed` here means CLI sessions
  report nothing, and it needs the install command — including when the bundled line above says the
  IDE is covered. A healthy IDE says nothing at all about the CLI.

So `⚠ Beezi: analytics hooks are NOT installed` printed underneath a firing bundled registry is a
real problem to fix, not a contradiction. Run the install. Both registries are meant to stay
installed side by side; duplicated events are collapsed when they are read, so installing does not
double-count anything.

If the status output says Cursor's third-party extensibility is off, pass that on word for word. It
means Cursor is ignoring the plugin's own bundled hooks entirely, and the user-scope install above is
what makes analytics work anyway. Do not tell the user to turn the setting on unless they ask — the
user-scope registry covers both hosts either way.

## Adding Beezi to a project

Project scope is a file, `<workspace>/.cursor/settings.json`, and it needs the marketplace's
repository URL because Cursor clones project plugins straight from git:

`node "<BEEZI>/scripts/install.mjs" project --git-url <https url> [--git-ref <branch>]`

Ask the user for the URL rather than guessing it; only `https://…` and `git@…` addresses work, and a
marketplace they added from a local folder cannot be used at project scope at all. `project-remove`
takes the entry back out.

This is also the answer when the plugins UI failed with **"Workspace collection is not available"** —
that error is Cursor's, it happens for every plugin outside a multi-workspace window, and writing the
file does the same job.

## What no command can do

- **Restart Cursor** after any hook install — registries are read when the app starts.
- **Sign in**, if the machine is not linked — that is the `beezi-login` skill.
