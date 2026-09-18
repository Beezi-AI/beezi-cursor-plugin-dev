import { toFilesystemPath } from '../lib/hook-cwd.mjs';
import { test } from 'node:test';

// Cursor builds workspace_roots from `uri.path`, never `uri.fsPath`, so a Windows workspace arrives
// as `/c:/Users/you/project`. Spawning git with that as cwd fails outright — the segment then has
// no repository, and is dropped. The timeline has no git dependency and kept being reported, which
// is what made this look like "only the timeline is tracked".
test('a Windows URI path becomes a usable filesystem path', () => {
  assert.equal(toFilesystemPath('/c:/Users/you/project'), 'c:/Users/you/project');
  assert.equal(toFilesystemPath('/C:/Users/you/project'), 'C:/Users/you/project');
  assert.equal(toFilesystemPath('/c:'), 'c:');
});

test('a file:// URI is unwrapped, on either platform', () => {
  assert.equal(toFilesystemPath('file:///c:/Users/you/project'), 'c:/Users/you/project');
  assert.equal(toFilesystemPath('file:///home/you/project'), '/home/you/project');
});

test('percent-escapes are decoded only for values that were URIs', () => {
  assert.equal(toFilesystemPath('/c:/Users/you/My%20Repo'), 'c:/Users/you/My Repo');
  // A plain Windows path is not a URI, so a literal % in a directory name must survive.
  assert.equal(toFilesystemPath('C:\\Users\\you\\100%25'), 'C:\\Users\\you\\100%25');
});

test('real filesystem paths are returned untouched', () => {
  assert.equal(toFilesystemPath('C:\\Users\\you\\project'), 'C:\\Users\\you\\project');
  assert.equal(toFilesystemPath('C:/Users/you/project'), 'C:/Users/you/project');
  assert.equal(toFilesystemPath('/home/you/project'), '/home/you/project');
  // A POSIX root that merely starts with a slash and a letter is not a drive letter.
  assert.equal(toFilesystemPath('/c/Users/you'), '/c/Users/you');
});

test('nothing usable is null, not an empty string', () => {
  assert.equal(toFilesystemPath(''), null);
  assert.equal(toFilesystemPath('   '), null);
  assert.equal(toFilesystemPath(undefined), null);
  assert.equal(toFilesystemPath(null), null);
  assert.equal(toFilesystemPath(42), null);
});

import assert from 'node:assert/strict';
import { PROJECT_DIR_VARS, enterProjectDir, projectDir } from '../lib/hook-cwd.mjs';

function spy() {
  const calls = [];
  return { calls, fn: (dir) => calls.push(dir) };
}

const ALWAYS = () => true;

test('Cursor names the workspace folder CURSOR_PROJECT_DIR, with the Claude spelling as backup', () => {
  assert.deepEqual([...PROJECT_DIR_VARS], ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']);
  assert.equal(projectDir({ CURSOR_PROJECT_DIR: '/work/repo' }), '/work/repo');
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: '/work/repo' }), '/work/repo');
  assert.equal(projectDir({ CURSOR_PROJECT_DIR: '/a', CLAUDE_PROJECT_DIR: '/b' }), '/a');
});

test('the hook moves to the workspace folder Cursor named', () => {
  const chdir = spy();
  const moved = enterProjectDir({ env: { CURSOR_PROJECT_DIR: '/work/repo' }, chdir: chdir.fn, exists: ALWAYS });
  assert.equal(moved, '/work/repo');
  assert.deepEqual(chdir.calls, ['/work/repo']);
});

test('a window with no folder open is a normal state, not a failure', () => {
  const chdir = spy();
  // Cursor sets the variable to the empty string when the workspace has no folders.
  assert.equal(enterProjectDir({ env: { CURSOR_PROJECT_DIR: '' }, chdir: chdir.fn, exists: ALWAYS }), null);
  assert.equal(enterProjectDir({ env: {}, chdir: chdir.fn, exists: ALWAYS }), null);
  assert.deepEqual(chdir.calls, []);
});

test('a directory that no longer exists is left alone rather than chdir-ed into', () => {
  const chdir = spy();
  const moved = enterProjectDir({ env: { CURSOR_PROJECT_DIR: '/gone' }, chdir: chdir.fn, exists: () => false });
  assert.equal(moved, null);
  assert.deepEqual(chdir.calls, []);
});

test('a chdir that throws does not take the hook down', () => {
  // The hook still has an event to record; failing to move is not a reason to lose it.
  const moved = enterProjectDir({
    env: { CURSOR_PROJECT_DIR: '/denied' },
    chdir: () => { throw new Error('EACCES'); },
    exists: ALWAYS,
  });
  assert.equal(moved, null);
});
