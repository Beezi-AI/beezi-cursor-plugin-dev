import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthState, AuthReason } from '../lib/auth-state.mjs';
import {
  readAuthMarkers,
  markReauthRequired,
  markRefreshFailure,
  clearAuthMarkers,
  REFRESH_BACKOFF_MS,
} from '../lib/auth-markers.mjs';
import { getAuthState, forceRefresh, authEpoch, invalidateTokenCache } from '../lib/token.mjs';
import { commitCredentials, readCredentialRecord, CredentialStatus } from '../lib/credentials.mjs';
import { BACKEND_TIMEOUT_MS } from '../lib/credential-backends.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authstate-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  invalidateTokenCache();
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    invalidateTokenCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FILE_STORE = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };

const creds = (over = {}) => ({
  client_id: 'cid',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: 10_000_000,
  ...over,
});

const FRESH_NOW = () => 1_000_000; // far inside the credential's expiry
const STALE_NOW = () => 9_999_000; // inside the 60s skew, so a refresh is due

// ── the constants other lanes import ─────────────────────────────────────────

test('the typed vocabulary matches the frozen contract', () => {
  assert.deepEqual(AuthState, {
    READY: 'ready',
    UNLINKED: 'unlinked',
    REFRESHING: 'refreshing',
    UNAVAILABLE: 'unavailable',
    REAUTH_REQUIRED: 'reauth_required',
    FORBIDDEN: 'forbidden',
  });
  assert.deepEqual(AuthReason, {
    NONE: 'none',
    MISSING: 'missing',
    TIMEOUT: 'timeout',
    UNREADABLE: 'unreadable',
    CORRUPT: 'corrupt',
    CONFLICT: 'conflict',
    LOCKED: 'locked',
    INVALID_GRANT: 'invalid_grant',
    BACKOFF: 'backoff',
    TRANSPORT: 'transport',
    HTTP_5XX: 'http_5xx',
  });
});

// ── getAuthState ─────────────────────────────────────────────────────────────

test('an empty store is UNLINKED/MISSING, never UNAVAILABLE', async (t) => {
  tmpHome(t);
  const state = await getAuthState({ ...FILE_STORE });
  assert.equal(state.state, AuthState.UNLINKED);
  assert.equal(state.reason, AuthReason.MISSING);
  assert.equal(state.token, null);
});

test('a healthy credential is READY with its token and generation', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  const state = await getAuthState({ ...FILE_STORE, now: FRESH_NOW });
  assert.equal(state.state, AuthState.READY);
  assert.equal(state.reason, AuthReason.NONE);
  assert.equal(state.token, 'at');
  assert.equal(state.generation, 1);
  assert.equal(typeof state.epoch, 'string');
});

// The whole point of the typed store: a keyring that did not answer must not be reported as an
// unlinked machine, because "not linked" is what makes a hook offer to delete and relink.
test('a store that did not answer is UNAVAILABLE/TIMEOUT, not UNLINKED', async (t) => {
  tmpHome(t);
  const deps = {
    getCredentialRecord: async () => ({
      status: CredentialStatus.TIMEOUT, creds: null, generation: 2, epoch: 1, service: 'beezi-cursor',
    }),
  };
  const state = await getAuthState(deps);
  assert.equal(state.state, AuthState.UNAVAILABLE);
  assert.equal(state.reason, AuthReason.TIMEOUT);
  assert.equal(state.generation, 2);
});

test('an unreadable or corrupt store is UNAVAILABLE with its own reason', async (t) => {
  tmpHome(t);
  for (const [status, reason] of [
    [CredentialStatus.UNREADABLE, AuthReason.UNREADABLE],
    [CredentialStatus.CORRUPT, AuthReason.CORRUPT],
    [CredentialStatus.RECOVERY_NEEDED, AuthReason.CORRUPT],
  ]) {
    const state = await getAuthState({ getCredentialRecord: async () => ({ status, creds: null, generation: 0, epoch: 0 }) });
    assert.equal(state.state, AuthState.UNAVAILABLE, status);
    assert.equal(state.reason, reason, status);
  }
});

test('a busy mutation lock is REFRESHING/LOCKED', async (t) => {
  tmpHome(t);
  const state = await getAuthState({
    getCredentialRecord: async () => ({ status: CredentialStatus.LOCKED, creds: null, generation: 0, epoch: 0 }),
  });
  assert.equal(state.state, AuthState.REFRESHING);
  assert.equal(state.reason, AuthReason.LOCKED);
});

test('getAuthState never throws and never deletes, whatever the store does', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  let deleted = false;
  const state = await getAuthState({
    ...FILE_STORE,
    now: STALE_NOW,
    deleteCredentials: async () => { deleted = true; },
    refreshTokens: async () => { throw new Error('provider exploded'); },
  });
  assert.equal(deleted, false);
  assert.ok(state.state);
  assert.equal((await readCredentialRecord(FILE_STORE)).status, CredentialStatus.OK, 'still linked');
});

