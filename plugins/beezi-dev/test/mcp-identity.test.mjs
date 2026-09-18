import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServerFrom } from '../lib/mcp-identity.mjs';

// The whole point of this module is that Cursor's `beforeMCPExecution` payload carries no server
// name — only a `url` (remote) or a `command` (stdio). Every case below is a shape one of those two
// fields really takes in an MCP config, plus the ones where the honest answer is null.

const cases = [
  // --- remote servers: the host is the identity -----------------------------------------------
  [{ url: 'https://mcp.linear.app/sse' }, 'mcp.linear.app'],
  [{ url: 'https://www.example.com/mcp' }, 'example.com'],
  [{ url: 'HTTPS://MCP.Notion.SO/mcp' }, 'mcp.notion.so'],
  // Userinfo and port are authority, not identity.
  [{ url: 'https://user:pw@mcp.beezi.dev:8443/sse' }, 'mcp.beezi.dev'],
  // No scheme at all — `new URL` throws on this and the hand-rolled parse has to carry it.
  [{ url: 'mcp.example.com/sse' }, 'mcp.example.com'],

  // --- local servers: the host names the machine, so look at the path -------------------------
  // Every segment is transport (`/mcp`), so there is nothing to name it with.
  [{ url: 'http://localhost:3000/mcp' }, null],
  [{ url: 'http://127.0.0.1:8787/weather/sse' }, 'weather'],
  [{ url: 'http://[::1]:3000/sse' }, null],
  // A LAN address is a lease, not a name — same fallback as localhost.
  [{ url: 'http://10.0.0.5:9000/notion/mcp' }, 'notion'],
  // `new URL` parses this with protocol "localhost:" and an EMPTY hostname; trusting that would
  // read the port as a path segment and report a server called "3000".
  [{ url: 'localhost:3000/mcp' }, null],

  // --- stdio servers: walk the argv past the runner --------------------------------------------
  [{ command: 'npx -y @modelcontextprotocol/server-github' }, 'server-github'],
  [{ command: 'npx --yes @scope/thing@1.2.3' }, 'thing'],
  [{ command: 'uvx mcp-server-git' }, 'mcp-server-git'],
  [{ command: 'node /abs/path/server.mjs' }, 'server'],
  [{ command: 'python3 -m some_module' }, 'some_module'],
  [{ command: 'deno run --allow-net /srv/weather.ts' }, 'weather'],
  [{ command: 'docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server' }, 'github-mcp-server'],
  // `-m` is python's "module" and docker's "memory limit"; `-p` is npx's "package" and docker's
  // "publish port". Reading either unconditionally reports a server called "512m" or "3000".
  [{ command: 'docker run -m 512m -p 3000:3000 --rm mcp/filesystem' }, 'filesystem'],
  [{ command: 'npx -p @scope/tools mcp-thing' }, 'mcp-thing'],
  // Quotes group, whitespace splits, and a backslash is a path separator rather than an escape —
  // every Windows MCP config on earth writes C:\Users\… and eating those would report the argv.
  [{ command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Servers\\weather-mcp.mjs"' }, 'weather-mcp'],
  // An argv that arrives pre-split rather than as a string.
  [{ command: ['npx', '-y', '@modelcontextprotocol/server-github'] }, 'server-github'],
  // A shell means the real command is a PROGRAM inside a quoted string. Half-parsing one would
  // report "sh" or the first word of a pipeline; null routes to the joiner's fallback instead.
  [{ command: 'sh -c "uvx mcp-server-git"' }, null],
  [{ command: 'node' }, null],

  // --- nothing derivable ------------------------------------------------------------------------
  [{}, null],
  [{ url: '' }, null],
  [{ command: '   ' }, null],
  [{ url: 'http://' }, null],
  [{ command: '--only --flags' }, null],
  [{ url: 42, command: 42 }, null],
];

test('mcpServerFrom names the server from a url or a command, or says nothing', () => {
  for (const [payload, expected] of cases) {
    assert.equal(
      mcpServerFrom(payload),
      expected,
      `${JSON.stringify(payload)} should resolve to ${JSON.stringify(expected)}`,
    );
  }
});

test('tool_name is never consulted — that is the broken inference this replaces', () => {
  // `mcp_plugin_beezi_beezi_create_ticket` split at its first underscore gives "plugin". Deriving
  // it here would make the same wrong answer look observed; null lets the joiner own the fallback.
  assert.equal(mcpServerFrom({ tool_name: 'mcp_plugin_beezi_beezi_create_ticket' }), null);
});

test('a credential on the command line never becomes a server name', () => {
  // The argv of a stdio server is written into the sidecar's neighbourhood: whatever this returns
  // lands in a plain-text file that outlives the session and is uploaded as a by_server key.
  const key = 'sk-live-51H8xQ2eZvKYlo0fG';
  const commands = [
    `npx -y notion-mcp --api-key ${key}`,
    `npx --api-key ${key} notion-mcp`,
    `API_KEY=${key} npx -y notion-mcp`,
    `env NOTION_TOKEN=${key} uvx notion-mcp`,
  ];
  for (const command of commands) {
    assert.equal(mcpServerFrom({ command }), 'notion-mcp', command);
  }
  // Nothing left but the key: null, not the key.
  assert.equal(mcpServerFrom({ command: `npx --api-key ${key}` }), null);
  // And the backstop, for a flag whose name gives no warning: the token's own shape rejects it.
  assert.equal(mcpServerFrom({ command: `npx --wat ${key}` }), null);
  assert.equal(mcpServerFrom({ command: 'npx --wat eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }), null);
});

test('a token in a remote url never reaches the derived name', () => {
  const name = mcpServerFrom({ url: 'https://mcp.beezi.dev/sse?access_token=sk-live-abcdef' });
  assert.equal(name, 'mcp.beezi.dev');
  assert.equal(name.includes('sk-live'), false);
});

test('the name is capped so a report dimension cannot be an arbitrary argv token', () => {
  const name = mcpServerFrom({ command: `npx -y ${'a'.repeat(200)}` });
  assert.equal(name.length, 64);
});

test('never throws, whatever it is handed', () => {
  const garbage = [
    undefined,
    null,
    0,
    '',
    'a string',
    [],
    { url: null },
    { url: {} },
    { command: {} },
    { command: [1, 2, 3] },
    { url: '://' },
    { url: 'http://[' },
    { command: '"' },
    { command: "'unterminated" },
    { command: '\u0000\u0001' },
    { url: `https://${'x'.repeat(5000)}.com/mcp` },
    { command: '-'.repeat(5000) },
  ];
  for (const payload of garbage) {
    const result = mcpServerFrom(payload);
    assert.ok(
      result === null || typeof result === 'string',
      `${JSON.stringify(payload)} returned ${String(result)}`,
    );
  }
});
