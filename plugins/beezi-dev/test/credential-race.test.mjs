import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFile } from 'node:child_process';
import { homeDigest } from '../lib/keyring-namespace.mjs';
import { readCurrent } from '../lib/credential-control.mjs';

// Real processes, not promises.
//
// Everything the credential lock exists to prevent happens BETWEEN processes: Cursor fires hooks as
// separate OS processes, the MCP server is a fourth, and a user running the logout script is a
// fifth. An in-process test can only ever exercise the queue in lib/credential-lock.mjs — it can
// never demonstrate that the file lock arbitrates, because a single process never contends with
// itself for the lock directory.
//
// The keyring is faked by a JSON file under the test's own temp directory, and every child is given
// its own BEEZI_CURSOR_HOME. Nothing here can reach the developer's OS keychain: the children ask
// for the 'darwin' backend chain and inject a `run` that only understands the fake.

const LIB = url.pathToFileURL(path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'lib',
)).href;

// The child. Written into the temp directory rather than kept under test/, because `node --test`
// collects every .mjs it finds there and would run a helper as though it were a suite.
const CHILD_SOURCE = `
import fs from 'fs';
import {
  commitCredentials, deleteCredentialRecord, readCredentialRecord,
} from '${LIB}/credentials.mjs';
import { forceRefresh } from '${LIB}/token.mjs';

// A file-backed stand-in for the OS keychain, shared by every child. Mutations only ever happen
// while a child holds the credential lock, so a whole-map rewrite is safe here.
const STORE = process.env.RACE_KEYRING;
// ONE FILE PER ENTRY. The earlier double kept the whole keyring in a single JSON file and
// read-modify-wrote it, which silently lost a concurrent writer's entry — a defect of the double,
// not of the store: the real security/secret-tool/Credential Manager mutate one entry at a time and
// cannot lose an unrelated one. Under a forced interleave that difference IS the test.
const entryFile = (key) => STORE + '/' + Buffer.from(key).toString('hex');
const readEntry = (key) => { try { return fs.readFileSync(entryFile(key), 'utf-8'); } catch { return null; } };
const writeEntry = (key, value) => {
  fs.mkdirSync(STORE, { recursive: true });
  for (let i = 0; ; i += 1) {
    try { fs.writeFileSync(entryFile(key), value, 'utf-8'); return; } catch (e) { if (i > 50) throw e; }
  }
};
// Retried like writeEntry: on Windows an unlink can hit EPERM while another process has the file
// open, and a swallowed delete would read as a product bug — a secret that outlived its logout.
const deleteEntry = (key) => {
  for (let i = 0; ; i += 1) {
    try { fs.unlinkSync(entryFile(key)); return; } catch (e) {
      if (e && e.code === 'ENOENT') return;
      if (i > 50) return;
    }
  }
};

// Busy-wait: the backend interface is synchronous, so a barrier inside it has to be too.
const spinUntil = (test, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (test()) return true; }
  return false;
};
const flag = (name) => process.env.RACE_BARRIER + '/' + name;
const raise = (name) => { try { fs.writeFileSync(flag(name), '1', 'utf-8'); } catch { /* best effort */ } };
const ROLE = process.env.RACE_ROLE;

function run(file, args) {
  if (file !== 'security') return { ok: false, stdout: '', timedOut: false };
  const key = args[args.indexOf('-s') + 1] + '::' + args[args.indexOf('-a') + 1];
  if (args[0] === 'find-generic-password') {
    const value = readEntry(key);
    const hit = value == null ? { ok: false, stdout: '' } : { ok: true, stdout: value + String.fromCharCode(10) };
    // Force both writers to stage the SAME generation and then publish one after the other.
    // A: verified -> wait until B has also staged -> publish (wins)
    // B: staged   -> wait until A has published   -> publish (conflict)
    // Under generation-only slot names both staged into ONE slot, so B's losing cleanup deleted the
    // very secret A's published record points at.
    // The return value is asserted: a barrier that times out would otherwise let the test carry on
    // with no interleave at all and pass vacuously, which is the failure mode that hid the round-2
    // Critical.
    if (hit.ok && ROLE === 'a') {
      raise('a.verified');
      if (!spinUntil(() => fs.existsSync(flag('b.staged')), 5000)) throw new Error('barrier timeout: b.staged');
    }
    if (hit.ok && ROLE === 'b') {
      raise('b.staged');
      if (!spinUntil(() => fs.existsSync(flag('a.done')), 5000)) throw new Error('barrier timeout: a.done');
    }
    return hit;
  }
  if (args[0] === 'add-generic-password') {
    if (ROLE === 'b' && !spinUntil(() => fs.existsSync(flag('a.verified')), 5000)) {
      throw new Error('barrier timeout: a.verified');
    }
    writeEntry(key, args[args.indexOf('-w') + 1]);
    return { ok: true, stdout: '' };
  }
  if (args[0] === 'delete-generic-password') { deleteEntry(key); return { ok: true, stdout: '' }; }
  return { ok: false, stdout: '' };
}

const deps = { platform: 'darwin', run, lockWaitMs: Number(process.env.RACE_LOCK_WAIT_MS || 10000) };

// A lease this process did not take. Handing it in makes withCredentialLock re-enter instead of
// acquiring, so the child runs its critical section with NO mutual exclusion at all — which is the
// state the design explicitly allows for: the lock is an optimisation, and the reclaim path can
// hand two writers a section. Correctness has to come from the store, not from the lock.
const unlocked = { held: true, dir: null, owner: { nonce: 'unlocked' }, verify: () => true };
const op = process.argv[2];
const tag = process.argv[3];

const creds = (accessToken) => ({
  client_id: process.env.RACE_CLIENT_ID || 'cid',
  token_endpoint: 'https://clerk.example.com/oauth/token',
  access_token: accessToken,
  refresh_token: 'rt-' + accessToken,
  expires_at: 10000000,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A refresh whose PRE-LOCK read is pinned open by a file barrier, so a login can be made to land in
// exactly the window the fence exists for.
async function barrieredRefresh() {
  const dir = process.env.RACE_BARRIER;
  let calls = 0;
  const getCredentialRecord = async (d) => {
    calls += 1;
    const record = await readCredentialRecord(d);
    if (calls === 1) {
      fs.writeFileSync(dir + '/read.flag', '1', 'utf-8');
      for (let i = 0; i < 600 && !fs.existsSync(dir + '/login.done'); i += 1) await wait(10);
    }
    return record;
  };
  return forceRefresh({
    ...deps,
    getCredentialRecord,
    refreshTokens: async () => ({ tokens: { access_token: tag, expires_in: 3600 } }),
  });
}

async function main() {
  if (op === 'commit') return commitCredentials(creds(tag), deps);
  if (op === 'delete') return deleteCredentialRecord(deps);
  if (op === 'read') return readCredentialRecord(deps);
  if (op === 'refresh') return barrieredRefresh();
  if (op === 'commit-unlocked') {
    const r = await commitCredentials(creds(tag), { ...deps, lock: unlocked });
    raise(ROLE + '.done');
    return r;
  }
  throw new Error('unknown op ' + op);
}

main().then(
  (r) => { process.stdout.write(JSON.stringify(r)); },
  (e) => { process.stdout.write(JSON.stringify({ status: 'threw', message: String(e && e.message) })); },
);
`;

