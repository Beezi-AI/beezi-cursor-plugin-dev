import { payloadCursorVersion, sanitizeCursorVersion } from './hook-input-cursor.mjs';
// `pickString` is the one shared field-probe, and this module carried a copy of it rather than
// importing one on the grounds that it had to stay dependency-free. It is not, and was not: the
// line above already reaches lib/hook-input-cursor.mjs, which imports `fs` and lib/hook-cwd.mjs.
// The constraint that is real — and that this import respects — is that the postToolUse hook must
// be able to load this module without pulling in the reporting engine (delta-cursor reaches
// node:sqlite). lib/pick-field.mjs imports nothing at all, so it can neither drag the engine in
// nor form a cycle.
//
// `pickString` and not `firstString`: `firstString` in hook-input-cursor.mjs is varargs and does
// not trim, so reusing that name here would give one name two behaviours.
import { pickString } from './pick-field.mjs';

// Cursor hook payload → sidecar event lines.
//
// Kept out of both `sidecar.mjs` (the writer, which must not know about hook shapes) and
// `scripts/tool-event.mjs` (a hot path that has to stay tiny and testable-by-proxy). It imports only
// lib/hook-input-cursor.mjs and lib/pick-field.mjs — neither reaches the reporting engine — so the
// postToolUse hook can import it without dragging `node:sqlite` onto the hot path.
//
// The event kinds are the vocabulary `delta-cursor` / `operations-cursor` / `code-changes-cursor`
// read back:
//   {"ts":…,"ev":"gen","model":"claude-4.5-sonnet","model_variant":"claude-4.5-sonnet-thinking"}
//   {"ts":…,"ev":"tool","tool":"read_file","bytes":4210,"ms":120,"eid":"toolu_01…"}
//   {"ts":…,"ev":"edit","path":"src/a.ts","added":12,"removed":3,"eid":"toolu_01…"}
//   {"ts":…,"ev":"shell","cmd":"git commit -m …"}
//   {"ts":…,"ev":"mcp_server","tool":"mcp_plugin_beezi_beezi_create_ticket","server":"beezi"}
//   {"ts":…,"ev":"subagent_start","sid":"sa_01…","stype":"general-purpose","task":"…","parent":"…"}
//   {"ts":…,"ev":"subagent_stop","stype":"general-purpose","status":"completed","duration_ms":8123}
//
// EVERY new `ev` string here must also be added to KNOWN_EVENTS in lib/delta-cursor.mjs. That set is
// what the `schemaMiss` diagnostic counts against, and a window in which nothing is recognised is
// reported to the host as a writer/reader schema mismatch — so a name added on one side only turns
// every segment on every machine into a false alarm.
//
// Deliberately field-driven rather than switching on `hook_event_name`: the exact event names and
// payload keys are the single largest unverified area of this design, and reading whatever fields
// are present degrades to "fewer events" instead of "no events" when a key is renamed. The two
// exceptions are marked where they occur (`beforeMCPExecution`, `subagentStart`/`subagentStop`) and
// both have the same justification: those payloads are field-ambiguous with payloads we already
// handle, and guessing wrong DOUBLE-COUNTS rather than under-reports.
// TODO(P0): unverified — see lib/hook-dump.mjs

// The observed Cursor build, stamped on every line a payload produces and read back by replay.
//
// FIELD NAME `cv`, two characters, because it goes on every line of every sidecar on every machine.
//
// A PAYLOAD FACT, not a process fact, which is what keeps duplicate collapse valid: both hook
// registries handle the same host event and both stamp the same string, so the two lines stay
// byte-identical and still collapse to one. A value derived from the running process (the installed
// Cursor, an environment variable) would differ between the two and double every machine.
//
// The sanitizer is imported rather than re-implemented. Every hook script already loads
// hook-input-cursor to read its stdin, so this costs nothing at load, and a second copy of the rule
// that decides whether an untrusted host string may be persisted is how one of the two ends up a
// character behind the other.
const CURSOR_VERSION_FIELD = 'cv';

// The version recorded on one sidecar line, validated on the way out as well as on the way in: the
// line may have been written by an older plugin, hand-edited, or produced by something else
// entirely, and a value that cannot be vouched for is absent rather than trusted.
export function cursorVersionOf(event) {
  return sanitizeCursorVersion(
    event == null || typeof event !== 'object' ? undefined : event[CURSOR_VERSION_FIELD],
  );
}

