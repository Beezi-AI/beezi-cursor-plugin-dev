import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childOwnerFile, readChildOwner, writeChildOwner } from '../lib/cli-child-owner.mjs';
import { stateDir } from '../lib/paths-cursor.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { resolveActiveConversation } from '../lib/active-conversation.mjs';

// The durable "this conversation is a CLI subagent of X" marker. The checkpoint writes it when the
// chat store proves a child; the checkpoint, the report queue and the timeline outbox read it, so a
// child is never reported as a session of its own even after its chat store is gone.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-owner-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const KID = '11111111-2222-4333-8444-555555555555';

test('a written marker reads back as its parent and root', (t) => {
  tmpHome(t);
  assert.equal(readChildOwner(KID), null, 'no marker, no owner');
  assert.equal(writeChildOwner(KID, { parent: 'mid', root: 'top' }), true);
  assert.deepEqual(readChildOwner(KID), { parent: 'mid', root: 'top' });
  assert.deepEqual(JSON.parse(fs.readFileSync(childOwnerFile(KID), 'utf8')), { v: 1, parent: 'mid', root: 'top' });
});

test('a missing root falls back to the parent', (t) => {
  tmpHome(t);
  writeChildOwner(KID, { parent: 'p', root: null });
  assert.deepEqual(readChildOwner(KID), { parent: 'p', root: 'p' });
});

test('the marker is not a .json file, so it is never read as a conversation state', (t) => {
  tmpHome(t);
  writeChildOwner(KID, { parent: 'p', root: 'p' });
  const file = childOwnerFile(KID);
  assert.equal(path.dirname(file), stateDir());
  assert.equal(path.basename(file), `${KID}.cli-owner`);
  // lib/active-conversation.mjs treats every state/*.json as a conversation.
  assert.notEqual(resolveActiveConversation(os.tmpdir()), `${KID}.cli-owner`);
  assert.deepEqual(fs.readdirSync(stateDir()).filter((f) => f.endsWith('.json')), []);
});

test('a marker that is not ours reads as no marker; nothing is written without a parent', (t) => {
  tmpHome(t);
  assert.equal(writeChildOwner(KID, { parent: '', root: 'x' }), false);
  assert.equal(writeChildOwner(KID, null), false);
  assert.equal(fs.existsSync(childOwnerFile(KID)), false);
  fs.mkdirSync(stateDir(), { recursive: true });
  for (const body of ['not json', '{"v":2,"parent":"p","root":"p"}', '{"v":1,"parent":"","root":"p"}', '[1]']) {
    fs.writeFileSync(childOwnerFile(KID), body);
    assert.equal(readChildOwner(KID), null, body);
  }
});

test('an id that cannot be made into a filename has no marker and never writes one', (t) => {
  tmpHome(t);
  assert.equal(childOwnerFile(''), null);
  assert.equal(childOwnerFile(null), null);
  assert.equal(readChildOwner(null), null);
  assert.equal(writeChildOwner(null, { parent: 'p', root: 'p' }), false);
});

// Fix round 2: the marker also keeps the worker's last-sent fold, the one record of it that a
// backfill or sync (which keep no state) leaves behind.
const WORK = Object.freeze({
  sig: 'sig-1',
  code_changes: { files_changed: 1, lines_added: 5, lines_removed: 1, by_extension: { '.ts': 1 } },
  operations: { file: { count: 2, est_tokens: 10 } },
});

test('a marker carries the last-sent fold, and a refresh without one keeps it', (t) => {
  tmpHome(t);
  assert.equal(writeChildOwner(KID, { parent: 'p', root: 'p', work: WORK }), true);
  assert.deepEqual(readChildOwner(KID), { parent: 'p', root: 'p', work: WORK });
  // The child's own guard refreshes the marker with ids only: the fold must survive that.
  writeChildOwner(KID, { parent: 'p', root: 'p' });
  assert.deepEqual(readChildOwner(KID), { parent: 'p', root: 'p', work: WORK });
  // A newer fold replaces it.
  const next = { ...WORK, sig: 'sig-2' };
  writeChildOwner(KID, { parent: 'p', root: 'p', work: next });
  assert.equal(readChildOwner(KID).work.sig, 'sig-2');
});

