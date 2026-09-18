import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialStatus,
  DEFAULT_SERVICE,
  commitCredentials,
  deleteCredentialRecord,
  getCredentials,
  readControlSnapshot,
  readCredentialRecord,
  recoverLegacyCredential,
  resolveServiceName,
  setCredentials,
  deleteCredentials,
  controlFile,
} from '../lib/credentials.mjs';
import {
  BACKEND_TIMEOUT_MS, INTERACTIVE_RETRY_TIMEOUT_MS, accountForSlot, fileForSlot,
} from '../lib/credential-backends.mjs';
import { defaultKeyringService, homeDigest } from '../lib/keyring-namespace.mjs';
import {
  currentSlot, publishGeneration, readCurrent, recordFile, stagingFile,
  noteStaged, sweepStaging,
} from '../lib/credential-control.mjs';

// The live secret's slot, asked for rather than reconstructed: a slot name carries the writing
// attempt's id so that two concurrent writers can never address the same one.
const live = () => currentSlot(SERVICE());
const liveKey = () => `${SERVICE()}::${accountForSlot(live().slot)}`;

// The namespace this home owns. Every home the suite creates is a CUSTOM home, so it gets its own
// keyring service — which is the whole point of C4: two of them must not share slot names.
const SERVICE = () => defaultKeyringService();

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credstore-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const creds = (accessToken, over = {}) => ({
  client_id: 'cid',
  redirect_uri: 'http://127.0.0.1:49152/callback',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: accessToken,
  refresh_token: 'rt',
  expires_at: 123,
  ...over,
});

// A macOS `security` stand-in that is SLOT-AWARE: entries are keyed by (service, account), which is
// what makes a staged generation a genuinely separate entry from the committed one. `faults` lets a
// test make one specific operation time out or fail.
function keychain({ entries = new Map(), faults = {} } = {}) {
  const key = (args) => `${args[args.indexOf('-s') + 1]}::${args[args.indexOf('-a') + 1]}`;
  const run = (file, args) => {
    if (file !== 'security') return { ok: false, stdout: '', timedOut: false };
    const sub = args[0];
    const fault = faults[sub];
    if (fault === 'timeout') return { ok: false, stdout: '', timedOut: true };
    if (fault === 'fail') return { ok: false, stdout: '', timedOut: false };
    if (sub === 'find-generic-password') {
      const hit = entries.get(key(args));
      return hit == null ? { ok: false, stdout: '' } : { ok: true, stdout: `${hit}\n` };
    }
    if (sub === 'add-generic-password') { entries.set(key(args), args[args.indexOf('-w') + 1]); return { ok: true, stdout: '' }; }
    if (sub === 'delete-generic-password') { entries.delete(key(args)); return { ok: true, stdout: '' }; }
    return { ok: false, stdout: '' };
  };
  return { run, entries };
}

const mac = (kc, over = {}) => ({ platform: 'darwin', run: kc.run, ...over });
const FILE_STORE = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };

const readControl = (deps = {}) => JSON.parse(fs.readFileSync(controlFile(deps), 'utf-8'));
// Control records are one immutable file per generation now, so "is anything staged" is a question
// about which files exist rather than a field inside one.
const stagingLeftOver = () => fs.readdirSync(process.env.BEEZI_CURSOR_HOME)
  .filter((name) => name.includes('.staging.'));

// ── generations and the control record ───────────────────────────────────────

test('the first commit publishes generation 1 and a control record naming it', async (t) => {
  tmpHome(t);
  const kc = keychain();
  const result = await commitCredentials(creds('at1'), mac(kc));

  assert.equal(result.status, CredentialStatus.COMMITTED);
  assert.equal(result.generation, 1);
  const control = readControl();
  assert.equal(control.generation, 1);
  assert.equal(control.backend, 'keychain');
  assert.equal(control.service, SERVICE());
  assert.deepEqual(stagingLeftOver(), [], 'the staging breadcrumb was cleared');
  assert.ok(kc.entries.has(liveKey()), 'stored in the generation slot the record names');
});

test('a second commit advances the generation and retires the previous slot', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  const second = await commitCredentials(creds('at2'), mac(kc));

  assert.equal(second.generation, 2);
  assert.equal(readControl().generation, 2);
  assert.equal(kc.entries.size, 1, 'generation 1 retired');
  const read = await readCredentialRecord(mac(kc));
  assert.equal(read.creds.access_token, 'at2');
  assert.equal(read.generation, 2);
});

test('a commit against a stale generation is a conflict and changes nothing', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  await commitCredentials(creds('at2'), mac(kc)); // generation 2 — the racer never saw this

  const losing = await commitCredentials(creds('stale'), mac(kc), { expectGeneration: 1 });
  assert.equal(losing.status, CredentialStatus.CONFLICT);
  assert.equal(losing.generation, 2, 'reports the generation that is actually current');
  assert.equal((await readCredentialRecord(mac(kc))).creds.access_token, 'at2');
});

// A write that dies after staging must not have destroyed anything: the committed generation is a
// DIFFERENT slot, so the old value is still exactly where the control record says it is.
test('a crash between staging and publishing leaves the old value readable', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('committed'), mac(kc));

  // Reproduce the crash: the breadcrumb was dropped and the secret written, but generation 2 was
  // never published. Readers take the highest PUBLISHED record, so generation 1 is still current.
  fs.writeFileSync(
    stagingFile(SERVICE(), 2, 'deadwriter9'),
    JSON.stringify({
      version: 1, service: SERVICE(), generation: 2, attempt: 'deadwriter9',
      backend: 'keychain', slot: 'g2.deadwriter9', state: 'staged', at: Date.now(),
    }),
    'utf-8',
  );
  kc.entries.set(`${SERVICE()}::${accountForSlot('g2.deadwriter9')}`, JSON.stringify(creds('half-written')));

  const read = await readCredentialRecord(mac(kc));
  assert.equal(read.status, CredentialStatus.OK);
  assert.equal(read.creds.access_token, 'committed', 'the unpublished generation is not served');
  assert.equal(read.generation, 1);
});

