import fs from 'fs';
import path from 'path';
import { withDatabase } from './vscdb.mjs';
import { cursorConfigDir } from './paths-cursor.mjs';

// Read-only access to the Cursor CLI's own chat store.
//
// The CLI never writes state.vscdb, so everything lib/vscdb.mjs enriches an IDE session with (title,
// usage, the model Auto picked) is null for a CLI session. It keeps its own store instead:
//
//   <cursorConfigDir>/chats/<md5(cwd)>/<chatId>/meta.json   {"title": …, "cwd": …}  (top-level only)
//   <cursorConfigDir>/chats/<md5(cwd)>/<chatId>/store.db    tables meta(key,value) + blobs(id,data)
//
// store.db's meta row '0' is hex-encoded JSON carrying `name`, `lastUsedModel`, `createdAt`,
// `subagentInfo` (children only), and `blobEncryptionKey`. The key is deleted the moment the row is
// parsed, and the parsed object never leaves the query callback: only an allowlist of fields is
// copied out. From `blobs` exactly two things are extracted: the per-reply `modelName` and the child
// agent ids in `CallDynamicTool` results, whether the message is a JSON row or a JSON object embedded
// in a binary row. Message content is never returned, cached or logged.
//
// Every store read passes `noSnapshot`. The snapshot fallback in withDatabase copies .db + -wal to a
// temp dir, which here would be a copy of the encryption key that a hook killed at its deadline never
// removes. A direct `?mode=ro` open was verified to read a live CLI store's WAL-resident rows.
//
// Observed on CLI 2026.09.18 (evidence in docs/superpowers/plans/2026-09-23-cursor-cli-parity.md).
// Like every reader here it degrades to null / [] rather than throwing, because it runs inside hooks.
// Every function takes `deps.chatsDir` (test seam), `deps.sqlite` (forwarded to withDatabase) and
// `deps.deadline` (epoch ms): past the deadline it returns what it has, or null, and opens nothing.

// A chat id is a UUID. Anything with a separator in it is refused before it reaches a path join.
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Validation for an extracted model name. A slug that fails it is dropped rather than passed on, so a
// format change can never smuggle free text into the model field.
const MODEL_NAME_RE = /^[A-Za-z0-9._:-]+$/;
const MAX_MODEL_NAME = 120;

// A Task subagent's CallDynamicTool result text names the child chat. First match per result only.
const AGENT_ID_RE = /Agent ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

// Bounds on the blob scan. A long CLI session holds thousands of rows and megabytes of WAL; the scan
// sits inside a hook budget, so it is bounded by rows, by bytes decoded and by the deadline. Rows
// over `maxRowBytes` are never fetched at all: the page query reads only their length and a 24-byte
// head. Binary rows have a tighter cap, `maxBinaryRowBytes`: the largest seen on real stores was
// 12.5 KB, and the embedded-object search over one is linear in its size. `deps.limits` overrides
// these for tests, so budget tests need no 8 MiB fixtures.
const STORE_SCAN_LIMITS = Object.freeze({
  pageSize: 200,
  maxRows: 4000,
  maxBytes: 8 * 1024 * 1024,
  maxRowBytes: 256 * 1024,
  maxBinaryRowBytes: 64 * 1024,
});

// A parent names its children exactly (R2), so this caps only a pathological parent.
const MAX_CHILD_DB_OPENS = 64;

// JSON blobs start with their role; the rest are binary tree nodes. Compared as bytes, before any
// decode, so a row is classified without reading its body.
const ROLE_HEADS = [
  ['assistant', Buffer.from('{"role":"assistant"', 'utf8')],
  ['tool', Buffer.from('{"role":"tool"', 'utf8')],
  ['user', Buffer.from('{"role":"user"', 'utf8')],
];

// Any JSON role row (system, user, or a role not yet seen). Only assistant and tool rows are fetched;
// the rest are skipped from the head alone, and are NOT binary rows, so the system prompt is never
// read or charged to the byte budget.
const JSON_ROLE_HEAD = Buffer.from('{"role":"', 'utf8');

