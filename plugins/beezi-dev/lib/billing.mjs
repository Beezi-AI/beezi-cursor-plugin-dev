import { normalizeCursorPlan } from './cursor-account.mjs';

// The billing-source vocabulary shared with the Beezi API. Defined once so a stray literal typo in
// a comparison can't silently misclassify. THIRD_PARTY and OPENAI_API_KEY are unreachable from this
// plugin — they are kept so the enum stays a faithful mirror of the API's CliAgentBillingSource,
// which is what lets billing-config.mjs be shared verbatim across all three forks.
export const BillingSource = Object.freeze({
  THIRD_PARTY: 'third_party',
  OPENAI_API_KEY: 'openai_api_key',
  SUBSCRIPTION: 'subscription',
  CURSOR_CREDITS: 'cursor_credits',
});

// Cursor has no API-key mode and no third-party provider configuration — it proxies every model
// call through its own backend against the user's account — so its billing question is not "whose
// key paid" but "which of the account's two money streams paid": the seat's included allowance, or
// the on-demand credits billed once that allowance runs out.
//
// `subscription` was reported unconditionally, which said "seat-covered" for every segment a user
// paid real credits for. The segment's own pools are the only thing that can answer it, so they are
// what this reads: any credit-funded request in the window makes the segment a credits segment.
//
// This is a coarser statement than the per-row `billing_pool`, which stays the exact record of the
// split — one segment can be part seat, part credits, and only the rows can say how much of each.
//
// `signals` replaces the `env`/`deps` parameters the Claude Code and Codex forks take: those detect
// billing from the environment, this one from the delta, and neither call site passes the other's.
export function detectBillingSource(signals = {}) {
  return signals.usedCredits ? BillingSource.CURSOR_CREDITS : BillingSource.SUBSCRIPTION;
}

// Sources that still ride a paid seat and therefore still have a plan to name. Cursor bills
// on-demand credits ON TOP of the subscription, so a credit-funded segment is still a Pro/Business
// seat — a bare `=== SUBSCRIPTION` test drops the tier from exactly the segments where a user most
// wants to see what their seat did and did not cover.
//
// Owned here, beside the vocabulary it classifies, because three modules need the same answer
// (billing-config's report fields, billing-capture's stored plan, session-start's stale-plan
// nudge) and a fourth copy of the rule is how they start disagreeing.
const PLAN_BEARING = Object.freeze([BillingSource.SUBSCRIPTION, BillingSource.CURSOR_CREDITS]);

export function isPlanBearing(billingSource) {
  return PLAN_BEARING.includes(billingSource);
}

// The specific third-party provider vocabulary shared with the Beezi API.
export const ThirdPartyProvider = Object.freeze({
  AZURE: 'azure',
  GATEWAY: 'gateway',
});

// Cursor has no third-party provider configuration to detect. Returns null; kept for API symmetry
// with the other two plugins so `thirdPartyReportFields` needs no per-agent branch.
export function detectThirdPartyProvider(/* env = process.env */) {
  return null;
}

// Normalize to a Cursor plan label. `rateLimitTier` is unused (Cursor exposes none) but kept in the
// signature for parity with the report/capture flow.
export function normalizePlan(subscriptionType /*, rateLimitTier */) {
  return normalizeCursorPlan(subscriptionType);
}
