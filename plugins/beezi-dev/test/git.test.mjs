import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskFromBranch,
  sanitizeRemote,
  localRemoteFromRoot,
  isSyntheticLocalRemote,
  convertLegacyLocalRemote,
  sanitizeQueuedPayloadRemote,
  clampBranch,
  MAX_BRANCH_CHARS,
  UNKNOWN_BRANCH,
  UNATTRIBUTED_REMOTE,
  TASK_BRANCH_RE,
} from '../lib/git.mjs';

test('taskFromBranch — extracts task token from a task branch', () => {
  assert.equal(taskFromBranch('feature/task-abc-123'), 'task-abc-123');
  assert.equal(taskFromBranch('beezi/task-PROJ_9'), 'task-PROJ_9');
});

test('taskFromBranch — null when the branch does not fit', () => {
  assert.equal(taskFromBranch('main'), null);
  assert.equal(taskFromBranch('feature/no-task-here'), null);
  assert.equal(taskFromBranch('task-abc'), null); // needs a leading segment before task-
  assert.equal(taskFromBranch(''), null);
  assert.equal(taskFromBranch(undefined), null);
});

test('taskFromBranch — agrees with TASK_BRANCH_RE (checkpoint filter)', () => {
  for (const branch of ['x/task-1', 'main', 'feat/task-a_b-c', 'nope']) {
    assert.equal(Boolean(taskFromBranch(branch)), TASK_BRANCH_RE.test(branch));
  }
});

test('sanitizeRemote — strips credentials from the URL', () => {
  assert.equal(
    sanitizeRemote('https://user:tok@host/acme/repo.git'),
    'https://host/acme/repo.git',
  );
});

// ── clampBranch ────────────────────────────────────────────────────────────────────────────────
//
// The backend's `branch` column is 255 characters. One over-long field is a PERMANENT 4xx, and a
// permanent 4xx deletes the queue record — the segment's tokens, cost and code changes go with it.

test('clampBranch — the cap is 255 characters', () => {
  assert.equal(MAX_BRANCH_CHARS, 255);
});

test('clampBranch — 255 passes through untouched, 256 is clamped to 255', () => {
  const at = 'b'.repeat(255);
  const over = 'b'.repeat(256);
  assert.equal(clampBranch(at), at);
  assert.equal(clampBranch(at).length, 255);
  assert.equal(clampBranch(over).length, 255);
  assert.equal(clampBranch(over), at);
});

test('clampBranch — a branch well under the cap is returned verbatim', () => {
  assert.equal(clampBranch('feature/task-123'), 'feature/task-123');
  assert.equal(clampBranch('release/2026.01'), 'release/2026.01');
});

test('clampBranch — unknown/detached/empty falls back to (unknown)', () => {
  assert.equal(UNKNOWN_BRANCH, '(unknown)');
  assert.equal(clampBranch(null), UNKNOWN_BRANCH);
  assert.equal(clampBranch(undefined), UNKNOWN_BRANCH);
  assert.equal(clampBranch(''), UNKNOWN_BRANCH);
  assert.equal(clampBranch('   '), UNKNOWN_BRANCH);
  assert.equal(clampBranch(42), UNKNOWN_BRANCH);
  assert.equal(clampBranch({}), UNKNOWN_BRANCH);
  // The fallback survives its own clamp — the audit path re-clamps values the live path produced.
  assert.equal(clampBranch(UNKNOWN_BRANCH), UNKNOWN_BRANCH);
});

test('clampBranch — surrounding whitespace is trimmed, not counted against the cap', () => {
  assert.equal(clampBranch('  main\n'), 'main');
  const padded = `  ${'b'.repeat(255)}  `;
  assert.equal(clampBranch(padded), 'b'.repeat(255));
});

test('clampBranch — is idempotent (the shared sanitizer runs on live and audit reports)', () => {
  for (const value of ['main', 'b'.repeat(300), '', null, '  spaced  ']) {
    assert.equal(clampBranch(clampBranch(value)), clampBranch(value));
  }
});

