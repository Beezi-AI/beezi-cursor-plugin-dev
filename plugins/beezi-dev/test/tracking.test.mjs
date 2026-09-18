import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TrackingMode,
  readTrackingState,
  writeTrackingState,
  isLiveTrackingAllowed,
  isTrackingDisabled,
  shouldBackfill,
  matchesIdentity,
  recordWhoami,
  accountKey,
  currentAccountKey,
  markTrackingDisabled,
  markBackfillCompleted,
  clearTrackingState,
  markLinked,
  linkedAtMs,
} from '../lib/tracking.mjs';
import { trackingStateFile } from '../lib/paths-cursor.mjs';
import { commitCredentials, controlFile } from '../lib/credentials.mjs';
import { pruneStale } from '../lib/prune.mjs';

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tracking-test-'));
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// linkedAtMs falls back to the credentials file's mtime for pre-stamp installs, so every
// assertion about the STAMP has to say there is no such file. Injected rather than left to the
// default: the default stats a real path, and a suite must never read (or depend on the absence
// of) the home directory of whoever runs it.
const NO_CREDENTIALS = { statImpl: () => { throw new Error('ENOENT'); } };

// The gate is a UX/efficiency optimization — the server's guard is the boundary. Failing closed
// on a missing file would dark-mode every fresh install.
test('1. fail-open: missing file, null mode and a corrupt file all allow tracking', (t) => {
  const home = makeHome(t);

  assert.equal(isLiveTrackingAllowed(), true, 'missing file');

  writeTrackingState({ trackingMode: null });
  assert.equal(isLiveTrackingAllowed(), true, 'null mode (pre-audit server)');

  fs.writeFileSync(trackingStateFile(), '{ torn wri', 'utf-8');
  assert.equal(readTrackingState(), null, 'corrupt file reads as absent');
  assert.equal(isLiveTrackingAllowed(), true, 'corrupt file');
  assert.ok(home);
});

test('2. both audit modes block live tracking; live allows it', (t) => {
  makeHome(t);

  writeTrackingState({ trackingMode: TrackingMode.BACKFILL_ONLY });
  assert.equal(isLiveTrackingAllowed(), false);

  writeTrackingState({ trackingMode: TrackingMode.DISABLED });
  assert.equal(isLiveTrackingAllowed(), false);

  writeTrackingState({ trackingMode: TrackingMode.LIVE });
  assert.equal(isLiveTrackingAllowed(), true);
});

// Mirrors the server's resolveTrackingMode: everything except disabled is offered the pull until
// it completes — paid tenants included. A null mode is a pre-audit server: no pull to offer.
// accountKey scopes the backfill's live-cursor belt. Case-folded (emails are), and null for an
// accountless machine so every consumer stays conservative rather than matching on ''.
test('accountKey folds case and refuses to name an accountless machine', () => {
  assert.equal(accountKey('Me@Example.io', 'https://api.beezi.io'), 'https://api.beezi.io|me@example.io');
  assert.equal(accountKey(null, 'https://api.beezi.io'), null);
  assert.equal(accountKey('', 'https://api.beezi.io'), null);
});

