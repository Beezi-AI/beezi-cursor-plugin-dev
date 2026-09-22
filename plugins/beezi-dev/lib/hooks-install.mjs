import fs from 'fs';
import path from 'path';
import url from 'url';
import { cursorHooksFile, cursorPluginDir, hookLauncherDir } from './paths-cursor.mjs';
import { readJson, writeFileAtomic } from './fs-store.mjs';
import { UserError } from './friendly-error.mjs';
import { removeSync } from './fs-compat.mjs';
import { HOOK_TIMEOUTS } from './hook-runner.mjs';
import { variantMarker } from './env-identity.mjs';

// Beezi's Cursor hook installer — the repair path, not the primary one.
//
// The plugin ships `hooks/hooks.json` at its own root, which Cursor's plugin spec discovers
// automatically (`hooks` in the manifest, default `hooks/hooks.json`, commands resolved relative to
// the plugin root). A marketplace install therefore needs no install step at all. What this module
// covers is every case where that registry does not fire:
//
//   user    <cursorConfigDir>/hooks.json                             (self-installed fallback)
//   plugin  <cursorConfigDir>/plugins/local/beezi/hooks/hooks.json   (legacy local materialization)
//
// Both scopes are merge-preserving. `lib/plugin-install.mjs` picks between "leave it to the bundled
// registry" and "write the user scope" from what the hook scripts actually recorded — see
// lib/hook-source.mjs.

export const HookScope = Object.freeze({
  PLUGIN: 'plugin',
  USER: 'user',
});

// Shown next to each entry in Cursor's hook listing. Also one of the two ways we recognise our own
// handlers — see isBeeziHandler, which does not rely on it alone precisely because the file is the
// user's to open and edit.
export const BEEZI_STATUS_MESSAGE = 'Beezi analytics';

// The one instruction every caller has to pass on. Cursor loads its hook registry at startup, so a
// fresh install does nothing until the window (or the `cursor-agent` process) is restarted.
export const RELOAD_STEP = 'restart Cursor — hooks are read when the app starts';

// The events Beezi registers.
//
// `sessionEnd` IS registered here, unlike the Codex plugin: Cursor genuinely implements it, while
// Codex declares it and silently drops the entry. `postToolUseFailure` revives the failure-reporting
// hook the Codex fork had to delete for the same reason.
//
// The last four are capture-only for now — their scripts dump the payload Cursor hands them and
// exit, and nothing reads the result yet (see lib/hook-dump.mjs). They are registered ahead of the
// features that need them because the registry is what has to be exercised: a capture session
// proves the whole listing at once, and splitting it across two sessions on a machine that has
// Cursor installed doubles the only expensive part.
//
// `afterMCPExecution` is deliberately absent. `postToolUse` already fires for MCP tools, so a
// handler on the completion side would count every MCP call twice.
//
// Two of the ten — `beforeMCPExecution` and `subagentStart` — are PERMISSION hooks: Cursor reads
// their stdout and obeys it, and exit code 2 blocks the user's action outright. Their scripts write
// nothing to stdout on any path and always exit 0. Do not add an entry here without checking which
// kind it is.
//
// Adding an event is also the one edit here that can cost the OTHER nine. An event Cursor does not
// fire is harmless — the entry simply never runs, which is the expected state of the last three
// under `cursor-agent`, where staff have confirmed only sessionStart, sessionEnd, stop, postToolUse,
// beforeShellExecution, afterShellExecution and afterFileEdit. An event name Cursor does not
// RECOGNISE is a different matter: if its loader answers an unknown key by discarding the registry
// rather than the entry, every hook in this list goes silent together. So the first thing to check
// after changing this array is that Cursor's own hook listing still shows all of them.
// TODO(P0): unverified — see lib/hook-dump.mjs
export const BEEZI_HOOKS = Object.freeze([
  { event: 'sessionStart', script: 'session-start.mjs' },
  { event: 'afterShellExecution', script: 'checkpoint.mjs' },
  { event: 'postToolUse', script: 'tool-event.mjs' },
  { event: 'stop', script: 'stop.mjs' },
  { event: 'sessionEnd', script: 'report.mjs' },
  { event: 'postToolUseFailure', script: 'stop-failure.mjs' },
  { event: 'afterFileEdit', script: 'file-edit.mjs' },
  { event: 'beforeMCPExecution', script: 'mcp-before.mjs', permission: true },
  { event: 'subagentStart', script: 'subagent-start.mjs', permission: true },
  { event: 'subagentStop', script: 'subagent-stop.mjs' },
]);

