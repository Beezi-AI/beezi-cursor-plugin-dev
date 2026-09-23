import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findCliChatDir, readCliChatMeta, readCliStoreFacts, listCliSubagents, clearCliChatCache,
} from '../lib/cli-chats-cursor.mjs';

// Fixtures mirror the Cursor CLI store observed on CLI 2026.09.18 (plan evidence E5/E6):
//   chats/<md5(cwd)>/<chatId>/meta.json   top-level chats only
//   chats/<md5(cwd)>/<chatId>/store.db    meta(key,value) with hex JSON in row '0', blobs(id,data)
// JSON blobs start with {"role":…}; the rest are binary tree nodes the adapter must ignore.

const sqlite = process.getBuiltinModule?.('node:sqlite') ?? null;
const hex = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');

const KID_A = '11111111-2222-4333-8444-555555555555';
const KID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function makeStore(file, storeMeta, blobs = []) {
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  if (storeMeta !== undefined) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', hex(storeMeta));
  const ins = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  blobs.forEach((b, i) => {
    let data;
    if (Buffer.isBuffer(b)) data = b;
    else if (typeof b === 'string') data = Buffer.from(b, 'utf8');
    else data = Buffer.from(JSON.stringify(b), 'utf8');
    ins.run(`b${i}`, data);
  });
  db.close();
}

function makeChat(root, hash, id, { meta, storeMeta, blobs = [], garbageStore = false } = {}) {
  const dir = path.join(root, hash, id);
  fs.mkdirSync(dir, { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (garbageStore) fs.writeFileSync(path.join(dir, 'store.db'), 'not a database at all. '.repeat(64));
  else if (storeMeta !== undefined && sqlite) makeStore(path.join(dir, 'store.db'), storeMeta, blobs);
  return dir;
}

function tmpChats() {
  clearCliChatCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cli-chats-'));
}

const assistant = (modelName, extra = []) => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'hidden thoughts', providerOptions: { cursor: { modelName } } },
    { type: 'text', text: 'hi' },
    ...extra,
  ],
});

const taskResult = (agentId, toolName = 'CallDynamicTool') => ({
  role: 'tool',
  content: [{
    type: 'tool-result',
    toolCallId: 'toolu_x',
    toolName,
    result: `Subagent finished.\nAgent ID: ${agentId}\nsome private reply text`,
  }],
});

const childMeta = (parent, createdAt, toolCallId = 'toolu_1', typeName = 'generalPurpose') => ({
  name: 'New Agent',
  createdAt,
  blobEncryptionKey: 'CHILD-SECRET',
  subagentInfo: { parentAgentId: parent, rootParentAgentId: parent, toolCallId, typeName },
});

// A DatabaseSync stand-in that records which files were opened, every SQL text prepared and the
// params of every statement run, while delegating to the real node:sqlite. `new` on a function that
// returns an object yields that object, which is all withDatabase needs.
function spySqlite() {
  const opened = [];
  const calls = [];
  function DatabaseSync(file, opts) {
    opened.push(String(file));
    const db = opts === undefined ? new sqlite.DatabaseSync(file) : new sqlite.DatabaseSync(file, opts);
    return {
      exec: (s) => db.exec(s),
      close: () => db.close(),
      prepare(sql) {
        const st = db.prepare(sql);
        const record = (kind) => (...params) => { calls.push({ sql, params }); return st[kind](...params); };
        return { get: record('get'), all: record('all'), run: record('run') };
      },
    };
  }
  return { sqlite: { DatabaseSync }, opened, calls };
}

// openDirect may construct twice for one open (URI, then the readOnly fallback), so opens are
// counted as DISTINCT chat directories touched, not constructor calls.
function openedChats(spy) {
  return [...new Set(spy.opened.map((f) => path.basename(path.dirname(decodeURIComponent(f.replace(/^file:\/+/, '').replace(/\?.*$/, ''))))))];
}

// ─── findCliChatDir ─────────────────────────────────────────────────────────

