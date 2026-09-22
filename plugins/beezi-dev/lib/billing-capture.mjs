import { detectBillingSource, isPlanBearing } from './billing.mjs';
import { AccountSource, normalizeCursorPlan } from './cursor-account.mjs';
import {
  BILLING_SCHEMA_VERSION,
  RECHECK_MS,
  isDue,
  migrateBillingRecord,
  normalizeAccountAnchor,
  normalizeAccountEmail,
  normalizeAccountIdentifier,
} from './billing-config.mjs';
import { UserError } from './friendly-error.mjs';

// The credential fields are short opaque labels. Anything token-shaped (a secret,
// an over-long string, or embedded whitespace) is refused so a misdirected value
// can never be persisted.
const TOKEN_LIKE = /sk-|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new UserError('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

// Same test, but for a value the HOST produced rather than the user. A weird string out of
// Cursor's own database is a schema surprise, not a mistyped argument: refusing the whole capture
// would turn one odd row into a permanently uncapturable machine, so the raw value is simply
// dropped and the normalized plan stands alone.
function safeHostField(value) {
  try {
    return safeField(value);
  } catch {
    return null;
  }
}

// ── argument parsing

// `--expires-at` accepted a vendor credential expiry that Cursor has never exposed. It stays
// PARSEABLE so an older installed shim or a copied command line does not hard-fail, but the value
// is discarded and the caller is told once. Removing the flag outright is the next major.
const DEPRECATED_FLAGS = Object.freeze(['--expires-at']);

export function parseArgs(argv) {
  const out = { deprecated: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') { i += 1; out.deprecated.push('--expires-at'); }
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--email') out.email = argv[++i];
    else if (flag === '--from-cursor') out.fromCursor = true;
    else if (flag === '--force') out.force = true;
  }
  // The script's --from-cursor branch builds its observation from Cursor's own account record,
  // which would silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromCursor && out.plan != null) {
    throw new UserError('--plan and --from-cursor are mutually exclusive.');
  }
  // An observation is ONE atomic tuple of { plan, source, email }. `--email` exists to anchor a
  // self-report to an account; attaching it to a deterministic read would pair one account's
  // address with another source's plan, which is the exact mis-attribution BILL-05 is about.
  if (out.fromCursor && out.email != null) {
    throw new UserError('--email and --from-cursor are mutually exclusive.');
  }
  return out;
}

export const DEPRECATION_NOTICES = Object.freeze({
  '--expires-at': 'Beezi: --expires-at is deprecated and ignored — Cursor exposes no credential expiry.',
});

export { AccountSource, DEPRECATED_FLAGS };

// ── observations

// Self-reported plans a user can pick in the sign-in fallback. Cursor has **no** `AskUserQuestion`
// equivalent and no `$ARGUMENTS` substitution in commands, so the value reaches this script as free
// text the model composed from a plain-conversation answer. That is exactly why the set is fixed
// and validated here: a mis-composed argument is rejected rather than stored.
//
// `free` IS a member, unlike the Codex plugin's list — Cursor's Hobby tier is a real plan a user
// can be on, and refusing it would push those users to 'unknown' forever.
// Cursor "Start" (₹649/mo, India) is deliberately absent: it is non-USD and has no seat rate in
// SUBSCRIPTION_PLAN_RATES, so it normalizes to 'unknown'. Documented gap.
const SELF_REPORTED_PLANS = Object.freeze([
  'free', 'pro', 'pro_plus', 'ultra', 'team', 'team_premium', 'enterprise',
]);

// `identity` is `{ accountId, subscriptionId, status }` and is optional: only the deterministic
// state.vscdb read can supply one. Its ids go through `normalizeAccountIdentifier`, NOT through
// `safeField` above — `safeField` caps at 64 characters, and an SSO `samlp|<connection>|<nameId>`
// id is routinely longer than that. Truncating it, or dropping it, is how a Team/SSO seat becomes
// permanently email-only.
function observation(plan, rawPlan, rateLimitTier, source, email, via, identity) {
  const id = identity == null ? {} : identity;
  return {
    plan: plan == null || plan === '' ? 'unknown' : plan,
    rawPlan,
    rateLimitTier,
    source,
    email: normalizeAccountEmail(email),
    accountId: normalizeAccountIdentifier(id.accountId),
    subscriptionId: normalizeAccountIdentifier(id.subscriptionId),
    status: typeof id.status === 'string' && id.status !== '' ? id.status : null,
    via: via == null ? null : via,
  };
}