test('the next commit cleans up only the orphaned staged slot of this namespace', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('committed'), mac(kc));
  // The crash happened while the keychain was down, so generation 2's secret went to the FILE
  // backend and was never published. The committed generation is still 1, in the keychain.
  // A breadcrumb in the shape the production path really writes: per-attempt, naming the exact
  // backend and slot it staged. The old fixture used a shape production could not emit, so the
  // cleanup it certified was unreachable in practice.
  const orphanSlot = 'g2.deadwriter7';
  fs.writeFileSync(
    stagingFile(SERVICE(), 2, 'deadwriter7'),
    JSON.stringify({
      version: 1, service: SERVICE(), generation: 2, attempt: 'deadwriter7',
      backend: 'file', slot: orphanSlot, state: 'staged', at: Date.now(),
    }),
    'utf-8',
  );
  fs.writeFileSync(fileForSlot(orphanSlot), JSON.stringify({ token: 'orphan' }), 'utf-8');
  kc.entries.set(`other-service::${accountForSlot('g2')}`, 'not ours');

  await commitCredentials(creds('next'), mac(kc));
  assert.equal(fs.existsSync(fileForSlot(orphanSlot)), false, 'the orphaned staged slot is gone');
  assert.equal(kc.entries.get(`other-service::${accountForSlot('g2')}`), 'not ours', 'another namespace untouched');
  assert.equal((await readCredentialRecord(mac(kc))).creds.access_token, 'next');
});

// A crashed writer's breadcrumb must not block that generation for everybody afterwards, which is
// what making the breadcrumb itself exclusive would have done.
test('an abandoned staging breadcrumb does not block the generation it names', async (t) => {
  tmpHome(t);
  const kc = keychain();
  fs.mkdirSync(process.env.BEEZI_CURSOR_HOME, { recursive: true });
  fs.writeFileSync(
    stagingFile(SERVICE(), 1, 'deadwriter1'),
    JSON.stringify({
      version: 1, service: SERVICE(), generation: 1, attempt: 'deadwriter1',
      backend: 'keychain', slot: 'g1.deadwriter1', state: 'staged', at: 0,
    }),
    'utf-8',
  );
  const result = await commitCredentials(creds('after-crash'), mac(kc));
  assert.equal(result.status, CredentialStatus.COMMITTED);
  assert.equal(result.generation, 1);
  assert.equal((await readCredentialRecord(mac(kc))).creds.access_token, 'after-crash');
});

// ── read outcomes are distinct, not collapsed into "not linked" ───────────────

test('an empty store reads as MISSING', async (t) => {
  tmpHome(t);
  const read = await readCredentialRecord(mac(keychain()));
  assert.equal(read.status, CredentialStatus.MISSING);
  assert.equal(read.creds, null);
});

test('a keyring that does not answer inside the budget reads as TIMEOUT, not MISSING', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));

  const slow = keychain({ entries: kc.entries, faults: { 'find-generic-password': 'timeout' } });
  const read = await readCredentialRecord(mac(slow));
  assert.equal(read.status, CredentialStatus.TIMEOUT);
  assert.equal(read.creds, null);
  assert.equal(read.generation, 1, 'the generation is known even when the value is not');
});

test('a committed slot holding unparseable bytes reads as CORRUPT', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  kc.entries.set(liveKey(), '{not json');

  const read = await readCredentialRecord(mac(kc));
  assert.equal(read.status, CredentialStatus.CORRUPT);
});

test('an unreadable file slot reads as UNREADABLE, not MISSING', async (t) => {
  tmpHome(t);
  await commitCredentials(creds('at1'), FILE_STORE);
  fs.writeFileSync(fileForSlot(live().slot), 'not json at all', 'utf-8');

  const read = await readCredentialRecord(FILE_STORE);
  assert.equal(read.status, CredentialStatus.UNREADABLE);
});

// ── delete ───────────────────────────────────────────────────────────────────

test('delete verifies the slot is really empty and advances the epoch', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  const before = readControlSnapshot();

  const result = await deleteCredentialRecord(mac(kc));
  assert.equal(result.status, CredentialStatus.OK);
  assert.equal(result.deleted, true);
  assert.equal(result.verified, true);
  assert.equal(kc.entries.size, 0);
  assert.ok(readControlSnapshot().epoch > before.epoch, 'logout advances the epoch');
  assert.equal((await readCredentialRecord(mac(kc))).status, CredentialStatus.MISSING);
});

// AUTH-01: "logged out" must not be printed while the token is still in the keychain.
test('delete reports failure when the backend still serves the value afterwards', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));

  const stubborn = keychain({ entries: kc.entries, faults: { 'delete-generic-password': 'fail' } });
  const result = await deleteCredentialRecord(mac(stubborn));
  assert.equal(result.status, CredentialStatus.ERROR);
  assert.equal(result.verified, false);
  assert.equal(kc.entries.size, 1, 'the value really is still there');
});

test('delete of an already-empty store succeeds without inventing a deletion', async (t) => {
  tmpHome(t);
  const result = await deleteCredentialRecord(mac(keychain()));
  assert.equal(result.status, CredentialStatus.OK);
  assert.equal(result.deleted, false);
  assert.equal(result.verified, true);
});