test('findCliChatDir locates a chat under any workspace hash', () => {
  const root = tmpChats();
  makeChat(root, 'aaaa', 'other', { meta: { title: 'x' } });
  const dir = makeChat(root, 'bbbb', 'chat-1', { meta: { title: 'x' } });
  assert.equal(findCliChatDir('chat-1', { chatsDir: root }), dir);
  assert.equal(findCliChatDir('missing', { chatsDir: root }), null);
});

test('findCliChatDir refuses path-traversal and non-string ids', () => {
  const root = tmpChats();
  assert.equal(findCliChatDir('../etc', { chatsDir: root }), null);
  assert.equal(findCliChatDir('a/b', { chatsDir: root }), null);
  assert.equal(findCliChatDir('a\\b', { chatsDir: root }), null);
  assert.equal(findCliChatDir('', { chatsDir: root }), null);
  assert.equal(findCliChatDir(null, { chatsDir: root }), null);
});

test('findCliChatDir with an expired deadline looks at nothing', () => {
  const root = tmpChats();
  makeChat(root, 'h', 'c1', { meta: { title: 'x' } });
  assert.equal(findCliChatDir('c1', { chatsDir: root, deadline: Date.now() - 1 }), null);
  // The cut-short answer was not cached: a later call with time left finds it.
  assert.ok(findCliChatDir('c1', { chatsDir: root }));
});

// ─── readCliChatMeta ────────────────────────────────────────────────────────

test('readCliChatMeta prefers meta.json title and drops the encryption key', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'c1', {
    meta: { title: 'Run Subagent OK', cwd: 'C:\\x', createdAtMs: 1 },
    storeMeta: { name: 'Run Subagent OK', lastUsedModel: 'claude-opus-5', createdAt: 5, blobEncryptionKey: 'SECRET', mode: 'agent' },
  });
  const meta = readCliChatMeta('c1', { chatsDir: root });
  assert.deepEqual(meta, {
    title: 'Run Subagent OK', name: 'Run Subagent OK', lastUsedModel: 'claude-opus-5', createdAt: 5, subagentInfo: null,
  });
  assert.equal(JSON.stringify(meta).includes('SECRET'), false);
  assert.equal(JSON.stringify(meta).includes('C:'), false, 'cwd must not be returned');
});

test('readCliChatMeta reads a child: no title, subagentInfo reduced to its four fields', { skip: !sqlite }, () => {
  const root = tmpChats();
  const info = childMeta('parent', 2000).subagentInfo;
  makeChat(root, 'h', 'kid', {
    storeMeta: { name: 'New Agent', createdAt: 2000, blobEncryptionKey: 'SECRET', subagentInfo: { ...info, extra: 'nope' } },
  });
  const meta = readCliChatMeta('kid', { chatsDir: root });
  assert.equal(meta.title, null);
  assert.equal(meta.name, 'New Agent');
  assert.equal(meta.createdAt, 2000);
  assert.deepEqual(meta.subagentInfo, info);
  assert.equal(JSON.stringify(meta).includes('SECRET'), false);
});

test('readCliChatMeta degrades without sqlite to meta.json only', () => {
  const root = tmpChats();
  makeChat(root, 'h', 'c2', { meta: { title: 'Only json', createdAtMs: 77 } });
  const meta = readCliChatMeta('c2', { chatsDir: root, sqlite: null });
  assert.equal(meta.title, 'Only json');
  assert.equal(meta.lastUsedModel, null);
  assert.equal(meta.createdAt, 77);
});

test('readCliChatMeta treats an unparseable meta row as absent', { skip: !sqlite }, () => {
  const root = tmpChats();
  const dir = makeChat(root, 'h', 'c3', { meta: { title: 't' }, storeMeta: { name: 'n' } });
  const db = new sqlite.DatabaseSync(path.join(dir, 'store.db'));
  db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(Buffer.from('{"blobEncryptionKey":"SECRET",', 'utf8').toString('hex'));
  db.close();
  const meta = readCliChatMeta('c3', { chatsDir: root });
  assert.equal(meta.title, 't');
  assert.equal(meta.name, null);
});

