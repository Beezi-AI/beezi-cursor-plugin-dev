import { BackfillHalt } from './audit-flush.mjs';
import { SyncHalt } from './session-audit.mjs';
import { RETENTION_WINDOW_DAYS } from './retention-window.mjs';

// What the history commands print.
//
// `scripts/backfill.mjs` and `scripts/sync.mjs` used to hold this wording inline, which made every
// sentence about truthfulness — "oversize sessions were skipped", "this pull is finalized WITHOUT
// them", "nothing was uploaded" — unreachable from a test without spawning a subprocess and giving
// it a fake credential store. The renderers are pure: a result bag in, `{ error, lines }` out. The
// scripts keep exactly one behaviour of their own, which is that `error` exits non-zero.
//
// Rules that hold for every line in here:
//   - a number that is nonzero is printed (a count that only exists in the result object is a
//     number nobody can act on),
//   - a sentence never promises a repair the plugin cannot perform,
//   - sync says nothing about sealing, finalizing or the one-time import, because it does neither.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const were = (n) => (n === 1 ? 'was' : 'were');

// The 64 MiB sidecar cap in the unit the user's file manager shows. Stated numerically because
// "too large" alone reads as a bug to report rather than a property of one enormous conversation.
const OVERSIZE_LIMIT = '64 MiB';

// One sentence for a condition the user waits out, and it has three jobs: name the condition,
// promise that nothing local changed, and say that re-running is the fix. It must never read as
// "you are not signed in" — that sends the user through a full OAuth round trip to fix a store
// that was busy for a second.
function authUnavailableMessage(result) {
  const detail = result.authReason == null ? result.authState : `${result.authState}: ${result.authReason}`;
  return (
    `Beezi: your saved Beezi sign-in could not be read right now (${detail == null ? 'unavailable' : detail}). ` +
    'Nothing was changed — your credentials, your upload history and the one-time import are exactly as they were. ' +
    'Wait a moment and try again; signing in again is not needed.'
  );
}

// Sessions the retention floor dropped. Stated as a property of the product ("Beezi reports on the
// last N days"), not as a failure the user could retry: the count is permanent, and a sentence that
// reads like an error sends people back to re-run a command that will skip exactly the same files.
function tooOldLines(result) {
  if (!(result.tooOld > 0)) return [];
  return [
    `  ${plural(result.tooOld, 'session')} ${were(result.tooOld)} older than ` +
      `${RETENTION_WINDOW_DAYS} days and ${were(result.tooOld)} skipped — Beezi only reports on the ` +
      `last ${RETENTION_WINDOW_DAYS} days.`,
  ];
}

function oversizeLines(result) {
  if (!(result.oversize > 0)) return [];
  return [
    `  ${plural(result.oversize, 'session')} ${were(result.oversize)} too large to read ` +
      `(over ${OVERSIZE_LIMIT}) and ${were(result.oversize)} skipped — re-running will not recover them.`,
  ];
}

