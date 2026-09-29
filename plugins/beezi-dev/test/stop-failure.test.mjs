import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What actually leaves the machine when a tool call fails.
//
// `scripts/stop-failure.mjs` is a script, not a module — its whole body is the wiring under test —
// so it is run exactly the way Cursor runs it: own process, payload on stdin. The alternative is
// re-implementing `classifyToolFailure` (lib/session-error-cursor.mjs) in the test and asserting
// against the copy, which would keep passing after the real classifier changed — what text it picks
// (`error_message` first, the legacy field names as fallbacks) and which failures it skips (an
// interrupt, an ordinary error on a file or search tool).
//
// lib/redact.mjs's own rules are NOT retested here; test/redact.test.mjs owns that, negative table
// included. These tests are about the wire: the body the API would have received.

const SCRIPT = fileURLToPath(new URL('../scripts/stop-failure.mjs', import.meta.url));

// ── the one seam a subprocess cannot be given through the environment ────────────────────────────
//
// The hook only POSTs when `getAccessToken()` answers, and on Windows the first credential backend
// is the real Credential Manager, reached by an absolute path to powershell.exe. No env var moves
// it, and libuv puts SystemRoot back into a child environment even when the parent deletes it — so
// there is no way to make the credential store answer from a temp directory.
//
// Left alone the test would be non-hermetic in both directions: it would observe nothing on an
// unlinked machine (no token, no request) and on a linked one it would put the developer's real
// access token on a socket to satisfy an assertion that has nothing to do with tokens. So exactly
// one module is replaced — the token accessor — and everything downstream of it is the real thing:
// the real detail extraction, the real lib/redact.mjs, the real lib/session-error-report.mjs, the
// real bounded POST, and a real HTTP server on loopback receiving a real request body.
//
// The token stub also LEAVES A MARK. "Did the hook look up a credential?" is the assertion the
// tracking-policy tests turn on, and the only honest way to answer it is to watch the accessor
// itself: a hook that skipped the POST but still read the keychain has not honoured the policy, it
// has merely failed to send.
function writeTokenStub(dir, extra = {}) {
  const probe = JSON.stringify(path.join(dir, 'token-was-read'));
  fs.writeFileSync(
    path.join(dir, 'fake-token.mjs'),
    'import fs from "node:fs";\n'
      + 'export async function getAccessToken() {\n'
      + `  fs.writeFileSync(${probe}, "1");\n`
      + '  return "test-token";\n'
      + '}\n'
      + 'export function invalidateTokenCache() {}\n',
    'utf-8',
  );
  // { "<module basename>.mjs": "<stub source>" } — one more module the hook loads, replaced.
  const stubs = { 'token.mjs': './fake-token.mjs' };
  let i = 0;
  for (const [target, source] of Object.entries(extra)) {
    const file = `extra-${i}.mjs`;
    i += 1;
    fs.writeFileSync(path.join(dir, file), source, 'utf-8');
    stubs[target] = `./${file}`;
  }
  fs.writeFileSync(
    path.join(dir, 'loader-hooks.mjs'),
    `const STUBS = ${JSON.stringify(stubs)};\n`
      + 'const RESOLVED = Object.fromEntries(\n'
      + '  Object.entries(STUBS).map(([k, v]) => [`/lib/${k}`, new URL(v, import.meta.url).href]),\n'
      + ');\n'
      + 'export async function resolve(specifier, context, next) {\n'
      + '  const result = await next(specifier, context);\n'
      + '  for (const [suffix, url] of Object.entries(RESOLVED)) {\n'
      + '    if (result.url.endsWith(suffix)) return { ...result, url, shortCircuit: true };\n'
      + '  }\n'
      + '  return result;\n'
      + '}\n',
    'utf-8',
  );
  const entry = path.join(dir, 'register-hooks.mjs');
  fs.writeFileSync(
    entry,
    'import { register } from "node:module";\n'
      + 'register("./loader-hooks.mjs", import.meta.url);\n',
    'utf-8',
  );
  return entry;
}

