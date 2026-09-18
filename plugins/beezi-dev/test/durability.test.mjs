import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeFileAtomic, writeJsonSecure } from '../lib/fs-store.mjs';
import { isStale } from '../lib/billing-config.mjs';
import { refreshTokens } from '../lib/oauth.mjs';

// The failures pinned here all share a shape: something goes wrong for a moment, and the plugin
// turns that moment into permanent loss — of the user's file, of their link, or of analytics that
// were already consumed from the sidecar.

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-durability-'));
}

test('a failed write leaves the previous file intact', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'hooks.json');
  fs.writeFileSync(file, '{"hooks":{"theirs":[1,2,3]}}', 'utf-8');

  // A value JSON.stringify cannot serialise stands in for any mid-write failure: ENOSPC, or
  // Cursor's hard 10s kill landing between the truncate and the write.
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonSecure(file, circular));

  // The old contents must still be there. writeFileSync would have truncated first.
  assert.deepEqual(readJson(file), { hooks: { theirs: [1, 2, 3] } });
});

test('a failed write leaves no temp file behind', () => {
  const dir = tmpdir();
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonSecure(path.join(dir, 'state.json'), circular));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('writeFileAtomic replaces content in place', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'settings.json');
  writeFileAtomic(file, 'first\n');
  writeFileAtomic(file, 'second\n');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'second\n');
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('only a named OAuth error unlinks the machine', async () => {
  const answer = (status, body) => async () => ({
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not JSON');
      return body;
    },
  });
  const call = (fetchImpl) =>
    refreshTokens({ tokenEndpoint: 'https://x/token', clientId: 'c', refreshToken: 'r' }, { fetchImpl });

  // Positive evidence: the grant really is dead.
  assert.deepEqual(await call(answer(400, { error: 'invalid_grant' })), { invalidGrant: true });
  assert.deepEqual(await call(answer(401, { error: 'invalid_client' })), { invalidGrant: true });

  // Everything else is transient. A corporate proxy answering 401 with an HTML body used to be
  // read as revocation, and the only copy of the refresh token was deleted. The result now also
  // CLASSIFIES the failure, so the caller can back off on the right schedule; what matters here is
  // that none of these produces a token and none of them claims the grant is dead.
  for (const transient of [
    answer(401, undefined), answer(400, undefined),
    answer(400, { message: 'rate limited' }), answer(429, { error: 'slow_down' }),
  ]) {
    const r = await call(transient);
    assert.equal(r.tokens, null);
    assert.ok(!r.invalidGrant, 'no unlink without positive evidence');
    assert.ok(r.failure, 'and the reason is named');
  }
});

test('a machine with no captured plan is stale, so the nudge can fire', () => {
  // The caller's wording is "plan info is missing or stale"; `false` here made the missing half
  // unreachable for every machine that linked but never ran the plan step.
  assert.equal(isStale(null), true);
  assert.equal(isStale(undefined), true);
  // A non-subscription source carries no plan, so staleness is not a concept there.
  assert.equal(isStale({ source: 'api_key' }), false);
});
