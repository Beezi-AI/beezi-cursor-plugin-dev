import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DIAGNOSTICS_SCHEMA_VERSION,
  MAX_EVENTS_PER_BATCH,
  MAX_BODY_BYTES,
  WIRE_FIELDS,
  OPTIONAL_WIRE_FIELDS,
  WIRE_CODE_ALIASES,
  MIN_SEND_INTERVAL_MS,
  retryAfterMs,
  toWireEvent,
  encodeEnvelope,
  postDiagnostics,
  flushDiagnostics,
} from '../lib/telemetry-transport.mjs';
import { setConsent } from '../lib/telemetry-consent.mjs';
import { recordIssue, suppressRecording } from '../lib/telemetry-recorder.mjs';
import { telemetryQueueDir, telemetrySendStateFile } from '../lib/telemetry-store.mjs';
import { withLoopAlive } from './helpers/loop-alive.mjs';

// `return await`, not `return` — every body here is async, and a bare return would run the
// cleanup the moment the promise was CREATED, deleting the home out from under the flush.
async function withHome(fn) {
  const previous = process.env.BEEZI_CURSOR_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-tx-'));
  process.env.BEEZI_CURSOR_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.BEEZI_CURSOR_HOME;
    else process.env.BEEZI_CURSOR_HOME = previous;
    suppressRecording(false);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const iso = (ms) => new Date(ms).toISOString();
// Seeded records must be INSIDE the 14-day retention window, or the flush's own sweep is what
// empties the queue and every delivery assertion below passes for the wrong reason.
const FRESH = () => new Date().toISOString();

function seed(count, overrides = {}) {
  const dir = telemetryQueueDir();
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const event = Object.assign({
      eventId: `evt${i}`,
      code: 'hook_crash',
      source: 'stop',
      site: 'lib/checkpoint.mjs:412',
      errorName: 'Error',
      errorCode: 'ENOENT',
      httpStatus: null,
      authState: null,
      reason: null,
      installationId: null,
      pluginVersion: '0.5.2',
      nodeVersion: 'v20.0.0',
      os: 'linux',
      osRelease: '6.8.0',
      arch: 'x64',
      durationMs: 12,
      cursorVersion: '1.2.3',
      count: 1,
      firstSeenAt: FRESH(),
      lastSeenAt: FRESH(),
    }, typeof overrides === 'function' ? overrides(i) : overrides);
    fs.writeFileSync(path.join(dir, `k${i}.json`), JSON.stringify(event));
  }
}

const queueNames = () => {
  try { return fs.readdirSync(telemetryQueueDir()).sort(); } catch { return []; }
};

// Every key in a structure, lowercased, at any depth.
function allKeys(value, out = [], depth = 0) {
  if (depth > 12 || value == null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out, depth + 1);
    return out;
  }
  for (const key of Object.keys(value)) {
    out.push(key.toLowerCase());
    allKeys(value[key], out, depth + 1);
  }
  return out;
}

// ─── the request itself ─────────────────────────────────────────────────────

test('postDiagnostics sends no token, no cookies and no machine headers', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200, headers: { get: () => null } }; };
  await postDiagnostics('https://example.test/api/cli-agent/plugin-diagnostics/public', '{"schemaVersion":2,"events":[]}', { fetchImpl });

  assert.equal(calls.length, 1);
  const headerNames = Object.keys(calls[0].opts.headers).map((h) => h.toLowerCase());
  assert.deepEqual(headerNames, ['content-type']);
  for (const forbidden of ['authorization', 'cookie', 'x-beezi-agent', 'x-beezi-machine', 'x-beezi-hostname']) {
    assert.ok(!headerNames.includes(forbidden), forbidden);
  }
  assert.equal(calls[0].opts.method, 'POST');
});