function arena(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credrace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'child.mjs');
  fs.writeFileSync(child, CHILD_SOURCE, 'utf-8');
  return {
    dir,
    child,
    home: path.join(dir, 'home'),
    keyring: path.join(dir, 'keyring'),
  };
}

function spawnChild(a, op, tag, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [a.child, op, tag == null ? '' : tag],
      {
        env: {
          ...process.env,
          BEEZI_CURSOR_HOME: a.home,
          RACE_KEYRING: a.keyring,
          ...env,
        },
      },
      (error, stdout) => {
        try { resolve(JSON.parse(String(stdout))); } catch { resolve({ status: 'unparseable', stdout: String(stdout), error: String(error) }); }
      },
    );
  });
}

const serviceFor = (a) => `beezi-cursor-h${homeDigest(a.home)}`;
const keyringEntries = (a) => {
  try {
    const out = {};
    for (const name of fs.readdirSync(a.keyring)) {
      out[Buffer.from(name, 'hex').toString('utf-8')] = fs.readFileSync(path.join(a.keyring, name), 'utf-8');
    }
    return out;
  } catch { return {}; }
};
// The control record is one immutable file PER GENERATION now; "the current record" is the highest
// one present, which is what readCurrent answers.
const control = (a) => {
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = a.home;
  try {
    const current = readCurrent(serviceFor(a));
    return { ...current.record, generation: current.generation };
  } finally {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
  }
};

