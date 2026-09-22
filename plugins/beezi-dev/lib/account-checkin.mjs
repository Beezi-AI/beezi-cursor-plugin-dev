import { apiBase } from './config.mjs';
import { postJson as _postJson, readJsonBounded, POST_TIMEOUT_MS } from './http.mjs';
import { getAccessToken as _getAccessToken, authEpoch as _authEpoch } from './token.mjs';
import { readBillingConfig as _readBillingConfig } from './billing-config.mjs';
import { envName as _envName } from './env-identity.mjs';
import { currentAccountKey as _currentAccountKey } from './tracking.mjs';
import { buildCheckInPayload, checkInAccount as _checkInAccount, CheckInOutcome } from './account-sync.mjs';
import { lazyRecordIssue } from './diagnostics-sink.mjs';

// Plan §4 B3 — the one production entry point for the account check-in.
//
// `lib/account-sync.mjs` owns the protocol: the payload allowlist, the fingerprint, the seven-day
// heartbeat, the auth fence and the plan writeback. It deliberately owns NO wiring — it builds no
// URL, reads no file and resolves no token — which is why, until this module existed, it had zero
// callers and the whole subsystem was inert. Everything a call site needs in order to reach it
// lives here, ONCE, for the same reason the payload allowlist lives in one place: three call sites
// each assembling their own scope, their own transport adapter and their own auth pair is three
// chances for one of them to be subtly wrong and fail silently.
//
// The name mirrors the Claude Code plugin's `syncAccountIfNeeded(token, {force, via}, deps)` on
// purpose. The two plugins do the same thing against the same route, and a reader diffing them
// should find one vocabulary rather than two.
//
// NOTHING HERE MAY THROW. Every caller is a hook, a login or a user-facing command for which this
// is best-effort telemetry; a check-in that cannot happen is a check-in that did not happen, never
// a failed session. The whole body is wrapped, and the outcome is RETURNED rather than reported,
// so a caller that cares (a test, a future drain of §4 C3's `pendingCheckIn` marker) can ask.

// `via` NAMES THE CALLER FOR LOCAL REASONING ONLY. It is never a payload field and must never
// become one: the route runs under `forbidNonWhitelisted`, so one unknown key 400s the entire
// check-in rather than dropping that key. It exists so an outcome can be attributed in a log or in
// a test, and `buildCheckInPayload` is the only thing that ever builds a body.
export const CheckInVia = Object.freeze({
  LOGIN: 'login',
  SESSION_START: 'session-start',
  BILLING_CAPTURE: 'billing-capture',
  // Plan §4 C — the stop hook's change-detection path (`lib/stop-account-change.mjs`). Named here
  // rather than spelled as a bare string at that call site for the reason the enum exists at all:
  // a value that only ever appears as a literal is a value the next caller invents a variant of.
  STOP: 'stop',
});

// Outcomes this module adds in FRONT of `CheckInOutcome` — the states in which no check-in was
// attempted at all. They are deliberately not folded into `CheckInOutcome.SKIPPED`, which means
// "the protocol looked and decided not to send"; these mean "the wiring could not produce a
// request", and the two want different answers from whoever reads them.
export const CheckInSkip = Object.freeze({
  NO_TOKEN: 'no-token',
  NO_RECORD: 'no-record',
  NOTHING_TO_REPORT: 'nothing-to-report',
  NO_SCOPE: 'no-scope',
  ERROR: 'error',
});

function skipped(reason) {
  return { outcome: null, successful: false, writeback: null, skipped: reason };
}

// ── the scope

// `checkInAccount` REFUSES an incomplete scope — `SCHEMA/incomplete-scope`, and it looks exactly
// like every other schema refusal. Building the scope here, and reporting a failure to build it as
// its own outcome, is plan §2 C8's "must be logged, not silently SCHEMA-dropped": a machine whose
// check-ins all die on a missing `beeziAccount` must be distinguishable from one whose payload is
// malformed.
//
// `env` is `''` on production — that is the value `envName` returns for prod, not an absence — so
// this is an explicit `== null` / non-string test and NEVER a truthiness one. `scope.env == null`
// is also exactly what `checkInAccount` checks, so a truthy guard here would make every production
// machine on earth silently unreportable while every test with `env: 'staging'` passed.
export function buildCheckInScope(sources) {
  const s = sources == null ? {} : sources;
  let env;
  try {
    // Throws a ConfigError on an invalid BEEZI_CURSOR_ENV. That is an operator typo a second ago,
    // not a user state, and it is the one scope failure worth a diagnostic.
    env = s.envName == null ? _envName(process.env) : s.envName(process.env);
  } catch {
    return { ok: false, reason: 'invalid-env', scope: null };
  }
  if (typeof env !== 'string') return { ok: false, reason: 'invalid-env', scope: null };

  const accountKey = s.currentAccountKey == null ? _currentAccountKey : s.currentAccountKey;
  let beeziAccount = null;
  try {
    // `who` is passed when the caller has a FRESH whoami in hand, together with `tracking: null`,
    // so the answer comes from the probe rather than from a best-effort cache write that may not
    // have landed yet — `recordWhoami` is wrapped in a swallowing try/catch at every call site.
    // A caller with no probe, or one whose probe did not answer, passes null and gets the cached
    // email, which is the only thing a hook could have known anyway.
    beeziAccount = s.who == null
      ? accountKey()
      : accountKey({ who: s.who, tracking: s.tracking === undefined ? null : s.tracking });
  } catch {
    beeziAccount = null;
  }
  // Not a bug, and not filled in with a placeholder: a machine that has never completed a whoami
  // genuinely does not know which Beezi account it reports under, and keying two accounts to one
  // state file is precisely the mis-attribution the scoping exists to prevent.
  if (beeziAccount == null) return { ok: false, reason: 'no-beezi-account', scope: null };

  return { ok: true, reason: null, scope: { env, beeziAccount } };
}

