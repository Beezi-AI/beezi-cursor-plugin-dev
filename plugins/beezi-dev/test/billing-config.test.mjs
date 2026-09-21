import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BILLING_SCHEMA_VERSION,
  normalizeAccountAnchor,
  readBillingConfig,
  writeBillingConfig,
  isStale,
  subscriptionReportFields,
} from '../lib/billing-config.mjs';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-billing-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME; else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('write then read round-trips the config', () => {
  withTempHome(() => {
    const cfg = { version: BILLING_SCHEMA_VERSION, source: 'subscription', plan: 'pro' };
    writeBillingConfig(cfg);
    assert.deepEqual(readBillingConfig(), cfg);
  });
});

test('readBillingConfig returns null when absent', () => {
  withTempHome(() => assert.equal(readBillingConfig(), null));
});

const DAY = 24 * 60 * 60 * 1000;

// `openai_api_key` and `cursor_credits` are the two members of the shared CliAgentBillingSource
// enum that matter here: one is not plan-bearing, the other is. The old fixture spelled
// `anthropic_api_key`, which is not a member of this plugin's vocabulary at all.
test('isStale — false for a source that bears no plan', () => {
  assert.equal(isStale({ source: 'openai_api_key' }), false);
  assert.equal(isStale({ source: 'third_party' }), false);
});

test('isStale — true when plan missing or unknown', () => {
  const now = Date.parse('2001-09-09T01:46:40.000Z');
  assert.equal(isStale({ source: 'subscription', capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'cursor_credits', plan: 'unknown', capturedAt: new Date(now).toISOString() }, now), true);
});

test('isStale — a credential expiry is no longer an input', () => {
  // Cursor exposes no vendor credential expiry, so a v1 record carrying one must not be able to
  // pin a machine into permanent staleness.
  const now = Date.parse('2001-09-09T01:46:40.000Z');
  const cfg = { version: 1, source: 'subscription', plan: 'pro', credentialsExpiresAt: now - 1, capturedAt: new Date(now).toISOString() };
  assert.equal(isStale(cfg, now), false);
});

test('isStale — true when older than the window, false when fresh', () => {
  const now = Date.parse('2001-09-09T01:46:40.000Z');
  const fresh = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 1 * DAY).toISOString() };
  const old = { source: 'subscription', plan: 'pro', capturedAt: new Date(now - 8 * DAY).toISOString() };
  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
});

test('subscriptionReportFields — populated for every plan-bearing source, empty otherwise', () => {
  const cfg = { subscriptionType: 'pro', rateLimitTier: 'default', plan: 'pro' };
  assert.deepEqual(subscriptionReportFields('subscription', cfg), {
    subscription_type: 'pro',
    rate_limit_tier: 'default',
    subscription_plan: 'pro',
  });
  assert.deepEqual(subscriptionReportFields('cursor_credits', cfg), {
    subscription_type: 'pro',
    rate_limit_tier: 'default',
    subscription_plan: 'pro',
  });
  assert.deepEqual(subscriptionReportFields('openai_api_key', cfg), {});
  assert.deepEqual(subscriptionReportFields('subscription', null), {});
});

// A1: a key with no value is OMITTED, never sent as an explicit null. The two are different
// instructions to the upsert on the other end - absent means "I have nothing to say about this
// column", null means "set this column to null" - and a plan-less machine now reaches the report
// path on every session start, where at baseline only the manual CLI wrote billing.json. Emitting
// three explicit nulls per report would have the reconciler overwrite a plan the backend already
// knew about.
test('subscriptionReportFields — a key with no value is omitted, not sent as null', () => {
  assert.deepEqual(subscriptionReportFields('subscription', {}), {});
  assert.deepEqual(subscriptionReportFields('subscription', {
    subscriptionType: null, rateLimitTier: null, plan: null,
  }), {});
  // Partial knowledge sends only what it knows.
  assert.deepEqual(subscriptionReportFields('subscription', { plan: 'pro' }), { subscription_plan: 'pro' });
  const partial = subscriptionReportFields('subscription', { subscriptionType: 'pro', plan: undefined });
  assert.deepEqual(partial, { subscription_type: 'pro' });
  assert.equal('subscription_plan' in partial, false);
  assert.equal('rate_limit_tier' in partial, false);
});

test('isStale — self-reported plan never goes stale by age', () => {
  const now = Date.parse('2001-09-09T01:46:40.000Z');
  const old = {
    source: 'subscription',
    plan: 'ultra',
    selfReported: true,
    capturedAt: new Date(now - 400 * DAY).toISOString(),
  };
  assert.equal(isStale(old, now), false);
});

test('isStale — self-reported config with missing or unknown plan is still stale', () => {
  const now = Date.parse('2001-09-09T01:46:40.000Z');
  assert.equal(isStale({ source: 'subscription', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
  assert.equal(isStale({ source: 'subscription', plan: 'unknown', selfReported: true, capturedAt: new Date(now).toISOString() }, now), true);
});

// ── v3: the account anchor carries an identity, not just an address ────────────────────────────

test('an anchor accepts an id with no email, and an email with no id', () => {
  // Both halves are real populations: a machine whose Cursor has cached no address still has a
  // signed-in id, and every record written before v3 — plus every CLI-config machine — has only an
  // address. Requiring both would throw away the stronger half of each.
  const idOnly = normalizeAccountAnchor({ accountId: 'auth0|seat_1', source: 'state_vscdb' });
  assert.equal(idOnly.accountId, 'auth0|seat_1');
  assert.equal(idOnly.email, null);

  const emailOnly = normalizeAccountAnchor({ email: 'Dev@Example.com', source: 'cli_config' });
  assert.equal(emailOnly.email, 'dev@example.com');
  assert.equal(emailOnly.accountId, null);

  assert.equal(normalizeAccountAnchor({ accountId: 'auth0|seat_1' }), null, 'a source is still mandatory');
});

test('an anchor id is stored verbatim — never split, prefixed away or capped', () => {
  const samlpId = `samlp|${new Array(101).join('c')}|${new Array(82).join('u')}@example.com`;
  const anchor = normalizeAccountAnchor({ accountId: samlpId, subscriptionId: '  sub_a  ', source: 'state_vscdb' });
  assert.equal(anchor.accountId, samlpId);
  assert.equal(anchor.accountId.length, 200, 'a truncated id is a wrong id, and a wrong id is a phantom row');
  assert.equal(anchor.subscriptionId, 'sub_a', 'trimmed, and nothing more');
  assert.equal(normalizeAccountAnchor({ accountId: '   ', source: 'state_vscdb' }).accountId, null);
  assert.equal(normalizeAccountAnchor({ accountId: 42, source: 'state_vscdb' }).accountId, null);
});

test('the record round-trips the v3 fields through disk', () => {
  withTempHome(() => {
    const cfg = {
      version: BILLING_SCHEMA_VERSION,
      source: 'subscription',
      plan: 'pro',
      subscriptionStatus: 'active',
      accountAnchor: { email: 'dev@example.com', accountId: 'auth0|seat_1', subscriptionId: 'sub_a', source: 'state_vscdb' },
    };
    writeBillingConfig(cfg);
    assert.deepEqual(readBillingConfig(), cfg);
  });
});