test('postDiagnostics refuses to follow a redirect', async () => {
  // A redirect is how an unexpected header gets injected into a request that deliberately carries
  // none. Erroring reads as a transport failure, which preserves the queue.
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200, headers: { get: () => null } }; };
  await postDiagnostics('https://example.test/x', '{}', { fetchImpl });
  assert.equal(calls[0].redirect, 'error');
});

test('postDiagnostics bounds the request with an abort signal', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(opts); return { status: 200, headers: { get: () => null } }; };
  await postDiagnostics('https://example.test/x', '{}', { fetchImpl, timeoutMs: 1000 });
  assert.ok(calls[0].signal != null, 'every request carries an abort signal');
});

test('a server that answers and then stalls the body stays inside the budget', async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => null },
    json: () => new Promise(() => {}), // never settles
  });
  const started = Date.now();
  // withLoopAlive: a real stalled body stalls on a ref'd socket; this fake holds nothing, which
  // leaves readJsonBounded's unref'd abandon timer as the only handle. See helpers/loop-alive.mjs.
  // The 200ms budget below is still what has to bound the read.
  const result = await withLoopAlive(() => postDiagnostics('https://example.test/x', '{}', { fetchImpl, timeoutMs: 200 }));
  assert.ok(Date.now() - started < 3000, 'the body read must be bounded too');
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
});

test('retryAfterMs accepts seconds and HTTP-dates and bounds both at an hour', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs(' 30 ', now), 30000);
  assert.equal(retryAfterMs('999999', now), 3600000, 'seconds are capped');
  assert.equal(retryAfterMs('Thu, 17 Sep 2026 12:05:00 GMT', now), 300000);
  assert.equal(retryAfterMs('Thu, 17 Sep 2026 11:00:00 GMT', now), 0, 'a past date is now');
  assert.equal(retryAfterMs('Thu, 18 Sep 2027 12:00:00 GMT', now), 3600000, 'dates are capped');
  for (const bad of [null, undefined, '', 'soon', '-5', '1.5']) {
    assert.equal(retryAfterMs(bad, now), null, String(bad));
  }
});

// ─── the serialized body ────────────────────────────────────────────────────

test('the envelope is exactly schemaVersion 2 plus events', () => {
  const body = JSON.parse(encodeEnvelope([toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'stop', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
  })], null));
  assert.deepEqual(Object.keys(body).sort(), ['events', 'schemaVersion']);
  assert.equal(body.schemaVersion, DIAGNOSTICS_SCHEMA_VERSION);
  assert.equal(DIAGNOSTICS_SCHEMA_VERSION, 2);
});

test('installationId rides on the envelope only when there is one', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const withId = JSON.parse(encodeEnvelope([], id));
  assert.equal(withId.installationId, id);
  assert.ok(!('installationId' in JSON.parse(encodeEnvelope([], null))));
});

test('a serialized event carries only the fields the deployed DTO declares', () => {
  const wire = toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'stop', site: 'lib/x.mjs:1',
    errorName: 'Error', errorCode: 'ENOENT', httpStatus: 500, pluginVersion: '0.5.2',
    nodeVersion: 'v20.0.0', os: 'linux', osRelease: '6.8.0', arch: 'x64',
    count: 2, firstSeenAt: iso(0), lastSeenAt: iso(1),
    // Local-only, and every one of them would reject the event server-side.
    durationMs: 12, cursorVersion: '1.2.3', installationId: null,
    stack: 'Error: boom\n at x', message: 'boom', prompt: 'hi',
  });
  assert.deepEqual(Object.keys(wire).sort(), WIRE_FIELDS.slice().sort());
  assert.ok(!('cursorVersion' in wire), 'the host version has no backend field yet');
  assert.ok(!('durationMs' in wire));
  assert.ok(!('claudeCodeVersion' in wire) || wire.claudeCodeVersion === null);
});