const BEEZI_EVENTS = BEEZI_HOOKS.map((h) => h.event);

// The two events whose stdout Cursor reads and OBEYS, derived from the table above rather than
// listed a second time — a permission event named in one place and not the other is an event that
// gets the analytics deadline and the analytics failure path by accident.
export const PERMISSION_EVENTS = Object.freeze(
  BEEZI_HOOKS.filter((h) => h.permission === true).map((h) => h.event),
);

export function isPermissionEvent(event) {
  return PERMISSION_EVENTS.indexOf(event) !== -1;
}

// Cursor's hooks.json carries a schema version at the top level.
// TODO(P0): unverified — see lib/hook-dump.mjs
const REGISTRY_VERSION = 1;

// Our ceiling for a hook run, in SECONDS, and Cursor's `timeout` field is in seconds too — this is
// declared to the host, not merely believed by us. It is also the number the checkpoint's own budget
// is derived from, kept in one place so the two cannot drift apart.
//
// This comment used to say Cursor's registry had no per-hook `timeout` field (unlike Codex's), and
// that belief cost something real: `buildHookEntries` emitted no timeout at all, so every hook
// installed into the USER scope — which is the only registry `cursor-agent` reads (Cursor staff,
// forum 163890) — ran against Cursor's undocumented default instead of the 10s the budget assumes.
// The bundled hooks/hooks.json had carried `timeout: 10` on every entry the whole time, so the two
// registries silently disagreed about the deadline the same script was written to.
//
// The number itself now comes from HOOK_TIMEOUTS in lib/hook-runner.mjs, which is the one table both
// registries and the runner's own budget read. Declared in milliseconds there because that is the
// unit every budget in this plugin is in; converted here because Cursor's registry field is seconds.
export const HOOK_TIMEOUT_SEC = HOOK_TIMEOUTS.analytics / 1000;

// A permission hook's deadline, and the reason it is a different number.
//
// `beforeMCPExecution` and `subagentStart` run IN FRONT of the user's action: the host holds the MCP
// call or the subagent launch until the hook answers. Ten seconds of a wedged filesystem there is
// ten seconds of an editor that has not moved, on a hook whose entire contribution is one sidecar
// line. The analytics hooks run behind the work and keep the 10s lib/checkpoint.mjs derives
// HOOK_BUDGET_MS from — shortening those would truncate the queue flush for no benefit to anyone.
export const PERMISSION_HOOK_TIMEOUT_SEC = HOOK_TIMEOUTS.permission / 1000;

// The deadline this event's handler is registered with, in seconds, for BOTH registries. One lookup
// so the bundled hooks/hooks.json and the user-scope registry cannot declare different budgets for
// the same script — see the parity test in test/hooks-install.test.mjs.
export function hookTimeoutSec(event) {
  return isPermissionEvent(event) ? PERMISSION_HOOK_TIMEOUT_SEC : HOOK_TIMEOUT_SEC;
}

// This module sits in <pluginRoot>/lib, so its own location is the single source of truth for where
// the plugin lives — no caller has to rediscover the layout.
export const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const DEFAULT_SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');

