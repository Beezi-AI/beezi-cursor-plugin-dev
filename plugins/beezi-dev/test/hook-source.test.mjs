import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HookSource,
  PLUGIN_ROOT,
  PROBE_TTL_MS,
  claimHookRun,
  hookVia,
  pluginHooksAlive,
  readHookSource,
  recordHookRun,
} from '../lib/hook-source.mjs';

function probeFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hook-source-')), 'hook-source.json');
}

const ROOT = '/plugins/cache/beezi/beezi/abc123';
const NOW = 1_770_000_000_000;

test('the --via flag is what distinguishes the two registries', () => {
  assert.equal(hookVia(['--via', 'plugin-hooks']), HookSource.PLUGIN);
  assert.equal(hookVia([]), HookSource.LAUNCHER);
  // Anything unrecognised reads as the launcher: that is the branch that checks before acting, so
  // guessing wrong there costs a redundant check rather than a silent double-run.
  assert.equal(hookVia(['--via', 'something-else']), HookSource.LAUNCHER);
  assert.equal(hookVia(['--via']), HookSource.LAUNCHER);
});

test('a bundled run records itself and always owns the run', () => {
  const file = probeFile();
  assert.equal(claimHookRun({ argv: ['--via', 'plugin-hooks'], now: NOW, file, pluginRoot: ROOT }), true);
  const probe = readHookSource({ file });
  assert.equal(probe.via, HookSource.PLUGIN);
  assert.equal(probe.pluginRoot, ROOT);
  assert.equal(probe.ts, NOW);
});

// ---------------------------------------------------------------------------
// The stand-down rule that used to live here, and why it had to go
// ---------------------------------------------------------------------------
//
// A launcher run used to exit 0 without doing anything whenever a bundled run had been recorded in
// the last PROBE_TTL_MS, on the reasoning that the bundled registry was already covering the
// machine. It is not: `cursor-agent` does not run hooks that come from an installed plugin at all,
// only `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json` (Cursor staff, forum 163890). The
// launchers ARE the CLI's only registry, so one IDE session was enough to switch the CLI's analytics
// off for a fortnight — and lib/plugin-install.mjs then deleted the launchers outright, making it
// permanent. Nothing about that was visible: the hooks reported as installed the whole time.

test('a launcher run does the work even while the bundled registry is alive', () => {
  const file = probeFile();
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: ROOT, now: NOW, file });
  // The overlap is now the permanent, intended state — both registries installed, both firing —
  // and the duplicate lines are collapsed by the reader. See test/event-dedupe.test.mjs.
  assert.equal(claimHookRun({ argv: [], now: NOW + 1000, file, pluginRoot: ROOT }), true);
});

test('one registry firing never erases the other registry’s record', () => {
  const file = probeFile();
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: ROOT, now: NOW, file });
  claimHookRun({ argv: [], now: NOW + 1000, file, pluginRoot: ROOT });

  // The launcher ran last, so that is what the top-level record says…
  assert.equal(readHookSource({ file }).via, HookSource.LAUNCHER);
  // …but the bundled registry is still known to be alive. A single shared slot would flip on every
  // tool call, which is both a lie to the status surfaces and a file write in the hottest path.
  assert.equal(pluginHooksAlive({ probe: readHookSource({ file }), now: NOW + 2000, pluginRoot: ROOT }), true);
});

test('a claim from either registry is throttled once that registry has a fresh record', () => {
  const file = probeFile();
  claimHookRun({ argv: ['--via', 'plugin-hooks'], now: NOW, file, pluginRoot: ROOT });
  claimHookRun({ argv: [], now: NOW + 1000, file, pluginRoot: ROOT });
  const before = fs.statSync(file).mtimeMs;
  // postToolUse fires on every tool call, from both registries. Neither may write here per call.
  claimHookRun({ argv: ['--via', 'plugin-hooks'], now: NOW + 2000, file, pluginRoot: ROOT });
  claimHookRun({ argv: [], now: NOW + 3000, file, pluginRoot: ROOT });
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('a bundled record older than the TTL stops vouching for the bundled registry', () => {
  const file = probeFile();
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: ROOT, now: NOW, file });
  const probe = readHookSource({ file });
  assert.equal(pluginHooksAlive({ probe, now: NOW + PROBE_TTL_MS, pluginRoot: ROOT }), true);
  // Status only — a machine that stopped discovering the bundled hooks must stop claiming they run.
  // No hook's behaviour depends on this any more.
  assert.equal(pluginHooksAlive({ probe, now: NOW + PROBE_TTL_MS + 1, pluginRoot: ROOT }), false);
});

test('a record from another copy of the plugin does not vouch for this one', () => {
  const file = probeFile();
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: '/plugins/cache/beezi/beezi/OLD', now: NOW, file });
  // An upgrade leaves the previous cache directory on disk. Its record describes that copy, not
  // this one, so the status surfaces must not report this copy's bundled hooks as proven.
  const probe = readHookSource({ file });
  assert.equal(pluginHooksAlive({ probe, now: NOW + 1000, pluginRoot: ROOT }), false);
});

test('a launcher run with no record at all does the work', () => {
  const file = probeFile();
  assert.equal(claimHookRun({ argv: [], now: NOW, file, pluginRoot: ROOT }), true);
  assert.equal(readHookSource({ file }).via, HookSource.LAUNCHER);
});

test('the record is refreshed on a timer, not on every hot-path run', () => {
  const file = probeFile();
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: ROOT, now: NOW, file });
  const before = fs.statSync(file).mtimeMs;
  // postToolUse fires on every tool call; rewriting this file each time buys nothing.
  recordHookRun({ via: HookSource.PLUGIN, pluginRoot: ROOT, now: NOW + 60_000, file });
  assert.equal(readHookSource({ file }).ts, NOW);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('a probe written before per-registry records still vouches for its registry', () => {
  const file = probeFile();
  // The shape this file had before the two registries stopped competing. An upgrade must not read
  // every existing machine as "no bundled hook has ever fired here".
  fs.writeFileSync(file, JSON.stringify({ via: HookSource.PLUGIN, pluginRoot: ROOT, ts: NOW }), 'utf-8');
  assert.equal(pluginHooksAlive({ probe: readHookSource({ file }), now: NOW + 1000, pluginRoot: ROOT }), true);
});

test('an unreadable or truncated record reads as "no record"', () => {
  const file = probeFile();
  fs.writeFileSync(file, '{ not json', 'utf-8');
  assert.equal(readHookSource({ file }), null);
  assert.equal(pluginHooksAlive({ probe: readHookSource({ file }), now: NOW, pluginRoot: ROOT }), false);
  // …and the hook keeps working rather than exiting on a corrupt bookkeeping file.
  assert.equal(claimHookRun({ argv: [], now: NOW, file, pluginRoot: ROOT }), true);
});

test('PLUGIN_ROOT resolves to the plugin directory that owns this module', () => {
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'lib', 'hook-source.mjs')));
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')));
});
