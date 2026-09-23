import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureInstalled, shimBody, writeBinShim } from '../lib/plugin-install.mjs';
import { HookSource, recordHookRun } from '../lib/hook-source.mjs';
import { BEEZI_HOOKS, PLUGIN_ROOT } from '../lib/hooks-install.mjs';
import { readJson } from '../lib/fs-store.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-self-install-'));
}

const NOW = 1_770_000_000_000;

// Every call here is fully pathed. The real thing writes into ~/.cursor and ~/.beezi-cursor, and a
// test suite must never touch either.
function ensure(dir, extra = {}) {
  return ensureInstalled({
    now: NOW,
    shimFile: path.join(dir, 'bin', 'beezi.mjs'),
    sourceFile: path.join(dir, 'hook-source.json'),
    statusDeps: { hooksFile: path.join(dir, 'hooks.json'), launcherDir: path.join(dir, 'launchers'), platform: 'linux' },
    installDeps: {
      hooksFile: path.join(dir, 'hooks.json'),
      launcherDir: path.join(dir, 'launchers'),
      platform: 'linux',
      nodePath: process.execPath,
    },
    ...extra,
  });
}

test('the shim forwards to the plugin copy that generated it', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'beezi.mjs');
  writeBinShim({ pluginRoot: '/plugins/cache/beezi/beezi/abc123', file });
  const body = fs.readFileSync(file, 'utf-8');
  // A marketplace install lives under a git-sha directory, so this path is the whole reason the
  // shim exists: no command markdown can name it.
  assert.match(body, /plugins\/cache\/beezi\/beezi\/abc123/);
  assert.match(body, /process\.argv = \[process\.argv\[0\], target, \.\.\.rest\]/);
});

test('the shim is rewritten only when the target changes', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'beezi.mjs');
  assert.equal(writeBinShim({ pluginRoot: '/a', file }).written, true);
  // This runs at every session start; an unchanged rewrite is pure churn.
  assert.equal(writeBinShim({ pluginRoot: '/a', file }).written, false);
  assert.equal(writeBinShim({ pluginRoot: '/b', file }).written, true);
});

test('the shim actually runs a real script and passes its arguments through', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'beezi.mjs');
  writeBinShim({ pluginRoot: PLUGIN_ROOT, file });
  // `install status` is the one subcommand that neither writes nor needs the network.
  const out = execFileSync(process.execPath, [file, 'install', 'status'], {
    encoding: 'utf-8',
    env: { ...process.env, BEEZI_CURSOR_HOME: path.join(dir, 'home'), CURSOR_CONFIG_DIR: path.join(dir, 'cursor') },
  });
  assert.match(out, /Beezi/);
});

test('an unknown subcommand fails loudly rather than silently doing nothing', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'beezi.mjs');
  writeBinShim({ pluginRoot: PLUGIN_ROOT, file });
  assert.throws(() => execFileSync(process.execPath, [file, 'not-a-command'], { stdio: 'pipe' }));
});

test('no record yet: the user-scope registry is installed so analytics work anyway', () => {
  const dir = tmpdir();
  const result = ensure(dir);
  assert.equal(result.source, 'launcher');
  const registry = readJson(path.join(dir, 'hooks.json'));
  assert.deepEqual(Object.keys(registry.hooks).sort(), BEEZI_HOOKS.map((h) => h.event).sort());
  assert.ok(fs.existsSync(path.join(dir, 'bin', 'beezi.mjs')));
});

test('bundled hooks proven alive: the user-scope registry stays exactly where it is', () => {
  const dir = tmpdir();
  ensure(dir); // first session — the user-scope registry goes in
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: PLUGIN_ROOT, now: NOW, file: path.join(dir, 'hook-source.json') });

  const result = ensure(dir);
  // Reported, not acted on: this now names the registry seen firing, and nothing branches on it.
  assert.equal(result.source, 'plugin-hooks');
  assert.deepEqual(result.actions, [], 'a proven bundled registry is not a reason to touch anything');

  // This used to delete the file. Older `cursor-agent` builds run no plugin-bundled hook, so
  // there these entries are the CLI's only ones — removing them on the strength of an IDE
  // session having fired is what silently stopped every CLI session on the machine from reporting.
  const registry = readJson(path.join(dir, 'hooks.json'));
  assert.deepEqual(Object.keys(registry.hooks).sort(), BEEZI_HOOKS.map((h) => h.event).sort());
});

test('a user registry is never clobbered, and their hooks keep their place', () => {
  const dir = tmpdir();
  const hooksFile = path.join(dir, 'hooks.json');
  fs.writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'mine.sh' }] } }), 'utf-8');

  ensure(dir);
  let registry = readJson(hooksFile);
  assert.deepEqual(registry.hooks.stop[0], { command: 'mine.sh' });
  assert.equal(registry.hooks.stop.length, 2, 'Beezi appends; it does not take the slot');

  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: PLUGIN_ROOT, now: NOW, file: path.join(dir, 'hook-source.json') });
  ensure(dir);
  registry = readJson(hooksFile);
  assert.deepEqual(registry.hooks.stop[0], { command: 'mine.sh' });
  assert.equal(registry.hooks.stop.length, 2);
});

