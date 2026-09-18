import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLoginPreflight, PreflightCode } from '../lib/login-preflight.mjs';
import { performLogin } from '../lib/login.mjs';
import { commitCredentials, readCredentialRecord, getCredentials, setCredentials, CredentialStatus } from '../lib/credentials.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const installedHooks = () => ({ state: 'installed', registered: ['stop'] });

function preflightDeps(over = {}) {
  return {
    hooksStatus: installedHooks,
    ensureInstalled: () => ({ source: 'launcher', actions: [] }),
    ...over,
  };
}

// ── the storage probe ────────────────────────────────────────────────────────

test('a writable root passes and leaves nothing behind', async (t) => {
  const dir = tmpHome(t);
  const result = await runLoginPreflight({ deps: preflightDeps() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('preflight'));
  assert.deepEqual(leftovers, [], 'the temporary probe cleaned itself up');
});

test('a missing parent directory is created rather than reported as a failure', async (t) => {
  const dir = tmpHome(t);
  const nested = path.join(dir, 'deep', 'deeper');
  const result = await runLoginPreflight({ roots: [nested], deps: preflightDeps() });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(nested), true);
});

test('a root that cannot be written blocks the sign-in and names the directory', async (t) => {
  tmpHome(t);
  const failing = {
    mkdirSync: () => {},
    openSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; },
    writeSync: () => {},
    closeSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
  };
  const result = await runLoginPreflight({ roots: ['/no/such/root'], deps: preflightDeps({ fsImpl: failing }) });
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].code, PreflightCode.STORAGE_UNWRITABLE);
  assert.equal(result.blocking[0].path, '/no/such/root');
  assert.equal(result.blocking[0].detail, 'EACCES');
});

test('a directory that exists but refuses a rename also blocks', async (t) => {
  tmpHome(t);
  const written = [];
  const failing = {
    mkdirSync: () => {},
    openSync: (p) => { written.push(p); return 1; },
    writeSync: () => {},
    closeSync: () => {},
    renameSync: () => { const e = new Error('read-only'); e.code = 'EROFS'; throw e; },
    unlinkSync: () => {},
  };
  const result = await runLoginPreflight({ roots: ['/read/only'], deps: preflightDeps({ fsImpl: failing }) });
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].detail, 'EROFS');
});

test('the probe never touches the credential store', async (t) => {
  tmpHome(t);
  await commitCredentials({
    client_id: 'cid', token_endpoint: 't', access_token: 'at', refresh_token: 'rt', expires_at: 4_000_000_000_000,
  }, { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });
  const before = await readCredentialRecord({ platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });

  await runLoginPreflight({ deps: preflightDeps() });

  const after = await readCredentialRecord({ platform: 'sunos', run: () => ({ ok: false, stdout: '' }) });
  assert.equal(after.generation, before.generation);
  assert.equal(after.creds.access_token, 'at');
});

// ── hooks: repairable, not a reason to refuse a first login ──────────────────

test('installed hooks report ok and need no restart', async (t) => {
  tmpHome(t);
  const result = await runLoginPreflight({ deps: preflightDeps() });
  assert.deepEqual(result.hooks, { status: 'ok', restartRequired: false });
});

// A first-ever sign-in has no hooks by definition. Refusing it would make the plugin impossible to
// set up; the normal repair path is called and the user is told to restart Cursor.
test('a first install is repaired through the normal path and asks for a restart', async (t) => {
  tmpHome(t);
  let repaired = 0;
  const states = [{ state: 'absent', registered: [] }, { state: 'installed', registered: ['stop'] }];
  const result = await runLoginPreflight({
    deps: preflightDeps({
      hooksStatus: () => states.shift() || installedHooks(),
      ensureInstalled: () => { repaired += 1; return { source: 'launcher', actions: ['user-hooks-installed:absent'] }; },
    }),
  });
  assert.equal(repaired, 1);
  assert.equal(result.ok, true, 'missing hooks never block a sign-in');
  assert.deepEqual(result.hooks, { status: 'repaired', restartRequired: true });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, PreflightCode.HOOKS_REPAIRED);
});

