import fs from 'fs';
import path from 'path';
import { beeziCursorHome } from './paths-cursor.mjs';
import { removeSync } from './fs-compat.mjs';
import { maybeApplyCaptureRetention } from './capture-retention.mjs';

// The hook payload capture harness — the answer to `TODO(P0): unverified`.
//
// Those markers sit across the plugin's Cursor-facing modules, and every one of them means the same
// thing: Cursor was never installed on the machine this plugin was written on, so no real hook
// payload has ever been read. Which key carries an MCP server's identity, whether `afterFileEdit`
// reports a path or a diff, what a subagent's start event even looks like — all of it is inference
// from documentation, and inference is exactly how this plugin has failed before. `normalizeHookInput`
// once required `conversation_id` because the docs implied it; real `stop` payloads carry
// `session_id` and no `conversation_id` at all, so every hook on every machine read its input, found
// no identity, and exited having done nothing. Nobody could see it, because the thing that was wrong
// was the shape of a payload nobody had ever looked at.
//
// So this module looks at it. Turn `BEEZI_CURSOR_DUMP_HOOKS` on, drive Cursor for one session, and
// `~/.beezi-cursor/capture/hooks.jsonl` holds the exact bytes every registered hook received. One
// session answers every one of them.
//
// Three properties this must have, each paid for by a bug elsewhere in this plugin:
//
//   1. Free when it is off. `dumpHookPayload` is called from `postToolUse`, which fires on EVERY
//      tool call — the path `scripts/tool-event.mjs` is deliberately kept to append-and-exit with
//      minimal imports. One environment read happens before anything else here; with the variable
//      unset nothing is allocated, no path is built and no syscall is made.
//   2. Never throws. This observes the hooks; it must never be the reason one dies. A capture that
//      cannot write is a capture that silently records nothing, not a hook that fails in front of
//      the user.
//   3. Raw bytes, verbatim. The whole point is to see what arrived BEFORE this plugin's own decoding
//      touched it. The Windows BOM behaviour documented in lib/hook-input-cursor.mjs:12-31 — Cursor
//      spilling the payload to a temp file and piping it back through PowerShell's BOM-carrying
//      UTF8 encoder, sometimes twice — is itself one of the things capture has to confirm, and a
//      record that had already been BOM-stripped and JSON-parsed could not confirm it.

// Off by default, and named per agent like every other variable this plugin honours (see
// BEEZI_CURSOR_HOME in lib/paths-cursor.mjs): a machine may run the Claude Code, Codex and Cursor
// plugins at once, and one shared switch would turn capture on for all three.
export const DUMP_ENV_VAR = 'BEEZI_CURSOR_DUMP_HOOKS';

// A ceiling on what one line may cost. `postToolUse` carries `tool_output`, which is the full text a
// tool produced — a `read_file` on a bundled asset or a `grep` across a monorepo is megabytes, and a
// capture session is thousands of hook runs. Unbounded, the capture file is the thing that fills the
// user's disk. The record says when it truncated, so nobody reads a clipped payload as a short one.
export const MAX_RAW_BYTES = 256 * 1024;

// Everything capture writes lives under one directory, so "I am done capturing" is one `rm -rf`.
export function captureDir(home = beeziCursorHome()) {
  return path.join(home, 'capture');
}

export function captureFile(home = beeziCursorHome()) {
  return path.join(captureDir(home), 'hooks.jsonl');
}

// The `--via` value exactly as it appeared on the command line, NOT normalized through
// lib/hook-source.mjs's `hookVia`. That function maps anything unrecognised onto `launcher`, which
// is the right call for bookkeeping and the wrong one here: capture has to be able to show that a
// registry passed a flag nobody expected, and a normalizer hides precisely that.
function viaOf(argv) {
  if (!Array.isArray(argv)) return null;
  const at = argv.indexOf('--via');
  if (at === -1) return null;
  return typeof argv[at + 1] === 'string' ? argv[at + 1] : null;
}