// The typed local account observation for the manual path, or null when the arguments name no
// plan at all. Throws UserError on a value we refuse to store.
export function observationFromArgs(args) {
  const via = safeField(args.via);
  const rateLimitTier = safeField(args.rateLimitTier);
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new UserError(`Unknown plan '${args.plan}'. Valid: ${SELF_REPORTED_PLANS.join(', ')}.`);
    }
    return observation(plan, plan, rateLimitTier, AccountSource.SELF_REPORT, args.email, via);
  }
  const subscriptionType = safeField(args.subscriptionType);
  if (subscriptionType == null) return null;
  return observation(
    normalizeCursorPlan(subscriptionType), subscriptionType, rateLimitTier,
    AccountSource.SELF_REPORT, args.email, via,
  );
}

// The typed observation for the deterministic path. `readCursorAccount` already returns exactly one
// self-contained `{ plan, rawPlan, source, email, accountId, subscriptionId, status }` tuple, so
// nothing is paired here either — the identity travels with the plan it was read beside, or not at
// all.
export function observationFromAccount(account, via) {
  if (account == null || typeof account !== 'object') return null;
  const rawPlan = safeHostField(account.rawPlan);
  return observation(
    account.plan, rawPlan == null ? account.plan : rawPlan, null,
    typeof account.source === 'string' ? account.source : AccountSource.STATE_VSCDB,
    account.email, via == null ? null : safeField(via),
    { accountId: account.accountId, subscriptionId: account.subscriptionId, status: account.status },
  );
}

// ── identity

export const IdentityMatch = Object.freeze({
  MATCH: 'match',
  SWITCH: 'switch',
  UNKNOWN: 'unknown',
});

// ID FIRST, then email. The account id is Cursor's own opaque identity for this seat and does not
// move when a user renames their address, so where both sides have one it is the only thing worth
// asking. Email is the fallback for the population that has no id: every pre-v3 record, every
// CLI-config machine, and any seat whose per-seat key was absent.
//
// A missing identity on EITHER side is `unknown` — not a match, and not a switch. Treating it as a
// match would let an old user's protected tier survive a hand-over; treating it as a switch would
// throw away a perfectly good plan every time Cursor happens not to cache an address.
//
// A changed `subscriptionId` under an unchanged `accountId` is a SWITCH, because that is one seat
// moving between subscriptions and is precisely the event this whole feature exists to notice. It
// counts only when BOTH sides carry one: `null -> something` is this machine LEARNING the id for
// the first time, not the seat moving, and calling that a switch would make the first run after
// every upgrade destroy a stored plan it had no reason to doubt.
export function compareAnchors(observed, existing) {
  if (observed == null || existing == null) return IdentityMatch.UNKNOWN;
  if (observed.accountId && existing.accountId) {
    if (observed.accountId !== existing.accountId) return IdentityMatch.SWITCH;
    if (observed.subscriptionId && existing.subscriptionId
      && observed.subscriptionId !== existing.subscriptionId) return IdentityMatch.SWITCH;
    // Same seat: a differing email is the user having renamed their address, never a hand-over.
    return IdentityMatch.MATCH;
  }
  if (!observed.email || !existing.email) return IdentityMatch.UNKNOWN;
  return observed.email === existing.email ? IdentityMatch.MATCH : IdentityMatch.SWITCH;
}

// ── reconciliation

export const ReconcileOutcome = Object.freeze({
  // Nothing could be observed at all (no SQLite, no CLI config, no argument).
  NO_SOURCE: 'no-source',
  // We looked and the stored facts still hold.
  KEPT: 'kept',
  // A field was filled in or a confirmed fact replaced a different one.
  CHANGED: 'changed',
  // There is no usable plan and only the user can supply one.
  NEEDS_USER: 'needs-user',
  // We looked, learned nothing, and could not confirm whose account this is. The stored plan
  // stands, but nothing about it was verified.
  UNVERIFIED: 'unverified',
});

