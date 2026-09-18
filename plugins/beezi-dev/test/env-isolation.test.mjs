import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  LOCAL_API_BASE,
  PROD_API_BASE,
  apiBase,
  dataRootName,
  envName,
  envSuffix,
  homeDigest,
  keyringService,
  readBakedEnv,
} from '../lib/env-identity.mjs';

// ┌─ TASK 05-A ACCEPTANCE CHECKS ─────────────────────────────────────────────────────────────────┐
// │ M10 owns the implementation of environment identity; M05 owns these checks. They ran first     │
// │ against test/helpers/env-identity-contract.mjs, a local mirror of CONTRACTS §1 that existed    │
// │ only so this file could run before the release lane's module did. INTEGRATION (step 1) pointed │
// │ the import at the real `../lib/env-identity.mjs` and deleted the mirror.                       │
// │                                                                                                │
// │ The real module takes the ENVIRONMENT BAG and a PLUGIN ROOT — it reads the baked identity off  │
// │ disk rather than taking it as an argument — so every call below that the mirror answered with  │
// │ a `baked` object now names a temp directory built by `bakedRoot()`. The assertions themselves  │
// │ are unchanged, with one exception recorded at its own test: the mirror reported an `error` for │
// │ a MISSING env.json and the shipped module deliberately does not.                               │
// │                                                                                                │
// │ What is being checked, and why it is M05's to check: auth, the queue and reporting all resolve │
// │ their destination through this identity. If two variants can see one queue directory or one    │
// │ credential entry, a staging launch delivers production data — or deletes it — and no amount of │
// │ endpoint correctness downstream can undo that.                                                 │
// │                                                                                                │
// │ NOT checked here, deliberately: `apiBase()` resolution and the baked env.json fixtures. Those  │
// │ are the release lane's own steps, and a second guess at the endpoint is precisely the          │
// │ disagreement this packet exists to prevent. This file checks ISOLATION only.                   │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘

const ENVS = ['', 'dev', 'staging', 'local'];
const HOME_BASE = path.join('C:', 'Users', 'someone');

// A plugin root holding exactly the baked identity a case describes. `undefined` means NO env.json
// at all (a source checkout, and the prod default).
//
// One directory per call, never shared: `readBakedEnv` memoizes by resolved path for the life of
// the process and nothing invalidates that cache, so two cases with different contents must not
// share a root.
function bakedRoot(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-env-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'env.json'), contents);
  return dir;
}

// Shorthand for "a root with no baked identity", which is most of the cases below.
const noBaked = (t) => bakedRoot(t, undefined);

// The environment bag that names an environment explicitly. The resolvers read the name off the
// bag; a bare name is never an argument.
const declaring = (name, rest = {}) => (name === '' ? { ...rest } : { BEEZI_CURSOR_ENV: name, ...rest });

// The three store paths a variant must not share, derived exactly as lib/paths-cursor.mjs derives
// them today — home root, then a fixed child directory.
function storePaths(env, { home = null } = {}) {
  const root = home == null ? path.join(HOME_BASE, dataRootName(declaring(env))) : home;
  return {
    root,
    queue: path.join(root, 'queue'),
    state: path.join(root, 'state'),
    events: path.join(root, 'events'),
    credentialService: keyringService(declaring(env), home),
  };
}

// ─── environment resolution ─────────────────────────────────────────────────────────────────────

test('no override and no baked name resolves to prod, spelled as the empty name', (t) => {
  const bare = noBaked(t);
  assert.equal(envName({}, bare), '');
  assert.equal(envName({ BEEZI_CURSOR_ENV: '' }, bare), '');
  assert.equal(envName({}, bakedRoot(t, JSON.stringify({ name: '' }))), '');
});

test('BEEZI_CURSOR_ENV takes precedence over the baked name', (t) => {
  const bakedDev = bakedRoot(t, JSON.stringify({ name: 'dev' }));
  assert.equal(envName({ BEEZI_CURSOR_ENV: 'staging' }, bakedDev), 'staging');
  assert.equal(envName({}, bakedDev), 'dev');
});

test('an unrecognized environment name is refused, never silently invented', (t) => {
  // A typo must not mint a fourth store, a fourth keyring entry and a fourth endpoint that nobody
  // is watching. It also must not silently fall back to prod, which would point a mistyped staging
  // launch at production data.
  const bare = noBaked(t);
  assert.throws(() => envName({ BEEZI_CURSOR_ENV: 'stagng' }, bare), ConfigError);
  assert.throws(() => envName({ BEEZI_CURSOR_ENV: 'production' }, bare), ConfigError);
});

test('an unrecognized name INSIDE an installed variant degrades to prod instead of crashing it', (t) => {
  // The one place the mirror and the shipped module part company on purpose, and the shipped
  // behaviour is the safer one: env.json lives inside an already-installed copy on a user's
  // machine, so a throw here is a crash loop in every hook process, not a message anyone reads.
  // An operator-typed BEEZI_CURSOR_ENV still throws (above) — that one they can fix in a second.
  assert.equal(envName({}, bakedRoot(t, JSON.stringify({ name: 'qa' }))), '');
});

