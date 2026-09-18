import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BEEZI_HOOKS, PERMISSION_EVENTS } from '../lib/hooks-install.mjs';

// Every registered hook, run the way Cursor runs it, with its business layer broken on purpose.
//
// The failure this suite pins is not hypothetical. Eight of the ten scripts used to reach their
// business modules through STATIC imports, so a module that threw while being evaluated took the
// process down before the script's first statement: exit 1, a stack trace on stderr, and a FAILED
// HOOK entry in Cursor's execution log — on the user's own tool call, for work that was only ever
// best-effort analytics. Two of the ten are worse than cosmetic: `beforeMCPExecution` and
// `subagentStart` are permission hooks whose stdout Cursor reads and obeys.
//
// So each script is run in its own process with a module loader that replaces one business module
// with a broken one, and what is asserted is the same three things every time: exit 0, protocol-safe
// stdout, and termination inside the host's deadline.
//
// test/hook-runner.test.mjs owns the runner's own decisions; this file owns the wiring.

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const LIB = path.join(PLUGIN_ROOT, 'lib');

// Cursor's own ceiling is 10s (5s for a permission hook). A run that has not finished in twice that
// is not "slow", it is the unbounded hang this bootstrap exists to make impossible.
const KILL_MS = 20000;

// One business module per script, and the export its handler actually calls.
//
// `lib/sidecar.mjs` is the common one by construction: nine of the ten append at least one line, and
// it is reached only through `load`, never through the four bootstrap imports at the top of a hook
// entry. `session-start.mjs` has no sidecar work of its own, so its own engine module stands in.
const BROKEN = Object.freeze({
  'session-start.mjs': { module: 'session-start.mjs', symbol: 'runSessionStart' },
  'checkpoint.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'tool-event.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'stop.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'report.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'stop-failure.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'file-edit.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'mcp-before.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'subagent-start.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
  'subagent-stop.mjs': { module: 'sidecar.mjs', symbol: 'appendEvent' },
});

const permissionScripts = new Set(
  BEEZI_HOOKS.filter((h) => PERMISSION_EVENTS.includes(h.event)).map((h) => h.script),
);

// A payload that is valid and attributable, and that names no working directory.
//
// It used to carry `cwd: PLUGIN_ROOT`, which sent `enterProjectDir()` and every git shell-out in the
// checkpoint into THIS CHECKOUT — the developer's own repository, on a suite that is supposed to be
// hermetic. `runScript` sets CURSOR_PROJECT_DIR to the throwaway home instead, so `stampableCwd`
// resolves there and git runs in a directory that is not a repository at all.
const PAYLOAD = JSON.stringify({
  session_id: 'conv-bootstrap',
  hook_event_name: 'postToolUse',
  tool_name: 'read_file',
});