// ── epochs: refresh keeps one, a new login starts another ────────────────────

test('a same-client commit (a refresh) keeps the epoch; a new client_id advances it', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  const first = readControlSnapshot().epoch;

  await commitCredentials(creds('at2'), mac(kc)); // refresh: same client_id
  assert.equal(readControlSnapshot().epoch, first, 'a refresh is the same identity');

  await commitCredentials(creds('at3', { client_id: 'other' }), mac(kc));
  assert.ok(readControlSnapshot().epoch > first, 'a new login is a new identity');
});

// ── legacy migration ─────────────────────────────────────────────────────────

test('a legacy file store is migrated once, under the lock, into generation 1', async (t) => {
  const dir = tmpHome(t);
  // What a shipped version wrote: the raw credential JSON under `token`, in credentials.json.
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: JSON.stringify(creds('legacy')) }), 'utf-8');

  const read = await readCredentialRecord(FILE_STORE);
  assert.equal(read.status, CredentialStatus.OK);
  assert.equal(read.creds.access_token, 'legacy');
  assert.equal(read.generation, 1);
  assert.equal(readControl().backend, 'file');
  assert.equal(fs.existsSync(fileForSlot(live().slot)), true, 'republished into the generation slot');
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false, 'legacy slot retired');
});

test('a corrupt legacy store reports recovery-needed and is never adopted or destroyed', async (t) => {
  const dir = tmpHome(t);
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{ half written', 'utf-8');

  const read = await readCredentialRecord(FILE_STORE);
  assert.equal(read.status, CredentialStatus.RECOVERY_NEEDED);
  assert.equal(read.creds, null);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), true, 'the old bytes survive for recovery');
  assert.equal(fs.existsSync(controlFile()), false, 'nothing was committed');
});

test('a legacy bare device token is not a credential and is not adopted', async (t) => {
  const dir = tmpHome(t);
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'bzi_legacy' }), 'utf-8');
  const read = await readCredentialRecord(FILE_STORE);
  assert.equal(read.status, CredentialStatus.RECOVERY_NEEDED);
  assert.equal(await getCredentials(FILE_STORE), null, 'the compatibility reader still says "not linked"');
});

// AUTH-11: a scoped store must never query — let alone delete — the production keyring entry.
test('a custom home never reads the production legacy keyring entry', async (t) => {
  tmpHome(t); // BEEZI_CURSOR_HOME is set, so this is a custom home by definition
  const asked = [];
  const run = (file, args) => { asked.push(args.join(' ')); return { ok: false, stdout: '' }; };
  await readCredentialRecord({ platform: 'darwin', run });
  const legacyAccount = accountForSlot('');
  for (const call of asked) {
    assert.ok(!call.includes(`-a ${legacyAccount} `) && !call.endsWith(`-a ${legacyAccount}`),
      `no call addressed the legacy entry: ${call}`);
  }
});

test('two custom homes with different keyring services never see each other', async (t) => {
  const a = tmpHome(t);
  const entries = new Map(); // one shared "OS keychain"
  const kc = keychain({ entries });

  process.env.BEEZI_CURSOR_HOME = a;
  await commitCredentials(creds('home-a'), mac(kc, { keyringService: () => 'beezi-cursor-hAAAA' }));

  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'credstore-b-'));
  t.after(() => fs.rmSync(b, { recursive: true, force: true }));
  process.env.BEEZI_CURSOR_HOME = b;
  const depsB = mac(kc, { keyringService: () => 'beezi-cursor-hBBBB' });
  assert.equal((await readCredentialRecord(depsB)).status, CredentialStatus.MISSING);

  await commitCredentials(creds('home-b'), depsB);
  await deleteCredentialRecord(depsB);

  process.env.BEEZI_CURSOR_HOME = a;
  const depsA = mac(kc, { keyringService: () => 'beezi-cursor-hAAAA' });
  assert.equal((await readCredentialRecord(depsA)).creds.access_token, 'home-a', "B's logout left A linked");
});

test('an unsafe injected service name falls back to the file store instead of being interpolated', async (t) => {
  tmpHome(t);
  const asked = [];
  const run = (file, args) => { asked.push(args.join(' ')); return { ok: false, stdout: '' }; };
  const deps = { platform: 'darwin', run, keyringService: () => "beezi';rm -rf /;'" };
  const result = await commitCredentials(creds('at1'), deps);
  assert.equal(result.status, CredentialStatus.COMMITTED);
  assert.equal(readControl(deps).backend, 'file');
  assert.deepEqual(asked, [], 'the name never reached a subprocess');
});

test('the default service is the shipped name for the default home and digested for a custom one', (t) => {
  const prev = process.env.BEEZI_CURSOR_HOME;
  delete process.env.BEEZI_CURSOR_HOME;
  t.after(() => { if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev; });
  // Unsuffixed on the default home, so an upgrade reads the entry it already has.
  assert.equal(resolveServiceName({}), DEFAULT_SERVICE);

  process.env.BEEZI_CURSOR_HOME = path.join(os.tmpdir(), 'some-home');
  assert.match(resolveServiceName({}), /^beezi-cursor-h[0-9a-f]{12}$/);
  assert.equal(resolveServiceName({}), `beezi-cursor-h${homeDigest(process.env.BEEZI_CURSOR_HOME)}`);
  assert.equal(resolveServiceName({ keyringService: () => 'beezi-cursor-staging' }), 'beezi-cursor-staging');
});

// ── B6: one bag, both halves of the namespace ──────────────────────────────────────────────────