// The exact command that installs the hooks, absolute and copy-pasteable. Every message that asks
// the user to install has to quote this one: their cwd is the repository they are working in, not
// the plugin root, so a relative `scripts/install.mjs` resolves to nothing.
export function installCommand(scriptsDir = DEFAULT_SCRIPTS_DIR) {
  return `node "${path.join(scriptsDir, 'install.mjs')}" install`;
}

// A launcher is a single-token executable, so the `command` field never depends on how Cursor
// splits arguments or on `node` being resolvable from the hook's PATH.
//
// This is a property of the USER scope, and it is not a workaround for a missing variable. Cursor
// does have a plugin-root substitution — `${CURSOR_PLUGIN_ROOT}`, staff-confirmed, expanded in a
// hook's `command` and in an MCP server's `args`/`cwd` — and the bundled hooks/hooks.json relies on
// it for all ten entries. What it is NOT expanded in is `~/.cursor/hooks.json`, which belongs to the
// user rather than to any plugin and so has no plugin root to resolve against. The absolute path has
// to be baked in there by the installer, and baking it into a one-token launcher is what keeps the
// entry free of argument-splitting and PATH-resolution rules — and what lets a Node upgrade be
// detected as a stale launcher (see hooksStatus) instead of failing every hook at spawn.
//
// WHOSE launcher, as well as what kind. The name carries the ENVIRONMENT VARIANT this install
// belongs to — CONTRACTS §1's `variantMarker(env)`, which is `beezi` for production and
// `beezi-dev` / `beezi-staging` / `beezi-local` for the others. Production keeps the unsuffixed
// spelling on purpose, so an upgrade from before variants existed rewrites nothing and every
// comparison in this module still recognises the entries already on disk.
export const VARIANT_MARKER_DEFAULT = 'beezi';

// Every marker that is NOT production, as the token that follows the shared `beezi-` head.
//
// This list is what stops one variant claiming another's handlers. Production's marker is a literal
// PREFIX of every other variant's, so `beezi-dev-stop.cmd` starts with `beezi-` as surely as
// `beezi-stop.cmd` does — and a prod uninstall that matched on the prefix alone would delete the dev
// install's launchers and strip its registry entries. The rule is therefore "starts with my marker,
// and what follows is not another variant's token". It costs one thing: a hook script could never be
// named `dev-*.mjs`, because `beezi-dev-*.cmd` would then be unclaimable by prod. None is, and the
// names are ours to choose.
const VARIANT_TOKENS = Object.freeze(['dev', 'staging', 'local']);

// The marker every default argument in this module falls back to.
//
// A FUNCTION, not a captured constant, so a test — and a hook spawned into a different environment —
// reads the variant at the moment of use rather than at import. It resolves through
// `lib/env-identity.mjs`'s `variantMarker(env)` (CONTRACTS §1): `beezi` for production, which is
// exactly `VARIANT_MARKER_DEFAULT`, so an install predating variants rewrites nothing; and
// `beezi-dev` / `beezi-staging` / `beezi-local` otherwise, so one variant's uninstall cannot strip
// another's handlers.
export function defaultVariantMarker() {
  return variantMarker(process.env);
}

export function launcherName(script, platform = process.platform, variantMarker = defaultVariantMarker()) {
  const stem = `${variantMarker}-${path.basename(script, '.mjs')}`;
  return platform === 'win32' ? `${stem}.cmd` : `${stem}.sh`;
}

function launcherPath(script, launcherDir, platform, variantMarker) {
  return path.join(launcherDir, launcherName(script, platform, variantMarker));
}

// Is this launcher filename one THIS variant would have written? See VARIANT_TOKENS.
function ownsLauncherName(basename, variantMarker) {
  const prefix = `${variantMarker}-`;
  if (basename.indexOf(prefix) !== 0) return false;
  const rest = basename.slice(prefix.length);
  return !VARIANT_TOKENS.some((token) => rest.indexOf(`${token}-`) === 0);
}

