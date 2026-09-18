import fs from 'fs';

// Where a hook runs, and why that is not where Cursor starts it.
//
// Cursor starts a plugin hook in the PLUGIN's directory — except `stop` and `subagentStop`, which
// it starts in the workspace folder. That default is actively wrong for this plugin: every segment
// is attributed by shelling out to git in the current directory, and a marketplace install is
// itself a git clone of the marketplace repo. Left alone, four of the six hooks would attribute the
// user's work to the Beezi plugin repository and report a branch nobody is working on.
//
// Cursor passes the real workspace folder in the hook environment, so the fix is to move there
// before doing anything. The launcher-invoked path gets the same treatment: those inherit whatever
// directory Cursor's hook runner happened to use, which is no more predictable.

// CURSOR_PROJECT_DIR is Cursor's own name; CLAUDE_PROJECT_DIR carries the same value and is checked
// second so a future rename of either does not leave the hook running in the wrong repository.
export const PROJECT_DIR_VARS = Object.freeze(['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']);

// A URI path is not a filesystem path, and on Windows the difference is fatal rather than cosmetic.
//
// Cursor builds `workspace_roots` as `getWorkspace().folders.map(f => f.uri.path)` — `uri.path`,
// not `uri.fsPath` — so a Windows workspace arrives as `/c:/Users/you/project`. Node cannot spawn
// with that as its working directory: `git rev-parse` fails with `spawnSync … cmd.exe ENOENT`,
// every repo lookup comes back empty, and the segment is dropped for having nothing to attribute
// it to. The session timeline needs no git, so it kept arriving — which is what "only the timeline
// is tracked" looks like from the server.
//
// Percent-decoding is applied only to values that announced themselves as URIs (a `file://` scheme
// or a leading-slash drive letter). A plain Windows path is returned untouched, so a directory with
// a literal `%` in its name survives.
export function toFilesystemPath(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;

  let wasUri = false;
  if (/^file:\/\//i.test(text)) {
    text = text.replace(/^file:\/\//i, '');
    wasUri = true;
  }
  if (/^\/[A-Za-z]:(?:[\\/]|$)/.test(text)) {
    text = text.slice(1);
    wasUri = true;
  }
  if (wasUri) {
    try { text = decodeURIComponent(text); } catch { /* keep the raw form */ }
  }
  return text === '' ? null : text;
}

export function projectDir(env = process.env) {
  for (const name of PROJECT_DIR_VARS) {
    const resolved = toFilesystemPath(env[name]);
    if (resolved) return resolved;
  }
  return null;
}

// Returns the directory actually moved to, or null when the environment said nothing usable.
// Never throws: a hook that cannot chdir must still record the event it was started for, and a
// window with no folder open (project dir is the empty string) is a normal state, not an error.
export function enterProjectDir({ env = process.env, chdir = process.chdir, exists = fs.existsSync } = {}) {
  const dir = projectDir(env);
  if (!dir) return null;
  try {
    if (!exists(dir)) return null;
    chdir(dir);
    return dir;
  } catch {
    return null;
  }
}
