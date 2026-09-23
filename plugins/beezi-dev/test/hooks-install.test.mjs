import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  HOOK_TIMEOUT_SEC,
  PERMISSION_EVENTS,
  PERMISSION_HOOK_TIMEOUT_SEC,
  HookScope,
  hookTimeoutSec,
  buildHookEntries,
  hooksFileFor,
  hooksStatus,
  installHooks,
  launcherBody,
  launcherName,
  stableNodePath,
  materializePlugin,
  mergeHooks,
  PLUGIN_ROOT,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';
import { PERMISSION_FAILURE_OUTPUT } from '../lib/hook-runner.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hooks-'));
}

test('the default scope is the one a marketplace install actually uses', () => {
  // The legacy `plugin` scope resolves its scripts under ~/.cursor/plugins/local/beezi, which a
  // marketplace install never creates — so defaulting to it made every launcher look like it
  // pointed at a directory that no longer exists, and every status surface that omitted the
  // argument reported a correct install as `stale`. link-status.mjs and login.mjs both omitted it.
  assert.equal(hooksFileFor(), hooksFileFor(HookScope.USER));
  assert.notEqual(hooksFileFor(HookScope.PLUGIN), hooksFileFor(HookScope.USER));
  assert.equal(hooksStatus({ hooksFile: path.join(tmpdir(), 'hooks.json'), launcherDir: tmpdir() }).scope, HookScope.USER);
});

// Every install in this file is non-materializing and fully pathed: the real installer copies into
// ~/.cursor, and a test suite must never write there.
function install(opts) {
  return installHooks({ materialize: false, nodePath: process.execPath, platform: 'linux', ...opts });
}

const EVENTS = [
  'afterFileEdit',
  'afterShellExecution',
  'beforeMCPExecution',
  'postToolUse',
  'postToolUseFailure',
  'sessionEnd',
  'sessionStart',
  'stop',
  'subagentStart',
  'subagentStop',
];

test('all ten Cursor lifecycle events are registered', () => {
  // sessionEnd IS registered, unlike the Codex fork — Cursor implements it while Codex silently
  // drops the entry. postToolUseFailure revives the failure hook Codex had no event for.
  //
  // The last four are capture-only: their scripts dump the payload and exit, and nothing reads the
  // result yet. They are registered ahead of the features that need them because a capture session
  // proves the registry as a whole, and the machine that has Cursor installed is the expensive part.
  assert.deepEqual(BEEZI_HOOKS.map((h) => h.event).sort(), EVENTS);
});

test('afterMCPExecution is deliberately not registered', () => {
  // postToolUse already fires for MCP tools, so a handler on the completion side would count every
  // MCP call twice — once as a tool use and once as an MCP execution.
  assert.equal(BEEZI_HOOKS.some((h) => h.event === 'afterMCPExecution'), false);
});

test('postToolUse routes to the tiny sidecar writer, not the reporting engine', () => {
  // tool-event.mjs fires on every tool call. Pointing it at checkpoint.mjs would put ~25 modules,
  // git shell-outs and a queue flush on that path.
  const byEvent = Object.fromEntries(BEEZI_HOOKS.map((h) => [h.event, h.script]));
  assert.equal(byEvent.postToolUse, 'tool-event.mjs');
  assert.equal(byEvent.afterShellExecution, 'checkpoint.mjs');
  assert.equal(byEvent.sessionEnd, 'report.mjs');
  assert.equal(byEvent.postToolUseFailure, 'stop-failure.mjs');
  assert.equal(byEvent.afterFileEdit, 'file-edit.mjs');
  assert.equal(byEvent.beforeMCPExecution, 'mcp-before.mjs');
  assert.equal(byEvent.subagentStart, 'subagent-start.mjs');
  assert.equal(byEvent.subagentStop, 'subagent-stop.mjs');
});

test('launcherName picks the right extension per platform', () => {
  assert.equal(launcherName('checkpoint.mjs', 'win32'), 'beezi-checkpoint.cmd');
  assert.equal(launcherName('checkpoint.mjs', 'linux'), 'beezi-checkpoint.sh');
});

test('launcherBody quotes both paths and uses CRLF on Windows', () => {
  const win = launcherBody('C:\\p l\\stop.mjs', { nodePath: 'C:\\n o\\node.exe', platform: 'win32' });
  assert.ok(win.includes('"C:\\n o\\node.exe" --no-warnings "C:\\p l\\stop.mjs"'));
  assert.ok(win.startsWith('@echo off\r\n'));

  const posix = launcherBody('/p l/stop.mjs', { nodePath: '/n o/node', platform: 'linux' });
  assert.ok(posix.startsWith('#!/bin/sh\n'));
  assert.ok(posix.includes('exec "/n o/node" --no-warnings "/p l/stop.mjs" "$@"'));
});

test('every launcher silences Node’s own warnings', () => {
  // node:sqlite is experimental, so touching it prints "ExperimentalWarning: SQLite is an
  // experimental feature" to stderr — on every hook. Cursor shows a hook's stderr in its execution
  // log, so a plugin that is working perfectly reads as one erroring several times a minute. The
  // flag hides Node's warnings only; the plugin's own stderr diagnostics still get through.
  for (const platform of ['win32', 'linux']) {
    assert.ok(
      launcherBody('/p/stop.mjs', { nodePath: '/node', platform }).includes('--no-warnings'),
      `${platform} launcher does not suppress Node warnings`,
    );
  }
});

