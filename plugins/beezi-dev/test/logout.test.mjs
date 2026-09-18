import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performLogout, describeLogout } from '../lib/logout.mjs';
import { commitCredentials, readCredentialRecord, CredentialStatus } from '../lib/credentials.mjs';
import { readAuthMarkers, markReauthRequired } from '../lib/auth-markers.mjs';
import { invalidateTokenCache } from '../lib/token.mjs';
import { auditLedgerFile, trackingStateFile, queueDir } from '../lib/paths-cursor.mjs';
import { resolveServiceName } from '../lib/credentials.mjs';
import { publishGeneration, readCurrent } from '../lib/credential-control.mjs';
import { fileForSlot } from '../lib/credential-backends.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-'));
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

const CREDS = {
  client_id: 'cid',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  revocation_endpoint: 'https://clerk.example.com/oauth/revoke',
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: 4_000_000_000_000,
};

// Every call is answered by the test; nothing here may touch the network or a real keychain.
function deps(over = {}) {
  return {
    ...FILE_STORE,
    base: 'https://api.test',
    fetchImpl: async () => ({ ok: true, status: 204, body: null, json: async () => ({}) }),
    ...over,
  };
}

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (body === undefined ? {} : body),
});

async function link(t) {
  tmpHome(t);
  await commitCredentials(CREDS, FILE_STORE);
}

// ── the truthful part ────────────────────────────────────────────────────────

test('a confirmed server unlink and a verified local delete report exactly that', async (t) => {
  await link(t);
  const calls = [];
  const out = await performLogout(deps({
    fetchImpl: async (url, init) => { calls.push([String(url), init.method]); return res(204); },
  }));

  assert.deepEqual(calls, [['https://api.test/me/cursor/machine', 'DELETE']]);
  assert.equal(out.remote.status, 'confirmed');
  assert.equal(out.local.deleted, true);
  assert.equal(out.local.verified, true);
  assert.equal(out.exitCode, 0);
  assert.equal((await readCredentialRecord(FILE_STORE)).status, CredentialStatus.MISSING);
});

// AUTH-01. A 401 says the token was not accepted; it is not the server confirming it removed the
// machine's row. Printing "unlinked" on it told users a grant had been destroyed that was still live.
test('a 401 or 403 from the unlink is REFUSED, never confirmed', async (t) => {
  for (const status of [401, 403]) {
    await link(t);
    const out = await performLogout(deps({ fetchImpl: async () => res(status) }));
    assert.equal(out.remote.status, 'refused', `HTTP ${status}`);
    assert.equal(out.remote.httpStatus, status);
    assert.equal(out.local.verified, true, 'the local half still succeeds');
  }
});

test('a 5xx is unconfirmed and an unreachable server is unreachable', async (t) => {
  await link(t);
  assert.equal((await performLogout(deps({ fetchImpl: async () => res(503) }))).remote.status, 'unconfirmed');

  await link(t);
  const offline = await performLogout(deps({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } }));
  assert.equal(offline.remote.status, 'unreachable');
  assert.equal(offline.local.verified, true, 'local logout does not depend on remote reachability');
});

// ── revocation comes from metadata or is unconfirmed ─────────────────────────

test('revocation uses the discovered endpoint when the server unlink did not confirm', async (t) => {
  await link(t);
  const urls = [];
  const out = await performLogout(deps({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes('/oauth/revoke') ? res(200) : res(503);
    },
  }));
  assert.equal(out.revoke.status, 'confirmed');
  assert.ok(urls.includes('https://clerk.example.com/oauth/revoke'));
});

// The old code derived `${token_endpoint}/revoke`. That URL 404s on a provider that publishes none,
// and the 404 was reported to the user as "access revoked".
test('a credential with no revocation endpoint yields "unavailable", not a guessed URL', async (t) => {
  tmpHome(t);
  await commitCredentials({ ...CREDS, revocation_endpoint: null }, FILE_STORE);
  const urls = [];
  const out = await performLogout(deps({
    fetchImpl: async (url) => { urls.push(String(url)); return res(503); },
  }));
  assert.equal(out.revoke.status, 'unavailable');
  assert.ok(!urls.some((u) => u.includes('revoke')), `no revoke URL was invented: ${urls.join(', ')}`);
});

test('a revocation endpoint that refuses is unconfirmed, not confirmed', async (t) => {
  await link(t);
  const out = await performLogout(deps({
    fetchImpl: async (url) => (String(url).includes('revoke') ? res(400) : res(503)),
  }));
  assert.equal(out.revoke.status, 'unconfirmed');
});

test('a confirmed server unlink makes a separate revocation unnecessary', async (t) => {
  await link(t);
  const urls = [];
  const out = await performLogout(deps({ fetchImpl: async (url) => { urls.push(String(url)); return res(204); } }));
  assert.equal(out.remote.status, 'confirmed');
  assert.equal(out.revoke.status, 'unavailable');
  assert.ok(!urls.some((u) => u.includes('revoke')), 'the unlink already destroyed the client');
});

