// The structured outcome of one Cursor turn, from its `stop` payload.
//
// The payload says how the turn ended (`status`) and how many agent loops it took (`loop_count`),
// and the sidecar's bare `stop` marker dropped both — so a session where the model gave up after
// nine loops and one where it answered in one are indistinguishable in every report.
//
// THREE RULES, and each of them is a thing this could get wrong in a way nobody would notice:
//
//   1. The status is an ALLOWLIST, not a passthrough. An unrecognised value becomes `unknown`
//      rather than being mapped onto the member it resembles: `cancelled` is not evidence of
//      `aborted` and `failed` is not evidence of `error`, because no capture establishes Cursor's
//      vocabulary, and a guess is indistinguishable downstream from an observation.
//   2. A turn outcome is NOT a tool failure and NOT a rate limit. `error` here means the turn ended
//      badly; the plugin has no local rate-limit signal at all, and inventing one from a failed
//      status is how a support question about throttling gets answered with fiction (BILL-04).
//   3. Only these two fields leave. The payload also carries free text, token counts and the user's
//      email address; none of that is an outcome, and an unbounded string on a validated wire field
//      fails the entire report rather than the field.

// Every status this module will report, in the order the contract lists them. `unknown` is a member
// rather than an absence: a turn that ended in a way the host did not describe still ended.
export const TURN_STATUS = Object.freeze(['completed', 'aborted', 'error', 'unknown']);
const ALLOWED = new Set(TURN_STATUS);
const UNKNOWN = 'unknown';

function pickLoopCount(payload) {
  const raw = payload.loop_count == null ? payload.loopCount : payload.loop_count;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0 || Math.round(raw) !== raw) return null;
  return raw;
}

// `{ status, loopCount }`, or null when the payload describes no turn at all.
//
// `loopCount` is OMITTED rather than zeroed when the host sent nothing usable: zero loops is a real
// observation about a turn that did nothing, and it must not also mean "the field was missing".
export function normalizeTurnOutcome(stopPayload) {
  if (stopPayload == null || typeof stopPayload !== 'object' || Array.isArray(stopPayload)) return null;
  const hasStatus = 'status' in stopPayload;
  const loopCount = pickLoopCount(stopPayload);
  // Neither field present: this payload is not a turn end as far as this module is concerned, and an
  // `unknown` outcome invented for every hook event would put a status on turns that never stopped.
  if (!hasStatus && loopCount === null) return null;

  const raw = stopPayload.status;
  const label = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const status = ALLOWED.has(label) ? label : UNKNOWN;
  return {
    status,
    ...(loopCount === null ? {} : { loopCount }),
  };
}

// The sidecar `stop` line for one turn-end payload: the boundary marker, plus how the turn ended when
// the host said. Written by scripts/stop.mjs, and the reason this module exists — the bare marker
// used to throw both fields away.
//
// `loop_count` in snake_case, like the `subagent_stop` line's: the sidecar keeps the host's spelling.
// Both hook registries build this from the same payload, so their two copies stay byte-identical and
// dedupeEvents (lib/delta-cursor.mjs) still collapses them to one.
//
// LOCAL ONLY, and NOT an error source. No reader sends these fields, and turn errors are reported
// from the transcript's `turn_ended` line (lib/transcript-turns-cursor.mjs) alone: a second path to
// the same fact is how one abort becomes two rows.
export function stopEventFrom(stopPayload) {
  const line = { ev: 'stop' };
  const outcome = normalizeTurnOutcome(stopPayload);
  if (outcome === null) return line;
  line.status = outcome.status;
  if (outcome.loopCount !== undefined) line.loop_count = outcome.loopCount;
  return line;
}
