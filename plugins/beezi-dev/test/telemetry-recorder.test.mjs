import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  MAX_PENDING,
  MAX_COUNT,
  RETENTION_MS,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SOURCES,
  normalizeSite,
  siteFrom,
  recordIssue,
  applyTelemetryRetention,
  suppressRecording,
  readPendingEvents,
} from '../lib/telemetry-recorder.mjs';
import { setConsent } from '../lib/telemetry-consent.mjs';
import {
  telemetryQueueDir, telemetryQuarantineDir, telemetryLockDir,
  purgeCorrelatedPending, purgeAllPending, installationFile,
} from '../lib/telemetry-store.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-rec-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    suppressRecording(false);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const pending = () => readPendingEvents();
const pendingFiles = () => {
  try { return fs.readdirSync(telemetryQueueDir()).sort(); } catch { return []; }
};

// ─── consent is the only gate ───────────────────────────────────────────────

test('no consent → no writes, no identifiers, no directory at all', () => {
  withHome((home) => {
    assert.equal(recordIssue('hook_crash', { source: 'stop' }), false);
    assert.equal(fs.existsSync(path.join(home, 'telemetry', 'pending')), false);
    // A denial is just as much a no as an absent record.
    setConsent('off');
    assert.equal(recordIssue('hook_crash', { source: 'stop' }), false);
    assert.deepEqual(pendingFiles(), []);
  });
});

test('a granted machine records a structured event', () => {
  withHome(() => {
    setConsent('on');
    assert.equal(recordIssue('hook_crash', { source: 'stop', status: 500 }), true);
    const events = pending();
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'hook_crash');
    assert.equal(events[0].source, 'stop');
    assert.equal(events[0].httpStatus, 500);
    assert.equal(events[0].count, 1);
    assert.match(events[0].eventId, /^[A-Za-z0-9_-]{1,64}$/);
  });
});

// ─── the code and source allowlists ─────────────────────────────────────────

test('only allowlisted codes and sources are recorded', () => {
  withHome(() => {
    setConsent('on');
    for (const code of Object.values(DIAGNOSTIC_CODES)) {
      assert.equal(recordIssue(code, { source: 'stop' }), true, code);
    }
    assert.equal(pending().length, Object.values(DIAGNOSTIC_CODES).length);
    for (const bad of ['prompt_text', '', null, undefined, 42, 'HOOK_CRASH']) {
      assert.equal(recordIssue(bad, { source: 'stop' }), false, String(bad));
    }
    // An unknown source falls back to the neutral default rather than being invented.
    assert.equal(recordIssue('hook_crash', { source: 'not_a_source' }), true);
    assert.ok(pending().some((e) => e.source === DIAGNOSTIC_SOURCES.UNKNOWN));
  });
});

// ─── nothing free-text survives ─────────────────────────────────────────────

test('a secret-bearing Error contributes only its shape', () => {
  withHome(() => {
    setConsent('on');
    const error = new Error('token=sk-live-9a8b7c6d5e4f3a2b1c0d failed for /Users/dev/secret/app.ts');
    error.code = 'ENOENT';
    error.stack = `Error: ${error.message}\n    at boom (${path.join(PLUGIN_ROOT, 'lib', 'checkpoint.mjs')}:412:9)`;
    assert.equal(recordIssue('hook_crash', {
      source: 'stop',
      error,
      // Every one of these is an attempt to smuggle prose past the allowlist.
      message: error.message,
      stack: error.stack,
      prompt: 'write me a login page',
      toolOutput: 'ok',
      repoUrl: 'git@github.com:acme/secret.git',
      hostname: os.hostname(),
      cwd: process.cwd(),
    }), true);

    const [event] = pending();
    assert.equal(event.errorName, 'Error');
    assert.equal(event.errorCode, 'ENOENT');
    assert.equal(event.site, 'lib/checkpoint.mjs:412');
    const serialized = JSON.stringify(event);
    for (const secret of ['sk-live', '/Users/dev', 'login page', 'github.com', os.hostname(), process.cwd()]) {
      assert.ok(!serialized.includes(secret), `${secret} leaked: ${serialized}`);
    }
    assert.deepEqual(Object.keys(event).filter((k) => /message|stack|prompt|tool|repo|host|cwd/i.test(k)), []);
  });
});