// One line of JSONL per hook run. Append-only and newline-terminated for the same reason the event
// sidecar is (lib/sidecar.mjs): Cursor runs hooks as separate processes and several are alive at
// once, so a single `appendFileSync` of one complete line is the atomicity that keeps concurrent
// runs interleaving whole lines instead of shredding each other's.
//
// 0600 on the file and 0700 on the directory, because this is the least redacted thing the plugin
// ever writes — full tool output, shell command text, file paths, and whatever a payload carries
// that we do not yet know about. That is the point of capture, and it is also why it is off by
// default and why it should be deleted when the session is over.
function appendCaptureLine(file, line) {
  // Append first, create the directory only if that is what was missing — the same lazy-mkdir the
  // sidecar uses, for the same reason: the directory exists for all but the first write of a
  // session, so an unconditional mkdir is a syscall per hook run bought for nothing.
  try {
    fs.appendFileSync(file, line, { encoding: 'utf-8', mode: 0o600 });
    return;
  } catch (error) {
    if (error == null || error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line, { encoding: 'utf-8', mode: 0o600 });
}

function buildRecord(rawBuffer, argv) {
  const record = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    // Which hook produced this line. The payload's own `hook_event_name` is not trustworthy here —
    // establishing whether Cursor actually sends it is one of the questions capture exists to
    // answer — so the identity comes from the process instead, which cannot be wrong.
    script: typeof process.argv[1] === 'string' ? path.basename(process.argv[1]) : null,
    pid: process.pid,
    via: viaOf(argv),
    argv: Array.isArray(argv) ? argv : null,
    platform: process.platform,
    bytes: null,
    truncated: false,
    // The first eight bytes in hex, always. This is the single field that answers the BOM question
    // at a glance: `7b2273657373696f6e` is a clean `{"session`, `efbbbf7b` is a UTF-8 BOM, `fffe` is
    // UTF-16LE. Reading it out of `raw` would mean trusting the decoding that is under suspicion.
    head_hex: null,
    raw: null,
  };

  const buf = Buffer.isBuffer(rawBuffer)
    ? rawBuffer
    : (typeof rawBuffer === 'string' ? Buffer.from(rawBuffer, 'utf-8') : null);
  // A run with nothing readable on stdin is still recorded. "This hook fired and received no bytes"
  // is a finding, not a non-event — it is what a registry that fires the hook but pipes it nothing
  // looks like, and dropping the line would make that indistinguishable from a hook that never ran.
  if (buf === null) return record;

  record.bytes = buf.length;
  record.head_hex = buf.subarray(0, 8).toString('hex');
  const kept = buf.length > MAX_RAW_BYTES ? buf.subarray(0, MAX_RAW_BYTES) : buf;
  record.truncated = kept.length !== buf.length;
  // No BOM stripping and no parsing: `EF BB BF` decodes to U+FEFF and survives JSON.stringify as
  // `﻿`, so a BOM that arrived is a BOM that is in the file.
  record.raw = kept.toString('utf-8');
  // …unless the bytes were not UTF-8 at all. A UTF-16LE payload (Windows PowerShell has been seen
  // producing one) decodes to replacement characters, which is lossy — and a capture that quietly
  // loses the bytes it exists to preserve is worse than no capture. `raw` stays readable for a
  // human; `raw_b64` is added only when it is no longer authoritative.
  if (!Buffer.from(record.raw, 'utf-8').equals(kept)) record.raw_b64 = kept.toString('base64');
  return record;
}

// Append one capture line for this hook run. Returns nothing: no caller may branch on whether the
// capture landed, because no caller may behave differently when capture is on.
export function dumpHookPayload(rawBuffer, argv = process.argv.slice(2)) {
  // The one environment read, before anything else — see property 1 in the header.
  if (!process.env[DUMP_ENV_VAR]) return;
  try {
    // Bounds BEFORE the append, so the rotation decision is made against the size the file has
    // now rather than one line later, and so an interrupted run's replay files are the previous
    // run's problem rather than this session's. `maybeApplyCaptureRetention` is throttled — one
    // lstat on a normal run — because this function is on the postToolUse path and fires for
    // every tool call; see lib/capture-retention.mjs for the bounds and why prune cannot do it.
    maybeApplyCaptureRetention(captureDir());
    appendCaptureLine(captureFile(), `${JSON.stringify(buildRecord(rawBuffer, argv))}\n`);
  } catch {
    // Deliberately silent, and deliberately not stderr: Cursor surfaces a hook's stderr in its
    // execution log as a failure, so a capture directory that cannot be created would make ten
    // working hooks look broken. See NODE_FLAGS in lib/hooks-install.mjs for the same reasoning.
  }
}

// Read the hook's stdin so it can be captured AND still be read by the hook itself.
//
// Stdin is single-shot. Cursor pipes the payload in (on Windows through a PowerShell pipeline, see
// lib/hook-input-cursor.mjs), so the first `readFileSync(0)` drains it to EOF and a second read
// returns nothing. That is a real trap: reading raw bytes at the top of a hook script for capture
// would leave `readHookInput()` below it with an empty pipe, so every hook would dump a perfect
// payload and then do none of its work — analytics silently off for the whole capture session, on
// the one machine that finally has Cursor installed. Turning the plugin off is not an acceptable
// price for watching it.
//
// So the bytes are read once, handed back for the dump, and written to a replay file whose path the
// caller passes straight to `readHookInput`. The hook's own input path is unchanged: same decoder,
// same BOM handling, same parse — capture observes it, it does not stand in for it.
//
// Returns null when capture is off, which is the whole of the cost on a normal run: no read, no
// write, and the call site's fd-0 fallback leaves `readHookInput()` reading fd 0 exactly as before.
export function captureHookStdin(fd = 0, { home = beeziCursorHome(), env = process.env } = {}) {
  if (!env[DUMP_ENV_VAR]) return null;
  let raw;
  try {
    raw = fs.readFileSync(fd);
  } catch {
    // Nothing readable on stdin. Report it as a run with no bytes rather than as no run: the caller
    // still dumps (buildRecord records `bytes: null`) and still falls back to fd 0.
    return { raw: null, replay: null };
  }

  const replay = path.join(captureDir(home), 'stdin', `${process.pid}-${Date.now()}.bin`);
  try {
    try {
      fs.writeFileSync(replay, raw, { mode: 0o600 });
    } catch (error) {
      if (error == null || error.code !== 'ENOENT') throw error;
      fs.mkdirSync(path.dirname(replay), { recursive: true, mode: 0o700 });
      fs.writeFileSync(replay, raw, { mode: 0o600 });
    }
  } catch {
    // The dump still happens; only the replay is lost, and the hook falls back to a drained fd 0.
    return { raw, replay: null };
  }

  // The replay file has served its purpose the moment the hook has parsed it, and a capture session
  // is thousands of hook runs — left behind they are thousands of files holding full payloads at
  // 0600 in the user's home. `exit` fires for `process.exit(0)` too, which is how every hook script
  // in this plugin ends.
  try {
    process.on('exit', () => {
      try { removeSync(replay, { force: true }); } catch { /* a killed hook leaves it for the rm -rf */ }
    });
  } catch { /* never worth failing a hook over */ }

  return { raw, replay };
}
