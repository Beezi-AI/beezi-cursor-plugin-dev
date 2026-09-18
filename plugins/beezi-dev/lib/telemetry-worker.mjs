import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { beeziCursorHome } from './paths-cursor.mjs';
import { writeJsonSecure } from './fs-store.mjs';
import { isTelemetryGranted } from './telemetry-consent.mjs';
import {
  telemetrySendStateFile,
  countPending,
  purgeAllPending,
  withTelemetryLock,
} from './telemetry-store.mjs';
import { suppressRecording, isSuppressed } from './telemetry-recorder.mjs';
import {
  flushDiagnostics,
  readSendState,
  MIN_SEND_INTERVAL_MS,
  SEND_STATE_VERSION,
} from './telemetry-transport.mjs';

// The nonblocking delivery worker: a detached process that sends what is queued and exits.
//
// Delivery cannot happen inside a hook. Cursor kills a hook at ten seconds and surfaces its stderr
// as a failure, and a diagnostics POST is the one call in this plugin that has no business costing
// the user a turn. So a hook only decides whether a worker is DUE; the worker does the work.

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Belt and braces over the transport's own request timeout: a spawn that wedges inside a native
// call never returns to JavaScript, and this process must not outlive the window it claimed.
export const WATCHDOG_MS = 30 * 1000;
// A test seam, and only that. Clamped to the real ceiling so it can shorten the watchdog for a
// subprocess test but never extend it, and never disable it.
export const WATCHDOG_ENV_VAR = 'BEEZI_CURSOR_TELEMETRY_WATCHDOG_MS';
const MIN_WATCHDOG_MS = 50;

export function workerScriptPath(pluginRoot = PLUGIN_ROOT) {
  return path.join(pluginRoot, 'scripts', 'telemetry-worker.mjs');
}

export function resolveWatchdogMs(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return WATCHDOG_MS;
  return Math.min(Math.max(parsed, MIN_WATCHDOG_MS), WATCHDOG_MS);
}

export function startWatchdog(deps = {}) {
  const exit = deps.exit == null ? (code) => process.exit(code) : deps.exit;
  const ms = resolveWatchdogMs(deps.ms == null ? deps.env == null
    ? process.env[WATCHDOG_ENV_VAR]
    : deps.env[WATCHDOG_ENV_VAR] : deps.ms);
  return setTimeout(() => exit(0), ms);
}

export function hasPendingWork() {
  return countPending() > 0;
}

// Fire and forget: start the worker in its own process, cut every tie to this one, and return.
//
// `stdio: 'ignore'`, `windowsHide: true` and `unref()` are all load-bearing, and not for tidiness.
// An inherited pipe would put the child's bytes on the HOOK's stdout, which Cursor parses as the
// hook's protocol response; a ref'd child handle keeps a libuv handle alive in the parent, and a
// hook that exits while a handle is mid-close aborts on Windows (`!(handle->flags &
// UV_HANDLE_CLOSING)`), which the host reports as a hook error. `windowsHide` is what keeps a
// console window from flashing in front of the user on every turn.
//
// The home is passed EXPLICITLY rather than merely inherited: a parent that resolved its home from
// the default must hand the child that same absolute path, so a worker can never drain one
// environment variant's queue against another's identity.
//
// Never throws: a machine that refuses to spawn (EPERM, EMFILE, a locked-down policy) must cost
// the hook nothing at all.
export function spawnWorker(deps = {}) {
  const spawnImpl = deps.spawnImpl == null ? spawn : deps.spawnImpl;
  const script = deps.script == null ? workerScriptPath() : deps.script;
  try {
    const child = spawnImpl(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: Object.assign({}, process.env, { BEEZI_CURSOR_HOME: beeziCursorHome() }),
    });
    if (child == null) return false;
    if (typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

// The gate every trigger point shares: consent, something to send, and the backoff window. All
// three are cheap file reads, so a hook with nothing to deliver pays a stat and returns.
//
// The window is CLAIMED here rather than inside the worker. Hook start and hook completion fire
// within milliseconds of each other, and without the claim every hook in a turn would spawn its
// own worker; with it, the second trigger reads a next-attempt time in the future and does
// nothing. A lost race costs one duplicate delivery, which the route dedups on eventId.
export function maybeLaunchWorker(deps = {}) {
  try {
    if (!isTelemetryGranted()) return false;
    if (!hasPendingWork()) return false;
    const now = (deps.now == null ? Date.now : deps.now)();
    const state = readSendState();
    if (now < state.nextAttemptAt) return false;
    try {
      // Every field the sender will read back, written through the SAME version constant it
      // validates against: a literal here would silently invalidate the whole record the day that
      // constant moves, and an omitted `batchLimit` would throw away a 413 shrink the sender
      // persisted (see lib/telemetry-transport.mjs).
      writeJsonSecure(telemetrySendStateFile(), {
        version: SEND_STATE_VERSION,
        attempts: state.attempts,
        nextAttemptAt: now + MIN_SEND_INTERVAL_MS,
        batchLimit: state.batchLimit,
      });
    } catch {
      // An unclaimable window would let every hook spawn a worker. Refuse instead.
      return false;
    }
    return spawnWorker(deps);
  } catch {
    return false;
  }
}

// What the detached process actually runs.
//
// Recording is suppressed for its whole lifetime, and this is the reason the worker does NOT go
// through the hook runner: every failure in here is a failure of the diagnostics path, and
// recording it would enqueue a report that the next worker fails to deliver in exactly the same
// way. It takes no hook wrapper and writes nothing to stdout.
//
// The telemetry lock is held across the flush, so a `beezi telemetry off` typed mid-batch defers
// its purge rather than deleting a report this process is about to have acknowledged — and the
// flush itself rechecks consent before every request, so the denial still lands immediately.
export async function runWorker(deps = {}) {
  // Restored in `finally` rather than left set. In the detached process it makes no difference —
  // it exits moments later — but `runWorker` is also called in-process by the tests and by anything
  // that wants a synchronous drain, and a suppression flag left on would silence every later
  // recording in that process without anything saying so.
  const wasSuppressed = isSuppressed();
  suppressRecording(true);
  try {
    const result = await withTelemetryLock(async () => {
      if (!isTelemetryGranted()) {
        purgeAllPending();
        return { ran: true, purged: true };
      }
      const flushed = await flushDiagnostics(deps);
      return Object.assign({ ran: true }, flushed);
    }, Object.assign({ miss: { ran: false, reason: 'locked' } }, deps.lock));
    return result;
  } catch {
    // A worker that throws is still a worker that must exit quietly.
    return { ran: false, reason: 'failed' };
  } finally {
    suppressRecording(wasSuppressed);
  }
}