test('deps.env supplies the home as well as the environment — never a mix of two bags', (t) => {
  // The namespace has two halves: the environment suffix and the custom-home digest. `deps.env` was
  // honoured for the first and ignored for the second, because `customHome()` was called with no
  // argument and read `process.env` unconditionally. A caller that handed in a bag therefore got a
  // service name assembled out of TWO different environments — the injected one's environment and
  // the ambient process's home — which names a keyring entry belonging to neither.
  const prev = process.env.BEEZI_CURSOR_HOME;
  t.after(() => { if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev; });

  const ambient = path.join(os.tmpdir(), 'ambient-home');
  const injected = path.join(os.tmpdir(), 'injected-home');
  process.env.BEEZI_CURSOR_HOME = ambient;

  const seen = [];
  resolveServiceName({
    env: { BEEZI_CURSOR_HOME: injected },
    keyringService: (env, home) => { seen.push({ env, home }); return 'x'; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].home, injected, 'the home came from process.env instead of the injected bag');
  assert.equal(seen[0].env.BEEZI_CURSOR_HOME, injected);

  // And the real provider agrees: the digest is the INJECTED home's, not the ambient one's.
  assert.equal(
    resolveServiceName({ env: { BEEZI_CURSOR_HOME: injected } }),
    `beezi-cursor-h${homeDigest(injected)}`,
  );

  // The fallback path takes the same bag: a provider that answers nothing usable must not drop
  // back to a name derived from a different environment again.
  assert.equal(
    resolveServiceName({ env: { BEEZI_CURSOR_HOME: injected }, keyringService: () => '' }),
    `beezi-cursor-h${homeDigest(injected)}`,
  );

  // An injected bag with no home at all is the DEFAULT home, whatever the ambient one says.
  assert.equal(resolveServiceName({ env: {}, keyringService: () => '' }), DEFAULT_SERVICE);
});

// The digest has to be stable across the spellings one machine produces for one directory, or a
// path that arrives with backslashes reads as a different home from the same path with slashes.
test('the home digest is canonical', () => {
  const a = path.join(os.tmpdir(), 'beezi-digest-home');
  assert.equal(homeDigest(a), homeDigest(path.join(a, '.')));
  if (process.platform === 'win32') {
    assert.equal(homeDigest(a), homeDigest(a.toUpperCase()));
    const BACKSLASH = String.fromCharCode(92);
    assert.equal(homeDigest(a), homeDigest(a.split(BACKSLASH).join('/')));
  }
});

// C4. Two custom homes, NOTHING injected: exactly the shipped default. They used to share the
// keyring service while keeping SEPARATE generation counters, so home B's second commit retired
// `token.g1` — home A's live credential — and home A read as unlinked.
test('two custom homes do not share keyring slots with no provider injected', async (t) => {
  const entries = new Map();               // one machine-global "OS keychain"
  const kc = keychain({ entries });
  const store = { platform: 'darwin', run: kc.run };

  const prev = process.env.BEEZI_CURSOR_HOME;
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'credstore-A-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'credstore-B-'));
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  });

  process.env.BEEZI_CURSOR_HOME = homeA;
  await commitCredentials(creds('home-a'), store);

  // Home B links, then commits a second time — which retires ITS generation 1.
  process.env.BEEZI_CURSOR_HOME = homeB;
  await commitCredentials(creds('home-b-1'), store);
  await commitCredentials(creds('home-b-2'), store);

  process.env.BEEZI_CURSOR_HOME = homeA;
  const a = await readCredentialRecord(store);
  assert.equal(a.status, CredentialStatus.OK, 'home A was unlinked by home B');
  assert.equal(a.creds.access_token, 'home-a');

  // And a logout in B leaves A alone.
  process.env.BEEZI_CURSOR_HOME = homeB;
  await deleteCredentialRecord(store);
  process.env.BEEZI_CURSOR_HOME = homeA;
  assert.equal((await readCredentialRecord(store)).creds.access_token, 'home-a');
});

// ── a busy lock is reported, not silently ignored ─────────────────────────────

test('a commit that cannot take the lock reports LOCKED and writes nothing', async (t) => {
  const dir = tmpHome(t);
  // A live foreign holder: our own pid answers signal 0, and the injected liveness check says alive.
  fs.mkdirSync(path.join(dir, 'credentials.lock'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ owner: { pid: 999_999, processStartTime: 1, nonce: 'other' }, acquiredAt: Date.now() }),
    'utf-8',
  );

  const kc = keychain();
  const result = await commitCredentials(creds('at1'), mac(kc, { lockWaitMs: 20, kill: () => {}, sleep: async () => {} }));
  assert.equal(result.status, CredentialStatus.LOCKED);
  assert.equal(kc.entries.size, 0);
  assert.equal(fs.existsSync(controlFile()), false);
});

// ── the compatibility adapters keep their old shapes ─────────────────────────

test('setCredentials still answers with where the value landed, and getCredentials round-trips', async (t) => {
  tmpHome(t);
  const kc = keychain();
  assert.equal(await setCredentials(creds('at1'), mac(kc)), 'the macOS keychain');
  assert.deepEqual(await getCredentials(mac(kc)), creds('at1'));
  await deleteCredentials(mac(kc));
  assert.equal(await getCredentials(mac(kc)), null);
});

