import { execFileSync } from 'child_process';
import path from 'path';

// A branch is tracked only when it carries a `.../task-<id>` segment. The capture group
// yields the `task-<id>` token (see taskFromBranch).
export const TASK_BRANCH_RE = /\/(task-[a-zA-Z0-9_-]+)/;

// The identity of last resort: a session that recorded no working directory at all (pre-stamp
// history with no edits) still carries billable usage, and dropping it because it cannot be
// named is worse than one honest catch-all bucket. Constant on purpose — every such session
// lands in ONE place instead of splintering.
//
// Deliberately NOT respelled to `local:unknown` alongside the folder change below. It carries no
// path, so it is not the disclosure that change exists to fix, and a new spelling would fork one
// backend bucket into two while rewriting nothing that was already uploaded.
export const UNATTRIBUTED_REMOTE = 'local://unknown';

// Every synthetic remote this plugin has ever written starts here. The legacy form is
// `local://<absolute path>`; the current one is `local:<folder>`.
const LOCAL_PREFIX = 'local:';

// The backend's `branch` column. One over-long field is a PERMANENT 4xx, and a permanent 4xx
// deletes the queue record — the segment's tokens, cost, operations and code changes are lost with
// it, not retried. Clamping at the source is the only place that cannot be forgotten.
export const MAX_BRANCH_CHARS = 255;

// What a branch is called when nothing can name it: a detached HEAD, a blocked git, a window with
// no repo at all. ONE spelling, shared by the live checkpoint, the audit/backfill path and
// lib/attribution-cursor.mjs — a second spelling splits one repo's unknown-branch history in two.
export const UNKNOWN_BRANCH = '(unknown)';

// The wire-safe branch label. Truncates rather than dropping the value: an over-long branch is
// still the right repo and the right work, and `(unknown)` for a branch we DO know would be worse
// than a clipped name. Unlike a remote, a truncated branch fabricates no identity — it is a label,
// not a key.
export function clampBranch(name) {
  if (typeof name !== 'string') return UNKNOWN_BRANCH;
  const trimmed = name.trim();
  if (trimmed === '') return UNKNOWN_BRANCH;
  if (trimmed.length <= MAX_BRANCH_CHARS) return trimmed;
  let cut = MAX_BRANCH_CHARS;
  const lead = trimmed.charCodeAt(cut - 1);
  // Cutting between the halves of a surrogate pair leaves a lone surrogate, which is not valid
  // UTF-8: JSON.stringify emits a bare \ud83d escape and the DTO can reject the whole report.
  // Dropping one character is cheaper than dropping the segment.
  if (lead >= 0xd800 && lead <= 0xdbff) cut -= 1;
  return trimmed.slice(0, cut);
}

