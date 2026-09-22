import { installHookGuards, runHook } from '../lib/hook-runner.mjs';
import { claimHookRun } from '../lib/hook-source.mjs';
import { enterProjectDir } from '../lib/hook-cwd.mjs';
import { captureHookStdin, dumpHookPayload } from '../lib/hook-dump.mjs';

// FIRST STATEMENT — see lib/hook-runner.mjs.
installHookGuards({ name: 'stop-failure' });

// Capture, when it is switched on; two environment reads and a return otherwise. Above claimHookRun
// so the record is of the run as Cursor started it. See lib/hook-dump.mjs.
const stdin = captureHookStdin();
dumpHookPayload(stdin == null ? undefined : stdin.raw);

// Records this run's registry for the status surfaces; always true. See lib/hook-source.mjs.
//
// The stand-down that used to live here exited a launcher run whenever a bundled run had been
// recorded in the last fortnight. The Cursor CLI runs no plugin-bundled hook at all (Cursor staff,
// forum 163890), so on a machine that used both hosts, every tool failure under `cursor-agent` went
// unreported — the one hook whose entire job is telling the user something broke.
if (!claimHookRun()) process.exit(0);

// Attribute the user's repository, not the plugin clone Cursor starts in. See lib/hook-cwd.mjs.
enterProjectDir();

// `postToolUseFailure` — the failure-reporting hook the Codex fork had to delete (Codex has no
// equivalent lifecycle event, so hard failures went unreported there). Cursor fires this one, so
// session-error reporting is back.
//
// Deliberately NOT a full checkpoint: a failing tool call is common, and running the reporting
// engine on each one would put git shell-outs and a queue flush on a path that fires mid-error.
// The sidecar line is written unconditionally; the error POST is the only network work, and it is
// bounded and best-effort.
runHook({
  name: 'stop-failure',
  stdin,
  // The transport, the credential store and the redactor all arrive here rather than at the top of
  // the file: a payload we cannot attribute should cost one short-lived process, not a module graph
  // — and any of these can throw while being evaluated, which used to exit the hook non-zero.
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
    import('../lib/tracking.mjs'),
    import('../lib/token.mjs'),
    import('../lib/session-error-report.mjs'),
    import('../lib/redact.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar, tracking, tokens, transport, redact] = mods;
    for (const event of events.eventsFromHookPayload(ctx.payload)) {
      sidecar.appendEvent(ctx.input.session_id, sidecar.withCwd(event, ctx.cwd));
    }

    // TENANT POLICY, BEFORE THE CREDENTIAL. A session-error report is authenticated user-session
    // analytics, so a tenant switched to `backfill_only` or `disabled` must see neither a keychain
    // read nor a request — not a request that is built and then dropped. Consent is a different
    // question and does not stand in for this one.
    //
    // The sidecar line above is deliberately NOT gated: it is local collection, it is what the
    // checkpoint reports from, and the checkpoint applies the same policy on its own path. Gating it
    // here would lose the failure from the segment as well as from the error report.
    //
    // The gate is FAIL-OPEN by lib/tracking.mjs's own contract: an absent or unreadable cache means
    // allow, because the server is the real boundary and failing closed would dark-mode every fresh
    // install until its first whoami.
    if (!tracking.isLiveTrackingAllowed()) return null;

    // The output of a command that JUST FAILED — which is exactly where credentials surface. The
    // `curl` that 401'd is echoed with its `-H "Authorization: Bearer …"` intact; a `git push` that
    // was refused quotes the remote URL with the token still in its userinfo; a driver that could not
    // connect prints the DSN it parsed; a shell that could not find a binary dumps the environment.
    // This used to be `detail.slice(0, 2000)` and went to the API verbatim.
    //
    // `redactDetail` is that slice with the scrubbing in front of it, and the order matters:
    // truncating first can cut a credential away from the anchor that identifies it — a `Bearer`
    // separated from its token, a key name separated from its `=` — and leave the surviving half in
    // the report with nothing left to match it. See lib/redact.mjs, and test/redact.test.mjs for the
    // negative table that keeps this off ordinary diagnostics.
    //
    // First field actually present wins, and `null`/`undefined` is the only thing that counts as
    // absent: an empty-string `error` is a real (if unhelpful) report and must not fall through to
    // `tool_output`.
    const payload = ctx.payload;
    const detail =
      payload == null ? null
        : payload.error != null ? payload.error
          : payload.tool_output != null ? payload.tool_output
            : payload.output != null ? payload.output
              : null;

    // WHEN IT HAPPENED, captured now rather than at send time. The queue, a slow credential store
    // and a retried POST all sit between this moment and the request, and a timestamp taken at the
    // transport would quietly describe the delivery instead of the failure. `ctx.occurredAt` prefers
    // a validated instant from the normalized host payload and falls back to this run's clock — see
    // hookOccurredAt in lib/hook-runner.mjs, and the handoff for the normalization field it wants.
    const occurredAt = ctx.occurredAt;
    return tokens.getAccessToken().then((token) =>
      token
        ? transport.postSessionError(
            {
              sessionId: ctx.input.session_id,
              error: 'tool_failure',
              errorDetails: redact.redactDetail(detail),
              lastAssistantMessage: null,
              occurredAt,
            },
            token,
            // What is LEFT of the hook deadline, read here rather than at the top: the sidecar
            // append, the policy read and the credential lookup have all been paid for out of it,
            // and a transport given a fresh full budget would be killed by the host mid-request
            // instead of returning in time for a clean exit.
            { timeoutMs: ctx.remainingMs(), occurredAt },
          )
        : null);
  },
});