test('a marker without a fold, or with a malformed one, is still a valid marker with no fold', (t) => {
  tmpHome(t);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(childOwnerFile(KID), JSON.stringify({ v: 1, parent: 'p', root: 'p' }));
  assert.deepEqual(readChildOwner(KID), { parent: 'p', root: 'p' });
  for (const work of [null, 'x', { sig: 1 }, { sig: 's', code_changes: null, operations: {} }, { sig: 's', code_changes: {}, operations: [] }]) {
    fs.writeFileSync(childOwnerFile(KID), JSON.stringify({ v: 1, parent: 'p', root: 'p', work }));
    assert.deepEqual(readChildOwner(KID), { parent: 'p', root: 'p' }, JSON.stringify(work));
  }
  // A malformed fold is never written, and never replaces a good one.
  writeChildOwner(KID, { parent: 'p', root: 'p', work: WORK });
  writeChildOwner(KID, { parent: 'p', root: 'p', work: { sig: 3 } });
  assert.deepEqual(readChildOwner(KID).work, WORK);
});

// Fix round 3: a stored fold carries the account it was staged under and when, and the marker never
// trades a newer fold for an older one.
test('a stored fold keeps its account and staging time, and an older fold never replaces a newer one', (t) => {
  tmpHome(t);
  const newer = { ...WORK, sig: 'new', account: 'acct-a', sentAt: 2000 };
  const older = { ...WORK, sig: 'old', account: 'acct-a', sentAt: 1000 };
  writeChildOwner(KID, { parent: 'p', root: 'p', work: newer });
  assert.deepEqual(readChildOwner(KID).work, newer);
  writeChildOwner(KID, { parent: 'p', root: 'p', work: older });
  assert.equal(readChildOwner(KID).work.sig, 'new', 'older staging time: kept the newer fold');
  writeChildOwner(KID, { parent: 'p', root: 'p', work: { ...WORK, sig: 'undated', account: 'acct-a' } });
  assert.equal(readChildOwner(KID).work.sig, 'new', 'an undated fold loses to a dated one');
  writeChildOwner(KID, { parent: 'p', root: 'p', work: { ...WORK, sig: 'newest', account: 'acct-b', sentAt: 3000 } });
  assert.equal(readChildOwner(KID).work.sig, 'newest');
});

test('prune keeps an owner marker for 180 days while its state-dir siblings go at the normal horizon', (t) => {
  const home = tmpHome(t);
  writeChildOwner(KID, { parent: 'p', root: 'p' });
  const OLD = '22222222-2222-4333-8444-555555555555';
  writeChildOwner(OLD, { parent: 'p', root: 'p' });
  const sibling = path.join(stateDir(), `${KID}.json`);
  fs.writeFileSync(sibling, '{}');
  const day = 24 * 60 * 60 * 1000;
  const at = (file, ageDays) => { const s = (Date.now() - ageDays * day) / 1000; fs.utimesSync(file, s, s); };
  at(childOwnerFile(KID), 60);
  at(sibling, 60);
  at(childOwnerFile(OLD), 200);
  const snapDir = path.join(home, 'snap');
  fs.mkdirSync(snapDir);
  pruneStale(Date.now(), undefined, { tmpDir: snapDir });
  assert.equal(fs.existsSync(childOwnerFile(KID)), true, 'a 60-day-old marker is kept');
  assert.equal(fs.existsSync(sibling), false, 'a 60-day-old state file is not');
  assert.equal(fs.existsSync(childOwnerFile(OLD)), false, 'past 180 days the marker goes too');
});

test('prune ages a marker out with the rest of the state dir', (t) => {
  const home = tmpHome(t);
  writeChildOwner(KID, { parent: 'p', root: 'p' });
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  fs.utimesSync(childOwnerFile(KID), old / 1000, old / 1000);
  // An isolated snapshot dir, so the sweep's temp-dir pass cannot touch anything real.
  const snapDir = path.join(home, 'snap');
  fs.mkdirSync(snapDir);
  pruneStale(Date.now(), undefined, { tmpDir: snapDir });
  assert.equal(fs.existsSync(childOwnerFile(KID)), false);
});
