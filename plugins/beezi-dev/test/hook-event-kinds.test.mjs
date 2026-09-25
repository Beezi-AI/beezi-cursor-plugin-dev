import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsFromHookPayload } from '../lib/sidecar-events.mjs';
import { computeDelta, dedupeEvents } from '../lib/delta-cursor.mjs';
import { computeSessionTimeline } from '../lib/session-timeline-cursor.mjs';

// The event kinds `beforeMCPExecution`, `subagentStart` and `subagentStop` put in the sidecar.
//
// All three are built in one pass, before anything consumes them, because the shapes are the
// contract three later features are written against — MCP server attribution, subagent accounting,
// and the joins between them. What is asserted here is the shape ITSELF, verbatim, not just that
// something plausible comes out: a field renamed after those features land is a silent data loss on
// every machine that already wrote the old spelling.

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const CONV = 'conv-kinds';

const delta = (events) =>
  computeDelta(CONV, 0, {
    readEvents: () => events,
    readUsageData: () => null,
    aiCodeTrackingDbFile: null,
  });

// ---------------------------------------------------------------------------
// beforeMCPExecution — the server side channel
// ---------------------------------------------------------------------------
//
// Cursor's payload is `{tool_name, tool_input}` — tool_input is a JSON STRING — plus EITHER `{url}`
// for a remote server OR `{command}` for a stdio one. There is no server NAME field anywhere in it,
// which is the whole reason this event exists: the fallback everything uses today splits the
// flattened `mcp_<server>_<tool>` at its first underscore, and for this plugin's own tools that
// gives the server "plugin".

const REMOTE_MCP = Object.freeze({
  hook_event_name: 'beforeMCPExecution',
  tool_name: 'mcp_plugin_beezi_beezi_create_ticket',
  tool_input: '{"title":"x"}',
  url: 'https://mcp.beezi.dev/sse?token=sk-live-must-never-be-logged',
  conversation_id: CONV,
});

const STDIO_MCP = Object.freeze({
  hook_event_name: 'beforeMCPExecution',
  tool_name: 'mcp_context7_query_docs',
  tool_input: '{"q":"x"}',
  command: 'npx -y @upstash/context7-mcp --api-key sk-live-must-never-be-logged',
  conversation_id: CONV,
});

test('beforeMCPExecution emits the server side channel and nothing else', () => {
  assert.deepEqual(eventsFromHookPayload(REMOTE_MCP, { mcpServer: 'beezi' }), [
    { ev: 'mcp_server', tool: 'mcp_plugin_beezi_beezi_create_ticket', server: 'beezi' },
  ]);
});

test('the side channel carries no countable field, because postToolUse already counted the call', () => {
  const [event] = eventsFromHookPayload(REMOTE_MCP, { mcpServer: 'beezi' });
  // `bytes` and `ms` are what computeOperations reads. A second line carrying either would double
  // every MCP call in the operations breakdown and in est_tokens.
  assert.ok(!('bytes' in event));
  assert.ok(!('ms' in event));
  assert.ok(!('failed' in event));
});

test('no `tool` line is written for an MCP execution', () => {
  // `postToolUse` fires for the same call and writes the countable line. Two would be two calls.
  const kinds = eventsFromHookPayload(REMOTE_MCP, { mcpServer: 'beezi' }).map((e) => e.ev);
  assert.ok(!kinds.includes('tool'), `expected no tool line, got ${kinds.join(',')}`);
});

test('a stdio server’s launch command never reaches the sidecar', () => {
  // THE CONTRACT this module chose: the caller derives the server name and the raw url/command stays
  // out of the log. A stdio server is launched from an argv that routinely carries its own
  // credentials, and the sidecar is a plain-text file that outlives the session.
  const events = eventsFromHookPayload(STDIO_MCP, { mcpServer: 'context7' });
  assert.deepEqual(events, [
    { ev: 'mcp_server', tool: 'mcp_context7_query_docs', server: 'context7' },
  ]);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('sk-live'), 'a secret in the argv must not be written to telemetry');
  assert.ok(!serialized.includes('npx'));
  assert.ok(!events.some((e) => e.ev === 'shell'), 'and it must not be counted as a shell operation');
});

