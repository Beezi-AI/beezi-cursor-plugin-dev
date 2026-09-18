import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  aiCodeTrackingDbFile,
  beeziCursorHome,
  billingConfigFile,
  credentialsFile,
  cursorConfigDir,
  cursorHooksFile,
  cursorPluginDir,
  cursorProjectsDir,
  eventsDir,
  hookLauncherDir,
  pendingBatchFile,
  pendingDir,
  queueDir,
  repoMapFile,
  sessionStateFile,
  stateDir,
  syncStateFile,
} from '../lib/paths-cursor.mjs';

// Swap an env var for one test and put it back, whether or not it was set.
function withEnv(t, name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

const everyStore = () => [
  beeziCursorHome(),
  queueDir(),
  stateDir(),
  eventsDir(),
  repoMapFile(),
  credentialsFile(),
  billingConfigFile(),
  hookLauncherDir(),
];

test("the data root is this agent's own, not the shared ~/.beezi", (t) => {
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  assert.equal(beeziCursorHome(), path.join(os.homedir(), '.beezi-cursor'));
});

test('no store lands inside another agent plugin\'s data root', (t) => {
  // All three plugins write the same filenames — queue/, state/, billing.json, repo-map.json,
  // credentials.json. Sharing a root means one agent's queued segments flushed under the other's
  // identity, and whichever captured a plan last winning billing.json for both.
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  const foreign = [path.join(os.homedir(), '.beezi'), path.join(os.homedir(), '.beezi-codex')];
  for (const p of everyStore()) {
    for (const root of foreign) {
      assert.ok(
        !(p === root || p.startsWith(root + path.sep)),
        `${p} is inside ${root}, another plugin's data root`,
      );
    }
  }
});

test('BEEZI_HOME does not relocate this plugin', (t) => {
  // Honouring it would restore the collision on exactly the machines that set it: one variable
  // pointing every agent at one directory.
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  withEnv(t, 'BEEZI_HOME', path.join(os.tmpdir(), 'shared-beezi'));
  assert.equal(beeziCursorHome(), path.join(os.homedir(), '.beezi-cursor'));
});

test('BEEZI_CODEX_HOME does not relocate this plugin either', (t) => {
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  withEnv(t, 'BEEZI_CODEX_HOME', path.join(os.tmpdir(), 'codex-beezi'));
  assert.equal(beeziCursorHome(), path.join(os.homedir(), '.beezi-cursor'));
});

test('BEEZI_CURSOR_HOME relocates every store together', (t) => {
  const dir = path.join(os.tmpdir(), 'beezi-cursor-home-test');
  withEnv(t, 'BEEZI_CURSOR_HOME', dir);
  assert.equal(beeziCursorHome(), dir);
  for (const p of everyStore()) {
    assert.ok(p === dir || p.startsWith(dir + path.sep), `${p} ignored BEEZI_CURSOR_HOME`);
  }
});

test('the sidecar lives under the plugin root, in its own directory', (t) => {
  const dir = path.join(os.tmpdir(), 'beezi-cursor-events-test');
  withEnv(t, 'BEEZI_CURSOR_HOME', dir);
  assert.equal(eventsDir(), path.join(dir, 'events'));
});

// One owner for the `<name>.json under state/` shape. lib/checkpoint.mjs writes these files and
// lib/sidecar-index.mjs reads them for the backfill's live-cursor belt; a reader that spelled the
// path differently from the writer would see `cursor: 0` forever and re-upload sessions live
// tracking already sent.
test('sessionStateFile is <name>.json under the state directory', (t) => {
  const dir = path.join(os.tmpdir(), 'beezi-cursor-state-test');
  withEnv(t, 'BEEZI_CURSOR_HOME', dir);
  assert.equal(sessionStateFile('conv-1'), path.join(stateDir(), 'conv-1.json'));
});

// It takes an ALREADY-SANITIZED name and does not sanitize: the plugin's one sanitizer for an
// untrusted conversation id is safeName in lib/sidecar.mjs, and this module cannot import it
// (sidecar imports paths-cursor, so the arrow points one way only). Both callers run safeName
// themselves. Asserted so nobody hands this a raw id believing it is guarded.
test('sessionStateFile joins only — sanitation belongs to its caller', (t) => {
  const dir = path.join(os.tmpdir(), 'beezi-cursor-state-test');
  withEnv(t, 'BEEZI_CURSOR_HOME', dir);
  assert.equal(sessionStateFile('a_b'), path.join(stateDir(), 'a_b.json'));
});

test('cursorConfigDir resolves CURSOR_CONFIG_DIR -> XDG_CONFIG_HOME/cursor -> ~/.cursor', (t) => {
  withEnv(t, 'CURSOR_CONFIG_DIR', undefined);
  withEnv(t, 'XDG_CONFIG_HOME', undefined);
  assert.equal(cursorConfigDir(), path.join(os.homedir(), '.cursor'));

  process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'xdg');
  assert.equal(cursorConfigDir(), path.join(os.tmpdir(), 'xdg', 'cursor'));

  process.env.CURSOR_CONFIG_DIR = path.join(os.tmpdir(), 'explicit');
  assert.equal(cursorConfigDir(), path.join(os.tmpdir(), 'explicit'));
});

test('the XDG branch has no OS guard — it fires on every platform, deliberately', (t) => {
  // Documented, intended behaviour: a developer who exports XDG_CONFIG_HOME on Windows or macOS
  // genuinely relocates Cursor's config there, and guarding this by platform would point the
  // plugin at a directory Cursor is not using. Asserted so nobody "fixes" it.
  withEnv(t, 'CURSOR_CONFIG_DIR', undefined);
  withEnv(t, 'XDG_CONFIG_HOME', path.join(os.tmpdir(), 'xdg-anyplatform'));
  assert.equal(cursorConfigDir(), path.join(os.tmpdir(), 'xdg-anyplatform', 'cursor'));
});