// The latest version observed AT OR BEFORE `endExclusive` lines, or undefined.
//
// The bound is what stops a replay borrowing a later observation: a session that upgraded Cursor
// mid-conversation has segments from both builds, and the early ones were not written by the new
// one. An unstamped line does not erase what was observed before it (old sidecars have none at all,
// and a single un-stamped writer must not blank the field); a segment that ends before the first
// observation genuinely has none.
//
// `endExclusive` indexes THIS array. A caller holding a resumed window passes a bound within it.
export function cursorVersionAt(events, endExclusive) {
  if (!Array.isArray(events)) return undefined;
  const bound = Number.isFinite(endExclusive) ? Math.trunc(endExclusive) : events.length;
  const end = Math.min(Math.max(bound, 0), events.length);
  for (let i = end - 1; i >= 0; i--) {
    const version = cursorVersionOf(events[i]);
    if (version !== undefined) return version;
  }
  return undefined;
}

const MAX_CMD_CHARS = 2000;
// The same bound for a subagent's task text, and for the same reason: a sidecar line is telemetry,
// and `task` on `subagentStart` is whatever prompt the parent handed the worker — potentially a
// whole pasted file. Bounded generously rather than tightly on purpose; see the note on
// `subagent_stop` and duplicate collapse, where the task string is load-bearing entropy.
const MAX_TASK_CHARS = 2000;

// Cursor 3.14 splits a generation's model across two fields: `model_id` is the model itself
// ("kimi-k3") while `model` is the user-facing variant — the id with the values of `model_params`
// folded in ("kimi-k3-max" for reasoning=max). Recording the variant made one model read as
// several everywhere downstream: its own analytics row, its own pricing lookup, its own leaderboard
// entry per reasoning level.
//
// `model` is still the only one older builds send, so it stays the fallback — and it is kept
// alongside the id as `model_variant`, because Cursor prices per variant in `usageData` and the
// cost split has to be able to find that record (see delta-cursor's usage matching).
const MODEL_ID_FIELDS = ['model_id', 'modelId'];
const MODEL_VARIANT_FIELDS = ['model', 'model_name', 'modelName'];

// `eid` — the host's own identity for the event that produced a line.
//
// This is what lets both of Beezi's hook registries stay installed at once. The plugin reaches a
// machine through the bundled `hooks/hooks.json` AND through the launchers merged into
// `~/.cursor/hooks.json`, and on a machine that has both, one tool call fires both and writes two
// identical sidecar lines. That used to be arbitrated at write time — a launcher run stood down for
// a fortnight after any bundled run — which blinded `cursor-agent` completely, because the CLI does
// not run a plugin's bundled hooks at all and the launchers were the only registry it had (Cursor
// staff, forum 163890). Stamping the id the payload already carries moves the decision to the
// reader, where it is a fact about the event instead of a guess about which registry is alive; see
// dedupeEvents in lib/delta-cursor.mjs.
//
// Snake_case first, camelCase after, the way every other reader in this plugin takes Cursor's
// payloads (see hook-input-cursor.mjs) — the same field genuinely arrives under both spellings from
// different events. The `*_call_id` spellings are read too: an id that turns out to name something
// coarser than one tool call costs nothing, because the reader keys on the id AND the rest of the
// line, so two different calls that share an id still differ and both survive.
//
// NEVER fabricated. A line with no `eid` says "the host gave me nothing to match on", which the
// reader answers with a much more careful, time-bounded rule. An invented id would instead assert
// an identity we cannot back, and identity is what deletes events.
const TOOL_ID_FIELDS = ['tool_use_id', 'toolUseId', 'tool_call_id', 'toolCallId'];
const GEN_ID_FIELDS = ['generation_id', 'generationId'];

// The host's own name for the event that produced this payload. Confirmed present on real payloads
// — hook-input-cursor.mjs documents a live `stop` payload as carrying `hook_event_name` — and it is
// the ONLY thing that separates two pairs of payloads this module cannot otherwise tell apart:
// `beforeMCPExecution` from a shell tool call (both carry `tool_name` + `command`), and
// `subagentStop` from a plain `stop` (both carry `status` + `loop_count`). Read only where a wrong
// guess would double-count; everything else stays field-driven. See the header.
const HOOK_EVENT_FIELDS = ['hook_event_name', 'hookEventName'];
const MCP_EXECUTION_EVENT = 'beforeMCPExecution';
const SUBAGENT_START_EVENT = 'subagentStart';
const SUBAGENT_STOP_EVENT = 'subagentStop';

