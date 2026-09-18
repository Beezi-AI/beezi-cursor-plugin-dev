---
name: beezi-telemetry
description: Turn Beezi plugin crash reporting on or off, with or without account correlation
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-telemetry/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Do NOT look at the consent
record, the pending reports, the credential store, or anything under `~/.beezi-cursor`. Run only
this command, passing through whatever the user typed as the argument (no argument reports the
current setting):

`node "<BEEZI>/scripts/telemetry.mjs" <setting>`

Report its one-line output to the user verbatim. It is already accurate about what happened —
do not soften it, do not add a reassurance it did not make, and do not re-run the command to get
a different sentence.

The four settings, if the user asks:

- `on` — send crash reports about the plugin. It answers only the send-or-not question and leaves
  account correlation exactly as it was, so on a machine that previously chose `correlate` it does
  NOT make the reports anonymous again.
- `off` — send nothing, and delete what is pending.
- `correlate` — send the reports and attach a random installation ID, so one can be associated
  with the last Beezi account linked on this machine.
- `anonymous` — the way to withdraw correlation: it removes that ID, deletes the reports already
  stamped with it, and leaves the reports themselves on.

If the user asks what is collected: a fixed failure code, which plugin file and line failed, the
plugin and Node versions, the operating system, and an HTTP status when there was one. Never their
code, prompts, file contents, file paths outside the plugin, repository names, hostname or account
identity.

Diagnostics are OFF until someone turns them on. Whatever the user chooses is the answer: state
what each setting does if asked, do not argue for a different one, do not present any setting as
the preferred one, and do not ask again later.