test('a repair that does not take is a warning naming the remaining step', async (t) => {
  tmpHome(t);
  const result = await runLoginPreflight({
    deps: preflightDeps({
      hooksStatus: () => ({ state: 'stale', registered: [] }),
      ensureInstalled: () => ({ source: 'unknown', actions: ['hooks-failed:EACCES'] }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.hooks.status, 'missing');
  assert.equal(result.warnings[0].code, PreflightCode.HOOKS_MISSING);
});

test('an installer that throws is a warning, not a failed sign-in', async (t) => {
  tmpHome(t);
  const result = await runLoginPreflight({
    deps: preflightDeps({
      hooksStatus: () => { throw new Error('registry unreadable'); },
      ensureInstalled: () => { throw new Error('cannot write'); },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.hooks.status, 'failed');
  assert.equal(result.warnings[0].code, PreflightCode.HOOKS_FAILED);
});

// ── performLogin runs it, before the browser ─────────────────────────────────

const FILE_STORE = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };

function loginDeps(over = {}) {
  return {
    getCredentials: () => getCredentials(FILE_STORE),
    setCredentials: (c) => setCredentials(c, FILE_STORE),
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test' }),
    discover: async () => ({
      authorizationEndpoint: 'https://auth.test/authorize',
      tokenEndpoint: 'https://auth.test/token',
      registrationEndpoint: 'https://auth.test/register',
      revocationEndpoint: null,
    }),
    pkcePair: () => ({ verifier: 'v', challenge: 'c' }),
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:1234/callback', port: 1234, code: Promise.resolve('auth-code'), cancel: () => {},
    }),
    registerClient: async () => 'client-123',
    exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    whoami: async () => ({ valid: true, name: 'Dev', email: null }),
    openBrowser: async () => ({ ok: true }),
    ensureInstalled: () => ({ source: 'launcher', actions: [] }),
    runLoginPreflight: async () => ({ ok: true, blocking: [], warnings: [], hooks: { status: 'ok', restartRequired: false } }),
    ...over,
  };
}

test('a blocking preflight stops before the browser and before any OAuth traffic', async (t) => {
  tmpHome(t);
  const steps = [];
  const blocked = {
    ok: false,
    blocking: [{ code: PreflightCode.STORAGE_UNWRITABLE, path: '/x', detail: 'EACCES' }],
    warnings: [],
    hooks: { status: 'ok', restartRequired: false },
  };
  await assert.rejects(performLogin({
    onStep: (s) => steps.push(s),
    deps: loginDeps({
      runLoginPreflight: async () => blocked,
      discover: async () => { throw new Error('discovery must not run'); },
      openBrowser: async () => { throw new Error('no browser may open'); },
      startLoopback: async () => { throw new Error('no port may be bound'); },
    }),
  }), /cannot be written|EACCES/);
  assert.deepEqual(steps.filter((s) => s.type === 'authorize-url'), []);
});

test('a blocking preflight leaves an existing credential untouched', async (t) => {
  tmpHome(t);
  await commitCredentials({
    client_id: 'old', token_endpoint: 't', access_token: 'keepme', refresh_token: 'rt', expires_at: 4_000_000_000_000,
  }, FILE_STORE);
  const before = await readCredentialRecord(FILE_STORE);

  await assert.rejects(performLogin({
    deps: loginDeps({
      linkStatus: async () => ({ state: 'revoked', account: null, apiBase: 'https://api.test', who: { valid: false } }),
      runLoginPreflight: async () => ({
        ok: false,
        blocking: [{ code: PreflightCode.STORAGE_UNWRITABLE, path: '/x', detail: 'EACCES' }],
        warnings: [],
        hooks: { status: 'ok', restartRequired: false },
      }),
    }),
  }));

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, CredentialStatus.OK);
  assert.equal(after.generation, before.generation);
  assert.equal(after.creds.access_token, 'keepme');
});

// A partly completed workflow must preserve the authentication it achieved and explain the rest.
test('preflight warnings ride along with a successful link instead of failing it', async (t) => {
  tmpHome(t);
  const result = await performLogin({
    deps: loginDeps({
      runLoginPreflight: async () => ({
        ok: true,
        blocking: [],
        warnings: [{ code: PreflightCode.HOOKS_REPAIRED, detail: 'user-hooks-installed:absent' }],
        hooks: { status: 'repaired', restartRequired: true },
      }),
    }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(result.setup.hooks.status, 'repaired');
  assert.equal(result.setup.hooks.restartRequired, true);
  assert.equal(result.setup.warnings[0].code, PreflightCode.HOOKS_REPAIRED);
});

test('performLogin uses the real preflight when nothing is injected', async (t) => {
  const dir = tmpHome(t);
  // The installer seams still come from the deps bag — a suite must never write ~/.cursor/hooks.json
  // — but the preflight itself, including its filesystem probe, is the real one.
  const deps = loginDeps({ hooksStatus: installedHooks });
  delete deps.runLoginPreflight;

  const result = await performLogin({ deps });
  assert.equal(result.type, 'linked');
  assert.deepEqual(result.setup.hooks, { status: 'ok', restartRequired: false });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('preflight')), [], 'probes cleaned up');
});

// ── the diagnostics seam (CONTRACTS section 8) ───────────────────────────────

test('a failed sign-in offers the injected recorder a structured reason and nothing else', async (t) => {
  tmpHome(t);
  const recorded = [];
  await assert.rejects(performLogin({
    deps: loginDeps({
      recordIssue: (code, fields) => recorded.push({ code, fields }),
      exchangeCode: async () => { throw new Error('https://auth.test said no for user dev@acme.com'); },
    }),
  }));
  assert.deepEqual(recorded, [{ code: 'login_failed', fields: { reason: 'token_exchange' } }]);
});

test('a recorder that throws cannot break a sign-in', async (t) => {
  tmpHome(t);
  const result = await performLogin({
    deps: loginDeps({ recordIssue: () => { throw new Error('diagnostics exploded'); } }),
  });
  assert.equal(result.type, 'linked');
});

test('a blocked preflight is reported as its own reason', async (t) => {
  tmpHome(t);
  const recorded = [];
  await assert.rejects(performLogin({
    deps: loginDeps({
      recordIssue: (code, fields) => recorded.push([code, fields.reason]),
      runLoginPreflight: async () => ({
        ok: false,
        blocking: [{ code: PreflightCode.STORAGE_UNWRITABLE, path: '/x', detail: 'EACCES' }],
        warnings: [],
        hooks: { status: 'failed', restartRequired: false },
      }),
    }),
  }));
  assert.deepEqual(recorded, [['login_failed', 'preflight']]);
});
