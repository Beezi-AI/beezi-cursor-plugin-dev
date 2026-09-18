import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The publish boundary, exercised end to end against real local bare repositories.
//
// Every scenario below is a way this has gone wrong for somebody: an internal analysis directory
// pushed to a public marketplace, a snapshot from one branch deleting the other environment's
// variant, a no-op build rewriting history every night, a typo'd config publishing a tunnel URL
// that stays in the commit log forever. None of them are visible in a diff of the script.

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PLUGIN_ROOT));
const SYNC = path.join(REPO_ROOT, 'scripts', 'sync-to-github.sh');
const MAKE_VARIANT = path.join(REPO_ROOT, 'scripts', 'make-variant.sh');

const BASH = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p))
  : '/bin/bash';

const PROD_API = 'https://beezi-api-prod.azurewebsites.net/api';

// The developer's own git config must not reach these repositories: a global commit.gpgsign turns
// every fixture commit into a signing prompt that hangs the suite on Windows.
function gitEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-empty'),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd, args, home) {
  const res = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf-8',
    env: gitEnv(home),
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}${res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function writeText(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// A miniature of this repository: the internal files that must never publish, a plugin with every
// runtime artifact the publish asserts, and the two manifests.
function sourceRepo(t, { version = '0.6.0', apiBase = PROD_API, envName = '', extraPlugins = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig-empty'), '');
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });

  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.copyFileSync(SYNC, path.join(src, 'scripts', 'sync-to-github.sh'));
  fs.copyFileSync(MAKE_VARIANT, path.join(src, 'scripts', 'make-variant.sh'));

  // The internal half. Every one of these paths is on the exclusion list.
  writeText(path.join(src, 'azure-pipelines.yml'), 'stages: []\n');
  writeText(path.join(src, 'docs', 'gap-analysis', 'internal.md'), 'internal analysis\n');
  writeText(path.join(src, 'docs', 'superpowers', 'specs', 'plan.md'), 'internal plan');

  // The PUBLIC half of `docs/`, which the published README links to. `docs/` is filtered per
  // subtree rather than wholesale precisely so these travel with it; an artifact that drops them
  // ships a front page of dead links, which looks like a working publish.
  writeText(path.join(src, 'docs', 'privacy.md'), 'what is sent');
  writeText(path.join(src, 'CONTRIBUTING.md'), 'how to contribute');

  writeText(path.join(src, '.github', 'workflows', 'old.yml'), 'name: old\n');
  writeText(path.join(src, '.claude', 'settings.json'), '{"secret":"do not publish"}\n');
  writeJson(path.join(src, '.cursor-plugin', 'publish.json'), {
    plugins: { beezi: { publish: true } },
  });

  const names = ['beezi', ...extraPlugins];
  for (const name of names) {
    const dir = path.join(src, 'plugins', name);
    writeJson(path.join(dir, '.cursor-plugin', 'plugin.json'), {
      name,
      version,
      description: 'Reports Cursor session analytics.',
      author: { name: 'Beezi' },
      skills: './skills/',
      hooks: './hooks/hooks.json',
      mcpServers: './mcp.json',
    });
    writeJson(path.join(dir, 'package.json'), { name, version, private: true, type: 'module' });
    writeJson(path.join(dir, 'env.json'), { name: envName, apiBase });
    writeJson(path.join(dir, 'mcp.json'), {
      mcpServers: { beezi: { command: 'node', args: ['--no-warnings', '${CURSOR_PLUGIN_ROOT}/scripts/mcp.mjs'], cwd: '${CURSOR_PLUGIN_ROOT}' } },
    });
    writeJson(path.join(dir, 'hooks', 'hooks.json'), { version: 1, hooks: {} });
    writeText(path.join(dir, 'scripts', 'mcp.mjs'), '// mcp bridge\n');
    writeText(path.join(dir, 'scripts', 'stop.mjs'), '// stop hook\n');
    writeText(path.join(dir, 'lib', 'config.mjs'), 'export const x = 1;\n');
    writeText(path.join(dir, 'skills', 'beezi-me', 'SKILL.md'), '# me\n');
    writeText(path.join(dir, 'README.md'), '# plugin\n');
  }

  writeJson(path.join(src, '.cursor-plugin', 'marketplace.json'), {
    name: 'beezi',
    owner: { name: 'Beezi' },
    description: "Beezi's Cursor plugin marketplace.",
    plugins: names.map((name) => ({
      name,
      source: `./plugins/${name}`,
      description: 'Reports Cursor session analytics.',
      version,
      author: { name: 'Beezi' },
      category: 'analytics',
    })),
  });

  git(src, ['init', '-q', '-b', 'prod'], home);
  git(src, ['add', '-A'], home);
  git(src, ['commit', '-q', '-m', 'fixture: initial'], home);

  const dest = path.join(root, 'dest.git');
  git(root, ['init', '-q', '--bare', dest], home);
  const publicDest = path.join(root, 'public.git');
  git(root, ['init', '-q', '--bare', publicDest], home);

  return { root, home, src, dest, publicDest };
}

function publish(fx, env = {}, args = []) {
  const res = spawnSync(BASH, [path.join(fx.src, 'scripts', 'sync-to-github.sh'), ...args], {
    cwd: fx.src,
    encoding: 'utf-8',
    env: {
      ...gitEnv(fx.home),
      GITHUB_REPO: 'Beezi-AI/beezi-cursor-plugin',
      PUBLISH_DEST: fx.dest,
      SOURCE_REF: 'HEAD',
      TARGET_BRANCH: 'main',
      ...env,
    },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function publishedFiles(fx, dest = fx.dest) {
  try {
    return git(dest, ['ls-tree', '-r', '--name-only', 'main'], fx.home).split('\n').filter(Boolean);
  } catch (error) {
    return null;
  }
}

function publishedJson(fx, file, dest = fx.dest) {
  return JSON.parse(git(dest, ['show', `main:${file}`], fx.home));
}

function destCommits(fx, dest = fx.dest) {
  try {
    return git(dest, ['log', '--format=%s', 'main'], fx.home).split('\n').filter(Boolean);
  } catch (error) {
    return [];
  }
}

function buildVariant(fx, env, api, buildId) {
  const res = spawnSync(BASH, [path.join(fx.src, 'scripts', 'make-variant.sh'), env, api, buildId], {
    cwd: fx.src, encoding: 'utf-8', env: gitEnv(fx.home),
  });
  assert.equal(res.status, 0, res.stderr);
}

// ── snapshot mode ─────────────────────────────────────────────────────────────────────────────

test('a first publish creates the branch with the plugin and nothing internal', (t) => {
  const fx = sourceRepo(t);
  const res = publish(fx);
  assert.equal(res.code, 0, res.stderr);

  const files = publishedFiles(fx);
  // The runtime half is all there — including plugins/beezi/scripts, which shares a name with the
  // ROOT scripts directory on the exclusion list. An unanchored pathspec drops both, and the plugin
  // publishes without its MCP bridge or a single hook script.
  assert.ok(files.includes('plugins/beezi/scripts/mcp.mjs'), 'the plugin lost its own scripts/');
  assert.ok(files.includes('plugins/beezi/scripts/stop.mjs'));
  assert.ok(files.includes('plugins/beezi/lib/config.mjs'));
  assert.ok(files.includes('plugins/beezi/.cursor-plugin/plugin.json'));
  assert.ok(files.includes('plugins/beezi/env.json'));
  assert.ok(files.includes('.cursor-plugin/marketplace.json'));
  // The public docs the README points at travel with it.
  assert.ok(files.includes('docs/privacy.md'), 'a public doc the README links was filtered out');
  assert.ok(files.includes('CONTRIBUTING.md'));

  // The internal half is all gone.
  for (const forbidden of [
    'azure-pipelines.yml',
    'scripts/sync-to-github.sh',
    'scripts/make-variant.sh',
    'docs/gap-analysis/internal.md',
    'docs/superpowers/specs/plan.md',
    '.github/workflows/old.yml',
    '.claude/settings.json',
    '.cursor-plugin/publish.json',
  ]) {
    assert.equal(files.includes(forbidden), false, `${forbidden} reached the public repo`);
  }
});

test('publishing twice with no source change pushes nothing', (t) => {
  const fx = sourceRepo(t);
  assert.equal(publish(fx).code, 0);
  const first = destCommits(fx);
  const again = publish(fx);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already up to date/);
  assert.deepEqual(destCommits(fx), first, 'a no-op build rewrote the published history');
});

test('a version change publishes a new commit', (t) => {
  const fx = sourceRepo(t);
  assert.equal(publish(fx).code, 0);
  const before = destCommits(fx).length;

  for (const file of ['.cursor-plugin/plugin.json', 'package.json']) {
    const p = path.join(fx.src, 'plugins', 'beezi', file);
    const doc = JSON.parse(fs.readFileSync(p, 'utf-8'));
    doc.version = '0.6.1';
    writeJson(p, doc);
  }
  const market = path.join(fx.src, '.cursor-plugin', 'marketplace.json');
  const doc = JSON.parse(fs.readFileSync(market, 'utf-8'));
  doc.plugins[0].version = '0.6.1';
  writeJson(market, doc);
  git(fx.src, ['commit', '-aqm', 'fixture: bump to 0.6.1'], fx.home);

  assert.equal(publish(fx).code, 0);
  assert.equal(destCommits(fx).length, before + 1);
  assert.equal(publishedJson(fx, 'plugins/beezi/.cursor-plugin/plugin.json').version, '0.6.1');
  assert.equal(publishedJson(fx, '.cursor-plugin/marketplace.json').plugins[0].version, '0.6.1');
});

test('a selected plugin with no directory aborts before anything is pushed', (t) => {
  const fx = sourceRepo(t);
  writeJson(path.join(fx.src, '.cursor-plugin', 'publish.json'), {
    plugins: { beezi: { publish: true }, 'beezi-web': { publish: true } },
  });
  git(fx.src, ['commit', '-aqm', 'fixture: select a plugin that does not exist'], fx.home);

  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /beezi-web/);
  assert.equal(publishedFiles(fx), null, 'the destination was written despite the abort');
});

test('a plugin directory with no publish entry aborts rather than guessing', (t) => {
  const fx = sourceRepo(t, { extraPlugins: ['beezi-web'] });
  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /beezi-web/);
});

test('a withheld plugin leaves the tree AND the marketplace listing', (t) => {
  const fx = sourceRepo(t, { extraPlugins: ['beezi-web'] });
  writeJson(path.join(fx.src, '.cursor-plugin', 'publish.json'), {
    plugins: { beezi: { publish: true }, 'beezi-web': { publish: false } },
  });
  git(fx.src, ['commit', '-aqm', 'fixture: withhold beezi-web'], fx.home);

  assert.equal(publish(fx).code, 0);
  const files = publishedFiles(fx);
  assert.equal(files.some((f) => f.startsWith('plugins/beezi-web/')), false);
  // A listing that still advertises files which are not there is an install that 404s.
  const names = publishedJson(fx, '.cursor-plugin/marketplace.json').plugins.map((p) => p.name);
  assert.deepEqual(names, ['beezi']);
});

test('a malformed publish config or plugin manifest aborts', (t) => {
  const fx = sourceRepo(t);
  writeText(path.join(fx.src, '.cursor-plugin', 'publish.json'), '{ "plugins": ');
  git(fx.src, ['commit', '-aqm', 'fixture: break the publish config'], fx.home);
  let res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.equal(publishedFiles(fx), null);

  writeJson(path.join(fx.src, '.cursor-plugin', 'publish.json'), { plugins: { beezi: { publish: true } } });
  writeText(path.join(fx.src, 'plugins', 'beezi', '.cursor-plugin', 'plugin.json'), '{ "name": ');
  git(fx.src, ['commit', '-aqm', 'fixture: break the manifest'], fx.home);
  res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.equal(publishedFiles(fx), null);
});

test('a publish config whose entry is not a boolean aborts instead of silently withholding', (t) => {
  const fx = sourceRepo(t);
  writeJson(path.join(fx.src, '.cursor-plugin', 'publish.json'), { plugins: { beezi: { publish: 'yes' } } });
  git(fx.src, ['commit', '-aqm', 'fixture: publish is a string'], fx.home);
  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /boolean/);
});

