import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isTelemetryGranted } from './telemetry-consent.mjs';
import {
  telemetryQueueDir,
  telemetryQuarantineDir,
  listQueueFiles,
  unlinkQuietly,
} from './telemetry-store.mjs';
import { currentInstallationId } from './telemetry-installation.mjs';

// The structured recorder. Everything this plugin ever learns about its own failures goes through
// here, and the shape of a record is the whole of the privacy guarantee: there is deliberately no
// branch that can put an error message, a stack string, a prompt, tool output, a repository URL,
// a hostname or a path from outside the plugin into a file.
//
// The fields are a fixed vocabulary compared against the deployed portal DTO
// (`api/src/application/cli-agent/dto/plugin-diagnostics.request.dto.ts` at commit 871a788). A
// value that does not match its shape is DROPPED, never truncated: a truncated sentence is still a
// sentence, and the server rejects the whole event on an unknown value anyway.

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_PENDING = 200;
// The server's own bound (`@Max(100000)` on `count`). Clamped at fold time so a pathologically hot
// event cannot fold itself into a record the route will refuse forever.
export const MAX_COUNT = 100000;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Structured vocabularies have a shape; prose does not.
const IDENTIFIER = /^[A-Za-z0-9_$.-]{1,64}$/;   // ENOENT, ERR_MODULE_NOT_FOUND, SyntaxError
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;  // 2.1.251, 0.6.0, 1.0.0-beta.3
const OS_RELEASE = /^[A-Za-z0-9._-]{1,80}$/;    // 25.4.0, 6.8.0-45-generic
// Mirrors the portal's `site` pattern exactly — a shape only this side considers valid can never
// fail server-side, and vice versa.
const SITE = /^[A-Za-z0-9_./-]+:\d+$/;

// The codes this plugin may emit, frozen by CONTRACTS.md §8. Every value here except
// `auth_state_transition` is present verbatim in the deployed `PluginDiagnosticCode` enum; that
// one is translated on the wire (see lib/telemetry-transport.mjs) rather than invented.
export const DIAGNOSTIC_CODES = Object.freeze({
  HOOK_CRASH: 'hook_crash',
  HOOK_UNHANDLED_REJECTION: 'hook_unhandled_rejection',
  HOOK_IMPORT_FAILED: 'hook_import_failed',
  QUEUE_FILE_QUARANTINED: 'queue_file_quarantined',
  QUEUE_FLUSH_HTTP_ERROR: 'queue_flush_http_error',
  STATE_WRITE_FAILED: 'state_write_failed',
  MCP_HANDSHAKE_TIMEOUT: 'mcp_handshake_timeout',
  MCP_STARTUP_FAILED: 'mcp_startup_failed',
  LOGIN_FAILED: 'login_failed',
  LOGOUT_UNLINK_UNCONFIRMED: 'logout_unlink_unconfirmed',
  INSTALLATION_BINDING_FAILED: 'installation_binding_failed',
  AUTH_STATE_TRANSITION: 'auth_state_transition',
});

// Where a failure was observed. A call site that does not know (fs-store, token) gets UNKNOWN
// rather than a guess.
export const DIAGNOSTIC_SOURCES = Object.freeze({
  CHECKPOINT: 'checkpoint',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  REPORT: 'report',
  SESSION_START: 'session_start',
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_STOP: 'subagent_stop',
  TRACK_PROMPT: 'track_prompt',
  PULSE: 'pulse',
  MCP_BRIDGE: 'mcp_bridge',
  BACKFILL: 'backfill',
  SYNC: 'sync',
  LOGIN: 'login',
  LOGOUT: 'logout',
  ME: 'me',
  TELEMETRY_FLUSH: 'telemetry_flush',
  DIAGNOSTICS_WORKER: 'diagnostics_worker',
  UNKNOWN: 'unknown',
});

const CODE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_CODES).map((k) => DIAGNOSTIC_CODES[k]));
const SOURCE_VALUES = Object.freeze(Object.keys(DIAGNOSTIC_SOURCES).map((k) => DIAGNOSTIC_SOURCES[k]));

