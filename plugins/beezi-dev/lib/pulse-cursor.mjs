import fs from 'fs';
import path from 'path';
import { stateDir } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { removeSync } from './fs-compat.mjs';
import { safeName } from './sidecar.mjs';

// The mid-turn pulse: a long turn reporting before it ends.
//
// THE GAP. Outside git work, `postToolUse` only ever appended to the sidecar — so a turn that ran
// for an hour, or was abandoned halfway, held every segment it produced until `stop` or `sessionEnd`
// finally came. On an abandoned turn that is never; on a long one it is long enough that the user's
// dashboard is describing a session they finished thinking about.
//
// WHAT THIS IS NOT. Not a timer, not a daemon, not a second hook. Cursor registers exactly one
// handler per event, and the Claude plugin's equivalent also guards on a transcript path that
// `cursor-agent` does not produce at all. This is a gate called from the handler that is already
// running: on the overwhelming majority of tool calls it reads one small file and returns.
//
// THE LOCK RULE, which is the one thing that must not be got wrong. `runCheckpoint` acquires the
// session lock itself (`sessionLockPath`, lib/lock.mjs). Taking that same lock here and then calling
// the checkpoint inside it would deadlock a hook against its own work — the lock is not reentrant
// and does not sleep. So the pulse has a claim of its own, at a different path, whose only job is to
// stop two concurrent hook processes both deciding the same window is due. The claim is released
// before nothing and after everything, in a `finally`.

// At most one mid-turn checkpoint per this much event activity, per session.
//
// Fifteen minutes is the interval the reporting design already thinks in, and it bounds the cost:
// the checkpoint is the expensive path (git shell-outs, whole-session parse, a queue flush), so a
// fan-out of a hundred tool calls in a minute still pays for it once.
export const PULSE_INTERVAL_MS = 15 * 60 * 1000;

// How long a FAILED pulse waits before trying again.
//
// Deliberately much shorter than the interval. A checkpoint that threw — a transient lock, a
// momentarily unreadable sidecar, a git call that failed — must not buy a full quarter hour of
// silence for a turn that is still producing work. A failure that persists costs at most one
// attempt a minute, which is the same order as the ordinary interval's cost.
export const PULSE_RETRY_MS = 60 * 1000;

// The least remaining hook budget a pulse will start on.
//
// A checkpoint the host kills mid-run is worse than no checkpoint: `runCheckpoint` advances the
// cursor only after the segment is queued, so a kill is safe for the data but still costs a failed
// hook in Cursor's log and the whole of the user's remaining deadline. Below this, the pulse
// declines and stays due — the next tool call will have a full budget.
export const PULSE_MIN_BUDGET_MS = 2000;

// When a claim left by a killed process stops counting.
//
// A pulse holds the claim for at most one hook budget (7.5 s), so anything older than this belonged
// to a process the host killed or that died. Same reasoning and same number as the session lock in
// lib/lock.mjs, kept separate because the two guard different things and either may be retuned
// without the other.
export const PULSE_CLAIM_STALE_MS = 30 * 1000;

const STATE_VERSION = 1;

// Where one session's pulse bookkeeping lives.
//
// NOT `.json`, and that is load-bearing: lib/active-conversation.mjs treats every `*.json` in the
// state directory as a conversation's state file and derives a conversation id from its stem, so a
// `<id>.pulse.json` beside `<id>.json` would be read back as a second, non-existent conversation
// called `<id>.pulse`. The claim is a DIRECTORY for the same reason `withLock`'s is — a
// non-recursive mkdir is the atomic create-if-absent every filesystem here agrees on — and
// lib/prune.mjs's unlink skips directories, so neither file confuses the sweeper.
export function pulseStateFile(sessionId) {
  const name = safeName(sessionId);
  return name === null ? null : path.join(stateDir(), `${name}.pulse`);
}

export function pulseClaimPath(sessionId) {
  const name = safeName(sessionId);
  return name === null ? null : path.join(stateDir(), `${name}.pulse.claim`);
}

function readState(file, deps) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(file, null);
  if (raw == null || typeof raw !== 'object') return null;
  if (raw.v !== STATE_VERSION) return null;
  if (typeof raw.lastAt !== 'number' || !Number.isFinite(raw.lastAt)) return null;
  return raw;
}

function writeState(file, state, deps) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  // Best-effort: losing the stamp costs one extra checkpoint, while throwing here would cost the
  // tool call this gate is sitting on.
  try { write(file, { v: STATE_VERSION, ...state }); } catch (error) { /* best effort */ }
}