// Binary rows. In some CLI chats (an Auto session on CLI 2026.09.18) a reply exists ONLY inside a
// protobuf-wrapped row, as a complete JSON object in a length-prefixed field that starts
// `{"id":"1","role":"assistant",…`. On every real store probed the key after `id` was `role`.
// Such an object is found by this needle and cut out by brace-matching, never by a regex over the
// payload, then passed through the same allowlist as a JSON row.
const EMBED_NEEDLE = Buffer.from('{"id":"', 'utf8');
// Candidates tried per row, successful or not, so a row full of broken candidates costs at most
// this many linear passes. Real rows hold one.
const MAX_EMBEDDED_PER_ROW = 8;
// Whether a candidate that cannot be read was a reply or a tool result is decided from its own head
// only: anchored, with bounded quantifiers, over at most EMBED_HEAD_BYTES. Searching the row for
// the marker instead would let a user message that quotes it mark the facts incomplete.
const EMBED_HEAD_BYTES = 128;
const EMBEDDED_REPLY_HEAD_RE = /^\{"id":"[^"\\]{0,64}","role":"(?:assistant|tool)"/;
// A binary row over the cap is never fetched at all, and makes the facts incomplete: whatever it
// holds is unread. (A 4 KiB marker probe was tried first and let a reply further in go unseen.)

// Per-process caches, like readComposerData's. A hook process lives for one event, and sync or
// backfill visit each session once, so staleness inside one process is not a concern. Values are
// keyed by the resolved chat dir, which includes the chats root.
const dirCache = new Map();
const metaCache = new Map();
const factsCache = new Map();

export function clearCliChatCache() {
  dirCache.clear();
  metaCache.clear();
  factsCache.clear();
}

function chatsDirOf(deps) {
  if (deps && typeof deps.chatsDir === 'string') return deps.chatsDir;
  return path.join(cursorConfigDir(), 'chats');
}

function nowOf(deps) {
  return typeof deps.now === 'function' ? deps.now() : Date.now();
}

// A typeof check, not truthiness: `deadline: 0` is a real (long past) deadline.
function expired(deps) {
  return typeof deps.deadline === 'number' && nowOf(deps) >= deps.deadline;
}

// A caller that injected its own sqlite is asking for that sqlite (usually a spy counting opens), so
// value caches are bypassed for it, the same rule readComposerData applies to an injected reader.
function cacheable(deps) {
  return deps.sqlite === undefined;
}

function storeDeps(deps) {
  return { ...deps, noSnapshot: true };
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ─── chat dir ───────────────────────────────────────────────────────────────

// The dir is found by listing, not by hashing the cwd: MD5 is case-sensitive over the exact cwd
// spelling the CLI used, which a hook payload does not reliably reproduce. `chats/` has one entry per
// workspace, so this is a handful of stats.
export function findCliChatDir(chatId, deps = {}) {
  if (typeof chatId !== 'string' || !SAFE_ID.test(chatId)) return null;
  const root = chatsDirOf(deps);
  const cacheKey = `${root}\u001f${chatId}`;
  if (dirCache.has(cacheKey)) return dirCache.get(cacheKey);
  if (expired(deps)) return null;
  let found = null;
  for (const hash of listDir(root)) {
    // Cut short: say nothing, and cache nothing, rather than cache a miss that is not one.
    if (expired(deps)) return null;
    const candidate = path.join(root, hash, chatId);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        found = candidate;
        break;
      }
    } catch { /* not in this workspace */ }
  }
  dirCache.set(cacheKey, found);
  return found;
}

// ─── meta ───────────────────────────────────────────────────────────────────

// meta.json is a few hundred bytes; anything far larger is not the file we know.
const MAX_META_JSON_BYTES = 64 * 1024;