// §10's environment suffixes and AUTH-11's home digest are the same mechanism seen twice: one
// keyring service per (environment, home). A staging build signing in must not disturb the
// production entry that shares the machine.
test('a non-production variant neither reads nor deletes the production entry', async (t) => {
  tmpHome(t);
  const entries = new Map();
  const kc = keychain({ entries });
  const prod = mac(kc);
  const staging = mac(kc, { keyringService: () => 'beezi-cursor-staging' });

  await commitCredentials(creds('prod-token'), prod);
  await commitCredentials(creds('staging-token'), staging);
  assert.equal((await readCredentialRecord(prod)).creds.access_token, 'prod-token');
  assert.equal((await readCredentialRecord(staging)).creds.access_token, 'staging-token');

  await deleteCredentialRecord(staging);
  assert.equal((await readCredentialRecord(staging)).status, CredentialStatus.MISSING);
  assert.equal((await readCredentialRecord(prod)).creds.access_token, 'prod-token', 'production survives');
});

// ── the interactive retry (M01.1 step 2) ─────────────────────────────────────
//
// A hook is on a deadline and takes the answer it gets. A person waiting at a prompt would rather
// wait than be told their machine is not linked because a cold keychain helper missed its budget.

test('an interactive caller gets one explicitly longer retry after a timeout', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));

  // Times out on the first read of the committed slot, answers on the second.
  const budgets = [];
  let reads = 0;
  const run = (file, args, input, timeoutMs) => {
    if (args[0] === 'find-generic-password') {
      budgets.push(timeoutMs);
      reads += 1;
      if (reads === 1) return { ok: false, stdout: '', timedOut: true };
    }
    return kc.run(file, args, input);
  };

  const patient = await readCredentialRecord({ platform: 'darwin', run, interactive: true });
  assert.equal(patient.status, CredentialStatus.OK);
  assert.equal(patient.creds.access_token, 'at1');
  assert.deepEqual(budgets, [BACKEND_TIMEOUT_MS, INTERACTIVE_RETRY_TIMEOUT_MS],
    'the retry is a different, explicitly larger budget — not the same one twice');
});

test('a hook caller is NOT given the longer retry', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));

  let reads = 0;
  const run = (file, args) => {
    if (args[0] === 'find-generic-password') { reads += 1; return { ok: false, stdout: '', timedOut: true }; }
    return { ok: false, stdout: '' };
  };
  const hook = await readCredentialRecord({ platform: 'darwin', run });
  assert.equal(hook.status, CredentialStatus.TIMEOUT);
  assert.equal(reads, 1, 'one read, one budget — the caller owns its deadline');
});

test('a caller that named its own budget keeps it, interactive or not', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('at1'), mac(kc));
  const budgets = [];
  const run = (file, args, input, timeoutMs) => {
    if (args[0] === 'find-generic-password') { budgets.push(timeoutMs); return { ok: false, stdout: '', timedOut: true }; }
    return { ok: false, stdout: '' };
  };
  await readCredentialRecord({ platform: 'darwin', run, interactive: true, timeoutMs: 250 });
  assert.deepEqual(budgets, [250]);
});

// ── a contended first-ever migration is retryable, not a stale generation ────
//
// Two hooks land together on the first run after an upgrade. One migrates; the other must not serve
// the legacy value at generation 0, because a caller that FENCES on that generation — logout does —
// would then report a conflict on a machine that is perfectly linked.

test('a legacy store being migrated by another process reads as LOCKED, not as generation 0', async (t) => {
  const dir = tmpHome(t);
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: JSON.stringify(creds('legacy')) }), 'utf-8');
  // A live foreign holder of the credential lock.
  fs.mkdirSync(path.join(dir, 'credentials.lock'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'credentials.lock', 'owner.json'),
    JSON.stringify({ owner: { pid: 999_999, processStartTime: 1, nonce: 'migrating' }, acquiredAt: Date.now() }),
    'utf-8',
  );

  const read = await readCredentialRecord({ ...FILE_STORE, lockWaitMs: 20, kill: () => {}, sleep: async () => {} });
  assert.equal(read.status, CredentialStatus.LOCKED);
  assert.equal(read.creds, null, 'no credential is served at a generation that is about to be stale');
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), true, 'and the legacy bytes are untouched');
});

test('the same store reads normally once the migrating process releases the lock', async (t) => {
  const dir = tmpHome(t);
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: JSON.stringify(creds('legacy')) }), 'utf-8');
  const read = await readCredentialRecord(FILE_STORE);
  assert.equal(read.status, CredentialStatus.OK);
  assert.equal(read.generation, 1);
});

// ── I2: recovering from a downgrade-and-relogin ──────────────────────────────
//
// An older build cannot see the generation layout, so it reports "not linked"; the user signs in
// there and it writes the LEGACY slot; the machine is upgraded again and serves the credential from
// before the downgrade. It is an explicit repair, not a silent one — detecting it on every read
// would cost a second keyring subprocess per hook.

// The file store, because that is the legacy slot a CUSTOM home may look at. The keyring's
// pre-generation entry is keyed by the service name alone, which every home on the machine shared
// before the digest existed, so a custom home is still forbidden from reading it (AUTH-11) — that
// exclusion is asserted separately below. On the default home the same code path covers both.
test('recoverLegacyCredential adopts a credential an older build wrote after the migration', async (t) => {
  const dir = tmpHome(t);
  await commitCredentials(creds('before-downgrade'), FILE_STORE);

  // What the older build does: writes the pre-generation slot and knows nothing about the control
  // record, which still names the generation holding the OLD token.
  fs.writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({ token: JSON.stringify(creds('after-relogin')) }),
    'utf-8',
  );
  assert.equal((await readCredentialRecord(FILE_STORE)).creds.access_token, 'before-downgrade');

  const recovered = await recoverLegacyCredential(FILE_STORE);
  assert.equal(recovered.status, CredentialStatus.COMMITTED);
  assert.equal(recovered.generation, 2);

  const after = await readCredentialRecord(FILE_STORE);
  assert.equal(after.creds.access_token, 'after-relogin');
  assert.equal(after.generation, 2);
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), false, 'the legacy slot is retired');
  assert.equal(
    fs.readdirSync(process.env.BEEZI_CURSOR_HOME).filter((n) => n.startsWith('credentials.g1')).length,
    0,
    'and so is the superseded generation',
  );
});

