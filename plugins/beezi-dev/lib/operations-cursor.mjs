import { pickString } from './pick-field.mjs';

// Bucket each Cursor tool call in a segment into the same seven operation categories the Codex and
// Claude engines report, so the server's operation breakdown needs no per-agent branch.
//
// Cursor is the only one of the three where the tool result is available live: `postToolUse` carries
// `tool_output`, and the sidecar writer records its byte length. So `est_tokens` here is measured
// from a real payload rather than reconstructed from a transcript that (staff-confirmed) omits tool
// outputs entirely — the same bytes/4 convention, but on honest bytes.
//
// MCP SERVER IDENTITY comes from two sources here, in this order:
//
//   1. The `mcp_server` side channel — one line per MCP execution, written by scripts/mcp-before.mjs
//      from the `url`/`command` that only `beforeMCPExecution` carries. This is the real name.
//   2. `mcpServerOf`, which splits the flattened `mcp_<server>_<tool>` at its first underscore. It
//      is wrong for any server whose name contains an underscore and it is still what answers for
//      every tool the side channel has not named.
//
// The two events sit on opposite sides of the call, which is why the alias LRU below is not an
// optimization. `beforeMCPExecution` fires before dispatch and `postToolUse` after, so a checkpoint
// boundary can fall between them: the `mcp_server` line lands in window N, the `tool` line it names
// lands in N+1, and a join confined to one window misses because N+1 contains no side channel at
// all. The call would not be lost — it falls back to the prefix split — but the FIRST call to every
// server is the one most likely to straddle a boundary, so the miss would be systematic rather than
// random, and the systematic case is exactly the one that renames a server in the dashboard.
//
// Solved by carrying the map in session state, which the checkpoint owns:
//
//   const operations = computeOperations(window, { mcpAliases: state.mcpAliases });
//   state.mcpAliases = operations.mcpAliases;   // [[tool, server], …], coldest first, ≤ 64
//
// Wired in lib/delta-cursor.mjs (which calls this) and lib/checkpoint.mjs, where the write happens
// only after a successful enqueue so alias state and cursor state cannot disagree. Both properties
// are non-enumerable, and that is load-bearing rather than tidy: the whole operations object is
// serialized into the report body, and one unknown key 400s the entire report.

// TODO(P0): unverified — see lib/hook-dump.mjs
// Tool names come from Cursor's documented agent tool vocabulary. Each set is one line per name so a
// newly observed tool is a one-line addition; an unrecognized name is never dropped, it lands in
// `other` and is reported through the diagnostics below.
const FILE_TOOLS = new Set([
  'read_file',
  'write',
  'search_replace',
  'edit_file',
  'delete_file',
  'list_dir',
  'read_lints',
]);
const SEARCH_TOOLS = new Set([
  'codebase_search',
  'grep',
  'grep_search',
  'file_search',
  'glob_file_search',
]);
const INTERNET_TOOLS = new Set(['web_search', 'web_fetch', 'browser', 'fetch_pull_request']);
const SHELL_TOOLS = new Set(['run_terminal_cmd', 'run_command']);
// Interactive / bookkeeping builtins that are not work against the repo.
const OTHER_BUILTINS = new Set(['todo_write', 'update_memory', 'create_diagram']);

// The Cursor CLI names the same builtins in PascalCase (observed on 2026.09.18: Read, Write, Grep,
// Shell; the rest are the CLI's documented tool names, unobserved). Mapped explicitly rather than by
// lowercasing, so an IDE name and a CLI name can never collide into the wrong bucket by accident:
// lowercasing would also silently change how the IDE's existing `write` is matched.
// `CallDynamicTool` (the CLI's subagent `Task` wrapper) is deliberately absent. It is not work
// against the repo, and no `postToolUse` fires for it anyway, so it stays in `other`.
const CLI_TOOL_CATEGORY = new Map([
  ['Read', 'file'], ['Write', 'file'], ['StrReplace', 'file'], ['Edit', 'file'],
  ['MultiEdit', 'file'], ['Delete', 'file'], ['LS', 'file'], ['ReadLints', 'file'],
  ['Grep', 'search'], ['Glob', 'search'], ['SemanticSearch', 'search'],
  ['Shell', 'shell'],
  ['WebSearch', 'internet'], ['WebFetch', 'internet'],
]);

// Cursor namespaces MCP server tools as `mcp_<server>_<tool>` — unlike Codex, which surfaces them
// bare and therefore has to treat every unknown name as MCP. Here the prefix is the evidence, so an
// unknown *unprefixed* name is genuinely unknown and belongs in `other`.
const MCP_PREFIX = 'mcp_';

const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'skill', 'other'];

// The sidecar's tool record, tolerating the field spellings the writer might settle on.
// TODO(P0): unverified — see lib/hook-dump.mjs
const TOOL_EVENTS = new Set(['tool', 'tool_call', 'tool_error', 'tool_failed']);
const NAME_FIELDS = ['tool', 'tool_name', 'name'];
const BYTES_FIELDS = ['bytes', 'output_bytes', 'outputBytes'];

