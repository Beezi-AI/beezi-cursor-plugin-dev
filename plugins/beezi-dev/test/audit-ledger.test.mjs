import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadLedger,
  isImported,
  markImported,
  saveLedger,
  markComplete,
  isComplete,
  markUnreadable,
  wasUnreadable,
  hasImports,
  loadSyncState,
  saveSyncState,
  syncProgressFor,
  recordSyncProgress,
  syncStateFile,
  SYNC_STATE_VERSION,
} from '../lib/audit-ledger.mjs';
import { auditLedgerFile } from '../lib/paths-cursor.mjs';
import { pruneStale } from '../lib/prune.mjs';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    delete process.env.BEEZI_CURSOR_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('an empty ledger reports nothing as imported', (t) => {
  makeHome(t);
  const ledger = loadLedger();

  assert.equal(isImported(ledger, 'conv-1'), false);
  assert.deepEqual(ledger.sessions, {});
});

// hasImports is the client-side proxy for "a pull exists server-side": /complete on a pull that
// was never opened is ignored with a warning, so the seal is gated on it.
test('hasImports reflects whether any session was ever judged', (t) => {
  makeHome(t);
  const ledger = loadLedger();

  assert.equal(hasImports(ledger), false);
  assert.equal(hasImports(null), false);

  markUnreadable(ledger, 'conv-broken');
  assert.equal(hasImports(ledger), false, 'an unreadable marker is not an import');

  markImported(ledger, 'conv-1', { outcome: 'accepted', reports: 1 });
  assert.equal(hasImports(ledger), true);
});

test('round-trips a marked session through disk', (t) => {
  makeHome(t);
  const ledger = loadLedger();
  markImported(ledger, 'conv-1', { outcome: 'stored', reports: 12 });
  saveLedger(ledger);

  const reloaded = loadLedger();

  assert.equal(isImported(reloaded, 'conv-1'), true);
  assert.equal(reloaded.sessions['conv-1'].outcome, 'stored');
  assert.equal(reloaded.sessions['conv-1'].reports, 12);
  assert.ok(reloaded.updatedAt);
});

// A repository that was never connected to Beezi rejects every one of its reports and always
// will, so resending it on each run is pure waste.
test('a rejected session counts as imported', (t) => {
  makeHome(t);
  const ledger = loadLedger();
  markImported(ledger, 'conv-1', { outcome: 'rejected', reports: 3 });
  saveLedger(ledger);

  assert.equal(isImported(loadLedger(), 'conv-1'), true);
});

test('a ledger with an unknown version is discarded, not merged', (t) => {
  makeHome(t);
  fs.mkdirSync(path.dirname(auditLedgerFile()), { recursive: true });
  fs.writeFileSync(
    auditLedgerFile(),
    JSON.stringify({ version: 99, sessions: { 'conv-1': {} } }),
    'utf-8',
  );

  assert.equal(isImported(loadLedger(), 'conv-1'), false);
});

test('a corrupt ledger file falls back to empty instead of throwing', (t) => {
  makeHome(t);
  fs.mkdirSync(path.dirname(auditLedgerFile()), { recursive: true });
  fs.writeFileSync(auditLedgerFile(), 'not json at all', 'utf-8');

  assert.deepEqual(loadLedger().sessions, {});
});

// The regression that matters: pruneStale wipes 14-day-old files in state/, queue/ AND events/,
// which is exactly why the ledger must not live in any of them.
test('survives pruneStale — the ledger is outside the pruned dirs', (t) => {
  const home = makeHome(t);
  const ledger = loadLedger();
  markImported(ledger, 'conv-1', { outcome: 'stored', reports: 1 });
  saveLedger(ledger);

  // Age the ledger well past the prune horizon, and give prune real dirs to walk.
  const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(auditLedgerFile(), ancient, ancient);
  for (const sub of ['state', 'queue', 'events']) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
    const stale = path.join(home, sub, 'stale.json');
    fs.writeFileSync(stale, '{}', 'utf-8');
    fs.utimesSync(stale, ancient, ancient);
  }

  pruneStale(Date.now());

  assert.equal(fs.existsSync(path.join(home, 'state', 'stale.json')), false, 'prune ran');
  assert.equal(isImported(loadLedger(), 'conv-1'), true, 'ledger survived');
});

test('the ledger file sits at the beeziCursorHome root', (t) => {
  const home = makeHome(t);

  assert.equal(auditLedgerFile(), path.join(home, 'audit-ledger.json'));
});

