import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { base64url } from '../lib/base64url.mjs';

// Node 13.2 — the plugin's declared floor — has no `base64url` Buffer encoding (it arrived in
// 14.18/15.7). Every call site that reached for it produced `undefined`-shaped output there, so the
// PKCE verifier and the OAuth `state` were silently broken on the floor. This module is the
// replacement, and these tests pin it against BOTH the RFC 4648 §10 vectors and the native encoding
// on the modern Node the suite runs on, so the two can never drift.

// RFC 4648 §10 test vectors, with the standard alphabet's padding removed (RFC 7515 §2 base64url).
const RFC_4648 = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
];

test('matches the RFC 4648 vectors with padding stripped', () => {
  for (const [input, expected] of RFC_4648) {
    assert.equal(base64url(Buffer.from(input, 'utf-8')), expected, `vector ${JSON.stringify(input)}`);
  }
});

test('maps the two URL-unsafe alphabet characters', () => {
  // 0xfb 0xff 0xbf encodes to '+/+/' in the standard alphabet — both substitutions in one vector.
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0xfe]);
  assert.equal(bytes.toString('base64'), '+/+//g==');
  const out = base64url(bytes);
  assert.equal(out, '-_-__g');
  assert.ok(!/[+/=]/.test(out), 'no +, / or = survives');
});

test('agrees with the native base64url encoding for random inputs', () => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = crypto.randomBytes(length);
    assert.equal(base64url(bytes), bytes.toString('base64url'), `length ${length}`);
  }
});

test('accepts a plain Uint8Array, not only a Buffer', () => {
  const bytes = Uint8Array.from([102, 111, 111]);
  assert.equal(base64url(bytes), 'Zm9v');
});

test('produces the 43-character form PKCE and the OAuth state depend on', () => {
  assert.match(base64url(crypto.randomBytes(32)), /^[A-Za-z0-9_-]{43}$/);
  assert.match(base64url(crypto.randomBytes(16)), /^[A-Za-z0-9_-]{22}$/);
});
