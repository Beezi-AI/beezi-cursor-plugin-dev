import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkStatus, describeLink, describeReporting, LinkState } from '../lib/link-status.mjs';

const HOOKS_ABSENT = () => ({ state: 'absent', registered: [] });

test('no token reads as not_linked without calling whoami', async () => {
  let called = 0;
  const s = await linkStatus({
    getAccessToken: async () => null,
    whoami: async () => { called += 1; return { valid: true }; },
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.NOT_LINKED);
  assert.equal(called, 0);
});

test('a valid token reports the account and the API it was checked against', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev', email: 'd@e.f' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'http://localhost:5001/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.account, 'Dev');
  assert.match(describeLink(s), /localhost:5001/);
});

test('whoami null is unreachable, not "not linked"', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => null,
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.UNREACHABLE);
  // The distinction matters: an unreachable API says nothing about the credentials, and claiming
  // otherwise is what made the status script and the sign-in tool look like they disagreed.
  assert.doesNotMatch(describeReporting(s), /not linked/i);
  assert.match(describeReporting(s), /unknown/i);
});

test('whoami invalid is revoked', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: false }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.REVOKED);
  assert.match(describeReporting(s), /revoked/i);
});

test('a linked machine with no hooks is told why nothing is reported', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /NOT being reported/);
  assert.match(describeReporting(s), /not installed/);
});

test('installed hooks still point at the restart step, since Cursor reads them at startup', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['sessionStart', 'postToolUse', 'stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /restart Cursor/);
});

test('every not-installed outcome names the exact install command', async () => {
  // Their cwd is the repository they are working in, not the plugin root, so a relative path
  // resolves to nothing — the message has to carry the absolute one.
  for (const state of ['absent', 'stale', 'partial']) {
    const s = await linkStatus({
      getAccessToken: async () => 'tok',
      whoami: async () => ({ valid: true }),
      hooksStatus: () => ({ state, registered: [] }),
      apiBase: 'https://api.test/api',
    });
    assert.match(describeReporting(s), /install\.mjs" install/, state);
  }
});

test('a broken hook registry never breaks the link check', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => { throw new Error('registry unreadable'); },
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  // Was `s.hooks.state`. `hooks` now reports the two registries separately — `{ bundled, user }` —
  // because they cover different hosts and one verdict cannot describe a machine whose IDE reports
  // and whose CLI does not. The unreadable one here is the user scope.
  assert.equal(s.hooks.user.state, 'unknown');
});

test('no message names a slash command Cursor does not have', async () => {
  for (const state of Object.values(LinkState)) {
    // Fixture updated to the `{ bundled, user }` shape — see above.
    const hooks = { bundled: false, user: { state: 'absent', registered: [] } };
    const s = { state, account: null, apiBase: 'https://api.test/api', hooks };
    for (const text of [describeLink(s), describeReporting(s)].filter(Boolean)) {
      assert.ok(!/\/beezi:/.test(text), `"${text}" names a command that does not exist`);
    }
  }
});

// ── Two registries, two hosts ───────────────────────────────────────────────────────────────────

// A machine where Cursor has discovered and run the plugin's own bundled hooks.
const BUNDLED_ALIVE = {
  pluginHooksAlive: () => true,
  readHookSource: () => ({ via: 'plugin-hooks', ts: Date.now() }),
};

test('live plugin hooks do NOT excuse an absent user-scope registry', async () => {
  // This replaces the old short-circuit outright. `hooks()` used to return `plugin-hooks` the moment
  // the bundled registry was seen firing and never read the user scope at all, and describeReporting
  // answered "nothing needs installing" — so this exact machine was reported as healthy.
  //
  // It is not healthy. `cursor-agent` does not run hooks that come from an installed plugin,
  // marketplace or local; only ~/.cursor/hooks.json fires under the CLI (Cursor staff, forum 163890,
  // still open). The absent registry below is therefore the CLI's ONLY path, and every cursor-agent
  // session on this machine records nothing at all while the IDE looks perfect.
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
    ...BUNDLED_ALIVE,
  });

  assert.equal(s.hooks.bundled, true);
  assert.equal(s.hooks.user.state, 'absent');

  const reporting = describeReporting(s);
  assert.match(reporting, /NOT being reported/, 'a live IDE registry must not read as "all good"');
  assert.match(reporting, /not installed/);
  assert.match(reporting, /install\.mjs" install/, 'the fix has to be named, not implied');
  assert.match(reporting, /cursor-agent/, 'the user has to be told WHICH host is uncovered');
});

test('both registries are reported, and neither hides the other', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['sessionStart'] }),
    apiBase: 'https://api.test/api',
    ...BUNDLED_ALIVE,
  });
  const reporting = describeReporting(s);
  assert.match(reporting, /installed/);
  assert.match(reporting, /cursor-agent/);
  assert.match(reporting, /IDE/);
});

test('a CLI-only machine is not told its hooks are broken', async () => {
  // The converse mistake. No bundled hook has ever fired here — normal on a machine that only runs
  // `cursor-agent` — and the user-scope registry is doing all the work. Nothing needs fixing.
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['sessionStart'] }),
    pluginHooksAlive: () => false,
    readHookSource: () => null,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.hooks.bundled, false);
  const reporting = describeReporting(s);
  assert.doesNotMatch(reporting, /NOT being reported/);
  assert.match(reporting, /normal/i, 'an absent bundled registry must not read as a fault');
});

test('an unreadable hook-source probe reads as "not seen", never as a live registry', async () => {
  // Conservative direction on purpose: vouching for a registry we could not confirm is what would
  // let a broken machine be reported as covered.
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: HOOKS_ABSENT,
    readHookSource: () => { throw new Error('probe unreadable'); },
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.hooks.bundled, false);
  assert.equal(s.state, LinkState.LINKED);
});
