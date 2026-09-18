import path from 'path';
import { UNKNOWN_BRANCH } from './git.mjs';
import { normPath } from './repo-map.mjs';
import { lastCdTarget } from './repo-timeline.mjs';
import { timestampOf } from './subagents-cursor.mjs';

// Event-time repository and branch attribution for one raw sidecar window.
//
// THE DEFECT THIS EXISTS FOR. A checkpoint used to stamp ONE repo and ONE branch — the workspace
// root the hook happened to report, and the branch that was checked out when the window ended — on
// every line in the window. A session that edits two projects in a multi-root workspace, or that
// switches branch halfway through a turn, therefore billed all of it to whichever context happened
// to be current at the end. `workspace_roots[0]` can misattribute the very FIRST event.
//
// WHY NOT `extractPathSignal`. lib/repo-timeline.mjs already derives a directory signal, but from a
// Claude transcript line: `message.content[]` blocks of `type:'tool_use'` with `input.file_path`.
// A Cursor sidecar line is `{ev:'edit',path,cwd,ts}` / `{ev:'shell',cmd,cwd,ts}` — a different shape
// entirely, and handing one to `extractPathSignal` yields null for every line. The `cd` grammar IS
// shared (imported, not copied): that rule is the one piece both readers genuinely have in common.
//
// THE SIGNAL RULES, in the order they are applied to each event:
//
//   1. an `edit` line's `path` names the file that was actually written. Relative paths resolve
//      against THAT EVENT's own stamped `cwd`, not the session's — a conversation that moves
//      between projects stamps a different cwd on each line, and resolving against the session cwd
//      would drag every relative path back to the launch directory.
//   2. a `shell` line's `cmd` is PARSED for the recognized `cd`/`pushd` forms only, and never
//      executed. An unrecognized command (`git -C elsewhere status`) is not a directory signal;
//      guessing at shell semantics is how a `--help` string becomes a repo switch.
//   3. anything else — a generation, a tool call, a prompt — carries the last unambiguous repo
//      forward. It is the same work in the same place until something says otherwise.
//   4. `cwd` is a RESOLUTION BASE and a last-resort seed, never a switch signal. The hook stamps it
//      on every line it writes, so a repeated workspace-root stamp is the fallback context the host
//      had — not evidence that activity switched back from the last file's repo. Treating it as a
//      signal is precisely the multi-root defect, re-expressed one line at a time.
//
// DETERMINISM. `indexedEvents` carries ABSOLUTE raw indices — the same numbers `from`/`to` count in
// lib/delta-cursor.mjs — and nothing in here ever looks at an array position. Events outside
// `[from, to)` are dropped before anything is established, so a full read (which holds the whole
// file) and a byte-resume read (which holds only the new tail) see exactly the same in-window
// evidence and produce byte-identical boundaries. That is the invariant the `segmentId` contract
// rests on: a re-read of the same range must name the same runs.

// Re-exported, not redefined: the fallback branch name is owned by lib/git.mjs, where clampBranch
// falls back to the same string at payload construction. A second spelling of "we could not tell"
// would split one repo's unknown-branch history into two buckets server-side.
export { UNKNOWN_BRANCH };

// `ev` values whose `path` names an edited file. The writer emits `edit`; the aliases match the
// tolerance lib/delta-cursor.mjs already extends to a writer that renames the kind.
const EDIT_EVENTS = new Set(['edit', 'file_edit', 'edits']);
const SHELL_EVENTS = new Set(['shell']);

