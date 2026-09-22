import { readKeysBounded as _readKeysBounded, KEY_SCAN_DEFAULTS } from './vscdb.mjs';
import { stateVscdbFile } from './paths-cursor.mjs';
import {
  listAllConversations as _listAllConversations,
  lastActivityTs as _lastActivityTs,
} from './sidecar-index.mjs';

// What history exists on this machine, from BOTH places it can live, merged by conversation id.
//
// The sidecar (`~/.beezi-cursor/events/<id>.jsonl`) is this plugin's source of truth, and it has a
// hard horizon: it starts when the plugin was installed and pruneStale() deletes it at 14 days.
// Everything the user did before that, and everything older than two weeks, exists only in
// Cursor's own durable store (`state.vscdb`, one `composerData:<id>` record per conversation).
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
// It does not upload. Enumerating `composerData:` is technically easy and accounting off it is
// not: `usageData` is CUMULATIVE PRICED OVERAGE (lib/vscdb.mjs documents the three-way null / {} /
// {...} contract), so it is neither a total cost nor a token count nor a duration, and its absence
// means "covered by the seat", not "free". The portal's backfill cost DTO wants total cost, model
// token fields and started_at; filling any of those with zero from a record that does not carry
// them manufactures facts about somebody's spend. So discovery and dry-run counts ship now, and
// upload stays off behind HISTORY_UPLOAD_ENABLED until a backend-approved partial-snapshot
// contract exists — see handoff-sync.md for what that contract has to state.
//
// It also never reports a zero it did not observe. A database that is missing, locked, built
// without SQLite support, or whose schema has moved is `available: false` with a NULL count. "This
// machine has no history" and "we could not look" are opposite facts, and a shared number is how
// the second silently becomes the first.

export const HISTORY_UPLOAD_ENABLED = false;

export const HistorySource = Object.freeze({
  SIDECAR: 'sidecar',
  DURABLE: 'durable',
});

// Cursor stores one record per conversation under this prefix. Kept here as well as in vscdb.mjs
// because this module parses ids back OUT of the key, which is the inverse operation.
// TODO(P0): unverified — see lib/hook-dump.mjs
const COMPOSER_KEY_PREFIX = 'composerData:';

// Same window and the same reasoning as the audit's: a conversation whose last REAL activity is
// within a day is probably still open, and its hooks own it.
const ACTIVE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Same cap as the audit's: a sidecar this large is never read.
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;

export function conversationIdFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith(COMPOSER_KEY_PREFIX)) return null;
  const id = key.slice(COMPOSER_KEY_PREFIX.length);
  return id === '' ? null : id;
}