test('prod is accepted under its own name and still resolves to the unsuffixed identity', (t) => {
  assert.equal(envName({ BEEZI_CURSOR_ENV: 'prod' }, noBaked(t)), '');
});

// ─── endpoint resolution ────────────────────────────────────────────────────────────────────────
//
// The source defaults to localhost today (`lib/config.mjs` returns `http://localhost:5001/api` when
// BEEZI_API_URL is unset), which is PIPE-01: a shipped build reports to nothing. These checks pin
// the four rungs of CONTRACTS §1's precedence ladder so the release lane's implementation cannot
// quietly resolve to a fifth answer.

test('no override and no baked apiBase resolves to the production URL', (t) => {
  assert.equal(apiBase({}, noBaked(t)), PROD_API_BASE);
  assert.doesNotMatch(PROD_API_BASE, /localhost/, 'the default must not be a developer machine');
});

test('the local environment resolves to the localhost URL, baked value or not', (t) => {
  assert.equal(apiBase({ BEEZI_CURSOR_ENV: 'local' }, noBaked(t)), LOCAL_API_BASE);
  assert.equal(
    apiBase({}, bakedRoot(t, JSON.stringify({ name: 'local', apiBase: 'https://someone-elses-host/api' }))),
    LOCAL_API_BASE,
    'local is a fixed destination — a baked URL must not point `local` at a real deployment',
  );
});

test('a baked staging URL is used when nothing overrides it', (t) => {
  const baked = { name: 'staging', apiBase: 'https://beezi-api-staging.azurewebsites.net/api' };
  const root = bakedRoot(t, JSON.stringify(baked));
  assert.equal(envName({}, root), 'staging', 'the name comes off the baked file, not the bag');
  assert.equal(apiBase({}, root), baked.apiBase);
});

test('BEEZI_API_URL wins over the baked value, the environment default and prod', (t) => {
  const env = { BEEZI_API_URL: 'http://127.0.0.1:8080/api' };
  const baked = { name: 'staging', apiBase: 'https://beezi-api-staging.azurewebsites.net/api' };
  const bare = noBaked(t);
  assert.equal(apiBase(env, bakedRoot(t, JSON.stringify(baked))), env.BEEZI_API_URL);
  assert.equal(apiBase(declaring('local', env), bare), env.BEEZI_API_URL, 'an explicit override outranks even local');
  assert.equal(apiBase(env, bare), env.BEEZI_API_URL);
});

test('malformed baked JSON resolves to prod and surfaces the error, it never invents an endpoint', (t) => {
  const root = bakedRoot(t, '{ "name": "stag');
  const record = readBakedEnv(root);
  assert.deepEqual(
    { name: record.name, apiBase: record.apiBase },
    { name: '', apiBase: null },
    'a file that will not parse yields no name and no endpoint',
  );
  assert.ok(record.error, 'the failure is reported, not swallowed');
  // And the empty name is prod, not a throw: a broken baked file must not make the plugin unusable.
  assert.equal(envName({}, root), '');
  assert.equal(apiBase({}, root), PROD_API_BASE);
});

test('a missing baked file resolves like a malformed one, but is NOT reported as a failure', (t) => {
  // MOVED PREMISE (integration step 1). The mirror this file used to import reported an `error` for
  // an absent env.json as well as for an unparseable one. The shipped module deliberately does not:
  // a source checkout and the prod artifact both read that way, so flagging it would make every
  // healthy tree look broken. The RESOLUTION is identical — no name, no endpoint, prod — and that
  // is what this file exists to pin; the presence of a diagnostic string is the release lane's
  // call, and it made it in the other direction.
  const root = bakedRoot(t, undefined);
  const record = readBakedEnv(root);
  assert.equal(record.name, '');
  assert.equal(record.apiBase, null);
  assert.equal(record.error, undefined, 'an absent env.json is the prod default, not a fault');
  assert.equal(apiBase({}, root), PROD_API_BASE);
});

test('a baked file with an unusable apiBase falls through to prod rather than to localhost', (t) => {
  for (const bad of [null, '', 42, 'not a url', {}]) {
    const root = bakedRoot(t, JSON.stringify({ name: '', apiBase: bad }));
    assert.equal(readBakedEnv(root).apiBase, null, `apiBase=${JSON.stringify(bad)} must not become an endpoint`);
    assert.equal(apiBase({}, root), PROD_API_BASE, `apiBase=${JSON.stringify(bad)}`);
  }
});

// ─── prod keeps its established names ───────────────────────────────────────────────────────────

test('prod keeps the unsuffixed root and service, so an upgrade reads the existing store', () => {
  assert.equal(envSuffix(declaring('')), '');
  assert.equal(dataRootName(declaring('')), '.beezi-cursor');
  assert.equal(keyringService(declaring('')), 'beezi-cursor');
});

