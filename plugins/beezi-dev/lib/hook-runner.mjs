// The bootstrap every Beezi hook entry runs, and the only place a hook decides how to fail.
//
// WHAT THIS IS FOR. Eight of the ten hook scripts used to have no failure handling at all: a module
// that threw while being evaluated, a business function that threw, or a promise nobody caught left
// the process with a non-zero exit code and a stack trace on stderr. Cursor records that as a FAILED
// HOOK in its execution log — so a plugin whose analytics are best-effort by design was reporting
// host-level failures on the user's own tool calls, several times a minute, for work nobody was
// waiting on. Two scripts (mcp-before, subagent-start) already installed the handlers by hand, and
// those two are the pattern the other eight are brought up to here.
//
// WHAT IT CANNOT DO, said plainly because the alternative is a comforting lie: a syntax error in a
// hook script itself, or in this module, is a parse failure. Nothing inside the file that failed to
// parse can catch it — not these handlers, not a try/catch. Containment starts at the first
// statement of a script that parsed, which is why the scripts keep their static imports down to the
// four small bootstrap modules and reach everything else through `load`.
//
// THE ORDER MATTERS AND IT IS NOT NEGOTIABLE. ESM evaluates every static import before the first
// statement of the importing module, so a handler installed in a script body cannot protect that
// script's own imports. `installHookGuards()` is therefore the first statement of every hook entry,
// and every module that can fail during evaluation — the reporting engine, the sidecar, the token
// store, the transport — arrives through the `load` callback, after the handlers exist.

// Cursor's per-handler `timeout`, in MILLISECONDS, for the three kinds of hook this plugin registers.
// Both registries (the bundled hooks/hooks.json and the user-scope one lib/hooks-install.mjs writes)
// derive their declared seconds from this table, so the two cannot drift apart.
//
// Why the permission kind is smaller. `beforeMCPExecution` and `subagentStart` sit IN FRONT of an
// action the user asked for: the host waits for the hook before dispatching the MCP call or starting
// the subagent. A stalled write on that path costs the user the full timeout in dead time, staring
// at an editor that has not moved. The analytics hooks run behind the work and cost nobody anything
// when they are slow, so they keep the 10s the checkpoint budget is derived from. Five seconds is
// still far more than the permission path's actual work (one sidecar append) can take; it is a
// ceiling for a wedged filesystem, not a target.
//
// Why the GATE kind is smaller still. `beforeSubmitPrompt` is synchronous and sits between the
// user's Send and the model: Cursor waits for its answer before the prompt goes anywhere, on EVERY
// turn. The analytics ten seconds there would be a Send button that can freeze for ten seconds, and
// even the permission five is a long time to stare at a prompt that has not left. Its work is one
// sidecar append, and its script answers `{"continue":true}` before doing any of it (see
// scripts/prompt-submit.mjs), so three seconds is again only a ceiling for a wedged filesystem.
// It is NOT a permission hook: that kind's stdout is empty by contract and tested to be, while this
// one's must carry exactly one token.
export const HOOK_TIMEOUTS = Object.freeze({ analytics: 10000, permission: 5000, gate: 3000 });

// The `kind` spelling of a gate hook, for hookBudgetMs. A hook entry says `gate: true` the way a
// permission one says `permission: true`; this constant is what that boolean maps to.
export const HOOK_KIND_GATE = 'gate';

// Which of the three kinds an entry's options describe. `gate` wins over `permission` only because
// no entry is both; the two are separate flags so an entry cannot become one by naming the other.
function hookKindOf(opts) {
  if (opts != null && opts.gate === true) return HOOK_KIND_GATE;
  if (opts != null && opts.permission === true) return 'permission';
  return 'analytics';
}

// What a hook leaves between finishing its work and the host's kill. It covers node's own startup,
// which is paid before any code here runs, plus the process teardown after it.
//
// It is the same 2500 ms `lib/checkpoint.mjs` subtracts from the analytics timeout for HOOK_BUDGET_MS
// — but that file spells the number out as a literal of its own, so the two are equal by agreement
// and not by construction, and a change here would silently reach the runner's hooks and not the
// checkpoint's budget. The handoff carries the one-line patch that has checkpoint.mjs import this
// constant instead; until integration applies it, changing this number means changing that one too.
export const HOOK_GUARD_MARGIN_MS = 2500;