test('an unshaped errorName or errorCode is dropped, not truncated', () => {
  withHome(() => {
    setConsent('on');
    const error = new Error('x');
    error.code = 'could not open the file the user asked about';
    error.stack = 'Error: x\n    at nowhere (/tmp/elsewhere.js:1:1)';
    recordIssue('hook_crash', { source: 'stop', error });
    const [event] = pending();
    assert.equal(event.errorCode, null, 'a sentence is not an identifier');
    assert.equal(event.site, null, 'a frame outside the plugin is not a site');
  });
});

// ─── site containment ───────────────────────────────────────────────────────

test('a site is accepted only after normalized containment inside pluginRoot', () => {
  const inside = path.join(PLUGIN_ROOT, 'lib', 'checkpoint.mjs');
  assert.equal(normalizeSite(`${inside}:412`, PLUGIN_ROOT), 'lib/checkpoint.mjs:412');
  assert.equal(normalizeSite('lib/checkpoint.mjs:412', PLUGIN_ROOT), 'lib/checkpoint.mjs:412');
  // Already-relative forms normalize to forward slashes.
  assert.equal(normalizeSite('lib\\checkpoint.mjs:412', PLUGIN_ROOT), 'lib/checkpoint.mjs:412');
});

test('absolute, drive-letter, UNC and traversal sites are all refused', () => {
  const refused = [
    '/etc/passwd:1',
    '/Users/dev/secret/app.ts:12',
    '\\Windows\\System32\\config:1',
    'C:\\Users\\dev\\secret.mjs:12',
    'c:/Users/dev/secret.mjs:12',
    'Z:/payload.mjs:9',
    '\\\\fileserver\\share\\secret.mjs:3',
    '//fileserver/share/secret.mjs:3',
    '../../../etc/passwd:1',
    'lib/../../outside.mjs:4',
    'lib/checkpoint.mjs',           // no line number
    'lib/check point.mjs:4',        // space is not in the server's character class
    ':12',
    '',
    null,
    12,
  ];
  for (const value of refused) {
    assert.equal(normalizeSite(value, PLUGIN_ROOT), null, JSON.stringify(value));
  }
});

// ─── folding, caps, retention, quarantine ───────────────────────────────────

test('identical events fold into one record with a count', () => {
  withHome(() => {
    setConsent('on');
    for (let i = 0; i < 5; i += 1) recordIssue('hook_crash', { source: 'stop', status: 500 });
    const events = pending();
    assert.equal(events.length, 1);
    assert.equal(events[0].count, 5);
    assert.notEqual(events[0].firstSeenAt, undefined);
    assert.ok(events[0].lastSeenAt >= events[0].firstSeenAt);
  });
});

test('events that differ in any structured field do not fold together', () => {
  withHome(() => {
    setConsent('on');
    recordIssue('hook_crash', { source: 'stop', status: 500 });
    recordIssue('hook_crash', { source: 'stop', status: 502 });
    recordIssue('hook_crash', { source: 'report', status: 500 });
    recordIssue('hook_import_failed', { source: 'stop', status: 500 });
    assert.equal(pending().length, 4);
  });
});

test('the count is clamped so a hot event cannot fold itself past the server cap', () => {
  withHome(() => {
    setConsent('on');
    recordIssue('hook_crash', { source: 'stop' });
    const file = path.join(telemetryQueueDir(), pendingFiles()[0]);
    const event = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, event, { count: MAX_COUNT })));
    recordIssue('hook_crash', { source: 'stop' });
    assert.equal(pending()[0].count, MAX_COUNT);
    assert.equal(MAX_COUNT, 100000);
  });
});