// A registry `command` is a command STRING, not a path field. Cursor's own bundled hooks.json puts
// `node --no-warnings "${CURSOR_PLUGIN_ROOT}/scripts/stop.mjs" --via plugin-hooks` in it, so whatever
// reads that field splits on whitespace and honours quotes. Which makes "a launcher is one token"
// true only while the launcher's own path holds no whitespace — and the launcher lives under the
// user's home, which on Windows is routinely `C:\Users\First Last`. Unquoted, such an entry asks the
// host to run `C:\Users\First` with `Last\.beezi-cursor\hooks\beezi-stop.cmd` as an argument, and
// every hook on the machine fails at spawn while the registry still lists all ten and looks perfect.
//
// Quote only when there is whitespace to protect. A space-free path then stays byte-identical to what
// every existing install already has on disk, so an upgrade rewrites nothing and no comparison
// anywhere has to change its mind about an entry it has seen before.
//
// The one host this does not help is PowerShell, where a wholly quoted string with no arguments is
// data rather than a command (`& ` would be needed). That spelling can only ever appear on a path
// that is ALREADY broken unquoted, so quoting cannot regress an install that works today — and
// `& "…"` is not written here because it is correct in PowerShell and wrong in cmd.exe and sh, and
// nothing on the authoring machine can say which one Cursor uses.
// TODO(P0): unverified — see lib/hook-dump.mjs
function quoteCommand(launcher) {
  return /\s/.test(launcher) ? `"${launcher}"` : launcher;
}

