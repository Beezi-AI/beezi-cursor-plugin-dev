import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { computeSessionTimeline } from '../lib/session-timeline-cursor.mjs';
import { queueDir } from '../lib/paths-cursor.mjs';
import { CHECKIN_PAYLOAD_FIELDS } from '../lib/account-sync.mjs';

// M03.1 — the versioned wire contract, and the gates that are still open against it.
//
// This file does two things test/report-payload-shape.test.mjs deliberately does not:
//
//   1. it validates the FULL serialized main, subagent and timeline payloads against a fixture that
//      records the backend's accepted properties AND their types, lengths and enums — not just a
//      subset check of key names;
//   2. it states the known INCOMPATIBILITIES as gated expectations. A contract test that only
//      asserted what this client emits would be green on the day every Cursor report 400s, because
//      the client and the fixture would agree with each other and disagree with the server.
//
// The fixture's provenance block names the exact backend commit every rule below was transcribed
// from. That is a SOURCE SNAPSHOT: it proves what the schema says, never what a deployment accepts.
// Closing a gate needs a live authenticated check against the target environment.
//
// The payloads in the fixture are generated, never typed by hand — regenerate them with
// BEEZI_CONTRACT_FIXTURE_WRITE=1 after any change to the payload builders.

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'backend-contract.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

// One session that exercises every branch a report has: a generation with real token counts, a tool
// call, a file edit, a shell command, and a ten-minute subagent whose residual time only the
// interval union can bill.
const EVENTS = [
  { ts: T0, ev: 'prompt', cv: '3.14.7' },
  { ts: T0 + 1000, ev: 'gen', model: 'claude-4.5-sonnet', model_variant: 'claude-4.5-sonnet-thinking', gen_id: 'g1', cv: '3.14.7' },
  { ts: T0 + 2000, ev: 'tool', tool: 'read_file', bytes: 400, ms: 12, eid: 't1', cv: '3.14.7' },
  { ts: T0 + 3000, ev: 'edit', path: 'src/a.ts', added: 12, removed: 3, eid: 't2', cv: '3.14.7' },
  { ts: T0 + 4000, ev: 'shell', cmd: 'npm test', cv: '3.14.7' },
  { ts: T0 + 5000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit the parser', cv: '3.14.7' },
  { ts: T0 + 605000, ev: 'subagent_stop', stype: 'general-purpose', status: 'completed', task: 'audit the parser', cv: '3.14.7' },
  { ts: T0 + 606000, ev: 'gen', model: 'claude-4.5-sonnet', gen_id: 'g1', token_input: 19570, token_output: 181, token_cache_read: 19152, token_cache_write: 3, cv: '3.14.7' },
  { ts: T0 + 606000, ev: 'stop', status: 'completed', loop_count: 4, cv: '3.14.7' },
];

function fakeGit(args) {
  if (args[0] === 'rev-parse') return '/repo';
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

// Machine-dependent by construction: the IANA zone is where the developer is sitting and
// `generated_at` is the wall clock. Replaced rather than dropped, so a builder that stopped sending
// one would still fail the comparison.
function normalize(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  if ('timezone' in copy) copy.timezone = '(machine timezone)';
  // The epoch rather than a prose placeholder: `generated_at` is an ISO-8601 field on the wire, and
  // a placeholder that could not pass its own validation would hide a real formatting regression.
  if ('generated_at' in copy) copy.generated_at = '1970-01-01T00:00:00.000Z';
  return copy;
}

// The REAL pipeline: the real delta, the real reader, the real correlation, the real payload
// builders in lib/checkpoint.mjs. Nothing between the sidecar and the queue file is stubbed, which
// is the only way this says anything about what would go on the wire.
async function serializeAll(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-contract-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    EVENTS.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );

  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGit,
      fetchImpl: async () => { throw new Error('network disabled in test'); },
    },
    { emitTimeline: true },
  );

  const queued = fs.readdirSync(queueDir())
    .map((name) => JSON.parse(fs.readFileSync(path.join(queueDir(), name), 'utf-8')));
  return {
    main: normalize(queued.find((p) => !p.is_subagent)),
    subagent: normalize(queued.find((p) => p.is_subagent)),
    timeline: normalize({ sessionId: 'conv-1', ...computeSessionTimeline('conv-1') }),
  };
}

// ---------------------------------------------------------------------------
// The validator: the fixture's rules, applied the way the backend's pipe applies them
// ---------------------------------------------------------------------------

