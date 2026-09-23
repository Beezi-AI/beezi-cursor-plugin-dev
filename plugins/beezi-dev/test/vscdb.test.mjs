import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSqliteAvailable,
  prefixUpperBound,
  readKeys,
  readKeysBounded,
  readComposerData,
  readUsageData,
  withDatabase,
} from '../lib/vscdb.mjs';

// The suite exercises the real node:sqlite path when it exists, and the degraded path always —
// `deps.sqlite = null` simulates a runtime without it, which is a supported production configuration
// (Node below 24, or a build without SQLite).
const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;

function makeDb(rows, table = 'cursorDiskKV') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-vscdb-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE "${table}" (key TEXT PRIMARY KEY, value BLOB)`);
  const insert = db.prepare(`INSERT INTO "${table}" (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  db.close();
  return file;
}

const composerKey = (id) => `composerData:${id}`;

test('prefixUpperBound produces the successor key used for the range scan', () => {
  assert.equal(prefixUpperBound('composerData:'), 'composerData;');
  assert.equal(prefixUpperBound('a'), 'b');
  assert.equal(prefixUpperBound(''), null);
  assert.equal(prefixUpperBound(null), null);
  assert.equal(prefixUpperBound(`x${String.fromCharCode(0xffff)}`), null);
});

test('isSqliteAvailable reports the injected probe rather than the ambient runtime', () => {
  assert.equal(isSqliteAvailable({ sqlite: null }), false);
  assert.equal(isSqliteAvailable({ sqlite: { DatabaseSync: class {} } }), true);
});

test('without node:sqlite every reader degrades to null, never a throw', () => {
  const deps = { sqlite: null, stateVscdbFile: '/nowhere/state.vscdb' };
  assert.equal(withDatabase('/nowhere/state.vscdb', () => 'x', deps), null);
  assert.equal(readKeys('/nowhere/state.vscdb', 'composerData:', deps), null);
  assert.equal(readComposerData('conv-1', deps), null);
  // This is the line that produces billing_pool 'unknown' on a machine without SQLite.
  assert.equal(readUsageData('conv-1', deps), null);
});

test('a missing database file reads as null, not as an empty result', () => {
  const missing = path.join(os.tmpdir(), 'beezi-cursor-absent-state.vscdb');
  assert.equal(readKeys(missing, 'composerData:'), null);
  assert.equal(readUsageData('conv-1', { stateVscdbFile: missing }), null);
});

test('an unresolvable database path yields null rather than guessing', () => {
  assert.equal(readUsageData('conv-1', { stateVscdbFile: null }), null);
});

test('readKeys range-scans a prefix and excludes neighbouring keys', { skip: !sqlite }, () => {
  const file = makeDb({
    'composerDaso:zzz': { no: true },
    [composerKey('a')]: { name: 'A' },
    [composerKey('b')]: { name: 'B' },
    'composerData;after': { no: true },
    'cursorAuth/stripeMembershipType': '"pro"',
  });
  const rows = readKeys(file, 'composerData:');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key).sort(), [composerKey('a'), composerKey('b')]);
});

test('readKeys returns [] for a prefix with no matches, distinct from null', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('a')]: { name: 'A' } });
  assert.deepEqual(readKeys(file, 'nothing:'), []);
});

test('readKeys reads the ItemTable spelling too', { skip: !sqlite }, () => {
  const file = makeDb({ 'cursorAuth/stripeMembershipType': '"pro"' }, 'ItemTable');
  const rows = readKeys(file, 'cursorAuth/stripeMembershipType');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, '"pro"');
});

test('readUsageData returns the priced models with amount and cents', { skip: !sqlite }, () => {
  const file = makeDb({
    [composerKey('conv-1')]: {
      name: 'Fix the parser',
      usageData: { 'claude-4.5-sonnet': { amount: 3, costInCents: 42 } },
    },
  });
  assert.deepEqual(readUsageData('conv-1', { stateVscdbFile: file }), {
    'claude-4.5-sonnet': { amount: 3, costInCents: 42 },
  });
});

test('a record with no usageData means "read fine, nothing priced" — {} not null', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'Fix the parser' } });
  const usage = readUsageData('conv-1', { stateVscdbFile: file });
  assert.deepEqual(usage, {});
  // The distinction the whole cost split rests on: {} is subscription, null is unknown.
  assert.notEqual(usage, null);
});

test('an absent composerData record is unreadable — null, never {}', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('other')]: { usageData: {} } });
  assert.equal(readUsageData('conv-1', { stateVscdbFile: file }), null);
});

test('a prefix hit on a longer key is not mistaken for this conversation', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1-extra')]: { usageData: { m: { amount: 9, costInCents: 900 } } } });
  assert.equal(readUsageData('conv-1', { stateVscdbFile: file }), null);
});

