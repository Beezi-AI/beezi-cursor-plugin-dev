import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildHistoryIndex,
  renderHistorySummary,
  conversationIdFromKey,
  HISTORY_UPLOAD_ENABLED,
  HistorySource,
} from '../lib/history-index.mjs';

// Discovery only. Cursor's durable store (`state.vscdb`, `composerData:<id>`) holds conversations
// the sidecar never saw — everything from before the plugin was installed, and everything the
// 14-day retention has since deleted. Enumerating them is possible; UPLOADING them is not, and the
// gap between those two sentences is what this module is careful about:
//
//   - a database that cannot be read is `unavailable`, never a zero count. "This machine has no
//     history" and "we could not look" are opposite facts and must never share a number.
//   - `usageData` is CUMULATIVE PRICED OVERAGE, not whole-session cost, and carries neither total
//     tokens nor duration. It cannot stand in for a session report, so no DB-only candidate is
//     uploadable until a backend contract for a partial snapshot exists.
//   - the 24-hour active exclusion and the account boundary still apply.

const CLOCK = 40 * 24 * 60 * 60 * 1000;

const conversation = (sessionId, mtimeMs = 1000) => ({
  sessionId,
  eventsPath: `C:/home/.beezi-cursor/events/${sessionId}.jsonl`,
  mtimeMs,
  size: 1024,
});

const keys = (...ids) => ({
  keys: ids.map((id) => ({ key: `composerData:${id}`, table: 'cursorDiskKV' })),
  truncated: false,
  reason: 'complete',
});

function makeDeps(overrides = {}) {
  return {
    now: () => CLOCK,
    listConversations: () => [conversation('a')],
    lastActivityOfImpl: (entry) => entry.mtimeMs,
    readKeysBoundedImpl: () => keys('a', 'b'),
    ...overrides,
  };
}

// ─── key parsing ────────────────────────────────────────────────────────────

test('a conversation id is the part of the key after the prefix', () => {
  assert.equal(conversationIdFromKey('composerData:abc-123'), 'abc-123');
  assert.equal(conversationIdFromKey('composerData:'), null);
  assert.equal(conversationIdFromKey('otherData:abc'), null);
  assert.equal(conversationIdFromKey(null), null);
});

// ─── availability ───────────────────────────────────────────────────────────

test('an unreadable durable store is unavailable, never a zero history count', () => {
  const index = buildHistoryIndex(makeDeps({ readKeysBoundedImpl: () => null }));

  assert.equal(index.durable.available, false);
  assert.equal(index.durable.reason, 'unavailable');
  assert.equal(index.durable.count, null, 'an unavailable source must not report a count');
  assert.equal(index.counts.durableOnly, 0);
});

test('a readable-but-empty durable store is a real zero', () => {
  const index = buildHistoryIndex(makeDeps({ readKeysBoundedImpl: () => keys() }));

  assert.equal(index.durable.available, true);
  assert.equal(index.durable.count, 0);
});

test('a throwing enumeration is unavailable, not a crash', () => {
  const index = buildHistoryIndex(makeDeps({ readKeysBoundedImpl: () => { throw new Error('locked'); } }));

  assert.equal(index.durable.available, false);
  assert.equal(index.durable.reason, 'unavailable');
});

test('a truncated enumeration says the count is a floor, not a total', () => {
  const index = buildHistoryIndex(makeDeps({
    readKeysBoundedImpl: () => ({ ...keys('a', 'b'), truncated: true, reason: 'max-rows' }),
  }));

  assert.equal(index.durable.truncated, true);
  assert.equal(index.durable.reason, 'max-rows');
  assert.match(renderHistorySummary(index).join('\n'), /at least/i);
});

// ─── merging ────────────────────────────────────────────────────────────────

test('a conversation seen in both sources is merged once, with both sources named', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [conversation('a'), conversation('b')],
    readKeysBoundedImpl: () => keys('a', 'b'),
  }));

  assert.equal(index.candidates.length, 2);
  assert.deepEqual(index.candidates.map((c) => c.sessionId).sort(), ['a', 'b']);
  assert.deepEqual(index.candidates.find((c) => c.sessionId === 'a').sources, [HistorySource.SIDECAR, HistorySource.DURABLE]);
  assert.equal(index.counts.both, 2);
  assert.equal(index.counts.sidecarOnly, 0);
  assert.equal(index.counts.durableOnly, 0);
});

test('duplicate durable keys for one id collapse to a single candidate', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [],
    readKeysBoundedImpl: () => ({
      keys: [
        { key: 'composerData:a', table: 'cursorDiskKV' },
        { key: 'composerData:a', table: 'ItemTable' },
      ],
      truncated: false,
      reason: 'complete',
    }),
  }));

  assert.equal(index.candidates.length, 1);
  assert.equal(index.counts.durableOnly, 1);
});

test('a durable-only conversation is counted and marked unsupported for upload', () => {
  const index = buildHistoryIndex(makeDeps({ listConversations: () => [] }));

  assert.equal(index.counts.durableOnly, 2);
  assert.equal(index.counts.sidecarOnly, 0);
  assert.equal(index.unsupported.durableOnly, 2);
  assert.equal(index.uploadable, 0);
});

