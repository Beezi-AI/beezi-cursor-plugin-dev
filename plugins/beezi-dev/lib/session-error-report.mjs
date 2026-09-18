import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { redactDetail } from './redact.mjs';
import { resolveFetch } from './fetch-compat.mjs';

// The two free-text fields on this payload, with the length the server accepts for each.
//
// The scrub lives HERE, at the transport, and not at each call site. There are two call sites and
// they carry text from completely different places — scripts/stop-failure.mjs sends a failed tool's
// own output, lib/checkpoint.mjs sends the assistant text of a rate-limit event — and a rule that
// has to be remembered at every new call site is a rule that gets forgotten at the third one. This
// function is the last thing that touches the payload before it becomes a request body, so putting
// it here means a caller cannot ship free text past it by accident. `redactDetail` is idempotent
// (see lib/redact.mjs), so a caller that scrubs its own text first — stop-failure does, because it
// needs the redact-before-truncate order for a 2000-character slice — costs a second pass over at
// most a few kilobytes and changes nothing.
//
// The caps are the server's, not ours: `SessionErrorRequestDto` declares 1000 and 4000, and Nest's
// ValidationPipe rejects the WHOLE request with a 400 when either is exceeded. Nothing on this path
// surfaces that — postSessionError swallows its own failures by design, so an over-long field is a
// session error that silently never arrives. Truncation happens after redaction for the same reason
// it does inside redactDetail: cutting first can strand half a credential past its anchor.
const FIELD_CAPS = Object.freeze({
  errorDetails: 1000,
  lastAssistantMessage: 4000,
});

// A timestamp is believable only inside a window a session could actually have happened in. The
// floor rejects an epoch value that is really a flag (`0`, `-1`) or a clock that never got set; the
// ceiling rejects a future stamp, which is a machine with a broken clock rather than an event.
const EARLIEST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
// Anything below this as a NUMBER is seconds, anything at or above it is milliseconds. The two
// ranges cannot overlap for a real timestamp: 1e11 ms is 1973 and 1e11 s is the year 5138.
const SECONDS_CEILING = 1e11;

// Every field `SessionErrorRequestDto` declares, and nothing else. `occurredAt` is here for
// completeness; the caller below always resolves it afterwards.
const WIRE_FIELDS = Object.freeze(['sessionId', 'error', 'errorDetails', 'lastAssistantMessage', 'occurredAt']);

// A PROJECTION onto the DTO, not the caller's object with two fields capped.
//
// `{ ...payload }` copied whatever the caller happened to be holding and then capped the two fields
// it knew the name of, so any other key travelled uninspected, uncapped and unredacted — and the
// two call sites that exist today carry text from completely different places. An allowlist is the
// only shape where adding a third call site cannot widen what leaves the machine, which is exactly
// why the diagnostics path next door is built this way.
//
// Key PRESENCE is still preserved: `/sessions/errors` is a whitelist-validated DTO on this same
// server, and a field materializing out of nothing is how the report endpoint started 400ing an
// entire segment. A field the caller did not send is not one this function invents — hence the
// `in` test rather than a fixed five-key object.
function scrubFreeText(payload) {
  const source = payload == null || typeof payload !== 'object' ? {} : payload;
  const out = {};
  for (const field of WIRE_FIELDS) {
    if (!(field in source)) continue;
    const cap = FIELD_CAPS[field];
    out[field] = cap == null ? source[field] : redactDetail(source[field], cap);
  }
  return out;
}

// An ISO string or an epoch (seconds or milliseconds, as a number or a numeric string) → ISO.
// Anything else — prose, a flag value, a future stamp, an unparseable string — is null, and the
// caller substitutes the injected current time.
export function normalizeOccurredAt(value, now = Date.now()) {
  let ms = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    ms = value < SECONDS_CEILING ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      ms = numeric < SECONDS_CEILING ? numeric * 1000 : numeric;
    } else {
      ms = Date.parse(text);
    }
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  if (ms < EARLIEST_MS || ms > now + FUTURE_SLACK_MS) return null;
  return new Date(ms).toISOString();
}

// When the failure HAPPENED, which is not when this request is made.
//
// A report can be delivered minutes after the turn that produced it — a queued hook, a retried
// audit, a machine that came back online — and a send-time stamp would silently move every delayed
// failure to the moment it was finally delivered. `deps.occurredAt` (from M03's verified input
// normalization) outranks the payload's own field, because the host's capture is the better source
// than whatever a call site filled in; an unusable value in either position falls back to the
// injected clock rather than being sent as-is, since `@IsISO8601()` would 400 the whole request.
function resolveOccurredAt(payload, deps) {
  const now = (deps.now == null ? Date.now : deps.now)();
  const fromDeps = normalizeOccurredAt(deps.occurredAt, now);
  if (fromDeps !== null) return fromDeps;
  if (deps.occurredAt == null) {
    const fromPayload = normalizeOccurredAt(payload == null ? null : payload.occurredAt, now);
    if (fromPayload !== null) return fromPayload;
  }
  return new Date(now).toISOString();
}

// POST one session-error record to Beezi. Fire-and-forget by convention; callers swallow the
// result. Returns { reported, status?, reason? }.
//
// Two call shapes, deliberately. CONTRACTS.md §8 spells this `postSessionError(payload, deps)`
// while the two existing call sites pass the token positionally, so an object in the second
// position is read as `deps` and its `token` is used. Neither form can send without a token.
export async function postSessionError(payload, token, deps = {}) {
  let bearer = token;
  let options = deps;
  if (token !== null && typeof token === 'object') {
    options = token;
    bearer = options.token;
  }
  const fetchImpl = options.fetchImpl == null ? resolveFetch() : options.fetchImpl;
  const post = options.postJsonImpl == null ? postJson : options.postJsonImpl;

  if (payload == null || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  if (!bearer) return { reported: false, reason: 'no-token' };
  try {
    const body = scrubFreeText(payload);
    body.occurredAt = resolveOccurredAt(payload, options);
    // `timeoutMs` is passed through undefined-and-all: postJson's own default is the 3s hook
    // budget, and only a caller that HAS a different budget (the audit's 60s, or what is left of a
    // hook deadline) should be able to change it.
    const res = await post(`${apiBase()}${ENDPOINTS.sessionErrors}`, bearer, body, {
      fetchImpl, timeoutMs: options.timeoutMs,
    });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
