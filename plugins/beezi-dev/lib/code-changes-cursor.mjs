import path from 'path';
import * as hostPaths from './paths-cursor.mjs';
import { withDatabase } from './vscdb.mjs';
import { lineCount } from './sidecar-events.mjs';

// Code-change stats for a segment, in the same shape the Codex and Claude engines report:
//   { files_changed, lines_added, lines_removed, by_extension }
//
// Two sources, in order of fidelity:
//   1. ai-code-tracking.db — Cursor's own AI-vs-human line accounting. Preferred, because it counts
//      what Cursor itself attributes to the model rather than what a hook happened to observe.
//   2. the sidecar's `edit` events (afterFileEdit.edits[]) — always available, IDE and CLI.
//
// That precedence has not changed, but source 2 only recently became real. The database is written
// by the IDE and is usually ABSENT under `cursor-agent`, and until scripts/file-edit.mjs stopped
// being a capture-only stub, nothing was registered to write an `edit` line either — so for a CLI
// user the preferred source was missing and the fallback was empty, and every segment reported zero
// files changed while the agent rewrote the repository. Both halves matter now, and the ordering
// between them is load-bearing rather than theoretical.
//
// The database is used ONLY when a time window can be applied to it. Its rows are cumulative across
// the whole machine, so an unwindowed read would attribute a user's entire history to one segment —
// a confidently wrong number, which is worse than the honest lower bound the events give.

// lib/paths-cursor.mjs supplies the database path (imported at the top of this file). It used to be
// bound through a guarded `await import` so a missing module left the events fallback — which needs
// no Cursor install at all — carrying the whole feature. Top-level await needs Node 14.8 and the
// plugin's floor is 13.2, so the binding is static now: the module is a sibling in this package, and
// resolveDbFile() below still degrades to null on anything short of a callable export.

// TODO(P0): unverified — Cursor not installed on the authoring machine.
// ai-code-tracking.db's table and column names come from decompiled-binary analysis and have moved
// before, so they are discovered from sqlite_master rather than hardcoded to one spelling. Each
// candidate list is one line per name.
const FILE_COLUMNS = ['file_path', 'filePath', 'path', 'file', 'relative_path', 'uri'];
const ADDED_COLUMNS = [
  'ai_lines_added',
  'aiLinesAdded',
  'ai_lines',
  'aiLines',
  'lines_added',
  'added',
  'additions',
];
const REMOVED_COLUMNS = [
  'ai_lines_removed',
  'aiLinesRemoved',
  'lines_removed',
  'removed',
  'deletions',
];
const TIME_COLUMNS = ['timestamp', 'created_at', 'createdAt', 'ts', 'time', 'edited_at'];

const EDIT_EVENTS = new Set(['edit', 'file_edit', 'edits']);
const PATH_FIELDS = ['path', 'file', 'file_path', 'filePath', 'uri'];
const ADDED_FIELDS = ['added', 'lines_added', 'linesAdded', 'additions'];
const REMOVED_FIELDS = ['removed', 'lines_removed', 'linesRemoved', 'deletions'];

function extOf(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return ext || '(none)';
}

