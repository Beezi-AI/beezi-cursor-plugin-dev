import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRules,
  RULES_MAX_DEPTH,
  RULES_MAX_FILES,
  RULES_MAX_BYTES,
} from '../lib/rules-cursor.mjs';

// UX-06 / DATA-03: how big are this repository's standing instructions.
//
// The claim this reader is allowed to make is narrow on purpose. It counts LINES IN FILES THAT EXIST
// ON DISK NOW. It is not evidence that those instructions were in any prompt, it is not token usage,
// and a file discovered is not a file applied — which is why `discovered` and `alwaysApplied` are
// two different numbers and only the second one is a candidate for emission.

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const mdc = (always, body) => `---\nalwaysApply: ${always}\ndescription: a rule\n---\n${body}`;

// ---------------------------------------------------------------------------
// Absent, present-empty, and the difference between them
// ---------------------------------------------------------------------------

test('a repository with no rules at all reports nothing, not zero', (t) => {
  assert.equal(readRules(tmpRoot(t)), null);
});

test('an unusable root is absent rather than an error', () => {
  for (const root of [null, undefined, '', 42, {}]) assert.equal(readRules(root), null);
  assert.equal(readRules(path.join(os.tmpdir(), 'beezi-rules-does-not-exist-9e1')), null);
});

test('a file that exists and is empty is a zero, which is not the same as absent', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', '');
  const rules = readRules(root);
  assert.equal(rules.discovered.sources, 1);
  assert.equal(rules.discovered.lines, 0);
  assert.equal(rules.complete, true);
});

// ---------------------------------------------------------------------------
// Line counting
// ---------------------------------------------------------------------------

test('lines are counted the way an editor shows them', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'one\ntwo\nthree\n');
  assert.equal(readRules(root).discovered.lines, 3, 'one trailing newline terminates the last line');
});

test('a file with no trailing newline counts its last line', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'one\ntwo');
  assert.equal(readRules(root).discovered.lines, 2);
});

test('a second trailing newline is a real empty line', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'one\n\n');
  assert.equal(readRules(root).discovered.lines, 2);
});

test('CRLF files count the same as LF files', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'one\r\ntwo\r\n');
  assert.equal(readRules(root).discovered.lines, 2);
});

// ---------------------------------------------------------------------------
// The three source kinds
// ---------------------------------------------------------------------------

test('AGENTS.md, .cursorrules and .cursor/rules/*.mdc are all discovered', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'a\nb\n');
  write(root, '.cursorrules', 'c\n');
  write(root, '.cursor/rules/style.mdc', mdc('false', 'd\ne\n'));
  const rules = readRules(root);
  assert.equal(rules.discovered.sources, 3);
  assert.equal(rules.discovered.lines, 2 + 1 + 2);
  assert.equal(rules.bySource.agents.sources, 1);
  assert.equal(rules.bySource.cursorrules.sources, 1);
  assert.equal(rules.bySource.mdc.sources, 1);
});

test('only an explicit boolean alwaysApply: true joins the always-applied subset', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/always.mdc', mdc('true', 'x\ny\n'));
  write(root, '.cursor/rules/never.mdc', mdc('false', 'z\n'));
  const rules = readRules(root);
  assert.equal(rules.discovered.sources, 2);
  assert.equal(rules.alwaysApplied.sources, 1);
  assert.equal(rules.alwaysApplied.lines, 2);
});

test('a quoted, capitalised, missing or malformed alwaysApply does not qualify', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/a.mdc', '---\nalwaysApply: "true"\n---\nbody\n');
  write(root, '.cursor/rules/b.mdc', '---\nalwaysApply: True\n---\nbody\n');
  write(root, '.cursor/rules/c.mdc', '---\nalwaysApply: yes\n---\nbody\n');
  write(root, '.cursor/rules/d.mdc', '---\ndescription: none\n---\nbody\n');
  write(root, '.cursor/rules/e.mdc', 'alwaysApply: true\nbody\n');
  write(root, '.cursor/rules/f.mdc', '---\nalwaysApply: true\nbody with no closing fence\n');
  write(root, '.cursor/rules/g.mdc', '---\nalwaysApply:true\n---\nbody\n');
  const rules = readRules(root);
  assert.equal(rules.discovered.sources, 7);
  assert.equal(rules.alwaysApplied.sources, 0);
  assert.equal(rules.alwaysApplied.lines, 0);
});

test('alwaysApply: true with extra surrounding space still qualifies', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/a.mdc', '---\n  alwaysApply:   true  \n---\nbody\n');
  assert.equal(readRules(root).alwaysApplied.sources, 1);
});

test('the frontmatter is not part of the body count', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/a.mdc', mdc('true', 'one\ntwo\nthree\n'));
  const rules = readRules(root);
  assert.equal(rules.alwaysApplied.lines, 3, 'four frontmatter lines are metadata, not instructions');
  assert.equal(rules.discovered.lines, 3);
});

