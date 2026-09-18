import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushQueue, runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths-cursor.mjs';

// The read cursor is the only record of which sidecar lines have already been reported. Every test
// here is a way it used to move when it should not have, and each one costs real analytics: moving
// forward over unsent lines loses them outright, moving backward re-reports them under a segmentId
// the server has never seen, so its dedupe cannot catch the overlap.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cursor-safety-'));
  const prev = process.env.BEEZI_CURSOR_HOME;
  process.env.BEEZI_CURSOR_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function gitWithOrigin(args) {
  if (args[0] === 'remote') return 'https://example.com/acme/app.git';
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

// A repo that has no origin yet — routine on a fresh `git init`, and the state Windows reports for
// a `detected dubious ownership` repository.
function gitWithoutOrigin(args) {
  if (args[0] === 'remote') throw new Error("error: No such remote 'origin'");
  if (args[0] === 'branch') return 'feature/task-42';
  if (args[0] === 'reflog') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
}

function delta(overrides = {}) {
  return {
    conversationId: 'conv-1',
    segmentId: 'conv-1:0-4',
    from: 0,
    to: 4,
    nextCursor: 4,
    repoRoot: '/repo',
    branch: 'feature/task-42',
    entries: [{ model: 'm', billing_pool: 'subscription', requests: 1, cost_usd: 0 }],
    rateLimitEvents: [],
    operations: {},
    est_tokens: 0,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    duration_ms: 1000,
    diagnostics: { schemaMiss: false },
    ...overrides,
  };
}

const deps = (over = {}) => ({
  getAccessToken: async () => 'tok',
  gitImpl: gitWithOrigin,
  fetchImpl: async () => { throw new Error('network disabled in test'); },
  ...over,
});

const queuedFiles = () => { try { return fs.readdirSync(queueDir()); } catch { return []; } };
const stateOf = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));

test('a repo without origin is still enqueued under a local: remote', async (t) => {
  tmpHome(t);
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ gitImpl: gitWithoutOrigin, computeDelta: () => delta({ repoRoot: '/repo', branch: null }) }),
  );

  const files = queuedFiles();
  assert.equal(files.length, 1, 'missing origin must not drop the segment');
  const payload = JSON.parse(fs.readFileSync(path.join(queueDir(), files[0]), 'utf-8'));
  assert.equal(payload.remote, 'local:repo');
  assert.equal(stateOf('conv-1').cursor, 4);
});

test('the same lines are reported once the blocker clears', async (t) => {
  tmpHome(t);
  // A write failure is the remaining reason a segment may be declined; simulate by pointing the
  // home at a file so queueDir() cannot be created as a directory.
  const home = process.env.BEEZI_CURSOR_HOME;
  fs.writeFileSync(path.join(home, 'queue'), 'not-a-dir');
  const opts = { computeDelta: () => delta() };
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ ...opts }));
  assert.equal(stateOf('conv-1')?.cursor ?? 0, 0, 'cursor must not advance over an unsent segment');

  fs.rmSync(path.join(home, 'queue'));
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps(opts));

  assert.equal(queuedFiles().length, 1);
  assert.equal(stateOf('conv-1').cursor, 4);
});

test('the cursor never moves backwards', async (t) => {
  tmpHome(t);
  await runCheckpoint({ session_id: 'conv-1', cwd: '/repo' }, deps({ computeDelta: () => delta() }));
  assert.equal(stateOf('conv-1').cursor, 4);

  // computeDelta derives `to` from the events it managed to read, and any read failure — an
  // antivirus scanner holding the file, a pruned sidecar — reads as "zero events".
  await runCheckpoint(
    { session_id: 'conv-1', cwd: '/repo' },
    deps({ computeDelta: () => delta({ from: 0, to: 0, nextCursor: 0 }) }),
  );

  assert.equal(stateOf('conv-1').cursor, 4, 'a failed read must not rewind what was reported');
});

