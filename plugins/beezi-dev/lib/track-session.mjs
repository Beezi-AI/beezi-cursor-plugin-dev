// `beezi-track` without the terminal: one function that runs the manual save and RETURNS what
// happened. `scripts/track.mjs` becomes the glyph, the stream and the exit code.
//
// TWO THINGS WERE WRONG WITH THE OLD SCRIPT.
//
// It made a branch lookup a precondition for reporting. `currentBranch` throws on a detached HEAD
// (by design — `git branch --show-current` prints nothing there, and answering the literal string
// "HEAD" as if it were a branch is worse) and `git` itself fails outside a repository, so a user
// mid-bisect, mid-rebase, on a checked-out tag, or simply in a folder that is not a checkout was
// told `✗ Beezi: not a git repository` and NOTHING WAS SAVED — for a session whose analytics were
// intact and whose sidecar was sitting right there. The branch only ever chose the label echoed
// back. Attribution is the checkpoint's job and already falls through to a synthetic local remote
// when there is no origin, so the label falls back to the folder name and the work goes on.
//
// And it could not explain itself. A refused token, an unreadable credential store, a tenant whose
// admin switched tracking off, a queue waiting out its backoff and a permanent server rejection all
// collapsed into "saved" or "could not be delivered". Those five need five different actions from
// the user — sign in, retry, nothing, nothing, report it — so this file names them.
//
// WHAT IS DELIBERATELY NOT HERE: any update check. PIPE-07 is an alias of PKG-16 and stays deferred
// under M10-10; approved §10.1 adds no `updateManifestUrl`, so there is no manifest to ask and
// inventing one would ship a network call the release does not have a server for. Extracting this
// helper does not close it.
import path from 'path';
import { currentBranch as _currentBranch, taskFromBranch as _taskFromBranch } from './git.mjs';
import { resolveActiveConversation as _resolveActiveConversation } from './active-conversation.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { getAccessToken } from './token.mjs';
import { isLiveTrackingAllowed } from './tracking.mjs';
import { friendlyMessage } from './friendly-error.mjs';

// A local mirror of CONTRACTS §2's AuthState values, so this module can be written against the
// typed auth seam before lib/auth-state.mjs exists. Integration replaces this constant with an
// import from that file — the STRINGS are the contract and must not drift.
export const TrackAuthState = Object.freeze({
  READY: 'ready',
  UNLINKED: 'unlinked',
  REFRESHING: 'refreshing',
  UNAVAILABLE: 'unavailable',
  REAUTH_REQUIRED: 'reauth_required',
  FORBIDDEN: 'forbidden',
});

// The default auth seam: today's `getAccessToken()` adapted to the typed shape. It keeps the
// existing behaviour for a linked machine and splits the one case the old script got wrong — a
// THROW from the credential store (a locked keychain, a DPAPI failure, a contended read) used to be
// swallowed into "this machine is not linked", which invites a user with perfectly good credentials
// to log out and back in. Integration swaps this for token.mjs's own `getAuthState`.
async function defaultAuthState() {
  let token;
  try {
    token = await getAccessToken();
  } catch (error) {
    return { state: TrackAuthState.UNAVAILABLE, reason: 'transport', token: null, error };
  }
  if (token) return { state: TrackAuthState.READY, reason: 'none', token };
  return { state: TrackAuthState.UNLINKED, reason: 'missing', token: null };
}

// What to call this run in the line the user reads back. A task branch is named by its task token
// (that is what their ticket is called), any other branch by its own name, and a working copy with
// no answerable branch by its folder. Never fatal, and never consulted for anything but the echo.
function labelFor(cwd, currentBranch, taskFromBranch) {
  let branch = null;
  try {
    branch = currentBranch(cwd);
  } catch {
    branch = null;
  }
  if (branch) {
    const task = taskFromBranch(branch);
    return task == null ? branch : task;
  }
  // `path.basename` of a drive root or `/` is the empty string; fall back to something printable
  // rather than emitting "analytics saved for  (1 segment)".
  const folder = path.basename(path.resolve(cwd));
  return folder === '' ? 'this machine' : folder;
}

function segments(n) {
  return `${n} segment${n === 1 ? '' : 's'}`;
}