test('a remote server’s url — token and all — never reaches the sidecar either', () => {
  const events = eventsFromHookPayload(REMOTE_MCP, { mcpServer: 'beezi' });
  assert.ok(!JSON.stringify(events).includes('sk-live'));
  assert.ok(!JSON.stringify(events).includes('mcp.beezi.dev'));
});

test('the payload is recognised as MCP from hook_event_name even with no derived name', () => {
  // A caller that forwarded the payload without the option still must not double-count it. The
  // server is OMITTED rather than guessed — the joiner falls back to the flattened-name split.
  const events = eventsFromHookPayload(STDIO_MCP);
  assert.deepEqual(events, [{ ev: 'mcp_server', tool: 'mcp_context7_query_docs' }]);
});

test('the mcpServer option is authoritative even if Cursor renames the event', () => {
  const renamed = { ...STDIO_MCP, hook_event_name: 'beforeMcpToolExecution' };
  assert.deepEqual(eventsFromHookPayload(renamed, { mcpServer: 'context7' }), [
    { ev: 'mcp_server', tool: 'mcp_context7_query_docs', server: 'context7' },
  ]);
});

test('a call id is stamped as `eid`, which is the join key back to the tool line', () => {
  const [event] = eventsFromHookPayload(
    { ...REMOTE_MCP, tool_call_id: 'toolu_01' },
    { mcpServer: 'beezi' },
  );
  assert.deepEqual(event, {
    ev: 'mcp_server',
    tool: 'mcp_plugin_beezi_beezi_create_ticket',
    server: 'beezi',
    eid: 'toolu_01',
  });
});

test('an ordinary shell tool call is untouched by the MCP path', () => {
  // `tool_name` + `command` is exactly what a shell call looks like, which is why detection is not
  // field-driven here. The regression this guards is the reverse of the double-count: a shell call
  // silently reclassified as an MCP execution would stop being counted at all.
  const events = eventsFromHookPayload({
    hook_event_name: 'afterShellExecution',
    tool_name: 'run_terminal_cmd',
    command: 'git status',
  });
  assert.deepEqual(events.map((e) => e.ev), ['tool', 'shell']);
});

test('mcp_server is excluded from everything that counts operations', () => {
  const events = [
    { ts: T0, ev: 'mcp_server', tool: 'mcp_plugin_beezi_beezi_create_ticket', server: 'beezi' },
    { ts: T0 + 10, ev: 'tool', tool: 'mcp_plugin_beezi_beezi_create_ticket', bytes: 400, ms: 5, eid: 'toolu_01' },
  ];
  const result = delta(events);
  assert.equal(result.operations.mcp.count, 1, 'one MCP call, counted once — by the tool line');
  assert.equal(result.operations.other.count, 0, 'the side channel is not an operation of any kind');
  assert.equal(result.est_tokens, 100);
  assert.equal(result.code_changes.files_changed, 0);
  assert.equal(result.entries.length, 0);
});

test('two registries writing one MCP execution report one', () => {
  const line = { ts: T0, ev: 'mcp_server', tool: 'mcp_beezi_x', server: 'beezi', eid: 'toolu_01' };
  assert.equal(dedupeEvents([line, { ...line, ts: T0 + 7 }]).events.length, 1);
});

test('collapsing two id-less side-channel lines costs nothing', () => {
  // Without a call id, two calls to the same MCP tool inside one second collapse. Both lines assert
  // the identical fact — this tool belongs to this server — and neither is counted, so the identity
  // survives intact and the call count is unaffected (postToolUse owns that).
  const line = { ts: T0, ev: 'mcp_server', tool: 'mcp_beezi_x', server: 'beezi' };
  const { events } = dedupeEvents([line, { ...line, ts: T0 + 40 }]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], line);
});

// ---------------------------------------------------------------------------
// subagentStart / subagentStop
// ---------------------------------------------------------------------------

