import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFile } from 'node:child_process';
import { performLogout } from '../lib/logout.mjs';
import { runLoginPreflight } from '../lib/login-preflight.mjs';
import { getAuthState, forceRefresh, authEpoch } from '../lib/token.mjs';
import { probeWhoami } from '../lib/whoami.mjs';
import { commitCredentials } from '../lib/credentials.mjs';
import { AuthState } from '../lib/auth-state.mjs';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authreg-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const FILE_STORE = { platform: 'sunos', run: () => ({ ok: false, stdout: '' }) };

// ── the declared Node floor ──────────────────────────────────────────────────
//
// package.json promises `>=13.2` and a separate CI job runs the real thing, but that job cannot see
// a branch until it merges. These constructs parse on the Node this suite runs and throw a
// SyntaxError on 13.2, which means the failure mode is a plugin that does not load AT ALL on a
// machine it claims to support — no hook fires, no error is attributable.

// Strip comments and string/template literals so a `??` inside a sentence about `??` is not a hit.
// Regex literals are recognised by what precedes them, which is enough for this codebase.
function stripLiterals(source) {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      out += '""';
      continue;
    }
    // A `/` in an operand position starts a regex literal, not a division.
    if (ch === '/' && '([,=:!&|?+{};\n'.indexOf(prev) !== -1) {
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '/') { i += 1; break; }
        i += 1;
      }
      out += '//';
      continue;
    }
    out += ch;
    if (ch.trim() !== '') prev = ch;
    i += 1;
  }
  return out;
}

