import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { installHookGuards } from '../lib/hook-runner.mjs';
import { PROJECT_DIR_VARS } from '../lib/hook-cwd.mjs';

// SAFETY-CRITICAL: this script answers Cursor exactly once, with exactly `{"continue":true}`, and
// must never write another byte or exit non-zero.
//
// `beforeSubmitPrompt` is a GATE hook, the third kind this plugin registers (lib/hook-runner.mjs,
// HOOK_TIMEOUTS). It is synchronous: Cursor holds the user's Send until the hook answers, and reads
// the answer as `{"continue": true|false, "user_message"?}`. `false` refuses the prompt the user
// just typed, `user_message` puts text in front of them, and exit code 2 blocks the prompt outright;
// any other failure fails open. An analytics plugin has no business with any of those, so:
//
//   - the answer is written FIRST, synchronously, straight to fd 1 — before stdin is read and
//     before a single business module is loaded. Every path after this line (an early exit, an
//     unattributable payload, a module that throws while being evaluated, an uncaught throw) has
//     therefore already answered, and answered "continue".
//   - it is written exactly once, and nothing else in this process owns stdout: there is no runner
//     here to write a `failOutput` behind it, and the guards are told `gate: true`, which keeps
//     their crash path silent. Two concatenated tokens are not fail-open, they are malformed output
//     in front of the user's prompt.
//   - the process LEAVES FAST, and that is a separate promise from answering fast. Codex review,
//     BLOCKING: Cursor waits for the hook PROCESS to end, not for the answer on stdout. The script
//     used to answer and then run capture, registry bookkeeping, the runner's dynamic imports and
//     the append with no deadline at all — a simulated 900 ms append kept the process, and so the
//     user's Send, alive 928 ms after `{"continue":true}` was already written.
//   - and the process does NO SYNCHRONOUS I/O after the answer. Codex review, BLOCKING, the second
//     time round: the wall-clock guard added for the first finding is a timer, and a timer cannot
//     interrupt a synchronous call — a 900 ms synchronous append stub kept the process alive 914 ms
//     after answering, guard or no guard. A stalled filesystem (a wedged network drive, an
//     antivirus scan holding the sidecar) would have held Send until Cursor's own kill. So the
//     gate no longer writes the line at all. It reads stdin through events, which leaves the one
//     thread free for the guard; pulls out the ids; hands them to a DETACHED RECORDER — this same
//     script, run again with RECORD_FLAG — and exits. The recorder does the append nobody waits for.
//
// THE TWO PROCESSES, and what each may do:
//
//   the gate      (`--via …`, what Cursor waits for) — the answer, the guard, an event-driven read
//                 of stdin, one decode, one `spawn`, `process.exit(0)`. No file is read or written
//                 synchronously (test/plugin-manifest.test.mjs greps for it), and no filesystem
//                 call of any kind is made — not even the existsSync + chdir every other hook entry
//                 makes to enter the workspace (see the note above `runRecorder()` below).
//   the recorder  (RECORD_FLAG, what nobody waits for) — reads the hand-off from its environment,
//                 validates it, appends the one line ASYNCHRONOUSLY to the sidecar path
//                 lib/sidecar.mjs names (and, with capture on, the capture record asynchronously to
//                 the capture file), and exits — by its own hard deadline if an append never
//                 completes (RECORD_WALL_MS). It has no
//                 stdin, no stdout and no stderr (all three 'ignore'), and it never fails: an error
//                 there is a lost turn-start anchor, and the timeline has a rule for a turn without
//                 one.
//
// NOT on this path, deliberately:
//
//   - `claimHookRun` (lib/hook-source.mjs). It records which registry started a run, for the status
//     surfaces, and every other hook this plugin registers records exactly that on every event —
//     including `stop`, which ends every turn this hook starts. What it would add here is a JSON
//     read and an atomic write in front of every Send, to tell the status surfaces something they
//     already know. The per-script "claims its run" pin in test/plugin-manifest.test.mjs exempts the
//     gate for this reason, and the gate's own structure test pins the absence.
//   - lib/hook-runner.mjs's `runHook`. Its value is containment for scripts that do real work; here
//     it was the source of the unbounded tail (decoder import, `load`, handler, then `finish`), and
//     its 500 ms gate budget was advisory — nothing ever enforced it. The guards are still installed.
//   - telemetry. A failed import, spawn or append is recorded nowhere: recording it means loading
//     the diagnostics sink, which is exactly the kind of tail this rewrite exists to remove.
//
// Static imports are five builtins (`fs` for the answer and the recorder's asynchronous append,
// `child_process` and `os` for the recorder, `path` for its sidecar directory, `url` for this
// file's own path), the guards module (no imports of its own) and hook-cwd, for its
// PROJECT_DIR_VARS list alone (it imports `fs` for enterProjectDir, which this script no longer
// calls; evaluating it touches no file). None of them does filesystem work at the top level.
// Everything that could fail while being evaluated arrives by dynamic import, after the guards exist
// and after the answer is written.
installHookGuards({ name: 'prompt-submit', gate: true });

