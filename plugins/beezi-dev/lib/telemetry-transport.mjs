// Bounded, AUTHORIZATION-FREE delivery of consented diagnostics.
//
// Deliberately takes no token and sends no machineHeaders(): the whole point of the public
// ingestion route is that losing OAuth must not also lose the evidence about losing it. There is
// no Authorization, no Cookie, no X-Beezi-* header and no hostname on the wire, and this module
// imports nothing from token.mjs or machine-identity.mjs, so a diagnostic send can never trigger a
// token refresh. The absent token parameter is the guarantee — do not add one.
//
// The wire shape is pinned to the portal at commit 871a78842f9b7c20808e23b7bc61765886ce85cb:
//   api/src/application/cli-agent/dto/public-plugin-diagnostics.request.dto.ts   (envelope)
//   api/src/application/cli-agent/dto/plugin-diagnostics.request.dto.ts          (event)
//   api/src/application/cli-agent/utils/public-diagnostic-event.validator.ts     (per-event rules)
//   api/src/application/cli-agent/guards/public-diagnostics-intake.guard.ts      (32 KiB, identity)
// The per-event validator runs class-validator with `forbidNonWhitelisted`, so ONE undeclared key
// rejects that event. Everything below is therefore an allowlist, never a spread.
import path from 'path';
import { apiBase } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';
import { readJsonBounded } from './http.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { isTelemetryGranted, isCorrelationGranted } from './telemetry-consent.mjs';
import {
  telemetryQueueDir,
  telemetrySendStateFile,
  listQueueFiles,
  unlinkQuietly,
  purgeAllPending,
  purgeCorrelatedPending,
  DIAGNOSTICS_PATHS,
} from './telemetry-store.mjs';
import { applyTelemetryRetention } from './telemetry-recorder.mjs';
import fs from 'fs';

export { DIAGNOSTICS_PATHS };

export const DIAGNOSTICS_SCHEMA_VERSION = 2;
export const MAX_EVENTS_PER_BATCH = 50;
// The route answers 413 above 32 KiB. Aim under it so a routine batch is not a routine 413.
export const MAX_BODY_BYTES = 28 * 1024;
// Sealed events are named for their eventId; a pending event is named for its fold key. The prefix
// is what tells "still accumulating occurrences" from "frozen and awaiting delivery".
const SEALED_PREFIX = 'evt-';
const SAFE_EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Exported because the worker's window claim writes this record too, and a literal on that side
// would invalidate every send-state the day this moves.
export const SEND_STATE_VERSION = 1;
export const SEND_BACKOFF_MS = Object.freeze([60000, 120000, 300000, 900000, 1800000, 3600000]);
export const MIN_SEND_INTERVAL_MS = 60000;
// Nothing is retried after a permanent refusal, so the only reason to loop is a 413 split or a
// backlog; four round trips keeps a worker short-lived.
const MAX_REQUESTS_PER_RUN = 4;
// One run never considers more than the recorder's own cap, so a readdir here is bounded.
const MAX_PER_RUN = 200;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

// Exactly the keys the deployed event DTO declares. `claudeCodeVersion` is deliberately absent: it
// is a Claude-only field, and the plan forbids putting a Cursor host version on the wire until a
// backend DTO revision permits one. `durationMs` and `cursorVersion` are recorded locally and are
// absent here for the same reason — an undeclared key rejects the event.
export const WIRE_FIELDS = Object.freeze([
  'eventId', 'code', 'source', 'site', 'errorName', 'errorCode', 'httpStatus',
  'pluginVersion', 'nodeVersion', 'os', 'osRelease', 'arch',
  'count', 'firstSeenAt', 'lastSeenAt',
]);
// Present only when they carry a value: each is `@IsOptional()` with an enum or UUID rule, and a
// null would be accepted but says nothing.
export const OPTIONAL_WIRE_FIELDS = Object.freeze(['installationId', 'authState', 'reason']);

// CONTRACTS.md §8 names this code `auth_state_transition`; the deployed `PluginDiagnosticCode`
// enum has `auth_state_changed` and nothing else that means it. Translating to a value the backend
// verifiably has is the conservative move — the alternative is an event rejected with UNKNOWN_CODE
// — and it is done HERE, at the wire, so the local vocabulary stays the contract's.
export const WIRE_CODE_ALIASES = Object.freeze({ auth_state_transition: 'auth_state_changed' });

