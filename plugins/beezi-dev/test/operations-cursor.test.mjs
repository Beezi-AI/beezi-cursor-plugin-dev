import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOperations, categoryOf, mcpServerOf, totalEstTokens } from '../lib/operations-cursor.mjs';

const tool = (name, bytes = 0) => ({ ts: 1, ev: 'tool', tool: name, bytes, ms: 5 });

test('maps every one of the seven categories from Cursor tool names', () => {
  const ops = computeOperations([
    tool('read_file', 40),
    tool('write'),
    tool('search_replace'),
    tool('codebase_search', 8),
    tool('grep'),
    tool('web_search', 20),
    tool('run_terminal_cmd', 400),
    tool('mcp_notion_search', 16),
    tool('todo_write'),
  ]);

  assert.equal(ops.file.count, 3);
  assert.equal(ops.file.est_tokens, 10); // 40 bytes / 4
  assert.equal(ops.search.count, 2);
  assert.equal(ops.search.est_tokens, 2);
  assert.equal(ops.internet.count, 1);
  assert.equal(ops.internet.est_tokens, 5);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.shell.est_tokens, 100);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.mcp.est_tokens, 4);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.skill.count, 0);
});

test('the emitted shape carries exactly the seven categories plus plugins', () => {
  const ops = computeOperations([tool('read_file')]);
  assert.deepEqual(
    Object.keys(ops).sort(),
    ['file', 'internet', 'mcp', 'other', 'plugins', 'search', 'shell', 'skill'],
  );
  assert.deepEqual(ops.skill.by_skill, {});
  // Diagnostics must not reach the wire: the payload has to stay identical to the other engines'.
  assert.equal(JSON.parse(JSON.stringify(ops)).diagnostics, undefined);
});

test('mcp tools are attributed to their server, and mirrored into plugins', () => {
  const ops = computeOperations([tool('mcp_notion_search', 40), tool('mcp_notion_fetch', 40), tool('mcp_jira_issue', 8)]);
  assert.equal(ops.mcp.count, 3);
  assert.equal(ops.mcp.by_server.notion.count, 2);
  assert.equal(ops.mcp.by_server.notion.est_tokens, 20);
  assert.equal(ops.mcp.by_server.jira.count, 1);
  assert.equal(ops.plugins.notion.count, 2);
  assert.equal(mcpServerOf('mcp_notion_search'), 'notion');
});

test('an unknown tool name lands in other and is reported, never dropped', () => {
  const ops = computeOperations([tool('some_future_tool', 40), tool('read_file')]);
  assert.equal(ops.other.count, 1);
  assert.equal(ops.other.est_tokens, 10);
  assert.equal(ops.mcp.count, 0); // Cursor prefixes its MCP tools, so unknown != mcp here
  assert.deepEqual(ops.diagnostics.unrecognized, ['some_future_tool']);
  assert.equal(ops.diagnostics.matched, 1);
});

test('a tool event whose name field moved signals the miss instead of reporting zero work', () => {
  // Every count is zero here, which is indistinguishable from "the user ran no tools" — the
  // diagnostics are the only thing that can tell the two apart.
  const ops = computeOperations([{ ts: 1, ev: 'tool', toolIdentifier: 'read_file', bytes: 40 }]);
  assert.equal(ops.file.count, 0);
  assert.equal(ops.diagnostics.toolEvents, 1);
  assert.equal(ops.diagnostics.unnamed, 1);
  assert.equal(ops.diagnostics.named, 0);
});

test('alternate name and byte spellings are tolerated', () => {
  const ops = computeOperations([{ ev: 'tool', tool_name: 'grep', output_bytes: 12 }]);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.search.est_tokens, 3);
});

test('failed tool calls still count as operations', () => {
  const ops = computeOperations([{ ev: 'tool', tool: 'run_terminal_cmd', bytes: 8, failed: true }]);
  assert.equal(ops.shell.count, 1);
});

test('non-tool events are ignored entirely', () => {
  const ops = computeOperations([
    { ev: 'gen', model: 'claude-4.5-sonnet' },
    { ev: 'edit', path: 'a.ts', added: 1, removed: 0 },
    { ev: 'shell', cmd: 'git status' },
  ]);
  assert.equal(ops.diagnostics.toolEvents, 0);
  assert.equal(totalEstTokens(ops), 0);
});

test('totalEstTokens sums every category', () => {
  const ops = computeOperations([tool('read_file', 40), tool('run_terminal_cmd', 40), tool('mcp_x_y', 40)]);
  assert.equal(totalEstTokens(ops), 30);
});

test('categoryOf rejects non-strings without throwing', () => {
  assert.equal(categoryOf(undefined), 'other');
  assert.equal(categoryOf(''), 'other');
  assert.equal(categoryOf(42), 'other');
});

