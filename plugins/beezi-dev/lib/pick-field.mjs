// The one field-probe the sidecar readers share: the first of `fields` this record carries as a
// non-empty string, trimmed, or null.
//
// Five near-identical copies lived in lib/delta-cursor.mjs, lib/context-metrics-cursor.mjs,
// lib/code-changes-cursor.mjs, lib/operations-cursor.mjs and lib/sidecar-events.mjs. Two of them
// (operations, sidecar-events) probed the record unguarded, so a null record threw where the other
// three answered null. The GUARDED form is what survives here: every caller feeds this function a
// record parsed out of a sidecar line or a hook payload, which is exactly where a null arrives
// from, and a hook that throws is a hook that breaks the user's Cursor session.
//
// IMPORTS NOTHING, and must keep importing nothing. scripts/check-node-floor.mjs walks lib/ off the
// filesystem and `import()`s every module it finds in an isolated child, so anything this leaf
// pulled in would be pulled into that child too; and a module that imports nothing cannot take part
// in a cycle, which is what lets the hook-path modules share it without inheriting the reporting
// engine.
export function pickString(record, fields) {
  for (const field of fields) {
    const value = record == null ? undefined : record[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}
