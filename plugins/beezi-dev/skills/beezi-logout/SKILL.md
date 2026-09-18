---
name: beezi-logout
description: Unlink this machine from Beezi analytics (sign out)
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-logout/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only this command:

`node "<BEEZI>/scripts/logout.mjs"`

Report its output to the user verbatim.

## What the output means

The command reports three independent facts, and its **exit code** follows only the first:

1. **the local credential** — whether it was removed from this machine, *verified* by reading the
   store back afterwards. This is the only part the command controls, so it is the only part a
   success claim rests on. A failure here exits **non-zero**.
2. **the portal** — `confirmed`, `refused`, `unreachable` or `unconfirmed`. A refusal (HTTP 401 or
   403) means the portal declined to act on the token; it is **not** proof that the machine's row
   was removed.
3. **revocation at the sign-in provider** — `confirmed`, `unconfirmed`, or `unavailable` when the
   provider publishes no revocation endpoint.

Do not add reassurance the command did not print. In particular:

- Do **not** tell the user their access was revoked unless the output says it was revoked.
- Do **not** tell them the portal no longer lists this machine unless the output says the portal
  confirmed it. When it does not, the output already names the Connections tab — relay that.
- If the command exits non-zero, the machine may still hold a usable credential and may still
  report analytics. Relay the recovery step it printed; do not call it a success.

Do not offer to delete credential files, keyring entries, or anything under `~/.beezi-cursor` by
hand as a workaround. The command clears every store it owns and verifies it, and a manual deletion
would leave the control record pointing at something that is gone. Queued analytics that have not
been delivered yet are deliberately left in place — signing out is not a request to destroy the
user's own data.
