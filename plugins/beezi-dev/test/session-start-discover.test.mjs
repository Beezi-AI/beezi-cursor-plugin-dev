import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepos } from '../lib/session-start.mjs';
import { normPath, findRepoRootByWalk } from '../lib/repo-map.mjs';

// Direct regression coverage for repo discovery — the sessionStart step that seeds the persisted
// repo map so later checkpoints can attribute a segment even when the git binary is blocked.
// It had none: every assertion about it was incidental, inside tests about something else, which
// is what leaves map repair vulnerable the next time session-start's policy is touched.
//
// `discoverRepos(cwd, gitImpl, map, deps)` is already exported and already takes an injected
// `gitImpl`, so no seam had to be opened. `deps.fs` only covers the readdir/exists calls INSIDE
// discoverRepos, though: resolveRepoRoot → matchKnownRoot → hasGitEntry, findRepoRootByWalk and
// originFromGitConfig all reach the real `fs` module. So these fixtures are real directories in a
// real temp dir — a fake filesystem would simply not be consulted and the test would pass for the
// wrong reason.
//
// NOTHING HERE TOUCHES THE DEVELOPER'S OWN WORKSPACE. Every fixture lives under one mkdtemp root,
// no real `git` is ever spawned (gitImpl is injected in every call), and `repoMapFile()` is never
// written because discoverRepos only mutates the map object it is handed.

function fixtureRoot(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-discover-')));
  // The plugin's own home is redirected too. discoverRepos does not read it today, but a future
  // step in the same function might, and a test that would then start writing to the real
  // ~/.beezi-cursor is not a test anyone notices until it has already happened.
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = path.join(base, 'home');
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

// A normal checkout: a `.git` DIRECTORY, optionally with an origin in its config.
function makeRepo(dir, origin) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (origin) writeGitConfig(path.join(dir, '.git'), origin);
  return dir;
}

function writeGitConfig(gitDir, origin) {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    'utf-8',
  );
}