// ── invalid_grant: marked, not wiped ─────────────────────────────────────────

test('a provider-confirmed dead grant marks reauth for that generation and keeps the credential', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);

  const state = await getAuthState({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ invalidGrant: true }),
  });
  assert.equal(state.state, AuthState.REAUTH_REQUIRED);
  assert.equal(state.reason, AuthReason.INVALID_GRANT);
  assert.equal(state.token, null);

  const stored = await readCredentialRecord(FILE_STORE);
  assert.equal(stored.status, CredentialStatus.OK, 'the credential was NOT deleted');
  assert.equal(readAuthMarkers().reauthRequired, true);
  assert.equal(readAuthMarkers().generation, stored.generation);
});

test('a reauth marker from an older generation does not apply to a newly linked credential', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  markReauthRequired(1, AuthReason.INVALID_GRANT);
  await commitCredentials(creds({ client_id: 'cid-2', access_token: 'at2' }), FILE_STORE); // generation 2

  const state = await getAuthState({ ...FILE_STORE, now: FRESH_NOW });
  assert.equal(state.state, AuthState.READY);
  assert.equal(state.token, 'at2');
});

// ── bounded backoff ──────────────────────────────────────────────────────────

test('the refresh backoff schedule is 15s, 30s, 60s, 120s, 300s and then holds', () => {
  assert.deepEqual(REFRESH_BACKOFF_MS, [15_000, 30_000, 60_000, 120_000, 300_000]);
});

test('repeated transient refresh failures back off on that schedule', async (t) => {
  tmpHome(t);
  let now = 1_000;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    markRefreshFailure(1, AuthReason.TRANSPORT, { now: () => now });
    const markers = readAuthMarkers();
    const expected = REFRESH_BACKOFF_MS[Math.min(attempt, REFRESH_BACKOFF_MS.length) - 1];
    assert.equal(markers.backoffUntil, now + expected, `attempt ${attempt}`);
    now += expected;
  }
});

test('a credential inside its backoff window is not refreshed again', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  markRefreshFailure(1, AuthReason.TRANSPORT, { now: STALE_NOW });

  let attempts = 0;
  const state = await getAuthState({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => { attempts += 1; return { tokens: null }; },
  });
  assert.equal(attempts, 0, 'the failing provider is not hammered');
  assert.equal(state.reason, AuthReason.BACKOFF);
  assert.equal(state.token, 'at', 'the existing token is still offered — the server decides');
});

test('a successful refresh clears the markers', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  markRefreshFailure(1, AuthReason.TRANSPORT, { now: () => 0 });

  const result = await forceRefresh({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ tokens: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, 'at2');
  assert.equal(readAuthMarkers().backoffUntil, 0);
  assert.equal(readAuthMarkers().attempts, 0);
});

test('a refresh that legitimately omits a replacement refresh token keeps the old one', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  await forceRefresh({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
  });
  const stored = await readCredentialRecord(FILE_STORE);
  assert.equal(stored.creds.access_token, 'at2');
  assert.equal(stored.creds.refresh_token, 'rt', 'rotation is preserved, not erased');
});

test('forceRefresh reports a dead grant without deleting anything', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  const result = await forceRefresh({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ invalidGrant: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, AuthState.REAUTH_REQUIRED);
  assert.equal(result.reason, AuthReason.INVALID_GRANT);
  assert.equal((await readCredentialRecord(FILE_STORE)).status, CredentialStatus.OK);
});

test('forceRefresh on an unlinked machine is UNLINKED, not an error', async (t) => {
  tmpHome(t);
  const result = await forceRefresh({ ...FILE_STORE });
  assert.equal(result.ok, false);
  assert.equal(result.state, AuthState.UNLINKED);
});

// ── the epoch fence ──────────────────────────────────────────────────────────

test('a same-account refresh keeps the epoch; a new login advances it', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  const first = await authEpoch(FILE_STORE);

  await forceRefresh({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
  });
  assert.equal(await authEpoch(FILE_STORE), first, 'a refresh is the same identity');

  await forceRefresh({
    ...FILE_STORE,
    now: STALE_NOW,
    refreshTokens: async () => ({ tokens: { access_token: 'at3', expires_in: 3600 } }),
  });
  assert.equal(await authEpoch(FILE_STORE), first, 'and so is the next one');

  await commitCredentials(creds({ client_id: 'cid-2' }), FILE_STORE); // a new login
  assert.notEqual(await authEpoch(FILE_STORE), first);
});