// The two spellings of "allow" a permission hook can leave on stdout.
//
// Cursor reads a permission hook's stdout as JSON and OBEYS it. `{}` carries no `permission` key, so
// the host's own default stands — an explicit, parseable no-opinion. An empty stream is the same
// answer said by saying nothing, and it is the one this plugin has always given: the scripts are
// grepped by test/plugin-manifest.test.mjs for any way of reaching stdout at all, precisely so that
// a token which could be coerced into a decision can never appear on the path that gates a user's
// MCP call.
//
// So silence is the default here and `{}` is available to a caller that wants it. The choice is a
// deviation from CONTRACTS §9, which names `{}`; it is recorded in the handoff with the frozen test
// that forces it. Whichever is chosen, it is written ONLY when the handler wrote nothing itself —
// see `runHook`, which owns every byte of a hook's stdout for exactly this reason.
export const PERMISSION_FAILURE_OUTPUT = '';
export const PERMISSION_ALLOW_OUTPUT = '{}';

// The window an occurrence timestamp has to fall inside to be believed.
//
// It is what makes "epoch or ISO" a decision rather than a guess. A seconds-epoch value handed in as
// milliseconds lands in 1970 and is REJECTED here rather than silently multiplied by a thousand —
// scaling it would be inventing a unit the host never declared. A value in the far future is the
// same mistake in the other direction.
const OCCURRED_FLOOR_MS = Date.UTC(2000, 0, 1);
const OCCURRED_CEIL_MS = Date.UTC(2100, 0, 1);

// A date-first shape, so a bare number-in-a-string or a loose "July 2026" cannot be coerced into an
// instant by Date.parse's implementation-defined fallback.
const ISO_HEAD = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// WHEN the thing this hook is reporting actually happened.
//
// Taken at hook time and carried on the payload, because everything between here and the wire can
// delay delivery — a slow credential store, a queued retry, a backoff — and a timestamp read at the
// transport would describe the delivery rather than the event. Delayed execution must retain the
// captured occurrence time.
//
// The source is the NORMALIZED input's `occurred_at`, never a raw Cursor field name: which fields a
// Cursor payload carries, and what they mean, is the input-normalization owner's question and is not
// answered by guessing here. Until that field exists the fallback is always taken, which is the
// documented, correct behaviour for a hook that is running right now anyway.
export function hookOccurredAt(input, nowMs) {
  const raw = input == null ? null : input.occurred_at;
  let ms = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) ms = raw;
  else if (typeof raw === 'string' && ISO_HEAD.test(raw)) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === null || ms < OCCURRED_FLOOR_MS || ms > OCCURRED_CEIL_MS) ms = nowMs;
  return new Date(ms).toISOString();
}

// How long a hook of this kind may spend before it has to be finished.
//
// `true` is the permission kind and `false` the analytics one, as they always were; the gate kind is
// asked for by name (HOOK_KIND_GATE). A gate budget is 500 ms — node's startup is inside the margin,
// and the one append this kind does takes a millisecond on a healthy disk.
export function hookBudgetMs(kind) {
  let ceiling = HOOK_TIMEOUTS.analytics;
  if (kind === true || kind === 'permission') ceiling = HOOK_TIMEOUTS.permission;
  else if (kind === HOOK_KIND_GATE) ceiling = HOOK_TIMEOUTS.gate;
  return ceiling - HOOK_GUARD_MARGIN_MS;
}

// Whether this process has already put something on stdout. Module scope because the guards and the
// handler's `emit` are two different call sites answering one question — "is the stream still mine
// to write?" — and a hook process runs exactly one hook.
let wroteStdout = false;

function writeOut(deps, text) {
  const write = deps.write == null ? ((s) => process.stdout.write(s)) : deps.write;
  write(text);
  wroteStdout = true;
}

// Fire the diagnostics callback and forget about it.
//
// Never awaited, never allowed to throw, never allowed to reject into the process. A hook's outcome
// is decided by the hook; a telemetry facade that is broken, slow or offline is not a reason to
// change what the host is told. It is consent-gated on its own side.
//
// The default reaches `lazyRecordIssue` (lib/diagnostics-sink.mjs) through a DYNAMIC import, and
// BOTH halves of that matter. lib/telemetry.mjs reaches child_process and http, and this module is
// the first statement of every hook entry — including the two permission hooks that sit in front of
// a user's tool call — so a static import would spend that evaluation on every run for a diagnostic
// almost none of them emit. This file has no static imports at all, by design (see the header), and
// reaching the sink dynamically is what keeps it that way while still leaving exactly ONE loader on
// the machine: a second copy of it inlined here is how two sinks end up disagreeing about whether a
// failed load is silent.
//
// WHAT THAT COSTS, stated rather than implied: the loader needs a turn of the loop. `runHook`'s
// caught path has one — it leaves through `finish`, which awaits the shutdown drain — so
// hook_import_failed, hook_crash from the decode step and a handler's own failure are recorded.
// `installHookGuards`'s process handlers do NOT: an uncaught exception leaves through a synchronous
// `process.exit`, and nothing started there can resolve first. Those two codes therefore still need
// an injected SYNCHRONOUS recorder to be delivered, which is why the seam stays injectable.
function safeRecord(deps, code, name) {
  const injected = deps != null && typeof deps.recordIssue === 'function' ? deps.recordIssue : null;
  const record = injected == null
    ? ((issue, fields) => import('./diagnostics-sink.mjs').then(
      (mod) => mod.lazyRecordIssue(issue, fields),
      () => false,
    ))
    : injected;
  try {
    // Structured fields only. No message, no stack, no path: an exception's text routinely carries
    // the user's home directory, a command line or a token, and this is the one call on the failure
    // path that could put it somewhere it outlives the process.
    const pending = record(code, { source: name == null ? null : name });
    if (pending != null && typeof pending.then === 'function') pending.then(() => {}, () => {});
  } catch { /* diagnostics must never change a hook's outcome */ }
}

