import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  REBIND_AFTER_MS,
  UUID_V4,
  randomUuid,
  readInstallationRecord,
  ensureInstallationId,
  currentInstallationId,
  needsBinding,
  markBound,
  rotateInstallation,
  bindInstallation,
} from '../lib/telemetry-installation.mjs';
import { setConsent, CORRELATION_CONSENT_VERSION } from '../lib/telemetry-consent.mjs';
import { installationFile } from '../lib/telemetry-store.mjs';

async function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-inst-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The module's CODE, with its comments stripped — the comments deliberately name the things the
// code must not use, and explaining a prohibition is not breaking it.
const codeOf = (url) => fs.readFileSync(url, 'utf-8')
  .split(/\r?\n/)
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

// ─── minting ────────────────────────────────────────────────────────────────

test('randomUuid is a v4 UUID built from randomBytes, not crypto.randomUUID', () => {
  // crypto.randomUUID landed in Node 14.17; the engines floor is 13.2. The source must not
  // reference it at all — a guarded call is still a call this floor would have to survive.
  const code = codeOf(new URL('../lib/telemetry-installation.mjs', import.meta.url));
  assert.ok(!code.includes('randomUUID'), 'randomUUID must not be called on this floor');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = randomUuid();
    assert.match(id, UUID_V4, id);
    seen.add(id);
  }
  assert.equal(seen.size, 200, 'ids must not repeat');
});

test('anonymous mode never creates an identifier', async () => {
  await withHome(() => {
    setConsent('on');
    assert.equal(ensureInstallationId(), null);
    assert.equal(fs.existsSync(installationFile()), false);
    assert.equal(currentInstallationId(), null);

    setConsent('anonymous');
    assert.equal(ensureInstallationId(), null);
    assert.equal(fs.existsSync(installationFile()), false);
  });
});

test('correlation consent mints exactly one identifier and reuses it', async () => {
  await withHome(() => {
    setConsent('correlate');
    const first = ensureInstallationId();
    assert.match(first, UUID_V4);
    assert.equal(ensureInstallationId(), first);
    const record = readInstallationRecord();
    assert.equal(record.consentVersion, CORRELATION_CONSENT_VERSION);
    assert.equal(record.boundAt, null);
  });
});

test('an unconfirmed binding never stamps an event', async () => {
  await withHome(() => {
    setConsent('correlate');
    ensureInstallationId();
    assert.equal(currentInstallationId(), null, 'minted is not bound');
    markBound(Date.parse('2026-09-17T00:00:00.000Z'));
    assert.match(currentInstallationId(), UUID_V4);
  });
});

test('a malformed record reads as absent', async () => {
  await withHome(() => {
    setConsent('correlate');
    fs.mkdirSync(path.dirname(installationFile()), { recursive: true });
    for (const raw of ['{', JSON.stringify({ version: 9, id: randomUuid() }),
      JSON.stringify({ version: 1, id: 'not-a-uuid' })]) {
      fs.writeFileSync(installationFile(), raw);
      assert.equal(readInstallationRecord(), null, raw);
      assert.equal(currentInstallationId(), null, raw);
    }
  });
});

// ─── rebinding at seven days ────────────────────────────────────────────────

test('rebinding is due after seven days, not ninety', async () => {
  await withHome(() => {
    setConsent('correlate');
    ensureInstallationId();
    assert.equal(REBIND_AFTER_MS, 7 * 24 * 60 * 60 * 1000);
    const boundAt = Date.parse('2026-09-01T00:00:00.000Z');
    assert.equal(needsBinding(boundAt), true, 'never bound');
    markBound(boundAt);
    assert.equal(needsBinding(boundAt + REBIND_AFTER_MS - 1000), false);
    assert.equal(needsBinding(boundAt + REBIND_AFTER_MS + 1000), true);
  });
});

test('binding is never due without correlation consent', async () => {
  await withHome(() => {
    setConsent('on');
    assert.equal(needsBinding(), false);
  });
});

// ─── the binding call ───────────────────────────────────────────────────────

function fakePost(status, calls) {
  return async (url, token, body, deps) => {
    calls.push({ url, token, body, deps });
    return { status, headers: { get: () => null } };
  };
}

