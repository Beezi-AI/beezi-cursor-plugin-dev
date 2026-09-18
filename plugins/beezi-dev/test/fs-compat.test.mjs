import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeSync } from '../lib/fs-compat.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-fs-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('removes a file', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'x');

  removeSync(file, { force: true });

  assert.equal(fs.existsSync(file), false);
});

test('removes a directory tree with recursive', (t) => {
  const dir = tmpDir(t);
  const nested = path.join(dir, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'x.txt'), 'x');

  removeSync(path.join(dir, 'a'), { recursive: true, force: true });

  assert.equal(fs.existsSync(path.join(dir, 'a')), false);
});

test('force swallows a missing target; without force it throws', (t) => {
  const dir = tmpDir(t);
  const missing = path.join(dir, 'nope');

  removeSync(missing, { force: true }); // must not throw
  assert.throws(() => removeSync(missing), /ENOENT/);
});

// The pre-14.14 branch is what the shim exists for — exercise it directly by hiding rmSync,
// exactly the way a Node 13 runtime presents fs.
test('the fallback branch removes files and trees without rmSync', (t) => {
  const dir = tmpDir(t);
  const nested = path.join(dir, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'x.txt'), 'x');
  const real = fs.rmSync;
  fs.rmSync = undefined;
  try {
    removeSync(path.join(dir, 'a'), { recursive: true, force: true });
    removeSync(path.join(dir, 'missing'), { force: true });
  } finally {
    // Restored inline, not via t.after: after-hooks run in registration order, so tmpDir's
    // rmSync cleanup would fire while the global is still hidden.
    fs.rmSync = real;
  }

  assert.equal(fs.existsSync(path.join(dir, 'a')), false);
});