// Pinned cross-repo vocabularies, copied from the enums at the commit above. A value the server
// does not know rejects the whole EVENT (UNKNOWN_CODE / UNKNOWN_REASON), so an unknown `reason` or
// `authState` is dropped from the event rather than allowed to destroy it.
const BACKEND_CODES = new Set([
  'hook_crash', 'hook_unhandled_rejection', 'queue_file_quarantined', 'queue_flush_http_error',
  'token_refresh_failed', 'transcript_parse_failed', 'mcp_handshake_timeout', 'state_write_failed',
  'auth_state_changed', 'auth_recovered', 'login_failed', 'logout_unlink_unconfirmed',
  'credential_migration_conflict', 'refresh_interrupted', 'mcp_startup_failed',
  'hook_import_failed', 'installation_binding_failed',
]);
const BACKEND_SOURCES = new Set([
  'checkpoint', 'stop', 'stop_failure', 'report', 'session_start', 'track_prompt', 'usage_ping',
  'pulse', 'statusline', 'mcp_bridge', 'backfill', 'sync', 'login', 'telemetry_flush',
  'subagent_start', 'subagent_stop', 'unknown', 'refresh_worker', 'logout', 'me',
  'diagnostics_worker',
]);
const BACKEND_AUTH_STATES = new Set([
  'ready', 'unlinked', 'refreshing', 'unavailable', 'reauth_required',
]);
const BACKEND_REASONS = new Set([
  'ok', 'recovered', 'no_credentials', 'logged_out', 'storage_unavailable', 'storage_conflict',
  'lock_timeout', 'refresh_in_progress', 'refresh_timeout', 'refresh_network_error',
  'refresh_server_error', 'refresh_interrupted', 'refresh_storage_failed', 'refresh_spawn_failed',
  'verification_unavailable', 'rate_limited', 'invalid_grant', 'invalid_client',
  'missing_refresh_token', 'consent_required', 'forbidden', 'unauthorized', 'probe_unreachable',
  'login_cancelled', 'discovery_failed', 'registration_failed', 'exchange_failed',
  'binding_conflict',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─── the request

// Seconds or an HTTP-date, per RFC 9110. Anything else, or a value past an hour, reads as absent,
// so a hostile or broken header cannot park the queue indefinitely.
export function retryAfterMs(header, now = Date.now()) {
  if (header == null) return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  // Every HTTP-date spelling RFC 9110 permits names a weekday and a month, so a value with no
  // three-letter word in it is not one. Without this guard `Date.parse` happily reads `-5` as a
  // year and `1.5` as a January date, and a malformed header becomes a delay nobody intended.
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const delta = at - now;
  return delta <= 0 ? 0 : Math.min(delta, MAX_RETRY_AFTER_MS);
}

// Resolves `{ status, retryAfterMs, body }`; throws only on transport failure or timeout, which
// the caller treats as "preserve and retry".
//
// `redirect: 'error'` is the header-injection guard: this request deliberately carries nothing but
// a Content-Type, and a 30x to an attacker-chosen origin is how something else would get added.
// The caller also refuses any 3xx status it is handed, because the pre-Node-18 shim in
// lib/fetch-compat.mjs does not implement `redirect` (it follows up to five hops) — on that path
// there is nothing to forward, since there is no credential on the request at all.
export async function postDiagnostics(url, payload, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const now = deps.now == null ? () => Date.now() : deps.now;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    // Cleared the moment the HEADERS arrive — fetch settles there, not at the end of the body.
    clearTimeout(timeout);
  }

  const status = res == null ? 0 : res.status;
  const header = res == null || res.headers == null ? null : res.headers.get('retry-after');
  let body = null;
  // A body is only interesting on a 2xx; every other status is decided by the code alone. The read
  // is bounded by what is LEFT of the same budget the headers spent, so a server that answers and
  // then stalls mid-body cannot outlive the request.
  if (status >= 200 && status < 300) {
    body = await readJsonBounded(res, Math.max(0, timeoutMs - (Date.now() - startedAt)));
  }
  return { status, retryAfterMs: retryAfterMs(header, now()), body };
}

// ─── the envelope

function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

// One stored record → one wire event. An allowlist copy, never a spread.
export function toWireEvent(value) {
  const event = {};
  for (const field of WIRE_FIELDS) {
    event[field] = value[field] === undefined ? null : value[field];
  }
  const aliased = Object.prototype.hasOwnProperty.call(WIRE_CODE_ALIASES, value.code)
    ? WIRE_CODE_ALIASES[value.code]
    : value.code;
  event.code = pick(aliased, BACKEND_CODES, null);
  // A source the deployed enum lacks is neutralized rather than sent: `unknown` is a real member,
  // and losing the source is cheaper than losing the event.
  event.source = pick(value.source, BACKEND_SOURCES, 'unknown');
  if (typeof value.installationId === 'string' && UUID_V4.test(value.installationId)) {
    event.installationId = value.installationId;
  }
  const authState = pick(value.authState, BACKEND_AUTH_STATES, null);
  if (authState !== null) event.authState = authState;
  const reason = pick(value.reason, BACKEND_REASONS, null);
  if (reason !== null) event.reason = reason;
  return event;
}

export function encodeEnvelope(events, installationId) {
  const envelope = { schemaVersion: DIAGNOSTICS_SCHEMA_VERSION };
  if (typeof installationId === 'string' && UUID_V4.test(installationId)) {
    envelope.installationId = installationId;
  }
  envelope.events = events;
  return JSON.stringify(envelope);
}

// Everything the server DTO requires. A record missing any of these would be rejected per-event
// and cost a round trip for nothing.
function isPostableEvent(value) {
  return value != null
    && typeof value === 'object'
    && typeof value.eventId === 'string' && SAFE_EVENT_ID.test(value.eventId)
    && typeof value.code === 'string' && value.code.length > 0
    && typeof value.pluginVersion === 'string' && value.pluginVersion.length > 0
    && Number.isInteger(value.count) && value.count >= 1
    && typeof value.firstSeenAt === 'string' && value.firstSeenAt.length > 0
    && typeof value.lastSeenAt === 'string' && value.lastSeenAt.length > 0;
}

// ─── the queue side

// Freezes each accumulating event into an immutable one, named for its eventId. `rename` is the
// synchronization: it is atomic within a filesystem, so a competing recorder either finds the file
// (and adds an occurrence to what will be sealed) or does not (and starts a NEW event with a NEW
// eventId). An acknowledgement therefore never deletes an occurrence recorded after the seal.
export function sealPending() {
  const dir = telemetryQueueDir();
  let sealed = 0;
  for (const name of listQueueFiles(dir)) {
    if (name.indexOf(SEALED_PREFIX) === 0) continue;
    const filePath = path.join(dir, name);
    const value = readJson(filePath);
    if (!isPostableEvent(value)) { unlinkQuietly(filePath); continue; }
    try {
      fs.renameSync(filePath, path.join(dir, `${SEALED_PREFIX}${value.eventId}.json`));
      sealed += 1;
    } catch { /* another worker sealed it first, or it was pruned mid-pass */ }
  }
  return sealed;
}

function readSealed() {
  const dir = telemetryQueueDir();
  const entries = [];
  for (const name of listQueueFiles(dir)) {
    if (name.indexOf(SEALED_PREFIX) !== 0) continue;
    const filePath = path.join(dir, name);
    const value = readJson(filePath);
    if (!isPostableEvent(value)) { unlinkQuietly(filePath); continue; }
    entries.push({ filePath, event: toWireEvent(value) });
    if (entries.length >= MAX_PER_RUN) break;
  }
  return entries;
}

// The largest an empty envelope can be: `schemaVersion`, an `installationId` UUID and `events`.
// Charged unconditionally so the byte budget can never be underestimated by the envelope deciding
// afterwards that it does carry an id.
const ENVELOPE_OVERHEAD_BYTES = Buffer.byteLength(
  encodeEnvelope([], '00000000-0000-4000-8000-000000000000'), 'utf-8',
);

// The envelope-level identity, and the gate that stops it re-attributing anything.
//
// The server resolves each row as `event.installationId ?? dto.installationId ?? null`
// (public-plugin-diagnostics.service.ts at 871a788). An event recorded while consent was merely
// `on` carries NO id — `toWireEvent` omits the key — so an envelope id would be substituted into
// it, and a machine that later ran `correlate` would have its earlier ANONYMOUS reports attributed
// to the account. That is precisely the guarantee the recorder makes when it stamps at queue time.
//
// So the envelope names an id only when every event in the batch already carries that same one, in
// which case the field is a compact restatement and can substitute nothing.
function sharedInstallationId(batch) {
  if (batch.length === 0) return null;
  const first = batch[0].event.installationId;
  if (typeof first !== 'string' || !UUID_V4.test(first)) return null;
  for (const entry of batch) {
    if (entry.event.installationId !== first) return null;
  }
  return first;
}

// Bounded by count AND by ACTUAL serialized UTF-8 bytes. `String.length` would under-count every
// multibyte character by up to a factor of three, which is exactly how a body sails past a byte
// cap the server measures in bytes. The first entry is always taken: a batch is never empty, and a
// single oversize event has to be attempted once so the 413 path can dispose of it.
function takeBatch(entries, limit) {
  const batch = [];
  let bytes = ENVELOPE_OVERHEAD_BYTES;
  for (const entry of entries.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(entry.event), 'utf-8') + 1;
    if (batch.length > 0 && bytes + size > MAX_BODY_BYTES) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
}

export function readSendState() {
  const raw = readJson(telemetrySendStateFile());
  if (raw == null || raw.version !== SEND_STATE_VERSION) {
    return { attempts: 0, nextAttemptAt: 0, batchLimit: MAX_EVENTS_PER_BATCH };
  }
  return {
    attempts: Number.isInteger(raw.attempts) ? raw.attempts : 0,
    nextAttemptAt: Number.isFinite(raw.nextAttemptAt) ? raw.nextAttemptAt : 0,
    // Clamped on the way in as well as out: a corrupt or hostile value must not be able to park
    // the sender on a zero-event batch, nor to widen it past the route's own array cap.
    batchLimit: Number.isInteger(raw.batchLimit)
      ? Math.min(Math.max(raw.batchLimit, 1), MAX_EVENTS_PER_BATCH)
      : MAX_EVENTS_PER_BATCH,
  };
}

function writeSendState(attempts, nextAttemptAt, batchLimit) {
  try {
    writeJsonSecure(telemetrySendStateFile(), {
      version: SEND_STATE_VERSION,
      attempts,
      nextAttemptAt,
      batchLimit: Math.min(Math.max(batchLimit, 1), MAX_EVENTS_PER_BATCH),
    });
  } catch { /* a machine that cannot write its backoff still must not spin: the trigger's own
                minimum interval is the fallback gate */ }
}

// Preserved: the report is still deliverable later. 401/403 are authorization answers this route
// should never produce, but if a gateway invents one the evidence must survive it; 404/405 mean an
// older API that has not deployed the route yet. 3xx means something redirected a request that
// refuses to be redirected.
const PRESERVING_STATUSES = new Set([401, 403, 404, 405, 408, 429]);
const preserves = (status) => status === 0
  || status >= 500
  || (status >= 300 && status < 400)
  || PRESERVING_STATUSES.has(status);

// Applies a 2xx to the files: only acknowledged events and individually rejected ones go away. An
// event the server neither accepted nor named is kept and re-sent (it dedups on eventId).
//
// A 2xx whose body is not the route's shape is far more often a proxy, a captive portal or a load
// balancer than the route itself, so NOTHING is deleted on it — the server dedups on eventId,
// which makes preserving free, while unlinking destroys the evidence with no retry.
function applyAcknowledgement(batch, body) {
  if (body == null || !Array.isArray(body.acceptedEventIds)) {
    return { removed: 0, offContract: true };
  }
  const accepted = new Set(body.acceptedEventIds);
  const rejected = new Set(
    (Array.isArray(body.rejected) ? body.rejected : [])
      .map((row) => (row == null ? null : row.index))
      .filter((index) => Number.isInteger(index)),
  );
  let removed = 0;
  batch.forEach((entry, index) => {
    if (accepted.has(entry.event.eventId) || rejected.has(index)) {
      if (unlinkQuietly(entry.filePath)) removed += 1;
    }
  });
  return { removed, offContract: false };
}

// Delivers sealed diagnostics over the authorization-free route.
//
// Deliberately records NOTHING about its own failures: a diagnostic about the diagnostics path is
// a loop that feeds itself, and the next worker would fail to deliver it in exactly the same way.
// There is no `recordIssue` call anywhere in this module.
export async function flushDiagnostics(deps = {}) {
  const post = deps.postDiagnosticsImpl == null ? postDiagnostics : deps.postDiagnosticsImpl;
  const now = (deps.now == null ? Date.now : deps.now)();
  const url = deps.url == null ? `${apiBase()}${DIAGNOSTICS_PATHS.public}` : deps.url;
  const result = {
    sent: 0, deleted: 0, kept: 0, requests: 0, status: null, purged: false, offContract: false,
  };

  if (!isTelemetryGranted()) {
    purgeAllPending();
    result.purged = true;
    return result;
  }

  applyTelemetryRetention({ now: () => now });
  sealPending();
  let pending = readSealed();
  if (pending.length === 0) return result;

  const state = readSendState();
  let attempts = state.attempts;
  let nextIn = MIN_SEND_INTERVAL_MS;
  // Halved on a 413, never raised again in the same run, and PERSISTED across runs.
  //
  // Persisting it is what makes the single-event drop reachable. A run makes at most four requests,
  // so a batch of fifty that is refused every time gets to 50 → 25 → 13 → 7 and stops; if the next
  // run started at fifty again, the one impossible event that is refusing the whole batch would be
  // retried forever and nothing else in the queue would ever be delivered. Starting where the last
  // run left off converges to a batch of one, which is the size the disposal branch needs.
  let limit = state.batchLimit;
  // At most once per run. The purge is idempotent, but re-running it on every iteration would cost
  // a full queue read per batch for nothing, and a purge that removed nothing must not be able to
  // stall the loop.
  let correlationSettled = false;

  while (pending.length > 0 && result.requests < MAX_REQUESTS_PER_RUN) {
    // Immediately before EVERY transmission, not once per worker: a run makes up to four requests,
    // and a user who types `beezi telemetry off` between two of them must not have the rest sent.
    if (!isTelemetryGranted()) {
      purgeAllPending();
      result.purged = true;
      return result;
    }
    // The SAME recheck for correlation, and it belongs here for the same reason. `setConsent
    // ('anonymous')` writes the denial first and purges second, deliberately — but the purge can
    // find the delivery lock held by this very worker and be deferred, and scripts/telemetry.mjs
    // then tells the user the correlated reports "are cleared on the next run". Without this, the
    // run that holds the lock went on to send up to three more batches that were ALREADY stamped
    // with the installation ID: the reports the user was promised would be deleted were delivered.
    //
    // Purge-and-re-read rather than stripping the id out of the batch, because deletion is what
    // was promised. An anonymized report is still a report the user asked not to exist.
    if (!correlationSettled && !isCorrelationGranted()) {
      correlationSettled = true;
      result.deleted += purgeCorrelatedPending();
      // Re-read UNCONDITIONALLY, not only when this purge removed something. `pending` holds
      // records already parsed into memory, so a purge that ran somewhere else — `setConsent
      // ('anonymous')` doing its own destructive half while this loop was between batches — leaves
      // this run holding events whose files no longer exist and sending them anyway. The re-read is
      // what makes the deletion stick for the run that is in flight, and it is the whole point of
      // rechecking here rather than trusting the writer.
      pending = readSealed();
      if (pending.length === 0) break;
    }
    const batch = takeBatch(pending, limit);
    if (batch.length === 0) break;
    const installationId = sharedInstallationId(batch);

    let outcome;
    try {
      result.requests += 1;
      outcome = await post(url, encodeEnvelope(batch.map((e) => e.event), installationId), deps);
    } catch {
      // Timeout or transport failure: preserve everything and back off.
      outcome = { status: 0, retryAfterMs: null, body: null };
    }
    result.status = outcome.status;

    if (outcome.status === 413) {
      if (batch.length === 1) {
        // One event alone is over the cap; the same bytes will be refused forever. Disposed of
        // with a local counter, without recording another event about it. The limit stays where it
        // is: the rest of the queue is still under suspicion until something actually succeeds.
        if (unlinkQuietly(batch[0].filePath)) result.deleted += 1;
        pending = pending.slice(1);
        continue;
      }
      limit = Math.max(1, Math.ceil(batch.length / 2));
      // A 413 is a failed attempt like any other. Without this the run ends with `attempts` at
      // zero and a one-minute next-attempt time, so a queue holding one impossible event would be
      // re-attacked every minute until it happened to shrink far enough.
      attempts += 1;
      nextIn = SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)];
      continue;
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      const ack = applyAcknowledgement(batch, outcome.body);
      result.deleted += ack.removed;
      if (ack.offContract) {
        result.offContract = true;
        result.kept = pending.length;
        attempts += 1;
        nextIn = SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)];
        break;
      }
      result.sent += batch.length;
      attempts = 0;
      nextIn = MIN_SEND_INTERVAL_MS;
      // Something got through at this size, so the shrink has done its job and the next run may go
      // back to full batches. Without the reset a single historical 413 would cap every future
      // batch at one event for the life of the machine.
      limit = MAX_EVENTS_PER_BATCH;
      pending = pending.slice(batch.length);
      continue;
    }

    if (preserves(outcome.status)) {
      result.kept = pending.length;
      attempts += 1;
      nextIn = outcome.retryAfterMs == null
        ? SEND_BACKOFF_MS[Math.min(attempts - 1, SEND_BACKOFF_MS.length - 1)]
        : Math.max(outcome.retryAfterMs, MIN_SEND_INTERVAL_MS);
      break;
    }

    // Any other refusal (400, 422, …) is about the bytes, which will never change.
    for (const entry of batch) { if (unlinkQuietly(entry.filePath)) result.deleted += 1; }
    attempts = 0;
    pending = pending.slice(batch.length);
  }

  if (result.kept === 0) result.kept = pending.length;
  writeSendState(attempts, now + nextIn, limit);
  return result;
}
