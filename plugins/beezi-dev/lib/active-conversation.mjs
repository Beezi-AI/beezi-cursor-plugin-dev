import fs from 'fs';
import path from 'path';
import { stateDir } from './paths-cursor.mjs';
import { listAllConversations } from './sidecar-index.mjs';

// Which Cursor conversation is "the one the user means" when they run `track.mjs` from a terminal.
//
// The hooks always know: `conversation_id` is on every payload. The CLI does not — there is no
// Cursor equivalent of "the current session id" available to an unrelated process. So this resolves
// it the only way the machine can: the most recently active conversation whose recorded cwd is this
// repository, falling back to the most recently written sidecar overall.
//
// Deliberately NOT a transcript scan (the Codex plugin's approach): `cursor-agent` has no observed
// transcript write path, and Cursor's on-disk chat format has moved four times in a year.

function normalize(dir) {
  return typeof dir === 'string' ? path.resolve(dir).replace(/\\/g, '/').toLowerCase() : null;
}

// Newest-first list of { id, cwd, mtimeMs } from the plugin's own state directory.
function statesByRecency() {
  let files;
  try { files = fs.readdirSync(stateDir()); } catch { return []; }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(stateDir(), file);
    let mtimeMs;
    try { ({ mtimeMs } = fs.statSync(full)); } catch { continue; }
    let state = null;
    try { state = JSON.parse(fs.readFileSync(full, 'utf-8')); } catch { /* keep null */ }
    const cwd = state == null || state.cwd == null ? null : state.cwd;
    out.push({ id: path.basename(file, '.json'), cwd, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The most recently written sidecar on this machine, or null when there is none.
//
// One enumerator for events/ across the plugin: listAllConversations already does this readdir —
// oldest-first, so the newest is the last — and does it with the validation this used to skip. A
// directory named `x.jsonl` statted fine here and was returned as a conversation id; so was a stem
// the writer's sanitizer would never have produced. Both are now excluded, which is the point: a
// `track` run must not enqueue a checkpoint against an id no sidecar was ever written under.
function newestSidecarId() {
  const all = listAllConversations();
  // Index arithmetic rather than `.at(-1)`: Array.prototype.at needs Node 16.6, and the plugin's
  // floor is 13.2. The length guard is what `.at` did for an empty list.
  const newest = all.length > 0 ? all[all.length - 1] : undefined;
  if (newest == null || newest.sessionId == null) return null;
  return newest.sessionId;
}

// The conversation id to checkpoint, or null when this machine has recorded none.
//
// `cwd` narrows the answer to conversations opened in (or under) this directory, which is what makes
// running `track` in one repo not flush a conversation from another. When nothing matches, the
// newest conversation on the machine is returned rather than nothing: a user who just asked to save
// their analytics is better served by the most recent session than by a refusal.
export function resolveActiveConversation(cwd = process.cwd()) {
  const here = normalize(cwd);
  const states = statesByRecency();
  if (here) {
    const match = states.find((s) => {
      const theirs = normalize(s.cwd);
      return theirs !== null && (theirs === here || here.startsWith(`${theirs}/`) || theirs.startsWith(`${here}/`));
    });
    if (match) return match.id;
  }
  // `newestSidecarId()` reads the filesystem, so it stays lazy exactly as `??` had it: it runs only
  // when the newest state carries no usable id.
  const newest = states[0] == null ? undefined : states[0].id;
  return newest == null ? newestSidecarId() : newest;
}
