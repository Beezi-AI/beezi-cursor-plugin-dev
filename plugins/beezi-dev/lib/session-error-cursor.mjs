import { redactDetail } from './redact.mjs';
import { categoryOf } from './operations-cursor.mjs';
import { pickString } from './pick-field.mjs';

// Cursor's failure signals → the `{ error, errorDetails }` pair `POST /sessions/errors` carries.
//
// TWO SOURCES, ONE VOCABULARY. A failed tool call arrives on the `postToolUseFailure` payload
// (scripts/stop-failure.mjs); a turn that ended badly is written down only in Cursor's own agent
// transcript, as a `turn_ended` line (lib/transcript-turns-cursor.mjs). Both are classified here so
// the codes are spelled in exactly one place.
//
// WHY THE CODES ARE PRECISE. The API folds everything but `rate_limit` and `billing_error` into
// `other` — but it stores the raw value and the portal shows it. `tool_failure` for every failure
// told a support engineer nothing they could act on, and an empty `errorDetails` told them less.
//
// CHEAP TO IMPORT. stop-failure loads this on a path that fires mid-error, so it reaches only
// lib/redact.mjs (no imports), lib/operations-cursor.mjs (pick-field only) and lib/pick-field.mjs.
//
// `errorDetails` IS NEVER EMPTY. Every branch below falls back to a sentence built from fields that
// are safe to send. `tool_input` is never one of them and is never read: it is the command line, the
// file body or the MCP arguments, which is where a pasted secret sits whole.

// Every value this plugin sends as `error`. The server stores the raw string, so a typo here is a
// new category in the portal rather than a failed build — hence one frozen spelling.
export const SESSION_ERROR = Object.freeze({
  // Turn level, from the transcript's `turn_ended` line.
  RATE_LIMIT: 'rate_limit',
  USER_ABORTED: 'user_aborted',
  AGENT_STALLED: 'agent_stalled',
  TURN_ERROR: 'turn_error',
  // Tool level, from the `postToolUseFailure` payload.
  TOOL_TIMEOUT: 'tool_timeout',
  TOOL_PERMISSION_DENIED: 'tool_permission_denied',
  MCP_ERROR: 'mcp_error',
  TOOL_ERROR: 'tool_error',
});

// SessionErrorRequestDto's cap. The transport caps again (lib/session-error-report.mjs); capping here
// as well is what lets a caller, and a test, see the exact string that will be sent.
export const ERROR_DETAILS_CAP = 1000;

// How much host text reaches the redactor. A failed command's message can be a whole test log and
// only the first 1000 characters survive, so this is every character that could be sent plus a wide
// margin — and a credential cut at 20000 is 19000 characters past anything that is kept.
const MESSAGE_WINDOW_CHARS = 20000;
const MAX_TOOL_NAME_CHARS = 120;
const UNKNOWN_TOOL = 'Unknown tool';
const SEPARATOR = ' · ';

// Documented names first, camelCase second, then the three this hook read before any payload had
// been captured (`error`, `tool_output`, `output`). The legacy names stay as fallbacks; what real
// payloads carry is pinned in test/fixtures/hook-payloads/.
const TOOL_NAME_FIELDS = ['tool_name', 'toolName', 'tool'];
const FAILURE_TYPE_FIELDS = ['failure_type', 'failureType'];
const DURATION_FIELDS = ['duration', 'duration_ms', 'durationMs'];
const MESSAGE_FIELDS = ['error_message', 'errorMessage', 'error', 'tool_output', 'toolOutput', 'output'];

// The categories whose ORDINARY errors are noise: a read of a file that is not there, a grep with no
// match, an edit whose anchor moved. The agent recovers on its own, a session has dozens, and
// reporting them buried the failures a person would act on. Their timeouts and denials are still
// reported — those are not the agent's to fix.
const NOISY_CATEGORIES = new Set(['file', 'search']);

// A host label narrowed before it is echoed into a sentence: one lowercase word or `unknown`. The
// string reaches the portal, and a value this cannot vouch for is not repaired into one it can.
const LABEL_RE = /^[a-z_]{1,32}$/;

// `mcp_<server>_<tool>` is the spelling lib/operations-cursor.mjs knows; `MCP:<tool>` is the one
// Cursor's hook docs use in matchers. Which one a failure payload carries is a capture question, so
// both are read rather than one being guessed.
const MCP_COLON_RE = /^mcp:/i;

// The texts Cursor writes on a `turn_ended` line, as observed on 2026-09-28 across IDE and CLI
// transcripts. Checked in this order, and the ORDER is the point: "User aborted request" arrives
// with `status: "error"`, so reading the status first would file every such abort as `turn_error`.
const ABORT_TEXT_RE = /\buser aborted\b|\binterrupted manually\b/i;
const RATE_LIMIT_TEXT_RE = /\busage limit\b|\[resource_exhausted\]|\bERROR_RATE_LIMITED/i;
const STALL_TEXT_RE = /\bresume attempts made no progress\b/i;
const SUCCESS_STATUSES = new Set(['success', 'completed']);

