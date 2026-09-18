import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as telemetry from '../lib/telemetry.mjs';
import { telemetryQueueDir, installationFile } from '../lib/telemetry-store.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fac-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    telemetry.suppressRecording(false);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The same rule production uses: only a `.json` basename is an event (`listQueueFiles` in
// lib/telemetry-store.mjs). `writeFileAtomic` writes `.<name>.<pid>.tmp` beside the target and
// renames it, and on Windows a scanner holding either handle can make both the rename and the
// cleanup fail — leaving a fully-written `.tmp` that production ignores. Counting it here made
// this file intermittently fail with two events where it expected one.
const pending = () => {
  try { return fs.readdirSync(telemetryQueueDir()).filter((n) => n.endsWith('.json')).sort(); }
  catch { return []; }
};

// ─── the frozen surface ─────────────────────────────────────────────────────

test('the facade exports exactly the names CONTRACTS §8 froze', () => {
  for (const name of ['recordIssue', 'maybeLaunchWorker', 'telemetryStatus', 'onLogout']) {
    assert.equal(typeof telemetry[name], 'function', name);
  }
});

test('the code allowlist is exactly the one CONTRACTS §8 names', () => {
  const codes = Object.keys(telemetry.DIAGNOSTIC_CODES)
    .map((key) => telemetry.DIAGNOSTIC_CODES[key])
    .sort();
  assert.deepEqual(codes, [
    'auth_state_transition',
    'hook_crash',
    'hook_import_failed',
    'hook_unhandled_rejection',
    'installation_binding_failed',
    'login_failed',
    'logout_unlink_unconfirmed',
    'mcp_handshake_timeout',
    'mcp_startup_failed',
    'queue_file_quarantined',
    'queue_flush_http_error',
    'state_write_failed',
  ]);
});

// ─── recordIssue ────────────────────────────────────────────────────────────

test('recordIssue never throws, whatever it is handed', async () => {
  await withHome(() => {
    telemetry.setConsent('on');
    for (const args of [
      [], [null], [undefined, undefined], ['hook_crash', null], ['hook_crash', 'not an object'],
      ['hook_crash', { source: Symbol('x') }], [{}, {}], [123, []],
    ]) {
      assert.doesNotThrow(() => telemetry.recordIssue(...args), JSON.stringify(String(args[0])));
    }
  });
});

test('recordIssue is consent-gated at the facade too', async () => {
  await withHome(() => {
    assert.equal(telemetry.recordIssue('hook_crash', { source: 'stop' }), false);
    assert.deepEqual(pending(), []);
    telemetry.setConsent('on');
    assert.equal(telemetry.recordIssue('hook_crash', { source: 'stop' }), true);
    assert.equal(pending().length, 1);
  });
});

test('a code outside the allowlist is refused', async () => {
  await withHome(() => {
    telemetry.setConsent('on');
    assert.equal(telemetry.recordIssue('token_refresh_failed', { source: 'stop' }), false,
      'a backend code this plugin does not emit is still not in OUR allowlist');
    assert.equal(telemetry.recordIssue('something_new', { source: 'stop' }), false);
    assert.deepEqual(pending(), []);
  });
});

test('a recorded event carries the correlation id once the binding is confirmed', async () => {
  await withHome(async () => {
    telemetry.setConsent('correlate');
    telemetry.recordIssue('login_failed', { source: 'login' });
    const before = JSON.parse(fs.readFileSync(path.join(telemetryQueueDir(), pending()[0]), 'utf-8'));
    assert.equal(before.installationId, null, 'unbound machines stay anonymous');

    await telemetry.bindInstallation({
      token: 'tok',
      postJsonImpl: async () => ({ status: 200 }),
    });
    telemetry.recordIssue('mcp_startup_failed', { source: 'mcp_bridge' });
    const stamped = pending()
      .map((name) => JSON.parse(fs.readFileSync(path.join(telemetryQueueDir(), name), 'utf-8')))
      .filter((event) => event.code === 'mcp_startup_failed');
    assert.equal(stamped.length, 1);
    assert.match(stamped[0].installationId, /^[0-9a-f-]{36}$/);
  });
});

// ─── status ─────────────────────────────────────────────────────────────────