test('clampBranch — never cuts a surrogate pair in half', () => {
  // A lone surrogate is not valid UTF-8; JSON.stringify emits it as a bare \\ud83d escape and the
  // DTO can reject the whole report. Losing one emoji is cheaper than losing the segment.
  const branch = 'x'.repeat(254) + '\u{1F600}';
  const clamped = clampBranch(branch);
  assert.ok(clamped.length <= MAX_BRANCH_CHARS);
  assert.equal(clamped, 'x'.repeat(254));
  assert.equal(Buffer.from(clamped, 'utf-8').toString('utf-8'), clamped, 'round-trips as valid UTF-8');
});

// ── localRemoteFromRoot ────────────────────────────────────────────────────────────────────────
//
// A synthetic remote used to be `local://<absolute path>`, which puts the user's home directory —
// their account name, their private folder names — on the wire. Only the FOLDER travels now, the
// same `local:<folder>` convention the sibling Claude plugin already reports under.

test('localRemoteFromRoot — only the folder name travels, never the path around it', () => {
  assert.equal(localRemoteFromRoot('/home/alice/work/checkout'), 'local:checkout');
  assert.ok(!localRemoteFromRoot('/home/alice/work/checkout').includes('alice'));
  assert.ok(!localRemoteFromRoot('/home/alice/work/checkout').includes('/'.repeat(1) + 'home'));
});

test('localRemoteFromRoot — Windows drive paths yield the folder, with no drive or path', () => {
  assert.equal(localRemoteFromRoot('C:\\Users\\Me\\Project'), 'local:Project');
  assert.equal(localRemoteFromRoot('C:/Users/Me/Project'), 'local:Project');
  assert.equal(localRemoteFromRoot('\\\\server\\share\\Project'), 'local:Project');
});

test('localRemoteFromRoot — POSIX paths yield the folder', () => {
  assert.equal(localRemoteFromRoot('/repo/app'), 'local:app');
  assert.equal(localRemoteFromRoot('/app'), 'local:app');
});

test('localRemoteFromRoot — trailing separators do not change the identity', () => {
  assert.equal(localRemoteFromRoot('/repo/app/'), 'local:app');
  assert.equal(localRemoteFromRoot('/repo/app///'), 'local:app');
  assert.equal(localRemoteFromRoot('C:\\ws\\a\\'), 'local:a');
});

test('localRemoteFromRoot — case is preserved so the key matches the sibling plugin byte for byte', () => {
  // Deliberately NOT folded: the Claude plugin reports `local:${path.basename(dir)}` unfolded, and
  // a Cursor client that lowercased would report the same checkout under a second key forever.
  assert.equal(localRemoteFromRoot('C:/ws/Project'), 'local:Project');
  assert.notEqual(localRemoteFromRoot('C:/ws/Project'), localRemoteFromRoot('C:/ws/project'));
});

test('localRemoteFromRoot — no absolute path can ever appear in the result', () => {
  for (const root of ['/home/alice/secret-client/app', 'C:\\Users\\alice\\secret-client\\app']) {
    const remote = localRemoteFromRoot(root);
    assert.equal(remote, 'local:app');
    assert.ok(!remote.includes('alice'), 'no username');
    assert.ok(!remote.includes('secret-client'), 'no parent folder');
    assert.ok(!/[\\/]/.test(remote.slice('local:'.length)), 'no separator survives');
  }
});

test('localRemoteFromRoot — equal basenames collide, and that is the documented limitation', () => {
  // The shared `local:<folder>` convention is not a uniqueness promise. Hashing the path into a new
  // key scheme would be a private backend contract nobody else can read; two checkouts named `app`
  // reporting as one repo is the honest, shared behaviour.
  assert.equal(localRemoteFromRoot('/a/app'), localRemoteFromRoot('/b/app'));
  assert.equal(localRemoteFromRoot('/a/app'), 'local:app');
});