// Hyphens and whitespace fold to `_` BEFORE the check: `permission-denied` and `Permission Denied`
// name the documented `permission_denied`, and rejecting the separator filed them as `unknown`
// under tool_error. Anything else outside [a-z_] is still refused, not repaired.
function labelOf(value, absent) {
  if (typeof value !== 'string' || value.trim() === '') return absent;
  const label = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return LABEL_RE.test(label) ? label : 'unknown';
}

// Milliseconds, as a number or a numeric string (Cursor converts some counts from int64). A negative
// or non-numeric value is not a duration, and the sentence simply leaves it out.
function durationMsOf(payload) {
  for (const field of DURATION_FIELDS) {
    const raw = payload[field];
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function categoryOfTool(tool) {
  if (tool === null) return 'other';
  return MCP_COLON_RE.test(tool) ? 'mcp' : categoryOf(tool);
}

// `Shell · timeout · 30.0s: <message>`, or `Shell failed (timeout)` when the host sent no text.
// Redacted as ONE string and only then cut, for the reason lib/redact.mjs gives: cutting first can
// strand half a credential past the anchor that identifies it.
function toolFailureDetails(tool, failureType, durationMs, message) {
  const name = tool === null ? UNKNOWN_TOOL : tool.slice(0, MAX_TOOL_NAME_CHARS);
  if (message === null) return redactDetail(`${name} failed (${failureType})`, ERROR_DETAILS_CAP);
  const head = [name, failureType];
  if (durationMs !== null) head.push(`${(durationMs / 1000).toFixed(1)}s`);
  return redactDetail(`${head.join(SEPARATOR)}: ${message.slice(0, MESSAGE_WINDOW_CHARS)}`, ERROR_DETAILS_CAP);
}

// One `postToolUseFailure` payload → the report, or null when it is not worth one.
//
// PRECEDENCE, written out because each rule overrides the next:
//   1. is_interrupt       → null. The user stopped it; nothing failed.
//   2. timeout            → tool_timeout, in any category.
//   3. permission_denied  → tool_permission_denied, in any category.
//   4. error on file/search → null (see NOISY_CATEGORIES). An absent failure_type is `error`.
//   5. MCP                → mcp_error.
//   6. anything else      → tool_error, including a failure kind nobody documented.
// Null here costs nothing downstream: the sidecar line is written before this is asked.
export function classifyToolFailure(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.is_interrupt === true || payload.isInterrupt === true) return null;
  const tool = pickString(payload, TOOL_NAME_FIELDS);
  const failureType = labelOf(pickString(payload, FAILURE_TYPE_FIELDS), 'error');
  const category = categoryOfTool(tool);
  let error;
  if (failureType === 'timeout') error = SESSION_ERROR.TOOL_TIMEOUT;
  else if (failureType === 'permission_denied') error = SESSION_ERROR.TOOL_PERMISSION_DENIED;
  else if (failureType === 'error' && NOISY_CATEGORIES.has(category)) return null;
  else if (category === 'mcp') error = SESSION_ERROR.MCP_ERROR;
  else error = SESSION_ERROR.TOOL_ERROR;
  const message = pickString(payload, MESSAGE_FIELDS);
  return { error, errorDetails: toolFailureDetails(tool, failureType, durationMsOf(payload), message) };
}

// One `turn_ended` outcome → the report, or null for a turn that ended well.
//
// A line with neither a status nor a text is not evidence of anything and answers null rather than
// inventing a `turn_error`; a status alone is enough, and becomes the sentence.
export function classifyTurnError(turn) {
  if (turn == null || typeof turn !== 'object') return null;
  const message = typeof turn.message === 'string' && turn.message.trim() !== '' ? turn.message.trim() : null;
  const hasStatus = typeof turn.status === 'string' && turn.status.trim() !== '';
  if (!hasStatus && message === null) return null;
  const status = labelOf(turn.status, 'unknown');
  if (SUCCESS_STATUSES.has(status)) return null;
  const text = message === null ? '' : message;
  let error;
  if (status === 'aborted' || ABORT_TEXT_RE.test(text)) error = SESSION_ERROR.USER_ABORTED;
  else if (RATE_LIMIT_TEXT_RE.test(text)) error = SESSION_ERROR.RATE_LIMIT;
  else if (STALL_TEXT_RE.test(text)) error = SESSION_ERROR.AGENT_STALLED;
  else error = SESSION_ERROR.TURN_ERROR;
  const errorDetails = message === null
    ? `Turn ended with status "${status}"`
    : redactDetail(message.slice(0, MESSAGE_WINDOW_CHARS), ERROR_DETAILS_CAP);
  return { error, errorDetails };
}
