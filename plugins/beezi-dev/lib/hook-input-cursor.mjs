import fs from 'fs';
import { projectDir, toFilesystemPath } from './hook-cwd.mjs';

// Carried over verbatim from the Codex plugin's hook-input.mjs — the branch-boundary vocabulary is
// git's, not the host's, so it is identical for every agent.
export function isGitCheckpointCommand(cmd) {
  return /git\s+(commit|switch|checkout)\b/.test(cmd);
}

// Decode a stdin buffer that may carry a byte-order mark, and may carry more than one.
//
// On Windows, Cursor does not pipe the payload to the hook at all. `$executeHookDirect` writes it
// to a temp file and rewrites the command into a PowerShell pipeline:
//
//   $OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -LiteralPath '<file>' -Raw |
//     & { $input | <command> }
//
// `[System.Text.Encoding]::UTF8` is the BOM-carrying instance, and Windows PowerShell emits that
// preamble into the pipe — so what reaches the hook is `﻿{"session_id":…}`, sometimes twice,
// even though the temp file itself starts with `{`. JSON.parse rejects it, and every hook on every
// Windows machine then read its input, got null, and exited having done nothing. Cursor's own
// execution log showed six hooks running and "(no output)" for each; no sidecar line, no queued
// report and no API request was ever produced. Verified by replaying that exact command line.
export function decodeHookPayload(buffer) {
  if (!Buffer.isBuffer(buffer)) return typeof buffer === 'string' ? buffer : '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.swap16().toString('utf16le');
  // Repeated marks are stripped as characters after decoding, which covers both the byte form at
  // the head and any further ones a nested pipeline stage added.
  return buffer.toString('utf-8').replace(/^﻿+/, '');
}