test('buildHookEntries lists handlers directly under the event, with no matcher', () => {
  // Cursor's registry shape, not Claude/Codex's { matcher, hooks: [...] } grouping.
  //
  // The directory is a space-free literal rather than os.tmpdir() on purpose: the command is quoted
  // when the launcher path carries whitespace, and a machine whose TEMP sits under `C:\Users\First
  // Last` would otherwise make this assertion pass or fail on whose laptop it ran. The quoting rule
  // has its own tests below.
  const launcherDir = path.join(path.sep, 'beezi-launchers');
  const entries = buildHookEntries({ launcherDir, platform: 'linux' });
  assert.deepEqual(Object.keys(entries).sort(), EVENTS);
  for (const handlers of Object.values(entries)) {
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].statusMessage, BEEZI_STATUS_MESSAGE);
    assert.equal(path.dirname(handlers[0].command), launcherDir);
    assert.equal(handlers[0].matcher, undefined);
  }
});

test('the user scope declares the same timeout the bundled registry does', () => {
  // `timeout` is a real, documented, per-handler field measured in SECONDS. It used to be omitted
  // here on the belief that Cursor had no such field, so every hook installed into the user scope —
  // the only registry older `cursor-agent` builds read — ran against Cursor's undocumented default
  // while hooks/hooks.json declared 10s for the same script. lib/checkpoint.mjs budgets against the
  // 10.
  const entries = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  assert.equal(Object.keys(entries).length, BEEZI_HOOKS.length);
  for (const [event, handlers] of Object.entries(entries)) {
    assert.equal(handlers[0].timeout, hookTimeoutSec(event));
  }
});

test('a permission hook gets half the deadline an analytics hook does', () => {
  // A permission hook sits IN FRONT of the user's action — Cursor waits for it before dispatching
  // the MCP call or starting the subagent — so a stalled one costs the user the whole timeout in
  // dead time. The analytics hooks run behind the work and keep the 10s lib/checkpoint.mjs derives
  // HOOK_BUDGET_MS from.
  assert.equal(PERMISSION_HOOK_TIMEOUT_SEC, 5);
  assert.ok(PERMISSION_HOOK_TIMEOUT_SEC < HOOK_TIMEOUT_SEC);
  const entries = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  assert.deepEqual([...PERMISSION_EVENTS].sort(), ['beforeMCPExecution', 'subagentStart']);
  for (const event of PERMISSION_EVENTS) {
    assert.equal(entries[event][0].timeout, PERMISSION_HOOK_TIMEOUT_SEC, `${event} kept the analytics deadline`);
  }
  for (const { event } of BEEZI_HOOKS) {
    if (PERMISSION_EVENTS.includes(event)) continue;
    assert.equal(entries[event][0].timeout, HOOK_TIMEOUT_SEC, `${event} is not a permission hook`);
  }
});

test('BOTH registries declare the same per-event deadline', () => {
  // The parity assertion. The bundled hooks/hooks.json is the registry the IDE discovers and the
  // user-scope one is the only registry older `cursor-agent` builds read (Cursor staff, forum
  // 163890; CLI 2026.09.18 runs both) — the same script runs under both, so a deadline that lives
  // in one of them is a script written to two different budgets. This is the test that fails if a timeout is changed in one place only.
  const bundled = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'),
  );
  const entries = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(bundled.hooks[event][0].timeout, hookTimeoutSec(event), `${event} bundled deadline`);
    assert.equal(entries[event][0].timeout, hookTimeoutSec(event), `${event} user-scope deadline`);
  }
});

test('the command is a single-token launcher path, never a `node <script>` pair', () => {
  // Cursor DOES have a plugin-root substitution — ${CURSOR_PLUGIN_ROOT}, which hooks/hooks.json
  // uses — but it is not expanded in ~/.cursor/hooks.json, which belongs to the user and has no
  // plugin root to resolve against. So the user scope bakes in an absolute path, and a one-token
  // executable is what keeps the command free of argument-splitting and PATH resolution rules.
  const entries = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  for (const handlers of Object.values(entries)) {
    assert.ok(!handlers[0].command.includes(' '), handlers[0].command);
    // Nothing to protect, so nothing is added. Every install that exists today has the bare form on
    // disk, and an upgrade that rewrote it would produce a diff in the user's own file for no gain.
    assert.ok(!handlers[0].command.startsWith('"'), handlers[0].command);
  }
});

test('a launcher path containing whitespace is quoted, or it is not one token at all', () => {
  // `C:\Users\First Last` is an ordinary Windows home, and the launcher lives under it. Bare, that
  // command asks the host to run `C:\Users\First` with the rest as an argument — every hook on the
  // machine fails at spawn while the registry still lists all ten and reads as perfect.
  const launcherDir = 'C:\\Users\\First Last\\.beezi-cursor\\hooks';
  const entries = buildHookEntries({ launcherDir, platform: 'win32' });
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(entries[event][0].command, `"${path.join(launcherDir, launcherName(script, 'win32'))}"`);
  }
});