export const ChangeKind = Object.freeze({
  FILLED: 'filled',
  CHANGED: 'changed',
  PRESERVED: 'preserved',
  UNAVAILABLE: 'unavailable',
  MIGRATED: 'migrated',
  IDENTITY_CHECKED: 'identity-checked',
});

// Only these two are worth putting in front of a user. The rest are bookkeeping.
const MATERIAL_KINDS = Object.freeze([ChangeKind.FILLED, ChangeKind.CHANGED]);

export function isMaterial(changes) {
  if (!Array.isArray(changes)) return false;
  return changes.some((c) => c != null && MATERIAL_KINDS.includes(c.kind));
}

function known(plan) {
  return typeof plan === 'string' && plan !== '' && plan !== 'unknown';
}

function change(kind, field, from, to) {
  return { kind, field, from: from === undefined ? null : from, to: to === undefined ? null : to };
}

function recordFromObservation(obs, anchor, prior, nowIso) {
  // An observation names a PLAN, never a money stream: `detectBillingSource()` has no delta to read
  // here and answers SUBSCRIPTION by construction. Letting that overwrite a stored `cursor_credits`
  // record would tell every later report that a credit-funded machine rides only its seat, and the
  // record would flip between the two every time a different writer touched it.
  const source = prior != null && isPlanBearing(prior.source) ? prior.source : detectBillingSource();
  const planBearing = isPlanBearing(source);
  // Cursor exposes no rate-limit tier, so the deterministic path always observes null. Treating
  // that as "the tier is gone" would erase a value some other path did observe.
  const rateLimitTier = obs.rateLimitTier == null && prior != null ? prior.rateLimitTier : obs.rateLimitTier;
  return {
    version: BILLING_SCHEMA_VERSION,
    source,
    plan: planBearing ? obs.plan : null,
    subscriptionType: planBearing ? obs.rawPlan : null,
    rateLimitTier: planBearing ? rateLimitTier : null,
    capturedAt: nowIso,
    identityCheckedAt: nowIso,
    lastPlanReadAttemptAt: nowIso,
    migratedAt: prior == null ? null : prior.migratedAt,
    accountAnchor: anchor,
    // Read beside the plan, from the same source, in the same pass. A source that observes no
    // status says null rather than inheriting the previous one: unlike the rate-limit tier, a
    // status is a statement about RIGHT NOW, and a stale `active` is worse than no answer.
    subscriptionStatus: obs.status,
    capturedBy: obs.via == null ? 'manual' : obs.via,
    selfReported: obs.source === AccountSource.SELF_REPORT,
  };
}

// An account switch is the only event that may DESTROY a plan. The new account's record keeps the
// identity we just confirmed and nothing else: no tier, no provenance, no capture stamp.
function blankedForSwitch(prior, anchor, nowIso) {
  return {
    version: BILLING_SCHEMA_VERSION,
    source: prior.source,
    plan: null,
    subscriptionType: null,
    rateLimitTier: null,
    capturedAt: null,
    identityCheckedAt: nowIso,
    lastPlanReadAttemptAt: nowIso,
    migratedAt: prior.migratedAt,
    accountAnchor: anchor,
    // The old account's status is as dead as its tier.
    subscriptionStatus: null,
    capturedBy: 'account-switch',
    selfReported: false,
  };
}

// The record a machine that has never captured anything gets, so an attempt stamp has somewhere to
// live. It claims no plan and no identity - only that we looked.
function blankRecord() {
  return {
    version: BILLING_SCHEMA_VERSION,
    source: detectBillingSource(),
    plan: null,
    subscriptionType: null,
    rateLimitTier: null,
    capturedAt: null,
    identityCheckedAt: null,
    lastPlanReadAttemptAt: null,
    migratedAt: null,
    accountAnchor: null,
    subscriptionStatus: null,
    capturedBy: 'manual',
    selfReported: false,
  };
}

// The human-facing name for an anchor, for change entries only — never for comparison. Email
// first because that is the word a user recognizes; the id is the fallback for a seat whose Cursor
// has cached no address.
function anchorLabel(anchor) {
  if (anchor == null) return null;
  if (anchor.email != null) return anchor.email;
  return anchor.accountId;
}

