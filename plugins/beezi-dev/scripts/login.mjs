import { performLogin } from '../lib/login.mjs';
import { CredentialStatus, recoverLegacyCredential } from '../lib/credentials.mjs';
import { RELOAD_STEP, installCommand } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { PreflightCode } from '../lib/login-preflight.mjs';
import { telemetryStatus, pendingNotice, markNoticeShown } from '../lib/telemetry.mjs';

// Printing only. Every check this script used to perform after the fact — is the machine linked, are
// the hooks installed, does the install need repair — now happens inside performLogin's preflight,
// before a browser opens, so the CLI and the MCP `beezi_login` tool cannot disagree about what was
// verified.

function onStep(step) {
  if (step.type === 'already-linked') {
    console.log(`\n✓ This machine is already linked to Beezi${step.account ? ` as ${step.account}` : ''}.`);
    return;
  }
  // 403: authenticated, not entitled. Signing in again cannot grant a seat, so the flow stops here
  // rather than spending a browser round-trip to arrive at the same answer — and the existing
  // authorization is left exactly where it is.
  if (step.type === 'forbidden') {
    console.log('\n• Your Beezi account is signed in, but this tenant is not permitting this machine.');
    console.log(`  (API: ${step.apiBase}) The existing link was left in place — signing in again cannot change this.`);
    console.log('  Ask a Beezi administrator about seats or access for this account.');
    return;
  }
  if (step.type === 'authorize-url') {
    console.log('\nBeezi analytics — link this machine\n');
    console.log('Opening your browser to sign in with your Beezi account…');
    console.log(`If it does not open, go to:\n  ${step.url}\n`);
    return;
  }
  // The launcher failed — a sandboxed shell, no http association, no PowerShell. Say so plainly
  // instead of leaving the user watching a prompt that looks like it is still working.
  if (step.type === 'browser-failed') {
    console.log('✗ Could not open a browser automatically'
      + `${step.detail ? ` (${step.detail})` : ''}.`);
    console.log(`  Open this URL yourself to finish signing in:\n  ${step.url}\n`);
    console.log('  Waiting for you to complete the sign-in…\n');
    return;
  }
  if (step.type === 'linked') {
    console.log(`\n✓ Beezi analytics linked${step.account ? ` as ${step.account}` : ''}. Credentials stored in ${step.storedIn}.`);
  }
}

// What the preflight found, reported after the link so a setup problem never reads as a failed
// sign-in. Authentication is the hard half and it has already succeeded by the time this runs.
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

function reportSetup(result) {
  const setup = result == null ? null : result.setup;
  if (setup == null) return;
  switch (setup.hooks.status) {
    case 'repaired':
      console.log(`  Analytics hooks were installed as part of this sign-in — ${RELOAD_STEP}.`);
      break;
    case 'missing':
      console.log(`\n  Analytics are not being reported yet: run ${installCommand()}, then ${RELOAD_STEP}.`);
      break;
    case 'failed':
      console.log('\n  The analytics hook registry could not be read or written, so nothing will be reported yet.');
      console.log(`  Run ${installCommand()} to see the exact problem.`);
      break;
    default:
      console.log(`  Analytics hooks are installed. If nothing arrives, ${RELOAD_STEP}.`);
  }
  for (const warning of setup.warnings) {
    if (warning.code !== PreflightCode.HOOKS_REPAIRED) console.log(`  (${warning.code}: ${warning.detail})`);
  }
}

// `--recover-legacy`: adopt a credential an OLDER build of this plugin wrote.
//
// Downgrading past the transactional store makes the old build report "not linked"; signing in there
// writes the pre-generation slot, and a later upgrade then serves the credential from before the
// downgrade instead. This repairs that without another browser round-trip. It is explicit because
// checking for it on every read would cost a second keyring subprocess per hook.
async function recoverLegacy() {
  const result = await recoverLegacyCredential();
  if (result.status === CredentialStatus.COMMITTED) {
    console.log(`\n✓ Adopted the credential an older Beezi build left behind. Stored in ${result.where}.`);
    return;
  }
  if (result.status === CredentialStatus.MISSING) {
    console.log('\n• Nothing to recover: no older Beezi build has written credentials here.');
    return;
  }
  if (result.status === CredentialStatus.LOCKED) {
    console.log('\n• Another Beezi process is changing the credentials. Try again in a moment.');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✗ Could not adopt the older credential (${result.status}). Sign in again instead.`);
  process.exitCode = 1;
}

if (process.argv.includes('--recover-legacy')) {
  recoverLegacy().catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
} else {
  performLogin({ onStep })
    .then((result) => {
      reportSetup(result);
      // A completed login is the other reliably-seen output, and the notice is shown exactly once
      // across both surfaces: `pendingNotice()` answers null as soon as either has stamped it.
      reportDiagnostics();
      console.log('');
    })
    .catch((error) => {
      console.error(`\n✗ ${friendlyMessage(error)}`);
      process.exit(1);
    });
}
