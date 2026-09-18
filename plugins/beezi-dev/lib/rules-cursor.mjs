import fs from 'fs';
import path from 'path';

// How large this repository's standing instructions are, counted without reading them into anything
// that leaves the process.
//
// WHAT THIS IS EVIDENCE OF, exactly: files that exist on disk right now, and how many lines they
// hold. It is NOT evidence that any of it reached a model, it is NOT token usage, and a file being
// present is NOT proof it was applied. Those distinctions are why the result carries two different
// numbers:
//
//   discovered      every rule source found — the local inventory. A `.mdc` that applies only to
//                   `*.tsx` is in here, and counting it as a prompt floor would overstate every
//                   session in a repository that keeps a lot of conditional rules.
//   alwaysApplied   the subset that DECLARES ITSELF unconditional (`alwaysApply: true`). This is the
//                   only number that is a candidate for emission, and even then only after the
//                   backend contract accepts a field for it.
//
// AGENTS.md and the legacy `.cursorrules` are discovered but NOT in the always-applied subset. Both
// are conventionally unconditional, and neither says so in a way this reader can check: no fixture
// or host documentation in this workspace establishes Cursor's precedence between the three kinds.
// A metric that claimed them would be asserting something nobody here has verified. That is a gate,
// not a conclusion — host documentation showing the precedence is what moves them.
//
// Nothing is cached. A rules file edited between two checkpoints must read differently, and a cache
// that survived the edit would report yesterday's repository as today's. A caller that needs one
// answer per checkpoint holds the result itself.

// Initial budgets. Constants rather than literals so a bound that stopped applying shows up as a
// failing boundary test instead of as a machine walking a monorepo inside a 10 s hook.
export const RULES_MAX_DEPTH = 3;
export const RULES_MAX_FILES = 100;
export const RULES_MAX_BYTES = 1048576;

const AGENTS_FILE = 'AGENTS.md';
const CURSORRULES_FILE = '.cursorrules';
const RULES_DIR = ['.cursor', 'rules'];
const MDC_EXT = '.mdc';
const FRONTMATTER_FENCE = '---';

// Lines the way an editor shows them: ONE trailing newline terminates the last line, a second one is
// a real empty line, and a file with no trailing newline still has a last line. Empty is zero.
//
// Counted with indexOf rather than split: a rules file is small by policy, but the same rule counts
// agent edits elsewhere in this plugin over multi-megabyte strings, and one counting rule that
// behaves identically everywhere is worth more than a marginally shorter one here.
function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let lines = 0;
  let index = text.indexOf('\n');
  while (index !== -1) {
    lines += 1;
    index = text.indexOf('\n', index + 1);
  }
  return text.charCodeAt(text.length - 1) === 10 ? lines : lines + 1;
}

// `{ body, alwaysApply }` for an `.mdc` file.
//
// Frontmatter is a fenced block at the very start of the file and nowhere else. No closing fence
// means there is no frontmatter — the file is all body, and whatever `alwaysApply:` line it happens
// to contain is prose rather than metadata.
//
// `alwaysApply` qualifies ONLY on the literal `true`, after a colon and at least one space, which is
// what YAML requires for a mapping at all (`alwaysApply:true` is the scalar string
// "alwaysApply:true", not a key). `"true"`, `True`, `yes`, `1`, absent and malformed all fail: the
// subset this feeds is the one metric that claims a rule was unconditional, and a lenient parse
// there turns a conditional rule into a permanent one.
function parseMdc(text) {
  const source = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
  const lines = source.split('\n');
  const first = lines.length === 0 ? '' : lines[0].replace(/\r$/, '');
  if (first !== FRONTMATTER_FENCE) return { body: source, alwaysApply: false };

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === FRONTMATTER_FENCE) { close = i; break; }
  }
  if (close === -1) return { body: source, alwaysApply: false };

  let alwaysApply = false;
  for (let i = 1; i < close; i++) {
    const match = /^\s*alwaysApply:[ \t]+(.*)$/.exec(lines[i].replace(/\r$/, ''));
    if (match === null) continue;
    alwaysApply = match[1].trim() === 'true';
  }
  return { body: lines.slice(close + 1).join('\n'), alwaysApply };
}

function emptyCount() {
  return { lines: 0, sources: 0 };
}

