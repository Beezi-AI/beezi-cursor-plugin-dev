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

// ── identity: account id, subscription id, subscription status ─────────────────────────────────
//
// Verified key spellings, read on a real machine 2026-09-21 — see the table in lib/cursor-account.mjs.

const SIGNED_IN_KEY = 'glass.lastSignedInAuthId';
const ADMIN_ID_KEY = 'adminSettings.cachedAuthId';
const MEMBERSHIP_ID_KEY = 'cursorAuth/stripeMembershipAuthId';
const STATUS_KEY = 'cursorAuth/stripeSubscriptionStatus';

const AUTH0_ID = 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T';

test('the observed personal pro seat reads as one whole tuple', () => {
  const account = readCursorAccount(vscdb({
    [MEMBERSHIP_KEY]: '"pro"',
    [EMAIL_KEY]: '"uliana.gerek@gmail.com"',
    [MEMBERSHIP_ID_KEY]: `"${AUTH0_ID}"`,
    [STATUS_KEY]: '"active"',
    [SIGNED_IN_KEY]: `"${AUTH0_ID}"`,
    [ADMIN_ID_KEY]: `"${AUTH0_ID}"`,
  }));
  assert.equal(account.plan, 'pro');
  assert.equal(account.email, 'uliana.gerek@gmail.com');
  assert.equal(account.accountId, AUTH0_ID);
  assert.equal(account.subscriptionId, AUTH0_ID);
  assert.equal(account.status, 'active');
});

test('the signed-in id outranks the admin id', () => {
  const account = readCursorAccount(vscdb({
    [MEMBERSHIP_KEY]: '"pro"',
    [SIGNED_IN_KEY]: '"auth0|seat_signed_in"',
    [ADMIN_ID_KEY]: '"auth0|seat_admin_cache"',
  }));
  assert.equal(account.accountId, 'auth0|seat_signed_in');
});

test('the admin id answers when the signed-in key is absent', () => {
  const account = readCursorAccount(vscdb({
    [MEMBERSHIP_KEY]: '"pro"',
    [ADMIN_ID_KEY]: '"auth0|seat_admin_cache"',
  }));
  assert.equal(account.accountId, 'auth0|seat_admin_cache');
});

// THE §3.1 GUARD. On a Team plan the membership id is plausibly the PAYING OWNER's, so falling
// back to it would make every member upsert the same account_uuid — and the server's merge DELETES
// the row it absorbs, collapsing the whole team with no endpoint that undoes it. A null accountId
// costs one email-only provisional row, which the next good check-in absorbs cleanly. If this test
// ever goes red, the chain has grown a third link and the cost of that is a merged team.
test('the membership id is NEVER the account id, even when both per-seat keys are absent', () => {
  const account = readCursorAccount(vscdb({
    [MEMBERSHIP_KEY]: '"team"',
    [EMAIL_KEY]: '"member@example.com"',
    [MEMBERSHIP_ID_KEY]: '"auth0|the_paying_owner"',
    [STATUS_KEY]: '"active"',
  }));
  assert.equal(account.plan, 'team');
  assert.equal(account.accountId, null, 'the owner id must never be adopted as this seat');
  assert.equal(account.subscriptionId, 'auth0|the_paying_owner', 'but it is still kept, locally');
  assert.equal(account.email, 'member@example.com', 'the email still anchors a provisional row');
});

test('no id key at all leaves every identifier null without disturbing the plan', () => {
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"ultra"' }));
  assert.equal(account.plan, 'ultra');
  assert.equal(account.accountId, null);
  assert.equal(account.subscriptionId, null);
  assert.equal(account.status, null);
});

test('an auth0 id survives the read intact — no split on the pipe, no prefix stripped', () => {
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"pro"', [SIGNED_IN_KEY]: `"${AUTH0_ID}"` }));
  assert.equal(account.accountId, AUTH0_ID);
  assert.ok(account.accountId.startsWith('auth0|'));
});

// An SSO seat is the exact population the Team tier exists for, and its id runs far past the 64
// characters the server column holds today. Capping it here would mint a phantom subscription row
// for every such seat; the fix belongs in the column width, not in this reader.
test('a 200-character SSO id survives intact and untruncated', () => {
  const samlpId = `samlp|${new Array(101).join('c')}|${new Array(82).join('u')}@example.com`;
  assert.equal(samlpId.length, 200, 'the fixture itself must be 200 chars');
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"team_premium"', [SIGNED_IN_KEY]: JSON.stringify(samlpId) }));
  assert.equal(account.accountId, samlpId);
  assert.equal(account.accountId.length, 200);
});