const SUBAGENT_ID_FIELDS = ['subagent_id', 'subagentId'];
const SUBAGENT_TYPE_FIELDS = ['subagent_type', 'subagentType'];
const SUBAGENT_TASK_FIELDS = ['task'];
const SUBAGENT_PARENT_FIELDS = ['parent_conversation_id', 'parentConversationId'];
const SUBAGENT_STATUS_FIELDS = ['status'];

function byteLengthOf(output) {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf-8');
  if (output == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(output), 'utf-8');
  } catch {
    return 0;
  }
}

function nonNegativeInt(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

// A string's line count, tolerating exactly one trailing newline. Absent/empty → 0.
//
// This is the ONLY way to know how big an agent edit was. Cursor's `afterFileEdit` payload is
// `{file_path, edits: [{old_string, new_string}]}` and nothing else — no line numbers, no ranges, no
// counts. Those fields exist only on `afterTabFileEdit`, which fires for Tab completions and never
// for an agent edit. So `removed` comes from counting `old_string` and `added` from counting
// `new_string`, exactly as the Claude plugin has done since it shipped
// (beezi-claude-plugins/plugins/beezi/lib/code-changes.mjs:41-44). A replaced-block count is a lower
// bound on the real churn rather than a diff, and that is the honest answer available here.
//
// NO `.split('\n')`, which is what the sibling does and what this cannot afford. `new_string` is
// whatever the model wrote: a whole-file rewrite of a generated bundle or a lockfile is routinely
// several megabytes, and splitting it allocates one string object per line — hundreds of thousands
// of them — inside a hook Cursor runs synchronously and kills at a 10s deadline. `indexOf` walks the
// same bytes inside the engine and allocates nothing at all.
export function lineCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  // ONE trailing newline is a line terminator, not an empty last line: "a\nb\n" is two lines. A
  // SECOND one is a real empty line and is counted, which is why only one is excluded. Matches the
  // sibling's `.replace(/\n$/, '')` exactly, including that a lone "\n" counts as one line.
  const end = text.charCodeAt(text.length - 1) === 10 ? text.length - 1 : text.length;
  let lines = 1;
  let at = text.indexOf('\n');
  while (at !== -1 && at < end) {
    lines += 1;
    at = text.indexOf('\n', at + 1);
  }
  return lines;
}

