import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearVscdbCache, readComposerData, readUsageData } from '../lib/vscdb.mjs';

// A single checkpoint asks for the same composerData record twice — resolveSessionName wants the
// title, readUsageData wants the priced usage — and each call used to open Cursor's database from
// scratch, falling back to copying the whole file when Cursor holds the WAL. A hook process handles
// one event, so the record cannot meaningfully change between two reads inside it.

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;

// stateVscdbFile() resolves through globalStorageDir(), which reads APPDATA on Windows and
// XDG_CONFIG_HOME elsewhere — so the default (and only cached) path can be exercised for real.
function fakeStore(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-vscdb-cache-'));
  const storage = path.join(dir, 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(storage, { recursive: true });
  const file = path.join(storage, 'state.vscdb');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  for (const [key, value] of rows) {
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(key, value);
  }
  db.close();

  const vars = process.platform === 'win32' ? ['APPDATA'] : ['XDG_CONFIG_HOME'];
  const prev = {};
  for (const v of vars) { prev[v] = process.env[v]; process.env[v] = dir; }
  clearVscdbCache();
  t.after(() => {
    for (const v of vars) {
      if (prev[v] === undefined) delete process.env[v];
      else process.env[v] = prev[v];
    }
    clearVscdbCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

test('the record is read from disk once per process', { skip: !sqlite }, (t) => {
  const file = fakeStore(t, [
    ['composerData:conv-1', JSON.stringify({ name: 'Fix the parser', usageData: { m: { amount: 2, costInCents: 34 } } })],
  ]);

  const first = readComposerData('conv-1');
  assert.equal(first?.name, 'Fix the parser');

  // Delete the store. A second read that still answers can only have come from the cache — this is
  // the second consumer inside the same checkpoint, which used to pay a full open-and-read again.
  fs.rmSync(file, { force: true });

  const second = readComposerData('conv-1');
  assert.equal(second?.name, 'Fix the parser');
  assert.equal(second, first, 'the same record object should be handed back');

  // readUsageData rides on the same cached record.
  assert.deepEqual(readUsageData('conv-1'), { m: { amount: 2, costInCents: 34 } });
});

test('a miss is cached too — establishing absence costs the same open', { skip: !sqlite }, (t) => {
  fakeStore(t, [['composerData:other', JSON.stringify({ name: 'x' })]]);
  assert.equal(readComposerData('conv-1'), null);
  assert.equal(readComposerData('conv-1'), null);
});

test('clearing the cache makes the next read go back to disk', { skip: !sqlite }, (t) => {
  const file = fakeStore(t, [['composerData:conv-1', JSON.stringify({ name: 'first' })]]);
  assert.equal(readComposerData('conv-1')?.name, 'first');

  clearVscdbCache();
  fs.rmSync(file, { force: true });
  assert.equal(readComposerData('conv-1'), null);
});

test('an injected reader is never served from the cache', { skip: !sqlite }, (t) => {
  fakeStore(t, [['composerData:conv-1', JSON.stringify({ name: 'from disk' })]]);
  assert.equal(readComposerData('conv-1')?.name, 'from disk');

  // Tests that stub the store must not be answered with another test's data, and must not poison
  // the cache for the default path either.
  const stubbed = readComposerData('conv-1', { readKeys: () => [{ key: 'composerData:conv-1', value: '{"name":"stubbed"}' }] });
  assert.equal(stubbed.name, 'stubbed');
  assert.equal(readComposerData('conv-1')?.name, 'from disk');
});
