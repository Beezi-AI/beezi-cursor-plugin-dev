import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readJson, setWriteFailureReporter, writeFileAtomic, writeJsonSecure } from '../lib/fs-store.mjs';

// lib/fs-store.mjs is three short functions and every durable thing this plugin owns goes through
// them: credentials.json, the per-conversation cursors, the queue segments, ~/.cursor/hooks.json
// and a user's own .cursor/settings.json. Until now it had no direct suite — it was covered
// incidentally by whichever caller happened to exercise a branch.
//
// The contract, in the order the plan lists it: a missing or malformed document falls back rather
// than throwing; a reader during a replacement sees the old file or the new one and never half of
// either; permissions are 0600 where the platform means it; a failed write leaves the original
// intact and propagates; no temp file survives.

const STORE = fileURLToPath(new URL('../lib/fs-store.mjs', import.meta.url));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fs-store-'));
  t.after(() => {
    // A test that removed write permission to provoke a failure has to give it back, or the
    // cleanup fails and the temp directory outlives the run.
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// The sibling temp file writeFileAtomic uses. Its name is deterministic by construction — same
// directory, basename, pid — which is what makes a failure injectable without a seam in the module.
function tempSiblingOf(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
}

// ── reading ───────────────────────────────────────────────────────────────────────────────────

test('readJson round-trips what writeJsonSecure wrote', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'nested', 'deeper', 'state.json');
  writeJsonSecure(file, { cursor: 42, segmentId: 's:1-2' });
  assert.deepEqual(readJson(file), { cursor: 42, segmentId: 's:1-2' });
});

test('a missing file is the fallback, not an exception', (t) => {
  const dir = tmpDir(t);
  assert.equal(readJson(path.join(dir, 'absent.json')), null, 'the documented default is null');
  assert.equal(readJson(path.join(dir, 'absent.json'), 'fallback'), 'fallback');
  assert.deepEqual(readJson(path.join(dir, 'deep', 'absent.json'), { a: 1 }), { a: 1 });
});

test('a malformed file is the fallback too, whatever shape the damage takes', (t) => {
  const dir = tmpDir(t);
  const cases = {
    'truncated.json': '{"cursor":4',
    'trailing.json': '{"cursor":4}65070,"model":"x"}',
    'empty.json': '',
    'text.json': 'not json at all',
    'bom.json': '﻿{"cursor":4}',
    'binary.json': Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('binary'),
  };
  for (const [name, body] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    assert.equal(readJson(file, 'fallback'), 'fallback', `${name} was not treated as unreadable`);
  }
});

test('a directory where a file should be reads as the fallback', (t) => {
  // Not hypothetical: a half-finished manual cleanup, or a `mkdir -p` over the wrong path, leaves
  // exactly this. readFileSync raises EISDIR, which is a read failure like any other.
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  fs.mkdirSync(file);
  assert.equal(readJson(file, 'fallback'), 'fallback');
});

// ── replacement ───────────────────────────────────────────────────────────────────────────────

