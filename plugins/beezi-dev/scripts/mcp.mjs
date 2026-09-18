// Stdio entry for the Beezi MCP server: Cursor runs this instead of
// connecting to the portal directly, so the stored sign-in credentials
// authenticate MCP too — no separate OAuth prompt. Logic in lib/mcp-bridge.mjs.
import readline from 'readline';
import { createBridge, createIssueRecorder } from '../lib/mcp-bridge.mjs';
import { ensureInstalled } from '../lib/plugin-install.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Cursor spawns this server once per session, from the installed plugin directory — the only
// process that reliably knows where that directory is. So this is where the parts a marketplace
// install cannot carry get written: the `~/.beezi-cursor/bin` shim the commands invoke, and the
// user-scope hook registry, if the bundled `hooks/hooks.json` is not firing. Never fatal, and never
// on stdout: stdout is the JSON-RPC channel.
try {
  const { source, actions } = ensureInstalled();
  if (actions.length) process.stderr.write(`[beezi-mcp] install (${source}): ${actions.join(', ')}\n`);
} catch (error) {
  const message = error == null ? undefined : error.message;
  process.stderr.write(`[beezi-mcp] self-install skipped: ${message == null ? error : message}\n`);
}

// stdout on a pipe is asynchronous, so a forced exit drops whatever is still buffered — including
// the response we waited for the in-flight work below to produce. Keeping only the newest write's
// flush promise is enough: stream writes complete in order, so awaiting the last implies the rest.
let flushed = Promise.resolve();
const write = (line) => {
  flushed = new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
};

// Startup and handshake failures used to exist only on stderr, where nobody reads them. This
// routes them to the consent-gated telemetry facade instead — structured code, source, status,
// reason and duration, never a token, a URL, RPC arguments or a response body. A machine that has
// not opted in has no lib/telemetry.mjs to load, and the recorder stays silent.
const recordIssue = createIssueRecorder({
  onError: (error) => {
    const message = error == null ? undefined : error.message;
    process.stderr.write(`[beezi-mcp] diagnostics unavailable: ${message == null ? error : message}\n`);
  },
});

const bridge = createBridge({ write, recordIssue });
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Handling is async — a tool call can be a whole browser sign-in — so exiting the moment stdin
// ends would drop whatever is still in flight and swallow its response. Track the outstanding
// work and leave only once it has settled.
const inFlight = new Set();
let stdinClosed = false;
let leaving = false;

async function maybeExit() {
  if (leaving || !stdinClosed || inFlight.size > 0) return;
  leaving = true;
  await flushed;
  // exitClean, not process.exit: undici's keep-alive handles trip a libuv assertion on Windows
  // when the process is torn down while they are still open.
  await exitClean(0);
}

rl.on('line', (line) => {
  // A throw anywhere in handling must not escape as an unhandled rejection — Node makes those
  // fatal, and staying up for the whole session is this server's entire job.
  const work = bridge
    .handleLine(line)
    .catch((error) => {
      const message = error == null ? undefined : error.message;
      process.stderr.write(`[beezi-mcp] ${message == null ? error : message}\n`);
    })
    .finally(() => {
      inFlight.delete(work);
      void maybeExit();
    });
  inFlight.add(work);
});

rl.on('close', () => {
  stdinClosed = true;
  // Stdin closing is the end of the session: the bridge's recovery watcher must stop probing a
  // portal for a client that is gone, and must not be able to write to a stdout nobody reads.
  // In-flight work is still drained below — disposing is not cancelling.
  bridge.dispose();
  void maybeExit();
});
