import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventsFromHookPayload } from '../lib/sidecar-events.mjs';
import { computeDelta } from '../lib/delta-cursor.mjs';
import { clearCliChatCache } from '../lib/cli-chats-cursor.mjs';

// Cursor's `stop` payload carries the turn's model, its generation_id, and its
// aiserver.v1.TokenUsage. The plugin used to record only a bare `{ev:'stop'}` marker, so a turn
// that ran no tools reached the API as `models: {}` with zeroed tokens.

// The real payload, from a Cursor 3.14.7 hook execution log.
const STOP_PAYLOAD = Object.freeze({
  conversation_id: '3f538118-d862-41b9-9e42-35604b6e7525',
  generation_id: '3bba48ac-4405-41db-b68f-e7130a9ea982',
  model: 'gemini-3.5-flash',
  model_id: 'gemini-3.5-flash',
  status: 'completed',
  loop_count: 0,
  input_tokens: 19570,
  output_tokens: 181,
  cache_read_tokens: 19152,
  cache_write_tokens: 0,
  session_id: '3f538118-d862-41b9-9e42-35604b6e7525',
  hook_event_name: 'stop',
  cursor_version: '3.14.7',
  workspace_roots: ['/c:/Users/DmytroKuryshko/Documents/project-control'],
  user_email: 'someone@example.com',
});

test('a stop payload yields a generation carrying its model and tokens', () => {
  const [gen, ...rest] = eventsFromHookPayload(STOP_PAYLOAD);
  assert.deepEqual(rest, [], 'a stop payload names no tool, so it is one event');
  assert.deepEqual(gen, {
    ev: 'gen',
    model: 'gemini-3.5-flash',
    gen_id: '3bba48ac-4405-41db-b68f-e7130a9ea982',
    // The same id again under the reader's uniform name for "which host event wrote this line" —
    // what lets both hook registries stay installed without their copies being counted twice.
    eid: '3bba48ac-4405-41db-b68f-e7130a9ea982',
    token_input: 19570,
    token_output: 181,
    token_cache_read: 19152,
    token_cache_write: 0,
    // The observed host build, stamped from this very payload (UX-03). Two characters because it
    // rides on every line; absent entirely when the host sends nothing usable. It is a payload fact,
    // so both hook registries write it identically and their copies still collapse to one.
    cv: '3.14.7',
  });
  // And the address that sits beside it in the same payload does not travel. Nothing here needs it.
  assert.equal(JSON.stringify(gen).includes('someone@example.com'), false);
});

test('a tool call yields a generation with no token claim', () => {
  // postToolUse carries model and generation_id on the common envelope but no usage. Recording
  // zeros there would assert the turn used nothing.
  const [gen] = eventsFromHookPayload({
    conversation_id: 'c', generation_id: 'g1', model: 'gemini-3.5-flash',
    tool_name: 'Read', tool_output: 'x', duration: 5,
  });
  assert.equal(gen.ev, 'gen');
  assert.equal(gen.gen_id, 'g1');
  assert.equal('token_input' in gen, false);
});

test('a turn that ran no tools still reports its model', () => {
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [{ ts: 1, ...eventsFromHookPayload(STOP_PAYLOAD)[0] }, { ts: 2, ev: 'stop' }],
    readUsageData: () => null,
  });

  // This is the case that reached the API as models: {}.
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].model, 'gemini-3.5-flash');
  assert.equal(delta.entries[0].requests, 1);
  assert.deepEqual(delta.tokens, {
    token_input: 19570,
    token_output: 181,
    token_cache_read: 19152,
    token_cache_write: 0,
  });
});

test('one generation across many tool calls counts as one request', () => {
  // The envelope stamps model and generation_id on every postToolUse, so counting `gen` lines
  // reported one request per tool call and inflated the seat-covered bucket against usageData.
  const events = [{ ts: 1, ev: 'gen', model: 'm', gen_id: 'g1' }];
  for (let i = 0; i < 9; i++) {
    events.push({ ts: 2 + i, ev: 'gen', model: 'm', gen_id: 'g1' });
    events.push({ ts: 2 + i, ev: 'tool', tool: 'Read', bytes: 10, ms: 1 });
  }
  events.push({ ts: 100, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 500, token_output: 20 });

  const delta = computeDelta('conv-1', 0, { readEvents: () => events, readUsageData: () => null });
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.entries[0].requests, 1, 'eleven lines, one generation');
  // The turn-end line is the only one with counts, and it must not be lost to the earlier ones.
  assert.equal(delta.tokens.token_input, 500);
  assert.equal(delta.tokens.token_output, 20);
});