test('localRemoteFromRoot — no usable folder falls back to UNATTRIBUTED_REMOTE', () => {
  assert.equal(localRemoteFromRoot(null), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot(undefined), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot(''), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('   '), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot(7), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('/'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('C:\\'), UNATTRIBUTED_REMOTE, 'a bare drive names no folder');
  assert.equal(localRemoteFromRoot('C:'), UNATTRIBUTED_REMOTE);
  // No path.resolve() any more — resolving made the answer depend on process.cwd, which is not a
  // property of the checkout — so a relative root has to be rejected here rather than reported as
  // a repository literally called "." or "..".
  assert.equal(localRemoteFromRoot('.'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('./'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('..'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('../'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('..\\'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('/repo/app/..'), UNATTRIBUTED_REMOTE);
  assert.equal(localRemoteFromRoot('/repo/app/.'), UNATTRIBUTED_REMOTE);
});

test('localRemoteFromRoot — its own output is recognized as synthetic and is stable under conversion', () => {
  const remote = localRemoteFromRoot('/home/alice/work/checkout');
  assert.ok(isSyntheticLocalRemote(remote));
  assert.equal(convertLegacyLocalRemote(remote), remote);
});

// ── isSyntheticLocalRemote / convertLegacyLocalRemote ──────────────────────────────────────────

test('isSyntheticLocalRemote — recognizes both the legacy and the current spelling', () => {
  assert.equal(isSyntheticLocalRemote('local://c:/users/me/project'), true);
  assert.equal(isSyntheticLocalRemote('local:///repo/app'), true);
  assert.equal(isSyntheticLocalRemote(UNATTRIBUTED_REMOTE), true);
  assert.equal(isSyntheticLocalRemote('local:app'), true);
});

test('isSyntheticLocalRemote — a real origin is never synthetic', () => {
  assert.equal(isSyntheticLocalRemote('https://github.com/acme/repo.git'), false);
  assert.equal(isSyntheticLocalRemote('git@github.com:acme/repo.git'), false);
  assert.equal(isSyntheticLocalRemote('ssh://git@dev.azure.com/org/proj/_git/repo'), false);
  assert.equal(isSyntheticLocalRemote('https://dev.azure.com/org/proj/_git/local'), false);
  assert.equal(isSyntheticLocalRemote(null), false);
  assert.equal(isSyntheticLocalRemote(''), false);
  assert.equal(isSyntheticLocalRemote(42), false);
});

test('convertLegacyLocalRemote — a persisted local:// path becomes local:<folder>', () => {
  assert.equal(convertLegacyLocalRemote('local://c:/users/me/project'), 'local:project');
  assert.equal(convertLegacyLocalRemote('local:///repo/app'), 'local:app');
  assert.equal(convertLegacyLocalRemote('local:///repo/app/'), 'local:app');
});

test('convertLegacyLocalRemote — leaves the catch-all bucket alone', () => {
  // `local://unknown` carries no path, so it is not the disclosure this change exists to fix.
  // Rewriting it would fork one backend bucket into two for no privacy gain at all.
  assert.equal(convertLegacyLocalRemote(UNATTRIBUTED_REMOTE), UNATTRIBUTED_REMOTE);
});

test('convertLegacyLocalRemote — is idempotent and leaves real origins untouched', () => {
  const once = convertLegacyLocalRemote('local://c:/users/me/project');
  assert.equal(convertLegacyLocalRemote(once), once);
  for (const url of [
    'https://github.com/acme/repo.git',
    'git@github.com:acme/repo.git',
    'ssh://git@dev.azure.com/org/proj/_git/repo',
  ]) {
    assert.equal(convertLegacyLocalRemote(url), url);
  }
  assert.equal(convertLegacyLocalRemote(null), null);
  assert.equal(convertLegacyLocalRemote(5), 5);
});

test('convertLegacyLocalRemote — a legacy value naming no folder lands in the catch-all', () => {
  assert.equal(convertLegacyLocalRemote('local://'), UNATTRIBUTED_REMOTE);
  assert.equal(convertLegacyLocalRemote('local:///'), UNATTRIBUTED_REMOTE);
  assert.equal(convertLegacyLocalRemote('local://c:/'), UNATTRIBUTED_REMOTE);
});

// ── sanitizeQueuedPayloadRemote ────────────────────────────────────────────────────────────────
//
// Queue files written before this change still carry a full absolute path. They must be rewritten
// BEFORE sending — and nothing else about them may move: the segmentId is the server's idempotency
// key, and `_retry` is the queue's own age/backoff bookkeeping.

const legacyPayload = () => ({
  segmentId: 'conv-1:0-4',
  sessionId: 'conv-1',
  remote: 'local://c:/users/me/project',
  branch: 'main',
  from_line: 0,
  to_line: 4,
  tokens: { token_input: 10, token_output: 20 },
  models: [{ model: 'claude-4.5-sonnet', requests: 2, cost_usd: 0.34, pool: 'credits' }],
  operations: { read_file: 3 },
  duration_sec: 42,
  _retry: { attempts: 2, nextAttemptAt: 1700000060000, firstQueuedAt: 1700000000000 },
});

test('sanitizeQueuedPayloadRemote — rewrites only the synthetic remote', () => {
  const before = legacyPayload();
  const after = sanitizeQueuedPayloadRemote(before);
  assert.equal(after.remote, 'local:project');
  assert.notEqual(after, before, 'the input payload is not mutated');
  assert.equal(before.remote, 'local://c:/users/me/project', 'the caller\'s object is untouched');
});

test('sanitizeQueuedPayloadRemote — preserves segmentId, amounts, counters and firstQueuedAt', () => {
  const before = legacyPayload();
  const after = sanitizeQueuedPayloadRemote(before);
  assert.deepEqual(
    { ...after, remote: before.remote },
    before,
    'every field other than `remote` survives byte for byte',
  );
  assert.equal(after.segmentId, 'conv-1:0-4');
  assert.deepEqual(after._retry, { attempts: 2, nextAttemptAt: 1700000060000, firstQueuedAt: 1700000000000 });
  assert.deepEqual(after.tokens, { token_input: 10, token_output: 20 });
  assert.deepEqual(after.models, before.models);
  assert.equal(after.duration_sec, 42);
});

test('sanitizeQueuedPayloadRemote — is idempotent', () => {
  const once = sanitizeQueuedPayloadRemote(legacyPayload());
  const twice = sanitizeQueuedPayloadRemote(once);
  assert.deepEqual(twice, once);
  assert.equal(twice, once, 'a payload with nothing to migrate is returned by reference');
});

test('sanitizeQueuedPayloadRemote — real HTTPS/SSH origins are returned untouched, by reference', () => {
  for (const url of ['https://github.com/acme/repo.git', 'git@github.com:acme/repo.git']) {
    const payload = { ...legacyPayload(), remote: url };
    assert.equal(sanitizeQueuedPayloadRemote(payload), payload);
  }
});

test('sanitizeQueuedPayloadRemote — the catch-all bucket is left in place', () => {
  const payload = { ...legacyPayload(), remote: UNATTRIBUTED_REMOTE };
  assert.equal(sanitizeQueuedPayloadRemote(payload), payload);
});

test('sanitizeQueuedPayloadRemote — a malformed queue record is never thrown on', () => {
  assert.equal(sanitizeQueuedPayloadRemote(null), null);
  assert.equal(sanitizeQueuedPayloadRemote(undefined), undefined);
  assert.equal(sanitizeQueuedPayloadRemote('junk'), 'junk');
  const noRemote = { segmentId: 'conv-1:0-4' };
  assert.equal(sanitizeQueuedPayloadRemote(noRemote), noRemote);
  const arr = [];
  assert.equal(sanitizeQueuedPayloadRemote(arr), arr);
});
