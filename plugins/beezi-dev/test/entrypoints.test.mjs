import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Skills are this plugin's entire user-facing surface — Cursor can refuse to load a plugin command
// at all (`thirdPartyExtensibilityEnabled` plus a server-side feature gate), so everything a user
// invokes ships as a skill. These assertions cover the two things a reader of the files cannot
// check by eye: which entry points exist, and what they still advertise.

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS = path.join(PLUGIN_ROOT, 'skills');

// EXACT, not merely required. The comment here used to say "required, not exhaustive" because
// beezi-refresh, beezi-sync and beezi-telemetry were being written by other lanes in parallel and an
// exact-set assertion would have failed in a file their authors did not own. The lanes are finished
// and all nine are on disk, so the weaker assertion has nothing left to protect — and what it cannot
// catch is the case that actually matters now: a skill appearing, disappearing or being renamed
// without the README's entry-point table moving with it. Both directions are asserted below.
const REQUIRED_SKILLS = [
  'beezi-analytics', 'beezi-install', 'beezi-login', 'beezi-logout', 'beezi-me',
  'beezi-refresh', 'beezi-sync', 'beezi-telemetry', 'beezi-track',
];

// §10.2: the terminal ticket launcher is removed. The upstream drafting TOOLS stay reachable
// through the MCP bridge — `withLocalTools()` appends, it does not filter — but this plugin no
// longer offers a ticket workflow of its own.
const FORBIDDEN_SKILLS = ['create-ticket', 'beezi-ticket', 'ticket'];

function skillDirs() {
  return fs.readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function skillBody(name) {
  return fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf-8');
}

function frontmatter(body) {
  // CRLF-tolerant: these files are authored on Windows and git normalises on the way in, so a
  // line-ending-sensitive matcher passes on one machine and fails on the other.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  assert.ok(match, 'the skill has no frontmatter block');
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

test('every entry point the plugin promises is installed, and each is a real skill', () => {
  const present = skillDirs();
  for (const name of REQUIRED_SKILLS) {
    assert.ok(present.includes(name), `${name} is missing from skills/`);
    assert.ok(fs.existsSync(path.join(SKILLS, name, 'SKILL.md')), `${name} has no SKILL.md`);
  }
  // A directory under skills/ with no SKILL.md is loaded by Cursor as nothing at all, silently.
  for (const name of present) {
    assert.ok(fs.existsSync(path.join(SKILLS, name, 'SKILL.md')), `${name} has no SKILL.md`);
    assert.match(name, /^beezi-/, `${name} does not namespace itself under beezi-`);
  }
});

test('the terminal ticket launcher is gone', () => {
  const present = skillDirs();
  for (const name of FORBIDDEN_SKILLS) {
    assert.equal(present.includes(name), false, `skills/${name} still ships`);
  }
  assert.equal(fs.existsSync(path.join(SKILLS, 'create-ticket')), false);
});

test('no skill advertises ticket drafting any more', () => {
  // The removal is only real if nothing still offers it. A skill that mentions `create_ticket` or
  // tells the model to fetch a drafting workflow is a ticket launcher whatever its directory is
  // called, and this is the assertion that notices one being reintroduced.
  const banned = [
    /create_ticket/,
    /get_drafting_instructions/,
    /get_estimation_instructions/,
    /draft(ing)? a ticket/i,
    /ticket[- ]drafting/i,
    /file a bug/i,
    /Azure DevOps\)? or (in )?Beezi/i,
  ];
  for (const name of skillDirs()) {
    const body = skillBody(name);
    for (const pattern of banned) {
      assert.equal(pattern.test(body), false, `skills/${name}/SKILL.md still advertises tickets (${pattern})`);
    }
  }
});

test('no skill can be invoked by the model on its own initiative', () => {
  // These open browsers, rewrite hook registries and upload history. "A sentence looked related" is
  // not consent, and Cursor's own agent will act on one without this line.
  for (const name of skillDirs()) {
    const meta = frontmatter(skillBody(name));
    assert.equal(meta['disable-model-invocation'], 'true', `${name} may be model-invoked`);
    assert.equal(meta.name, name, `${name}'s frontmatter name is '${meta.name}'`);
    assert.ok(meta.description && meta.description.length > 20, `${name} has no usable description`);
  }
});

test('every script a skill tells the user to run actually exists', () => {
  // The failure this prevents shipped once already: a skill naming a script that is not in the
  // package produces `Cannot find module` in the user's terminal, and the only place the name
  // appears is prose that nothing compiles.
  let named = 0;
  for (const name of skillDirs()) {
    for (const [, script] of skillBody(name).matchAll(/<BEEZI>\/scripts\/([\w.-]+)/g)) {
      named++;
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'scripts', script)), `${name} → scripts/${script} is missing`);
    }
  }
  assert.ok(named > 0, 'no skill names a script — the matcher stopped matching');
});

test('no skill expects Cursor to expand a variable it does not expand in a skill', () => {
  for (const name of skillDirs()) {
    const body = skillBody(name);
    // Cursor expands ${CURSOR_PLUGIN_ROOT} in a hook `command` and an MCP server's `args`. It does
    // NOT expand it in a skill body: the model receives the literal token, hands it to a shell, and
    // the shell resolves it to nothing.
    assert.equal(body.includes('${CURSOR_PLUGIN_ROOT}'), false, `${name} expects a substitution Cursor does not perform`);
    // ~/.beezi-cursor/bin/beezi.mjs is written by the MCP server at session start, so depending on
    // it makes every entry point dead until a session has run one — which is exactly the state a
    // machine is in right after installing.
    assert.equal(body.includes('.beezi-cursor/bin'), false, `${name} depends on the generated shim`);
  }
});