// The stub, plus the loader that puts it in front of the real module.
//
// The stub re-exports the real module through a URL carrying a query string, which is what keeps the
// resolve hook from redirecting the stub's own import back to itself. An explicitly named export
// shadows a star re-export, so exactly one symbol is broken and everything else — `safeName`, which
// lib/checkpoint.mjs and lib/lock.mjs both import from lib/sidecar.mjs — still behaves.
//
// EVERY mode replaces a module, and that is a property of the suite rather than a convenience:
// no run here reaches the real credential store (which on Windows is an absolute path to
// powershell.exe that no environment variable can redirect) or the real reporting path.
function writeLoader(dir, target, symbol, mode) {
  const realUrl = `${pathToFileURL(path.join(LIB, target)).href}?real=1`;
  const stub = mode === 'import-failure'
    ? 'throw new Error("beezi-test: this module cannot be evaluated");\n'
    : `export * from ${JSON.stringify(realUrl)};\n`
      + `export function ${symbol}() {\n`
      + (mode === 'rejects'
        ? '  return Promise.reject(new Error("beezi-test: business rejected"));\n'
        : '  throw new Error("beezi-test: business threw");\n')
      + '}\n';
  fs.writeFileSync(path.join(dir, 'stub.mjs'), stub, 'utf-8');
  // The credential accessor, answering "not linked", on EVERY run.
  //
  // Not belt-and-braces. In the `rejects` mode the stubbed function returns a rejected promise
  // rather than throwing, so the handler carries on — and for stop/report that means the real
  // reporting engine runs, which reaches the platform credential store. On Windows that is an
  // absolute path to powershell.exe which no environment variable can redirect (see the header of
  // test/stop-failure.test.mjs), so on a linked machine this suite would read the developer's own
  // token. Answering null short-circuits the engine before any of that.
  fs.writeFileSync(
    path.join(dir, 'token-stub.mjs'),
    'export async function getAccessToken() { return null; }\n'
      + 'export function invalidateTokenCache() {}\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'loader.mjs'),
    'const STUB = new URL("./stub.mjs", import.meta.url).href;\n'
      + 'const TOKEN_STUB = new URL("./token-stub.mjs", import.meta.url).href;\n'
      + `const TARGET = ${JSON.stringify(`/lib/${target}`)};\n`
      + 'export async function resolve(specifier, context, next) {\n'
      + '  const result = await next(specifier, context);\n'
      + '  const url = new URL(result.url);\n'
      + '  if (url.search !== "") return result;\n'
      + '  if (url.pathname.endsWith(TARGET)) return { ...result, url: STUB, shortCircuit: true };\n'
      + '  if (url.pathname.endsWith("/lib/token.mjs")) return { ...result, url: TOKEN_STUB, shortCircuit: true };\n'
      + '  return result;\n'
      + '}\n',
    'utf-8',
  );
  const entry = path.join(dir, 'register.mjs');
  fs.writeFileSync(
    entry,
    'import { register } from "node:module";\n'
      + 'register("./loader.mjs", import.meta.url);\n',
    'utf-8',
  );
  return entry;
}