// A same-account re-login restores the ORIGINAL link instant on top of the fresh markLinked
// stamp — the liveTracked cutoff must keep counting from the first link or everything tracked
// between the two logins double-bills. It rides in the SAME patch as the verdict: a
// wipe-then-restore pair is two chances to leave the cache holding the fresh stamp.
test('recordWhoami restores a previous link instant without touching the rest', (t) => {
  makeHome(t);
  markLinked();

  recordWhoami(
    { valid: true, trackingMode: TrackingMode.LIVE, email: 'me@x.io' },
    'client-2',
    { linkedAt: '2026-08-01T00:00:00.000Z' },
  );

  const state = readTrackingState();
  assert.equal(state.linkedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(state.email, 'me@x.io');
  assert.equal(state.trackingMode, TrackingMode.LIVE, 'the verdict lands in the same write');
});

// A first-ever login has nothing to restore and says so by passing what it has — which must not
// blank out the markLinked() stamp the flow just wrote.
test('recordWhoami leaves the fresh stamp alone when there is nothing to restore', (t) => {
  makeHome(t);
  markLinked();
  const fresh = readTrackingState().linkedAt;

  for (const linkedAt of [undefined, null, '', 0]) {
    recordWhoami({ valid: true, trackingMode: TrackingMode.LIVE, email: 'me@x.io' }, 'c', { linkedAt });
    assert.equal(readTrackingState().linkedAt, fresh, `linkedAt=${JSON.stringify(linkedAt)} is refused`);
  }
  // And with no options bag at all — the shape every other caller uses.
  recordWhoami({ valid: true, trackingMode: TrackingMode.LIVE, email: 'me@x.io' }, 'c');
  assert.equal(readTrackingState().linkedAt, fresh);
});

// ONE derivation of "who are we right now" for the checkpoint, the audit and the login's
// same-account comparison. Freshest wins: a whoami that answered and validated names the account,
// and only when it did not does the cached email stand in.
test('currentAccountKey prefers a valid whoami over the cache, and falls back to it', (t) => {
  makeHome(t);
  const cached = { email: 'cached@x.io' };
  const key = (email) => accountKey(email);

  assert.equal(
    currentAccountKey({ who: { valid: true, email: 'fresh@x.io' }, tracking: cached }),
    key('fresh@x.io'),
  );
  // An invalid or absent whoami is not an answer — the cache stands in rather than blanking out.
  assert.equal(currentAccountKey({ who: { valid: false }, tracking: cached }), key('cached@x.io'));
  assert.equal(currentAccountKey({ who: null, tracking: cached }), key('cached@x.io'));
  // A valid whoami carrying no email is likewise not an answer to THIS question.
  assert.equal(currentAccountKey({ who: { valid: true }, tracking: cached }), key('cached@x.io'));
  // Nothing anywhere: null, so every consumer stays conservative rather than matching on ''.
  assert.equal(currentAccountKey({ who: null, tracking: null }), null);
});

// The hooks call it with no `who` at all, deliberately: a hook must not touch the network, so the
// cached email is the only answer available to it. That path must read the file.
test('currentAccountKey with no arguments reads the cache off disk', (t) => {
  makeHome(t);
  assert.equal(currentAccountKey(), null, 'an unlinked machine names no account');

  recordWhoami({ valid: true, trackingMode: TrackingMode.LIVE, email: 'Me@Example.io' }, 'c');
  assert.equal(currentAccountKey(), accountKey('Me@Example.io'));
});

test('3. shouldBackfill truth table', (t) => {
  makeHome(t);

  const cases = [
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: false }, true],
    [{ trackingMode: TrackingMode.LIVE, backfillCompleted: true }, false],
    [{ trackingMode: TrackingMode.DISABLED, backfillCompleted: false }, false],
    [{ trackingMode: null, backfillCompleted: false }, false],
    [null, false],
  ];
  for (const [state, expected] of cases) {
    assert.equal(shouldBackfill(state), expected, JSON.stringify(state));
  }
});

// pruneStale() sweeps state/ and queue/ after 14 days; the tracking cache must survive it or
// dark-mode tenants silently light back up.
test('4. tracking.json lives at the root and survives pruneStale', (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });

  writeTrackingState({ trackingMode: TrackingMode.DISABLED });
  const fifteenDaysAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(trackingStateFile(), fifteenDaysAgo, fifteenDaysAgo);

  pruneStale();

  assert.ok(fs.existsSync(trackingStateFile()));
  assert.equal(isLiveTrackingAllowed(), false);
});

// The state is machine-global but the server scope is per (tenant, user, tool): a state written
// under another login must be discarded, never trusted.
test('5. identity mismatch discards the state; missing identities stay permissive', (t) => {
  makeHome(t);

  assert.equal(matchesIdentity({ identity: 'client-a' }, 'client-a'), true);
  assert.equal(matchesIdentity({ identity: 'client-a' }, 'client-b'), false);
  assert.equal(matchesIdentity({ identity: null }, 'client-b'), true);
  assert.equal(matchesIdentity(null, 'client-b'), true);
  assert.equal(matchesIdentity({ identity: 'client-a' }, null), true);
});