// A count the payload actually carried, or null when it carried none.
//
// THE FALSE ZERO — a live bug this replaced. The edit builder used to write
// `nonNegativeInt(edit?.added ?? edit?.lines_added ?? edit?.linesAdded)`, and `nonNegativeInt`
// answers `0` for `undefined`. So every edit from a payload with no count field was recorded as
// `"added":0,"removed":0`. That is not a harmless default: `applyEdit` in code-changes-cursor.mjs
// (~:117) reaches for its text-derived fallback only when BOTH counts are `null`, and a literal `0`
// is a number, so the false zero read as a genuine observation of "this edit changed nothing" and
// suppressed the fallback outright. Segments named every file the agent had touched and reported
// `lines_added: 0` for all of them — a confidently wrong number, which everything else in this
// engine is built to avoid (see the `unknown` billing pool, and `sumTokens` returning null).
//
// So an unobserved count is OMITTED. Absent means absent.
function observedCount(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

// The replaced and the replacing text of one edit record, under either spelling, or `undefined` for
// a side the record does not carry. Shared with `lineCountsFromText` in lib/code-changes-cursor.mjs
// so write time and read time look under the same keys; only the KEYS are shared, because the two
// callers deliberately answer differently when neither side is there — `{}` here, null there, and
// the null is what that module's three-state precedence is built on.
export function editTexts(record) {
  if (record == null) return { before: undefined, after: undefined };
  return {
    before: typeof record.old_string === 'string' ? record.old_string : record.oldString,
    after: typeof record.new_string === 'string' ? record.new_string : record.newString,
  };
}

// `{ added?, removed? }` for one edit — either what the payload counted, or what its text says, or
// neither. Mirrors `applyEdit`'s own precedence in code-changes-cursor.mjs so the fallback source is
// chosen the same way at write time and at read time: reported counts win WHOLESALE (if either is
// present, neither is derived), because mixing an observation with a derivation produces a pair of
// numbers that came from two different accountings of the same edit.
function editCounts(record) {
  const added = record == null
    ? null
    : observedCount(record.added, record.lines_added, record.linesAdded);
  const removed = record == null
    ? null
    : observedCount(record.removed, record.lines_removed, record.linesRemoved);
  if (added !== null || removed !== null) {
    return { ...(added === null ? {} : { added }), ...(removed === null ? {} : { removed }) };
  }
  const { before, after } = editTexts(record);
  // One side present is enough — a pure insertion has an empty `old_string` and a pure deletion an
  // empty `new_string`, and both are real observations of the edit. Neither side present is not.
  if (typeof before !== 'string' && typeof after !== 'string') return {};
  return { added: lineCount(after), removed: lineCount(before) };
}

// The four counts Cursor hands a turn-end hook, under the names its own TokenUsage message uses.
// Returns null when the payload carries none of them, so a `gen` derived from a tool call stays a
// bare model marker rather than claiming a turn used zero tokens.
const TOKEN_FIELDS = Object.freeze({
  token_input: ['input_tokens', 'inputTokens'],
  token_output: ['output_tokens', 'outputTokens'],
  token_cache_read: ['cache_read_tokens', 'cacheReadTokens'],
  token_cache_write: ['cache_write_tokens', 'cacheWriteTokens'],
});

function tokenUsageOf(payload) {
  const out = {};
  let seen = false;
  for (const [key, fields] of Object.entries(TOKEN_FIELDS)) {
    for (const field of fields) {
      const value = payload[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[key] = Math.max(0, Math.round(value));
        seen = true;
        break;
      }
      // Cursor converts these from protobuf int64, which can arrive as a numeric string.
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        out[key] = Math.max(0, Math.round(Number(value)));
        seen = true;
        break;
      }
    }
  }
  return seen ? out : null;
}

// Cursor's `afterFileEdit` reports `{ file_path, edits: [{ old_string, new_string }] }`. The
// per-edit line counts are the FALLBACK source for code_changes — `ai-code-tracking.db` is primary —
// so a file named by a payload that counts nothing is still recorded, with no counts on it, rather
// than dropped from the changed set.
function editEvents(payload, eid) {
  const edits = payload != null && Array.isArray(payload.edits) ? payload.edits : [];
  const out = [];
  // The id belongs to the edit CALL, so every file in one `edits[]` carries the same one. That is
  // not a collision: the reader keys on the whole line, and the paths differ.
  const stamp = eid === null ? {} : { eid };
  for (const edit of edits) {
    const editPath = edit == null ? undefined : edit.path;
    const editFilePath = edit == null ? undefined : edit.file_path;
    const editFilePathCamel = edit == null ? undefined : edit.filePath;
    const payloadFilePath = payload == null ? undefined : payload.file_path;
    const filePath = editPath != null ? editPath
      : editFilePath != null ? editFilePath
        : editFilePathCamel != null ? editFilePathCamel
          : payloadFilePath != null ? payloadFilePath
            : null;
    if (typeof filePath !== 'string' || filePath === '') continue;
    out.push({ ev: 'edit', path: filePath, ...editCounts(edit), ...stamp });
  }
  // A file edit reported without an `edits[]` array still names its file — record the touch so
  // files_changed is right even when the line counts are only available from the tracking db.
  if (out.length === 0 && payload != null && typeof payload.file_path === 'string' && payload.file_path !== '') {
    out.push({ ev: 'edit', path: payload.file_path, ...editCounts(payload), ...stamp });
  }
  return out;
}

