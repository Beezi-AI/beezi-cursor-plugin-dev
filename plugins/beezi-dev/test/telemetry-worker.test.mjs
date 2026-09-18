import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  WATCHDOG_MS,
  WATCHDOG_ENV_VAR,
  resolveWatchdogMs,
  startWatchdog,
  workerScriptPath,
  hasPendingWork,
  spawnWorker,
  maybeLaunchWorker,
  runWorker,
} from '../lib/telemetry-worker.mjs';
import { setConsent } from '../lib/telemetry-consent.mjs';
import { suppressRecording, isSuppressed } from '../lib/telemetry-recorder.mjs';
import { SEND_STATE_VERSION, MIN_SEND_INTERVAL_MS } from '../lib/telemetry-transport.mjs';
import {
  telemetryQueueDir,
  telemetrySendStateFile,
  telemetryLockDir,
  acquireTelemetryLock,
  releaseTelemetryLock,
  lockOwnerToken,
} from '../lib/telemetry-store.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-wrk-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function seed(dir, count = 1) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `k${i}.json`), JSON.stringify({
      eventId: `evt${i}`, code: 'hook_crash', source: 'stop', pluginVersion: '0.5.2',
      count: 1, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    }));
  }
}

const fakeSpawn = (launches) => (cmd, args, options) => {
  launches.push({ cmd, args, options });
  return { unref() { this.unrefed = true; }, unrefed: false };
};

// ─── the lock ───────────────────────────────────────────────────────────────

test('the lock is exclusive while its owner is alive and inside the window', async () => {
  await withHome(() => {
    const lock = telemetryLockDir();
    const token = acquireTelemetryLock(lock);
    assert.equal(token, lockOwnerToken());
    assert.equal(acquireTelemetryLock(lock), null, 'a live lock is not stolen');
    assert.equal(releaseTelemetryLock(lock, token), true);
    assert.equal(fs.existsSync(lock), false);
  });
});

test('a dead owner is recovered; a live one with a reused pid is not', async () => {
  await withHome(() => {
    const lock = telemetryLockDir();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      pid: 424242, instance: 'gone', at: Date.now(),
    }));
    assert.notEqual(acquireTelemetryLock(lock, { isAlive: () => false }), null, 'dead owner');
    releaseTelemetryLock(lock, lockOwnerToken());

    // PID reuse: the number is alive again, but it is a different process, and the claim is fresh.
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'a-previous-incarnation', at: Date.now(),
    }));
    assert.equal(acquireTelemetryLock(lock, { isAlive: () => true }), null,
      'a live pid inside the window keeps its lock whoever it is');
  });
});

test('a claim older than the staleness window is broken', async () => {
  await withHome(() => {
    const lock = telemetryLockDir();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'stuck', at: 1000,
    }));
    const token = acquireTelemetryLock(lock, { now: () => 1000000, isAlive: () => true });
    assert.notEqual(token, null);
    releaseTelemetryLock(lock, token);
  });
});

test('a stale process cannot remove its successor\'s lock', async () => {
  await withHome(() => {
    const lock = telemetryLockDir();
    // The loser's token, from before it was broken.
    const stale = '99999:an-old-instance';
    const successor = acquireTelemetryLock(lock);
    assert.equal(releaseTelemetryLock(lock, stale), false, 'the token check refuses');
    assert.ok(fs.existsSync(lock), 'the successor still holds it');
    assert.equal(releaseTelemetryLock(lock, successor), true);
  });
});

test('a lock with an unreadable owner file is treated as abandoned', async () => {
  await withHome(() => {
    const lock = telemetryLockDir();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), '{not json');
    assert.notEqual(acquireTelemetryLock(lock), null);
  });
});

// ─── launching ──────────────────────────────────────────────────────────────

test('no consent, no pending work and a closed window each refuse a launch', async () => {
  await withHome(() => {
    const launches = [];
    assert.equal(maybeLaunchWorker({ spawnImpl: fakeSpawn(launches) }), false, 'no consent');

    setConsent('on');
    assert.equal(maybeLaunchWorker({ spawnImpl: fakeSpawn(launches) }), false, 'nothing to send');

    seed(telemetryQueueDir());
    assert.equal(hasPendingWork(), true);
    assert.equal(maybeLaunchWorker({ spawnImpl: fakeSpawn(launches), now: () => 1000 }), true);
    assert.equal(launches.length, 1);
  });
});