// ── the local half is mandatory for a success claim ──────────────────────────

test('a local deletion that cannot be verified fails the command and says what to do', async (t) => {
  tmpHome(t);
  // A keychain that accepts the delete and keeps serving the value afterwards.
  const entries = new Map();
  const run = (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '' };
    const key = `${args[args.indexOf('-s') + 1]}::${args[args.indexOf('-a') + 1]}`;
    if (args[0] === 'add-generic-password') { entries.set(key, args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (args[0] === 'find-generic-password') return entries.has(key) ? { ok: true, stdout: `${entries.get(key)}\n` } : { ok: false, stdout: '' };
    if (args[0] === 'delete-generic-password') return { ok: false, stdout: '' }; // refuses, silently
    return { ok: false, stdout: '' };
  };
  await commitCredentials(CREDS, { platform: 'darwin', run });

  const store = { platform: 'darwin', run };
  const out = await performLogout(deps({ ...store, fetchImpl: async () => res(204) }));
  assert.equal(out.local.verified, false);
  assert.equal(out.exitCode, 1);
  assert.match(describeLogout(out).join('\n'), /could not be removed|still/i);

  // The store must still describe the credential that is demonstrably still there. Publishing a
  // generation-0 tombstone here would make the next read — and the next logout — say "not linked"
  // while the token sits in the keychain, which is the same lie AUTH-01 is about.
  const after = await readCredentialRecord(store);
  assert.equal(after.status, CredentialStatus.OK, 'the record still names the surviving generation');
  assert.equal(after.creds.access_token, 'at');
  assert.equal(entries.size, 1, 'and the secret really is still readable');

  // A second attempt must try again, not congratulate itself.
  const retry = await performLogout(deps({ ...store, fetchImpl: async () => res(204) }));
  assert.notEqual(retry.alreadyUnlinked, true, 'it did not decide there was nothing to do');
  assert.equal(retry.local.verified, false);
  assert.equal(retry.exitCode, 1);
  assert.ok(!/Logged out/.test(describeLogout(retry).join('\n')), 'and it did not claim success');
});

// The other half of the same rule: once the store really is empty, the tombstone IS published, so
// the epoch keeps advancing and a later read does not wander back into a legacy scan.
test('a verified deletion tombstones, so a second logout reports nothing to do', async (t) => {
  await link(t);
  const first = await performLogout(deps({ fetchImpl: async () => res(204) }));
  assert.equal(first.local.verified, true);

  const second = await performLogout(deps({ fetchImpl: async () => res(204) }));
  assert.equal(second.alreadyUnlinked, true);
  assert.equal(second.exitCode, 0);
});

test('an already-unlinked machine reports nothing to do and succeeds', async (t) => {
  tmpHome(t);
  let asked = false;
  const out = await performLogout(deps({ fetchImpl: async () => { asked = true; return res(204); } }));
  assert.equal(out.local.deleted, false);
  assert.equal(out.local.verified, true);
  assert.equal(out.exitCode, 0);
  assert.equal(asked, false, 'no request is sent on behalf of a machine that is not linked');
});

test('a store that will not answer is not reported as an unlinked machine', async (t) => {
  tmpHome(t);
  const out = await performLogout(deps({
    platform: 'darwin',
    run: () => ({ ok: false, stdout: '', timedOut: true }),
    getCredentialRecord: async () => ({ status: CredentialStatus.TIMEOUT, creds: null, generation: 3, epoch: 1 }),
  }));
  assert.equal(out.local.verified, false);
  assert.equal(out.local.error, 'timeout');
  assert.equal(out.exitCode, 1);
});

// ── refresh-before-lease, and reread under it ────────────────────────────────

test('an expired credential is refreshed first, and the REREAD token is what is sent', async (t) => {
  tmpHome(t);
  await commitCredentials({ ...CREDS, expires_at: 1 }, FILE_STORE);
  const sent = [];
  const out = await performLogout(deps({
    now: () => 1_000_000,
    refreshTokens: async () => ({ tokens: { access_token: 'rotated', refresh_token: 'rt2', expires_in: 3600 } }),
    fetchImpl: async (url, init) => { sent.push(init.headers.Authorization); return res(204); },
  }));
  assert.deepEqual(sent, ['Bearer rotated'], 'the pre-refresh token is never the one sent');
  assert.equal(out.remote.status, 'confirmed');
  assert.equal(out.local.verified, true);
});

// ── cleanup, scoped ──────────────────────────────────────────────────────────

test('tenant policy cache, audit ledger and auth markers go; queued analytics do not', async (t) => {
  await link(t);
  fs.writeFileSync(trackingStateFile(), JSON.stringify({ email: 'dev@acme.com' }), 'utf-8');
  fs.writeFileSync(auditLedgerFile(), JSON.stringify({ version: 1 }), 'utf-8');
  markReauthRequired(1);
  fs.mkdirSync(queueDir(), { recursive: true });
  fs.writeFileSync(path.join(queueDir(), 'seg.json'), '{}', 'utf-8');

  await performLogout(deps({ fetchImpl: async () => res(204) }));

  assert.equal(fs.existsSync(trackingStateFile()), false, 'the tenant policy cache is account state');
  assert.equal(fs.existsSync(auditLedgerFile()), false, 'so is the audit ledger');
  assert.equal(readAuthMarkers().reauthRequired, false);
  assert.equal(fs.existsSync(path.join(queueDir(), 'seg.json')), true, 'unsent user data is not incidental cleanup');
});

test('the installation-rotation callback fires once on a successful local logout', async (t) => {
  await link(t);
  const rotations = [];
  await performLogout(deps({
    fetchImpl: async () => res(204),
    onInstallationRotate: (reason) => rotations.push(reason),
  }));
  assert.deepEqual(rotations, ['logout']);
});

test('an unconfirmed unlink is recorded through the injected diagnostics callback', async (t) => {
  await link(t);
  const issues = [];
  await performLogout(deps({
    fetchImpl: async () => res(503),
    recordIssue: (code, fields) => issues.push([code, fields]),
  }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0][0], 'logout_unlink_unconfirmed');
  assert.deepEqual(Object.keys(issues[0][1]).sort(), ['httpStatus', 'status']);
  // Structured fields only — no token, no URL, no message (CONTRACTS section 8).
  assert.equal(issues[0][1].status, 'unconfirmed');
  assert.equal(issues[0][1].httpStatus, 503);
});

test('diagnostics default to a no-op, so logout works with no telemetry at all', async (t) => {
  await link(t);
  const out = await performLogout(deps({ fetchImpl: async () => res(503) }));
  assert.equal(out.exitCode, 0);
});

// ── a racing login survives ──────────────────────────────────────────────────

test('a logout fenced to a generation refuses to delete a newer one', async (t) => {
  await link(t);
  // A new sign-in has landed since this logout read the store: the observed generation is 1, the
  // committed one is 2. Deleting "whatever is current" would take the fresh link with it.
  await commitCredentials({ ...CREDS, client_id: 'cid-2', access_token: 'new' }, FILE_STORE);
  const stale = { status: CredentialStatus.OK, creds: CREDS, generation: 1, epoch: 1 };

  const out = await performLogout(deps({
    fetchImpl: async () => res(204),
    getCredentialRecord: async () => stale,
  }));
  assert.equal(out.local.deleted, false);
  assert.equal(out.local.error, 'conflict');
  assert.equal(out.exitCode, 1);
  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, CredentialStatus.OK);
  assert.equal(after.creds.access_token, 'new', 'the racing login survived');
});

