import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  ENV_NAMES,
  LOCAL_API_BASE,
  PROD_API_BASE,
  apiBase,
  dataRootName,
  envName,
  envSuffix,
  homeDigest,
  keyringService,
  readBakedEnv,
  variantMarker,
} from '../lib/env-identity.mjs';

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every resolver takes the environment BAG (a process.env-shaped object), never a bare name, so a
// test never has to mutate the real process.env to describe a different machine.
function bag(overrides = {}) {
  return { ...overrides };
}

function tmpRoot(t, envJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-env-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (envJson !== undefined) fs.writeFileSync(path.join(dir, 'env.json'), envJson);
  return dir;
}

// ── the committed artifact ────────────────────────────────────────────────────────────────────

test('the committed env.json is production, verbatim', () => {
  // This file IS the default for every clean install: a source checkout, a prod marketplace
  // install and a hook running out of ~/.cursor/plugins all read it. A name that is not the empty
  // string here would namespace the credential store and the data root of every prod user.
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'env.json'), 'utf-8');
  assert.deepEqual(JSON.parse(raw), { name: '', apiBase: PROD_API_BASE });
  assert.equal(PROD_API_BASE, 'https://beezi-api-prod.azurewebsites.net/api');
});

test('the frozen constants are what the other lanes were handed', () => {
  assert.deepEqual(ENV_NAMES, ['local', 'dev', 'staging', 'prod']);
  // CONTRACTS spells this 3000 and then says "keep whatever config.mjs uses today for local".
  // lib/config.mjs uses 5001; preserving existing behaviour wins. See the handoff's deviations.
  assert.equal(LOCAL_API_BASE, 'http://localhost:5001/api');
});

// ── readBakedEnv ──────────────────────────────────────────────────────────────────────────────

test('readBakedEnv parses a generated variant file', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: 'dev', apiBase: 'https://dev.example.com/api' }));
  assert.deepEqual(readBakedEnv(root), { name: 'dev', apiBase: 'https://dev.example.com/api' });
});

test('readBakedEnv reads a missing file as prod WITHOUT an error', (t) => {
  // A source checkout has no env.json until this task adds one, and an absent file is not a
  // failure — it is the prod default. Reporting an error here would make every "is this variant
  // broken" check fire on a healthy tree.
  const root = tmpRoot(t);
  assert.deepEqual(readBakedEnv(root), { name: '', apiBase: null });
});

test('readBakedEnv reports malformed JSON and still resolves to prod', (t) => {
  const root = tmpRoot(t, '{ "name": "dev", ');
  const baked = readBakedEnv(root);
  assert.equal(baked.name, '');
  assert.equal(baked.apiBase, null);
  assert.equal(typeof baked.error, 'string');
  assert.ok(baked.error.length > 0);
});

test('readBakedEnv rejects a non-object document and a non-string field', (t) => {
  for (const body of ['[1,2,3]', '"dev"', 'null', '42']) {
    const root = tmpRoot(t, body);
    const baked = readBakedEnv(root);
    assert.deepEqual([baked.name, baked.apiBase], ['', null], `${body} must not become an identity`);
    assert.equal(typeof baked.error, 'string');
  }
  const root = tmpRoot(t, JSON.stringify({ name: 7, apiBase: { url: 'x' } }));
  const baked = readBakedEnv(root);
  assert.deepEqual([baked.name, baked.apiBase], ['', null]);
  assert.equal(typeof baked.error, 'string');
});

// ── envName ───────────────────────────────────────────────────────────────────────────────────

test('BEEZI_CURSOR_ENV outranks the baked name', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: 'dev', apiBase: 'https://dev.example.com/api' }));
  assert.equal(envName(bag({ BEEZI_CURSOR_ENV: 'staging' }), root), 'staging');
});

test('prod normalizes to the empty suffix from either source', (t) => {
  const prodRoot = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  assert.equal(envName(bag({ BEEZI_CURSOR_ENV: 'prod' }), prodRoot), '');
  assert.equal(envName(bag({ BEEZI_CURSOR_ENV: '' }), prodRoot), '');
  assert.equal(envName(bag(), prodRoot), '');
  const devRoot = tmpRoot(t, JSON.stringify({ name: 'prod', apiBase: PROD_API_BASE }));
  assert.equal(envName(bag(), devRoot), '');
});

