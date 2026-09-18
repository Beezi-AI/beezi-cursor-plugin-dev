import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performLogin, openBrowser } from '../lib/login.mjs';
import {
  CredentialStatus, commitCredentials, getCredentials, readCredentialRecord, setCredentials,
} from '../lib/credentials.mjs';

// Enough of the flow to reach the browser step and past it, with nothing touching the network.
function loginDeps(overrides = {}) {
  return {
    getCredentials: async () => null,
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test' }),
    discover: async () => ({
      authorizationEndpoint: 'https://auth.test/authorize',
      tokenEndpoint: 'https://auth.test/token',
      registrationEndpoint: 'https://auth.test/register',
    }),
    pkcePair: () => ({ verifier: 'v', challenge: 'c' }),
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:1234/callback',
      port: 1234,
      code: Promise.resolve('auth-code'),
      cancel: () => {},
    }),
    registerClient: async () => 'client-123',
    exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    setCredentials: async () => 'the OS keyring',
    whoami: async () => ({ valid: true, name: 'Dev Eloper', email: null }),
    openBrowser: async () => ({ ok: true }),
    // performLogin now writes the user-scope hook registry as its last step, so a machine that just
    // linked can report without opening the IDE. Stubbed here for the same reason every install in
    // test/hooks-install.test.mjs is fully pathed: the real one merges into ~/.cursor/hooks.json,
    // and a test suite must never write there.
    ensureInstalled: () => ({ source: 'launcher', actions: [] }),
    ...overrides,
  };
}

test('login emits the authorize URL before it tries to open a browser', async (t) => {
  tmpHome(t);
  const steps = [];
  const order = [];
  await performLogin({
    onStep: (s) => { steps.push(s); order.push(`step:${s.type}`); },
    deps: loginDeps({ openBrowser: async () => { order.push('openBrowser'); return { ok: true }; } }),
  });
  assert.equal(order[0], 'step:authorize-url');
  assert.equal(order[1], 'openBrowser');
  assert.match(steps[0].url, /^https:\/\/auth\.test\/authorize\?/);
});

// The launcher used to be fire-and-forget with stdio ignored, so a sandboxed shell or a machine
// with no http association failed invisibly: no browser, no message, and — through the MCP tool —
// no URL either. The outcome now reaches the caller.
test('a launcher that fails is surfaced as a browser-failed step', async (t) => {
  tmpHome(t);
  const steps = [];
  const result = await performLogin({
    onStep: (s) => steps.push(s),
    deps: loginDeps({ openBrowser: async () => ({ ok: false, detail: 'no http association' }) }),
  });

  const failed = steps.find((s) => s.type === 'browser-failed');
  assert.ok(failed, 'no browser-failed step was emitted');
  assert.equal(failed.detail, 'no http association');
  assert.match(failed.url, /^https:\/\/auth\.test\/authorize\?/);
  // The sign-in itself still completes — the user can open the URL by hand.
  assert.equal(result.type, 'linked');
  assert.equal(result.account, 'Dev Eloper');
});

test('an openBrowser that resolves ok emits no browser-failed step', async (t) => {
  tmpHome(t);
  const steps = [];
  await performLogin({ onStep: (s) => steps.push(s), deps: loginDeps() });
  assert.equal(steps.find((s) => s.type === 'browser-failed'), undefined);
});