// The turn's start, taken HERE — right after the guards, before the answer, before stdin — and
// carried to the recorder in the hand-off. The recorder is a fresh node process that pays its own
// startup (and, under the test seam, a deliberate stall) before it writes, so a `ts` stamped there
// would move every turn start later by however long that took, and the gap it moved it into is the
// user's (lib/session-timeline-cursor.mjs, buildPeriods). Read inside a try/catch because this runs
// BEFORE the answer: a clock that throws must cost the line, never the answer. No start time, no line.
let startedAt = null;
try {
  startedAt = Date.now();
} catch {
  startedAt = null;
}

// Which of the two processes this is. The flag is the recorder's alone: Cursor launches the gate
// with `--via <registry>` (hooks/hooks.json, lib/hooks-install.mjs) and never with this.
const RECORD_FLAG = '--record';
const RECORDER = process.argv.slice(2).indexOf(RECORD_FLAG) !== -1;
const SELF = fileURLToPath(import.meta.url);

// The hand-off, in the recorder's ENVIRONMENT and never on its command line: argv is what every
// process listing on the machine shows, to every user. Even so it carries only what the line needs —
// the session id, the generation id, the stamped cwd and the start time — and never a byte of the
// prompt. Both variables are cleared from what the gate passes on before being set, so a stale
// value in the gate's own environment is never replayed.
const RECORD_ENV_VAR = 'BEEZI_PROMPT_RECORD';
const CAPTURE_ENV_VAR = 'BEEZI_PROMPT_CAPTURE';
const DUMP_ENV_VAR = 'BEEZI_CURSOR_DUMP_HOOKS';

// The hard wall-clock guard. Well inside the gate budget (hookBudgetMs, 500 ms) and far inside the
// host's three-second kill, measured from here rather than from spawn — node's own startup is paid
// before any line of this file runs, and the budget's margin is what covers it.
//
// It bounds everything the gate still does after answering, and it can, because none of it is
// synchronous file I/O: stdin arrives through events (a pipe the host never closes simply never
// ends, and the guard fires), the decoder is a dynamic import, and the only file write — the line —
// happens in the recorder. What is left synchronous is the 17-byte answer, which goes first, and the
// `spawn` itself: one process creation from the node binary already running, which touches neither
// the sidecar nor the user's workspace.
const GATE_WALL_MS = 300;
// The recorder's own hard deadline. Nobody waits for it, so this is not a latency bound; it is what
// stops a recorder stuck on a wedged filesystem from living on as an orphan. Codex review, MAJOR:
// it used to be unable to do that job — the append was a synchronous `appendFileSync`, which no
// timer can interrupt, so a wedged sidecar collected one stuck node process per prompt per
// registry. The append is asynchronous now (appendPrompt), so this timer CAN fire while the write
// is outstanding and `process.exit` ends the process (test/prompt-submit.test.mjs, the deadline
// test, which stands for the wedged write with an `fs.appendFile` that never calls back — it proves
// the timer fires with the append pending, not what a given OS does with a threadpool thread stuck
// inside the syscall at exit). Ten seconds is generous for one line of a hundred-odd bytes on a cold node start.
//
// The capture append is held to the same rule (appendCapture). Codex review, MAJOR: with capture on,
// the recorder used to call lib/hook-dump.mjs's dumpHookPayload, whose retention sweep and append are
// both synchronous, so a stalled capture filesystem blocked the thread past this deadline — a 12 s
// stall kept the recorder alive 12,086 ms (test/prompt-submit.test.mjs, the capture deadline test).
//
// What it still cannot cut short, stated: node's own synchronous reads of the plugin's module
// sources while the recorder loads, and the sidecar and capture paths' resolution — with
// BEEZI_CURSOR_HOME unset, lib/env-identity.mjs reads the plugin's env.json once, synchronously. Both are reads of
// the plugin's install directory, not of the sidecar or the user's workspace. And on POSIX, a write
// stuck in the kernel on a hung network mount is uninterruptible for any process, killed or not.
const RECORD_WALL_MS = 10 * 1000;
const leave = () => process.exit(0);

