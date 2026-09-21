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
import { reportRefreshedAccount } from '../lib/account-checkin.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Tell the portal about the account this run just reconciled (plan §4 B3).
//
// FORCED, and the force is the point. `/beezi:refresh` reaches this script as
// `--from-cursor --force --via refresh`: the user has explicitly asked for a re-read, and the
// commonest reason they do is that the recorded tier is wrong. The check-in's own hash gate would
// answer SKIPPED for exactly the payload that has not changed since the last send, which is the
// state a user in that situation is in — so an unforced check-in here would swallow the one request
// the command exists to make.
//
// SILENT THROUGHOUT, and deliberately after the result line has already been printed. The last line
// of this script's stdout is a contract with the `beezi-refresh` skill (`beezi-billing-result:` +
// JSON, whose `outcome` the skill branches on); a check-in must not be able to delay it, interleave
// with it, add to it, or change this command's exit status. An unlinked or offline machine reports
// nothing and the command works exactly as it always did.
async function reportAccount(record) {
  if (record == null) return;
  // No token is passed: this is an interactive command, not a hook, so it has none in hand and the
  // helper resolves one — or finds none, on a machine that never signed in, and does nothing.
  try {
    await reportRefreshedAccount(record);
  } catch { /* best-effort — telemetry may never change this command's output */ }
}

// The command seam: readCursorAccount -> observation -> reconcile -> write. Everything it does is
// in a library function that is unit-tested on its own; this file exists to wire them together and
// to own the exit status, which is why it is deliberately this short.
//
// `run()` exists only because the check-in is asynchronous and the Node floor is 13.2, which has no
// top-level await. The try/catch stays INSIDE it, around the same statements it always guarded.
async function run() {
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

    // LAST. The record that was just reconciled is handed over directly rather than re-read: it is
    // the same object that was (or was not) persisted a moment ago, and re-reading billing.json here
    // would race the write above on a machine where it failed.
    await reportAccount(result.record);
  } catch (error) {
    console.error(`✗ ${friendlyMessage(error)}`);
    process.exit(1);
  }
}

run();