test('the complete flag round-trips and survives a reload', (t) => {
  makeHome(t);
  const ledger = loadLedger('client-1');
  assert.equal(isComplete(ledger), false);

  markComplete(ledger);
  saveLedger(ledger);

  const reloaded = loadLedger('client-1');
  assert.equal(isComplete(reloaded), true);
});

// The ledger is machine-global but the pull is per (tenant, user, tool): a ledger written under
// another login must read as EMPTY, or a workspace switch would replay it, find zero candidates
// and seal the new tenant's pull with nothing in it.
test('a foreign-identity ledger is discarded on load', (t) => {
  makeHome(t);
  const original = loadLedger('client-a');
  markImported(original, 'conv-1', { outcome: 'accepted', reports: 3 });
  markComplete(original);
  saveLedger(original);

  const foreign = loadLedger('client-b');

  assert.equal(isImported(foreign, 'conv-1'), false);
  assert.equal(isComplete(foreign), false);
  assert.equal(foreign.identity, 'client-b');

  // The same identity still sees its own ledger.
  const same = loadLedger('client-a');
  assert.equal(isImported(same, 'conv-1'), true);
  assert.equal(isComplete(same), true);
});

// A legacy ledger written before identity binding carries none — adopt it for the current login
// rather than discarding real progress.
test('an identity-less ledger is adopted by the first identified load', (t) => {
  makeHome(t);
  const legacy = loadLedger();
  markImported(legacy, 'conv-1', { outcome: 'accepted' });
  saveLedger(legacy);

  const adopted = loadLedger('client-a');
  assert.equal(isImported(adopted, 'conv-1'), true);
  assert.equal(adopted.identity, 'client-a');
});

// The unreadable marker is bookkeeping for the one retry an unreadable sidecar earns, so it must
// NOT count as imported (the session stays eligible) and must clear once the session imports.
test('unreadable markers keep the session eligible and clear on import', (t) => {
  makeHome(t);
  const ledger = loadLedger();
  markUnreadable(ledger, 'conv-1');
  saveLedger(ledger);

  const reloaded = loadLedger();
  assert.equal(wasUnreadable(reloaded, 'conv-1'), true);
  assert.equal(isImported(reloaded, 'conv-1'), false, 'still eligible for the next run');

  markImported(reloaded, 'conv-1', { outcome: 'accepted', reports: 1 });
  saveLedger(reloaded);
  assert.equal(wasUnreadable(loadLedger(), 'conv-1'), false, 'imported sessions are not unreadable');
});

// ─── sync progress (08-B) ───────────────────────────────────────────────────
//
// A SEPARATE file from the one-time ledger, on purpose. The v1 ledger's `sessions` map means "this
// session was handed to the one-time pull and judged"; a suffix uploaded by sync is not that, and
// writing it there would let an older client read a partial resume as whole-history completion.
// Nothing below ever touches `complete`, and nothing in the ledger above ever reads this file.

test('a fresh sync state is empty and scoped to the account', (t) => {
  makeHome(t);

  const state = loadSyncState('acct-a');

  assert.equal(state.version, SYNC_STATE_VERSION);
  assert.equal(state.account, 'acct-a');
  assert.deepEqual(state.sessions, {});
  assert.equal(syncProgressFor(state, 'conv-1'), null);
});

test('progress round-trips through disk with its cursor and fingerprint', (t) => {
  makeHome(t);
  const state = loadSyncState('acct-a');

  recordSyncProgress(state, 'conv-1', { cursor: 42, fingerprint: 'v1:abc' });
  saveSyncState(state);

  const reloaded = loadSyncState('acct-a');
  assert.deepEqual(syncProgressFor(reloaded, 'conv-1'), { cursor: 42, fingerprint: 'v1:abc' });
});

test('another account never inherits this one progress', (t) => {
  makeHome(t);
  const mine = loadSyncState('acct-a');
  recordSyncProgress(mine, 'conv-1', { cursor: 42, fingerprint: 'v1:abc' });
  saveSyncState(mine);

  const theirs = loadSyncState('acct-b');

  assert.deepEqual(theirs.sessions, {});
  assert.equal(syncProgressFor(theirs, 'conv-1'), null);
});