test('a sidecar-only conversation keeps its sidecar metrics as the default source', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [conversation('z')],
    readKeysBoundedImpl: () => keys('a'),
  }));

  const z = index.candidates.find((c) => c.sessionId === 'z');
  assert.deepEqual(z.sources, [HistorySource.SIDECAR]);
  assert.equal(z.metricsSource, HistorySource.SIDECAR);
  const a = index.candidates.find((c) => c.sessionId === 'a');
  assert.equal(a.metricsSource, null, 'a durable-only candidate has no usable metrics source');
});

test('a both-source conversation still prefers the sidecar for metrics', () => {
  const index = buildHistoryIndex(makeDeps({ listConversations: () => [conversation('a')] }));

  assert.equal(index.candidates.find((c) => c.sessionId === 'a').metricsSource, HistorySource.SIDECAR);
});

// ─── exclusions ─────────────────────────────────────────────────────────────

test('a session active in the last day is excluded from the candidates', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [conversation('a')],
    lastActivityOfImpl: () => CLOCK - 1000,
    readKeysBoundedImpl: () => keys(),
  }));

  assert.equal(index.counts.active, 1);
  assert.deepEqual(index.candidates, []);
});

test('an active session excluded on the sidecar side is not resurrected by its durable row', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [conversation('a')],
    lastActivityOfImpl: () => CLOCK - 1000,
    readKeysBoundedImpl: () => keys('a'),
  }));

  assert.equal(index.counts.active, 1);
  assert.deepEqual(index.candidates, []);
});

test('an oversize sidecar is counted apart and never read', () => {
  const index = buildHistoryIndex(makeDeps({
    listConversations: () => [{ ...conversation('a'), size: 80 * 1024 * 1024 }],
    readKeysBoundedImpl: () => keys(),
  }));

  assert.equal(index.counts.oversize, 1);
  assert.deepEqual(index.candidates, []);
});

test('the index records the account it was built for', () => {
  const index = buildHistoryIndex(makeDeps({}), { account: 'acct-a' });

  assert.equal(index.account, 'acct-a');
});

// ─── upload gate ────────────────────────────────────────────────────────────

test('upload is disabled and the summary says exactly why', () => {
  assert.equal(HISTORY_UPLOAD_ENABLED, false);
  const index = buildHistoryIndex(makeDeps({ listConversations: () => [] }));
  const summary = renderHistorySummary(index).join('\n');

  assert.match(summary, /2 conversations/);
  assert.match(summary, /not uploaded|cannot be uploaded/i);
  // The reason is a fact about the data, not a shrug: the durable record carries priced overage,
  // no total tokens and no duration, so it cannot stand in for a session report.
  assert.match(summary, /overage|priced/i);
  assert.doesNotMatch(summary, /coming soon/i);
});

test('an unavailable durable store is reported as unknown, never as "no history"', () => {
  const index = buildHistoryIndex(makeDeps({ readKeysBoundedImpl: () => null }));
  const summary = renderHistorySummary(index).join('\n');

  assert.match(summary, /could not be read|unavailable/i);
  assert.doesNotMatch(summary, /0 conversations/);
});

test('a dry run counts and reads no conversation values at all', () => {
  const reads = [];
  buildHistoryIndex(makeDeps({ readComposerDataImpl: (id) => { reads.push(id); return {}; } }));

  assert.deepEqual(reads, [], 'discovery must not parse conversation blobs');
});

// ─── the capture gate (08-C) ────────────────────────────────────────────────

test('the capture matrix is a template and stays free of real data', () => {
  const matrix = JSON.parse(
    fs.readFileSync(new URL('./fixtures/composer-capture-matrix.json', import.meta.url), 'utf-8'),
  );

  // Every question the task requires an answer to before a DB-only upload can be designed.
  const required = [
    'key-format', 'stable-conversation-id', 'timestamps', 'missing-timestamps', 'title',
    'workspace-attribution', 'usage-subscription', 'usage-credits', 'usage-empty',
    'usage-malformed', 'usage-monotonic', 'tokens', 'duration', 'locked-db', 'changed-schema',
  ];
  assert.deepEqual(matrix.rows.map((r) => r.id).sort(), [...required].sort());

  // Unfilled: the gate is open only when a capture from a real install has filled these in.
  assert.equal(matrix.rows.every((r) => r.observed === null), true, 'the committed template must stay unfilled');
  assert.equal(matrix.capturedFrom.cursorVersion, null);

  // Nothing that could identify a person or a machine may be committed with it.
  const serialized = JSON.stringify(matrix);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\|\/Users\/|\/home\//, 'an absolute path leaked into the fixture');
  assert.doesNotMatch(serialized, /[\w.+-]+@[\w-]+\.[\w.]+/, 'an address leaked into the fixture');
});

test('upload stays disabled while the capture matrix is unfilled', () => {
  assert.equal(HISTORY_UPLOAD_ENABLED, false);
});