// `beforeMCPExecution` — which server a tool belongs to, and nothing else.
//
// Cursor's payload is `{ tool_name, tool_input }` (tool_input is a JSON *string*, not an object)
// plus EITHER `{ url }` for a remote server OR `{ command }` for a stdio one. There is no server
// NAME field anywhere in it, and that absence is the entire reason this event exists. The only other
// way to name the server is to split the flattened `mcp_<server>_<tool>` at its first underscore,
// which `mcpServerOf` in lib/operations-cursor.mjs (~:81) does today and which is provably wrong for
// this plugin's own tools: `mcp_plugin_beezi_beezi_create_ticket` resolves to a server called
// "plugin", so every Beezi MCP call is attributed to a server that does not exist.
//
// A SIDE CHANNEL, deliberately, and it MUST STAY ONE. `postToolUse` already fires for MCP tools and
// its `tool` line is what `computeOperations` counts; a second countable line here would double
// every MCP call in the operations breakdown and in est_tokens. So this line carries identity only —
// no `bytes`, no `ms`, no field any counter reads — and it is excluded from every consumer by
// construction, because none of TOOL_EVENTS / EDIT_EVENTS / GEN_EVENTS / PROMPT_EVENTS /
// TURN_END_EVENTS contains `mcp_server`. Joining it back onto the `tool` line is another round's
// work; `eid` below is the key that makes it possible.
//
// THE CONTRACT, chosen over the alternative of putting the raw `url`/`command` on the event and
// deriving the server at read time: the CALLER hands us an already-derived server name and the raw
// `url`/`command` NEVER reaches the sidecar. A stdio server is launched from an argv that routinely
// carries its own credentials (`npx some-mcp --api-key sk-…`) and a remote server's url can carry a
// token in its query string; the sidecar is a plain-text file that outlives the session and is read
// back by the reporting engine, so writing either into it turns a telemetry log into a secret store.
// Deriving at write time also keeps the reporting engine out of this module's import graph, which is
// the only reason the postToolUse hot path can import it at all.
function mcpServerEvent(tool, server, eid) {
  return {
    ev: 'mcp_server',
    tool,
    // Omitted, never guessed, when the caller could not derive one. A line that says "this was an
    // MCP execution whose server we cannot name" is still worth having — it tells the joiner to fall
    // back to the flattened-name split rather than to assume the side channel was never written.
    ...(server === null ? {} : { server }),
    // Stamped when the payload carries a call id, because that is the exact join key back to the
    // `tool` line `postToolUse` writes for the same call. Without one, two calls to the same MCP tool
    // inside one second collapse in dedupeEvents — which costs nothing here, because both copies
    // assert the identical fact (this tool belongs to this server) and neither is counted.
    ...(eid === null ? {} : { eid }),
  };
}

