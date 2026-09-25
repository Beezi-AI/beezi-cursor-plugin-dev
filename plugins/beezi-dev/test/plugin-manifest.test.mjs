import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BEEZI_HOOKS, PLUGIN_ROOT, hookTimeoutSec } from '../lib/hooks-install.mjs';
import { HookSource } from '../lib/hook-source.mjs';
import { hookBudgetMs, HOOK_KIND_GATE } from '../lib/hook-runner.mjs';
import { readJson } from '../lib/fs-store.mjs';

// Cursor's plugin spec, checked against what is actually on disk. Every assertion here is a path
// Cursor resolves itself: get one wrong and the plugin installs, reports success, and serves
// nothing — which is exactly how this layout failed the first time.

// The one variable Cursor expands for a plugin, in both the MCP config and a hook command.
const VAR = '${CURSOR_PLUGIN_ROOT}';

const manifest = () => readJson(path.join(PLUGIN_ROOT, '.cursor-plugin', 'plugin.json'));
const hooksRegistry = () => readJson(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'));

test('the manifest lives where Cursor looks for it', () => {
  // NOT <root>/plugin.json — that is Claude Code's layout, and Cursor silently ignores it.
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, '.cursor-plugin', 'plugin.json')));
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, 'plugin.json')), false);
  assert.equal(manifest().name, 'beezi');
});

test('one version, declared in three places that must agree', () => {
  // Cursor reads the marketplace entry to decide whether an installed copy is stale, and the plugin
  // manifest to name what it installed. Neither is derived from the other, and `npm version` updates
  // only the third — so the three drift silently, and a machine keeps running an old copy because
  // the marketplace says it is current.
  const repoRoot = path.dirname(path.dirname(PLUGIN_ROOT));
  const declared = manifest().version;
  assert.match(declared, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson(path.join(PLUGIN_ROOT, 'package.json')).version, declared);
  const entry = readJson(path.join(repoRoot, '.cursor-plugin', 'marketplace.json'))
    .plugins.find((p) => p.name === 'beezi');
  assert.equal(entry.version, declared);
});

test('every component path the manifest declares exists', () => {
  const m = manifest();
  for (const field of ['skills', 'hooks', 'mcpServers']) {
    assert.equal(typeof m[field], 'string', `${field} must be declared`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, m[field])), `${field} → ${m[field]} is missing`);
  }
});

test('nothing ships as a plugin command, because Cursor can refuse to load one', () => {
  // `loadAllCommands` gates plugin commands on `thirdPartyExtensibilityEnabled` AND the
  // `enable_cc_plugin_import` server-side feature gate; with either off, `loadPluginCommands` is
  // never called and every command in this plugin silently does not exist. Skills are loaded on a
  // path with no such gate, so the user-invoked entry points ship as skills instead.
  assert.equal(manifest().commands, undefined);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, 'commands')), false);
});

test('the MCP server is addressed by ${CURSOR_PLUGIN_ROOT}, never a relative path', () => {
  const mcp = readJson(path.join(PLUGIN_ROOT, 'mcp.json'));
  const server = mcp.mcpServers.beezi;
  assert.equal(server.command, 'node');
  // A relative arg is resolved against the MCP process's cwd — the user's HOME directory, which is
  // how this shipped broken: "Cannot find module 'C:\\Users\\<user>\\scripts\\mcp.mjs'". Cursor
  // substitutes ${CURSOR_PLUGIN_ROOT} in command, args, env and cwd before spawning.
  // --no-warnings first: node:sqlite is experimental, and its warning on stderr is noise in the
  // MCP log for a server that is working.
  assert.deepEqual(server.args, ['--no-warnings', `${VAR}/scripts/mcp.mjs`]);
  assert.equal(server.cwd, VAR);
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', 'mcp.mjs')));
  // `env_vars` is not in Cursor's schema — an unknown key here is what broke registration before.
  assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'cwd']);
});

test('the bundled registry covers exactly the events the installer registers', () => {
  const registry = hooksRegistry();
  assert.equal(registry.version, 1);
  assert.deepEqual(Object.keys(registry.hooks).sort(), BEEZI_HOOKS.map((h) => h.event).sort());
});