// The side channel. `scripts/mcp-before.mjs` writes one of these per MCP execution, carrying the
// tool's name and the server derived from the `url`/`command` that only `beforeMCPExecution` sees.
//
// It is NOT a tool event and must never become one: `postToolUse` already writes the countable
// `tool` line for the same call, so counting this too would double every MCP call in `operations`
// and in `est_tokens`. It is excluded by construction — TOOL_EVENTS above does not contain it — and
// the only thing read off it here is identity. Same exclusion on the writing side (no `bytes`, no
// `ms`) and in delta-cursor's KNOWN_EVENTS notes.
const MCP_SERVER_EVENT = 'mcp_server';
const SERVER_FIELDS = ['server'];

// How many tool→server aliases travel between checkpoint windows. See the note on `options` in
// computeOperations: 64 is far more MCP tools than a session uses and small enough that the state
// file stays a state file.
const MCP_ALIAS_CAP = 64;

function pickBytes(event, fields) {
  for (const field of fields) {
    const value = event[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function isToolEvent(event) {
  return event !== null && typeof event === 'object' && TOOL_EVENTS.has(event.ev);
}

export function categoryOf(name) {
  if (typeof name !== 'string' || name === '') return 'other';
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  if (FILE_TOOLS.has(name)) return 'file';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (INTERNET_TOOLS.has(name)) return 'internet';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (OTHER_BUILTINS.has(name)) return 'other';
  // Checked after the IDE sets, whose names are all lowercase, so the two vocabularies cannot
  // shadow each other; the order only matters if a future IDE build adopts a PascalCase name.
  if (CLI_TOOL_CATEGORY.has(name)) return CLI_TOOL_CATEGORY.get(name);
  return 'other';
}

// `mcp_<server>_<tool>` -> server, by splitting at the first underscore.
//
// THE FALLBACK, no longer the only answer. A server name containing underscores cannot be recovered
// from the flattened name at all, and this plugin's own tools are the proof:
// `mcp_plugin_beezi_beezi_create_ticket` resolves to a server called "plugin", so every Beezi MCP
// call used to be attributed to a server that does not exist. The `mcp_server` side channel is the
// fix (see mcpAliasMap below); this stays because it is what answers for every tool the side channel
// has not named yet — which is every tool until `beforeMCPExecution` has fired once for that server,
// and every tool forever if that event turns out not to fire under `cursor-agent` at all.
//
// TODO(P0): the FLATTENED-NAME FORMAT is unverified — Cursor is not installed on the authoring
// machine, so `mcp_<server>_<tool>` comes from documentation rather than from an observed payload.
// The side-channel join does not depend on it; this function is the only thing that does.
export function mcpServerOf(name) {
  const rest = name.slice(MCP_PREFIX.length);
  const cut = rest.indexOf('_');
  const server = cut === -1 ? rest : rest.slice(0, cut);
  return server === '' ? 'unknown' : server;
}

// Whatever the caller carried over from an earlier window, as [tool, server] pairs. A Map, a plain
// object and an array of pairs are all accepted, because the persisted form is the checkpoint's
// choice and JSON round-trips a Map into neither of the other two.
function aliasPairs(seed) {
  if (seed instanceof Map) return [...seed];
  if (Array.isArray(seed)) return seed;
  if (seed !== null && typeof seed === 'object') return Object.entries(seed);
  return [];
}

// tool -> server, learned from this window's `mcp_server` lines on top of whatever the caller
// seeded. Insertion order is least-recently-seen first, so trimming to the cap drops the coldest
// entries and the map doubles as the LRU the checkpoint persists.
function mcpAliasMap(events, seed) {
  const map = new Map();
  const remember = (tool, server) => {
    if (typeof tool !== 'string' || tool.trim() === '') return;
    if (typeof server !== 'string' || server.trim() === '') return;
    const key = tool.trim();
    map.delete(key);
    map.set(key, server.trim());
  };
  for (const pair of aliasPairs(seed)) if (Array.isArray(pair)) remember(pair[0], pair[1]);
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.ev !== MCP_SERVER_EVENT) continue;
    // A side-channel line with no `server` asserts nothing — mcpServerFrom could not name the
    // server from the payload's url/command. It must not delete an alias an earlier line DID
    // establish, so it is skipped rather than recorded as an absence.
    remember(pickString(event, NAME_FIELDS), pickString(event, SERVER_FIELDS));
  }
  return map;
}

// The window's operation breakdown.
//
// `options.mcpAliases` — tool→server pairs observed in EARLIER windows, so the side-channel join
// survives a checkpoint boundary. `beforeMCPExecution` fires before the call and `postToolUse` after
// it, so the `mcp_server` line can land in window N while the `tool` line it names lands in N+1;
// without a carry-over the join misses and that call falls back to the prefix split. Nothing passes
// this yet — see the note above the return for the exact contract the checkpoint should use.
//
// THE OUTPUT SHAPE IS A BACKEND CONTRACT. The report DTO is validated with
// `whitelist + forbidNonWhitelisted` GLOBALLY, so one unknown key 400s the entire report and the
// segment's tokens, cost and code changes go with it (this file's siblings carry the scar — see
// lib/checkpoint.mjs). `operations.<category>` accepts exactly `{count, est_tokens, by_server?,
// by_skill?}`. There is NO `by_tool`, and adding one to carry the join's detail would destroy all
// reporting rather than enrich it. Everything this function learns beyond those keys leaves
// non-enumerably or not at all.
export function computeOperations(events, options = {}) {
  const window = Array.isArray(events) ? events : [];
  const aliases = mcpAliasMap(window, options == null ? undefined : options.mcpAliases);

  const totals = {};
  for (const category of CATEGORIES) totals[category] = { count: 0, est_tokens: 0 };
  totals.mcp.by_server = {};
  // Cursor skills are prompt-injected rather than invoked as tools, so nothing can populate this.
  totals.skill.by_skill = {};
  const plugins = {};

  const diagnostics = {
    toolEvents: 0,
    named: 0,
    unnamed: 0,
    matched: 0,
    unrecognized: [],
    // How each MCP call got its server. This is the readout for the open question the whole side
    // channel rests on: if `beforeMCPExecution` never fires under `cursor-agent`, `mcpAliased`
    // stays 0 forever on those machines and `mcpInferred` carries everything — which is a fact
    // about the host, invisible in production unless it is counted here.
    mcpAliased: 0,
    mcpInferred: 0,
  };
  const unrecognized = new Set();

  for (const event of window) {
    if (!isToolEvent(event)) continue;
    diagnostics.toolEvents += 1;
    const name = pickString(event, NAME_FIELDS);
    if (name === null) {
      // A tool event we cannot name is a schema miss, not a zero: report it rather than letting the
      // segment look like the user ran no tools.
      diagnostics.unnamed += 1;
      continue;
    }
    diagnostics.named += 1;

    const aliased = aliases.get(name);
    const alias = aliased == null ? null : aliased;
    let category = categoryOf(name);
    // The side channel outranks the prefix, but only where the prefix said nothing. `mcp-before.mjs`
    // runs on `beforeMCPExecution` and on no other event, so an alias is direct evidence that the
    // tool is an MCP tool — which rescues the classification if a Cursor build ever stops flattening
    // MCP names with the `mcp_` prefix. It is deliberately not allowed to MOVE a call: a payload that
    // somehow aliased `read_file` must not relocate file operations into the MCP bucket.
    if (category === 'other' && alias !== null) category = 'mcp';

    const known = category !== 'other' || OTHER_BUILTINS.has(name);
    if (known) diagnostics.matched += 1;
    else unrecognized.add(name);

    const est = Math.round(pickBytes(event, BYTES_FIELDS) / 4);
    const bucket = totals[category];
    bucket.count += 1;
    bucket.est_tokens += est;

    if (category === 'mcp') {
      // The observed name when the hook has given us one; the flattened-name split otherwise. The
      // fallback is not a degraded mode — it is the whole of the behaviour on any machine where
      // `beforeMCPExecution` does not fire.
      if (alias === null) diagnostics.mcpInferred += 1;
      else diagnostics.mcpAliased += 1;
      const server = alias == null ? mcpServerOf(name) : alias;
      if (bucket.by_server[server] == null) bucket.by_server[server] = { count: 0, est_tokens: 0 };
      const byServer = bucket.by_server[server];
      byServer.count += 1;
      byServer.est_tokens += est;
      if (plugins[server] == null) plugins[server] = { count: 0, est_tokens: 0 };
      const plugin = plugins[server];
      plugin.count += 1;
      plugin.est_tokens += est;
    }
  }

  diagnostics.unrecognized = [...unrecognized];

  const result = { ...totals, plugins };
  // Non-enumerable so the wire payload stays byte-identical to the Codex/Claude operations shape
  // while the schema-miss signal is still assertable in tests and readable by the delta engine.
  Object.defineProperty(result, 'diagnostics', { value: diagnostics, enumerable: false });
  // The aliases to carry into the next window, seed included, coldest first and capped. Also
  // non-enumerable: this is state for the host, not a report field, and an enumerable key here
  // would 400 the report on the DTO whitelist.
  Object.defineProperty(result, 'mcpAliases', { value: trimAliases(aliases), enumerable: false });
  return result;
}

// Least-recently-seen entries fall off the front. `mcpAliasMap` re-inserts on every sighting, so a
// server the session is actually using is never the one evicted.
function trimAliases(map) {
  const pairs = [...map];
  return pairs.length > MCP_ALIAS_CAP ? pairs.slice(pairs.length - MCP_ALIAS_CAP) : pairs;
}

export function totalEstTokens(operations) {
  let total = 0;
  for (const category of CATEGORIES) {
    const bucket = operations == null ? undefined : operations[category];
    const est = bucket == null ? undefined : bucket.est_tokens;
    total += est == null ? 0 : est;
  }
  return total;
}