test('optional wire fields appear only when they carry a value', () => {
  const bare = toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'stop', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
  });
  for (const field of OPTIONAL_WIRE_FIELDS) assert.ok(!(field in bare), field);
  const full = toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'stop', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
    installationId: '11111111-2222-4333-8444-555555555555',
    authState: 'unlinked', reason: 'no_credentials',
  });
  assert.equal(full.authState, 'unlinked');
  assert.equal(full.reason, 'no_credentials');
});

test('vocabulary the deployed backend does not know is dropped, not invented', () => {
  // `PluginDiagnosticReason` and `PluginAuthState` are pinned wire enums at portal 871a788. An
  // unknown value rejects the WHOLE event with UNKNOWN_REASON, so the field goes instead.
  const wire = toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'stop', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
    authState: 'forbidden',   // CONTRACTS §2 has it; PluginAuthState does not
    reason: 'http_5xx',       // CONTRACTS §2 has it; PluginDiagnosticReason does not
  });
  assert.ok(!('authState' in wire));
  assert.ok(!('reason' in wire));
});

test('auth_state_transition is translated to the enum value the backend actually has', () => {
  assert.equal(WIRE_CODE_ALIASES.auth_state_transition, 'auth_state_changed');
  const wire = toWireEvent({
    eventId: 'a', code: 'auth_state_transition', source: 'login', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
  });
  assert.equal(wire.code, 'auth_state_changed');
});

test('an unknown source is neutralized rather than sent', () => {
  const wire = toWireEvent({
    eventId: 'a', code: 'hook_crash', source: 'made_up', pluginVersion: '0.5.2',
    count: 1, firstSeenAt: iso(0), lastSeenAt: iso(0),
  });
  assert.equal(wire.source, 'unknown');
});

test('nothing the intake guard calls an identity claim ever reaches the body', async () => {
  await withHome(async () => {
    setConsent('on');
    recordIssue('login_failed', {
      source: 'login',
      error: Object.assign(new Error(`${os.hostname()} rejected dev@example.com`), { code: 'EACCES' }),
    });
    const bodies = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        bodies.push(body);
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: [], rejected: [] } };
      },
    });
    assert.equal(bodies.length, 1);
    const keys = allKeys(JSON.parse(bodies[0]));
    for (const forbidden of ['userid', 'tenantid', 'email', 'hostname', 'clientid',
      'oauthclientid', 'accesstoken', 'refreshtoken', 'authorization']) {
      assert.ok(!keys.includes(forbidden), `${forbidden} is in the body`);
    }
    assert.ok(!bodies[0].includes(os.hostname()));
  });
});

// ─── batching bounds ────────────────────────────────────────────────────────

test('a batch never exceeds 50 events', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(120);
    const sizes = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        sizes.push(JSON.parse(body).events.length);
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: JSON.parse(body).events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.equal(MAX_EVENTS_PER_BATCH, 50);
    for (const size of sizes) assert.ok(size <= MAX_EVENTS_PER_BATCH, String(size));
  });
});

test('a batch never exceeds 28 KiB of ACTUAL utf-8 bytes, multibyte included', async () => {
  await withHome(async () => {
    setConsent('on');
    // Multibyte where the DTO allows it: an os release is a free-ish 80-char string, and
    // `String.length` would under-count these by a factor of three.
    seed(60, (i) => ({
      eventId: `e${i}`,
      osRelease: '中'.repeat(80),             // 80 chars, 240 bytes
      site: `lib/${'a'.repeat(180)}.mjs:1`,
    }));
    const byteLengths = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        byteLengths.push(Buffer.byteLength(body, 'utf-8'));
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: JSON.parse(body).events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.equal(MAX_BODY_BYTES, 28 * 1024);
    for (const bytes of byteLengths) assert.ok(bytes <= MAX_BODY_BYTES, `${bytes} bytes`);
  });
});