export function readRules(root, deps = {}) {
  if (typeof root !== 'string' || root === '') return null;
  const fsImpl = deps.fsImpl == null ? fs : deps.fsImpl;
  const base = path.resolve(root);

  const discovered = emptyCount();
  const alwaysApplied = emptyCount();
  const bySource = { agents: emptyCount(), cursorrules: emptyCount(), mdc: emptyCount() };
  let files = 0;
  let bytes = 0;
  // The FIRST thing that stopped this being a complete reading is the one reported: it is the one
  // the operator would fix, and a later cap tripping because an earlier one truncated the walk is a
  // consequence rather than a cause.
  let reason = null;
  const incomplete = (why) => { if (reason === null) reason = why; };

  // Inside the resolved root, always. The traversal below never follows a link, so an escape would
  // take a bug to produce — which is exactly when a cheap check is worth having.
  const contained = (candidate) => {
    const resolved = path.resolve(candidate);
    return resolved === base || resolved.startsWith(base + path.sep);
  };

  // Read one candidate file, or say why it was not read. Returns the text, or null.
  const readFile = (file) => {
    if (!contained(file)) { incomplete('escaped-path'); return null; }
    if (files >= RULES_MAX_FILES) { incomplete('max-files'); return null; }
    let stat;
    try {
      stat = fsImpl.lstatSync(file);
    } catch {
      return null; // absent — not an incomplete reading, just a file this repository does not have
    }
    // lstat, so a symlink is seen as a symlink. Following one is how a rules directory reaches
    // outside the repository, and a rule counted from somewhere else is not this repository's.
    if (stat.isSymbolicLink()) { incomplete('symlink'); return null; }
    if (!stat.isFile()) return null;
    const size = Number.isFinite(stat.size) ? stat.size : 0;
    if (bytes + size > RULES_MAX_BYTES) { incomplete('max-bytes'); return null; }
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf-8');
    } catch {
      // Present but unreadable is a THIRD state, distinct from absent and from empty: something is
      // there and its size is unknown, so the total cannot be called exact.
      incomplete('unreadable');
      return null;
    }
    files += 1;
    bytes += size;
    return typeof text === 'string' ? text : String(text);
  };

  const countPlain = (file, bucket) => {
    const text = readFile(file);
    if (text === null) return;
    const lines = countLines(text);
    bucket.lines += lines;
    bucket.sources += 1;
    discovered.lines += lines;
    discovered.sources += 1;
  };

  countPlain(path.join(base, AGENTS_FILE), bySource.agents);
  countPlain(path.join(base, CURSORRULES_FILE), bySource.cursorrules);

  // `.cursor/rules/**/*.mdc`, breadth-limited. `depth` counts directories below the rules directory
  // itself, so a rule sitting directly in it is at depth 0 and RULES_MAX_DEPTH allows three levels of
  // nesting below that.
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no rules directory here, which is the common case
    }
    // Sorted, so two machines reading the same repository hit the caps on the same files and report
    // the same numbers.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { incomplete('symlink'); continue; }
      if (entry.isDirectory()) {
        if (depth + 1 > RULES_MAX_DEPTH) { incomplete('max-depth'); continue; }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(MDC_EXT)) continue;
      const text = readFile(full);
      if (text === null) continue;
      const parsed = parseMdc(text);
      // Body lines only. The fenced block is metadata about the rule, not instruction text, and
      // counting it would inflate every rule by its own header.
      const lines = countLines(parsed.body);
      bySource.mdc.lines += lines;
      bySource.mdc.sources += 1;
      discovered.lines += lines;
      discovered.sources += 1;
      if (parsed.alwaysApply) {
        alwaysApplied.lines += lines;
        alwaysApplied.sources += 1;
      }
    }
  };
  walk(path.join(base, ...RULES_DIR), 0);

  // ABSENT is spelled `null`: this repository has no rules this reader can see. It is a different
  // observation from "it has rules totalling zero lines", and different again from "there was
  // something here and none of it could be read" — a directory of symlinks, an unreadable file, a
  // path that tried to escape the root. Only the FIRST of those is absent.
  //
  // `reason !== null` is exactly "something was skipped", so a zero-source result with a reason is
  // reported as an incomplete observation with its reason attached rather than as an empty
  // repository. Reporting that as absent would let an unreadable rules directory look identical to a
  // project that has no rules at all.
  if (discovered.sources === 0 && reason === null) return null;

  return {
    discovered,
    alwaysApplied,
    // Per kind, never per filename: a path is content of a sort, and this result is allowed to leave
    // the function. Kept because precedence between the three kinds is unproven, and a caller that
    // must not claim an exact summed prompt floor needs the parts to say so.
    bySource,
    complete: reason === null,
    ...(reason === null ? {} : { reason }),
  };
}
