import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDetail, MAX_DETAIL_CHARS } from '../lib/redact.mjs';

// ─── the negative table ─────────────────────────────────────────────────────
//
// THIS IS THE IMPORTANT HALF. A redactor that eats diagnostics is worse than no redactor: the error
// report still arrives, still looks plausible, and is useless — and nobody finds out, because the
// only person who could compare it against the real output has already moved on. Every one of these
// must come back byte-identical.

const MUST_PASS_THROUGH = [
  ['connection refused', 'connect ECONNREFUSED 127.0.0.1:5432'],
  ['typescript diagnostic', "src/app.ts(12,5): error TS2304: Cannot find name 'foo'."],
  ['enoent with a windows path', "Error: ENOENT: no such file or directory, open 'C:\\src\\app.ts'"],
  ['npm lifecycle failure', 'npm ERR! code ELIFECYCLE\nnpm ERR! errno 1'],
  [
    'an ordinary stack trace',
    [
      'Error: boom',
      '    at doWork (/app/src/index.js:10:15)',
      '    at Object.authorize (C:\\src\\lib\\token.ts:42:7)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  ],
  ['a git sha', 'fatal: bad object 3282021ab9f4c1d0e5b6a7382910fbc4d5e6a7b8'],
  ['a short git sha in prose', 'HEAD is now at 3282021 fix(beezi): track a checkout with no origin'],
  ['a bare base64 blob with no key beside it', 'unexpected payload: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo='],
  ['file paths', "cannot stat '/home/dev/.aws/credentials': No such file or directory"],
  ['an ssh remote', "fatal: Could not read from remote repository 'git@github.com:acme/app.git'"],
  ['a plain https url', 'POST https://api.example.dev/v1/sessions/report failed with 502'],
  ['basic auth mentioned in prose', 'Basic authentication failed for user dev'],
  ['a hyphenated word after a scheme name', 'Basic authentication-related failure in middleware'],
  ['env vars that are not secret-ish', 'PATH=/usr/bin:/bin NODE_OPTIONS=--max-old-space-size=4096'],
  ['a lowercase mention of authenticate', 'error: failed to authenticate with the registry'],
  ['a v8 syntax error about the = token', 'SyntaxError: Unexpected token = in JSON at position 12'],
  ['a quoted v8 syntax error', "SyntaxError: Unexpected token '=', \"=1\" is not valid JSON"],
  ['a word containing sk-', 'cannot resolve module task-management-utils from ./src'],
  ['a source line mentioning auth', 'Module not found: Error: Cannot resolve ./auth/login.js'],
  ['a stack frame in a file called token.js', '    at refresh (/app/lib/token.js:16:45)'],
  ['a port and a duration', 'listen EADDRINUSE: address already in use :::3000 after 1500ms'],
  ['a uuid', 'conversation 6f3a1b2c-8d4e-4f50-9a1b-2c3d4e5f6071 not found'],
  ['a docker image digest', 'manifest for node@sha256:9b1f2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9 not found'],
];

for (const [name, text] of MUST_PASS_THROUGH) {
  test(`keeps ${name} intact`, () => {
    assert.equal(redact(text), text);
  });
}

// ─── the positive table ─────────────────────────────────────────────────────

function assertScrubbed(input, secret, { expected } = {}) {
  const out = redact(input);
  assert.ok(!out.includes(secret), `secret survived redaction:\n  in:  ${input}\n  out: ${out}`);
  assert.ok(out.includes('[REDACTED]'), `nothing was masked:\n  out: ${out}`);
  if (expected !== undefined) assert.equal(out, expected);
}

test('redacts an Authorization header, however it was written', () => {
  assertScrubbed(
    'GET /v1/me\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.signature\n',
    'eyJhbGciOiJIUzI1NiJ9',
  );
  assertScrubbed(
    "curl -H 'Authorization: Bearer sk-live-9a8b7c6d5e4f3a2b1c0d' https://api.example.dev/v1/me",
    'sk-live-9a8b7c6d5e4f3a2b1c0d',
  );
  // The closing quote of the -H argument survives, so the command stays readable.
  assert.equal(
    redact('curl -H "Authorization: Basic ZGV2Omh1bnRlcjIxMjM0NQ==" http://localhost:3000'),
    'curl -H "Authorization: [REDACTED]" http://localhost:3000',
  );
  assertScrubbed('proxy-authorization: Basic ZGV2Omh1bnRlcjIxMjM0NQ==', 'ZGV2Omh1bnRlcjIxMjM0NQ');
});

test('an Authorization written with = takes the whole value, not just the scheme word', () => {
  // Regression: the unquoted-assignment rule used to reach this first, mask the WORD "Bearer" and
  // leave the credential behind it sitting in the report.
  assert.equal(
    redact('Authorization=Bearer abcdefghijklmnopqrstuvwxyz'),
    'Authorization=[REDACTED]',
  );
});

test('redacts a bare Bearer credential', () => {
  assert.equal(
    redact('request failed: Bearer A1b2C3d4E5f6G7h8I9j0K1l2M3n4'),
    'request failed: Bearer [REDACTED]',
  );
});

test('redacts a JWT anywhere it appears', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assertScrubbed(`token refresh rejected for ${jwt}`, jwt);
  assertScrubbed(`{"access_token":"${jwt}"}`, jwt);
});

test('redacts issuer-prefixed tokens', () => {
  assertScrubbed('remote: Invalid credentials ghp_16C7e42F292c6912E7710c838347Ae178B4a', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a');
  assertScrubbed('using github_pat_11ABCDEFG0abcdefghijkl_MnOpQrStUvWxYz0123456789', 'github_pat_11ABCDEFG0abcdefghijkl');
  assertScrubbed('OpenAI error for sk-proj-abc123def456ghi789jkl012mno', 'sk-proj-abc123def456ghi789jkl012mno');
  assertScrubbed('slack post failed: xoxb-2345678901-abcdefghijkl', 'xoxb-2345678901-abcdefghijkl');
  assertScrubbed('The AWS Access Key Id AKIAIOSFODNN7EXAMPLE does not exist', 'AKIAIOSFODNN7EXAMPLE');
});

test('redacts the password in a connection string but keeps user, host and database', () => {
  assert.equal(
    redact('could not connect to postgres://appuser:hunter2SuperSecret@db.internal:5432/prod'),
    'could not connect to postgres://appuser:[REDACTED]@db.internal:5432/prod',
  );
  assert.equal(
    redact('fatal: Authentication failed for https://dev:ghp_abcdefghijklmnop@github.com/acme/app.git'),
    'fatal: Authentication failed for https://dev:[REDACTED]@github.com/acme/app.git',
  );
  assertScrubbed('mongodb+srv://svc:p%40ssw0rd!@cluster0.abcd.mongodb.net/test', 'p%40ssw0rd');
});

test('redacts secret-ish env assignments while keeping the variable name', () => {
  assert.equal(
    redact('env: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
    'env: AWS_SECRET_ACCESS_KEY=[REDACTED]',
  );
  assert.equal(redact('GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz012345'), 'GITHUB_TOKEN=[REDACTED]');
  assert.equal(redact('DB_PASSWORD=hunter2 npm run migrate'), 'DB_PASSWORD=[REDACTED] npm run migrate');
  assert.equal(redact('npm_config__auth=aGVsbG8gd29ybGQ='), 'npm_config__auth=[REDACTED]');
  assert.equal(redact('--client-secret=abc123def456'), '--client-secret=[REDACTED]');
});

test('keeps the rest of a query string when redacting a token parameter', () => {
  assert.equal(
    redact('GET /v1/items?access_token=a1b2c3d4e5f6g7h8&page=2 returned 401'),
    'GET /v1/items?access_token=[REDACTED]&page=2 returned 401',
  );
});

test('redacts secret-ish keys in JSON, YAML and ini shapes', () => {
  assert.equal(
    redact('{"apiKey":"a1b2c3d4e5f6g7h8i9j0","limit":50}'),
    '{"apiKey":"[REDACTED]","limit":50}',
  );
  assert.equal(redact('  password = "hunter2"'), '  password = "[REDACTED]"');
  assert.equal(
    redact('x-api-key: A1b2C3d4E5f6G7h8I9j0K1l2'),
    'x-api-key: [REDACTED]',
  );
  assertScrubbed(
    "config: { client_secret: 'zR8kQ2mN5pL7vX3wY6tB9cF1' }",
    'zR8kQ2mN5pL7vX3wY6tB9cF1',
  );
});

test('redacts a PEM private key block', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA3Tz2mv3PQ0mIu0jP1cCjZ0y5wR6uK9xLmN4pQ8vT2sB7aD5eF',
    'gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redact(`ssh: failed to parse key\n${pem}\n`);
  assert.ok(out.includes('[REDACTED PRIVATE KEY]'));
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'));
  assert.ok(out.includes('ssh: failed to parse key'), 'the diagnostic line must survive');
});

test('scrubs a realistic failed-curl tool output end to end', () => {
  const out = redact([
    '$ curl -sS -X POST https://api.example.dev/v1/report \\',
    '    -H "Authorization: Bearer sk-live-4f8a2b9c1d3e5f7a0b2c" \\',
    '    -H "Content-Type: application/json"',
    '{"statusCode":401,"message":"Unauthorized"}',
    'exit code 22',
  ].join('\n'));
  assert.ok(!out.includes('sk-live-4f8a2b9c1d3e5f7a0b2c'));
  // Everything a human needs to debug this is still here.
  assert.ok(out.includes('https://api.example.dev/v1/report'));
  assert.ok(out.includes('"statusCode":401'));
  assert.ok(out.includes('Content-Type: application/json'));
  assert.ok(out.includes('exit code 22'));
});

// ─── properties ─────────────────────────────────────────────────────────────

test('redaction is idempotent', () => {
  const input = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG and Bearer A1b2C3d4E5f6G7h8I9j0K1';
  const once = redact(input);
  assert.equal(redact(once), once);
});

test('non-strings never pass through unexamined', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact({ token: 'secret' }), '');
  assert.equal(redact(''), '');
});

