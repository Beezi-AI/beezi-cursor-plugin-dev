import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { telemetryCommand } from '../scripts/telemetry.mjs';
import { shimBody } from '../lib/plugin-install.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'telemetry.mjs');
const SKILL = path.join(PLUGIN_ROOT, 'skills', 'beezi-telemetry', 'SKILL.md');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-telcli-'));
  try {
    return fn(home);
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Runs the CLI exactly as the shim and the skill do: a separate node process, one argument.
function run(home, arg) {
  const args = arg === undefined ? [SCRIPT] : [SCRIPT, arg];
  return execFileSync(process.execPath, args, {
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { BEEZI_CURSOR_HOME: home }),
  });
}

// Read the skill with its line endings normalised.
//
// Every skill in this plugin is `i/lf w/crlf` (`git ls-files --eol`): a Windows checkout with
// core.autocrlf=true materialises them with CRLF, so an assertion carrying a literal newline —
// `/^---\n/` against `---\r\n` — passes on the machine that authored the file and fails on a fresh
// clone. The other skill tests avoid this by using `/m` anchors and single-line `includes`; the
// assertions below span line breaks deliberately, because the frontmatter BLOCK is the thing under
// test, so they normalise instead. What is asserted is the file's content, never its checkout
// encoding.
const skillBody = () => fs.readFileSync(SKILL, 'utf-8').replace(/\r\n/g, '\n');

const consentRecord = (home) => JSON.parse(
  fs.readFileSync(path.join(home, 'telemetry', 'consent.json'), 'utf-8'),
);

test('the CLI reports OFF on a machine that has never decided', () => {
  withHome((home) => {
    const out = run(home);
    assert.match(out, /^Beezi plugin diagnostics are OFF\./);
    assert.match(out, /beezi telemetry on\|off\|correlate\|anonymous/);
    assert.equal(out.split('\n').filter(Boolean).length, 1, 'exactly one line');
    assert.equal(fs.existsSync(path.join(home, 'telemetry', 'consent.json')), false,
      'reading the status must not write a record');
  });
});

test('each setting dispatches through the script and lands on disk', () => {
  withHome((home) => {
    assert.match(run(home, 'on'), /diagnostics are ON/);
    assert.equal(consentRecord(home).consent, 'granted');
    assert.notEqual(consentRecord(home).correlation, 'granted');

    assert.match(run(home, 'correlate'), /ON with account correlation/);
    assert.equal(consentRecord(home).correlation, 'granted');

    assert.match(run(home, 'anonymous'), /without account correlation/);
    assert.equal(consentRecord(home).consent, 'granted');
    assert.equal(consentRecord(home).correlation, 'denied');

    assert.match(run(home, 'off'), /^Beezi plugin diagnostics are OFF\./);
    assert.equal(consentRecord(home).consent, 'denied');
  });
});

test('an unknown argument changes nothing and says so', () => {
  withHome((home) => {
    run(home, 'on');
    const out = run(home, 'maybe');
    assert.match(out, /Not a Beezi diagnostics setting: "maybe"/);
    assert.match(out, /Nothing was changed/);
    assert.equal(consentRecord(home).consent, 'granted');
  });
});

test('the status line counts pending reports without opening them', () => {
  withHome((home) => {
    run(home, 'on');
    const pending = path.join(home, 'telemetry', 'pending');
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'a.json'), '{"eventId":"a"}');
    fs.writeFileSync(path.join(pending, 'b.json'), '{"eventId":"b"}');
    assert.match(run(home), /2 report\(s\) pending/);
  });
});

// ─── the sentences the CLI is allowed to say ────────────────────────────────

test('a failed write never claims the setting changed', () => {
  const line = telemetryCommand('off', {
    setConsent: () => ({ ok: false, mode: 'off', changed: false, purged: false, removed: 0, error: 'write-failed' }),
    consentSummary: () => ({ enabled: true, correlated: false, decided: true, noticeShown: false, pending: 3 }),
  });
  assert.match(line, /Could not save the Beezi diagnostics setting \(write-failed\); nothing was changed\./);
  assert.match(line, /diagnostics are ON/, 'the surviving setting is stated');
});

test('a deferred purge never claims the pending reports were deleted', () => {
  const line = telemetryCommand('off', {
    setConsent: () => ({ ok: true, mode: 'off', changed: true, purged: false, removed: 0, error: 'purge-deferred' }),
    consentSummary: () => ({ enabled: false, correlated: false, decided: true, noticeShown: false, pending: 3 }),
  });
  assert.match(line, /diagnostics are OFF/);
  assert.ok(!/were deleted/.test(line), line);
  assert.match(line, /deleted, not sent, on the next run/);
});

// ─── the skill ──────────────────────────────────────────────────────────────

test('the telemetry skill is a real, non-model-invoked Cursor skill', () => {
  const body = skillBody();
  assert.match(body, /^---\n/);
  assert.match(body, /\nname: beezi-telemetry\n/);
  assert.match(body, /\ndisable-model-invocation: true\n/);
  assert.match(body, /\*\*Resolve `<BEEZI>` first\.\*\*/, 'the shared path preamble');
  assert.match(body, /node "<BEEZI>\/scripts\/telemetry\.mjs"/);
  assert.match(body, /skills\/beezi-telemetry\/SKILL\.md/, 'names its own path for the trim');
});

test('the telemetry skill neither inspects secrets nor argues with the user', () => {
  const body = skillBody();
  assert.match(body, /Do NOT read, open, or inspect any files/);
  assert.match(body, /credential store/);
  assert.match(body, /do not argue for a different one/);
  assert.ok(!/recommend/i.test(body), 'the skill must never recommend a setting');
  assert.match(body, /verbatim/);
});

test('the four settings and the disable command are documented in the skill', () => {
  const body = skillBody();
  for (const mode of ['on', 'off', 'correlate', 'anonymous']) {
    assert.match(body, new RegExp(`- \`${mode}\``), mode);
  }
});

// ─── the generated shim, for real ───────────────────────────────────────────
//
// `scripts/telemetry.mjs` is the only script in this plugin that guards its self-invocation on
// `path.basename(process.argv[1])`; every other one calls `main()` unconditionally. That guard is
// only correct because `shimBody` rewrites `process.argv` to the TARGET script before the dynamic
// import — and if that ever stopped being true, `beezi telemetry on` would import this module, do
// nothing, print nothing and exit zero. Running the real generated shim is the only way to see it.

test('the generated beezi shim actually dispatches to the telemetry command', () => {
  withHome((home) => {
    const shim = path.join(home, 'beezi.mjs');
    fs.writeFileSync(shim, shimBody(PLUGIN_ROOT, { telemetry: 'telemetry.mjs' }), 'utf-8');
    const viaShim = (...args) => execFileSync(process.execPath, [shim, ...args], {
      encoding: 'utf-8',
      env: Object.assign({}, process.env, { BEEZI_CURSOR_HOME: home }),
    });

    assert.match(viaShim('telemetry', 'correlate'), /ON with account correlation/);
    assert.equal(consentRecord(home).correlation, 'granted',
      'the decision reached disk through the shim, not just through a direct node call');
    assert.match(viaShim('telemetry'), /diagnostics are ON/, 'no argument reports the setting');
  });
});