test('ai-code-tracking.db ignores CURSOR_CONFIG_DIR and XDG_CONFIG_HOME', (t) => {
  // Cursor's tracker writes it to the real home directory regardless, so resolving it through
  // cursorConfigDir() would look in a directory that is empty on exactly the machines that
  // relocate their config.
  withEnv(t, 'CURSOR_CONFIG_DIR', path.join(os.tmpdir(), 'elsewhere'));
  withEnv(t, 'XDG_CONFIG_HOME', path.join(os.tmpdir(), 'xdg'));
  assert.equal(aiCodeTrackingDbFile(), path.join(os.homedir(), '.cursor', 'ai-code-tracking.db'));
});

test('the plugin dir, hooks file and projects dir hang off the resolved config root', (t) => {
  const root = path.join(os.tmpdir(), 'cursor-cfg');
  withEnv(t, 'CURSOR_CONFIG_DIR', root);
  withEnv(t, 'CURSOR_DATA_DIR', undefined);
  assert.equal(cursorPluginDir(), path.join(root, 'plugins', 'local', 'beezi'));
  assert.equal(cursorHooksFile(), path.join(root, 'hooks.json'));
  // projects follows CURSOR_DATA_DIR, a different variable — a machine may set one and not the other.
  assert.equal(cursorProjectsDir(), path.join(os.homedir(), '.cursor', 'projects'));

  process.env.CURSOR_DATA_DIR = path.join(os.tmpdir(), 'cursor-data');
  assert.equal(cursorProjectsDir(), path.join(os.tmpdir(), 'cursor-data', 'projects'));
});

// ─── environment variants coexist (integration step 1: R-1 + R-2) ───────────────────────────────

test('an environment variant gets its own data root and its own materialized plugin dir', (t) => {
  // The two builders R-1 and R-2 rewire. Unsuffixed they are ONE directory for every variant, so
  // installing dev overwrites the prod copy prod's launchers execute, and uninstalling dev deletes
  // it. The suffix is the whole isolation.
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  withEnv(t, 'BEEZI_CURSOR_ENV', 'dev');
  const root = path.join(os.tmpdir(), 'cursor-cfg-dev');
  withEnv(t, 'CURSOR_CONFIG_DIR', root);
  assert.equal(beeziCursorHome(), path.join(os.homedir(), '.beezi-cursor-dev'));
  assert.equal(cursorPluginDir(), path.join(root, 'plugins', 'local', 'beezi-dev'));
});

test('with no environment declared both builders are byte-identical to the pre-variant spelling', (t) => {
  // The upgrade path, stated as a test: a production install that predates variants must keep
  // reading `~/.beezi-cursor` and executing out of `plugins/local/beezi`. A suffix appearing here
  // would orphan every queued segment, every state cursor and the launchers already on disk.
  withEnv(t, 'BEEZI_CURSOR_HOME', undefined);
  withEnv(t, 'BEEZI_CURSOR_ENV', undefined);
  const root = path.join(os.tmpdir(), 'cursor-cfg-prod');
  withEnv(t, 'CURSOR_CONFIG_DIR', root);
  assert.equal(beeziCursorHome(), path.join(os.homedir(), '.beezi-cursor'));
  assert.equal(cursorPluginDir(), path.join(root, 'plugins', 'local', 'beezi'));
});

test('an explicit BEEZI_CURSOR_HOME is honoured exactly, with no environment suffix appended', (t) => {
  // An explicit home is the operator saying where the store IS. Relocating it per environment
  // would strand the data already there — and a test harness that sets it would silently stop
  // isolating anything.
  const home = path.join(os.tmpdir(), 'explicit-beezi-home');
  withEnv(t, 'BEEZI_CURSOR_HOME', home);
  withEnv(t, 'BEEZI_CURSOR_ENV', 'staging');
  assert.equal(beeziCursorHome(), home);
});


// ─── the pending batch and the sync-state file (integration step 2: R-3, R-4) ───────────────────

test('pendingBatchFile — <home>/pending/<name>.json, and it is NOT under state/', (t) => {
  const home = path.join(os.tmpdir(), 'beezi-pending-shape');
  withEnv(t, 'BEEZI_CURSOR_HOME', home);
  assert.equal(pendingBatchFile('conv-1'), path.join(home, 'pending', 'conv-1.json'));
  assert.equal(path.dirname(pendingBatchFile('conv-1')), pendingDir());
  // `state/<id>.json` is committed truth and `pending/<id>.json` is intent. Sharing a directory
  // would make the recovery scan read one as the other.
  assert.notEqual(path.dirname(pendingBatchFile('conv-1')), stateDir());
  // The shape must move with BEEZI_CURSOR_HOME like every other builder, or a custom home
  // recovers batches from the default home's directory.
  assert.ok(pendingBatchFile('conv-1').startsWith(home));
});

test('sync-state.json sits at the home ROOT, outside every directory pruneStale walks', (t) => {
  // A 14-day expiry on sync progress would make every run re-ask coverage for the whole machine.
  const home = path.join(os.tmpdir(), 'beezi-sync-state-shape');
  withEnv(t, 'BEEZI_CURSOR_HOME', home);
  assert.equal(syncStateFile(), path.join(home, 'sync-state.json'));
  for (const swept of [stateDir(), queueDir(), eventsDir(), pendingDir()]) {
    assert.notEqual(path.dirname(syncStateFile()), swept, `sync progress must not live under ${swept}`);
  }
});
