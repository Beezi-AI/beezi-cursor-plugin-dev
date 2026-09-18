import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_PLUGIN_KEY,
  installProjectPlugin,
  isSupportedGitUrl,
  projectPluginStatus,
  projectSettingsFile,
  uninstallProjectPlugin,
} from '../lib/project-install.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-project-'));
}

const GIT_URL = 'https://github.com/beezi-ai/beezi-cursor-plugin';

function read(dir) {
  return JSON.parse(fs.readFileSync(projectSettingsFile(dir), 'utf-8'));
}

test('the entry lands in the file Cursor reads project plugins from', () => {
  const dir = tmpdir();
  const { file } = installProjectPlugin({ dir, gitUrl: GIT_URL });
  // NOT .cursor/plugins.json and NOT .cursor/hooks.json — Cursor reads `plugins` out of
  // <workspace>/.cursor/settings.json, and ignores the entry anywhere else.
  assert.equal(file, path.join(dir, '.cursor', 'settings.json'));
  assert.deepEqual(read(dir).plugins[PROJECT_PLUGIN_KEY], {
    enabled: true,
    gitUrl: GIT_URL,
    gitRef: 'main',
    gitPath: 'plugins/beezi',
  });
});

test('the key is marketplace/plugin — Cursor splits it at the first slash', () => {
  assert.equal(PROJECT_PLUGIN_KEY, 'beezi/beezi');
});

test('only https:// and git@ URLs are accepted, because Cursor drops the rest', () => {
  assert.equal(isSupportedGitUrl(GIT_URL), true);
  assert.equal(isSupportedGitUrl('git@github.com:beezi-ai/beezi-cursor-plugin.git'), true);
  // A marketplace added from a local path produces exactly this, and Cursor logs
  // "Ignoring project plugin with invalid gitUrl" and moves on.
  assert.equal(isSupportedGitUrl('file:///c:/Users/me/beezi-cursor-plugin'), false);
  assert.equal(isSupportedGitUrl('http://github.com/beezi-ai/x'), false);
  assert.equal(isSupportedGitUrl('https://user:pw@github.com/beezi-ai/x'), false);
  assert.equal(isSupportedGitUrl(''), false);
  assert.equal(isSupportedGitUrl(undefined), false);
});

test('an unusable git URL is refused before anything is written', () => {
  const dir = tmpdir();
  assert.throws(() => installProjectPlugin({ dir, gitUrl: 'file:///c:/tmp/x' }), /https:\/\/ or git@/);
  assert.equal(fs.existsSync(projectSettingsFile(dir)), false);
});

test('the rest of the file is preserved — it is the user’s settings, not ours', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(
    projectSettingsFile(dir),
    JSON.stringify({ 'editor.tabSize': 2, plugins: { 'acme/other': { enabled: true } } }, null, 2),
    'utf-8',
  );

  installProjectPlugin({ dir, gitUrl: GIT_URL, gitRef: 'dev' });

  const settings = read(dir);
  assert.equal(settings['editor.tabSize'], 2);
  assert.deepEqual(settings.plugins['acme/other'], { enabled: true });
  assert.equal(settings.plugins[PROJECT_PLUGIN_KEY].gitRef, 'dev');
});

test('a settings file that cannot be parsed is refused, never overwritten', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(projectSettingsFile(dir), '{ "plugins": { , }', 'utf-8');
  assert.throws(() => installProjectPlugin({ dir, gitUrl: GIT_URL }), /not valid JSON/);
  // Same rule the hook registry follows: clobbering a file we could not read loses the user's work.
  assert.equal(fs.readFileSync(projectSettingsFile(dir), 'utf-8'), '{ "plugins": { , }');
});

test('re-running is idempotent rather than additive', () => {
  const dir = tmpdir();
  installProjectPlugin({ dir, gitUrl: GIT_URL });
  installProjectPlugin({ dir, gitUrl: GIT_URL });
  assert.equal(Object.keys(read(dir).plugins).length, 1);
});

test('status reports what is there without needing Cursor to be running', () => {
  const dir = tmpdir();
  assert.deepEqual(projectPluginStatus({ dir }), {
    file: projectSettingsFile(dir),
    installed: false,
    entry: null,
  });

  installProjectPlugin({ dir, gitUrl: GIT_URL });
  const status = projectPluginStatus({ dir });
  assert.equal(status.installed, true);
  assert.equal(status.entry.gitUrl, GIT_URL);
});

test('status does not throw on a file it cannot parse', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(projectSettingsFile(dir), 'nope', 'utf-8');
  const status = projectPluginStatus({ dir });
  assert.equal(status.installed, false);
  assert.equal(status.unreadable, true);
});

test('uninstall removes only Beezi’s entry', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
  fs.writeFileSync(
    projectSettingsFile(dir),
    JSON.stringify({ 'editor.tabSize': 2, plugins: { 'acme/other': { enabled: true } } }),
    'utf-8',
  );
  installProjectPlugin({ dir, gitUrl: GIT_URL });

  const { removed } = uninstallProjectPlugin({ dir });
  assert.equal(removed, true);
  const settings = read(dir);
  assert.equal(settings['editor.tabSize'], 2);
  assert.deepEqual(Object.keys(settings.plugins), ['acme/other']);
});

test('uninstall on a file with nothing of ours is a no-op', () => {
  const dir = tmpdir();
  assert.deepEqual(uninstallProjectPlugin({ dir }).removed, false);
  assert.equal(fs.existsSync(projectSettingsFile(dir)), false);
});

test('an empty settings file is taken with the entry that created it', () => {
  const dir = tmpdir();
  installProjectPlugin({ dir, gitUrl: GIT_URL });
  uninstallProjectPlugin({ dir });
  // Leaving `{"plugins":{}}` behind would read as "this project configures plugins" forever.
  assert.equal(fs.existsSync(projectSettingsFile(dir)), false);
});