function readJsonFile(file) {
  try {
    if (fs.statSync(file).size > MAX_META_JSON_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickSubagentInfo(info) {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null;
  return {
    parentAgentId: str(info.parentAgentId),
    rootParentAgentId: str(info.rootParentAgentId),
    toolCallId: str(info.toolCallId),
    typeName: str(info.typeName),
  };
}

// The store's meta row, reduced to the allowlisted fields inside the callback, so the parsed object
// (and the key it carried) never escapes this function, not even into a cache.
function readStoreMeta(dir, deps) {
  return withDatabase(
    path.join(dir, 'store.db'),
    (db) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get();
      if (row == null || typeof row.value !== 'string') return null;
      let parsed;
      try {
        // Parsed locally: a V8 parse error can quote the input, and this input holds the key.
        parsed = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      delete parsed.blobEncryptionKey;
      return {
        name: str(parsed.name),
        lastUsedModel: str(parsed.lastUsedModel),
        createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : null,
        subagentInfo: pickSubagentInfo(parsed.subagentInfo),
      };
    },
    storeDeps(deps),
  );
}

function copyMeta(meta) {
  if (meta === null) return null;
  return {
    title: meta.title,
    name: meta.name,
    lastUsedModel: meta.lastUsedModel,
    createdAt: meta.createdAt,
    subagentInfo: meta.subagentInfo === null ? null : { ...meta.subagentInfo },
  };
}

// `{ title, name, lastUsedModel, createdAt, subagentInfo }`, or null when neither file is readable.
// `title` comes from meta.json only (a child has none); `name` is the store's, and is the placeholder
// "New Agent" on brand-new and headless chats, which callers must not mistake for a title.
export function readCliChatMeta(chatId, deps = {}) {
  const dir = findCliChatDir(chatId, deps);
  if (dir === null) return null;
  const useCache = cacheable(deps);
  if (useCache && metaCache.has(dir)) return copyMeta(metaCache.get(dir));
  if (expired(deps)) return null;
  const json = readJsonFile(path.join(dir, 'meta.json'));
  let store = null;
  try { store = readStoreMeta(dir, deps); } catch { store = null; }
  let meta = null;
  if (json !== null || store !== null) {
    const j = json === null ? {} : json;
    const s = store === null ? {} : store;
    const created = Number.isFinite(s.createdAt) ? s.createdAt
      : (Number.isFinite(j.createdAtMs) ? j.createdAtMs : null);
    meta = {
      title: str(j.title),
      name: s.name === undefined ? null : s.name,
      lastUsedModel: s.lastUsedModel === undefined ? null : s.lastUsedModel,
      createdAt: created,
      subagentInfo: s.subagentInfo === undefined ? null : s.subagentInfo,
    };
  }
  // A store that could not be read (most often a brief lock: the CLI is mid-write and the no-snapshot
  // rule leaves no fallback) is NOT remembered — caching that miss would hide the title and the
  // subagent back-pointer for the rest of this process. Only a result that saw the store is final.
  if (useCache && store !== null) metaCache.set(dir, meta);
  return copyMeta(meta);
}

// ─── blob facts ─────────────────────────────────────────────────────────────

function roleOfHead(head) {
  if (head == null) return null;
  const buf = typeof head === 'string' ? Buffer.from(head, 'utf8') : Buffer.from(head);
  for (const [role, prefix] of ROLE_HEADS) {
    if (buf.length >= prefix.length && buf.compare(prefix, 0, prefix.length, 0, prefix.length) === 0) return role;
  }
  return null;
}

// 'assistant' | 'tool' for a JSON row worth fetching, 'skip' for any other JSON role row, 'binary'
// for everything else.
function kindOfHead(head) {
  const role = roleOfHead(head);
  if (role === 'assistant' || role === 'tool') return role;
  if (role !== null) return 'skip';
  if (head == null) return 'binary';
  const buf = typeof head === 'string' ? Buffer.from(head, 'utf8') : Buffer.from(head);
  const isJsonRole = buf.length >= JSON_ROLE_HEAD.length
    && buf.compare(JSON_ROLE_HEAD, 0, JSON_ROLE_HEAD.length, 0, JSON_ROLE_HEAD.length) === 0;
  return isJsonRole ? 'skip' : 'binary';
}

// node:sqlite hands back a Uint8Array for a BLOB; view it as a Buffer without copying.
function toBuffer(data) {
  if (data == null) return null;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// The index just past the `}` that balances the `{` at `start`, or -1 if none within `maxLen` bytes.
// One linear pass over bytes: braces count only outside strings, and a backslash inside a string
// escapes the next byte. UTF-8 multi-byte sequences are all >= 0x80, so they can never be taken for
// a quote, a backslash or a brace.
function objectEnd(buf, start, maxLen) {
  const stop = Math.min(buf.length, start + maxLen);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stop; i += 1) {
    const c = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b) {
      depth += 1;
    } else if (c === 0x7d) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function looksLikeReply(buf, start) {
  return EMBEDDED_REPLY_HEAD_RE.test(buf.toString('latin1', start, Math.min(buf.length, start + EMBED_HEAD_BYTES)));
}


// Every `{"id":"…` object embedded in one binary row, each handed to `take(role, content)` once it
// has passed the same shape checks as a JSON row. Returns false when a candidate that looked like a
// reply or tool result could not be read (unbalanced, not JSON, no content array, or past the
// per-row cap), so the caller can mark the facts incomplete. Any other role is ignored silently.
function scanEmbedded(buf, maxObjectBytes, take) {
  let ok = true;
  let from = 0;
  for (let attempts = 0; ; attempts += 1) {
    const start = buf.indexOf(EMBED_NEEDLE, from);
    if (start === -1) break;
    if (attempts >= MAX_EMBEDDED_PER_ROW) {
      // Past the cap, whatever follows is unread — and a later object can be a reply routed to a
      // different model even when the one at the cap is not (Codex re-review: eight model-A replies,
      // a user object, then model B came back "complete" and resolved Auto to A). Unread means
      // incomplete, unconditionally.
      ok = false;
      break;
    }
    const end = objectEnd(buf, start, maxObjectBytes);
    const parsed = end === -1 ? null : parseRow(buf.toString('utf8', start, end));
    if (parsed === null) {
      if (looksLikeReply(buf, start)) ok = false;
      // A broken outer object may still contain whole inner ones, so the search resumes just inside it.
      from = start + EMBED_NEEDLE.length;
      continue;
    }
    // Resume past the object, so an object nested in one already read is never counted twice.
    from = end;
    if (parsed.role !== 'assistant' && parsed.role !== 'tool') continue;
    if (!Array.isArray(parsed.content)) {
      ok = false;
      continue;
    }
    take(parsed.role, parsed.content);
  }
  return ok;
}

function parseRow(data) {
  if (data == null) return null;
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The first `providerOptions.cursor.modelName` on a content PART of an assistant reply. Only parts are
// looked at: the row-level providerOptions carries the provider's native content, and tool-call args
// are the model's own words; neither is a routing fact.
function replyModelOf(content) {
  for (const part of content) {
    if (!isObject(part) || !isObject(part.providerOptions) || !isObject(part.providerOptions.cursor)) continue;
    const name = part.providerOptions.cursor.modelName;
    if (typeof name !== 'string') continue;
    // One reply carries the name on several parts (reasoning + text): the first one decides.
    return name.length <= MAX_MODEL_NAME && MODEL_NAME_RE.test(name) ? name : null;
  }
  return null;
}

// Child agent ids named by this tool row's CallDynamicTool results. The result text also holds the
// subagent's reply; only the id is taken from it.
function childIdsOf(content) {
  const ids = [];
  for (const part of content) {
    if (!isObject(part) || part.type !== 'tool-result' || part.toolName !== 'CallDynamicTool') continue;
    if (typeof part.result !== 'string') continue;
    const m = AGENT_ID_RE.exec(part.result);
    if (m !== null) ids.push(m[1]);
  }
  return ids;
}

function resolveLimits(deps) {
  const o = isObject(deps.limits) ? deps.limits : {};
  const pick = (k) => (Number.isFinite(o[k]) && o[k] > 0 ? o[k] : STORE_SCAN_LIMITS[k]);
  return {
    pageSize: pick('pageSize'),
    maxRows: pick('maxRows'),
    maxBytes: pick('maxBytes'),
    maxRowBytes: pick('maxRowBytes'),
    maxBinaryRowBytes: pick('maxBinaryRowBytes'),
  };
}

// One paged pass over `blobs`, inside a single open. Each page reads only rowid, length and a
// 24-byte head; a body is fetched, one row at a time, only for an assistant or tool row, or a binary
// row, that fits the per-row and total byte caps. Every other JSON role row (user, system) is
// classified from the head and never fetched: nothing here needs its body. A binary row is searched
// for embedded messages; one over its cap is only peeked at, through its first 4 KiB.
// `complete` goes false whenever an assistant or tool message could not be examined (too big, over
// budget, unparseable) or a cap or the deadline ended the scan, so a caller resolving Auto from these
// facts can tell "every reply agreed" from "every reply we saw agreed".
function scanBlobs(db, deps, limits) {
  const pageStmt = db.prepare(
    'SELECT rowid AS rid, length(data) AS n, substr(CAST(data AS BLOB), 1, 24) AS head '
    + 'FROM blobs WHERE rowid > ? ORDER BY rowid LIMIT ?',
  );
  const rowStmt = db.prepare('SELECT data FROM blobs WHERE rowid = ?');
  const binaryCap = Math.min(limits.maxBinaryRowBytes, limits.maxRowBytes);
  const replyModels = [];
  const childAgentIds = [];
  const seenChild = new Set();
  let complete = true;
  let cutByDeadline = false;
  let examined = 0;
  let fetchedBytes = 0;
  let after = Number.MIN_SAFE_INTEGER;

  // One sink for both row kinds, so a JSON row and an embedded object pass the same allowlist. A
  // reply stored both ways is pushed twice; its model is the same, so unanimity is unaffected, and
  // child ids are deduped here.
  const take = (role, content) => {
    if (role === 'assistant') {
      const model = replyModelOf(content);
      if (model !== null) replyModels.push(model);
      return;
    }
    for (const id of childIdsOf(content)) {
      if (seenChild.has(id)) continue;
      seenChild.add(id);
      childAgentIds.push(id);
    }
  };

  outer:
  for (;;) {
    if (expired(deps)) { complete = false; cutByDeadline = true; break; }
    const rows = pageStmt.all(after, limits.pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.rid;
      if (examined >= limits.maxRows) { complete = false; break outer; }
      examined += 1;
      const kind = kindOfHead(row.head);
      // User and system rows carry nothing we read and never affect completeness.
      if (kind === 'skip') continue;
      const n = Number(row.n);
      if (kind === 'binary') {
        // An empty row holds nothing to find.
        if (!(n > 0)) continue;
        if (n > binaryCap) {
          // Too big to search, so whatever it holds is unread — and never fetched. A marker check
          // on its first 4 KiB was tried and is not enough: a reply further in was invisible to it
          // and let a mixed Auto session read as unanimous (Codex re-review). Real binary rows top
          // out near 12 KiB, far under the cap, so treating every oversized one as a gap costs
          // nothing in practice.
          complete = false;
          continue;
        }
        if (fetchedBytes + n > limits.maxBytes) { complete = false; break outer; }
        if (expired(deps)) { complete = false; cutByDeadline = true; break outer; }
        fetchedBytes += n;
        const got = rowStmt.get(row.rid);
        const buf = toBuffer(got == null ? null : got.data);
        if (buf !== null && !scanEmbedded(buf, binaryCap, take)) complete = false;
        continue;
      }
      if (!Number.isFinite(n) || n > limits.maxRowBytes) { complete = false; continue; }
      if (fetchedBytes + n > limits.maxBytes) { complete = false; break outer; }
      if (expired(deps)) { complete = false; cutByDeadline = true; break outer; }
      const got = rowStmt.get(row.rid);
      fetchedBytes += n;
      const parsed = parseRow(got == null ? null : got.data);
      if (parsed === null || parsed.role !== kind || !Array.isArray(parsed.content)) { complete = false; continue; }
      take(kind, parsed.content);
    }
    if (rows.length < limits.pageSize) break;
  }
  return { facts: { replyModels, childAgentIds, complete }, cutByDeadline };
}

function copyFacts(facts) {
  if (facts === null) return null;
  return { replyModels: facts.replyModels.slice(), childAgentIds: facts.childAgentIds.slice(), complete: facts.complete };
}

// `{ replyModels, childAgentIds, complete }` for one chat, or null when its store cannot be read.
//   replyModels    raw `modelName` per assistant reply, rowid order (Auto resolution, T5). A reply
//                  stored both as a JSON row and inside a binary row appears twice: read it for
//                  agreement, never count replies from it
//   childAgentIds  subagent chat ids from CallDynamicTool results, rowid order, deduped (T6)
//   complete       false when any cap or the deadline stopped the scan short
// A result the deadline cut short is not cached, so a later call with time left reads it all.
export function readCliStoreFacts(chatId, deps = {}) {
  const dir = findCliChatDir(chatId, deps);
  if (dir === null) return null;
  const useCache = cacheable(deps);
  if (useCache && factsCache.has(dir)) return copyFacts(factsCache.get(dir));
  if (expired(deps)) return null;
  const limits = resolveLimits(deps);
  let scan = null;
  try {
    scan = withDatabase(path.join(dir, 'store.db'), (db) => scanBlobs(db, deps, limits), storeDeps(deps));
  } catch {
    scan = null;
  }
  const facts = scan === null ? null : scan.facts;
  // Same rule as the meta cache: an unreadable store (scan === null) is retried, never remembered.
  if (useCache && scan !== null && !scan.cutByDeadline) factsCache.set(dir, facts);
  return copyFacts(facts);
}

// ─── subagents ──────────────────────────────────────────────────────────────

// The child store's last write. A zero-length WAL was reset by a checkpoint rather than written to,
// so its mtime says nothing about when the subagent worked and is ignored.
function lastWriteMs(dir) {
  let newest = 0;
  for (const name of ['store.db', 'store.db-wal']) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (name === 'store.db-wal' && st.size === 0) continue;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* absent */ }
  }
  return newest;
}

// The parent's CLI subagents, `[{ agentId, typeName, toolCallId, startMs, endMs }]` by start time.
//
// Discovered by exact id, with no directory scan: the parent's own CallDynamicTool results name each
// child, and a child is kept only if its store says this parent is its direct parent. That opens
// exactly the parent's children, cannot be starved by other sessions' chats, and gives the same answer
// in every fresh hook process. A worker still running has no result yet and shows up at the next
// checkpoint, which is fine: a lane with no end cannot be drawn anyway.
export function listCliSubagents(parentId, deps = {}) {
  if (typeof parentId !== 'string' || !SAFE_ID.test(parentId)) return [];
  if (expired(deps)) return [];
  const facts = readCliStoreFacts(parentId, deps);
  if (facts === null) return [];
  const out = [];
  let opens = 0;
  for (const agentId of facts.childAgentIds) {
    if (opens >= MAX_CHILD_DB_OPENS || expired(deps)) break;
    if (agentId === parentId) continue;
    const dir = findCliChatDir(agentId, deps);
    if (dir === null) continue;
    opens += 1;
    const meta = readCliChatMeta(agentId, deps);
    const info = meta === null ? null : meta.subagentInfo;
    if (info === null || info.parentAgentId !== parentId) continue;
    const startMs = meta.createdAt;
    if (!Number.isFinite(startMs)) continue;
    out.push({
      agentId,
      typeName: info.typeName,
      toolCallId: info.toolCallId,
      startMs,
      // APPROXIMATE: the child store's last write. The CLI records no end time for a subagent.
      endMs: Math.max(startMs, lastWriteMs(dir)),
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || (a.agentId < b.agentId ? -1 : 1));
  return out;
}