test('usageData present but not an object is a schema miss — null, never {}', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { usageData: [{ model: 'm', amount: 2 }] } });
  assert.equal(readUsageData('conv-1', { stateVscdbFile: file }), null);
});

test('usageData entries with no field we recognize are a schema miss, not zero spend', { skip: !sqlite }, () => {
  const file = makeDb({
    [composerKey('conv-1')]: { usageData: { 'claude-4.5-sonnet': { totalMicroDollars: 4200 } } },
  });
  assert.equal(readUsageData('conv-1', { stateVscdbFile: file }), null);
});

test('an explicitly empty usageData object stays {} — nothing was priced', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { usageData: {} } });
  assert.deepEqual(readUsageData('conv-1', { stateVscdbFile: file }), {});
});

test('alternate amount/cents spellings are accepted', { skip: !sqlite }, () => {
  const file = makeDb({
    [composerKey('conv-1')]: { usageData: { 'gpt-5': { numRequests: '4', costCents: 75 } } },
  });
  assert.deepEqual(readUsageData('conv-1', { stateVscdbFile: file }), {
    'gpt-5': { amount: 4, costInCents: 75 },
  });
});

test('an unparseable composerData value reads as unreadable', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: 'not json{' });
  assert.equal(readComposerData('conv-1', { stateVscdbFile: file }), null);
  assert.equal(readUsageData('conv-1', { stateVscdbFile: file }), null);
});

test('withDatabase falls back to a WAL snapshot when the direct open cannot answer', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'A' } });
  let calls = 0;
  const value = withDatabase(file, (db) => {
    calls += 1;
    // Fail the first attempt the way a live-WAL read does, then succeed against the copy.
    if (calls === 1) throw new Error('database is locked');
    return db.prepare('SELECT count(*) AS n FROM cursorDiskKV').get().n;
  });
  assert.equal(calls, 2);
  assert.equal(value, 1);
});

test('withDatabase returns null when the callback keeps failing, and does not throw', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'A' } });
  assert.equal(
    withDatabase(file, () => {
      throw new Error('always');
    }),
    null,
  );
});

test('the database is opened read-only — a hook can never mutate Cursor state', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'A' } });
  const wrote = withDatabase(file, (db) => {
    try {
      db.exec("INSERT INTO cursorDiskKV (key, value) VALUES ('x', 'y')");
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(wrote, false);
});

// ─── noSnapshot (CLI chat stores) ───────────────────────────────────────────
//
// The Cursor CLI's store.db carries `blobEncryptionKey` in its meta row, and its WAL holds the same
// data. The snapshot fallback copies .db + -wal + -shm into a temp directory, and a hook killed at
// its deadline leaves that copy behind. `noSnapshot: true` makes a failure a plain null instead.

test('noSnapshot: an open failure returns null without calling the callback or copying', () => {
  const copies = [];
  let calls = 0;
  const value = withDatabase('/some/store.db', () => { calls += 1; return 'x'; }, {
    sqlite: { DatabaseSync: function DatabaseSync() { throw new Error('open'); } },
    exists: () => true,
    mkdtemp: (prefix) => { copies.push(prefix); throw new Error('no snapshot expected'); },
    noSnapshot: true,
  });
  assert.equal(value, null);
  assert.equal(calls, 0);
  assert.deepEqual(copies, []);
});

test('noSnapshot: a file that is not a database returns null without copying', { skip: !sqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-vscdb-'));
  const file = path.join(dir, 'store.db');
  // SQLite opens lazily, so garbage usually "opens" and fails at the first query; either branch
  // must end in null with no temp copy.
  fs.writeFileSync(file, 'this is not a sqlite database, only text padding it out. '.repeat(40));
  const copies = [];
  const value = withDatabase(file, (db) => db.prepare('SELECT count(*) AS n FROM blobs').get().n, {
    mkdtemp: (prefix) => { copies.push(prefix); throw new Error('no snapshot expected'); },
    noSnapshot: true,
  });
  assert.equal(value, null);
  assert.deepEqual(copies, []);
});

test('noSnapshot: a query failure after a good open is not retried against a copy', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'A' } });
  const copies = [];
  let calls = 0;
  const value = withDatabase(file, (db) => {
    calls += 1;
    // No `blobs` table in this database: the query throws after a successful open.
    return db.prepare('SELECT count(*) AS n FROM blobs').get().n;
  }, {
    mkdtemp: (prefix) => { copies.push(prefix); throw new Error('no snapshot expected'); },
    noSnapshot: true,
  });
  assert.equal(value, null);
  assert.equal(calls, 1);
  assert.deepEqual(copies, []);
});

