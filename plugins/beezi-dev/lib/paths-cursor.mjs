import os from 'os';
import path from 'path';
import { dataRootName, variantMarker } from './env-identity.mjs';
// This module's own exports, as the lookup table `hostPath` at the bottom of the file reads by
// name. A self-import is a live namespace binding, not a second evaluation: nothing is re-run and
// nothing enters the graph that was not already in it.
import * as ownPaths from './paths-cursor.mjs';

// This plugin's own data root — deliberately NOT `~/.beezi` (Claude Code's) and NOT `~/.beezi-codex`
// (the Codex plugin's). All three write the same filenames: `queue/`, `state/`, `billing.json`,
// `repo-map.json`, `credentials.json`. Sharing any of them means one agent's queued segments flush
// under the other's identity, and whichever plugin captured a subscription plan last wins
// `billing.json` for both. Same reasoning as the `beezi-cursor` keyring entry — one store per agent.
//
// `BEEZI_HOME` is deliberately NOT honored: it is the single knob that would point every agent back
// at one directory, which is precisely the collision this root exists to prevent. The agent-scoped
// `BEEZI_CURSOR_HOME` is honored instead (mirroring `BEEZI_CODEX_HOME`) — a per-agent variable
// cannot merge two agents' stores no matter what it is set to.
// BEEZI_CURSOR_HOME is honoured EXACTLY, with no environment suffix appended: an explicit home is
// the operator saying where the store IS, and quietly relocating it would strand the data already
// there. Otherwise the environment names the directory (`dataRootName()`), so a dev variant cannot
// read prod's queue, credentials or upload history. Prod is unsuffixed, so an upgrade from before
// variants existed reads exactly what is already on disk.
export function beeziCursorHome() {
  return process.env.BEEZI_CURSOR_HOME == null
    ? path.join(os.homedir(), dataRootName())
    : process.env.BEEZI_CURSOR_HOME;
}

export function queueDir() {
  return path.join(beeziCursorHome(), 'queue');
}

export function stateDir() {
  return path.join(beeziCursorHome(), 'state');
}

// Uncommitted checkpoint intent: the frozen pending batch (window, attribution runs, serialized
// payloads with fixed ids, proposed next cursor/usage snapshot) written BEFORE the first enqueue
// and deleted only after the state commit is durable.
//
// A DIRECTORY OF ITS OWN, beside `state/`, not a field inside the state file. `state/<id>.json` is
// committed truth; a pending batch is intent. One file holding both would need one atomic write to
// carry both, and a crash between "the batch is durable" and "the state is committed" would be
// indistinguishable from "neither happened" — which is the exact ambiguity the batch exists to
// remove.
export function pendingDir() {
  return path.join(beeziCursorHome(), 'pending');
}

// Takes an ALREADY-SANITIZED name, the same contract (and for the same cycle reason) as
// `sessionStateFile` below: `safeName` lives in lib/sidecar.mjs, which imports this module.
export function pendingBatchFile(name) {
  return path.join(pendingDir(), `${name}.json`);
}

// One conversation's live state (cursor, anchor, account stamp, covered intervals).
//
// Takes an ALREADY-SANITIZED name, not a raw conversation id, and that split is deliberate. The
// plugin's one sanitizer for that untrusted value is `safeName` in lib/sidecar.mjs, and this module
// cannot call it: lib/sidecar.mjs imports paths-cursor, so importing it back would be a cycle. So
// sanitation stays with its owner and only the SHAPE of the path lives here — which is the half two
// modules were duplicating (lib/checkpoint.mjs writes these files, lib/sidecar-index.mjs reads them
// for the backfill's live-cursor belt), and a reader that spelled the shape differently from the
// writer would read `cursor: 0` forever and re-upload sessions live tracking already sent.
export function sessionStateFile(name) {
  return path.join(stateDir(), `${name}.json`);
}

// The event sidecar: one append-only JSONL per Cursor conversation. This is the plugin's PRIMARY
// data source — Cursor's own storage has moved format four times in a year and has twice been wiped
// on upgrade, so nothing load-bearing is read out of it.
export function eventsDir() {
  return path.join(beeziCursorHome(), 'events');
}

// Persisted known-repo-root map (dir→root resolution cache/seed). One JSON for the machine.
export function repoMapFile() {
  return path.join(beeziCursorHome(), 'repo-map.json');
}

export function credentialsFile() {
  return path.join(beeziCursorHome(), 'credentials.json');
}

// Durable "already imported" ledger for the login-time history backfill. Deliberately at the
// beeziCursorHome() ROOT and not under state/, queue/ or events/: pruneStale() deletes 14-day-old
// files in all three, so a marker living there would expire and make every old session look
// importable again on the next run.
export function auditLedgerFile() {
  return path.join(beeziCursorHome(), 'audit-ledger.json');
}

// Repeatable-sync progress, account-scoped and separately versioned from the one-time ledger above.
// Root-level for the same pruneStale() reason: a 14-day expiry here would make every run re-ask
// coverage for the whole machine.
export function syncStateFile() {
  return path.join(beeziCursorHome(), 'sync-state.json');
}

// Cached tenant tracking state (whoami's trackingMode/tier/backfillCompleted, plus the linkedAt
// stamp login writes). Root-level for the same pruneStale() reason as the audit ledger — an
// expiring cache would silently forget that the one-time pull already completed.
export function trackingStateFile() {
  return path.join(beeziCursorHome(), 'tracking.json');
}

export function billingConfigFile() {
  return path.join(beeziCursorHome(), 'billing.json');
}

