---
name: beezi-refresh
description: Refresh this machine's Cursor subscription plan for Beezi analytics (no re-login needed)
disable-model-invocation: true
---

**Resolve `<BEEZI>` first.** Every command below contains `<BEEZI>`, which stands for this
plugin's directory. It is not a shell variable and nothing expands it — substitute the real path
yourself before running anything, and never pass `<BEEZI>` or `$CURSOR_PLUGIN_ROOT` to a shell.

Cursor gave you this file's absolute path on the `Path:` line directly above the skill content.
`<BEEZI>` is that path with the trailing `skills/beezi-refresh/SKILL.md` removed — three path
segments. Nothing else has to be discovered: the scripts live in `<BEEZI>/scripts/`.

Do NOT read, open, or inspect any files. Do NOT search the codebase. Run only the commands below,
exactly as written.

This skill updates the stored Cursor plan. It does **not** re-link the machine and never opens a
browser — the Beezi sign-in is a separate skill and is not needed here.

## Step 1 — try to read the plan from Cursor itself

`node "<BEEZI>/scripts/billing-capture.mjs" --from-cursor --force --via refresh`

Report its human-readable output verbatim, then read the LAST line, which always starts with
`beezi-billing-result:` and is followed by JSON. Use its `outcome` field — never the prose — to
decide what happens next:

| `outcome` | What it means | What to do |
| --- | --- | --- |
| `changed` | The plan was captured or corrected. | Done. Stop here. |
| `kept` | The stored plan was re-confirmed. | Done. Stop here. |
| `unverified` | Nothing new could be read; the stored plan still stands but was not confirmed. | Done, unless the user says the tier is wrong — then go to Step 2. |
| `no-source` | Cursor's local account record could not be read on this machine. | Go to Step 2. |
| `needs-user` | There is no usable plan (new machine, or the Cursor account changed). | Go to Step 2. |

If the command exits non-zero, report the `✗` line verbatim and stop; do not retry with different
flags.

## Step 2 — ask the user, then record the answer

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

`node "<BEEZI>/scripts/billing-capture.mjs" --plan <value> --via refresh`

Report the output verbatim.

## Notes

- Never pass `--email`. The plugin learns the account address from Cursor itself; typing one in
  would attach a guessed identity to the plan.
- `--expires-at` is deprecated and ignored. Do not use it.
- If the user just wants to know what is currently recorded without changing it, run
  `node "<BEEZI>/scripts/me.mjs"` instead of this skill.
