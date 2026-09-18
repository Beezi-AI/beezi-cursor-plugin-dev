import fs from 'fs';
import path from 'path';
import { UserError } from './friendly-error.mjs';
import { writeFileAtomic } from './fs-store.mjs';
import { removeSync } from './fs-compat.mjs';

// Project scope, written as a file instead of clicked in the UI.
//
// Cursor's plugins editor cannot install a plugin for a project in an ordinary window: the handler
// calls `workspaceCollectionService.createWorkspaceReference(...)` first, and outside a Glass
// (multi-workspace) window the injected service is the empty stub whose every method throws
// `Workspace collection is not available`. That is a client bug, it fires for every plugin, and no
// plugin can work around it from inside.
//
// It does not have to be worked around. Project scope is a file: the extension host reads
// `<workspace>/.cursor/settings.json`, takes `plugins` as a map of `"<marketplace>/<plugin>"` →
// `{ enabled, gitUrl, gitRef, gitPath }`, and clones each entry that carries a git URL directly —
// no backend, no workspace collection, no UI. Entries WITHOUT a `gitUrl` are resolved through
// Cursor's public plugin registry instead, so a self-hosted marketplace has to name its URL.
//
// This module writes that file the way the hook installer writes the hook registry: merge into what
// is already there, refuse anything unparseable, and take the file away again if Beezi's entry was
// the only thing in it.

export const MARKETPLACE_NAME = 'beezi';
export const PLUGIN_NAME = 'beezi';

// Cursor splits this key at the FIRST slash into { marketplaceName, name } — a bare `beezi` would
// be looked up as a first-party plugin in the public registry and never found.
export const PROJECT_PLUGIN_KEY = `${MARKETPLACE_NAME}/${PLUGIN_NAME}`;

// Where the plugin sits inside the marketplace repository. Cursor's own project-install writer
// drops this field, but its reader honours it, so a plugin that is not at the repo root has to be
// installed by file — one more reason this path exists.
export const DEFAULT_GIT_PATH = 'plugins/beezi';

export const DEFAULT_GIT_REF = 'main';

export function projectSettingsFile(dir = process.cwd()) {
  return path.join(dir, '.cursor', 'settings.json');
}

// Cursor's own validation, reproduced: https:// with no credentials, query or fragment, or an
// scp-style git@ address. Everything else — file://, http://, a bare path — is dropped at load time
// with a console warning the user will never see. A marketplace added from a local directory
// therefore cannot be installed at project scope at all; the repository has to be reachable.
export function isSupportedGitUrl(value) {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!url) return false;
  if (url.startsWith('git@')) return /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~\-/]+(?:\.git)?$/.test(url);
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

// The user's settings file — hand-written, commented on, checked into their repository. Parsing it
// as `{}` because of a stray comma and writing our entry over the top would delete every setting
// they had. Refuse and name the file instead.
function readSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return {}; }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  throw new UserError(
    `${file} is not valid JSON. Fix or remove it, then run this again — refusing to overwrite settings that cannot be read.`,
  );
}

// Atomic: this file holds every project setting the user has, and is usually committed to their
// repository. A truncated one loses all of it and then trips readSettings' refusal for good.
function writeSettings(file, settings) {
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function installProjectPlugin({
  dir = process.cwd(),
  file = null,
  gitUrl,
  gitRef = DEFAULT_GIT_REF,
  gitPath = DEFAULT_GIT_PATH,
} = {}) {
  if (!isSupportedGitUrl(gitUrl)) {
    throw new UserError(
      `Project scope needs the marketplace's repository URL, and Cursor accepts only https:// or git@ addresses: ${JSON.stringify(gitUrl == null ? '' : gitUrl)} is not one.`,
    );
  }
  const target = file == null ? projectSettingsFile(dir) : file;
  const settings = readSettings(target);
  const plugins = { ...(settings.plugins == null ? {} : settings.plugins) };
  const entry = { enabled: true, gitUrl: gitUrl.trim(), gitRef };
  if (gitPath) entry.gitPath = gitPath;
  plugins[PROJECT_PLUGIN_KEY] = entry;
  writeSettings(target, { ...settings, plugins });
  return { file: target, key: PROJECT_PLUGIN_KEY, entry };
}

export function uninstallProjectPlugin({ dir = process.cwd(), file = null } = {}) {
  const target = file == null ? projectSettingsFile(dir) : file;
  if (!fs.existsSync(target)) return { file: target, removed: false };
  const settings = readSettings(target);
  const plugins = { ...(settings.plugins == null ? {} : settings.plugins) };
  if (!(PROJECT_PLUGIN_KEY in plugins)) return { file: target, removed: false };
  delete plugins[PROJECT_PLUGIN_KEY];

  const next = { ...settings };
  if (Object.keys(plugins).length === 0) delete next.plugins;
  else next.plugins = plugins;

  // If our entry was the only thing the file held, remove the file too: an empty `{}` left in a
  // repository reads as a deliberate, empty project configuration to everyone who opens it.
  if (Object.keys(next).length === 0) {
    try { removeSync(target); } catch { /* already gone */ }
    return { file: target, removed: true };
  }
  writeSettings(target, next);
  return { file: target, removed: true };
}

// Never throws: this is called from a status report, and a settings file the user broke by hand is
// a thing to say out loud, not a reason for the whole report to fail.
export function projectPluginStatus({ dir = process.cwd(), file = null } = {}) {
  const target = file == null ? projectSettingsFile(dir) : file;
  let settings;
  try {
    settings = readSettings(target);
  } catch {
    return { file: target, installed: false, entry: null, unreadable: true };
  }
  const plugins = settings.plugins;
  const found = plugins == null ? undefined : plugins[PROJECT_PLUGIN_KEY];
  const entry = found == null ? null : found;
  return { file: target, installed: entry != null && entry.enabled === true, entry };
}