// The inverse, for reading back a registry we did not necessarily write in this version. Every
// install made before the quoting rule existed carries the bare path, and those entries have to stay
// recognisable as ours: an unrecognised one is not stripped before the current entries are appended,
// so re-install grows a second handler beside the old one, uninstall leaves firing hooks behind, and
// `hooksStatus` reports `partial` on a machine that is merely out of date.
function commandTarget(command) {
  const trimmed = command.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

// Node's own warnings go to stderr, and Cursor puts a hook's stderr in its execution log where it
// reads as a failure. `node:sqlite` is experimental, so merely touching it prints
// "ExperimentalWarning: SQLite is an experimental feature" on every single hook — a plugin that
// works perfectly looks like one that is erroring several times a minute. The flag suppresses only
// Node's own warnings; anything the plugin deliberately writes to stderr (a schema mismatch, an
// install failure) still gets through.
export const NODE_FLAGS = Object.freeze(['--no-warnings']);

export function launcherBody(scriptPath, { nodePath, platform = process.platform }) {
  const flags = NODE_FLAGS.join(' ');
  if (platform === 'win32') {
    // CRLF: cmd.exe mis-parses a batch file with bare LF line endings on some shells.
    return ['@echo off', `"${nodePath}" ${flags} "${scriptPath}" %*`, ''].join('\r\n');
  }
  return ['#!/bin/sh', `exec "${nodePath}" ${flags} "${scriptPath}" "$@"`, ''].join('\n');
}

// The `{ hooks: { <event>: [ { command, statusMessage, timeout } ] } }` fragment for Beezi's events.
// Cursor's registry lists handlers directly under the event — there is no Claude/Codex-style
// `{ matcher, hooks: [...] }` grouping, and no matcher at all.
//
// `timeout` is declared here for the same reason the bundled registry declares it: it is a real,
// documented, per-handler field measured in seconds, and leaving it out does not mean "no limit" —
// it means Cursor's undocumented default, which is not the number scripts/checkpoint.mjs and
// lib/checkpoint.mjs budget against. See HOOK_TIMEOUT_SEC.
// TODO(P0): unverified — see lib/hook-dump.mjs
export function buildHookEntries({ launcherDir, platform = process.platform, variantMarker = defaultVariantMarker() }) {
  const out = {};
  for (const { event, script } of BEEZI_HOOKS) {
    out[event] = [{
      // Quoted only when the path carries whitespace — see quoteCommand.
      command: quoteCommand(launcherPath(script, launcherDir, platform, variantMarker)),
      statusMessage: BEEZI_STATUS_MESSAGE,
      timeout: hookTimeoutSec(event),
    }];
  }
  return out;
}

// Ours if — and ONLY if — it runs a launcher this variant would have written, out of this variant's
// launcher directory.
//
// THE LABEL IS NOT A TEST. `statusMessage: 'Beezi analytics'` used to be sufficient on its own, and
// that was a way to delete a stranger's hook: the string is generic, the file is the user's to open
// and edit, and any other tool — or the user's own note on a handler of their own — could carry it.
// A generic label can confirm an entry we already recognise; it can never be the reason an entry is
// removed. So ownership rests on two facts that are ours by construction:
//
//   the DIRECTORY   a user's ~/bin/beezi-notify.sh is not ours to touch, and uninstall promises to
//                   leave their hooks alone;
//   the NAME        `<variantMarker>-<script>` — see ownsLauncherName for why a prefix test alone
//                   would make a production uninstall strip the dev install's entries.
//
// Neither carries a plugin version, so both survive upgrades, which is what keeps re-install
// idempotent and uninstall complete.
function isBeeziHandler(handler, launcherDir = hookLauncherDir(), variantMarker = defaultVariantMarker()) {
  if (handler == null) return false;
  const command = handler.command == null ? handler.commandWindows : handler.command;
  if (typeof command !== 'string') return false;
  // Both spellings of our own entry — quoted and bare — name the same launcher, and this is the ONLY
  // place in the module that reads a registry command, so unwrapping here is what makes every
  // consumer (ownership, merge, uninstall, status) tolerate a registry written by an older install.
  const target = commandTarget(command);
  if (path.resolve(path.dirname(target)) !== path.resolve(launcherDir)) return false;
  return ownsLauncherName(path.basename(target), variantMarker);
}

// Does this event already carry the exact entry the current version would write for it? Exact, not
// equivalent: the point is to detect an entry this version has stopped producing, and any looser
// comparison would call the old one current and skip the repair — see hooksStatus.
//
// BOTH FIELDS, and the second one is not decoration. `timeout` is what the host actually kills the
// hook at, and when `beforeMCPExecution` and `subagentStart` dropped from 10s to 5s, every machine
// with an existing user-scope install kept its old `timeout: 10` — the command string had not
// changed, so the entry read as current, `hooksStatus` said `installed`, and `ensureInstalled` never
// rewrote it. The bundled registry would have said 5 and the user-scope registry 10 for the same two
// scripts, for the lifetime of the install, with nothing anywhere reporting a problem. A deadline
// that is declared in one registry and not the other is the exact drift this module's one-lookup
// design exists to prevent, so it has to be part of what "current" means.
//
// It cannot flap: both values compared here are built by the same expressions buildHookEntries uses,
// so the install this triggers makes the next call agree.
function hasCurrentEntry(registry, event, launcher) {
  const registryHooks = registry == null ? undefined : registry.hooks;
  const handlers = registryHooks == null ? undefined : registryHooks[event];
  if (!Array.isArray(handlers)) return false;
  const command = quoteCommand(launcher);
  const timeout = hookTimeoutSec(event);
  return handlers.some((h) => {
    if (h == null) return false;
    return (h.command == null ? h.commandWindows : h.command) === command && h.timeout === timeout;
  });
}

// The events a registry currently carries Beezi handlers for.
function beeziEvents(registry, launcherDir, variantMarker) {
  const out = [];
  const hooks = registry == null || registry.hooks == null ? {} : registry.hooks;
  for (const [event, handlers] of Object.entries(hooks)) {
    if (!Array.isArray(handlers)) continue;
    if (handlers.some((h) => isBeeziHandler(h, launcherDir, variantMarker))) out.push(event);
  }
  return out;
}

// Drop Beezi's handlers from a registry, leaving every other hook — and any unknown top-level key
// — untouched. An event left with no handlers is removed.
export function removeBeeziHooks(existing, launcherDir = hookLauncherDir(), variantMarker = defaultVariantMarker()) {
  const source = existing == null ? undefined : existing.hooks;
  if (!source || typeof source !== 'object') return existing == null ? {} : existing;
  const hooks = {};
  for (const [event, handlers] of Object.entries(source)) {
    // A malformed event value has no handlers to filter — pass it through rather than reshape it.
    if (!Array.isArray(handlers)) { hooks[event] = handlers; continue; }
    const kept = handlers.filter((h) => !isBeeziHandler(h, launcherDir, variantMarker));
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

// Re-install is idempotent: strip our previous entries first, then append the current ones. The
// user's own hooks keep their position and content.
export function mergeHooks(existing, beeziHooks, launcherDir = hookLauncherDir(), variantMarker = defaultVariantMarker()) {
  const base = removeBeeziHooks(existing, launcherDir, variantMarker);
  const hooks = { ...(base.hooks == null ? {} : base.hooks) };
  for (const [event, handlers] of Object.entries(beeziHooks)) {
    const prior = hooks[event] == null ? [] : hooks[event];
    hooks[event] = [...prior, ...handlers];
  }
  return { version: base.version == null ? REGISTRY_VERSION : base.version, ...base, hooks };
}

// A registry we cannot parse must never be treated as an empty one. The file is the user's — they
// are invited to open and review it — so a stray trailing comma is a realistic state, and merging
// onto `{}` would rewrite the file with Beezi's ten events and nothing else, deleting every hook
// they had configured. Refuse instead, and say which file to fix.
function readRegistry(hooksFile) {
  let raw;
  try { raw = fs.readFileSync(hooksFile, 'utf-8'); } catch { return {}; }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to the error below */ }
  throw new UserError(
    `${hooksFile} is not valid JSON. Fix or remove it, then run the install again — refusing to overwrite hooks that cannot be read.`,
  );
}

// Not writeJsonSecure: this file is Cursor's, holds no secret, and must stay readable and
// hand-editable — the user is expected to be able to review it. Atomic all the same: it holds the
// user's own hooks, and a truncated one both stops those hooks loading and trips readRegistry's
// refusal, which turns a transient write failure into permanent, unrepairable loss.
function writeRegistry(hooksFile, registry) {
  writeFileAtomic(hooksFile, `${JSON.stringify(registry, null, 2)}\n`);
}

// Where a scope's registry lives. Exported because every CLI message has to name the exact file it
// wrote, and because the two scopes are otherwise indistinguishable in a status report.
//
// The default is USER everywhere in this module, and deliberately so. `plugin` scope resolves its
// scripts under ~/.cursor/plugins/local/beezi — a directory a marketplace install never creates —
// so a caller that omitted the argument compared every launcher against a path that does not
// exist and got `stale` back for a perfectly good install. Two callers omitted it, which is how
// `me` and the sign-in summary came to report broken hooks while Cursor's own settings pane listed
// every one of them as installed and its execution log showed them running.
export function hooksFileFor(scope = HookScope.USER) {
  if (scope === HookScope.USER) return cursorHooksFile();
  if (scope === HookScope.PLUGIN) return path.join(cursorPluginDir(), 'hooks', 'hooks.json');
  throw new UserError(`Unknown hook scope '${scope}'. Use 'plugin' or 'user'.`);
}

// Files that must never travel into the installed copy: build inputs, VCS metadata and the test
// suite are not part of what a hook runs, and copying node_modules would defeat the whole
// zero-runtime-dependency property by making the installed size unbounded.
const SKIP_ENTRIES = new Set(['node_modules', '.git', 'test', '.DS_Store']);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// Materialize the plugin at ~/.cursor/plugins/local/beezi, so the launchers point at a stable
// location rather than at whatever directory the user happened to clone into. Returns the installed
// root. A no-op when the running copy already IS the installed one — re-running the installer from
// inside the destination must not copy a directory onto itself.
export function materializePlugin({ sourceRoot = PLUGIN_ROOT, targetRoot = cursorPluginDir() } = {}) {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) return { root: targetRoot, copied: false };
  copyTree(sourceRoot, targetRoot);
  return { root: targetRoot, copied: true };
}

export function installHooks({
  scope = HookScope.USER,
  materialize = false,
  sourceRoot = PLUGIN_ROOT,
  targetRoot = null,
  scriptsDir = null,
  nodePath = process.execPath,
  platform = process.platform,
  hooksFile = null,
  launcherDir = hookLauncherDir(),
  variantMarker = defaultVariantMarker(),
} = {}) {
  const resolvedTarget = targetRoot == null ? cursorPluginDir() : targetRoot;
  const installed = materialize
    ? materializePlugin({ sourceRoot, targetRoot: resolvedTarget })
    : { root: sourceRoot, copied: false };
  // The launchers must point at the materialized copy, not at the checkout the installer ran from:
  // the checkout can be moved or deleted, and every hook would then fail at spawn with the registry
  // still looking perfect.
  const resolvedScriptsDir = scriptsDir == null ? path.join(installed.root, 'scripts') : scriptsDir;
  // Lazy on purpose: hooksFileFor throws on an unknown scope, so an explicit hooksFile must still
  // win without the fallback ever being evaluated.
  const resolvedHooksFile = hooksFile == null ? hooksFileFor(scope) : hooksFile;

  fs.mkdirSync(launcherDir, { recursive: true });

  const launchers = [];
  for (const { script } of BEEZI_HOOKS) {
    const launcher = launcherPath(script, launcherDir, platform, variantMarker);
    fs.writeFileSync(launcher, launcherBody(path.join(resolvedScriptsDir, script), { nodePath, platform }), 'utf-8');
    if (platform !== 'win32') {
      try { fs.chmodSync(launcher, 0o755); } catch { /* best effort */ }
    }
    launchers.push(launcher);
  }

  writeRegistry(
    resolvedHooksFile,
    mergeHooks(
      readRegistry(resolvedHooksFile),
      buildHookEntries({ launcherDir, platform, variantMarker }),
      launcherDir,
      variantMarker,
    ),
  );

  return {
    scope,
    hooksFile: resolvedHooksFile,
    pluginRoot: installed.root,
    materialized: installed.copied,
    launchers,
    events: BEEZI_EVENTS,
  };
}

export function uninstallHooks({
  scope = HookScope.USER,
  platform = process.platform,
  hooksFile = null,
  launcherDir = hookLauncherDir(),
  variantMarker = defaultVariantMarker(),
} = {}) {
  const resolvedHooksFile = hooksFile == null ? hooksFileFor(scope) : hooksFile;
  const existing = readJson(resolvedHooksFile, null);
  const removed = beeziEvents(existing, launcherDir, variantMarker).length > 0;
  if (existing) {
    const stripped = removeBeeziHooks(existing, launcherDir, variantMarker);
    // If Beezi's entries were the only reason this registry existed, take the file with them —
    // leaving an empty `{"hooks":{}}` behind would misreport as "the user configured hooks".
    // `version` is ours too when we wrote the file, so it does not count as user content.
    const empty = Object.keys(stripped.hooks == null ? {} : stripped.hooks).length === 0
      && Object.keys(stripped).every((k) => k === 'hooks' || k === 'version');
    if (empty) {
      try { removeSync(resolvedHooksFile); } catch { /* already gone */ }
    } else {
      writeRegistry(resolvedHooksFile, stripped);
    }
  }
  for (const { script } of BEEZI_HOOKS) {
    try { removeSync(launcherPath(script, launcherDir, platform, variantMarker)); } catch { /* already gone */ }
  }
  return { scope, hooksFile: resolvedHooksFile, removed };
}

// The interpreter path baked into a launcher, if it still resolves.
function nodePathIn(body) {
  const match = /"([^"]+)"/.exec(body);
  if (!match) return false;
  try { return fs.existsSync(match[1]); } catch { return false; }
}

