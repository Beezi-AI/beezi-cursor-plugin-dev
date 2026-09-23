import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStale } from '../lib/prune.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_CURSOR_HOME = dir;
}

function stateDir(homeDir) {
  return path.join(homeDir, 'state');
}

function queueDir(homeDir) {
  return path.join(homeDir, 'queue');
}

function writeFile(dir, name, content = '{}') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function ageFile(p, ageMs, now = Date.now()) {
  // utimesSync takes seconds
  const timeSec = (now - ageMs) / 1000;
  fs.utimesSync(p, timeSec, timeSec);
}

// ─── test 1: prunes old state file ──────────────────────────────────────────

test('1. prunes old state file (mtime 31 days ago)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();
  const expiredMs = 31 * 24 * 60 * 60 * 1000;

  const p = writeFile(stateDir(homeDir), 'old.json');
  ageFile(p, expiredMs, now);

  pruneStale(now);

  assert.equal(fs.existsSync(p), false, 'old state file must be pruned');
});

// ─── test 2: keeps recent state file ────────────────────────────────────────

test('2. keeps recent state file (mtime now)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();

  const p = writeFile(stateDir(homeDir), 'fresh.json');
  ageFile(p, 0, now); // mtime = now

  pruneStale(now);

  assert.equal(fs.existsSync(p), true, 'recent state file must be kept');
});

// ─── test 3: prunes old queue file, keeps recent queue file ─────────────────

test('3. prunes old queue file, keeps recent queue file', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);

  const now = Date.now();
  const expiredMs = 31 * 24 * 60 * 60 * 1000;

  const qd = queueDir(homeDir);
  const oldFile = writeFile(qd, 'old-seg.json');
  const recentFile = writeFile(qd, 'recent-seg.json');

  ageFile(oldFile, expiredMs, now);
  ageFile(recentFile, 0, now);

  pruneStale(now);

  assert.equal(fs.existsSync(oldFile), false, 'old queue file must be pruned');
  assert.equal(fs.existsSync(recentFile), true, 'recent queue file must be kept');
});

// ─── test 4: missing dirs → no throw ────────────────────────────────────────

test('4. missing dirs → no throw', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  // Neither state/ nor queue/ exist in homeDir

  assert.doesNotThrow(() => pruneStale(Date.now()));
});

// ─── test 5: custom maxAgeMs boundary ────────────────────────────────────────

test('5. custom maxAgeMs boundary — 2-day-old file pruned at 1d, kept at 3d', (t) => {
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const oneDayMs = 1 * 24 * 60 * 60 * 1000;
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  // ── scenario A: maxAgeMs = 1 day → file aged 2 days should be pruned ──
  const homeDirA = makeTmpDir(t);
  process.env.BEEZI_CURSOR_HOME = homeDirA;

  const pA = writeFile(stateDir(homeDirA), 'file-a.json');
  ageFile(pA, twoDaysMs, now);

  pruneStale(now, oneDayMs);
  assert.equal(fs.existsSync(pA), false, '2-day-old file pruned with maxAgeMs=1day');

  // ── scenario B: maxAgeMs = 3 days → file aged 2 days should be kept ──
  const homeDirB = makeTmpDir(t);
  process.env.BEEZI_CURSOR_HOME = homeDirB;

  const pB = writeFile(stateDir(homeDirB), 'file-b.json');
  ageFile(pB, twoDaysMs, now);

  pruneStale(now, threeDaysMs);
  assert.equal(fs.existsSync(pB), true, '2-day-old file kept with maxAgeMs=3days');
});

// ─── pending/ and the capture sweep (integration step 2: PR-1, PR-2) ────────────────────────────

test('pruneStale collects an expired pending batch and keeps a fresh one', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  const dir = path.join(home, 'pending');
  const old = writeFile(dir, 'conv-old.json', '{"version":1}');
  const fresh = writeFile(dir, 'conv-new.json', '{"version":1}');
  const now = Date.now();
  ageFile(old, 31 * 24 * 60 * 60 * 1000, now);

  pruneStale(now);

  // Checkpoint recovery deliberately LEAVES a batch whose account no longer matches — enqueuing
  // another tenant's payloads is worse than one orphaned file — so nothing else ever deletes it.
  assert.equal(fs.existsSync(old), false, 'an orphaned batch is not immortal');
  assert.equal(fs.existsSync(fresh), true, 'a batch awaiting recovery on the next hook survives');
});

test('pruneStale does not throw when pending/ has never been created', (t) => {
  setHome(makeTmpDir(t));
  assert.doesNotThrow(() => pruneStale(Date.now()));
});

test('pruneStale runs the capture sweep even on a machine where capture is switched off', (t) => {
  // `capture/` cannot join the mtime loop above: that loop unlinks immediate files only, so it can
  // neither reach nested capture/stdin/ nor cap a log appended to continuously — a file written all
  // week is never 14 days old. Its own bounded sweep has to be called, and it has to be called on
  // every machine, or a user who turned capture off keeps the raw payloads forever.
  const home = makeTmpDir(t);
  setHome(home);
  const previous = process.env.BEEZI_CURSOR_DUMP_HOOKS;
  delete process.env.BEEZI_CURSOR_DUMP_HOOKS;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_DUMP_HOOKS;
    else process.env.BEEZI_CURSOR_DUMP_HOOKS = previous;
  });

  const stdin = path.join(home, 'capture', 'stdin');
  const stale = writeFile(stdin, '1111-stale.bin', 'x');
  const now = Date.now();
  ageFile(stale, 5 * 60 * 60 * 1000, now);

  pruneStale(now);

  assert.equal(fs.existsSync(stale), false, 'the nested replay the mtime loop cannot see is swept');
});
