import fs from 'fs';
import path from 'path';
import { readKeys } from './vscdb.mjs';
// Default paths come from lib/paths-cursor.mjs, imported statically. This was a top-level
// `await import()` in a try/catch, from when that module did not exist yet; top-level await needs
// Node 14.8 and the plugin's floor is 13.2. Nothing is lost — paths-cursor imports only Node
// builtins and lib/env-identity.mjs, does no work at import time, and so cannot fail to load — and the real degrade was always the try/catch inside `hostPath`,
// now shared from that module, which is untouched: a path function that throws, or resolves to
// nothing, still yields null.
import { hostPath } from './paths-cursor.mjs';

// The Cursor subscription tier, used to price the seat half of the cost model. Three sources, in
// descending order of authority:
//   1. state.vscdb -> ItemTable -> cursorAuth/stripeMembershipType  (what Cursor itself believes)
//   2. the CLI's cli-config.json                                    (covers a CLI-only machine)
//   3. the user's own `--plan` self-report                          (covers no-SQLite machines)
//
// A source that yields a string we do not recognize does NOT end the search — its raw value is kept
// (the server turns unmapped plan strings into the discovery query for tiers that shipped after we
// did) while the next source gets a chance to produce a mapped one.

// VERIFIED 2026-09-21 on a real machine — %APPDATA%\Cursor\User\globalStorage\state.vscdb,
// table ItemTable:
//
//   cursorAuth/cachedEmail              => "uliana.gerek@gmail.com"
//   cursorAuth/stripeMembershipType     => "pro"
//   cursorAuth/stripeMembershipAuthId   => "auth0|user_01KESV726FDEFJEV6CX7GHWQ8T"
//   cursorAuth/stripeSubscriptionStatus => "active"
//   cursorAuth/cachedSignUpType         => "Auth_0"
//   cursorAuth/cachedScopedProfile      => "{\"displayName\":\"Uliana Herek\"}"
//   glass.lastSignedInAuthId            => "auth0|user_01KESV726FDEFJEV6CX7GHWQ8T"
//   adminSettings.cachedAuthId          => "auth0|user_01KESV726FDEFJEV6CX7GHWQ8T"
//
// That machine is a PERSONAL `pro` seat, where all three id keys agree. Team-plan divergence —
// where `stripeMembershipAuthId` is plausibly the paying OWNER while the other two name this seat
// — is reasoned, not observed, and is still treated as real: see ACCOUNT_ID_KEYS for why guessing
// the other way is unrecoverable.
//
// This table is one line
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

// Verified above, 2026-09-21. These four share one prefix, so one database open answers them all
// — see readVscdbCandidate.
const CURSOR_AUTH_PREFIX = 'cursorAuth/';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';
// LOCAL ONLY, and never the account id. On a Team plan this is plausibly the PAYING OWNER's
// identity rather than this seat's, so it is kept in billing.json purely as a subscription-switch
// signal — it does not go on the wire until there is a server field that means "the subscription
// this seat belongs to".
const MEMBERSHIP_ID_KEY = 'cursorAuth/stripeMembershipAuthId';
const STATUS_KEY = 'cursorAuth/stripeSubscriptionStatus';

// THE ACCOUNT-ID CHAIN, IN FULL. Two elements, written as a frozen literal rather than an `a || b`
// fallback expression so there is no third slot for anyone to append MEMBERSHIP_ID_KEY into later.
//
// Both entries are PER-SEAT identities; the membership id is deliberately absent. On a Team machine
// whose keys diverge, a seat whose signed-in key happened to be missing would fall through to the
// owner's id, and every member would then upsert the same `account_uuid`. The server's
// late-arriving-id merge DELETES the row it absorbs, and no endpoint undoes it — one such check-in
// collapses a whole team into a single account, permanently. When neither key answers, the account
// id stays null and the field is omitted downstream: that costs an email-only provisional row,
// which the next good check-in absorbs cleanly. Absent is cheap; shared is unrecoverable.
const ACCOUNT_ID_KEYS = Object.freeze(['glass.lastSignedInAuthId', 'adminSettings.cachedAuthId']);

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