test('6. recordWhoami persists the policy fields bound to the identity', (t) => {
  makeHome(t);

  recordWhoami(
    {
      valid: true,
      tenantTier: 'audit',
      trackingMode: TrackingMode.BACKFILL_ONLY,
      backfillCompleted: false,
      email: 'Me@Example.io',
    },
    'client-1',
  );

  const state = readTrackingState();
  assert.equal(state.trackingMode, TrackingMode.BACKFILL_ONLY);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.backfillCompleted, false);
  assert.equal(state.identity, 'client-1');
  assert.equal(state.email, 'Me@Example.io', 'the login email rides along for accountKey');
  assert.ok(state.fetchedAt);

  // An invalid or absent whoami must never overwrite the recorded state.
  recordWhoami({ valid: false }, 'client-1');
  recordWhoami(null, 'client-1');
  assert.equal(readTrackingState().trackingMode, TrackingMode.BACKFILL_ONLY);
});

test('7. markTrackingDisabled flips the mode and keeps the rest; markBackfillCompleted seals', (t) => {
  makeHome(t);

  recordWhoami(
    { valid: true, tenantTier: 'audit', trackingMode: TrackingMode.BACKFILL_ONLY, backfillCompleted: false },
    'client-1',
  );
  markTrackingDisabled('server said so');

  let state = readTrackingState();
  assert.equal(state.trackingMode, TrackingMode.DISABLED);
  assert.equal(state.tenantTier, 'audit');
  assert.equal(state.reason, 'server said so');

  markBackfillCompleted();
  state = readTrackingState();
  assert.equal(state.backfillCompleted, true);

  clearTrackingState();
  assert.equal(readTrackingState(), null);
});

// The audit's "already tracked live" cutoff reads this stamp. It used to read the credentials
// file's mtime, which the CredMan/Keychain/secret-tool backends never write — so on most machines
// the cutoff was null and every transcript, live-tracked or not, was a backfill candidate.
test('8. markLinked stamps the link instant and survives later whoami refreshes', (t) => {
  makeHome(t);

  assert.equal(linkedAtMs(readTrackingState(), NO_CREDENTIALS), null, 'no stamp before login');

  const before = Date.now();
  markLinked();
  const stamped = linkedAtMs(readTrackingState(), NO_CREDENTIALS);
  assert.ok(stamped >= before, 'stamp is the link instant');

  recordWhoami(
    { valid: true, tenantTier: 'pro', trackingMode: TrackingMode.LIVE, backfillCompleted: false },
    'client-1',
  );
  assert.equal(linkedAtMs(readTrackingState(), NO_CREDENTIALS), stamped, 'whoami refresh keeps the stamp');
  assert.equal(readTrackingState().trackingMode, TrackingMode.LIVE, 'verdict still wins');

  markTrackingDisabled('server said so');
  assert.equal(linkedAtMs(readTrackingState(), NO_CREDENTIALS), stamped, 'dark-mode flip keeps the stamp');
});

test('9. linkedAtMs ignores a missing or unparseable stamp', () => {
  assert.equal(linkedAtMs(null, NO_CREDENTIALS), null);
  assert.equal(linkedAtMs({}, NO_CREDENTIALS), null);
  assert.equal(linkedAtMs({ linkedAt: 'not-a-date' }, NO_CREDENTIALS), null);
  assert.equal(
    linkedAtMs({ linkedAt: '2026-08-10T00:00:00.000Z' }, NO_CREDENTIALS),
    Date.parse('2026-08-10T00:00:00.000Z'),
  );
});