test('recovery reports MISSING when no older build has written anything', async (t) => {
  tmpHome(t);
  await commitCredentials(creds('current'), FILE_STORE);
  const recovered = await recoverLegacyCredential(FILE_STORE);
  assert.equal(recovered.status, CredentialStatus.MISSING);
  assert.equal((await readCredentialRecord(FILE_STORE)).creds.access_token, 'current', 'nothing was disturbed');
});

test('recovery on a custom home still refuses to look at the production keyring entry', async (t) => {
  tmpHome(t);
  const asked = [];
  const run = (file, args) => { asked.push(args.join(' ')); return { ok: false, stdout: '' }; };
  await recoverLegacyCredential({ platform: 'darwin', run });
  const legacyAccount = accountForSlot('');
  for (const call of asked) {
    assert.ok(
      !call.includes(`-a ${legacyAccount} `) && !call.endsWith(`-a ${legacyAccount}`),
      `no call addressed the legacy entry: ${call}`,
    );
  }
});

test('recovery refuses a legacy slot that is not a credential', async (t) => {
  const dir = tmpHome(t);
  await commitCredentials(creds('current'), FILE_STORE);
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ token: 'bzi_legacy' }), 'utf-8');

  const recovered = await recoverLegacyCredential(FILE_STORE);
  assert.equal(recovered.status, CredentialStatus.RECOVERY_NEEDED);
  assert.equal((await readCredentialRecord(FILE_STORE)).creds.access_token, 'current');
  assert.equal(fs.existsSync(path.join(dir, 'credentials.json')), true, 'and the bytes survive');
});

// ── parity with the release lane's env-identity (C4) ─────────────────────────
//
// `lib/env-identity.mjs` is the release lane's to write, and it is the SOLE implementer of
// `homeDigest`/`keyringService` once it lands. This lane needed the same discriminator immediately
// (two custom homes were sharing keyring slots), so the formula is duplicated — and a duplicated
// formula that drifts by one character silently unlinks every machine that uses a custom home.
//
// The independent restatement below is the release lane's spec as given, not a call into this
// lane's code, so a change to either side fails here. Integration must ALSO run a direct parity
// test against the real module once it exists (see the handoff).
function releaseLaneDigest(homePath) {
  let canonical = path.resolve(homePath);
  if (process.platform === 'win32') {
    canonical = canonical.toLowerCase().split(String.fromCharCode(92)).join('/');
  }
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

test('homeDigest is byte-identical to the release lane formula', () => {
  const B = String.fromCharCode(92);
  const samples = [
    `C:${B}Users${B}Dev${B}.beezi-cursor`,
    'c:/users/dev/.beezi-cursor',
    '/home/dev/.beezi-cursor',
    './relative-home',
    `C:${B}Users${B}Dev${B}a b${B}..${B}home`,
    path.join(os.tmpdir(), 'beezi-parity'),
    // The input both sides agree on for an ARBITRARY home but could disagree on for this one: the
    // default home named explicitly. Without the equivalence branch one side says `beezi-cursor`
    // and the other `beezi-cursor-h<digest>`, and every file and keyring entry renames at once.
    path.join(os.homedir(), '.beezi-cursor'),
  ];
  for (const sample of samples) {
    assert.equal(homeDigest(sample), releaseLaneDigest(sample), sample);
    assert.match(homeDigest(sample), /^[0-9a-f]{12}$/);
  }
});

test('the service name is the release lane spelling: beezi-cursor + envSuffix + -h<digest>', (t) => {
  const prev = process.env.BEEZI_CURSOR_HOME;
  t.after(() => { if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev; });

  const home = path.join(os.tmpdir(), 'beezi-parity-home');
  process.env.BEEZI_CURSOR_HOME = home;
  // Production's envSuffix is the empty string, which is the only environment this lane can
  // produce until env-identity supplies the others.
  assert.equal(defaultKeyringService(), `beezi-cursor-h${releaseLaneDigest(home)}`);

  delete process.env.BEEZI_CURSOR_HOME;
  assert.equal(defaultKeyringService(), 'beezi-cursor', 'the default home stays unsuffixed');

  // The equivalence branch: pointing the variable AT the default home is the default home.
  process.env.BEEZI_CURSOR_HOME = path.join(os.homedir(), '.beezi-cursor');
  assert.equal(
    defaultKeyringService(),
    'beezi-cursor',
    'BEEZI_CURSOR_HOME set to the default home must not resolve to a digested namespace',
  );
});

// ── the atomic publish, which is what mutual exclusion now rests on ──────────

// Two writers that both observe generation N must not both publish N+1. Under the old
// read-then-write record they could: `readControl()` and `writeJsonSecure()` were separate calls
// with the whole staging transaction between them, so "check then write" was never atomic however
// close the two sat. Publishing is now an exclusive create, which the OS resolves for us.
test('two writers that both observe the same generation cannot both publish the next', (t) => {
  tmpHome(t);
  const service = SERVICE();
  const record = { backend: 'keychain', epoch: 1, clientId: 'cid', updatedAt: 'x' };

  assert.equal(publishGeneration(service, 1, record), 'published');
  // The second writer observed generation 0 exactly as the first did, and is publishing the same
  // generation. It is refused rather than replacing the winner.
  assert.equal(publishGeneration(service, 1, { ...record, clientId: 'other' }), 'conflict');

  const after = readCurrent(service);
  assert.equal(after.generation, 1);
  assert.equal(after.record.clientId, 'cid', 'the winner stands');
});

// The rollback paths are gone because there is nothing to roll back. A commit that cannot place its
// secret never publishes, so a concurrent winner's record cannot be clobbered or deleted by it.
// The rollback paths are gone because there is nothing to roll back: a commit that loses the
// publish never created a record, so a concurrent winner's cannot be clobbered or deleted — and the
// loser cleans up only its own staged secret.
// The rollback paths are gone because there is nothing to roll back: a commit that does not publish
// never created a record, so a concurrent winner's cannot be clobbered or deleted, and the refused
// writer leaves no staged secret behind. (The publish-loss interleave itself needs two processes and
// is covered in test/credential-race.test.mjs.)
test('a commit refused by its fence leaves the winner untouched and stages nothing', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('winner'), mac(kc));
  const before = await readCredentialRecord(mac(kc));
  const winnerKey = liveKey();

  // Another writer has committed since this caller read the store.
  await commitCredentials(creds('newer', { client_id: 'cid-2' }), mac(kc));
  const newerKey = liveKey();

  const refused = await commitCredentials(creds('loser'), mac(kc), { expectGeneration: before.generation });
  assert.equal(refused.status, CredentialStatus.CONFLICT);

  const after = await readCredentialRecord(mac(kc));
  assert.equal(after.status, CredentialStatus.OK);
  assert.equal(after.creds.access_token, 'newer', 'the newer generation survived');
  assert.deepEqual(
    [...kc.entries.keys()],
    [newerKey],
    'the refused writer staged nothing, and the superseded slot was retired by its own successor',
  );
  assert.ok(!kc.entries.has(winnerKey));
  assert.deepEqual(
    fs.readdirSync(process.env.BEEZI_CURSOR_HOME).filter((n) => n.includes('.staging.')),
    [],
    'no breadcrumb outlived the refusal',
  );
});