test('a single event bigger than the cap is still attempted once', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(1, { site: `lib/${'a'.repeat(60000)}.mjs:1` });
    let requests = 0;
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async () => { requests += 1; return { status: 413, retryAfterMs: null, body: null }; },
    });
    assert.equal(requests, 1, 'a batch is never empty');
    assert.equal(result.deleted, 1, 'the same bytes would be refused forever');
    assert.deepEqual(queueNames(), []);
  });
});

// ─── response handling ──────────────────────────────────────────────────────

test('413 halves the batch and only drops an event that is alone and still refused', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(8);
    const sizes = [];
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const events = JSON.parse(body).events;
        sizes.push(events.length);
        if (events.length > 1) return { status: 413, retryAfterMs: null, body: null };
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.deepEqual(sizes.slice(0, 4), [8, 4, 2, 1]);
    assert.equal(result.deleted, 1, 'exactly the one accepted event is gone');
    assert.equal(queueNames().length, 7);
  });
});

test('a partial acknowledgement deletes only what the server named', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(4);
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const events = JSON.parse(body).events;
        return {
          status: 200,
          retryAfterMs: null,
          body: { acceptedEventIds: [events[0].eventId], rejected: [{ index: 1, eventId: events[1].eventId, reason: 'invalid_schema' }] },
        };
      },
    });
    assert.equal(result.deleted, 2, 'accepted and individually rejected both go');
    assert.equal(queueNames().length, 2, 'the two the server never named are kept');
  });
});

test('an off-contract 2xx acknowledges nothing', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(3);
    const result = await flushDiagnostics({
      // A captive portal, a proxy, a load balancer: anything but the route.
      postDiagnosticsImpl: async () => ({ status: 200, retryAfterMs: null, body: { ok: true } }),
    });
    assert.equal(result.deleted, 0);
    assert.equal(queueNames().length, 3);
    assert.equal(result.offContract, true);
  });
});

test('network failure, 429 and 5xx all preserve the queue', async () => {
  for (const outcome of [
    () => { throw new Error('ECONNREFUSED'); },
    () => ({ status: 429, retryAfterMs: 120000, body: null }),
    () => ({ status: 503, retryAfterMs: null, body: null }),
    () => ({ status: 0, retryAfterMs: null, body: null }),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withHome(async () => {
      setConsent('on');
      seed(3);
      const result = await flushDiagnostics({ postDiagnosticsImpl: async () => outcome() });
      assert.equal(result.deleted, 0);
      assert.equal(queueNames().length, 3);
      assert.ok(result.kept >= 3);
    });
  }
});

test('a bounded Retry-After sets the next attempt; an absurd one cannot park the queue', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(1);
    await flushDiagnostics({
      now: () => 1000,
      postDiagnosticsImpl: async () => ({ status: 429, retryAfterMs: 120000, body: null }),
    });
    const state = JSON.parse(fs.readFileSync(telemetrySendStateFile(), 'utf-8'));
    assert.equal(state.nextAttemptAt, 1000 + 120000);
  });
});

test('a 4xx that is about the bytes discards them rather than retrying forever', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(2);
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async () => ({ status: 400, retryAfterMs: null, body: null }),
    });
    assert.equal(result.deleted, 2);
    assert.deepEqual(queueNames(), []);
  });
});

// ─── consent, rechecked ─────────────────────────────────────────────────────

test('a flush with no consent sends nothing and purges what is queued', async () => {
  await withHome(async () => {
    seed(3);
    let requests = 0;
    const result = await flushDiagnostics({ postDiagnosticsImpl: async () => { requests += 1; return { status: 200 }; } });
    assert.equal(requests, 0);
    assert.equal(result.purged, true);
    assert.deepEqual(queueNames(), []);
  });
});

test('consent is rechecked before EVERY batch, not once per worker', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(120);
    let requests = 0;
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        requests += 1;
        // The user types `beezi telemetry off` between the first and second request.
        setConsent('off');
        const events = JSON.parse(body).events;
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.equal(requests, 1, 'the rest of the backlog is never sent');
    assert.equal(result.purged, true);
    assert.deepEqual(queueNames(), []);
  });
});