test('a required runtime artifact missing from the plugin aborts', (t) => {
  const fx = sourceRepo(t);
  git(fx.src, ['rm', '-q', 'plugins/beezi/mcp.json'], fx.home);
  git(fx.src, ['commit', '-qm', 'fixture: drop the MCP config'], fx.home);
  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /mcp\.json/);
  assert.equal(publishedFiles(fx), null);
});

test('a non-production destination in a publishable plugin is refused', (t) => {
  for (const apiBase of ['http://localhost:5001/api', 'https://abc123.ngrok.io/api', 'http://127.0.0.1:5001/api']) {
    const fx = sourceRepo(t, { apiBase });
    const res = publish(fx);
    assert.notEqual(res.code, 0, `${apiBase} was published`);
    assert.match(res.stderr, /non-production|localhost|ngrok|127\.0\.0\.1/);
    assert.equal(publishedFiles(fx), null);
  }
});

test('a plugin baked as the local environment is refused', (t) => {
  // BEEZI_CURSOR_ENV=local is the one environment that is never published: its store, its keychain
  // service and its API base are all a developer's machine.
  const fx = sourceRepo(t, { envName: 'local' });
  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /local/);
  assert.equal(publishedFiles(fx), null);
});

test('an uncommitted change in the working tree does not reach the published tree', (t) => {
  // The tree is built from the source COMMIT through a throwaway index. A build agent always has a
  // dirty tree — dist/ is generated into it — and a publish that picked up working-tree state would
  // ship whatever a previous step happened to leave behind.
  const fx = sourceRepo(t);
  writeText(path.join(fx.src, 'plugins', 'beezi', 'lib', 'leaked.mjs'), 'export const secret = 1;\n');
  writeText(path.join(fx.src, 'plugins', 'beezi', 'lib', 'config.mjs'), 'export const x = 999; // uncommitted\n');
  assert.equal(publish(fx).code, 0);
  const files = publishedFiles(fx);
  assert.equal(files.includes('plugins/beezi/lib/leaked.mjs'), false);
  assert.equal(git(fx.dest, ['show', 'main:plugins/beezi/lib/config.mjs'], fx.home), 'export const x = 1;');
});

