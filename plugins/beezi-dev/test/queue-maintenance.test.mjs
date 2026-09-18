import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QUEUE_HOLD_MS,
  queueAgeMs,
  seedFirstQueuedAt,
  sweepHeldQueue,
} from '../lib/queue-maintenance.mjs';
import { recordFailure } from '../lib/queue-backoff.mjs';
import { queueDir, trackingStateFile } from '../lib/paths-cursor.mjs';
import { TrackingMode, isLiveTrackingAllowed, markTrackingDisabled, readTrackingState, recordWhoami } from '../lib/tracking.mjs';

// A policy hold is not a pause — it is a state the queue can sit in for as long as the tenant
// leaves tracking off, and every file in it is undeliverable by construction. `_retry.firstQueuedAt`
// cannot date those files: it is stamped on the first FAILURE (lib/queue-backoff.mjs), and a held
// record is never attempted, so it has none. A hold sweep keyed only off it would make every
// never-attempted record immortal until prune.mjs's unrelated 14-day rule.
//
// Hence the migration this module owns: firstQueuedAt when it is there and real, the file's
// original mtime otherwise — and the delivery path seeds the fallback ONTO the record before the
// first retry rewrite, because a rewrite refreshes mtime and destroys the only other clock.

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpQueue(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedFile(dir, name, payload, mtimeMs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (mtimeMs != null) {
    const when = new Date(mtimeMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

// ─── queueAgeMs ─────────────────────────────────────────────────────────────────────────────────

test('the hold is three days', () => {
  assert.equal(QUEUE_HOLD_MS, 3 * DAY_MS);
});

test('queueAgeMs prefers a valid _retry.firstQueuedAt over the file mtime', () => {
  const now = 10 * DAY_MS;
  const payload = { segmentId: 's', _retry: { attempts: 2, nextAttemptAt: 0, firstQueuedAt: 6 * DAY_MS } };
  // mtime is fresh because recording the retry rewrote the file — that is exactly why it must lose.
  assert.equal(queueAgeMs(payload, { mtimeMs: now }, now), 4 * DAY_MS);
});

test('queueAgeMs falls back to mtime for a record that has never failed', () => {
  const now = 10 * DAY_MS;
  assert.equal(queueAgeMs({ segmentId: 's' }, { mtimeMs: 6 * DAY_MS }, now), 4 * DAY_MS);
});

test('queueAgeMs falls back to mtime for every malformed firstQueuedAt', () => {
  const now = 10 * DAY_MS;
  const stat = { mtimeMs: 6 * DAY_MS };
  for (const bad of ['yesterday', null, undefined, NaN, Infinity, -Infinity, {}, []]) {
    const payload = { _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: bad } };
    assert.equal(queueAgeMs(payload, stat, now), 4 * DAY_MS, `firstQueuedAt=${String(bad)}`);
  }
});

test('queueAgeMs is null when neither a stamp nor an mtime is knowable', () => {
  assert.equal(queueAgeMs({ segmentId: 's' }, null, 1000), null);
  assert.equal(queueAgeMs({ segmentId: 's' }, { mtimeMs: 'nope' }, 1000), null);
  assert.equal(queueAgeMs(null, null, 1000), null);
});

test('queueAgeMs reports a future timestamp as a negative age rather than clamping it', () => {
  const now = 1000;
  const payload = { _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: now + 5 * DAY_MS } };
  assert.equal(queueAgeMs(payload, { mtimeMs: now }, now), -5 * DAY_MS);
});

// ─── seedFirstQueuedAt ──────────────────────────────────────────────────────────────────────────

test('seedFirstQueuedAt stamps the mtime onto a record that has never failed', () => {
  const payload = { segmentId: 's' };
  const seeded = seedFirstQueuedAt(payload, { mtimeMs: 4 * DAY_MS });
  assert.deepEqual(seeded._retry, { attempts: 0, nextAttemptAt: 0, firstQueuedAt: 4 * DAY_MS });
  assert.equal(payload._retry, undefined, 'the input payload must not be mutated');
});

test('seedFirstQueuedAt survives the retry rewrite that destroys the mtime', () => {
  const mtimeMs = 4 * DAY_MS;
  const now = 9 * DAY_MS;
  const failed = recordFailure(seedFirstQueuedAt({ segmentId: 's' }, { mtimeMs }), now);
  assert.equal(failed._retry.attempts, 1);
  assert.equal(failed._retry.firstQueuedAt, mtimeMs, 'the original enqueue clock must be carried forward');
  // Without the seed, recordFailure would have stamped `now` and reset the file's age to zero.
  assert.equal(recordFailure({ segmentId: 's' }, now)._retry.firstQueuedAt, now);
});

test('seedFirstQueuedAt leaves an existing stamp and an unknowable mtime alone', () => {
  const stamped = { segmentId: 's', _retry: { attempts: 3, nextAttemptAt: 7, firstQueuedAt: 5 } };
  assert.strictEqual(seedFirstQueuedAt(stamped, { mtimeMs: 99 }), stamped);
  const bare = { segmentId: 's' };
  assert.strictEqual(seedFirstQueuedAt(bare, null), bare);
  assert.strictEqual(seedFirstQueuedAt(bare, { mtimeMs: undefined }), bare);
});

// ─── sweepHeldQueue ─────────────────────────────────────────────────────────────────────────────

test('a never-failed record older than the hold is swept on its mtime alone', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'old.json', { segmentId: 'old' }, now - 4 * DAY_MS);
  seedFile(dir, 'new.json', { segmentId: 'new' }, now - 1 * DAY_MS);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.swept, 1);
  assert.equal(result.kept, 1);
  assert.deepEqual(fs.readdirSync(dir), ['new.json']);
});

