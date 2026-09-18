import { runTrack } from '../lib/track-session.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Every decision — the label fallback, the typed auth outcomes, the policy hold, the delivery
// verdicts — lives in lib/track-session.mjs, which RETURNS them instead of printing them. This file
// is the terminal: one glyph, one stream, one exit code. That split is what made the outcomes
// testable at all; the previous version's branches could only be observed by spawning it.
async function main() {
  const { exitCode, message } = await runTrack({ cwd: process.cwd() });
  if (exitCode === 0) console.log(`✓ ${message}`);
  else console.error(`✗ ${message}`);
  process.exit(exitCode);
}

// No `Beezi: ` prefix here on purpose: `runTrack` carries it inside every deliberate message, and
// an unexpected error is a bare `friendlyMessage` sentence — matching what the old `fail()` did.
main().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
