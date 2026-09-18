import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAllConversations, firstRecordedCwd, liveCursorOf, lastActivityTs, sidecarSnapshot } from '../lib/sidecar-index.mjs';
import { appendEvent, withCwd, eventsFileFor } from '../lib/sidecar.mjs';
import { eventsDir, stateDir } from '../lib/paths-cursor.mjs';
import { writeJsonSecure } from '../lib/fs-store.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sidecar-index-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ─── listAllConversations ───────────────────────────────────────────────────

test('lists recorded conversations oldest-first with id, path, mtime and size', (t) => {
  tmpHome(t);
  appendEvent('conv-new', { ev: 'gen', model: 'm' });
  appendEvent('conv-old', { ev: 'gen', model: 'm' });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(eventsFileFor('conv-old'), old, old);

  const all = listAllConversations();

  assert.deepEqual(all.map((e) => e.sessionId), ['conv-old', 'conv-new']);
  assert.equal(all[0].eventsPath, eventsFileFor('conv-old'));
  assert.ok(all[0].size > 0);
  assert.ok(all[0].mtimeMs < all[1].mtimeMs);
});

test('an absent events directory yields an empty list, never a throw', (t) => {
  tmpHome(t);
  assert.deepEqual(listAllConversations(), []);
});

// The stem is only trusted when eventsFileFor(stem) resolves back to the very file it was read
// from — hand-planted junk must not be reported under an identity the writer never produced.
//
// The round-trip is the WHOLE check. A `^[A-Za-z0-9._-]+$` regex used to run in front of it and
// was strictly weaker: it passes `.hidden` (dot is in the class), which only the round-trip
// catches, and says nothing about length or emptiness. Every case below is a round-trip case now,
// including the out-of-alphabet stem the regex used to be there for.
test('non-sidecar files and unsafe stems are skipped', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });
  fs.writeFileSync(path.join(eventsDir(), 'notes.txt'), 'x', 'utf-8');
  fs.writeFileSync(path.join(eventsDir(), '.hidden.jsonl'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(eventsDir(), 'has space.jsonl'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(eventsDir(), `${'x'.repeat(201)}.jsonl`), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(eventsDir(), '.jsonl'), '{}\n', 'utf-8'); // an empty stem
  fs.mkdirSync(path.join(eventsDir(), 'dir.jsonl'));

  assert.deepEqual(listAllConversations().map((e) => e.sessionId), ['conv-1']);
});

// ─── firstRecordedCwd ───────────────────────────────────────────────────────

// Generation 1: the cwd field the hook scripts stamp (via withCwd). First one wins.
test('finds the stamped cwd field the hook scripts write', (t) => {
  tmpHome(t);
  appendEvent('conv-1', withCwd({ ev: 'gen', model: 'm' }, 'C:\\work\\app'));
  appendEvent('conv-1', withCwd({ ev: 'tool', tool: 'read_file', bytes: 1, ms: 1 }, 'C:\\work\\other'));

  assert.equal(firstRecordedCwd('conv-1'), 'C:\\work\\app');
});

// Generation 2: history written before the stamp existed — an absolute edit path's directory is
// inside the workspace, and repo resolution walks up from there.
test('falls back to the first absolute edit path for pre-stamp history', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });
  appendEvent('conv-1', { ev: 'edit', path: 'relative/file.ts', added: 1, removed: 0 });
  const abs = path.join(os.tmpdir(), 'proj', 'src', 'a.ts');
  appendEvent('conv-1', { ev: 'edit', path: abs, added: 2, removed: 1 });

  assert.equal(firstRecordedCwd('conv-1'), path.dirname(abs));
});

test('a conversation with neither stamp nor absolute edit reports null', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });
  appendEvent('conv-1', { ev: 'shell', cmd: 'ls' });

  assert.equal(firstRecordedCwd('conv-1'), null);
  assert.equal(firstRecordedCwd('conv-missing'), null);
});

// ─── lastActivityTs ─────────────────────────────────────────────────────────