test('a recoverable status keeps the queued report for the next hook', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  const file = path.join(home, 'queue', 'conv-1_0-4.json');

  // 425 (Too Early) was in the retryable set from the start and had never been exercised by a test,
  // so nothing would have caught it being dropped from the set when the set moved to
  // lib/queue-backoff.mjs. It is here now.
  //
  // The payload is rewritten at the top of each iteration, which the previous version of this test
  // did not need to do. A recoverable failure now records `_retry` ON the file (see
  // lib/queue-backoff.mjs) so the next flush skips it instead of burning the budget on the same head
  // file forever — which means a second flush inside 30s would report `deferred: 1`, not
  // `failed: 1`. Re-seeding isolates each status, which is what this test is actually about.
  for (const status of [401, 403, 408, 425, 429, 500, 503]) {
    fs.writeFileSync(file, JSON.stringify({ segmentId: 'conv-1:0-4' }));
    const res = await flushQueue('tok', { fetchImpl: async () => ({ status, json: async () => ({}) }) });
    assert.equal(res.failed, 1, `HTTP ${status} must be retried, not discarded`);
    assert.equal(res.rejected, 0);
    // A queue file is the only copy — the cursor has already moved past these lines.
    assert.deepEqual(queuedFiles(), ['conv-1_0-4.json'], `HTTP ${status} deleted the only copy`);
    // And the segment itself survived the rewrite: retry state is added, nothing is taken away.
    const kept = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(kept.segmentId, 'conv-1:0-4', `HTTP ${status} corrupted the only copy`);
    assert.equal(kept._retry.attempts, 1, `HTTP ${status} recorded no backoff, so it starves the queue`);
  }
});

test('a file that has been failing for two weeks is finally dropped', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  const file = path.join(home, 'queue', 'conv-1_0-4.json');
  const T0 = 1_700_000_000_000;
  const FIFTEEN_DAYS = 15 * 24 * 60 * 60 * 1000;

  // The age that decides is `_retry.firstQueuedAt`, never mtime: recording a retry REWRITES the
  // file, so its mtime is minutes old no matter how long it has been failing, and lib/prune.mjs
  // deletes on mtime. Without this rule the one file that can never be sent is also the one file
  // that can never be deleted — and the queue it sits at the head of is starved behind it.
  fs.writeFileSync(file, JSON.stringify({
    segmentId: 'conv-1:0-4',
    _retry: { attempts: 40, nextAttemptAt: T0, firstQueuedAt: T0 - FIFTEEN_DAYS },
  }));

  let posted = 0;
  const res = await flushQueue('tok', {
    now: () => T0,
    fetchImpl: async () => { posted += 1; return { status: 500, json: async () => ({}) }; },
  });

  assert.equal(posted, 0, 'an expired file must not cost a request on its way out');
  assert.equal(res.expired, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(queuedFiles(), []);
});

test('a file that has never failed is not aged out, however old the queue is', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(home, 'queue', 'conv-1_0-4.json'), JSON.stringify({ segmentId: 'conv-1:0-4' }));

  // No `_retry` means no recorded age, so the give-up rule has nothing to measure and must not
  // guess. prune.mjs's mtime rule is the correct one for these files precisely because nothing ever
  // rewrites them.
  const res = await flushQueue('tok', {
    now: () => 1_900_000_000_000,
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  });
  assert.equal(res.expired, 0);
  assert.equal(res.flushed, 1);
});

test('a genuinely permanent rejection still drops the file', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(home, 'queue', 'conv-1_0-4.json'), JSON.stringify({ segmentId: 'conv-1:0-4' }));

  const res = await flushQueue('tok', {
    fetchImpl: async () => ({ status: 422, json: async () => ({ message: 'branch not linked' }) }),
  });
  assert.equal(res.rejected, 1);
  assert.equal(res.lastError, 'branch not linked');
  assert.deepEqual(queuedFiles(), []);
});

test('a delivered report whose file cannot be deleted is not counted as a failure', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(home, 'queue', 'conv-1_0-4.json'), JSON.stringify({ segmentId: 'conv-1:0-4' }));

  // On Windows a scanner or backup agent holding a handle makes the unlink throw. Counting that as
  // `failed` told the user the send had failed when the server had already accepted it.
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  t.after(() => { fs.unlinkSync = realUnlink; });

  const res = await flushQueue('tok', { fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  assert.equal(res.flushed, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.stuck, 1);
});
