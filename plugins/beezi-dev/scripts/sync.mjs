import { parseSyncArgs, runAudit } from '../lib/session-audit.mjs';
import { extractAuditReports } from '../lib/checkpoint.mjs';
import { renderSyncSummary } from '../lib/audit-summary.mjs';
import { buildHistoryIndex, renderHistorySummary } from '../lib/history-index.mjs';
import { currentAccountKey } from '../lib/tracking.mjs';
import { authEpoch, getAuthState } from '../lib/token.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The repeatable history upload (the beezi-sync skill). Unlike the one-time import at the end of
// the beezi-login skill, this can be run again and again: it asks Beezi how far each session
// already reaches and sends only what is missing, so a re-run costs nothing and never double-counts.
//
// It never seals the one-time import, never calls /complete and never advances live tracking state.
// Only --dry-run is accepted; parseSyncArgs explains why the other two flags are refused.
//
// Every user-visible sentence lives in lib/audit-summary.mjs so the wording can be asserted.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const options = parseSyncArgs(process.argv.slice(2));

  // `--history`: local, read-only, no network and no upload. It answers "is that everything?" by
  // counting what Cursor's own store holds alongside what this plugin recorded — and says plainly
  // that the difference cannot be uploaded (lib/history-index.mjs explains why).
  if (options.history) {
    const index = buildHistoryIndex({}, { account: currentAccountKey() });
    for (const line of renderHistorySummary(index)) console.log(line);
    return;
  }

  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions checked…`);
      },
      // The typed auth probe (CONTRACTS §2). Without it runSync falls back to the bare
      // `getAccessToken()` adapter, where a null token is read as `no-token` — so a locked keychain
      // or a store that simply did not answer would be reported to the user as "not linked".
      getAuthState,
      // The request-identity fence. It changes on account change and on logout, NOT on a
      // same-account token rotation, which is exactly the distinction a minutes-long sync needs:
      // a rotated token may keep sending, a different account may not.
      //
      // REQUIRED, not an optimisation. `runSync` HALTS with `epoch-unavailable` when it cannot
      // establish a fence at all, because a run whose fence is null compares `null === null` on
      // every re-check — the guard is a no-op and a relink mid-run goes unnoticed, which is a whole
      // history uploaded into the wrong tenant. (`authEpoch` is also carried on the typed result
      // above; wiring the probe as well means the fence is re-READ before each send rather than
      // compared against a value captured once.)
      authEpoch: () => authEpoch({}),
      // The audit-only extraction seam (C-16). Wired HERE rather than as a `runSync` default on
      // purpose: `runSync` halts with `extraction-unavailable` when it is absent, and that halt is
      // a real acceptance check — a build that cannot resume a session must make no request and
      // touch no queue file. A default inside runSync would make the halt unreachable and the
      // assertion that pins it vacuous.
      //
      // It is NOT `runCheckpoint`: runSync holds this session's lock across the coverage query, the
      // extraction and the acknowledgment, and runCheckpoint would try to take the same lock, lose
      // the race against its own caller and return zero reports.
      extractAuditReports,
    },
    options,
  );

  const summary = renderSyncSummary(result, options);
  if (summary.error != null) fail(summary.error);
  for (const line of summary.lines) console.log(line);
}

main().catch((error) => fail(friendlyMessage(error)));