// `subagentStart` / `subagentStop`.
//
// CONFIRMED HOST BUGS, verified against real payloads. Do not "fix" any of the workarounds below by
// reaching for the documented field — it is not there:
//
//   • `subagentStop` carries NO `subagent_id`. There is no join key back to the start event at all,
//     so these are recorded as two independent facts and correlating them is a separate problem
//     with a separate, lossy answer. Nothing here may assume a pairing exists.
//   • `summary` and `modified_files` are documented and ABSENT from real payloads.
//   • `agent_transcript_path` is always null — there is no sub-transcript to read, ever.
//   • `description` on the stop event holds the PARENT's task title, not the subagent's. It is
//     deliberately NOT recorded: a field named for the subagent that in fact describes its parent is
//     worse than an absent field, because a later reader will believe it.
//   • `subagent_model` does not exist, and Cursor exposes no per-subagent token usage anywhere. A
//     subagent's spend is therefore only ever visible inside its parent turn's totals.
//   • `subagent_type` always reads "general-purpose" whatever type actually ran. It is recorded as
//     `stype` because it is what the host said, not because it is true — so nothing downstream may
//     treat it as a discriminator between subagents.
//   • A background subagent fires `subagentStart` and NEVER fires `subagentStop`. A start with no
//     stop is the normal case here, not a dropped event, and no consumer may wait for the pair.
//
// DUPLICATE COLLAPSE, said loudly because it is a real and unfixable cost. `subagent_stop` has no id
// of any kind, so dedupeEvents falls to its content-hash + 1s window — and `stype` is a constant
// (see above), so the only fields that distinguish two workers finishing in the same second are
// `task`, `status`, `duration_ms`, `message_count`, `tool_call_count` and `loop_count`. In practice
// millisecond durations and differing counts separate them. But two parallel workers given the SAME
// task that finish in the same second having agreed on every one of those counts WILL be recorded as
// one, and nothing in the payload can prevent it. `loop_count` is recorded partly for that reason —
// every extra field the host really sends is entropy the content key can use. Under-counting a
// repeat is the direction this engine chooses to fail in everywhere else too (see dedupeEvents), and
// the alternative — exempting `subagent_stop` from collapse — would double every subagent on every
// machine that has both hook registries installed, which is now every machine.
function subagentEvents(payload, eid) {
  const hook = pickString(payload, HOOK_EVENT_FIELDS);
  const sid = pickString(payload, SUBAGENT_ID_FIELDS);
  const stype = pickString(payload, SUBAGENT_TYPE_FIELDS);

  // The host's own name wins when it gives one, INCLUDING when it names something else: a plain
  // `stop` payload carries `status` and `loop_count` too, and reading one as a subagent completion
  // would invent a subagent on every turn of every session. Fields are only consulted when the host
  // named nothing — and then `subagent_id` is the discriminator, because it is the one key
  // `subagentStart` has and `subagentStop` provably has not.
  let kind = null;
  if (hook === SUBAGENT_START_EVENT) kind = 'start';
  else if (hook === SUBAGENT_STOP_EVENT) kind = 'stop';
  else if (hook !== null) kind = null;
  else if (sid !== null) kind = 'start';
  else if (stype !== null) kind = 'stop';
  if (kind === null) return [];

  const task = pickString(payload, SUBAGENT_TASK_FIELDS);
  const taskField = task === null ? {} : { task: task.slice(0, MAX_TASK_CHARS) };

  if (kind === 'start') {
    const parallel = payload.is_parallel_worker == null
      ? payload.isParallelWorker
      : payload.is_parallel_worker;
    const parent = pickString(payload, SUBAGENT_PARENT_FIELDS);
    return [{
      ev: 'subagent_start',
      ...(sid === null ? {} : { sid }),
      ...(stype === null ? {} : { stype }),
      ...taskField,
      // Recorded although nothing consumes it yet. `parent_conversation_id` is the ONLY depth signal
      // Cursor exposes — there is no nesting level, no parent subagent id, no tree anywhere in these
      // payloads — and it cannot be recovered afterwards from a sidecar that never captured it. A
      // field costs bytes once; a re-instrumented fleet costs a release.
      ...(parent === null ? {} : { parent }),
      // Which Task tool call spawned this worker — the join back to the parent's own `tool` line.
      // Carried alongside `eid` under two names for the same reason `gen_id` and `eid` are (see the
      // generation builder below): one names the THING, the other names the host event that wrote
      // the line and is what duplicate collapse keys on. Cursor gives us nothing finer than the tool
      // call today so the two coincide, and keeping them apart means neither reader has to know.
      ...(eid === null ? {} : { tool_call_id: eid, eid }),
      ...(typeof parallel === 'boolean' ? { parallel } : {}),
    }];
  }

  const status = pickString(payload, SUBAGENT_STATUS_FIELDS);
  return [{
    ev: 'subagent_stop',
    ...(stype === null ? {} : { stype }),
    ...(status === null ? {} : { status }),
    ...taskField,
    // Omitted rather than zeroed when the host sends nothing, for the same reason edit counts are:
    // a zero here would read downstream as a subagent that ran instantly and did nothing.
    ...countField('duration_ms', payload.duration_ms, payload.durationMs),
    ...countField('message_count', payload.message_count, payload.messageCount),
    ...countField('tool_call_count', payload.tool_call_count, payload.toolCallCount),
    ...countField('loop_count', payload.loop_count, payload.loopCount),
  }];
}

function countField(name, ...values) {
  const value = observedCount(...values);
  return value === null ? {} : { [name]: value };
}