test('an explicit unknown BEEZI_CURSOR_ENV is a configuration error, not another tenant', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  for (const value of ['production', 'PROD', 'Dev', ' dev', 'dev ', 'qa', 'prod;local']) {
    assert.throws(
      () => envName(bag({ BEEZI_CURSOR_ENV: value }), root),
      (error) => error instanceof ConfigError && /BEEZI_CURSOR_ENV/.test(error.message),
      `${JSON.stringify(value)} must not silently resolve`,
    );
  }
});

test('nothing an unchecked name could carry ever reaches a path, a service name or a shell', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  // These are the exact shapes that would matter downstream: a traversal segment in the data root,
  // a separator in the keychain service, a quote/semicolon in the PowerShell argument that stores
  // the token. Every one of them has to die at the allowlist, before any interpolation.
  const hostile = ['../../etc', 'dev/../prod', 'dev"; rm -rf ~', "dev'", 'dev\\prod', 'dev\nstaging', 'dev$(whoami)'];
  for (const value of hostile) {
    assert.throws(() => envName(bag({ BEEZI_CURSOR_ENV: value }), root), ConfigError, value);
    assert.throws(() => dataRootName(bag({ BEEZI_CURSOR_ENV: value }), root), ConfigError, value);
    assert.throws(() => keyringService(bag({ BEEZI_CURSOR_ENV: value }), undefined, root), ConfigError, value);
    assert.throws(() => variantMarker(bag({ BEEZI_CURSOR_ENV: value }), root), ConfigError, value);
  }
});

test('a BAKED name that is not an environment falls back to prod instead of throwing', (t) => {
  // Asymmetry on purpose. A bad env var is the operator's typo, made this second, and saying so is
  // useful. A bad env.json is inside an already-generated variant: throwing there turns every hook
  // process of that install into a crash loop, and prod is the safe read.
  const root = tmpRoot(t, JSON.stringify({ name: '../prod', apiBase: PROD_API_BASE }));
  assert.equal(envName(bag(), root), '');
  assert.equal(dataRootName(bag(), root), '.beezi-cursor');
});

test('envName defaults to the real process.env when no bag is passed', () => {
  const previous = process.env.BEEZI_CURSOR_ENV;
  process.env.BEEZI_CURSOR_ENV = 'dev';
  try {
    assert.equal(envName(), 'dev');
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_ENV;
    else process.env.BEEZI_CURSOR_ENV = previous;
  }
});

// ── apiBase ───────────────────────────────────────────────────────────────────────────────────

test('apiBase precedence: override, local opt-in, baked, prod constant', (t) => {
  const devRoot = tmpRoot(t, JSON.stringify({ name: 'dev', apiBase: 'https://dev.example.com/api' }));
  const prodRoot = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const bareRoot = tmpRoot(t);

  assert.equal(apiBase(bag({ BEEZI_API_URL: 'https://override.example.com/api' }), devRoot), 'https://override.example.com/api');
  assert.equal(apiBase(bag({ BEEZI_CURSOR_ENV: 'local' }), prodRoot), LOCAL_API_BASE);
  assert.equal(apiBase(bag(), devRoot), 'https://dev.example.com/api');
  assert.equal(apiBase(bag(), prodRoot), PROD_API_BASE);
  // No env.json at all (a plain source checkout) still talks to prod, never to localhost.
  assert.equal(apiBase(bag(), bareRoot), PROD_API_BASE);
});

test('a malformed env.json sends traffic to prod rather than nowhere', (t) => {
  const root = tmpRoot(t, 'not json');
  assert.equal(apiBase(bag(), root), PROD_API_BASE);
});

test('BEEZI_API_URL alone does not move the identity', (t) => {
  // Documented in the handoff as an operator rule: pointing at another tenant's API without also
  // setting BEEZI_CURSOR_ENV/BEEZI_CURSOR_HOME writes that tenant's data into the prod store.
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const env = bag({ BEEZI_API_URL: 'https://dev.example.com/api' });
  assert.equal(apiBase(env, root), 'https://dev.example.com/api');
  assert.equal(envName(env, root), '');
  assert.equal(dataRootName(env, root), '.beezi-cursor');
});

// ── namespaces ────────────────────────────────────────────────────────────────────────────────