// `observed`, with each field it could not see taken from `stored`. ONLY safe for two anchors
// already known to describe the same account — see the call site. `source` is never backfilled:
// it names which read produced this observation and is a fact about the read, not about the
// account. A field the observation DID see always wins, including a changed email.
function filledFrom(observed, stored) {
  if (observed == null) return stored;
  if (stored == null) return observed;
  return {
    email: observed.email == null ? stored.email : observed.email,
    accountId: observed.accountId == null ? stored.accountId : observed.accountId,
    subscriptionId: observed.subscriptionId == null ? stored.subscriptionId : observed.subscriptionId,
    source: observed.source,
  };
}

// Does this anchor say ANYTHING about who the account is? An anchor that carries only a source is
// a record of having looked, not an identity.
function anchorIdentifies(anchor) {
  return anchor != null && (anchor.email != null || anchor.accountId != null);
}

// Every field, ids included. This drives `persist` in the KEPT branch, so an omission here is not
// a cosmetic one: an anchor that has just LEARNED its accountId while the email stayed the same
// would compare equal, report "nothing changed", and the id would be computed and then thrown away
// unwritten — on every run, forever.
function anchorsEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.email === b.email
    && a.accountId === b.accountId
    && a.subscriptionId === b.subscriptionId
    && a.source === b.source;
}