// whoami is a display-name lookup that runs *after* the credentials are stored. It must never be
// able to fail the login — that is what stranded a completed sign-in behind a pending request.
test('a whoami that fails still yields a linked result', async (t) => {
  tmpHome(t);
  const result = await performLogin({
    deps: loginDeps({ whoami: async () => { throw new Error('unreachable'); } }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(result.account, null);
});

test('openBrowser refuses a non-http(s) URL instead of handing it to a shell', async () => {
  const result = await openBrowser('file:///c:/windows/system32/calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.detail, /non-http/);
});

test('openBrowser reports a launcher it cannot start', { skip: process.platform !== 'win32' }, async (t) => {
  // Point the launcher at a directory that holds no powershell.exe: the spawn fails, and the
  // caller has to learn about it rather than believing a browser opened.
  const prev = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\beezi-no-such-root';
  t.after(() => {
    if (prev === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prev;
  });

  const result = await openBrowser('https://auth.test/authorize?x=1');
  assert.equal(result.ok, false);
  assert.ok(result.detail, 'the failure carries a reason');
});

// ── AUTH-08 / AUTH-V01: a sign-in may never destroy an existing authorization ──

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FILE_STORE = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };
const PERSISTED = {
  client_id: 'client-old',
  redirect_uri: 'http://127.0.0.1:1234/callback',
  token_endpoint: 'https://auth.test/token',
  access_token: 'persisted-at',
  refresh_token: 'persisted-rt',
  expires_at: 4000000000000,
};
// The real store, reached through the same seams the deps bag already owns.
const realStore = () => ({
  getCredentials: () => getCredentials(FILE_STORE),
  setCredentials: (c) => setCredentials(c, FILE_STORE),
});

test('a forbidden tenant stops the sign-in and keeps the credential at the same generation', async (t) => {
  tmpHome(t);
  await commitCredentials(PERSISTED, FILE_STORE);
  const before = await readCredentialRecord(FILE_STORE);

  const steps = [];
  const result = await performLogin({
    onStep: (s) => steps.push(s),
    deps: loginDeps({
      ...realStore(),
      // link-status maps whoami's 403 to REVOKED and carries the raw verdict; `forbidden` is what
      // distinguishes "not entitled" from "token rejected".
      linkStatus: async () => ({
        state: 'revoked', account: null, apiBase: 'https://api.test', who: { valid: false, forbidden: true },
      }),
      discover: async () => { throw new Error('a forbidden tenant must not start an OAuth round-trip'); },
      openBrowser: async () => { throw new Error('no browser may open'); },
    }),
  });
  assert.equal(result.type, 'forbidden');
  assert.equal(steps.filter((s) => s.type === 'authorize-url').length, 0);

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, CredentialStatus.OK, 'relinking cannot grant a seat - the link is left alone');
  assert.equal(after.generation, before.generation, 'the same generation is still readable');
  assert.equal(after.creds.access_token, 'persisted-at');
});

test('a revoked link is re-registered without erasing the stored credential first', async (t) => {
  tmpHome(t);
  await commitCredentials(PERSISTED, FILE_STORE);
  const result = await performLogin({
    deps: loginDeps({
      ...realStore(),
      linkStatus: async () => ({ state: 'revoked', account: null, apiBase: 'https://api.test', who: { valid: false } }),
      registerClient: async () => 'client-new',
    }),
  });
  assert.equal(result.type, 'linked');
  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.creds.client_id, 'client-new', 'a fresh client replaced the stale one');
  assert.equal(after.generation, 2, 'by advancing a generation, not by a delete-then-write pair');
});

// The store is only ever REPLACED by the successful commit at the end. A sign-in that dies halfway
// used to leave the machine with nothing, having started with a link that might have recovered.
test('a sign-in that fails halfway leaves the previous authorization readable', async (t) => {
  tmpHome(t);
  await commitCredentials(PERSISTED, FILE_STORE);
  const before = await readCredentialRecord(FILE_STORE);

  await assert.rejects(performLogin({
    deps: loginDeps({
      ...realStore(),
      linkStatus: async () => ({ state: 'revoked', account: null, apiBase: 'https://api.test', who: { valid: false } }),
      exchangeCode: async () => { throw new Error('token exchange failed'); },
    }),
  }), /token exchange failed/);

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, CredentialStatus.OK);
  assert.equal(after.generation, before.generation);
  assert.equal(after.creds.access_token, 'persisted-at');
});

// ── B1: the installation binding has a production call site ─────────────────────────────────────

test('a successful login binds the diagnostic installation with the token it already holds', async (t) => {
  // Without this call `bindInstallation` had no caller outside the tests, so `boundAt` was never
  // written, `currentInstallationId()` was always null, the `correlate` setting was inert and the
  // README's claim that the id is bound to the last account linked here was describing code that
  // never ran.
  tmpHome(t);
  const calls = [];
  const result = await performLogin({
    deps: loginDeps({
      bindInstallation: async (deps) => { calls.push(deps); return { status: 'bound' }; },
    }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(calls.length, 1, 'exactly one binding attempt per successful sign-in');
  // The token the flow ALREADY has. There is no refresh path into the identity module by design,
  // so a binding that had to fetch its own token would be the wrong shape entirely.
  assert.equal(calls[0].token, 'at');
});

test('the installation binding can never fail, slow or change a sign-in', async (t) => {
  for (const bind of [
    async () => { throw new Error('the diagnostics API is down'); },
    () => { throw new Error('threw synchronously'); },
    async () => ({ status: 'unauthorized' }),
    async () => null,
  ]) {
    tmpHome(t);
    const result = await performLogin({ deps: loginDeps({ bindInstallation: bind }) });
    assert.equal(result.type, 'linked', 'the sign-in outcome is unchanged');
    assert.equal(result.account, 'Dev Eloper');
  }
});

test('an already-linked machine reasserts the binding too', async (t) => {
  // The rebind window is seven days and a re-run of the login skill is the most likely moment a
  // user gives the machine an authenticated token; skipping this branch would leave a machine that
  // never signs in afresh permanently unbound.
  tmpHome(t);
  const calls = [];
  const result = await performLogin({
    deps: loginDeps({
      getCredentials: async () => ({ client_id: 'client-123', access_token: 'existing-at' }),
      linkStatus: async () => ({
        state: 'linked', account: 'Dev Eloper', apiBase: 'https://api.test', who: { valid: true },
      }),
      bindInstallation: async (deps) => { calls.push(deps); return { status: 'bound' }; },
    }),
  });
  assert.equal(result.type, 'already-linked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'existing-at');
});