test('two triggers a millisecond apart produce exactly one launch', async () => {
  await withHome(() => {
    setConsent('on');
    seed(telemetryQueueDir());
    const launches = [];
    const spawnImpl = fakeSpawn(launches);
    assert.equal(maybeLaunchWorker({ spawnImpl, now: () => 5000 }), true);
    assert.equal(maybeLaunchWorker({ spawnImpl, now: () => 5001 }), false);
    assert.equal(launches.length, 1, 'the window was already claimed');
    // And the window reopens once the minimum interval has passed.
    assert.equal(maybeLaunchWorker({ spawnImpl, now: () => 5000 + 60000 }), true);
    assert.equal(launches.length, 2);
  });
});

test('the child is detached, hidden, silent and unref\'d, and inherits this home', async () => {
  await withHome((home) => {
    setConsent('on');
    seed(telemetryQueueDir());
    const launches = [];
    const child = { unrefed: false, unref() { this.unrefed = true; } };
    assert.equal(maybeLaunchWorker({
      now: () => 1,
      spawnImpl: (cmd, args, options) => { launches.push({ cmd, args, options }); return child; },
    }), true);

    const launch = launches[0];
    assert.equal(launch.cmd, process.execPath);
    assert.deepEqual(launch.args, [workerScriptPath()]);
    assert.equal(launch.options.detached, true);
    assert.equal(launch.options.stdio, 'ignore');
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.env.BEEZI_CURSOR_HOME, home,
      'the child can never drain another variant\'s queue');
    assert.equal(child.unrefed, true);
  });
});

test('a spawn that fails costs the caller nothing', async () => {
  await withHome(() => {
    setConsent('on');
    seed(telemetryQueueDir());
    assert.equal(spawnWorker({ spawnImpl: () => { throw new Error('EPERM'); } }), false);
    assert.equal(spawnWorker({ spawnImpl: () => null }), false);
    assert.equal(maybeLaunchWorker({ spawnImpl: () => { throw new Error('EMFILE'); } }), false);
  });
});

test('the worker script exists where the launcher points', () => {
  assert.ok(fs.existsSync(workerScriptPath()), workerScriptPath());
});

// ─── running ────────────────────────────────────────────────────────────────

test('the worker rechecks consent and purges rather than sending', async () => {
  await withHome(async () => {
    seed(telemetryQueueDir(), 3); // queued while consent was on, revoked since
    let posts = 0;
    const result = await runWorker({ postDiagnosticsImpl: async () => { posts += 1; return { status: 200 }; } });
    assert.equal(posts, 0);
    assert.equal(result.purged, true);
    assert.deepEqual(fs.readdirSync(telemetryQueueDir()), []);
  });
});

test('a worker that cannot take the lock does nothing at all', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(telemetryQueueDir());
    const lock = telemetryLockDir();
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'someone-else', at: Date.now(),
    }));
    let posts = 0;
    const result = await runWorker({ postDiagnosticsImpl: async () => { posts += 1; return { status: 200 }; } });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'locked');
    assert.equal(posts, 0);
    assert.equal(fs.readdirSync(telemetryQueueDir()).length, 1, 'the holder\'s work is untouched');
  });
});

test('the worker holds the lock while it flushes', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(telemetryQueueDir());
    let heldDuringPost = null;
    await runWorker({
      postDiagnosticsImpl: async (url, body) => {
        heldDuringPost = acquireTelemetryLock(telemetryLockDir());
        const events = JSON.parse(body).events;
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.equal(heldDuringPost, null, 'nobody else could have taken it mid-batch');
    assert.equal(fs.existsSync(telemetryLockDir()), false, 'and it is released afterwards');
  });
});

// ─── the watchdog ───────────────────────────────────────────────────────────

test('the watchdog is thirty seconds and can only be shortened', () => {
  assert.equal(WATCHDOG_MS, 30 * 1000);
  assert.equal(resolveWatchdogMs(undefined), WATCHDOG_MS);
  assert.equal(resolveWatchdogMs('not a number'), WATCHDOG_MS);
  assert.equal(resolveWatchdogMs('600000'), WATCHDOG_MS, 'never extended');
  assert.equal(resolveWatchdogMs('0'), 50, 'never disabled');
  assert.equal(resolveWatchdogMs('-1'), 50);
  assert.equal(resolveWatchdogMs('300'), 300);
});