// Bounded, keys-only enumeration of the durable store.
//
// `{ available, reason, ids, truncated }`. `reason` is `null` when the scan completed, the scan's
// own ceiling name when it was cut short (`max-rows` / `max-bytes` / `max-ms`), and `unavailable`
// when the database could not be read at all. Values are NOT fetched here — a bare
// `composerData:` scan with values is the user's whole conversation store in one array.
export function enumerateDurableConversations(deps = {}, options = {}) {
  const readKeys = deps.readKeysBoundedImpl == null ? _readKeysBounded : deps.readKeysBoundedImpl;
  const dbFile = deps.stateVscdbFile === undefined ? stateVscdbFile() : deps.stateVscdbFile;
  let scan;
  try {
    scan = readKeys(dbFile, COMPOSER_KEY_PREFIX, options.limits == null ? KEY_SCAN_DEFAULTS : options.limits);
  } catch {
    // A locked database whose snapshot copy failed throws out of the sqlite layer on some
    // platforms. Unreadable is unreadable; it is never zero.
    return { available: false, reason: 'unavailable', ids: [], truncated: false };
  }
  if (scan == null || !Array.isArray(scan.keys)) {
    return { available: false, reason: 'unavailable', ids: [], truncated: false };
  }
  // Merged by id, once, here: the same conversation can appear in both key/value tables across a
  // format move, and two rows for one conversation are one conversation.
  const ids = [];
  const seen = new Set();
  for (const row of scan.keys) {
    const id = conversationIdFromKey(row == null ? null : row.key);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return {
    available: true,
    reason: scan.truncated === true ? scan.reason : null,
    ids,
    truncated: scan.truncated === true,
  };
}

// The merged view. Discovery and counting only — nothing here reads a conversation's value, posts
// anything, or writes anything.
export function buildHistoryIndex(deps = {}, options = {}) {
  const listConversations = deps.listConversations == null ? _listAllConversations : deps.listConversations;
  const lastActivityOf = deps.lastActivityOfImpl == null ? ((entry) => _lastActivityTs(entry.sessionId)) : deps.lastActivityOfImpl;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  const account = options.account === undefined ? null : options.account;

  const counts = {
    total: 0,
    sidecarOnly: 0,
    durableOnly: 0,
    both: 0,
    active: 0,
    oversize: 0,
  };

  // The sidecar side first, because its exclusions are authoritative for BOTH sources: a
  // conversation that is still open must not be reported as importable history merely because a
  // durable row also exists for it.
  const sidecarIds = new Set();
  const excluded = new Set();
  for (const entry of listConversations()) {
    if (entry.size > MAX_SIDECAR_BYTES) {
      counts.oversize += 1;
      excluded.add(entry.sessionId);
      continue;
    }
    const activityMs = lastActivityOf(entry);
    if (activityMs != null && activityMs > now() - ACTIVE_SESSION_WINDOW_MS) {
      counts.active += 1;
      excluded.add(entry.sessionId);
      continue;
    }
    sidecarIds.add(entry.sessionId);
  }

  const durable = enumerateDurableConversations(deps, options);
  const durableIds = new Set(durable.ids);

  const candidates = [];
  for (const sessionId of sidecarIds) {
    const inDurable = durableIds.has(sessionId);
    candidates.push({
      sessionId,
      sources: inDurable ? [HistorySource.SIDECAR, HistorySource.DURABLE] : [HistorySource.SIDECAR],
      // The sidecar stays the metrics source whenever it exists: it carries real operation counts,
      // token estimates, timing and repository attribution. The durable record carries none of
      // those — see the module comment.
      metricsSource: HistorySource.SIDECAR,
      uploadable: true,
    });
    if (inDurable) counts.both += 1;
    else counts.sidecarOnly += 1;
  }
  for (const sessionId of durableIds) {
    if (sidecarIds.has(sessionId) || excluded.has(sessionId)) continue;
    candidates.push({
      sessionId,
      sources: [HistorySource.DURABLE],
      // Null, not 'durable': there IS no source of whole-session metrics for this candidate, and
      // naming one would imply numbers that do not exist.
      metricsSource: null,
      uploadable: false,
    });
    counts.durableOnly += 1;
  }
  counts.total = candidates.length;

  return {
    account,
    sidecar: { available: true, count: sidecarIds.size },
    durable: {
      available: durable.available,
      // An unavailable source reports NO count. A zero here would be read as "no pre-install
      // history exists", which is the false fact this whole module is arranged to avoid.
      count: durable.available ? durableIds.size : null,
      reason: durable.available ? (durable.reason == null ? 'complete' : durable.reason) : 'unavailable',
      truncated: durable.truncated,
    },
    candidates,
    counts,
    // Sidecar-backed candidates are uploadable by the existing audit/sync paths; this module does
    // not upload anything itself.
    uploadable: 0,
    unsupported: {
      durableOnly: counts.durableOnly,
      reason: 'no-approved-snapshot-contract',
    },
    uploadEnabled: HISTORY_UPLOAD_ENABLED,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The dry-run report. Counts and provenance only.
export function renderHistorySummary(index) {
  const lines = [];
  lines.push(
    `Beezi: ${plural(index.sidecar.count, 'conversation')} recorded by this plugin ` +
      `(${index.counts.both} of them also in Cursor's own storage).`,
  );

  if (!index.durable.available) {
    lines.push(
      "  Cursor's own conversation storage could not be read on this machine, so how much history " +
        'predates this plugin is unknown. It is not zero — it is unmeasured.',
    );
  } else if (index.counts.durableOnly > 0) {
    lines.push(
      `  ${index.durable.truncated ? 'At least ' : ''}${plural(index.counts.durableOnly, 'conversation')} ` +
        `${index.counts.durableOnly === 1 ? 'exists' : 'exist'} only in Cursor's own storage — from before this plugin was installed, or older than ` +
        'the 14 days it keeps.',
    );
    lines.push(
      '  Those cannot be uploaded. Cursor records priced overage for them, not a total cost, token ' +
        'counts or a duration, so uploading them would report numbers nobody measured.',
    );
  } else if (index.durable.truncated) {
    lines.push(
      `  The scan of Cursor's own storage stopped early (${index.durable.reason}), so this is a ` +
        'floor: at least this much history exists.',
    );
  }

  if (index.counts.active > 0) {
    lines.push(`  ${plural(index.counts.active, 'conversation')} are still active and were not counted.`);
  }
  if (index.counts.oversize > 0) {
    lines.push(`  ${plural(index.counts.oversize, 'conversation')} were too large to read.`);
  }
  return lines;
}