// ─── redactDetail — the stop-failure call site ──────────────────────────────

test('redactDetail truncates to the report limit', () => {
  assert.equal(redactDetail('x'.repeat(5000)).length, MAX_DETAIL_CHARS);
  assert.equal(MAX_DETAIL_CHARS, 2000);
});

test('redactDetail returns null for a non-string, matching the existing call site', () => {
  assert.equal(redactDetail(null), null);
  assert.equal(redactDetail(undefined), null);
  assert.equal(redactDetail({ error: 'x' }), null);
});

test('redactDetail redacts BEFORE truncating', () => {
  // A secret straddling the 2000-character cut. Truncate-first would slice it away from its anchor
  // and leave the fragment in the report; redact-first sees the whole value.
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const input = `${'.'.repeat(MAX_DETAIL_CHARS - 10)}${secret} trailing`;
  const out = redactDetail(input);
  assert.ok(!out.includes('ghp_0123456789'), out.slice(-80));
  assert.ok(out.includes('[REDACTED]'));
});

test('redactDetail bounds its work on a huge tool output', () => {
  const started = Date.now();
  const out = redactDetail(`${'lorem ipsum dolor sit amet '.repeat(400_000)}GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345`);
  assert.equal(out.length, MAX_DETAIL_CHARS);
  assert.ok(Date.now() - started < 2000, 'must not spend the hook budget on a 10MB log');
});