test('a second session with the fallback already in place installs nothing further', () => {
  const dir = tmpdir();
  ensure(dir);
  const result = ensure(dir);
  // Idempotent: the registry is already complete, so there is nothing to write.
  assert.deepEqual(result.actions, []);
  assert.equal(result.source, 'launcher');
});

test('a session start repairs a registry whose commands predate the quoting rule', () => {
  // The end of the chain the quoting fix depends on, and the half a unit test on hooksStatus cannot
  // reach. A launcher path under a home directory with a space in it is written quoted now; a
  // registry from before that carries the bare path, which is the broken one. Everything about that
  // machine looks healthy — our entries, all ten events, launchers present and current — so if the
  // status check ever calls it `installed` again, `ensureInstalled` writes nothing and the user stays
  // broken forever with no surface saying why. This is the test that fails if that happens.
  const dir = tmpdir();
  const hooksFile = path.join(dir, 'hooks.json');
  const launcherDir = path.join(dir, 'First Last', 'launchers');
  const seams = {
    statusDeps: { hooksFile, launcherDir, platform: 'linux' },
    installDeps: { hooksFile, launcherDir, platform: 'linux', nodePath: process.execPath },
  };

  ensureInstalled({ now: NOW, shimFile: path.join(dir, 'bin', 'beezi.mjs'), sourceFile: path.join(dir, 'hook-source.json'), ...seams });

  const aged = readJson(hooksFile);
  for (const handlers of Object.values(aged.hooks)) handlers[0].command = handlers[0].command.slice(1, -1);
  fs.writeFileSync(hooksFile, `${JSON.stringify(aged, null, 2)}\n`, 'utf-8');

  const result = ensureInstalled({ now: NOW, shimFile: path.join(dir, 'bin', 'beezi.mjs'), sourceFile: path.join(dir, 'hook-source.json'), ...seams });

  assert.ok(
    result.actions.includes('user-hooks-installed:stale'),
    `the session start did not repair the registry: ${JSON.stringify(result.actions)}`,
  );
  const repaired = readJson(hooksFile);
  assert.equal(repaired.hooks.stop.length, 1, 'repaired in place — not a second entry beside the old one');
  assert.equal(repaired.hooks.stop[0].command, `"${path.join(launcherDir, 'beezi-stop.sh')}"`);
});

test('a failure anywhere still returns rather than taking the MCP server down', () => {
  const dir = tmpdir();
  // A registry that cannot be parsed makes the installer throw — the MCP tools must survive it.
  fs.writeFileSync(path.join(dir, 'hooks.json'), '{ not json', 'utf-8');
  const result = ensure(dir);
  assert.equal(result.source, 'unknown');
  assert.ok(result.actions.some((a) => a.startsWith('hooks-failed')));
});

test('shimBody escapes a Windows plugin root into valid JavaScript', () => {
  const body = shimBody('C:\\Users\\dev\\.cursor\\plugins\\cache\\beezi\\beezi\\abc');
  assert.match(body, /"C:\\\\Users\\\\dev/);
});

// ─── every user-facing verb has a shim (integration step 2: PI-1, PI-2, PI-3) ───────────────────

test('the shim dispatches refresh, telemetry and sync as well as the original five', () => {
  // The shim is the stable path a human types. A verb a skill or a nudge names but the shim does
  // not know prints "unknown command" — which is indistinguishable, to the user, from the feature
  // not existing.
  const body = shimBody('/opt/beezi');
  for (const [verb, script] of [
    ['login', 'login.mjs'],
    ['logout', 'logout.mjs'],
    ['me', 'me.mjs'],
    ['track', 'track.mjs'],
    ['install', 'install.mjs'],
    ['plan', 'billing-capture.mjs'],
    ['refresh', 'billing-capture.mjs'],
    ['telemetry', 'telemetry.mjs'],
    ['sync', 'sync.mjs'],
  ]) {
    assert.match(body, new RegExp(`"${verb}"\\s*:\\s*"${script.replace('.', '\\.')}"`), `${verb} is not dispatched`);
  }
});

test('the shim rewrites argv[1] before importing, which scripts/telemetry.mjs depends on', () => {
  // scripts/telemetry.mjs is the only script that guards its self-invocation, on
  // `path.basename(process.argv[1]) === 'telemetry.mjs'`. It is correct ONLY because of this
  // rewrite; without it `beezi telemetry off` would import the module, change nothing and exit 0.
  const body = shimBody('/opt/beezi');
  assert.match(body, /process\.argv\s*=\s*\[/);
});