// An account or subscription identifier, VERBATIM. Trimmed, required non-empty, and nothing else:
// no splitting on `|`, no stripping of the `auth0|` / `samlp|` provider prefix, and above all NO
// LENGTH CAP. A truncated id is a wrong id, and a wrong id mints a phantom subscription row that
// never reconciles with the real one. Auth0 enterprise connections mint
// `samlp|<connection>|<nameId>` where the nameId is usually an email address, which runs well past
// the 64 characters the server column holds today; the answer to that is widening the column, not
// capping what we read. This is also why ids never travel through billing-capture's `safeField`,
// whose 64-character ceiling would silently drop exactly the SSO seats this feature targets.
function identifierOrNull(value) {
  const unwrapped = unwrapScalar(value);
  if (typeof unwrapped !== 'string') return null;
  const trimmed = unwrapped.trim();
  return trimmed === '' ? null : trimmed;
}

// Stripe's subscription status, bounded to one lowercase token. It is EVIDENCE, never a gate: a
// status we have never seen — or one Stripe adds next year — normalizes to null and the plan
// resolves exactly as it would have. Suppressing a plan because its status word was unfamiliar
// would price a paying seat at zero on the strength of a spelling.
const STATUS_TOKEN = /^[a-z_]{1,32}$/;

function statusOrNull(value) {
  const unwrapped = unwrapScalar(value);
  if (typeof unwrapped !== 'string') return null;
  const token = unwrapped.trim().toLowerCase();
  return STATUS_TOKEN.test(token) ? token : null;
}

// The raw stored value for one exact key out of a readKeys result, or null. A null/absent result
// set and a key that is simply not there are the same answer here: nothing to unwrap.
function valueAt(rows, key) {
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((r) => r.key === key);
  return hit ? hit.value : null;
}

function readVscdbCandidate(deps) {
  const dbFile = deps.stateVscdbFile !== undefined ? deps.stateVscdbFile : hostPath('stateVscdbFile');
  if (!dbFile) return null;
  const read = deps.readKeys == null ? ((file, prefix) => readKeys(file, prefix, deps)) : deps.readKeys;

  // Every readKeys call OPENS the database, and can fall through to copying it when Cursor holds a
  // lock, so the four cursorAuth/ keys are fetched as ONE prefix scan. Only the id keys, which sit
  // under different prefixes, cost an open of their own — and the second one only when the first
  // came back empty.
  const authRows = read(dbFile, CURSOR_AUTH_PREFIX);
  if (!Array.isArray(authRows)) return null; // null = could not look at all
  const raw = unwrapScalar(valueAt(authRows, MEMBERSHIP_KEY));
  if (raw === null) return null;

  const email = unwrapScalar(valueAt(authRows, EMAIL_KEY));
  const subscriptionId = identifierOrNull(valueAt(authRows, MEMBERSHIP_ID_KEY));
  const status = statusOrNull(valueAt(authRows, STATUS_KEY));

  // First key that answers wins; when neither does, the id stays null. The loop IS the whole
  // chain — there is nothing after it, by design (see ACCOUNT_ID_KEYS).
  let accountId = null;
  for (const key of ACCOUNT_ID_KEYS) {
    accountId = identifierOrNull(valueAt(read(dbFile, key), key));
    if (accountId !== null) break;
  }

  return { rawPlan: raw, source: AccountSource.STATE_VSCDB, email, accountId, subscriptionId, status };
}

// TODO(P0): the PLAN key spellings are still unverified — see lib/hook-dump.mjs. The IDENTITY is
// not: VERIFIED 2026-09-24 on a real CLI machine, `~/.cursor/cli-config.json` nests it as
// `authInfo.email` and `authInfo.authId`, both equal to that machine's state.vscdb anchor, and the
// file carries NO plan key at all. So a CLI-only machine's config is an identity source first and
// a plan source only if a future CLI starts writing one.
const CLI_CONFIG_FILE = 'cli-config.json';
const CLI_PLAN_FIELDS = ['stripeMembershipType', 'membershipType', 'plan', 'subscription', 'tier'];
// The pre-2026-09-24 guesses, kept as a FALLBACK for the email only. None of them was ever observed,
// and there is deliberately no top-level id spelling beside them: an id nobody has seen in the wild
// is an id we would be guessing the meaning of.
const CLI_EMAIL_FIELDS = ['email', 'cachedEmail', 'userEmail'];
// `authInfo` sits beside the CLI's credentials. These two names are the ENTIRE read surface of that
// object — picked one by one, never spread, never iterated — so a token stored next to them has no
// path into the candidate, billing.json or the wire.
const CLI_AUTH_INFO = 'authInfo';
const CLI_AUTH_EMAIL = 'email';
const CLI_AUTH_ID = 'authId';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

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
    raw = nonEmptyString(parsed[field]);
    if (raw !== null) break;
  }

  const authInfo = parsed[CLI_AUTH_INFO] !== null && typeof parsed[CLI_AUTH_INFO] === 'object'
    ? parsed[CLI_AUTH_INFO]
    : {};
  // The same verbatim rule as the vscdb ids (see identifierOrNull): trimmed, never split, never
  // capped. This is the per-seat signed-in id, not a membership/owner id, which is why it may be an
  // account id at all.
  const accountId = nonEmptyString(authInfo[CLI_AUTH_ID]);
  let email = nonEmptyString(authInfo[CLI_AUTH_EMAIL]);
  if (email === null) {
    for (const field of CLI_EMAIL_FIELDS) {
      email = nonEmptyString(parsed[field]);
      if (email !== null) break;
    }
  }

  // No plan AND no identity is no answer. An identity with no plan IS one: on a CLI-only machine it
  // is the only account anchor there is, and returning null here was why such a machine checked in
  // nothing and every session report went out with no `account_uuid`. `rawPlan: null` is how the
  // caller tells an identity-only candidate from a plan-bearing one.
  if (raw === null && email === null && accountId === null) return null;
  // The CLI keeps no Stripe subscription id or status; both stay explicitly null so a caller never
  // has to distinguish "this source cannot answer" from "this source was not consulted".
  return { rawPlan: raw, source: AccountSource.CLI_CONFIG, email, accountId, subscriptionId: null, status: null };
}

