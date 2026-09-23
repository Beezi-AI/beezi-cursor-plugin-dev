import { auditLedgerFile, syncStateFile } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const LEDGER_VERSION = 1;

// Which past sessions the history backfill (the last step of the beezi-login skill) has already
// handed to the server, and what the server said.
//
// This has to be durable in a way ~/.beezi-cursor/state/<id>.json is not: pruneStale() deletes
// anything in state/, queue/ and events/ past the retention horizon, so a marker there expires and every
// old session looks importable again on the next run. auditLedgerFile() sits at the
// beeziCursorHome() root, outside the dirs pruneStale walks.
//
// The ledger is machine-global but the server's pull record is per (tenant, user, tool), so it
// binds to the login that wrote it: a ledger recorded under another identity is discarded, or a
// logout→login into a different workspace would replay it, find zero candidates, and seal the
// new tenant's pull EMPTY (there is no reopen).
export function loadLedger(identity = null) {
  const raw = readJson(auditLedgerFile(), null);
  // A ledger from a future/foreign shape is discarded rather than merged: re-sending is
  // idempotent server-side, whereas trusting an unknown shape is not.
  if (!raw || raw.version !== LEDGER_VERSION || typeof raw.sessions !== 'object' || raw.sessions === null) {
    return emptyLedger(identity);
  }
  if (raw.identity && identity && raw.identity !== identity) {
    return emptyLedger(identity);
  }
  if (!raw.identity && identity) raw.identity = identity;
  // Normalised here rather than guarded at every use site, in case an older shape lacked it.
  if (!raw.unreadable || typeof raw.unreadable !== 'object') raw.unreadable = {};
  return raw;
}

function emptyLedger(identity) {
  return {
    version: LEDGER_VERSION,
    identity: identity == null ? null : identity,
    sessions: {},
    unreadable: {},
    complete: false,
    updatedAt: null,
  };
}

