import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MARKERS_VERSION,
  REFRESH_BACKOFF_MS,
  clearAuthMarkers,
  inBackoff,
  markReauthRequired,
  markRefreshFailure,
  markersFile,
  readAuthMarkers,
  reauthRequiredFor,
} from '../lib/auth-markers.mjs';
import { AuthReason } from '../lib/auth-state.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markers-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const staging = { keyringService: () => 'beezi-cursor-staging' };

test('absent or unreadable markers read as "nothing is known"', (t) => {
  const dir = tmpHome(t);
  assert.deepEqual(readAuthMarkers(), {
    version: MARKERS_VERSION,
    generation: 0,
    reauthRequired: false,
    reason: AuthReason.NONE,
    attempts: 0,
    backoffUntil: 0,
    inflight: null,
  });

  // Permissive on purpose: an unreadable marker file costs one extra refresh attempt, where the
  // restrictive reading would lock a machine out of refreshing at all.
  fs.writeFileSync(markersFile(), '{ truncated', 'utf-8');
  assert.equal(readAuthMarkers().reauthRequired, false);
  assert.equal(fs.existsSync(path.join(dir, 'auth-markers.json')), true);
});

test('a marker from a different version is ignored rather than trusted', (t) => {
  tmpHome(t);
  fs.writeFileSync(markersFile(), JSON.stringify({ version: 99, reauthRequired: true, generation: 1 }), 'utf-8');
  assert.equal(reauthRequiredFor(1), false);
});

test('markers apply only to the generation they describe', (t) => {
  tmpHome(t);
  markReauthRequired(1);
  assert.equal(reauthRequiredFor(1), true);
  assert.equal(reauthRequiredFor(2), false, 'a new credential is not born needing re-authentication');

  markRefreshFailure(3, AuthReason.TRANSPORT, { now: () => 1000 });
  assert.equal(inBackoff(3, { now: () => 1100 }), true);
  assert.equal(inBackoff(2, { now: () => 1100 }), false);
  assert.equal(reauthRequiredFor(1), false, 'writing for generation 3 retired generation 1s marker');
});

test('the backoff advances one step per failure and holds at the last', (t) => {
  tmpHome(t);
  let now = 0;
  const seen = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    markRefreshFailure(1, AuthReason.HTTP_5XX, { now: () => now });
    seen.push(readAuthMarkers().backoffUntil - now);
    now += 1;
  }
  assert.deepEqual(seen, [...REFRESH_BACKOFF_MS, 300_000, 300_000]);
});

// I5. The markers file used to be keyed by HOME alone. A staging build and a production build
// sharing one home therefore shared one set of markers: one namespace's invalid_grant told the
// other's perfectly good credential to re-authenticate, and its backoff suppressed the other's
// refresh.
test('two namespaces in one home keep separate markers', (t) => {
  const dir = tmpHome(t);
  assert.notEqual(markersFile(), markersFile(staging));
  assert.equal(path.basename(markersFile()), 'auth-markers.json', 'the default namespace keeps the shipped name');
  assert.equal(path.basename(markersFile(staging)), 'auth-markers.beezi-cursor-staging.json');

  markReauthRequired(1, AuthReason.INVALID_GRANT, staging);
  assert.equal(reauthRequiredFor(1, staging), true);
  assert.equal(reauthRequiredFor(1), false, 'production was not told to re-authenticate');

  // Production's failing provider must not stop staging from trying its own.
  markRefreshFailure(1, AuthReason.TRANSPORT, { now: () => 1000 });
  assert.equal(inBackoff(1, { now: () => 1100 }), true);
  assert.equal(inBackoff(1, { ...staging, now: () => 1100 }), false, "staging inherited production's backoff");

  clearAuthMarkers(staging);
  assert.equal(reauthRequiredFor(1, staging), false);
  assert.equal(inBackoff(1, { now: () => 1100 }), true, "clearing staging cleared production's too");
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.startsWith('auth-markers')),
    ['auth-markers.json'],
    'each namespace owns exactly one file, and only staging’s was removed',
  );
});

test('a marker file is written with restricted permissions (posix only)', { skip: process.platform === 'win32' }, (t) => {
  tmpHome(t);
  markReauthRequired(1);
  assert.equal(fs.statSync(markersFile()).mode & 0o777, 0o600);
});