test('an .mdc whose body is empty is a source with zero lines', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/a.mdc', mdc('true', ''));
  const rules = readRules(root);
  assert.equal(rules.alwaysApplied.sources, 1);
  assert.equal(rules.alwaysApplied.lines, 0);
});

test('nested rule directories are walked', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/a.mdc', mdc('true', 'x\n'));
  write(root, '.cursor/rules/team/b.mdc', mdc('true', 'y\n'));
  write(root, '.cursor/rules/team/web/c.mdc', mdc('true', 'z\n'));
  assert.equal(readRules(root).alwaysApplied.sources, 3);
});

test('a non-.mdc file in the rules directory is not a rule', (t) => {
  const root = tmpRoot(t);
  write(root, '.cursor/rules/notes.md', 'x\n');
  write(root, '.cursor/rules/a.mdc', mdc('false', 'y\n'));
  assert.equal(readRules(root).discovered.sources, 1);
});

test('AGENTS.md and .cursorrules are discovered but never counted as always applied', (t) => {
  // Cursor's own precedence for these two is not established by any fixture this plugin has, and an
  // always-applied metric is a claim about what reached the model. Discovered is what is known.
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'a\n');
  write(root, '.cursorrules', 'b\n');
  const rules = readRules(root);
  assert.equal(rules.discovered.sources, 2);
  assert.equal(rules.alwaysApplied.sources, 0);
  assert.equal(rules.alwaysApplied.lines, 0);
});

// ---------------------------------------------------------------------------
// Bounds, at their exact boundaries
// ---------------------------------------------------------------------------

test('the bounds are the documented constants', () => {
  assert.equal(RULES_MAX_DEPTH, 3);
  assert.equal(RULES_MAX_FILES, 100);
  assert.equal(RULES_MAX_BYTES, 1048576);
});

test('a rule exactly at the depth limit is read, one below it is not', (t) => {
  const root = tmpRoot(t);
  const atLimit = `.cursor/rules/${['a', 'b', 'c'].slice(0, RULES_MAX_DEPTH).join('/')}/deep.mdc`;
  write(root, atLimit, mdc('true', 'x\n'));
  const ok = readRules(root);
  assert.equal(ok.alwaysApplied.sources, 1);
  assert.equal(ok.complete, true);

  write(root, `${path.dirname(atLimit)}/d/too-deep.mdc`, mdc('true', 'y\n'));
  const capped = readRules(root);
  assert.equal(capped.alwaysApplied.sources, 1, 'the file below the limit is not read');
  assert.equal(capped.complete, false);
  assert.equal(capped.reason, 'max-depth');
});

test('the file cap is inclusive, and exceeding it reports incomplete rather than a truncated total', (t) => {
  const root = tmpRoot(t);
  for (let i = 0; i < RULES_MAX_FILES; i++) write(root, `.cursor/rules/r${i}.mdc`, mdc('true', 'x\n'));
  const exact = readRules(root);
  assert.equal(exact.discovered.sources, RULES_MAX_FILES);
  assert.equal(exact.complete, true);

  write(root, `.cursor/rules/r${RULES_MAX_FILES}.mdc`, mdc('true', 'x\n'));
  const over = readRules(root);
  assert.equal(over.discovered.sources, RULES_MAX_FILES);
  assert.equal(over.complete, false);
  assert.equal(over.reason, 'max-files');
});

test('the byte cap is inclusive, and the file that would cross it is not read', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'x'.repeat(RULES_MAX_BYTES));
  const exact = readRules(root);
  assert.equal(exact.complete, true);
  assert.equal(exact.discovered.sources, 1);

  write(root, '.cursorrules', 'y');
  const over = readRules(root);
  assert.equal(over.complete, false);
  assert.equal(over.reason, 'max-bytes');
  assert.equal(over.discovered.sources, 1, 'the crossing file contributes nothing at all');
});

// ---------------------------------------------------------------------------
// Symlinks, escapes and unreadable files — injected, because a Windows test cannot make a symlink
// ---------------------------------------------------------------------------

function fakeFs(tree) {
  // tree: { 'rel/path': { content } | { dir: true } | { link: true } | { unreadable: true } }
  const norm = (p) => p.split(path.sep).join('/');
  const rel = (root, p) => norm(path.relative(root, p)).replace(/^\.\//, '');
  const root = path.resolve('/repo');
  const entry = (p) => tree[rel(root, p)];
  return {
    root,
    fsImpl: {
      readdirSync(dir) {
        const prefix = rel(root, dir) === '' ? '' : `${rel(root, dir)}/`;
        const names = new Set();
        for (const key of Object.keys(tree)) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest === '') continue;
          names.add(rest.split('/')[0]);
        }
        if (names.size === 0 && entry(dir) === undefined) throw new Error('ENOENT');
        return [...names].map((name) => {
          const record = tree[`${prefix}${name}`];
          return {
            name,
            isDirectory: () => record === undefined || record.dir === true,
            isFile: () => record !== undefined && record.dir !== true && record.link !== true,
            isSymbolicLink: () => record !== undefined && record.link === true,
          };
        });
      },
      lstatSync(p) {
        const record = entry(p);
        if (record === undefined) throw new Error('ENOENT');
        return {
          size: record.content == null ? 0 : Buffer.byteLength(record.content, 'utf-8'),
          isFile: () => record.dir !== true && record.link !== true,
          isDirectory: () => record.dir === true,
          isSymbolicLink: () => record.link === true,
        };
      },
      readFileSync(p) {
        const record = entry(p);
        if (record === undefined || record.unreadable) throw new Error('EACCES');
        return record.content == null ? '' : record.content;
      },
    },
  };
}

