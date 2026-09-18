import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, registerClient, pkcePair, exchangeCode, refreshTokens } from '../lib/oauth.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

const jsonRes = (body, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
});

test('pkcePair returns base64url verifier and S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(verifier, challenge);
});

test('discover chains protected-resource → authorization-server metadata', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/.well-known/oauth-protected-resource')) {
      return jsonRes({ authorization_servers: ['https://clerk.example.com'] });
    }
    return jsonRes({
      authorization_endpoint: 'https://clerk.example.com/oauth/authorize',
      token_endpoint: 'https://clerk.example.com/oauth/token',
      registration_endpoint: 'https://clerk.example.com/oauth/register',
    });
  };
  const meta = await discover({ fetchImpl, origin: 'https://api.example.com' });
  assert.equal(calls[0], 'https://api.example.com/.well-known/oauth-protected-resource');
  assert.equal(calls[1], 'https://clerk.example.com/.well-known/oauth-authorization-server');
  assert.equal(meta.authorizationEndpoint, 'https://clerk.example.com/oauth/authorize');
  assert.equal(meta.tokenEndpoint, 'https://clerk.example.com/oauth/token');
  assert.equal(meta.registrationEndpoint, 'https://clerk.example.com/oauth/register');
});

test('discover throws a friendly error when the portal has no OAuth metadata', async () => {
  const fetchImpl = async () => jsonRes({}, 404);
  await assert.rejects(
    discover({ fetchImpl, origin: 'https://api.example.com' }),
    /OAuth discovery failed/,
  );
});

test('registerClient POSTs DCR metadata and returns client_id', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return jsonRes({ client_id: 'cid_123' }, 201);
  };
  const id = await registerClient('https://clerk.example.com/oauth/register',
    'http://127.0.0.1:49152/callback', { fetchImpl, hostname: 'my-mac' });
  assert.equal(id, 'cid_123');
  assert.equal(sent.client_name, 'Beezi Cursor plugin — my-mac');
  assert.deepEqual(sent.redirect_uris, ['http://127.0.0.1:49152/callback']);
  assert.equal(sent.token_endpoint_auth_method, 'none');
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token']);
});

test('exchangeCode posts urlencoded grant and returns tokens', async () => {
  let sentBody;
  const fetchImpl = async (url, init) => {
    sentBody = new URLSearchParams(init.body);
    return jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 });
  };
  const tokens = await exchangeCode({
    tokenEndpoint: 'https://clerk.example.com/oauth/token',
    clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', code: 'c', verifier: 'v',
  }, { fetchImpl });
  assert.equal(tokens.access_token, 'at');
  assert.equal(sentBody.get('grant_type'), 'authorization_code');
  assert.equal(sentBody.get('code_verifier'), 'v');
  assert.equal(sentBody.get('client_id'), 'cid');
  assert.equal(sentBody.get('redirect_uri'), 'http://127.0.0.1:1/callback');
});

test('refreshTokens flags invalid_grant', async () => {
  const fetchImpl = async () => jsonRes({ error: 'invalid_grant' }, 400);
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl },
  );
  assert.equal(r.invalidGrant, true);
});

test('refreshTokens returns null tokens on network failure', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl },
  );
  assert.equal(r.tokens, null);
  assert.ok(!r.invalidGrant);
});

// ── AUTH-05 / AUTH-09 / AUTH-14 ──────────────────────────────────────────────

import { GrantFailure, MAX_BODY_BYTES, validateGrant } from '../lib/oauth.mjs';

const streamRes = (text, status = 200) => ({
  ok: status < 400,
  status,
  body: {
    getReader() {
      let sent = false;
      return {
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { value: Buffer.from(text, 'utf-8'), done: false };
        },
        cancel: async () => {},
      };
    },
  },
});

const stalledRes = () => ({
  ok: true,
  status: 200,
  body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
});

// ── grant validation ─────────────────────────────────────────────────────────

test('validateGrant rejects an initial grant with no usable access token', () => {
  for (const body of [null, {}, { access_token: '' }, { access_token: 42 }, { access_token: '   ' }]) {
    assert.equal(validateGrant(body, { initial: true }).ok, false, JSON.stringify(body));
  }
});

// A login without a refresh token produces a link that dies at the first expiry and can only be
// fixed by another browser round-trip. Refusing it up front is the difference between a failed
// sign-in the user can retry and a stored credential that quietly stops working.
test('validateGrant rejects an initial grant with no refresh token, and accepts one with both', () => {
  assert.equal(validateGrant({ access_token: 'at' }, { initial: true }).ok, false);
  assert.equal(validateGrant({ access_token: 'at', refresh_token: 'rt' }, { initial: true }).ok, true);
});

// A REFRESH may legitimately omit a replacement — that is not rotation, and the caller keeps the
// refresh token it already has.
test('validateGrant accepts a refresh response that omits a replacement refresh token', () => {
  const r = validateGrant({ access_token: 'at2' }, { initial: false });
  assert.equal(r.ok, true);
  assert.equal(r.tokens.refresh_token, undefined);
});

test('exchangeCode refuses a malformed grant instead of returning one to be stored', async () => {
  const fetchImpl = async () => jsonRes({ token_type: 'Bearer' });
  await assert.rejects(exchangeCode({
    tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', code: 'c', verifier: 'v',
  }, { fetchImpl }), /usable access token/);
});

test('exchangeCode refuses a grant with no refresh token', async () => {
  const fetchImpl = async () => jsonRes({ access_token: 'at', expires_in: 3600 });
  await assert.rejects(exchangeCode({
    tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', code: 'c', verifier: 'v',
  }, { fetchImpl }), /refresh token/);
});

// ── one end-to-end deadline, headers AND body ────────────────────────────────