function checkValue(where, value, rule, schema) {
  const errors = [];
  const fail = (message) => errors.push(`${where}: ${message}`);
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') { fail(`must be a string, got ${typeof value}`); break; }
      if (rule.notEmpty && value === '') fail('must not be empty');
      if (rule.maxLength != null && value.length > rule.maxLength) fail(`longer than ${rule.maxLength}`);
      break;
    case 'iso8601':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        fail('must be an ISO-8601 timestamp');
      }
      break;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) { fail(`must be an integer, got ${JSON.stringify(value)}`); break; }
      if (rule.min != null && value < rule.min) fail(`must be >= ${rule.min}`);
      break;
    case 'boolean':
      // `transform: true` without implicit conversion: the string "true" is NOT coerced, it is a 400.
      if (typeof value !== 'boolean') fail(`must be a boolean, got ${typeof value}`);
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('must be an object');
      break;
    case 'enum':
      if (!rule.values.includes(value)) fail(`must be one of ${rule.values.join(', ')}`);
      break;
    case 'array':
      if (!Array.isArray(value)) { fail('must be an array'); break; }
      if (rule.maxItems != null && value.length > rule.maxItems) fail(`more than ${rule.maxItems} items`);
      value.forEach((item, index) => {
        errors.push(...validate(item, schema[rule.itemSchema], `${where}[${index}]`));
      });
      break;
    case 'modelUsageRecord':
      // The whole of the models gate, in the validator's own terms: an ARRAY is rejected here
      // exactly as IsModelUsageRecord rejects it.
      if (typeof value !== 'object' || value === null) { fail('must be an object'); break; }
      if (Array.isArray(value)) { fail('must be a Record, not an array'); break; }
      for (const [model, usage] of Object.entries(value)) {
        errors.push(...validate(usage, fixture.report.model_entry, `${where}.${model}`));
      }
      break;
    default:
      fail(`fixture has no rule type ${rule.type}`);
  }
  return errors;
}

