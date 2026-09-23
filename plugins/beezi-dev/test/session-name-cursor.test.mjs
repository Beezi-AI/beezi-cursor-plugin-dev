import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionName } from '../lib/session-name-cursor.mjs';
import { clearCliChatCache } from '../lib/cli-chats-cursor.mjs';

const NO_EVENTS = { readEvents: () => [] };
// Without a cliMeta the resolver reads the real ~/.cursor/chats. Spread FIRST, so a test that passes
// its own cliMeta later in the literal still wins.
const NO_CLI = { cliMeta: null };

test('composerData.name is the preferred title', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { name: 'Fix the parser' },
    readEvents: () => [{ ev: 'prompt', text: 'a prompt nobody should see' }],
  });
  assert.equal(name, 'Fix the parser');
});

test('alternate title spellings are accepted', () => {
  assert.equal(resolveSessionName('conv-1', { ...NO_CLI, composerData: { title: 'Refactor' }, ...NO_EVENTS }), 'Refactor');
  assert.equal(
    resolveSessionName('conv-1', { ...NO_CLI, composerData: { composerTitle: 'Ship it' }, ...NO_EVENTS }),
    'Ship it',
  );
});

test('the first sidecar prompt is the fallback when there is no title', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: {},
    readEvents: () => [
      { ev: 'gen', model: 'gpt-5' },
      { ev: 'prompt', text: 'Refactor the checkout flow' },
      { ev: 'prompt', text: 'and then the cart' },
    ],
  });
  assert.equal(name, 'Refactor the checkout flow');
});

test('a prompt stored inside composerData is the last fallback', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: {
      conversation: [
        { type: 2, text: 'assistant reply' },
        { type: 1, text: 'Add a retry to the uploader' },
      ],
    },
    ...NO_EVENTS,
  });
  assert.equal(name, 'Add a retry to the uploader');
});

test('the newer role-based message shape is understood too', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { messages: [{ role: 'user', content: 'Explain the reducer' }] },
    ...NO_EVENTS,
  });
  assert.equal(name, 'Explain the reducer');
});

test('a sidecar prompt outranks a composerData message', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { messages: [{ role: 'user', text: 'stale' }] },
    readEvents: () => [{ ev: 'prompt', text: 'live' }],
  });
  assert.equal(name, 'live');
});

test('the name is truncated to 200 characters', () => {
  const long = 'x'.repeat(500);
  assert.equal(resolveSessionName('conv-1', { ...NO_CLI, composerData: { name: long }, ...NO_EVENTS }).length, 200);
  assert.equal(
    resolveSessionName('conv-1', { ...NO_CLI, composerData: {}, readEvents: () => [{ ev: 'prompt', text: long }] }).length,
    200,
  );
});

test('a blank title falls through instead of becoming the name', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { name: '   ' },
    readEvents: () => [{ ev: 'prompt', text: 'the real prompt' }],
  });
  assert.equal(name, 'the real prompt');
});

test('an unreadable conversation record yields null, not an empty string', () => {
  assert.equal(resolveSessionName('conv-1', { ...NO_CLI, composerData: null, ...NO_EVENTS }), null);
});

test('a composerData whose fields all moved yields null rather than a fabricated name', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { composerName: 'Fix the parser', turns: [{ speaker: 'user', body: 'hi' }] },
    ...NO_EVENTS,
  });
  assert.equal(name, null);
});

test('a throwing event reader does not break the name resolution', () => {
  const name = resolveSessionName('conv-1', {
    ...NO_CLI,
    composerData: { messages: [{ role: 'user', text: 'from the record' }] },
    readEvents: () => {
      throw new Error('unreadable');
    },
  });
  assert.equal(name, 'from the record');
});

test('a missing conversation id resolves to null without touching any source', () => {
  let touched = false;
  assert.equal(
    resolveSessionName('', {
      ...NO_CLI,
      readEvents: () => {
        touched = true;
        return [];
      },
    }),
    null,
  );
  assert.equal(touched, false);
});

// ─── Cursor CLI chat title ──────────────────────────────────────────────────

test('a CLI chat title is used when there is no composer record', () => {
  const name = resolveSessionName('cli-1', {
    composerData: null, cliMeta: { title: 'Usage Limits Statusline', name: 'Usage Limits Statusline' }, ...NO_EVENTS,
  });
  assert.equal(name, 'Usage Limits Statusline');
});

test('store.db name is the second CLI choice', () => {
  const name = resolveSessionName('cli-1', { composerData: null, cliMeta: { title: null, name: 'Beezi Me' }, ...NO_EVENTS });
  assert.equal(name, 'Beezi Me');
});

test('the CLI placeholder "New Agent" is never reported as a name', () => {
  const name = resolveSessionName('cli-1', { composerData: null, cliMeta: { title: null, name: 'New Agent' }, ...NO_EVENTS });
  assert.equal(name, null);
});

test('the CLI placeholder falls through to the prompt fallbacks', () => {
  const name = resolveSessionName('cli-1', {
    composerData: null,
    cliMeta: { title: null, name: 'New Agent' },
    readEvents: () => [{ ev: 'prompt', text: 'run two subagents' }],
  });
  assert.equal(name, 'run two subagents');
});

test('composer name still wins over the CLI title', () => {
  const name = resolveSessionName('x', { composerData: { name: 'IDE' }, cliMeta: { title: 'CLI' }, ...NO_EVENTS });
  assert.equal(name, 'IDE');
});

test('a CLI title outranks the sidecar prompt', () => {
  const name = resolveSessionName('cli-1', {
    composerData: null,
    cliMeta: { title: 'Renamed', name: 'New Agent' },
    readEvents: () => [{ ev: 'prompt', text: 'the first prompt' }],
  });
  assert.equal(name, 'Renamed');
});

test('a malformed CLI meta is ignored rather than trusted', () => {
  assert.equal(resolveSessionName('cli-1', { composerData: null, cliMeta: 'Renamed', ...NO_EVENTS }), null);
  assert.equal(resolveSessionName('cli-1', { composerData: null, cliMeta: { title: 42, name: '  ' }, ...NO_EVENTS }), null);
});

// Review Focus 1: an id in neither state.vscdb nor chats/ reports exactly what it did before.
test('an id with no composer record and no CLI chat resolves to null', () => {
  assert.equal(resolveSessionName('cli-1', { composerData: null, cliMeta: null, ...NO_EVENTS }), null);
});

// The reader is called with the resolver's deps, so the checkpoint's deadline bounds it. The fixture
// has a store.db and a counting sqlite, so "no open" is a real observation, not a missing file.
test('the deadline is forwarded to the CLI chat reader', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-name-cli-'));
  const id = '94046b93-0000-4000-8000-000000000001';
  const dir = path.join(root, 'workspacehash', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'From CLI' }));
  fs.writeFileSync(path.join(dir, 'store.db'), 'not a database');
  let opens = 0;
  const sqlite = {
    DatabaseSync: function () {
      opens += 1;
      throw new Error('open');
    },
  };
  // No NO_CLI here: cliMeta must be undefined for the disk reader to run at all.
  const base = { composerData: null, chatsDir: root, sqlite, ...NO_EVENTS };
  try {
    clearCliChatCache();
    assert.equal(resolveSessionName(id, base), 'From CLI');
    assert.ok(opens >= 1, 'the fixture store is opened when time is left');

    clearCliChatCache();
    opens = 0;
    assert.equal(resolveSessionName(id, { ...base, deadline: 0 }), null);
    assert.equal(opens, 0);
  } finally {
    clearCliChatCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