test('a destination that moved on is absorbed, never overwritten', (t) => {
  const fx = sourceRepo(t);
  assert.equal(publish(fx).code, 0);

  // Somebody else pushes to the published branch between builds — a hotfix, a README edit, the
  // other environment's publish. Force-pushing here destroys it silently.
  const clone = path.join(fx.root, 'clone');
  git(fx.root, ['clone', '-q', fx.dest, clone], fx.home);
  // The bare fixture's HEAD still names git's default branch, which the publish never created.
  git(clone, ['checkout', '-q', '-B', 'main', 'origin/main'], fx.home);
  writeText(path.join(clone, 'FOREIGN.md'), 'someone else was here\n');
  git(clone, ['add', '-A'], fx.home);
  git(clone, ['commit', '-qm', 'foreign: a commit this pipeline did not make'], fx.home);
  git(clone, ['push', '-q', 'origin', 'main'], fx.home);

  writeText(path.join(fx.src, 'plugins', 'beezi', 'lib', 'extra.mjs'), 'export const y = 2;\n');
  git(fx.src, ['add', '-A'], fx.home);
  git(fx.src, ['commit', '-qm', 'fixture: add a lib file'], fx.home);
  assert.equal(publish(fx).code, 0);

  const subjects = destCommits(fx);
  assert.ok(subjects.includes('foreign: a commit this pipeline did not make'),
    'the foreign commit was force-overwritten');
  assert.ok(publishedFiles(fx).includes('plugins/beezi/lib/extra.mjs'));
});

