import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ROTATE_AT_BYTES,
  MAX_LOG_FILES,
  LOG_MAX_AGE_MS,
  REPLAY_MAX_AGE_MS,
  MAX_ENTRIES_SCANNED,
  SWEEP_INTERVAL_MS,
  RETENTION_MARKER,
  applyCaptureRetention,
  maybeApplyCaptureRetention,
} from '../lib/capture-retention.mjs';
import { captureDir, captureFile, dumpHookPayload, DUMP_ENV_VAR } from '../lib/hook-dump.mjs';

function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cap-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const ROTATED_NAME = /^hooks\.jsonl\.\d+$/;
const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const now = () => NOW;

function makeCapture(home, spec) {
  const dir = captureDir(home);
  fs.mkdirSync(path.join(dir, 'stdin'), { recursive: true });
  for (const [rel, { bytes = 10, ageMs = 0 }] of Object.entries(spec)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(bytes));
    const at = new Date(NOW - ageMs);
    fs.utimesSync(target, at, at);
  }
  return dir;
}

const entries = (dir) => fs.readdirSync(dir).sort();
const replays = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'stdin')).sort(); } catch { return []; }
};

// ─── the declared policy ────────────────────────────────────────────────────

test('the bounds are the documented client policy', () => {
  assert.equal(ROTATE_AT_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_LOG_FILES, 4);
  assert.equal(LOG_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal(REPLAY_MAX_AGE_MS, 60 * 60 * 1000);
});

// ─── rotation and the total bound ───────────────────────────────────────────

test('the capture log rotates at 8 MiB and not before', () => {
  withHome((home) => {
    const dir = makeCapture(home, { 'hooks.jsonl': { bytes: ROTATE_AT_BYTES - 1 } });
    applyCaptureRetention(dir, { now });
    assert.deepEqual(entries(dir).filter((n) => n.startsWith('hooks')), ['hooks.jsonl']);

    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'x'.repeat(ROTATE_AT_BYTES));
    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.rotated, 1);
    const names = entries(dir).filter((n) => n.startsWith('hooks'));
    assert.equal(names.length, 1, 'the active log is gone until the next append');
    assert.match(names[0], /^hooks\.jsonl\.\d+$/);
  });
});

test('at most four capture logs survive, oldest first out', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'hooks.jsonl': { bytes: ROTATE_AT_BYTES },
      'hooks.jsonl.1000': {},
      'hooks.jsonl.2000': {},
      'hooks.jsonl.3000': {},
      'hooks.jsonl.4000': {},
      'hooks.jsonl.5000': {},
    });
    applyCaptureRetention(dir, { now });
    // Three rotations survive; the fourth slot is the active log the next append recreates, so the
    // directory holds MAX_LOG_FILES the moment capture writes again and never more.
    const rotated = entries(dir).filter((n) => ROTATED_NAME.test(n));
    assert.equal(rotated.length, MAX_LOG_FILES - 1, JSON.stringify(rotated));
    assert.ok(rotated.includes('hooks.jsonl.5000'));
    assert.ok(rotated.includes('hooks.jsonl.4000'));
    assert.ok(!rotated.includes('hooks.jsonl.1000'));
    assert.ok(!rotated.includes('hooks.jsonl.2000'));
    assert.ok(!rotated.includes('hooks.jsonl.3000'));

    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'a new line\n');
    applyCaptureRetention(dir, { now });
    assert.equal(entries(dir).filter((n) => n.startsWith('hooks')).length, MAX_LOG_FILES);
  });
});

test('a capture log older than fourteen days expires whatever its size', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'hooks.jsonl': { bytes: 10, ageMs: LOG_MAX_AGE_MS + 1000 },
      'hooks.jsonl.900': { ageMs: LOG_MAX_AGE_MS + 1000 },
      'hooks.jsonl.901': { ageMs: LOG_MAX_AGE_MS - 1000 },
    });
    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.removedLogs, 2);
    assert.deepEqual(entries(dir).filter((n) => n.startsWith('hooks')), ['hooks.jsonl.901']);
  });
});

// ─── orphan replay files ────────────────────────────────────────────────────

test('a stale replay goes and a fresh one — the active run\'s — stays', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'stdin/1111-old.bin': { ageMs: REPLAY_MAX_AGE_MS + 60000 },
      'stdin/2222-older.bin': { ageMs: 5 * 60 * 60 * 1000 },
      [`stdin/${process.pid}-now.bin`]: { ageMs: 0 },
      'stdin/3333-recent.bin': { ageMs: REPLAY_MAX_AGE_MS - 60000 },
    });
    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.removedReplays, 2);
    assert.deepEqual(replays(dir), [`${process.pid}-now.bin`, '3333-recent.bin'].sort());
  });
});

test('a replay whose pid was reused is still judged by its age alone', () => {
  // Deliberately NOT a liveness probe: pids are reused, so "this pid is alive" would preserve a
  // dead run's payload forever, and the work would be unbounded on a busy machine.
  withHome((home) => {
    const dir = makeCapture(home, {
      [`stdin/${process.pid}-stale.bin`]: { ageMs: REPLAY_MAX_AGE_MS + 1000 },
    });
    applyCaptureRetention(dir, { now });
    assert.deepEqual(replays(dir), []);
  });
});