test('separate generations are separate requests and sum their tokens', () => {
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 100, token_output: 10 },
      { ts: 2, ev: 'gen', model: 'm', gen_id: 'g2', token_input: 200, token_output: 20 },
    ],
    readUsageData: () => null,
  });
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.tokens.token_input, 300);
  assert.equal(delta.tokens.token_output, 30);
});

test('a generation with no id is still counted on its own', () => {
  // Older sidecar lines, written before the id was recorded, must not collapse into one request.
  //
  // Seconds apart, not milliseconds: two lines this alike written inside the same second are now
  // read as one host event recorded twice by two hook registries, which is what they invariably
  // are — no two generations of one model start a millisecond apart. See test/event-dedupe.test.mjs.
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1_000, ev: 'gen', model: 'm' },
      { ts: 9_000, ev: 'gen', model: 'm' },
    ],
    readUsageData: () => null,
  });
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.tokens, null, 'no counts reported is null, never a zeroed total');
});

test('a model’s tokens are attributed to its rows and still sum to the total', () => {
  // credits and subscription split the same requests, so the rows split the model's tokens by
  // request share. What must hold is that the rows sum to what the segment reports — a per-model
  // breakdown that disagrees with the total is worse than no breakdown.
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 101, token_output: 7 },
      { ts: 2, ev: 'gen', model: 'm', gen_id: 'g2', token_input: 100, token_output: 6 },
      { ts: 3, ev: 'gen', model: 'm', gen_id: 'g3', token_input: 100, token_output: 7 },
    ],
    readUsageData: () => ({ m: { amount: 1, costInCents: 34 } }),
  });

  const pools = delta.entries.map((e) => e.billing_pool).sort();
  assert.deepEqual(pools, ['credits', 'subscription'], 'one priced request, two covered');

  const sum = (field) => delta.entries.reduce((t, e) => t + (e[field] ?? 0), 0);
  assert.equal(sum('token_input'), delta.tokens.token_input);
  assert.equal(sum('token_output'), delta.tokens.token_output);
  assert.equal(delta.tokens.token_input, 301);
  assert.equal(delta.tokens.token_output, 20);
});

test('a model’s tokens never leak onto another model’s rows', () => {
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1, ev: 'gen', model: 'a', gen_id: 'g1', token_input: 10 },
      { ts: 2, ev: 'gen', model: 'b', gen_id: 'g2', token_input: 500 },
    ],
    readUsageData: () => null,
  });
  const byModel = Object.fromEntries(delta.entries.map((e) => [e.model, e.token_input]));
  assert.deepEqual(byModel, { a: 10, b: 500 });
});

test('a window with no turn-end reports no token figure at all', () => {
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [{ ts: 1, ev: 'tool', tool: 'Read', bytes: 10, ms: 1 }],
    readUsageData: () => null,
  });
  // Null, not zeros: an unobserved figure reported as zero is indistinguishable from a real zero.
  assert.equal(delta.tokens, null);
});

// ---------------------------------------------------------------------------
// model vs model_id — the model itself, not the settings it was run at
// ---------------------------------------------------------------------------

// A real Cursor 3.14.27 stop payload for a model run with a reasoning parameter. `model` is the
// user-facing variant (id + the values of `model_params`), `model_id` is the model.
const PARAMETERIZED_STOP = Object.freeze({
  conversation_id: 'a087936a-c95c-4483-8845-2adebf965e9f',
  generation_id: '0446c4e0-2cf8-45ed-92d2-e5a9ec9287e2',
  model: 'kimi-k3-max',
  model_id: 'kimi-k3',
  model_params: [{ id: 'reasoning', value: 'max' }],
  status: 'completed',
  input_tokens: 19662,
  output_tokens: 45,
  cache_read_tokens: 3072,
  cache_write_tokens: 0,
  session_id: 'a087936a-c95c-4483-8845-2adebf965e9f',
  hook_event_name: 'stop',
  cursor_version: '3.14.27',
});

