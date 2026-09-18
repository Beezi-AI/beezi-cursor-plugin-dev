import { linkStatus, describeLink, describeReporting, LinkState } from '../lib/link-status.mjs';
import { getAuthState } from '../lib/token.mjs';
import { AuthState, describeAuthState } from '../lib/auth-state.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { telemetryStatus, pendingNotice, markNoticeShown } from '../lib/telemetry.mjs';

// The plugin's own crash reporting, on the two surfaces a user reliably sees. A status line is not
// optional here: diagnostics are OFF unless turned on, and a setting nobody can read is a setting
// nobody can trust.
function reportDiagnostics() {
  const diagnostics = telemetryStatus();
  if (diagnostics.enabled) {
    console.log(`  Diagnostics: on${diagnostics.correlated ? ' (account-correlated)' : ' (anonymous)'}`);
  } else {
    console.log('  Diagnostics: off');
  }
  // The notice goes on a RELIABLE surface. Cursor may drop a hook's stdout without anyone noticing,
  // so the stamp belongs to whatever actually printed it — print first, stamp second, and never
  // treat a displayed prompt, a timeout or silence as consent. `pendingNotice()` answers null once
  // either surface has stamped it, so whichever runs first wins and it is shown exactly once.
  const notice = pendingNotice();
  if (notice !== null) {
    console.log(`\n${notice}`);
    markNoticeShown();
  }
}

// Status, in the vocabulary of what was actually observed.
//
// This used to print linkStatus alone, which has four states because they are a shared contract —
// and three of its answers are produced by a single `getAccessToken() === null`. A keyring that did
// not answer, a grant the provider has disowned, and a machine that was never signed in all printed
// "not linked", which is the one wording that makes a user delete a working link and start again.
// The LOCAL half is asked first and reported in its own words; the portal half follows.
async function main() {
  const auth = await getAuthState({ interactive: true });

  if (auth.state !== AuthState.READY) {
    console.log(`• Beezi: ${describeAuthState(auth)}`);
    // A credential that cannot be read is not a credential that is gone: say what the next step is
    // without implying the link has to be recreated.
    if (auth.state === AuthState.UNLINKED) {
      console.log('  Analytics are NOT being reported — this machine is not linked.');
    }
    reportDiagnostics();
    return;
  }

  const status = await linkStatus();
  // 403 is entitlement, not a revoked token. link-status has to call it REVOKED — its states are a
  // shared contract — but the raw verdict says which refusal it was.
  if (status.who != null && status.who.forbidden === true) {
    console.log(`• Beezi: ${describeAuthState({ state: AuthState.FORBIDDEN })}`);
    console.log(`  (API: ${status.apiBase})`);
    reportDiagnostics();
    return;
  }

  console.log(`${status.state === LinkState.LINKED ? '✓' : '•'} Beezi: ${describeLink(status)}`);
  const reporting = describeReporting(status);
  if (reporting) console.log(`  ${reporting}`);
  // Tenant policy, when the server sends it: plan tier, tracking mode, and whether the one-time
  // history pull (the last step of beezi-login) has already completed.
  const who = status.who;
  if (who != null && who.tenantTier) console.log(`  Plan tier: ${who.tenantTier}`);
  if (who != null && who.trackingMode) {
    console.log(`  Tracking: ${who.trackingMode}${who.backfillCompleted ? ' (history pull complete)' : ''}`);
  }
  reportDiagnostics();
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