// ─── containment ────────────────────────────────────────────────────────────

test('a symlink inside the capture root is skipped, never followed', (t) => {
  withHome((home) => {
    const outside = path.join(home, 'precious.txt');
    fs.writeFileSync(outside, 'do not delete me');
    const dir = makeCapture(home, { 'hooks.jsonl': { bytes: 10 } });
    let linked = true;
    try {
      // Windows needs a privilege for this; a machine without it just skips the case.
      fs.symlinkSync(outside, path.join(dir, 'stdin', 'link.bin'));
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip('symlink creation is not permitted on this machine');
      return;
    }
    const old = new Date(NOW - 5 * 60 * 60 * 1000);
    fs.lutimesSync(path.join(dir, 'stdin', 'link.bin'), old, old);

    const result = applyCaptureRetention(dir, { now });
    assert.ok(result.skipped >= 1, 'the link was skipped rather than unlinked');
    assert.equal(fs.existsSync(outside), true, 'nothing outside the capture root was touched');
    assert.ok(fs.readdirSync(path.join(dir, 'stdin')).includes('link.bin'));
  });
});

test('a directory inside the capture root is never unlinked', () => {
  withHome((home) => {
    const dir = makeCapture(home, { 'hooks.jsonl': { bytes: 10 } });
    const nested = path.join(dir, 'stdin', 'a-directory');
    fs.mkdirSync(nested, { recursive: true });
    const old = new Date(NOW - 5 * 60 * 60 * 1000);
    fs.utimesSync(nested, old, old);
    applyCaptureRetention(dir, { now });
    assert.equal(fs.existsSync(nested), true);
  });
});

test('a capture root that is not a usable directory is a no-op, not a throw', () => {
  withHome((home) => {
    for (const root of [path.join(home, 'nope'), null, undefined, '', 42]) {
      assert.doesNotThrow(() => applyCaptureRetention(root, { now }), String(root));
    }
  });
});

// ─── bounded, and never a hook failure ──────────────────────────────────────

test('the sweep is bounded and never throws, whatever the filesystem says', () => {
  withHome((home) => {
    const dir = makeCapture(home, { 'hooks.jsonl': { bytes: 10 } });
    let statted = 0;
    const fsImpl = {
      readdirSync: () => {
        const names = [];
        for (let i = 0; i < MAX_ENTRIES_SCANNED * 3; i += 1) names.push(`stdin/${i}.bin`);
        return names;
      },
      lstatSync: () => { statted += 1; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      unlinkSync: () => { throw new Error('EBUSY'); },
      renameSync: () => { throw new Error('EBUSY'); },
      statSync: () => { throw new Error('ENOENT'); },
      utimesSync: () => { throw new Error('EPERM'); },
      writeFileSync: () => { throw new Error('EPERM'); },
    };
    let result;
    assert.doesNotThrow(() => { result = applyCaptureRetention(dir, { now, fsImpl }); });
    assert.ok(statted <= MAX_ENTRIES_SCANNED * 2 + 4, `scanned ${statted} entries`);
    assert.equal(result.removedLogs, 0);
  });
});

test('concurrent removal under the sweep is tolerated', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'stdin/a.bin': { ageMs: 5 * 60 * 60 * 1000 },
      'stdin/b.bin': { ageMs: 5 * 60 * 60 * 1000 },
    });
    // Another hook deletes the file between the listing and the unlink.
    fs.unlinkSync(path.join(dir, 'stdin', 'a.bin'));
    let result;
    assert.doesNotThrow(() => { result = applyCaptureRetention(dir, { now }); });
    assert.equal(result.removedReplays, 1);
  });
});

// ─── the throttle, and the hook-dump call site ──────────────────────────────

test('the throttled sweep runs once and then leaves the next hook alone', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'stdin/old.bin': { ageMs: 5 * 60 * 60 * 1000 },
      'stdin/older.bin': { ageMs: 6 * 60 * 60 * 1000 },
    });
    assert.equal(maybeApplyCaptureRetention(dir, { now }).ran, true);
    assert.deepEqual(replays(dir), []);
    assert.ok(fs.existsSync(path.join(dir, RETENTION_MARKER)));

    makeCapture(home, { 'stdin/new-orphan.bin': { ageMs: 5 * 60 * 60 * 1000 } });
    assert.equal(maybeApplyCaptureRetention(dir, { now }).ran, false, 'not again this interval');
    assert.deepEqual(replays(dir), ['new-orphan.bin'], 'and it did no work');

    const later = () => NOW + SWEEP_INTERVAL_MS + 1000;
    assert.equal(maybeApplyCaptureRetention(dir, { now: later }).ran, true);
    assert.deepEqual(replays(dir), []);
  });
});

