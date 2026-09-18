---
name: beezi-track
description: Manually save Beezi analytics for the current Cursor conversation
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-track/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only this command:

`node "<BEEZI>/scripts/track.mjs"`

Run it from the repository the user is working in — the command reads the current branch and origin
remote from the working directory.

Report its output to the user verbatim. "Nothing new to save" is a success, not a problem: the hooks
already checkpointed this conversation.