test('telemetryStatus reports the state and never the identifier itself', async () => {
  await withHome(async () => {
    assert.deepEqual(telemetry.telemetryStatus(), {
      enabled: false, correlated: false, decided: false, noticeShown: false, pending: 0, bound: false,
    });
    telemetry.setConsent('correlate');
    await telemetry.bindInstallation({ token: 'tok', postJsonImpl: async () => ({ status: 200 }) });
    const status = telemetry.telemetryStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.correlated, true);
    assert.equal(status.bound, true);
    const id = JSON.parse(fs.readFileSync(installationFile(), 'utf-8')).id;
    assert.ok(!JSON.stringify(status).includes(id), 'the value is not a status field');
  });
});

// ─── logout ─────────────────────────────────────────────────────────────────

test('onLogout rotates the correlation identity and is safe to call twice', async () => {
  await withHome(async () => {
    telemetry.setConsent('correlate');
    await telemetry.bindInstallation({ token: 'tok', postJsonImpl: async () => ({ status: 200 }) });
    assert.equal(telemetry.telemetryStatus().bound, true);

    assert.equal(telemetry.onLogout(), true);
    assert.equal(telemetry.currentInstallationId(), null);
    assert.equal(telemetry.telemetryStatus().bound, false);
    assert.equal(telemetry.onLogout(), false, 'already rotated is not an error');
    // Diagnostics themselves are untouched: signing out is not withdrawing consent.
    assert.equal(telemetry.telemetryStatus().enabled, true);
  });
});

// ─── the one-time notice ────────────────────────────────────────────────────

test('the notice names the skill and the command and is not itself a stamp', async () => {
  await withHome(() => {
    const notice = telemetry.pendingNotice();
    assert.match(notice, /beezi-telemetry/);
    assert.match(notice, /beezi telemetry on/);
    assert.match(notice, /OFF unless you turn it on/);
    assert.equal(telemetry.hasNoticeBeenShown(), false, 'reading it stamps nothing');
    assert.equal(telemetry.pendingNotice(), notice, 'and it is still pending');

    telemetry.markNoticeShown();
    assert.equal(telemetry.pendingNotice(), null, 'shown once is shown');
    assert.equal(telemetry.hasBeenAsked(), false, 'shown is still not decided');
  });
});

test('a machine that already decided is never offered the notice', async () => {
  await withHome(() => {
    telemetry.setConsent('off');
    assert.equal(telemetry.pendingNotice(), null);
  });
});

// ── the surfaces that actually show the status and the notice (SC-2) ──────────────────

// Diagnostics are OFF unless turned on, and a setting nobody can read is a setting nobody can
// trust — so `beezi me` says where they stand on every one of its exits, not just the happy one.
// The notice is the other half: it must be shown, and shown ONCE. `pendingNotice()` deliberately
// does not stamp itself (Cursor may drop a hook's stdout without anyone noticing), so the stamp
// belongs to whatever actually printed it, and these two runs are what prove the stamp happened.
const ME = fileURLToPath(new URL('../scripts/me.mjs', import.meta.url));

function spawnMe(home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ME],
      // A closed port: an unlinked home needs no network, and this makes sure it takes none.
      { env: { ...process.env, BEEZI_CURSOR_HOME: home, BEEZI_API_URL: 'http://127.0.0.1:1/api' } },
      (error, stdout, stderr) => resolve({ code: error == null ? 0 : error.code, stdout, stderr }),
    );
  });
}

test('beezi me states where diagnostics stand, and offers the notice exactly once', async () => {
  await withHome(async (home) => {
    const first = await spawnMe(home);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^ {2}Diagnostics: off$/m, 'the status line is on the unlinked exit too');
    assert.match(first.stdout, /anonymous crash reports about this plugin/, 'and the notice is offered');

    // Printing it IS the stamp. A second run must not ask again: repeating a consent prompt until
    // it is answered is how silence turns into a yes.
    const second = await spawnMe(home);
    assert.match(second.stdout, /^ {2}Diagnostics: off$/m);
    assert.equal(
      /anonymous crash reports about this plugin/.test(second.stdout),
      false,
      'the notice was stamped by the surface that printed it',
    );
  });
});