test('the flush never records a diagnostic about itself', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(1);
    await flushDiagnostics({
      postDiagnosticsImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    // The one seeded record and nothing else: no queue_flush_http_error about the failure to
    // deliver, which the next worker would fail to deliver in exactly the same way.
    assert.equal(queueNames().length, 1);
  });
});

// ─── the envelope identity can never substitute for a missing one ───────────
//
// The route resolves each row as `event.installationId ?? dto.installationId ?? null`
// (public-plugin-diagnostics.service.ts at 871a788). An event recorded while consent was merely
// `on` carries no id at all, so an envelope id would be filled into it — and a machine that later
// ran `correlate` would have its earlier ANONYMOUS reports attributed to the account.

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

async function envelopeOf(events) {
  const bodies = [];
  await flushDiagnostics({
    postDiagnosticsImpl: async (url, body) => {
      bodies.push(JSON.parse(body));
      const sent = JSON.parse(body).events;
      return { status: 200, retryAfterMs: null, body: { acceptedEventIds: sent.map((e) => e.eventId), rejected: [] } };
    },
  });
  assert.equal(bodies.length, 1, 'expected exactly one request');
  return bodies[0];
}

// Every fixture below that seeds a STAMPED record grants `correlate`, not `on`. It used to say
// `on`, which describes a machine that never gave the correlation grant — and on such a machine a
// stamped record cannot exist, because the recorder only stamps behind `currentInstallationId()`.
// The flush now rechecks correlation between batches (B2) and deletes what it finds, so the old
// fixture was not merely artificial, it was a state the flush is specifically there to clean up.
// The envelope arithmetic under test is identical either way; only the consent mode changed.

test('a mixed batch names no installation id on the envelope', async () => {
  await withHome(async () => {
    setConsent('correlate');
    seed(3, (i) => ({ eventId: `e${i}`, installationId: i === 0 ? ID_A : null }));
    const envelope = await envelopeOf();
    assert.ok(!('installationId' in envelope),
      'an anonymous report must not inherit a correlated one\'s identity');
    // The one event that WAS stamped keeps its own id; the other two have no such key at all.
    const stamped = envelope.events.filter((e) => e.installationId != null);
    assert.equal(stamped.length, 1);
    assert.equal(stamped[0].installationId, ID_A);
  });
});

test('two different identities in one batch also name none', async () => {
  await withHome(async () => {
    setConsent('correlate');
    seed(2, (i) => ({ eventId: `e${i}`, installationId: i === 0 ? ID_A : ID_B }));
    const envelope = await envelopeOf();
    assert.ok(!('installationId' in envelope));
  });
});

test('a batch that is entirely one identity may restate it on the envelope', async () => {
  await withHome(async () => {
    setConsent('correlate');
    seed(3, (i) => ({ eventId: `e${i}`, installationId: ID_A }));
    const envelope = await envelopeOf();
    assert.equal(envelope.installationId, ID_A, 'nothing can be substituted, so it is free');
    for (const event of envelope.events) assert.equal(event.installationId, ID_A);
  });
});

test('an all-anonymous batch names no identity anywhere', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(2);
    const envelope = await envelopeOf();
    assert.ok(!('installationId' in envelope));
    for (const event of envelope.events) assert.ok(!('installationId' in event));
  });
});

test('the byte budget is charged for an envelope identity whether or not one appears', async () => {
  // takeBatch cannot know the id before the batch is chosen, so it charges the widest envelope.
  // A batch sized without that allowance could land over the cap the moment an id is restated.
  await withHome(async () => {
    setConsent('correlate');
    seed(60, (i) => ({
      eventId: `e${i}`,
      installationId: ID_A,
      osRelease: '中'.repeat(80),
      site: `lib/${'a'.repeat(180)}.mjs:1`,
    }));
    const sizes = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        sizes.push(Buffer.byteLength(body, 'utf-8'));
        const sent = JSON.parse(body).events;
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: sent.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.ok(sizes.length > 0);
    for (const bytes of sizes) assert.ok(bytes <= MAX_BODY_BYTES, `${bytes} bytes`);
  });
});