test('a replacement is never visible half-done', async (t) => {
  // The property the whole module exists for. writeFileSync opens with O_TRUNC and writes in two
  // steps, so a reader landing between them sees a truncated file — and every reader here treats a
  // parse failure as "absent", which for state/<id>.json means the cursor resets to 0 and the
  // entire sidecar is re-reported under a segmentId the server has never seen.
  //
  // Two payloads of very different lengths, because the damage that matters is a short write
  // landing over a long one and leaving its tail behind.
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  const long = { segmentId: 's:1-2', stats: { filler: 'x'.repeat(4000) }, model: 'claude-opus-5' };
  const short = { segmentId: 's:1-2' };
  const longText = JSON.stringify(long);
  const shortText = JSON.stringify(short);

  const worker = path.join(dir, 'worker.mjs');
  // The module is addressed by file URL: on Windows a bare absolute path is not a valid ESM
  // specifier ("C:" reads as an unsupported URL scheme), and the child would die before writing a
  // single byte — leaving this test passing for the wrong reason, or hanging forever.
  fs.writeFileSync(worker, `
    import { writeJsonSecure } from ${JSON.stringify(pathToFileURL(STORE).href)};
    const [file, longText, shortText] = process.argv.slice(2);
    const payloads = [JSON.parse(longText), JSON.parse(shortText)];
    let i = 0;
    let wrote = 0;
    const codes = {};
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        writeJsonSecure(file, payloads[i++ % 2]);
        wrote++;
      } catch (error) {
        // Counted, not swallowed for the caller's benefit: see the Windows note below.
        const code = error.code === undefined ? error.name : error.code;
        codes[code] = (codes[code] === undefined ? 0 : codes[code]) + 1;
      }
    }
    process.send({ wrote, codes });
  `);

  writeJsonSecure(file, long);
  const child = fork(worker, [file, longText, shortText], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  // Settled by EITHER the message or the exit. A child that died on import would otherwise leave
  // this await pending until the runner's own timeout, reporting a hang instead of the reason.
  const finished = new Promise((resolve) => {
    child.once('message', (msg) => resolve(msg));
    child.once('exit', (code) => resolve(`exit ${code}`));
  });
  t.after(() => child.kill());

  let reads = 0;
  const damaged = [];
  const readFailures = [];
  const stop = Date.now() + 3000;
  while (Date.now() < stop) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      // A read that could not OPEN the file is a different outcome from a read that saw a splice:
      // nothing was read at all, so it says nothing about whether a replacement was visible
      // half-done. Collected here and checked on its own terms below, per platform.
      readFailures.push(error.code === undefined ? error.name : error.code);
      continue;
    }
    reads++;
    if (raw !== longText && raw !== shortText) {
      damaged.push(`neither payload, ${raw.length} bytes ending ${JSON.stringify(raw.slice(-40))}`);
    }
  }
  const outcome = await finished;
  assert.equal(typeof outcome, 'object', `the writer died (${outcome}): ${childStderr.slice(0, 400)}`);

  // THE contract, and it holds on both platforms: a concurrent reader sees one complete payload or
  // the other, never a splice of the two and never a missing file.
  assert.ok(reads > 50, `only ${reads} reads raced the writer — the test did not exercise anything`);
  assert.deepEqual(damaged.slice(0, 3), [], `${damaged.length}/${reads} reads saw a partial file`);
  // The symmetric half of the Windows note at the bottom of this test. MoveFileEx and a reader in a
  // tight loop race for the handle, and EITHER can lose: the writer is told it cannot replace an open
  // path, the reader is told the path is busy. The writer's half has always been asserted this way;
  // the reader's half used to be reported as "a partial file", which is the one thing it cannot be.
  // ENOENT is deliberately NOT in the allowed set — rename() replaces and never unlinks first, so a
  // missing file is still a contract violation — and on POSIX the set is EMPTY, so nothing there is
  // tolerated that was not tolerated before.
  const allowedReadFailures = process.platform === 'win32' ? ['EPERM', 'EBUSY', 'EACCES'] : [];
  assert.deepEqual(
    readFailures.filter((code) => !allowedReadFailures.includes(code)).slice(0, 3),
    [],
    `${readFailures.length} reads could not open the file: ${JSON.stringify(readFailures.slice(0, 5))}`,
  );
  assert.ok(outcome.wrote > 0, 'the writer never landed a single write — nothing was raced');
  // Whichever payload won last, it is a whole one.
  assert.ok([longText, shortText].includes(fs.readFileSync(file, 'utf-8')));

  if (process.platform === 'win32') {
    // Practical Windows behaviour, asserted rather than wished away. NTFS rename IS atomic, but it
    // is not unconditional: MoveFileEx over a path another process has open fails EPERM/EBUSY, and
    // a reader in a tight loop makes that happen — on a loaded machine it wins most of the races,
    // which is why the count above is only required to be non-zero here.
    //
    // So the guarantee callers get is "the reader never sees a partial file", NOT "the write always
    // lands". A caller that treats a throw from writeJsonSecure as impossible is wrong on Windows.
    for (const code of Object.keys(outcome.codes)) {
      assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(code),
        `unexpected write failure ${code} x${outcome.codes[code]} — only a sharing violation is expected here`);
    }
  } else {
    // POSIX rename() replaces unconditionally, so every attempt must have landed.
    assert.deepEqual(outcome.codes, {}, 'a write failed on a platform where rename cannot be blocked');
    assert.ok(outcome.wrote > 50, `the writer only completed ${outcome.wrote} writes`);
  }
});