test('an entry written before the quoting rule is repaired, not duplicated and not left alone', () => {
  // Every registry installed before that rule carries the bare path, and on a home directory with a
  // space in it that entry is the broken one. Two things have to hold at once, and neither is worth
  // much without the other: the old entry is still recognised as OURS (or re-install appends a
  // second handler beside it and uninstall leaves firing hooks behind), and it is still reported as
  // out of date (or `ensureInstalled`, which rewrites only when the state is not `installed`, leaves
  // the broken spelling in place at every session start forever).
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'First Last', 'hooks');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  install({ scriptsDir, hooksFile, launcherDir });

  const aged = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const handlers of Object.values(aged.hooks)) {
    handlers[0].command = handlers[0].command.slice(1, -1);
    // Also reworded, so recognition can only come from the command — the label would otherwise
    // answer the question before the command is ever looked at.
    handlers[0].statusMessage = 'my analytics';
  }
  fs.writeFileSync(hooksFile, JSON.stringify(aged));

  const status = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'stale', 'a spelling this version no longer writes has to trigger the repair');
  assert.equal(status.complete, false);
  assert.deepEqual(status.outdatedEntries.sort(), EVENTS);
  // Recognised all the same — the launchers are fine, so this is a registry to rewrite, not a
  // machine that never installed.
  assert.deepEqual(status.registered.sort(), EVENTS);
  assert.deepEqual(status.missingLaunchers, []);
  assert.deepEqual(status.staleLaunchers, []);

  install({ scriptsDir, hooksFile, launcherDir });
  const merged = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(merged.hooks.stop.length, 1, 'the old entry was replaced, not left beside the new one');
  assert.equal(merged.hooks.stop[0].command, `"${path.join(launcherDir, 'beezi-stop.sh')}"`);

  // Reword the labels the re-install just restored, so the QUOTED form has to be recognised by the
  // command alone. Without that, this whole test passes on the statusMessage shortcut and proves
  // nothing about the quoted spelling — which is the one this version writes.
  for (const handlers of Object.values(merged.hooks)) handlers[0].statusMessage = 'my analytics';
  fs.writeFileSync(hooksFile, JSON.stringify(merged));
  // Converged: the repair is what the next status call expects to find, so a session start does not
  // rewrite the user's registry again, and again, on every launch.
  const after = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(after.state, 'installed');
  assert.deepEqual(after.outdatedEntries, []);

  assert.equal(uninstallHooks({ platform: 'linux', hooksFile, launcherDir }).removed, true);
  assert.ok(!fs.existsSync(hooksFile));
});

test('hooksFileFor separates the plugin scope from the user-scope fallback', () => {
  assert.notEqual(hooksFileFor(HookScope.PLUGIN), hooksFileFor(HookScope.USER));
  assert.ok(hooksFileFor(HookScope.PLUGIN).endsWith(path.join('hooks', 'hooks.json')));
  assert.ok(hooksFileFor(HookScope.USER).endsWith('hooks.json'));
  assert.throws(() => hooksFileFor('project'), /Unknown hook scope/);
});

// A handler this variant would have written, for the ownership tests below.
const ours = (script, dir = '/h', marker = undefined) => ({
  command: path.join(dir, launcherName(script, 'linux', marker)),
  statusMessage: BEEZI_STATUS_MESSAGE,
});

test('removeBeeziHooks leaves a user’s own hooks untouched', () => {
  const mine = { command: '/usr/local/bin/audit' };
  const existing = {
    hooks: {
      beforeShellExecution: [mine],
      stop: [ours('stop.mjs')],
    },
  };
  const out = removeBeeziHooks(existing, '/h');
  assert.deepEqual(out.hooks.beforeShellExecution, [mine]);
  assert.ok(!('stop' in out.hooks), 'an event left with no handlers is dropped');
});

test('removeBeeziHooks strips only our handler from a shared event', () => {
  const mine = { command: '/usr/local/bin/audit' };
  const existing = { hooks: { stop: [mine, ours('stop.mjs')] } };
  assert.deepEqual(removeBeeziHooks(existing, '/h').hooks.stop, [mine]);
});

test('the generic label alone is never enough to remove a handler', () => {
  // `Beezi analytics` used to be SUFFICIENT on its own. The string is generic, the registry is the
  // user's to open and edit, and any other tool — or a note the user put on a handler of their own
  // — could carry it; matching on it meant uninstall could delete a stranger's hook. A label can
  // confirm an entry we already recognise by its launcher; it can never be the reason one is
  // removed.
  const foreign = { command: '/usr/local/bin/somebody-elses-tool', statusMessage: BEEZI_STATUS_MESSAGE };
  const existing = { hooks: { stop: [foreign, ours('stop.mjs')] } };
  assert.deepEqual(removeBeeziHooks(existing, '/h').hooks.stop, [foreign]);
});

test('a handler whose command is not a string is left exactly where it is', () => {
  const odd = { command: { path: '/x' }, statusMessage: BEEZI_STATUS_MESSAGE };
  assert.deepEqual(removeBeeziHooks({ hooks: { stop: [odd] } }, '/h').hooks.stop, [odd]);
});

// ── environment variants sharing one machine ──────────────────────────────────────────────

test('production keeps the unsuffixed launcher name it has always written', () => {
  // The migration rule: prod is the current, unsuffixed install, so an upgrade rewrites nothing and
  // every entry already on a user's machine stays recognisable.
  assert.equal(launcherName('stop.mjs', 'win32'), 'beezi-stop.cmd');
  assert.equal(launcherName('stop.mjs', 'linux'), 'beezi-stop.sh');
});

