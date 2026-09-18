import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Namespace import, never `{ registerHooks }`: the named form is checked when the module is LINKED,
// so on a Node that does not export it (18, still in the CI matrix) this file would die with a
// SyntaxError before any test ran — and the skip guards below, which exist precisely for that Node,
// would never execute. The namespace form parses everywhere and leaves the export `undefined`.
import * as nodeModule from 'node:module';

// The bridge's unit tests drive `handleMessage` directly, which cannot see the two things that
// actually broke in the field: a response still sitting in an asynchronous stdout pipe when the
// process left, and a Windows teardown that trips libuv while a handle is closing. Those need the
// real process, real stdio and a real exit.
const SCRIPT = fileURLToPath(new URL('../scripts/mcp.mjs', import.meta.url));

// `module.registerHooks` is Node >= 20.19 / 22.15, and `--import` is >= 20.6, so this one check
// gates both. Without it there is no way to keep the child off a real credential, and the tests
// skip rather than read one.
const CAN_STUB_CREDENTIALS = typeof nodeModule.registerHooks === 'function';

// The replacement `lib/credentials.mjs` the child gets, and the loader that installs it.
//
// Why replace it at all: no environment variable can keep a spawned child off the machine's OS
// keyring. `lib/credentials.mjs` derives its service name from a constant and runs an absolute
// PowerShell path rebuilt from `%SystemRoot%`, which libuv re-injects into every spawn (and faking
// that variable breaks Node's own CSPRNG initialization). A child on a linked machine would read
// that machine's real token and put it in an outbound Authorization header. With no credential
// store at all, "unlinked" becomes a property of the test rather than of the developer's machine,
// which is also what lets the assertions below be exact.
//
// Kept as source here, and written into the test's own temp directory at run time, because `node
// --test` executes EVERY .mjs under `test/` as a test file — including a loader hook that would
// then install itself into the test runner.
//
// It must satisfy EVERY importer the child links, not just the ones this test thought about: an ESM
// named import is resolved at link time, so one missing export kills the child before a single
// request is read. That is exactly how this test broke when `lib/credentials.mjs` grew its typed
// API and `lib/auth-markers.mjs` and `lib/token.mjs` began importing from it. The guard test at the
// bottom of this file makes the next such addition fail HERE, by name, instead of surfacing as an
// unexplained child exit code.
//
// The behavior is one fixed point: a store that is permanently empty and refuses every write. That
// is what makes "not linked" a property of the test rather than of the developer's machine, and it
// is what the two exact assertions below (`/not linked/i`, exactly the two local tools) rest on.
const CREDENTIALS_STUB = [
  "export const DEFAULT_SERVICE = 'beezi-cursor-test-stub';",
  'export const SERVICE = DEFAULT_SERVICE;',
  // Kept in step with the real module by the guard test, which compares the two objects by value.
  'export const CredentialStatus = Object.freeze({',
  "  OK: 'ok',",
  "  MISSING: 'missing',",
  "  TIMEOUT: 'timeout',",
  "  UNREADABLE: 'unreadable',",
  "  CORRUPT: 'corrupt',",
  "  CONFLICT: 'conflict',",
  "  LOCKED: 'locked',",
  "  COMMITTED: 'committed',",
  "  RECOVERY_NEEDED: 'recovery_needed',",
  "  ERROR: 'error',",
  '});',
  'export const CONTROL_VERSION = 1;',
  'export function resolveServiceName() { return DEFAULT_SERVICE; }',
  "export function controlFile() { return 'test-stub://control'; }",
  "export function fileForSlot(slot) { return 'test-stub://slot/' + String(slot); }",
  'export function isSafeKeyringName() { return true; }',
  'export function readControlSnapshot() {',
  '  return { service: DEFAULT_SERVICE, generation: 0, epoch: 0, backend: null, clientId: null };',
  '}',
  // The empty-store reading, in the shape `readOutcome` produces. A right name carrying a wrong
  // shape kills the child just as dead as a missing export, so this half matters as much.
  'export async function readCredentialRecord() {',
  '  return {',
  '    status: CredentialStatus.MISSING,',
  '    creds: null,',
  '    generation: 0,',
  '    epoch: 0,',
  '    backend: null,',
  '    service: DEFAULT_SERVICE,',
  '  };',
  '}',
  'export async function getCredentials() { return null; }',
  'export async function recoverLegacyCredential() { return { status: CredentialStatus.MISSING }; }',
  // Every write path throws or reports that it wrote nothing. The stub stores nothing, ever.
  "export async function commitCredentials() { throw new Error('the test stub stores nothing'); }",
  "export async function setCredentials() { throw new Error('the test stub stores nothing'); }",
  'export async function deleteCredentialRecord() {',
  '  return { status: CredentialStatus.OK, deleted: false, verified: true, generation: 0 };',
  '}',
  "export async function deleteCredentials() { return { deleted: false, backend: 'test stub' }; }",
].join('\n');

const LOADER_SOURCE = [
  "import * as nodeModule from 'node:module';",
  `const SOURCE = ${JSON.stringify(CREDENTIALS_STUB)};`,
  "if (typeof nodeModule.registerHooks === 'function') {",
  '  nodeModule.registerHooks({',
  '    load(url, context, nextLoad) {',
  "      if (url.endsWith('/lib/credentials.mjs')) {",
  "        return { format: 'module', shortCircuit: true, source: SOURCE };",
  '      }',
  '      return nextLoad(url, context);',
  '    },',
  '  });',
  '}',
  '',
].join('\n');