const SUBAGENT_START = Object.freeze({
  hook_event_name: 'subagentStart',
  subagent_id: 'sa_01',
  subagent_type: 'general-purpose',
  task: 'Find every caller of eventsFromHookPayload',
  parent_conversation_id: 'conv-parent',
  tool_call_id: 'toolu_task_01',
  is_parallel_worker: true,
  conversation_id: CONV,
});

const SUBAGENT_STOP = Object.freeze({
  hook_event_name: 'subagentStop',
  subagent_type: 'general-purpose',
  status: 'completed',
  task: 'Find every caller of eventsFromHookPayload',
  description: 'Ship the sidecar event foundation',
  duration_ms: 8123,
  message_count: 14,
  tool_call_count: 9,
  loop_count: 3,
  conversation_id: CONV,
});

test('subagentStart records every field Cursor really sends', () => {
  assert.deepEqual(eventsFromHookPayload(SUBAGENT_START), [
    {
      ev: 'subagent_start',
      sid: 'sa_01',
      stype: 'general-purpose',
      task: 'Find every caller of eventsFromHookPayload',
      parent: 'conv-parent',
      tool_call_id: 'toolu_task_01',
      eid: 'toolu_task_01',
      parallel: true,
    },
  ]);
});

test('parent_conversation_id is captured although nothing consumes it yet', () => {
  // It is the ONLY depth signal Cursor exposes — no nesting level, no parent subagent id, no tree
  // anywhere — and a sidecar that never captured it cannot be made to yield it later.
  const [event] = eventsFromHookPayload(SUBAGENT_START);
  assert.equal(event.parent, 'conv-parent');
});

test('subagentStop records what arrives and nothing that does not', () => {
  assert.deepEqual(eventsFromHookPayload(SUBAGENT_STOP), [
    {
      ev: 'subagent_stop',
      stype: 'general-purpose',
      status: 'completed',
      task: 'Find every caller of eventsFromHookPayload',
      duration_ms: 8123,
      message_count: 14,
      tool_call_count: 9,
      loop_count: 3,
    },
  ]);
});

test('the confirmed host bugs are encoded, not worked around', () => {
  const [start] = eventsFromHookPayload(SUBAGENT_START);
  const [stop] = eventsFromHookPayload(SUBAGENT_STOP);

  // `subagentStop` carries NO subagent_id. There is no join key back to start, and none is invented.
  assert.ok(!('sid' in stop), 'a fabricated join key is worse than an absent one');
  assert.equal(start.sid, 'sa_01');

  // `description` holds the PARENT's task title, not the subagent's. Recording it under a subagent
  // field would be believed by the next reader.
  assert.ok(!('description' in stop));
  assert.ok(!JSON.stringify(stop).includes('Ship the sidecar event foundation'));

  // `summary`, `modified_files`, `agent_transcript_path` and `subagent_model` are documented and
  // absent (or always null) in real payloads. Nothing here reads them.
  for (const absent of ['summary', 'modified_files', 'agent_transcript_path', 'subagent_model']) {
    assert.ok(!(absent in start) && !(absent in stop), `${absent} must not appear`);
  }

  // Cursor exposes no per-subagent token usage, so neither event may carry one.
  for (const field of ['token_input', 'token_output', 'token_cache_read', 'token_cache_write']) {
    assert.ok(!(field in start) && !(field in stop));
  }
});

test('a background subagent that never stops is the normal case, not a dropped event', () => {
  // Background subagents fire subagentStart and never fire subagentStop. Nothing may wait for a pair.
  const events = [{ ts: T0, ...eventsFromHookPayload(SUBAGENT_START)[0] }];
  const result = delta(events);
  assert.equal(result.diagnostics.schemaMiss, false);
  assert.deepEqual(result.diagnostics.unrecognizedEvents, []);
});

test('unobserved subagent counts are omitted rather than zeroed', () => {
  // A zero here reads downstream as a worker that ran instantly and did nothing — the same false
  // zero that suppressed the code_changes fallback for edits.
  const [event] = eventsFromHookPayload({
    hook_event_name: 'subagentStop',
    subagent_type: 'general-purpose',
    status: 'aborted',
  });
  assert.deepEqual(event, { ev: 'subagent_stop', stype: 'general-purpose', status: 'aborted' });
});