test('an overwrite leaves no temp file behind, in either direction of size', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonSecure(file, { filler: 'x'.repeat(2000) });
  writeJsonSecure(file, { a: 1 });
  writeJsonSecure(file, { filler: 'y'.repeat(2000) });
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'a temp file survived a successful write');
});

test('writeFileAtomic creates the parent directories it needs', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'a', 'b', 'c', 'deep.txt');
  writeFileAtomic(file, 'contents');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'contents');
});

// ── permissions ───────────────────────────────────────────────────────────────────────────────

test('a secure write is 0600 on POSIX, and an overwrite cannot widen it', (t) => {
  // These files hold refresh tokens and prompt text. On POSIX the mode IS the protection; the
  // second write matters because writeFileSync only applies `mode` when it CREATES the file, so an
  // overwrite of a world-readable leftover would otherwise keep the old permissions.
  const dir = tmpDir(t);
  const file = path.join(dir, 'credentials.json');
  writeJsonSecure(file, { token: 'secret' });
  if (process.platform === 'win32') {
    // Windows has no POSIX mode. The protection there is the user-profile ACL on the parent, which
    // node cannot assert portably — so what is checked is that the write SUCCEEDED and the mode
    // argument did not make it fail, which is the regression that would actually ship.
    assert.deepEqual(readJson(file), { token: 'secret' });
    return;
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the parent directory is created 0700');

  fs.chmodSync(file, 0o644);
  writeJsonSecure(file, { token: 'rotated' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'an overwrite widened the permissions');
});

test('a stale temp file from a previous crash cannot widen the new file', {
  skip: process.platform === 'win32' ? 'POSIX modes are not meaningful on win32' : false,
}, (t) => {
  // A process killed between writeFileSync and rename leaves the temp file behind. The next run
  // has the same pid eventually, reuses that name, and writeFileSync does not apply `mode` to a
  // file it did not create — hence the explicit chmod in the module.
  const dir = tmpDir(t);
  const file = path.join(dir, 'credentials.json');
  const stale = tempSiblingOf(file);
  fs.writeFileSync(stale, 'leftover');
  fs.chmodSync(stale, 0o666);
  writeJsonSecure(file, { token: 'secret' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeFileAtomic without a mode leaves the default, and honours an explicit dirMode', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'open', 'plain.txt');
  writeFileAtomic(file, 'no mode requested', { dirMode: 0o755 });
  assert.equal(fs.readFileSync(file, 'utf-8'), 'no mode requested');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
  }
});

// ── failure ───────────────────────────────────────────────────────────────────────────────────

test('a failed write preserves the original and propagates', (t) => {
  // Injected without a seam: the temp path is deterministic, so occupying it with a DIRECTORY makes
  // writeFileSync fail with EISDIR on every platform. That is the same shape as a full disk or a
  // revoked permission — the write dies before the rename, which is exactly the case where the
  // original must survive.
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonSecure(file, { cursor: 7 });
  const original = fs.readFileSync(file, 'utf-8');

  const blocker = tempSiblingOf(file);
  fs.mkdirSync(blocker);
  t.after(() => fs.rmSync(blocker, { recursive: true, force: true }));

  // Propagated, not swallowed. A silent failure here is a queue segment the caller believes it
  // enqueued, and a token the caller believes it stored.
  assert.throws(() => writeJsonSecure(file, { cursor: 99 }), (error) => error instanceof Error);
  assert.equal(fs.readFileSync(file, 'utf-8'), original, 'the previous contents were lost');
  assert.deepEqual(readJson(file), { cursor: 7 });
});

test('a failed write in an unwritable directory preserves the original and propagates', {
  skip: process.platform === 'win32' ? 'chmod-based write denial is not enforced on win32' : false,
}, (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonSecure(file, { cursor: 7 });
  fs.chmodSync(dir, 0o500); // read + execute: nothing new can be created inside
  t.after(() => { try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } });

  assert.throws(() => writeJsonSecure(file, { cursor: 99 }));
  fs.chmodSync(dir, 0o700);
  assert.deepEqual(readJson(file), { cursor: 7 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'a temp file survived a failed write');
});

test('a failed write cleans up its own temp file', (t) => {
  // The failure path removes the temp file before rethrowing. Without that, a directory whose
  // writes keep failing accumulates one `.name.<pid>.tmp` per attempt, forever, holding whatever
  // partial payload got through.
  const dir = tmpDir(t);
  const file = path.join(dir, 'state.json');
  writeJsonSecure(file, { cursor: 1 });

  // A payload that cannot be serialised fails INSIDE writeFileSync's argument evaluation... so
  // instead the failure is forced where the module actually writes: a target that is a directory
  // makes the rename fail after the temp file exists.
  const target = path.join(dir, 'occupied.json');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'child'), 'makes the directory non-empty');
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  assert.throws(() => writeJsonSecure(target, { a: 1 }));
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the temp file from the failed rename was not removed');
  // The directory that stood in the way is untouched — a failed write destroys nothing.
  assert.deepEqual(fs.readdirSync(target), ['child']);
});

test('one writer failing does not disturb another file in the same directory', (t) => {
  const dir = tmpDir(t);
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  writeJsonSecure(good, { keep: true });
  fs.mkdirSync(tempSiblingOf(bad));
  t.after(() => fs.rmSync(tempSiblingOf(bad), { recursive: true, force: true }));

  assert.throws(() => writeJsonSecure(bad, { a: 1 }));
  assert.deepEqual(readJson(good), { keep: true });
  assert.equal(fs.existsSync(bad), false, 'a failed write created the target anyway');
});


// ─── the injected write-failure reporter (integration step 2: F-1) ──────────────────────────────
//
// The seam lands three steps before its only caller (lib/session-start.mjs wires
// recordIssue('state_write_failed', …) in step 5), so these are the properties that make it safe to
// carry unwired: with no reporter, nothing changes; with a bad one, nothing changes either.

// Every case here must put the module back the way it found it, or a later test in this file runs
// against a reporter it never installed.
function withReporter(t, fn) {
  setWriteFailureReporter(fn);
  t.after(() => setWriteFailureReporter(null));
}

function failingWrite(t) {
  // A directory where the file should be: writeFileSync then fails with EISDIR/EPERM on every
  // platform, which is a real failure of the real function rather than a stubbed one.
  const dir = tmpDir(t);
  const target = path.join(dir, 'state.json');
  fs.mkdirSync(target);
  return target;
}

test('with no reporter set, a failed write is silent and rethrows the original error unchanged', (t) => {
  const target = failingWrite(t);
  let thrown = null;
  try {
    writeJsonSecure(target, { a: 1 });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, 'the failure still propagates');
  assert.ok(thrown.code, `the original errno survives (got ${thrown.code})`);
  // And no temp file is left behind — the cleanup runs before the report, not instead of it.
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((n) => n.includes('.tmp')),
    [],
  );
});