// The single exit taken by every failure path: record, emit protocol-safe output, exit 0.
//
// Exit 0 is not politeness. For a permission hook, 2 BLOCKS the user's action and any other non-zero
// code is logged as a failed hook; for an analytics hook, non-zero is the failed-hook entry this
// module exists to remove. Zero with nothing on stdout is "I ran, I have no opinion".
function createBail(opts, deps) {
  // A gate entry is never treated as a permission one here, even if both flags were set: its script
  // has already written the one token Cursor may see, and a failOutput behind it is two tokens.
  const permission = opts.permission === true && opts.gate !== true;
  const exit = deps.exit == null ? ((c) => process.exit(c)) : deps.exit;
  let bailed = false;
  return function bail(code) {
    // A crash during the crash path — or a rejection surfacing after the exception handler already
    // ran — must not exit twice or write twice.
    if (bailed) return;
    bailed = true;
    safeRecord(deps, code, opts.name);
    // Only the permission kind has a protocol to be safe in: Cursor reads its stdout. An analytics
    // hook's return value is validated and dropped (Cursor forum #155689), so its failure path
    // writes nothing at all. Neither does a gate hook's: its script answered before this could run.
    if (permission && !wroteStdout) {
      const out = opts.failOutput == null ? PERMISSION_FAILURE_OUTPUT : opts.failOutput;
      if (out !== '') {
        try { writeOut(deps, out); } catch { /* a closed pipe is still fail-open */ }
      }
    }
    exit(0);
  };
}

// Install the process-level handlers. THE FIRST STATEMENT OF EVERY HOOK ENTRY — see the header.
//
// Returns its own bail function, which is the handler both process events share: it exits on the
// first failure and ignores every one after it, so a rejection surfacing behind an exception cannot
// exit twice or write twice.
//
// `runHook` deliberately does NOT reuse it. A failure the runner CAUGHT has unwound normally and
// leaves through `exitClean`, while an uncaught one cannot assume anything about the process and
// leaves immediately — same exit code, different discipline, so they are different functions. The
// return value is here for a caller that wants to trigger the uncaught path itself; no hook entry
// currently does.
export function installHookGuards(options) {
  const opts = options == null ? {} : options;
  const deps = opts.deps == null ? {} : opts.deps;
  const on = deps.on == null ? ((ev, fn) => process.on(ev, fn)) : deps.on;
  const bail = createBail(opts, deps);
  on('uncaughtException', () => bail('hook_crash'));
  on('unhandledRejection', () => bail('hook_unhandled_rejection'));
  return bail;
}

// Leave the process.
//
// The analytics path drains undici's keep-alive pool and lets the loop empty on its own — see
// lib/shutdown.mjs for the libuv assertion that forcing the exit produces on Windows. The permission
// path does NOT: it opens no socket, so there is nothing to drain, and loading the shutdown module
// there would put one more evaluable file in front of a user's tool call for no benefit. That is the
// same reason the permission path does no network and flushes no telemetry.
//
// `immediate` is true for the permission AND the gate kind. The gate hook opens no socket either,
// and it stands between the user's Send and the model, so a drain there is dead time on every turn.
async function finish(immediate, deps) {
  const exit = deps.exit == null ? ((c) => process.exit(c)) : deps.exit;
  if (immediate) { exit(0); return; }
  try {
    const shutdown = deps.shutdown == null ? await import('./shutdown.mjs') : deps.shutdown;
    await shutdown.exitClean(0);
  } catch {
    exit(0);
  }
}

