import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/make-variant.sh is a ROOT script, not plugin code, but its output IS the shipped plugin:
// the manifest name that namespaces the credential store, and the env.json that decides which
// tenant a build reports to. A wrong answer here is not a broken build, it is a dev machine
// uploading into production.

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PLUGIN_ROOT));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'make-variant.sh');

const BASH = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p))
  : '/bin/bash';

const SOURCE_VERSION = '0.5.2';
const SOURCE_DESCRIPTION = 'Reports Cursor session analytics.';

// A fixture repo rather than the real tree: the script resolves its repository root from its own
// location, so a copy of it in a temp directory writes dist/ there and the developer's checkout is
// never touched by a test run.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-variant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'make-variant.sh'));

  const src = path.join(root, 'plugins', 'beezi');
  fs.mkdirSync(path.join(src, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills', 'beezi-me'), { recursive: true });
  writeJson(path.join(src, '.cursor-plugin', 'plugin.json'), {
    name: 'beezi',
    version: SOURCE_VERSION,
    description: SOURCE_DESCRIPTION,
    author: { name: 'Beezi' },
    keywords: ['analytics'],
    skills: './skills/',
    hooks: './hooks/hooks.json',
    mcpServers: './mcp.json',
  });
  writeJson(path.join(src, 'package.json'), { name: 'beezi', version: SOURCE_VERSION, private: true });
  writeJson(path.join(src, 'env.json'), { name: '', apiBase: 'https://beezi-api-prod.azurewebsites.net/api' });
  fs.writeFileSync(path.join(src, 'lib', 'config.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(src, 'skills', 'beezi-me', 'SKILL.md'), '# me\n');
  return root;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Two assertions below read the generator as text rather than running it. That is deliberate: no
// black-box run can prove the ABSENCE of a destructive branch or of a key the release decision
// forbids, and both are cheap to grep.
function scriptLines() {
  return fs.readFileSync(SCRIPT, 'utf-8').split('\n').map((line) => line.replace(/\r$/, ''));
}

function run(root, args) {
  const res = spawnSync(BASH, [path.join(root, 'scripts', 'make-variant.sh'), ...args], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, PATH: process.env.PATH },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('bash is available to run the release scripts', () => {
  assert.ok(BASH, 'no bash on this machine — the variant/publish scripts cannot be exercised');
});

test('a dev variant is renamed, versioned and pointed at the dev API', (t) => {
  const root = fixture(t);
  const res = run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '12345']);
  assert.equal(res.code, 0, res.stderr);

  const out = path.join(root, 'dist', 'variant', 'plugins', 'beezi-dev');
  const manifest = readJson(path.join(out, '.cursor-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'beezi-dev', 'the manifest name IS the credential/state namespace');
  // Prerelease, not a bump: every internal publish has to read as newer than the last one without
  // a human touching package.json, and `0.5.2-dev.12346` sorts above `0.5.2-dev.12345`.
  assert.equal(manifest.version, `${SOURCE_VERSION}-dev.12345`);
  assert.match(manifest.description, /dev/);
  assert.equal(manifest.skills, './skills/', 'untouched fields survive the rewrite');

  assert.deepEqual(readJson(path.join(out, 'env.json')), {
    name: 'dev',
    apiBase: 'https://beezi-api-dev.azurewebsites.net/api',
  });
  // The plugin itself is copied verbatim; only the two identity files are rewritten.
  assert.ok(fs.existsSync(path.join(out, 'lib', 'config.mjs')));
  assert.ok(fs.existsSync(path.join(out, 'skills', 'beezi-me', 'SKILL.md')));
});

test('env.json carries no updateManifestUrl, anywhere in the generated tree', (t) => {
  // PKG-16 is deferred by an explicit product decision (§10.1). A build that bakes an update URL
  // ships a self-update channel nobody approved, and the Claude-plugin script this one is derived
  // from does exactly that — so it is asserted, not assumed.
  const root = fixture(t);
  assert.equal(run(root, ['staging', 'https://beezi-api-staging.azurewebsites.net/api', '7']).code, 0);
  const out = path.join(root, 'dist', 'variant', 'plugins', 'beezi-staging');
  assert.deepEqual(Object.keys(readJson(path.join(out, 'env.json'))).sort(), ['apiBase', 'name']);
  // Comments are stripped before the grep: the script SAYS why the key is absent, and that
  // sentence is worth keeping.
  const code = scriptLines()
    .filter((line) => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
    .join(' ');
  assert.equal(/updateManifestUrl/.test(code), false, 'the generator must not write the key');
});

test('prod builds as plain `beezi` and keeps the source version', (t) => {
  const root = fixture(t);
  assert.equal(run(root, ['prod', 'https://beezi-api-prod.azurewebsites.net/api', '99']).code, 0);
  const out = path.join(root, 'dist', 'variant', 'plugins', 'beezi');
  const manifest = readJson(path.join(out, '.cursor-plugin', 'plugin.json'));
  assert.equal(manifest.name, 'beezi');
  assert.equal(manifest.version, SOURCE_VERSION, 'prod must stay equal to package.json, three-way');
  assert.equal(manifest.description, SOURCE_DESCRIPTION, 'no environment tag on the public listing');
  assert.deepEqual(readJson(path.join(out, 'env.json')), {
    name: '',
    apiBase: 'https://beezi-api-prod.azurewebsites.net/api',
  });
});

test('the source tree is never modified', (t) => {
  const root = fixture(t);
  const src = path.join(root, 'plugins', 'beezi');
  const before = {
    manifest: fs.readFileSync(path.join(src, '.cursor-plugin', 'plugin.json'), 'utf-8'),
    env: fs.readFileSync(path.join(src, 'env.json'), 'utf-8'),
    pkg: fs.readFileSync(path.join(src, 'package.json'), 'utf-8'),
  };
  assert.equal(run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1']).code, 0);
  assert.equal(fs.readFileSync(path.join(src, '.cursor-plugin', 'plugin.json'), 'utf-8'), before.manifest);
  assert.equal(fs.readFileSync(path.join(src, 'env.json'), 'utf-8'), before.env);
  assert.equal(fs.readFileSync(path.join(src, 'package.json'), 'utf-8'), before.pkg);
});

test('an unknown environment is refused', (t) => {
  const root = fixture(t);
  for (const env of ['qa', 'PROD', 'production', '']) {
    const res = run(root, [env, 'https://beezi-api-dev.azurewebsites.net/api', '1']);
    assert.notEqual(res.code, 0, `env ${JSON.stringify(env)} was accepted`);
    assert.match(res.stderr, /make-variant/);
  }
});

test('a traversal in the environment or the source directory is refused', (t) => {
  const root = fixture(t);
  for (const args of [
    ['../prod', 'https://beezi-api-dev.azurewebsites.net/api', '1'],
    ['dev/../staging', 'https://beezi-api-dev.azurewebsites.net/api', '1'],
    ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1', '../../etc'],
    ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1', 'plugins/../../elsewhere'],
  ]) {
    const res = run(root, args);
    assert.notEqual(res.code, 0, `${args.join(' ')} was accepted`);
  }
});

test('a bad build id is refused', (t) => {
  const root = fixture(t);
  for (const id of ['', 'abc', '1.2', '-1', '1 2', '1;rm -rf /', '12345678901234567890123']) {
    const res = run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', id]);
    assert.notEqual(res.code, 0, `build id ${JSON.stringify(id)} was accepted`);
  }
});

test('a publishable environment refuses anything but a clean https base', (t) => {
  const root = fixture(t);
  const rejected = [
    'http://beezi-api-dev.azurewebsites.net/api',          // plaintext
    'https://user:pass@beezi-api-dev.azurewebsites.net/api', // embedded credentials
    'https://token@beezi-api-dev.azurewebsites.net/api',
    'https://localhost:5001/api',                           // a developer box
    'http://localhost:5001/api',
    'https://127.0.0.1:5001/api',
    'https://abc123.ngrok.io/api',                          // a tunnel that dies after the demo
    'https://beezi-api-dev.azurewebsites.net',              // not an API base
    'ftp://beezi-api-dev.azurewebsites.net/api',
    'https://beezi api.example.com/api',
  ];
  for (const url of rejected) {
    const res = run(root, ['dev', url, '1']);
    assert.notEqual(res.code, 0, `${url} was accepted for a publishable environment`);
    assert.match(res.stderr, /api-base/);
  }
});

test('local is the one environment allowed to point at a developer box', (t) => {
  const root = fixture(t);
  const res = run(root, ['local', 'http://localhost:5001/api', '1']);
  assert.equal(res.code, 0, res.stderr);
  const out = path.join(root, 'dist', 'variant', 'plugins', 'beezi-local');
  assert.deepEqual(readJson(path.join(out, 'env.json')), { name: 'local', apiBase: 'http://localhost:5001/api' });
  assert.equal(readJson(path.join(out, '.cursor-plugin', 'plugin.json')).name, 'beezi-local');
});

test('a rejected build deletes nothing — validation runs before cleanup', (t) => {
  // The whole reason the checks are ordered that way: a typo in the API base must not destroy the
  // variant that is sitting in dist/ from the last good build (and, in the pipeline, the one a
  // parallel step is about to publish).
  const root = fixture(t);
  assert.equal(run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1']).code, 0);
  const good = path.join(root, 'dist', 'variant', 'plugins', 'beezi-dev', '.cursor-plugin', 'plugin.json');
  assert.ok(fs.existsSync(good));

  for (const args of [
    ['qa', 'https://beezi-api-dev.azurewebsites.net/api', '2'],
    ['dev', 'http://beezi-api-dev.azurewebsites.net/api', '2'],
    ['dev', 'https://beezi-api-dev.azurewebsites.net/api', 'nope'],
    ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '2', 'plugins/does-not-exist'],
  ]) {
    assert.notEqual(run(root, args).code, 0, args.join(' '));
    assert.ok(fs.existsSync(good), `${args.join(' ')} wiped the previous variant`);
    assert.equal(readJson(good).version, `${SOURCE_VERSION}-dev.1`, 'the previous build survived intact');
  }
});

test('a source directory that is not a plugin is refused', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'plugins', 'empty'), { recursive: true });
  for (const dir of ['plugins/empty', 'plugins/missing', 'scripts']) {
    const res = run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1', dir]);
    assert.notEqual(res.code, 0, `${dir} was accepted as a plugin source`);
  }
});

test('an explicit, valid source directory is honoured', (t) => {
  const root = fixture(t);
  const res = run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1', 'plugins/beezi']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(root, 'dist', 'variant', 'plugins', 'beezi-dev', 'env.json')));
});

test('a rebuild replaces the previous output rather than merging into it', (t) => {
  const root = fixture(t);
  assert.equal(run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1']).code, 0);
  const stale = path.join(root, 'dist', 'variant', 'plugins', 'beezi-dev', 'stale.txt');
  fs.writeFileSync(stale, 'left over from an older source tree');
  assert.equal(run(root, ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '2']).code, 0);
  assert.equal(fs.existsSync(stale), false, 'a deleted source file must not survive in the artifact');
  assert.equal(
    readJson(path.join(root, 'dist', 'variant', 'plugins', 'beezi-dev', '.cursor-plugin', 'plugin.json')).version,
    `${SOURCE_VERSION}-dev.2`,
  );
});

test('the generator only ever removes its own dist/variant', () => {
  // Read as text on purpose. An `rm -rf` whose target came from an argument is one bad default
  // away from deleting the checkout, and no black-box test can prove the absence of that path.
  const script = fs.readFileSync(SCRIPT, 'utf-8');
  const removals = script.split('\n').filter((line) => /(^|\s)rm\s/.test(line) && !line.trim().startsWith('#'));
  assert.ok(removals.length > 0, 'the script must clean its output');
  for (const line of removals) {
    assert.match(line, /"\$OUT/, `rm target is not under the verified output dir: ${line.trim()}`);
  }
  assert.match(script, /OUT="\$REPO_ROOT\/dist\/variant"/);
});