test('a reporter is handed the real error, once, and only on failure', (t) => {
  const seen = [];
  withReporter(t, (error) => seen.push(error));

  const dir = tmpDir(t);
  writeJsonSecure(path.join(dir, 'fine.json'), { ok: true });
  assert.deepEqual(seen, [], 'a successful write reports nothing');

  const target = failingWrite(t);
  assert.throws(() => writeJsonSecure(target, { a: 1 }));
  assert.equal(seen.length, 1, 'exactly one report per failed write');
  assert.ok(seen[0] instanceof Error);
  assert.ok(seen[0].code, 'the reporter receives the errno-bearing error, not a message');
});

test('a reporter that throws never masks the real failure', (t) => {
  // This is the whole reason the call is wrapped. The reporter is telemetry; the error is the
  // caller's. A diagnostic that replaced a disk-full error with its own would send the caller
  // chasing the wrong fault.
  const target = failingWrite(t);
  withReporter(t, () => { throw new Error('telemetry is broken'); });

  let thrown = null;
  try {
    writeJsonSecure(target, { a: 1 });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.notEqual(thrown.message, 'telemetry is broken', 'the reporter must not become the failure');
  assert.ok(thrown.code, 'the original errno still reaches the caller');
});

test('setWriteFailureReporter(non-function) restores the silent default rather than crashing', (t) => {
  const seen = [];
  withReporter(t, (error) => seen.push(error));
  setWriteFailureReporter(null);
  const target = failingWrite(t);
  assert.throws(() => writeJsonSecure(target, { a: 1 }));
  assert.deepEqual(seen, [], 'the previous reporter is detached, and no call is attempted');
});
