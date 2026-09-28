import fs from 'fs';
import path from 'path';

// The prompt gate's detached recorder: the append nobody waits for.
//
// scripts/prompt-submit.mjs is two processes. The GATE is what Cursor waits for on
// `beforeSubmitPrompt` — it answers, reads stdin through events, and hands the ids to a recorder it
// spawns detached. The RECORDER is that same script run again with `--record`, and this module is
// what it runs: it reads the hand-off from its environment, validates it, and appends the one
// `prompt` line (and, with capture on, the capture record) ASYNCHRONOUSLY. The script keeps what a
// terminal owns — its process-level deadline (RECORD_WALL_MS, armed before this module is even
// loaded) and the exit, which is handed in as `leave` — and everything that decides lives here.
// The why of every rule below (the Codex review findings, the byte-identity with appendEvent and
// dumpHookPayload) is in the comments beside it, and the whole two-process contract is in the
// script's header.
//
// Loaded only by the recorder, by dynamic import, never by the gate: the gate may load nothing it
// does not need before it leaves. No import-time side effects — the two builtins, three constants.

// The hand-off variables. They MUST match the names scripts/prompt-submit.mjs sets: the gate cannot
// import this module to share them (see above), so each side names them. The end-to-end tests in
// test/prompt-submit.test.mjs fail at once if the two drift — no line and no capture record lands.
const RECORD_ENV_VAR = 'BEEZI_PROMPT_RECORD';
const CAPTURE_ENV_VAR = 'BEEZI_PROMPT_CAPTURE';
const DUMP_ENV_VAR = 'BEEZI_CURSOR_DUMP_HOOKS';

// ── the recorder ───────────────────────────────────────────────────────────────────────────────

// Append the handed-off line, capture the handed-off bytes, leave. Each job is contained on its own,
// so a failed capture never costs the line, and every path — a refused hand-off included — ends in
// `leave`. Writes nothing to any stream: it has none. `leave` is the script's exit
// (scripts/prompt-submit.mjs): the script owns it, this module only says when.
export function runRecorder(leave) {
  const record = recordFromEnv(process.env[RECORD_ENV_VAR]);
  const capture = process.env[DUMP_ENV_VAR] ? captureFromEnv(process.env[CAPTURE_ENV_VAR]) : null;
  if (record === null && capture === null) {
    leave();
    return;
  }
  const jobs = [];
  if (record !== null) {
    jobs.push(import('./sidecar.mjs').then((sidecar) => appendPrompt(sidecar, record)).catch(() => {}));
  }
  if (capture !== null) {
    jobs.push(import('./hook-dump.mjs').then((dump) => appendCapture(dump, capture)).catch(() => {}));
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
// appendEvent, whose write is a synchronous `appendFileSync` — and the RECORD_WALL_MS timer
// (scripts/prompt-submit.mjs), like every timer, cannot interrupt a synchronous call. A wedged
// sidecar (a stalled home drive, an
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
// its constant and its path taken from the module itself so neither can drift. `script` is the
// recorder script's name, as there — `process.argv[1]` is scripts/prompt-submit.mjs in the recorder,
// never this module, so it stays `prompt-submit.mjs` — and `pid` is the recorder's, which is also
// what it was when the recorder called dumpHookPayload. The bytes are the gate's, already redacted
// (captureOf, in the script), and `via` is the gate's registry flag, handed over in `argv`.
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
// synchronous step that is left (see RECORD_WALL_MS, scripts/prompt-submit.mjs) — which no timer in
// any process can interrupt.
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