test('the status is a bounded lowercase token, normalized case-insensitively', () => {
  const read = (raw) => readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"pro"', [STATUS_KEY]: raw })).status;
  assert.equal(read('"active"'), 'active');
  assert.equal(read('"PAST_DUE"'), 'past_due');
  assert.equal(read('  "trialing"  '), 'trialing');
});

// Status is EVIDENCE, never a gate. A word Stripe adds next year must cost us the word, not the
// plan — pricing a paying seat at zero on the strength of an unfamiliar spelling is the failure
// this asserts against.
test('an unrecognized status token is dropped while the plan still resolves', () => {
  for (const raw of ['"Active Until 2027"', '"incomplete-expired"', '"' + new Array(40).join('a') + '"', '"123"', '""', '"{}"']) {
    const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: '"pro"', [STATUS_KEY]: raw }));
    assert.equal(account.status, null, `${raw} must not be stored`);
    assert.equal(account.plan, 'pro', `${raw} must not suppress the plan`);
  }
});

// The legacy top-level spelling carries only an email, never an id; only `authInfo.authId` (below)
// can put an account id on a cli-config candidate. A bare self-report carries nothing.
test('a legacy top-level CLI email and a bare self-report carry no account id', () => {
  const cli = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ membershipType: 'ultra', email: 'cli@example.com' }),
  });
  assert.equal(cli.accountId, null);
  assert.equal(cli.subscriptionId, null);
  assert.equal(cli.status, null);

  const self = readCursorAccount({ ...NO_VSCDB, cliConfigFile: null, selfReportedPlan: 'pro' });
  assert.equal(self.accountId, null);
  assert.equal(self.subscriptionId, null);
  assert.equal(self.status, null);
});

test('a bare (non-JSON) id value is accepted and kept verbatim', () => {
  const account = readCursorAccount(vscdb({ [MEMBERSHIP_KEY]: 'pro', [SIGNED_IN_KEY]: AUTH0_ID }));
  assert.equal(account.accountId, AUTH0_ID);
});

// ── the CLI's nested identity (`~/.cursor/cli-config.json` → `authInfo`) ─────────────────────────
//
// VERIFIED 2026-09-24 on a real CLI machine: the identity lives at `authInfo.email` and
// `authInfo.authId` (both equal to the state.vscdb anchor on that machine), there is NO plan key
// anywhere in the file, and `authInfo` sits beside credential material. The fixture copies that
// layout, secrets included, so the no-leak assertions below are tested against the real hazard.
const CLI_AUTH_ID = 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T';
const CLI_SECRET = 'sk-cli-secret-0123456789';
const CLI_REFRESH = 'rt-cli-refresh-9876543210';
function realCliConfig(extra) {
  return JSON.stringify({
    version: 1,
    editor: { vimMode: false },
    permissions: { allow: [], deny: [] },
    authInfo: {
      email: 'Seat@Example.com',
      authId: CLI_AUTH_ID,
      accessToken: CLI_SECRET,
      refreshToken: CLI_REFRESH,
      apiKey: CLI_SECRET,
      displayName: 'Seat Holder',
    },
    ...(extra == null ? {} : extra),
  });
}
const CLI_ONLY = (extra) => ({
  ...NO_VSCDB,
  cliConfigFile: '/fake/cli-config.json',
  readFile: () => realCliConfig(extra),
});

test('a CLI-only machine with no plan key still yields its identity', () => {
  const account = readCursorAccount(CLI_ONLY());
  assert.notEqual(account, null, 'an identity with no plan is still an answer — it is the anchor');
  assert.equal(account.accountId, CLI_AUTH_ID, 'kept verbatim, provider prefix and all');
  assert.equal(account.email, 'Seat@Example.com');
  assert.equal(account.source, 'cli_config');
  // No plan was read, so none is claimed: `unknown`, never a fabricated tier, and no raw string for
  // the server's alias-discovery loop to mistake for a tier name.
  assert.equal(account.plan, 'unknown');
  assert.equal(account.rawPlan, null);
  assert.equal(account.subscriptionId, null);
  assert.equal(account.status, null);
});