test('an oversize log is rotated even inside the throttle window', () => {
  withHome((home) => {
    const dir = makeCapture(home, { 'hooks.jsonl': { bytes: 10 } });
    maybeApplyCaptureRetention(dir, { now });
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'x'.repeat(ROTATE_AT_BYTES));
    const result = maybeApplyCaptureRetention(dir, { now });
    assert.equal(result.ran, true, 'a full log cannot wait for the interval');
    assert.equal(result.rotated, 1);
  });
});

test('hook-dump applies retention before it appends, and appending still works', () => {
  withHome((home) => {
    const previous = process.env[DUMP_ENV_VAR];
    process.env[DUMP_ENV_VAR] = '1';
    try {
      const dir = makeCapture(home, {
        'stdin/stale.bin': { ageMs: 5 * 60 * 60 * 1000 },
      });
      fs.writeFileSync(captureFile(home), 'x'.repeat(ROTATE_AT_BYTES));

      dumpHookPayload(Buffer.from('{"session_id":"s1"}'), ['--via', 'launcher']);

      const names = entries(dir).filter((n) => n.startsWith('hooks'));
      assert.ok(names.includes('hooks.jsonl'), 'the new line landed in a fresh log');
      assert.ok(names.some((n) => /^hooks\.jsonl\.\d+$/.test(n)), 'the full one was rotated');
      const written = fs.readFileSync(captureFile(home), 'utf-8');
      assert.equal(written.trim().split('\n').length, 1);
      assert.ok(written.length < ROTATE_AT_BYTES, 'the append went to the rotated-away file');
      assert.equal(JSON.parse(written).via, 'launcher');
      assert.deepEqual(replays(dir), [], 'the stale replay went with it');
    } finally {
      if (previous === undefined) delete process.env[DUMP_ENV_VAR];
      else process.env[DUMP_ENV_VAR] = previous;
    }
  });
});

test('retention never makes a hook fail, even when it cannot do anything', () => {
  withHome((home) => {
    const previous = process.env[DUMP_ENV_VAR];
    process.env[DUMP_ENV_VAR] = '1';
    try {
      // A FILE where the capture directory has to be: mkdir, rotate and append all fail.
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(captureDir(home), 'not a directory');
      assert.doesNotThrow(() => dumpHookPayload(Buffer.from('{}'), []));
    } finally {
      if (previous === undefined) delete process.env[DUMP_ENV_VAR];
      else process.env[DUMP_ENV_VAR] = previous;
    }
  });
});

test('retention works with capture switched off — prune calls it either way', () => {
  withHome((home) => {
    const dir = makeCapture(home, {
      'stdin/stale.bin': { ageMs: 5 * 60 * 60 * 1000 },
      'hooks.jsonl.10': { ageMs: LOG_MAX_AGE_MS + 1000 },
    });
    delete process.env[DUMP_ENV_VAR];
    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.removedReplays, 1);
    assert.equal(result.removedLogs, 1);
  });
});


// ─── the replay directory itself ────────────────────────────────────────────
//
// Skipping symlinked ENTRIES is not enough on its own. Replacing `capture/stdin` itself with a link
// to somewhere else makes every name inside it resolve elsewhere, while `path.join(root, 'stdin',
// name)` still passes the containment check — the link genuinely IS inside the capture root — so
// the unlink would land on the target directory's files. A junction is the Windows spelling of the
// same trick and surfaces the same way.

test('a symlinked stdin directory is skipped, so nothing outside is deleted', (t) => {
  withHome((home) => {
    const elsewhere = path.join(home, 'someone-elses-files');
    fs.mkdirSync(elsewhere, { recursive: true });
    const victim = path.join(elsewhere, '1111-old.bin');
    fs.writeFileSync(victim, 'not yours to delete');
    const old = new Date(NOW - 5 * 60 * 60 * 1000);
    fs.utimesSync(victim, old, old);

    const dir = captureDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'x');
    let linked = true;
    try {
      fs.symlinkSync(elsewhere, path.join(dir, 'stdin'), 'junction');
    } catch {
      try { fs.symlinkSync(elsewhere, path.join(dir, 'stdin'), 'dir'); } catch { linked = false; }
    }
    if (!linked) {
      t.skip('neither a junction nor a directory symlink is permitted on this machine');
      return;
    }

    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.removedReplays, 0, 'the sweep did not descend into the link');
    assert.ok(result.skipped >= 1);
    assert.equal(fs.existsSync(victim), true, 'the file it pointed at is untouched');
  });
});

test('a stdin path that is a plain file, not a directory, is skipped', () => {
  withHome((home) => {
    const dir = captureDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'x');
    fs.writeFileSync(path.join(dir, 'stdin'), 'not a directory');
    let result;
    assert.doesNotThrow(() => { result = applyCaptureRetention(dir, { now }); });
    assert.equal(result.removedReplays, 0);
    assert.ok(result.skipped >= 1);
  });
});

test('an absent stdin directory is not an error and not a skip', () => {
  withHome((home) => {
    const dir = captureDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks.jsonl'), 'x');
    const result = applyCaptureRetention(dir, { now });
    assert.equal(result.removedReplays, 0);
    assert.equal(result.skipped, 0);
  });
});
