---
name: beezi-analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary, or spend summary from the terminal.
disable-model-invocation: true
---

This skill is a launcher, and it runs no script. The summary workflow lives on the `beezi` MCP
server so it stays in step with what the server can actually answer — **do not improvise your own
flow, and do not restate the workflow from memory.** The MCP server is already connected in this
session; nothing has to be installed or resolved first.

## Do this

1. Read the period out of what the user asked for: `7d` or `30d`. Anything else, including no
   period at all, is `7d`.
2. Call `get_analytics_instructions` on the `beezi` MCP server.
3. Follow the returned instructions exactly, passing the period from step 1.

The instructions decide which other tools are called and in what order. Do not reach past them: a
summary assembled from whatever tool looked relevant is a number the user will act on, and there is
no way for them to tell it apart from the real one.

## When it does not work

**Only `beezi_login` is offered by the server, and nothing else.** This machine is not linked. That
single tool is the sign-in — call it, then retry `get_analytics_instructions` in the same session.
The server picks up the new credentials without a restart and re-advertises its tools.

**No `beezi` tools at all, not even `beezi_login`.** The MCP server is not connected. Ask the user
to confirm the `beezi` plugin is installed in Cursor and to start a new chat. Do not go looking for
the data yourself.

**An authentication error on a linked machine.** The stored credentials were rejected — a link
revoked from the Beezi portal does exactly this. Call `beezi_login` again, then retry once.

**Anything else.** Report the message the tool returned, plus the `correlationId` if the result
carries one, and stop. Do not retry blindly.

In every one of these cases, say that the summary could not be produced. Never estimate the user's
spend, session count or recommendations from anything else in the conversation — a plausible number
presented as their analytics is worse than no answer.