test('the generation records the model id, keeping the variant beside it', () => {
  const [gen] = eventsFromHookPayload(PARAMETERIZED_STOP);
  assert.equal(gen.model, 'kimi-k3', 'reporting "kimi-k3-max" makes one model read as several');
  assert.equal(gen.model_variant, 'kimi-k3-max', 'the variant is how Cursor keys its price records');
  assert.equal(gen.token_input, 19662);
});

test('a payload whose two model fields agree writes no redundant variant', () => {
  const [gen] = eventsFromHookPayload(STOP_PAYLOAD);
  assert.equal('model_variant' in gen, false);
});

test('a build that sends only `model` still names its model', () => {
  // model_id arrived in 3.14; every earlier payload has `model` alone, and it must keep working.
  const [gen] = eventsFromHookPayload({ conversation_id: 'c', generation_id: 'g', model: 'gpt-5' });
  assert.equal(gen.model, 'gpt-5');
  assert.equal('model_variant' in gen, false);
});

test('a price record keyed by the variant is still found for the model', () => {
  // The whole point of carrying the variant: requests bucket under "kimi-k3" while Cursor prices
  // "kimi-k3-max". Matching on the id alone would have called this spend seat-covered and lost the
  // charged dollars entirely.
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1, ev: 'gen', model: 'kimi-k3', model_variant: 'kimi-k3-max', gen_id: 'g1' },
      { ts: 2, ev: 'gen', model: 'kimi-k3', model_variant: 'kimi-k3-max', gen_id: 'g2' },
    ],
    readUsageData: () => ({ 'kimi-k3-max': { amount: 1, costInCents: 55 } }),
  });
  const credits = delta.entries.find((e) => e.billing_pool === 'credits');
  const subscription = delta.entries.find((e) => e.billing_pool === 'subscription');
  assert.equal(credits.model, 'kimi-k3');
  assert.equal(credits.requests, 1);
  assert.equal(credits.cost_usd, 0.55);
  assert.equal(subscription.requests, 1);
});

test('one model run at two settings sums both price records under the one model', () => {
  const delta = computeDelta('conv-1', 0, {
    readEvents: () => [
      { ts: 1, ev: 'gen', model: 'kimi-k3', model_variant: 'kimi-k3-max', gen_id: 'g1' },
      { ts: 2, ev: 'gen', model: 'kimi-k3', gen_id: 'g2' },
    ],
    readUsageData: () => ({
      'kimi-k3-max': { amount: 1, costInCents: 55 },
      'kimi-k3': { amount: 1, costInCents: 12 },
    }),
  });
  // Both records are consumed here, so the unobserved-model pass must not re-report either of them
  // as a model of its own.
  assert.deepEqual(delta.entries.map((e) => e.model), ['kimi-k3']);
  assert.equal(delta.entries[0].billing_pool, 'credits');
  assert.equal(delta.entries[0].requests, 2);
  assert.equal(delta.entries[0].cost_usd, 0.67);
});

// ---------------------------------------------------------------------------
// Cursor CLI: one model per generation, and Auto (`default`) resolved from the CLI chat store
// ---------------------------------------------------------------------------
//
// The CLI sends only the slug, and changes it WITHIN one generation: `default` on some lines, the
// bare model on postToolUse, the thinking/effort slug on `stop` (plan evidence E2/E3). Every spelling
// used to be its own model and its own request.

// Epoch milliseconds: a number below 1e12 is read as seconds by timestampOf.
const T = 1790000000000;

// `cliMeta: null, cliStoreFacts: null` keeps these tests off the real ~/.cursor: undefined would
// make computeDelta read the CLI store from disk. `extra` is merged over the defaults.
const computeDeltaFor = (events, extra = {}) =>
  computeDelta('conv-1', 0, {
    readEvents: () => events,
    readUsageData: () => null,
    cliMeta: null,
    cliStoreFacts: null,
    ...extra,
  });

const factsOf = (replyModels, complete = true) => ({ replyModels, childAgentIds: [], complete });
const requestsOf = (delta) => delta.entries.reduce((n, e) => n + e.requests, 0);
const tokenInputOf = (delta) => delta.entries.reduce((n, e) => n + (e.token_input ?? 0), 0);
const modelsOf = (delta) => [...new Set(delta.entries.map((e) => e.model))];
const TOKENS = (input) => ({ token_input: input, token_output: 1, token_cache_read: 0, token_cache_write: 0 });
const rowsOf = (delta) => delta.entries.map((e) => [e.model, e.billing_pool, e.requests, e.cost_usd]);

