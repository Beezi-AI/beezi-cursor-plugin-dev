import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingSource, detectBillingSource, detectThirdPartyProvider, normalizePlan } from '../lib/billing.mjs';

test('a seat-covered segment is subscription-billed', () => {
  // There is no API-key mode and no third-party provider configuration: Cursor proxies every model
  // call through its own backend against the user's own account, so the only billing question is
  // which of that account's two money streams paid.
  assert.equal(detectBillingSource(), BillingSource.SUBSCRIPTION);
  assert.equal(detectBillingSource({}), BillingSource.SUBSCRIPTION);
  assert.equal(detectBillingSource({ usedCredits: false }), BillingSource.SUBSCRIPTION);
});

test('a segment that drew on credits is credit-billed', () => {
  // Reporting `subscription` unconditionally said "seat-covered" for every segment the user paid
  // real credits for — the one thing this plugin's cost design exists to never do.
  assert.equal(detectBillingSource({ usedCredits: true }), BillingSource.CURSOR_CREDITS);
});

test('an environment-shaped argument cannot be mistaken for a credits signal', () => {
  // The Claude Code and Codex forks pass `env` here. Cursor's signature is different on purpose, and
  // a stray env object must fall through to the seat rather than invent credit spend.
  assert.equal(detectBillingSource({ OPENAI_API_KEY: 'sk-x' }), BillingSource.SUBSCRIPTION);
  assert.equal(detectBillingSource({ ANTHROPIC_API_KEY: 'sk-y' }), BillingSource.SUBSCRIPTION);
});

test('normalizePlan maps Cursor tiers and rejects unknowns', () => {
  assert.equal(normalizePlan('pro'), 'pro');
  assert.equal(normalizePlan('Pro Plus'), 'pro_plus');
  assert.equal(normalizePlan('ULTRA'), 'ultra');
  assert.equal(normalizePlan('team_premium'), 'team_premium');
  assert.equal(normalizePlan('enterprise'), 'enterprise');
  assert.equal(normalizePlan('free'), 'free');
  // Cursor "Start" (₹649/mo, India) is non-USD and has no seat rate — a documented gap that must
  // land on 'unknown' rather than being silently folded into a paid tier.
  assert.equal(normalizePlan('start'), 'unknown');
  assert.equal(normalizePlan('mystery'), 'unknown');
  assert.equal(normalizePlan(null), 'unknown');
});

test('third-party provider is never detected — Cursor has none', () => {
  assert.equal(detectThirdPartyProvider(), null);
});