test('each variant writes its own launcher name', () => {
  assert.equal(launcherName('stop.mjs', 'linux', 'beezi-dev'), 'beezi-dev-stop.sh');
  assert.equal(launcherName('stop.mjs', 'win32', 'beezi-staging'), 'beezi-staging-stop.cmd');
});

test('production does not claim a variant’s handlers, although it is a prefix of them', () => {
  // `beezi-dev-stop.sh` starts with `beezi-`. A prefix test alone — which is what this module used
  // to do — would make a production uninstall delete the dev install's entries off a machine that
  // runs both.
  const dev = ours('stop.mjs', '/h', 'beezi-dev');
  const staging = ours('stop.mjs', '/h', 'beezi-staging');
  const out = removeBeeziHooks({ hooks: { stop: [dev, staging, ours('stop.mjs')] } }, '/h');
  assert.deepEqual(out.hooks.stop, [dev, staging]);
});

test('a variant does not claim production’s handlers either', () => {
  // The other direction, and the one the migration rule turns on: a legacy unsuffixed handler
  // belongs to prod and to nothing else, so installing dev beside it must leave it alone.
  const prod = ours('stop.mjs');
  const out = removeBeeziHooks({ hooks: { stop: [prod, ours('stop.mjs', '/h', 'beezi-dev')] } }, '/h', 'beezi-dev');
  assert.deepEqual(out.hooks.stop, [prod]);
});

test('three variants coexist in one registry, and each re-install touches only its own', () => {
  const dir = '/h';
  const markers = ['beezi', 'beezi-dev', 'beezi-staging'];
  let registry = {};
  for (const marker of markers) {
    registry = mergeHooks(registry, buildHookEntries({ launcherDir: dir, platform: 'linux', variantMarker: marker }), dir, marker);
  }
  assert.equal(registry.hooks.stop.length, 3, 'one handler per variant');

  // Re-installing dev replaces dev's entry and leaves the other two byte-identical and in order.
  const before = registry.hooks.stop.map((h) => h.command);
  registry = mergeHooks(registry, buildHookEntries({ launcherDir: dir, platform: 'linux', variantMarker: 'beezi-dev' }), dir, 'beezi-dev');
  assert.equal(registry.hooks.stop.length, 3);
  assert.deepEqual(
    registry.hooks.stop.map((h) => h.command).sort(),
    before.slice().sort(),
  );

  // Uninstalling staging leaves prod and dev running.
  const left = removeBeeziHooks(registry, dir, 'beezi-staging');
  assert.deepEqual(
    left.hooks.stop.map((h) => h.command).sort(),
    [path.join(dir, 'beezi-dev-stop.sh'), path.join(dir, 'beezi-stop.sh')],
  );
});

test('a variant install reports only its own events as registered', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const { script } of BEEZI_HOOKS) fs.writeFileSync(path.join(scriptsDir, script), '', 'utf-8');

  installHooks({ scriptsDir, hooksFile, launcherDir, platform: 'linux', nodePath: process.execPath, variantMarker: 'beezi-dev' });
  assert.ok(fs.existsSync(path.join(launcherDir, 'beezi-dev-stop.sh')));
  assert.ok(!fs.existsSync(path.join(launcherDir, 'beezi-stop.sh')));

  const asProd = hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux' });
  assert.deepEqual(asProd.registered, [], 'prod must not report the dev install as its own');
  assert.equal(asProd.state, 'absent');

  const asDev = hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux', variantMarker: 'beezi-dev' });
  assert.equal(asDev.state, 'installed');

  // And a prod uninstall leaves every one of dev's launchers and entries in place.
  uninstallHooks({ hooksFile, launcherDir, platform: 'linux' });
  assert.ok(fs.existsSync(path.join(launcherDir, 'beezi-dev-stop.sh')));
  assert.equal(
    hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux', variantMarker: 'beezi-dev' }).state,
    'installed',
  );
});

test('removeBeeziHooks preserves unknown top-level keys', () => {
  const out = removeBeeziHooks({ version: 1, hooks: {}, somethingElse: { keep: true } });
  assert.deepEqual(out.somethingElse, { keep: true });
  assert.equal(out.version, 1);
});

test('mergeHooks is idempotent — re-install does not duplicate entries', () => {
  const beezi = buildHookEntries({ launcherDir: '/h', platform: 'linux' });
  const once = mergeHooks({}, beezi, '/h');
  const twice = mergeHooks(once, beezi, '/h');
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.stop.length, 1);
  assert.equal(twice.version, 1);
});

test('mergeHooks keeps a user hook on an event Beezi also registers', () => {
  const mine = { command: '/mine' };
  const merged = mergeHooks({ hooks: { stop: [mine] } }, buildHookEntries({ launcherDir: '/h', platform: 'linux' }), '/h');
  assert.equal(merged.hooks.stop.length, 2);
  assert.deepEqual(merged.hooks.stop[0], mine);
});

