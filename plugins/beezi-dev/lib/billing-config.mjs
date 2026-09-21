import { billingConfigFile } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { BillingSource, detectThirdPartyProvider, isPlanBearing } from './billing.mjs';

// THE schema version. One constant, exported, so a migration, a writer and a reader can never
// disagree about which shape is current — the v1 record carried the literal `1` in three places
// and nothing tied them together.
export const BILLING_SCHEMA_VERSION = 3;

// How long a plan/identity fact is trusted before it is worth looking again. One window, two
// different questions asked of it — see isStale (nudge the user) and isDue (recheck cheaply).
export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export function readBillingConfig() {
  return readJson(billingConfigFile());
}

export function writeBillingConfig(obj) {
  writeJsonSecure(billingConfigFile(), obj);
}

// ── account anchor ────────────────────────────────────────────────────────────────────────────
//
// The anchor answers "whose plan is this?". It is deliberately NOT the same thing as the record's
// `source` field: that one names the money stream (the BillingSource enum), this one names where
// the observation came from (`state_vscdb` / `cli_config` / `self_report`). Two different words
// called `source` in the same file is how an identity comparison ends up reading a billing enum.

const MAX_EMAIL_LENGTH = 254;

// Normalized for COMPARISON, not for display: an address we cannot parse is not a weaker identity,
// it is no identity at all, and must fall to `null` so it can never be compared as if it were one.
export function normalizeAccountEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null;
  if (at === trimmed.length - 1) return null;
  return trimmed;
}

// An id is stored VERBATIM — trimmed, required non-empty, and never capped or split. See the same
// rule and its reasoning in lib/cursor-account.mjs: a truncated id is a wrong id, and a wrong id
// points at a subscription that does not exist.
export function normalizeAccountIdentifier(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

// `{ email, accountId, subscriptionId, source }` or null. A source is mandatory: an anchor without
// one cannot say which read produced the identity, and that is exactly the pairing the reconciler
// must never invent. Every OTHER field is independently optional — an anchor with an id and no
// email is what a machine whose Cursor has not cached an address looks like, and an anchor with an
// email and no id is what every pre-v3 record and every CLI-config machine looks like. Requiring
// both would throw away the stronger half of each.
//
// `accountId` is this SEAT's identity and is the only one that may ever go on the wire.
// `subscriptionId` is the subscription the seat belongs to, kept locally as a switch signal only.
export function normalizeAccountAnchor(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.source !== 'string' || raw.source.trim() === '') return null;
  return {
    email: normalizeAccountEmail(raw.email),
    accountId: normalizeAccountIdentifier(raw.accountId),
    subscriptionId: normalizeAccountIdentifier(raw.subscriptionId),
    source: raw.source.trim(),
  };
}

// ── migration ─────────────────────────────────────────────────────────────────────────────────

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function normalizeRecord(raw, version) {
  return {
    version,
    source: stringOrNull(raw.source) == null ? BillingSource.SUBSCRIPTION : raw.source,
    plan: stringOrNull(raw.plan),
    subscriptionType: stringOrNull(raw.subscriptionType),
    rateLimitTier: stringOrNull(raw.rateLimitTier),
    capturedAt: isoOrNull(raw.capturedAt),
    identityCheckedAt: isoOrNull(raw.identityCheckedAt),
    migratedAt: isoOrNull(raw.migratedAt),
    accountAnchor: normalizeAccountAnchor(raw.accountAnchor),
    // Stripe's own word for the state of the subscription (`active`, `past_due`, ...). Evidence
    // only: nothing in this plugin gates on it, because a plan we can price must not become
    // unpriceable just because a status string was unfamiliar. It exists so a cancelled seat that
    // is still labelled `pro` is distinguishable from a paying one, later and deliberately.
    subscriptionStatus: stringOrNull(raw.subscriptionStatus),
    // When the host was last LOOKED AT, whether or not the look produced anything. Distinct from
    // `capturedAt` (when a plan was observed) and `identityCheckedAt` (when an account was
    // confirmed): a machine that has no plan at all learns nothing from either of those, and
    // without this stamp it would re-read the host on every single session start.
    lastPlanReadAttemptAt: isoOrNull(raw.lastPlanReadAttemptAt),
    capturedBy: stringOrNull(raw.capturedBy) == null ? 'manual' : raw.capturedBy,
    selfReported: raw.selfReported === true,
  };
}