test('nothing but email and authId ever leaves cli-config.json — no token, no other field', () => {
  const account = readCursorAccount(CLI_ONLY());
  // The exact key set: a reader that spread `authInfo` would add accessToken/refreshToken here.
  assert.deepEqual(Object.keys(account).sort(), ['accountId', 'email', 'plan', 'rawPlan', 'source', 'status', 'subscriptionId']);
  const serialized = JSON.stringify(account);
  for (const secret of [CLI_SECRET, CLI_REFRESH, 'Seat Holder', 'accessToken', 'refreshToken', 'apiKey']) {
    assert.equal(serialized.includes(secret), false, `${secret} must never be read into the account`);
  }
});

test('the nested identity outranks the legacy top-level email, which stays a fallback', () => {
  const nested = readCursorAccount(CLI_ONLY({ email: 'legacy@example.com' }));
  assert.equal(nested.email, 'Seat@Example.com');

  const legacy = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ email: 'legacy@example.com' }),
  });
  assert.equal(legacy.email, 'legacy@example.com');
  assert.equal(legacy.accountId, null, 'there is no top-level id spelling to fall back to');
});

test('a cli-config with neither plan nor identity is still no answer', () => {
  const account = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ version: 1, authInfo: { accessToken: CLI_SECRET } }),
  });
  assert.equal(account, null);
});

test('a non-string authId or email is ignored, not coerced', () => {
  const account = readCursorAccount({
    ...NO_VSCDB,
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => JSON.stringify({ authInfo: { authId: 12345, email: { nested: true } } }),
  });
  assert.equal(account, null);
});

test('a self-reported plan takes its identity from cli-config', () => {
  const account = readCursorAccount({ ...CLI_ONLY(), selfReportedPlan: 'pro' });
  assert.equal(account.plan, 'pro', 'the plan comes from the self-report');
  // The winner's source is KEPT: `selfReported` and the staleness exemption key off it, and the
  // identity donor must not be able to relabel a typed plan as a host read.
  assert.equal(account.source, 'self_report');
  assert.equal(account.accountId, CLI_AUTH_ID, 'the identity comes from cli-config');
  assert.equal(account.email, 'Seat@Example.com');
  assert.equal(JSON.stringify(account).includes(CLI_SECRET), false);
});

test('an unmapped self-report still surfaces its raw string, with the cli-config identity', () => {
  const account = readCursorAccount({ ...CLI_ONLY(), selfReportedPlan: 'mystery-tier' });
  assert.equal(account.plan, 'unknown');
  assert.equal(account.rawPlan, 'mystery-tier', 'an identity-only candidate has no raw plan to win with');
  assert.equal(account.source, 'self_report');
  assert.equal(account.accountId, CLI_AUTH_ID);
});

test('a state.vscdb identity is never overwritten by the CLI one', () => {
  // The IDE and the CLI can be signed into different accounts. Mixing them would attribute one
  // account's plan to the other's id, so the donor only fills a winner that identifies nobody.
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"pro"', [EMAIL_KEY]: '"ide@example.com"', [SIGNED_IN_KEY]: 'auth0|ide_seat' }),
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => realCliConfig(),
  });
  assert.equal(account.source, 'state_vscdb');
  assert.equal(account.email, 'ide@example.com');
  assert.equal(account.accountId, 'auth0|ide_seat');
});

test('a state.vscdb email with no id is not topped up with the CLI id', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"pro"', [EMAIL_KEY]: '"ide@example.com"' }),
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => realCliConfig(),
  });
  assert.equal(account.email, 'ide@example.com');
  assert.equal(account.accountId, null, 'half an identity from each source is no identity at all');
});

test('an unmapped state.vscdb tier still wins over an identity-only cli-config', () => {
  const account = readCursorAccount({
    ...vscdb({ [MEMBERSHIP_KEY]: '"start"', [EMAIL_KEY]: '"ide@example.com"' }),
    cliConfigFile: '/fake/cli-config.json',
    readFile: () => realCliConfig(),
  });
  assert.equal(account.rawPlan, 'start');
  assert.equal(account.source, 'state_vscdb');
  assert.equal(account.email, 'ide@example.com');
  // This is the case that actually REACHES the donor (the loop did not break on a mapped plan), so
  // it is the one that proves half an identity from each source is never stitched into one anchor.
  assert.equal(account.accountId, null);
});
