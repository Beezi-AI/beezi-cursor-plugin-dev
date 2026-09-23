// How far back this machine keeps, and uploads, its own analytics history.
//
// One number for two jobs that must not drift apart:
//   - lib/prune.mjs deletes state/, queue/, events/ and pending/ files older than this,
//   - lib/session-audit.mjs refuses to upload a session whose last real activity is older.
//
// They are different mechanisms on purpose. Prune works on the file mtime, which Cursor restamps
// on every app restart, so a tab forgotten for months can have a file written minutes ago and
// survive every sweep. The upload floor keys on the last REAL activity, which is the thing a user
// would call the session's age — so it catches exactly what prune structurally cannot.
//
// Its own module rather than a constant inside either file: prune.mjs runs on the hook path and
// must not pull the audit's dependency graph in behind it, and the audit must not import the
// pruner just to read a number.
export const RETENTION_WINDOW_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
