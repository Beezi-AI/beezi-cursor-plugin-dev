import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
// Default paths come from lib/paths-cursor.mjs, imported statically. This used to be a top-level
// `await import()` in a try/catch, from when that module did not exist yet; it needs Node 14.8 and
// the plugin's floor is 13.2, so the tolerance had to go. Nothing is lost: paths-cursor imports only
// Node builtins and lib/env-identity.mjs, and does no work at import time, so it cannot fail to load. The degrade this module promises is unchanged and lives
// in `hostPath`, now shared from that module — a path function that throws, or resolves to nothing,
// still yields null and callers still take their documented degraded branch, the same one a missing
// Cursor install produces.
import { hostPath } from './paths-cursor.mjs';
import { removeSync } from './fs-compat.mjs';

// Read-only access to Cursor's SQLite stores (state.vscdb, ai-code-tracking.db) with no runtime
// dependency: node:sqlite or nothing. Every export degrades to null rather than throwing, because
// every one of them sits behind a hook that must not break the user's Cursor session.
//
// The degrade table this implements (design doc, "SQLite under a zero-dependency constraint"):
//   node:sqlite present -> ai-code-tracking.db code changes + usageData cost/pool + plan
//   absent              -> edits[] fallback, billing_pool 'unknown', plan via --plan self-report

let probed;

// node:sqlite is experimental below Node 24 and gated behind a flag on some builds, so it is probed,
// never assumed. `deps.sqlite` is the test seam: pass null to exercise the degraded path.
function loadSqlite(deps = {}) {
  if (deps.sqlite !== undefined) return deps.sqlite;
  if (probed !== undefined) return probed;
  probed = null;
  try {
    // The 'node:sqlite' STRING stays: this is a runtime lookup, not an import specifier, and the
    // builtin only exists under that name. `getBuiltinModule` itself arrived in Node 22, so on an
    // older interpreter this whole branch is skipped and the require below throws into its catch.
    const mod = typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite')
      : undefined;
    if (mod != null && mod.DatabaseSync) probed = mod;
  } catch {
    /* not permitted in this runtime */
  }
  if (!probed) {
    try {
      const mod = createRequire(import.meta.url)('node:sqlite');
      if (mod != null && mod.DatabaseSync) probed = mod;
    } catch {
      /* older Node, or built without SQLite */
    }
  }
  return probed;
}

export function isSqliteAvailable(deps = {}) {
  return loadSqlite(deps) !== null;
}

// The smallest key strictly greater than every key starting with `prefix`, or null when no such
// bound exists. Used so key lookups run `key >= p AND key < p++` against the primary-key index —
// LIKE 'p%' cannot use it, and these tables carry a full conversation history.
export function prefixUpperBound(prefix) {
  if (typeof prefix !== 'string' || prefix === '') return null;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xffff) return null;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

// Cursor has kept its key/value store in two tables across its format moves; both live in
// state.vscdb and the key namespaces do not collide, so both are scanned.
// TODO(P0): unverified — see lib/hook-dump.mjs
const KV_TABLES = ['cursorDiskKV', 'ItemTable'];

function decodeValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  if (value == null) return null;
  return String(value);
}

function openDirect(sqlite, dbFile) {
  // `?mode=ro` is honored by node:sqlite and is stronger than a read-only flag: SQLite itself
  // refuses the write, so a hook can never mutate the user's Cursor state.
  const uri = `${pathToFileURL(dbFile).href}?mode=ro`;
  try {
    return new sqlite.DatabaseSync(uri);
  } catch {
    /* fall through */
  }
  try {
    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    // Wait briefly for a lock instead of failing instantly. Without this, a Cursor that happens to
    // be mid-write sends every read down the fallback path, which copies the entire database — the
    // expensive branch is taken for a lock that would have cleared in milliseconds. Kept far below
    // the hook budget: the point is to absorb a blip, not to block a hook.
    try { db.exec('PRAGMA busy_timeout = 250'); } catch { /* older builds ignore it */ }
    return db;
  } catch {
    return null;
  }
}