test('every variant is suffixed and prod alone is not', () => {
  assert.deepEqual(
    ENVS.map((env) => dataRootName(declaring(env))),
    ['.beezi-cursor', '.beezi-cursor-dev', '.beezi-cursor-staging', '.beezi-cursor-local'],
  );
  assert.deepEqual(
    ENVS.map((env) => keyringService(declaring(env))),
    ['beezi-cursor', 'beezi-cursor-dev', 'beezi-cursor-staging', 'beezi-cursor-local'],
  );
});

// ─── the isolation itself ───────────────────────────────────────────────────────────────────────

test('queue, state, events and the credential service all differ across the four environments', () => {
  for (const key of ['root', 'queue', 'state', 'events', 'credentialService']) {
    const values = ENVS.map((env) => storePaths(env)[key]);
    assert.equal(
      new Set(values).size,
      ENVS.length,
      `${key} collides across environments: ${JSON.stringify(values)}`,
    );
  }
});

test('a staging launch cannot name, read or delete a production path', () => {
  const prod = storePaths('');
  const staging = storePaths('staging');

  for (const key of ['root', 'queue', 'state', 'events']) {
    assert.notEqual(staging[key], prod[key]);
    // Not merely different: neither may CONTAIN the other, or a recursive prune under one would
    // walk into the other's records.
    assert.equal(staging[key].startsWith(prod[key] + path.sep), false, `${key} nests under prod`);
    assert.equal(prod[key].startsWith(staging[key] + path.sep), false, `${key} nests under staging`);
  }
  assert.notEqual(staging.credentialService, prod.credentialService);
});

test('the prod service is a STRING PREFIX of every variant, so lookups must be exact', () => {
  // This is the hazard, stated as a test rather than left as a comment: `beezi-cursor` is a prefix
  // of `beezi-cursor-dev`, so any credential lookup that matches on a prefix — a `secret-tool`
  // search, a `cmdkey /list` scan, a startsWith over stored service names — would hand a dev launch
  // the production token. The names are distinct; the MATCH has to be too.
  const prod = keyringService(declaring(''));
  for (const env of ['dev', 'staging', 'local']) {
    const service = keyringService(declaring(env));
    assert.notEqual(service, prod);
    assert.equal(service.startsWith(`${prod}-`), true, `${service} must remain prefixed by ${prod}`);
  }
  assert.equal(new Set(ENVS.map((env) => keyringService(declaring(env)))).size, ENVS.length);
});

// ─── explicit custom homes ──────────────────────────────────────────────────────────────────────

test('a custom home isolates credentials even when two variants share the directory', () => {
  // Pointing two variants at one BEEZI_CURSOR_HOME defeats FILESYSTEM isolation by the user's own
  // instruction — that is documented, not prevented. The credential service must still separate
  // them, because a shared keyring entry would let one variant read the other's account token.
  const shared = path.join(HOME_BASE, 'shared-beezi-home');
  const dev = storePaths('dev', { home: shared });
  const staging = storePaths('staging', { home: shared });

  assert.equal(dev.queue, staging.queue, 'the shared directory is shared, as instructed');
  assert.notEqual(dev.credentialService, staging.credentialService, 'the credentials must not be');
});

test('a custom home scopes the service per directory, and identically for the same path', () => {
  const a = keyringService(declaring(''), path.join(HOME_BASE, 'home-a'));
  const b = keyringService(declaring(''), path.join(HOME_BASE, 'home-b'));
  assert.notEqual(a, b);
  assert.equal(a, keyringService(declaring(''), path.join(HOME_BASE, 'home-a')), 'the same home must be stable across runs');
  assert.match(a, /^beezi-cursor-h[0-9a-f]{12}$/);
  assert.notEqual(a, keyringService(declaring('')), 'a custom home is never the default store');
});

test('the home digest canonicalizes the path so one directory is one identity', () => {
  const canonical = path.join(HOME_BASE, 'home-a');
  const trailing = `${canonical}${path.sep}`;
  assert.equal(homeDigest(canonical), homeDigest(trailing), 'a trailing separator is the same directory');
  if (process.platform === 'win32') {
    assert.equal(homeDigest(canonical), homeDigest(canonical.toUpperCase()), 'Windows paths are case-insensitive');
  }
});

// ─── no automatic migration ─────────────────────────────────────────────────────────────────────

test('nothing in the identity contract maps one environment onto another', () => {
  // There is no "inherit prod credentials" path by construction: the service name is a pure
  // function of (env, customHome) and every input produces its own value. Reverting a variant
  // therefore cannot merge its credentials or queue into prod — there is nothing to merge through.
  const derived = ENVS.map((env) => keyringService(declaring(env), null));
  assert.equal(derived.filter((s) => s === 'beezi-cursor').length, 1, 'exactly one environment owns the prod service');
});