// The pull was sealed server-side (we finalized it, or a chunk answered ALREADY_COMPLETED).
export function markComplete(ledger, { at = new Date() } = {}) {
  ledger.complete = true;
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function isComplete(ledger) {
  return ledger != null && ledger.complete === true;
}

// Rejected sessions count as imported. A repository that was never connected to Beezi rejects
// every one of its reports and always will, so resending it each run is pure waste; --force is the
// escape hatch when the repo has since been connected.
export function isImported(ledger, sessionId) {
  const sessions = ledger == null ? undefined : ledger.sessions;
  return Object.prototype.hasOwnProperty.call(sessions == null ? {} : sessions, sessionId);
}

export function markImported(ledger, sessionId, { outcome, reports = 0, at = new Date() } = {}) {
  ledger.sessions[sessionId] = { at: at.toISOString(), outcome, reports };
  // A session that read fine this time is not unreadable any more; leaving the marker would make
  // wasUnreadable() answer yes forever for a session that has since imported.
  if (ledger.unreadable != null) delete ledger.unreadable[sessionId];
  ledger.updatedAt = at.toISOString();
  return ledger;
}

// Whether any session was ever judged by the server under this ledger — the client-side proxy
// for "a pull exists server-side". The server opens the pull on the first backfill chunk it
// stores; /complete against a pull that was never opened is ignored with a warning while still
// answering 2xx, so the caller gates the seal on this instead of poisoning its caches off that
// hollow success. Unreadable markers do not count: nothing of theirs ever reached the server.
export function hasImports(ledger) {
  const sessions = ledger == null ? undefined : ledger.sessions;
  return Object.keys(sessions == null ? {} : sessions).length > 0;
}

// A sidecar that could not be read. Deliberately NOT in `sessions`: the session stays eligible,
// so the next run parses it again. It only records that we already gave it one chance, which is
// what lets the pull seal on the second attempt instead of blocking forever on a file that fails
// deterministically (a permission error reads exactly like a transient one).
export function markUnreadable(ledger, sessionId, { at = new Date() } = {}) {
  ledger.unreadable[sessionId] = { at: at.toISOString() };
  ledger.updatedAt = at.toISOString();
  return ledger;
}

export function wasUnreadable(ledger, sessionId) {
  const unreadable = ledger == null ? undefined : ledger.unreadable;
  return Object.prototype.hasOwnProperty.call(unreadable == null ? {} : unreadable, sessionId);
}

// 0600 — the ledger records which projects the user worked on, by session id only, but the file
// lives alongside credentials.json and follows the same rule.
export function saveLedger(ledger) {
  writeJsonSecure(auditLedgerFile(), ledger);
}

// ── repeatable sync progress
//
// A SEPARATE, separately-versioned file from the one-time ledger above, and the separation is the
// migration rule, not tidiness. The v1 ledger's `sessions` map means "the one-time pull handed this
// session to the server and the server judged it". A suffix that `beezi-sync` uploaded afterwards
// is not that, and an older client reading a suffix upload out of `sessions` would treat a partial
// resume as whole-history completion — which is unreopenable. So:
//
//   - the ledger stays readable and unchanged in meaning; nothing here writes to it,
//   - progress here is ACCOUNT-scoped (the pull is per tenant/user/tool, and so is the coverage
//     this progress mirrors); a different account gets an empty state rather than another
//     tenant's cursors,
//   - a corrupt or unknown version rescans. Never completion: the wrong direction for a
//     coverage-driven resume is re-asking the server, and the right direction is never "assume
//     delivered".
//
// The stored cursor is a raw event-index cursor in the SAME coordinate system the segmentIds use,
// and it travels with a fingerprint of the prefix it names — see sidecar-index.mjs. A sidecar that
// was truncated and re-appended has the same size and a newer mtime while its line space is
// entirely different, so size and mtime cannot establish content identity and are not consulted.
export const SYNC_STATE_VERSION = 1;

// `syncStateFile()` now lives in lib/paths-cursor.mjs beside `auditLedgerFile()` — one owner for
// every path shape, so a reader cannot spell it differently from the writer. It is re-exported here
// because this module's own tests and lib/session-audit.mjs import it from here.
//
// It sits at the beeziCursorHome() ROOT for the same reason as the ledger: pruneStale() deletes
// 14-day-old files under state/, queue/ and events/, and progress that expired there would make
// sync re-ask coverage for everything (safe, but pointless) or — worse, if the answer were ever
// unavailable — look like a machine that has never synced.
export { syncStateFile };

function emptySyncState(account) {
  return {
    version: SYNC_STATE_VERSION,
    account: account == null ? null : account,
    sessions: {},
    updatedAt: null,
  };
}

export function loadSyncState(account = null) {
  const raw = readJson(syncStateFile(), null);
  if (
    !raw ||
    raw.version !== SYNC_STATE_VERSION ||
    typeof raw.sessions !== 'object' ||
    raw.sessions === null ||
    Array.isArray(raw.sessions)
  ) {
    return emptySyncState(account);
  }
  // A state written under another account is discarded, not merged: its cursors describe what a
  // DIFFERENT tenant already holds, and resuming from them would skip history this account has
  // never received.
  //
  // NO ACCOUNT is the same refusal, not a wildcard. A machine that has linked but never recorded an
  // email cannot say whose cursors these are, and "unknown" matching everything is how one tenant's
  // verified prefix authorizes skipping another's history. It reads empty and, below, refuses to
  // write — an unscoped run simply re-asks the server, which is the safe direction.
  if (account == null) return emptySyncState(null);
  if (raw.account != null && raw.account !== account) return emptySyncState(account);
  if (raw.account == null) raw.account = account;
  return raw;
}

// What sync may resume this session from, or null when it must rescan from the server's coverage
// alone. An entry that does not carry BOTH a usable cursor and the fingerprint of the prefix it
// names is not progress — it is a number with nothing to prove it still describes this file.
export function syncProgressFor(state, sessionId) {
  const sessions = state == null ? undefined : state.sessions;
  if (sessions == null) return null;
  if (!Object.prototype.hasOwnProperty.call(sessions, sessionId)) return null;
  const entry = sessions[sessionId];
  if (entry == null || typeof entry !== 'object') return null;
  const cursor = entry.cursor;
  if (!Number.isInteger(cursor) || cursor < 0) return null;
  if (typeof entry.fingerprint !== 'string' || entry.fingerprint === '') return null;
  return { cursor, fingerprint: entry.fingerprint };
}

export function recordSyncProgress(state, sessionId, { cursor, fingerprint, at = new Date() } = {}) {
  state.sessions[sessionId] = { cursor, fingerprint, at: at.toISOString() };
  state.updatedAt = at.toISOString();
  return state;
}

// Same 0600 rule as the ledger: session ids name the projects the user worked on.
//
// Returns whether anything was written. An unscoped state is REFUSED rather than written: it would
// overwrite a real account's verified cursors with progress nobody can attribute, and the next
// scoped run would then resume from a prefix that was never checked against its own coverage.
export function saveSyncState(state) {
  if (state == null || state.account == null) return false;
  writeJsonSecure(syncStateFile(), state);
  return true;
}