test('installHooks writes launchers and a readable registry, then uninstall reverses it', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'cursor', 'plugins', 'local', 'beezi', 'hooks', 'hooks.json');
  const launcherDir = path.join(root, 'launchers');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  const res = install({ scriptsDir, hooksFile, launcherDir });
  assert.equal(res.launchers.length, BEEZI_HOOKS.length);
  for (const l of res.launchers) assert.ok(fs.existsSync(l));

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), EVENTS);
  assert.equal(written.version, 1);
  // The deadline reaches disk, not just the builder — this file is what Cursor actually reads.
  for (const [event, handlers] of Object.entries(written.hooks)) {
    assert.equal(handlers[0].timeout, hookTimeoutSec(event), `${event} was installed with no timeout`);
  }
  assert.ok(fs.readFileSync(hooksFile, 'utf-8').includes('\n  '), 'registry stays hand-reviewable');

  uninstallHooks({ platform: 'linux', hooksFile, launcherDir });
  assert.ok(!fs.existsSync(hooksFile), 'a registry that held only our entries is removed, not emptied');
  for (const l of res.launchers) assert.ok(!fs.existsSync(l));
});

test('both scopes install the same entries into different files', () => {
  const root = tmpdir();
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');
  const pluginFile = path.join(root, 'plugin-scope.json');
  const userFile = path.join(root, 'user-scope.json');

  install({ scope: HookScope.PLUGIN, scriptsDir, hooksFile: pluginFile, launcherDir });
  install({ scope: HookScope.USER, scriptsDir, hooksFile: userFile, launcherDir });

  const a = JSON.parse(fs.readFileSync(pluginFile, 'utf-8'));
  const b = JSON.parse(fs.readFileSync(userFile, 'utf-8'));
  assert.deepEqual(a, b, 'the P0 fallback registers exactly the same hooks');
});

test('the user-scope fallback preserves hooks the user already had', () => {
  // This is the documented P0 fallback target and, unlike a plugin-private file, it is a file the
  // user configures themselves. Clobbering it is the failure this whole merge path exists to avoid.
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  fs.writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: '/mine' }] } }));

  install({ scope: HookScope.USER, scriptsDir: '/p/scripts', hooksFile, launcherDir });
  const res = uninstallHooks({ scope: HookScope.USER, platform: 'linux', hooksFile, launcherDir });

  assert.equal(res.removed, true);
  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(kept.hooks.beforeShellExecution[0].command, '/mine');
  assert.ok(!('stop' in kept.hooks));
});

test('hooksStatus reports installed only when registry and launchers agree', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'absent');

  install({ scriptsDir, hooksFile, launcherDir });
  const ok = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(ok.state, 'installed');
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.registered.sort(), EVENTS);
  assert.deepEqual(ok.missingLaunchers, []);
});

test('hooksStatus calls launchers left behind by a plugin upgrade stale, not absent', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');

  install({ scriptsDir: path.join(root, 'v1', 'scripts'), hooksFile, launcherDir });

  const status = hooksStatus({ scriptsDir: path.join(root, 'v2', 'scripts'), platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.complete, false);
  assert.equal(status.missingLaunchers.length, 0);
  assert.equal(status.staleLaunchers.length, BEEZI_HOOKS.length);
});

test('hooksStatus reports partial when the registry has our entries but a launcher is gone', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  const { launchers } = install({ scriptsDir, hooksFile, launcherDir });
  fs.rmSync(launchers[0]);

  const status = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'partial');
  assert.equal(status.missingLaunchers.length, 1);
});

test('an entry whose label the user reworded is still recognised as ours', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');

  install({ scriptsDir: '/p/scripts', hooksFile, launcherDir });
  const edited = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const handlers of Object.values(edited.hooks)) handlers[0].statusMessage = 'my analytics';
  fs.writeFileSync(hooksFile, JSON.stringify(edited));

  // Ownership falls back to the launcher filename, so re-install stays idempotent…
  install({ scriptsDir: '/p/scripts', hooksFile, launcherDir });
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf-8')).hooks.stop.length, 1);

  // …and uninstall does not silently leave firing hooks behind.
  assert.equal(uninstallHooks({ platform: 'linux', hooksFile, launcherDir }).removed, true);
  assert.ok(!fs.existsSync(hooksFile));
});

test('uninstallHooks on a machine that never installed reports nothing removed', () => {
  const root = tmpdir();
  const res = uninstallHooks({ platform: 'linux', hooksFile: path.join(root, 'hooks.json'), launcherDir: path.join(root, 'l') });
  assert.equal(res.removed, false);
});

test('an unreadable registry is refused, never silently replaced', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  // Users are invited to open and review this file, so a stray comma is a real state.
  fs.writeFileSync(hooksFile, '{ "hooks": { "beforeShellExecution": [ ] , } }');

  assert.throws(
    () => install({ scriptsDir: '/p/scripts', hooksFile, launcherDir: path.join(root, 'l') }),
    /not valid JSON/,
  );
  // Their file is exactly as they left it — merging onto `{}` would have deleted every hook in it.
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), '{ "hooks": { "beforeShellExecution": [ ] , } }');
});

test('a user script that merely starts with beezi- is not ours to remove', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const mine = { command: path.join(root, 'bin', 'beezi-notify.sh') };
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { beforeShellExecution: [mine] } }));

  install({ scriptsDir: '/p/scripts', hooksFile, launcherDir });
  uninstallHooks({ platform: 'linux', hooksFile, launcherDir });

  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.beforeShellExecution, [mine], 'uninstall promised to leave their hooks alone');
});

test('a launcher whose interpreter has been upgraded away reads as stale', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');

  // Installed with a Node that no longer exists — every hook now fails at spawn, so reporting
  // "installed" would leave the real cause invisible.
  install({ scriptsDir, nodePath: path.join(root, 'nvm', 'v20', 'node'), hooksFile, launcherDir });

  const status = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.staleLaunchers.length, BEEZI_HOOKS.length);
});