// Up to the current version, tolerantly. Returns `{ record, migrated }`; `migrated` is true only
// when the stored shape actually changed, so a caller knows whether a write is owed.
//
// `capturedAt` is COPIED, never restamped. It is the only record of when the plan was observed,
// and a schema rewrite observes nothing — a migration that refreshed it would make an old user's
// tier look freshly confirmed on every upgrade (BILL-V01). `migratedAt` records the rewrite, and
// `identityCheckedAt` starts null because a v1 record never checked an identity.
//
// `credentialsExpiresAt` is dropped rather than carried: Cursor exposes no vendor credential
// expiry, so the field could only ever hold a value no current input can produce. Dropping it IS
// ignoring it, and it keeps the v2 shape honest about what it can answer.
export function migrateBillingRecord(raw, options) {
  const opts = options == null ? {} : options;
  const now = opts.now == null ? Date.now() : opts.now;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { record: null, migrated: false };
  }
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1;
  // A record written by a NEWER client keeps every field it came with; only the ones this version
  // understands are normalized on top. Returning `normalizeRecord` alone would drop whatever that
  // client added, which is a downgrade dressed up as a read. `reconcilePlan` additionally refuses
  // to rewrite such a record unless the user forces it.
  if (version > BILLING_SCHEMA_VERSION) {
    return { record: { ...raw, ...normalizeRecord(raw, version) }, migrated: false };
  }
  if (version === BILLING_SCHEMA_VERSION) {
    return { record: normalizeRecord(raw, version), migrated: false };
  }
  const record = normalizeRecord(raw, BILLING_SCHEMA_VERSION);
  // v1 -> anything: a v1 record never checked an identity and never recorded a read attempt, so
  // both stamps start null. This clause is SPECIFIC TO v1 and must stay that way — running a v2
  // record through it would erase two stamps that record real events, which is the opposite of a
  // migration. The v2 -> v3 step adds fields and touches nothing else: `normalizeRecord` has
  // already filled `accountId`, `subscriptionId` and `subscriptionStatus` with null, because a v2
  // record simply does not carry them.
  if (version < 2) {
    record.identityCheckedAt = null;
    record.lastPlanReadAttemptAt = null;
  }
  record.migratedAt = new Date(now).toISOString();
  return { record, migrated: true };
}

// ── freshness ─────────────────────────────────────────────────────────────────────────────────

function lastLookedAt(record) {
  const stamps = [];
  for (const value of [record.lastPlanReadAttemptAt, record.identityCheckedAt, record.capturedAt]) {
    const parsed = Date.parse(value == null ? '' : value);
    if (!Number.isNaN(parsed)) stamps.push(parsed);
  }
  return stamps.length === 0 ? null : Math.max.apply(null, stamps);
}

// Is the record bad enough to NAG THE USER about? This drives the session-start message, so it is
// deliberately conservative: a self-reported plan is exempt from ageing, because nagging someone
// weekly about a fact only they can supply and have already supplied is how a nudge gets ignored.
//
// `isPlanBearing` replaces the old `source === SUBSCRIPTION` test: a credit-funded machine still
// rides a paid seat and still has a tier worth knowing (BILL-08).
export function isStale(config, now = Date.now(), staleMs = RECHECK_MS) {
  if (!config) return true;
  const record = migrateBillingRecord(config, { now }).record;
  if (record == null) return true;
  if (!isPlanBearing(record.source)) return false;
  if (!record.plan || record.plan === 'unknown') return true;
  if (record.selfReported) return false;
  const capturedAt = Date.parse(record.capturedAt == null ? '' : record.capturedAt);
  if (Number.isNaN(capturedAt)) return true;
  return now - capturedAt > staleMs;
}

// Is it worth LOOKING AGAIN, cheaply and silently? Unlike isStale this does NOT exempt a
// self-report: the deterministic `--from-cursor` read costs one SQLite lookup and is the only way
// a machine notices that the user switched accounts or changed tier since they typed it (BILL-05).
// A caller uses this to decide whether to attempt a recheck, never to decide what to tell the user.
export function isDue(config, now = Date.now(), recheckMs = RECHECK_MS) {
  if (!config) return true;
  const record = migrateBillingRecord(config, { now }).record;
  if (record == null) return true;
  if (!isPlanBearing(record.source)) return false;
  // The attempt stamp is consulted BEFORE the plan test, and that order is the whole point. A
  // machine with no plan is permanently "plan unknown", so a plan-only test says "due" on every
  // session start forever - and the read it triggers is an uncached SQLite scan that can fall
  // through to copying the whole database. Having looked and found nothing is a reason to wait.
  const attempted = Date.parse(record.lastPlanReadAttemptAt == null ? '' : record.lastPlanReadAttemptAt);
  if (!Number.isNaN(attempted) && now - attempted < recheckMs) return false;
  if (!record.plan || record.plan === 'unknown') return true;
  const last = lastLookedAt(record);
  if (last == null) return true;
  return now - last >= recheckMs;
}

// The report payload keys for the subscription plan, or {} when not applicable. The Claude Code and
// Codex forks never emit a source `isPlanBearing` accepts beyond SUBSCRIPTION, so this file still
// behaves identically in all three.
export function subscriptionReportFields(billingSource, config) {
  if (!isPlanBearing(billingSource) || !config) return {};
  // A key we have no value for is OMITTED, never sent as an explicit null. Absent and null are
  // different instructions to the upsert on the other end: absent says "I have nothing to say
  // about this column", null says "set this column to null". That distinction only started
  // mattering when session start began reconciling billing on the first due start - before that
  // the manual CLI was the only writer of billing.json, and a plan-less machine never reached
  // here. A machine that has looked and found no plan must not overwrite a plan the backend
  // already learned from somewhere else.
  const fields = {};
  if (config.subscriptionType != null) fields.subscription_type = config.subscriptionType;
  if (config.rateLimitTier != null) fields.rate_limit_tier = config.rateLimitTier;
  if (config.plan != null) fields.subscription_plan = config.plan;
  return fields;
}

// The report payload key naming the third-party provider, or {} when billing is not third-party
// (or the provider can't be identified from the env). Env-based — no persisted config needed.
export function thirdPartyReportFields(billingSource, env = process.env) {
  if (billingSource !== BillingSource.THIRD_PARTY) return {};
  const provider = detectThirdPartyProvider(env);
  return provider ? { third_party_provider: provider } : {};
}
