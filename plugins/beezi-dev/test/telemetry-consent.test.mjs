import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONSENT_RECORD_VERSION,
  CORRELATION_CONSENT_VERSION,
  CONSENT_MODES,
  readConsent,
  setConsent,
  isTelemetryGranted,
  isCorrelationGranted,
  hasBeenAsked,
  markNoticeShown,
  hasNoticeBeenShown,
  consentSummary,
} from '../lib/telemetry-consent.mjs';
import {
  telemetryConsentFile,
  telemetryQueueDir,
  telemetryLockDir,
  consentLockDir,
  noticeFile,
  CONSENT_LOCK_STALE_MS,
  installationFile,
} from '../lib/telemetry-store.mjs';
import { writeJsonSecure } from '../lib/fs-store.mjs';

// One isolated telemetry home per case. Nothing here may touch the developer's own
// `~/.beezi-cursor`, so every test body runs with BEEZI_CURSOR_HOME pointed at a fresh temp dir.
function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-tel-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function writeRecord(raw) {
  const file = telemetryConsentFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
}

function queueEvent(name, event) {
  const dir = telemetryQueueDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(event));
}

const pendingNames = () => {
  try { return fs.readdirSync(telemetryQueueDir()).sort(); } catch { return []; }
};

// ─── reading a record ───────────────────────────────────────────────────────

test('absent, malformed and unreadable records all deny', () => {
  withHome(() => {
    assert.equal(readConsent(), null, 'absent');
    assert.equal(isTelemetryGranted(), false);
    assert.equal(isCorrelationGranted(), false);

    writeRecord('{not json');
    assert.equal(readConsent(), null, 'malformed');
    assert.equal(isTelemetryGranted(), false);

    writeRecord({ version: 99, consent: 'granted', correlation: 'granted' });
    assert.equal(readConsent(), null, 'unknown record version');
    assert.equal(isTelemetryGranted(), false);
    assert.equal(isCorrelationGranted(), false);

    writeRecord([1, 2, 3]);
    assert.equal(readConsent(), null, 'not an object');
    assert.equal(isTelemetryGranted(), false);
  });
});

test('an unreadable consent file denies rather than throwing', () => {
  withHome(() => {
    // A directory where the file should be: every read fails with EISDIR.
    fs.mkdirSync(telemetryConsentFile(), { recursive: true });
    assert.equal(readConsent(), null);
    assert.equal(isTelemetryGranted(), false);
    assert.equal(isCorrelationGranted(), false);
  });
});

test('a correlated record still reads as granted — the record stays at version 1', () => {
  // The correlation consent version (2) is what the binding route is told; bumping the RECORD
  // version would make every correlated machine read as denied, i.e. a silent total opt-out.
  withHome(() => {
    setConsent('correlate');
    const record = readConsent();
    assert.equal(record.version, CONSENT_RECORD_VERSION);
    assert.equal(CONSENT_RECORD_VERSION, 1);
    assert.equal(CORRELATION_CONSENT_VERSION, 2);
    assert.equal(isTelemetryGranted(), true);
    assert.equal(isCorrelationGranted(), true);
  });
});

// ─── the four commands, from every starting record ──────────────────────────

const STARTS = {
  absent: null,
  granted: { version: 1, consent: 'granted', correlation: 'denied' },
  correlated: { version: 1, consent: 'granted', correlation: 'granted' },
  denied: { version: 1, consent: 'denied', correlation: 'denied' },
  malformed: '{{{',
};

// mode × starting record → [diagnostics granted, correlation granted]
const TABLE = [
  ['on', 'absent', true, false],
  ['on', 'granted', true, false],
  ['on', 'correlated', true, true],
  ['on', 'denied', true, false],
  ['on', 'malformed', true, false],
  ['off', 'absent', false, false],
  ['off', 'granted', false, false],
  ['off', 'correlated', false, false],
  ['off', 'denied', false, false],
  ['off', 'malformed', false, false],
  ['correlate', 'absent', true, true],
  ['correlate', 'granted', true, true],
  ['correlate', 'correlated', true, true],
  ['correlate', 'denied', true, true],
  ['correlate', 'malformed', true, true],
  ['anonymous', 'absent', false, false],
  ['anonymous', 'granted', true, false],
  ['anonymous', 'correlated', true, false],
  ['anonymous', 'denied', false, false],
  ['anonymous', 'malformed', false, false],
];

for (const [mode, start, granted, correlated] of TABLE) {
  test(`${mode} from a ${start} record → diagnostics ${granted}, correlation ${correlated}`, () => {
    withHome(() => {
      if (STARTS[start] !== null) writeRecord(STARTS[start]);
      const result = setConsent(mode);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.mode, mode);
      assert.equal(isTelemetryGranted(), granted);
      assert.equal(isCorrelationGranted(), correlated);
    });
  });
}

