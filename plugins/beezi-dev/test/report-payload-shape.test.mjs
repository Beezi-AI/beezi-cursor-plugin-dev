import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths-cursor.mjs';

// The wire contract for POST /sessions/report.
//
// The route is frozen — it is shared with the already-installed Claude Code and Codex plugins — and
// the server validates it as a WHITELIST: Nest's ValidationPipe rejects the whole request with
// `BadRequestException` if it carries a property the DTO does not declare. So an extra field is not
// forward-compatible extra data, it is a 400 that throws away the segment's tokens, cost, code
// changes and operations together, for every report, silently from the plugin's side.
//
// Adding a field here therefore requires a server change FIRST. This list is a copy of
// SessionReportRequestDto's properties.
const DTO_PROPERTIES = new Set([
  'segmentId', 'sessionId', 'remote', 'branch', 'from_line', 'to_line', 'models',
  'token_total', 'token_input', 'token_output', 'token_cache', 'duration_sec',
  'session_name', 'billing_source', 'subscription_type', 'rate_limit_tier', 'subscription_plan',
  'third_party_provider', 'timezone', 'started_at', 'ended_at', 'code_changes', 'operations',
  'is_subagent', 'agent_id', 'agent_type', 'agent_name', 'spawn_depth',
  // Plan §4 D. The session→subscription identity pair. Both were already declared on
  // SessionReportRequestDto before this client emitted either, which is what makes filling them a
  // client-only change to a frozen route. `account_uuid` is the SEAT id; the subscription id the
  // anchor also holds has no wire field and must never appear here.
  'account_uuid', 'account_email',
]);

// Every field the DTO marks @IsInt() @Min(0). A float or a NaN is a 400 exactly like an unknown key.
const NON_NEGATIVE_INTEGERS = ['from_line', 'to_line', 'token_total', 'token_input', 'token_output', 'token_cache', 'duration_sec'];

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-payload-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeGit(args) {
  if (args[0] === 'rev-parse') return '/repo';
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function queuedPayloads() {
  let files;
  try { files = fs.readdirSync(queueDir()); } catch { return []; }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));
}

// The real delta and the real reader — the point is the payload that actually goes on the wire.
// `options` reaches runCheckpoint's third parameter: `emitTimeline` is the turn-end path, and it is
// the only one that produces subagent segments (correlation is whole-session, so it needs the whole
// stream, which only a turn-end reads).
async function reportFor(options = {}) {
  return runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    {
      getAccessToken: async () => 'tok',
      gitImpl: fakeGit,
      fetchImpl: async () => { throw new Error('network disabled in test'); },
    },
    options,
  );
}

test('a report carries no property the server would reject', async (t) => {
  tmpHome(t);
  const home = process.env.BEEZI_CURSOR_HOME;
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: 1700000000000, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 19570, token_output: 181, token_cache_read: 19152, token_cache_write: 3 }),
      JSON.stringify({ ts: 1700000001000, ev: 'tool', tool: 'Read', bytes: 10, ms: 4 }),
      JSON.stringify({ ts: 1700000002000, ev: 'stop' }),
    ].join('\n') + '\n',
  );

  await reportFor();

  const [payload] = queuedPayloads();
  assert.ok(payload, 'a segment should have been queued');

  const extra = Object.keys(payload).filter((k) => !DTO_PROPERTIES.has(k));
  assert.deepEqual(extra, [], `these keys would 400 the whole report: ${extra.join(', ')}`);
});

test('the cache split rides inside models, never at the top level', async (t) => {
  tmpHome(t);
  const home = process.env.BEEZI_CURSOR_HOME;
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    JSON.stringify({ ts: 1700000000000, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 100, token_output: 10, token_cache_read: 40, token_cache_write: 2 }) + '\n',
  );

  await reportFor();
  const [payload] = queuedPayloads();

  // `models` is stored opaquely, so the read/write detail still reaches the server there.
  assert.equal(payload.token_cache, 42, 'the top level gets the sum the DTO accepts');
  // Same definition as the Claude Code plugin (token_input + token_output + token_cache) and as the
  // server's own usageTokenTotal. A different one would make the two agents' reports incomparable.
  assert.equal(payload.token_total, 100 + 10 + 42);
  assert.equal('token_cache_read' in payload, false);
  assert.equal('token_cache_write' in payload, false);
  const entry = Object.values(payload.models)[0];
  assert.equal(entry.token_cache_read, 40);
  assert.equal(entry.token_cache_creation, 2);
});

test('a subagent segment carries no property the server would reject either', async (t) => {
  tmpHome(t);
  const home = process.env.BEEZI_CURSOR_HOME;
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  // The parent writes nothing for ten minutes while the worker runs, which is what leaves the
  // subagent residual seconds to bill and therefore a segment to emit at all.
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: 1700000000000, ev: 'gen', model: 'm', gen_id: 'g1' }),
      JSON.stringify({ ts: 1700000001000, ev: 'subagent_start', sid: 'sa-1', stype: 'general-purpose', task: 'audit the parser' }),
      JSON.stringify({ ts: 1700000601000, ev: 'subagent_stop', task: 'audit the parser' }),
      JSON.stringify({ ts: 1700000602000, ev: 'stop' }),
    ].join('\n') + '\n',
  );

  await reportFor({ emitTimeline: true });

  const subagent = queuedPayloads().find((p) => p.is_subagent);
  assert.ok(subagent, 'a subagent segment should have been queued');

  const extra = Object.keys(subagent).filter((k) => !DTO_PROPERTIES.has(k));
  assert.deepEqual(extra, [], `these keys would 400 the whole report: ${extra.join(', ')}`);

  // The four subagent fields this plugin can honestly fill, and the one it cannot. `spawn_depth` is
  // on the whitelist and would validate, but Cursor exposes only `parent_conversation_id` — which
  // separates depth-1 from depth-≥2 and nothing further — and never a subagent's own conversation
  // id, so the graph cannot be walked and any number here would be invented.
  assert.equal(subagent.is_subagent, true);
  assert.equal(typeof subagent.is_subagent, 'boolean', 'the pipe does no implicit conversion: "true" is a 400');
  assert.equal(subagent.agent_id, 'sa-1');
  assert.equal(subagent.agent_type, 'general-purpose');
  assert.equal(subagent.agent_name, 'audit the parser');
  assert.equal('spawn_depth' in subagent, false);

  for (const field of NON_NEGATIVE_INTEGERS) {
    assert.ok(Number.isInteger(subagent[field]) && subagent[field] >= 0, `${field} must be a non-negative integer`);
  }
});

test('every whole-number field really is a non-negative integer', async (t) => {
  tmpHome(t);
  const home = process.env.BEEZI_CURSOR_HOME;
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'events', 'conv-1.jsonl'),
    [
      JSON.stringify({ ts: 1700000000000, ev: 'gen', model: 'm', gen_id: 'g1', token_input: 7, token_output: 3, token_cache_read: 5 }),
      JSON.stringify({ ts: 1700000000500, ev: 'stop' }),
    ].join('\n') + '\n',
  );

  await reportFor();
  const [payload] = queuedPayloads();

  for (const field of NON_NEGATIVE_INTEGERS) {
    const value = payload[field];
    assert.equal(typeof value, 'number', `${field} must be a number`);
    assert.ok(Number.isInteger(value), `${field} must be an integer, got ${value}`);
    assert.ok(value >= 0, `${field} must be >= 0, got ${value}`);
  }
});