// Every path the server WRITES to is redirected into a temp tree: the credential file store and bin
// shim via BEEZI_CURSOR_HOME, and Cursor's user-scope hook registry via CURSOR_CONFIG_DIR. Without
// the second one, running this test would rewrite the developer's own Cursor hooks.
function isolatedEnv(dir) {
  const base = {};
  for (const key of Object.keys(process.env)) {
    // PATH is rebuilt below; dropping every casing of it matters on Windows, where `Path` and
    // `PATH` are the same variable but two different keys in this object.
    if (key.toLowerCase() === 'path') continue;
    base[key] = process.env[key];
  }
  return {
    ...base,
    PATH: path.join(dir, 'no-tools'),
    BEEZI_CURSOR_HOME: path.join(dir, 'home'),
    CURSOR_CONFIG_DIR: path.join(dir, 'cursor'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    // Unlinked, so nothing should be attempted anyway; pointed at a dead port so that a regression
    // which tried would fail loudly rather than reach a real portal.
    BEEZI_API_URL: 'http://127.0.0.1:9/api',
    BEEZI_MCP_URL: 'http://127.0.0.1:9/api/mcp',
  };
}

function runServer(dir, lines) {
  const loader = path.join(dir, 'no-keyring.mjs');
  fs.writeFileSync(loader, LOADER_SOURCE);
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, SCRIPT], {
    env: isolatedEnv(dir),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = [];
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let index;
    while ((index = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      if (line.trim()) out.push(JSON.parse(line));
    }
  });
  const stderr = [];
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
  child.stdin.end();

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, stderr: stderr.join('') }));
  });
}

test('the server answers every request and exits cleanly when stdin closes', { timeout: 30000 }, async (t) => {
  if (!CAN_STUB_CREDENTIALS) return t.skip('needs module.registerHooks to keep the child off the real OS keyring');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { code, out, stderr } = await runServer(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  // The child's stderr is in the message on purpose: a bare "expected 0, got 1" is what made the
  // last breakage of this test — a stub that no longer satisfied the server's importers — cost an
  // afternoon to diagnose.
  assert.equal(code, 0, `a forced teardown mid-close is what trips libuv on Windows
${stderr}`);
  // stdout on a pipe is asynchronous: leaving the moment stdin ends used to drop whatever the
  // in-flight work had just written.
  assert.deepEqual(out.map((m) => m.id), [1, 2], 'both requests were answered, in order, before exit');
  // The notification is answered with silence, not an error, and nothing else reached stdout.
  assert.equal(out.length, 2);
  assert.ok(out.every((m) => m.jsonrpc === '2.0'), 'stdout is the JSON-RPC channel and carries nothing else');
  assert.equal(out[0].error, undefined, 'a failed handshake would take the whole plugin down with it');
  assert.equal(out[0].result.capabilities.tools.listChanged, true);
  // Exact, and only meaningful because the stub made the child genuinely unlinked.
  assert.match(out[0].result.serverInfo.title, /not linked/i);
  assert.deepEqual(out[1].result.tools.map((tool) => tool.name), ['beezi_login', 'beezi_status']);
});

test('the process does not linger once its work has drained', { timeout: 30000 }, async (t) => {
  if (!CAN_STUB_CREDENTIALS) return t.skip('needs module.registerHooks to keep the child off the real OS keyring');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The handshake puts the bridge into recovery, which arms a 15s interval. If stdin closing did not
  // dispose it — or if it were not unref'd — this exit would take at least that long, and on a real
  // machine the server would outlive the session.
  const startedAt = Date.now();
  const { code, stderr } = await runServer(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  ]);
  assert.equal(code, 0, stderr);
  assert.ok(Date.now() - startedAt < 15000, `exit took ${Date.now() - startedAt}ms — something kept the loop alive`);
});

// The guard. `CREDENTIALS_STUB` is a second implementation of `lib/credentials.mjs`'s surface, and
// ESM resolves named imports at LINK time: an export added to the real module and not to the stub
// does not degrade the child, it kills it before the first byte of the first request — and the only
// symptom the two tests above can report is "exit 1". That is precisely what happened when the typed
// credential API landed. This test moves the failure here and names what is missing.
//
// It deliberately does NOT skip on the Nodes without `registerHooks`: the check is a pure comparison
// of export sets, it costs nothing, and the Node that cannot run the two tests above is the one most
// in need of telling you the stub has rotted.
test('the credential stub covers every export the real module has', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credentials-stub.mjs');
  fs.writeFileSync(file, CREDENTIALS_STUB);

  const stub = await import(pathToFileURL(file).href);
  const real = await import(new URL('../lib/credentials.mjs', import.meta.url).href);

  const missing = Object.keys(real).filter((name) => !(name in stub));
  assert.deepEqual(
    missing,
    [],
    `the spawned child links lib/credentials.mjs by name, so these exports would kill it: ${missing.join(', ')}`,
  );
  // Names are only half of it. `lib/token.mjs` branches on these VALUES, so a status renamed or
  // re-valued in the real module would pass the check above and still break the child — with the
  // same uninformative exit code.
  assert.deepEqual(stub.CredentialStatus, real.CredentialStatus);
});
