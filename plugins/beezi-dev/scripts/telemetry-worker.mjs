import { suppressRecording } from '../lib/telemetry-recorder.mjs';
import { runWorker, startWatchdog } from '../lib/telemetry-worker.mjs';

// Detached entry point for diagnostics delivery. Argv carries nothing: consent, the queue and the
// backoff all live in files this process rereads itself, and an argument list is visible to every
// process on the machine.
//
// Nothing is ever written to stdout or stderr. This process is spawned from inside a hook, and a
// hook's streams are the host's protocol channel.

suppressRecording(true);

const watchdog = startWatchdog();

runWorker()
  .catch(() => {})
  .then(() => { clearTimeout(watchdog); process.exit(0); });
