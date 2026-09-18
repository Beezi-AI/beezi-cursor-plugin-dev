---
name: beezi-login
description: Link this machine to Beezi analytics (browser sign-in with your Beezi account)
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-login/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only the commands below,
exactly as written.

## The steps are separate — stop where one actually fails

Signing in, capturing the plan, installing the hooks and uploading history are four independent
steps. Run them in order, report each one's output verbatim, and **stop at the first step that
actually fails** rather than pressing on and summarising a success that did not happen. A step that
reports a WARNING is not a failure — carry on and relay the warning at the end.

Never re-run step 1 to "fix" a later step. A machine that is already linked but has no plan
captured needs step 2, not another browser sign-in.

## Step 1 — link the machine

`node "<BEEZI>/scripts/login.mjs"`

Report its output to the user verbatim. A browser tab opens; the command prints the URL as well, so
pass that on if the tab does not appear. Wait for the command to finish before continuing.

What its outcomes mean:

- **already linked** — continue to step 2. A plan can go stale on a linked machine.
- **linked** — the credential is stored. If the output also says the analytics hooks were installed
  as part of the sign-in, tell the user Cursor has to be restarted before anything is reported.
- **not permitted** (a 403 from the portal) — the account is authenticated and this tenant is not
  allowing it. **Stop.** Do not run the later steps, and do not suggest signing in again: it cannot
  grant a seat. The existing authorization was deliberately left in place.
- **sign-in stopped before opening a browser** — the plugin's own data directory could not be
  written, so a completed sign-in could not have been saved. **Stop** and relay the directory and
  the error code it named. No browser was opened and no existing credential was touched.
- **any other failure** — **stop**, and say the machine is not linked. A failed sign-in leaves any
  previously stored authorization exactly as it was: the credential store is only replaced by a
  sign-in that completes, so the user has lost nothing by retrying.

## Step 2 — capture the Cursor subscription tier

First, try to read the plan from Cursor itself:

`node "<BEEZI>/scripts/billing-capture.mjs" --from-cursor --via login`

Read the last line, which starts with `beezi-billing-result:` and is followed by JSON. If its
`outcome` is `changed` or `kept`, the plan is captured — skip the rest of this step and go to
Step 3. For `no-source`, `needs-user` or `unverified`, continue and ask the question below.

Ask the user which Cursor plan they are on with the **AskUserQuestion tool**. Never guess the
plan, never read it from a file, and never skip the question. One single-select question:

- question: "Which Cursor plan is this machine on?" — header: "Cursor plan"
- options, in this order: the first four **Plan** labels in the table below.

A user on a Teams or Enterprise plan will not find their plan among the options: they pick
"Other" and type it. Map what they type onto exactly one of the table's last three rows; if their
answer does not clearly name one of those three, ask again.

Only if the AskUserQuestion tool is unavailable in this environment (it does not exist in
Cursor's agent), ask in plain conversation as this exact numbered list, and accept a bare digit
as the answer:

```
Which Cursor plan is this machine on?
  1. Pro
  2. Pro+
  3. Ultra
  4. Free / Hobby
  5. Teams / Enterprise
```

A `5` needs one follow-up: Teams Standard, Teams Premium or Enterprise.

| Plan | Digit | Value to pass |
| --- | --- | --- |
| Pro | 1 | `pro` |
| Pro+ | 2 | `pro_plus` |
| Ultra | 3 | `ultra` |
| Free / Hobby | 4 | `free` |
| Teams Standard | 5 → follow-up | `team` |
| Teams Premium | 5 → follow-up | `team_premium` |
| Enterprise | 5 → follow-up | `enterprise` |

Those seven values are the entire set the script accepts; it rejects anything else. Do not invent
some other spelling — if the resolved value is not one of the seven, ask again instead of running
the command.

Then run, substituting only the resolved value:

`node "<BEEZI>/scripts/billing-capture.mjs" --plan <value> --via cursor-command`

Report the output verbatim.

## Step 3 — make sure the hooks are actually installed

Analytics only flow once a hook registry Cursor reads carries Beezi's entries. Run:

`node "<BEEZI>/scripts/install.mjs" status`

Report its output verbatim and follow what it says. If it reports the hooks are not installed, run
`node "<BEEZI>/scripts/install.mjs" install` and tell the user to restart Cursor —
hook registries are read when the app starts.

## Step 4 — upload past sessions (ALWAYS run this last)

Only reached if steps 1–3 did not fail. Run it after Steps 2/3, on both fresh links and
already-linked machines. Run EXACTLY this one
command:

`node "<BEEZI>/scripts/backfill.mjs" --via login`

It is the one-time upload of this machine's recorded Cursor history into Beezi and can take
several minutes; it prints progress lines as it goes. Report its output verbatim — progress and
final summary, or the error line. It is safe on every login: already-uploaded sessions are
skipped, and if it says nothing new to upload, just tell the user their history is up to date. If
some sessions could not be delivered, tell the user that re-running this login skill later will
resume the upload where it left off. Never echo any token.

If it reports the one-time import **has already been used**, that is final — the import is once
per account and cannot be re-run. Do NOT retry, do NOT run the script again with different flags,
and refuse politely if the user asks you to bypass it; relay the script's message (including the
upgrade suggestion when it prints one) and stop.

Note for the user, only when Step 4 reports the pull finalized: the pull is one-time per account
and tool — if they have Cursor history on other machines, they should run this login skill there
BEFORE it finalizes; a finalized pull cannot be re-opened.