test('readCliChatMeta with an expired deadline opens no store', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'c4', { meta: { title: 't' }, storeMeta: { name: 'n' } });
  const spy = spySqlite();
  assert.equal(readCliChatMeta('c4', { chatsDir: root, sqlite: spy.sqlite, deadline: Date.now() - 1 }), null);
  assert.deepEqual(spy.opened, []);
});

// ─── readCliStoreFacts ──────────────────────────────────────────────────────

test('readCliStoreFacts returns reply models and child ids, and nothing else', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: { title: 'p' },
    storeMeta: { name: 'p' },
    blobs: [
      { role: 'system', content: 'system prompt' },
      // A user message that happens to contain both patterns is never read.
      { role: 'user', content: `please use "modelName":"SECRET-USER" and Agent ID: ${KID_B}` },
      Buffer.from([0x0a, 0x20, 0x01, 0x02, 0xff]),
      assistant('cursor-grok-4.5-high', [
        { type: 'tool-call', toolCallId: 't1', toolName: 'Task', args: { modelName: 'SECRET-ARGS' } },
      ]),
      // A tool result from another tool mentioning an agent id is not a subagent.
      { ...taskResult(KID_B, 'Read'), providerOptions: { cursor: { modelName: 'SECRET-TOOL' } } },
      taskResult(KID_A),
      taskResult(KID_A),
      // Row-level providerOptions are not a content part.
      { role: 'assistant', content: [{ type: 'text', text: 'x' }], providerOptions: { cursor: { modelName: 'SECRET-ROW' } } },
      assistant('cursor-grok-4.5-high'),
      // A modelName that is not a slug is refused rather than passed on.
      assistant('bad name with spaces'),
    ],
  });
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite });
  assert.deepEqual(facts, {
    replyModels: ['cursor-grok-4.5-high', 'cursor-grok-4.5-high'],
    childAgentIds: [KID_A],
    complete: true,
  });
  assert.equal(JSON.stringify(facts).includes('SECRET'), false);
  // The system and user rows are JSON role rows, not binary ones: their bodies are never fetched.
  const fetched = spy.calls.filter((c) => /FROM blobs WHERE rowid = \?/.test(c.sql)).map((c) => c.params[0]);
  assert.equal(fetched.includes(1), false, 'system row not fetched');
  assert.equal(fetched.includes(2), false, 'user row not fetched');
});

test('readCliStoreFacts never fetches a user row body', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {},
    storeMeta: { name: 'p' },
    blobs: [{ role: 'user', content: 'secret prompt' }, assistant('m1'), { role: 'user', content: 'again' }],
  });
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite });
  assert.deepEqual(facts.replyModels, ['m1']);
  const fetched = spy.calls.filter((c) => /SELECT data FROM blobs WHERE rowid = \?/.test(c.sql)).map((c) => c.params[0]);
  assert.deepEqual(fetched, [2], 'only the assistant row (rowid 2) is fetched');
});

test('a malformed assistant row is skipped and makes the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {},
    storeMeta: { name: 'p' },
    blobs: [assistant('m1'), '{"role":"assistant","content":[{"modelName":"SECRET-BROKEN"'],
  });
  const facts = readCliStoreFacts('p', { chatsDir: root });
  assert.deepEqual(facts.replyModels, ['m1']);
  assert.equal(facts.complete, false);
});

test('a 5 MiB blob is never selected, and oversized assistant rows make the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  const big = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024), providerOptions: { cursor: { modelName: 'm-big' } } }] };
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [assistant('m1'), big, assistant('m1')] });
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite });
  assert.deepEqual(facts.replyModels, ['m1', 'm1']);
  assert.equal(facts.complete, false);
  // Only the two small rows' bodies were fetched; the page query selects length and a 24-byte head.
  const fetched = spy.calls.filter((c) => /SELECT data FROM blobs WHERE rowid = \?/.test(c.sql)).map((c) => c.params[0]);
  assert.deepEqual(fetched, [1, 3]);
  const pageSql = [...new Set(spy.calls.filter((c) => /rowid > \?/.test(c.sql)).map((c) => c.sql))];
  assert.equal(pageSql.length, 1);
  assert.equal(/SELECT\s+rowid(\s+AS\s+\w+)?\s*,\s*data\b/i.test(pageSql[0]), false, 'the page query must not select data');
});