// The delete path gets the same atomicity: a tombstone is a publish, so a login that landed while
// the logout was on the network wins the exchange and its credential survives.
test('a tombstone cannot erase a generation published after the logout observed the store', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('original'), mac(kc));
  const observed = await readCredentialRecord(mac(kc));

  // The login lands while the logout is between its read and its delete.
  await commitCredentials(creds('relinked', { client_id: 'cid-2' }), mac(kc));

  const refused = await deleteCredentialRecord(mac(kc), { expectGeneration: observed.generation });
  assert.equal(refused.status, CredentialStatus.CONFLICT);
  assert.equal(refused.deleted, false);

  const after = await readCredentialRecord(mac(kc));
  assert.equal(after.status, CredentialStatus.OK);
  assert.equal(after.creds.access_token, 'relinked', 'the racing login survived the logout');
});

// ── an unusable record is recovery-needed, never an empty store ─────────────
//
// `pruneBelow` removes superseded records, so in steady state there is nothing underneath the
// current one. Skipping an unreadable record therefore reported generation 0, which reads as an
// empty store and sent `readCredentialRecord` into the legacy keyring scan — M01.1 step 4 forbids
// exactly that. Version skew is the reachable trigger: one client publishing a format this one does
// not know would otherwise make every older client read a healthy store as unlinked.
test('a record written by a newer client reports recovery-needed, not "not linked"', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('current'), mac(kc));
  const { generation } = live();

  fs.writeFileSync(
    recordFile(SERVICE(), generation),
    JSON.stringify({ version: 99, service: SERVICE(), generation, backend: 'keychain', slot: 'g1.future' }),
    'utf-8',
  );

  const read = await readCredentialRecord(mac(kc));
  assert.notEqual(read.status, CredentialStatus.MISSING, 'a newer format read as an empty store');
  // RECOVERY_NEEDED by name: M01.1 step 4 asks for it, and it says "repairable" where UNREADABLE
  // says only "broken".
  assert.equal(read.status, CredentialStatus.RECOVERY_NEEDED);
  assert.equal(read.creds, null);
});

test('a truncated record reports recovery-needed and does not fall back to the legacy keyring', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('current'), mac(kc));
  const { generation } = live();
  // A legacy entry that a fall-through would wrongly adopt.
  kc.entries.set(`${SERVICE()}::${accountForSlot('')}`, JSON.stringify(creds('stale-legacy')));

  fs.writeFileSync(recordFile(SERVICE(), generation), '{ truncated', 'utf-8');

  const read = await readCredentialRecord(mac(kc));
  assert.equal(read.status, CredentialStatus.RECOVERY_NEEDED);
  assert.equal(read.creds, null, 'another backend\u2019s stale value was adopted');
});