test('the watchdog exits the process when it fires', async () => {
  let code = null;
  const timer = startWatchdog({ ms: 20, exit: (value) => { code = value; } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearTimeout(timer);
  assert.equal(code, 0, 'the process is asked to leave');
});

// ─── the real subprocess ────────────────────────────────────────────────────

test('a stalled endpoint cannot outlive the watchdog, and the child stays silent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-wrk-sub-'));
  // A server that accepts the connection, reads the body and then says nothing at all — the exact
  // shape that leaves a fetch pending forever.
  const server = http.createServer((req) => { req.resume(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const previous = process.env.BEEZI_CURSOR_HOME;
    process.env.BEEZI_CURSOR_HOME = home;
    try {
      setConsent('on');
      seed(telemetryQueueDir(), 2);
    } finally {
      if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
      else process.env.BEEZI_CURSOR_HOME = previous;
    }

    const startedAt = Date.now();
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'telemetry-worker.mjs')], {
        env: Object.assign({}, process.env, {
          BEEZI_CURSOR_HOME: home,
          BEEZI_API_URL: `http://127.0.0.1:${port}/api`,
          // The real watchdog path, shortened so the test does not wait half a minute. The
          // transport's own request timeout is five seconds, so only the watchdog can end this.
          [WATCHDOG_ENV_VAR]: '400',
        }),
        timeout: 20000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });

    assert.equal(outcome.error, null, `the worker must exit cleanly: ${outcome.error}`);
    assert.ok(Date.now() - startedAt < 15000, 'the watchdog ended it');
    assert.equal(outcome.stdout, '', 'nothing may reach the hook stdout protocol');
    assert.equal(outcome.stderr, '', 'nothing may reach stderr either — Cursor reads it as failure');

    // The undelivered reports survive, and the child recorded no diagnostic about its own failure.
    const names = fs.readdirSync(path.join(home, 'telemetry', 'pending')).sort();
    assert.equal(names.length, 2, JSON.stringify(names));
    for (const name of names) {
      const event = JSON.parse(fs.readFileSync(path.join(home, 'telemetry', 'pending', name), 'utf-8'));
      assert.equal(event.code, 'hook_crash', 'no new diagnostics about the diagnostics path');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ─── suppression is scoped to the run ───────────────────────────────────────

test('runWorker restores the suppression flag it found', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(telemetryQueueDir());
    assert.equal(isSuppressed(), false);
    await runWorker({
      postDiagnosticsImpl: async (url, body) => {
        assert.equal(isSuppressed(), true, 'suppressed FOR the run');
        const events = JSON.parse(body).events;
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
      },
    });
    // In the detached process this makes no difference — it exits moments later — but runWorker is
    // also called in-process, and a flag left set would silence every later recording there with
    // nothing saying so.
    assert.equal(isSuppressed(), false, 'and not one instant longer');
  });
});

test('a throwing run still restores suppression', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(telemetryQueueDir());
    await runWorker({ postDiagnosticsImpl: () => { throw new Error('boom'); } });
    assert.equal(isSuppressed(), false);
  });
});

test('an already-suppressed caller stays suppressed afterwards', async () => {
  await withHome(async () => {
    setConsent('on');
    suppressRecording(true);
    try {
      await runWorker({ postDiagnosticsImpl: async () => ({ status: 200, retryAfterMs: null, body: null }) });
      assert.equal(isSuppressed(), true, 'restored to what it was, not to false');
    } finally {
      suppressRecording(false);
    }
  });
});

test('the window claim writes every field the sender reads back', async () => {
  await withHome(() => {
    setConsent('on');
    seed(telemetryQueueDir());
    // A 413 shrink the sender persisted must survive a worker launch, and the record must stay at
    // the version the sender validates — a literal on this side would invalidate the whole thing
    // the day that constant moves.
    fs.writeFileSync(telemetrySendStateFile(), JSON.stringify({
      version: SEND_STATE_VERSION, attempts: 2, nextAttemptAt: 0, batchLimit: 3,
    }));
    assert.equal(maybeLaunchWorker({ spawnImpl: fakeSpawn([]), now: () => 9000 }), true);
    const state = JSON.parse(fs.readFileSync(telemetrySendStateFile(), 'utf-8'));
    assert.equal(state.version, SEND_STATE_VERSION);
    assert.equal(state.attempts, 2, 'the backoff count is carried, not reset');
    assert.equal(state.batchLimit, 3, 'and so is the shrink');
    assert.equal(state.nextAttemptAt, 9000 + MIN_SEND_INTERVAL_MS);
  });
});