// Cursor re-fires session_end for every still-open tab when the app quits or restarts, so a
// conversation forgotten in a background tab is restamped (file mtime AND tail ts) on every
// launch. Real activity is the last event that is NOT that lifecycle marker.
const writeLines = (id, lines) => {
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.writeFileSync(eventsFileFor(id), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
};

test('activity is the last non-session_end timestamp, not the restart noise after it', (t) => {
  tmpHome(t);
  writeLines('conv-1', [
    { ts: 100, ev: 'gen', model: 'm' },
    { ts: 200, ev: 'stop' },
    { ts: 5_000, ev: 'session_end' },
    { ts: 9_000, ev: 'session_end' },
  ]);

  assert.equal(lastActivityTs('conv-1'), 200);
});

test('a sidecar holding only lifecycle noise has no activity at all', (t) => {
  tmpHome(t);
  writeLines('conv-1', [
    { ts: 100, ev: 'session_end' },
    { ts: 200, ev: 'session_end' },
  ]);

  assert.equal(lastActivityTs('conv-1'), null);
  assert.equal(lastActivityTs('conv-missing'), null);
});

test('a ts-less line does not mask the timestamped activity before it', (t) => {
  tmpHome(t);
  writeLines('conv-1', [
    { ts: 100, ev: 'gen', model: 'm' },
    { ev: 'stop' },
    { ts: 900, ev: 'session_end' },
  ]);

  assert.equal(lastActivityTs('conv-1'), 100);
});

// ─── liveCursorOf ───────────────────────────────────────────────────────────

// A nonzero cursor stamped with the CURRENT account is proof the session queued live segments
// for this very tenant — the backfill skips it, or `id:0-M` beside the live `id:0-N`
// double-bills (different segmentIds, no server collapse).
test('reads the live cursor from the session state file', (t) => {
  tmpHome(t);
  writeJsonSecure(path.join(stateDir(), 'conv-1.json'), { cursor: 7, account: 'https://a|me@x.io' });

  assert.equal(liveCursorOf('conv-1', { account: 'https://a|me@x.io' }), 7);
  assert.equal(liveCursorOf('conv-untracked', { account: 'https://a|me@x.io' }), 0);
});

// Segments behind a cursor went to the account stamped beside it. The belt fires ONLY when the
// stamp names the current account: the pull is per (tenant, user, tool), so a foreign, missing
// or unknowable stamp must not rob the current tenant of history it never received. Same-tenant
// re-logins are protected at the source instead (performLogin preserves linkedAt).
test('the belt fires only when the stamped account names the current one', (t) => {
  tmpHome(t);
  writeJsonSecure(path.join(stateDir(), 'conv-1.json'), { cursor: 7, account: 'https://a|me@x.io' });
  writeJsonSecure(path.join(stateDir(), 'conv-2.json'), { cursor: 3 }); // pre-stamp build

  assert.equal(liveCursorOf('conv-1', { account: 'https://a|me@x.io' }), 7);
  assert.equal(liveCursorOf('conv-1', { account: 'https://b|other@y.io' }), 0);
  assert.equal(liveCursorOf('conv-2', { account: 'https://a|me@x.io' }), 0, 'unstamped state loads');
  assert.equal(liveCursorOf('conv-1', {}), 0, 'unknown current account loads');
  assert.equal(liveCursorOf('conv-1'), 0);
});

test('a corrupt or cursorless state file reads as 0, never a throw', (t) => {
  tmpHome(t);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 'conv-1.json'), 'torn wri', 'utf-8');
  writeJsonSecure(path.join(stateDir(), 'conv-2.json'), { sentSessionName: 'x' });

  assert.equal(liveCursorOf('conv-1'), 0);
  assert.equal(liveCursorOf('conv-2'), 0);
  assert.equal(liveCursorOf(null), 0);
});

// ─── sidecarSnapshot (08-B) ─────────────────────────────────────────────────
//
// What a sync run records alongside a resume cursor. Size and mtime cannot establish that a cursor
// still names the same lines: a sidecar that was truncated and re-appended has a NEWER mtime and
// can have exactly the same size while its line space is completely different — and resuming from
// a stale cursor on that file uploads a window that overlaps what the server already holds.

test('a snapshot reports the event count and a fingerprint of the named prefix', (t) => {
  tmpHome(t);
  for (let i = 0; i < 5; i += 1) appendEvent('conv-1', { ev: 'gen', model: 'm', i });

  const snap = sidecarSnapshot('conv-1', 3);

  assert.equal(snap.lines, 5);
  assert.equal(typeof snap.fingerprint, 'string');
  assert.match(snap.fingerprint, /^v1:/);
});

test('the fingerprint is stable while the file only grows', (t) => {
  tmpHome(t);
  for (let i = 0; i < 3; i += 1) appendEvent('conv-1', { ev: 'gen', model: 'm', i });
  const before = sidecarSnapshot('conv-1', 3).fingerprint;

  appendEvent('conv-1', { ev: 'gen', model: 'm', i: 99 });

  const after = sidecarSnapshot('conv-1', 3);
  assert.equal(after.fingerprint, before);
  assert.equal(after.lines, 4);
});

test('a truncated-and-rewritten sidecar of the same length does NOT keep its fingerprint', (t) => {
  tmpHome(t);
  for (let i = 0; i < 3; i += 1) appendEvent('conv-1', { ev: 'gen', model: 'm', i });
  const before = sidecarSnapshot('conv-1', 3).fingerprint;

  // Same number of lines, same byte length, entirely different history.
  const lines = fs.readFileSync(eventsFileFor('conv-1'), 'utf-8').split('\n').filter(Boolean);
  fs.writeFileSync(eventsFileFor('conv-1'), lines.map((l) => l.replace(/"m"/, '"n"')).join('\n') + '\n');

  assert.notEqual(sidecarSnapshot('conv-1', 3).fingerprint, before);
});

test('a prefix that changed BEYOND the first bytes is still caught', (t) => {
  tmpHome(t);
  // A head-only hash would miss this: only the last line of the prefix differs.
  for (let i = 0; i < 40; i += 1) appendEvent('conv-1', { ev: 'gen', model: 'm', i });
  const before = sidecarSnapshot('conv-1', 40).fingerprint;
  const lines = fs.readFileSync(eventsFileFor('conv-1'), 'utf-8').split('\n').filter(Boolean);
  lines[39] = lines[39].replace('"i":39', '"i":41');
  fs.writeFileSync(eventsFileFor('conv-1'), lines.join('\n') + '\n');

  assert.notEqual(sidecarSnapshot('conv-1', 40).fingerprint, before);
});

test('a prefix longer than the file has no fingerprint at all', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });

  const snap = sidecarSnapshot('conv-1', 9);

  assert.equal(snap.lines, 1);
  assert.equal(snap.fingerprint, null);
});

test('a zero prefix has a fingerprint of its own — every session starts somewhere', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });

  assert.equal(typeof sidecarSnapshot('conv-1', 0).fingerprint, 'string');
});

test('an absent sidecar is null, not an empty snapshot', (t) => {
  tmpHome(t);

  assert.equal(sidecarSnapshot('nope', 0), null);
});
