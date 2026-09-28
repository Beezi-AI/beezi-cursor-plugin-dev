// What one node start costs on this machine, right now — the slack a spawned-process timing assert
// is owed, and nothing more.
//
// The gate tests time `beforeSubmitPrompt` from the moment its answer reaches stdout to the moment
// the process is gone, against the gate budget (hookBudgetMs, 500 ms). That window holds a `spawn`
// of the recorder and the gate's own teardown, and both are paid in the same currency as a node
// start: on an idle box they are a few tens of milliseconds, and on a box running the whole suite in
// parallel the same work can take several hundred. A budget assert that ignores that fails under
// load for a gate that did nothing wrong. A gate that BLOCKS — on a stalled filesystem, on a
// synchronous append — still fails, because what it costs is the stall (seconds), not one extra
// process start.
//
// Measured, not guessed: `process.execPath -e ""` spawned once, the first time a test file asks, and
// the figure is kept for the rest of that file. Once per file on purpose — load changes over a run,
// and a figure taken minutes earlier by another file would describe a different machine.
//
// NOTHING RUNS AT IMPORT. `node --test` with no arguments runs every .mjs under test/ as a test file,
// this one included (test/helpers/loop-alive.mjs is loaded the same way), so a measurement taken at
// the top level would spawn a node for no one on every run of the suite.
import { spawnSync } from 'node:child_process';

let measured = null;

export function startupMs() {
  if (measured === null) {
    const startedAt = process.hrtime.bigint();
    const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', timeout: 20_000 });
    // A probe that failed measured nothing. Timed out, it would read ~20 000 ms and every budget
    // assert built on it would pass for any gate at all, so it fails the test instead of widening them.
    if (result.error || result.status !== 0) {
      throw new Error(`the node-startup probe failed (status ${result.status}): ${result.error ? result.error.message : 'non-zero exit'}`);
    }
    measured = Number(process.hrtime.bigint() - startedAt) / 1e6;
  }
  return measured;
}
