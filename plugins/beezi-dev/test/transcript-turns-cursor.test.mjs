import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  locateTranscript, readTurnEnds, unseenTurns, scanTurnErrors, MAX_TRANSCRIPT_BYTES,
} from '../lib/transcript-turns-cursor.mjs';

// Cursor writes why a turn ended in ONE place: the `turn_ended` line of its agent transcript. These
// tests pin how that file is found, how little of it is read, and the count that stops one line
// from being reported twice. Every file lives under a temp root, never the developer's ~/.cursor.

const ID = '0233cb34-d9f8-42b6-9700-fa5ae47c4007';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-transcripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// <projects>/<slug>/agent-transcripts/<id>/<id>.jsonl — the layout observed on IDE and CLI alike.
function writeTranscript(root, slug, id, lines, eol = '\n') {
  const dir = path.join(root, slug, 'agent-transcripts', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join(eol) + eol);
  return file;
}

const said = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } });
const ended = (status, error) => (error === undefined
  ? { type: 'turn_ended', status }
  : { type: 'turn_ended', status, error });

test('the transcript is found under whichever project slug Cursor chose', (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, '1785580206268', 'terminals'), { recursive: true });
  writeTranscript(root, 'C-Users-dev', 'another-conversation', [ended('success')]);
  const file = writeTranscript(root, 'c-Users-dev-Documents-app', ID, [ended('success')]);
  assert.equal(locateTranscript(ID, { projectsDir: root }), file);
});

test('the payload transcript_path is used only when it names this conversation', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [ended('success')]);
  assert.equal(locateTranscript(ID, { transcriptPath: file, projectsDir: path.join(root, 'missing') }), file);
  const elsewhere = path.join(root, 'x', `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, '');
  // Right basename, wrong parent: not this conversation's file, so the scan answers instead.
  assert.equal(locateTranscript(ID, { transcriptPath: elsewhere, projectsDir: root }), file);
});

test('an id that is not a plain name, or a missing projects dir, finds nothing', (t) => {
  const root = tmpRoot(t);
  writeTranscript(root, 'a', ID, [ended('success')]);
  assert.equal(locateTranscript('../../etc', { projectsDir: root }), null);
  assert.equal(locateTranscript('', { projectsDir: root }), null);
  assert.equal(locateTranscript(null, { projectsDir: root }), null);
  assert.equal(locateTranscript(ID, { projectsDir: path.join(root, 'nope') }), null);
});

test('a subagent transcript is never taken for a conversation of its own', (t) => {
  const root = tmpRoot(t);
  const dir = path.join(root, 'a', 'agent-transcripts', ID, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'child-1.jsonl'), `${JSON.stringify(ended('error', 'boom'))}\n`);
  assert.equal(locateTranscript('child-1', { projectsDir: root }), null);
});

test('only turn_ended lines are read, in order, and a message that quotes one is not one', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [
    said('please fix it'),
    ended('success'),
    // In JSONL the quotes inside this text are escaped, so the structural marker never matches it.
    said('{"type":"turn_ended","status":"error","error":"typed by the user"}'),
    ended('error', 'User aborted request'),
    ended('aborted', 'User aborted/interrupted manually.'),
  ]);
  const read = readTurnEnds(file);
  assert.deepEqual(read.turns, [
    { status: 'success', message: null },
    { status: 'error', message: 'User aborted request' },
    { status: 'aborted', message: 'User aborted/interrupted manually.' },
  ]);
  assert.equal(typeof read.mtimeMs, 'number');
});

test('a turn_ended line still being written is not counted until it is whole', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [ended('success')]);
  fs.appendFileSync(file, '{"type":"turn_ended","status":"err');
  assert.equal(readTurnEnds(file).turns.length, 1);
});

test('CRLF line endings read the same', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [said('x'), ended('error', 'User aborted request')], '\r\n');
  assert.deepEqual(readTurnEnds(file).turns, [{ status: 'error', message: 'User aborted request' }]);
});

test('an unreadable or oversized transcript reads as null, not as zero turns', (t) => {
  const root = tmpRoot(t);
  assert.equal(readTurnEnds(path.join(root, 'missing.jsonl')), null);
  const huge = {
    statSync: () => ({ isFile: () => true, size: MAX_TRANSCRIPT_BYTES + 1, mtimeMs: 0 }),
    readFileSync: () => { throw new Error('an oversized file must not be read'); },
  };
  assert.equal(readTurnEnds('x.jsonl', { fsImpl: huge }), null);
});

test('the anchor: only turns past the count already seen are new', () => {
  assert.deepEqual(unseenTurns(['a', 'b', 'c'], 1), { unseen: ['b', 'c'], seen: 3 });
  assert.deepEqual(unseenTurns(['a', 'b', 'c'], 3), { unseen: [], seen: 3 });
});

test('a transcript that shrank is adopted, and nothing is posted from it', () => {
  assert.deepEqual(unseenTurns(['a'], 4), { unseen: [], seen: 1 });
});

test('first sight of an already-tracked session reports only its latest turn', () => {
  assert.deepEqual(unseenTurns(['a', 'b', 'c'], undefined, { priorHistory: true }), { unseen: ['c'], seen: 3 });
  assert.deepEqual(unseenTurns([], undefined, { priorHistory: true }), { unseen: [], seen: 0 });
});

test('first sight of a new session reports every turn', () => {
  assert.deepEqual(unseenTurns(['a', 'b'], undefined), { unseen: ['a', 'b'], seen: 2 });
  assert.deepEqual(unseenTurns(['a', 'b'], 'not a count'), { unseen: ['a', 'b'], seen: 2 });
});

test('scanTurnErrors turns new error lines into wire payloads stamped with the transcript mtime', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [
    ended('success'),
    ended('error', '[resource_exhausted] Error'),
    ended('error', 'User aborted request'),
  ]);
  const at = Date.parse('2026-09-28T11:28:00.000Z');
  fs.utimesSync(file, at / 1000, at / 1000);
  const scan = scanTurnErrors(ID, { projectsDir: root, seen: 1, now: () => at + 60000 });
  assert.equal(scan.seen, 3);
  assert.deepEqual(scan.payloads, [
    { sessionId: ID, error: 'rate_limit', errorDetails: '[resource_exhausted] Error', lastAssistantMessage: null, occurredAt: '2026-09-28T11:28:00.000Z' },
    { sessionId: ID, error: 'user_aborted', errorDetails: 'User aborted request', lastAssistantMessage: null, occurredAt: '2026-09-28T11:28:00.000Z' },
  ]);
});

test('a transcript stamped in the future is reported at now', (t) => {
  const root = tmpRoot(t);
  const file = writeTranscript(root, 'a', ID, [ended('error', 'boom')]);
  const now = Date.parse('2026-09-28T11:00:00.000Z');
  fs.utimesSync(file, (now + 3600000) / 1000, (now + 3600000) / 1000);
  const scan = scanTurnErrors(ID, { projectsDir: root, now: () => now });
  assert.equal(scan.payloads[0].error, 'turn_error');
  assert.equal(scan.payloads[0].occurredAt, new Date(now).toISOString());
});

test('no transcript is null, so the caller leaves its anchor alone', (t) => {
  const root = tmpRoot(t);
  assert.equal(scanTurnErrors(ID, { projectsDir: root, seen: 0 }), null);
});