test('the publisher can never force-push', () => {
  const body = fs.readFileSync(SYNC, 'utf-8');
  const code = body.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.equal(/--force/.test(code), false, 'a force push destroys whatever the pipeline did not make');
  assert.equal(/push\s+-f\b/.test(code), false);
  assert.equal(/\+refs\//.test(code), false, 'a leading + is a force push spelled differently');
});

test('the tree verification aborts when the listing and the manifest disagree on a version', (t) => {
  // The one failure the pathspec filter cannot cause and the manifest checks above cannot see: both
  // documents are individually valid, and only their RELATIONSHIP is wrong. Cursor decides an
  // installed copy is stale by comparing the marketplace entry against the installed manifest, so a
  // listing that advertises a version the plugin does not have is an install that looks current
  // forever — and nothing at runtime would ever report it.
  const fx = sourceRepo(t);
  const market = path.join(fx.src, '.cursor-plugin', 'marketplace.json');
  const doc = JSON.parse(fs.readFileSync(market, 'utf-8'));
  doc.plugins[0].version = '9.9.9';
  writeJson(market, doc);
  git(fx.src, ['commit', '-aqm', 'fixture: advertise a version the plugin does not have'], fx.home);

  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /verification failed/);
  assert.match(res.stderr, /9\.9\.9/);
  assert.equal(publishedFiles(fx), null, 'the divergent tree was published anyway');
});

test('the tree verification aborts when the listing points somewhere else', (t) => {
  const fx = sourceRepo(t);
  const market = path.join(fx.src, '.cursor-plugin', 'marketplace.json');
  const doc = JSON.parse(fs.readFileSync(market, 'utf-8'));
  doc.plugins[0].source = './plugins/somewhere-else';
  writeJson(market, doc);
  git(fx.src, ['commit', '-aqm', 'fixture: point the listing at a directory that is not published'], fx.home);

  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /verification failed/);
  assert.equal(publishedFiles(fx), null);
});