function pickString(record, fields) {
  for (const field of fields) {
    const value = record == null ? undefined : record[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// A count the record actually carried, or null when it carried none. `typeof value === 'number'` is
// what makes an explicit `null` indistinguishable from an absent field — intentionally, see the
// three-state note on applyEdit — while keeping a literal 0 as the observation it is.
function pickCount(record, fields) {
  for (const field of fields) {
    const value = record == null ? undefined : record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function newCollector() {
  return { files: new Set(), byExt: new Map(), added: 0, removed: 0 };
}

function touch(collector, filePath) {
  if (!filePath) return;
  collector.files.add(filePath);
  const ext = extOf(filePath);
  let set = collector.byExt.get(ext);
  if (!set) {
    set = new Set();
    collector.byExt.set(ext, set);
  }
  set.add(filePath);
}

function finalize(collector) {
  const by_extension = {};
  for (const [ext, set] of collector.byExt) by_extension[ext] = set.size;
  return {
    files_changed: collector.files.size,
    lines_added: collector.added,
    lines_removed: collector.removed,
    by_extension,
  };
}

// Cursor's afterFileEdit describes an edit as replaced text rather than as line counts — always, not
// merely sometimes. Its payload is `{file_path, edits:[{old_string, new_string}]}` with no line
// numbers, no ranges and no counts anywhere in it; those fields exist only on `afterTabFileEdit`,
// which fires for Tab completions and never for an agent edit. Counting the lines on each side of
// the replacement is a lower bound on the change, which is honest; guessing zero is not.
//
// `lineCount` (lib/sidecar-events.mjs) rather than the local `text.split('\n').length` this used to
// be, which was wrong twice over:
//
//   • It over-counted by one for any text ending in a newline — the common case, since almost every
//     source file does. `"a\nb\nc\n".split('\n')` is four elements, the last of them empty. So a
//     three-line replacement was reported as four, on BOTH sides of EVERY edit in EVERY segment
//     whose counts came from here. The sibling plugin has always done
//     `.replace(/\n$/, '').split('\n').length` (beezi-claude-plugins/…/lib/code-changes.mjs:4-7) and
//     `lineCount` reproduces that semantics exactly, second trailing newline included.
//   • It allocated one string object per line for text that is whatever the model wrote. A
//     whole-file rewrite of a lockfile or a generated bundle is routinely several megabytes —
//     hundreds of thousands of allocations — and this runs on the READ path, inside the `stop` hook
//     Cursor kills at a 10s deadline. `lineCount` walks the same bytes with `indexOf` and allocates
//     nothing at all.
//
// Sharing the function with the write side is the other reason: lib/sidecar-events.mjs derives the
// same counts from the same strings when a hook payload carries none, so two copies of this
// arithmetic would be two answers for one edit depending on which side happened to measure it.
//
// TODO(P0): unverified — the `edits[]` ELEMENT shape has never been seen from a real Cursor install
// (BEEZI_CURSOR_DUMP_HOOKS answers it). Degradation is deliberate and one-directional: a record
// whose replaced text is under keys we do not know returns null here, the caller records the file
// as touched with no line counts, and `uncountedEdits` says so. Never a wrong number.
function lineCountsFromText(record) {
  const before = record == null
    ? undefined
    : (typeof record.old_string === 'string' ? record.old_string : record.oldString);
  const after = record == null
    ? undefined
    : (typeof record.new_string === 'string' ? record.new_string : record.newString);
  if (typeof before !== 'string' && typeof after !== 'string') return null;
  // `lineCount` answers 0 for a non-string, which is the right answer for the one-sided cases: a
  // pure insertion carries no `old_string` and a pure deletion no `new_string`.
  return { added: lineCount(after), removed: lineCount(before) };
}

// One `edits[]` element, or the edit event itself when the writer flattened it.
//
// THREE STATES PER COUNT, and collapsing any two of them produces a wrong number rather than a
// missing one:
//
//   observed   the record carries a number, INCLUDING a literal 0. `pickCount` returns it and no
//              fallback runs. An observed zero is a measurement — the host said this edit changed no
//              lines — and deriving over the top of it replaces a fact with a guess.
//   null       the record carries `"added": null`. `pickCount` skips it (`typeof null` is 'object'),
//              so it reads as absent, which is correct: a writer that says "I looked and found
//              nothing" is saying what a writer that never wrote the field is saying.
//   absent     the field is not there at all. Since lib/sidecar-events.mjs stopped emitting the
//              false zero this is the NORMAL state for a Cursor edit, and it is the only state in
//              which the text fallback runs.
//
// That last point is the bug this pairing exists to keep fixed. The write side used to record
// `"added":0,"removed":0` on every edit whose payload carried no counts, because `nonNegativeInt`
// answered 0 for `undefined`. A literal 0 is a number, so `pickCount` returned it, the condition
// below saw a non-null and the text fallback never ran — segments named every file the agent had
// touched and reported zero lines for all of them. Both sides are needed: omitting the field at
// write time is what lets this read side tell "nothing was observed" from "nothing changed".
//
// WHOLESALE, not per field: if EITHER count was observed, NEITHER is derived. Mixing an observation
// with a derivation reports two numbers taken from two different accountings of one edit. This is
// the same precedence `editCounts` applies in lib/sidecar-events.mjs, deliberately, so the choice of
// source does not depend on which side of the sidecar happened to make it.
function applyEdit(collector, record, fallbackPath, diagnostics) {
  const pickedPath = pickString(record, PATH_FIELDS);
  const filePath = pickedPath == null ? fallbackPath : pickedPath;
  let added = pickCount(record, ADDED_FIELDS);
  let removed = pickCount(record, REMOVED_FIELDS);
  if (added === null && removed === null) {
    const derived = lineCountsFromText(record);
    if (derived) {
      added = derived.added;
      removed = derived.removed;
    }
  }
  if (filePath === null && added === null && removed === null) {
    diagnostics.unmatchedEdits += 1;
    return;
  }
  diagnostics.matchedEdits += 1;
  // A file we can name but could not measure — counted apart from `matchedEdits` because it is the
  // precise fingerprint of `afterFileEdit`'s `edits[]` arriving in a shape this module does not
  // know. The file still belongs in files_changed (it WAS changed) and the line totals stay a lower
  // bound, which is the intended degradation; what is NOT acceptable is that degradation being
  // invisible. Without this counter a segment of unreadable edits and a segment of genuinely empty
  // ones report identically.
  if (added === null && removed === null) diagnostics.uncountedEdits += 1;
  touch(collector, filePath);
  // The `== null ? 0` below adds nothing for a count that was never observed. It is not the false
  // zero described above: that one was WRITTEN onto the line, where it suppressed the fallback and
  // then claimed to be an observation. This one is local, reached only after the fallback has
  // already had its turn.
  collector.added += added == null ? 0 : added;
  collector.removed += removed == null ? 0 : removed;
}

function fromEvents(events, diagnostics) {
  const collector = newCollector();
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || !EDIT_EVENTS.has(event.ev)) continue;
    diagnostics.editEvents += 1;
    const fallbackPath = pickString(event, PATH_FIELDS);
    if (Array.isArray(event.edits) && event.edits.length > 0) {
      for (const edit of event.edits) applyEdit(collector, edit, fallbackPath, diagnostics);
      continue;
    }
    applyEdit(collector, event, fallbackPath, diagnostics);
  }
  return collector;
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

function firstMatch(columns, candidates) {
  const lower = new Map(columns.map((c) => [String(c).toLowerCase(), c]));
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// The first table that carries a file column, an added-lines column AND a timestamp column. The
// timestamp is not optional: without it the rows cannot be attributed to this segment.
function resolveSchema(db) {
  let tables;
  try {
    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
  } catch {
    return null;
  }
  for (const table of tables) {
    const columns = columnsOf(db, table);
    const file = firstMatch(columns, FILE_COLUMNS);
    const added = firstMatch(columns, ADDED_COLUMNS);
    const time = firstMatch(columns, TIME_COLUMNS);
    if (file && added && time) {
      return { table, file, added, removed: firstMatch(columns, REMOVED_COLUMNS), time };
    }
  }
  return null;
}

function fromDatabase(dbFile, window, deps, diagnostics) {
  return withDatabase(
    dbFile,
    (db) => {
      const schema = resolveSchema(db);
      if (!schema) return null;
      diagnostics.table = schema.table;
      // Cursor has written these timestamps in both seconds and milliseconds; matching either keeps
      // a unit change from silently emptying the result.
      const secStart = Math.floor(window.startMs / 1000);
      const secEnd = Math.ceil(window.endMs / 1000);
      const removedExpr = schema.removed ? `"${schema.removed}"` : '0';
      const sql =
        `SELECT "${schema.file}" AS f, "${schema.added}" AS a, ${removedExpr} AS r ` +
        `FROM "${schema.table}" ` +
        `WHERE ("${schema.time}" >= ? AND "${schema.time}" <= ?) ` +
        `OR ("${schema.time}" >= ? AND "${schema.time}" <= ?)`;
      const rows = db.prepare(sql).all(window.startMs, window.endMs, secStart, secEnd);
      if (rows.length === 0) return null;
      const collector = newCollector();
      for (const row of rows) {
        touch(collector, typeof row.f === 'string' ? row.f : null);
        collector.added += Number.isFinite(row.a) ? Number(row.a) : 0;
        collector.removed += Number.isFinite(row.r) ? Number(row.r) : 0;
      }
      diagnostics.dbRows = rows.length;
      return collector;
    },
    deps,
  );
}

// `deps.window` = { startMs, endMs } bounds the database read to this segment. Without it the
// events fallback is used, deliberately.
export function computeCodeChanges(events, deps = {}) {
  const diagnostics = {
    source: 'none',
    editEvents: 0,
    matchedEdits: 0,
    // Matched by path, but with no count observed and no replaced text to derive one from. See
    // applyEdit: this is what an unrecognised `edits[]` element shape looks like from here.
    uncountedEdits: 0,
    unmatchedEdits: 0,
    dbRows: 0,
    table: null,
  };

  const window = deps.window == null ? null : deps.window;
  const dbFile =
    deps.aiCodeTrackingDbFile !== undefined
      ? deps.aiCodeTrackingDbFile
      : resolveDbFile();

  let collector = null;
  if (dbFile && window && Number.isFinite(window.startMs) && Number.isFinite(window.endMs)) {
    collector = fromDatabase(dbFile, window, deps, diagnostics);
    if (collector) diagnostics.source = 'ai_code_tracking';
  }
  if (!collector) {
    collector = fromEvents(events, diagnostics);
    if (diagnostics.matchedEdits > 0) diagnostics.source = 'events';
  }

  const result = finalize(collector);
  // Non-enumerable: the wire shape stays identical to the other engines' code_changes, while
  // "which source answered, and did anything match" stays assertable.
  Object.defineProperty(result, 'diagnostics', { value: diagnostics, enumerable: false });
  return result;
}

function resolveDbFile() {
  const fn = hostPaths.aiCodeTrackingDbFile;
  if (typeof fn !== 'function') return null;
  try {
    const resolved = fn();
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  } catch {
    return null;
  }
}