test('a skill that runs a script explains how to resolve <BEEZI> from its own path', () => {
  for (const name of skillDirs()) {
    const body = skillBody(name);
    if (!body.includes('<BEEZI>/scripts/')) continue;
    assert.match(body, /Resolve `<BEEZI>` first/, `${name} does not explain <BEEZI>`);
    assert.ok(body.includes(`skills/${name}/SKILL.md\` removed`), `${name}'s resolution rule does not name its own path`);
  }
});

// ── the analytics launcher ────────────────────────────────────────────────────────────────────

test('beezi-analytics launches the server workflow instead of reimplementing it', () => {
  const body = skillBody('beezi-analytics');
  // PKG-11 is a LAUNCHER. The analytics workflow already exists on the server and is already
  // reachable — `withLocalTools()` appends local tools to the upstream list rather than replacing
  // it — so the gap was discoverability, not capability. Copying the workflow into this file would
  // drift from the server's version the first time either changed.
  assert.match(body, /get_analytics_instructions/);
  assert.match(body, /do not (improvise|restate)/i, 'the skill must forbid inventing the workflow');

  // It spawns nothing: the tool is on the MCP server that is already connected.
  assert.equal(/<BEEZI>/.test(body), false, 'the analytics launcher runs no script, so it needs no plugin path');
  assert.equal(/node "/.test(body), false, 'the analytics launcher must not shell out');

  // The two states a user actually hits, and neither may be answered with a guess.
  assert.match(body, /beezi_login/, 'an unlinked machine must be told how to sign in');
  assert.match(body, /not connected|unavailable/i, 'a missing MCP server must be named as a cause');
});

test('beezi-analytics invents no server-side vocabulary', () => {
  const body = skillBody('beezi-analytics');
  // Every MCP tool this file names has to be one the bridge actually advertises. A plausible name
  // that does not exist produces a tool-not-found the model then works around by making the answer
  // up — which is an invented analytics summary presented as the user's real spend.
  const known = new Set([
    'get_analytics_instructions', 'get_my_usage_summary', 'get_local_flow_summary',
    'query_local_flow_metric', 'get_local_flow_session', 'list_local_flow_scopes', 'beezi_login',
  ]);
  for (const [, name] of body.matchAll(/`([a-z][a-z0-9_]{6,})`/g)) {
    if (!/^(get|list|query|beezi)_/.test(name)) continue;
    assert.ok(known.has(name), `beezi-analytics names an MCP tool that is not advertised: ${name}`);
  }
});

// ── B1: the two telemetry seams the CLI entry points are the only composition root for ──────────

// `scripts/*.mjs` run their work on import — `main()` and a top-level `.then()` — so they cannot be
// imported into a test to observe what they pass. The wiring is asserted against the SOURCE instead,
// which is the only thing that can fail when someone deletes the argument. The behaviour on the far
// side of each seam is covered by test/logout.test.mjs and test/login.test.mjs; what these two pin
// is that a production caller exists at all, which is precisely what was missing.
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const scriptBody = (name) => fs.readFileSync(path.join(SCRIPTS, name), 'utf-8');

test('the logout CLI passes the installation-rotation callback to performLogout', () => {
  const body = scriptBody('logout.mjs');
  // A no-op default plus no caller is indistinguishable from the feature being absent: `boundAt`
  // outliving a logout is exactly the case the README promises does not happen.
  assert.match(body, /onInstallationRotate\s*:/, 'performLogout is called without the rotation seam');
  assert.match(
    body,
    /import\s*\{[^}]*\bonLogout\b[^}]*\}\s*from\s*['"]\.\.\/lib\/telemetry\.mjs['"]/,
    'the rotation callback must be the telemetry facade\'s onLogout, not a local stand-in',
  );
});

test('lib/login.mjs binds the diagnostic installation itself, for every sign-in surface', () => {
  // Defaulted inside the library rather than injected by each CLI, because there are TWO sign-in
  // surfaces (this script and the MCP bridge's beezi_login tool) and a seam that one of them
  // forgets is the dead seam all over again.
  const body = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'login.mjs'), 'utf-8');
  assert.match(
    body,
    /import\s*\{[^}]*\bbindInstallation\b[^}]*\}\s*from\s*['"]\.\/telemetry\.mjs['"]/,
    'the binding must come through the telemetry facade (CONTRACTS section 8)',
  );
  assert.match(body, /bindDiagnostics\(d,/, 'nothing calls the binding');
});

// ── the entry-point set is exact, and the README agrees with it ─────────────────────────────────

test('the skills on disk are exactly the nine the README advertises', () => {
  // Two assertions in one, deliberately. `skillDirs()` is the ground truth; REQUIRED_SKILLS is what
  // this suite claims; the README table is what a user is told. All three drifting apart silently
  // is how a plugin ends up documenting a skill it does not ship, or shipping one nobody can find.
  assert.deepEqual(skillDirs(), [...REQUIRED_SKILLS].sort(), 'the skills on disk are not the exact set');

  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf-8');
  const section = readme.split('## Entry points')[1];
  assert.ok(section, 'the README has no Entry points section for the table to live in');
  const table = section.split(/\n## /)[0];
  const listed = [...table.matchAll(/^\| `(beezi-[a-z-]+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, [...REQUIRED_SKILLS].sort(), 'the README table and the skills on disk disagree');
});
