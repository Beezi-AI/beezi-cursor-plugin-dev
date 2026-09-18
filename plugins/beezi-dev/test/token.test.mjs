import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken, invalidateTokenCache } from '../lib/token.mjs';
import { setCredentials } from '../lib/credentials.mjs';
import { fileForSlot } from '../lib/credential-backends.mjs';
import { currentSlot } from '../lib/credential-control.mjs';
import { defaultKeyringService } from '../lib/keyring-namespace.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FRESH = {
  client_id: 'cid', token_endpoint: 'https://x/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};

test('returns null when not linked', async () => {
  assert.equal(await getAccessToken({ getCredentials: async () => null }), null);
});

test('returns the stored token while fresh, without refreshing', async () => {
  let refreshed = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { refreshed = true; return { tokens: null }; },
    now: () => 1_000_000, // 9000s before expiry
  });
  assert.equal(token, 'at');
  assert.equal(refreshed, false);
});

test('refreshes an expiring token and persists the result', async (t) => {
  tmpHome(t);
  let saved;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 } }),
    now: () => 9_999_000, // 1s before expiry (< 60s skew)
  });
  assert.equal(token, 'at2');
  assert.equal(saved.access_token, 'at2');
  assert.equal(saved.refresh_token, 'rt2');
  assert.equal(saved.expires_at, 9_999_000 + 86_400_000);
});

// A dead grant used to DELETE the credential from inside a token read. That made every caller of
// this function a potential destroyer of the link — including the session-start hook, which runs
// unattended — and the deletion was irreversible while the cause (a proxy answering 401 with an
// HTML body, a provider mid-incident) frequently was not. Explicit logout deletes; this marks.
test('invalid_grant returns null and marks reauth WITHOUT deleting the credential', async (t) => {
  tmpHome(t);
  let deleted = false;
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => { deleted = true; },
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
  assert.equal(deleted, false, 'nothing was destroyed on the way to reporting the refusal');
});

test('transient refresh failure falls back to the stale token', async (t) => {
  tmpHome(t);
  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => ({ tokens: null }),
    now: () => 9_999_000,
  });
  assert.equal(token, 'at');
});

test('waits out a concurrent refresh instead of racing it', async (t) => {
  const dir = tmpHome(t);
  // Another process holds the credential mutation lock, and it is alive: an owner that answers
  // signal 0 is never reclaimed, however long it has been there.
  fs.mkdirSync(path.join(dir, 'credentials.lock'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ owner: { pid: 999_999, processStartTime: 1, nonce: 'other' }, acquiredAt: Date.now() }),
    'utf-8',
  );
  let reread = 0;
  const token = await getAccessToken({
    getCredentials: async () => { reread += 1; return { ...FRESH }; },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    kill: () => {},
    sleep: async () => {},
  });
  assert.equal(token, 'at', "the lock holder's store is re-read rather than raced");
  assert.equal(reread, 2);
});

// ── the in-process memo ──────────────────────────────────────────────────────
//
// The MCP bridge asks for a token on every JSON-RPC message it forwards, and on Windows the default
// backend answers each ask by spawning powershell.exe to compile a P/Invoke struct — a measured
// median of 532ms, sitting in the model's tool-call latency. These tests pin the two halves of the
// fix: the read really is skipped, and it is never skipped for longer than a minute.
//
// They have to go through the DEFAULT credential reader, because an injected getCredentials bypasses
// the memo by design. 'sunos' has no keyring backend, so credentials.mjs resolves to the plain file
// under BEEZI_CURSOR_HOME — a real read of a real store, with no subprocess and nothing machine-
// specific about it.
const FILE_STORE = { platform: 'sunos' };

// The memo is module state shared by every test in this process, so it is cleared on the way in as
// well as on the way out — the same discipline test/vscdb-cache.test.mjs keeps with clearVscdbCache.
function memoHome(t) {
  const dir = tmpHome(t);
  invalidateTokenCache();
  t.after(() => invalidateTokenCache());
  return dir;
}

