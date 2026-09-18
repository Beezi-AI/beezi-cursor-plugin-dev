import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TrackAuthState, runTrack } from '../lib/track-session.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// `beezi-track` is manual recovery: the same data path the hooks use, driven by a user who is
// waiting at a terminal. Two things were wrong with it.
//
// It treated a branch lookup as a precondition for reporting. `currentBranch` throws on a detached
// HEAD and `git` itself fails outside a repository, so `✗ Beezi: not a git repository` was printed
// — and nothing was saved — for a session whose analytics were perfectly intact. The branch only
// ever decided the LABEL echoed back; attribution is the checkpoint's job and works without it.
//
// And it could not explain itself. A refused token, an unreadable credential store, a tenant with
// tracking switched off and a queue that is simply waiting out its backoff all produced the same
// two outcomes ("saved" or "could not be delivered"), so a user could not tell which of them had
// happened or whether anything was theirs to fix.
//
// runTrack returns `{ exitCode, message }` and prints nothing: the thinned scripts/track.mjs owns
// the glyph, the stream and process.exit.

const CWD = path.join('C:', 'work', 'my-project');

function deps(overrides = {}) {
  const calls = { checkpoint: [], flush: [] };
  const base = {
    currentBranch: () => 'main',
    resolveActiveConversation: () => 'conv-1',
    getAuthState: async () => ({ state: TrackAuthState.READY, reason: 'none', token: 'tok-1' }),
    isTrackingAllowed: () => true,
    runCheckpoint: async (input, checkpointDeps, options) => {
      calls.checkpoint.push({ input, options });
      return { enqueued: 1, flush: { sent: 1, flushed: 1, rejected: 0, failed: 0, deferred: 0, gated: false, trackingDisabled: false, lastError: null } };
    },
  };
  return { calls, deps: { ...base, ...overrides } };
}

const flushResult = (patch = {}) => ({
  sent: 0, flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0, stuck: 0,
  gated: false, trackingDisabled: false, quarantined: 0, quarantineFailed: 0, lastError: null,
  ...patch,
});

// ─── the label never decides whether we report ──────────────────────────────────────────────────

test('a detached HEAD falls back to the folder label and still reaches the checkpoint', async () => {
  const { calls, deps: d } = deps({
    currentBranch: () => { throw new Error('detached HEAD: no current branch'); },
  });

  const result = await runTrack({ cwd: CWD }, d);

  assert.equal(result.exitCode, 0);
  assert.match(result.message, /my-project/);
  assert.equal(calls.checkpoint.length, 1, 'a detached HEAD is not a reason to skip the data path');
  assert.deepEqual(calls.checkpoint[0].input, { session_id: 'conv-1', cwd: CWD });
});

test('a directory that is not a git repository is reported on under its folder label', async () => {
  const { calls, deps: d } = deps({
    currentBranch: () => { throw Object.assign(new Error('fatal: not a git repository'), { status: 128 }); },
  });

  const result = await runTrack({ cwd: CWD }, d);

  assert.equal(result.exitCode, 0, 'the analytics exist whether or not git does');
  assert.match(result.message, /my-project/);
  assert.equal(calls.checkpoint.length, 1);
});

test('an unborn branch keeps its name — git --show-current answers before the first commit', async () => {
  const { deps: d } = deps({ currentBranch: () => 'trunk' });
  const result = await runTrack({ cwd: CWD }, d);
  assert.match(result.message, /trunk/);
});

test('a repository with no origin is not runTrack\'s concern at all', async () => {
  // Attribution under a synthetic local remote is the checkpoint's job; runTrack never looks at
  // remotes, so a git that would fail on `remote get-url` changes nothing here.
  const { calls, deps: d } = deps({
    gitImpl: (args) => {
      if (args[0] === 'remote') throw new Error("No such remote 'origin'");
      return 'main';
    },
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.checkpoint.length, 1);
});

test('a task branch is echoed by its task token, not the whole branch name', async () => {
  const { deps: d } = deps({ currentBranch: () => 'feature/task-4821-add-widget' });
  const result = await runTrack({ cwd: CWD }, d);
  assert.match(result.message, /task-4821/);
});

test('a cwd that is a filesystem root still yields a usable label', async () => {
  const { deps: d } = deps({ currentBranch: () => { throw new Error('nope'); } });
  const result = await runTrack({ cwd: path.parse(process.cwd()).root }, d);
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.message, 'string');
  assert.notEqual(result.message.trim(), '');
});

// ─── typed auth outcomes ────────────────────────────────────────────────────────────────────────

