import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionName } from '../lib/session-name-cursor.mjs';

const NO_EVENTS = { readEvents: () => [] };

test('composerData.name is the preferred title', () => {
  const name = resolveSessionName('conv-1', {
    composerData: { name: 'Fix the parser' },
    readEvents: () => [{ ev: 'prompt', text: 'a prompt nobody should see' }],
  });
  assert.equal(name, 'Fix the parser');
});

test('alternate title spellings are accepted', () => {
  assert.equal(resolveSessionName('conv-1', { composerData: { title: 'Refactor' }, ...NO_EVENTS }), 'Refactor');
  assert.equal(
    resolveSessionName('conv-1', { composerData: { composerTitle: 'Ship it' }, ...NO_EVENTS }),
    'Ship it',
  );
});

test('the first sidecar prompt is the fallback when there is no title', () => {
  const name = resolveSessionName('conv-1', {
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
    composerData: { messages: [{ role: 'user', content: 'Explain the reducer' }] },
    ...NO_EVENTS,
  });
  assert.equal(name, 'Explain the reducer');
});

test('a sidecar prompt outranks a composerData message', () => {
  const name = resolveSessionName('conv-1', {
    composerData: { messages: [{ role: 'user', text: 'stale' }] },
    readEvents: () => [{ ev: 'prompt', text: 'live' }],
  });
  assert.equal(name, 'live');
});

test('the name is truncated to 200 characters', () => {
  const long = 'x'.repeat(500);
  assert.equal(resolveSessionName('conv-1', { composerData: { name: long }, ...NO_EVENTS }).length, 200);
  assert.equal(
    resolveSessionName('conv-1', { composerData: {}, readEvents: () => [{ ev: 'prompt', text: long }] }).length,
    200,
  );
});

test('a blank title falls through instead of becoming the name', () => {
  const name = resolveSessionName('conv-1', {
    composerData: { name: '   ' },
    readEvents: () => [{ ev: 'prompt', text: 'the real prompt' }],
  });
  assert.equal(name, 'the real prompt');
});

test('an unreadable conversation record yields null, not an empty string', () => {
  assert.equal(resolveSessionName('conv-1', { composerData: null, ...NO_EVENTS }), null);
});

test('a composerData whose fields all moved yields null rather than a fabricated name', () => {
  const name = resolveSessionName('conv-1', {
    composerData: { composerName: 'Fix the parser', turns: [{ speaker: 'user', body: 'hi' }] },
    ...NO_EVENTS,
  });
  assert.equal(name, null);
});

test('a throwing event reader does not break the name resolution', () => {
  const name = resolveSessionName('conv-1', {
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
      readEvents: () => {
        touched = true;
        return [];
      },
    }),
    null,
  );
  assert.equal(touched, false);
});