test('the queue stops accepting NEW events at the 200-record cap but keeps folding', () => {
  withHome(() => {
    setConsent('on');
    const dir = telemetryQueueDir();
    fs.mkdirSync(dir, { recursive: true });
    // One real, foldable record, then fillers up to the cap.
    recordIssue('hook_crash', { source: 'stop' });
    for (let i = 0; i < MAX_PENDING - 1; i += 1) {
      fs.writeFileSync(path.join(dir, `filler-${i}.json`), JSON.stringify({
        eventId: `e${i}`, code: 'hook_crash', source: 'stop', count: 1,
        firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      }));
    }
    assert.equal(MAX_PENDING, 200);
    assert.equal(recordIssue('mcp_startup_failed', { source: 'mcp_bridge' }), false, 'new event refused');
    assert.equal(pendingFiles().length, MAX_PENDING);

    // A fold is not a new record, so an existing event still counts occurrences at the cap.
    assert.equal(recordIssue('hook_crash', { source: 'stop' }), true);
    assert.equal(pendingFiles().length, MAX_PENDING);
    assert.equal(pending().filter((e) => e.code === 'hook_crash' && e.count === 2).length, 1);
  });
});

test('records older than 14 days expire, newer ones survive', () => {
  withHome(() => {
    setConsent('on');
    const dir = telemetryQueueDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.parse('2026-09-17T00:00:00.000Z');
    const stamp = (ms) => new Date(now - ms).toISOString();
    const write = (name, lastSeenAt) => fs.writeFileSync(path.join(dir, name), JSON.stringify({
      eventId: name, code: 'hook_crash', source: 'stop', count: 1,
      firstSeenAt: lastSeenAt, lastSeenAt,
    }));
    write('old.json', stamp(RETENTION_MS + 1000));
    write('fresh.json', stamp(1000));
    fs.writeFileSync(path.join(dir, 'undated.json'), JSON.stringify({ eventId: 'x' }));

    const removed = applyTelemetryRetention({ now: () => now });
    assert.equal(RETENTION_MS, 14 * 24 * 60 * 60 * 1000);
    assert.ok(removed >= 1);
    const names = pendingFiles();
    assert.ok(names.includes('fresh.json'));
    assert.ok(!names.includes('old.json'));
  });
});

test('a corrupt record is quarantined and the event starts again', () => {
  withHome(() => {
    setConsent('on');
    recordIssue('hook_crash', { source: 'stop' });
    const name = pendingFiles()[0];
    fs.writeFileSync(path.join(telemetryQueueDir(), name), '{"count": 3, tru');

    assert.equal(recordIssue('hook_crash', { source: 'stop' }), true);
    const events = pending();
    assert.equal(events.length, 1);
    assert.equal(events[0].count, 1, 'a salvaged fragment never seeds a count');
    const quarantined = fs.readdirSync(telemetryQuarantineDir());
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /\.corrupt\.json$/);
  });
});

test('a corrupt count never compounds through string concatenation', () => {
  withHome(() => {
    setConsent('on');
    recordIssue('hook_crash', { source: 'stop' });
    const file = path.join(telemetryQueueDir(), pendingFiles()[0]);
    const event = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, event, { count: '7' })));
    recordIssue('hook_crash', { source: 'stop' });
    assert.equal(pending()[0].count, 1, 'a non-integer count restarts the event');
  });
});

// ─── never the reason a hook fails ──────────────────────────────────────────

test('recordIssue never throws, whatever the filesystem does', () => {
  withHome(() => {
    setConsent('on');
    // A file where the queue directory has to be: every write fails.
    fs.mkdirSync(path.dirname(telemetryQueueDir()), { recursive: true });
    fs.writeFileSync(telemetryQueueDir(), 'not a directory');
    assert.equal(recordIssue('hook_crash', { source: 'stop' }), false);
  });
});

test('a nested failure inside recording makes exactly one bounded attempt', () => {
  withHome(() => {
    setConsent('on');
    let depth = 0;
    let maxDepth = 0;
    let attempts = 0;
    // A write that fails the way fs-store's own state write does — and whose failure handler is
    // the thing that wants to record a diagnostic. Without the reentrancy guard this recurses.
    const write = () => {
      attempts += 1;
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        recordIssue('state_write_failed', { source: 'checkpoint' }, { write });
        throw new Error('EIO');
      } finally {
        depth -= 1;
      }
    };
    assert.equal(recordIssue('state_write_failed', { source: 'checkpoint' }, { write }), false);
    assert.equal(attempts, 1, 'the nested call was refused before it could write');
    assert.equal(maxDepth, 1);
  });
});