// The ceiling on what stdin may cost. A prompt payload carries the user's whole prompt and their
// attachment list, and a pasted log can make that large; this is the point past which the gate
// stops buffering it. Everything the line needs is two short ids, so a payload the cap cut short is
// DROPPED rather than guessed at — its turn falls back to the timeline's turn-end rule, the same as
// a build that never fires this hook. The cost, stated: the bytes past the cap are left unread, and
// on Windows the PowerShell stage writing them may log a broken pipe. That trade is taken knowingly;
// buffering an unbounded paste in front of Send is the worse one.
const MAX_STDIN_BYTES = 1024 * 1024;

// The ceiling on the capture hand-off. The redacted payload travels to the recorder in an
// environment variable, and a variable has a hard limit — 32 767 characters on Windows, for the
// variable and its name together. Past this many base64 characters (about 12 KiB of payload) the
// run is captured as metadata only. Deliberately not a temp file: that is a synchronous write in
// front of Send, the exact thing this rewrite removes, and a file a killed gate would leave behind.
const MAX_CAPTURE_ENV_CHARS = 16 * 1024;

if (RECORDER) setTimeout(leave, RECORD_WALL_MS);
if (!RECORDER) setTimeout(leave, GATE_WALL_MS);

// The answer — the gate's, never the recorder's (whose stdout is 'ignore' anyway, and a recorder
// that answered would be answering nobody). `writeSync`, not `process.stdout.write`: a piped stdout
// is asynchronous on some platforms, and an exit that races an async write can lose the token —
// Cursor would then see empty output, which fails open, but a gate that sometimes answers and
// sometimes does not is not a gate anyone can reason about. A closed pipe is swallowed: nothing
// downstream depends on it.
if (!RECORDER) {
  try {
    fs.writeSync(1, '{"continue":true}');
  } catch { /* the host stopped listening; there is nobody left to answer */ }
}

// `beforeSubmitPrompt` — the only event that says when a turn STARTED.
//
// Why it is registered at all (verified on a real CLI session): a turn that calls no tool leaves
// nothing in the sidecar but the `gen` + `stop` pair stop.mjs writes at its END. With only turn ends
// to go on, lib/session-timeline-cursor.mjs labelled every gap after a stop `waiting_user`, never
// drew the first turn at all, and the portal showed such a session as almost nothing but "User
// input". The `prompt` line written here is the other edge of the turn: the gap before it is the
// user's, the gap after it is the agent's (buildPeriods, rules 1 and 2). delta-cursor reads it as a
// timing anchor but not as work, like `stop`, so a prompt the user aborted bills nothing.
//
// It fires in the interactive CLI (receptron/mulmoterminal#2064, 2026.09.10) and not in headless
// `agent -p`; the timeline falls back to its turn-end rule for any turn without a prompt line.

