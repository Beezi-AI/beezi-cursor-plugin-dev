import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookInput, sanitizeCursorVersion } from '../lib/hook-input-cursor.mjs';
import { eventsFromHookPayload, cursorVersionOf, cursorVersionAt } from '../lib/sidecar-events.mjs';
import { dedupeEvents } from '../lib/delta-cursor.mjs';

// UX-03: the observed host build, carried from the hook payload through the sidecar so a replay can
// say which Cursor wrote a segment.
//
// The rule the whole feature rests on: this is an OBSERVATION, not a lookup. Nothing here may read
// the currently installed Cursor, and a segment replayed from last month must never be stamped with
// the version running today.

const VALID = ['1.2.3', '0.45.11', '2', '2.0.0-nightly.5', '1.0.0+build.9', '3.14.15-rc1'];
const MAX = `1${'a'.repeat(39)}`;

test('a well-formed version is preserved exactly, never coerced', () => {
  for (const value of VALID) assert.equal(sanitizeCursorVersion(value), value);
});

test('forty characters pass and forty-one do not', () => {
  assert.equal(MAX.length, 40);
  assert.equal(sanitizeCursorVersion(MAX), MAX);
  assert.equal(sanitizeCursorVersion(`${MAX}a`), undefined);
});

test('anything that is not a plain version string is absent, never repaired', () => {
  for (const value of [
    undefined, null, '', 'v1.2.3', '.1.2', '-1', 'x1', '1.2 3', '1.2\n3', '1.2\u00003',
    '1.2.3 ', ' 1.2.3', 'Cursor 1.2.3', '1.2.3é', 123, 1.23, true, [], ['1.2.3'],
    { version: '1.2.3' }, { toString: () => '1.2.3' },
  ]) {
    assert.equal(sanitizeCursorVersion(value), undefined, `value: ${JSON.stringify(value)}`);
  }
});

test('normalizeHookInput carries a valid cursor_version', () => {
  const input = normalizeHookInput({ session_id: 's1', cwd: '/r', cursor_version: '1.7.44' });
  assert.equal(input.cursor_version, '1.7.44');
});

test('an absent or malformed version leaves the key off entirely — unknown is not a value', () => {
  for (const payload of [
    { session_id: 's1', cwd: '/r' },
    { session_id: 's1', cwd: '/r', cursor_version: '' },
    { session_id: 's1', cwd: '/r', cursor_version: { major: 1 } },
    { session_id: 's1', cwd: '/r', cursor_version: 'v1.2.3' },
  ]) {
    assert.equal('cursor_version' in normalizeHookInput(payload), false);
  }
});

test('the camelCase spelling is read too', () => {
  assert.equal(normalizeHookInput({ session_id: 's1', cwd: '/r', cursorVersion: '1.7.44' }).cursor_version, '1.7.44');
});

test('user_email never leaves the payload — not through the input, not through a sidecar line', () => {
  // The live `stop` payload carries it. Nothing in this feature has any use for it, and a field that
  // identifies a person must not start travelling because a version field was added beside it.
  const payload = {
    session_id: 's1', cwd: '/r', cursor_version: '1.7.44', user_email: 'someone@example.com',
    model: 'gpt-5', generation_id: 'g1',
  };
  const input = normalizeHookInput(payload);
  assert.equal('user_email' in input, false);
  assert.equal(JSON.stringify(input).includes('example.com'), false);
  for (const event of eventsFromHookPayload(payload)) {
    assert.equal(JSON.stringify(event).includes('example.com'), false);
  }
});

// ---------------------------------------------------------------------------
// The sidecar stamp
// ---------------------------------------------------------------------------

test('every line a payload produces carries the observed version', () => {
  const events = eventsFromHookPayload({
    session_id: 's1', model: 'gpt-5', generation_id: 'g1', tool_name: 'read_file',
    tool_output: 'x', cursor_version: '1.7.44',
  });
  assert.ok(events.length >= 2);
  for (const event of events) assert.equal(cursorVersionOf(event), '1.7.44');
});