test('an unlinked machine is told to sign in, and nothing is computed', async () => {
  const { calls, deps: d } = deps({
    getAuthState: async () => ({ state: TrackAuthState.UNLINKED, reason: 'missing', token: null }),
  });

  const result = await runTrack({ cwd: CWD }, d);

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /not linked/i);
  assert.equal(calls.checkpoint.length, 0);
});

test('an unreadable credential store is NOT reported as an unlinked machine', async () => {
  const { calls, deps: d } = deps({
    getAuthState: async () => ({ state: TrackAuthState.UNAVAILABLE, reason: 'locked', token: null }),
  });

  const result = await runTrack({ cwd: CWD }, d);

  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.message, /sign in/i, 'telling a linked user to sign in invites a needless logout');
  assert.match(result.message, /again/i);
  assert.equal(calls.checkpoint.length, 0);
});

test('an expired grant asks for a fresh sign-in', async () => {
  const { deps: d } = deps({
    getAuthState: async () => ({ state: TrackAuthState.REAUTH_REQUIRED, reason: 'invalid_grant', token: null }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /sign in/i);
});

test('a ready state with no token is refused rather than sent as an empty bearer', async () => {
  const { calls, deps: d } = deps({
    getAuthState: async () => ({ state: TrackAuthState.READY, reason: 'none', token: '' }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.equal(calls.checkpoint.length, 0);
});

// ─── policy ─────────────────────────────────────────────────────────────────────────────────────

test('a tenant with tracking off is told so, and is never told anything was tracked', async () => {
  const { calls, deps: d } = deps({ isTrackingAllowed: () => false });

  const result = await runTrack({ cwd: CWD }, d);

  assert.equal(result.exitCode, 0, 'a policy the user did not set is not their error to fix');
  assert.match(result.message, /turned off|disabled/i);
  assert.doesNotMatch(result.message, /saved|tracked/i);
  assert.equal(calls.checkpoint.length, 0, 'no live compute and no queue write behind a closed gate');
});

test('a flush that came back gated is reported as a policy hold, not as a failure', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 0, flush: flushResult({ gated: true }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /turned off|disabled/i);
});

test('a 403 TRACKING_DISABLED during the flush is reported as a policy hold', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 2, flush: flushResult({ trackingDisabled: true, deferred: 2 }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /turned off|disabled/i);
  assert.doesNotMatch(result.message, /saved/i);
});

// ─── delivery outcomes ──────────────────────────────────────────────────────────────────────────

test('a successful save names the label and the segment count', async () => {
  const { deps: d } = deps({
    currentBranch: () => 'release',
    runCheckpoint: async () => ({ enqueued: 3, flush: flushResult({ sent: 3, flushed: 3 }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /release/);
  assert.match(result.message, /3 segments/);
});

test('one segment is singular', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: flushResult({ sent: 1, flushed: 1 }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.match(result.message, /1 segment\)/);
});

test('nothing new to send says so instead of claiming a save', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 0, flush: flushResult() }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /nothing new/i);
});

test('a deferred backlog is an honest success, not a silent one', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 0, flush: flushResult({ deferred: 4 }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /4/);
  assert.match(result.message, /queued|retried/i);
});

test('a transient delivery failure names the cause and promises the retry', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: flushResult({ failed: 1, lastError: 'HTTP 503' }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /HTTP 503/);
  assert.match(result.message, /queued/i);
});

test('a permanent rejection reports the server\'s own message', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: flushResult({ rejected: 1, lastError: 'segmentId already sealed' }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /segmentId already sealed/);
});

test('a permanent rejection with no readable message still says what happened', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 1, flush: flushResult({ rejected: 1 }) }),
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /rejected/i);
});

test('no recorded conversation is a linked machine with no hooks, and says so', async () => {
  const { calls, deps: d } = deps({ resolveActiveConversation: () => null });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /hook/i);
  assert.equal(calls.checkpoint.length, 0);
});

// ─── seams and safety ───────────────────────────────────────────────────────────────────────────

test('a checkpoint that produced no flush summary still drains the queue through the injected flush', async () => {
  const { calls, deps: d } = deps({
    runCheckpoint: async () => ({ enqueued: 0, flush: null }),
    flushQueue: async (token) => { calls.flush.push(token); return flushResult({ sent: 2, flushed: 2 }); },
  });

  const result = await runTrack({ cwd: CWD }, d);

  assert.deepEqual(calls.flush, ['tok-1']);
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /2 segments/);
});