test('every namespace derived from one environment agrees', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const table = [
    ['', '', '.beezi-cursor', 'beezi-cursor', 'beezi'],
    ['dev', '-dev', '.beezi-cursor-dev', 'beezi-cursor-dev', 'beezi-dev'],
    ['staging', '-staging', '.beezi-cursor-staging', 'beezi-cursor-staging', 'beezi-staging'],
    ['local', '-local', '.beezi-cursor-local', 'beezi-cursor-local', 'beezi-local'],
  ];
  for (const [name, suffix, dataRoot, service, marker] of table) {
    const env = bag(name === '' ? {} : { BEEZI_CURSOR_ENV: name });
    assert.equal(envSuffix(env, root), suffix, name);
    assert.equal(dataRootName(env, root), dataRoot, name);
    assert.equal(keyringService(env, undefined, root), service, name);
    assert.equal(variantMarker(env, root), marker, name);
  }
});

// ── homeDigest / keyringService ───────────────────────────────────────────────────────────────

test('homeDigest is 12 stable hex characters of the canonical path', () => {
  const digest = homeDigest(path.join(os.tmpdir(), 'beezi-home'));
  assert.match(digest, /^[0-9a-f]{12}$/);
  assert.equal(digest, homeDigest(path.join(os.tmpdir(), 'beezi-home')), 'must be deterministic');
  assert.notEqual(digest, homeDigest(path.join(os.tmpdir(), 'beezi-other')));
  // Relative and absolute spellings of one directory are one namespace.
  assert.equal(homeDigest(path.join(os.tmpdir(), 'x', '..', 'beezi-home')), digest);
});

test('homeDigest matches the documented sha256 construction', () => {
  const target = path.resolve(path.join(os.tmpdir(), 'beezi-home'));
  const canonical = process.platform === 'win32'
    ? target.toLowerCase().split('\\').join('/')
    : target;
  const expected = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  assert.equal(homeDigest(path.join(os.tmpdir(), 'beezi-home')), expected);
});

test('on Windows, case and slash direction name the same home', { skip: process.platform !== 'win32' }, () => {
  assert.equal(homeDigest('C:\\Users\\Dev\\.beezi-cursor'), homeDigest('c:/users/dev/.beezi-cursor'));
});

test('a custom home gets its own credential service, the default home keeps the plain one', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const custom = path.join(os.tmpdir(), 'beezi-custom-home');

  assert.equal(keyringService(bag(), undefined, root), 'beezi-cursor');
  assert.equal(
    keyringService(bag(), custom, root),
    `beezi-cursor-h${homeDigest(custom)}`,
    'a shared keychain entry across two homes is one logout deleting the other home\'s token',
  );
  assert.equal(keyringService(bag({ BEEZI_CURSOR_ENV: 'dev' }), custom, root), `beezi-cursor-dev-h${homeDigest(custom)}`);

  // An explicit BEEZI_CURSOR_HOME pointing at the DEFAULT location is still the default: suffixing
  // it would orphan the credentials the same machine stored before the variable was exported.
  const defaultHome = path.join(os.homedir(), '.beezi-cursor');
  assert.equal(keyringService(bag(), defaultHome, root), 'beezi-cursor');
  const devDefault = path.join(os.homedir(), '.beezi-cursor-dev');
  assert.equal(keyringService(bag({ BEEZI_CURSOR_ENV: 'dev' }), devDefault, root), 'beezi-cursor-dev');
  // ...and that equality is per environment: the prod home under a dev variant is a custom home.
  assert.equal(
    keyringService(bag({ BEEZI_CURSOR_ENV: 'dev' }), defaultHome, root),
    `beezi-cursor-dev-h${homeDigest(defaultHome)}`,
  );
});

test('keyringService reads BEEZI_CURSOR_HOME from the bag when no home is passed', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const custom = path.join(os.tmpdir(), 'beezi-bag-home');
  assert.equal(keyringService(bag({ BEEZI_CURSOR_HOME: custom }), undefined, root), `beezi-cursor-h${homeDigest(custom)}`);
  assert.equal(keyringService(bag({ BEEZI_CURSOR_HOME: '' }), undefined, root), 'beezi-cursor');
});