// Every sidecar line a single Cursor hook payload implies, in write order. Returns [] for a payload
// that carries nothing worth recording — the caller writes nothing rather than an empty marker.
//
// OPTIONS, both opt-in and both defaulting to the safe answer, because five hook scripts share this
// one function and a default that suits the newest of them silently corrupts the other four:
//
//   allowEdits  Emit `edit` lines. ONLY the `afterFileEdit` script passes true. This used to be
//               unconditional, which was survivable only because `afterFileEdit` was not registered:
//               `postToolUse` fires for a `Write` tool and its payload can carry a top-level
//               `file_path`, so the moment `afterFileEdit` IS registered every agent write is
//               recorded twice — once by the edit hook that saw the real edits[], and once by the
//               tool hook that saw a filename. Those two lines differ in content (one has counts,
//               one has none), so dedupeEvents cannot collapse them and code_changes counts the file
//               twice. Defaulting to false makes every existing caller correct without touching it.
//   mcpServer   The server name the caller has already derived for a `beforeMCPExecution` payload.
//               Its presence also marks the payload as an MCP execution. See mcpServerEvent for the
//               full contract and why the raw url/command deliberately does not travel.
export function eventsFromHookPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return [];
  const allowEdits = options.allowEdits === true;
  const mcpServer =
    typeof options.mcpServer === 'string' && options.mcpServer.trim() !== ''
      ? options.mcpServer.trim()
      : null;
  // Two signals, because misreading this one costs more than missing it. The option is what the
  // dedicated `beforeMCPExecution` script passes and is authoritative even if Cursor renames the
  // event; `hook_event_name` is the belt-and-braces read for a caller that forwarded the payload
  // without it. Field-driven detection is NOT possible here: `tool_name` + `command` is exactly what
  // a shell tool call looks like, and guessing wrong writes a `tool` line that double-counts the MCP
  // call AND a `shell` line containing the server's launch credentials.
  const isMcpExecution =
    mcpServer !== null || pickString(payload, HOOK_EVENT_FIELDS) === MCP_EXECUTION_EVENT;
  const events = [];

  // A generation. Cursor stamps `model` and `generation_id` on the common hook envelope, so this
  // fires on `postToolUse` (once per tool call) as well as on the turn-end events — the id is what
  // lets the reader collapse those back into the one generation they describe.
  //
  // `stop` and `afterAgentResponse` additionally carry that turn's token counts
  // (aiserver.v1.TokenUsage: input/output/cache_read/cache_write). The original design assumed no
  // usage block ever reached the client and reported zeros for every report; it does reach the
  // client, on those two events, and recording it here is what makes the numbers real.
  const variant = pickString(payload, MODEL_VARIANT_FIELDS);
  const modelId = pickString(payload, MODEL_ID_FIELDS);
  const model = modelId == null ? variant : modelId;
  if (model !== null) {
    const gen = { ev: 'gen', model };
    // Only when it actually differs: a build that sends one field, or sends both identically, must
    // not start writing a second copy of the same string on every line.
    if (variant !== null && variant !== model) gen.model_variant = variant;
    const genId = pickString(payload, GEN_ID_FIELDS);
    if (genId !== null) {
      gen.gen_id = genId;
      // The same string under two names, deliberately. `gen_id` says which GENERATION the line
      // belongs to — delta-cursor collapses a generation's eleven lines into one billable request
      // with it, and merges the token counts that only the turn-end line carries. `eid` says which
      // HOST EVENT wrote the line, which is what duplicate collapse keys on. Cursor gives us
      // nothing finer than the generation on this envelope today, so the two coincide; keeping them
      // apart means neither reader has to know that, and a build that starts stamping a per-event
      // id needs no change anywhere downstream.
      gen.eid = genId;
    }
    const tokens = tokenUsageOf(payload);
    if (tokens) Object.assign(gen, tokens);
    events.push(gen);
  }

  const toolId = pickString(payload, TOOL_ID_FIELDS);
  const tool = payload.tool_name != null ? payload.tool_name
    : payload.toolName != null ? payload.toolName
      : payload.tool;
  const named = typeof tool === 'string' && tool !== '';
  // The side channel REPLACES the tool line, it never accompanies it. `beforeMCPExecution` and
  // `postToolUse` both fire for one MCP call and both name the same tool, so emitting a countable
  // line from each would report every MCP call twice in operations and in est_tokens.
  if (named && isMcpExecution) {
    events.push(mcpServerEvent(tool, mcpServer, toolId));
  } else if (named) {
    const output = payload.tool_output != null ? payload.tool_output
      : payload.toolOutput != null ? payload.toolOutput
        : payload.output;
    const ms = payload.duration_ms != null ? payload.duration_ms
      : payload.durationMs != null ? payload.durationMs
        : payload.duration;
    events.push({
      ev: 'tool',
      tool,
      bytes: byteLengthOf(output),
      ms: nonNegativeInt(ms),
      ...(toolId === null ? {} : { eid: toolId }),
      // Only stamped when the payload says so, so `postToolUseFailure` is distinguishable from a
      // successful call without inventing a second event kind.
      ...(payload.status === 'error' || payload.error != null || payload.success === false
        ? { failed: true }
        : {}),
    });
  }

  // `isMcpExecution` guards this too, and it is the more dangerous of the two suppressions. A stdio
  // MCP server's payload carries `command` at the top level — the argv Cursor launches the server
  // with — so without this guard registering `beforeMCPExecution` would both count every MCP server
  // start as a shell operation AND write that argv, credentials and all, into the sidecar.
  const nestedCommand = payload.tool_input == null ? undefined : payload.tool_input.command;
  const command = isMcpExecution
    ? null
    : (payload.command == null ? nestedCommand : payload.command);
  if (typeof command === 'string' && command !== '') {
    // No `eid`: `afterShellExecution` is not a tool-use event and carries no id of its own, and
    // inventing one from the tool envelope would claim an identity the host never gave. The reader
    // collapses these by content within a one-second window instead.
    //
    // Truncated: a sidecar line is telemetry, and a pasted heredoc would otherwise put an entire
    // file body into the event log (and, through it, into whatever reads the log next).
    events.push({ ev: 'shell', cmd: command.slice(0, MAX_CMD_CHARS) });
  }

  events.push(...subagentEvents(payload, toolId));
  // See the `allowEdits` note on the signature: unguarded, this double-counts every agent write the
  // moment `afterFileEdit` is registered alongside `postToolUse`.
  if (allowEdits) events.push(...editEvents(payload, toolId));

  // Stamped last, on every line this payload produced, so one host event carries one observation
  // however many lines it wrote. Absent when the host sent nothing usable — see CURSOR_VERSION_FIELD.
  const version = payloadCursorVersion(payload);
  if (version !== undefined) {
    for (const event of events) event[CURSOR_VERSION_FIELD] = version;
  }
  return events;
}