test('materializePlugin copies the plugin but never node_modules, .git or test', () => {
  const root = tmpdir();
  const sourceRoot = path.join(root, 'src');
  const targetRoot = path.join(root, 'installed');
  fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'test'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'scripts', 'stop.mjs'), '// x');
  fs.writeFileSync(path.join(sourceRoot, 'node_modules', 'junk'), 'x');
  fs.writeFileSync(path.join(sourceRoot, 'test', 'a.test.mjs'), 'x');

  const res = materializePlugin({ sourceRoot, targetRoot });
  assert.equal(res.copied, true);
  assert.ok(fs.existsSync(path.join(targetRoot, 'scripts', 'stop.mjs')));
  assert.ok(!fs.existsSync(path.join(targetRoot, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(targetRoot, 'test')));
});

test('materializePlugin is a no-op when the running copy is already the installed one', () => {
  const root = tmpdir();
  assert.deepEqual(materializePlugin({ sourceRoot: root, targetRoot: root }), { root, copied: false });
});

test('the launchers point at the materialized copy, not the checkout they ran from', () => {
  // The checkout can be moved or deleted; every hook would then fail at spawn with the registry
  // still looking perfect.
  const root = tmpdir();
  const sourceRoot = path.join(root, 'checkout');
  const targetRoot = path.join(root, 'installed');
  fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'scripts', 'stop.mjs'), '// x');

  const launcherDir = path.join(root, 'l');
  const res = installHooks({
    // Explicit: materializing is the legacy plugin-scope behaviour and no longer the default, so
    // this is the one test that has to ask for it.
    materialize: true,
    sourceRoot,
    targetRoot,
    nodePath: process.execPath,
    platform: 'linux',
    hooksFile: path.join(root, 'hooks.json'),
    launcherDir,
  });

  assert.equal(res.pluginRoot, targetRoot);
  const body = fs.readFileSync(path.join(launcherDir, 'beezi-stop.sh'), 'utf-8');
  assert.ok(body.includes(path.join(targetRoot, 'scripts', 'stop.mjs')));
  assert.ok(!body.includes(path.join(sourceRoot, 'scripts', 'stop.mjs')));
});


// ── an upgrade that changes a deadline has to reach the machines already installed ───────────────

test('an entry carrying the previous deadline is outdated, and the next install repairs it', () => {
  // The regression this exists for. When beforeMCPExecution and subagentStart dropped from 10s to
  // 5s, the command string did not change — so a registry written by the previous version read as
  // current, `hooksStatus` said `installed`, and `ensureInstalled` (which only rewrites when the
  // state is NOT `installed`) never touched it. The bundled registry would have declared 5 and the
  // user-scope registry 10 for the same two scripts, permanently, with nothing reporting a problem.
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const { script } of BEEZI_HOOKS) fs.writeFileSync(path.join(scriptsDir, script), '', 'utf-8');

  install({ scriptsDir, hooksFile, launcherDir });
  assert.equal(hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux' }).state, 'installed');

  // Rewind exactly one field, the way the previous version left it: our command, our launcher, the
  // old uniform deadline.
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const event of PERMISSION_EVENTS) registry.hooks[event][0].timeout = HOOK_TIMEOUT_SEC;
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2), 'utf-8');

  const stale = hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux' });
  assert.deepEqual(stale.outdatedEntries.sort(), [...PERMISSION_EVENTS].sort());
  assert.equal(stale.state, 'stale', 'an entry that is ours, listed and wrong must not read as installed');
  assert.deepEqual(stale.registered.sort(), EVENTS, 'it is still recognised as ours — this is a repair, not a re-add');

  // And the repair actually lands, without duplicating the entry.
  install({ scriptsDir, hooksFile, launcherDir });
  const repaired = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const event of PERMISSION_EVENTS) {
    assert.equal(repaired.hooks[event].length, 1, `${event} was duplicated rather than repaired`);
    assert.equal(repaired.hooks[event][0].timeout, PERMISSION_HOOK_TIMEOUT_SEC);
  }
  assert.equal(hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux' }).state, 'installed');
});

test('an unchanged install is not rewritten, so the deadline check cannot flap', () => {
  // The other half: `outdatedEntries` triggers a rewrite at every session start, so a check that
  // disagreed with what buildHookEntries writes would rewrite the user's registry forever.
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = path.join(root, 'plugin', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const { script } of BEEZI_HOOKS) fs.writeFileSync(path.join(scriptsDir, script), '', 'utf-8');

  install({ scriptsDir, hooksFile, launcherDir });
  const first = fs.readFileSync(hooksFile, 'utf-8');
  install({ scriptsDir, hooksFile, launcherDir });
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), first, 'a re-install rewrote an identical registry');
  assert.deepEqual(hooksStatus({ scriptsDir, hooksFile, launcherDir, platform: 'linux' }).outdatedEntries, []);
});

// ── the permission scripts still cannot express an opinion ───────────────────────────────────────