// The one-time history import (`scripts/backfill.mjs`).
export function renderBackfillSummary(result, options = {}) {
  const lines = [];
  const viaLogin = options.via === 'login';

  if (result.reason === 'no-token') {
    return { error: 'Beezi: this machine is not linked. Run the beezi-login skill first.', lines };
  }
  if (result.reason === 'auth-unavailable') {
    return { error: authUnavailableMessage(result), lines };
  }

  const alreadyUsed =
    result.reason === 'already-completed' || result.halt === BackfillHalt.ALREADY_COMPLETED;
  if (alreadyUsed) {
    const headline =
      'Beezi already has the history for this workspace — the one-time import has been used and cannot run again.';
    const upgrade = result.upgradeAdvised
      ? 'Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.'
      : null;
    if (viaLogin) {
      lines.push(`✓ ${headline}`);
      if (upgrade) lines.push(`  ${upgrade}`);
      return { error: null, lines };
    }
    return { error: upgrade == null ? headline : `${headline} ${upgrade}`, lines };
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return { error: 'Beezi: the audit period has ended — new history pulls are disabled for this workspace.', lines };
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return {
      error: 'Beezi: the server does not support the history pull yet — try again after the portal update.',
      lines,
    };
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return {
      error:
        `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then re-run the beezi-login skill.',
      lines,
    };
  }

  if (result.scanned === 0) {
    lines.push('✓ Beezi: no past Cursor sessions found to upload.');
    return { error: null, lines };
  }

  if (result.candidates === 0) {
    const bits = [];
    if (result.alreadyImported > 0) bits.push(`${plural(result.alreadyImported, 'session')} already uploaded`);
    if (result.liveTracked > 0) bits.push(`${result.liveTracked} already tracked live`);
    if (result.active > 0) bits.push(`${result.active} still active — they upload on a later login`);
    if (result.tooOld > 0) bits.push(`${result.tooOld} older than ${RETENTION_WINDOW_DAYS} days`);
    lines.push(`✓ Beezi: nothing new to upload${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    // Printed BEFORE the finalization line, so the sentence that says "without them" has the
    // sessions it is talking about directly above it.
    lines.push(...oversizeLines(result));
    lines.push(...tooOldLines(result));
    if (result.finalized) {
      lines.push(finalizedLine(result));
    } else if (result.activePreLink > 0) {
      lines.push(
        '  Your history pull stays open for the active sessions — run the beezi-login skill again once they have been quiet for a day.',
      );
    }
    return { error: null, lines };
  }

  if (options.dryRun) {
    lines.push(
      `Beezi: would upload ${plural(result.candidates, 'session')} / ` +
        `${plural(result.plannedReports, 'report')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    lines.push(...oversizeLines(result));
    lines.push(...tooOldLines(result));
    return { error: null, lines };
  }

  // Everything that was parsed but never judged by the server. Those sessions stay unledgered, so
  // "sign in again to continue" is accurate — the next login's backfill picks them up.
  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return {
      error:
        `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Re-run the beezi-login skill to continue where it left off.',
      lines,
    };
  }

  const parts = [
    `✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`,
  ];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (result.liveTracked > 0) parts.push(`${result.liveTracked} were already tracked live.`);
  if (result.active > 0) parts.push(`${result.active} still active — they upload on a later login.`);
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.sessionsRejected > 0) {
    parts.push(
      `${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`,
    );
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — re-run the beezi-login skill to retry them.`,
    );
  }
  lines.push(parts.join(' '));

  if (result.empty > 0) {
    lines.push(
      `  ${plural(result.empty, 'session')} held no usage data (no activity recorded) — nothing to upload.`,
    );
  }
  if (result.zeroUsage > 0) {
    lines.push(`  ${plural(result.zeroUsage, 'session')} held no billable usage — skipped.`);
  }
  if (result.unreadable > 0) {
    lines.push(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  lines.push(...oversizeLines(result));
  lines.push(...tooOldLines(result));
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    lines.push(
      `  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored ` +
        `and ${result.reportsSkipped} skipped by the server.`,
    );
  }

  if (result.finalized) {
    lines.push(finalizedLine(result));
  } else if (options.sinceMs != null) {
    lines.push('  Scoped run (--since): the pull stays open — a full run (no flags) finalizes it.');
  } else if (result.retriableUnreadable > 0) {
    lines.push(
      `  Your history is NOT finalized yet — ${plural(result.retriableUnreadable, 'session')} could not be read ` +
        'this time. Re-run the beezi-login skill to retry them; if they fail again the pull finalizes without them.',
    );
  } else if (result.activePreLink > 0) {
    lines.push(
      '  Your history pull stays open for the active sessions — run the beezi-login skill again once they have been quiet for a day.',
    );
  } else if (!result.pullOpened) {
    lines.push(
      '  Nothing has reached Beezi yet, so the one-time pull has not started — your history stays eligible for a later login.',
    );
  } else {
    lines.push(
      '  Your history is NOT finalized yet — re-run the beezi-login skill once the remaining sessions can be delivered.',
    );
  }
  if (result.timelines > 0) {
    lines.push('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  // One stanza, not two: `timelinesDropped` is a subset of the offered-minus-attached gap, so an
  // if/else would suppress the unexplained remainder — the very gap these counters exist to show.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    lines.push(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (!result.followupsAllowed) {
    lines.push('  Rate-limit events are not collected in audit mode.');
  }
  lines.push('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  lines.push(
    `  Note: history older than ${RETENTION_WINDOW_DAYS} days is not retained on this machine `
      + 'and cannot be uploaded.',
  );
  return { error: null, lines };
}

// The seal is one-time and cannot be reopened, so a run that sealed while skipping unreadable
// giants has to say which history it sealed WITHOUT. "Your history pull is finalized" on its own
// is the sentence that turns a permanent gap into a surprise.
function finalizedLine(result) {
  // Both exclusions are permanent for the same reason — the seal cannot be reopened — so they are
  // named in one sentence rather than left for the user to piece together from two.
  const without = [];
  if (result.oversize > 0) without.push(`${plural(result.oversize, 'session')} too large to read`);
  if (result.tooOld > 0) {
    without.push(`${plural(result.tooOld, 'session')} older than ${RETENTION_WINDOW_DAYS} days`);
  }
  if (without.length === 0) return '✓ Beezi: your history pull is finalized.';
  return (
    `✓ Beezi: your history pull is finalized — without ${without.join(' and ')}. ` +
    'The one-time import cannot be re-opened for them.'
  );
}

// The repeatable sync (`scripts/sync.mjs`). Deliberately shares no sentence with the backfill
// renderer above: sync never seals, never calls /complete and never advances live state, so every
// word about finalizing, one-time imports or "the pull" would be false here.
export function renderSyncSummary(result, options = {}) {
  const lines = [];

  if (result.reason === 'no-token') {
    return { error: 'Beezi: this machine is not linked. Run the beezi-login skill first.', lines };
  }
  if (result.reason === 'auth-unavailable') {
    return { error: authUnavailableMessage(result), lines };
  }
  if (result.halt === SyncHalt.COVERAGE_UNAVAILABLE) {
    return {
      error:
        'Beezi: sync stopped — Beezi could not confirm which history it already holds, and uploading ' +
        'without that answer would count the same work twice. Nothing was uploaded and nothing was ' +
        'changed; try again once the server is reachable.',
      lines,
    };
  }
  if (result.halt === SyncHalt.EXTRACTION_UNAVAILABLE) {
    return {
      error:
        'Beezi: resumable sync is not enabled in this build — the audit-only resume seam is not available yet. ' +
        'Nothing was uploaded; your one-time history import is unaffected.',
      lines,
    };
  }
  if (result.halt === SyncHalt.EPOCH_UNAVAILABLE) {
    return {
      error:
        'Beezi: sync stopped — it could not tell which Beezi account this run belongs to, and it ' +
        'will not upload the history of one account under the sign-in of another. Nothing was uploaded and ' +
        'nothing was changed; run the beezi-me skill to check the link, then try again.',
      lines,
    };
  }
  if (result.halt === BackfillHalt.ALREADY_COMPLETED) {
    // The sync route answering with the one-time seal's code is a server-side refusal, not news
    // about the user's import. Saying "your import is done" here would report their history as
    // complete on the strength of a request that was turned away.
    return {
      error:
        'Beezi: the server refused the sync upload — it did not accept the request for this ' +
        'workspace. Nothing was uploaded and your one-time history import is unaffected. Check ' +
        'with your workspace admin, then try again.',
      lines,
    };
  }
  if (result.halt === SyncHalt.QUEUE_UNREADABLE) {
    return {
      error:
        'Beezi: sync stopped — part of the pending upload queue could not be read, so the sessions it ' +
        'covers could not be identified. Nothing was uploaded. Re-run the beezi-track skill (or start a ' +
        'new Cursor session) to flush the queue, then try again.',
      lines,
    };
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) {
    return { error: 'Beezi: uploads are disabled for this workspace — the audit period has ended.', lines };
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return {
      error: 'Beezi: this Beezi server does not support the repeatable sync yet — try again after the portal update.',
      lines,
    };
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return {
      error:
        `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then try again.',
      lines,
    };
  }

  if (result.scanned === 0) {
    lines.push('✓ Beezi: no recorded Cursor sessions found on this machine.');
    return { error: null, lines };
  }

  if (options.dryRun) {
    lines.push(
      `Beezi: would upload ${plural(result.plannedReports, 'report')} across ` +
        `${plural(result.candidates, 'session')} in ${plural(result.plannedChunks, 'request')} ` +
        '(dry run — nothing sent).',
    );
    lines.push(...syncFootnotes(result));
    return { error: null, lines };
  }

  if (result.reportsFailed > 0 && result.sessionsImported === 0) {
    return {
      error:
        `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Run the beezi-sync skill again to continue where it left off.',
      lines,
    };
  }

  if (result.candidates === 0) {
    // "Everything is already uploaded" is only true when there is nothing this run declined to
    // look at. With sessions held by the queue, skipped for want of a coverage answer, deferred,
    // active, oversize or unreadable, the honest headline is "nothing new went up" — followed by
    // the footnotes that say what did not. This is the 08-A "finalized WITHOUT them" rule applied
    // to the repeatable command: a ✓ the next line contradicts is worse than no ✓.
    lines.push(skippedAnything(result)
      ? '✓ Beezi: nothing new was uploaded — everything else this machine still has is already in Beezi.'
      : '✓ Beezi: Beezi already holds everything this machine still has on disk.');
    lines.push(...syncFootnotes(result));
    return { error: null, lines };
  }

  const parts = [
    `✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`,
  ];
  if (result.upToDate > 0) parts.push(`${result.upToDate} were already up to date.`);
  if (result.partial > 0) {
    parts.push(
      `${plural(result.partial, 'session')} went up only in part — the rest of their reports were ` +
        'refused, so no progress was recorded for them and the next run retries what is missing.',
    );
  }
  if (result.itemErrors > 0) {
    parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.sessionsRejected > 0) {
    parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(
      `${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run the beezi-sync skill again to retry.`,
    );
  }
  lines.push(parts.join(' '));
  lines.push(...syncFootnotes(result));
  return { error: null, lines };
}

// Did this run decline to look at anything? Every counter here has a footnote of its own below,
// so the headline must not contradict one.
function skippedAnything(result) {
  return (
    result.empty > 0 ||
    result.partial > 0 ||
    result.queueHeld > 0 ||
    result.coverageMissing > 0 ||
    result.sourceMismatch > 0 ||
    result.deferred > 0 ||
    result.active > 0 ||
    result.oversize > 0 ||
    result.tooOld > 0 ||
    result.unreadable > 0
  );
}

function syncFootnotes(result) {
  const lines = [];
  if (result.empty > 0) {
    // Without this the run says it looked at N sessions and uploaded fewer, with no account of the
    // difference — the same silent gap the backfill's `empty` line exists to close.
    lines.push(
      `  ${plural(result.empty, 'session')} had nothing new to upload — the lines Beezi is missing ` +
        'for them carry no usage.',
    );
  }
  if (result.queueHeld > 0) {
    lines.push(
      `  ${plural(result.queueHeld, 'session')} ${were(result.queueHeld)} skipped this run — they still have ` +
        'segments waiting in the live upload queue, and sending around them would count the same work twice.',
    );
  }
  if (result.deferred > 0) {
    lines.push(
      `  ${plural(result.deferred, 'session')} ${were(result.deferred)} deferred — another Beezi process was ` +
        'working on them. Running sync again picks them up.',
    );
  }
  if (result.coverageMissing > 0) {
    lines.push(
      `  ${plural(result.coverageMissing, 'session')}: Beezi did not report how much of them it already ` +
        'holds, so nothing was sent for them — sending from the start would risk counting that work twice.',
    );
  }
  if (result.sourceMismatch > 0) {
    lines.push(
      `  ${plural(result.sourceMismatch, 'session')} could not be resumed: Beezi reports more history for ` +
        'them than this machine still has on disk, so nothing was sent for them.',
    );
  }
  if (result.unreadable > 0) {
    lines.push(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  lines.push(...oversizeLines(result));
  lines.push(...tooOldLines(result));
  if (result.active > 0) {
    lines.push(
      `  ${plural(result.active, 'session')} ${were(result.active)} still active — they sync once they have been quiet for a day.`,
    );
  }
  if (result.overageUnavailable > 0) {
    lines.push(
      `  ${plural(result.overageUnavailable, 'session')} were resumed part-way, so Beezi recorded their ` +
        'usage-based overage cost as unavailable rather than counting it twice.',
    );
  }
  if (result.timelines > 0) {
    lines.push('  ' + plural(result.timelines, 'session timeline') + ' attached.');
  }
  lines.push('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  lines.push(
    `  Note: history older than ${RETENTION_WINDOW_DAYS} days is not retained on this machine `
      + 'and cannot be uploaded.',
  );
  return lines;
}
