import test from 'node:test';
import assert from 'node:assert/strict';
import { pickString } from '../lib/pick-field.mjs';

// The one behavioural change in the pickString deduplication: five copies became one, and two of
// them (operations-cursor, sidecar-events) probed the record UNGUARDED, so a null record threw
// there and answered null everywhere else. The merged leaf is guarded, and these pin that — a hook
// that throws on the payload it was handed is a hook that breaks the user's Cursor session.

test('a null or undefined record answers null instead of throwing', () => {
  assert.equal(pickString(null, ['model']), null);
  assert.equal(pickString(undefined, ['model']), null);
});

test('an empty or whitespace-only value is not an observation', () => {
  assert.equal(pickString({ model: '' }, ['model']), null);
  assert.equal(pickString({ model: '   ' }, ['model']), null);
});

test('the value that answers is trimmed', () => {
  assert.equal(pickString({ model: '  kimi-k3  ' }, ['model']), 'kimi-k3');
});

test('a non-string under an earlier field does not stop the probe', () => {
  assert.equal(pickString({ model: 7, modelName: 'kimi-k3' }, ['model', 'modelName']), 'kimi-k3');
  assert.equal(pickString({ model: 7 }, ['model']), null);
});

test('fields are probed in the order the caller listed them', () => {
  const record = { model: 'first', model_name: 'second' };
  assert.equal(pickString(record, ['model', 'model_name']), 'first');
  assert.equal(pickString(record, ['model_name', 'model']), 'second');
});
