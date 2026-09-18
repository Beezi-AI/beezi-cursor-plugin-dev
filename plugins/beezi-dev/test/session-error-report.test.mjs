import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSessionError } from '../lib/session-error-report.mjs';

test('POSTs the payload to /sessions/errors with bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 }; };
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', errorDetails: null,
      lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z' },
    'my-token',
    { fetchImpl },
  );
  assert.equal(res.reported, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sessions\/errors$/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer my-token');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    sessionId: 's1', error: 'rate_limit', errorDetails: null,
    lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z',
  });
});

test('reports false without a token (no fetch)', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return { status: 200 }; };
  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, null, { fetchImpl });
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(calls.length, 0);
});

// ─── the scrub, at the transport ────────────────────────────────────────────
//
// Both free-text fields are redacted HERE rather than at each call site, so a caller cannot ship
// free text past it by forgetting to. lib/checkpoint.mjs is the reason: it hands `event.text`
// straight through with no scrub of its own, and it is owned by whoever is changing the delta that
// week. lib/redact.mjs's rules — and the negative table that keeps them off ordinary diagnostics —
// are test/redact.test.mjs's subject, not this file's. These tests are about the wire.

// The body a given payload would actually have been POSTed with.
async function sentBody(payload) {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200 }; };
  await postSessionError(payload, 'my-token', { fetchImpl });
  assert.equal(calls.length, 1, 'the payload was never sent');
  return JSON.parse(calls[0].body);
}

test('both free-text fields are scrubbed on the way out', async () => {
  const body = await sentBody({
    sessionId: 's1',
    error: 'tool_failure',
    errorDetails: 'GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz012345 git push failed',
    lastAssistantMessage: 'I ran `curl -H "Authorization: Bearer sk-live-9a8b7c6d5e4f3a2b1c0d"` and it 401d',
    occurredAt: '2026-07-08T10:00:00.000Z',
  });

  assert.ok(!body.errorDetails.includes('ghs_abcdefghijklmnopqrstuvwxyz012345'), body.errorDetails);
  assert.equal(body.errorDetails, 'GITHUB_TOKEN=[REDACTED] git push failed');
  assert.ok(!body.lastAssistantMessage.includes('sk-live-9a8b7c6d5e4f3a2b1c0d'), body.lastAssistantMessage);
  assert.ok(body.lastAssistantMessage.includes('and it 401d'), 'the sentence around it must survive');
});

test('each field is cut to the length its column accepts, after the scrub', async () => {
  // Nest's ValidationPipe rejects the WHOLE request when a field is over its declared length, and
  // postSessionError swallows its own failures by design — so an over-long field is a session error
  // that silently never arrives. The caps are 1000 and 4000; the truncation comes after redaction
  // for the same reason it does inside redactDetail, so a cut cannot strand half a credential.
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const body = await sentBody({
    sessionId: 's1',
    error: 'tool_failure',
    errorDetails: `${'.'.repeat(990)}${secret} tail`,
    lastAssistantMessage: `${'.'.repeat(3990)}${secret} tail`,
    occurredAt: '2026-07-08T10:00:00.000Z',
  });

  assert.equal(body.errorDetails.length, 1000);
  assert.equal(body.lastAssistantMessage.length, 4000);
  assert.ok(!body.errorDetails.includes('ghp_0123456789'), body.errorDetails.slice(-80));
  assert.ok(!body.lastAssistantMessage.includes('ghp_0123456789'), body.lastAssistantMessage.slice(-80));
  assert.ok(body.errorDetails.endsWith('[REDACTED]'));
  assert.ok(body.lastAssistantMessage.endsWith('[REDACTED]'));
});

test('an ordinary error report survives the round trip unchanged', async () => {
  // The rate-limit path (lib/checkpoint.mjs) and the tool-failure path both carry prose and
  // diagnostics that a careless redactor would eat, leaving a report that arrives, looks fine and
  // says nothing.
  const errorDetails = [
    "src/app.ts(12,5): error TS2304: Cannot find name 'foo'.",
    "Error: ENOENT: no such file or directory, open 'C:\\src\\app.ts'",
    '    at Object.authorize (C:\\src\\lib\\token.ts:42:7)',
    'npm ERR! code ELIFECYCLE',
  ].join('\n');
  const lastAssistantMessage = 'You have hit the usage limit; it resets 4:30pm (Europe/Kiev). '
    + 'Basic authentication failed for user dev, and connect ECONNREFUSED 127.0.0.1:5432.';

  const body = await sentBody({
    sessionId: 's1', error: 'rate_limit', errorDetails, lastAssistantMessage,
    occurredAt: '2026-07-08T10:00:00.000Z',
  });
  assert.equal(body.errorDetails, errorDetails);
  assert.equal(body.lastAssistantMessage, lastAssistantMessage);
});

test('the scrub does not invent a field the caller did not send', async () => {
  // `/sessions/report` on this same server is whitelist-validated: a property the DTO does not
  // declare is a 400 that discards the whole request. A field materializing out of nothing because
  // the scrub normalized `undefined` to `null` is the same class of bug, one endpoint over.
  const body = await sentBody({ sessionId: 's1', error: 'rate_limit', occurredAt: '2026-07-08T10:00:00.000Z' });
  assert.deepEqual(Object.keys(body).sort(), ['error', 'occurredAt', 'sessionId']);
});