test('an unknown version is a safe rescan, never completion', (t) => {
  const home = makeHome(t);
  fs.writeFileSync(
    path.join(home, 'sync-state.json'),
    JSON.stringify({ version: 99, account: 'acct-a', sessions: { 'conv-1': { cursor: 9, fingerprint: 'v1:x' } } }),
  );

  const state = loadSyncState('acct-a');

  assert.equal(state.version, SYNC_STATE_VERSION);
  assert.deepEqual(state.sessions, {});
});

test('a corrupt file is a safe rescan', (t) => {
  const home = makeHome(t);
  fs.writeFileSync(path.join(home, 'sync-state.json'), '{not json');

  const state = loadSyncState('acct-a');

  assert.deepEqual(state.sessions, {});
});

test('an entry with no fingerprint, or a nonsense cursor, is rescanned rather than trusted', (t) => {
  const home = makeHome(t);
  fs.writeFileSync(
    path.join(home, 'sync-state.json'),
    JSON.stringify({
      version: 1,
      account: 'acct-a',
      sessions: {
        'no-print': { cursor: 9 },
        'bad-cursor': { cursor: -1, fingerprint: 'v1:x' },
        'float-cursor': { cursor: 1.5, fingerprint: 'v1:x' },
        good: { cursor: 0, fingerprint: 'v1:x' },
      },
    }),
  );

  const state = loadSyncState('acct-a');

  assert.equal(syncProgressFor(state, 'no-print'), null);
  assert.equal(syncProgressFor(state, 'bad-cursor'), null);
  assert.equal(syncProgressFor(state, 'float-cursor'), null);
  assert.deepEqual(syncProgressFor(state, 'good'), { cursor: 0, fingerprint: 'v1:x' });
});

test('sync progress is written 0600 alongside the credentials', (t) => {
  makeHome(t);
  const state = loadSyncState('acct-a');
  recordSyncProgress(state, 'conv-1', { cursor: 1, fingerprint: 'v1:a' });

  saveSyncState(state);

  assert.ok(fs.existsSync(syncStateFile()));
});

test('sync progress survives the 14-day prune that clears state/, queue/ and events/', (t) => {
  makeHome(t);
  const state = loadSyncState('acct-a');
  recordSyncProgress(state, 'conv-1', { cursor: 1, fingerprint: 'v1:a' });
  saveSyncState(state);
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(syncStateFile(), new Date(old), new Date(old));

  pruneStale();

  assert.ok(fs.existsSync(syncStateFile()), 'sync progress must not expire with the pruned dirs');
});

test('the one-time ledger and the sync state never read each other', (t) => {
  makeHome(t);
  const ledger = loadLedger('acct-a');
  markComplete(ledger);
  markImported(ledger, 'conv-1', { outcome: 'accepted', reports: 1 });
  saveLedger(ledger);

  const state = loadSyncState('acct-a');

  // A ledger entry says "the one-time pull judged this session", which says nothing at all about
  // whether a suffix appended afterwards has been delivered.
  assert.equal(syncProgressFor(state, 'conv-1'), null);
  assert.equal(isComplete(loadLedger('acct-a')), true);
});

test('an unknown account never inherits another account progress, and never writes any', (t) => {
  const home = makeHome(t);
  const mine = loadSyncState('acct-a');
  recordSyncProgress(mine, 'conv-1', { cursor: 42, fingerprint: 'v1:abc' });
  saveSyncState(mine);
  const before = fs.readFileSync(syncStateFile(), 'utf-8');

  // No email recorded yet (a machine that has linked but never run whoami): the progress on disk
  // belongs to SOME account, and adopting it would resume from a prefix this run cannot attribute.
  const unscoped = loadSyncState(null);

  assert.equal(unscoped.account, null);
  assert.deepEqual(unscoped.sessions, {});
  assert.equal(syncProgressFor(unscoped, 'conv-1'), null);

  recordSyncProgress(unscoped, 'conv-2', { cursor: 1, fingerprint: 'v1:z' });
  assert.equal(saveSyncState(unscoped), false, 'unscoped progress must not be written');
  assert.equal(fs.readFileSync(syncStateFile(), 'utf-8'), before, 'the scoped file must be untouched');
});

test('saving scoped progress still reports that it was written', (t) => {
  makeHome(t);
  const state = loadSyncState('acct-a');
  recordSyncProgress(state, 'conv-1', { cursor: 1, fingerprint: 'v1:a' });

  assert.equal(saveSyncState(state), true);
});