// Decode the payload, load the business modules, run the handler — with every step contained.
//
// `load` is a callback rather than a module specifier so a script can pull several modules in one
// `Promise.all` and keep its own imports down to the bootstrap four. It runs INSIDE the try: a
// module that throws while being evaluated is the failure mode this whole file exists for, and it is
// indistinguishable from a handler throwing as far as the host is concerned.
export async function runHook(options) {
  const opts = options == null ? {} : options;
  const deps = opts.deps == null ? {} : opts.deps;
  const kind = hookKindOf(opts);
  const permission = kind === 'permission';
  // Permission and gate both leave by the immediate exit: neither holds a socket, and both sit in
  // front of something the user is waiting for.
  const immediate = kind !== 'analytics';
  const now = deps.now == null ? Date.now : deps.now;
  const deadlineAt = now() + hookBudgetMs(kind);
  // A hook process runs exactly one hook, so this is a no-op in production. It matters in tests,
  // where many runs share one process: a leftover `true` from an earlier run would suppress the next
  // run's fail-open token, and the suite would pass for the wrong reason in one order and fail in
  // another.
  wroteStdout = false;

  // A failure this function CAUGHT, as opposed to one that reached the process handlers.
  //
  // The difference is the way out. `createBail` exits immediately because an uncaught exception
  // leaves the process in a state nothing may assume anything about. Here the stack has unwound
  // normally, so the analytics path takes the ordinary `finish` — which drains undici's keep-alive
  // pool before letting the loop empty. That is not tidiness: forcing an exit while a socket is
  // mid-close fast-fails the process on Windows with a libuv assertion, and Cursor reports THAT as a
  // failed hook (see lib/shutdown.mjs). Containing an error and then dying on the way out would
  // produce exactly the log entry this module exists to remove.
  const fail = async (code) => {
    safeRecord(deps, code, opts.name);
    if (immediate) {
      // The failure token is the PERMISSION kind's alone. A gate script has already written
      // `{"continue":true}` itself, straight to fd 1 and not through `writeOut` —
      // so `wroteStdout` does not know about it, and a failOutput here would be a second token.
      if (permission && !wroteStdout) {
        const out = opts.failOutput == null ? PERMISSION_FAILURE_OUTPUT : opts.failOutput;
        if (out !== '') {
          try { writeOut(deps, out); } catch { /* a closed pipe is still fail-open */ }
        }
      }
      const exit = deps.exit == null ? ((c) => process.exit(c)) : deps.exit;
      exit(0);
      return;
    }
    await finish(false, deps);
  };

  let decoder;
  try {
    decoder = deps.decoder == null ? await import('./hook-input-cursor.mjs') : deps.decoder;
  } catch {
    await fail('hook_import_failed');
    return;
  }

  let payload = null;
  let input = null;
  let cwd = null;
  try {
    // When capture is on, stdin has already been drained by the script and spilled to `replay`; on
    // every other run this reads fd 0 once. Either way it is read exactly once per process.
    const replay = opts.stdin == null || opts.stdin.replay == null ? null : opts.stdin.replay;
    payload = decoder.readHookInput(replay === null ? 0 : replay);
    input = decoder.normalizeHookInput(payload);
    // stampableCwd, not input.cwd: only a value both registries would derive identically may be
    // stamped on a sidecar line, or the reader's duplicate collapse stops collapsing.
    cwd = input == null ? null : decoder.stampableCwd(payload);
  } catch {
    await fail('hook_crash');
    return;
  }

  // No identity, nothing to attribute. Not a failure: a malformed or partial payload is an ordinary
  // event on this path (see the BOM note in lib/hook-input-cursor.mjs), so it costs one short-lived
  // process and no diagnostics record.
  if (input == null) {
    await finish(immediate, deps);
    return;
  }

  let loaded = null;
  try {
    loaded = typeof opts.load === 'function' ? await opts.load() : null;
  } catch {
    await fail('hook_import_failed');
    return;
  }

  try {
    if (typeof opts.handle === 'function') {
      await opts.handle(loaded, {
        name: opts.name,
        permission,
        input,
        payload,
        cwd,
        // When the reported event happened, as opposed to when it is sent. See hookOccurredAt.
        occurredAt: hookOccurredAt(input, now()),
        // The host's kill, minus the margin, as an absolute instant — so a handler that hands a
        // timeout to the network gives it what is LEFT rather than a fresh full budget.
        deadlineAt,
        remainingMs: () => deadlineAt - now(),
        // The one way to stdout. Routed through here so the failure path can tell a stream it may
        // still write to from one a handler has already committed to.
        emit: (value) => { writeOut(deps, typeof value === 'string' ? value : JSON.stringify(value)); },
      });
    }
  } catch {
    await fail('hook_crash');
    return;
  }

  await finish(immediate, deps);
}