test('every declared mode is accepted and nothing else is', () => {
  withHome(() => {
    assert.deepEqual(CONSENT_MODES.slice().sort(), ['anonymous', 'correlate', 'off', 'on']);
    for (const mode of CONSENT_MODES) assert.equal(setConsent(mode).ok, true, mode);
    for (const bad of ['ON', 'yes', '', null, undefined, 'correlated']) {
      const result = setConsent(bad);
      assert.equal(result.ok, false, String(bad));
      assert.equal(result.changed, false);
      assert.equal(result.error, 'invalid-mode');
    }
  });
});

test('re-enabling after off never revives the old correlation grant', () => {
  withHome(() => {
    setConsent('correlate');
    assert.equal(isCorrelationGranted(), true);
    setConsent('off');
    setConsent('on');
    assert.equal(isTelemetryGranted(), true);
    assert.equal(isCorrelationGranted(), false, 'correlation must be re-granted explicitly');
  });
});

test('anonymous preserves the current basic diagnostics setting', () => {
  withHome(() => {
    setConsent('off');
    setConsent('anonymous');
    assert.equal(isTelemetryGranted(), false, 'anonymous must not turn diagnostics on');
    setConsent('on');
    setConsent('anonymous');
    assert.equal(isTelemetryGranted(), true, 'anonymous must not turn diagnostics off');
  });
});

// ─── a failed write cannot claim the setting changed ────────────────────────

test('a failed consent write reports ok:false and changes nothing', () => {
  withHome(() => {
    setConsent('on');
    const before = JSON.stringify(readConsent());
    const result = setConsent('off', {
      write() { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.error, 'write-failed');
    assert.equal(JSON.stringify(readConsent()), before, 'the stored record is untouched');
    assert.equal(isTelemetryGranted(), true, 'the old setting still stands');
  });
});

test('a failed write does not purge the queue either', () => {
  withHome(() => {
    setConsent('on');
    queueEvent('a', { eventId: 'a', code: 'hook_crash' });
    const result = setConsent('off', { write() { throw new Error('nope'); } });
    assert.equal(result.ok, false);
    assert.equal(result.purged, false);
    assert.deepEqual(pendingNames(), ['a.json'], 'nothing may be deleted on a failed decision');
  });
});

// ─── purge ──────────────────────────────────────────────────────────────────

test('off purges every pending event and drops the installation identity', () => {
  withHome(() => {
    setConsent('correlate');
    fs.mkdirSync(path.dirname(installationFile()), { recursive: true });
    fs.writeFileSync(installationFile(), JSON.stringify({ version: 1, id: 'x' }));
    queueEvent('a', { eventId: 'a', code: 'hook_crash', installationId: 'i' });
    queueEvent('b', { eventId: 'b', code: 'hook_crash', installationId: null });

    const result = setConsent('off');
    assert.equal(result.ok, true);
    assert.equal(result.purged, true);
    assert.equal(result.removed, 2);
    assert.deepEqual(pendingNames(), []);
    assert.equal(fs.existsSync(installationFile()), false);
  });
});

test('anonymous purges only the correlated pending events', () => {
  withHome(() => {
    setConsent('correlate');
    fs.mkdirSync(path.dirname(installationFile()), { recursive: true });
    fs.writeFileSync(installationFile(), JSON.stringify({ version: 1, id: 'x' }));
    queueEvent('stamped', { eventId: 'a', code: 'hook_crash', installationId: 'i-1' });
    queueEvent('anon', { eventId: 'b', code: 'hook_crash', installationId: null });
    queueEvent('broken', '{'); // unreadable: treated as correlated-unknown and removed

    const result = setConsent('anonymous');
    assert.equal(result.purged, true);
    assert.deepEqual(pendingNames(), ['anon.json'], 'anonymous reports keep being sent');
    assert.equal(fs.existsSync(installationFile()), false, 'the identity itself is dropped');
  });
});

test('on and correlate purge nothing', () => {
  withHome(() => {
    queueEvent('a', { eventId: 'a', code: 'hook_crash', installationId: 'i' });
    setConsent('on');
    assert.deepEqual(pendingNames(), ['a.json']);
    setConsent('correlate');
    assert.deepEqual(pendingNames(), ['a.json']);
  });
});

test('a held telemetry lock defers the purge but still persists the denial', () => {
  // The worker holds the lock while a batch is in flight. Skipping the purge is safe (the worker
  // rechecks consent and purges itself); claiming the pending reports were deleted is not.
  withHome(() => {
    setConsent('on');
    queueEvent('a', { eventId: 'a', code: 'hook_crash' });
    fs.mkdirSync(telemetryLockDir(), { recursive: true });
    fs.writeFileSync(path.join(telemetryLockDir(), 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'someone-else', at: Date.now(),
    }));

    const result = setConsent('off');
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(isTelemetryGranted(), false, 'the denial is persisted regardless');
    assert.equal(result.purged, false);
    assert.equal(result.error, 'purge-deferred');
    assert.deepEqual(pendingNames(), ['a.json'], 'the in-flight batch is left to its owner');
  });
});

// ─── notice + summary ───────────────────────────────────────────────────────

test('the one-time notice is stamped only when it is actually emitted', () => {
  withHome(() => {
    assert.equal(hasNoticeBeenShown(), false);
    assert.equal(hasBeenAsked(), false);
    assert.equal(markNoticeShown().ok, true);
    assert.equal(hasNoticeBeenShown(), true);
    // Stamping the notice is not consent.
    assert.equal(isTelemetryGranted(), false);
    assert.equal(hasBeenAsked(), false);
  });
});

test('hasBeenAsked is true only after an explicit decision', () => {
  withHome(() => {
    setConsent('on');
    assert.equal(hasBeenAsked(), true);
  });
});

test('consentSummary describes the current state without reading secrets', () => {
  withHome(() => {
    assert.deepEqual(consentSummary(), {
      enabled: false, correlated: false, decided: false, noticeShown: false, pending: 0,
    });
    setConsent('correlate');
    queueEvent('a', { eventId: 'a', code: 'hook_crash' });
    assert.deepEqual(consentSummary(), {
      enabled: true, correlated: true, decided: true, noticeShown: false, pending: 1,
    });
  });
});

// ─── a notice stamp must never resurrect a grant ────────────────────────────
//
// Two hooks land within milliseconds of each other at a turn boundary. One reads the record
// (consent granted) on its way to stamping the one-time notice, the user types
// `beezi telemetry off` and that writes a denial, and then the first one writes back the record it
// READ plus `noticeShownAt` — reinstating a grant the user has just withdrawn. Read and write now
// happen inside a mutex of their own, and the notice writer reconciles afterwards if it could not
// take it.

test('the consent writers take a mutex of their own, not the delivery lock', () => {
  // A held DELIVERY lock (a worker mid-batch) must not stop a decision being recorded — deferring
  // the queue purge is safe, deferring the denial is not.
  withHome(() => {
    setConsent('on');
    fs.mkdirSync(telemetryLockDir(), { recursive: true });
    fs.writeFileSync(path.join(telemetryLockDir(), 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'a-worker', at: Date.now(),
    }));
    const result = setConsent('off');
    assert.equal(result.changed, true);
    assert.equal(isTelemetryGranted(), false, 'the denial landed while the worker held its lock');
    assert.equal(result.purged, false);
  });
});

