import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEventsFrom } from '../lib/sidecar-read.mjs';
import { computeDelta } from '../lib/delta-cursor.mjs';

// Resuming from a byte offset is a pure optimisation: it must produce exactly what a full read
// would have produced, and it must fall back to a full read the moment the offset stops being
// trustworthy. Everything here uses real files — the whole point is the filesystem behaviour.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-resume-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeSidecar(home, id, events) {
  const file = path.join(home, 'events', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return file;
}

function appendSidecar(home, id, events) {
  const file = path.join(home, 'events', `${id}.jsonl`);
  fs.appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const ev = (i) => ({ ts: 1700000000000 + i, ev: 'tool', tool: 'Read', bytes: 10, ms: 1 });

test('a resumed read returns only what was appended since', (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'c1', [ev(1), ev(2), ev(3)]);

  const first = readEventsFrom('c1', null);
  assert.equal(first.events.length, 3);
  assert.equal(first.resumed, false);
  assert.ok(first.nextByte > 0);

  appendSidecar(home, 'c1', [ev(4), ev(5)]);

  const second = readEventsFrom('c1', { line: 3, byte: first.nextByte });
  assert.equal(second.resumed, true);
  assert.equal(second.baseLine, 3);
  assert.deepEqual(second.events.map((e) => e.ts), [ev(4).ts, ev(5).ts]);
});

test('nothing new means an empty resumed read, not a re-read', (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'c1', [ev(1), ev(2)]);
  const first = readEventsFrom('c1', null);

  const second = readEventsFrom('c1', { line: 2, byte: first.nextByte });
  assert.equal(second.resumed, true);
  assert.deepEqual(second.events, []);
  assert.equal(second.nextByte, first.nextByte);
});

test('a half-written last line is left for the next read', (t) => {
  const home = tmpHome(t);
  const file = writeSidecar(home, 'c1', [ev(1)]);
  const afterComplete = fs.statSync(file).size;
  // The writer is appending concurrently: the record has no terminating newline yet.
  fs.appendFileSync(file, '{"ts":1700000000009,"ev":"too');

  const read = readEventsFrom('c1', null);
  assert.equal(read.events.length, 1);
  assert.equal(read.truncatedTail, true);
  // The offset must stop at the last COMPLETE line, or the partial record is skipped forever.
  assert.equal(read.nextByte, afterComplete);

  fs.appendFileSync(file, 'l","tool":"Read"}\n');
  const resumed = readEventsFrom('c1', { line: 1, byte: read.nextByte });
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].tool, 'Read');
});

test('a truncated or replaced sidecar falls back to a full read', (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'c1', [ev(1), ev(2), ev(3)]);
  const stale = readEventsFrom('c1', null).nextByte;

  // Pruned and recreated: the offset now points past the end.
  writeSidecar(home, 'c1', [ev(9)]);
  const read = readEventsFrom('c1', { line: 3, byte: stale });
  assert.equal(read.resumed, false, 'an offset past EOF must not be trusted');
  assert.equal(read.baseLine, 0);
  assert.deepEqual(read.events.map((e) => e.ts), [ev(9).ts]);
});

test('an offset that does not land on a line boundary is refused', (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'c1', [ev(1), ev(2)]);
  const read = readEventsFrom('c1', { line: 1, byte: 5 });
  assert.equal(read.resumed, false);
  assert.equal(read.events.length, 2);
});

test('a resumed delta produces the same segment a full read would', (t) => {
  const home = tmpHome(t);
  writeSidecar(home, 'c1', [
    { ts: 1700000000000, ev: 'gen', model: 'composer-2.5' },
    { ts: 1700000001000, ev: 'tool', tool: 'Read', bytes: 10, ms: 5 },
    { ts: 1700000002000, ev: 'gen', model: 'composer-2.5' },
    { ts: 1700000003000, ev: 'tool', tool: 'Read', bytes: 10, ms: 5 },
  ]);

  const full = computeDelta('c1', 2, { readUsageData: () => null });
  const firstRead = readEventsFrom('c1', null);
  const resumed = computeDelta('c1', 2, {
    readUsageData: () => null,
    // The offset a previous checkpoint would have recorded for cursor 2.
    start: { line: 2, byte: byteAfterLine(home, 'c1', 2) },
  });

  assert.equal(resumed.segmentId, full.segmentId);
  assert.equal(resumed.from, full.from);
  assert.equal(resumed.to, full.to);
  assert.equal(resumed.started_at, full.started_at);
  assert.equal(resumed.ended_at, full.ended_at);
  assert.deepEqual(resumed.operations, full.operations);
  assert.equal(resumed.nextByte, firstRead.nextByte);
});

function byteAfterLine(home, id, lines) {
  const file = path.join(home, 'events', `${id}.jsonl`);
  const raw = fs.readFileSync(file, 'utf-8').split('\n');
  return Buffer.byteLength(raw.slice(0, lines).join('\n') + '\n', 'utf-8');
}
