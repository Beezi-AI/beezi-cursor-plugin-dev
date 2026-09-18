import { performLogout, describeLogout } from '../lib/logout.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { onLogout } from '../lib/telemetry.mjs';

// Thin on purpose. Everything that decides an outcome lives in lib/logout.mjs, where it is testable
// and where the MCP bridge can reach it without spawning a process; this file only prints and sets
// the exit code. The version this replaced carried the unlink request, the revocation fallback and
// the success wording inline, which is why none of it was ever exercised by a test — and why it
// claimed "Logged out" on a 401.
async function main() {
  // TEL-04, and this is the composition root that makes it real. `performLogout` keeps the callback
  // injected and no-op by default (CONTRACTS section 8: optional telemetry may never change an auth
  // outcome or its budget), which meant that until something supplied one, the rotation simply did
  // not happen — a diagnostic installation stayed bound to the account that had just left the
  // machine, and the README's "it is deleted on logout" was describing an unreached branch. This
  // script is the only caller of performLogout, so wiring it here wires it everywhere.
  const result = await performLogout({ onInstallationRotate: onLogout });
  for (const line of describeLogout(result)) console.log(line);
  // A failed local deletion exits non-zero: the skill and any script wrapping this one have to be
  // able to tell "signed out" from "still holding a credential" without parsing prose.
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