test('a dry run needs no credential', (t) => {
  // "Show me what this would publish" must not be a question only a release operator can ask. The
  // run never pushes, so requiring a PAT buys nothing and stops anyone reviewing the filter.
  const fx = sourceRepo(t);
  const res = publish(fx, { DRY_RUN: 'true', PUBLISH_DEST: '', GITHUB_PAT: '' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /nothing pushed/);
  assert.match(res.stdout, /plugins\/beezi\/scripts\/mcp\.mjs/);
});

test('a dry run pushes nothing and touches neither the index nor the working tree', (t) => {
  const fx = sourceRepo(t);
  const before = git(fx.src, ['status', '--porcelain'], fx.home);
  const res = publish(fx, { DRY_RUN: 'true' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /nothing pushed/);
  assert.match(res.stdout, /plugins\/beezi\/scripts\/mcp\.mjs/, 'a dry run must list what would publish');
  assert.equal(publishedFiles(fx), null, 'DRY_RUN pushed');
  assert.equal(git(fx.src, ['status', '--porcelain'], fx.home), before);
});

test('no credential ever reaches a URL, an argument or the log', (t) => {
  const fx = sourceRepo(t);
  const res = publish(fx, { GITHUB_PAT: 'ghp_SUPERSECRETVALUE' });
  assert.equal(res.code, 0, res.stderr);
  const output = res.stdout + res.stderr;
  assert.equal(output.includes('ghp_SUPERSECRETVALUE'), false, 'the PAT was printed');
  assert.equal(output.includes('x-access-token:'), false, 'a credential-bearing URL was printed');

  const body = fs.readFileSync(SYNC, 'utf-8');
  // The PAT reaches git through GIT_ASKPASS, which keeps it out of argv, out of `git remote -v`
  // and out of the pipeline log. Interpolating it into the remote URL puts it in all three.
  assert.match(body, /GIT_ASKPASS/);
  assert.equal(/https:\/\/\$\{?GITHUB_PAT/.test(body), false, 'the PAT is interpolated into a URL');
  assert.match(body, /trap /, 'the askpass helper must be removed even on failure');
});

// ── variant merge mode ────────────────────────────────────────────────────────────────────────

test('a variant merge bootstraps the internal marketplace and upserts a coherent entry', (t) => {
  const fx = sourceRepo(t);
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '4242');
  const res = publish(fx, { VARIANT_DIR: 'dist/variant', PUBLIC_REPO: 'Beezi-AI/beezi-cursor-plugin', GITHUB_REPO: 'Beezi-AI/internal' });
  assert.equal(res.code, 0, res.stderr);

  const files = publishedFiles(fx);
  assert.ok(files.includes('plugins/beezi-dev/.cursor-plugin/plugin.json'));
  assert.ok(files.includes('plugins/beezi-dev/scripts/mcp.mjs'));
  assert.equal(files.includes('scripts/sync-to-github.sh'), false, 'the generator copied internal files in');

  const market = publishedJson(fx, '.cursor-plugin/marketplace.json');
  // A name distinct from the public marketplace, so a developer can add both side by side.
  assert.equal(market.name, 'beezi-internal');
  const entry = market.plugins.find((p) => p.name === 'beezi-dev');
  const manifest = publishedJson(fx, 'plugins/beezi-dev/.cursor-plugin/plugin.json');
  assert.equal(entry.version, manifest.version, 'the listing must name the version it points at');
  assert.equal(entry.version, '0.6.0-dev.4242');
  assert.equal(entry.source, './plugins/beezi-dev');
  assert.equal(entry.description, manifest.description);
});

test('a variant merge preserves the other environment already in the repo', (t) => {
  // dev and staging publish from different branches into one repository. A snapshot from either
  // would delete the other; only an exact-pathspec merge keeps both installable.
  const fx = sourceRepo(t);
  const internal = { VARIANT_DIR: 'dist/variant', PUBLIC_REPO: 'Beezi-AI/beezi-cursor-plugin', GITHUB_REPO: 'Beezi-AI/internal' };
  buildVariant(fx, 'staging', 'https://beezi-api-staging.azurewebsites.net/api', '10');
  assert.equal(publish(fx, internal).code, 0);
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '11');
  assert.equal(publish(fx, internal).code, 0);

  const files = publishedFiles(fx);
  assert.ok(files.includes('plugins/beezi-staging/.cursor-plugin/plugin.json'), 'staging was wiped by the dev publish');
  assert.ok(files.includes('plugins/beezi-dev/.cursor-plugin/plugin.json'));
  const names = publishedJson(fx, '.cursor-plugin/marketplace.json').plugins.map((p) => p.name).sort();
  assert.deepEqual(names, ['beezi-dev', 'beezi-staging']);

  // Re-publishing the same variant replaces its own entry rather than appending a duplicate.
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '12');
  assert.equal(publish(fx, internal).code, 0);
  const after = publishedJson(fx, '.cursor-plugin/marketplace.json').plugins;
  assert.equal(after.filter((p) => p.name === 'beezi-dev').length, 1);
  assert.equal(after.find((p) => p.name === 'beezi-dev').version, '0.6.0-dev.12');
  assert.equal(after.find((p) => p.name === 'beezi-staging').version, '0.6.0-staging.10');
});