// NO `enterProjectDir()` HERE — the one hook entry without it (the carve-out is documented in
// test/plugin-manifest.test.mjs). Codex review, BLOCKING, the third time round: that call is an
// `fs.existsSync` of the workspace and a `process.chdir` into it, both synchronous, on the path
// Cursor waits for. A stalled workspace (a wedged network drive, a sleeping external disk) blocked
// the only thread past the wall guard: a 900 ms existsSync stall kept the gate alive 916 ms.
//
// Nothing here needs the workspace as its working directory. Every other hook enters it because it
// shells out to git for attribution; the gate shells out to nothing, and the recorder it starts is
// deliberately started OUTSIDE the workspace (see spawnRecorder). The cwd the line carries is derived
// from the payload's `cwd` / `workspace_roots` and the CURSOR_PROJECT_DIR environment by
// lib/hook-input-cursor.mjs's `stampableCwd` — string work only (lib/hook-cwd.mjs's
// `toFilesystemPath` and `projectDir`), no filesystem access. The decoder's `normalizeHookInput`
// still reads `process.cwd()` for its fallback `cwd`, which the gate discards; that is a getcwd of
// the process's own state, not a disk access, and it cannot stall on the workspace.
//
// The runtime proof is test/prompt-submit.test.mjs's stalled-filesystem test, which stalls every
// synchronous `fs` call and `process.chdir` in the gate process and still sees it leave in budget.
// A later edit that needs a working directory here must derive it the same way, never enter it.

if (RECORDER) runRecorder();
else runGate();

// ── the gate ───────────────────────────────────────────────────────────────────────────────────

// Read stdin, hand off, leave. Every path ends in `leave`: a module that cannot be evaluated is a
// lost line, never a failed hook, and a promise a stubbed business function leaves floating reaches
// the guards, which exit 0 without a word on stdout.
function runGate() {
  readStdinCapped().then(handOff).then(leave, leave);
}

// Stdin, through events, once, up to the cap. Resolves to the bytes, or null when the payload did
// not fit. EVENTS, not `readSync`: a synchronous read of a pipe the host is slow to close holds the
// thread the wall guard needs (see GATE_WALL_MS). Stdin is single-shot, so this is the only read, and
// capture works from the same bytes rather than a replay spill (see captureOf).
//
// A read error ends the read with what arrived so far. On Windows a closed pipe can surface as an
// error rather than an `end`; the decoder then gets whatever is here, and an incomplete payload
// simply fails to parse. Never rejects.
function readStdinCapped() {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stdin = null;
    try {
      stdin = process.stdin;
      stdin.on('data', (chunk) => {
        if (settled) return;
        if (total + chunk.length > MAX_STDIN_BYTES) {
          // Past the cap: stop listening, keep nothing. `pause` rather than `destroy`, so the host's
          // write end sees back-pressure instead of an abrupt reset while we are leaving anyway.
          settle(null);
          try { stdin.pause(); } catch { /* leaving regardless */ }
          return;
        }
        total += chunk.length;
        chunks.push(chunk);
      });
      stdin.on('end', () => settle(Buffer.concat(chunks, total)));
      stdin.on('error', () => settle(Buffer.concat(chunks, total)));
    } catch {
      // No stdin to speak of (a closed fd 0 can throw on first access): nothing to record.
      settle(null);
    }
  });
}

// Decode, and start the recorder if there is anything for it to do. Nothing to append and nothing
// to capture: return at once rather than load a module to find out.
function handOff(bytes) {
  const capturing = Boolean(process.env[DUMP_ENV_VAR]);
  if ((bytes === null || bytes.length === 0) && !capturing) return null;
  return Promise.all([
    import('../lib/hook-input-cursor.mjs'),
    capturing ? import('../lib/hook-dump.mjs') : null,
  ]).then(([decoder, dump]) => {
    let record = null;
    try {
      record = recordOf(decoder, payloadOf(decoder, bytes));
    } catch {
      record = null;
    }
    let capture = null;
    if (dump !== null) {
      try {
        capture = captureOf(dump, bytes);
      } catch {
        capture = null;
      }
    }
    if (record !== null || capture !== null) spawnRecorder(record, capture);
  });
}

