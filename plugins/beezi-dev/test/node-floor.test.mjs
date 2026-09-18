import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The floor gate itself runs only on Node 13.2, which no developer and no normal CI job has. These
// are the two properties of it that can be checked from the modern suite, and both are properties
// whose violation is invisible until the one job nobody runs locally goes red — or, worse, green
// for the wrong reason.

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PLUGIN_ROOT));
const GATE = path.join(REPO_ROOT, 'scripts', 'check-node-floor.mjs');

const source = () => fs.readFileSync(GATE, 'utf-8');

test('the floor gate exists where the pipeline calls it', () => {
  assert.ok(fs.existsSync(GATE), 'scripts/check-node-floor.mjs is missing');
});

test('the gate holds itself to the floor it enforces', () => {
  // A gate written in syntax its own interpreter cannot parse fails with a SyntaxError that looks
  // exactly like the plugin being broken. Checked as text because the only interpreter that could
  // settle it by executing is the one this machine does not have.
  const body = source();
  const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(/\?\./.test(code), false, 'optional chaining needs Node 14');
  assert.equal(/\?\?/.test(code), false, 'nullish coalescing needs Node 14');
  assert.equal(/^\s*await /m.test(code), false, 'top-level await needs Node 14.8');
  assert.equal(/\.at\(/.test(code), false, 'Array.prototype.at needs Node 16.6');
  assert.equal(/Object\.hasOwn/.test(code), false, 'Object.hasOwn needs Node 16.9');
  assert.equal(/\breplaceAll\b/.test(code), false, 'String.replaceAll needs Node 15');
  assert.equal(/fs\.rmSync/.test(code), false, 'fs.rmSync needs Node 14.14');
  assert.equal(/randomUUID/.test(code), false, 'crypto.randomUUID needs Node 14.17');
  assert.equal(/from ['"]node:/.test(code), false, "the node: prefix does not resolve in ESM on 13.2");
  assert.equal(/[0-9]_[0-9]/.test(code), false, 'numeric separators are banned by the shared contract');
});

test('the gate checks the base64url FIX, not the interpreter', () => {
  // The smoke used to run `randomBytes(16).toString('base64url')` literally. That is a property of
  // the INTERPRETER: it throws on every 13.2 binary no matter what this repository contains, so the
  // gate could never go green — and a gate that cannot pass blocks Publish forever and then gets
  // deleted. What must be exercised is the helper that makes the floor work.
  const body = source();
  assert.match(body, /lib\/base64url\.mjs/, 'the gate must exercise the floor helper');
  // The two RFC 7636 Appendix B constants. A shape-only check ("looks url-safe") would pass a
  // helper that still produces something an authorization server rejects.
  assert.match(body, /dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk/, 'the verifier vector is missing');
  assert.match(body, /E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM/, 'the challenge vector is missing');

  // And the smoke sources must not perform the unsupported encoding themselves. Comments are
  // stripped first: the smokes EXPLAIN the encoding at length, and that prose is the reason the
  // rule is followable.
  const smokes = body.split('var SMOKES = [')[1].split('\nvar SMOKE_PRELUDE')[0]
    .split('\n')
    .filter((line) => !/^\s*(\/\/|'\s*\/\/)/.test(line))
    .join('\n');
  assert.equal(
    /toString\(["']base64url["']\)/.test(smokes) || /digest\(["']base64url["']\)/.test(smokes),
    false,
    'a smoke performs the unsupported encoding itself — that can never pass on the floor',
  );
});

test('the gate sweeps runtime code for the encoding that cannot work on the floor', () => {
  // `Buffer.toString('base64url')` and `hash.digest('base64url')` both live inside functions, and
  // the second does not throw below 15.7 — it returns a Buffer. A reintroduction on a code path no
  // smoke happens to call is invisible until a user's login fails, so the sweep is static.
  const body = source();
  assert.match(body, /function phaseEncodings\(/);
  assert.match(body, /phaseEncodings\(opts, results\);/, 'the phase must actually be called');
});

test('the gate never loads an executable script, only parses one', () => {
  // scripts/login.mjs opens a browser and writes credentials; scripts/logout.mjs deletes them; the
  // hook scripts write to the data root. On a build agent that is noise, but the gate is also meant
  // to be run by hand on a developer's machine, where "import every script to see if it loads"
  // means signing somebody out.
  const body = source();
  assert.match(body, /Scripts are parsed, never loaded/, 'the rule must be stated where it is enforced');

  // phaseImport builds its file list from lib/ alone. If a future edit adds the scripts directory
  // to it, this is the line that notices.
  const importPhase = body.split('function phaseImport(')[1].split('\n}')[0];
  assert.match(importPhase, /listMjs\(path\.join\(opts\.plugin, 'lib'\)\)/);
  assert.equal(/'scripts'/.test(importPhase), false, 'phaseImport must not reach into scripts/');
});
