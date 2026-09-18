import { parseArgs, runAudit } from '../lib/session-audit.mjs';
import { renderBackfillSummary } from '../lib/audit-summary.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The login flow's final step: uploads this machine's past sessions into Beezi. The beezi-login
// skill runs it after the link and plan capture, and re-running beezi-login resumes an
// interrupted upload. Flags (--dry-run / --since / --force) remain for manual
// `node scripts/backfill.mjs` runs only.
//
// Every user-visible sentence lives in lib/audit-summary.mjs, so the wording can be asserted
// without spawning this script against a fake credential store. This file is the wiring: flags in,
// progress out, the renderer's verdict printed, a non-zero exit on its `error`.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const result = await runAudit(
    {
      // "read", not "sent": `processed` counts candidates PARSED, and a parsed session may still
      // produce nothing to upload. Calling it "sent" is what makes final totals look like they
      // lost sessions when the arithmetic is simply against a different number.
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  const summary = renderBackfillSummary(result, options);
  if (summary.error != null) fail(summary.error);
  for (const line of summary.lines) console.log(line);
}

main().catch((error) => fail(friendlyMessage(error)));