// Run the manual save. Returns `{ exitCode, message }` and writes nothing anywhere: the caller owns
// the glyph, the stream and `process.exit`, which is what makes every outcome below testable.
//
// `deps` seams: `currentBranch`, `taskFromBranch`, `resolveActiveConversation`, `getAuthState`,
// `isTrackingAllowed`, `runCheckpoint`, and `flushQueue` — the last used only when the checkpoint
// produced no flush summary of its own, so a CLI run never reports "nothing new" over a queue it
// silently left undrained.
export async function runTrack(input = {}, deps = {}) {
  const cwd = input.cwd == null ? process.cwd() : input.cwd;
  const currentBranch = deps.currentBranch == null ? _currentBranch : deps.currentBranch;
  const taskFromBranch = deps.taskFromBranch == null ? _taskFromBranch : deps.taskFromBranch;
  const resolveActiveConversation = deps.resolveActiveConversation == null
    ? _resolveActiveConversation
    : deps.resolveActiveConversation;
  const getAuthState = deps.getAuthState == null ? defaultAuthState : deps.getAuthState;
  const isTrackingAllowed = deps.isTrackingAllowed == null ? (() => isLiveTrackingAllowed()) : deps.isTrackingAllowed;
  const runCheckpoint = deps.runCheckpoint == null ? _runCheckpoint : deps.runCheckpoint;
  const flushQueue = deps.flushQueue == null ? null : deps.flushQueue;

  const label = labelFor(cwd, currentBranch, taskFromBranch);

  try {
    const auth = await getAuthState({ interactive: true });
    const state = auth == null ? TrackAuthState.UNAVAILABLE : auth.state;
    const token = auth == null ? null : auth.token;

    if (state === TrackAuthState.UNLINKED) {
      return { exitCode: 1, message: 'Beezi: this machine is not linked. Sign in to Beezi first.' };
    }
    if (state === TrackAuthState.REAUTH_REQUIRED) {
      return { exitCode: 1, message: 'Beezi: this machine needs to sign in to Beezi again — its previous authorization is no longer valid.' };
    }
    if (state === TrackAuthState.FORBIDDEN) {
      return { exitCode: 1, message: 'Beezi: this account is not allowed to report analytics — ask your Beezi workspace admin.' };
    }
    if (state !== TrackAuthState.READY || token == null || token === '') {
      // UNAVAILABLE and REFRESHING both land here, and deliberately do NOT mention signing in:
      // the credentials may be entirely fine and merely unreadable this second.
      return { exitCode: 1, message: 'Beezi: your Beezi credentials could not be read just now — nothing was lost, try again in a moment.' };
    }

    // The tenant gate, ahead of any source or usage work and ahead of any queue write. A disabled
    // workspace must not be told that anything was tracked.
    if (!isTrackingAllowed()) {
      return { exitCode: 0, message: 'Beezi: analytics are turned off for your Beezi workspace — nothing was collected or sent.' };
    }

    // There is no way for an unrelated process to ask Cursor for "the current conversation id", so
    // it is resolved from the plugin's own state — the most recent conversation recorded here.
    const conversationId = resolveActiveConversation(cwd);
    if (!conversationId) {
      return {
        exitCode: 1,
        message: 'Beezi: no Cursor conversation has been recorded on this machine yet — the analytics hooks may not be installed.',
      };
    }

    // No budgetMs: a user waiting at a terminal would rather see the whole queue drained than a
    // partial flush.
    const outcome = await runCheckpoint({ session_id: conversationId, cwd });
    const enqueued = outcome == null || outcome.enqueued == null ? 0 : outcome.enqueued;
    let flush = outcome == null ? null : outcome.flush;
    if (flush == null && flushQueue != null) flush = await flushQueue(token, {});

    if (flush != null && (flush.trackingDisabled === true || flush.gated === true)) {
      return {
        exitCode: 0,
        message: 'Beezi: analytics are turned off for your Beezi workspace — your queued data is kept, nothing was sent.',
      };
    }
    if (flush != null && flush.failed) {
      // `failed` covers a refused token and a rate limit as well as an unreachable server — all
      // three keep the record for the next hook, so name the cause rather than guessing at it.
      const cause = flush.lastError ? ` (${flush.lastError})` : '';
      return { exitCode: 1, message: `Beezi: the report could not be delivered${cause} — it stays queued and is retried automatically.` };
    }
    if (flush != null && flush.rejected) {
      return { exitCode: 1, message: `Beezi: ${flush.lastError == null ? 'the server rejected this report' : flush.lastError}.` };
    }

    // `sent` is queue-delivery's name and `flushed` is the one checkpoint's wrapper still returns;
    // whichever arrives, it is the number of segments that actually landed.
    const delivered = flush == null ? 0 : (flush.sent == null ? flush.flushed : flush.sent);
    const saved = delivered == null ? 0 : delivered;
    const deferred = flush == null || flush.deferred == null ? 0 : flush.deferred;

    if (enqueued === 0 && saved === 0) {
      if (deferred > 0) {
        // Not a failure and not a no-op: the records are waiting out a backoff they earned, and
        // saying "already up to date" over a non-empty queue is the lie this branch exists to avoid.
        return { exitCode: 0, message: `Beezi: nothing new to save for ${label} — ${segments(deferred)} still queued and retried automatically.` };
      }
      return { exitCode: 0, message: `Beezi: nothing new to save for ${label} — already up to date.` };
    }

    const tail = deferred > 0 ? `, ${segments(deferred)} still queued` : '';
    return { exitCode: 0, message: `Beezi: analytics saved for ${label} (${segments(saved)}${tail}).` };
  } catch (error) {
    // Never throw: the caller is a CLI entry point, and an unhandled rejection there prints a stack
    // trace at a user who wanted one line. No `Beezi:` prefix, because `friendlyMessage` already
    // writes whole sentences and the old script printed them bare — this branch is the only one
    // whose wording is not this file's.
    return { exitCode: 1, message: friendlyMessage(error) };
  }
}
