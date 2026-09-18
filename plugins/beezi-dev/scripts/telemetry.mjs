import path from 'path';
import {
  CONSENT_MODES,
  setConsent,
  consentSummary,
} from '../lib/telemetry-consent.mjs';

// `beezi telemetry on|off|correlate|anonymous`, and the skill that wraps it.
//
// A skill alone would not be enough: the same four settings have to be reachable from a terminal
// without an agent in the loop, because the one moment a user most wants to turn diagnostics off
// is the moment the agent is not working. This script is that surface; the generated `beezi` shim
// dispatches to it and skills/beezi-telemetry/SKILL.md runs it verbatim.
//
// One line of output, always, whatever happened. It is read aloud by an agent and by a human, and
// it never claims more than the call actually did: a failed write says the setting is unchanged,
// and a deferred purge says the pending reports are still there.

const CORRELATION_ON = 'An installation ID is attached, so a report can be matched to the last '
  + 'Beezi account linked on this machine.';
const CORRELATION_OFF = 'Reports are anonymous — no installation ID is attached.';
const USAGE = 'Use `beezi telemetry on|off|correlate|anonymous` to change it.';

function describe(summary) {
  if (!summary.enabled) return `Beezi plugin diagnostics are OFF. ${USAGE}`;
  const correlation = summary.correlated ? CORRELATION_ON : CORRELATION_OFF;
  const pending = summary.pending === 0 ? '' : ` ${summary.pending} report(s) pending.`;
  return `Beezi plugin diagnostics are ON. ${correlation}${pending} ${USAGE}`;
}

// Exported for the tests and for any caller that wants the sentence without the process.
export function telemetryCommand(mode, deps = {}) {
  const summary = deps.consentSummary == null ? consentSummary : deps.consentSummary;
  const apply = deps.setConsent == null ? setConsent : deps.setConsent;

  if (mode == null || mode === '' || mode === 'status') return describe(summary());

  const result = apply(mode);
  if (!result.ok && result.error === 'invalid-mode') {
    return `Not a Beezi diagnostics setting: "${String(mode)}". Expected one of ${CONSENT_MODES.join(', ')}. `
      + `Nothing was changed. ${describe(summary())}`;
  }
  if (!result.ok) {
    return `Could not save the Beezi diagnostics setting (${result.error}); nothing was changed. `
      + describe(summary());
  }

  const after = summary();
  if (mode === 'off') {
    // Only one of these two sentences is ever true, and which one depends on whether the purge
    // actually ran. A worker holding the lock means the reports are still on disk — it rechecks
    // consent before every batch and deletes them itself, but that has not happened yet.
    const disposed = result.purged
      ? `${result.removed} pending report(s) and the installation ID were deleted.`
      : 'A delivery is in flight, so the pending reports are still on disk; they are deleted, '
        + 'not sent, on the next run.';
    return `Beezi plugin diagnostics are OFF. ${disposed} ${USAGE}`;
  }
  if (mode === 'anonymous') {
    const disposed = result.purged
      ? `${result.removed} correlated report(s) and the installation ID were deleted.`
      : 'A delivery is in flight, so correlated reports are cleared on the next run.';
    const state = after.enabled
      ? 'Beezi plugin diagnostics stay ON, without account correlation.'
      : 'Beezi plugin diagnostics remain OFF; account correlation is off as well.';
    return `${state} ${CORRELATION_OFF} ${disposed} ${USAGE}`;
  }
  if (mode === 'correlate') {
    return `Beezi plugin diagnostics are ON with account correlation. ${CORRELATION_ON} `
      + `Use \`beezi telemetry anonymous\` to turn correlation off again.`;
  }
  return `Beezi plugin diagnostics are ON. ${after.correlated ? CORRELATION_ON : CORRELATION_OFF} `
    + `Crash reports about the plugin are sent — never your code, prompts, file paths or repository names. ${USAGE}`;
}

// Only when run as the program, never on import: the tests import this module.
const invoked = typeof process.argv[1] === 'string'
  && path.basename(process.argv[1]) === 'telemetry.mjs';
if (invoked) {
  process.stdout.write(`${telemetryCommand(process.argv[2])}\n`);
}
