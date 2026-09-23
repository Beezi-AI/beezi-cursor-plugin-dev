---
name: beezi-sync
description: Upload past Cursor sessions to Beezi analytics, skipping whatever Beezi already has
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-sync/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only this command:

`node "<BEEZI>/scripts/sync.mjs"`

Report its output to the user verbatim — the progress lines and the final summary, or the error
line. It can take a few minutes on a machine with a lot of history. Never echo any token.

## What it does, and what it does not

It asks Beezi how much of each session it already holds and uploads only the part that is missing,
so running it twice in a row is safe and the second run uploads nothing. It is **not** the one-time
history import: it never finalizes that import, never re-opens it, and never changes it in either
direction. A machine whose one-time import has already been used can still run this.

It only ever covers what is still on this machine, and only the **last 30 days**: sessions whose
last real activity is older than that are skipped and reported as skipped, on this command and on
the one-time import alike. History older than 30 days is deleted locally by the plugin's own
retention, and nothing can bring it back.

## Flags

`--dry-run` reports what would be uploaded and sends nothing.

`--history` is a local, read-only count: how many conversations this plugin recorded, and how many
exist only in Cursor's own storage (from before the plugin was installed, older than the 14 days
Cursor itself keeps, or past this plugin's own 30-day retention). It
makes no network request and uploads nothing. Report its output verbatim; it says plainly that the
conversations it found in Cursor's storage cannot be uploaded, and why. Do not offer to upload them
and do not suggest that support is coming.

There is deliberately no `--since` and no `--force`, and the command rejects both with an
explanation. Do not try to work around either: `--since` would filter on when a session last ran,
which says nothing about what Beezi is missing, and there is no one-time seal on this path to force
past. If the user asks for them, relay the command's message and stop.

## When it stops early

Each of these is a safe stop — nothing was uploaded and nothing was changed. Relay the message and
do not retry in a loop.

- **Beezi could not confirm what it already holds.** The command refuses to upload rather than risk
  counting the same work twice. Try again later.
- **Part of the pending upload queue could not be read.** Start a new Cursor session (or run the
  beezi-track skill) to flush the queue, then run this again.
- **Resumable sync is not enabled in this build.** Nothing to fix locally; the one-time import is
  unaffected.
- **This Beezi server does not support the repeatable sync yet.** Try again after the portal update.
- **The machine is not linked.** That is the `beezi-login` skill.

If it says your saved sign-in could not be read, that is not a sign-out: wait a moment and run the
command again. Do NOT run the login skill for it.