// A Map key for a repo root, including the null root — `String(null)` would collide with a
// directory literally named "null", which is legal on every filesystem this runs on.
const NO_ROOT_KEY = '\u0000no-root';
function rootKeyOf(root) {
  return root === null ? NO_ROOT_KEY : root;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// The directory an `edit` line implies, resolved against its own stamped cwd when the path is
// relative. Returns null when the line names no usable path.
function dirFromEdit(rawPath, rawCwd) {
  const normalized = normPath(rawPath);
  if (normalized === null) return null;
  // win32.isAbsolute accepts BOTH a POSIX root ("/repo/x.ts") and a drive root ("C:/repo/x.ts"),
  // which is what lets one rule serve a sidecar written on either platform.
  if (path.win32.isAbsolute(normalized)) return path.posix.dirname(normalized);
  const base = normPath(rawCwd);
  if (base === null) return null;
  return path.posix.join(base, path.posix.dirname(normalized));
}

// The directory signal a single sidecar event carries, or null when it carries none.
function dirSignalOf(event) {
  const kind = event.ev;
  if (EDIT_EVENTS.has(kind)) return dirFromEdit(event.path, event.cwd);
  if (SHELL_EVENTS.has(kind)) return lastCdTarget(event.cmd, normPath(event.cwd));
  return null;
}

// Drop everything that is not a usable `{ index, event }` pair inside the window, then order by
// absolute index. Sorting rather than trusting the caller keeps the planner honest about its own
// contract: the runs are a function of the indices, not of the array the caller happened to build.
function windowEntries(indexedEvents, from, to) {
  if (!Array.isArray(indexedEvents)) return [];
  const entries = [];
  for (const entry of indexedEvents) {
    if (entry === null || typeof entry !== 'object') continue;
    const index = entry.index;
    if (!Number.isFinite(index)) continue;
    if (index < from || index >= to) continue;
    const event = entry.event;
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
    entries.push({ index: Math.trunc(index), event });
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

// Ordered `{from,to,repoRoot,branch}` spans covering `[from, to)` exactly, plus the attribution to
// hand back as `previous` on the next window.
//
// `repoRootOf(dir)` and `branchAt(root, eventTimeMs)` are injected (the checkpoint's memoized git
// resolvers). Both may throw — a dubious-ownership repo, a blocked git binary — and a throw must
// cost the attribution, never the window: the whole point of splitting is to report MORE precisely,
// so failing closed and dropping the segment would be a straight regression.
export function planAttributionRuns(indexedEvents, options) {
  const opts = options == null ? {} : options;
  const from = Number.isFinite(opts.from) ? Math.trunc(opts.from) : null;
  const to = Number.isFinite(opts.to) ? Math.trunc(opts.to) : null;
  const previous = opts.previous == null || typeof opts.previous !== 'object' ? null : opts.previous;
  const carried = Object.freeze({
    repoRoot: previous === null || previous.repoRoot == null ? null : previous.repoRoot,
    branch: previous === null || !nonEmptyString(previous.branch) ? UNKNOWN_BRANCH : previous.branch,
  });

  // A window with no raw lines in it has nothing to attribute. Answering `[]` (rather than one
  // zero-width run) keeps the "every nonempty range has to > from" invariant unconditional.
  if (from === null || to === null || to <= from) {
    return { runs: Object.freeze([]), nextAttribution: carried };
  }

  const repoRootOf = typeof opts.repoRootOf === 'function' ? opts.repoRootOf : null;
  const branchAt = typeof opts.branchAt === 'function' ? opts.branchAt : null;

  // Both resolvers shell out to git on a cold cache. Memoizing per directory and per
  // (root, timestamp) is what keeps a 130k-line window from spawning a git process per line —
  // consecutive events routinely share both a directory and a millisecond.
  const rootByDir = new Map();
  const resolveRoot = (dir) => {
    const key = nonEmptyString(dir);
    if (key === null || repoRootOf === null) return null;
    if (rootByDir.has(key)) return rootByDir.get(key);
    let root = null;
    try {
      const resolved = repoRootOf(key);
      root = nonEmptyString(resolved);
    } catch {
      root = null;
    }
    rootByDir.set(key, root);
    return root;
  };

  const branchByKey = new Map();
  // The branch last resolved for a root, so an event with no usable timestamp carries it forward
  // instead of being billed to a branch nobody can name. Seeded from `previous` for exactly that
  // case at the head of a window.
  const lastBranchByRoot = new Map();
  if (carried.repoRoot !== null) lastBranchByRoot.set(rootKeyOf(carried.repoRoot), carried.branch);

  const callBranchAt = (root, ms) => {
    if (branchAt === null) return UNKNOWN_BRANCH;
    try {
      const resolved = branchAt(root, ms);
      const name = nonEmptyString(resolved);
      return name === null ? UNKNOWN_BRANCH : name;
    } catch {
      return UNKNOWN_BRANCH;
    }
  };

  const resolveBranch = (root, ms) => {
    const rk = rootKeyOf(root);
    let branch;
    if (ms === null) {
      // No timestamp: the reflog cannot be asked WHEN this happened, so the branch already
      // established for this root is the only honest answer. Falling back to a HEAD lookup (ms
      // null) only when nothing is established yet.
      branch = lastBranchByRoot.has(rk) ? lastBranchByRoot.get(rk) : callBranchAt(root, null);
    } else {
      const key = `${rk}\u0000${ms}`;
      if (branchByKey.has(key)) {
        branch = branchByKey.get(key);
      } else {
        branch = callBranchAt(root, ms);
        branchByKey.set(key, branch);
      }
    }
    lastBranchByRoot.set(rk, branch);
    return branch;
  };

  const entries = windowEntries(indexedEvents, from, to);

  let activeRoot = carried.repoRoot;
  // False until a signal (or a seed) has named a repo. While false, every event retries the seed,
  // but `resolveRoot` caches its misses too — so the retry costs a git process once per DISTINCT
  // directory, not once per event. A window whose events all carry the same unresolvable cwd pays
  // for exactly one lookup; a later event stamped with a different (resolvable) cwd still seeds.
  let established = carried.repoRoot !== null;

  const runs = [];
  let open = null;
  const place = (index, repoRoot, branch) => {
    if (open !== null && open.repoRoot === repoRoot && open.branch === branch) return;
    if (open !== null && index <= open.from) {
      // Two entries on the SAME raw line — a caller that indexed one line twice, or a sidecar line
      // that produced two events — would otherwise close the open run AT ITS OWN START and leave a
      // zero-width `{from: n, to: n}` behind, breaking the `to > from` invariant every consumer
      // relies on. One raw line is one boundary: the later entry's attribution replaces the open
      // run's in place and no new run is opened.
      open.repoRoot = repoRoot;
      open.branch = branch;
      return;
    }
    if (open !== null) open.to = index;
    // The first run always starts at `from`, even when the first parsed event sits further in:
    // the raw lines before it produced no event, so there is no separate activity to attribute
    // and folding them in keeps the run list minimal and the boundaries stable.
    open = { from: open === null ? from : index, to, repoRoot, branch };
    runs.push(open);
  };

  for (const entry of entries) {
    const event = entry.event;
    const signalDir = dirSignalOf(event);
    if (signalDir !== null) {
      const signalled = resolveRoot(signalDir);
      // A path we cannot map to a repo is AMBIGUOUS, not a move to "no repo": carrying the
      // established root forward keeps a scratch file edited mid-session from erasing the
      // attribution of the work around it.
      if (signalled !== null) {
        activeRoot = signalled;
        established = true;
      }
    }
    if (!established) {
      // Seed order: the event's own stamped cwd (the host's view at that moment), then the
      // session cwd. Never a switch — only the first naming of a repo this window has no other
      // evidence for.
      let seeded = resolveRoot(event.cwd);
      if (seeded === null) seeded = resolveRoot(opts.cwd);
      if (seeded !== null) {
        activeRoot = seeded;
        established = true;
      } else {
        activeRoot = null;
      }
    }
    place(entry.index, activeRoot, resolveBranch(activeRoot, timestampOf(event)));
  }

  if (open === null) {
    // Raw lines the reader could not turn into events still belong to the window — `to` counts
    // lines, not parsed events — so the range is covered by the best context available.
    if (!established) {
      const seeded = resolveRoot(opts.cwd);
      if (seeded !== null) { activeRoot = seeded; established = true; } else { activeRoot = null; }
    }
    place(from, activeRoot, resolveBranch(activeRoot, null));
  }

  const frozen = runs.map((run) => Object.freeze(run));
  const last = frozen[frozen.length - 1];
  return {
    runs: Object.freeze(frozen),
    nextAttribution: Object.freeze({ repoRoot: last.repoRoot, branch: last.branch }),
  };
}
