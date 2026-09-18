import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeCodeChanges } from '../lib/code-changes-cursor.mjs';
import { eventsFromHookPayload, lineCount } from '../lib/sidecar-events.mjs';

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;

const edit = (file, added, removed) => ({ ts: 1, ev: 'edit', path: file, added, removed });

// No ai-code-tracking.db unless a test asks for one: `aiCodeTrackingDbFile: null` forces the events
// fallback so the suite never depends on a Cursor install.
const EVENTS_ONLY = { aiCodeTrackingDbFile: null };

const at = (min) => Date.parse(`2026-01-01T00:${String(min).padStart(2, '0')}:00.000Z`);

function makeTrackingDb(rows, columns = { file: 'file_path', added: 'ai_lines_added', removed: 'ai_lines_removed', time: 'timestamp' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-track-'));
  const file = path.join(dir, 'ai-code-tracking.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(
    `CREATE TABLE ai_edits ("${columns.file}" TEXT, "${columns.added}" INTEGER, "${columns.removed}" INTEGER, "${columns.time}" INTEGER, model TEXT)`,
  );
  const insert = db.prepare(
    `INSERT INTO ai_edits ("${columns.file}", "${columns.added}", "${columns.removed}", "${columns.time}", model) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of rows) insert.run(row.file, row.added, row.removed, row.time, row.model ?? 'gpt-5');
  db.close();
  return file;
}

test('sums the sidecar edit events per file and per extension', () => {
  const cc = computeCodeChanges(
    [edit('src/a.ts', 12, 3), edit('src/b.ts', 4, 1), edit('src/c.js', 2, 0)],
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 3);
  assert.equal(cc.lines_added, 18);
  assert.equal(cc.lines_removed, 4);
  assert.equal(cc.by_extension['.ts'], 2);
  assert.equal(cc.by_extension['.js'], 1);
  assert.equal(cc.diagnostics.source, 'events');
});

test('the same file edited twice counts once in files_changed', () => {
  const cc = computeCodeChanges([edit('src/a.ts', 5, 1), edit('src/a.ts', 3, 2)], EVENTS_ONLY);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 8);
  assert.equal(cc.lines_removed, 3);
  assert.equal(cc.by_extension['.ts'], 1);
});

test('an afterFileEdit edits[] array is unpacked, inheriting the event path', () => {
  const cc = computeCodeChanges(
    [{ ev: 'edit', path: 'src/a.ts', edits: [{ added: 3, removed: 1 }, { added: 2, removed: 0 }] }],
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 5);
  assert.equal(cc.lines_removed, 1);
});

test('per-edit paths inside edits[] win over the event path', () => {
  const cc = computeCodeChanges(
    [{ ev: 'edit', path: 'src/a.ts', edits: [{ file_path: 'src/z.py', added: 1, removed: 0 }] }],
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.by_extension['.py'], 1);
});

test('an edit reported only as replaced text still yields a line count', () => {
  const cc = computeCodeChanges(
    [{ ev: 'edit', path: 'src/a.ts', edits: [{ old_string: 'a\nb', new_string: 'a\nb\nc\nd' }] }],
    EVENTS_ONLY,
  );
  assert.equal(cc.lines_added, 4);
  assert.equal(cc.lines_removed, 2);
  assert.equal(cc.files_changed, 1);
});

test('a touched file with no line counts still counts as changed', () => {
  const cc = computeCodeChanges([{ ev: 'edit', path: 'src/a.ts', added: 0, removed: 0 }], EVENTS_ONLY);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 0);
});

test('a file with no extension is bucketed explicitly', () => {
  const cc = computeCodeChanges([edit('Makefile', 2, 0)], EVENTS_ONLY);
  assert.equal(cc.by_extension['(none)'], 1);
});

test('non-edit events are ignored', () => {
  const cc = computeCodeChanges(
    [{ ev: 'gen', model: 'gpt-5' }, { ev: 'tool', tool: 'read_file', bytes: 10 }],
    EVENTS_ONLY,
  );
  assert.deepEqual(cc, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
  assert.equal(cc.diagnostics.source, 'none');
});

test('an edit event whose fields all moved signals the miss instead of reporting zero lines', () => {
  const cc = computeCodeChanges([{ ev: 'edit', document: 'src/a.ts', delta: { plus: 5 } }], EVENTS_ONLY);
  assert.equal(cc.files_changed, 0);
  assert.equal(cc.diagnostics.editEvents, 1);
  assert.equal(cc.diagnostics.unmatchedEdits, 1);
  assert.equal(cc.diagnostics.matchedEdits, 0);
  assert.equal(cc.diagnostics.source, 'none');
});

test('the emitted shape carries no diagnostics on the wire', () => {
  const cc = computeCodeChanges([edit('a.ts', 1, 0)], EVENTS_ONLY);
  assert.deepEqual(Object.keys(cc).sort(), ['by_extension', 'files_changed', 'lines_added', 'lines_removed']);
  assert.equal(JSON.parse(JSON.stringify(cc)).diagnostics, undefined);
});

test('without a time window the tracking database is not consulted at all', { skip: !sqlite }, () => {
  const dbFile = makeTrackingDb([{ file: 'src/history.ts', added: 9999, removed: 9999, time: at(0) }]);
  // No `window` — an unwindowed read would attribute the machine's whole history to this segment.
  const cc = computeCodeChanges([edit('src/a.ts', 1, 0)], { aiCodeTrackingDbFile: dbFile });
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.lines_added, 1);
});

test('with a window the tracking database is preferred over the events', { skip: !sqlite }, () => {
  const dbFile = makeTrackingDb([
    { file: 'src/a.ts', added: 20, removed: 4, time: at(1) },
    { file: 'src/b.py', added: 5, removed: 0, time: at(2) },
    { file: 'src/old.ts', added: 999, removed: 999, time: at(0) - 86_400_000 },
  ]);
  const cc = computeCodeChanges([edit('src/a.ts', 1, 0)], {
    aiCodeTrackingDbFile: dbFile,
    window: { startMs: at(0), endMs: at(5) },
  });
  assert.equal(cc.diagnostics.source, 'ai_code_tracking');
  assert.equal(cc.files_changed, 2);
  assert.equal(cc.lines_added, 25);
  assert.equal(cc.lines_removed, 4);
  assert.equal(cc.diagnostics.dbRows, 2);
});

test('tracking rows stamped in seconds are matched too', { skip: !sqlite }, () => {
  const dbFile = makeTrackingDb([{ file: 'src/a.ts', added: 7, removed: 1, time: Math.floor(at(1) / 1000) }]);
  const cc = computeCodeChanges([], { aiCodeTrackingDbFile: dbFile, window: { startMs: at(0), endMs: at(5) } });
  assert.equal(cc.diagnostics.source, 'ai_code_tracking');
  assert.equal(cc.lines_added, 7);
});

test('a tracking database with no recognizable schema falls back to the events', { skip: !sqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-track-'));
  const dbFile = path.join(dir, 'ai-code-tracking.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE something_else (a TEXT, b INTEGER)');
  db.close();
  const cc = computeCodeChanges([edit('src/a.ts', 3, 1)], {
    aiCodeTrackingDbFile: dbFile,
    window: { startMs: at(0), endMs: at(5) },
  });
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.lines_added, 3);
});

test('a tracking table with no timestamp column is refused, not read unwindowed', { skip: !sqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-track-'));
  const dbFile = path.join(dir, 'ai-code-tracking.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE ai_edits (file_path TEXT, ai_lines_added INTEGER)');
  db.prepare('INSERT INTO ai_edits VALUES (?, ?)').run('src/history.ts', 9999);
  db.close();
  const cc = computeCodeChanges([edit('src/a.ts', 2, 0)], {
    aiCodeTrackingDbFile: dbFile,
    window: { startMs: at(0), endMs: at(5) },
  });
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.lines_added, 2);
});

test('without node:sqlite the tracking database is skipped entirely', () => {
  const cc = computeCodeChanges([edit('src/a.ts', 6, 2)], {
    sqlite: null,
    aiCodeTrackingDbFile: '/anything/ai-code-tracking.db',
    window: { startMs: at(0), endMs: at(5) },
  });
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.lines_added, 6);
});

test('a non-array events argument is tolerated', () => {
  const cc = computeCodeChanges(null, EVENTS_ONLY);
  assert.deepEqual(cc, { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} });
});

// ---------------------------------------------------------------------------
// afterFileEdit, end to end
// ---------------------------------------------------------------------------
//
// scripts/file-edit.mjs is the only thing that ever writes an `edit` line, and until it stopped
// being a capture-only stub this whole fallback was dead code for every CLI user: ai-code-tracking.db
// is written by the IDE and is usually absent under `cursor-agent`, so `code_changes` reported zero
// files while the agent rewrote the repository.
//
// These go through the WRITE side and back out the READ side rather than hand-rolling event objects,
// because the two halves have to agree about what an unobserved count looks like and a hand-rolled
// fixture can only ever assert one side's opinion of that.
//
// Cursor's afterFileEdit payload is `{file_path, edits:[{old_string, new_string}]}` — no line
// numbers, no ranges, no counts. Those exist only on the Tab-only afterTabFileEdit.

// What scripts/file-edit.mjs writes for one payload: `allowEdits: true`, `edit` lines only, each
// stamped with a timestamp by lib/sidecar.mjs on the way to disk.
const fromEditHook = (payload) =>
  eventsFromHookPayload(payload, { allowEdits: true })
    .filter((event) => event.ev === 'edit')
    .map((event) => ({ ts: 1, ...event }));

test('an afterFileEdit payload with one edit reaches code_changes', () => {
  const cc = computeCodeChanges(
    fromEditHook({ file_path: 'src/a.ts', edits: [{ old_string: 'a\nb\n', new_string: 'a\nB\nc\n' }] }),
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 3);
  assert.equal(cc.lines_removed, 2);
  assert.equal(cc.by_extension['.ts'], 1);
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.diagnostics.uncountedEdits, 0);
});

test('every element of a multi-edit afterFileEdit payload is counted, on the one file', () => {
  const cc = computeCodeChanges(
    fromEditHook({
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'a\n', new_string: 'a\nb\n' },
        { old_string: 'x\ny\n', new_string: 'x\nY\nz\n' },
        { old_string: '', new_string: 'tail\n' },
      ],
    }),
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1, 'one file, however many replacements it took');
  assert.equal(cc.lines_added, 2 + 3 + 1);
  assert.equal(cc.lines_removed, 1 + 2 + 0);
  assert.equal(cc.diagnostics.editEvents, 3, 'one sidecar line per edits[] element');
});

test('an edit whose new_string is empty is a pure deletion, not an unmeasured edit', () => {
  const cc = computeCodeChanges(
    fromEditHook({ file_path: 'src/a.ts', edits: [{ old_string: 'x\ny\nz\n', new_string: '' }] }),
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 0, 'an empty new_string is a real observation of "nothing added"');
  assert.equal(cc.lines_removed, 3);
  assert.equal(cc.diagnostics.uncountedEdits, 0);
});

test('an afterFileEdit payload with no edits[] still records the file it names', () => {
  // The touch is what keeps files_changed right when only ai-code-tracking.db has the line counts.
  const cc = computeCodeChanges(fromEditHook({ file_path: 'src/a.ts' }), EVENTS_ONLY);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 0);
  assert.equal(cc.diagnostics.matchedEdits, 1);
  assert.equal(cc.diagnostics.uncountedEdits, 1, 'named but not measured, and it says so');
});

test('allowEdits defaults to false, so a postToolUse Write writes no edit line', () => {
  // postToolUse fires for a `Write` tool and its payload can carry a top-level `file_path`;
  // afterFileEdit carries the real edits[] for the SAME write. The two lines differ in content, so
  // dedupeEvents cannot collapse them — without the default-false gate every agent write is counted
  // as two files' worth of churn the moment afterFileEdit is registered, which it now is.
  const write = { tool_name: 'write', tool_use_id: 'toolu_01', file_path: 'src/a.ts' };
  const fromToolHook = eventsFromHookPayload(write).map((event) => ({ ts: 1, ...event }));
  assert.deepEqual(fromToolHook.map((e) => e.ev), ['tool'], 'no edit line from the normal caller');

  const fromEdit = fromEditHook({
    tool_use_id: 'toolu_01',
    file_path: 'src/a.ts',
    edits: [{ old_string: '', new_string: 'a\nb\n' }],
  });
  const cc = computeCodeChanges([...fromToolHook, ...fromEdit], EVENTS_ONLY);
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 2, 'one write, counted once');
  assert.equal(cc.diagnostics.editEvents, 1);
});

// ---------------------------------------------------------------------------
// The trailing-newline off-by-one
// ---------------------------------------------------------------------------

test('a trailing newline terminates the last line, it does not start an empty one', () => {
  // lineCountsFromText used to be `text.split('\n').length` with no trailing-newline tolerance.
  // Almost every source file ends in a newline, so this over-counted BOTH sides of EVERY edit whose
  // counts came from the text: a three-line replacement of a two-line block read as four and three.
  const oldWrong = (text) => text.split('\n').length;
  assert.equal(oldWrong('a\nb\nc\n'), 4, 'the shape of the old bug, pinned as wrong');
  assert.equal(lineCount('a\nb\nc\n'), 3);
  // A SECOND trailing newline is a real empty line and IS counted — the sibling plugin's
  // `.replace(/\n$/, '').split('\n').length` semantics, reproduced (…/lib/code-changes.mjs:4-7).
  assert.equal(lineCount('a\nb\nc\n\n'), 4);

  const cc = computeCodeChanges(
    [{ ts: 1, ev: 'edit', path: 'src/a.ts', edits: [{ old_string: 'a\nb\n', new_string: 'a\nb\nc\n' }] }],
    EVENTS_ONLY,
  );
  assert.equal(cc.lines_added, 3, 'was 4 before lineCount');
  assert.equal(cc.lines_removed, 2, 'was 3 before lineCount');
});

test('a multi-megabyte replacement is counted on the read path without allocating an array', (t) => {
  // `new_string` is whatever the model wrote — a whole-file rewrite of a lockfile or a generated
  // bundle is routinely megabytes. `.split('\n')` on that allocates one string object per line,
  // hundreds of thousands of them, and this is the READ path: it runs inside the `stop` hook, which
  // Cursor kills at a 10s deadline.
  //
  // Asserted by BANNING the allocation rather than by timing it: a busy CI box is not a benchmark,
  // and "it was fast enough today" is not the property under test.
  const big = 'const x = 1;\n'.repeat(200_000); // ~2.6 MB, 200k lines
  const realSplit = String.prototype.split;
  String.prototype.split = function banned() {
    throw new Error('line counting must not allocate — see lineCount in lib/sidecar-events.mjs');
  };
  let cc;
  try {
    cc = computeCodeChanges(
      [{ ts: 1, ev: 'edit', path: 'dist/bundle.js', edits: [{ old_string: '', new_string: big }] }],
      EVENTS_ONLY,
    );
  } finally {
    String.prototype.split = realSplit;
  }
  t.diagnostic(`counted ${big.length} chars`);
  assert.equal(cc.lines_added, 200_000);
  assert.equal(cc.lines_removed, 0);
});

// ---------------------------------------------------------------------------
// absent vs null vs observed zero
// ---------------------------------------------------------------------------

test('an observed zero is a measurement and is never overwritten by a derived count', () => {
  // The host genuinely said this edit changed no lines. The replaced text is present precisely to
  // prove the fallback stays away from it — deriving here would replace a fact with a guess.
  const cc = computeCodeChanges(
    [{ ts: 1, ev: 'edit', path: 'src/a.ts', added: 0, removed: 0, old_string: 'a\nb\nc\n', new_string: 'q\n' }],
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 0);
  assert.equal(cc.lines_removed, 0);
  assert.equal(cc.diagnostics.uncountedEdits, 0, 'zero was observed, not missing');
});

test('one observed count suppresses derivation of the other — wholesale, not per field', () => {
  // Mixing an observation with a derivation reports two numbers from two different accountings of
  // one edit. lib/sidecar-events.mjs makes the same all-or-nothing choice at write time.
  const cc = computeCodeChanges(
    [{ ts: 1, ev: 'edit', path: 'a.ts', added: 9, old_string: 'a\nb\nc\n', new_string: 'q\n' }],
    EVENTS_ONLY,
  );
  assert.equal(cc.lines_added, 9);
  assert.equal(cc.lines_removed, 0, 'not 3 — the text was not consulted at all');
});

test('an explicit null reads as absent, so the text fallback still runs', () => {
  // A writer that says "I looked and found nothing" is saying what a writer that never wrote the
  // field is saying. Only a NUMBER counts as an observation.
  const cc = computeCodeChanges(
    [{ ts: 1, ev: 'edit', path: 'a.ts', added: null, removed: null, old_string: 'a\n', new_string: 'a\nb\n' }],
    EVENTS_ONLY,
  );
  assert.equal(cc.lines_added, 2);
  assert.equal(cc.lines_removed, 1);
  assert.equal(cc.diagnostics.uncountedEdits, 0);
});

test('an edits[] element in a shape we do not know degrades to no counts, never to a wrong number', () => {
  // The unverified assumption, made visible. If Cursor's edits[] elements carry their replaced text
  // under keys this module does not read, the file must still land in files_changed with the line
  // totals left as a lower bound — and `uncountedEdits` is what says that happened, so a segment of
  // unreadable edits is distinguishable from a segment of genuinely empty ones.
  const cc = computeCodeChanges(
    [{ ts: 1, ev: 'edit', path: 'src/a.ts', edits: [{ before: 'a\nb\n', after: 'a\nb\nc\n' }] }],
    EVENTS_ONLY,
  );
  assert.equal(cc.files_changed, 1);
  assert.equal(cc.lines_added, 0);
  assert.equal(cc.lines_removed, 0);
  assert.equal(cc.diagnostics.matchedEdits, 1);
  assert.equal(cc.diagnostics.uncountedEdits, 1);
});

test('the tracking database still wins over a fed sidecar', { skip: !sqlite }, () => {
  // Registering afterFileEdit made the fallback real; it must not have made it preferred. The
  // database counts what Cursor itself attributes to the model, where an edit event counts what one
  // hook happened to observe.
  const dbFile = makeTrackingDb([{ file: 'src/db.ts', added: 20, removed: 4, time: at(1) }]);
  const cc = computeCodeChanges(
    fromEditHook({ file_path: 'src/hook.ts', edits: [{ old_string: '', new_string: 'a\nb\nc\n' }] }),
    { aiCodeTrackingDbFile: dbFile, window: { startMs: at(0), endMs: at(5) } },
  );
  assert.equal(cc.diagnostics.source, 'ai_code_tracking');
  assert.equal(cc.lines_added, 20);
  assert.equal(cc.by_extension['.ts'], 1);
  assert.equal(cc.files_changed, 1, 'the sidecar file is not merged in on top');
});

test('an unreadable tracking database falls back to the fed sidecar', () => {
  // Absent or unreadable is the CLI case: ai-code-tracking.db is written by the IDE, and
  // `cursor-agent` usually has none.
  const cc = computeCodeChanges(
    fromEditHook({ file_path: 'src/hook.ts', edits: [{ old_string: '', new_string: 'a\nb\nc\n' }] }),
    {
      aiCodeTrackingDbFile: path.join(os.tmpdir(), 'beezi-cursor-no-such-ai-code-tracking.db'),
      window: { startMs: at(0), endMs: at(5) },
    },
  );
  assert.equal(cc.diagnostics.source, 'events');
  assert.equal(cc.lines_added, 3);
});