test('four concurrent logins in separate processes produce one winner and no lost generation', async (t) => {
  const a = arena(t);
  const tags = ['p1', 'p2', 'p3', 'p4'];
  const results = await Promise.all(tags.map((tag) => spawnChild(a, 'commit', tag)));

  const committed = results.filter((r) => r.status === 'committed');
  assert.ok(committed.length >= 1, `at least one writer must win: ${JSON.stringify(results)}`);
  // Every outcome has to be one a caller can act on. `conflict` is the fence doing its job — a
  // writer whose lock was reclaimed refused to publish — and `error` is a store that could not be
  // written; neither destroys anything, which is what the invariants below check.
  for (const r of results) {
    assert.ok(
      ['committed', 'locked', 'conflict', 'error'].includes(r.status),
      `unexpected outcome ${JSON.stringify(r)}`,
    );
  }

  // Every winner took a distinct generation, and they form the run 1..n — no writer published over
  // a generation another had already taken.
  const generations = committed.map((r) => r.generation).sort((x, y) => x - y);
  assert.deepEqual(
    generations,
    committed.map((_, i) => i + 1),
    `generations are dense and unique — outcomes: ${JSON.stringify(results)}`,
  );

  const final = control(a);
  assert.equal(final.generation, generations[generations.length - 1], 'the control record names the newest');
  assert.deepEqual(
    fs.readdirSync(a.home).filter((name) => name.includes('.staging.')),
    [],
    'no staging breadcrumb outlived its transaction',
  );

  // Exactly one secret survives: the retired generations were cleaned up.
  const entries = keyringEntries(a);
  // Exactly one secret survives, and it is the generation the record names. The slot carries the
  // writing attempt's id, so the assertion is on the generation prefix rather than an exact name.
  assert.equal(Object.keys(entries).length, 1, JSON.stringify(entries));
  assert.ok(
    Object.keys(entries)[0].startsWith(`${serviceFor(a)}::token.g${final.generation}`),
    `surviving slot is not the committed generation: ${Object.keys(entries)[0]}`,
  );

  const read = await spawnChild(a, 'read');
  assert.equal(read.status, 'ok');
  assert.equal(read.generation, final.generation);
  assert.ok(tags.includes(read.creds.access_token));
});

test('a logout racing a login never leaves a readable credential behind a deleted control record', async (t) => {
  const a = arena(t);
  await spawnChild(a, 'commit', 'original');

  const [logout, login] = await Promise.all([
    spawnChild(a, 'delete'),
    spawnChild(a, 'commit', 'relinked', { RACE_CLIENT_ID: 'cid-2' }),
  ]);
  assert.ok(logout.status === 'ok' || logout.status === 'locked', JSON.stringify(logout));
  assert.ok(login.status === 'committed' || login.status === 'locked', JSON.stringify(login));

  const read = await spawnChild(a, 'read');
  const entries = keyringEntries(a);
  if (read.status === 'missing') {
    // Logout won the ordering: nothing may still be readable anywhere.
    assert.deepEqual(entries, {}, 'a deleted store leaves no secret behind');
  } else {
    // The login committed after the delete — the racing new credential must SURVIVE, and it must be
    // the only one there.
    assert.equal(read.status, 'ok');
    assert.equal(read.creds.access_token, 'relinked');
    assert.equal(Object.keys(entries).length, 1, JSON.stringify(entries));
    assert.ok(Object.keys(entries)[0].startsWith(`${serviceFor(a)}::token.g${read.generation}`));
  }
});

test('a logout confirms the deletion rather than trusting the delete call', async (t) => {
  const a = arena(t);
  await spawnChild(a, 'commit', 'original');
  const out = await spawnChild(a, 'delete');
  assert.equal(out.status, 'ok');
  assert.equal(out.verified, true);
  assert.deepEqual(keyringEntries(a), {});
  // A tombstone is a published record naming no backend, so the epoch keeps advancing across a
  // logout/login pair instead of restarting and repeating an earlier epoch string.
  const tomb = control(a);
  assert.equal(tomb.backend, null);
  assert.ok(tomb.generation > 0);
});

test('a login blocked by a live lock reports it instead of writing anyway', async (t) => {
  const a = arena(t);
  fs.mkdirSync(path.join(a.home, 'credentials.lock'), { recursive: true });
  fs.writeFileSync(
    path.join(a.home, 'credentials.lock', 'owner.json'),
    // This test process is unambiguously alive, and it started before the child did.
    JSON.stringify({ owner: { pid: process.pid, processStartTime: 1, nonce: 'held' }, acquiredAt: Date.now() }),
    'utf-8',
  );
  // `processStartTime: 1` would be read as a recycled pid by a process that shares it; the child has
  // a different pid, so it must consult the OS — and the OS says this pid is alive.
  const result = await spawnChild(a, 'commit', 'blocked', { RACE_LOCK_WAIT_MS: '150' });
  assert.equal(result.status, 'locked');
  assert.deepEqual(keyringEntries(a), {}, 'nothing was written');
  assert.equal(fs.existsSync(path.join(a.home, 'credential-store.json')), false);
});

