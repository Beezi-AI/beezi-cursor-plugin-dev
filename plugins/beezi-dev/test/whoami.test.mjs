import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { whoami, probeWhoami, WhoamiOutcome, WHOAMI_TIMEOUT_MS } from '../lib/whoami.mjs';

const deps = (fetchImpl) => ({ fetchImpl, base: 'https://api.test' });

test('whoami — 200 with body → valid with fields', async () => {
  const res = await whoami('tok', deps(async () => ({
    ok: true,
    json: async () => ({
      email: 'dev@acme.com',
      name: 'Dev Eloper',
    }),
  })));
  assert.deepEqual(res, {
    valid: true,
    email: 'dev@acme.com',
    name: 'Dev Eloper',
    tenantTier: null,
    trackingMode: null,
    backfillCompleted: false,
  });
});

test('whoami — 200 with tracking policy → policy fields carried', async () => {
  const res = await whoami('tok', deps(async () => ({
    ok: true,
    json: async () => ({
      email: 'dev@acme.com',
      name: 'Dev Eloper',
      tenantTier: 'platform',
      trackingMode: 'backfill_only',
      backfillCompleted: true,
    }),
  })));
  assert.deepEqual(res, {
    valid: true,
    email: 'dev@acme.com',
    name: 'Dev Eloper',
    tenantTier: 'platform',
    trackingMode: 'backfill_only',
    backfillCompleted: true,
  });
});

test('whoami — 401 → { valid: false }', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 401, ok: false })));
  assert.deepEqual(res, { valid: false });
});

test('whoami — 403 → not valid (and see the forbidden flag below)', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 403, ok: false })));
  assert.equal(res.valid, false);
});

test('whoami — other non-ok (500) → null', async () => {
  const res = await whoami('tok', deps(async () => ({ status: 500, ok: false })));
  assert.equal(res, null);
});

test('whoami — fetch throws (offline) → null', async () => {
  const res = await whoami('tok', deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.equal(res, null);
});

test('whoami — 200 but body missing fields → nulls', async () => {
  const res = await whoami('tok', deps(async () => ({ ok: true, json: async () => ({}) })));
  assert.deepEqual(res, {
    valid: true, email: null, name: null,
    tenantTier: null, trackingMode: null, backfillCompleted: false,
  });
});

// A connection the server accepts and never answers — a local API paused in a debugger, an app
// mid-restart, a proxy holding the socket. Without a bound this never settles, and because
// performLogin calls whoami *after* storing the credentials, a completed login is stranded: the
// browser round-trip succeeded, the token is on disk, and the MCP tool call never returns a result.
const hangingFetch = () => (url, opts) =>
  new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

test('whoami — server accepts but never answers → null, not a hang', async () => {
  const res = await whoami('tok', { fetchImpl: hangingFetch(), base: 'https://api.test', timeoutMs: 30 });
  assert.equal(res, null);
});

test('whoami — every request carries an abort signal', async () => {
  let seen;
  await whoami('tok', {
    base: 'https://api.test',
    fetchImpl: async (url, opts) => { seen = opts?.signal; return { ok: true, json: async () => ({}) }; },
  });
  assert.ok(seen, 'no signal passed — the request is unbounded');
  assert.equal(typeof seen.aborted, 'boolean');
});

test('whoami — sends bearer token to the whoami URL', async () => {
  let seen;
  await whoami('my-token', deps(async (url, opts) => {
    seen = { url, auth: opts?.headers?.Authorization };
    return { ok: true, json: async () => ({}) };
  }));
  assert.equal(seen.url, 'https://api.test/me/cursor/whoami');
  assert.equal(seen.auth, 'Bearer my-token');
});

// A stub can only stall the headers. The half that used to be unbounded is the BODY, and reaching
// it needs a real socket: a server that answers 200 with headers and then writes nothing.
const servers = [];

after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

function startStallingServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('whoami — a server that answers and then stalls the body stays inside the budget', async () => {
  // Before the body was bounded this returned in ~300s (undici's bodyTimeout), inside a hook that
  // Cursor kills at ~10s — so the hook died mid-turn rather than degrading to "unknown".
  const base = await startStallingServer();
  const startedAt = Date.now();
  const res = await whoami('tok', { base, timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;

  // The status already proved the token good; an unread body just means no display name.
  assert.deepEqual(res, {
    valid: true, email: null, name: null,
    tenantTier: null, trackingMode: null, backfillCompleted: false,
  });
  assert.ok(elapsed < 2000, `took ${elapsed}ms — the body read is not bounded`);
});

test('whoami — headers and body share ONE budget, they do not each get a full one', async () => {
  // The headers arrive at the very end of the budget, so the body must get only the remainder.
  // Two independent budgets would double the promised bound, which is exactly the overrun that
  // only ever reproduces on the slow connection of the user reporting it.
  const base = await startStallingServer();
  const budget = 400;
  const slowHeaders = async (url, opts) => {
    await new Promise((r) => setTimeout(r, budget - 100));
    return globalThis.fetch(url, opts);
  };
  const startedAt = Date.now();
  await whoami('tok', { base, fetchImpl: slowHeaders, timeoutMs: budget });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < budget * 2, `took ${elapsed}ms for a ${budget}ms budget — the phases are not sharing it`);
});

test('whoami — defaults to its own short budget, not the 10s generic read default', async () => {
  // whoami is never the point of the turn, it is a check on the way to the point of the turn.
  // Inheriting the generic read default let one identity lookup spend the whole hook budget.
  assert.equal(WHOAMI_TIMEOUT_MS, 1500);
  const startedAt = Date.now();
  const res = await whoami('tok', { base: 'https://api.test', fetchImpl: hangingFetch() });
  const elapsed = Date.now() - startedAt;
  assert.equal(res, null);
  assert.ok(elapsed < 5000, `took ${elapsed}ms — whoami inherited the 10s read default`);
});

test('whoami — an explicit timeoutMs overrides the default', async () => {
  const startedAt = Date.now();
  await whoami('tok', { base: 'https://api.test', fetchImpl: hangingFetch(), timeoutMs: 40 });
  assert.ok(Date.now() - startedAt < 1000, 'the caller-supplied budget was ignored');
});

// ── probeWhoami: the typed probe (CONTRACTS §2) ──────────────────────────────
//
// `whoami()` above answers a boolean question, and 401 and 403 give it the same answer. They are
// not the same event: 401 says the token is not accepted (a refresh may fix it), 403 says the
// caller is authenticated and not entitled (nothing this client can do fixes it, and relinking
// certainly cannot). Collapsing them is what let an entitlement refusal delete a working link.

test('probeWhoami — 200 is AUTHORIZED and carries tenant and policy', async () => {
  const r = await probeWhoami('tok', deps(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ email: 'dev@acme.com', name: 'Dev', tenantTier: 'platform', trackingMode: 'live' }),
  })));
  assert.equal(r.outcome, WhoamiOutcome.AUTHORIZED);
  assert.equal(r.status, 200);
  assert.equal(r.tenant.email, 'dev@acme.com');
  assert.equal(r.tenant.tenantTier, 'platform');
  assert.deepEqual(r.policy, { mode: 'live' });
  assert.equal(r.bodyMissing, false);
});