// ── the sweep must never touch the live secret ──────────────────────────────
//
// A breadcrumb for the CURRENT generation names the slot the committed record points at. It survives
// whenever a writer is killed between publishing and releasing it — a window containing a keyring
// remove subprocess — or while a concurrent writer has published but not yet released. If the next
// commit sweeps it, it deletes the live secret before staging any replacement: the record still
// stands, the user is still signed in, and every read afterwards is MISSING.
test('a breadcrumb naming the live slot is never swept', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('winner'), mac(kc));
  const liveNow = live();

  // Exactly what noteStaged writes, for the generation that is currently published.
  fs.writeFileSync(
    stagingFile(SERVICE(), liveNow.generation, 'crashedwriter'),
    JSON.stringify({
      version: 1, service: SERVICE(), generation: liveNow.generation, attempt: 'crashedwriter',
      backend: liveNow.backend, slot: liveNow.slot, state: 'staged', at: Date.now(),
    }),
    'utf-8',
  );

  // A commit that bails AFTER the sweep. Losing the lease is the cheapest such path, and it is the
  // one whose comment claims it "stops here, having touched nothing" — so it is exactly the claim
  // worth testing. The first verify() lets the re-entrant call in; the second, inside the commit,
  // reports the lease gone.
  let verifies = 0;
  const losingLease = {
    held: true,
    dir: null,
    owner: { nonce: 'other-process' },
    verify: () => { verifies += 1; return verifies <= 1; },
  };
  const bailed = await commitCredentials(creds('loser'), { ...mac(kc), lock: losingLease });
  assert.equal(bailed.status, CredentialStatus.CONFLICT);

  const after = await readCredentialRecord(mac(kc));
  assert.equal(after.status, CredentialStatus.OK, 'the sweep deleted the live committed secret');
  assert.equal(after.creds.access_token, 'winner');
});

// And the everyday case: a surviving breadcrumb must not cost the live secret even when the next
// commit succeeds — there must be no window in which the committed record names a deleted slot.
test('a commit after a crash-left breadcrumb keeps the old credential readable until it publishes', async (t) => {
  tmpHome(t);
  const kc = keychain();
  await commitCredentials(creds('winner'), mac(kc));
  const liveNow = live();
  fs.writeFileSync(
    stagingFile(SERVICE(), liveNow.generation, 'crashedwriter'),
    JSON.stringify({
      version: 1, service: SERVICE(), generation: liveNow.generation, attempt: 'crashedwriter',
      backend: liveNow.backend, slot: liveNow.slot, state: 'staged', at: Date.now(),
    }),
    'utf-8',
  );

  // Observed from inside the commit, at the moment its secret is being written: the PREVIOUS
  // credential must still be readable, which is M01.1 step 3's "failure before publish leaves the
  // old committed value readable".
  let readableDuringStaging = null;
  const watching = {
    platform: 'darwin',
    run: (file, args) => {
      if (args[0] === 'add-generic-password' && readableDuringStaging === null) {
        readableDuringStaging = kc.entries.has(`${SERVICE()}::${accountForSlot(liveNow.slot)}`);
      }
      return kc.run(file, args);
    },
  };
  const result = await commitCredentials(creds('next'), watching);
  assert.equal(result.status, CredentialStatus.COMMITTED);
  assert.equal(readableDuringStaging, true, 'the old credential was deleted before the new one was staged');
  assert.equal((await readCredentialRecord(mac(kc))).creds.access_token, 'next');
});

// ── B7: the live-slot guard, exercised directly rather than only through a caller ───────────────

// `sweepStaging` has TWO guards and only one of them had a test of its own. The `currentSlot()`
// guard — never remove the slot the COMMITTED record names, whatever generation the breadcrumb
// claims — was unreachable through `setCredentials`, because that caller narrows the sweep to
// `current - 1` and a breadcrumb below the current generation can never name the live slot. It was
// written once before, never called, and the live secret was deleted while its record still stood:
// signed in, record intact, slot empty, every later read MISSING.
//
// Two assertions, because either one alone can pass while the defect is back. The first calls
// `sweepStaging` directly with a `settled` that reaches the live generation; the second pins the
// narrowing that makes the first unreachable in production, so removing the narrowing fails here
// rather than in a user's keyring.
test('sweepStaging never removes the slot the committed record names', async (t) => {
  tmpHome(t);
  await setCredentials(creds('at-live'));

  const service = SERVICE();
  const current = readCurrent(service);
  assert.ok(current != null, 'a credential must be committed for there to be a live slot');
  const liveSlot = currentSlot(service);
  assert.ok(liveSlot != null && typeof liveSlot.slot === 'string' && liveSlot.slot !== '');

  // A breadcrumb for the CURRENT generation naming the CURRENT slot: exactly what a writer killed
  // between publishing and releasing leaves behind, a window that contains a keyring subprocess.
  noteStaged(service, current.generation, 'zzzz', { slot: liveSlot.slot, backend: liveSlot.backend });
  // And an abandoned one from a loser of the same generation, which SHOULD go.
  noteStaged(service, current.generation, 'yyyy', { slot: `g${current.generation}.yyyy`, backend: liveSlot.backend });

  const removed = [];
  // `settled` reaches the current generation on purpose — this is the call the production caller
  // does not make, and the guard is the only thing standing between it and the live secret.
  sweepStaging(service, current.generation, null, (backend, name) => removed.push(name));

  assert.deepEqual(removed, [`g${current.generation}.yyyy`], 'the live slot was swept');
  // The credential is still readable, which is the outcome the guard exists for.
  assert.deepEqual((await getCredentials()).access_token, 'at-live');
});

test('the staging sweep before a write stays strictly below the current generation', (t) => {
  // The breadcrumb naming the live slot is only unreachable from `setCredentials` because of this
  // narrowing, and nothing pinned it. A future edit that widens `current - 1` to `current` makes the
  // guard above load-bearing in production; this is the line that says so out loud.
  const body = fs.readFileSync(new URL('../lib/credentials.mjs', import.meta.url), 'utf-8');
  assert.match(
    body,
    /sweepStaging\(service,\s*current\s*-\s*1,\s*attempt,\s*removeSlot\)/,
    'the pre-write sweep no longer narrows to current - 1',
  );
});