// One subagent hook payload → the parent conversation's sidecar. Shared by
// scripts/subagent-start.mjs and scripts/subagent-stop.mjs, which are REQUIRED to apply the
// identical rule — see the routing note in the body.
//
// It lives here and not in lib/sidecar.mjs because the rule reads `parent_conversation_id`, which
// is a hook payload field: sidecar.mjs is the writer, and the writer must not know about hook
// shapes. Payload shapes are exactly what this module owns.
//
// The writer is a PARAMETER, not an import. lib/checkpoint.mjs and lib/code-changes-cursor.mjs
// load this module for its read-side helpers alone, and importing lib/sidecar.mjs here would hand
// them the writer and lib/paths-cursor.mjs with it. Both hook scripts already hold the module —
// they load it in the same dynamic `Promise.all` — so injecting it costs them nothing.
//
// Introduces no output and no throw path of its own, which is not optional: `subagentStart` is a
// PERMISSION hook whose whole contract is that it says nothing and exits 0 on every path. See the
// header of scripts/subagent-start.mjs. `appendEvent` is documented never to throw.
export function appendSubagentEvents(sidecar, payload, sessionId, cwd) {
  // WHICH CONVERSATION'S SIDECAR. `parent_conversation_id` wins over the payload's own session id.
  //
  // Only a TOP-LEVEL `stop` / `sessionEnd` ever checkpoints, and a checkpoint reads exactly one
  // conversation's sidecar. If Cursor stamps this payload with the CHILD's id, the line lands in a
  // file nothing will ever flush — the subagent is recorded, perfectly, into a void. Routing to the
  // parent is what makes the span reachable by the hook that reports it. When the two are the same
  // id (or the parent field is absent, which is the documented shape today) this is a no-op.
  //
  // Both hooks apply this one rule, so both halves of a span land in the same file — which is the
  // reason it is a function rather than a copy in each script. When the stop payload carries no
  // parent field and its session id IS the child's, the two halves land apart — the start stays
  // open and is closed synthetically, which is the designed fallback rather than a lost worker.
  // Whether that happens is a capture-session question, not a design one.
  const parent =
    payload == null ? undefined
      : payload.parent_conversation_id != null ? payload.parent_conversation_id
        : payload.parentConversationId;
  const target = typeof parent === 'string' && parent !== '' ? parent : sessionId;
  // Subagent lines ONLY. `eventsFromHookPayload` is field-driven and this payload can carry a
  // `tool_name` or a `model` too — emitting those would write a second `tool`/`gen` line for a call
  // `postToolUse` has already recorded, and because the two lines differ in content (this one has no
  // bytes and no timing) the reader's duplicate collapse cannot merge them. That double-counts the
  // parent's operations and its request count for every delegation.
  for (const event of eventsFromHookPayload(payload)) {
    if (typeof event.ev === 'string' && event.ev.startsWith('subagent_')) {
      sidecar.appendEvent(target, sidecar.withCwd(event, cwd));
    }
  }
}
