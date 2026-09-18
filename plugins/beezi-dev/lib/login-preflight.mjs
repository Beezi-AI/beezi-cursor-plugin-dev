import fs from 'fs';
import path from 'path';
import { beeziCursorHome, queueDir, stateDir } from './paths-cursor.mjs';
import { HookScope, hooksStatus as _hooksStatus } from './hooks-install.mjs';
import { ensureInstalled as _ensureInstalled } from './plugin-install.mjs';

// What a sign-in checks BEFORE it opens a browser.
//
// The flow used to launch the browser, wait out the round-trip, exchange the code and only then
// discover that the directory it meant to write the credential into was not writable — at which
// point the user had authenticated, been told nothing useful, and had to do the whole round-trip
// again. Everything here is cheap and local, so it costs nothing to find out first.
//
// The distinction that matters is BLOCKING versus WARNING. Storage that cannot be written means the
// sign-in cannot complete at all, so it stops before the browser opens. Hooks that are missing or
// stale mean analytics will not flow YET — which is the normal state of a first-ever install, and
// refusing to sign in over it would make the plugin impossible to set up. Those are repaired
// through the normal installer path and reported.

export const PreflightCode = Object.freeze({
  STORAGE_UNWRITABLE: 'storage_unwritable',
  HOOKS_REPAIRED: 'hooks_repaired',
  HOOKS_MISSING: 'hooks_missing',
  HOOKS_FAILED: 'hooks_failed',
});

const PROBE_PREFIX = '.beezi-preflight';

// Create / write / rename / remove an exclusive temporary file inside the directory the plugin will
// actually use. Nothing short of that proves it: a directory can be listable and not writable, a
// file can be creatable on a filesystem that then refuses the rename `writeFileAtomic` depends on
// (read-only bind mounts, some network shares), and `fs.access` answers neither question honestly
// on Windows. Restricted permissions, and cleaned up on every path.
function probeDirectory(dir, fsImpl) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, detail: error == null || error.code == null ? 'EMKDIR' : error.code };
  }

  const stamp = `${process.pid}.${Date.now()}`;
  const probe = path.join(dir, `${PROBE_PREFIX}.${stamp}.tmp`);
  const renamed = path.join(dir, `${PROBE_PREFIX}.${stamp}.ok`);
  try {
    // 'wx' is exclusive create: it fails rather than truncating anything that happens to be there,
    // so a probe can never destroy a real file even if the name collided.
    const fd = fsImpl.openSync(probe, 'wx', 0o600);
    try { fsImpl.writeSync(fd, 'beezi'); } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(probe, renamed);
    fsImpl.unlinkSync(renamed);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error == null || error.code == null ? 'EWRITE' : error.code };
  } finally {
    // Both names, unconditionally: a failure between the open and the rename leaves the first one,
    // and a probe file left in the data root would be indistinguishable from plugin state.
    for (const leftover of [probe, renamed]) {
      try { fsImpl.unlinkSync(leftover); } catch { /* already gone */ }
    }
  }
}

// Is the reporting installation usable, and can it be repaired if not?
function checkHooks(deps) {
  const status = deps.hooksStatus == null ? _hooksStatus : deps.hooksStatus;
  const install = deps.ensureInstalled == null ? _ensureInstalled : deps.ensureInstalled;
  try {
    const before = status({ scope: HookScope.USER });
    if (before.state === 'installed') return { hooks: { status: 'ok', restartRequired: false }, warning: null };

    // The normal repair path — the same one session start and the installer use. A first login has
    // no hooks yet by definition, and this is how it gets them.
    install();
    const after = status({ scope: HookScope.USER });
    if (after.state === 'installed') {
      return {
        hooks: { status: 'repaired', restartRequired: true },
        warning: { code: PreflightCode.HOOKS_REPAIRED, detail: before.state },
      };
    }
    return {
      hooks: { status: 'missing', restartRequired: true },
      warning: { code: PreflightCode.HOOKS_MISSING, detail: after.state },
    };
  } catch (error) {
    // An unreadable registry or an installer that cannot write is a setup problem, not an
    // authentication problem. Reported, never fatal.
    return {
      hooks: { status: 'failed', restartRequired: true },
      warning: {
        code: PreflightCode.HOOKS_FAILED,
        detail: error == null || error.code == null ? 'error' : error.code,
      },
    };
  }
}

// The roots a completed sign-in has to be able to write. Resolved at call time so an injected
// BEEZI_CURSOR_HOME (and, after integration, the environment's own data root) is what gets probed —
// checking some other directory would prove nothing about this one.
function defaultRoots() {
  return [beeziCursorHome(), stateDir(), queueDir()];
}

// Never throws. `ok: false` means: do not open a browser.
export async function runLoginPreflight({ roots, deps = {} } = {}) {
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  const targets = roots == null ? defaultRoots() : roots;

  const blocking = [];
  const seen = [];
  for (const dir of targets) {
    // The state and queue directories are normally under the data root, so probing each in turn
    // would pay for the same filesystem three times on the common install.
    if (seen.indexOf(dir) !== -1) continue;
    seen.push(dir);
    const probe = probeDirectory(dir, fsImpl);
    if (!probe.ok) {
      blocking.push({ code: PreflightCode.STORAGE_UNWRITABLE, path: dir, detail: probe.detail });
    }
  }

  // Storage decides whether a sign-in can complete at all, so a failure there means the hook check
  // is not worth its cost — and a browser must not open either way.
  if (blocking.length > 0) {
    return { ok: false, blocking, warnings: [], hooks: { status: 'failed', restartRequired: false } };
  }

  const { hooks, warning } = checkHooks(deps);
  return { ok: true, blocking: [], warnings: warning == null ? [] : [warning], hooks };
}

// The one phrasing of a blocking result, so the CLI and the MCP tool say the same thing.
export function describePreflightBlock(blocking) {
  const first = blocking[0];
  if (first == null) return 'Sign-in cannot continue.';
  return `Sign-in stopped before opening a browser: ${first.path} cannot be written (${first.detail}). `
    + 'Fix the permissions on that directory, or point BEEZI_CURSOR_HOME somewhere writable, and try again.';
}