// Is the current install complete and pointing at scripts that still exist? A plugin upgrade moves
// the versioned directory out from under the launchers, so a stale install is the expected failure
// and is named as such rather than reported as "not installed". `state` is the classifier callers
// should branch on — deriving it from the raw lists twice, differently, is how the setup and repair
// messages drift apart.
export function hooksStatus({
  scope = HookScope.USER,
  scriptsDir = null,
  platform = process.platform,
  hooksFile = null,
  launcherDir = hookLauncherDir(),
  variantMarker = defaultVariantMarker(),
} = {}) {
  // Each scope's launchers point somewhere different, so "are these launchers current?" is a
  // different question per scope: the legacy plugin scope runs the materialized copy, while the
  // user scope runs whichever copy installed it — which, for a marketplace install, is this one.
  const resolvedScriptsDir = scriptsDir == null
    ? path.join(scope === HookScope.PLUGIN ? cursorPluginDir() : PLUGIN_ROOT, 'scripts')
    : scriptsDir;
  const resolvedHooksFile = hooksFile == null ? hooksFileFor(scope) : hooksFile;
  const registry = readJson(resolvedHooksFile, null);
  const registered = beeziEvents(registry, launcherDir, variantMarker);

  const missingLaunchers = [];
  const staleLaunchers = [];
  const outdatedEntries = [];
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = launcherPath(script, launcherDir, platform, variantMarker);
    // An entry can be ours, present, and still not what this version writes. The command spelling is
    // part of what an install PRODUCES — a launcher path under a home directory with a space in it
    // gained its quotes in a later version — and recognising the old spelling (which isBeeziHandler
    // does) is only half a repair: `ensureInstalled` rewrites the registry solely when the state is
    // not `installed`, so an entry that is ours, complete and broken would be re-examined and left
    // alone at every session start, forever, and only a hand-run `install` would ever fix it.
    // Comparing against what this version would write is what turns recognition into repair.
    //
    // A space-free path and an unchanged deadline produce a byte-identical entry, so no machine that
    // is not actually affected sees any of this.
    if (registered.includes(event) && !hasCurrentEntry(registry, event, launcher)) outdatedEntries.push(event);
    let body;
    // Read rather than stat: a launcher left by an older plugin version exists but points at a
    // scripts directory that no longer does, and only its contents distinguish the two.
    try { body = fs.readFileSync(launcher, 'utf-8'); } catch { missingLaunchers.push(launcher); continue; }
    // Both halves of the launcher have to still exist. A Node upgrade removes the interpreter
    // directory the launcher was written with, and every hook then fails at spawn while the
    // registry still looks perfect — reporting "installed" would send the user chasing Cursor.
    if (!body.includes(path.join(resolvedScriptsDir, script)) || !nodePathIn(body)) staleLaunchers.push(launcher);
  }

  const complete =
    BEEZI_EVENTS.every((e) => registered.includes(e))
    && !missingLaunchers.length && !staleLaunchers.length && !outdatedEntries.length;
  let state;
  if (complete) state = 'installed';
  // An out-of-date command is the registry's half of exactly what `stale` already means for a
  // launcher — ours, listed, and pointing at something an older version wrote — and both status
  // surfaces already word that state as "points at an older plugin version".
  else if (staleLaunchers.length || outdatedEntries.length) state = 'stale';
  else if (!registered.length && missingLaunchers.length === BEEZI_HOOKS.length) state = 'absent';
  else state = 'partial';

  return {
    scope, hooksFile: resolvedHooksFile, state, complete, registered,
    missingLaunchers, staleLaunchers, outdatedEntries,
  };
}