test('a subagent task is bounded, because a sidecar line is telemetry', () => {
  const [event] = eventsFromHookPayload({ ...SUBAGENT_START, task: 'x'.repeat(9000) });
  assert.equal(event.task.length, 2000);
});

test('a plain `stop` payload is never mistaken for a subagent completion', () => {
  // A turn-end payload carries `status` and `loop_count` too. Reading one as a subagent completion
  // would invent a subagent on every turn of every session — which is why the host's own
  // hook_event_name is authoritative here even when a field looks like a match.
  const events = eventsFromHookPayload({
    hook_event_name: 'stop',
    status: 'completed',
    loop_count: 4,
    model_id: 'claude-4.5-sonnet',
    generation_id: 'g1',
    input_tokens: 500,
    output_tokens: 20,
  });
  assert.deepEqual(events.map((e) => e.ev), ['gen']);
});

test('with no hook_event_name, subagent_id is the discriminator', () => {
  // The field-driven fallback for a build that stops stamping the envelope. `subagent_id` is the one
  // key subagentStart has and subagentStop provably has not.
  const { hook_event_name: _s, ...start } = SUBAGENT_START;
  const { hook_event_name: _e, ...stop } = SUBAGENT_STOP;
  assert.equal(eventsFromHookPayload(start)[0].ev, 'subagent_start');
  assert.equal(eventsFromHookPayload(stop)[0].ev, 'subagent_stop');
});

// ---------------------------------------------------------------------------
// subagent_stop and duplicate collapse — the loud part
// ---------------------------------------------------------------------------

test('two subagents finishing in the same second stay two events', () => {
  // The one that matters. `subagent_stop` carries no id of any kind, so dedupeEvents falls to its
  // content hash inside a one-second window — and `subagent_type` is a constant ("general-purpose"
  // whatever ran), so it distinguishes nothing. The counts are what separate them.
  const a = { ts: T0, ...eventsFromHookPayload(SUBAGENT_STOP)[0] };
  const b = {
    ts: T0 + 40,
    ...eventsFromHookPayload({ ...SUBAGENT_STOP, duration_ms: 8140, message_count: 11, tool_call_count: 4 })[0],
  };
  const { events, dropped } = dedupeEvents([a, b]);
  assert.equal(events.length, 2, 'two workers finished, not one recorded twice');
  assert.equal(dropped, 0);
});

test('differing only in the task is enough to stay two events', () => {
  const a = { ts: T0, ...eventsFromHookPayload({ ...SUBAGENT_STOP, task: 'audit lib/' })[0] };
  const b = { ts: T0 + 40, ...eventsFromHookPayload({ ...SUBAGENT_STOP, task: 'audit test/' })[0] };
  assert.equal(dedupeEvents([a, b]).events.length, 2);
});

test('differing only in loop_count is enough to stay two events', () => {
  // Which is why loop_count is recorded at all — every field the host really sends is entropy the
  // content key can use to tell two id-less completions apart.
  const a = { ts: T0, ...eventsFromHookPayload(SUBAGENT_STOP)[0] };
  const b = { ts: T0 + 40, ...eventsFromHookPayload({ ...SUBAGENT_STOP, loop_count: 7 })[0] };
  assert.equal(dedupeEvents([a, b]).events.length, 2);
});

test('KNOWN LIMITATION: two identical completions in one second collapse to one', () => {
  // Pinned, not papered over. Cursor sends no subagent_id on subagentStop, so two parallel workers
  // given the SAME task that finish in the same second having agreed on duration_ms, message_count,
  // tool_call_count and loop_count are indistinguishable in the payload, and one of them is dropped.
  //
  // This is deliberate and is the direction this engine fails in everywhere else: the alternative —
  // exempting subagent_stop from collapse — would DOUBLE every subagent on every machine with both
  // hook registries installed, which is now every machine. It goes away the moment Cursor puts an id
  // on the event; nothing else can fix it.
  const a = { ts: T0, ...eventsFromHookPayload(SUBAGENT_STOP)[0] };
  const { events, dropped } = dedupeEvents([a, { ...a, ts: T0 + 40 }]);
  assert.equal(events.length, 1);
  assert.equal(dropped, 1);

  // A second apart is the edge of the doubt, and beyond it they survive — so the loss is bounded to
  // genuinely simultaneous, genuinely identical completions.
  assert.equal(dedupeEvents([a, { ...a, ts: T0 + 1001 }]).events.length, 2);
});