// PIPE-02/03: "the server sent no body" is not "the server confirmed a tracking policy".
test('probeWhoami — an authorized answer with no readable body is flagged, not invented', async () => {
  const r = await probeWhoami('tok', deps(async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } })));
  assert.equal(r.outcome, WhoamiOutcome.AUTHORIZED);
  assert.equal(r.bodyMissing, true);
  assert.equal(r.policy, null, 'no policy was confirmed');
});

test('probeWhoami — 401 is UNAUTHORIZED, 403 is FORBIDDEN', async () => {
  const unauthorized = await probeWhoami('tok', deps(async () => ({ ok: false, status: 401 })));
  assert.equal(unauthorized.outcome, WhoamiOutcome.UNAUTHORIZED);
  const forbidden = await probeWhoami('tok', deps(async () => ({ ok: false, status: 403 })));
  assert.equal(forbidden.outcome, WhoamiOutcome.FORBIDDEN);
});

test('probeWhoami — 429, 5xx, transport failure and a malformed body are each INDETERMINATE', async () => {
  for (const status of [429, 500, 502, 503]) {
    const r = await probeWhoami('tok', deps(async () => ({ ok: false, status })));
    assert.equal(r.outcome, WhoamiOutcome.INDETERMINATE, `HTTP ${status}`);
    assert.equal(r.status, status);
  }
  const transport = await probeWhoami('tok', deps(async () => { throw new Error('ECONNRESET'); }));
  assert.equal(transport.outcome, WhoamiOutcome.INDETERMINATE);
  assert.equal(transport.status, null);
});

test('probeWhoami — a stalled body does not turn an authorized token into a refusal', async () => {
  const r = await probeWhoami('tok', {
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    base: 'https://api.test',
    timeoutMs: 20,
  });
  assert.equal(r.outcome, WhoamiOutcome.AUTHORIZED);
  assert.equal(r.bodyMissing, true);
});

// `whoami()` keeps its shipped shape — lib/link-status.mjs is a shared file and reads it — but a
// 403 is now additionally FLAGGED, so the callers that must not delete on it can tell.
test('whoami — 403 keeps its legacy shape and is additionally flagged forbidden', async () => {
  const forbidden = await whoami('tok', deps(async () => ({ status: 403, ok: false })));
  assert.equal(forbidden.valid, false);
  assert.equal(forbidden.forbidden, true);
  const unauthorized = await whoami('tok', deps(async () => ({ status: 401, ok: false })));
  assert.equal(unauthorized.valid, false);
  assert.equal(unauthorized.forbidden, undefined);
});