test('a variant merge refuses the public marketplace repository', (t) => {
  const fx = sourceRepo(t);
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '1');
  const res = publish(fx, {
    VARIANT_DIR: 'dist/variant',
    GITHUB_REPO: 'Beezi-AI/beezi-cursor-plugin',
    PUBLIC_REPO: 'Beezi-AI/beezi-cursor-plugin',
    PUBLISH_DEST: fx.publicDest,
  });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /PUBLIC/i);
  assert.equal(publishedFiles(fx, fx.publicDest), null);
});

test('a variant merge is a no-op when nothing changed', (t) => {
  const fx = sourceRepo(t);
  const internal = { VARIANT_DIR: 'dist/variant', PUBLIC_REPO: 'Beezi-AI/beezi-cursor-plugin', GITHUB_REPO: 'Beezi-AI/internal' };
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '7');
  assert.equal(publish(fx, internal).code, 0);
  const before = destCommits(fx);
  const again = publish(fx, internal);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already up to date/);
  assert.deepEqual(destCommits(fx), before);
});

test('a variant built against a tunnel is refused', (t) => {
  const fx = sourceRepo(t);
  buildVariant(fx, 'dev', 'https://beezi-api-dev.azurewebsites.net/api', '1');
  const envFile = path.join(fx.src, 'dist', 'variant', 'plugins', 'beezi-dev', 'env.json');
  writeJson(envFile, { name: 'dev', apiBase: 'https://abc123.ngrok.io/api' });
  const res = publish(fx, { VARIANT_DIR: 'dist/variant', PUBLIC_REPO: 'Beezi-AI/beezi-cursor-plugin', GITHUB_REPO: 'Beezi-AI/internal' });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /ngrok|non-production/);
});

// ── the pipeline that calls all of this ───────────────────────────────────────────────────────
//
// Azure itself is an external gate: the variable group, the PATs and the branch policies are
// operator-provided and cannot be exercised here. What CAN be checked is the YAML's own logic,
// and it is worth checking, because every mistake in it is discovered in production by definition
// — the first time the file runs is the first time it publishes.

const PIPELINE = path.join(REPO_ROOT, 'azure-pipelines.yml');
const pipeline = () => fs.readFileSync(PIPELINE, 'utf-8');

test('Publish cannot run before Test, and never for a pull request', () => {
  const body = pipeline();
  assert.match(body, /- stage: Publish[\s\S]*?dependsOn: Test/);
  // A PR build reaching a stage that holds a `contents: write` PAT is an unreviewed branch with a
  // publish credential. `pr: none` alone does not do this for an ADO-hosted repository.
  assert.match(body, /ne\(variables\['Build\.Reason'\], 'PullRequest'\)/);
  assert.match(body, /^pr: none$/m);
});