test('neither permission script has any way to reach stdout', () => {
  // test/plugin-manifest.test.mjs greps these two for `process.stdout` and `console.log`. That grep
  // was written when the scripts owned their own output, and it is now VACUOUS on its own: every byte
  // of a hook's stdout goes through the runner, so a permission script could start answering Cursor
  // without the word `stdout` appearing anywhere in it.
  //
  // These are the two spellings that would do it. `ctx.emit` is the success path — a
  // `{"permission":"deny"}` there blocks the user's MCP call or subagent outright — and `failOutput`
  // is the failure path, which would put a token on the stream when the hook is already broken.
  // Neither may appear in a permission entry, and the check has to live in a file that knows they
  // exist.
  for (const { script, event } of BEEZI_HOOKS) {
    if (!PERMISSION_EVENTS.includes(event)) continue;
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf-8');
    assert.equal(/\bemit\b/.test(body), false, `${script} can write to stdout via ctx.emit`);
    assert.equal(/failOutput/.test(body), false, `${script} overrides the failure output`);
    assert.equal(/process\s*\.\s*stdout/.test(body), false, `${script} can write to stdout directly`);
    // And it must actually declare itself a permission hook — twice, because the guards and the
    // runner each branch on it and an entry that told only one of them would take the analytics
    // failure path.
    assert.match(body, /installHookGuards\(\{[^}]*permission: true/, `${script} guards as an analytics hook`);
    assert.match(body, /^\s*permission: true,$/m, `${script} does not run as a permission hook`);
  }
});

test('the failure a permission hook leaves on stdout is nothing at all', () => {
  // The value the two scripts inherit by not overriding it. CONTRACTS section 9 names `{}`; silence
  // is what this plugin has always answered and what the four permission tests in
  // test/plugin-manifest.test.mjs pin, so the deviation is deliberate and recorded in the handoff.
  // Pinned here because it is a one-character change with the user's blocked tool call downstream.
  assert.equal(PERMISSION_FAILURE_OUTPUT, '');
});

// ── launchers that survive a CLI update ───────────────────────────────────────────────────────────
//
// Under `cursor-agent` the installer runs on the CLI's own Node, which lives in
// `%LOCALAPPDATA%\cursor-agent\versions\<version>\node.exe` — a folder the CLI replaces on update.
// A launcher that names only that path points at nothing after the next update, and every hook then
// fails at spawn. These launchers try the recorded Node first and fall back to PATH `node`.

test('launcher falls back when the recorded node is gone (win32)', () => {
  const body = launcherBody('C:\\p\\stop.mjs', {
    nodePath: 'C:\\cli\\versions\\1\\node.exe', platform: 'win32', fallbacks: ['node'],
  });
  assert.equal(body, [
    '@echo off',
    'if not exist "C:\\cli\\versions\\1\\node.exe" goto beezi_fallback_1',
    '"C:\\cli\\versions\\1\\node.exe" --no-warnings "C:\\p\\stop.mjs" %*',
    // On its own line, so cmd expands %errorlevel% after node ran rather than when it parsed a block.
    'exit /b %errorlevel%',
    ':beezi_fallback_1',
    'node --no-warnings "C:\\p\\stop.mjs" %*',
    '',
  ].join('\r\n'));
});

test('launcher falls back when the recorded node is gone (posix)', () => {
  const body = launcherBody('/p/stop.mjs', { nodePath: '/cli/versions/1/node', platform: 'linux', fallbacks: ['node'] });
  assert.equal(body, [
    '#!/bin/sh',
    'if [ -x "/cli/versions/1/node" ]; then exec "/cli/versions/1/node" --no-warnings "/p/stop.mjs" "$@"; fi',
    'exec node --no-warnings "/p/stop.mjs" "$@"',
    '',
  ].join('\n'));
});

test('every fallback but the last is guarded, and a path-shaped one is quoted', () => {
  // Only the last candidate may be a bare command name: `if exist node` tests the cwd, not PATH.
  const win = launcherBody('C:\\p\\stop.mjs', {
    nodePath: 'C:\\a\\node.exe', platform: 'win32', fallbacks: ['C:\\b c\\node.exe', 'node'],
  });
  assert.ok(win.includes('\r\n:beezi_fallback_1\r\nif not exist "C:\\b c\\node.exe" goto beezi_fallback_2\r\n'));
  assert.ok(win.includes('\r\n"C:\\b c\\node.exe" --no-warnings "C:\\p\\stop.mjs" %*\r\nexit /b %errorlevel%\r\n'));
  assert.ok(win.endsWith('\r\n:beezi_fallback_2\r\nnode --no-warnings "C:\\p\\stop.mjs" %*\r\n'));

  const posix = launcherBody('/p/stop.mjs', { nodePath: '/a/node', platform: 'linux', fallbacks: ['/b c/node', 'node'] });
  assert.ok(posix.includes('\nif [ -x "/b c/node" ]; then exec "/b c/node" --no-warnings "/p/stop.mjs" "$@"; fi\n'));
  assert.ok(posix.endsWith('\nexec node --no-warnings "/p/stop.mjs" "$@"\n'));
});

test('no fallbacks keeps the launcher byte-identical to today', () => {
  // Every install that is not running on the CLI's versioned Node must rewrite nothing on upgrade.
  const win = launcherBody('C:\\p\\stop.mjs', { nodePath: 'C:\\n\\node.exe', platform: 'win32' });
  assert.equal(win, ['@echo off', '"C:\\n\\node.exe" --no-warnings "C:\\p\\stop.mjs" %*', ''].join('\r\n'));
  assert.equal(launcherBody('C:\\p\\stop.mjs', { nodePath: 'C:\\n\\node.exe', platform: 'win32', fallbacks: [] }), win);

  const posix = launcherBody('/p/stop.mjs', { nodePath: '/n/node', platform: 'linux' });
  assert.equal(posix, ['#!/bin/sh', 'exec "/n/node" --no-warnings "/p/stop.mjs" "$@"', ''].join('\n'));
});

test('a versioned cursor-agent node gets PATH node as fallback', () => {
  const win = 'C:\\Users\\u\\AppData\\Local\\cursor-agent\\versions\\2026.09.18-9a7762b\\node.exe';
  assert.deepEqual(stableNodePath(win, {}), { nodePath: win, fallbacks: ['node'] });
  const posix = '/home/u/.local/share/cursor-agent/versions/2026.09.18-9a7762b/node';
  assert.deepEqual(stableNodePath(posix, {}), { nodePath: posix, fallbacks: ['node'] });
});

test('an IDE or system node gets no fallbacks', () => {
  assert.deepEqual(stableNodePath('C:\\Program Files\\nodejs\\node.exe', {}).fallbacks, []);
  assert.deepEqual(stableNodePath('C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\resources\\helpers\\node.exe', {}).fallbacks, []);
  assert.deepEqual(stableNodePath('/usr/bin/node', {}).fallbacks, []);
});

test('stableNodePath never throws on a missing or odd execPath', () => {
  assert.deepEqual(stableNodePath(undefined), { nodePath: undefined, fallbacks: [] });
  assert.deepEqual(stableNodePath(null, null), { nodePath: null, fallbacks: [] });
});

// A real file standing in for the CLI's bundled Node, so hooksStatus's existence check sees it.
function fakeCliNode(root) {
  const nodePath = path.join(root, 'cursor-agent', 'versions', '1', 'node');
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(nodePath, '', 'utf-8');
  return nodePath;
}

function scriptsFixture(root) {
  const scriptsDir = path.join(root, 'plugin', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const { script } of BEEZI_HOOKS) fs.writeFileSync(path.join(scriptsDir, script), '', 'utf-8');
  return scriptsDir;
}

test('an install on the CLI node writes fallback launchers and reads as installed', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = scriptsFixture(root);
  const nodePath = fakeCliNode(root);

  install({ scriptsDir, hooksFile, launcherDir, nodePath });
  const body = fs.readFileSync(path.join(launcherDir, 'beezi-stop.sh'), 'utf-8');
  assert.ok(body.includes(`if [ -x "${nodePath}" ]`), 'the recorded CLI node is tried first');
  assert.ok(body.includes(`exec node --no-warnings "${path.join(scriptsDir, 'stop.mjs')}" "$@"`), 'PATH node is the fallback');
  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'installed');
});