export const isKnownCode = (value) => CODE_VALUES.indexOf(value) !== -1;
export const isKnownSource = (value) => SOURCE_VALUES.indexOf(value) !== -1;

// ─── suppression and reentrancy

// Set for the lifetime of the delivery worker: a failure while SENDING diagnostics must never
// enqueue a diagnostic about that failure, which the next worker would fail to send the same way.
let suppressed = false;
export function suppressRecording(value = true) {
  suppressed = value;
}
export function isSuppressed() {
  return suppressed;
}

// The reentrancy guard, and the reason it is a flag rather than a depth counter: the integrator's
// `state_write_failed` call site lives inside fs-store's own write failure handler, so recording a
// diagnostic can re-enter the very code that failed. One bounded attempt, then nothing.
let recording = false;

// A call site that does not know its own source falls back to whatever the hook runner published
// for the hook currently in flight.
let currentSource = null;
export function setCurrentSource(source) {
  currentSource = isKnownSource(source) ? source : null;
}

// ─── shaping

function shaped(value, pattern) {
  if (value == null) return null;
  const text = String(value);
  return pattern.test(text) ? text : null;
}

// A site is `<path relative to the plugin>:<line>` and nothing else.
//
// The containment check after `path.relative` is the actual guarantee; the character class only
// has to reject prose. `siteFrom` hands this ABSOLUTE paths out of a stack, so absolute is not by
// itself disqualifying — containment decides, and a drive letter or UNC share that is not under
// pluginRoot lands outside it (`path.relative` answers with the absolute target across roots, and
// with a `..` prefix within one).
//
// The extra guard below is for the OTHER platform's spelling. On POSIX, `C:\Users\dev\secret.mjs`
// and `\\server\share\x.mjs` are ordinary RELATIVE filenames, so they would resolve happily inside
// pluginRoot and be "contained" — a Windows path smuggled through a Linux CI run. A value that is
// not absolute here must therefore not look absolute anywhere.
export function normalizeSite(value, pluginRoot = PLUGIN_ROOT) {
  if (typeof value !== 'string' || value === '') return null;
  const at = value.lastIndexOf(':');
  if (at <= 0) return null;
  const line = value.slice(at + 1);
  if (!/^\d+$/.test(line)) return null;
  const raw = value.slice(0, at);
  if (raw === '') return null;

  if (!path.isAbsolute(raw)) {
    if (raw.charAt(0) === '/' || raw.charAt(0) === '\\') return null; // root-relative elsewhere
    if (/^[A-Za-z]:[\\/]/.test(raw)) return null;                     // a drive letter elsewhere
  }

  const rel = path.relative(pluginRoot, path.resolve(pluginRoot, raw));
  if (rel === '' || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  // An empty segment is a leading `//` or `\\` that survived normalization — a UNC share.
  if (parts.indexOf('..') !== -1 || parts.indexOf('') !== -1) return null;

  const site = `${parts.join('/')}:${line}`;
  return SITE.test(site) ? site : null;
}

// Both spellings of the plugin root that a stack frame can use.
//
// This is the whole of the fix for a bug that made `site` null for every real failure: an ESM stack
// frame names its module by URL, not by native path —
//   at telemetryDir (file:///C:/Users/.../plugins/beezi/lib/telemetry-store.mjs:22:15)
// — so comparing against the native root never matched on Windows, and never matched on POSIX
// either as soon as the path held a character URL encoding escapes (a space, a `#`). Only synthetic
// stacks assigned by hand in a test ever matched, which is exactly why the first tests passed.
function rootForms(pluginRoot) {
  const forms = [pluginRoot];
  try {
    const href = pathToFileURL(pluginRoot).href;
    if (href !== pluginRoot) forms.push(href);
  } catch { /* a root that is not a real path has only its literal form */ }
  return forms;
}

// A frame's file part as a native path. `fileURLToPath` is what undoes the percent-encoding;
// doing it by hand would reintroduce the same class of bug one layer down.
function framePathToNative(value) {
  if (value.indexOf('file://') !== 0) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return null;
  }
}