// ── the phrasing is one function, so the script and the skill cannot drift ───

test('describeLogout names each actual outcome', async (t) => {
  const lines = (over) => describeLogout({
    local: { deleted: true, verified: true },
    remote: { status: 'confirmed' },
    revoke: { status: 'unavailable' },
    exitCode: 0,
    ...over,
  }).join('\n');

  assert.match(lines({}), /unlinked/i);
  assert.match(lines({ remote: { status: 'refused', httpStatus: 401 } }), /refused|may still/i);
  assert.match(lines({ remote: { status: 'unreachable' } }), /could not reach/i);
  assert.match(
    lines({ remote: { status: 'unreachable' }, revoke: { status: 'confirmed' } }),
    /revoked/i,
  );
});

// The window the review named: a logout reads the store, then spends real time on the unlink and
// revoke NETWORK calls, and a login can land in that gap. Nothing may erase it.
test('a login landing during the logout network calls survives', async (t) => {
  await link(t);
  let relinked = false;
  const out = await performLogout(deps({
    fetchImpl: async () => {
      // Another PROCESS completes a sign-in while this request is in flight. It is simulated by
      // publishing the next generation directly, which is exactly what that process's commit would
      // do — the publish is a filesystem compare-and-set and needs no lock, so this does not
      // deadlock against the lease performLogout is holding.
      if (!relinked) {
        relinked = true;
        const service = resolveServiceName(FILE_STORE);
        const { generation } = readCurrent(service);
        fs.writeFileSync(
          fileForSlot(`g${generation + 1}`),
          JSON.stringify({ token: JSON.stringify({ ...CREDS, client_id: 'cid-2', access_token: 'relinked' }) }),
          'utf-8',
        );
        assert.equal(
          publishGeneration(service, generation + 1, {
            backend: 'file', epoch: 9, clientId: 'cid-2', updatedAt: 'x',
          }),
          'published',
        );
      }
      return res(204);
    },
  }));

  assert.notEqual(out.exitCode, 0, 'a logout that could not delete what it observed does not succeed');
  assert.equal(out.local.deleted, false);
  assert.equal(out.local.error, 'conflict');

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.status, CredentialStatus.OK, 'the new link was erased by the in-flight logout');
  assert.equal(after.creds.access_token, 'relinked');
  assert.match(describeLogout(out).join('\n'), /signed in again|newer sign-in/i);
});