// Comments gone, string literals KEPT — for rules about the contents of a string, such as an
// encoding name handed to Buffer#toString.
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Syntax and API rules, checked against code with comments AND string literals removed.
const FORBIDDEN = [
  [/\?\./, 'optional chaining (?.) needs Node 14'],
  [/\?\?/, 'nullish coalescing (??) needs Node 14'],
  [/\|\|=/, 'logical-OR assignment (||=) needs Node 15'],
  [/&&=/, 'logical-AND assignment (&&=) needs Node 15'],
  [/\bcrypto\.randomUUID\b/, 'crypto.randomUUID needs Node 14.17'],
  [/\bObject\.hasOwn\b/, 'Object.hasOwn needs Node 16.9'],
  [/\bstructuredClone\b/, 'structuredClone needs Node 17'],
  [/\bPromise\.any\b/, 'Promise.any needs Node 15'],
  [/\bAbortSignal\.timeout\b/, 'AbortSignal.timeout needs Node 17.3'],
  [/\.replaceAll\(/, 'String.replaceAll needs Node 15'],
  [/\.at\(/, 'Array.prototype.at / String.prototype.at needs Node 16.6'],
  [/\bfs\.rmSync\(/, 'fs.rmSync needs Node 14.14 — use removeSync from lib/fs-compat.mjs'],
  [/\bfs\.rm\(/, 'fs.rm needs Node 14.14 — use removeSync from lib/fs-compat.mjs'],
  // Top-level await needs Node 14.8. Only the unambiguous shapes: a statement or a declaration that
  // begins in column 0, which no code inside a function body does in this codebase's style.
  [/^await\s/m, 'top-level await needs Node 14.8'],
  [/^(?:const|let|var)\s+[^=\n]+=\s*await\s/m, 'top-level await needs Node 14.8'],
];

// Rules about what is INSIDE a string literal.
const FORBIDDEN_LITERALS = [
  [/\(\s*['"]base64url['"]\s*\)/, "the 'base64url' encoding needs Node 14.18 — use lib/base64url.mjs"],
];

// `lib/fs-compat.mjs` IS the shim: it calls fs.rmSync behind a `typeof` guard, which is the whole
// reason every other file may not.
const EXEMPT = { 'fs-compat.mjs': ['fs.rmSync', 'fs.rm'] };

function sourceFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join(dir, name));
}

test('every shipped lib and script file stays inside the declared Node 13.2 floor', () => {
  const offenders = [];
  for (const file of [...sourceFiles(path.join(ROOT, 'lib')), ...sourceFiles(path.join(ROOT, 'scripts'))]) {
    const name = path.basename(file);
    const raw = fs.readFileSync(file, 'utf-8');
    const code = stripLiterals(raw);
    const withStrings = stripComments(raw);
    const exempt = EXEMPT[name] == null ? [] : EXEMPT[name];
    for (const [pattern, why] of FORBIDDEN) {
      if (!pattern.test(code)) continue;
      if (exempt.some((allowed) => why.indexOf(allowed) === 0)) continue;
      offenders.push(`${name}: ${why}`);
    }
    for (const [pattern, why] of FORBIDDEN_LITERALS) {
      if (pattern.test(withStrings)) offenders.push(`${name}: ${why}`);
    }
    // `node:test` must never be imported by shipped code: the module does not exist on the floor.
    if (/node:test/.test(raw)) offenders.push(`${name}: imports node:test`);
  }
  assert.deepEqual(offenders, []);
});

// The scanner has to be able to fail, or it proves nothing.
test('the floor scanner detects the constructs it is looking for', () => {
  const bad = stripLiterals('const a = b?.c; // a ?? b in a comment\nconst s = "x ?? y";');
  assert.ok(/\?\./.test(bad), 'optional chaining in code is seen');
  assert.ok(!/\?\?/.test(bad), 'the same operator inside a comment and a string is not');

  const samples = [
    ['let a; a ||= 1;', /\|\|=/],
    ['let a; a &&= 1;', /&&=/],
    ['structuredClone(x);', /\bstructuredClone\b/],
    ['Promise.any([p]);', /\bPromise\.any\b/],
    ['AbortSignal.timeout(5);', /\bAbortSignal\.timeout\b/],
    ['fs.rmSync(p);', /\bfs\.rmSync\(/],
    ['fs.rm(p);', /\bfs\.rm\(/],
    ['xs.at(-1);', /\.at\(/],
    ['await go();', /^await\s/m],
    ['const v = await go();', /^(?:const|let|var)\s+[^=\n]+=\s*await\s/m],
  ];
  for (const [snippet, pattern] of samples) {
    assert.ok(pattern.test(stripLiterals(snippet)), `not detected: ${snippet}`);
  }

  // And the literal rule sees an encoding name a comment merely mentions.
  assert.ok(/\(\s*['"]base64url['"]\s*\)/.test(stripComments("buf.toString('base64url');")));
  assert.ok(!/\(\s*['"]base64url['"]\s*\)/.test(stripComments("// never call toString('base64url')")));
});

// ── the three scripts, run as real processes against an isolated home ────────

function runScript(name, home, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', name)],
      { env: { ...process.env, BEEZI_CURSOR_HOME: home, BEEZI_API_URL: 'http://127.0.0.1:9/api', ...env } },
      (error, stdout, stderr) => resolve({
        code: error == null ? 0 : (error.code == null ? 1 : error.code),
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
  });
}

test('me.mjs on an unlinked machine says so, and says nothing is being reported', async (t) => {
  const home = tmpHome(t);
  const out = await runScript('me.mjs', home);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /not linked/i);
  assert.match(out.stdout, /NOT being reported/);
  assert.equal(out.stderr, '', 'no stray output');
});

// The wording that used to be wrong: an unreadable store is not an unlinked machine. The store here
// is a credentials file that exists and cannot be parsed, which is the shape of a truncated write.
test('me.mjs reports an unreadable store as unreadable, not as "not linked"', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'credentials.json'), '{ truncated', 'utf-8');
  const out = await runScript('me.mjs', home);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /could not be read|present but unusable/i);
  assert.match(out.stdout, /does NOT mean the machine is unlinked/i);
  assert.ok(!/not linked to Beezi/i.test(out.stdout), out.stdout);
});

test('logout.mjs on an unlinked machine succeeds and invents no server call', async (t) => {
  const home = tmpHome(t);
  const out = await runScript('logout.mjs', home);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /not linked/i);
  assert.equal(out.stderr, '');
});

// ── telemetry is optional, and never carries a secret ────────────────────────

test('no auth entry point needs a diagnostics recorder, and none of them changes outcome with one', async (t) => {
  tmpHome(t);
  const creds = {
    client_id: 'cid', token_endpoint: 'https://p/token', revocation_endpoint: null,
    access_token: 'super-secret-token', refresh_token: 'super-secret-refresh', expires_at: 4_000_000_000_000,
  };
  await commitCredentials(creds, FILE_STORE);

  const recorded = [];
  const deps = {
    ...FILE_STORE,
    base: 'https://api.test',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    recordIssue: (code, fields) => recorded.push({ code, fields }),
  };

  const withRecorder = await performLogout(deps);
  assert.equal(withRecorder.exitCode, 0);
  assert.ok(recorded.length > 0, 'the recorder was offered something');

  const serialized = JSON.stringify(recorded);
  assert.ok(!serialized.includes('super-secret-token'), 'no access token reached diagnostics');
  assert.ok(!serialized.includes('super-secret-refresh'), 'no refresh token reached diagnostics');
  assert.ok(!serialized.includes('api.test'), 'no URL reached diagnostics');
  for (const entry of recorded) {
    for (const value of Object.values(entry.fields)) {
      assert.ok(value === null || typeof value === 'string' || typeof value === 'number',
        'structured fields only, never a message or a stack');
    }
  }
});

test('preflight needs no recorder either', async (t) => {
  tmpHome(t);
  const result = await runLoginPreflight({
    deps: { hooksStatus: () => ({ state: 'installed', registered: [] }), ensureInstalled: () => ({}) },
  });
  assert.equal(result.ok, true);
});

// ── the consumer-facing surface other lanes were promised ────────────────────

test('the typed auth API other lanes import exists with the frozen signatures', async (t) => {
  tmpHome(t);
  await commitCredentials({
    client_id: 'cid', token_endpoint: 'https://p/token', access_token: 'at', refresh_token: 'rt',
    expires_at: 4_000_000_000_000,
  }, FILE_STORE);

  const state = await getAuthState({ ...FILE_STORE, deadlineMs: 500 });
  for (const key of ['state', 'reason', 'token', 'generation', 'epoch', 'account']) {
    assert.ok(key in state, `getAuthState result carries ${key}`);
  }
  assert.equal(state.state, AuthState.READY);

  const refreshed = await forceRefresh({
    ...FILE_STORE,
    now: () => 4_000_000_000_000,
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
  });
  for (const key of ['ok', 'token', 'state', 'reason', 'epoch', 'generation']) {
    assert.ok(key in refreshed, `forceRefresh result carries ${key}`);
  }

  assert.equal(typeof await authEpoch(FILE_STORE), 'string');

  const probe = await probeWhoami('tok', { base: 'https://api.test', fetchImpl: async () => ({ ok: false, status: 403 }) });
  for (const key of ['outcome', 'status', 'tenant', 'policy', 'bodyMissing']) {
    assert.ok(key in probe, `probeWhoami result carries ${key}`);
  }
});

// ── the skills describe what the commands actually do ────────────────────────

const skill = (name) => fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf-8');

test('beezi-me tells the reader that an unreadable store is not an unlinked machine', () => {
  const text = skill('beezi-me');
  assert.match(text, /could not be read/i);
  assert.ok(/not.*mean.*unlinked/i.test(text), 'the distinction is spelled out');
});

test('beezi-logout explains the exit code and does not promise a revocation the command did not make', () => {
  const text = skill('beezi-logout');
  assert.match(text, /exit|non-zero/i);
  assert.ok(!/always revoked|guaranteed/i.test(text));
});

test('beezi-login names the separate steps and stops on an actual failure', () => {
  const text = skill('beezi-login');
  assert.match(text, /stop/i);
  // A linked machine missing only a plan should run capture, not another OAuth round-trip.
  assert.match(text, /already linked/i);
});
