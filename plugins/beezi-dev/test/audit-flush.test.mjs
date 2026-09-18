import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flushBackfillChunks,
  completeBackfill,
  planChunks,
  BackfillSessionStatus,
  BackfillHalt,
  MAX_BODY_BYTES,
  MAX_CHUNK_ITEMS,
  AuditEndpoint,
} from '../lib/audit-flush.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

// One report, padded to roughly `bytes` so chunk-boundary behaviour can be driven precisely.
function report(sessionId, segmentId, bytes = 200) {
  return {
    segmentId,
    sessionId,
    remote: 'git@github.com:acme/app.git',
    branch: 'main',
    from_line: 0,
    to_line: 5,
    session_name: 'x'.repeat(Math.max(0, bytes - 200)),
    models: { 'claude-sonnet-4-5': { token_input: 1, token_output: 1, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 2,
    token_input: 1,
    token_output: 1,
    token_cache: 0,
    duration_sec: 1,
  };
}

function group(sessionId, count, bytes = 200) {
  return {
    sessionId,
    reports: Array.from({ length: count }, (_unused, i) => report(sessionId, `${sessionId}:${i}`, bytes)),
  };
}

// Records every call, replies with the queued status/body. Bodies are served through text() —
// the transport reads every body exactly once as text (readResponseBody).
function fakePost(replies) {
  const calls = [];
  let i = 0;
  const impl = async (url, token, body, deps) => {
    calls.push({ url, token, body, deps });
    const reply = typeof replies === 'function' ? replies(body, calls.length) : replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      status: reply.status,
      text: async () => {
        if (reply.throws) throw new Error('unreadable');
        if (reply.raw != null) return reply.raw;
        return JSON.stringify(reply.body ?? {});
      },
    };
  };
  return { impl, calls };
}

const okBody = (over = {}) => ({ stored: 1, skipped: 0, completed: false, errors: [], ...over });

// ─── planChunks ─────────────────────────────────────────────────────────────

test('1. packs several sessions into one chunk when they fit', () => {
  const chunks = planChunks([group('s1', 2), group('s2', 2)]);

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].sessionIds, ['s1', 's2']);
  assert.equal(chunks[0].reports.length, 4);
});

// Sessions stay whole so the ledger can attribute a chunk verdict to whole sessions.
test('2. never splits a session that fits, even at a chunk boundary', () => {
  const chunks = planChunks([group('s1', 40), group('s2', 40)]);

  assert.ok(chunks.length > 1, 'the two sessions do not fit in one chunk');
  for (const chunk of chunks) {
    const ids = new Set(chunk.reports.map((r) => r.sessionId));
    assert.equal(ids.size, 1, 'a chunk boundary fell inside a session');
  }
});

test('3. every planned chunk stays under both caps', () => {
  const chunks = planChunks([group('s1', 40, 1000), group('s2', 40, 1000), group('s3', 40, 1000)]);

  for (const chunk of chunks) {
    assert.ok(chunk.reports.length <= MAX_CHUNK_ITEMS, `chunk of ${chunk.reports.length} items exceeds the item cap`);
    const bytes = Buffer.byteLength(JSON.stringify({ sessions: chunk.reports }), 'utf-8');
    assert.ok(bytes <= MAX_BODY_BYTES, `chunk of ${bytes} bytes exceeds the byte budget`);
  }
});

// The ruling: 50 array items per request, regardless of how far under the byte budget they sit.
test('4. cuts a chunk at exactly MAX_CHUNK_ITEMS even when far under the byte budget', () => {
  const chunks = planChunks([group('s1', 30), group('s2', 30)]);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.reports.length <= MAX_CHUNK_ITEMS));
});

// A session with more segments than one chunk holds now legally splits; continuations carry
// partialOf so the caller accepts the session only when every part landed.
test('5. an over-cap session splits with partialOf on every part', () => {
  const chunks = planChunks([group('big', MAX_CHUNK_ITEMS * 2 + 5)]);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.partialOf === 'big'));
  assert.deepEqual([...new Set(chunks.flatMap((c) => c.sessionIds))], ['big']);
});

