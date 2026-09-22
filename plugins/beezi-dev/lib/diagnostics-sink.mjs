// The one lazy bridge from a hook's hot path to the consent-gated diagnostics facade.
//
// WHY IT IS ITS OWN MODULE. `lib/telemetry.mjs` reaches `lib/telemetry-worker.mjs`
// (`child_process`) and `lib/telemetry-transport.mjs` (`lib/http.mjs`, `lib/fetch-compat.mjs`), and
// the modules that want to record an issue — `lib/hook-runner.mjs`, which is the FIRST statement of
// every hook entry, and `lib/checkpoint.mjs`'s flush wrapper — are the ones that must not put that
// stack on their import graph. A static import there would spend a process spawn's worth of module
// evaluation on every tool call for a diagnostic almost no run emits. The same objection is written
// out at length in `lib/fs-store.mjs`'s reporter seam.
//
// A COPY of this three-line loader in each caller is the drift this file exists to prevent: two
// sinks that disagree about whether a rejected import is silent is a machine where half the
// diagnostics vanish and nothing says so.
//
// Node 13.2 floor: dynamic `import()` only, no `?.`, no `??`, no top-level await.

// Resolved at most once per process, and a failure is remembered as `null` rather than retried —
// a machine with no consent record, or one where the facade cannot load at all, must not pay for
// the attempt on every issue.
let loading = null;

// Record one structured issue, best-effort and asynchronously.
//
// NEVER awaited by a caller, never throws, never rejects. A hook's outcome is decided by the hook;
// a diagnostics facade that is broken, slow or offline is not a reason to change what the host is
// told. Returns the pending promise only so a caller that genuinely has a window before exit can
// attach to it — `lib/hook-runner.mjs`'s caught path does; its uncaught path cannot, because an
// uncaught exception leaves through a synchronous `process.exit`.
export function lazyRecordIssue(code, fields) {
  try {
    if (loading === null) {
      loading = Promise.resolve()
        .then(() => import('./telemetry.mjs'))
        .catch(() => null);
    }
    return loading.then((mod) => {
      if (mod === null || mod === undefined || typeof mod.recordIssue !== 'function') return false;
      // RECORD ONLY. Deliberately NOT `maybeLaunchWorker()`: the delivery worker is a process
      // spawn, and a hook exists to be cheap and to end. The long-lived MCP server is the one
      // process that launches it (see lib/mcp-bridge.mjs's createIssueRecorder), and it drains
      // whatever the hooks queued. A hook that spawned a deliverer would be paying for a network
      // round trip on the user's tool call to report that an earlier tool call went wrong.
      return mod.recordIssue(code, fields === undefined ? {} : fields);
    }, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

// Tests only: forget the memo so a case can drive a fresh load. Production never calls it — the
// facade cannot change under a running process.
export function resetDiagnosticsSink() {
  loading = null;
}