// Forward slashes, no trailing separator. Local to this module rather than borrowed from
// lib/repo-map.mjs, which imports THIS file — the shared normalizer would be an import cycle.
function normalizeRoot(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Synthetic remote for a directory with no `origin` — a checkout without one, or a workspace that
// is not a repo at all. Keeps the wire `remote` field populated so /sessions/report can attribute
// the segment. Prefer a real origin whenever one exists.
//
// ONLY THE FOLDER NAME TRAVELS. This used to be `local://<absolute path>`, which put the user's
// account name and their private folder names on the wire for every repo with no origin. The
// folder alone is the same `local:<folder>` convention the sibling Claude plugin already reports
// under, so one checkout worked on from both agents lands on one key instead of two.
//
// Two checkouts with the same folder name DO collide. That is a limitation of the shared
// convention, stated rather than papered over: hashing the path into a new key scheme would invent
// a private backend contract no other client can read, and truncating a path would fabricate an
// identity outright. Case is preserved for the same reason — the sibling does not fold, and a
// client that did would report the same checkout under a second key forever.
export function localRemoteFromRoot(root) {
  const normalized = normalizeRoot(root).trim();
  if (normalized === '') return UNATTRIBUTED_REMOTE;
  const base = path.posix.basename(normalized);
  // A bare drive ("C:") names a disk, not a project. `.` and `..` name no folder at all: this no
  // longer path.resolve()s the input (resolving made the result depend on process.cwd, which is
  // not a property of the checkout), so a relative root has to be rejected here rather than
  // silently reported as a repo literally called "..".
  if (base === '' || base === '.' || base === '..' || /^[A-Za-z]:$/.test(base)) {
    return UNATTRIBUTED_REMOTE;
  }
  return LOCAL_PREFIX + base;
}

// True for a remote this plugin minted itself, in either spelling. A real origin — HTTPS, SSH,
// scp-style — never starts with `local:`.
export function isSyntheticLocalRemote(url) {
  return typeof url === 'string' && url.startsWith(LOCAL_PREFIX);
}

// A persisted `local://<absolute path>` rewritten to `local:<folder>`. Idempotent: the current
// spelling, a real origin and a non-string all come back unchanged, so this can run over a whole
// queue directory (or a whole repo map) without knowing which records have already been migrated.
//
// Already-uploaded identities are NOT rewritten by this. Consolidating history under the new key
// is a backend migration, outside what a client can honestly do.
export function convertLegacyLocalRemote(url) {
  if (!isSyntheticLocalRemote(url)) return url;
  if (url === UNATTRIBUTED_REMOTE) return url;
  // Strip the prefix and, for the legacy form, the `//` authority marker; what is left is a path
  // (legacy) or a folder (current), and localRemoteFromRoot answers the same for both.
  const rest = url.slice(LOCAL_PREFIX.length).replace(/^\/\//, '');
  return localRemoteFromRoot(rest);
}

// One queued payload with its synthetic remote migrated in place. Pure and narrow ON PURPOSE:
// nothing but `remote` may move. `segmentId` is the server's idempotency key, and `_retry` is the
// queue's own age and backoff bookkeeping — a migration that disturbed either would either
// double-bill the segment or reset its queue age.
//
// Returns the SAME object when there is nothing to migrate, so a caller can skip the rewrite (and
// the fsync) on an untouched file.
export function sanitizeQueuedPayloadRemote(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const remote = payload.remote;
  if (!isSyntheticLocalRemote(remote)) return payload;
  const converted = convertLegacyLocalRemote(remote);
  if (converted === remote) return payload;
  return { ...payload, remote: converted };
}

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    // Swallow git's stderr. Every call site already treats a failure as a normal state — not a
    // repo, no origin — but without this, git's own `fatal: not a git repository` and
    // `error: No such remote 'origin'` are forwarded to the hook's stderr and surface in Cursor's
    // hook execution log as if something had gone wrong.
    stdio: ['ignore', 'pipe', 'ignore'],
    // Bound the spawn so a hung git can't burn the whole 10s hook budget.
    timeout: 5000,
    killSignal: 'SIGKILL',
    // Pin the C locale so parsed output (e.g. reflog "checkout: moving from…") stays
    // English regardless of the user's git language settings.
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

export function sanitizeRemote(url) {
  return url.replace(/\/\/[^@/]+@/, '//');
}

// Resolve a repo's origin remote with embedded credentials stripped, or null on any
// failure (not a repo, no origin, git error). Never throws.
export function resolveOriginRemote(gitImpl, dir) {
  try { return sanitizeRemote(gitImpl(['remote', 'get-url', 'origin'], dir)); }
  catch { return null; }
}

// `git branch --show-current`, not `rev-parse --abbrev-ref HEAD`.
//
// `rev-parse` answers the literal string `HEAD` on a detached HEAD — reported as if it were a
// branch name — and exits 128 on a repository with no commits, which is every `git init` before
// the first commit. `--show-current` prints an empty line when detached and the branch name on a
// commit-less repo, so both states become answerable instead of wrong.
export function currentBranch(cwd, gitImpl = git) {
  const branch = gitImpl(['branch', '--show-current'], cwd);
  if (branch) return branch;
  throw new Error('detached HEAD: no current branch');
}

// The `task-<id>` token for a task branch, or null when the branch doesn't fit.
export function taskFromBranch(branch) {
  const match = TASK_BRANCH_RE.exec(branch == null ? '' : branch);
  return match ? match[1] : null;
}
