---
name: beezi-me
description: Show whether this machine is linked to Beezi and whether analytics are being reported
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-me/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only this command:

`node "<BEEZI>/scripts/me.mjs"`

Report its output to the user verbatim.

## What the output means

The command answers two separate questions — is this machine linked, and are the analytics hooks
installed. Both have to be true before anything is reported, so pass on both lines even when the
first one is good news.

The first line names one observed status. Do not paraphrase one as another:

- **linked** — the portal accepted the stored token. Analytics can flow once the hooks are in.
- **not linked** — no credential is stored. Signing in is the fix.
- **the stored credential could not be read** — the OS credential store did not answer, or what it
  holds could not be parsed. This does **not** mean the machine is unlinked, and it is **not** a
  reason to sign in again: a new sign-in cannot fix a store that will not answer, and the existing
  link is very likely still there. Suggest running the command again, and checking that the OS
  keychain / Credential Manager is unlocked.
- **a new sign-in is needed** — the sign-in provider disowned the stored grant. The credential was
  deliberately kept; signing in replaces it. This one **is** a reason to run `beezi-login`.
- **not permitted** — the account is authenticated and this tenant is not allowing it. Signing in
  again cannot change this; the user needs an administrator.
- **a refresh is in progress** — another Beezi process is mid-refresh. Just try again.
- **could not reach Beezi** — the link may be perfectly fine; the portal did not answer. Say that
  the status is unknown, not that anything is broken.

If the user asks *why* nothing is arriving, the answer is in that output, or in
`node "<BEEZI>/scripts/install.mjs" status`. Do not investigate by reading configuration files or
inspecting `~/.cursor`, and never offer to delete credentials to "reset" a status you did not
understand.
