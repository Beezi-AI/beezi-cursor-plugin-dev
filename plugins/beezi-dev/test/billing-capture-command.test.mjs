import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { RESULT_PREFIX } from '../lib/billing-capture.mjs';

// The command seam — `readCursorAccount -> args -> reconcile -> write` — run as a real subprocess.
// Unit tests already cover the reconcile table; what escapes them is the wiring: which flags reach
// which branch, what actually lands on disk, what the user sees, and the exit status a skill reads.

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'billing-capture.mjs');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-capture-cmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'beezi-home');
  // Cursor's config root: the CLI's cli-config.json is the account source we can populate without
  // a SQLite database, and it exercises the same readCursorAccount contract.
  const cursorConfig = path.join(root, 'cursor-config');
  // Every root state.vscdb could be resolved from, pointed at an empty directory so the higher
  // authority source is genuinely absent rather than accidentally the developer's own Cursor.
  const empty = path.join(root, 'empty');
  fs.mkdirSync(cursorConfig, { recursive: true });
  fs.mkdirSync(empty, { recursive: true });
  return { root, home, cursorConfig, empty };
}

function writeCliConfig(box, fields) {
  fs.writeFileSync(path.join(box.cursorConfig, 'cli-config.json'), JSON.stringify(fields));
}

function run(box, args, extraEnv) {
  const env = {
    ...process.env,
    BEEZI_CURSOR_HOME: box.home,
    CURSOR_CONFIG_DIR: box.cursorConfig,
    // globalStorageDir() resolves through these three depending on platform.
    APPDATA: box.empty,
    XDG_CONFIG_HOME: box.empty,
    HOME: box.empty,
    USERPROFILE: box.empty,
    ...(extraEnv == null ? {} : extraEnv),
  };
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf-8' });
  const stdout = res.stdout == null ? '' : res.stdout;
  let result = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.indexOf(RESULT_PREFIX) === 0) result = JSON.parse(line.slice(RESULT_PREFIX.length));
  }
  return { status: res.status, stdout, stderr: res.stderr == null ? '' : res.stderr, result };
}