test('a response whose body never arrives does not outlive the deadline', async () => {
  const started = Date.now();
  // `stalledRes` holds nothing, and the deadline it has to lose to is an unref'd timer
  // (lib/oauth.mjs:49) — see test/helpers/loop-alive.mjs. The 60ms budget is unchanged and still
  // has to expire on its own for these assertions to hold.
  const r = await withLoopAlive(() => refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl: async () => stalledRes(), timeoutMs: 60 },
  ));
  assert.ok(Date.now() - started < 2000, 'the caller was released');
  assert.equal(r.tokens, null);
  assert.equal(r.failure, GrantFailure.TIMEOUT);
});

test('the headers and the body share one budget rather than each getting a full one', async () => {
  const fetchImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return stalledRes();
  };
  const started = Date.now();
  const r = await withLoopAlive(() => refreshTokens({ tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' }, { fetchImpl, timeoutMs: 300 }));
  const elapsed = Date.now() - started;
  assert.equal(r.failure, GrantFailure.TIMEOUT);
  // The headers took 200ms of a 300ms budget, so the body may have at most the remaining 100.
  // Giving it a fresh 300 — which is what a per-phase timer does — would cost 500ms.
  assert.ok(elapsed < 450, `the body got a fresh budget: spent ${elapsed}ms`);
});

test('an over-long body is abandoned rather than buffered without limit', async () => {
  const huge = `{"access_token":"${'x'.repeat(MAX_BODY_BYTES + 1000)}"}`;
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl: async () => streamRes(huge), timeoutMs: 500 },
  );
  assert.equal(r.tokens, null);
  assert.equal(r.failure, GrantFailure.MALFORMED);
});

// ── typed refresh failures ───────────────────────────────────────────────────

test('refreshTokens classifies each failure instead of returning one opaque null', async () => {
  const cases = [
    [async () => jsonRes({ error: 'invalid_grant' }, 400), 'invalidGrant'],
    [async () => jsonRes({ error: 'invalid_client' }, 401), 'invalidGrant'],
    [async () => jsonRes({}, 500), GrantFailure.HTTP_5XX],
    [async () => jsonRes({}, 503), GrantFailure.HTTP_5XX],
    [async () => jsonRes({}, 429), GrantFailure.HTTP_OTHER],
    [async () => jsonRes({ error: 'temporarily_unavailable' }, 400), GrantFailure.HTTP_OTHER],
    [async () => { throw new Error('ECONNRESET'); }, GrantFailure.TRANSPORT],
    [async () => streamRes('not json at all'), GrantFailure.MALFORMED],
    [async () => jsonRes({ token_type: 'Bearer' }), GrantFailure.MALFORMED],
  ];
  for (const [fetchImpl, expected] of cases) {
    const r = await refreshTokens(
      { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
      { fetchImpl, timeoutMs: 500 },
    );
    if (expected === 'invalidGrant') {
      assert.equal(r.invalidGrant, true);
    } else {
      assert.equal(r.tokens, null);
      assert.equal(r.failure, expected, `expected ${expected}`);
    }
  }
});

// A corporate proxy answering "401 Proxy Authentication Required" with an HTML body is not the
// authorization server saying the grant is dead. Unlinking on it costs a full browser re-link.
test('a non-OAuth 401 is not read as a dead grant', async () => {
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: 'rt' },
    { fetchImpl: async () => streamRes('<html>Proxy Authentication Required</html>', 401), timeoutMs: 500 },
  );
  assert.ok(!r.invalidGrant);
  assert.equal(r.failure, GrantFailure.HTTP_OTHER);
});

test('refreshTokens refuses to ask without a refresh token', async () => {
  let asked = false;
  const r = await refreshTokens(
    { tokenEndpoint: 'https://x/oauth/token', clientId: 'cid', refreshToken: null },
    { fetchImpl: async () => { asked = true; return jsonRes({}); } },
  );
  assert.equal(asked, false);
  assert.equal(r.tokens, null);
  assert.equal(r.failure, GrantFailure.NO_REFRESH_TOKEN);
});

// ── discovery carries the revocation endpoint, or nothing ────────────────────

const discoveryFetch = (extra) => async (url) => (String(url).endsWith('/.well-known/oauth-protected-resource')
  ? jsonRes({ authorization_servers: ['https://clerk.example.com'] })
  : jsonRes({
    authorization_endpoint: 'https://clerk.example.com/oauth/authorize',
    token_endpoint: 'https://clerk.example.com/oauth/token',
    registration_endpoint: 'https://clerk.example.com/oauth/register',
    ...extra,
  }));

test('discover reads revocation_endpoint when the provider publishes one', async () => {
  const meta = await discover({
    origin: 'https://api.example.com',
    fetchImpl: discoveryFetch({ revocation_endpoint: 'https://clerk.example.com/oauth/revoke' }),
  });
  assert.equal(meta.revocationEndpoint, 'https://clerk.example.com/oauth/revoke');
});

// Guessing `${token_endpoint}/revoke` produced a URL that 404s and a logout that claimed the grant
// had been revoked. Absent metadata means the revocation is UNCONFIRMED, never fabricated.
test('discover reports no revocation endpoint rather than inventing one', async () => {
  const meta = await discover({ origin: 'https://api.example.com', fetchImpl: discoveryFetch({}) });
  assert.equal(meta.revocationEndpoint, null);
});

test('discovery is bounded end to end too', async () => {
  const started = Date.now();
  await withLoopAlive(() => assert.rejects(discover({
    origin: 'https://api.example.com',
    fetchImpl: async () => stalledRes(),
    timeoutMs: 60,
  }), /OAuth discovery failed/));
  assert.ok(Date.now() - started < 2000);
});
