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
// recorded in the last fortnight. Older CLI builds ran no plugin-bundled hook at all (Cursor staff,
// forum 163890, Jun–Aug 2026), so on a machine that used both hosts, every tool failure under
// `cursor-agent` went unreported — the one hook whose entire job is telling the user something
// broke.
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
  // The transport, the credential store and the classifier all arrive here rather than at the top of
  // the file: a payload we cannot attribute should cost one short-lived process, not a module graph
  // — and any of these can throw while being evaluated, which used to exit the hook non-zero.
  load: () => Promise.all([
    import('../lib/sidecar-events.mjs'),
    import('../lib/sidecar.mjs'),
    import('../lib/tracking.mjs'),
    import('../lib/token.mjs'),
    import('../lib/session-error-report.mjs'),
    import('../lib/session-error-cursor.mjs'),
  ]),
  handle: (mods, ctx) => {
    const [events, sidecar, tracking, tokens, transport, classifier] = mods;
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

    // WHICH FAILURES DESERVE A REPORT, AND WHAT EACH IS CALLED — lib/session-error-cursor.mjs, which
    // also owns the precedence. An interrupted call and an ordinary file/search error answer null:
    // the sidecar line above already recorded them, and a report nobody would act on is not worth a
    // keychain read, so this is asked BEFORE the credential is touched.
    //
    // The scrub moved with the text. A failed command's message is exactly where credentials surface
    // — the `curl` that 401'd echoed with its `-H "Authorization: Bearer …"`, a refused `git push`
    // quoting its remote with the token in the userinfo — and the classifier redacts it before it cuts
    // it, for the reason lib/redact.mjs gives. The transport scrubs again; that pass is idempotent.
    // `tool_input` is never read by either.
    const report = classifier.classifyToolFailure(ctx.payload);
    if (report === null) return null;

    // WHEN IT HAPPENED, captured now rather than at send time. The queue, a slow credential store
    // and a retried POST all sit between this moment and the request, and a timestamp taken at the
    // transport would quietly describe the delivery instead of the failure. See hookOccurredAt in
    // lib/hook-runner.mjs.
    const occurredAt = ctx.occurredAt;
    return tokens.getAccessToken().then((token) =>
      token
        ? transport.postSessionError(
            {
              sessionId: ctx.input.session_id,
              error: report.error,
              errorDetails: report.errorDetails,
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