// ── the transport adapter

// `checkInAccount` expects `postJson(endpoint, body, token) -> {ok, status, body}`. `lib/http.mjs`
// exports `postJson(url, token, body, deps) -> Response`. THREE things differ, and every one of
// them fails silently if it is got wrong:
//
//   * the argument order — a swapped pair sends `Bearer [object Object]`, a 401, and a `FAILED`
//     the caller swallows;
//   * path vs URL — a bare `/me/cli-agent/account` makes fetch throw, which reads as `OFFLINE`;
//   * the return shape — handing back the Response works for `.ok` and `.status` and leaves
//     `.body` as a ReadableStream, so the outcome is `SENT` and `successful` is true while
//     `planWriteback` quietly refuses with `no-plan`. That one LOOKS like success.
//
// So the adapter lives here, next to the only thing that uses it, and the tests assert a parsed
// writeback rather than merely a `SENT`.
export function makeCheckInTransport(options) {
  const o = options == null ? {} : options;
  const post = o.postJson == null ? _postJson : o.postJson;
  const timeoutMs = o.timeoutMs == null ? POST_TIMEOUT_MS : o.timeoutMs;
  return async function postCheckIn(endpoint, body, token) {
    const startedAt = Date.now();
    const res = await post(`${apiBase()}${endpoint}`, token, body, { fetchImpl: o.fetchImpl, timeoutMs });
    // ONE budget across headers and body, the same discipline `announceRepo` uses: handing the body
    // a second full timeout would cost twice what the request promised, on a hot path.
    const parsed = await readJsonBounded(res, timeoutMs - (Date.now() - startedAt));
    // A 2xx whose body we could not read IS a check-in that landed. Reporting `null` would make
    // `checkInAccount` answer SCHEMA, leave the heartbeat state unwritten, and re-send the same
    // payload forever on a server whose body reads are slow. `{}` records the success and lets the
    // writeback refuse on its own terms (`no-plan`), which is the truthful outcome.
    const ok = res != null && res.ok === true;
    return { ok, status: res == null ? null : res.status, body: parsed == null && ok ? {} : parsed };
  };
}

// ── the payload

// Everything is taken from the RECONCILED RECORD, not from a second read of the host.
//
// `record.subscriptionType` is where `reconcilePlan` puts the observation's `rawPlan`, which is
// what the server's alias-discovery loop needs. Sourcing it from the record rather than from a
// `readCursorAccount()` of our own means the manual `--plan` path reports too, means a hot path
// never opens state.vscdb twice, and means what we tell the server is exactly what we stored.
//
// `includeSubscriptionStatus` is NEVER passed. Plan §4 E3's column is in no deployed release, and
// under `forbidNonWhitelisted` an undeployed property 400s the whole check-in.
export function checkInPayloadFromRecord(record) {
  if (record == null || typeof record !== 'object') return null;
  return buildCheckInPayload({
    anchor: record.accountAnchor,
    account: { rawPlan: record.subscriptionType },
    record,
  });
}

// Is there anything worth telling the server?
//
// `buildCheckInPayload` omits absent facts rather than sending nulls, so a machine that could
// identify nothing produces `{}` — which validates, hashes and POSTs perfectly happily. An empty
// forced check-in every time `/beezi:refresh` runs on a plan-less machine is pure noise, so an
// identity is the floor: without an `accountUuid` or an `email` the server has no row to upsert.
export function identifiesAnAccount(payload) {
  if (payload == null || typeof payload !== 'object') return false;
  return typeof payload.accountUuid === 'string' || typeof payload.email === 'string';
}

// ── the call