function stored(box) {
  const file = path.join(box.home, 'billing.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
}

// ── 1. automatic success ──────────────────────────────────────────────────────────────────────

test('command: --from-cursor captures the plan and the account email deterministically', (t) => {
  const box = sandbox(t);
  writeCliConfig(box, { stripeMembershipType: 'pro', email: 'Dev@Example.com' });

  const run1 = run(box, ['--from-cursor', '--via', 'login']);
  assert.equal(run1.status, 0);
  assert.equal(run1.result.outcome, 'changed');
  assert.equal(run1.result.written, true);
  assert.equal(run1.result.material, true);

  const cfg = stored(box);
  assert.equal(cfg.version, 3);
  assert.equal(cfg.plan, 'pro');
  assert.equal(cfg.selfReported, false);
  assert.equal(cfg.capturedBy, 'login');
  // The account email used to be dropped on the way into the config; without it no later run can
  // tell an account switch from a plan change.
  assert.deepEqual(cfg.accountAnchor, { email: 'dev@example.com', accountId: null, subscriptionId: null, source: 'cli_config' });
  assert.equal('credentialsExpiresAt' in cfg, false);
  assert.match(run1.stdout, /Beezi billing captured/);
});

// ── 2. no local account source (the no-SQLite machine) ────────────────────────────────────────

test('command: --from-cursor with no readable account source captures nothing and still exits 0', (t) => {
  const box = sandbox(t);
  const res = run(box, ['--from-cursor']);
  assert.equal(res.status, 0);
  assert.equal(res.result.outcome, 'no-source');
  assert.equal(res.result.material, false, 'nothing about the plan changed');
  // A record IS written, but it claims nothing: it holds only the read-attempt stamp. See
  // 'a machine with no plan does not re-read the host on the next run'.
  assert.equal(stored(box).plan, null);
  assert.equal(stored(box).capturedAt, null);
  assert.match(res.stdout, /node:sqlite is unavailable/);
});

test('command: --force over an unreadable source erases nothing; only the attempt is recorded', (t) => {
  const box = sandbox(t);
  assert.equal(run(box, ['--plan', 'ultra', '--via', 'cursor-command']).status, 0);
  const before = stored(box);

  const res = run(box, ['--from-cursor', '--force']);
  assert.equal(res.status, 0);
  assert.equal(res.result.outcome, 'no-source');

  const after = stored(box);
  // Every fact the record carried is still there. The one field that moved is the read-attempt
  // stamp, which records that we looked and found nothing - it claims no plan and no identity, and
  // it is what makes the next fruitless read wait a week instead of happening next session.
  for (const field of ['plan', 'capturedAt', 'selfReported', 'subscriptionType', 'capturedBy', 'identityCheckedAt']) {
    assert.deepEqual(after[field], before[field], `${field} must not move on an unreadable source`);
  }
  assert.deepEqual(after.accountAnchor, before.accountAnchor);
  assert.notEqual(after.lastPlanReadAttemptAt, null);
});

test('command: a machine with no plan does not re-read the host on the next run', (t) => {
  const box = sandbox(t);
  const first = run(box, ['--from-cursor']);
  assert.equal(first.status, 0);
  assert.equal(first.result.outcome, 'no-source');
  assert.equal(first.result.written, true, 'the attempt is persisted so it can be backed off from');
  const stamp = stored(box).lastPlanReadAttemptAt;
  assert.notEqual(stamp, null);
  assert.equal(stored(box).plan, null, 'no plan is invented for a machine that has none');

  // The session-start caller gates on isDue, which now honours that stamp; the record it would
  // read back says "already looked".
  const second = run(box, ['--from-cursor']);
  assert.equal(second.status, 0);
  assert.equal(stored(box).plan, null);
});

// ── 3. self-report kept ───────────────────────────────────────────────────────────────────────

test('command: an unrecognized host tier keeps the self-reported plan and its freshness', (t) => {
  const box = sandbox(t);
  assert.equal(run(box, ['--plan', 'ultra', '--via', 'cursor-command']).status, 0);
  const before = stored(box);

  writeCliConfig(box, { stripeMembershipType: 'some-tier-we-have-never-seen' });
  const res = run(box, ['--from-cursor']);
  assert.equal(res.status, 0);
  // The host told us nothing usable and did not say whose account it is.
  assert.equal(res.result.outcome, 'unverified');
  assert.equal(res.result.material, false);

  const after = stored(box);
  assert.equal(after.plan, 'ultra');
  assert.equal(after.selfReported, true, 'provenance survives');
  assert.equal(after.capturedAt, before.capturedAt, 'an unobserved plan must not look freshly observed');
});

// ── 4. explicit manual correction ─────────────────────────────────────────────────────────────

test('command: --plan corrects a stored tier without relinking and reports the change', (t) => {
  const box = sandbox(t);
  assert.equal(run(box, ['--plan', 'pro', '--via', 'cursor-command']).status, 0);

  const res = run(box, ['--plan', 'team_premium', '--via', 'cursor-command', '--email', 'Dev@Example.com']);
  assert.equal(res.status, 0);
  assert.equal(res.result.outcome, 'changed');
  assert.equal(res.result.material, true);
  assert.match(res.stdout, /plan=team_premium \(was pro\)/);

  const cfg = stored(box);
  assert.equal(cfg.plan, 'team_premium');
  assert.equal(cfg.selfReported, true);
  assert.deepEqual(cfg.accountAnchor, { email: 'dev@example.com', accountId: null, subscriptionId: null, source: 'self_report' });
});

test('command: an invalid manual plan is refused and nothing is written', (t) => {
  const box = sandbox(t);
  const res = run(box, ['--plan', 'platinum']);
  assert.equal(res.status, 1);
  assert.equal(stored(box), null);
  assert.match(res.stderr, /Unknown plan/);
});

// ── 5. forced re-capture of a known, unchanged plan ───────────────────────────────────────────

test('command: an unchanged plan is not rewritten inside the recheck window, but --force is', (t) => {
  const box = sandbox(t);
  writeCliConfig(box, { stripeMembershipType: 'pro', email: 'dev@example.com' });
  assert.equal(run(box, ['--from-cursor']).status, 0);
  const first = stored(box);

  const quiet = run(box, ['--from-cursor']);
  assert.equal(quiet.result.outcome, 'kept');
  assert.equal(quiet.result.written, false);
  assert.equal(quiet.result.material, false);
  assert.match(quiet.stdout, /Cursor plan unchanged \(pro\)/);
  assert.deepEqual(stored(box), first);

  const forced = run(box, ['--from-cursor', '--force']);
  assert.equal(forced.status, 0);
  assert.equal(forced.result.outcome, 'kept');
  assert.equal(forced.result.written, true);
  assert.equal(stored(box).plan, 'pro');
  assert.ok(Date.parse(stored(box).identityCheckedAt) >= Date.parse(first.identityCheckedAt));
});

// ── 6. account switch ─────────────────────────────────────────────────────────────────────────

test('command: a confirmed account switch clears the previous tier instead of inheriting it', (t) => {
  const box = sandbox(t);
  writeCliConfig(box, { stripeMembershipType: 'ultra', email: 'old@example.com' });
  assert.equal(run(box, ['--from-cursor']).status, 0);
  assert.equal(stored(box).plan, 'ultra');

  writeCliConfig(box, { stripeMembershipType: 'a-tier-we-do-not-map', email: 'new@example.com' });
  const res = run(box, ['--from-cursor']);
  assert.equal(res.status, 0);
  assert.equal(res.result.outcome, 'needs-user');

  const cfg = stored(box);
  assert.equal(cfg.plan, null, 'an old user tier cannot stay on the machine indefinitely');
  assert.equal(cfg.capturedAt, null);
  assert.deepEqual(cfg.accountAnchor, { email: 'new@example.com', accountId: null, subscriptionId: null, source: 'cli_config' });
  assert.match(res.stdout, /different Cursor account/);
});

test('command: a switch that also names a known plan adopts the new account plan', (t) => {
  const box = sandbox(t);
  writeCliConfig(box, { stripeMembershipType: 'ultra', email: 'old@example.com' });
  assert.equal(run(box, ['--from-cursor']).status, 0);

  writeCliConfig(box, { stripeMembershipType: 'free', email: 'new@example.com' });
  const res = run(box, ['--from-cursor']);
  assert.equal(res.result.outcome, 'changed');
  assert.equal(stored(box).plan, 'free');
});

// ── 7. failed write ───────────────────────────────────────────────────────────────────────────

test('command: a failed write exits non-zero and says so, rather than reporting success', (t) => {
  const box = sandbox(t);
  // A regular file where a directory has to be: mkdirSync then fails with ENOTDIR/EEXIST on both
  // Windows and POSIX, which `chmod` cannot be relied on to reproduce.
  const blocker = path.join(box.root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blocked = { ...box, home: path.join(blocker, 'home') };

  const res = run(blocked, ['--plan', 'pro']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.indexOf(RESULT_PREFIX), -1, 'a run that failed to persist must not print a success result');
  assert.match(res.stderr, /^✗ /m);
});

// ── flag hygiene ──────────────────────────────────────────────────────────────────────────────

test('command: --expires-at is accepted, announced as deprecated and never stored', (t) => {
  const box = sandbox(t);
  const res = run(box, ['--plan', 'pro', '--expires-at', '12345']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--expires-at is deprecated and ignored/);
  assert.equal('credentialsExpiresAt' in stored(box), false);
});

test('command: --email cannot be pinned onto a --from-cursor observation', (t) => {
  const box = sandbox(t);
  const res = run(box, ['--from-cursor', '--email', 'someone@example.com']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /mutually exclusive/);
  assert.equal(stored(box), null);
});

// ── the beezi-refresh skill ───────────────────────────────────────────────────────────────────
//
// test/plugin-manifest.test.mjs holds the skill contract but enumerates RUNNER_SKILLS by hand and
// is integration-owned, so beezi-refresh is held to the same rules here. The handoff carries the
// one-line patch that adds it to that list; these assertions are what prove the patch is safe.

const REFRESH_SKILL = path.join(HERE, '..', 'skills', 'beezi-refresh', 'SKILL.md');

test('beezi-refresh meets the skill contract the manifest test enforces', () => {
  const body = fs.readFileSync(REFRESH_SKILL, 'utf-8');
  assert.match(body, /^name: beezi-refresh$/m);
  assert.match(body, /^disable-model-invocation: true$/m);
  assert.match(body, /Resolve `<BEEZI>` first/);
  assert.ok(body.includes('skills/beezi-refresh/SKILL.md` removed'));
  assert.equal(body.includes('${CURSOR_PLUGIN_ROOT}'), false);
  assert.equal(body.includes('.beezi-cursor/bin'), false);
  assert.equal(body.includes('.cursor/plugins/local/beezi/scripts'), false);
  for (const [, script] of body.matchAll(/<BEEZI>\/scripts\/([\w.-]+)/g)) {
    assert.ok(fs.existsSync(path.join(HERE, '..', 'scripts', script)), `beezi-refresh -> ${script} is missing`);
  }
});

test('beezi-refresh branches on the structured outcome, not on console wording', () => {
  const body = fs.readFileSync(REFRESH_SKILL, 'utf-8');
  assert.ok(body.includes(RESULT_PREFIX), 'the skill must name the machine-readable line it parses');
  for (const outcome of ['no-source', 'kept', 'changed', 'needs-user', 'unverified']) {
    assert.ok(body.includes(`\`${outcome}\``), `beezi-refresh does not handle the ${outcome} outcome`);
  }
});

test('beezi-refresh offers exactly the seven tiers the script accepts, and no others', () => {
  const body = fs.readFileSync(REFRESH_SKILL, 'utf-8');
  for (const plan of ['free', 'pro', 'pro_plus', 'ultra', 'team', 'team_premium', 'enterprise']) {
    assert.ok(body.includes(`\`${plan}\``), `beezi-refresh omits the ${plan} tier`);
  }
  // Pricing vocabulary the script would reject; offering it would send the user round a loop.
  for (const bogus of ['business', 'max_5x', 'max_20x', 'start']) {
    assert.equal(body.includes(`\`${bogus}\``), false, `beezi-refresh offers ${bogus}, which the script rejects`);
  }
  assert.equal(body.includes('--email'), true);
  assert.match(body, /Never pass `--email`/);
});

// ── plan §4 B3: the account check-in rides this command, and changes nothing about it ─────────

test('the machine-readable line is still the LAST thing the command prints', (t) => {
  // The check-in was added AFTER this line on purpose. It is the contract the beezi-refresh skill
  // parses, and a check-in that could delay it, interleave with it or append to it would break a
  // skill that reads "the last line".
  const box = sandbox(t);
  writeCliConfig(box, { membershipType: 'pro', email: 'seat@example.com' });
  const run1 = run(box, ['--from-cursor', '--force', '--via', 'refresh']);
  assert.equal(run1.status, 0);
  const lines = run1.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  assert.equal(lines.length > 0, true);
  assert.equal(lines[lines.length - 1].indexOf(RESULT_PREFIX), 0, 'something printed after the contract line');
  assert.notEqual(run1.result, null);
  assert.equal(typeof run1.result.outcome, 'string');
  assert.equal(typeof run1.result.written, 'boolean');
});

test('an unlinked machine runs the whole command and exits cleanly', (t) => {
  // The sandbox has no credentials and no tracking cache, which is the state of every machine that
  // captures a plan before it signs in. The check-in must find nothing to do, print nothing, hold
  // no socket open and leave the exit status alone.
  const box = sandbox(t);
  writeCliConfig(box, { membershipType: 'pro', email: 'seat@example.com' });
  const res = run(box, ['--from-cursor', '--force', '--via', 'refresh']);
  assert.equal(res.status, 0, res.stderr);
  // Node's SQLite experimental warning is the only thing allowed on stderr; a check-in must not
  // add a line of its own.
  assert.doesNotMatch(res.stderr, /✗|Error|check-in/i);
  assert.equal(res.result.outcome, 'changed');
  assert.equal(stored(box).plan, 'pro');
  // Nothing about the check-in reaches the user's terminal.
  assert.doesNotMatch(res.stdout, /check-in|checkin|account-sync/i);
});

test('the manual --plan path still writes and reports exactly as before', (t) => {
  const box = sandbox(t);
  const res = run(box, ['--plan', 'ultra', '--via', 'refresh']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.result.outcome, 'changed');
  assert.equal(res.result.plan, 'ultra');
  assert.equal(stored(box).plan, 'ultra');
});