// One reusable reconcile service. Pure: it reads nothing and writes nothing, so login, the refresh
// script and a bounded session-start check all get the same answer from the same inputs.
//
//   observation — the typed local account observation, or null when no source produced one.
//   existing    — whatever is on disk, at ANY schema version (or null).
//   options     — { now, force }.
//
// Returns `{ outcome, record, changes, persist }`. `record` is what SHOULD be on disk;
// `persist` says whether that differs from what is there now, so the caller never rewrites a file
// to change nothing. (`persist` is additive to CONTRACTS §11 — see the handoff.)
//
// `force` bypasses the seven-day recheck gate so a user who asks for a refresh gets their stamps
// moved immediately. It can never manufacture data: with no observation there is nothing to apply,
// and a forced run over an unreadable source leaves the record exactly as it was.
export function reconcilePlan(observationInput, existing, options) {
  const opts = options == null ? {} : options;
  const now = opts.now == null ? Date.now() : opts.now;
  const force = opts.force === true;
  // Did the caller actually LOOK at the host? A null observation means "looked, found nothing" for
  // the deterministic path and "supplied nothing" for a manual run, and only the first is worth
  // backing off from. Defaults to true whenever an observation exists, because producing one means
  // having looked.
  const attempted = opts.attempted === undefined ? observationInput != null : opts.attempted === true;
  const nowIso = new Date(now).toISOString();

  const migration = migrateBillingRecord(existing, { now });
  const prior = migration.record;
  const changes = [];
  if (migration.migrated) {
    changes.push(change(ChangeKind.MIGRATED, 'version', existing.version == null ? 1 : existing.version, BILLING_SCHEMA_VERSION));
  }

  // ── a record from a newer client
  // Rewriting it in this version's shape would drop whatever that client added. Refuse, and leave
  // `--force` as the documented escape hatch for a user who deliberately rolled the plugin back.
  if (prior != null && typeof prior.version === 'number' && prior.version > BILLING_SCHEMA_VERSION && !force) {
    changes.push(change(ChangeKind.PRESERVED, 'version', prior.version, prior.version));
    return { outcome: ReconcileOutcome.KEPT, record: prior, changes, persist: false };
  }

  // ── nothing was observed
  if (observationInput == null) {
    changes.push(change(ChangeKind.UNAVAILABLE, 'plan', prior == null ? null : prior.plan, prior == null ? null : prior.plan));
    if (!attempted) {
      return { outcome: ReconcileOutcome.NO_SOURCE, record: prior, changes, persist: migration.migrated };
    }
    // We looked and the host had nothing. Remember the ATTEMPT - not a plan, not an identity - so
    // the next session start waits instead of repeating an uncached database read. Everything else
    // about the record, its plan and that plan's freshness included, is untouched.
    const stamped = prior == null
      ? { ...blankRecord(), lastPlanReadAttemptAt: nowIso }
      : { ...prior, lastPlanReadAttemptAt: nowIso };
    return { outcome: ReconcileOutcome.NO_SOURCE, record: stamped, changes, persist: true };
  }

  const obs = observationInput;
  const observedAnchor = normalizeAccountAnchor({
    email: obs.email, accountId: obs.accountId, subscriptionId: obs.subscriptionId, source: obs.source,
  });
  const identity = compareAnchors(observedAnchor, prior == null ? null : prior.accountAnchor);
  // A read that could not SEE an identifier is not a read that says the identifier is gone. Cursor
  // can withhold one for entirely uninteresting reasons — a locked row, a partial WAL snapshot, a
  // sign-out and back in — and writing the blank through would drop a known accountId, send the
  // next check-in with no id, and mint a fresh email-only provisional row on the server. The same
  // reasoning already governs `rateLimitTier` inside recordFromObservation.
  //
  // Gated on MATCH, and that gate is the whole safety of it: backfilling from the previous anchor
  // is only sound when the previous anchor describes the SAME account. On a switch the old seat's
  // id must never ride along onto the new one.
  const anchor = identity === IdentityMatch.MATCH
    ? filledFrom(observedAnchor, prior.accountAnchor)
    : observedAnchor;
  const priorKnown = prior != null && known(prior.plan);
  const due = force || prior == null || isDue(prior, now, RECHECK_MS);

  // ── a confirmed switch to a different account
  if (identity === IdentityMatch.SWITCH) {
    // Name the identity that actually moved. On an id-driven switch both emails can be null, and
    // reporting `null -> null` would describe the one event a user most needs to understand as
    // nothing at all.
    changes.push(change(ChangeKind.CHANGED, 'accountAnchor', anchorLabel(prior.accountAnchor), anchorLabel(observedAnchor)));
    if (known(obs.plan)) {
      changes.push(change(ChangeKind.CHANGED, 'plan', prior.plan, obs.plan));
      return {
        outcome: ReconcileOutcome.CHANGED,
        record: recordFromObservation(obs, observedAnchor, prior, nowIso),
        changes,
        persist: true,
      };
    }
    // The old tier belonged to the old account and cannot be inherited; the new account has told
    // us nothing yet, so the only honest record is "this account, plan unknown".
    changes.push(change(ChangeKind.CHANGED, 'plan', prior.plan, null));
    return {
      outcome: ReconcileOutcome.NEEDS_USER,
      record: blankedForSwitch(prior, observedAnchor, nowIso),
      changes,
      persist: true,
    };
  }

  // ── same account, or an account we cannot identify
  if (known(obs.plan)) {
    const anchorChanged = !anchorsEqual(anchor, prior == null ? null : prior.accountAnchor);
    if (!priorKnown) {
      changes.push(change(ChangeKind.FILLED, 'plan', prior == null ? null : prior.plan, obs.plan));
      return {
        outcome: ReconcileOutcome.CHANGED,
        record: recordFromObservation(obs, anchor, prior, nowIso),
        changes,
        persist: true,
      };
    }
    if (prior.plan !== obs.plan) {
      changes.push(change(ChangeKind.CHANGED, 'plan', prior.plan, obs.plan));
      return {
        outcome: ReconcileOutcome.CHANGED,
        record: recordFromObservation(obs, anchor, prior, nowIso),
        changes,
        persist: true,
      };
    }
    // Same plan, observed again. `capturedAt` DOES move here: the plan really was read a second
    // time, so this is genuine observation freshness rather than a schema restamp.
    if (identity === IdentityMatch.MATCH) {
      changes.push(change(ChangeKind.IDENTITY_CHECKED, 'identityCheckedAt', prior.identityCheckedAt, nowIso));
    }
    if (anchorChanged) {
      changes.push(change(ChangeKind.FILLED, 'accountAnchor', anchorLabel(prior.accountAnchor), anchorLabel(anchor)));
    }
    return {
      outcome: ReconcileOutcome.KEPT,
      record: recordFromObservation(obs, anchor, prior, nowIso),
      changes,
      persist: due || anchorChanged || migration.migrated,
    };
  }

  // ── the source produced no plan we recognize
  if (priorKnown) {
    // Preserve the value AND its provenance. `capturedAt` must not move: nothing about the plan
    // was observed, and an unobserved plan that looks freshly captured is the whole of BILL-V01.
    const kept = {
      ...prior,
      // The identity stamp only moves when the identity was actually confirmed.
      identityCheckedAt: identity === IdentityMatch.MATCH ? nowIso : prior.identityCheckedAt,
      // The read stamp moves either way: we did look, and that is all it records.
      lastPlanReadAttemptAt: nowIso,
      // An observation that learned an ACCOUNT ID but no email is still a better anchor than the
      // stored one; testing the email alone would discard the stronger identity of the two.
      accountAnchor: anchorIdentifies(anchor) ? anchor : prior.accountAnchor,
    };
    changes.push(change(ChangeKind.PRESERVED, 'plan', prior.plan, prior.plan));
    const anchorLearned = !anchorsEqual(kept.accountAnchor, prior.accountAnchor);
    return {
      outcome: identity === IdentityMatch.MATCH ? ReconcileOutcome.KEPT : ReconcileOutcome.UNVERIFIED,
      record: kept,
      changes,
      persist: migration.migrated || identity === IdentityMatch.MATCH || anchorLearned,
    };
  }

  // Nothing stored, nothing observed that names a plan: only the user can close this. The attempt
  // is still recorded, for the same reason as the no-source branch above.
  changes.push(change(ChangeKind.UNAVAILABLE, 'plan', prior == null ? null : prior.plan, null));
  const base = prior == null ? blankRecord() : prior;
  return {
    outcome: ReconcileOutcome.NEEDS_USER,
    record: attempted ? { ...base, lastPlanReadAttemptAt: nowIso } : prior,
    changes,
    persist: attempted || migration.migrated,
  };
}