// Where the installer writes its launcher scripts. Each is a single-token executable so the
// `command` field never depends on how Cursor splits arguments or resolves `node` on PATH.
export function hookLauncherDir() {
  return path.join(beeziCursorHome(), 'hooks');
}

// A stable path for a human to type. A marketplace install lives under
// `plugins/cache/<marketplace>/<plugin>/<git-sha>/`, so it changes on every upgrade; the shim here
// is regenerated on every session and forwards to whichever copy is actually installed. The skills
// do NOT go through it — Cursor expands `${CURSOR_PLUGIN_ROOT}` in a skill's body, so they name the
// installed scripts directly and do not wait for a session that has run the MCP server.
export function binDir() {
  return path.join(beeziCursorHome(), 'bin');
}

export function binShimFile() {
  return path.join(binDir(), 'beezi.mjs');
}

// Which hook registry actually fired last, and when. Written by the hook scripts themselves and
// read by the self-installer, which is the only way to tell a plugin-bundled `hooks/hooks.json`
// that Cursor discovered from one it silently ignored.
export function hookSourceFile() {
  return path.join(stateDir(), 'hook-source.json');
}

// Cursor's config root. The resolution order is Cursor's own, and the `XDG_CONFIG_HOME` branch has
// NO OS guard — it fires on Windows and macOS too. That is Cursor's documented behaviour, not a
// bug in this function: a developer who exports XDG_CONFIG_HOME on Windows genuinely relocates
// Cursor's config there, so guarding this by platform would send the plugin to a directory Cursor
// is not using. Do not "fix" it.
// TODO(P0): unverified — see lib/hook-dump.mjs
export function cursorConfigDir() {
  if (process.env.CURSOR_CONFIG_DIR) return process.env.CURSOR_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'cursor');
  return path.join(os.homedir(), '.cursor');
}

// Where a locally-installed plugin is materialized. The installer copies the plugin here and points
// the launchers at this copy, so a plugin upgrade is a re-run of the installer rather than a
// registry that silently points at a deleted cache directory.
// TODO(P0): unverified — see lib/hook-dump.mjs
// Namespaced by environment. Unsuffixed it is one directory for every variant, so installing dev
// OVERWRITES the materialized prod copy that prod's launchers point at — and uninstalling dev then
// deletes it.
export function cursorPluginDir() {
  return path.join(cursorConfigDir(), 'plugins', 'local', variantMarker());
}

// Cursor's per-project data (chat/agent state). Relocatable via CURSOR_DATA_DIR, which is a
// *different* variable from CURSOR_CONFIG_DIR — a machine may set one and not the other.
// TODO(P0): unverified — see lib/hook-dump.mjs
export function cursorProjectsDir() {
  const base = process.env.CURSOR_DATA_DIR == null
    ? path.join(os.homedir(), '.cursor')
    : process.env.CURSOR_DATA_DIR;
  return path.join(base, 'projects');
}

// Cursor's user-level hook registry. This is the P0 fallback target: if a plugin-scope
// `hooks/hooks.json` turns out not to be discovered, the installer merges here instead
// (`install --scope user`), which is the path the Codex plugin already proved.
// TODO(P0): unverified — see lib/hook-dump.mjs
export function cursorHooksFile() {
  return path.join(cursorConfigDir(), 'hooks.json');
}

// Cursor's AI-vs-human line attribution database. Hardcoded to the REAL home directory: Cursor's
// tracker writes it there regardless of CURSOR_CONFIG_DIR or XDG_CONFIG_HOME, so resolving it
// through cursorConfigDir() would look in a directory that is empty on exactly the machines that
// relocate their config.
// TODO(P0): unverified — see lib/hook-dump.mjs
export function aiCodeTrackingDbFile() {
  return path.join(os.homedir(), '.cursor', 'ai-code-tracking.db');
}

// The VS Code-derived global storage directory that holds `state.vscdb` (Cursor is a VS Code fork,
// so it keeps VS Code's per-platform layout under its own product name).
// TODO(P0): unverified — see lib/hook-dump.mjs
export function globalStorageDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA == null
      ? path.join(home, 'AppData', 'Roaming')
      : process.env.APPDATA;
    return path.join(appData, 'Cursor', 'User', 'globalStorage');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  }
  const xdg = process.env.XDG_CONFIG_HOME == null
    ? path.join(home, '.config')
    : process.env.XDG_CONFIG_HOME;
  return path.join(xdg, 'Cursor', 'User', 'globalStorage');
}

// TODO(P0): unverified — see lib/hook-dump.mjs
export function stateVscdbFile() {
  return path.join(globalStorageDir(), 'state.vscdb');
}

// One named path function, resolved by name and degrading to null instead of throwing.
// lib/vscdb.mjs, lib/cursor-account.mjs and lib/code-changes-cursor.mjs each carried a copy of this
// body, keyed off a namespace import of this module; here the table is this module's own namespace
// and the behaviour is unchanged. Every caller sits behind a hook that must not break the user's
// Cursor session, so a name this module does not export, a resolver that throws, and a resolver
// that answers with nothing are all ONE answer: null, and the caller takes its documented degraded
// branch — the same one a missing Cursor install produces.
//
// The name is looked up per call, never at import time, so this adds no import-time work to the
// hook processes that all load this module.
export function hostPath(name) {
  const fn = ownPaths[name];
  if (typeof fn !== 'function') return null;
  try {
    const resolved = fn();
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  } catch {
    return null;
  }
}
