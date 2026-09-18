// fs.rmSync shim for Node < 14.14, which has no rmSync at all. `removeSync()` is what call
// sites use; it hands the work to the real rmSync when present so behavior on 14.14+ is
// untouched, and falls back to lstat + rmdirSync/unlinkSync below it — covering only the
// surface this codebase exercises: `{ force: true }` (missing target is fine) and
// `{ recursive: true }` for directories. It is not a general rm(1).
//
// This exists because most of the plugin's rmSync sites are best-effort try/catch cleanups
// where a missing rmSync would merely go quiet — but lib/lock.mjs releases the per-session
// lock with it, and a lock that can never be released turns every later checkpoint on that
// session into a contention skip. Silent-failing THERE is not best-effort, it is the plugin
// off. (The Claude plugin keeps raw rmSync inside try/catch and accepts the quiet miss; this
// shim is a strict superset of that behavior.)
//
// Bare specifier on purpose, like fetch-compat: the `node:` prefix does not resolve on the
// very interpreters this shim exists for.
import fs from 'fs';

export function removeSync(target, options) {
  const opts = options == null ? {} : options;
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(target, opts);
    return;
  }
  let stats = null;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    // rmSync's force:true swallows a missing target; without force it throws ENOENT — match both.
    if (opts.force === true) return;
    throw error;
  }
  if (stats.isDirectory()) {
    // rmdirSync({ recursive }) has existed since 12.10 — present on every interpreter that
    // lacks rmSync. Non-recursive callers get the plain form so a non-empty dir still throws.
    fs.rmdirSync(target, opts.recursive === true ? { recursive: true } : {});
  } else {
    fs.unlinkSync(target);
  }
}