function runScript(script, { loaderEntry = null, input = PAYLOAD } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-bootstrap-'));
  const args = [];
  if (loaderEntry) args.push('--import', pathToFileURL(loaderEntry).href);
  args.push(path.join(SCRIPTS, script), '--via', 'plugin-hooks');
  const started = Date.now();
  try {
    const stdout = execFileSync(process.execPath, args, {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: KILL_MS,
      env: {
        ...process.env,
        BEEZI_CURSOR_HOME: home,
        CURSOR_CONFIG_DIR: path.join(home, 'cursor'),
        // The workspace a hook attributes to, and the directory git is run in. Pointed at the
        // throwaway home so no part of this suite can touch the developer's own checkout.
        CURSOR_PROJECT_DIR: home,
        CLAUDE_PROJECT_DIR: home,
        // Nothing here may reach the network even if a business path survives the injection.
        BEEZI_API_URL: 'http://127.0.0.1:1',
      },
    });
    return { stdout, code: 0, ms: Date.now() - started };
  } catch (error) {
    return {
      stdout: error.stdout == null ? '' : error.stdout,
      code: error.status == null ? `signal:${error.signal}` : error.status,
      ms: Date.now() - started,
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const { script } of BEEZI_HOOKS) {
  const broken = BROKEN[script];
  const permission = permissionScripts.has(script);

  test(`${script} contains a business module that cannot be evaluated`, () => {
    // The dynamic-import failure. Under the old static imports this was an exit 1 before the script
    // body ran at all — there was nowhere left to catch it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-loader-'));
    try {
      const entry = writeLoader(dir, broken.module, broken.symbol, 'import-failure');
      const res = runScript(script, { loaderEntry: entry });
      assert.equal(res.code, 0, `${script} exited ${res.code} on an import failure`);
      assert.equal(res.stdout, '', `${script} wrote to stdout on an import failure`);
      assert.ok(res.ms < KILL_MS, `${script} did not terminate inside the host deadline`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${script} contains a business function that throws`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-loader-'));
    try {
      const entry = writeLoader(dir, broken.module, broken.symbol, 'throws');
      const res = runScript(script, { loaderEntry: entry });
      assert.equal(res.code, 0, `${script} exited ${res.code} on a business throw`);
      assert.equal(res.stdout, '', `${script} wrote to stdout on a business throw`);
      assert.ok(res.ms < KILL_MS, `${script} did not terminate inside the host deadline`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${script} contains a business promise nobody catches`, () => {
    // The rejection is raised from INSIDE the handler, by the stubbed business function, so it is
    // guaranteed to land after the script's first statement has installed the handlers. Injecting it
    // from a `--import` preload instead looked simpler and was wrong: preload modules run before the
    // main entry, and registering a loader moves the microtask checkpoint in front of the script
    // body — so the rejection fired in the bootstrap's own unprotected window and every script
    // exited 1. That window is real and the module header does not claim to cover it; this test is
    // about the window that comes after.
    //
    // Nine of the ten discard `appendEvent`'s return value, so the rejection genuinely reaches the
    // unhandledRejection handler. `session-start.mjs` awaits its business promise, so for that one
    // this is the caught path — both end at exit 0, which is the assertion either way, and the
    // process-level handler is exercised for both kinds by the synthetic fixtures below.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-loader-'));
    try {
      const entry = writeLoader(dir, broken.module, broken.symbol, 'rejects');
      const res = runScript(script, { loaderEntry: entry });
      assert.equal(res.code, 0, `${script} exited ${res.code} on an uncaught rejection`);
      assert.equal(res.stdout, '', `${script} wrote to stdout on an uncaught rejection`);
      assert.ok(res.ms < KILL_MS, `${script} did not terminate inside the host deadline`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (permission) {
    test(`${script} stays silent on a payload it cannot attribute`, () => {
      // A permission hook's stdout is READ AND OBEYED. `{}` would be fail-open too, but silence is
      // what this plugin has always answered and what test/plugin-manifest.test.mjs greps the
      // scripts to keep possible. See PERMISSION_FAILURE_OUTPUT in lib/hook-runner.mjs.
      for (const input of ['', 'not json', '{"no":"session"}']) {
        const res = runScript(script, { input });
        assert.equal(res.stdout, '', `${script} wrote to stdout on ${JSON.stringify(input)}`);
        assert.equal(res.code, 0);
      }
    });
  }
}

// ── the runner itself, in a real process ─────────────────────────────────────────────────────────

// A hook entry shaped exactly like the ten, but with its failure injected directly, so the injection
// does not depend on which module a given script happens to import.
function writeFixture(dir, { permission, mode }) {
  const runner = pathToFileURL(path.join(LIB, 'hook-runner.mjs')).href;
  const body = `import { installHookGuards, runHook } from ${JSON.stringify(runner)};\n`
    + `installHookGuards({ name: 'fixture', permission: ${permission} });\n`
    + `const deps = ${mode === 'telemetry-throws' ? '{ recordIssue() { throw new Error("beezi-test: telemetry"); } }' : '{}'};\n`
    + 'runHook({\n'
    + "  name: 'fixture',\n"
    + `  permission: ${permission},\n`
    + '  deps,\n'
    + (mode === 'load-throws'
      ? '  load: () => Promise.reject(new Error("beezi-test: load")),\n  handle: () => {},\n'
      : mode === 'handle-rejects'
        ? '  load: () => Promise.resolve({}),\n  handle: () => Promise.reject(new Error("beezi-test: handle")),\n'
        : mode === 'floating-rejection'
          ? '  load: () => Promise.resolve({}),\n  handle: () => { Promise.reject(new Error("beezi-test: floating")); },\n'
          : '  load: () => Promise.resolve({}),\n  handle: () => { throw new Error("beezi-test: handle"); },\n')
    + '});\n';
  const file = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

for (const permission of [false, true]) {
  for (const mode of ['load-throws', 'handle-throws', 'handle-rejects', 'floating-rejection', 'telemetry-throws']) {
    test(`a ${permission ? 'permission' : 'analytics'} entry survives ${mode}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fixture-'));
      try {
        const file = writeFixture(dir, { permission, mode });
        const started = Date.now();
        let stdout = '';
        let code = 0;
        try {
          stdout = execFileSync(process.execPath, [file], {
            input: PAYLOAD,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: KILL_MS,
            env: { ...process.env, BEEZI_CURSOR_HOME: dir },
          });
        } catch (error) {
          stdout = error.stdout == null ? '' : error.stdout;
          code = error.status == null ? `signal:${error.signal}` : error.status;
        }
        assert.equal(code, 0, `${mode} exited ${code}`);
        assert.equal(stdout, '', `${mode} wrote to stdout`);
        assert.ok(Date.now() - started < KILL_MS);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