test('a symlinked rule file is not followed, and the result says so', () => {
  const { root, fsImpl } = fakeFs({
    'AGENTS.md': { content: 'a\n' },
    '.cursor': { dir: true },
    '.cursor/rules': { dir: true },
    '.cursor/rules/linked.mdc': { link: true },
  });
  const rules = readRules(root, { fsImpl });
  assert.equal(rules.discovered.sources, 1);
  assert.equal(rules.complete, false);
  assert.equal(rules.reason, 'symlink');
});

test('a symlinked rules DIRECTORY is not walked, and that is not the same as absent', () => {
  const { root, fsImpl } = fakeFs({
    '.cursor': { dir: true },
    '.cursor/rules': { dir: true },
    '.cursor/rules/team': { link: true },
    '.cursor/rules/team/a.mdc': { content: 'x\n' },
  });
  const rules = readRules(root, { fsImpl });
  // Zero sources AND a reason: something was there and none of it could be read. Reporting `null`
  // here would make an unwalkable rules directory indistinguishable from a repository that has no
  // rules at all, and only one of those is a fact about the project.
  assert.equal(rules.discovered.sources, 0);
  assert.equal(rules.discovered.lines, 0);
  assert.equal(rules.alwaysApplied.sources, 0);
  assert.equal(rules.complete, false);
  assert.equal(rules.reason, 'symlink');
});

test('a directory entry that would escape the root is refused before it is read', () => {
  // Defence in depth: the walk never follows a link, so an entry naming its way out of the root
  // takes a host bug or a hostile checkout to produce — which is exactly when a cheap prefix check
  // on the resolved path earns its keep.
  const base = path.resolve('/repo');
  const rulesDir = path.join(base, '.cursor', 'rules');
  let read = 0;
  const fsImpl = {
    readdirSync(dir) {
      if (dir !== rulesDir) throw new Error('ENOENT');
      return [{
        name: `..${path.sep}..${path.sep}..${path.sep}evil.mdc`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      }];
    },
    lstatSync() { throw new Error('ENOENT'); },
    readFileSync() { read += 1; return 'pwned\n'; },
  };
  const rules = readRules(base, { fsImpl });
  assert.equal(read, 0, 'the escaping path must never reach a read');
  assert.equal(rules.discovered.sources, 0);
  assert.equal(rules.complete, false);
  assert.equal(rules.reason, 'escaped-path');
});

test('a symlinked AGENTS.md is skipped rather than read through', () => {
  const { root, fsImpl } = fakeFs({
    'AGENTS.md': { link: true },
    '.cursorrules': { content: 'b\n' },
  });
  const rules = readRules(root, { fsImpl });
  assert.equal(rules.discovered.sources, 1);
  assert.equal(rules.complete, false);
  assert.equal(rules.reason, 'symlink');
});

test('an unreadable file is an incomplete observation, never a zero', () => {
  const { root, fsImpl } = fakeFs({
    'AGENTS.md': { content: 'a\nb\n' },
    '.cursorrules': { unreadable: true, content: 'x' },
  });
  const rules = readRules(root, { fsImpl });
  assert.equal(rules.discovered.lines, 2);
  assert.equal(rules.discovered.sources, 1);
  assert.equal(rules.complete, false);
  assert.equal(rules.reason, 'unreadable');
});

test('two roots are two answers — nothing is cached across them', (t) => {
  const a = tmpRoot(t);
  const b = tmpRoot(t);
  write(a, 'AGENTS.md', 'one\ntwo\n');
  write(b, 'AGENTS.md', 'one\n');
  assert.equal(readRules(a).discovered.lines, 2);
  assert.equal(readRules(b).discovered.lines, 1);
  assert.equal(readRules(a).discovered.lines, 2);
});

test('an edit between two reads is seen — this is a snapshot, not a memory', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'one\n');
  assert.equal(readRules(root).discovered.lines, 1);
  write(root, 'AGENTS.md', 'one\ntwo\nthree\n');
  assert.equal(readRules(root).discovered.lines, 3);
});

test('no file content and no absolute path is anywhere in the result', (t) => {
  const root = tmpRoot(t);
  write(root, 'AGENTS.md', 'SECRET INSTRUCTION\n');
  write(root, '.cursor/rules/a.mdc', mdc('true', 'ANOTHER SECRET\n'));
  const serialized = JSON.stringify(readRules(root));
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('AGENTS.md'), false);
});