test('a CLI generation with default + variant lines is ONE request on the base model', () => {
  const events = [
    { ts: T + 1000, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' },
    { ts: T + 1001, ev: 'tool', tool: 'Read', bytes: 10, ms: 5, eid: 't1' },
    { ts: T + 1002, ev: 'gen', model: 'claude-opus-5', gen_id: 'g1', eid: 'g1' },
    { ts: T + 2000, ev: 'gen', model: 'claude-opus-5-thinking-high', gen_id: 'g1', eid: 'g1', ...TOKENS(100) },
    { ts: T + 2001, ev: 'stop' },
  ];
  const delta = computeDeltaFor(events);
  assert.deepEqual(modelsOf(delta), ['claude-opus-5']);
  assert.equal(requestsOf(delta), 1);
  assert.equal(tokenInputOf(delta), 100);
  // Resolved inside the window: nothing was left for the store to answer.
  assert.equal(delta.diagnostics.unresolvedAuto, 0);
});

test('print mode: slug spellings of one model under gen_id == conversation id are one request', () => {
  // `agent -p` stamps every turn with the conversation id (E7), so this is also what a multi-turn
  // headless session looks like. One request per session there is a host limitation, recorded in
  // the plan; what this pins is that the two spellings no longer read as two models.
  const events = [
    { ts: T + 1000, ev: 'gen', model: 'claude-opus-5', gen_id: 'conv', eid: 'conv' },
    { ts: T + 5000, ev: 'gen', model: 'claude-opus-5-thinking-high', gen_id: 'conv', eid: 'conv' },
  ];
  const delta = computeDeltaFor(events);
  assert.equal(requestsOf(delta), 1);
  assert.deepEqual(modelsOf(delta), ['claude-opus-5']);
});

test('the carried generation keys keep the `model\\ngen_id` format, on the base id', () => {
  const events = [
    { ts: T + 1000, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' },
    { ts: T + 2000, ev: 'gen', model: 'claude-opus-5-thinking-high', gen_id: 'g1', eid: 'g1' },
  ];
  // One key: the placeholder line was rewritten, so it is not a second identity to persist.
  assert.deepEqual(computeDeltaFor(events).countedGenerations, ['claude-opus-5\ng1']);
});

test('a generation split across two windows is billed once, whatever model each window saw', () => {
  const w1 = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' }];
  const d1 = computeDeltaFor(w1, { cliStoreFacts: factsOf(['model-a']) });
  assert.deepEqual(modelsOf(d1), ['model-a']);
  const w2 = [{ ts: T + 9, ev: 'gen', model: 'claude-opus-5-thinking-high', gen_id: 'g1', eid: 'g1', ...TOKENS(10) }];
  const d2 = computeDeltaFor(w2, {
    countedGenerations: d1.countedGenerations,
    cliStoreFacts: factsOf(['model-b', 'model-b']),
  });
  assert.equal(requestsOf(d1) + requestsOf(d2), 1);
  // The id was billed in window 1, so window 2 carries the tokens on a zero-request row of the
  // model ITS line named, rather than dropping them or counting the turn again.
  assert.equal(tokenInputOf(d2), 10);
  assert.deepEqual(d2.entries.map((e) => [e.model, e.requests]), [['claude-opus-5', 0]]);
});

test('carried generation keys written with a raw slug are honoured after the upgrade', () => {
  // A state file from the previous release holds the slug; the line is read under the base id now.
  const events = [
    { ts: T + 3000, ev: 'gen', model: 'claude-opus-5-thinking-high', gen_id: 'g9', eid: 'g9' },
  ];
  const delta = computeDeltaFor(events, { countedGenerations: ['claude-opus-5-thinking-high\ng9'] });
  assert.equal(requestsOf(delta), 0);
  // And the persisted list does not grow a second spelling of the same identity.
  assert.deepEqual(delta.countedGenerations, ['claude-opus-5\ng9']);
});

test('a carried key with no separator is kept as-is and bills nothing away', () => {
  const events = [{ ts: T + 1, ev: 'gen', model: 'm', gen_id: 'g1', eid: 'g1' }];
  const delta = computeDeltaFor(events, { countedGenerations: ['g1'] });
  assert.equal(requestsOf(delta), 1, 'a malformed key names no generation');
  assert.deepEqual(delta.countedGenerations, ['g1', 'm\ng1']);
});

test('an IDE stream with only the slug still finds its slug-keyed price record', () => {
  // Older IDE builds send `model: "kimi-k3-max"` with no model_id (E4). The request now buckets
  // under kimi-k3, and the raw slug is what still finds Cursor's per-slug price record.
  const delta = computeDeltaFor(
    [{ ts: T + 1, ev: 'gen', model: 'kimi-k3-max', gen_id: 'g1', eid: 'g1' }],
    { readUsageData: () => ({ 'kimi-k3-max': { amount: 3, costInCents: 12 } }) },
  );
  assert.deepEqual(rowsOf(delta), [['kimi-k3', 'credits', 3, 0.12]]);
});

test('delayed slug pricing with no gen line in the window is one row on the base id', () => {
  const delta = computeDeltaFor([{ ts: T + 1, ev: 'tool', tool: 'Read', bytes: 1, ms: 1 }], {
    readUsageData: () => ({
      'kimi-k3-max': { amount: 1, costInCents: 10 },
      'kimi-k3-high': { amount: 2, costInCents: 5 },
    }),
  });
  assert.deepEqual(rowsOf(delta), [['kimi-k3', 'credits', 3, 0.15]]);
});

test('a slug price record the window never named merges into its base model row', () => {
  const delta = computeDeltaFor(
    [{ ts: T + 1, ev: 'gen', model: 'kimi-k3', gen_id: 'g1', eid: 'g1' }],
    { readUsageData: () => ({ 'kimi-k3-max': { amount: 1, costInCents: 20 } }) },
  );
  assert.deepEqual(rowsOf(delta), [['kimi-k3', 'credits', 1, 0.2]]);
});

test('a resolved default generation never prices usage under a second model', () => {
  // The rewritten line has no slug of its own to match, so the concrete slug's price record is a
  // leftover; bucketed by base id it lands on the resolved model instead of a second row.
  const delta = computeDeltaFor(
    [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' }],
    {
      cliStoreFacts: factsOf(['cursor-grok-4.5-high']),
      readUsageData: () => ({ 'cursor-grok-4.5-high': { amount: 1, costInCents: 40 } }),
    },
  );
  assert.deepEqual(rowsOf(delta), [['cursor-grok-4.5', 'credits', 1, 0.4]]);
});

test('a placeholder is never a price variant of the model it resolved to', () => {
  // Were `default` recorded as a variant, a `default` price record would be folded into the
  // resolved model's spend. The resolved model keeps only what was priced under its own names.
  const delta = computeDeltaFor(
    [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' },
      { ts: T + 2, ev: 'gen', model: 'claude-opus-5', gen_id: 'g1', eid: 'g1' }],
    { readUsageData: () => ({ default: { amount: 1, costInCents: 7 } }) },
  );
  const opus = rowsOf(delta).filter((row) => row[0] === 'claude-opus-5');
  assert.deepEqual(opus, [['claude-opus-5', 'subscription', 1, 0]]);
});

// ── Auto resolution (plan Task 5 / Revision 3, R3) ──

test('an Auto session takes the model from unanimous CLI replies', () => {
  const events = [
    { ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g', ...TOKENS(5) },
    { ts: T + 2, ev: 'stop' },
  ];
  const delta = computeDeltaFor(events, {
    cliMeta: { lastUsedModel: 'default' },
    cliStoreFacts: factsOf(['cursor-grok-4.5-high', 'cursor-grok-4.5']),
  });
  assert.deepEqual(delta.entries.map((e) => e.model), ['cursor-grok-4.5']);
  assert.equal(delta.diagnostics.unresolvedAuto, 0);
});

test('lastUsedModel is used only when concrete, the scan is complete and no reply named a model', () => {
  const events = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }];
  const used = computeDeltaFor(events, {
    cliMeta: { lastUsedModel: 'claude-opus-5-thinking-high' },
    cliStoreFacts: factsOf([]),
  });
  assert.deepEqual(modelsOf(used), ['claude-opus-5']);

  const incomplete = computeDeltaFor(events, {
    cliMeta: { lastUsedModel: 'claude-opus-5' },
    cliStoreFacts: factsOf([], false),
  });
  assert.deepEqual(modelsOf(incomplete), ['default']);

  const placeholder = computeDeltaFor(events, { cliMeta: { lastUsedModel: 'default' }, cliStoreFacts: factsOf([]) });
  assert.deepEqual(modelsOf(placeholder), ['default']);

  // Replies that disagree are not overruled by the session's last pick.
  const mixed = computeDeltaFor(events, {
    cliMeta: { lastUsedModel: 'claude-opus-5' },
    cliStoreFacts: factsOf(['model-a', 'model-b']),
  });
  assert.deepEqual(modelsOf(mixed), ['default']);
});

test('mixed replies keep default and report it as unresolved', () => {
  const events = [
    { ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' },
    { ts: T + 2, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1', ...TOKENS(3) },
    { ts: T + 9, ev: 'gen', model: 'default', gen_id: 'g2', eid: 'g2' },
  ];
  const delta = computeDeltaFor(events, { cliStoreFacts: factsOf(['model-a-high', 'model-b']) });
  assert.deepEqual(modelsOf(delta), ['default']);
  // Per generation, not per line: two generations were left unnamed.
  assert.equal(delta.diagnostics.unresolvedAuto, 2);
  // A diagnostic, never a report field: an unknown key on an entry 400s the report.
  for (const entry of delta.entries) assert.equal('unresolvedAuto' in entry, false);
});

test('an incomplete store scan keeps default, even when the replies it saw agree', () => {
  const events = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }];
  const delta = computeDeltaFor(events, { cliStoreFacts: factsOf(['model-a'], false) });
  assert.deepEqual(modelsOf(delta), ['default']);
  assert.equal(delta.diagnostics.unresolvedAuto, 1);
});

test('with no CLI store the placeholder is kept, never invented', () => {
  const events = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }];
  const delta = computeDeltaFor(events);
  assert.deepEqual(modelsOf(delta), ['default']);
  assert.equal(delta.diagnostics.unresolvedAuto, 1);
});

