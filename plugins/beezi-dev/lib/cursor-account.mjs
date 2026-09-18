import fs from 'fs';
import path from 'path';
import { readKeys } from './vscdb.mjs';
import * as hostPaths from './paths-cursor.mjs';

// The Cursor subscription tier, used to price the seat half of the cost model. Three sources, in
// descending order of authority:
//   1. state.vscdb -> ItemTable -> cursorAuth/stripeMembershipType  (what Cursor itself believes)
//   2. the CLI's cli-config.json                                    (covers a CLI-only machine)
//   3. the user's own `--plan` self-report                          (covers no-SQLite machines)
//
// A source that yields a string we do not recognize does NOT end the search — its raw value is kept
// (the server turns unmapped plan strings into the discovery query for tiers that shipped after we
// did) while the next source gets a chance to produce a mapped one.

// TODO(P0): unverified — Cursor not installed on the authoring machine.
// The exact strings `cursorAuth/stripeMembershipType` emits are a P0 read. This table is one line
// per accepted string so a newly observed value is a one-line addition. Matching is
// case-insensitive and punctuation-normalized; anything absent maps to 'unknown' and NEVER to a
// paid tier, because a wrong seat rate is charged silently for every seat, every month.
const PLAN_ALIASES = new Map([
  ['free', 'free'],
  ['hobby', 'free'],
  ['free_trial', 'free'],
  ['trial', 'free'],
  ['pro', 'pro'],
  ['pro_plus', 'pro_plus'],
  ['ultra', 'ultra'],
  ['team', 'team'],
  ['teams', 'team'],
  ['team_premium', 'team_premium'],
  ['teams_premium', 'team_premium'],
  ['enterprise', 'enterprise'],
]);

// Deliberately NOT mapped:
//   'start'    — Cursor Start, ₹649/mo, India-only, launched 2026-07-28. Non-USD, so it has no
//                entry in SUBSCRIPTION_PLAN_RATES and must report 'unknown' rather than be
//                approximated against a dollar tier. Documented gap.
//   'business' — no evidence it is the Teams tier rather than a distinct one; mapping it would
//                guess a paid rate.

export const CURSOR_PLANS = Object.freeze([
  'free',
  'pro',
  'pro_plus',
  'ultra',
  'team',
  'team_premium',
  'enterprise',
  'unknown',
]);

// Where an observation came from. Owned here, beside the readers that produce them, because the
// reconciler compares account anchors by this value and a fourth spelling of `state_vscdb` is how
// a match silently becomes an unknown. NOT the same vocabulary as the billing `source` enum in
// lib/billing.mjs: that one names which money stream paid, this one names which file we read.
export const AccountSource = Object.freeze({
  STATE_VSCDB: 'state_vscdb',
  CLI_CONFIG: 'cli_config',
  SELF_REPORT: 'self_report',
});

export function normalizeCursorPlan(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 'unknown';
  const key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\+/g, '_plus')
    .replace(/[\s.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (key === '') return 'unknown';
  const mapped = PLAN_ALIASES.get(key);
  return mapped == null ? 'unknown' : mapped;
}

// TODO(P0): unverified — Cursor not installed on the authoring machine
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

// state.vscdb values are stored as JSON, but a bare string has been observed too; accept both.
function unwrapScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
    return null;
  } catch {
    return trimmed;
  }
}

// Default paths come from lib/paths-cursor.mjs, imported statically. This was a top-level
// `await import()` in a try/catch, from when that module did not exist yet; top-level await needs
// Node 14.8 and the plugin's floor is 13.2. Nothing is lost — paths-cursor imports only `os` and
// `path` and cannot fail to load — and the real degrade was always the try/catch below, which is
// untouched: a path function that throws, or resolves to nothing, still yields null.
function hostPath(fnName) {
  const fn = hostPaths[fnName];
  if (typeof fn !== 'function') return null;
  try {
    const resolved = fn();
    return typeof resolved === 'string' && resolved !== '' ? resolved : null;
  } catch {
    return null;
  }
}

function readVscdbCandidate(deps) {
  const dbFile = deps.stateVscdbFile !== undefined ? deps.stateVscdbFile : hostPath('stateVscdbFile');
  if (!dbFile) return null;
  const read = deps.readKeys == null ? ((file, prefix) => readKeys(file, prefix, deps)) : deps.readKeys;

  const rows = read(dbFile, MEMBERSHIP_KEY);
  if (!Array.isArray(rows)) return null; // null = could not look at all
  const membership = rows.find((r) => r.key === MEMBERSHIP_KEY);
  const raw = membership ? unwrapScalar(membership.value) : null;
  if (raw === null) return null;

  let email = null;
  const emailRows = read(dbFile, EMAIL_KEY);
  if (Array.isArray(emailRows)) {
    const hit = emailRows.find((r) => r.key === EMAIL_KEY);
    email = hit ? unwrapScalar(hit.value) : null;
  }

  return { rawPlan: raw, source: AccountSource.STATE_VSCDB, email };
}

// TODO(P0): unverified — Cursor not installed on the authoring machine.
// The CLI's own config; key spelling is a guess, so several are accepted.
const CLI_CONFIG_FILE = 'cli-config.json';
const CLI_PLAN_FIELDS = ['stripeMembershipType', 'membershipType', 'plan', 'subscription', 'tier'];
const CLI_EMAIL_FIELDS = ['email', 'cachedEmail', 'userEmail'];

function readCliCandidate(deps) {
  let file = deps.cliConfigFile;
  if (file === undefined) {
    const dir = hostPath('cursorConfigDir');
    file = dir ? path.join(dir, CLI_CONFIG_FILE) : null;
  }
  if (!file) return null;
  const readFile = deps.readFile == null ? ((p) => fs.readFileSync(p, 'utf-8')) : deps.readFile;
  let parsed;
  try {
    parsed = JSON.parse(readFile(file));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  let raw = null;
  for (const field of CLI_PLAN_FIELDS) {
    const value = parsed[field];
    if (typeof value === 'string' && value.trim() !== '') {
      raw = value.trim();
      break;
    }
  }
  if (raw === null) return null;

  let email = null;
  for (const field of CLI_EMAIL_FIELDS) {
    if (typeof parsed[field] === 'string' && parsed[field].trim() !== '') {
      email = parsed[field].trim();
      break;
    }
  }
  return { rawPlan: raw, source: AccountSource.CLI_CONFIG, email };
}

function selfReportCandidate(deps) {
  const raw = deps.selfReportedPlan;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return { rawPlan: raw.trim(), source: AccountSource.SELF_REPORT, email: null };
}

// { plan, rawPlan, source, email } for the highest-authority source that produced a value, or null
// when no source did. `plan` is always one of CURSOR_PLANS; `rawPlan` keeps the original string even
// when it did not map, so an unrecognized tier is discoverable server-side instead of vanishing.
export function readCursorAccount(deps = {}) {
  const candidates = [];
  for (const read of [readVscdbCandidate, readCliCandidate, selfReportCandidate]) {
    let candidate = null;
    try {
      candidate = read(deps);
    } catch {
      candidate = null; // a broken source must not break the account read
    }
    if (!candidate) continue;
    const plan = normalizeCursorPlan(candidate.rawPlan);
    const resolved = { ...candidate, plan };
    if (plan !== 'unknown') return resolved;
    candidates.push(resolved);
  }
  // Nothing mapped: surface the highest-authority raw string we did see, so the unmapped value is
  // still reported rather than silently replaced by a lower-authority guess.
  return candidates.length > 0 ? candidates[0] : null;
}
