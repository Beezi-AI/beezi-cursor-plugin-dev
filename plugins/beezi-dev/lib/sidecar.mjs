import fs from 'fs';
import path from 'path';
import { eventsDir } from './paths-cursor.mjs';

// The event sidecar — this plugin's source of truth.
//
// Claude Code and Codex *must* scrape a transcript because their hosts emit no structured events.
// Cursor emits 21 typed lifecycle events, so the plugin records its own append-only stream and
// treats Cursor's storage (state.vscdb, ai-code-tracking.db) as optional enrichment. Two reasons
// this is required rather than merely preferred:
//
//   1. Cursor's transcripts exclude tool outputs, so the Claude/Codex trick of estimating
//      est_tokens as outputBytes/4 is unavailable from them. `postToolUse` supplies `tool_output`
//      live, so the sidecar yields exact operation counts and real est_tokens.
//   2. Cursor's local format has moved four times in a year and chat history was wiped across two
//      upgrades. A transcript-scraping design inherits that churn; this one does not.
//
// `segmentId = "<conversation_id>:<from>-<to>"` indexes OUR lines, so the server's idempotency
// contract is preserved exactly while dependence on Cursor's format is eliminated.

// A filename we are willing to create. `conversation_id` arrives from a hook payload, so it is
// untrusted input on a path — a value containing `../` would otherwise write outside the events
// directory. Anything outside [A-Za-z0-9._-] is replaced, and the result is length-bounded.
//
// Exported because this is the plugin's ONE sanitizer for that id and several other modules build
// paths out of the same untrusted value (state files, the per-session lock). A second, subtly
// different implementation is how one of those paths ends up escaping its directory, so callers
// import this rather than writing their own.
export function safeName(conversationId) {
  if (typeof conversationId !== 'string') return null;
  const cleaned = conversationId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  return cleaned === '' ? null : cleaned;
}

// Absolute path of the event log for one Cursor conversation. Returns null when the id cannot be
// turned into a safe filename, so a caller never builds a path out of an unusable value.
export function eventsFileFor(conversationId) {
  const name = safeName(conversationId);
  return name === null ? null : path.join(eventsDir(), `${name}.jsonl`);
}

// Stamp a working directory onto an event, or return the event untouched when there is none.
//
// `cwd` must be a value both hook registries derive identically for the same host event
// (lib/hook-input-cursor.mjs, stampableCwd) — the reader's duplicate collapse keys on line
// content, so a per-process value here would double-count every event on a dual-registry
// machine. An event that already carries its own cwd keeps it (spread order).
export function withCwd(event, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return event;
  if (!event || typeof event !== 'object') return event;
  return { cwd, ...event };
}

// Append one event line. Never throws: this runs inside `postToolUse`, which fires on EVERY tool
// call, and a telemetry write failing must never break the user's Cursor session. Returns whether
// the line landed, so a caller that wants to know can ask.
//
// `appendFileSync` with a single write of one already-newline-terminated line is the atomicity we
// need: O_APPEND makes each write land at the current end of file, and concurrent hook processes
// (Cursor runs them per tool call) therefore interleave whole lines rather than corrupting one.
export function appendEvent(conversationId, event) {
  const file = eventsFileFor(conversationId);
  if (file === null || !event || typeof event !== 'object') return false;
  let line;
  try {
    // ts is stamped here rather than by each caller so every line is comparable, and a caller that
    // supplies its own (replaying a batched payload) keeps it.
    line = `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
  } catch {
    return false; // a circular / unserializable field must not take the hook down
  }
  // Append first, create the directory only if that is what was missing. This runs once per tool
  // call — the hottest path in the plugin — and the directory exists for all but the first write
  // of a session, so an unconditional mkdir is a syscall per event bought for nothing.
  // 0600: these lines carry file paths, shell command text and tool arguments.
  try {
    fs.appendFileSync(file, line, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch (error) {
    if (error == null || error.code !== 'ENOENT') return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