test('a notice stamp interleaved with an opt-out cannot bring consent back', () => {
  withHome(() => {
    setConsent('on');
    assert.equal(isTelemetryGranted(), true);

    // The interleaving, made deterministic: the opt-out lands in the middle of the notice stamp's
    // own write. When the stamp was a FIELD on the consent record this resurrected the grant — the
    // stamp merged onto a record it had read before the denial and wrote the stale value back.
    // It cannot now, because the stamp does not read the consent record at all.
    let interleaved = false;
    markNoticeShown(new Date(), {
      write(file, value) {
        if (!interleaved) {
          interleaved = true;
          setConsent('off');          // the user answers, right here
        }
        writeJsonSecure(file, value);
      },
    });

    assert.equal(interleaved, true, 'the interleaving never happened, so this proved nothing');
    assert.equal(isTelemetryGranted(), false, 'a notice stamp is not a grant');
    assert.equal(readConsent().consent, 'denied');
    assert.equal(hasNoticeBeenShown(), true, 'and the stamp itself still landed');
  });
});

test('the notice stamp never touches the consent record', () => {
  withHome(() => {
    markNoticeShown();
    assert.equal(hasNoticeBeenShown(), true);
    assert.equal(readConsent(), null, 'no consent record is created by showing a notice');
    assert.equal(isTelemetryGranted(), false);
    assert.equal(hasBeenAsked(), false);
    assert.equal(fs.existsSync(noticeFile()), true);
    assert.equal(fs.existsSync(telemetryConsentFile()), false);
  });
});

test('setConsent is the only writer of the consent record', () => {
  withHome(() => {
    setConsent('correlate');
    const before = fs.readFileSync(telemetryConsentFile(), 'utf-8');
    markNoticeShown();
    assert.equal(fs.readFileSync(telemetryConsentFile(), 'utf-8'), before, 'byte for byte');
  });
});

test('a failed notice write reports it rather than claiming the notice was stamped', () => {
  withHome(() => {
    const result = markNoticeShown(new Date(), { write() { throw new Error('EACCES'); } });
    assert.equal(result.ok, false);
    assert.equal(hasNoticeBeenShown(), false, 'so the next reliable surface shows it again');
  });
});

test('the consent lock is released, so the next write is never blocked by the last', () => {
  withHome(() => {
    setConsent('on');
    assert.equal(fs.existsSync(consentLockDir()), false);
    markNoticeShown();
    assert.equal(fs.existsSync(consentLockDir()), false);
    assert.equal(setConsent('correlate').ok, true);
  });
});

test('a stale consent lock is broken rather than blocking a decision forever', () => {
  withHome(() => {
    fs.mkdirSync(consentLockDir(), { recursive: true });
    fs.writeFileSync(path.join(consentLockDir(), 'owner.json'), JSON.stringify({
      pid: process.pid, instance: 'crashed', at: Date.now() - (CONSENT_LOCK_STALE_MS + 1000),
    }));
    assert.equal(setConsent('off').ok, true);
    assert.equal(readConsent().consent, 'denied');
  });
});