// A worktree or submodule checkout: `.git` is a FILE pointing at the real git dir.
function makeGitFile(dir, gitDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`, 'utf-8');
  return dir;
}

const emptyMap = () => ({ version: 1, roots: {} });

// A gitImpl that answers from a lookup table and records every directory it was asked about, so a
// test can prove discovery never wandered outside its fixture.
function fakeGit({ toplevel = {}, origins = {}, calls = [] } = {}) {
  const impl = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    const key = normPath(cwd);
    if (args[0] === 'rev-parse') {
      if (!(key in toplevel)) throw new Error('fatal: not a git repository');
      return toplevel[key];
    }
    if (args[0] === 'remote') {
      if (!(key in origins)) throw new Error("error: No such remote 'origin'");
      return origins[key];
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  impl.calls = calls;
  return impl;
}

const alwaysThrows = (calls) => {
  const impl = (args, cwd) => { calls.push({ args: args.join(' '), cwd }); throw new Error('git is not available'); };
  impl.calls = calls;
  return impl;
};

// ── the launch directory's own repo ────────────────────────────────────────────────────────────

test('the cwd repo is registered with its origin', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'solo'));
  const root = normPath(repo);
  const gitImpl = fakeGit({
    toplevel: { [root]: root },
    origins: { [root]: 'https://github.com/acme/solo.git' },
  });

  const map = emptyMap();
  const result = discoverRepos(repo, gitImpl, map);

  assert.equal(result.dirty, true, 'a newly learned root marks the map dirty so it gets saved');
  assert.deepEqual(Object.keys(map.roots), [root]);
  assert.equal(map.roots[root].origin, 'https://github.com/acme/solo.git');
  assert.ok(map.roots[root].detectedAt, 'the entry is stamped');
});

test('a subdirectory of a repo registers the ROOT, not the subdirectory', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'solo'));
  const sub = path.join(repo, 'packages', 'api');
  fs.mkdirSync(sub, { recursive: true });
  const root = normPath(repo);
  const gitImpl = fakeGit({
    toplevel: { [normPath(sub)]: root },
    origins: { [root]: 'git@github.com:acme/solo.git' },
  });

  const map = emptyMap();
  discoverRepos(sub, gitImpl, map);

  assert.deepEqual(Object.keys(map.roots), [root]);
  assert.equal(map.roots[root].origin, 'git@github.com:acme/solo.git');
});

test('an origin with embedded credentials is stripped before it is persisted', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'solo'));
  const root = normPath(repo);
  const gitImpl = fakeGit({
    toplevel: { [root]: root },
    origins: { [root]: 'https://user:s3cret@github.com/acme/solo.git' },
  });

  const map = emptyMap();
  discoverRepos(repo, gitImpl, map);

  assert.equal(map.roots[root].origin, 'https://github.com/acme/solo.git');
});

// ── multi-root workspace prewarm ───────────────────────────────────────────────────────────────

test('a workspace folder that is not itself a repo prewarms each immediate child repo', (t) => {
  const base = fixtureRoot(t);
  const ws = path.join(base, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const repoA = makeRepo(path.join(ws, 'alpha'));
  const repoB = makeRepo(path.join(ws, 'beta'));
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });        // a plain folder
  fs.writeFileSync(path.join(ws, 'README.md'), '# ws\n', 'utf-8');  // a plain file
  // A repo one level deeper than the scan: discovery is deliberately shallow.
  makeRepo(path.join(ws, 'notes', 'nested'));

  assert.equal(
    findRepoRootByWalk(ws), null,
    'precondition: no ancestor of the temp fixture is itself a git checkout',
  );

  const gitImpl = fakeGit({
    toplevel: { [normPath(repoA)]: normPath(repoA), [normPath(repoB)]: normPath(repoB) },
    origins: { [normPath(repoA)]: 'https://github.com/acme/alpha.git' },
  });

  const map = emptyMap();
  const result = discoverRepos(ws, gitImpl, map);

  assert.equal(result.dirty, true);
  assert.deepEqual(Object.keys(map.roots).sort(), [normPath(repoA), normPath(repoB)].sort());
  assert.equal(map.roots[normPath(repoA)].origin, 'https://github.com/acme/alpha.git');
  assert.equal(map.roots[normPath(repoB)].origin, null, 'a checkout with no origin is still mapped');
});

test('non-repo folders, plain files and deeper nesting are ignored by the prewarm', (t) => {
  const base = fixtureRoot(t);
  const ws = path.join(base, 'workspace');
  fs.mkdirSync(path.join(ws, 'notes', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'notes', 'nested', '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'plain.txt'), 'x', 'utf-8');

  const gitImpl = fakeGit({});
  const map = emptyMap();
  const result = discoverRepos(ws, gitImpl, map);

  assert.deepEqual(map.roots, {}, 'nothing at the scanned depth is a repo');
  assert.equal(result.dirty, false, 'a scan that learns nothing must not force a map write');
});

// CURRENT BEHAVIOUR, pinned so a change is a decision rather than a surprise: the two paths are
// mutually exclusive. When the launch directory resolves to a repo, its children are NOT scanned —
// so a monorepo container that is itself a checkout does not prewarm the repos inside it. See the
// handoff for the proposed seam; this test states what ships today.
test('a cwd that is itself a repo does not additionally prewarm its child repos', (t) => {
  const base = fixtureRoot(t);
  const outer = makeRepo(path.join(base, 'outer'));
  makeRepo(path.join(outer, 'inner'));
  const root = normPath(outer);
  const gitImpl = fakeGit({ toplevel: { [root]: root }, origins: { [root]: 'https://h/o.git' } });

  const map = emptyMap();
  discoverRepos(outer, gitImpl, map);

  assert.deepEqual(Object.keys(map.roots), [root]);
  assert.ok(!(normPath(path.join(outer, 'inner')) in map.roots));
});

// ── worktrees and submodules ───────────────────────────────────────────────────────────────────

test('a linked worktree is registered under its own root, with the shared origin', (t) => {
  const base = fixtureRoot(t);
  const main = makeRepo(path.join(base, 'main'), 'https://github.com/acme/main.git');
  const wtGitDir = path.join(main, '.git', 'worktrees', 'feature');
  fs.mkdirSync(wtGitDir, { recursive: true });
  // A worktree's own git dir has no origin; `commondir` points at the shared one.
  fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf-8');
  const worktree = makeGitFile(path.join(base, 'feature-wt'), wtGitDir);

  // git itself is unavailable — the .git-FILE path has to work without it.
  const gitImpl = alwaysThrows([]);
  const map = emptyMap();
  discoverRepos(worktree, gitImpl, map);

  const root = normPath(worktree);
  assert.deepEqual(Object.keys(map.roots), [root], 'a `.git` file counts as a checkout root');
  assert.equal(map.roots[root].origin, 'https://github.com/acme/main.git');
});

test('a submodule is registered under its own root, with the submodule\'s own origin', (t) => {
  const base = fixtureRoot(t);
  const superRepo = makeRepo(path.join(base, 'super'), 'https://github.com/acme/super.git');
  const moduleGitDir = path.join(superRepo, '.git', 'modules', 'vendor');
  writeGitConfig(moduleGitDir, 'https://github.com/acme/vendor.git');
  const submodule = makeGitFile(path.join(superRepo, 'vendor'), moduleGitDir);

  const gitImpl = alwaysThrows([]);
  const map = emptyMap();
  discoverRepos(submodule, gitImpl, map);

  const root = normPath(submodule);
  assert.equal(map.roots[root].origin, 'https://github.com/acme/vendor.git',
    'a submodule reports its own remote, not the superproject\'s');
});

// ── failure tolerance ──────────────────────────────────────────────────────────────────────────

test('a git failure is tolerated: the root is still mapped, with the origin read off disk', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'blocked'), 'https://github.com/acme/blocked.git');
  const calls = [];
  const gitImpl = alwaysThrows(calls);

  const map = emptyMap();
  const result = discoverRepos(repo, gitImpl, map);

  assert.ok(calls.length > 0, 'git was attempted first — the fallbacks are fallbacks');
  assert.equal(result.dirty, true);
  assert.equal(
    map.roots[normPath(repo)].origin,
    'https://github.com/acme/blocked.git',
    'a blocked git binary (dubious ownership, PATH, timeout) must not cost the mapping',
  );
});

test('a git failure with no readable config maps the root with a null origin', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'noconfig'));
  const map = emptyMap();
  discoverRepos(repo, alwaysThrows([]), map);
  assert.equal(map.roots[normPath(repo)].origin, null);
});

test('an unreadable workspace directory is tolerated and learns nothing', (t) => {
  const base = fixtureRoot(t);
  const ws = path.join(base, 'workspace');
  fs.mkdirSync(ws, { recursive: true });

  const map = emptyMap();
  const result = discoverRepos(ws, alwaysThrows([]), map, {
    fs: {
      readdirSync: () => { throw new Error('EACCES'); },
      existsSync: () => { throw new Error('EACCES'); },
    },
  });

  assert.deepEqual(map.roots, {});
  assert.equal(result.dirty, false);
});

test('no cwd at all is a no-op', (t) => {
  fixtureRoot(t);
  for (const cwd of [null, undefined, '']) {
    const map = emptyMap();
    const calls = [];
    const result = discoverRepos(cwd, alwaysThrows(calls), map);
    assert.deepEqual(map.roots, {});
    assert.equal(result.dirty, false);
    assert.deepEqual(calls, [], 'no git process is spawned for a session with no directory');
  }
});

// ── the map is a seed, not a scratch space ─────────────────────────────────────────────────────

test('existing map entries survive discovery untouched', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'solo'));
  const root = normPath(repo);
  const gitImpl = fakeGit({ toplevel: { [root]: root }, origins: { [root]: 'https://h/solo.git' } });

  const kept = { origin: 'https://github.com/acme/elsewhere.git', detectedAt: '2020-01-01T00:00:00.000Z' };
  const map = { version: 1, roots: { '/somewhere/else': { ...kept } } };

  discoverRepos(repo, gitImpl, map);

  assert.deepEqual(map.roots['/somewhere/else'], kept, 'discovery never prunes or rewrites');
  assert.equal(map.roots[root].origin, 'https://h/solo.git');
});

test('rediscovering a known root refreshes it in place rather than duplicating it', (t) => {
  const base = fixtureRoot(t);
  const repo = makeRepo(path.join(base, 'solo'));
  const root = normPath(repo);
  const gitImpl = fakeGit({ toplevel: { [root]: root }, origins: { [root]: 'https://h/solo.git' } });

  const map = { version: 1, roots: { [root]: { origin: null, detectedAt: '2020-01-01T00:00:00.000Z' } } };
  discoverRepos(repo, gitImpl, map);

  assert.deepEqual(Object.keys(map.roots), [root], 'one entry per root');
  assert.equal(map.roots[root].origin, 'https://h/solo.git', 'a learned origin replaces a null one');
});

// ── containment ────────────────────────────────────────────────────────────────────────────────

test('discovery never asks git about a directory outside the workspace it was given', (t) => {
  const base = fixtureRoot(t);
  const ws = path.join(base, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const repoA = makeRepo(path.join(ws, 'alpha'));
  makeRepo(path.join(ws, 'beta'));
  const calls = [];
  const gitImpl = fakeGit({ toplevel: { [normPath(repoA)]: normPath(repoA) }, calls });

  discoverRepos(ws, gitImpl, emptyMap());

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(
      normPath(call.cwd).startsWith(normPath(base)),
      `git was asked about ${call.cwd}, which is outside the fixture`,
    );
  }
});