// ---------------------------------------------------------------------------
// The `mcp_server` side channel — scripts/mcp-before.mjs writes one line per MCP execution naming
// the server it derived from the url/command only `beforeMCPExecution` carries.
// ---------------------------------------------------------------------------

const BEEZI_TOOL = 'mcp_plugin_beezi_beezi_create_ticket';
const side = (toolName, server) => ({
  ts: 1,
  ev: 'mcp_server',
  tool: toolName,
  ...(server === undefined ? {} : { server }),
});

test('the side channel names the server the flattened tool name cannot', () => {
  // The bug this replaces: splitting `mcp_plugin_beezi_beezi_create_ticket` at its first underscore
  // reports a server called "plugin", so every Beezi MCP call was attributed to a server that does
  // not exist. Both `by_server` and the top-level `plugins` cross-cut have to move together.
  const ops = computeOperations([side(BEEZI_TOOL, 'beezi'), tool(BEEZI_TOOL, 40)]);
  assert.equal(ops.mcp.count, 1, 'the side channel must not add a second countable call');
  assert.deepEqual(Object.keys(ops.mcp.by_server), ['beezi']);
  assert.equal(ops.mcp.by_server.beezi.count, 1);
  assert.equal(ops.mcp.by_server.beezi.est_tokens, 10);
  assert.deepEqual(Object.keys(ops.plugins), ['beezi']);
  assert.equal(ops.plugins.beezi.est_tokens, 10);
  // The old answer, kept only as the fallback.
  assert.equal(mcpServerOf(BEEZI_TOOL), 'plugin');
});

test('a tool the side channel never named still falls back to prefix inference', () => {
  // Every tool is in this state until `beforeMCPExecution` has fired once for its server — and all
  // of them stay in it if that event turns out never to fire under cursor-agent.
  const ops = computeOperations([side('mcp_notion_search', 'notion'), tool('mcp_notion_search', 8), tool('mcp_jira_issue', 8)]);
  assert.equal(ops.mcp.by_server.notion.count, 1);
  assert.equal(ops.mcp.by_server.jira.count, 1);
  assert.equal(ops.diagnostics.mcpAliased, 1);
  assert.equal(ops.diagnostics.mcpInferred, 1);
});

test('mcp_server events are counted by nothing', () => {
  // A side-channel line carries no `bytes` and no `ms` by construction, but the guarantee has to
  // hold even if one grew them: it is not a tool event, so nothing here may read it as work.
  const ops = computeOperations([
    side(BEEZI_TOOL, 'beezi'),
    { ts: 1, ev: 'mcp_server', tool: 'mcp_x_y', server: 'x', bytes: 4000, ms: 900 },
  ]);
  for (const category of ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other']) {
    assert.equal(ops[category].count, 0, `${category} counted a side-channel line`);
    assert.equal(ops[category].est_tokens, 0, `${category} charged tokens for a side-channel line`);
  }
  assert.deepEqual(ops.mcp.by_server, {});
  assert.deepEqual(ops.plugins, {});
  assert.equal(totalEstTokens(ops), 0);
  assert.equal(ops.diagnostics.toolEvents, 0);
  assert.deepEqual(ops.diagnostics.unrecognized, []);
});

test('the wire shape is unchanged by the join', () => {
  // The report DTO is validated with whitelist + forbidNonWhitelisted GLOBALLY: one unknown key
  // 400s the whole report, so the alias state must leave non-enumerably or not at all.
  const ops = computeOperations([side(BEEZI_TOOL, 'beezi'), tool(BEEZI_TOOL, 40)]);
  assert.deepEqual(
    Object.keys(ops).sort(),
    ['file', 'internet', 'mcp', 'other', 'plugins', 'search', 'shell', 'skill'],
  );
  assert.deepEqual(Object.keys(ops.mcp).sort(), ['by_server', 'count', 'est_tokens']);
  const wire = JSON.parse(JSON.stringify(ops));
  assert.equal(wire.mcpAliases, undefined);
  assert.equal(wire.diagnostics, undefined);
});

test('aliases carried in from an earlier window join a tool line that arrived alone', () => {
  // The cross-window miss: `beforeMCPExecution` fires before the call and `postToolUse` after it, so
  // a checkpoint boundary between them leaves the `tool` line in a window with no side channel.
  const ops = computeOperations([tool(BEEZI_TOOL, 40)], { mcpAliases: [[BEEZI_TOOL, 'beezi']] });
  assert.equal(ops.mcp.by_server.beezi.count, 1);
  assert.equal(ops.diagnostics.mcpAliased, 1);
  // The persisted form is the host's choice, so a Map and a plain object are read the same way.
  assert.equal(
    computeOperations([tool(BEEZI_TOOL)], { mcpAliases: new Map([[BEEZI_TOOL, 'beezi']]) }).mcp.by_server.beezi.count,
    1,
  );
  assert.equal(
    computeOperations([tool(BEEZI_TOOL)], { mcpAliases: { [BEEZI_TOOL]: 'beezi' } }).mcp.by_server.beezi.count,
    1,
  );
});