// ── parity with lib/keyring-namespace.mjs (integration step 3, §2.4) ──────────────────────────
//
// WHY THIS FILE AND WHY DIRECTLY. `lib/keyring-namespace.mjs` is the auth lane's answer to "which
// keyring namespace does this home own" and this module is the release lane's. They were written
// independently against one CONTRACTS §1 formula, in two worktrees, and the failure mode of a
// divergence is silent and total: a machine linked under a custom home reads as UNLINKED, because
// the logout and the next read address a different Credential Manager target than the login wrote.
//
// Nothing else catches it. Each lane's own tests restate the formula rather than calling the other
// side, so both can be internally consistent and mutually wrong. These cases call BOTH modules.
//
// Step 3 also made `keyring-namespace.homeDigest` a re-export of this module's, so the digest half
// is now true by construction rather than by agreement — these assertions pin that it stays that
// way. The SERVICE half is not structural and is the real subject here.

import {
  DEFAULT_SERVICE as NS_DEFAULT_SERVICE,
  defaultKeyringService as nsDefaultKeyringService,
  homeDigest as nsHomeDigest,
} from '../lib/keyring-namespace.mjs';

test('the two homeDigest implementations are byte-identical across the path matrix', () => {
  const cases = [
    path.join('C:', 'Users', 'Dev', '.beezi-cursor'),   // a Windows drive path
    path.join('C:', 'Users', 'DEV', '.Beezi-Cursor'),   // mixed case — one directory on win32
    path.join('C:', 'Users', 'Dev', '.beezi-cursor') + path.sep,  // a trailing separator
    path.join('relative', 'home'),                      // resolved against cwd, not left relative
    os.homedir(),
    path.join(os.homedir(), '.beezi-cursor'),
  ];
  for (const home of cases) {
    assert.equal(
      nsHomeDigest(home),
      homeDigest(home),
      `the digest of ${home} must be one value, not two`,
    );
    assert.match(homeDigest(home), /^[0-9a-f]{12}$/);
  }
});

test('an explicit BEEZI_CURSOR_HOME equal to the default home still yields the UNSUFFIXED service', (t) => {
  // The one input where the two sides can legitimately disagree, because the answer depends on the
  // EQUIVALENCE branch rather than on the digest: a home whose canonical path IS the default home
  // is the default home. Suffixing it would orphan the credentials the same machine stored before
  // anyone exported the variable — an existing prod install silently losing its token.
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const defaultHome = path.join(os.homedir(), '.beezi-cursor');

  for (const spelling of [
    defaultHome,
    defaultHome + path.sep,
    process.platform === 'win32' ? defaultHome.toUpperCase() : defaultHome,
  ]) {
    const env = bag({ BEEZI_CURSOR_HOME: spelling });
    assert.equal(keyringService(env, undefined, root), 'beezi-cursor', `${spelling} is the default home`);
    assert.equal(nsDefaultKeyringService(env), NS_DEFAULT_SERVICE);
    assert.equal(keyringService(env, undefined, root), nsDefaultKeyringService(env));
  }
});

test('for production both modules name the same service, unset home and custom home alike', (t) => {
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  const homes = [
    undefined,
    path.join(os.tmpdir(), 'beezi-parity-a'),
    path.join(os.tmpdir(), 'beezi-parity-b'),
    path.join(os.homedir(), '.beezi-cursor'),
  ];
  for (const home of homes) {
    const env = home === undefined ? bag() : bag({ BEEZI_CURSOR_HOME: home });
    assert.equal(
      keyringService(env, undefined, root),
      nsDefaultKeyringService(env),
      `service disagreement for home=${String(home)} — every machine on it reads as unlinked`,
    );
  }
});

test('a non-production environment is env-identity\'s half alone, and prod is untouched by it', (t) => {
  // keyring-namespace is deliberately environment-BLIND: `namespaceSuffix()` compares against it to
  // name the control-record files, and keeping that comparison blind is what makes a production
  // store's `credential-store.g<N>.json` byte-identical before and after CR-2. So the two are
  // EXPECTED to differ for dev/staging/local — that is the suffix env-identity owns, not a drift.
  const root = tmpRoot(t, JSON.stringify({ name: '', apiBase: PROD_API_BASE }));
  for (const name of ['dev', 'staging', 'local']) {
    const env = bag({ BEEZI_CURSOR_ENV: name });
    assert.equal(keyringService(env, undefined, root), `beezi-cursor-${name}`);
    assert.equal(nsDefaultKeyringService(env), 'beezi-cursor');
  }
  // And with nothing declared they agree, which is the case every installed copy is in.
  assert.equal(keyringService(bag(), undefined, root), nsDefaultKeyringService(bag()));
});