// ─── a persistent 413 has to converge ──────────────────────────────────────
//
// A run makes at most four requests, so a batch of fifty that is refused every time only gets to
// 50 -> 25 -> 13 -> 7 before it stops. If the next run started at fifty again, the one impossible
// event refusing the whole batch would be retried forever and nothing else in the queue would ever
// be delivered. The shrunken limit is persisted so successive runs reach a batch of one, which is
// the size the disposal branch needs.

const always413 = async () => ({ status: 413, retryAfterMs: null, body: null });
const sendState = () => JSON.parse(fs.readFileSync(telemetrySendStateFile(), 'utf-8'));

test('a persistently refused batch shrinks across runs until an event can be dropped', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(40);
    const firstSizes = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        firstSizes.push(JSON.parse(body).events.length);
        return always413();
      },
    });
    assert.equal(firstSizes[0], 40, 'the first run starts at the full batch');
    assert.ok(sendState().batchLimit < 40, 'and leaves the shrink behind for the next one');

    let runs = 1;
    let dropped = 0;
    let smallest = firstSizes[firstSizes.length - 1];
    while (runs < 8 && dropped === 0) {
      const sizes = [];
      // eslint-disable-next-line no-await-in-loop
      const result = await flushDiagnostics({
        postDiagnosticsImpl: async (url, body) => {
          sizes.push(JSON.parse(body).events.length);
          return always413();
        },
      });
      assert.ok(sizes[0] <= smallest, `run ${runs + 1} started at ${sizes[0]}, not below ${smallest}`);
      smallest = sizes[sizes.length - 1];
      dropped = result.deleted;
      runs += 1;
    }
    assert.ok(dropped > 0, `never converged to a single-event drop after ${runs} runs`);
    assert.ok(queueNames().length < 40, 'the impossible event is gone');
  });
});

test('a 413 counts as a failed attempt and backs the sender off', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(8);
    await flushDiagnostics({ now: () => 1000, postDiagnosticsImpl: always413 });
    const state = sendState();
    assert.ok(state.attempts > 0, 'a refusal is an attempt');
    assert.ok(state.nextAttemptAt > 1000 + MIN_SEND_INTERVAL_MS,
      'and the next run waits longer than the floor');
  });
});

test('a successful send restores full batches', async () => {
  await withHome(async () => {
    setConsent('on');
    seed(8);
    await flushDiagnostics({ postDiagnosticsImpl: always413 });
    assert.ok(sendState().batchLimit < MAX_EVENTS_PER_BATCH);

    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const events = JSON.parse(body).events;
        return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
      },
    });
    assert.equal(sendState().batchLimit, MAX_EVENTS_PER_BATCH,
      'one historical 413 must not cap every future batch for the life of the machine');
    assert.equal(sendState().attempts, 0);
  });
});

test('a corrupt or hostile batchLimit cannot park or widen the sender', async () => {
  for (const [stored, expected] of [[0, 1], [-5, 1], [999, MAX_EVENTS_PER_BATCH], ['x', MAX_EVENTS_PER_BATCH]]) {
    // eslint-disable-next-line no-await-in-loop
    await withHome(async () => {
      setConsent('on');
      seed(3);
      fs.writeFileSync(telemetrySendStateFile(), JSON.stringify({
        version: 1, attempts: 0, nextAttemptAt: 0, batchLimit: stored,
      }));
      const sizes = [];
      await flushDiagnostics({
        postDiagnosticsImpl: async (url, body) => {
          sizes.push(JSON.parse(body).events.length);
          const events = JSON.parse(body).events;
          return { status: 200, retryAfterMs: null, body: { acceptedEventIds: events.map((e) => e.eventId), rejected: [] } };
        },
      });
      assert.ok(sizes[0] >= 1, `stored ${stored} produced an empty batch`);
      assert.ok(sizes[0] <= Math.min(expected, 3), `stored ${stored} produced ${sizes[0]}`);
    });
  }
});

