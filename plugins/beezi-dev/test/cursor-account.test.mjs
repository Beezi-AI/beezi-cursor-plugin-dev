import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCursorPlan, readCursorAccount, CURSOR_PLANS } from '../lib/cursor-account.mjs';

const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

// A readKeys stand-in over a plain key/value map, so the suite needs neither SQLite nor Cursor.
function vscdb(pairs) {
  return {
    stateVscdbFile: '/fake/state.vscdb',
    readKeys: (_file, prefix) =>
      Object.entries(pairs)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

// A machine where the database cannot be read at all.
const NO_VSCDB = { stateVscdbFile: '/fake/state.vscdb', readKeys: () => null };

test('every mapped string resolves to its plan', () => {
  assert.equal(normalizeCursorPlan('free'), 'free');
  assert.equal(normalizeCursorPlan('hobby'), 'free');
  assert.equal(normalizeCursorPlan('free_trial'), 'free');
  assert.equal(normalizeCursorPlan('trial'), 'free');
  assert.equal(normalizeCursorPlan('pro'), 'pro');
  assert.equal(normalizeCursorPlan('pro_plus'), 'pro_plus');
  assert.equal(normalizeCursorPlan('ultra'), 'ultra');
  assert.equal(normalizeCursorPlan('team'), 'team');
  assert.equal(normalizeCursorPlan('teams'), 'team');
  assert.equal(normalizeCursorPlan('team_premium'), 'team_premium');
  assert.equal(normalizeCursorPlan('teams_premium'), 'team_premium');
  assert.equal(normalizeCursorPlan('enterprise'), 'enterprise');
});

test('every mapped result is one of the declared plans', () => {
  for (const raw of ['free', 'pro', 'pro+', 'ultra', 'teams', 'teams premium', 'enterprise', 'nonsense']) {
    assert.ok(CURSOR_PLANS.includes(normalizeCursorPlan(raw)), `${raw} -> ${normalizeCursorPlan(raw)}`);
  }
});

test('matching is case-insensitive and punctuation-tolerant', () => {
  assert.equal(normalizeCursorPlan('PRO'), 'pro');
  assert.equal(normalizeCursorPlan('  Ultra  '), 'ultra');
  assert.equal(normalizeCursorPlan('Pro Plus'), 'pro_plus');
  assert.equal(normalizeCursorPlan('pro-plus'), 'pro_plus');
  assert.equal(normalizeCursorPlan('pro+'), 'pro_plus');
  assert.equal(normalizeCursorPlan('PRO_PLUS'), 'pro_plus');
  assert.equal(normalizeCursorPlan('Teams-Premium'), 'team_premium');
});

test('anything unrecognized is unknown, never a paid tier', () => {
  for (const raw of ['mystery', 'pro_trial', 'business', 'edu', 'plus', 'max', '', '   ', '_']) {
    assert.equal(normalizeCursorPlan(raw), 'unknown', `${raw} must not map`);
  }
  assert.equal(normalizeCursorPlan(null), 'unknown');
  assert.equal(normalizeCursorPlan(undefined), 'unknown');
  assert.equal(normalizeCursorPlan({}), 'unknown');
});

test('Cursor Start is deliberately unmapped — it is non-USD and has no rate', () => {
  assert.equal(normalizeCursorPlan('start'), 'unknown');
  assert.equal(normalizeCursorPlan('Start'), 'unknown');
});

test('the plan comes from state.vscdb, with the account email', () => {
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"pro"', [EMAIL_KEY]: '"dev@example.com"' }));
  assert.equal(account.plan, 'pro');
  assert.equal(account.rawPlan, 'pro');
  assert.equal(account.source, 'state_vscdb');
  assert.equal(account.email, 'dev@example.com');
});

test('a bare (non-JSON) stored value is accepted', () => {
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: 'ultra' }));
  assert.equal(account.plan, 'ultra');
  assert.equal(account.email, null);
});

test('the CLI config answers when state.vscdb cannot be read', () => {
  const account = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ membershipType: 'ultra', email: 'cli@example.com' }),
  });
  assert.equal(account.plan, 'ultra');
  assert.equal(account.source, 'cli_config');
  assert.equal(account.email, 'cli@example.com');
});

test('the --plan self-report is the last resort', () => {
  const account = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: null,
    selfReportedPlan: 'Pro Plus',
  });
  assert.equal(account.plan, 'pro_plus');
  assert.equal(account.rawPlan, 'Pro Plus');
  assert.equal(account.source, 'self_report');
});

test('state.vscdb outranks both fallbacks when it maps', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"team"' }),
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ membershipType: 'pro' }),
    selfReportedPlan: 'ultra',
  });
  assert.equal(account.plan, 'team');
  assert.equal(account.source, 'state_vscdb');
});

test('an unmapped stored value lets a lower source answer, without losing the raw string', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"start"' }),
    cliConfigFile: null,
    selfReportedPlan: 'pro',
  });
  assert.equal(account.plan, 'pro');
  assert.equal(account.source, 'self_report');
});

test('when nothing maps, the highest-authority raw string is still surfaced as unknown', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"start"' }),
    cliConfigFile: null,
    selfReportedPlan: 'mystery-tier',
  });
  assert.equal(account.plan, 'unknown');
  assert.equal(account.rawPlan, 'start');
  assert.equal(account.source, 'state_vscdb');
});

test('no source at all yields null rather than a fabricated free plan', () => {
  assert.equal(readCursorAccount({ ...NO_VSCDB, cliConfigFile: null }), null);
});

test('a source that throws does not break the account read', () => {
  const account = readCursorAccount({
    stateVscdbFile: '/fake/state.vscdb',
    readKeys: () => {
      throw new Error('database is locked');
    },
    cliConfigFile: null,
    selfReportedPlan: 'pro',
  });
  assert.equal(account.plan, 'pro');
});

test('an unparseable CLI config is skipped, not fatal', () => {
  const account = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => 'not json{',
    selfReportedPlan: 'ultra',
  });
  assert.equal(account.plan, 'ultra');
  assert.equal(account.source, 'self_report');
});

test('a membership key present but empty is treated as absent', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '' }),
    cliConfigFile: null,
    selfReportedPlan: 'pro',
  });
  assert.equal(account.source, 'self_report');
});