test('runTrack never throws — an unexpected failure becomes an exit code and a message', async () => {
  const { deps: d } = deps({
    runCheckpoint: async () => { throw new Error('sidecar exploded'); },
  });
  const result = await runTrack({ cwd: CWD }, d);
  assert.equal(result.exitCode, 1);
  assert.equal(typeof result.message, 'string');
  assert.notEqual(result.message.trim(), '');
});

test('runTrack has no update-check surface at all — PIPE-07 stays deferred', async () => {
  // Asserting on the MODULE, not on a call count. An injected `fetchImpl` that is never read proves
  // nothing — runTrack has no such dep, so the counter would stay at zero however much network the
  // file did. Approved §10.1 adds no `updateManifestUrl`, so the honest check is that the update
  // sender has no surface here to grow from: no transport imported, nothing to call.
  const source = await readFile(new URL('../lib/track-session.mjs', import.meta.url), 'utf-8');
  // Comment lines are stripped first. This file explains at length WHY there is no update check,
  // and a grep that matched its own explanation would pass no matter what the code did.
  const NL = String.fromCharCode(10);
  const code = source.split(NL).filter((line) => !line.trim().startsWith('//')).join(' ');

  for (const symbol of ['fetch', 'http', 'checkForUpdate', 'updateManifestUrl', 'postJson', 'getJson', 'apiBase']) {
    assert.equal(code.includes(symbol), false, `lib/track-session.mjs references ${symbol}`);
  }
  // And the positive half: the only modules it pulls in are local, non-transport ones.
  const imported = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imported, [
    './active-conversation.mjs',
    './checkpoint.mjs',
    './friendly-error.mjs',
    './git.mjs',
    './token.mjs',
    './tracking.mjs',
    'path',
  ]);
});

test('runTrack prints nothing itself', async () => {
  const realLog = console.log;
  const realError = console.error;
  const written = [];
  console.log = (...args) => written.push(args);
  console.error = (...args) => written.push(args);
  try {
    const { deps: d } = deps();
    await runTrack({ cwd: CWD }, d);
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.deepEqual(written, [], 'the caller owns the stream, so a test harness can assert on the message');
});

// ── the one thing scripts/track.mjs still owns ────────────────────────────────────

// Everything above drives `runTrack` in-process, which is the whole point of the split. What the
// thinned script still owns is the terminal contract — one glyph, one stream, one exit code — and
// that is only observable by spawning it. Two runs, one per outcome, because the pairing is what
// matters: a `✓` on stderr or a `✗` on stdout would both be invisible to a caller that redirects
// one stream, and an exit code that disagrees with the glyph is worse than either.
const SCRIPT = fileURLToPath(new URL('../scripts/track.mjs', import.meta.url));

function spawnTrack(home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, BEEZI_CURSOR_HOME: home, BEEZI_API_URL: 'http://127.0.0.1:1/api' } },
      (error, stdout, stderr) => resolve({ code: error == null ? 0 : error.code, stdout, stderr }),
    );
  });
}

function isolatedHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-track-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the script sends ✗ to stderr and exits 1 when there is nothing it can do', async (t) => {
  // An isolated home with no credential at all: `runTrack` answers "not linked", exit 1. Asserted
  // through a real spawn, so the stream and the status really are the script's.
  const home = isolatedHome(t);

  const { code, stdout, stderr } = await spawnTrack(home);

  assert.equal(code, 1);
  assert.match(stderr, /^✗ /, 'the failure glyph leads the line');
  assert.equal(stdout, '', 'and nothing at all went to stdout');
});

test('the script sends ✓ to stdout and exits 0 when the run succeeded', async (t) => {
  // A linked home with a conversation recorded and nothing new to report: the "already up to date"
  // outcome, which is a SUCCESS and must not be dressed as a failure — a user who ran this to
  // recover a session needs to be told plainly that there was nothing to recover.
  //
  // The credential is written in the legacy on-disk shape the store still adopts, because that is
  // the only way to make a REAL spawn reach the success path without a keychain. The API is pointed
  // at a closed port so nothing leaves the machine; the queue is empty, so nothing needs to.
  const home = isolatedHome(t);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state', 'conv-1.json'),
    JSON.stringify({ cursor: 0, cwd: process.cwd(), updatedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
    token: JSON.stringify({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:49152/callback',
      token_endpoint: 'https://clerk.example.test/oauth/token',
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() + 3_600_000,
    }),
  }));

  const { code, stdout, stderr } = await spawnTrack(home);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /^✓ /, 'the success glyph leads the line');
  assert.equal(stderr, '', 'and nothing at all went to stderr');
});