// One test's worth of isolation: a private data root, a private loader, and a server that records
// every request body it is handed.
async function harness(t, { stubs = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-stop-failure-'));
  const entry = writeTokenStub(dir, stubs);
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // The Authorization header is deliberately not recorded. Nothing here asserts on a token, and
      // an assertion message is a place a real credential must never be able to reach.
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  run.home = dir;
  run.tokenWasRead = () => fs.existsSync(path.join(dir, 'token-was-read'));
  run.transportArgs = () => JSON.parse(fs.readFileSync(path.join(dir, 'transport-args.json'), 'utf-8'));

  // Returns the parsed body of the session-error POST, or null if the hook made no request.
  return run;

  async function run(payload) {
    const before = requests.length;
    const child = spawn(process.execPath, ['--import', pathToFileURL(entry).href, SCRIPT], {
      env: {
        ...process.env,
        BEEZI_CURSOR_HOME: dir,
        BEEZI_API_URL: `http://127.0.0.1:${port}/api`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.stdin.end(JSON.stringify(payload));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    // A hook that exits non-zero is reported by Cursor as a failed hook, whatever it managed to
    // send — and a redaction import that does not resolve fails exactly here.
    assert.equal(code, 0, `stop-failure.mjs exited ${code}: ${stderr}`);
    const sent = requests.slice(before);
    assert.ok(sent.length <= 1, `expected at most one request, got ${sent.length}`);
    if (sent.length === 0) return null;
    assert.match(sent[0].url, /\/sessions\/errors$/);
    return JSON.parse(sent[0].body);
  }
}

const payloadWith = (fields) => ({ session_id: 'conv-fail', hook_event_name: 'postToolUseFailure', ...fields });

test('the credential a failed command echoed does not reach the API', async (t) => {
  const run = await harness(t);
  const body = await run(payloadWith({
    tool_name: 'Shell',
    failure_type: 'error',
    error_message: [
      '$ curl -sS -X POST https://api.example.dev/v1/report \\',
      '    -H "Authorization: Bearer sk-live-4f8a2b9c1d3e5f7a0b2c" \\',
      '    -H "Content-Type: application/json"',
      '{"statusCode":401,"message":"Unauthorized"}',
      'exit code 22',
    ].join('\n'),
  }));

  assert.ok(body, 'the hook sent no session-error report');
  assert.equal(body.error, 'tool_error');
  assert.equal(body.sessionId, 'conv-fail');
  assert.ok(!body.errorDetails.includes('sk-live-4f8a2b9c1d3e5f7a0b2c'), body.errorDetails);
  assert.ok(body.errorDetails.includes('[REDACTED]'), body.errorDetails);
  // The report is still a usable bug report — this is the half that breaks silently.
  assert.ok(body.errorDetails.includes('https://api.example.dev/v1/report'));
  assert.ok(body.errorDetails.includes('"statusCode":401'));
  assert.ok(body.errorDetails.includes('exit code 22'));
});

test('a token in a push URL and a connection string are scrubbed from `error` too', async (t) => {
  const run = await harness(t);
  // `error` is the legacy field the classifier still reads after `error_message`, so it keeps its
  // own coverage.
  const body = await run(payloadWith({
    tool_name: 'Shell',
    error: [
      "fatal: Authentication failed for 'https://dev:ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/acme/app.git'",
      'psql: could not connect to postgres://appuser:hunter2SuperSecret@db.internal:5432/prod',
    ].join('\n'),
  }));

  assert.ok(!body.errorDetails.includes('ghp_16C7e42F292c6912E7710c838347Ae178B4a'), body.errorDetails);
  assert.ok(!body.errorDetails.includes('hunter2SuperSecret'), body.errorDetails);
  // Who connected to what is the entire diagnostic value of these two lines, and it survives.
  assert.ok(body.errorDetails.includes('github.com/acme/app.git'));
  assert.ok(body.errorDetails.includes('postgres://appuser:[REDACTED]@db.internal:5432/prod'));
});

test('an ordinary tool failure reaches the API byte for byte, behind its prefix', async (t) => {
  const run = await harness(t);
  // The failure this whole design is guarded against: a redactor that eats diagnostics leaves the
  // report arriving, well-formed and useless, with nobody in a position to notice.
  const output = [
    "src/app.ts(12,5): error TS2304: Cannot find name 'foo'.",
    "Error: ENOENT: no such file or directory, open 'C:\\src\\app.ts'",
    'npm ERR! code ELIFECYCLE',
    'connect ECONNREFUSED 127.0.0.1:5432',
    'Error: boom',
    '    at doWork (/app/src/index.js:10:15)',
    '    at Object.authorize (C:\\src\\lib\\token.ts:42:7)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'fatal: bad object 3282021ab9f4c1d0e5b6a7382910fbc4d5e6a7b8',
    'listen EADDRINUSE: address already in use :::3000 after 1500ms',
  ].join('\n');

  const body = await run(payloadWith({ tool_name: 'Shell', failure_type: 'error', error_message: output }));
  assert.equal(body.errorDetails, `Shell · error: ${output}`);
});

test('errorDetails is redacted before it is cut to the length the server accepts', async (t) => {
  const run = await harness(t);
  // The secret straddles the 1000-character field cap. Cutting first would strand `ghp_0123456789…`
  // past the boundary with its prefix still attached and no rule left able to match it; redacting
  // first sees the whole value. lib/session-error-cursor.mjs windows the message to 20000 characters
  // BEFORE it reaches the redactor — that only bounds the cost of a megabyte log, not the wire length
  // — then redacts and only then cuts to the 1000-character cap the server accepts. The transport's
  // own 1000-character cap in lib/session-error-report.mjs repeats that same cut, idempotently, on
  // text that is already redacted. Both real cuts land after the scrub.
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  // `Shell · error: ` is now a 15-char prefix ahead of the message, so the padding shrinks by that
  // much (990 -> 970) to keep the secret straddling the same 1000-character field cap.
  const body = await run(payloadWith({
    tool_name: 'Shell',
    failure_type: 'error',
    error_message: `${'.'.repeat(970)}${secret} and the rest of a very long log`,
  }));

  assert.ok(body.errorDetails.length <= 1000, `errorDetails was ${body.errorDetails.length} chars`);
  assert.ok(!body.errorDetails.includes('ghp_0123456789'), body.errorDetails.slice(-120));
  assert.ok(body.errorDetails.includes('[REDACTED]'));
});

test('a documented shell timeout is reported with its own code and a readable line', async (t) => {
  const run = await harness(t);
  const secret = 'sk-live-4f8a2b9c1d3e5f7a0b2c';
  const body = await run(payloadWith({
    tool_name: 'Shell',
    tool_use_id: 'toolu_01',
    // The command line is exactly where a pasted secret sits, and nothing may read it.
    tool_input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.dev` },
    error_message: 'Command timed out after 30 seconds',
    failure_type: 'timeout',
    duration: 30000,
    is_interrupt: false,
  }));
  assert.ok(body, 'the hook sent no session-error report');
  assert.equal(body.error, 'tool_timeout');
  assert.equal(body.errorDetails, 'Shell · timeout · 30.0s: Command timed out after 30 seconds');
  assert.equal(body.lastAssistantMessage, null);
  assert.ok(!JSON.stringify(body).includes(secret), 'tool_input reached the wire');
  assert.ok(!JSON.stringify(body).includes('curl'), 'tool_input reached the wire');
});

test('an ordinary error on a file tool is noise: nothing is sent and no credential is read', async (t) => {
  const run = await harness(t);
  const body = await run(payloadWith({ tool_name: 'Read', failure_type: 'error', error_message: 'ENOENT: no such file' }));
  assert.equal(body, null);
  assert.equal(run.tokenWasRead(), false, 'a skipped failure must not cost a keychain read');
});

test('an interrupted tool call is recorded locally and not reported', async (t) => {
  const run = await harness(t);
  const body = await run(payloadWith({ tool_name: 'Shell', failure_type: 'error', error_message: 'Interrupted', is_interrupt: true }));
  assert.equal(body, null);
  assert.equal(run.tokenWasRead(), false);
  // Still a failed call in the segment: skipping the report is not skipping the collection.
  const line = JSON.parse(fs.readFileSync(path.join(run.home, 'events', 'conv-fail.jsonl'), 'utf-8').trim());
  assert.equal(line.ev, 'tool');
  assert.equal(line.failed, true);
});

test('a failure with no text still says what failed', async (t) => {
  const run = await harness(t);
  const body = await run(payloadWith({ tool_name: 'Shell', failure_type: 'error' }));
  assert.equal(body.error, 'tool_error');
  assert.equal(body.errorDetails, 'Shell failed (error)');
  assert.equal(body.lastAssistantMessage, null);
});

const FIXTURES = fileURLToPath(new URL('./fixtures/hook-payloads/', import.meta.url));

test('every documented or captured failure payload that is reported carries non-empty details', async (t) => {
  // The fixtures are real hook stdin (Task B0 captures) plus the documented shape. A captured file
  // error is legitimately skipped; what may never happen is a report whose details are empty.
  const files = fs.readdirSync(FIXTURES).filter((name) => /^post-tool-use-failure\..+\.json$/.test(name));
  assert.ok(files.length > 0, 'no postToolUseFailure fixture: the documented one is committed with the capture task');
  let reported = 0;
  for (const file of files) {
    const run = await harness(t);
    const body = await run(JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf-8')));
    if (body === null) continue;
    reported += 1;
    assert.equal(typeof body.errorDetails, 'string', file);
    assert.ok(body.errorDetails.length > 0, `${file}: empty errorDetails`);
    assert.notEqual(body.error, 'tool_failure', file);
  }
  assert.ok(reported > 0, 'not one fixture produced a report, so this test proved nothing');
});

test('a payload with no session id sends nothing at all', async (t) => {
  const run = await harness(t);
  // The guard the redaction import sits behind: no identity, no work, no module graph.
  assert.equal(await run({ hook_event_name: 'postToolUseFailure' }), null);
});


// ── tenant tracking policy (07-E) ────────────────────────────────────────────────────────────────
//
// A session-error report is authenticated USER-SESSION analytics, not optional plugin diagnostics.
// Consent is not a substitute for tenant policy: when the tenant has been switched to backfill-only
// or off, this hook must not reach for a credential and must not send. The sidecar line is a
// different question — it is local collection, it feeds the checkpoint, and it is written either
// way.

const trackingState = (dir, mode) => {
  fs.writeFileSync(
    path.join(dir, 'tracking.json'),
    JSON.stringify({ version: 1, trackingMode: mode }),
    'utf-8',
  );
};

for (const mode of ['disabled', 'backfill_only']) {
  test(`live tracking ${mode}: no credential is read and nothing is sent`, async (t) => {
    const run = await harness(t);
    // The REAL lib/tracking.mjs, reading a real state file out of the isolated home — the policy is
    // the thing under test, so stubbing the reader would test the stub.
    trackingState(run.home, mode);
    const body = await run(payloadWith({ tool_name: 'run_terminal_cmd', error: 'boom' }));
    assert.equal(body, null, `${mode} still reported a session error`);
    assert.equal(run.tokenWasRead(), false, `${mode} still read a credential`);
    // The sidecar is LOCAL collection and is not gated by the live-tracking policy: it is what the
    // checkpoint reports from, and the checkpoint applies the policy on its own path. Dropping the
    // line here would lose the failed call from the segment as well as from the error report.
    const line = JSON.parse(fs.readFileSync(path.join(run.home, 'events', 'conv-fail.jsonl'), 'utf-8').trim());
    assert.equal(line.ev, 'tool');
    assert.equal(line.tool, 'run_terminal_cmd');
  });
}

test('live tracking on: the report goes out exactly as before', async (t) => {
  const run = await harness(t);
  trackingState(run.home, 'live');
  const body = await run(payloadWith({ tool_name: 'Shell', error_message: 'boom' }));
  assert.ok(body);
  assert.equal(body.error, 'tool_error');
  assert.equal(run.tokenWasRead(), true);
});

test('no policy cached at all stays fail-open', async (t) => {
  // The documented default: the server is the real boundary, and failing closed here would dark-mode
  // every fresh install until its first whoami.
  const run = await harness(t);
  assert.ok(!fs.existsSync(path.join(run.home, 'tracking.json')));
  const body = await run(payloadWith({ error: 'boom' }));
  assert.ok(body, 'a missing policy must not silence the hook');
});

test('an unreadable policy file stays fail-open', async (t) => {
  const run = await harness(t);
  fs.writeFileSync(path.join(run.home, 'tracking.json'), '{ not json', 'utf-8');
  assert.ok(await run(payloadWith({ error: 'boom' })));
});

// ── occurrence time and the caller's timeout (07-E) ──────────────────────────────────────────────

// A transport stub that records exactly what the script handed it, so the two things that cannot be
// seen in a request body — the deps argument, and that it was built before the send — are assertable.
const RECORDING_TRANSPORT = (dir) => 'import fs from "node:fs";\n'
  + 'export async function postSessionError(payload, token, deps = {}) {\n'
  + `  fs.writeFileSync(${JSON.stringify(path.join(dir, 'transport-args.json'))}, JSON.stringify({ payload, deps }));\n`
  + '  return { reported: true, status: 200 };\n'
  + '}\n';

test('the report carries the moment the failure happened, as an ISO instant', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sf-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = await harness(t, { stubs: { 'session-error-report.mjs': RECORDING_TRANSPORT(dir) } });
  const before = Date.now();
  await run(payloadWith({ error: 'boom' }));
  const { payload } = JSON.parse(fs.readFileSync(path.join(dir, 'transport-args.json'), 'utf-8'));
  const at = Date.parse(payload.occurredAt);
  assert.ok(Number.isFinite(at), payload.occurredAt);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'the stamp is this run, not send time');
  assert.equal(payload.error, 'tool_error', 'a precise tool code, not a guessed rate-limit error');
  assert.equal(payload.lastAssistantMessage, null);
});

test('the transport is handed the REMAINING hook deadline, not a fresh one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sf-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = await harness(t, { stubs: { 'session-error-report.mjs': RECORDING_TRANSPORT(dir) } });
  await run(payloadWith({ error: 'boom' }));
  const { deps } = JSON.parse(fs.readFileSync(path.join(dir, 'transport-args.json'), 'utf-8'));
  assert.equal(typeof deps.timeoutMs, 'number');
  assert.ok(deps.timeoutMs > 0, 'a non-positive budget would abort the send before it started');
  // 7500ms is the analytics hook budget. Node's own startup and the sidecar append are already
  // spent by the time this is read, so it must be strictly less.
  assert.ok(deps.timeoutMs < 7500, `timeoutMs was ${deps.timeoutMs}, i.e. a fresh budget`);
  assert.equal(typeof deps.occurredAt, 'string');
});