function validate(payload, schema, where = 'payload') {
  const errors = [];
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return [`${where}: must be an object`];
  }
  const properties = schema.properties;
  for (const key of Object.keys(payload)) {
    if (!(key in properties)) errors.push(`${where}: unknown property ${key}`);
  }
  for (const [key, rule] of Object.entries(properties)) {
    const present = key in payload && payload[key] !== null && payload[key] !== undefined;
    if (!present) {
      if (rule.required) errors.push(`${where}: missing required property ${key}`);
      continue;
    }
    errors.push(...checkValue(`${where}.${key}`, payload[key], rule, schema));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The payloads themselves
// ---------------------------------------------------------------------------

test('the serialized payloads are byte-identical to the recorded contract fixture', async (t) => {
  const payloads = await serializeAll(t);
  if (process.env.BEEZI_CONTRACT_FIXTURE_WRITE === '1') {
    // Regeneration writes and stops. Asserting afterwards would compare the fresh payloads against
    // the fixture this process loaded BEFORE the write, so the regeneration run would always report
    // failures and the next person would read them as real ones.
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...fixture, payloads }, null, 2)}\n`);
    return;
  }
  assert.deepEqual(payloads.main, fixture.payloads.main);
  assert.deepEqual(payloads.subagent, fixture.payloads.subagent);
  assert.deepEqual(payloads.timeline, fixture.payloads.timeline);
});

test('the main segment validates against the recorded report schema', () => {
  assert.deepEqual(validate(fixture.payloads.main, fixture.report, 'main'), [
    // The one and only failure, and it is the open gate — see the `models-array-vs-record` entry.
    'main.models: must be a Record, not an array',
  ]);
});

test('the subagent segment validates against the same schema, and fails on the same one thing', () => {
  assert.deepEqual(validate(fixture.payloads.subagent, fixture.report, 'subagent'), [
    'subagent.models: must be a Record, not an array',
  ]);
});

test('the timeline payload validates clean', () => {
  assert.deepEqual(validate(fixture.payloads.timeline, fixture.timeline, 'timeline'), []);
});

test('every emitted property is one the recorded DTO declares', () => {
  const accepted = new Set(fixture.report.accepted_properties);
  for (const payload of [fixture.payloads.main, fixture.payloads.subagent]) {
    const extra = Object.keys(payload).filter((key) => !accepted.has(key));
    assert.deepEqual(extra, [], `an unknown top-level property 400s the whole report: ${extra.join(', ')}`);
  }
  const timelineAccepted = new Set(fixture.timeline.accepted_properties);
  const extraTimeline = Object.keys(fixture.payloads.timeline).filter((key) => !timelineAccepted.has(key));
  assert.deepEqual(extraTimeline, []);
});

test('the timeline states this client emits are all states the backend knows', () => {
  const known = new Set(fixture.timeline.known_states);
  for (const period of fixture.payloads.timeline.periods) {
    assert.ok(known.has(period.state), `unknown state ${period.state}`);
  }
  for (const period of fixture.payloads.timeline.periods) {
    assert.equal('waiting_subtype' in period, false, 'nothing produces a subtype on this host yet');
  }
});

// ---------------------------------------------------------------------------
// GATED expectations — the incompatibilities, asserted as they actually are
// ---------------------------------------------------------------------------

test('GATED: models is an array here and a Record on the backend — every Cursor report 400s', () => {
  // NOT a green assertion that the contract is satisfied. This records the exact, current
  // disagreement so that the day the backend (or this client) changes, this test fails and someone
  // reads the gate instead of discovering it from an empty dashboard.
  //
  // Backend: `models: Record<string, ICliAgentModelUsage>` with a validator whose first line is
  // `if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;`
  // (session-report.request.dto.ts:139-166, commit 871a788).
  // Client: an array, because one Cursor model in one segment can have a seat-covered row AND a
  // credits row, which a record keyed by model cannot hold.
  const gate = fixture.gates.find((g) => g.id === 'models-array-vs-record');
  assert.ok(gate, 'the gate must stay recorded in the fixture');
  assert.ok(gate.status.startsWith('OPEN'), 'closing this gate is a deployment fact, not a code change');

  assert.ok(Array.isArray(fixture.payloads.main.models), 'the client still emits an array');
  assert.deepEqual(
    checkValue('models', fixture.payloads.main.models, { type: 'modelUsageRecord' }, fixture.report),
    ['models: must be a Record, not an array'],
    'and the recorded backend rule still rejects it',
  );

  // The reason the array cannot simply be flattened: the pool split is real money.
  const pools = fixture.payloads.main.models.map((entry) => entry.billing_pool);
  assert.ok(pools.every((pool) => ['subscription', 'credits', 'unknown'].includes(pool)));
});

test('GATED: the cursor agent exists in the portal tree but on no proven deployment', () => {
  // The fixture used to claim `cursor` resolved to claude-code. That was true at the PINNED
  // snapshot 871a788 and is false at the portal working tree 62610eb, where BeeziAgent.CURSOR
  // exists and AGENT_BY_HEADER_VALUE maps the header value to it. The gate stays OPEN because
  // source proof is not deployment proof — which is the whole point of this file.
  const gate = fixture.gates.find((g) => g.id === 'cursor-agent-identity');
  assert.ok(gate && gate.status.startsWith('OPEN'));
  assert.ok(gate.closing_evidence.length > 0);
  assert.match(gate.what, /BeeziAgent\.CURSOR/, 'the corrected claim must stay recorded');
  assert.match(gate.status, /DEPLOYMENT UNVERIFIED/, 'what is still open here is deployment, not schema');
  assert.match(
    fixture.provenance.evidence.agent_resolver,
    /auth\.beezi-agent\.header\.unrecognised/,
    'only an absent or genuinely unrecognised header falls back to claude-code',
  );
});

test('GATED: break and waiting_subtype are schema-legal but unproven on the deployment', () => {
  const breakGate = fixture.gates.find((g) => g.id === 'timeline-break-state');
  const subtypeGate = fixture.gates.find((g) => g.id === 'timeline-waiting-subtype');
  assert.ok(breakGate.status.includes('DEPLOYMENT UNVERIFIED'));
  assert.ok(fixture.timeline.known_states.includes('break'));
  assert.ok(fixture.timeline.known_waiting_subtypes.includes('command_approval'));
  // `break` is emitted now (a user wait of BREAK_MS or more), so what this pins is narrower: the
  // recorded payload's periods are all short, and none of them may drift into the state by accident.
  const states = fixture.payloads.timeline.periods.map((period) => period.state);
  assert.equal(states.includes('break'), false);
});

test('GATED: the fields this lane derives exist in the DTO and are still not emitted', () => {
  const gate = fixture.gates.find((g) => g.id === 'data-lane-proposed-fields');
  assert.ok(gate && gate.status.includes('EMISSION GATED'));
  for (const field of ['claude_md_lines', 'context_peak_tokens', 'context_final_tokens', 'context_final_model']) {
    assert.ok(fixture.report.accepted_properties.includes(field), `${field} is declared`);
    assert.equal(field in fixture.payloads.main, false, `${field} must not be emitted yet`);
  }
  // There is no host-version property at any level, which is why `cursor_version` stays local.
  assert.equal(fixture.report.accepted_properties.includes('cursor_version'), false);
  assert.equal('cursor_version' in fixture.payloads.main, false);
});

// ---------------------------------------------------------------------------
// Rejection cases — the validator has to actually reject
// ---------------------------------------------------------------------------

test('an unknown top-level property is rejected', () => {
  const payload = { ...fixture.payloads.main, cursor_version: '3.14.7' };
  assert.ok(validate(payload, fixture.report).includes('payload: unknown property cursor_version'));
});

test('a wrong type is rejected, and the pipe does not convert it', () => {
  const stringBool = { ...fixture.payloads.subagent, is_subagent: 'true' };
  assert.ok(validate(stringBool, fixture.report).includes('payload.is_subagent: must be a boolean, got string'));

  const stringInt = { ...fixture.payloads.main, duration_sec: '6' };
  assert.ok(validate(stringInt, fixture.report).includes('payload.duration_sec: must be an integer, got "6"'));

  const floatInt = { ...fixture.payloads.main, token_total: 1.5 };
  assert.ok(validate(floatInt, fixture.report).includes('payload.token_total: must be an integer, got 1.5'));

  const negative = { ...fixture.payloads.main, from_line: -1 };
  assert.ok(validate(negative, fixture.report).includes('payload.from_line: must be >= 0'));
});

test('a value outside an enum is rejected', () => {
  const payload = { ...fixture.payloads.main, billing_source: 'cursor_credits' };
  assert.ok(validate(payload, fixture.report).some((e) => e.startsWith('payload.billing_source: must be one of')));
});

test('a string past its column width is rejected', () => {
  const payload = { ...fixture.payloads.subagent, agent_name: 'x'.repeat(201) };
  assert.ok(validate(payload, fixture.report).includes('payload.agent_name: longer than 200'));
});

test('a missing required property is rejected', () => {
  const payload = { ...fixture.payloads.main };
  delete payload.duration_sec;
  assert.ok(validate(payload, fixture.report).includes('payload: missing required property duration_sec'));
});

test('a model entry missing its token counts is rejected', () => {
  const models = { 'claude-4.5-sonnet': { token_input: 1, token_output: 1, token_cache_read: 1 } };
  const errors = checkValue('models', models, { type: 'modelUsageRecord' }, fixture.report);
  assert.ok(errors.includes('models.claude-4.5-sonnet: missing required property token_cache_creation'));
});

test('a timeline period with an empty or oversized state is rejected', () => {
  const empty = { ...fixture.payloads.timeline, periods: [{ state: '', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z' }] };
  assert.ok(validate(empty, fixture.timeline).includes('payload.periods[0].state: must not be empty'));

  const long = { ...fixture.payloads.timeline, periods: [{ state: 'x'.repeat(51), started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:01:00.000Z' }] };
  assert.ok(validate(long, fixture.timeline).includes('payload.periods[0].state: longer than 50'));
});

test('a timeline timestamp that is not ISO-8601 is rejected', () => {
  const payload = { ...fixture.payloads.timeline, generated_at: '17/09/2026' };
  assert.ok(validate(payload, fixture.timeline).includes('payload.generated_at: must be an ISO-8601 timestamp'));
});

// ---------------------------------------------------------------------------
// The account check-in route — the fixture side of it only
// ---------------------------------------------------------------------------
//
// Plan §4 B2a. This asserts the fixture RECORDS the route correctly AND that
// lib/account-sync.mjs's CHECKIN_PAYLOAD_FIELDS is a subset of it. The subset assertion was held
// back while the allowlist still carried the old, wrong names; B2 rewrote it to the server's
// vocabulary and the assertion now lives at the bottom of this file.

const ACCOUNT = fixture['me/cli-agent/account'];

test('the fixture records the account check-in route, with its own provenance', () => {
  assert.ok(ACCOUNT, 'a contract test for the check-in payload would otherwise assert against nothing');
  // Its own block, not the top-level one: this section came from a LATER tree than the pinned
  // snapshot, and saying so is the only thing that keeps both claims honest.
  assert.notEqual(ACCOUNT.provenance.backend_commit, fixture.provenance.backend_commit);
  assert.ok(ACCOUNT.provenance.deployment.startsWith('UNVERIFIED'));
  assert.deepEqual(ACCOUNT.accepted_properties, [
    'accountUuid',
    'email',
    'subscriptionType',
    'rateLimitTier',
    'subscriptionStatus',
    'keys',
  ]);
  // An empty body is a valid call, so nothing at the top level may be required.
  for (const [key, rule] of Object.entries(ACCOUNT.properties)) {
    assert.equal(rule.required, undefined, `${key} must stay optional`);
  }
});

test('the two properties the backend has not merged yet are marked as targets, not as fact', () => {
  // accountUuid's 255 bound (plan E5) and subscriptionStatus (plan E3) are in NO commit. Under
  // forbidNonWhitelisted, emitting subscriptionStatus against an undeployed tenant 400s the whole
  // check-in — so the marker is load-bearing, not decoration.
  const targets = Object.entries(ACCOUNT.properties)
    .filter(([, rule]) => rule.unverified_target === true)
    .map(([key]) => key);
  assert.deepEqual(targets.sort(), ['accountUuid', 'subscriptionStatus']);
  assert.equal(ACCOUNT.properties.accountUuid.maxLength, 255);
  assert.equal(ACCOUNT.properties.accountUuid.deployed_maxLength, 64, 'what the tree enforces today');
  assert.equal(ACCOUNT.properties.subscriptionStatus.maxLength, 32);
  assert.equal(ACCOUNT.provenance.unverified_target_rules.length, 2);
});

test('the account section validates payloads with the same validator as the report section', () => {
  // An empty body is valid, a known field is valid, an unknown field is a whole-request 400.
  assert.deepEqual(validate({}, ACCOUNT, 'checkin'), []);
  assert.deepEqual(
    validate({ accountUuid: 'auth0|user_01KESV726FDEFJEV6CX7GHWQ8T', email: 'a@b.com', subscriptionType: 'pro' }, ACCOUNT, 'checkin'),
    [],
  );
  assert.ok(validate({ plan: 'pro' }, ACCOUNT, 'checkin').includes('checkin: unknown property plan'));
  assert.ok(
    validate({ accountUuid: 'x'.repeat(256) }, ACCOUNT, 'checkin').includes('checkin.accountUuid: longer than 255'),
  );
  // The nested credential schema resolves through itemSchema, and its fields ARE required.
  const errors = validate({ keys: [{ kind: 'anthropic_api_key', prefix: 'sk-ant' }] }, ACCOUNT, 'checkin');
  assert.ok(errors.includes('checkin.keys[0]: missing required property last4'));
  assert.ok(
    validate({ keys: [{ kind: 'nope', prefix: 'p', last4: 'abcd' }] }, ACCOUNT, 'checkin')
      .some((e) => e.startsWith('checkin.keys[0].kind: must be one of')),
  );
});

test('the fixture still names the backend commit it was transcribed from', () => {
  assert.equal(fixture.provenance.backend_commit, '871a78842f9b7c20808e23b7bc61765886ce85cb');
  assert.ok(fixture.provenance.deployment.startsWith('UNVERIFIED'));
  assert.ok(Object.keys(fixture.provenance.evidence).length >= 10);
});

// The subset assertion the fixture exists for (plan §4 B2a). The check-in route runs under the
// server's global `ValidationPipe({whitelist: true, forbidNonWhitelisted: true})`, so ONE name the
// DTO does not declare is not a dropped field — it is a 400 for the whole check-in, which
// `checkInAccount` records as a silent FAILED. A key-name drift must therefore be caught here, in
// CI, and never on a user's machine.
test('every field the check-in client may send is one the recorded DTO accepts', () => {
  const accepted = new Set(ACCOUNT.accepted_properties);
  for (const field of CHECKIN_PAYLOAD_FIELDS) {
    assert.ok(accepted.has(field), `${field} is not accepted by POST /api/me/cli-agent/account`);
  }
  // And the allowlist is a strict SUBSET: `rateLimitTier` and `keys` are declared server-side but
  // have no Cursor equivalent, so this client never sends them.
  assert.equal(CHECKIN_PAYLOAD_FIELDS.includes('rateLimitTier'), false);
  assert.equal(CHECKIN_PAYLOAD_FIELDS.includes('keys'), false);
  // A payload built from the allowlist validates against the recorded matrix with the same
  // validator every other section uses.
  const payload = {};
  for (const field of CHECKIN_PAYLOAD_FIELDS) payload[field] = 'x';
  assert.deepEqual(validate(payload, ACCOUNT, 'checkin'), []);
});