test('main does not trigger the pipeline and never publishes', () => {
  const body = pipeline();
  // The trigger list is exactly the three release branches. main was removed deliberately: it is
  // not a release branch and it never published, so the only thing it ever did here was spend six
  // agents per push. Note the consequence — pushes to main now run NO pipeline, and a pull request
  // into main is gated only by a branch policy configured outside this file.
  const triggerList = body.split('trigger:')[1].split('pr:')[0];
  const triggered = [...triggerList.matchAll(/^\s*- ([a-z]+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(triggered.sort(), ['dev', 'prod', 'staging']);
  assert.equal(triggered.includes('main'), false, 'main is not a release branch');
  const publishStage = body.split('- stage: Publish')[1];
  // The FULL ref, and this pattern is the assertion (C2). `Build.SourceBranchName` is the last path
  // SEGMENT, so `release/prod` satisfied `eq(..., 'prod')` and reached a step holding a publish PAT;
  // matching `refs/heads/<branch>` is what makes each gate name exactly one branch.
  const branches = [...publishStage.matchAll(/Build\.SourceBranch'\], 'refs\/heads\/([a-z]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(branches.sort(), ['dev', 'prod', 'staging']);
  assert.equal(branches.includes('main'), false);
  // And the segment-only form is gone entirely, not merely outnumbered.
  assert.equal(
    /Build\.SourceBranchName/.test(publishStage),
    false,
    'a publish gate still matches the last path segment, which a branch name can collide with',
  );
});

test('prod publishes the public snapshot; dev and staging merge into the internal marketplace', () => {
  const publishStage = pipeline().split('- stage: Publish')[1];
  const prodStep = publishStage.split('- script: bash scripts/sync-to-github.sh')[1].split('- script: |')[0];
  assert.match(prodStep, /eq\(variables\['Build\.SourceBranch'\], 'refs\/heads\/prod'\)/);
  assert.equal(/VARIANT_DIR/.test(prodStep), false, 'prod must be a snapshot, not a variant merge');
  assert.match(prodStep, /GITHUB_REPO: \$\(GITHUB_REPO\)$/m, 'prod must target the PUBLIC repository');
  assert.equal(/GITHUB_REPO_INTERNAL/.test(prodStep), false);

  for (const env of ['dev', 'staging']) {
    // Up to the next step, not up to `displayName` — the `env:` block that maps the PAT comes
    // after both displayName and condition.
    const step = publishStage.split(`make-variant.sh ${env}`)[1].split('- script:')[0];
    assert.match(step, /VARIANT_DIR=dist\/variant/);
    // The slugs are macro-expanded in the body on purpose: non-secret group variables ARE
    // auto-exported, so a same-named `env:` remap would lose to the auto-export and the variant
    // would publish to the PUBLIC repository.
    assert.match(step, /GITHUB_REPO='\$\(GITHUB_REPO_INTERNAL\)'/);
    // PUBLIC_REPO is what makes sync-to-github.sh refuse when the two slugs are swapped.
    assert.match(step, /PUBLIC_REPO='\$\(GITHUB_REPO\)'/);
    // The PAT is NOT macro-expanded into the script text. A secret variable is not auto-exported,
    // and mapping it through `env:` is what keeps it out of the generated command line — which is
    // the one place masking cannot reliably reach.
    assert.equal(/GITHUB_PAT='\$\(/.test(step), false, 'the PAT is expanded into the script text');
    assert.match(step, /env:\s*\n\s*GITHUB_PAT: \$\(GITHUB_PAT_INTERNAL\)/);
  }
});

test('the pipeline defines the approved dev and staging API bases', () => {
  const body = pipeline();
  assert.match(body, /- group: beezi-cursor-plugin-release/);
  assert.match(body, /name: API_BASE_DEV\s+value: 'https:\/\/beezi-api-dev\.azurewebsites\.net\/api'/);
  assert.match(body, /name: API_BASE_STAGING\s+value: 'https:\/\/beezi-api-staging\.azurewebsites\.net\/api'/);
  assert.match(body, /make-variant\.sh dev '\$\(API_BASE_DEV\)'/);
  assert.match(body, /make-variant\.sh staging '\$\(API_BASE_STAGING\)'/);
});

test('the test stage runs Node 18 on both operating systems plus a real 13.2 floor job', () => {
  const body = pipeline();
  // Both operating systems, always. The credential backend, the CRLF launcher bodies, atomic
  // replacement and the chmod calls all branch on Windows, and every one of them decides whether
  // analytics reach the server. A matrix that quietly lost its Windows row would still be green.
  for (const os of ['windows', 'ubuntu']) {
    assert.match(body, new RegExp(`${os}_18:`), `${os} / node 18 is not in the matrix`);
  }
  // 18 is the lowest version with a built-in `node --test`, so it is the floor this harness can
  // exercise at all. It is NOT the declared engine floor — that is 13.2, proven by the job below.
  //
  // The matrix was deliberately cut from six rows to these two. The cost is real and is asserted
  // rather than left to a reader: node:sqlite arrives in 22.5, so with 18 as the only row NO job
  // has a real database, every test needing one skips itself, and only the `deps.sqlite = null`
  // degraded paths run. That caveat must stay written down next to the matrix — if someone widens
  // the matrix again, or deletes the warning without widening it, this assertion is what notices.
  assert.match(body, /real-sqlite paths are NOT covered/,
    'the matrix must keep stating which coverage it gave up');
  // A `13.x` spec resolves to 13.14 and would quietly prove a floor two minor versions above the
  // one package.json declares.
  assert.match(body, /versionSpec: '13\.2\.0'/);
  assert.match(body, /node scripts\/check-node-floor\.mjs/);
});

test('the publish config selects exactly the plugins that exist', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.cursor-plugin', 'publish.json'), 'utf-8'));
  const dirs = fs.readdirSync(path.join(REPO_ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(Object.keys(config.plugins).sort(), dirs,
    'sync-to-github.sh aborts on either mismatch; catching it here is cheaper than in a release build');
  for (const name of dirs) assert.equal(typeof config.plugins[name].publish, 'boolean');
});

test('generated variants are ignored', () => {
  assert.match(fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf-8'), /^dist\/$/m);
});

test('the superseded GitHub workflow is either still explained or already gone', () => {
  // The Azure Test stage covers the same six combinations and more, so this workflow is redundant
  // — but it is the only CI that has ever actually run, and deleting it before the Azure stage has
  // gone green once would leave the repository with no executed CI at all.
  //
  // So the assertion is conditional by design: while the file exists it must SAY it is superseded
  // and under what condition it goes, and once the operator deletes it this test keeps passing
  // without needing an edit in the same commit.
  const workflow = path.join(REPO_ROOT, '.github', 'workflows', 'test.yml');
  if (!fs.existsSync(workflow)) return;
  const body = fs.readFileSync(workflow, 'utf-8');
  assert.match(body, /SUPERSEDED/, 'the retained workflow must say it is superseded');
  assert.match(body, /azure-pipelines\.yml/, 'it must name what supersedes it');
  assert.match(body, /green Azure Test stage/, 'it must name the condition for removing it');
});

// ── C3: the published root is an ALLOWLIST, not whatever survived the exclusions ────────────────

// Both halves of the filter were allow-by-default. `EXCLUDE_PATHS` names the internal trees one by
// one, and `verify_tree` re-checked that same list — so the verification could only ever catch a
// pathspec that had stopped working, never a path nobody had thought to exclude. A new top-level
// directory, or a new internal subtree under `docs/`, publishes the moment it is committed, and
// nothing in a diff of this script would say so.

test('a new top-level directory does not publish just because nobody excluded it', (t) => {
  const fx = sourceRepo(t);
  // The shape of the mistake: an internal tree added at the root by someone who never read the
  // publish filter. `.superpowers/` is the real one this repository already carries.
  writeText(path.join(fx.src, '.superpowers', 'sdd', 'progress.md'), 'internal controller ledger\n');
  writeText(path.join(fx.src, 'internal-notes', 'pricing.md'), 'do not publish\n');
  git(fx.src, ['add', '-A'], fx.home);
  git(fx.src, ['commit', '-q', '-m', 'fixture: an unexcluded internal tree'], fx.home);

  const res = publish(fx);
  assert.notEqual(res.code, 0, 'the publish must refuse a root path it was never told about');
  assert.match(`${res.stdout}${res.stderr}`, /verification failed/i);
  // And nothing was pushed: the refusal has to happen before the destination is touched.
  assert.equal(publishedFiles(fx), null);
});

test('a new internal subtree under docs/ does not publish either', (t) => {
  const fx = sourceRepo(t);
  writeText(path.join(fx.src, 'docs', 'internal-runbooks', 'oncall.md'), 'rotation and phone numbers\n');
  git(fx.src, ['add', '-A'], fx.home);
  git(fx.src, ['commit', '-q', '-m', 'fixture: a new docs subtree'], fx.home);

  const res = publish(fx);
  assert.notEqual(res.code, 0);
  assert.match(`${res.stdout}${res.stderr}`, /verification failed/i);
});

test('the allowlist names what it refuses, so the fix is obvious from the log', (t) => {
  const fx = sourceRepo(t);
  writeText(path.join(fx.src, 'internal-notes', 'pricing.md'), 'do not publish\n');
  git(fx.src, ['add', '-A'], fx.home);
  git(fx.src, ['commit', '-q', '-m', 'fixture: unexcluded'], fx.home);
  const res = publish(fx);
  assert.match(`${res.stdout}${res.stderr}`, /internal-notes/, 'the offending path is not named');
});

test('the publish that ships today is unchanged by the allowlist', (t) => {
  // The other side of the same assertion. An allowlist that refuses the current tree is a broken
  // release, not a safe one, so the exact root-level set the fixture publishes is pinned here.
  const fx = sourceRepo(t);
  const res = publish(fx);
  assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  const files = publishedFiles(fx);
  const roots = [...new Set(files.map((f) => (f.includes('/') ? `${f.split('/')[0]}/` : f)))].sort();
  // The fixture's root has no README.md of its own — the only README it carries is the plugin's.
  // This is the fixture's published set, not this repository's; the real one is confirmed by the
  // dry run in the release checklist.
  assert.deepEqual(roots, [
    '.cursor-plugin/',
    'CONTRIBUTING.md',
    'docs/',
    'plugins/',
  ]);
});