test('an oversized binary row is unread, so the facts are incomplete', { skip: !sqlite }, () => {
  // Its content is never looked at, so it may hold a reply routed to another model; claiming
  // "complete" would let Auto resolve on a partial view (Codex re-review).
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {}, storeMeta: { name: 'p' }, blobs: [Buffer.alloc(300 * 1024, 7), assistant('m1')],
  });
  assert.deepEqual(readCliStoreFacts('p', { chatsDir: root }), { replyModels: ['m1'], childAgentIds: [], complete: false });
});

test('the byte budget stops fetching and marks the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  const blobs = [];
  for (let i = 0; i < 6; i += 1) blobs.push(assistant('m1', [{ type: 'text', text: 'y'.repeat(900) }]));
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs });
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite, limits: { maxBytes: 3000 } });
  assert.equal(facts.complete, false);
  assert.ok(facts.replyModels.length >= 1 && facts.replyModels.length < 6);
  const rowBytes = JSON.stringify(blobs[0]).length;
  const fetchedCount = spy.calls.filter((c) => /SELECT data FROM blobs WHERE rowid = \?/.test(c.sql)).length;
  assert.ok(fetchedCount * rowBytes <= 3000, 'bytes fetched stay within the budget');
});

test('the row cap and paging stop the scan and mark it incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  const blobs = [];
  for (let i = 0; i < 7; i += 1) blobs.push(assistant(`m${i}`));
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs });
  const all = readCliStoreFacts('p', { chatsDir: root, limits: { pageSize: 2 } });
  assert.deepEqual(all.replyModels, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.equal(all.complete, true);
  clearCliChatCache();
  const capped = readCliStoreFacts('p', { chatsDir: root, limits: { pageSize: 2, maxRows: 3 } });
  assert.deepEqual(capped.replyModels, ['m0', 'm1', 'm2']);
  assert.equal(capped.complete, false);
});

test('a deadline reached between pages returns what was read, incomplete and uncached', { skip: !sqlite }, () => {
  const root = tmpChats();
  const blobs = [];
  for (let i = 0; i < 6; i += 1) blobs.push(assistant(`m${i}`));
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs });
  // Resolve the directory first, so the clock below only ticks inside the scan.
  findCliChatDir('p', { chatsDir: root });
  let clock = 1000;
  const facts = readCliStoreFacts('p', { chatsDir: root, deadline: 1005, now: () => (clock += 1), limits: { pageSize: 2 } });
  assert.equal(facts.complete, false);
  assert.ok(facts.replyModels.length < 6);
  // Not cached: a call with time left reads everything.
  assert.equal(readCliStoreFacts('p', { chatsDir: root }).replyModels.length, 6);
});

test('readCliStoreFacts with an expired deadline opens nothing', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [assistant('m1')] });
  const spy = spySqlite();
  assert.equal(readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite, deadline: Date.now() - 1 }), null);
  assert.deepEqual(spy.opened, []);
});

// The checkpoint shape: an early call resolves (and caches) the chat dir, the deadline then passes,
// and later calls must still open nothing, not merely stop after the first page.
test('an expired deadline opens nothing even when the chat dir is already cached', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', { meta: { title: 't' }, storeMeta: { name: 'p' }, blobs: [assistant('m1')] });
  assert.ok(findCliChatDir('p', { chatsDir: root }));
  const spy = spySqlite();
  const late = { chatsDir: root, sqlite: spy.sqlite, deadline: Date.now() - 1 };
  assert.equal(readCliStoreFacts('p', late), null);
  assert.equal(readCliChatMeta('p', late), null);
  assert.deepEqual(spy.opened, []);
});

test('readCliStoreFacts is cached per process until clearCliChatCache', { skip: !sqlite }, () => {
  const root = tmpChats();
  const dir = makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [assistant('m1')] });
  const first = readCliStoreFacts('p', { chatsDir: root });
  first.replyModels.push('mutated-by-caller');
  fs.rmSync(path.join(dir, 'store.db'));
  assert.deepEqual(readCliStoreFacts('p', { chatsDir: root }).replyModels, ['m1']);
  clearCliChatCache();
  assert.equal(readCliStoreFacts('p', { chatsDir: root }), null);
});