test('every bundled hook runs a script that exists, and says which registry it came from', () => {
  const registry = hooksRegistry();
  for (const { event, script } of BEEZI_HOOKS) {
    const handlers = registry.hooks[event];
    assert.equal(handlers.length, 1, `${event} must have exactly one handler`);
    const { command, timeout } = handlers[0];
    // Absolute via the variable, quoted for a path containing spaces. NOT relative: Cursor runs
    // `stop` and `subagentStop` from the workspace folder, not the plugin root, so a relative
    // command works for eight of the ten and silently fails for the two that close a session or a
    // subagent.
    assert.equal(command, `node --no-warnings "${VAR}/scripts/${script}" --via ${HookSource.PLUGIN}`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', script)), `${script} is missing`);
    // Per EVENT, not uniform. A permission hook (beforeMCPExecution, subagentStart) sits in FRONT of
    // the user's action — the host holds the MCP call or the subagent launch until the hook answers
    // — so a stall there is dead time in an editor that has not moved, and it gets 5s. The analytics
    // hooks run behind the work and keep the 10s lib/checkpoint.mjs derives HOOK_BUDGET_MS from;
    // shortening those would truncate the queue flush for no benefit to anyone. The prompt gate
    // (beforeSubmitPrompt) holds the user's Send on every turn, so it gets 3s.
    //
    // One lookup serves BOTH registries — this bundled one and the user-scope one the installer
    // writes — because the same script runs under both, and a deadline declared in only one of them
    // is a script written to two different budgets. See hookTimeoutSec in lib/hooks-install.mjs, and
    // the parity test in test/hooks-install.test.mjs that reads this file and the builder together.
    assert.equal(timeout, hookTimeoutSec(event));
  }
});

test('every hook script claims the run before doing any work', () => {
  // NOT a duplicate guard any more, and it has not been one since arbitration was removed.
  // `claimHookRun()` always returns true: both registries stay installed, both fire, and the
  // duplicate lines are collapsed by the READER on the host's own event id (dedupeEvents in
  // lib/delta-cursor.mjs). The stand-down this line used to perform is exactly what blinded
  // the `cursor-agent` builds that run no plugin-bundled hook (Jun–Aug 2026) — see
  // lib/hook-source.mjs.
  //
  // What the call still does is RECORD which registry started the run, per registry, in
  // ~/.beezi-cursor/state/hook-source.json. Nothing is gated on it; `install status`, `me` and the
  // session banner read it, and "no bundled hook has ever run here" is the one signal that tells a
  // CLI-only machine apart from a broken install.
  //
  // The assertion stays because that record has to come from every script. A new hook added without
  // the line is a hook whose registry is invisible to all three surfaces, and the only symptom is a
  // status report that is quietly wrong.
  //
  // The ONE exemption is the prompt gate, and it is pinned the other way round in its own structure
  // test below. Codex review, BLOCKING: Cursor holds the user's Send until the gate PROCESS ends, so
  // a JSON read and an atomic write in front of every Send buys nothing — every other hook records
  // the same registry on every event, `stop` included, which ends every turn the gate starts.
  for (const { script, gate } of BEEZI_HOOKS) {
    if (gate === true) continue;
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf-8');
    assert.match(body, /if \(!claimHookRun\(\)\) process\.exit\(0\)/, `${script} does not claim its run`);
  }
});

test('every hook script moves to the project directory before doing any work', () => {
  // Cursor starts most of them inside the plugin directory, which is itself a git clone. Without
  // this call every segment would be attributed to the Beezi plugin repository.
  //
  // The ONE exemption is the prompt gate, pinned the other way round here and in its structure test
  // below. Codex review, BLOCKING: `enterProjectDir()` is a synchronous `fs.existsSync` plus a
  // `process.chdir`, and Cursor holds the user's Send until the gate PROCESS ends — a timer cannot
  // interrupt either call, so a 900 ms existsSync stall on a wedged workspace kept Send held 916 ms.
  // The gate shells out to nothing (attribution is the reason every other hook enters the
  // workspace), and the cwd it stamps is derived from the payload and the environment by
  // stampableCwd, without touching the disk. test/prompt-submit.test.mjs proves it at runtime with
  // every synchronous fs call in the gate process stalled.
  for (const { script, gate } of BEEZI_HOOKS) {
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf-8');
    if (gate === true) {
      const code = body.replace(/\/\/.*$/gm, '');
      assert.equal(/enterProjectDir\s*\(/.test(code), false, `${script} enters the project directory in front of Send`);
      continue;
    }
    assert.match(body, /^enterProjectDir\(\);$/m, `${script} does not enter the project directory`);
  }
});

// The events whose stdout Cursor READS AND OBEYS. A `{"permission":"deny"}` on one of these blocks
// a tool call or a subagent the user asked for, inside their editor, with no explanation — so the
// rule for an analytics plugin is that it says nothing at all on these two, ever.
const PERMISSION_EVENTS = ['beforeMCPExecution', 'subagentStart'];

const permissionScripts = () =>
  BEEZI_HOOKS.filter((h) => PERMISSION_EVENTS.includes(h.event)).map((h) => h.script);

test('the permission hooks are the ones we think they are', () => {
  // If this fails, a permission-bearing event was registered without anyone deciding it was safe —
  // the stdout tests below only cover what is named here.
  assert.deepEqual(permissionScripts().sort(), ['mcp-before.mjs', 'subagent-start.mjs']);
});

test('no permission hook script contains a way to write to stdout', () => {
  for (const script of permissionScripts()) {
    const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf-8');
    // Grepped, not just executed: a stdout write added on a branch these tests do not exercise is
    // exactly the one that would ship. `process.exit` is fine; `process.stdout` is not.
    assert.equal(/process\s*\.\s*stdout/.test(body), false, `${script} can write to stdout`);
    assert.equal(/console\s*\.\s*(log|info|dir|table)/.test(body), false, `${script} can write to stdout`);
    // Exit 2 is Cursor's "block this action". Nothing in an analytics plugin may reach for it.
    assert.equal(/process\.exit\((?!0\))/.test(body), false, `${script} can exit non-zero`);
  }
});

// The GATE hook: `beforeSubmitPrompt` holds the user's Send until it answers
// `{"continue": true|false, "user_message"?}`, and exit 2 blocks the prompt. It is not a permission
// hook (those must say nothing, and the grep above would rightly flag this one), so it gets its own
// structural pin. The runtime half — every path prints exactly the token and exits 0 — is in
// test/prompt-submit.test.mjs and test/hook-bootstrap.test.mjs.
const gateScripts = () => BEEZI_HOOKS.filter((h) => h.gate === true).map((h) => h.script);

test('the prompt gate answers exactly once, first, and has no other way to reach stdout', () => {
  assert.deepEqual(gateScripts(), ['prompt-submit.mjs']);
  assert.equal(permissionScripts().includes('prompt-submit.mjs'), false, 'the gate is not a permission hook');
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'prompt-submit.mjs'), 'utf-8');
  // Code only: the comments explain the contract and name the very things the code may not do.
  const body = source.replace(/\/\/.*$/gm, '');
  const answer = "fs.writeSync(1, '{\"continue\":true}')";
  assert.equal(body.split(answer).length - 1, 1, 'exactly one answer');
  assert.equal((body.match(/writeSync\s*\(/g) || []).length, 1, 'no second synchronous write');
  // ORDER: guards, then the wall-clock guard, then the answer, then everything that reads, loads,
  // appends or can exit early. Each `later` must be PRESENT as well as late: a missing one reads as
  // index -1, which is not after anything.
  const at = (needle) => body.indexOf(needle);
  const wall = 'setTimeout(leave, GATE_WALL_MS)';
  assert.ok(at('installHookGuards(') !== -1 && at('installHookGuards(') < at(wall), 'the wall guard precedes the process guards');
  assert.ok(at(wall) !== -1 && at(wall) < at(answer), 'the wall guard is armed after the answer, or not at all');
  // `enterProjectDir()` is no longer on this list: the gate does not call it at all (see the
  // project-directory test above). The recorder's append is `fs.appendFile(`, the asynchronous
  // call that replaced `appendEvent(` so a stalled sidecar cannot outlive the recorder's deadline.
  for (const later of ['process.stdin', 'import(', 'spawn(', 'fs.appendFile(']) {
    assert.ok(at(later) > at(answer), `${later} runs before the answer is written`);
  }
  // NO SYNCHRONOUS I/O IN THE GATE, and the recorder that does the write instead. Codex review,
  // BLOCKING, the second time round: a timer cannot interrupt a synchronous call, so a 900 ms
  // synchronous append stub kept the process — and the user's Send — alive 914 ms after answering,
  // wall guard or no wall guard. The gate now reads stdin through events and hands the line to a
  // detached recorder; the script itself holds no synchronous read of stdin and no synchronous
  // write but the answer (the recorder's append is lib/sidecar.mjs's, reached by import).
  for (const sync of ['appendFileSync', 'writeFileSync', 'readFileSync(0', 'readSync(']) {
    assert.equal(body.includes(sync), false, `${sync} is back in the gate script`);
  }
  // The recorder inherits NO stdio handle — Cursor may wait for the gate's pipes to close as well as
  // for its exit — is detached from the gate's process group, opens no console window on Windows,
  // and is not waited for.
  assert.match(body, /detached: true/);
  assert.match(body, /windowsHide: true/);
  assert.match(body, /stdio: \['ignore', 'ignore', 'ignore'\]/);
  assert.match(body, /\.unref\(\)/);
  // The hand-off goes through the environment, never the command line a process listing shows.
  assert.match(body, /\[\s*'--no-warnings',\s*SELF,\s*RECORD_FLAG\s*\]/);
  // The guard ends the process inside the gate budget. Codex review, BLOCKING: Cursor waits for the
  // hook PROCESS, not the answer, and the runner's 500 ms gate budget used to be enforced by nothing.
  const wallMs = Number((/const GATE_WALL_MS = (\d+);/.exec(body) || [])[1]);
  assert.ok(wallMs > 0 && wallMs < hookBudgetMs(HOOK_KIND_GATE), `GATE_WALL_MS ${wallMs} is not inside the gate budget`);
  // Nothing on the gate's path but the read and the hand-off: no registry bookkeeping (the exemption
  // in the claim test above), no runner and its unbounded tail, and no capture replay spill.
  assert.equal(/claimHookRun/.test(body), false, 'registry bookkeeping is back in front of Send');
  assert.equal(/\brunHook\b/.test(body), false, 'the runner is back on the gate path');
  assert.equal(/captureHookStdin/.test(body), false, 'the gate spills stdin to a replay file again');
  // Nothing else may reach the stream, and nothing may refuse or annotate the user's prompt.
  assert.equal(/\bemit\b/.test(body), false, 'ctx.emit would be a second token');
  assert.equal(/failOutput/.test(body), false, 'a failOutput would be a second token on the failure path');
  assert.equal(/process\s*\.\s*stdout/.test(body), false);
  assert.equal(/console\s*\./.test(body), false);
  assert.equal(/user_message/.test(body), false);
  assert.equal(/"continue"\s*:\s*false/.test(body), false);
  assert.equal(/process\.exit\((?!0\))/.test(body), false, 'exit 2 blocks the prompt');
  // A `gen` line derived from this payload would bill a generation Cursor has not started.
  assert.equal(/eventsFromHookPayload\s*\(/.test(body), false);
  // Declared a gate to the guards, or their crash path takes another kind's way out.
  assert.match(body, /installHookGuards\(\{[^}]*gate: true/);
});

// Run a hook script the way Cursor does — stdin piped, `--via plugin-hooks` on the command line —
// with a throwaway home so nothing lands in the developer's real ~/.beezi-cursor.
function runHook(script, stdin, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hook-run-'));
  try {
    const stdout = execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', script), '--via', 'plugin-hooks'], {
      input: stdin,
      encoding: 'utf-8',
      // stderr inherited into a pipe we discard: a hook is allowed to be noisy there, and Node's own
      // report of a caught-and-exited error would otherwise fail the run.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BEEZI_CURSOR_HOME: home, CURSOR_CONFIG_DIR: path.join(home, 'cursor'), ...extraEnv },
    });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', code: error.status };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a permission hook says nothing and exits 0 on a valid payload', () => {
  for (const script of permissionScripts()) {
    const res = runHook(script, JSON.stringify({ session_id: 'c1', hook_event_name: 'x', cwd: process.cwd() }));
    assert.equal(res.stdout, '', `${script} wrote to stdout`);
    assert.equal(res.code, 0, `${script} did not exit 0`);
  }
});

test('a permission hook says nothing and exits 0 on a payload it cannot parse', () => {
  // Malformed input is not hypothetical: lib/hook-input-cursor.mjs documents Windows PowerShell
  // prepending a BOM to every payload, which made JSON.parse reject on every hook on every Windows
  // machine. If that had happened on a permission hook that answered on stdout, it would have
  // blocked the user's MCP calls rather than merely losing analytics.
  for (const script of permissionScripts()) {
    for (const input of ['', 'not json at all', '﻿{"session_id":"c1"}', '{"session_id":']) {
      const res = runHook(script, input);
      assert.equal(res.stdout, '', `${script} wrote to stdout on ${JSON.stringify(input)}`);
      assert.equal(res.code, 0, `${script} did not exit 0 on ${JSON.stringify(input)}`);
    }
  }
});

test('a permission hook says nothing and exits 0 even when it throws internally', () => {
  // Date.now is read in a default parameter inside claimHookRun, past every try/catch in the script,
  // so breaking it is a genuine uncaught throw in the middle of the hook rather than a simulated
  // one. Without the uncaughtException handler at the top of these scripts this exits 1 and puts a
  // stack trace in Cursor's execution log on every MCP call.
  const boom = 'data:text/javascript,Date.now=()=>{throw new Error("boom")}';
  for (const script of permissionScripts()) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hook-throw-'));
    let out;
    let code = 0;
    try {
      out = execFileSync(
        process.execPath,
        ['--import', boom, path.join(PLUGIN_ROOT, 'scripts', script), '--via', 'plugin-hooks'],
        { input: '{"session_id":"c1"}', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BEEZI_CURSOR_HOME: home } },
      );
    } catch (error) {
      out = error.stdout ?? '';
      code = error.status;
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    assert.equal(out, '', `${script} wrote to stdout while failing`);
    assert.equal(code, 0, `${script} exited ${code} while failing — 2 blocks the user's action`);
  }
});

test('the capture harness is wired on the four newest hooks, and stays off until asked', () => {
  // WHAT THIS GUARANTEES, and it is narrower than the name it used to have. These four scripts were
  // capture-only stubs once; they are not any more — `file-edit.mjs` writes the `edit` lines that are
  // the only source of code_changes on a machine without ai-code-tracking.db, `mcp-before.mjs` writes
  // the `mcp_server` identity line, and the two subagent scripts write the span the session timeline
  // correlates. None of that real work is asserted here. What IS asserted is the capture wiring on
  // top of it, which has three properties worth pinning:
  //
  //   1. exactly ONE line per hook run. Two would mean the payload was read twice, and stdin is
  //      single-shot: the second read of a drained pipe returns nothing, so a script that reads it
  //      for capture and again for its own work does its work on an empty payload — silently, for
  //      the whole capture session, on the one machine that finally has Cursor installed.
  //   2. `raw` is the bytes verbatim. The BOM question (lib/hook-input-cursor.mjs) is one of the
  //      things a capture session exists to answer, and a record that had already been BOM-stripped
  //      could not answer it.
  //   3. NOTHING is written when BEEZI_CURSOR_DUMP_HOOKS is unset. A capture harness that is always
  //      on is a plugin that always writes unredacted tool output, shell command text and file paths
  //      to disk, and the off-by-default half is the only reason it is allowed to ship at all.
  //
  // The replay spill file is checked too: capture spills stdin to a file so the hook can still parse
  // it, and a capture session is thousands of runs — left behind they are thousands of files holding
  // full payloads in the user's home.
  //
  // Only these four are covered. The other six hook scripts wire the identical two calls and are not
  // exercised here, because they load the reporting engine and would do git and network work against
  // a throwaway home.
  for (const script of ['file-edit.mjs', 'mcp-before.mjs', 'subagent-start.mjs', 'subagent-stop.mjs']) {
    for (const capturing of [false, true]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hook-capture-'));
      const env = { ...process.env, BEEZI_CURSOR_HOME: home };
      if (capturing) env.BEEZI_CURSOR_DUMP_HOOKS = '1';
      else delete env.BEEZI_CURSOR_DUMP_HOOKS;
      try {
        execFileSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', script), '--via', 'plugin-hooks'], {
          input: '{"session_id":"c1","tool_name":"t"}',
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
        const file = path.join(home, 'capture', 'hooks.jsonl');
        assert.equal(fs.existsSync(file), capturing, `${script} capture=${capturing} wrote the wrong thing`);
        if (!capturing) continue;
        const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
        assert.equal(lines.length, 1, `${script} wrote ${lines.length} capture lines for one run`);
        const record = JSON.parse(lines[0]);
        assert.equal(record.script, script);
        assert.equal(record.via, 'plugin-hooks');
        assert.equal(record.raw, '{"session_id":"c1","tool_name":"t"}');
        // The replay file is cleaned up on the way out — a capture session is thousands of runs.
        assert.deepEqual(fs.readdirSync(path.join(home, 'capture', 'stdin')), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test('the skills Cursor loads are where the manifest says they are', () => {
  const skills = path.join(PLUGIN_ROOT, manifest().skills);
  const dirs = fs.readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length > 0);
  for (const d of dirs) {
    assert.ok(fs.existsSync(path.join(skills, d.name, 'SKILL.md')), `${d.name} has no SKILL.md`);
  }
});

// Every skill that runs something. `beezi-analytics` is the exception: it reads the MCP server's
// analytics tools and runs no script at all, so it carries no `<BEEZI>` preamble by design.
//
// Hand-maintained, and that is the hazard this comment exists to name: a runner skill ABSENT from
// this list is exempt from the `disable-model-invocation`, `<BEEZI>`-resolution and script-exists
// checks below, and nothing announces the omission.
const RUNNER_SKILLS = [
  'beezi-login',
  'beezi-logout',
  'beezi-me',
  'beezi-track',
  'beezi-install',
  'beezi-refresh',
  'beezi-sync',
  'beezi-telemetry',
];

function skillBody(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
}

test('the user-invoked entry points ship as skills, and only the model is kept out of them', () => {
  for (const name of RUNNER_SKILLS) {
    const body = skillBody(name);
    // Without this the agent invokes them on its own initiative — these open browsers and rewrite
    // registries, which is not something to do because a sentence looked related.
    assert.match(body, /^disable-model-invocation: true$/m, `${name} may be model-invoked`);
    assert.match(body, new RegExp(`^name: ${name}$`, 'm'), `${name}'s frontmatter name must match`);
  }
});

test('no skill asks a shell to expand ${CURSOR_PLUGIN_ROOT}', () => {
  for (const name of RUNNER_SKILLS) {
    const body = skillBody(name);
    // Cursor expands ${CURSOR_PLUGIN_ROOT} in a hook's `command` and an MCP server's `args`. It
    // does NOT expand it in a skill: the body is inlined verbatim under a "SKILL.md content:"
    // header, so the model receives the literal token, translates it to $env:CURSOR_PLUGIN_ROOT
    // or $CURSOR_PLUGIN_ROOT, and the shell resolves it to nothing — `Cannot find module
    // 'C:\scripts\track.mjs'`. Verified in an agent transcript, not inferred.
    assert.equal(
      body.includes('${CURSOR_PLUGIN_ROOT}'),
      false,
      `${name} expects a substitution Cursor does not perform on skills`,
    );
    // ~/.beezi-cursor/bin/beezi.mjs is written by the MCP server at session start. Depending on it
    // means every entry point is dead until that has happened at least once — which is precisely
    // the state a machine is in right after installing the plugin.
    assert.equal(body.includes('.beezi-cursor/bin'), false, `${name} depends on the generated shim`);
    assert.equal(
      body.includes('.cursor/plugins/local/beezi/scripts'),
      false,
      `${name} names a plugin path that a marketplace install does not have`,
    );
  }
});

test('a skill tells the model how to resolve <BEEZI> from the path Cursor gave it', () => {
  for (const name of RUNNER_SKILLS) {
    const body = skillBody(name);
    assert.match(body, /<BEEZI>\/scripts\//, `${name} names no plugin script`);
    // The anchor is Cursor's own "Path: …/skills/<name>/SKILL.md" line, which precedes every
    // inlined skill. Without an explicit rule for turning it into a plugin root, the model guesses.
    assert.match(body, /Resolve `<BEEZI>` first/, `${name} does not explain <BEEZI>`);
    assert.ok(
      body.includes(`skills/${name}/SKILL.md\` removed`),
      `${name}'s resolution rule does not name its own path`,
    );
  }
});

test('every script a skill invokes exists', () => {
  for (const name of RUNNER_SKILLS) {
    for (const [, script] of skillBody(name).matchAll(/<BEEZI>\/scripts\/([\w.-]+)/g)) {
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', script)), `${name} → ${script} is missing`);
    }
  }
});