test('a pulse window and the later turn-end window resolve one generation identically', () => {
  const pulse = computeDeltaFor([{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' }], {
    cliStoreFacts: factsOf(['cursor-grok-4.5-high']),
  });
  const turnEnd = computeDeltaFor(
    [{ ts: T + 60000, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1', ...TOKENS(50) }],
    {
      countedGenerations: pulse.countedGenerations,
      cliStoreFacts: factsOf(['cursor-grok-4.5-high', 'cursor-grok-4.5-high']),
    },
  );
  assert.deepEqual(modelsOf(pulse), ['cursor-grok-4.5']);
  assert.deepEqual(modelsOf(turnEnd), ['cursor-grok-4.5']);
  assert.equal(requestsOf(pulse) + requestsOf(turnEnd), 1);
  assert.equal(tokenInputOf(turnEnd), 50);
});

test('the turn-end window keeps the pulse window’s answer when the store has since drifted', () => {
  // By turn end the store can have outgrown the scan caps (complete:false) or gained a reply routed
  // elsewhere. The carried key already names the model this generation was billed under, and that
  // answer wins over a second look at the store, so the tokens do not land on a `default` row.
  const pulse = computeDeltaFor([{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1' }], {
    cliStoreFacts: factsOf(['model-a']),
  });
  const turnEnd = computeDeltaFor(
    [{ ts: T + 60000, ev: 'gen', model: 'default', gen_id: 'g1', eid: 'g1', ...TOKENS(50) }],
    { countedGenerations: pulse.countedGenerations, cliStoreFacts: factsOf(['model-a'], false) },
  );
  assert.deepEqual(turnEnd.entries.map((e) => [e.model, e.requests, e.token_input]), [['model-a', 0, 50]]);
  assert.equal(turnEnd.diagnostics.unresolvedAuto, 0);
});

test('the CLI store is not consulted when no placeholder survives the window', () => {
  let reads = 0;
  const spy = { get replyModels() { reads += 1; return []; }, childAgentIds: [], complete: true };
  computeDeltaFor(
    [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' },
      { ts: T + 2, ev: 'gen', model: 'claude-opus-5', gen_id: 'g', eid: 'g' }],
    { cliStoreFacts: spy },
  );
  assert.equal(reads, 0);
});

// ── the disk path: deadline forwarding and the reader's own contract ──

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;

function tmpChatsRoot(t) {
  clearCliChatCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-auto-'));
  t.after(() => {
    clearCliChatCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// A CLI store laid out as CLI 2026.09.18 writes it: blobs(id, data) and meta(key, value hex JSON).
function makeCliStore(root, chatId, blobs) {
  const dir = path.join(root, 'workspacehash', chatId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const meta = { name: 'New Agent', lastUsedModel: 'default', createdAt: T, blobEncryptionKey: 'SECRET' };
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta)).toString('hex'));
  const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  blobs.forEach((b, i) => ins.run(`b${i}`, Buffer.from(JSON.stringify(b), 'utf8')));
  db.close();
}

const reply = (modelName, padding = '') => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: padding, providerOptions: { cursor: { modelName } } },
    { type: 'text', text: 'ok' },
  ],
});

// Only the disk seams are given: cliMeta/cliStoreFacts are left undefined, so computeDelta reads.
const fromDisk = (events, extra) => computeDelta('conv-1', 0, {
  readEvents: () => events,
  readUsageData: () => null,
  ...extra,
});

test('the deadline is forwarded to the CLI store readers', (t) => {
  const root = tmpChatsRoot(t);
  const dir = path.join(root, 'workspacehash', 'conv-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.db'), 'placeholder');
  let opens = 0;
  const spySqlite = { DatabaseSync: function () { opens += 1; throw new Error('open'); } };
  const events = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }];

  const expired = fromDisk(events, { chatsDir: root, sqlite: spySqlite, deadline: 0 });
  assert.equal(opens, 0, 'an expired deadline opens nothing');
  assert.deepEqual(modelsOf(expired), ['default']);
  assert.equal(expired.diagnostics.unresolvedAuto, 1);

  clearCliChatCache();
  fromDisk(events, { chatsDir: root, sqlite: spySqlite });
  assert.ok(opens > 0, 'the control run does reach the store, so the zero above is the deadline');
});