// A refresh reads the stored credential BEFORE it queues for the lock. What it is queueing behind
// may well be a LOGIN. Committing the refresh afterwards would retire the credential the user just
// created and leave the machine holding a token for an OAuth client that no longer exists — the
// symptom is a machine that reports itself linked and 401s on every request.
//
// The barrier makes the race deterministic: the refreshing child publishes `read.flag` the instant
// it has its (soon to be stale) record, then waits for the login child to finish committing.
test('a login that lands while a refresh waits for the lock is not overwritten', async (t) => {
  const a = arena(t);
  await spawnChild(a, 'commit', 'original');

  const refreshing = spawnChild(a, 'refresh', 'refreshed', { RACE_BARRIER: a.dir });
  // Wait until the refresh has taken its pre-lock read.
  const readFlag = path.join(a.dir, 'read.flag');
  for (let i = 0; i < 400 && !fs.existsSync(readFlag); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(fs.existsSync(readFlag), true, 'the refreshing child never took its pre-lock read');

  const login = await spawnChild(a, 'commit', 'relinked', { RACE_CLIENT_ID: 'cid-2' });
  assert.equal(login.status, 'committed');
  fs.writeFileSync(path.join(a.dir, 'login.done'), '1', 'utf-8');

  const refreshed = await refreshing;
  assert.equal(refreshed.ok, false, 'the refresh must not claim success against a changed identity');
  assert.equal(refreshed.state, 'refreshing');
  assert.equal(refreshed.reason, 'conflict');

  const read = await spawnChild(a, 'read');
  assert.equal(read.status, 'ok');
  assert.equal(read.creds.access_token, 'relinked', "the login's credential is the one that survived");
  assert.equal(read.generation, login.generation, 'and the refresh took no generation of its own');
  const surviving = Object.keys(keyringEntries(a));
  assert.equal(surviving.length, 1, JSON.stringify(surviving));
  assert.ok(surviving[0].startsWith(`${serviceFor(a)}::token.g${login.generation}`));
});

// Two writers inside the critical section AT ONCE — the state the design allows for, since the lock
// is an optimisation and a reclaim can hand two processes a section. Everything about correctness
// therefore has to come from the store.
//
// The record publish is a compare-and-set, but for a long time the SECRET SLOT was not: it was named
// `g{generation}` from the generation alone, so both writers addressed the same slot. B's write
// clobbered A's, A published the record and retired the old generation, B lost the publish and
// deleted the shared slot — leaving a published record naming an empty slot, a user told they were
// signed in, and every later read MISSING.
test('two writers in the section at once cannot corrupt the committed credential', async (t) => {
  const a = arena(t);
  await spawnChild(a, 'commit', 'seed');

  const [first, second] = await Promise.all([
    spawnChild(a, 'commit-unlocked', 'writer-a', { RACE_ROLE: 'a', RACE_BARRIER: a.dir }),
    spawnChild(a, 'commit-unlocked', 'writer-b', { RACE_ROLE: 'b', RACE_BARRIER: a.dir }),
  ]);
  const outcomes = JSON.stringify([first, second]);
  for (const r of [first, second]) {
    assert.ok(['committed', 'conflict', 'error', 'locked'].includes(r.status), outcomes);
  }
  const committed = [first, second].filter((r) => r.status === 'committed');
  assert.equal(committed.length, 1, `exactly one writer may commit: ${outcomes}`);
  // The loser minted its credential against state that has since moved. `commitCredentials`
  // defaults to abandoning on a conflict, so it must NOT have rebased and published a newer
  // generation carrying its stale decision — M01.1's "no losing writer overwrites a newer
  // generation".
  assert.equal(committed[0].generation, 2, `a loser published over the winner: ${outcomes}`);

  // The store must still serve a real credential. This is the assertion that fails when two writers
  // share a slot: the record is published and points at nothing.
  const read = await spawnChild(a, 'read');
  assert.equal(read.status, 'ok', `the committed record names an empty slot: ${JSON.stringify(read)}`);
  assert.ok(
    ['seed', 'writer-a', 'writer-b'].includes(read.creds.access_token),
    `unexpected surviving credential ${JSON.stringify(read.creds)}`,
  );

  assert.equal(read.generation, committed[0].generation, 'the store does not serve the winner');
  // The loser removed its own staged secret and nothing else: exactly one slot survives.
  const left = Object.keys(keyringEntries(a));
  assert.equal(left.length, 1, `stray secrets left behind: ${JSON.stringify(left)}`);
  assert.deepEqual(
    fs.readdirSync(a.home).filter((name) => name.includes('.staging.')),
    [],
    'a breadcrumb outlived its transaction',
  );
  assert.equal(
    read.creds.access_token,
    committed[0].generation === 2 && first.status === 'committed' ? 'writer-a' : 'writer-b',
    'the committed record does not name the winner’s own secret',
  );
});