// Far enough inside FRESH's expiry that no refresh is attempted (it claims another 9000s).
const AT = () => 1_000_000;

async function store(accessToken, extra = {}) {
  await setCredentials({ ...FRESH, access_token: accessToken, ...extra }, FILE_STORE);
}

// Overwrite the bytes of the CURRENT generation's slot without going through the store, so the
// control record still names the same generation. Nothing but a real read could see the new value —
// which is what makes a memo hit observable at all.
function rewriteSlotInPlace(accessToken) {
  const live = currentSlot(defaultKeyringService());
  fs.writeFileSync(
    fileForSlot(live.slot),
    JSON.stringify({ token: JSON.stringify({ ...FRESH, access_token: accessToken }) }),
    'utf-8',
  );
}

test('a second call inside the window is answered from memory, not from the store', async (t) => {
  memoHome(t);
  await store('first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');

  rewriteSlotInPlace('second');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');
});

// The memo is keyed by (namespace, generation), and every committed mutation advances the
// generation — so a login, a refresh or a logout performed by ANOTHER process is seen on the very
// next ask instead of up to a minute later. That minute is what used to keep a revoked link alive
// inside a running bridge.
test('a committed mutation invalidates the memo immediately, even inside the window', async (t) => {
  memoHome(t);
  await store('first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');

  await store('second'); // a real commit: new generation
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'second');
});

test('the memo is never trusted for more than a minute, whatever the credential claims', async (t) => {
  memoHome(t);
  await store('first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');
  rewriteSlotInPlace('second');

  // FRESH claims another 9000s of life, and honouring that is exactly what would keep a revoked
  // link working for hours inside a running bridge.
  assert.equal(await getAccessToken({ ...FILE_STORE, now: () => 1_059_000 }), 'first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: () => 1_060_001 }), 'second');
});

test('invalidateTokenCache() sends the next call back to the store', async (t) => {
  memoHome(t);
  await store('first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');

  rewriteSlotInPlace('second');
  invalidateTokenCache();
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'second');
});

// Without this guard the suite starts answering itself: every other test in this file stubs the
// store, and a memo shared across them would hand one test the token another one made up.
test('an injected store is never served from the memo, and never writes to it', async (t) => {
  memoHome(t);
  await store('from-the-store');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'from-the-store');

  const injected = await getAccessToken({
    getCredentials: async () => ({ ...FRESH, access_token: 'injected' }),
    now: AT,
  });
  assert.equal(injected, 'injected', 'a caller that brought its own store gets that store');

  assert.equal(
    await getAccessToken({ ...FILE_STORE, now: AT }),
    'from-the-store',
    'and it did not leave its token behind for the default path to serve',
  );
});

// A memo outliving the verdict is how a revoked link becomes a session that can never recover: the
// grant is known dead but the token is still handed out of memory for another full minute.
test('invalid_grant drops the memo', async (t) => {
  memoHome(t);
  await store('first');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'first');

  const token = await getAccessToken({
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => {},
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);

  // The file survived (the delete was stubbed), so a re-read is observable — and it happens.
  rewriteSlotInPlace('second');
  assert.equal(await getAccessToken({ ...FILE_STORE, now: AT }), 'second');
});

// The two bags are different things: the FIRST names the store and the clock, the SECOND names what
// this call wants done. Merging them worked only because of the order they happened to be spread
// in, and would have read the next option named like a dep out of the wrong object.
test('getAccessToken keeps the deps bag and the options bag in their own positions', async (t) => {
  tmpHome(t);
  let refreshes = 0;
  const token = await getAccessToken(
    {
      getCredentials: async () => ({ ...FRESH }),
      setCredentials: async () => 'a file',
      refreshTokens: async () => {
        refreshes += 1;
        return { tokens: { access_token: 'rotated', expires_in: 3600 } };
      },
      now: () => 1_000_000, // 9000s before expiry: nothing but forceRefresh can cause a refresh
    },
    { forceRefresh: true },
  );
  assert.equal(refreshes, 1, 'the option in the options position was honoured');
  assert.equal(token, 'rotated');
});