// ─── readCliStoreFacts: binary rows ─────────────────────────────────────────

// Some CLI chats (an Auto session on CLI 2026.09.18) keep their assistant replies ONLY inside binary,
// protobuf-wrapped rows: a length-prefixed field holding a whole `{"id":"1","role":"assistant",…}`
// object. The wrapper bytes deliberately include `"`, `{` and `}` so a matcher that trusts the
// surroundings, rather than the object's own braces and strings, breaks here.
const WRAP_HEAD = Buffer.from([0x0a, 0x24, 0x22, 0x7b, 0x7d, 0x12, 0x80, 0x01]);
const WRAP_TAIL = Buffer.from([0x7d, 0x22, 0x7b, 0x1a, 0x00, 0xff]);
const wrap = (...parts) => Buffer.concat([WRAP_HEAD, ...parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))), WRAP_TAIL]);
const embed = (obj) => JSON.stringify({ id: '1', ...obj });

// A reply whose text holds a brace and an escaped quote, so string handling is exercised.
const embeddedReply = (modelName) => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'a } brace, a "quote" and a { brace', providerOptions: { cursor: { modelName } } },
    { type: 'text', text: 'hi' },
  ],
});

const fetchedRowids = (spy) => spy.calls.filter((c) => /FROM blobs WHERE rowid = \?/.test(c.sql)).map((c) => c.params[0]);

test('a reply embedded in a binary row yields its modelName', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {},
    storeMeta: { name: 'p' },
    blobs: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      wrap(embed(embeddedReply('cursor-grok-4.5-high'))),
      wrap(embed(taskResult(KID_A))),
    ],
  });
  assert.deepEqual(readCliStoreFacts('p', { chatsDir: root }), {
    replyModels: ['cursor-grok-4.5-high'],
    childAgentIds: [KID_A],
    complete: true,
  });
});

test('embedded user text, tool-call args and non-Task results never leak', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {},
    storeMeta: { name: 'p' },
    blobs: [
      wrap(embed({ role: 'user', content: [{ type: 'text', text: 'say "modelName":"SECRET-USER"', providerOptions: { cursor: { modelName: 'SECRET-USER' } } }] })),
      wrap(embed({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'Task', args: { modelName: 'SECRET-ARGS' } }] })),
      // Positive controls: the objects ARE parsed, and only the allowlisted part wins.
      wrap(embed({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'Task', args: { modelName: 'SECRET-ARGS2' } }, ...assistant('m-ok').content] })),
      wrap(embed({ ...taskResult(KID_B, 'Read'), providerOptions: { cursor: { modelName: 'SECRET-TOOL' } } })),
      wrap(embed(taskResult(KID_A))),
      wrap(embed({ role: 'assistant', content: [{ type: 'text', text: 'x' }], providerOptions: { cursor: { modelName: 'SECRET-ROW' } } })),
      wrap(embed(embeddedReply('bad name with spaces'))),
    ],
  });
  const facts = readCliStoreFacts('p', { chatsDir: root });
  assert.deepEqual(facts, { replyModels: ['m-ok'], childAgentIds: [KID_A], complete: true });
  assert.equal(JSON.stringify(facts).includes('SECRET'), false);
});