test('a 2xx binding stamps the identity; the body is only id and consent version', async () => {
  await withHome(async () => {
    setConsent('correlate');
    const calls = [];
    const result = await bindInstallation({ token: 'tok', postJsonImpl: fakePost(200, calls) });
    assert.equal(result.status, 'bound');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/cli-agent\/plugin-diagnostics\/installation$/);
    assert.equal(calls[0].token, 'tok');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['consentVersion', 'installationId']);
    assert.equal(calls[0].body.consentVersion, CORRELATION_CONSENT_VERSION);
    assert.match(currentInstallationId(), UUID_V4);
  });
});

test('binding never refreshes OAuth just to send diagnostics', async () => {
  await withHome(async () => {
    setConsent('correlate');
    let refreshes = 0;
    const result = await bindInstallation({
      token: null,
      forceRefresh: async () => { refreshes += 1; return { ok: true, token: 't' }; },
      postJsonImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(refreshes, 0, 'no refresh was attempted');
    assert.equal(result.status, 'no-token');
    assert.equal(currentInstallationId(), null);
    // The module must not even be able to: it imports nothing from token.mjs.
    const code = codeOf(new URL('../lib/telemetry-installation.mjs', import.meta.url));
    assert.ok(!code.includes('token.mjs'), 'no import of the token store');
  });
});

test('a 409 conflict rotates the identity so it is never reassigned', async () => {
  await withHome(async () => {
    setConsent('correlate');
    const before = ensureInstallationId();
    markBound(Date.now());
    const events = [];
    const result = await bindInstallation({
      token: 'tok',
      postJsonImpl: fakePost(409, []),
      recordIssue: (code, fields) => { events.push({ code, fields }); return true; },
    });
    assert.equal(result.status, 'conflict');
    assert.equal(fs.existsSync(installationFile()), false, 'the conflicting id is dropped');
    assert.equal(currentInstallationId(), null);
    assert.notEqual(ensureInstallationId(), before, 'the next one is fresh');
    assert.deepEqual(events.map((e) => e.code), ['installation_binding_failed']);
    assert.deepEqual(Object.keys(events[0].fields).sort(), ['reason', 'source', 'status']);
  });
});

test('an unauthorized or unreachable binding leaves the identity unstamped', async () => {
  for (const status of [401, 403, 500, 0]) {
    // eslint-disable-next-line no-await-in-loop
    await withHome(async () => {
      setConsent('correlate');
      ensureInstallationId();
      const result = await bindInstallation({
        token: 'tok',
        postJsonImpl: status === 0
          ? async () => { throw new Error('ECONNREFUSED'); }
          : fakePost(status, []),
      });
      assert.notEqual(result.status, 'bound', String(status));
      assert.equal(currentInstallationId(), null, String(status));
      assert.ok(fs.existsSync(installationFile()), 'the id survives a failure it did not cause');
    });
  }
});

test('binding does nothing at all without correlation consent', async () => {
  await withHome(async () => {
    setConsent('on');
    let posted = 0;
    const result = await bindInstallation({
      token: 'tok',
      postJsonImpl: async () => { posted += 1; return { status: 200 }; },
    });
    assert.equal(posted, 0);
    assert.equal(result.status, 'no-consent');
    assert.equal(fs.existsSync(installationFile()), false);
  });
});

// ─── logout and opt-out ─────────────────────────────────────────────────────

test('logout rotates the identity', async () => {
  await withHome(() => {
    setConsent('correlate');
    ensureInstallationId();
    markBound(Date.now());
    assert.equal(rotateInstallation(), true);
    assert.equal(fs.existsSync(installationFile()), false);
    assert.equal(currentInstallationId(), null);
    // Rotating twice is not an error: a missing file IS the rotated state.
    assert.equal(rotateInstallation(), false);
  });
});

test('turning diagnostics off takes the identity with it', async () => {
  await withHome(() => {
    setConsent('correlate');
    ensureInstallationId();
    markBound(Date.now());
    setConsent('off');
    assert.equal(fs.existsSync(installationFile()), false);
  });
});

test('going anonymous takes the identity with it', async () => {
  await withHome(() => {
    setConsent('correlate');
    ensureInstallationId();
    markBound(Date.now());
    setConsent('anonymous');
    assert.equal(fs.existsSync(installationFile()), false);
    assert.equal(currentInstallationId(), null);
  });
});