test('a rewritten failed record is dated by its stamp, not by the mtime the rewrite refreshed', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  // Failed minutes ago, so its mtime is brand new — but it was first queued five days back.
  seedFile(dir, 'stale.json', {
    segmentId: 'stale',
    _retry: { attempts: 6, nextAttemptAt: now + 60000, firstQueuedAt: now - 5 * DAY_MS },
  }, now);
  // The mirror image: the file has sat on disk untouched for ten days but was only stamped an
  // hour ago (a migrated record). The stamp wins in both directions.
  seedFile(dir, 'young.json', {
    segmentId: 'young',
    _retry: { attempts: 1, nextAttemptAt: now + 60000, firstQueuedAt: now - 3600000 },
  }, now - 10 * DAY_MS);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.swept, 1);
  assert.deepEqual(fs.readdirSync(dir), ['young.json']);
});

test('the three-day boundary is exact: equal is kept, one millisecond past is swept', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'exact.json', { _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: now - QUEUE_HOLD_MS } }, now);
  seedFile(dir, 'past.json', { _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: now - QUEUE_HOLD_MS - 1 } }, now);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.swept, 1);
  assert.deepEqual(fs.readdirSync(dir), ['exact.json'], 'an age exactly equal to the hold is not yet expired');
});

test('a future timestamp is never expired — a clock that jumped must not delete the queue', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'future-stamp.json', { _retry: { attempts: 1, nextAttemptAt: 0, firstQueuedAt: now + 40 * DAY_MS } }, now);
  seedFile(dir, 'future-mtime.json', { segmentId: 'f' }, now + 40 * DAY_MS);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.swept, 0);
  assert.equal(result.kept, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['future-mtime.json', 'future-stamp.json']);
});

test('an unlink that fails is counted, not swallowed, and the record stays', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'locked.json', { segmentId: 'locked' }, now - 10 * DAY_MS);

  const fsImpl = {
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
    unlinkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
  };
  const result = sweepHeldQueue({ now, dir, fsImpl });

  assert.equal(result.swept, 0);
  assert.equal(result.stuck, 1);
  assert.deepEqual(fs.readdirSync(dir), ['locked.json'], 'the record is still there to try again');
});

test('a malformed record is reported for quarantine, never deleted by the sweep', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'broken.json', '{"segmentId":', now - 10 * DAY_MS);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.corrupt, 1);
  assert.equal(result.swept, 0);
  assert.deepEqual(fs.readdirSync(dir), ['broken.json'], 'evidence is the delivery path\'s to quarantine');
});

test('only .json basenames are considered — .tmp and .corrupt are not the sweep\'s business', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  const old = now - 10 * DAY_MS;
  seedFile(dir, 'a.json', { segmentId: 'a' }, old);
  seedFile(dir, 'b.tmp', { segmentId: 'b' }, old);
  seedFile(dir, 'c.1234.corrupt', '{"broken":', old);
  seedFile(dir, 'noext', { segmentId: 'd' }, old);

  const result = sweepHeldQueue({ now, dir });

  assert.equal(result.swept, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b.tmp', 'c.1234.corrupt', 'noext']);
});

test('a missing queue directory is not an error', () => {
  const result = sweepHeldQueue({ now: 1000, dir: path.join(os.tmpdir(), 'beezi-hold-does-not-exist-12345') });
  assert.deepEqual(result, { swept: 0, kept: 0, stuck: 0, corrupt: 0 });
});

test('a custom maxAgeMs overrides the three-day default', (t) => {
  const dir = tmpQueue(t);
  const now = 30 * DAY_MS;
  seedFile(dir, 'a.json', { segmentId: 'a' }, now - 2 * DAY_MS);
  const result = sweepHeldQueue({ now, dir, maxAgeMs: DAY_MS });
  assert.equal(result.swept, 1);
});

test('sweepHeldQueue defaults to the environment queue directory', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hold-home-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(queueDir(), { recursive: true });
  const now = 30 * DAY_MS;
  seedFile(queueDir(), 'old.json', { segmentId: 'old' }, now - 10 * DAY_MS);

  assert.equal(sweepHeldQueue({ now }).swept, 1);
  assert.deepEqual(fs.readdirSync(queueDir()), []);
});

// ─── recovery ───────────────────────────────────────────────────────────────────────────────────
//
// The hold must be escapable. A permanent local gate with no way back would turn one 403 into a
// machine that never reports again even after the tenant turns tracking back on, which is why the
// disabled mode is cached state and not a flag file: the next whoami overwrites it.

test('a live whoami lifts a disabled hold recorded by a 403', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hold-policy-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  markTrackingDisabled('TRACKING_DISABLED');
  assert.equal(readTrackingState().trackingMode, TrackingMode.DISABLED);
  assert.equal(isLiveTrackingAllowed(readTrackingState()), false);
  assert.ok(fs.existsSync(trackingStateFile()));

  recordWhoami({ valid: true, trackingMode: TrackingMode.LIVE, email: 'a@b.c' }, 'client-1');

  assert.equal(readTrackingState().trackingMode, TrackingMode.LIVE);
  assert.equal(isLiveTrackingAllowed(readTrackingState()), true, 'the hold must be recoverable, not permanent');
});