// The first stack frame that belongs to this plugin, rendered relative to it. A stack with no
// plugin frame yields null rather than a path belonging to the user.
export function siteFrom(error, pluginRoot = PLUGIN_ROOT) {
  const stack = error == null || typeof error.stack !== 'string' ? '' : error.stack;
  const forms = rootForms(pluginRoot);
  for (const line of stack.split('\n')) {
    // Frames only. A MESSAGE can contain anything, including something that looks like a path
    // plus a line:col — and the message is exactly what must never reach a record.
    if (!/^\s*at\s/.test(line)) continue;
    for (const form of forms) {
      const index = line.indexOf(form);
      if (index === -1) continue;
      // Anchored to the start of a slice already proven to begin with the root, and to the end of
      // the line, so a space or paren inside the root cannot fracture the match into a shorter,
      // relative-looking fragment.
      const match = /^(.+):(\d+):\d+\)?$/.exec(line.slice(index));
      if (match === null) continue;
      const native = framePathToNative(match[1]);
      if (native === null) continue;
      const site = normalizeSite(`${native}:${match[2]}`, pluginRoot);
      if (site !== null) return site;
    }
  }
  return null;
}

function pluginVersion(pluginRoot) {
  const pkg = readJson(path.join(pluginRoot, 'package.json'));
  if (pkg == null || typeof pkg.version !== 'string') return 'unknown';
  return VERSION.test(pkg.version) ? pkg.version : 'unknown';
}

// ─── the queue

export function readPendingEvents(dir) {
  const target = dir == null ? telemetryQueueDir() : dir;
  const out = [];
  for (const name of listQueueFiles(target)) {
    const value = readJson(path.join(target, name));
    if (value != null && typeof value === 'object') out.push(value);
  }
  return out;
}