// Cursor may be running and holding the write-ahead log, in which case a read-only open of the main
// db either fails or returns a stale snapshot. Copying the whole set (.db + -wal + -shm) to temp and
// reading the copy is the only way to observe a consistent, current view without touching the
// original. The copy is opened writable on purpose: SQLite replays the WAL into it.
function openSnapshot(sqlite, dbFile, deps = {}) {
  const mkdtemp = deps.mkdtemp == null ? ((prefix) => fs.mkdtempSync(prefix)) : deps.mkdtemp;
  let dir = null;
  try {
    dir = mkdtemp(path.join(os.tmpdir(), 'beezi-cursor-db-'));
    const base = path.basename(dbFile);
    const target = path.join(dir, base);
    fs.copyFileSync(dbFile, target);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.copyFileSync(dbFile + suffix, target + suffix);
      } catch {
        /* the sidecar files are optional */
      }
    }
    const db = new sqlite.DatabaseSync(target);
    return { db, dir };
  } catch {
    if (dir) rmDir(dir);
    return null;
  }
}

function rmDir(dir) {
  try {
    removeSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Run `fn(db)` against a read-only handle on `dbFile`. Returns fn's value, or null when the database
// cannot be opened or fn throws. Never throws.
//
// `deps.noSnapshot === true` turns the temp-copy fallback off on BOTH branches (open failure and the
// query-failure retry): the direct read-only open answers, or the result is null. The Cursor CLI's
// store.db needs this, because its meta row and WAL carry `blobEncryptionKey`, and a snapshot is a
// copy of that key on disk that a hook killed at its deadline never cleans up. A direct `?mode=ro`
// open was verified to read a live CLI store's WAL-resident rows, so nothing is lost by refusing.
export function withDatabase(dbFile, fn, deps = {}) {
  const sqlite = loadSqlite(deps);
  if (!sqlite || typeof dbFile !== 'string' || dbFile === '') return null;
  const exists = deps.exists == null ? ((p) => fs.existsSync(p)) : deps.exists;
  if (!exists(dbFile)) return null;
  const allowSnapshot = deps.noSnapshot !== true;

  let handle = openDirect(sqlite, dbFile);
  let snapshotDir = null;
  if (!handle) {
    if (!allowSnapshot) return null;
    const snap = openSnapshot(sqlite, dbFile, deps);
    if (!snap) return null;
    handle = snap.db;
    snapshotDir = snap.dir;
  }

  try {
    return fn(handle);
  } catch {
    // A query failure on a live database is usually the WAL: retry once against a snapshot before
    // giving up, so a running Cursor does not silently cost us every enrichment read. Not when the
    // caller refused snapshots: the same copy would be made here.
    if (!snapshotDir && allowSnapshot) {
      try {
        handle.close();
      } catch {
        /* ignore */
      }
      const snap = openSnapshot(sqlite, dbFile, deps);
      if (!snap) return null;
      try {
        return fn(snap.db);
      } catch {
        return null;
      } finally {
        try {
          snap.db.close();
        } catch {
          /* ignore */
        }
        rmDir(snap.dir);
      }
    }
    return null;
  } finally {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
    if (snapshotDir) rmDir(snapshotDir);
  }
}

function tableNames(db) {
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
  } catch {
    return [];
  }
}

// All { key, value } rows whose key starts with `keyPrefix`, across whichever key/value tables this
// database actually has. Returns [] when nothing matches and null when the database is unreadable —
// callers must be able to tell "no such key" from "could not look".
export function readKeys(dbFile, keyPrefix, deps = {}) {
  if (typeof keyPrefix !== 'string' || keyPrefix === '') return null;
  const tables = deps.tables == null ? KV_TABLES : deps.tables;
  const upper = prefixUpperBound(keyPrefix);

  return withDatabase(
    dbFile,
    (db) => {
      const present = new Set(tableNames(db));
      const rows = [];
      for (const table of tables) {
        if (!present.has(table)) continue;
        const sql =
          upper === null
            ? `SELECT key, value FROM "${table}" WHERE key >= ?`
            : `SELECT key, value FROM "${table}" WHERE key >= ? AND key < ?`;
        const params = upper === null ? [keyPrefix] : [keyPrefix, upper];
        for (const row of db.prepare(sql).all(...params)) {
          rows.push({ key: row.key, value: decodeValue(row.value), table });
        }
      }
      return rows;
    },
    deps,
  );
}

// Bounded, PAGED, keys-only enumeration of a prefix.
//
// `readKeys` above decodes every matching value, which is right for one exact key and wrong for a
// bare `composerData:` scan: that is the user's entire conversation store, hundreds of megabytes on
// a heavy machine, materialised into one array to answer the question "which conversations exist".
// History discovery asks the cheap question here — keys only, in primary-key order, a page at a
// time — and fetches values afterwards, through readComposerData, for the handful of ids that
// survive filtering.
//
// Three explicit ceilings, because a read-only scan of somebody else's live database must be
// bounded in every dimension that can surprise it: rows (an account with years of history), bytes
// (keys are small, but not if the schema moved and the prefix now matches something else) and wall
// time (the snapshot fallback copies the whole database before the first row arrives).
//
// Returns `{ keys: [{ key, table }], truncated, reason }`, or NULL when the database could not be
// read — no SQLite, no file, a locked database the snapshot fallback could not copy, or a schema
// with none of the known key tables. Null is load-bearing: it becomes "unavailable" upstream, never
// "this machine has no history".
export const KEY_SCAN_DEFAULTS = Object.freeze({
  maxRows: 5000,
  maxBytes: 1024 * 1024,
  maxMs: 5000,
  pageSize: 500,
});

export function readKeysBounded(dbFile, keyPrefix, options = {}, deps = {}) {
  if (typeof keyPrefix !== 'string' || keyPrefix === '') return null;
  const tables = deps.tables == null ? KV_TABLES : deps.tables;
  const upper = prefixUpperBound(keyPrefix);
  const maxRows = options.maxRows == null ? KEY_SCAN_DEFAULTS.maxRows : options.maxRows;
  const maxBytes = options.maxBytes == null ? KEY_SCAN_DEFAULTS.maxBytes : options.maxBytes;
  const maxMs = options.maxMs == null ? KEY_SCAN_DEFAULTS.maxMs : options.maxMs;
  const pageSize = options.pageSize == null ? KEY_SCAN_DEFAULTS.pageSize : options.pageSize;
  const now = options.now == null ? (() => Date.now()) : options.now;

  const scan = withDatabase(
    dbFile,
    (db) => {
      const present = new Set(tableNames(db));
      const scanned = tables.filter((table) => present.has(table));
      // A database whose schema has moved out from under us must not read as "no rows": the
      // difference between "Cursor keeps conversations somewhere else now" and "this user has
      // never had a conversation" is the difference between a gap and a false zero.
      //
      // SIGNALLED, NOT THROWN. `withDatabase` answers a throw from this callback by reopening the
      // database from a full temp-directory COPY (.db plus -wal plus -shm) and running the callback
      // again — seconds of disk I/O on a heavy store, to arrive at the same verdict. A sentinel
      // value is converted to null below without that round trip.
      if (scanned.length === 0) return { schemaUnknown: true };

      const started = now();
      const keys = [];
      let bytes = 0;
      let reason = 'complete';

      for (const table of scanned) {
        let afterKey = null;
        for (;;) {
          if (keys.length >= maxRows) { reason = 'max-rows'; break; }
          if (bytes >= maxBytes) { reason = 'max-bytes'; break; }
          if (now() - started >= maxMs) { reason = 'max-ms'; break; }
          const clauses = [afterKey === null ? 'key >= ?' : 'key > ?'];
          const params = [afterKey === null ? keyPrefix : afterKey];
          if (upper !== null) { clauses.push('key < ?'); params.push(upper); }
          const sql = `SELECT key FROM "${table}" WHERE ${clauses.join(' AND ')} ORDER BY key LIMIT ?`;
          const rows = db.prepare(sql).all(...params, pageSize);
          if (rows.length === 0) break;
          for (const row of rows) {
            if (keys.length >= maxRows) { reason = 'max-rows'; break; }
            if (bytes >= maxBytes) { reason = 'max-bytes'; break; }
            keys.push({ key: row.key, table });
            bytes += Buffer.byteLength(String(row.key), 'utf-8');
          }
          afterKey = rows[rows.length - 1].key;
          if (rows.length < pageSize) break;
        }
        if (reason !== 'complete') break;
      }

      return { keys, truncated: reason !== 'complete', reason };
    },
    deps,
  );
  if (scan == null || scan.schemaUnknown === true) return null;
  return scan;
}

function stateVscdbFile(deps = {}) {
  if (deps.stateVscdbFile !== undefined) return deps.stateVscdbFile;
  return hostPath('stateVscdbFile');
}

// Cursor stores one record per conversation under this prefix in its key/value table.
// TODO(P0): unverified — see lib/hook-dump.mjs
const COMPOSER_KEY_PREFIX = 'composerData:';

// The parsed composerData record for a conversation, or null when it cannot be read (no SQLite, no
// resolvable database, unreadable database, key absent, or unparseable value). Null is load-bearing:
// it is what turns into billing_pool 'unknown' downstream.
// One record per conversation, read at most once per process.
//
// A single checkpoint asks for the same `composerData:<id>` record twice by two different routes —
// resolveSessionName wants its title, readUsageData wants its priced usage — and each call used to
// open Cursor's database from scratch. When Cursor is running the direct open fails on the WAL and
// the fallback copies the whole database plus its -wal and -shm to a temp directory; on a heavy
// user's multi-hundred-megabyte store that is seconds of disk I/O, twice, inside a 7.5 s budget.
//
// A hook process lives for one event, so there is no staleness window worth worrying about: the
// record cannot meaningfully change between two reads in the same hook. Misses are cached too —
// "there is no such record" is exactly as expensive to establish, and just as stable.
const composerCache = new Map();

// Tests that stub the store need the cache not to answer for a previous stub's data.
export function clearVscdbCache() {
  composerCache.clear();
}

export function readComposerData(conversationId, deps = {}) {
  if (!conversationId) return null;
  if (typeof deps.readComposerData === 'function') return deps.readComposerData(conversationId);

  // Only the default path is cached. A caller that injected its own reader is asking for that
  // reader, and caching across differing `deps` would hand one test another's answer.
  const cacheable = typeof deps.readKeys !== 'function' && deps.stateVscdbFile === undefined;
  if (cacheable && composerCache.has(conversationId)) return composerCache.get(conversationId);

  const value = readComposerDataUncached(conversationId, deps);
  if (cacheable) composerCache.set(conversationId, value);
  return value;
}

function readComposerDataUncached(conversationId, deps) {
  const dbFile = stateVscdbFile(deps);
  if (!dbFile) return null;
  const key = `${COMPOSER_KEY_PREFIX}${conversationId}`;
  const rows = deps.readKeys ? deps.readKeys(dbFile, key) : readKeys(dbFile, key, deps);
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Exact key first; a prefix hit on a longer key belongs to a different conversation.
  const row = rows.find((r) => r.key === key);
  if (!row || typeof row.value !== 'string') return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Field spellings Cursor has plausibly used for the two numbers we need. Adding a newly observed
// spelling is a one-line change, and an unrecognized shape yields null (-> 'unknown'), never a zero
// that would read as "covered by the seat".
// TODO(P0): unverified — see lib/hook-dump.mjs
const AMOUNT_FIELDS = ['amount', 'numRequests', 'num_requests', 'requests', 'count'];
const CENTS_FIELDS = ['costInCents', 'costCents', 'cost_in_cents', 'cents'];

function pickNumber(record, fields) {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // Cursor has written these as strings before a format move; accept a clean numeric string.
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

// Per-model priced usage for a conversation: { [model]: { amount, costInCents } }.
//
// The return has three distinct meanings and conflating any two of them corrupts the cost split:
//   null  -> could not read (no SQLite / no database / no record / shape we do not recognize)
//            => billing_pool 'unknown'
//   {}    -> read fine, nothing was priced  => every request is covered by the seat ('subscription')
//   {...} -> read fine, these models were priced
export function readUsageData(conversationId, deps = {}) {
  const composer = readComposerData(conversationId, deps);
  if (composer === null) return null;

  const raw = composer.usageData;
  // The record exists and simply carries no priced usage: Cursor writes usageData only for
  // usage-priced requests, so its absence on a record we DID read means "nothing priced".
  if (raw === undefined || raw === null) return {};
  // Present but not the shape we know: a format move. Refuse to interpret it — a wrong guess here
  // silently inflates the seat-covered bucket, which is the bug this whole split exists to prevent.
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};
  let recognized = 0;
  for (const [model, record] of Object.entries(raw)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const amount = pickNumber(record, AMOUNT_FIELDS);
    const costInCents = pickNumber(record, CENTS_FIELDS);
    if (amount === null && costInCents === null) continue;
    recognized += 1;
    out[model] = { amount: amount == null ? 0 : amount, costInCents: costInCents == null ? 0 : costInCents };
  }

  // Entries existed but none carried a field we understand — that is a schema miss, not an
  // in-allowance conversation.
  if (recognized === 0 && Object.keys(raw).length > 0) return null;
  return out;
}