// Check this machine's Cursor account in with the portal, if there is anything to say.
//
//   token    — a bearer token the caller already holds, or null to resolve one. A caller inside a
//              hook has one; `scripts/billing-capture.mjs` does not and passes null.
//   options  — `{ force, via }`. `force` skips the protocol's due gate ONLY (plan §2 C7); it is for
//              a caller that already knows something moved and for which waiting out a seven-day
//              heartbeat would leave the server holding the wrong subscription. `via` is local.
//   deps     — injection seams; every one defaults to the real thing.
//
// Returns `checkInAccount`'s result, or a `{skipped}` shape when no request was attempted. Never
// throws, never rejects.
export async function syncAccountIfNeeded(token, options, deps) {
  const o = options == null ? {} : options;
  const d = deps == null ? {} : deps;
  try {
    const checkIn = d.checkInAccount == null ? _checkInAccount : d.checkInAccount;
    const readBillingConfig = d.readBillingConfig == null ? _readBillingConfig : d.readBillingConfig;
    const getAccessToken = d.getAccessToken == null ? _getAccessToken : d.getAccessToken;
    const authEpoch = d.authEpoch == null ? _authEpoch : d.authEpoch;
    const recordIssue = d.recordIssue == null ? lazyRecordIssue : d.recordIssue;
    const now = d.now == null ? Date.now() : d.now;

    // The record the caller just reconciled, handed over directly. Re-reading billing.json here
    // would be a second file read for an answer already in hand — and, worse, a race: the answer
    // on disk may be the one the caller is about to write.
    const record = d.record === undefined ? readBillingConfig() : d.record;
    if (record == null) return skipped(CheckInSkip.NO_RECORD);

    const payload = checkInPayloadFromRecord(record);
    if (!identifiesAnAccount(payload)) return skipped(CheckInSkip.NOTHING_TO_REPORT);

    const built = buildCheckInScope({
      who: d.who,
      tracking: d.tracking,
      envName: d.envName,
      currentAccountKey: d.currentAccountKey,
    });
    if (!built.ok) {
      // VISIBLE, not silent. This is the failure plan §2 C8 is about: a scope that cannot be built
      // is reported as its own outcome and recorded, rather than reaching `checkInAccount` and
      // coming back as an indistinguishable `SCHEMA`.
      try { recordIssue('account_checkin_scope_failed', { reason: built.reason }); } catch { /* best-effort */ }
      return { ...skipped(CheckInSkip.NO_SCOPE), reason: built.reason };
    }

    let bearer = token;
    if (bearer == null) {
      try { bearer = await getAccessToken(); } catch { bearer = null; }
    }
    // An unlinked machine has nothing to authenticate with and nothing to report. Answering here
    // rather than inside the protocol keeps an offline `/beezi:refresh` from paying for a scope
    // read and a payload hash it can do nothing with.
    if (bearer == null) return skipped(CheckInSkip.NO_TOKEN);

    const auth = {
      // The caller's token, wrapped — the protocol asks for a getter because it re-fences around
      // it, not because it wants to resolve one of its own.
      getToken: async () => bearer,
      // The REAL fence (CONTRACTS §2), same as checkpoint.mjs's sender. It returns a STRING, which
      // is what `checkInAccount`'s three `!==` comparisons need; an object would make every
      // production check-in answer EPOCH_CHANGED while every stubbed test passed.
      authEpoch: () => authEpoch({}),
    };

    const result = await checkIn(payload, auth, {
      postJson: d.postJson == null
        ? makeCheckInTransport({ fetchImpl: d.fetchImpl, timeoutMs: d.timeoutMs })
        : d.postJson,
      scope: built.scope,
      now,
      // Passed so the returned `writeback` is computed against the account we actually asked about.
      // This module does NOT apply it: `lib/billing-config.mjs` owns billing.json and applying a
      // server plan is plan §4 B2's business, not a call site's.
      anchor: record.accountAnchor,
      existingBillingRecord: record,
      force: o.force === true,
    });
    return result == null ? skipped(CheckInSkip.ERROR) : result;
  } catch {
    // Telemetry may never break a session, a login or a command.
    return skipped(CheckInSkip.ERROR);
  }
}

// The `/beezi:refresh` command's check-in, as a NAMED function rather than three arguments buried
// in a script.
//
// A script cannot be imported without running, so this is the only place the force flag that makes
// `/beezi:refresh` work can be asserted at all. Dropping it would make every refresh on an
// unchanged payload answer SKIPPED — silently, and on exactly the run the user asked for because
// they believe the recorded tier is wrong.
//
// `record` is spread LAST on purpose: a caller's fixture bag must not be able to substitute a
// different record for the one that was just reconciled.
export async function reportRefreshedAccount(record, deps) {
  return syncAccountIfNeeded(
    null,
    { force: true, via: CheckInVia.BILLING_CAPTURE },
    { ...(deps == null ? {} : deps), record },
  );
}

export { CheckInOutcome };