test('a malformed version stamps nothing rather than a repaired value', () => {
  const events = eventsFromHookPayload({ session_id: 's1', model: 'gpt-5', cursor_version: 'v1.2.3' });
  assert.equal(cursorVersionOf(events[0]), undefined);
  assert.equal('cv' in events[0], false);
});

test('the stamp is a payload fact, so both hook registries write the identical line', () => {
  // Content-based duplicate collapse is what lets both registries stay installed. A field that
  // differed between the two processes would stop every line collapsing and double the machine.
  const payload = { session_id: 's1', model: 'gpt-5', generation_id: 'g1', cursor_version: '1.7.44' };
  const bundled = eventsFromHookPayload(payload).map((e) => ({ ts: 1700000000000, ...e }));
  const launcher = eventsFromHookPayload(payload).map((e) => ({ ts: 1700000000007, ...e }));
  const { events, dropped } = dedupeEvents([...bundled, ...launcher]);
  assert.equal(dropped, bundled.length);
  assert.equal(events.length, bundled.length);
});

// ---------------------------------------------------------------------------
// Replay — the latest observation at or before the segment, never a later one
// ---------------------------------------------------------------------------

const line = (ts, cv) => ({ ts, ev: 'gen', model: 'gpt-5', ...(cv === undefined ? {} : { cv }) });

test('an old sidecar that never recorded a version reports none', () => {
  const events = [line(1), line(2), line(3)];
  assert.equal(cursorVersionAt(events), undefined);
  assert.equal(cursorVersionAt(events, 3), undefined);
});

test('the latest observation at or before the segment wins', () => {
  const events = [line(1, '1.0.0'), line(2), line(3, '1.1.0'), line(4)];
  assert.equal(cursorVersionAt(events, 1), '1.0.0');
  assert.equal(cursorVersionAt(events, 2), '1.0.0', 'an unstamped line does not erase what was observed');
  assert.equal(cursorVersionAt(events, 3), '1.1.0', 'the bound is exclusive, so a bound of 3 includes lines 0..2');
  assert.equal(cursorVersionAt(events, 4), '1.1.0');
  assert.equal(cursorVersionAt(events), '1.1.0');
});

test('replaying an earlier segment never borrows the version from a later one', () => {
  // A mixed-version session: the user upgraded Cursor mid-conversation. The first segment was
  // written by the old build and must keep saying so.
  const events = [line(1, '1.0.0'), line(2, '1.0.0'), line(3, '2.0.0'), line(4, '2.0.0')];
  assert.equal(cursorVersionAt(events, 2), '1.0.0');
  assert.equal(cursorVersionAt(events, 4), '2.0.0');
});

test('a segment before the first observation has none, rather than the first one seen', () => {
  const events = [line(1), line(2, '1.0.0')];
  assert.equal(cursorVersionAt(events, 1), undefined);
});

test('a version another writer put on a line is validated on the way out too', () => {
  const events = [{ ts: 1, ev: 'gen', cv: 'v9' }, { ts: 2, ev: 'gen', cv: { major: 9 } }, { ts: 3, ev: 'gen', cv: '9.9' }];
  assert.equal(cursorVersionAt(events, 2), undefined);
  assert.equal(cursorVersionAt(events, 3), '9.9');
});

test('a JSON round trip through the sidecar preserves the stamp', () => {
  const written = eventsFromHookPayload({ session_id: 's1', model: 'gpt-5', cursor_version: '1.7.44' })
    .map((e) => JSON.stringify({ ts: 1700000000000, ...e }))
    .join('\n');
  const readBack = written.split('\n').map((l) => JSON.parse(l));
  assert.equal(cursorVersionAt(readBack), '1.7.44');
});

test('an unusable bound means the whole array; a nonpositive one means nothing', () => {
  const events = [line(1, '1.0.0')];
  assert.equal(cursorVersionAt(events, 0), undefined);
  assert.equal(cursorVersionAt(events, -1), undefined);
  assert.equal(cursorVersionAt(events, 'all'), '1.0.0');
  assert.equal(cursorVersionAt(null, 1), undefined);
  assert.equal(cursorVersionAt('nope'), undefined);
});
