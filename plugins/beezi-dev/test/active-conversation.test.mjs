import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveActiveConversation } from '../lib/active-conversation.mjs';
import { appendEvent, eventsFileFor } from '../lib/sidecar.mjs';
import { eventsDir, stateDir } from '../lib/paths-cursor.mjs';
import { writeJsonSecure } from '../lib/fs-store.mjs';

// Which conversation `track.mjs` means when a user runs it from a terminal. The hooks always know
// their conversation_id; an unrelated process does not, so this is the only resolution the machine
// can offer — the most recent conversation opened in THIS repo, else the newest one anywhere.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-active-conv-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const backdate = (file, msAgo) => {
  const when = new Date(Date.now() - msAgo);
  fs.utimesSync(file, when, when);
};

test('a machine that has recorded nothing at all resolves no conversation', (t) => {
  tmpHome(t);
  assert.equal(resolveActiveConversation(path.join(os.tmpdir(), 'nowhere')), null);
});

// No state file matches (or exists), so the answer falls through to the sidecar directory: a user
// who just asked to save their analytics is better served by their most recent session than by a
// refusal.
test('with no state files the newest sidecar answers', (t) => {
  tmpHome(t);
  appendEvent('conv-old', { ev: 'gen', model: 'm' });
  appendEvent('conv-new', { ev: 'gen', model: 'm' });
  backdate(eventsFileFor('conv-old'), 60 * 60 * 1000);

  assert.equal(resolveActiveConversation(path.join(os.tmpdir(), 'nowhere')), 'conv-new');
});

// The fallback enumerates events/ through listAllConversations (lib/sidecar-index.mjs) rather than
// re-walking the directory itself, which is what makes these two exclusions hold. Both used to be
// returned as conversation ids: a DIRECTORY named `x.jsonl` stats perfectly well, and a stem the
// writer's sanitizer would never have produced is not an id anything was ever recorded under — so
// `track` would checkpoint a session that does not exist.
test('a directory named like a sidecar, and an unsafe stem, are not conversations', (t) => {
  tmpHome(t);
  appendEvent('conv-1', { ev: 'gen', model: 'm' });
  backdate(eventsFileFor('conv-1'), 60 * 60 * 1000);
  // Both newer than the real sidecar, so a naive newest-mtime scan picks one of them.
  fs.mkdirSync(path.join(eventsDir(), 'dir.jsonl'));
  fs.writeFileSync(path.join(eventsDir(), '.hidden.jsonl'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(eventsDir(), 'has space.jsonl'), '{}\n', 'utf-8');

  assert.equal(resolveActiveConversation(path.join(os.tmpdir(), 'nowhere')), 'conv-1');
});

// The cwd narrows the answer: running `track` in one repo must not flush a conversation from
// another. The state file is where a checkpoint recorded which directory the conversation lives in.
test('a state file recorded under this directory wins over the newest sidecar', (t) => {
  tmpHome(t);
  const here = path.join(os.tmpdir(), 'beezi-active-conv-repo');
  writeJsonSecure(path.join(stateDir(), 'conv-here.json'), { cursor: 1, cwd: here });
  appendEvent('conv-elsewhere', { ev: 'gen', model: 'm' });

  assert.equal(resolveActiveConversation(here), 'conv-here');
  // A subdirectory of the recorded cwd is still the same workspace.
  assert.equal(resolveActiveConversation(path.join(here, 'src', 'deep')), 'conv-here');
});