test('a truncated embedded object is skipped without a throw; only an assistant/tool one makes the facts incomplete', { skip: !sqlite }, () => {
  const truncated = (obj) => Buffer.concat([WRAP_HEAD, Buffer.from(embed(obj).slice(0, 60), 'utf8')]);
  const root = tmpChats();
  makeChat(root, 'h', 'u', {
    meta: {}, storeMeta: { name: 'u' }, blobs: [truncated({ role: 'user', content: 'x'.repeat(100) }), assistant('m1')],
  });
  assert.deepEqual(readCliStoreFacts('u', { chatsDir: root }), { replyModels: ['m1'], childAgentIds: [], complete: true });
  makeChat(root, 'h', 'a', {
    meta: {}, storeMeta: { name: 'a' }, blobs: [truncated(embeddedReply('m-cut')), wrap(embed(embeddedReply('m1')))],
  });
  assert.deepEqual(readCliStoreFacts('a', { chatsDir: root }), { replyModels: ['m1'], childAgentIds: [], complete: false });
  makeChat(root, 'h', 't', {
    meta: {}, storeMeta: { name: 't' }, blobs: [truncated(taskResult(KID_A))],
  });
  assert.deepEqual(readCliStoreFacts('t', { chatsDir: root }), { replyModels: [], childAgentIds: [], complete: false });
  // Balanced braces but not JSON: the same rule, and the parser's message (which can quote its input)
  // never escapes.
  makeChat(root, 'h', 'j', {
    meta: {}, storeMeta: { name: 'j' }, blobs: [wrap('{"id":"1","role":"assistant","content":[SECRET-BAD]}')],
  });
  assert.deepEqual(readCliStoreFacts('j', { chatsDir: root }), { replyModels: [], childAgentIds: [], complete: false });
});

test('an embedded assistant object with no content array makes the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [wrap(embed({ role: 'assistant', content: 'flat' }))] });
  assert.equal(readCliStoreFacts('p', { chatsDir: root }).complete, false);
});

test('a reply stored both as a JSON row and embedded in a binary row stays unanimous', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', {
    meta: {},
    storeMeta: { name: 'p' },
    blobs: [assistant('m1'), wrap(embed(assistant('m1'))), taskResult(KID_A), wrap(embed(taskResult(KID_A)))],
  });
  const facts = readCliStoreFacts('p', { chatsDir: root });
  // Both copies are read (so the embedded one is really seen) and both agree.
  assert.deepEqual(facts.replyModels, ['m1', 'm1']);
  assert.deepEqual(facts.childAgentIds, [KID_A]);
  assert.equal(facts.complete, true);
});

test('at most 8 embedded objects are read per binary row; a 9th reply makes the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  const replies = [];
  for (let i = 0; i < 9; i += 1) replies.push(embed(embeddedReply(`m${i}`)));
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [wrap(...replies)] });
  const facts = readCliStoreFacts('p', { chatsDir: root });
  assert.deepEqual(facts.replyModels, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  assert.equal(facts.complete, false);
  // Anything past the cap is unread, even when the object AT the cap is not a reply: a later one may
  // be (Codex re-review: eight model-A replies, a user object, then model B read as "complete").
  makeChat(root, 'h', 'q', {
    meta: {}, storeMeta: { name: 'q' }, blobs: [wrap(...replies.slice(0, 8), embed({ role: 'user', content: 'u' }), embed(embeddedReply('m-b')))],
  });
  const q = readCliStoreFacts('q', { chatsDir: root });
  assert.equal(q.complete, false);
  assert.equal(q.replyModels.includes('m-b'), false);
  // Exactly eight objects: nothing is past the cap, so nothing is unread.
  makeChat(root, 'h', 'r', { meta: {}, storeMeta: { name: 'r' }, blobs: [wrap(...replies.slice(0, 8))] });
  assert.equal(readCliStoreFacts('r', { chatsDir: root }).complete, true);
});

test('an oversized binary row is never fetched and always makes the facts incomplete', { skip: !sqlite }, () => {
  const root = tmpChats();
  const big = wrap(embed(embeddedReply('m-big')), Buffer.alloc(70 * 1024, 0x20));
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [assistant('m1'), big] });
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite });
  assert.deepEqual(facts, { replyModels: ['m1'], childAgentIds: [], complete: false });
  // Row 2's payload is never selected — not whole, not as a prefix.
  const whole = spy.calls.filter((c) => /SELECT data FROM blobs WHERE rowid = \?/.test(c.sql)).map((c) => c.params[0]);
  assert.deepEqual(whole, [1]);
  assert.equal(spy.calls.some((c) => /substr\(CAST\(data AS BLOB\), 1, 4096\)/.test(c.sql)), false);
  // A reply deep inside an oversized row is exactly the case a prefix probe missed.
  makeChat(root, 'h', 'q', {
    meta: {}, storeMeta: { name: 'q' }, blobs: [wrap(Buffer.alloc(8 * 1024, 0x20), embed(embeddedReply('m-far')), Buffer.alloc(70 * 1024, 0x20))],
  });
  assert.equal(readCliStoreFacts('q', { chatsDir: root }).complete, false);
  // A tool marker counts too.
  makeChat(root, 'h', 'r', {
    meta: {}, storeMeta: { name: 'r' }, blobs: [wrap(embed(taskResult(KID_A)), Buffer.alloc(70 * 1024, 0x20))],
  });
  assert.equal(readCliStoreFacts('r', { chatsDir: root }).complete, false);
});