test('the alias map comes back out for the next window, coldest first and capped', () => {
  const seed = Array.from({ length: 70 }, (_, i) => [`mcp_t${i}`, `s${i}`]);
  const ops = computeOperations([side('mcp_t0', 's0-renamed')], { mcpAliases: seed });
  assert.equal(ops.mcpAliases.length, 64);
  // A tool seen again in this window moves to the hot end, so the cap never evicts what is in use.
  assert.deepEqual(ops.mcpAliases.at(-1), ['mcp_t0', 's0-renamed']);
  assert.deepEqual(ops.mcpAliases[0], ['mcp_t7', 's7']);
});

test('a side-channel line with no server never clobbers one that had it', () => {
  // `mcpServerFrom` returns null whenever the payload's url/command say nothing meaningful, and the
  // writer then omits `server`. That line asserts an absence of knowledge, not an absence of server.
  const ops = computeOperations(
    [side(BEEZI_TOOL, undefined), tool(BEEZI_TOOL, 8)],
    { mcpAliases: [[BEEZI_TOOL, 'beezi']] },
  );
  assert.equal(ops.mcp.by_server.beezi.count, 1);
  assert.equal(ops.mcp.by_server.plugin, undefined);
});

test('an aliased tool that is not mcp_-prefixed is still an MCP call', () => {
  // mcp-before.mjs runs on `beforeMCPExecution` and nothing else, so an alias is direct evidence of
  // an MCP tool — the rescue if a Cursor build ever stops flattening MCP names with the prefix.
  const ops = computeOperations([side('linear_create_issue', 'linear'), tool('linear_create_issue', 40)]);
  assert.equal(ops.mcp.count, 1);
  assert.equal(ops.other.count, 0);
  assert.equal(ops.mcp.by_server.linear.est_tokens, 10);
  assert.deepEqual(ops.diagnostics.unrecognized, []);
  // But an alias may not MOVE a call: a builtin stays where it belongs whatever the side channel says.
  const moved = computeOperations([side('read_file', 'linear'), tool('read_file', 40)]);
  assert.equal(moved.file.count, 1);
  assert.equal(moved.mcp.count, 0);
});

// ---------------------------------------------------------------------------
// Cursor CLI tool names. The CLI names its builtins in PascalCase (observed on 2026.09.18: Read,
// Write, Grep, Shell), so before this mapping every CLI tool call landed in `other`.

test('Cursor CLI PascalCase tool names are categorised', () => {
  assert.equal(categoryOf('Read'), 'file');
  assert.equal(categoryOf('Write'), 'file');
  assert.equal(categoryOf('StrReplace'), 'file');
  assert.equal(categoryOf('Delete'), 'file');
  assert.equal(categoryOf('LS'), 'file');
  assert.equal(categoryOf('Grep'), 'search');
  assert.equal(categoryOf('Glob'), 'search');
  assert.equal(categoryOf('Shell'), 'shell');
  assert.equal(categoryOf('WebSearch'), 'internet');
  assert.equal(categoryOf('WebFetch'), 'internet');
  assert.equal(categoryOf('mcp_x_y'), 'mcp');
  assert.equal(categoryOf('CallDynamicTool'), 'other');
});

test('a CLI session is bucketed and counted as matched, not reported as unrecognized', () => {
  // Shape of sidecar 323cf93b, where all 35 tool calls used to land in `other`.
  const ops = computeOperations([tool('Read', 40), tool('Write'), tool('Grep', 8), tool('Shell', 400)]);
  assert.equal(ops.file.count, 2);
  assert.equal(ops.file.est_tokens, 10);
  assert.equal(ops.search.count, 1);
  assert.equal(ops.shell.count, 1);
  assert.equal(ops.shell.est_tokens, 100);
  assert.equal(ops.other.count, 0);
  assert.equal(ops.diagnostics.matched, 4);
  assert.deepEqual(ops.diagnostics.unrecognized, []);
});

test('CLI and IDE names are matched exactly, never by case folding', () => {
  // The map is case-sensitive on purpose: an odd casing is an unobserved name and must surface in
  // the diagnostics rather than be guessed into a bucket.
  assert.equal(categoryOf('READ'), 'other');
  assert.equal(categoryOf('shell'), 'other');
  assert.equal(categoryOf('Read_file'), 'other');
  // The IDE's lowercase names still resolve as before.
  assert.equal(categoryOf('write'), 'file');
  assert.equal(categoryOf('grep'), 'search');
});
