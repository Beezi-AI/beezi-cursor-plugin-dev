import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseModelId, isPlaceholderModel } from '../lib/model-name-cursor.mjs';

test('thinking and effort suffixes are stripped from the right', () => {
  assert.equal(baseModelId('claude-opus-5-thinking-high'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-4-7-thinking-max'), 'claude-opus-4-7');
  assert.equal(baseModelId('gpt-5.6-terra-medium'), 'gpt-5.6-terra');
  assert.equal(baseModelId('cursor-grok-4.5-high'), 'cursor-grok-4.5');
  assert.equal(baseModelId('kimi-k3-max'), 'kimi-k3');
  assert.equal(baseModelId('claude-opus-5-xhigh'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-5-low'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-5-thinking'), 'claude-opus-5');
});

test('fast mode is stripped (user decision 2026-09-23)', () => {
  assert.equal(baseModelId('composer-2.5-fast'), 'composer-2.5');
  assert.equal(baseModelId('gpt-5.6-terra-high-fast'), 'gpt-5.6-terra');
});

test('suffix words match case-insensitively, the base keeps its own case', () => {
  assert.equal(baseModelId('Claude-Opus-5-Thinking-HIGH'), 'Claude-Opus-5');
});

test('context sizes and bracket params are stripped', () => {
  assert.equal(baseModelId('claude-opus-5-1m-thinking-high'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-5-300k'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-5[effort=high,context=300k]'), 'claude-opus-5');
  assert.equal(baseModelId('claude-opus-5[effort=high]'), 'claude-opus-5');
});

test('a bracket tail and slug suffixes combine, and whitespace before the bracket is dropped', () => {
  assert.equal(baseModelId('claude-opus-5-thinking[effort=high]'), 'claude-opus-5');
  assert.equal(baseModelId('  claude-opus-5 [effort=high]  '), 'claude-opus-5');
});

test('a slug that starts with a bracket is left alone rather than emptied', () => {
  assert.equal(baseModelId('[effort=high]'), '[effort=high]');
});

test('ids with no suffix are returned unchanged', () => {
  assert.equal(baseModelId('grok-4.7'), 'grok-4.7');
  assert.equal(baseModelId('composer-2.5'), 'composer-2.5');
  assert.equal(baseModelId('gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.equal(baseModelId('gpt-5-mini'), 'gpt-5-mini');
});

test('surrounding whitespace is trimmed', () => {
  assert.equal(baseModelId('  grok-4.7 '), 'grok-4.7');
});

test('a slug that is only suffix words is never stripped to nothing', () => {
  assert.equal(baseModelId('max'), 'max');
  assert.equal(baseModelId('high'), 'high');
  assert.equal(baseModelId('thinking-high'), 'thinking');
});

test('the internal separator of a version number is not a suffix boundary', () => {
  // `-5` and `-4-7` are version parts, never in the suffix vocabulary.
  assert.equal(baseModelId('claude-4.5-sonnet-thinking'), 'claude-4.5-sonnet');
});

test('a suffix word in the middle of the id is kept', () => {
  assert.equal(baseModelId('gpt-max-2'), 'gpt-max-2');
});

test('non-strings and blanks map to null', () => {
  assert.equal(baseModelId(null), null);
  assert.equal(baseModelId(undefined), null);
  assert.equal(baseModelId(''), null);
  assert.equal(baseModelId('   '), null);
  assert.equal(baseModelId(42), null);
  assert.equal(baseModelId({}), null);
});

test('placeholders are recognised case-insensitively', () => {
  assert.equal(isPlaceholderModel('default'), true);
  assert.equal(isPlaceholderModel('Default'), true);
  assert.equal(isPlaceholderModel(' default '), true);
  assert.equal(isPlaceholderModel('auto'), true);
  assert.equal(isPlaceholderModel('AUTO'), true);
  assert.equal(isPlaceholderModel('claude-opus-5'), false);
  assert.equal(isPlaceholderModel('default-model'), false);
  assert.equal(isPlaceholderModel(''), false);
  assert.equal(isPlaceholderModel(null), false);
  assert.equal(isPlaceholderModel(undefined), false);
  assert.equal(isPlaceholderModel(42), false);
});