test('the epoch changes on logout', async (t) => {
  tmpHome(t);
  await commitCredentials(creds(), FILE_STORE);
  const linked = await authEpoch(FILE_STORE);
  const { deleteCredentialRecord } = await import('../lib/credentials.mjs');
  await deleteCredentialRecord(FILE_STORE);
  assert.notEqual(await authEpoch(FILE_STORE), linked);
});

test('clearAuthMarkers removes the file entirely', async (t) => {
  const dir = tmpHome(t);
  markReauthRequired(1, AuthReason.INVALID_GRANT);
  assert.equal(fs.existsSync(path.join(dir, 'auth-markers.json')), true);
  clearAuthMarkers();
  assert.equal(fs.existsSync(path.join(dir, 'auth-markers.json')), false);
  assert.equal(readAuthMarkers().reauthRequired, false);
});

// ── the compatibility adapter other callers still use ────────────────────────

test('getAccessToken stays a bare-token adapter over the typed state', async (t) => {
  tmpHome(t);
  const { getAccessToken } = await import('../lib/token.mjs');
  await commitCredentials(creds(), FILE_STORE);
  assert.equal(await getAccessToken({ ...FILE_STORE, now: FRESH_NOW }), 'at');
});

// ── the caller's deadline reaches the thing that actually spends it ──────────
//
// `deadlineMs` used to travel only as far as the lock wait, while the credential READ — which on
// Windows spawns PowerShell and makes it compile a P/Invoke struct — kept the 5s backend default.
// A hook that asked for 800ms could be held for five seconds and killed by Cursor before it saw an
// answer.
// A keychain fake that records the budget it was given for every read of the committed slot.
function budgetRecorder() {
  const entries = new Map();
  const budgets = [];
  const run = (file, args, input, timeoutMs) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    const key = `${args[args.indexOf('-s') + 1]}::${args[args.indexOf('-a') + 1]}`;
    if (args[0] === 'add-generic-password') { entries.set(key, args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (args[0] === 'find-generic-password') {
      budgets.push(timeoutMs);
      return entries.has(key) ? { ok: true, stdout: `${entries.get(key)}\n` } : { ok: false, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') { entries.delete(key); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
  return { run, budgets };
}

test('a hook deadline bounds the credential read, not just the lock wait', async (t) => {
  tmpHome(t);
  const kc = budgetRecorder();
  await commitCredentials(creds(), { platform: 'darwin', run: kc.run });
  kc.budgets.length = 0;

  await getAuthState({ platform: 'darwin', run: kc.run, deadlineMs: 800, now: FRESH_NOW });
  assert.ok(kc.budgets.length > 0, 'the committed slot was read');
  for (const budget of kc.budgets) {
    assert.ok(budget <= 800, `a ${budget}ms keyring budget inside an 800ms deadline`);
  }
});

test('a caller that named its own backend budget keeps it', async (t) => {
  tmpHome(t);
  const kc = budgetRecorder();
  await commitCredentials(creds(), { platform: 'darwin', run: kc.run });
  kc.budgets.length = 0;

  await getAuthState({ platform: 'darwin', run: kc.run, deadlineMs: 800, timeoutMs: 120, now: FRESH_NOW });
  assert.ok(kc.budgets.length > 0);
  for (const budget of kc.budgets) assert.equal(budget, 120);
});

test('a caller with no deadline still gets the backend default', async (t) => {
  tmpHome(t);
  const kc = budgetRecorder();
  await commitCredentials(creds(), { platform: 'darwin', run: kc.run });
  kc.budgets.length = 0;

  await getAuthState({ platform: 'darwin', run: kc.run, now: FRESH_NOW });
  assert.ok(kc.budgets.length > 0);
  for (const budget of kc.budgets) assert.equal(budget, BACKEND_TIMEOUT_MS);
});

// The budget has to reach the rereads INSIDE the lease as well as the lock wait. Bounding only the
// wait left a hook that asked for 800ms able to sit for the full backend default on a cold keychain
// while already inside the critical section — and be killed by Cursor before it saw an answer.
test('a hook deadline also bounds the credential reread inside the refresh lease', async (t) => {
  tmpHome(t);
  const kc = budgetRecorder();
  // Expired, so getAuthState takes the lease and performRefresh rereads under it.
  await commitCredentials(creds({ expires_at: 1 }), { platform: 'darwin', run: kc.run });
  kc.budgets.length = 0;

  await getAuthState({
    platform: 'darwin',
    run: kc.run,
    deadlineMs: 800,
    now: () => 1_000_000,
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
  });

  assert.ok(kc.budgets.length > 1, 'the reread inside the lease happened');
  for (const budget of kc.budgets) {
    assert.ok(budget <= 800, `a ${budget}ms keyring budget inside an 800ms deadline`);
  }
});
