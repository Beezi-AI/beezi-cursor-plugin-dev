import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsFromHookPayload } from '../lib/sidecar-events.mjs';
import { computeDelta } from '../lib/delta-cursor.mjs';

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