test('a null field stays null rather than becoming an empty string', async () => {
  // Both call sites send an explicit null for the field they have no text for; the server stores it
  // as absent. An empty string would read as "the tool failed and said nothing", which is a
  // different fact.
  const body = await sentBody({
    sessionId: 's1', error: 'tool_failure', errorDetails: null, lastAssistantMessage: null,
    occurredAt: '2026-07-08T10:00:00.000Z',
  });
  assert.equal(body.errorDetails, null);
  assert.equal(body.lastAssistantMessage, null);
});

// ─── the caller's timeout reaches the transport ─────────────────────────────
//
// These are AUTHENTICATED user-session analytics, not the optional plugin diagnostics: the two
// share nothing but a verb. `postJson`'s default is the 3s hook budget, which is right for a hook
// and wrong for an audit doing the same call with 60s of its own.

test('deps.timeoutMs is handed to postJson, and the default is left alone', async () => {
  const seen = [];
  const postJsonImpl = async (url, token, body, deps) => { seen.push(deps); return { status: 200 }; };
  const payload = { sessionId: 's1', error: 'tool_failure', occurredAt: '2026-07-08T10:00:00.000Z' };

  await postSessionError(payload, 'tok', { postJsonImpl });
  assert.equal(seen[0].timeoutMs, undefined, 'no caller timeout means the transport default');

  await postSessionError(payload, 'tok', { postJsonImpl, timeoutMs: 60000 });
  assert.equal(seen[1].timeoutMs, 60000, 'the audit own budget reaches the request');

  await postSessionError(payload, 'tok', { postJsonImpl, timeoutMs: 1200 });
  assert.equal(seen[2].timeoutMs, 1200, 'a hook passes what is LEFT of its deadline');
});

test('the timeout survives the real postJson path as an abort signal', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200 }; };
  await postSessionError(
    { sessionId: 's1', error: 'tool_failure', occurredAt: '2026-07-08T10:00:00.000Z' },
    'tok',
    { fetchImpl, timeoutMs: 45000 },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal != null);
});

// ─── occurrence time ────────────────────────────────────────────────────────

async function sentWith(payload, deps) {
  const calls = [];
  const postJsonImpl = async (url, token, body) => { calls.push(body); return { status: 200 }; };
  await postSessionError(payload, 'tok', Object.assign({ postJsonImpl }, deps));
  assert.equal(calls.length, 1, 'the payload was never sent');
  return calls[0];
}

test('a captured occurrence timestamp is preferred over send time', async () => {
  // The whole point: the report may be delivered minutes after the turn that produced it, and a
  // send-time stamp would place a 10:00 failure at 10:37.
  const body = await sentWith(
    { sessionId: 's1', error: 'tool_failure' },
    { occurredAt: '2026-07-08T10:00:00.000Z', now: () => Date.parse('2026-07-08T10:37:00.000Z') },
  );
  assert.equal(body.occurredAt, '2026-07-08T10:00:00.000Z');
});

test('an epoch occurrence timestamp is normalized to ISO, in seconds or milliseconds', async () => {
  const ms = Date.parse('2026-07-08T10:00:00.000Z');
  for (const value of [ms, String(ms), Math.floor(ms / 1000), String(Math.floor(ms / 1000))]) {
    // eslint-disable-next-line no-await-in-loop
    const body = await sentWith({ sessionId: 's1', error: 'tool_failure' }, { occurredAt: value });
    assert.equal(body.occurredAt, '2026-07-08T10:00:00.000Z', JSON.stringify(value));
  }
});

test('an invalid occurrence timestamp falls back to the injected now', async () => {
  const now = Date.parse('2026-07-08T10:37:00.000Z');
  const invalid = ['not a date', '', 0, -1, NaN, Infinity, {}, [], 'Invalid Date',
    Date.parse('1969-01-01T00:00:00.000Z')];
  for (const value of invalid) {
    // eslint-disable-next-line no-await-in-loop
    const body = await sentWith(
      { sessionId: 's1', error: 'tool_failure' },
      { occurredAt: value, now: () => now },
    );
    assert.equal(body.occurredAt, new Date(now).toISOString(), JSON.stringify(String(value)));
  }
});

test('a missing occurrence timestamp uses the injected now', async () => {
  const now = Date.parse('2026-07-08T10:37:00.000Z');
  const body = await sentWith({ sessionId: 's1', error: 'tool_failure' }, { now: () => now });
  assert.equal(body.occurredAt, '2026-07-08T10:37:00.000Z');
});

test('a payload own occurredAt is honored, and a broken one is replaced', async () => {
  const now = Date.parse('2026-07-08T10:37:00.000Z');
  const kept = await sentWith(
    { sessionId: 's1', error: 'tool_failure', occurredAt: '2026-07-08T09:00:00.000Z' },
    { now: () => now },
  );
  assert.equal(kept.occurredAt, '2026-07-08T09:00:00.000Z');

  const replaced = await sentWith(
    { sessionId: 's1', error: 'tool_failure', occurredAt: 'yesterday afternoon' },
    { now: () => now },
  );
  assert.equal(replaced.occurredAt, '2026-07-08T10:37:00.000Z');
});