test('the binary row cap is overridable and never exceeds maxRowBytes', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs: [wrap(embed(embeddedReply('m1')))] });
  assert.equal(readCliStoreFacts('p', { chatsDir: root, limits: { maxBinaryRowBytes: 64 } }).complete, false);
  clearCliChatCache();
  assert.equal(readCliStoreFacts('p', { chatsDir: root, limits: { maxRowBytes: 64 } }).complete, false);
  clearCliChatCache();
  assert.deepEqual(readCliStoreFacts('p', { chatsDir: root }).replyModels, ['m1']);
});

test('binary rows spend the byte budget, and the budget still holds', { skip: !sqlite }, () => {
  const root = tmpChats();
  const blobs = [];
  for (let i = 0; i < 6; i += 1) {
    blobs.push(wrap(embed(embeddedReply('m1')), Buffer.alloc(200 + i * 50, 0x20)));
    blobs.push(assistant('m1', [{ type: 'text', text: 'y'.repeat(300) }]));
  }
  makeChat(root, 'h', 'p', { meta: {}, storeMeta: { name: 'p' }, blobs });
  const lengths = blobs.map((b) => (Buffer.isBuffer(b) ? b.length : Buffer.byteLength(JSON.stringify(b))));
  const spy = spySqlite();
  const facts = readCliStoreFacts('p', { chatsDir: root, sqlite: spy.sqlite, limits: { maxBytes: 3000 } });
  assert.equal(facts.complete, false);
  assert.ok(facts.replyModels.length >= 1 && facts.replyModels.length < 12);
  const spent = fetchedRowids(spy).reduce((sum, rid) => sum + lengths[rid - 1], 0);
  assert.ok(spent <= 3000, `bytes fetched (${spent}) stay within the budget`);
  // With room, every copy is read.
  clearCliChatCache();
  assert.equal(readCliStoreFacts('p', { chatsDir: root }).replyModels.length, 12);
});

// ─── listCliSubagents ───────────────────────────────────────────────────────

test('listCliSubagents opens exactly the children named in the parent store', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'parent', {
    meta: { title: 'p' },
    storeMeta: { name: 'p', createdAt: 1000 },
    blobs: [assistant('m1'), taskResult(KID_B), taskResult(KID_A)],
  });
  makeChat(root, 'h', KID_A, { storeMeta: childMeta('parent', 2000, 'toolu_a', 'generalPurpose') });
  makeChat(root, 'h', KID_B, { storeMeta: childMeta('parent', 1500, 'toolu_b', 'explore') });
  // Unrelated meta-less dirs, some even claiming the same parent: none is ever opened.
  for (let i = 0; i < 100; i += 1) {
    makeChat(root, 'h', `stray-${i}`, i % 10 === 0 ? { storeMeta: childMeta('parent', 3000) } : {});
  }
  const spy = spySqlite();
  const kids = listCliSubagents('parent', { chatsDir: root, sqlite: spy.sqlite });
  assert.deepEqual(openedChats(spy).sort(), [KID_A, KID_B, 'parent'].sort());
  assert.deepEqual(kids.map((k) => k.agentId), [KID_B, KID_A], 'sorted by start');
  assert.equal(kids[1].typeName, 'generalPurpose');
  assert.equal(kids[1].toolCallId, 'toolu_a');
  assert.equal(kids[1].startMs, 2000);
  assert.ok(kids[1].endMs >= kids[1].startMs);
  assert.deepEqual(Object.keys(kids[0]).sort(), ['agentId', 'endMs', 'startMs', 'toolCallId', 'typeName']);
  assert.equal(JSON.stringify(kids).includes('SECRET'), false);
});

