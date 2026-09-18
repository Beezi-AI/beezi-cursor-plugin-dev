import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents, readEventsDetailed, countEvents, eventsFile } from '../lib/sidecar-read.mjs';

function writeSidecar(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-sidecar-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, text);
  return { eventsFile: () => file };
}

const line = (event) => `${JSON.stringify(event)}\n`;

test('parses one event per line in file order', () => {
  const deps = writeSidecar(
    line({ ts: 1, ev: 'gen', model: 'claude-4.5-sonnet' }) +
      line({ ts: 2, ev: 'tool', tool: 'read_file', bytes: 40 }) +
      line({ ts: 3, ev: 'shell', cmd: 'git status' }),
  );
  const events = readEvents('conv-1', deps);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.ev),
    ['gen', 'tool', 'shell'],
  );
  assert.equal(events[0].model, 'claude-4.5-sonnet');
  assert.equal(countEvents('conv-1', deps), 3);
});

test('a truncated final line is dropped, not thrown, and is flagged', () => {
  const deps = writeSidecar(
    line({ ts: 1, ev: 'gen', model: 'gpt-5' }) + '{"ts":2,"ev":"tool","tool":"read_f',
  );
  const detailed = readEventsDetailed('conv-1', deps);
  assert.equal(detailed.events.length, 1);
  assert.equal(detailed.truncatedTail, true);
  assert.equal(detailed.skipped, 1);
  // The bound must not count the half-written record: the next window picks it up once whole.
  assert.equal(countEvents('conv-1', deps), 1);
});

test('a completed tail is counted on the next read, so no event is lost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-sidecar-'));
  const file = path.join(dir, 'events.jsonl');
  const deps = { eventsFile: () => file };
  fs.writeFileSync(file, line({ ts: 1, ev: 'gen', model: 'gpt-5' }) + '{"ts":2,"ev":"too');
  assert.equal(countEvents('conv-1', deps), 1);
  fs.writeFileSync(file, line({ ts: 1, ev: 'gen', model: 'gpt-5' }) + line({ ts: 2, ev: 'tool', tool: 'grep' }));
  assert.equal(countEvents('conv-1', deps), 2);
});

test('a missing file reads as no events, and says the file was absent', () => {
  const deps = { eventsFile: () => path.join(os.tmpdir(), 'beezi-cursor-does-not-exist.jsonl') };
  assert.deepEqual(readEvents('conv-1', deps), []);
  const detailed = readEventsDetailed('conv-1', deps);
  assert.equal(detailed.exists, false);
  assert.equal(detailed.events.length, 0);
});

test('an empty file is distinguishable from a missing one', () => {
  const deps = writeSidecar('');
  const detailed = readEventsDetailed('conv-1', deps);
  assert.equal(detailed.exists, true);
  assert.equal(detailed.events.length, 0);
});

test('non-object JSON lines are skipped rather than reported as events', () => {
  const deps = writeSidecar('"a string"\n42\n[1,2]\n' + line({ ts: 1, ev: 'gen', model: 'm' }));
  const detailed = readEventsDetailed('conv-1', deps);
  assert.equal(detailed.events.length, 1);
  assert.equal(detailed.skipped, 3);
});

test('blank lines do not shift the event count', () => {
  const deps = writeSidecar(line({ ts: 1, ev: 'gen', model: 'm' }) + '\n\n' + line({ ts: 2, ev: 'stop' }));
  assert.equal(countEvents('conv-1', deps), 2);
  assert.equal(readEventsDetailed('conv-1', deps).skipped, 0);
});

test('a traversal-shaped conversation id never resolves outside the events directory', () => {
  const safe = eventsFile('conv-1');
  const hostile = eventsFile('../../etc/passwd');
  assert.ok(safe, 'a normal id must resolve to a path');
  // The separators must be gone: the resolved file has to stay a direct child of the events dir.
  assert.ok(hostile === null || path.dirname(hostile) === path.dirname(safe), `escaped: ${hostile}`);
  assert.deepEqual(readEvents('../../etc/passwd'), []);
});

test('an empty conversation id reads as no events', () => {
  assert.deepEqual(readEvents(''), []);
  assert.equal(countEvents(null), 0);
});