test('without noSnapshot the IDE path still retries a failed query against a copy', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('conv-1')]: { name: 'A' } });
  let copies = 0;
  const value = withDatabase(file, () => { throw new Error('locked'); }, {
    mkdtemp: (prefix) => { copies += 1; return fs.mkdtempSync(prefix); },
  });
  assert.equal(value, null);
  assert.equal(copies, 1);
});

// ─── bounded key enumeration (08-C) ─────────────────────────────────────────
//
// `readKeys` decodes every matching VALUE, which for the bare `composerData:` prefix is the whole
// conversation store — hundreds of megabytes on a heavy user's machine, loaded into one array to
// answer "which conversations exist". History discovery asks the cheap question instead: keys
// only, paged, with explicit row/byte/time ceilings, and values fetched afterwards for the handful
// of ids that survive filtering.

test('readKeysBounded returns keys only, in order, without touching values', { skip: !sqlite }, () => {
  const file = makeDb({
    [composerKey('b')]: { huge: 'x'.repeat(10000) },
    [composerKey('a')]: { huge: 'y'.repeat(10000) },
    'other:z': { no: true },
  });

  const page = readKeysBounded(file, 'composerData:');

  assert.deepEqual(page.keys.map((k) => k.key), [composerKey('a'), composerKey('b')]);
  assert.equal(page.truncated, false);
  assert.equal(page.reason, 'complete');
  assert.equal('value' in page.keys[0], false, 'a value was decoded for a keys-only scan');
});

test('readKeysBounded stops at the row ceiling and says it was truncated', { skip: !sqlite }, () => {
  const rows = {};
  for (let i = 0; i < 20; i += 1) rows[composerKey(`c${String(i).padStart(2, '0')}`)] = { i };
  const file = makeDb(rows);

  const page = readKeysBounded(file, 'composerData:', { maxRows: 5, pageSize: 2 });

  assert.equal(page.keys.length, 5);
  assert.equal(page.truncated, true);
  assert.equal(page.reason, 'max-rows');
});

test('readKeysBounded pages through the prefix rather than asking for everything at once', { skip: !sqlite }, () => {
  const rows = {};
  for (let i = 0; i < 7; i += 1) rows[composerKey(`c${i}`)] = { i };
  const file = makeDb(rows);

  const page = readKeysBounded(file, 'composerData:', { pageSize: 2 });

  assert.equal(page.keys.length, 7);
  assert.equal(page.truncated, false);
});

test('readKeysBounded stops at the byte ceiling', { skip: !sqlite }, () => {
  const rows = {};
  for (let i = 0; i < 20; i += 1) rows[composerKey(`conversation-${i}`)] = { i };
  const file = makeDb(rows);

  const page = readKeysBounded(file, 'composerData:', { maxBytes: 60 });

  assert.ok(page.keys.length < 20);
  assert.equal(page.truncated, true);
  assert.equal(page.reason, 'max-bytes');
});

test('readKeysBounded stops at the time ceiling', { skip: !sqlite }, () => {
  const rows = {};
  for (let i = 0; i < 10; i += 1) rows[composerKey(`c${i}`)] = { i };
  const file = makeDb(rows);
  let clock = 0;

  const page = readKeysBounded(file, 'composerData:', { maxMs: 5, pageSize: 1, now: () => (clock += 4) });

  assert.equal(page.truncated, true);
  assert.equal(page.reason, 'max-ms');
});

test('readKeysBounded is null — never empty — when the database cannot be read', () => {
  assert.equal(readKeysBounded('/nowhere/state.vscdb', 'composerData:', {}, { sqlite: null }), null);
  assert.equal(readKeysBounded(path.join(os.tmpdir(), 'beezi-absent.vscdb'), 'composerData:'), null);
  assert.equal(readKeysBounded('/nowhere/state.vscdb', ''), null);
});

test('a database with none of the known key tables reads as unavailable, not as zero history', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('a')]: { i: 1 } }, 'somethingElse');

  assert.equal(readKeysBounded(file, 'composerData:'), null);
});

test('an unknown schema answers null WITHOUT copying the whole database', { skip: !sqlite }, () => {
  const file = makeDb({ [composerKey('a')]: { i: 1 } }, 'somethingElse');
  const copies = [];

  const page = readKeysBounded(file, 'composerData:', {}, {
    mkdtemp: (prefix) => { copies.push(prefix); throw new Error('no snapshot expected'); },
  });

  assert.equal(page, null);
  // withDatabase answers a THROWN callback by reopening from a full temp copy (.db + -wal + -shm)
  // and running it again — seconds of I/O on a heavy store, to reach the same verdict.
  assert.deepEqual(copies, [], 'the unknown-schema verdict must not trigger the snapshot fallback');
});