// Parse the hook's JSON payload from stdin (fd 0). Returns null on any read/parse
// failure so the caller can exit quietly — a hook must never throw on bad input.
export function readHookInput(fd = 0) {
  let text;
  try {
    text = decodeHookPayload(fs.readFileSync(fd)).replace(/^﻿+/, '').trim();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Cursor's stdin payload → the { session_id, transcript_path, cwd } shape every engine module
// already speaks.
//
// `session_id` is the identity, and Cursor has already done the resolving. `executeHookForStep`
// computes `session_id ?? conversation_id` and stamps the result back onto the payload as
// `session_id` for every event except `workspaceOpen`, which this plugin does not register. So the
// host's own precedence is reproduced here rather than second-guessed.
//
// This used to require `conversation_id` and return null without one, on the theory that
// `session_id` appeared only on sessionStart/sessionEnd. The real payloads say otherwise: a `stop`
// payload is `{ status, loop_count, input_tokens, …, session_id, hook_event_name, cursor_version,
// workspace_roots, user_email, transcript_path }` with no `conversation_id` anywhere. The cost of
// that assumption was total — every hook fired, read stdin, found no identity and exited, so not
// one sidecar line was ever written on a working install.
//
// `transcript_path` is passed through when Cursor supplies one, but nothing here depends on it: the
// plugin's own event sidecar is the source of truth, and binary analysis found no transcript write
// path in `cursor-agent` at all.
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

// The host build that wrote a payload, or undefined.
//
// One sanitizer for one value, shared by the hook input and the sidecar stamp. The shape is
// deliberately narrow — a digit, then up to 39 more of digit / letter / dot / plus / hyphen — because
// this string is carried through the sidecar, through replay and (once the backend accepts it)
// onto the wire, and every one of those is a place an unbounded or control-character-bearing value
// causes a problem that looks like something else.
//
// EXACT OR ABSENT, never repaired. `v1.2.3` is not trimmed down to `1.2.3` and an object is never
// coerced: an unknown host build must stay unknown, because a guessed version is worse than none —
// it groups a regression under a build that never ran.
const CURSOR_VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,39}$/;

export function sanitizeCursorVersion(value) {
  if (typeof value !== 'string') return undefined;
  return CURSOR_VERSION_RE.test(value) ? value : undefined;
}

// The observed version on a hook payload, under either spelling. Read from the PAYLOAD only: the
// currently installed Cursor is not evidence about the build that wrote a past session, and reading
// it would stamp today's version onto every backfilled segment.
export function payloadCursorVersion(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const snake = sanitizeCursorVersion(payload.cursor_version);
  return snake === undefined ? sanitizeCursorVersion(payload.cursorVersion) : snake;
}

export function normalizeHookInput(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = firstString(
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
  );
  if (sessionId === null) return null;
  const stampedCwd = stampableCwd(payload);
  const version = payloadCursorVersion(payload);
  const transcriptPath = payload.transcript_path != null ? payload.transcript_path
    : payload.transcriptPath != null ? payload.transcriptPath
      : null;
  return {
    session_id: sessionId,
    transcript_path: typeof transcriptPath === 'string' ? transcriptPath : null,
    // The stampable chain, plus ONE extra tail. stampableCwd already owns every step of the
    // resolution (payload.cwd → workspace_roots → workspaceRoots → toFilesystemPath →
    // CURSOR_PROJECT_DIR) and the early return above guarantees it the non-null object it wants,
    // so the two derivations are exactly equal up to that tail. The tail IS the whole difference
    // between the two functions, and it is deliberate in both directions — see stampableCwd for
    // why a stamped value must not have one.
    //
    // Having it here is not belt-and-braces: when the payload carried no usable root (a UNC
    // workspace, whose `uri.path` drops the host) and no CURSOR_PROJECT_DIR was set, this was null,
    // so no repo resolved, no remote resolved, and the segment was silently never enqueued. Every
    // hook script calls enterProjectDir() before this, so process.cwd() is the workspace folder.
    cwd: stampedCwd == null ? process.cwd() : stampedCwd,
    // Omitted when the host said nothing, or said something this cannot vouch for. An absent key is
    // the only honest spelling of "unknown host build"; a null or an empty string would have to be
    // special-cased by every consumer, and one that forgot would report a build that never existed.
    //
    // `user_email` is NOT carried and must not be: the live `stop` payload has one, nothing in this
    // plugin has a use for it, and a field that identifies a person does not start travelling
    // because a version field was added beside it.
    ...(version === undefined ? {} : { cursor_version: version }),
  };
}

// The cwd BOTH hook registries would derive for this payload — the only kind of cwd that may be
// stamped onto a sidecar line.
//
// Deliberately NOT normalizeHookInput's `cwd`: that one falls back to `process.cwd()`, which is
// whatever directory each hook runner happened to start the process in — the bundled registry and
// the launcher registry can disagree on it for the same host event. The reader's duplicate
// collapse keys on the line's content, so a divergent field would stop the two copies collapsing
// and every event on a dual-registry machine would be counted twice. The payload's own fields and
// the CURSOR_PROJECT_DIR environment Cursor sets for the run are per-EVENT facts, identical in
// both processes; `process.cwd()` is a per-PROCESS accident, so it is excluded here even though
// the reporting path may still use it.
//
// The stamp exists for the login-time backfill: a conversation recorded on an unlinked machine
// has no state/<id>.json, so the sidecar is the only place its working directory can be
// recovered from (lib/sidecar-index.mjs, firstRecordedCwd).
//
// This is also THE payload→cwd chain for the whole module: normalizeHookInput calls it rather than
// re-deriving the same four steps, and only appends its process.cwd() tail. `workspace_roots` is a
// list of URI paths, so on Windows it reads `/c:/Users/you/project`; handing that to a git
// shell-out fails at spawn, which silently costs every segment its repo — see toFilesystemPath.
export function stampableCwd(payload, env = process.env) {
  if (!payload || typeof payload !== 'object') return projectDir(env);
  const roots = payload.workspace_roots;
  const rootsCamel = payload.workspaceRoots;
  const firstRoot = roots == null ? undefined : roots[0];
  const firstRootCamel = rootsCamel == null ? undefined : rootsCamel[0];
  const raw = payload.cwd != null ? payload.cwd
    : firstRoot != null ? firstRoot
      : firstRootCamel != null ? firstRootCamel
        : null;
  const resolved = toFilesystemPath(raw);
  return resolved == null ? projectDir(env) : resolved;
}

// Every shell command in a Cursor hook payload. Unlike Codex — which ships two live tool surfaces
// and buries the command inside a `tool_input` that may be an object, a JSON string, or a JS
// program — Cursor's `afterShellExecution` carries `command` as a plain top-level string. So there
// is exactly one shape to read and no program parsing.
//
// Still returns an array: the caller's guard is `.some(isGitCheckpointCommand)`, and keeping the
// plural shape means a future Cursor event that batches commands is a one-line change here rather
// than a change at every call site.
// TODO(P0): unverified — Cursor not installed on the authoring machine
export function shellCommandsOf(input) {
  const direct = input == null ? undefined : input.command;
  if (typeof direct === 'string' && direct !== '') return [direct];
  // Documented fallback: some Cursor events nest the shell call under `tool_input`. Reading it
  // costs nothing and keeps checkpoints firing if the payload key moves again.
  const toolInput = input == null ? undefined : input.tool_input;
  const nested = toolInput == null ? undefined : toolInput.command;
  if (typeof nested === 'string' && nested !== '') return [nested];
  return [];
}
