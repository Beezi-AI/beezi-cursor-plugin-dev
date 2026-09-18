import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTENSIBILITY_KEY,
  extensibilityNote,
  readExtensibility,
} from '../lib/extensibility.mjs';

// The single flag that decides whether ANY of a plugin's hooks and commands reach the agent.
// Cursor clears `pluginHooks` and skips `loadPluginCommands` when it is off, and logs one line
// about Claude Code while doing it — so a machine in this state looks like a broken plugin.

function rows(value) {
  return [{ key: EXTENSIBILITY_KEY, value, table: 'ItemTable' }];
}

test('a stored "false" reads as disabled', () => {
  assert.equal(readExtensibility({ readKeys: () => rows('false') }), false);
});

test('a stored "true" reads as enabled', () => {
  assert.equal(readExtensibility({ readKeys: () => rows('true') }), true);
});

test('booleans and 0/1 are accepted — the store is not typed', () => {
  assert.equal(readExtensibility({ readKeys: () => rows(false) }), false);
  assert.equal(readExtensibility({ readKeys: () => rows(true) }), true);
  assert.equal(readExtensibility({ readKeys: () => rows(0) }), false);
  assert.equal(readExtensibility({ readKeys: () => rows(1) }), true);
});

test('an absent key is Cursor’s default, which is on', () => {
  // Cursor only writes this key once the toggle has been touched, so "no row" is not "off".
  assert.equal(readExtensibility({ readKeys: () => [] }), true);
});

test('an unreadable store is null, never a guess', () => {
  // No node:sqlite, no Cursor install, locked database — all report "could not look", which the
  // status output must not print as "your setting is off".
  assert.equal(readExtensibility({ readKeys: () => null }), null);
  assert.equal(readExtensibility({ readKeys: () => { throw new Error('locked'); } }), null);
});

test('an unrecognised value does not masquerade as a setting', () => {
  assert.equal(readExtensibility({ readKeys: () => rows('maybe') }), null);
});

test('the note explains the consequence only when the flag is off', () => {
  assert.equal(extensibilityNote(true), null);
  assert.equal(extensibilityNote(null), null);
  const note = extensibilityNote(false);
  assert.match(note, /Rules, Skills/);
  assert.match(note, /hooks/i);
});