function selfReportCandidate(deps) {
  const raw = deps.selfReportedPlan;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  // A user typing their tier tells us nothing about who they are; every identity field is null.
  return { rawPlan: raw.trim(), source: AccountSource.SELF_REPORT, email: null, accountId: null, subscriptionId: null, status: null };
}

// Does this candidate say who the account is? A source label alone does not.
function identifies(candidate) {
  return candidate != null && (candidate.email != null || candidate.accountId != null);
}

// The winner with the cli-config identity filled in — ONLY when the winner identifies nobody.
//
// A winner that knows even half an identity keeps exactly what it has. state.vscdb and the CLI can
// be signed into DIFFERENT accounts on one machine, and topping a vscdb email up with the CLI's id
// would stitch two accounts into one anchor: the reconciler would then compare, and the server
// would upsert, a seat that exists nowhere. A self-report is the case this exists for — the user
// typed a tier, which says nothing about who they are, and on a CLI-only machine cli-config is the
// only thing that does.
//
// Only `email` and `accountId` move. The winner's `source` is kept, because `selfReported` and the
// staleness exemption key off it: an identity donor must not be able to relabel a typed plan as a
// host read. `subscriptionId` and `status` stay the winner's — the CLI has neither.
function withDonorIdentity(winner, donor) {
  if (winner == null || donor == null || identifies(winner) || winner === donor) return winner;
  return { ...winner, email: donor.email, accountId: donor.accountId };
}

// { plan, rawPlan, source, email, accountId, subscriptionId, status } for the highest-authority
// source that produced a value, or null when no source did. `plan` is always one of CURSOR_PLANS;
// `rawPlan` keeps the original string even when it did not map, so an unrecognized tier is
// discoverable server-side instead of vanishing. The identity fields are always present: state.vscdb
// supplies all three, cli-config supplies `email` and `accountId` (from `authInfo`), and a
// self-report supplies none of its own.
//
// A cli-config that carries an identity but no plan is an IDENTITY-ONLY candidate (`rawPlan:
// null`). It never wins the plan — an unmapped raw string from any source still outranks it, since
// that string is what the server's discovery loop needs — but it donates its identity to a winner
// that has none, and when nothing else answered at all it is returned as `plan: 'unknown'` so a
// CLI-only machine still has an account anchor.
export function readCursorAccount(deps = {}) {
  const candidates = [];
  let donor = null;
  let winner = null;
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
    if (resolved.source === AccountSource.CLI_CONFIG && identifies(resolved)) donor = resolved;
    if (candidate.rawPlan == null) continue; // identity-only: a donor, never a plan answer
    if (plan !== 'unknown') { winner = resolved; break; }
    candidates.push(resolved);
  }
  // Nothing mapped: surface the highest-authority raw string we did see, so the unmapped value is
  // still reported rather than silently replaced by a lower-authority guess. With no raw string at
  // all, the identity-only candidate is still worth returning — it is the whole anchor.
  if (winner == null) winner = candidates.length > 0 ? candidates[0] : donor;
  return withDonorIdentity(winner, donor);
}