test('6. a single over-budget report is still sent alone rather than looping', () => {
  const chunks = planChunks([{ sessionId: 's1', reports: [report('s1', 's1:0', MAX_BODY_BYTES * 2)] }]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reports.length, 1);
});

test('7. empty groups are dropped', () => {
  assert.deepEqual(planChunks([{ sessionId: 's1', reports: [] }]), []);
});

// The audit already serializes each group to decide when to dispatch, so it hands the size over
// rather than making this function re-serialize the whole growing chunk once per session. Same
// boundaries either way — the pre-measured run is just not quadratic.
test('8. a pre-measured group packs exactly where an unmeasured one would', () => {
  const groups = [group('s1', 40, 1000), group('s2', 40, 1000), group('s3', 40, 1000)];
  const measured = groups.map((g) => ({
    ...g,
    bytes: Buffer.byteLength(JSON.stringify({ reports: g.reports, timeline: null }), 'utf-8'),
  }));

  const plain = planChunks(groups);
  const pre = planChunks(measured);

  assert.deepEqual(
    pre.map((c) => c.sessionIds),
    plain.map((c) => c.sessionIds),
  );
  for (const chunk of pre) {
    const bytes = Buffer.byteLength(JSON.stringify({ sessions: chunk.reports }), 'utf-8');
    assert.ok(bytes <= MAX_BODY_BYTES, `chunk of ${bytes} bytes exceeds the byte budget`);
  }
});

// The fallback is not decoration: planChunks is exported and tested standalone, and a caller that
// hands over bare groups must still get correct packing rather than a chunk of zero measured bytes
// that never flushes.
test('9. a group with no bytes field is still measured exactly', () => {
  const chunks = planChunks([
    { sessionId: 'huge', reports: [report('huge', 'huge:0', MAX_BODY_BYTES * 2)] },
    group('s2', 2),
  ]);

  assert.equal(chunks[0].sessionIds[0], 'huge');
  assert.equal(chunks[0].reports.length, 1, 'the over-budget session was not packed alongside another');
});

// ─── in-run transport retry ────────────────────────────────────────

const noSleep = { sleep: async () => {} };

test('31. a thrown post retries once and succeeds without marking anything failed', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return { status: 200, text: async () => JSON.stringify(okBody()) };
  };

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: impl, ...noSleep });

  assert.equal(calls, 2);
  assert.equal(result.retryableFailures, 0);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('32. a 5xx retries once and succeeds', async () => {
  const post = fakePost([{ status: 503, raw: 'busy' }, { status: 200, body: okBody() }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl, ...noSleep });

  assert.equal(post.calls.length, 2);
  assert.equal(result.retryableFailures, 0);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('33. the retry is bounded: two throws mark FAILED with the transport reason', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new TypeError('fetch failed'); };

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: impl, ...noSleep });

  assert.equal(calls, 2);
  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.lastError, 'network');
});

test('34. a timeout is recorded as timeout, not network', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const impl = async () => { throw abort; };

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: impl, ...noSleep });

  assert.equal(result.lastError, 'timeout');
  assert.equal(result.bySession.get('s1').reason, 'timeout');
});

// ─── in-band timelines ─────────────────────────────────────────────

const timelineFor = (sessionId) => ({ sessionId, periods: [{ state: 'working' }], subagents: [], plan_events: [] });

test('27. a group timeline rides its chunk; chunks without any omit the field entirely', async () => {
  const post = fakePost([{ status: 200, body: okBody({ timelines: 1 }) }, { status: 200, body: okBody() }]);
  const withTimeline = { ...group('s1', 1), timeline: timelineFor('s1') };

  const first = await flushBackfillChunks([withTimeline], 'tok', { postJsonImpl: post.impl });
  await flushBackfillChunks([group('s2', 1)], 'tok', { postJsonImpl: post.impl });

  assert.deepEqual(post.calls[0].body.timelines, [timelineFor('s1')]);
  assert.equal(first.timelines, 1);
  assert.equal('timelines' in post.calls[1].body, false, 'no-timeline chunks must stay byte-identical to the old wire shape');
});