test('a CLI update reads as stale, and the repair converges without a reinstall loop', () => {
  // Stale on purpose even though the PATH fallback would still run: `stale` is what makes
  // ensureInstalled point the launchers at the new CLI's Node, instead of leaning on a PATH `node`
  // that a CLI-only machine may not have.
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = scriptsFixture(root);
  const nodePath = fakeCliNode(root);

  install({ scriptsDir, hooksFile, launcherDir, nodePath });
  fs.rmSync(path.join(root, 'cursor-agent'), { recursive: true, force: true });
  const stale = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.staleLaunchers.length, BEEZI_HOOKS.length);

  install({ scriptsDir, hooksFile, launcherDir, nodePath: process.execPath });
  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'installed');
  const registry = fs.readFileSync(hooksFile, 'utf-8');
  const launcher = fs.readFileSync(path.join(launcherDir, 'beezi-stop.sh'), 'utf-8');
  install({ scriptsDir, hooksFile, launcherDir, nodePath: process.execPath });
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), registry, 'a second repair rewrote the registry');
  assert.equal(fs.readFileSync(path.join(launcherDir, 'beezi-stop.sh'), 'utf-8'), launcher);
  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'installed');
});

test('an older launcher on the CLI node without a fallback is migrated once', () => {
  // Launchers written before fallbacks existed name the versioned Node alone. They still work today
  // and would break at the next CLI update, so they read as stale now, while the fix is still cheap.
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = scriptsFixture(root);
  const nodePath = fakeCliNode(root);

  install({ scriptsDir, hooksFile, launcherDir, nodePath });
  for (const { script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, launcherName(script, 'linux'));
    fs.writeFileSync(launcher, launcherBody(path.join(scriptsDir, script), { nodePath, platform: 'linux' }), 'utf-8');
  }
  const old = hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir });
  assert.equal(old.state, 'stale');
  assert.equal(old.staleLaunchers.length, BEEZI_HOOKS.length);

  install({ scriptsDir, hooksFile, launcherDir, nodePath });
  assert.equal(hooksStatus({ scriptsDir, platform: 'linux', hooksFile, launcherDir }).state, 'installed');
});

test('a Windows fallback launcher still names its script and its node for hooksStatus', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = scriptsFixture(root);
  const nodePath = fakeCliNode(root);

  install({ scriptsDir, hooksFile, launcherDir, nodePath, platform: 'win32' });
  assert.ok(fs.readFileSync(path.join(launcherDir, 'beezi-stop.cmd'), 'utf-8').includes('goto beezi_fallback_1'));
  assert.equal(hooksStatus({ scriptsDir, platform: 'win32', hooksFile, launcherDir }).state, 'installed');
});