// ── reporting the outcome

// A skill must not have to parse arbitrary console wording to learn what happened, so every run
// prints exactly one machine-readable line with this prefix. The human lines around it are free to
// be reworded; this one is a contract.
export const RESULT_PREFIX = 'beezi-billing-result:';

export function formatResultLine(result, written) {
  const record = result.record;
  return `${RESULT_PREFIX} ${JSON.stringify({
    outcome: result.outcome,
    plan: record == null || record.plan == null ? null : record.plan,
    source: record == null ? null : record.source,
    anchorSource: record == null || record.accountAnchor == null ? null : record.accountAnchor.source,
    material: isMaterial(result.changes),
    written: written === true,
  })}`;
}

function planChange(changes) {
  for (const entry of changes) {
    if (entry.field === 'plan' && MATERIAL_KINDS.includes(entry.kind)) return entry;
  }
  return null;
}

// Human notices. A short one ONLY for a material change — an unchanged fact reported every session
// is how a user learns to stop reading the plugin's output.
export function noticeFor(result) {
  const record = result.record;
  const plan = record == null || record.plan == null ? 'unknown' : record.plan;
  if (result.outcome === ReconcileOutcome.NO_SOURCE) {
    return [
      'Beezi: no Cursor subscription info found locally — nothing captured.',
      '  This is expected when node:sqlite is unavailable. Use --plan <tier> instead.',
    ];
  }
  if (result.outcome === ReconcileOutcome.NEEDS_USER) {
    const switched = result.changes.some((c) => c.field === 'accountAnchor' && c.kind === ChangeKind.CHANGED);
    return [switched
      ? 'Beezi: this machine is now signed in to a different Cursor account — the previous plan was cleared. Run the beezi-refresh skill to name the new one.'
      : 'Beezi: could not determine your Cursor plan. Run the beezi-refresh skill and pick your tier.'];
  }
  if (result.outcome === ReconcileOutcome.UNVERIFIED) {
    return [`Beezi: kept the recorded Cursor plan (${plan}) — this machine's Cursor account could not be confirmed.`];
  }
  if (result.outcome === ReconcileOutcome.CHANGED) {
    const entry = planChange(result.changes);
    if (entry != null && entry.kind === ChangeKind.CHANGED) {
      return [`✓ Beezi billing updated: plan=${plan} (was ${entry.from == null ? 'unknown' : entry.from}).`];
    }
    return [`✓ Beezi billing captured: source=${record.source} plan=${plan}.`];
  }
  return [`Beezi: Cursor plan unchanged (${plan}).`];
}