test('deps.occurredAt outranks the payload', async () => {
  // M03's verified input normalization is the source of truth for host-captured time; a call site
  // that also filled the field in must not win over it.
  const body = await sentWith(
    { sessionId: 's1', error: 'tool_failure', occurredAt: '2026-07-08T09:00:00.000Z' },
    { occurredAt: '2026-07-08T08:15:00.000Z' },
  );
  assert.equal(body.occurredAt, '2026-07-08T08:15:00.000Z');
});

// ─── what must not change ───────────────────────────────────────────────────

test('a tool failure is still reported as tool_failure', async () => {
  // Not a guessed rate-limit or API-error classification: the call site knows a tool failed, and
  // that is the whole of what this plugin can honestly say.
  const body = await sentWith({
    sessionId: 's1', error: 'tool_failure', errorDetails: 'exit status 1',
    lastAssistantMessage: null,
  }, {});
  assert.equal(body.error, 'tool_failure');
  assert.equal(body.lastAssistantMessage, null, 'an explicit null is not an empty string');
});

test('redaction still happens before truncation, with a caller timeout in play', async () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const body = await sentWith({
    sessionId: 's1',
    error: 'tool_failure',
    errorDetails: `${'.'.repeat(990)}${secret} tail`,
    lastAssistantMessage: `${'.'.repeat(3990)}${secret} tail`,
  }, { timeoutMs: 60000 });
  assert.equal(body.errorDetails.length, 1000);
  assert.equal(body.lastAssistantMessage.length, 4000);
  assert.ok(body.errorDetails.endsWith('[REDACTED]'));
  assert.ok(body.lastAssistantMessage.endsWith('[REDACTED]'));
});

test('the token may travel in deps instead of the second argument', async () => {
  // CONTRACTS §8 spells this call `postSessionError(payload, deps)`. Both forms work, so the
  // existing call sites keep working and a new one can use the contract shape.
  const seen = [];
  const postJsonImpl = async (url, token, body) => { seen.push({ token, body }); return { status: 200 }; };
  const res = await postSessionError(
    { sessionId: 's1', error: 'tool_failure' },
    { token: 'from-deps', postJsonImpl, occurredAt: '2026-07-08T10:00:00.000Z' },
  );
  assert.equal(res.reported, true);
  assert.equal(seen[0].token, 'from-deps');
  assert.equal(seen[0].body.occurredAt, '2026-07-08T10:00:00.000Z');
});

test('no token in either position still refuses without a request', async () => {
  let posted = 0;
  const res = await postSessionError(
    { sessionId: 's1', error: 'tool_failure' },
    { postJsonImpl: async () => { posted += 1; return { status: 200 }; } },
  );
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(posted, 0);
});

// ── B4: the body is a PROJECTION, not the caller's object with two fields capped ────────────────

test('only the five DTO fields reach the wire, whatever the caller attached', async () => {
  // `{...payload}` copied the caller's object wholesale and then capped the two fields it knew
  // about, so every other key travelled uninspected and uncapped. Nothing does attach one today,
  // but the reason this function lives at the transport rather than at each call site is that a
  // rule which has to be remembered at every new call site gets forgotten at the third one — and
  // the diagnostics allowlist next door is already built the other way round.
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200 }; };
  await postSessionError(
    {
      sessionId: 's1',
      error: 'tool_failure',
      errorDetails: 'boom',
      lastAssistantMessage: null,
      occurredAt: '2026-07-08T10:00:00.000Z',
      // Everything below is a key the DTO does not declare. Some of them are the kinds of thing a
      // future call site would plausibly attach; none may leave the machine.
      cwd: 'C:/Users/dev/secret-project',
      stack: 'Error: at /home/dev/app/src/index.js:12',
      prompt: 'refactor the billing module',
      token: 'ya29.real-looking-credential',
      repoName: 'acme/private',
    },
    'my-token',
    { fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].body)).sort(), [
    'error', 'errorDetails', 'lastAssistantMessage', 'occurredAt', 'sessionId',
  ]);
});

test('a key the caller did not send is still not invented', async () => {
  // The other half of the same contract, and the reason this is a projection of what is PRESENT
  // rather than a fixed five-key object. `/sessions/errors` is whitelist-validated on the same
  // server, and a field materialising out of nothing is how the report endpoint started 400ing a
  // whole segment.
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200 }; };
  await postSessionError({ sessionId: 's1', error: 'rate_limit' }, 'my-token', { fetchImpl });
  const body = JSON.parse(calls[0].body);
  // occurredAt is always resolved by the transport, so it is the one key that IS always present.
  assert.deepEqual(Object.keys(body).sort(), ['error', 'occurredAt', 'sessionId']);
  assert.equal('errorDetails' in body, false);
  assert.equal('lastAssistantMessage' in body, false);
});