test('the deadline is forwarded to the CLI meta reader too', (t) => {
  // A complete scan with no replies is the one case that asks for lastUsedModel, so the facts are
  // injected and only the meta read goes to disk.
  const root = tmpChatsRoot(t);
  const dir = path.join(root, 'workspacehash', 'conv-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.db'), 'placeholder');
  let opens = 0;
  const spySqlite = { DatabaseSync: function () { opens += 1; throw new Error('open'); } };
  const events = [{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }];
  const seams = { chatsDir: root, sqlite: spySqlite, cliStoreFacts: factsOf([]) };

  const expired = fromDisk(events, { ...seams, deadline: 0 });
  assert.equal(opens, 0, 'an expired deadline opens nothing');
  assert.deepEqual(modelsOf(expired), ['default']);

  clearCliChatCache();
  fromDisk(events, seams);
  assert.ok(opens > 0, 'the control run does reach the store, so the zero above is the deadline');
});

test('Auto resolves end to end from a CLI store on disk', { skip: !sqlite }, (t) => {
  const root = tmpChatsRoot(t);
  makeCliStore(root, 'conv-1', [
    { role: 'user', content: 'go' },
    reply('cursor-grok-4.5-high'),
    reply('cursor-grok-4.5-high'),
  ]);
  const delta = fromDisk([{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }], { chatsDir: root });
  assert.deepEqual(modelsOf(delta), ['cursor-grok-4.5']);
});

test('an oversized assistant row makes the store incomplete, so Auto stays default (R9)', { skip: !sqlite }, (t) => {
  // The skipped reply may have been routed elsewhere, so the one small reply is not a unanimous answer.
  const root = tmpChatsRoot(t);
  makeCliStore(root, 'conv-1', [
    reply('model-a-high'),
    reply('model-a-high', 'x'.repeat(300 * 1024)),
  ]);
  const delta = fromDisk([{ ts: T + 1, ev: 'gen', model: 'default', gen_id: 'g', eid: 'g' }], { chatsDir: root });
  assert.deepEqual(modelsOf(delta), ['default']);
  assert.equal(delta.diagnostics.unresolvedAuto, 1);
});