// The payload, decoded the way every other hook decodes it: lib/hook-input-cursor.mjs's BOM-safe
// decodeHookPayload, then the same U+FEFF strip and trim readHookInput applies (that function takes
// an fd, and this script already holds the bytes). One decoder for every hook matters on Windows,
// where Cursor pipes the payload through PowerShell and a UTF-8 BOM — sometimes two — arrives in
// front of it; a gate that decoded differently would lose every Windows prompt line.
function payloadOf(decoder, bytes) {
  if (bytes === null || bytes.length === 0) return null;
  const text = decoder.decodeHookPayload(bytes).replace(/^﻿+/, '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The host's generation id, when it sent one, under either spelling (the same two
// lib/sidecar-events.mjs reads for a `gen` line). It is the `eid` both hook registries stamp on
// their copy of this line, which is what lets the reader collapse the two into one
// (dedupeEvents in lib/delta-cursor.mjs). NEVER fabricated: a line without it falls back to the
// reader's time-bounded rule, where an invented id would assert an identity nothing backs.
function generationIdOf(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  for (const field of ['generation_id', 'generationId']) {
    const value = payload[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

// The hand-off for the line: the session id, the generation id, the stamped cwd and the gate's
// start time — and nothing else from the payload, not the prompt, not the attachments, because the
// sidecar is a plain-text file that outlives the session and the environment is visible to the
// user's own tools. Null when there is nothing to attribute (a malformed or partial payload is an
// ordinary event here) or no start time to stamp.
//
// The session id goes through normalizeHookInput, so its spellings and their precedence are every
// other hook's; the result is checked here as well as in the recorder, because a decoder that
// misbehaves (test/hook-bootstrap.test.mjs stubs one to return a promise) must not start one.
//
// The cwd is stampableCwd's, never normalizeHookInput's: only a value BOTH registries derive
// identically for the same event may go on the line, or the reader's duplicate collapse stops
// collapsing and every prompt on a dual-registry machine counts twice.
function recordOf(decoder, payload) {
  if (typeof startedAt !== 'number' || !isFinite(startedAt)) return null;
  const input = decoder.normalizeHookInput(payload);
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const cwd = decoder.stampableCwd(payload);
  return {
    sid: input.session_id,
    eid: generationIdOf(payload),
    cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null,
    ts: startedAt,
  };
}

// Capture, when it is switched on, with the user's prompt text and attachments REPLACED before the
// bytes leave this process — the one hook whose raw payload is something the person typed rather
// than something about how Cursor behaves (redactPayloadBytes in lib/hook-dump.mjs). Opt-in
// debugging only: the environment is read first and the module is not even loaded when capture is
// off. The recorder writes the capture line, so the gate still writes nothing.
//
// Only REDACTED bytes cross, and only up to MAX_CAPTURE_ENV_CHARS; past that, and for a payload that
// cannot be redacted (which is never recorded verbatim), the run is captured with no bytes. The
// gate's own argv crosses too, because the capture record's `via` is the registry that launched the
// gate — the recorder's own command line would say `--record`.
//
// No replay spill. The other hooks need one because the runner re-reads stdin after capture drains
// it; this script already holds the bytes, so the spill — a full payload file a killed hook leaves
// behind — is simply never written.
function captureOf(dump, bytes) {
  let redacted = null;
  try {
    redacted = bytes === null ? null : dump.redactPayloadBytes(bytes, ['prompt', 'attachments']);
  } catch {
    redacted = null;
  }
  const b64 = redacted === null ? null : redacted.toString('base64');
  return {
    argv: process.argv.slice(2),
    raw_b64: b64 !== null && b64.length <= MAX_CAPTURE_ENV_CHARS ? b64 : null,
  };
}

// Start the recorder and let go of it.
//
//   - detached: its own process group (a new session on POSIX), so the gate's exit — and anything
//     the host does to the gate's group when it is done with it — does not take the recorder along.
//   - stdio all 'ignore': the recorder inherits NO handle of ours. Cursor may wait for the gate's
//     stdout and stderr to reach EOF as well as for its exit, and a recorder holding either pipe end
//     would hold Send for as long as it lives, stalled append included (test/prompt-submit.test.mjs
//     times the gate's pipes closing, not just its exit).
//   - windowsHide: a detached child on Windows otherwise gets a console window of its own.
//   - cwd outside the workspace, and no project-dir variables: a child inherits its parent's working
//     directory, and wherever Cursor started the gate — the workspace itself, for a host that starts
//     hooks there — is inherited unless it is overridden. On Windows a process's working directory
//     cannot be deleted or renamed, so a recorder left in the workspace would lock the user's project
//     folder for as long as it lives — a stalled append's whole length (verified: EPERM on removing
//     the workspace under a stalled recorder). It needs neither: the cwd it stamps is in the
//     hand-off, and its paths come from BEEZI_CURSOR_HOME. The variables are cleared so nothing the
//     recorder loads can find a workspace to enter.
//   - unref: nothing in the gate waits for it; the next statement is the exit anyway.
//
// A spawn that throws, or that errors after returning, costs the line and nothing else. There is NO
// fallback append in the gate: a synchronous append is exactly what this process may not do.
function spawnRecorder(record, capture) {
  const env = Object.assign({}, process.env);
  delete env[RECORD_ENV_VAR];
  delete env[CAPTURE_ENV_VAR];
  for (const name of PROJECT_DIR_VARS) delete env[name];
  if (record !== null) env[RECORD_ENV_VAR] = JSON.stringify(record);
  if (capture !== null) env[CAPTURE_ENV_VAR] = JSON.stringify(capture);
  try {
    const child = spawn(process.execPath, ['--no-warnings', SELF, RECORD_FLAG], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      cwd: os.tmpdir(),
      env,
    });
    // An asynchronous spawn failure arrives as an 'error' event; unheard, it would be an uncaught
    // throw. The gate is normally gone before it could fire.
    child.on('error', () => {});
    child.unref();
  } catch { /* no recorder, no line */ }
}

// ── the recorder ───────────────────────────────────────────────────────────────────────────────

// Append the handed-off line, capture the handed-off bytes, leave. Each job is contained on its own,
// so a failed capture never costs the line, and every path — a refused hand-off included — ends in
// `leave`. Writes nothing to any stream: it has none.
function runRecorder() {
  const record = recordFromEnv(process.env[RECORD_ENV_VAR]);
  const capture = process.env[DUMP_ENV_VAR] ? captureFromEnv(process.env[CAPTURE_ENV_VAR]) : null;
  if (record === null && capture === null) {
    leave();
    return;
  }
  const jobs = [];
  if (record !== null) {
    jobs.push(import('../lib/sidecar.mjs').then((sidecar) => appendPrompt(sidecar, record)).catch(() => {}));
  }
  if (capture !== null) {
    jobs.push(import('../lib/hook-dump.mjs').then((dump) => appendCapture(dump, capture)).catch(() => {}));
  }
  Promise.all(jobs).then(leave, leave);
}

// The hand-off, validated. It comes from our own gate, but it arrives through an environment
// anything upstream could have set, so it is read like untrusted input: a non-empty string session
// id, a finite numeric start time, and an eid and a cwd that are strings when present. Anything
// else is refused whole — a line with a guessed field is worse than no line.
function recordFromEnv(text) {
  if (typeof text !== 'string' || text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.sid !== 'string' || value.sid === '') return null;
  if (typeof value.ts !== 'number' || !isFinite(value.ts)) return null;
  if (value.eid != null && (typeof value.eid !== 'string' || value.eid === '')) return null;
  if (value.cwd != null && typeof value.cwd !== 'string') return null;
  return {
    sid: value.sid,
    ts: value.ts,
    eid: value.eid == null ? null : value.eid,
    cwd: value.cwd == null ? null : value.cwd,
  };
}

// The capture hand-off, validated the same way. Bytes that are absent or not a string are a run with
// no bytes (dumpHookPayload records `bytes: null`), which is also what the gate sends past the cap.
function captureFromEnv(text) {
  if (typeof text !== 'string' || text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const argv = Array.isArray(value.argv) && value.argv.every((a) => typeof a === 'string') ? value.argv : [];
  const bytes = typeof value.raw_b64 === 'string' ? Buffer.from(value.raw_b64, 'base64') : undefined;
  return { argv, bytes };
}

// The one line, appended ASYNCHRONOUSLY. Codex review, MAJOR: this used to be lib/sidecar.mjs's
// appendEvent, whose write is a synchronous `appendFileSync` — and the RECORD_WALL_MS timer, like
// every timer, cannot interrupt a synchronous call. A wedged sidecar (a stalled home drive, an
// antivirus scan holding the file) therefore left the recorder blocked with nothing able to end it,
// and every prompt on every registry added one more stuck node process. With `fs.appendFile` the
// write waits in libuv's threadpool while the one JS thread stays free, so the deadline fires and
// `process.exit` ends the process whether the write ever completes or not.
//
// What stays lib/sidecar.mjs's, so the line is the one appendEvent would have written byte for byte
// (test/prompt-submit.test.mjs compares the two): the path (`eventsFileFor`, safeName on the
// untrusted session id), the cwd stamp (`withCwd`, added only when there is one), and the shape
// `{ ts, ...event }` serialised as ONE newline-terminated line. Byte identity is not cosmetic: the
// reader collapses the two registries' copies of this line on content (dedupeEvents,
// lib/delta-cursor.mjs), and the other registry may be running a build that still used appendEvent.
// The `ts` is the gate's. The write keeps appendEvent's other two properties as well: mode 0600
// (these lines carry a working directory), and a single O_APPEND write of the whole line — flag 'a',
// one call, a line of a hundred-odd bytes — which is what lets concurrent hook processes interleave
// whole lines rather than tear one.
//
// Append first and create the directory only on ENOENT, the order appendEvent uses, with the mkdir
// asynchronous too: a synchronous one would reintroduce the uninterruptible stall one call earlier.
// Resolves either way; a failed append is a lost turn-start anchor, and the timeline has a rule for
// a turn without one.
//
// ONE line, and deliberately not `eventsFromHookPayload`: that would derive a `gen` line from the
// payload's envelope and bill a generation Cursor has not started.
function appendPrompt(sidecar, record) {
  const file = sidecar.eventsFileFor(record.sid);
  if (file === null) return null;
  const event = record.eid === null
    ? { ts: record.ts, ev: 'prompt' }
    : { ts: record.ts, ev: 'prompt', eid: record.eid };
  let text;
  try {
    text = `${JSON.stringify({ ts: record.ts, ...sidecar.withCwd(event, record.cwd) })}\n`;
  } catch {
    return null;
  }
  testRecorderStall();
  return appendLine(file, text);
}

// Append first and create the directory only on ENOENT, both asynchronously — the order
// lib/sidecar.mjs and lib/hook-dump.mjs use, without their synchronous calls. Resolves either way.
function appendLine(file, text) {
  return appendAsync(file, text).catch((error) => {
    if (error == null || error.code !== 'ENOENT') return null;
    return mkdirAsync(path.dirname(file)).then(() => appendAsync(file, text));
  });
}

// The capture record, appended ASYNCHRONOUSLY to the file lib/hook-dump.mjs names. Codex review,
// MAJOR: this used to be dumpHookPayload, and both of its steps are synchronous — the throttled
// retention sweep (an lstat at least, a directory walk and renames when it runs) and an
// `appendFileSync` — so a stalled capture filesystem held the recorder's one thread and the
// RECORD_WALL_MS timer could not fire: a 12 s stall kept it alive 12,086 ms. Now it is one
// `fs.appendFile` (the same 0600, flag 'a', one whole line) behind the same deadline as the prompt
// line, and a capture that never lands costs the capture, never the line or the exit.
//
// The retention sweep is SKIPPED here, deliberately. It is throttled and idempotent, every other hook
// entry runs it on every capture through dumpHookPayload — `stop` ends every turn this one starts —
// so the bounds still hold; running it here would put a synchronous directory walk back behind the
// deadline, which is the finding.
//
// The record is the one dumpHookPayload writes (test/prompt-submit.test.mjs compares the two field
// by field): hook-dump's builder is private to that module, so the format is replicated here, with
// its constant and its path taken from the module itself so neither can drift. `script` is this
// file's name, as there — `process.argv[1]` is SELF in the recorder — and `pid` is the recorder's,
// which is also what it was when the recorder called dumpHookPayload. The bytes are the gate's,
// already redacted (captureOf), and `via` is the gate's registry flag, handed over in `argv`.
function appendCapture(dump, capture) {
  let file;
  let text;
  try {
    file = dump.captureFile();
    text = `${JSON.stringify(captureRecordOf(capture.bytes, capture.argv, dump.MAX_RAW_BYTES))}\n`;
  } catch {
    return null;
  }
  return appendLine(file, text);
}

// lib/hook-dump.mjs's buildRecord, field for field and in its key order: which process wrote the
// line, what it was handed, the first eight bytes in hex (the BOM question), the bytes as UTF-8 up to
// the cap, and `raw_b64` only when that decoding is lossy. A run with no bytes is still a record.
function captureRecordOf(bytes, argv, maxRawBytes) {
  const now = Date.now();
  const at = Array.isArray(argv) ? argv.indexOf('--via') : -1;
  const record = {
    ts: now,
    iso: new Date(now).toISOString(),
    script: typeof process.argv[1] === 'string' ? path.basename(process.argv[1]) : null,
    pid: process.pid,
    via: at !== -1 && typeof argv[at + 1] === 'string' ? argv[at + 1] : null,
    argv: Array.isArray(argv) ? argv : null,
    platform: process.platform,
    bytes: null,
    truncated: false,
    head_hex: null,
    raw: null,
  };
  if (!Buffer.isBuffer(bytes)) return record;
  record.bytes = bytes.length;
  record.head_hex = bytes.subarray(0, 8).toString('hex');
  const kept = bytes.length > maxRawBytes ? bytes.subarray(0, maxRawBytes) : bytes;
  record.truncated = kept.length !== bytes.length;
  record.raw = kept.toString('utf-8');
  if (!Buffer.from(record.raw, 'utf-8').equals(kept)) record.raw_b64 = kept.toString('base64');
  return record;
}

// `fs.appendFile` and `fs.mkdir`, as promises. The callback API is looked up on the `fs` object at
// call time rather than through `fs.promises`, so a test preload can stand in for a wedged write
// (test/prompt-submit.test.mjs, the deadline test). A synchronous throw from either becomes a
// rejection, which appendPrompt's caller already absorbs.
function appendAsync(file, text) {
  return new Promise((resolve, reject) => {
    fs.appendFile(file, text, { encoding: 'utf-8', mode: 0o600, flag: 'a' }, (error) => (error ? reject(error) : resolve()));
  });
}

function mkdirAsync(dir) {
  return new Promise((resolve, reject) => {
    fs.mkdir(dir, { recursive: true, mode: 0o700 }, (error) => (error ? reject(error) : resolve()));
  });
}

// TEST SEAM: a SYNCHRONOUS stall in front of the recorder's append, standing for a block of the
// recorder's only thread — the wedged `appendFileSync` of the first Codex finding, and today any
// synchronous step that is left (see RECORD_WALL_MS) — which no timer in any process can interrupt.
// The asynchronous hang the deadline now handles is stubbed by a test preload instead (the deadline
// test), since it needs no seam here. A spawned-process test uses this one to show the gate exits
// (and closes its pipes) inside the budget while the recorder is still stuck, and that the line
// lands afterwards (test/prompt-submit.test.mjs). Honoured ONLY under NODE_ENV=test, so a stray variable in a user's
// shell cannot delay their prompt lines. It lives in the recorder alone: the gate has no append to
// stall, which is the point.
function testRecorderStall() {
  if (process.env.NODE_ENV !== 'test') return;
  const ms = Number(process.env.BEEZI_TEST_PROMPT_CHILD_STALL_MS);
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* no SharedArrayBuffer here: no stall, which only weakens the test */ }
}