test('suppressRecording silences the worker entirely', () => {
  withHome(() => {
    setConsent('on');
    suppressRecording(true);
    assert.equal(recordIssue('queue_flush_http_error', { source: 'telemetry_flush' }), false);
    assert.deepEqual(pendingFiles(), []);
    suppressRecording(false);
    assert.equal(recordIssue('queue_flush_http_error', { source: 'telemetry_flush' }), true);
  });
});

// ─── correlation stamping ───────────────────────────────────────────────────

test('an event is stamped with the installation id only when one is supplied', () => {
  withHome(() => {
    setConsent('correlate');
    recordIssue('login_failed', { source: 'login' }, { installationId: () => null });
    assert.equal(pending()[0].installationId, null);
  });
  withHome(() => {
    setConsent('correlate');
    recordIssue('login_failed', { source: 'login' }, {
      installationId: () => '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(pending()[0].installationId, '11111111-2222-4333-8444-555555555555');
  });
});

// ─── real stack frames, not hand-written ones ───────────────────────────────
//
// The original version of these assertions built `error.stack` by hand, out of NATIVE paths. Real
// ESM frames name their module by URL — `at telemetryDir (file:///C:/Users/.../lib/x.mjs:22:15)` —
// so `siteFrom` matched the synthetic stacks and nothing else: every genuine failure recorded
// `site: null` on Windows, and on POSIX too as soon as the plugin path held a character URL
// encoding escapes. Every test below therefore uses an error that was actually thrown.

// A genuine TypeError raised inside lib/telemetry-store.mjs. The symbol's description is a decoy:
// it lands in the error MESSAGE looking exactly like a site, so a reader that took the message
// line would report it.
function realErrorFromPluginModule() {
  try {
    telemetryLockDir(Symbol('lib/decoy.mjs:1'));
  } catch (error) {
    return error;
  }
  throw new Error('expected telemetryLockDir to reject a symbol');
}

test('siteFrom reads a REAL esm stack frame, which names its module by URL', () => {
  const error = realErrorFromPluginModule();
  assert.match(error.stack, /\n\s+at .*file:\/\/\/.*telemetry-store\.mjs:\d+:\d+/,
    `frames are URLs, and this test is worthless if that ever stops being true:\n${error.stack}`);
  assert.match(siteFrom(error, PLUGIN_ROOT), /^lib\/telemetry-store\.mjs:\d+$/);
});

test('the decoy in the message line is not the site', () => {
  const error = realErrorFromPluginModule();
  assert.ok(error.message.includes('lib/decoy.mjs:1'), error.message);
  assert.ok(!siteFrom(error, PLUGIN_ROOT).includes('decoy'), 'the message is never read for a site');
});

test('a real failure reaches the recorded event as a site', () => {
  withHome(() => {
    setConsent('on');
    recordIssue('state_write_failed', {
      source: 'checkpoint', error: realErrorFromPluginModule(),
    });
    const [event] = pending();
    assert.match(event.site, /^lib\/telemetry-store\.mjs:\d+$/, JSON.stringify(event.site));
    assert.equal(event.errorName, 'TypeError');
    assert.ok(!JSON.stringify(event).includes('decoy'));
  });
});

test('a real failure with no frame inside the root yields no site at all', () => {
  // Narrowed to lib/, because this test file is itself inside the plugin — without narrowing,
  // "outside the plugin" is not reachable from here.
  const libRoot = path.join(PLUGIN_ROOT, 'lib');
  assert.match(siteFrom(realErrorFromPluginModule(), libRoot), /^telemetry-store\.mjs:\d+$/);

  let thrownHere = null;
  try { JSON.parse('{'); } catch (error) { thrownHere = error; }
  assert.equal(siteFrom(thrownHere, libRoot), null, 'a frame in test/ is outside lib/');
});

test('a percent-encodable plugin root still matches its own frames', () => {
  // `file://` URLs escape spaces and `#`. Comparing a raw native root against an encoded frame is
  // the POSIX half of the same bug; `pathToFileURL` on our side is what keeps the two comparable.
  const spaced = path.join(os.tmpdir(), 'beezi plugin #1');
  const href = pathToFileURL(spaced).href;
  assert.ok(href.includes('%20'), href);
  const error = new Error('boom');
  error.stack = `Error: boom\n    at run (${href}/lib/checkpoint.mjs:42:9)`;
  assert.equal(siteFrom(error, spaced), 'lib/checkpoint.mjs:42');
});

test('a quarantine name uses the injected clock', () => {
  withHome(() => {
    setConsent('on');
    const at = Date.parse('2026-09-17T12:00:00.000Z');
    recordIssue('hook_crash', { source: 'stop' }, { now: () => at });
    const name = fs.readdirSync(telemetryQueueDir())[0];
    fs.writeFileSync(path.join(telemetryQueueDir(), name), '{ not json');
    recordIssue('hook_crash', { source: 'stop' }, { now: () => at });
    const quarantined = fs.readdirSync(telemetryQuarantineDir());
    assert.equal(quarantined.length, 1);
    assert.ok(quarantined[0].includes(String(at)), quarantined[0]);
  });
});

// ─── B5: withdrawing correlation sweeps the quarantine too ──────────────────

// A quarantined record is a report whose file could not be parsed on the way back in. It is still a
// report, it is still on this machine, and it can still carry an installationId — whether or not
// anybody can read it any more is exactly the reason `purgeCorrelatedPending` treats an unreadable
// record as correlated. Sweeping only `pending/` left `corrupt/` holding stamped records after the
// user typed `anonymous`, which is the one command whose entire purpose is that no such record
// remains. `purgeAllPending` has always swept both; this closes the gap between them.
test('anonymous sweeps the quarantine as well as the queue', () => {
  withHome(() => {
    setConsent('correlate');
    const queue = telemetryQueueDir();
    const quarantine = telemetryQuarantineDir();
    fs.mkdirSync(queue, { recursive: true });
    fs.mkdirSync(quarantine, { recursive: true });

    const ID = '11111111-2222-4333-8444-555555555555';
    fs.writeFileSync(path.join(queue, 'stamped.json'), JSON.stringify({ eventId: 'a', installationId: ID }));
    fs.writeFileSync(path.join(queue, 'anon.json'), JSON.stringify({ eventId: 'b', installationId: null }));
    fs.writeFileSync(path.join(quarantine, 'q1.corrupt.json'), JSON.stringify({ eventId: 'c', installationId: ID }));
    fs.writeFileSync(path.join(quarantine, 'q2.corrupt.json'), '{{{ not json at all');
    fs.writeFileSync(path.join(quarantine, 'q3.corrupt.json'), JSON.stringify({ eventId: 'd', installationId: null }));

    purgeCorrelatedPending();

    assert.deepEqual(fs.readdirSync(queue).sort(), ['anon.json'], 'the queue keeps only anonymous reports');
    assert.deepEqual(
      fs.readdirSync(quarantine).sort(),
      ['q3.corrupt.json'],
      'the quarantine keeps only the anonymous one; unreadable counts as correlated',
    );
    assert.equal(fs.existsSync(installationFile()), false, 'and the identity itself is gone');
  });
});

test('the count anonymous reports is the PENDING count, not the quarantine too', () => {
  // The number the CLI prints is "N correlated report(s) ... were deleted", and a user reads it as
  // reports they would otherwise have sent. A quarantined record is never sent, so counting it
  // would inflate that sentence.
  withHome(() => {
    setConsent('correlate');
    const queue = telemetryQueueDir();
    const quarantine = telemetryQuarantineDir();
    fs.mkdirSync(queue, { recursive: true });
    fs.mkdirSync(quarantine, { recursive: true });
    const ID = '11111111-2222-4333-8444-555555555555';
    fs.writeFileSync(path.join(queue, 'stamped.json'), JSON.stringify({ eventId: 'a', installationId: ID }));
    fs.writeFileSync(path.join(quarantine, 'q1.corrupt.json'), JSON.stringify({ eventId: 'c', installationId: ID }));
    assert.equal(purgeCorrelatedPending(), 1);
    assert.deepEqual(fs.readdirSync(quarantine), []);
  });
});
