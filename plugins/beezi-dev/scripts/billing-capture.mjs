import {
  parseArgs,
  observationFromArgs,
  observationFromAccount,
  reconcilePlan,
  formatResultLine,
  noticeFor,
  DEPRECATION_NOTICES,
} from '../lib/billing-capture.mjs';
import { readBillingConfig, writeBillingConfig } from '../lib/billing-config.mjs';
import { readCursorAccount } from '../lib/cursor-account.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The command seam: readCursorAccount -> observation -> reconcile -> write. Everything it does is
// in a library function that is unit-tested on its own; this file exists to wire them together and
// to own the exit status, which is why it is deliberately this short.
try {
  const args = parseArgs(process.argv.slice(2));
  for (const flag of args.deprecated) {
    const notice = DEPRECATION_NOTICES[flag];
    if (notice) console.log(notice);
  }

  // --from-cursor: read the plan ourselves, deterministically, from Cursor's own local record
  // (`cursorAuth/stripeMembershipType` in state.vscdb, with the CLI's cli-config.json as fallback).
  // No tokens are read or returned; the model supplies no values on this path.
  let observation = null;
  if (args.fromCursor) {
    let account = null;
    try {
      account = readCursorAccount();
    } catch {
      // An unreadable host source is "no observation", never a failure that erases a good record.
      account = null;
    }
    observation = observationFromAccount(account, args.via);
  } else {
    observation = observationFromArgs(args);
  }

  const result = reconcilePlan(observation, readBillingConfig(), {
    now: Date.now(),
    force: args.force === true,
    // `--from-cursor` LOOKED at the host, whether or not it found anything. Saying so is what lets
    // reconcile record the attempt, and the attempt is what stops a machine with no plan repeating
    // an uncached SQLite read on every single session start.
    attempted: args.fromCursor === true,
  });

  let written = false;
  if (result.persist && result.record != null) {
    writeBillingConfig(result.record);
    written = true;
  }

  for (const line of noticeFor(result)) console.log(line);
  console.log(formatResultLine(result, written));
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