test('28. a split session carries its timeline in the first part only', () => {
  const chunks = planChunks([{ ...group('big', MAX_CHUNK_ITEMS * 2 + 5), timeline: timelineFor('big') }]);

  assert.ok(chunks.length >= 3);
  assert.deepEqual(chunks[0].timelines, [timelineFor('big')]);
  assert.ok(chunks.slice(1).every((c) => c.timelines.length === 0));
});

test('29. bisection redistributes timelines to the sub-chunk holding their session', async () => {
  const post = fakePost((body, n) => {
    if (n === 1) return { status: 400, body: { statusCode: 400, message: ['bad payload'] } };
    return { status: 200, body: okBody({ timelines: (body.timelines ?? []).length }) };
  });
  const groups = [
    { ...group('s1', 1), timeline: timelineFor('s1') },
    { ...group('s2', 1), timeline: timelineFor('s2') },
  ];

  const result = await flushBackfillChunks(groups, 'tok', { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 3);
  assert.deepEqual(post.calls[1].body.timelines, [timelineFor('s1')]);
  assert.deepEqual(post.calls[2].body.timelines, [timelineFor('s2')]);
  assert.equal(result.timelines, 2);
});

test('30. an old server that 400s the timelines field gets the chunk again without them', async () => {
  const post = fakePost((body, n) => {
    if (n === 1) {
      return { status: 400, body: { statusCode: 400, message: ['property timelines should not exist'] } };
    }
    return { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(
    [{ ...group('s1', 1), timeline: timelineFor('s1') }],
    'tok',
    { postJsonImpl: post.impl },
  );

  assert.equal(post.calls.length, 2);
  assert.equal('timelines' in post.calls[1].body, false);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.permanentRejections, 0);
});

// ─── flushBackfillChunks ─────────────────────────────────────────────────────

test('8. POSTs { sessions } to the backfill route with the raised timeout', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.ok(post.calls[0].url.endsWith('/sessions/backfill'));
  assert.ok(Array.isArray(post.calls[0].body.sessions));
  assert.equal(post.calls[0].body.skipExisting, undefined);
  assert.equal(post.calls[0].deps.timeoutMs, 60_000);
});

// The response has no per-session success list — a session is accepted unless errors[] names it.
test('9. verdicts derive from errors[]: none → ACCEPTED, all → REJECTED, some → PARTIAL', async () => {
  const post = fakePost([
    {
      status: 200,
      body: okBody({
        stored: 2,
        skipped: 3,
        errors: [
          { sessionId: 's2', segmentId: 's2:0', reason: 'Repository is not connected to Beezi.' },
          { sessionId: 's3', segmentId: 's3:0', reason: 'boom' },
          { sessionId: 's3', segmentId: 's3:1', reason: 'boom' },
        ],
      }),
    },
  ]);

  const result = await flushBackfillChunks(
    [group('s1', 1), group('s2', 2), group('s3', 2)],
    'tok',
    { postJsonImpl: post.impl },
  );

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.PARTIAL);
  assert.equal(result.bySession.get('s2').reason, 'Repository is not connected to Beezi.');
  assert.equal(result.bySession.get('s3').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.itemErrors, 3);
  assert.equal(result.stored, 2);
  assert.equal(result.skipped, 3);
});

// The server's benign zero-token skip produces skipped > 0 with an empty errors[] — still accepted.
test('10. skipped-with-no-errors is still ACCEPTED', async () => {
  const post = fakePost([{ status: 200, body: okBody({ stored: 0, skipped: 1 }) }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('11. a 401 renews the token exactly once and retries the chunk', async () => {
  const post = fakePost([
    { status: 401, body: {} },
    { status: 200, body: okBody() },
    { status: 200, body: okBody() },
  ]);
  let renewals = 0;
  const getAccessToken = async (_deps, opts) => {
    if (opts?.forceRefresh) renewals += 1;
    return 'fresh-tok';
  };

  const result = await flushBackfillChunks([group('s1', 1)], 'stale-tok', { postJsonImpl: post.impl, getAccessToken });

  assert.equal(renewals, 1);
  assert.equal(post.calls.length, 2);
  assert.equal(post.calls[1].token, 'fresh-tok');
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
});

test('12. a still-401 after renewal is FAILED (retryable), never rejected', async () => {
  const post = fakePost([{ status: 401, body: {} }, { status: 401, body: {} }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', {
    postJsonImpl: post.impl,
    getAccessToken: async () => 'other-tok',
  });

  assert.equal(result.permanentRejections, 0);
  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

// One malformed field 400s the whole chunk; bisection isolates the poison session so the
// innocent ones still land — with a bounded number of extra requests.
test('13. a 400 bisects at session boundaries and isolates the poison session', async () => {
  const poisoned = new Set(['s3']);
  const post = fakePost((body) => {
    const ids = new Set(body.sessions.map((r) => r.sessionId));
    const bad = [...ids].some((id) => poisoned.has(id));
    return bad && ids.size >= 1
      ? ids.size === 1
        ? { status: 400, body: { statusCode: 400, message: ['sessions.0.agent_name must be shorter'], error: 'Bad Request' } }
        : { status: 400, body: { statusCode: 400, message: ['sessions.2.agent_name must be shorter'], error: 'Bad Request' } }
      : { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(
    [group('s1', 1), group('s2', 1), group('s3', 1), group('s4', 1)],
    'tok',
    { postJsonImpl: post.impl },
  );

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s3').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.bySession.get('s4').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.permanentRejections, 1);
  // 4 sessions: worst case 2N-1 = 7 requests on the 400 path.
  assert.ok(post.calls.length <= 7, `bisection used ${post.calls.length} requests`);
});

test('14. a single-session 400 floor surfaces the first validation message', async () => {
  const post = fakePost([
    { status: 400, body: { statusCode: 400, message: ['sessions.0.branch must be shorter than or equal to 255 characters'], error: 'Bad Request' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
  assert.match(result.lastError, /branch must be shorter/);
});

test('15. 403 BACKFILL_ALREADY_COMPLETED halts and sends nothing further', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_ALREADY_COMPLETED', message: 'sealed' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 40), group('s2', 40)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.ALREADY_COMPLETED);
  assert.equal(post.calls.length, 1);
});

test('16. 403 BACKFILL_NOT_ALLOWED halts with nothing marked judged', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_NOT_ALLOWED', message: 'audit ended' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.NOT_ALLOWED);
  assert.equal(result.bySession.size, 0);
});

// Seat revocation / deactivation answer 403 WITHOUT a code — that is re-link territory, never
// "the pull is done" or "tracking is off".
test('17. a code-less 403 is FAILED + a distinct halt, not a seal or a tracking signal', async () => {
  const post = fakePost([
    { status: 403, body: { statusCode: 403, message: 'Your seat was revoked', error: 'Forbidden' } },
  ]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.FORBIDDEN);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.retryableFailures, 1);
});

test('18. 404 from an old server halts as unsupported and marks nothing judged', async () => {
  const post = fakePost([{ status: 404, raw: '<html>Cannot POST /api/sessions/backfill</html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.halt, BackfillHalt.UNSUPPORTED_SERVER);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

// Express answers over-limit bodies itself with HTML — the transport must not choke on it.
test('19. a 413 with an HTML body is REJECTED without throwing', async () => {
  const post = fakePost([{ status: 413, raw: '<html><body>Payload Too Large</body></html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
  assert.equal(result.permanentRejections, 1);
});

test('20. a 503 marks the chunk FAILED so a re-run retries it', async () => {
  const post = fakePost([{ status: 503, body: {} }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
});

test('21. a thrown request is FAILED, not rejected', async () => {
  const result = await flushBackfillChunks([group('s1', 1)], 'tok', {
    postJsonImpl: async () => { throw new Error('socket hang up'); },
  });

  assert.equal(result.retryableFailures, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.FAILED);
  assert.equal(result.lastError, 'network');
});

// A 2xx we cannot attribute must never be ledgered — and never sealed on top of.
test('22. a 2xx with an unreadable body is UNATTRIBUTED and counted', async () => {
  const post = fakePost([{ status: 200, raw: '<html>gateway page</html>' }]);

  const result = await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.UNATTRIBUTED);
  assert.equal(result.unattributed, 1);
  assert.equal(result.lastError, 'unreadable-response');
});

// A split session is accepted only when every one of its sub-chunks was.
test('23. a split session downgrades when any sub-chunk fails', async () => {
  const post = fakePost((body, n) =>
    n === 1 ? { status: 200, body: okBody() } : { status: 503, body: {} },
  );

  const result = await flushBackfillChunks([group('big', MAX_CHUNK_ITEMS + 5)], 'tok', {
    postJsonImpl: post.impl,
  });

  assert.equal(result.bySession.get('big').status, BackfillSessionStatus.FAILED);
});

test('24. reports progress after each chunk', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);
  const seen = [];

  await flushBackfillChunks([group('s1', 40), group('s2', 40)], 'tok', {
    postJsonImpl: post.impl,
    onChunk: (p) => seen.push(p.sent),
  });

  assert.ok(seen.length > 1);
  assert.deepEqual(seen, seen.map((_unused, i) => i + 1));
});

test('25. no groups means no request at all', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  const result = await flushBackfillChunks([], 'tok', { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 0);
  assert.equal(result.chunks, 0);
});

// ─── completeBackfill ───────────────────────────────────────────────────────

test('26. completeBackfill POSTs the seal route and reports the coded refusals', async () => {
  const ok = fakePost([{ status: 200, body: { stored: 0, skipped: 0, completed: true, errors: [] } }]);
  const sealed = await completeBackfill('tok', { postJsonImpl: ok.impl });
  assert.ok(ok.calls[0].url.endsWith('/sessions/backfill/complete'));
  assert.equal(sealed.completed, true);

  const refused = fakePost([
    { status: 403, body: { statusCode: 403, code: 'BACKFILL_NOT_ALLOWED', message: 'audit ended' } },
  ]);
  const denial = await completeBackfill('tok', { postJsonImpl: refused.impl });
  assert.equal(denial.completed, false);
  assert.equal(denial.code, 'BACKFILL_NOT_ALLOWED');
});

// ─── endpoint selection (08-D) ──────────────────────────────────────────────
//
// Sync posts to a different route than the one-time backfill, and the selection is a CLOSED set of
// names. A caller can never hand this module a URL: a transport that accepts one turns every
// caller (and every future option bag that reaches it) into an exfiltration primitive, and it also
// makes "which pull did this consume" unanswerable.

test('35. the default endpoint is still the one-time backfill route', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl });

  assert.match(post.calls[0].url, /\/sessions\/backfill$/);
});

test('36. the sync endpoint posts to the sync route and never to backfill', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl }, { endpoint: AuditEndpoint.SYNC });

  assert.match(post.calls[0].url, /\/sessions\/sync$/);
  assert.equal(post.calls.filter((c) => /backfill/.test(c.url)).length, 0);
});

test('37. an arbitrary URL is refused and nothing is posted', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await assert.rejects(
    () => flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl }, { endpoint: 'https://evil.example/collect' }),
    /endpoint/,
  );
  assert.equal(post.calls.length, 0);
});

test('38. an unknown endpoint name is refused and nothing is posted', async () => {
  const post = fakePost([{ status: 200, body: okBody() }]);

  await assert.rejects(
    () => flushBackfillChunks([group('s1', 1)], 'tok', { postJsonImpl: post.impl }, { endpoint: 'cost-state' }),
    /endpoint/,
  );
  assert.equal(post.calls.length, 0);
});

test('39. completeBackfill has no endpoint parameter — the seal belongs to the backfill alone', async () => {
  const post = fakePost([{ status: 200, body: {} }]);

  await completeBackfill('tok', { postJsonImpl: post.impl }, { endpoint: AuditEndpoint.SYNC });

  assert.match(post.calls[0].url, /\/sessions\/backfill\/complete$/);
});

// ─── final wire bytes (08-D) ────────────────────────────────────────────────

test('40. a chunk whose real serialized body exceeds the budget is split before it is posted', async () => {
  // planChunks trusts each group's own `bytes`. A caller that understates them (a cached estimate
  // taken before the payload grew) would otherwise put an over-budget body on the wire and learn
  // about it from a 413.
  const understated = [
    { ...group('s1', 1, 3 * 1024 * 1024), bytes: 10 },
    { ...group('s2', 1, 3 * 1024 * 1024), bytes: 10 },
  ];
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks(understated, 'tok', { postJsonImpl: post.impl });

  assert.ok(post.calls.length >= 2, `expected the over-budget chunk to be split, got ${post.calls.length} request(s)`);
  for (const call of post.calls) {
    assert.ok(Buffer.byteLength(JSON.stringify(call.body), 'utf-8') <= MAX_BODY_BYTES);
  }
});

test('41. multibyte payloads are measured in bytes, not characters', async () => {
  // Every character here is 3 bytes in UTF-8, so a body whose STRING length sits comfortably under
  // the cap is three times over it on the wire.
  const wide = (sessionId) => ({
    sessionId,
    bytes: 10,
    reports: [{ segmentId: `${sessionId}:0`, sessionId, session_name: '漢'.repeat(900 * 1024) }],
  });
  const post = fakePost([{ status: 200, body: okBody() }]);

  await flushBackfillChunks([wide('s1'), wide('s2')], 'tok', { postJsonImpl: post.impl });

  for (const call of post.calls) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(call.body), 'utf-8') <= MAX_BODY_BYTES,
      'a multibyte body went out over the byte budget',
    );
  }
});

test('42. a single report that cannot be split is still sent once, not looped on', async () => {
  const huge = { sessionId: 's1', bytes: 10, reports: [report('s1', 's1:0', 5 * 1024 * 1024)] };
  const post = fakePost([{ status: 413, raw: '<html>too large</html>' }]);

  const result = await flushBackfillChunks([huge], 'tok', { postJsonImpl: post.impl });

  assert.equal(post.calls.length, 1);
  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.REJECTED);
});

test('43. the measured split still isolates verdicts per session', async () => {
  const understated = [
    { ...group('s1', 1, 3 * 1024 * 1024), bytes: 10 },
    { ...group('s2', 1, 3 * 1024 * 1024), bytes: 10 },
  ];
  const post = fakePost((body) => {
    const failing = body.sessions.some((s) => s.sessionId === 's2');
    return failing
      ? { status: 200, body: okBody({ stored: 0, errors: [{ sessionId: 's2', segmentId: 's2:0', reason: 'no repo' }] }) }
      : { status: 200, body: okBody() };
  });

  const result = await flushBackfillChunks(understated, 'tok', { postJsonImpl: post.impl });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.REJECTED);
});

// ─── mixed success (08-D) ───────────────────────────────────────────────────

test('44. only explicitly acknowledged sessions are ACCEPTED when a later chunk fails outright', async () => {
  const groups = [group('s1', MAX_CHUNK_ITEMS), group('s2', MAX_CHUNK_ITEMS)];
  const post = fakePost((body) => (body.sessions[0].sessionId === 's1'
    ? { status: 200, body: okBody({ stored: MAX_CHUNK_ITEMS }) }
    : { status: 503, raw: 'upstream' }));

  const result = await flushBackfillChunks(groups, 'tok', { postJsonImpl: post.impl, sleep: async () => {} });

  assert.equal(result.bySession.get('s1').status, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.bySession.get('s2').status, BackfillSessionStatus.FAILED);
});