// A record that will not parse is moved aside rather than deleted: a file that consistently fails
// to parse is itself evidence about the writer, and the retention sweep expires the quarantine on
// the same 14-day clock. Returns true when the file is no longer in the queue.
function quarantine(filePath, nowMs) {
  const dir = telemetryQuarantineDir();
  // The injected clock, not `Date.now()`: the quarantine name is also what the retention sweep
  // reads back, and a test that moves the clock must be able to age a quarantined record.
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const target = path.join(dir, `${path.basename(filePath, '.json')}.${stamp}.corrupt.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.renameSync(filePath, target);
    return true;
  } catch {
    return unlinkQuietly(filePath);
  }
}

function expiredAt(value, stat, now) {
  const stamp = value == null ? null : value.lastSeenAt;
  const parsed = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  if (Number.isFinite(parsed)) return now - parsed > RETENTION_MS;
  // No usable stamp: fall back to the file's own age, so an undated record still expires.
  if (stat == null || !Number.isFinite(stat.mtimeMs)) return false;
  return now - stat.mtimeMs > RETENTION_MS;
}

// Bounded by construction: two flat directories that the 200-record cap already keeps small.
export function applyTelemetryRetention(deps = {}) {
  const now = (deps.now == null ? Date.now : deps.now)();
  let removed = 0;
  for (const dir of [telemetryQueueDir(), telemetryQuarantineDir()]) {
    for (const name of listQueueFiles(dir)) {
      const filePath = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (expiredAt(readJson(filePath), stat, now) && unlinkQuietly(filePath)) removed += 1;
    }
  }
  return removed;
}

// ─── recording

// Record one structured issue. Returns true only when a file on disk now reflects it.
//
// `fields` is an allowlist, not a bag: `source`, `status`, `reason`, `durationMs`, `site`,
// `cursorVersion`, `authState` and an `error` used ONLY for its constructor name, its `.code` and
// the plugin-relative frame in its stack. Anything else the caller passes is ignored — there is no
// spread anywhere in this function.
//
// Never throws. Telemetry must never be the reason a hook fails.
export function recordIssue(code, fields = {}, deps = {}) {
  if (suppressed || recording) return false;
  recording = true;
  try {
    const pluginRoot = deps.pluginRoot == null ? PLUGIN_ROOT : deps.pluginRoot;
    const write = deps.write == null ? writeJsonSecure : deps.write;
    const nowMs = (deps.now == null ? Date.now : deps.now)();
    const nowIso = new Date(nowMs).toISOString();

    const input = fields == null || typeof fields !== 'object' ? {} : fields;
    const source = isKnownSource(input.source)
      ? input.source
      : (currentSource === null ? DIAGNOSTIC_SOURCES.UNKNOWN : currentSource);
    if (!isKnownCode(code)) return false;
    if (!isTelemetryGranted()) return false;

    const error = input.error;
    const errorName = shaped(
      error == null || error.constructor == null ? null : error.constructor.name, IDENTIFIER,
    );
    const errorCode = shaped(error == null ? null : error.code, IDENTIFIER);
    const site = input.site == null
      ? siteFrom(error, pluginRoot)
      : normalizeSite(input.site, pluginRoot);
    const version = pluginVersion(pluginRoot);
    const status = Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
      ? input.status
      : null;
    const reason = shaped(input.reason, IDENTIFIER);
    const authState = shaped(input.authState, IDENTIFIER);
    const durationMs = Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? Math.round(input.durationMs)
      : null;
    // Captured locally and deliberately never put on the wire: the deployed DTO permits
    // `claudeCodeVersion` and has no host-neutral field, and an unknown key rejects the event.
    const cursorVersion = shaped(input.cursorVersion, VERSION);

    // Repeated notices of the same shape fold into one event's count instead of minting a new
    // event each time. Everything that distinguishes two failures is in the key; nothing that
    // merely counts them is.
    const key = crypto.createHash('sha1')
      .update([code, source, site, errorName, errorCode, version, status, authState, reason].join('|'))
      .digest('hex')
      .slice(0, 16);

    const dir = telemetryQueueDir();
    const file = path.join(dir, `${key}.json`);
    let existing = readJson(file);
    if (existing === null && fs.existsSync(file)) {
      // Present but unparseable. Never salvage a fragment into a count.
      quarantine(file, nowMs);
      existing = null;
    }

    if (existing != null && typeof existing === 'object' && Number.isInteger(existing.count)) {
      const folded = Object.assign({}, existing, {
        count: Math.min(existing.count + 1, MAX_COUNT),
        lastSeenAt: nowIso,
      });
      write(file, folded);
      return true;
    }

    // A NEW record, so the caps apply. The retention sweep runs ONLY when the queue is already at
    // the cap — an expired record must not be the reason a live failure goes unreported, and a
    // readdir-plus-stat of every record on every new event would be a per-hook cost paid for
    // nothing in the 99% case where the queue holds a handful of files.
    if (listQueueFiles(dir).length >= MAX_PENDING) {
      applyTelemetryRetention({ now: () => nowMs });
      if (listQueueFiles(dir).length >= MAX_PENDING) return false;
    }

    // Stamped once, at queue time, and only when a CONFIRMED binding exists. An event keeps the
    // identity it was queued under even if the machine later rotates or drops it, so a report is
    // never re-attributed after the fact. A lookup failure must never lose the diagnostic.
    const readId = deps.installationId == null ? currentInstallationId : deps.installationId;
    let installationId = null;
    try { installationId = readId(); } catch { installationId = null; }
    write(file, {
      eventId: `${key}-${nowMs.toString(36)}`,
      code,
      source,
      site,
      errorName,
      errorCode,
      httpStatus: status,
      authState,
      reason,
      installationId: typeof installationId === 'string' ? installationId : null,
      pluginVersion: version,
      nodeVersion: process.version,
      os: process.platform,
      osRelease: shaped((deps.osRelease == null ? () => os.release() : deps.osRelease)(), OS_RELEASE),
      arch: process.arch,
      // Local-only fields; lib/telemetry-transport.mjs does not put them on the wire.
      durationMs,
      cursorVersion,
      count: 1,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    return true;
  } catch {
    return false;
  } finally {
    recording = false;
  }
}