test('listCliSubagents drops a child whose parentAgentId is someone else', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'parent', { meta: {}, storeMeta: { name: 'p' }, blobs: [taskResult(KID_A), taskResult(KID_B)] });
  makeChat(root, 'h', KID_A, { storeMeta: childMeta('parent', 2000) });
  // Only the root points at `parent`: a grandchild is not a direct child.
  makeChat(root, 'h', KID_B, {
    storeMeta: { createdAt: 2000, subagentInfo: { parentAgentId: 'other', rootParentAgentId: 'parent', toolCallId: 't', typeName: 'x' } },
  });
  assert.deepEqual(listCliSubagents('parent', { chatsDir: root }).map((k) => k.agentId), [KID_A]);
});

test('listCliSubagents with an expired deadline returns [] and opens nothing', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'parent', { meta: {}, storeMeta: { name: 'p' }, blobs: [taskResult(KID_A)] });
  makeChat(root, 'h', KID_A, { storeMeta: childMeta('parent', 2000) });
  const spy = spySqlite();
  assert.deepEqual(listCliSubagents('parent', { chatsDir: root, sqlite: spy.sqlite, deadline: Date.now() - 1 }), []);
  assert.deepEqual(spy.opened, []);
});

test('listCliSubagents opens at most 64 children per call', { skip: !sqlite }, () => {
  const root = tmpChats();
  const ids = [];
  for (let i = 0; i < 70; i += 1) ids.push(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
  makeChat(root, 'h', 'parent', { meta: {}, storeMeta: { name: 'p' }, blobs: ids.map((id) => taskResult(id)) });
  ids.forEach((id, i) => makeChat(root, 'h', id, { storeMeta: childMeta('parent', 2000 + i) }));
  const spy = spySqlite();
  const kids = listCliSubagents('parent', { chatsDir: root, sqlite: spy.sqlite });
  assert.equal(kids.length, 64);
  assert.equal(openedChats(spy).filter((c) => c !== 'parent').length, 64);
});

// ─── privacy: the CLI path never snapshots ──────────────────────────────────

test('no CLI reader ever copies a store to temp, even when it cannot be read', { skip: !sqlite }, () => {
  const root = tmpChats();
  makeChat(root, 'h', 'broken', { meta: { title: 'b' }, garbageStore: true });
  makeChat(root, 'h', 'parent', { meta: {}, storeMeta: { name: 'p' }, blobs: [taskResult(KID_A)] });
  makeChat(root, 'h', KID_A, { garbageStore: true });
  const copies = [];
  const deps = { chatsDir: root, mkdtemp: (prefix) => { copies.push(prefix); throw new Error('no snapshot expected'); } };
  assert.equal(readCliChatMeta('broken', deps).title, 'b');
  assert.equal(readCliStoreFacts('broken', deps), null);
  assert.deepEqual(listCliSubagents('broken', deps), []);
  assert.deepEqual(listCliSubagents('parent', deps), []);
  assert.deepEqual(copies, []);
});

// ─── degrade ────────────────────────────────────────────────────────────────

test('every reader returns null/[] when the chats dir does not exist', () => {
  const opts = { chatsDir: path.join(os.tmpdir(), 'beezi-no-such-dir-' + Date.now()) };
  clearCliChatCache();
  assert.equal(findCliChatDir('x', opts), null);
  assert.equal(readCliChatMeta('x', opts), null);
  assert.equal(readCliStoreFacts('x', opts), null);
  assert.deepEqual(listCliSubagents('x', opts), []);
});

test('every reader returns null/[] without node:sqlite, never a throw', () => {
  const root = tmpChats();
  makeChat(root, 'h', 'p', { meta: {} });
  const deps = { chatsDir: root, sqlite: null };
  assert.equal(readCliStoreFacts('p', deps), null);
  assert.deepEqual(listCliSubagents('p', deps), []);
});