test('a subagent_start is identified and collapses cleanly whatever the skew', () => {
  const line = { ts: T0, ...eventsFromHookPayload(SUBAGENT_START)[0] };
  assert.equal(line.eid, 'toolu_task_01');
  assert.equal(dedupeEvents([line, { ...line, ts: T0 + 45_000 }]).events.length, 1);
});

test('two parallel workers starting at once stay two, because start carries an id', () => {
  const a = { ts: T0, ...eventsFromHookPayload(SUBAGENT_START)[0] };
  const b = {
    ts: T0 + 3,
    ...eventsFromHookPayload({ ...SUBAGENT_START, subagent_id: 'sa_02', tool_call_id: 'toolu_task_02' })[0],
  };
  assert.equal(dedupeEvents([a, b]).events.length, 2);
});

// ---------------------------------------------------------------------------
// KNOWN_EVENTS
// ---------------------------------------------------------------------------

test('no new event kind trips the schemaMiss diagnostic', () => {
  // schemaMiss fires when a window holds events and recognises none, and the host surfaces it as a
  // broken sidecar. A turn that did nothing but fan out to workers produces exactly such a window.
  const events = [
    { ts: T0, ev: 'mcp_server', tool: 'mcp_beezi_x', server: 'beezi' },
    { ts: T0 + 1, ...eventsFromHookPayload(SUBAGENT_START)[0] },
    { ts: T0 + 2, ...eventsFromHookPayload(SUBAGENT_STOP)[0] },
  ];
  const result = delta(events);
  assert.equal(result.diagnostics.schemaMiss, false);
  assert.deepEqual(result.diagnostics.unrecognizedEvents, []);
  assert.equal(result.diagnostics.recognizedEvents, 3);
});

test('the new kinds are activity, so they still bound the segment', () => {
  const events = [
    { ts: T0, ...eventsFromHookPayload(SUBAGENT_START)[0] },
    { ts: T0 + 5_000, ...eventsFromHookPayload(SUBAGENT_STOP)[0] },
  ];
  const result = delta(events);
  assert.equal(result.duration_ms, 5_000);
  assert.equal(result.started_at, new Date(T0).toISOString());
});

// ---------------------------------------------------------------------------
// TURN_END_EVENTS — reported, not changed
// ---------------------------------------------------------------------------

test('a subagent finishing is NOT read as the user being handed control', () => {
  // TURN_END_EVENTS in lib/session-timeline-cursor.mjs is `{stop, session_start}` and matches on
  // exact equality, so `subagent_stop` is already excluded and the gap after one is classified
  // `working` — correctly: the parent agent is still running while its worker finishes.
  //
  // This test exists to keep it that way. That file belongs to a later round, and adding
  // `subagent_stop` to that set would bill the parent's own think-time to the user as `waiting_user`
  // on every fan-out.
  const timeline = computeSessionTimeline(CONV, {
    readEvents: () => [
      { ts: T0, ev: 'gen', model: 'm', gen_id: 'g1' },
      { ts: T0 + 1_000, ...eventsFromHookPayload(SUBAGENT_STOP)[0] },
      { ts: T0 + 2_000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1 },
    ],
  });
  assert.deepEqual(timeline.periods.map((p) => p.state), ['working']);

  const withRealStop = computeSessionTimeline(CONV, {
    readEvents: () => [
      { ts: T0, ev: 'gen', model: 'm', gen_id: 'g1' },
      { ts: T0 + 1_000, ev: 'stop' },
      { ts: T0 + 2_000, ev: 'tool', tool: 'read_file', bytes: 10, ms: 1 },
    ],
  });
  assert.deepEqual(withRealStop.periods.map((p) => p.state), ['working', 'waiting_user']);
});