// ─── B2: correlation consent is rechecked between batches, like diagnostics consent ────────────

test('correlation withdrawn mid-run — the already-stamped batches are deleted, not sent', async () => {
  await withHome(async () => {
    // The exact sequence the CLI describes. `setConsent('anonymous')` writes the denial FIRST and
    // purges SECOND, on purpose — but the purge finds the delivery lock held by a running worker
    // and is deferred, and scripts/telemetry.mjs then tells the user "correlated reports are
    // cleared on the next run". Before this recheck existed the worker went on to send up to three
    // more batches that were already stamped with the installation ID, so the reports that were
    // promised to be deleted were delivered instead.
    setConsent('correlate');
    seed(120, (i) => ({ installationId: i < 60 ? ID_A : null }));

    // Per REQUEST, not one flat list: the batch limit is bounded by bytes as well as by count, so
    // a fixed offset into a flat list is not the boundary between "before the withdrawal" and
    // "after" it.
    const perRequest = [];
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const parsed = JSON.parse(body);
        perRequest.push(parsed.events.map((e) => e.installationId));
        // Withdraw correlation after the first request has already gone out, exactly as a user
        // typing the command between two of a run's four requests would.
        if (perRequest.length === 1) setConsent('anonymous');
        return {
          status: 200,
          retryAfterMs: null,
          body: { acceptedEventIds: parsed.events.map((e) => e.eventId), rejected: [] },
        };
      },
    });

    assert.ok(perRequest.length >= 2, 'the run must continue, so the recheck is actually exercised');
    for (let i = 1; i < perRequest.length; i += 1) {
      assert.deepEqual(
        perRequest[i].filter((id) => id != null),
        [],
        `request ${i + 1} sent a correlated report after correlation was withdrawn`,
      );
    }
    // And the correlated ones still on disk were deleted rather than left for a later run.
    for (const name of queueNames()) {
      const record = JSON.parse(fs.readFileSync(path.join(telemetryQueueDir(), name), 'utf-8'));
      assert.equal(record.installationId, null, `${name} still carries an installation ID`);
    }
    assert.ok(result.requests >= 2);
    assert.ok(result.deleted >= 0);
  });
});

test('correlation already withdrawn before a run — nothing stamped is sent at all', async () => {
  await withHome(async () => {
    setConsent('correlate');
    seed(2, (i) => ({ installationId: i === 0 ? ID_A : null }));
    setConsent('anonymous');

    const sentIds = [];
    await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const parsed = JSON.parse(body);
        for (const e of parsed.events) sentIds.push(e.installationId);
        return {
          status: 200,
          retryAfterMs: null,
          body: { acceptedEventIds: parsed.events.map((e) => e.eventId), rejected: [] },
        };
      },
    });
    assert.deepEqual(sentIds.filter((id) => id != null), []);
  });
});

test('diagnostics still on and correlation still granted — the run is unchanged', async () => {
  await withHome(async () => {
    setConsent('correlate');
    seed(3, () => ({ installationId: ID_A }));
    const sentIds = [];
    const result = await flushDiagnostics({
      postDiagnosticsImpl: async (url, body) => {
        const parsed = JSON.parse(body);
        for (const e of parsed.events) sentIds.push(e.installationId);
        return {
          status: 200,
          retryAfterMs: null,
          body: { acceptedEventIds: parsed.events.map((e) => e.eventId), rejected: [] },
        };
      },
    });
    assert.deepEqual(sentIds, [ID_A, ID_A, ID_A], 'a granted run still carries the identity');
    assert.equal(result.sent, 3);
  });
});