// Is this event the one that should pay for a checkpoint?
//
// Exported for its own sake: the decision is pure, and everything around it is filesystem.
export function pulseDecision(state, at) {
  // No usable state — a fresh session, a pruned stamp, a file we cannot parse. BASELINE, not due:
  // `sessionStart` has just checkpointed and there is nothing yet for a pulse to report, and
  // treating "no stamp" as due would put a checkpoint on the first tool call of every session.
  if (state === null) return { due: false, reason: 'baseline', stamp: true };
  const elapsed = at - state.lastAt;
  // A stamp in the future is a clock that moved backwards (a resync, a VM resume, a timezone-naive
  // write). Re-baseline: the alternative is a stamp that never becomes due again.
  if (elapsed < 0) return { due: false, reason: 'baseline', stamp: true };
  const required = state.ok === false ? PULSE_RETRY_MS : PULSE_INTERVAL_MS;
  if (elapsed < required) return { due: false, reason: 'not-due', stamp: false };
  return { due: true, reason: 'due', stamp: false };
}

// The claim. Same atomic non-recursive mkdir the session lock uses — see lib/lock.mjs for why that
// spelling and not a lock FILE.
function claim(claimPath, at, fsImpl) {
  try { fsImpl.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 }); } catch (error) { /* best effort */ }
  try {
    fsImpl.mkdirSync(claimPath, { recursive: false });
    return true;
  } catch (error) {
    try {
      if (at - fsImpl.statSync(claimPath).mtimeMs > PULSE_CLAIM_STALE_MS) {
        removeSync(claimPath, { recursive: true, force: true });
        fsImpl.mkdirSync(claimPath, { recursive: false });
        return true;
      }
    } catch (inner) { /* someone else broke it first, or it vanished */ }
    return false;
  }
}

function release(claimPath) {
  try { removeSync(claimPath, { recursive: true, force: true }); } catch (error) { /* ignore */ }
}

// Run a checkpoint if this session has not had one in PULSE_INTERVAL_MS, and answer what happened.
//
// `budgetMs` is the REMAINING hook deadline, not a fresh one: the sidecar append that preceded this
// call has already been paid for out of the same budget the host will kill the process at.
//
// Never throws. Every outcome is a reason string, because the caller is `postToolUse` and the worst
// thing this function could do is turn a reporting shortfall into a failed tool-call hook.
export async function maybeRunPulse(input, deps = {}, budgetMs = 0) {
  const now = deps.now == null ? Date.now : deps.now;
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  const sessionId = input == null ? null : input.session_id;
  const stateFile = pulseStateFile(sessionId);
  const claimPath = pulseClaimPath(sessionId);
  // An id with no safe filename has no sidecar and no state file either — see `safeName`. There is
  // nothing to pulse and nowhere to record that we tried.
  if (stateFile === null || claimPath === null) return { ran: false, reason: 'no-session' };

  const at = now();
  const decision = pulseDecision(readState(stateFile, deps), at);
  if (!decision.due) {
    if (decision.stamp) writeState(stateFile, { lastAt: at, ok: true }, deps);
    return { ran: false, reason: decision.reason };
  }

  if (!(budgetMs >= PULSE_MIN_BUDGET_MS)) return { ran: false, reason: 'no-budget' };

  // Not stamped: the window stays due. The process holding the claim is covering exactly this
  // window right now, and if it dies before finishing, the next tool call should still find work
  // waiting rather than a fresh interval of silence.
  if (!claim(claimPath, at, fsImpl)) return { ran: false, reason: 'contended' };

  try {
    // Dynamic, and only here. lib/checkpoint.mjs pulls in ~25 modules, git and the network; the
    // not-due path above must never reach for any of it, and this is the branch that has already
    // decided to pay.
    const runCheckpoint = deps.runCheckpoint == null
      ? (await import('./checkpoint.mjs')).runCheckpoint
      : deps.runCheckpoint;
    // emitTimeline, like `stop` and `sessionEnd`: a turn reported mid-flight must not leave the
    // session timeline describing only the part before the pulse.
    await runCheckpoint(input, {}, { emitTimeline: true, budgetMs });
    writeState(stateFile, { lastAt: now(), ok: true }, deps);
    return { ran: true, ok: true, reason: 'ran' };
  } catch (error) {
    // Stamped as a FAILURE, which is what buys the short retry rather than the full interval.
    writeState(stateFile, { lastAt: now(), ok: false }, deps);
    return { ran: true, ok: false, reason: 'failed' };
  } finally {
    release(claimPath);
  }
}