// The credentials file's mtime is the fallback for machines linked before the stamp existed. It
// lives HERE, not at a call site: two consumers of "the link instant" that disagree on a pre-stamp
// install give the same machine two different cutoffs, and the audit keys both its live-tracked
// rule and its active-pre-link rule off this one number.
test('10. linkedAtMs falls back to the credentials mtime, but only without a stamp', () => {
  const credentials = { statImpl: () => ({ mtimeMs: 5_000 }) };

  assert.equal(linkedAtMs(null, credentials), 5_000, 'no state at all: the weaker signal answers');
  assert.equal(linkedAtMs({}, credentials), 5_000);
  assert.equal(linkedAtMs({ linkedAt: 'not-a-date' }, credentials), 5_000, 'a torn stamp is no stamp');
  assert.equal(
    linkedAtMs({ linkedAt: '2026-08-10T00:00:00.000Z' }, credentials),
    Date.parse('2026-08-10T00:00:00.000Z'),
    'the stamp is the real signal and outranks the mtime',
  );
  // A stat that answers without an mtime is as good as no answer — never NaN or undefined onward.
  assert.equal(linkedAtMs(null, { statImpl: () => ({}) }), null);
});

// ─── isTrackingDisabled (integration step 2, T-1 / CONTRACTS §3) ─────────────────────────────────

test('isTrackingDisabled names the DISABLED mode alone, never "live tracking is off"', () => {
  // The two predicates exist because one boolean cannot tell a user whether the work they just did
  // will eventually reach the server. `backfill_only` holds the queue and drains it later;
  // `disabled` never will. Collapsing them means either promising delivery that never happens or
  // announcing a loss that did not occur.
  assert.equal(isLiveTrackingAllowed({ trackingMode: TrackingMode.BACKFILL_ONLY }), false);
  assert.equal(isTrackingDisabled({ trackingMode: TrackingMode.BACKFILL_ONLY }), false);

  assert.equal(isLiveTrackingAllowed({ trackingMode: TrackingMode.DISABLED }), false);
  assert.equal(isTrackingDisabled({ trackingMode: TrackingMode.DISABLED }), true);

  assert.equal(isLiveTrackingAllowed({ trackingMode: TrackingMode.LIVE }), true);
  assert.equal(isTrackingDisabled({ trackingMode: TrackingMode.LIVE }), false);
});

test('isTrackingDisabled fails OPEN — an absent or modeless cache is not a disabled tenant', (t) => {
  // Same direction as its neighbour, and for the same reason: the server is the actual boundary,
  // and failing closed would dark-mode every fresh install until its first whoami.
  makeHome(t);
  assert.equal(readTrackingState(), null, 'no cache has been written');
  assert.equal(isTrackingDisabled(), false);
  assert.equal(isLiveTrackingAllowed(), true);
  assert.equal(isTrackingDisabled(null), false);
  assert.equal(isTrackingDisabled({}), false);
  assert.equal(isTrackingDisabled({ trackingMode: null }), false);
});

// ─── linkedAtMs falls back to the CONTROL RECORD (integration step 3, T-2) ──────────────────────

test('linkedAtMs is finite for a pre-stamp install once a credential is committed', async (t) => {
  // The fallback used to stat `credentials.json`. That path is the retired legacy slot now, so on
  // every migrated store the fallback returned null and a pre-stamp machine read as never linked —
  // which is the cutoff the audit's live-tracked and active-pre-link rules both key off.
  //
  // `platform: 'sunos'` picks the plain-file backend: no keyring, no subprocess, nothing
  // machine-specific. A suite must never touch the real credential store.
  const home = makeHome(t);
  const fileStore = { platform: 'sunos' };

  assert.equal(linkedAtMs(null), null, 'nothing is linked yet, and no stamp exists');

  const committed = await commitCredentials({
    client_id: 'cid',
    token_endpoint: 'https://example.test/oauth/token',
    access_token: 'at',
    refresh_token: 'rt',
    expires_at: Date.now() + 3_600_000,
  }, fileStore);
  assert.equal(committed.status, 'committed', `commit failed: ${JSON.stringify(committed)}`);

  const at = linkedAtMs(null);
  assert.ok(Number.isFinite(at), 'a committed credential is evidence this machine is linked');
  assert.equal(path.dirname(controlFile()), home, 'the record read is the one inside the temp home');

  // An explicit stamp still wins — the fallback is only for installs that predate it.
  assert.equal(linkedAtMs({ linkedAt: '2024-01-02T03:04:05.000Z' }), Date.parse('2024-01-02T03:04:05.000Z'));
});
