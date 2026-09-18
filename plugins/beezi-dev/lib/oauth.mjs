import crypto from 'crypto';
import os from 'os';
import { apiOrigin, PROTECTED_RESOURCE_PATH } from './config.mjs';
import { UserError } from './friendly-error.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';
import { base64url } from './base64url.mjs';

// Clerk development instances cold-start well past 5s; measured 5.6s–20s on first contact.
const TIMEOUT_MS = 15000;

// A token endpoint answers with a small JSON document. Anything larger is not a grant, and buffering
// it would let a misconfigured or hostile endpoint spend a hook's memory as well as its budget.
export const MAX_BODY_BYTES = 262_144;

// Why a grant could not be obtained. Each one calls for something different: a dead grant is final,
// a 5xx and a transport failure are worth retrying on a backoff, and a malformed body means the
// endpoint answered but did not answer with a grant.
// Why a grant was REFUSED by us rather than by the provider. Distinct from GrantFailure, which is
// about not getting an answer; these are answers we will not store.
export const GrantError = Object.freeze({
  MISSING_ACCESS_TOKEN: 'grant_missing_access_token',
  // Deliberately its own code. Whether the deployed provider ever omits a refresh token on the
  // INITIAL grant is unverified (see the handoff's Probe A gate), and if it does, every login fails
  // on this branch — so it has to be distinguishable from a generically malformed response.
  MISSING_REFRESH_TOKEN: 'grant_missing_refresh_token',
});

export const GrantFailure = Object.freeze({
  TIMEOUT: 'timeout',
  TRANSPORT: 'transport',
  HTTP_5XX: 'http_5xx',
  HTTP_OTHER: 'http_other',
  MALFORMED: 'malformed',
  NO_REFRESH_TOKEN: 'no_refresh_token',
});

// One end-to-end deadline for a request AND its body.
//
// `fetch` settles when the HEADERS arrive, so an abort timer cleared at that point leaves the body
// read unbounded — undici's only backstop is a 300s body timeout, thirty times what a Cursor hook
// gets before it is killed. Measured against a real server: headers in 27ms, the body still pending
// at 12s. The timer here is cleared only after the body has been read or abandoned, so the two
// phases share ONE budget instead of costing twice it.
async function fetchJsonBounded(fetchImpl, url, init, timeoutMs) {
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (timer != null && typeof timer.unref === 'function') timer.unref();

  const startedAt = Date.now();
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    return { ok: false, status: null, body: null, failure: timedOut ? GrantFailure.TIMEOUT : GrantFailure.TRANSPORT };
  }

  try {
    // What is LEFT of the budget, not a fresh copy of it. A server that dribbles headers at the
    // 1.4s mark and then goes quiet would otherwise cost twice what the caller was promised, which
    // is exactly the overrun a hook's 10s kill turns into a lost turn.
    const body = await readBounded(res, timeoutMs - (Date.now() - startedAt), controller);
    const status = res == null || res.status == null ? null : res.status;
    // `ok` describes the HTTP STATUS and `failure` describes the body, separately. Folding a
    // body-read failure into `ok` made a 401 with an HTML body indistinguishable from a 200 whose
    // body never arrived, and those call for opposite responses.
    return {
      ok: res != null && res.ok === true,
      status,
      body: body.failure == null ? body.value : null,
      failure: body.failure == null ? null : body.failure,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Drain at most MAX_BODY_BYTES and parse. A body that overruns the cap or the budget is cancelled,
// not merely abandoned: an open socket is exactly what keeps a finished hook process alive.
async function readBounded(res, timeoutMs, controller) {
  if (res == null || typeof res !== 'object') return { failure: GrantFailure.MALFORMED };
  const stream = res.body;
  const reader = stream != null && typeof stream.getReader === 'function' ? stream.getReader() : null;

  if (reader == null) {
    // A response with no stream — a stubbed fetch, or an implementation handing back a plain object.
    if (typeof res.json !== 'function') return { failure: GrantFailure.MALFORMED };
    try {
      const value = await Promise.race([
        Promise.resolve(res.json()).then((v) => ({ value: v }), () => ({ failure: GrantFailure.MALFORMED })),
        expire(timeoutMs),
      ]);
      return value;
    } catch {
      return { failure: GrantFailure.MALFORMED };
    }
  }

  const drain = (async () => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) {
          bytes += chunk.value.length;
          if (bytes > MAX_BODY_BYTES) {
            try { await reader.cancel(); } catch { /* already released */ }
            return { failure: GrantFailure.MALFORMED };
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      }
      text += decoder.decode();
    } catch {
      return { failure: GrantFailure.MALFORMED };
    }
    try { return { value: JSON.parse(text) }; } catch { return { failure: GrantFailure.MALFORMED }; }
  })();

  const result = await Promise.race([drain, expire(timeoutMs)]);
  if (result.failure === GrantFailure.TIMEOUT) {
    // Release the socket. `drain`'s rejection is pre-observed by the race, so cancelling is safe.
    try {
      const cancelled = reader.cancel();
      if (cancelled != null && typeof cancelled.catch === 'function') cancelled.catch(() => {});
    } catch { /* already released */ }
    try { controller.abort(); } catch { /* already aborted */ }
  }
  return result;
}

function expire(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ failure: GrantFailure.TIMEOUT }), Math.max(0, timeoutMs));
    if (timer != null && typeof timer.unref === 'function') timer.unref();
  });
}

const budget = (deps) => (deps.timeoutMs == null ? TIMEOUT_MS : deps.timeoutMs);

export function pkcePair() {
  // Not `.toString('base64url')` / `.digest('base64url')`: that encoding does not exist on the
  // Node 13.2 floor this plugin declares, and produces a value the authorization server rejects.
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Is this body a grant we may store?
//
// Login used to store whatever the token endpoint returned. A response with no access_token became
// a credential that reads back as corrupt; one with no refresh_token became a link that works until
// the first expiry and then can only be repaired by another browser round-trip, with nothing
// anywhere explaining why. A REFRESH is different: omitting a replacement refresh token is the
// provider declining to rotate, and the caller keeps the one it has.
export function validateGrant(body, { initial = false } = {}) {
  if (body == null || typeof body !== 'object') {
    return { ok: false, code: GrantError.MISSING_ACCESS_TOKEN, reason: 'the login server did not return a usable access token' };
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  if (!accessToken) {
    return { ok: false, code: GrantError.MISSING_ACCESS_TOKEN, reason: 'the login server did not return a usable access token' };
  }
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
  if (initial && !refreshToken) {
    return {
      ok: false,
      code: GrantError.MISSING_REFRESH_TOKEN,
      reason: 'the login server returned no refresh token, so this link would stop working at the first '
        + 'token expiry and could only be repaired by signing in again. Nothing was stored. If your Beezi '
        + 'administrator has only just changed the sign-in configuration, ask them to confirm this client '
        + 'is allowed the refresh_token grant',
    };
  }
  const tokens = { ...body, access_token: accessToken };
  if (refreshToken) tokens.refresh_token = refreshToken;
  else delete tokens.refresh_token;
  return { ok: true, tokens };
}

// Same discovery chain MCP clients use: the portal's RFC 9728 protected-resource document names the
// Clerk issuer; the issuer's own metadata names the endpoints.
export async function discover(deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const origin = deps.origin == null ? apiOrigin() : deps.origin;
  const timeoutMs = budget(deps);

  const pr = await fetchJsonBounded(fetchImpl, `${origin}${PROTECTED_RESOURCE_PATH}`, undefined, timeoutMs);
  if (!pr.ok || pr.body == null) {
    throw new UserError(
      pr.status == null
        ? `OAuth discovery failed (${pr.failure} talking to ${origin}). Check BEEZI_API_URL.`
        : `OAuth discovery failed (HTTP ${pr.status} from ${origin}). Check BEEZI_API_URL.`,
    );
  }
  const issuer = pr.body.authorization_servers == null ? undefined : pr.body.authorization_servers[0];
  if (!issuer) {
    throw new UserError('OAuth discovery failed: portal metadata lists no authorization server.');
  }

  const as = await fetchJsonBounded(
    fetchImpl,
    `${String(issuer).replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    undefined,
    timeoutMs,
  );
  if (!as.ok || as.body == null) {
    throw new UserError(
      as.status == null
        ? `OAuth discovery failed (${as.failure} talking to the authorization server).`
        : `OAuth discovery failed (HTTP ${as.status} from the authorization server).`,
    );
  }
  const meta = as.body;
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
    throw new UserError('OAuth discovery failed: authorization server metadata is incomplete.');
  }
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    // OPTIONAL, and deliberately not required above: a provider that publishes no revocation
    // endpoint is still a working provider. Logout reads this and reports the revocation as
    // UNCONFIRMED when it is null — it never derives a URL from the token endpoint, which is what
    // produced a 404 that was reported to the user as "access revoked".
    revocationEndpoint: typeof meta.revocation_endpoint === 'string' && meta.revocation_endpoint
      ? meta.revocation_endpoint
      : null,
  };
}

// Dynamic client registration (RFC 7591): one public client per machine.
export async function registerClient(registrationEndpoint, redirectUri, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const hostname = deps.hostname == null ? os.hostname() : deps.hostname;
  const r = await fetchJsonBounded(fetchImpl, registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Beezi Cursor plugin — ${hostname}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  }, budget(deps));
  if (!r.ok) {
    throw new UserError(
      r.status == null
        ? `Could not register this machine with the login server (${r.failure}).`
        : `Could not register this machine with the login server (HTTP ${r.status}).`,
    );
  }
  if (r.body == null || !r.body.client_id) throw new UserError('Login server returned no client_id.');
  return r.body.client_id;
}

function formInit(params) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  };
}

// The initial grant. Throws a UserError on any failure — and validates before returning, so a
// malformed grant becomes a failed sign-in the user can retry rather than a stored broken link.
// Nothing here writes to the credential store; the caller commits only what this returns.
export async function exchangeCode({ tokenEndpoint, clientId, redirectUri, code, verifier }, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const r = await fetchJsonBounded(fetchImpl, tokenEndpoint, formInit({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }), budget(deps));
  if (!r.ok || r.failure != null) {
    if (!r.ok) {
      throw new UserError(
        r.status == null
          ? `Login failed at the token exchange (${r.failure}).`
          : `Login failed at the token exchange (HTTP ${r.status}).`,
      );
    }
    throw new UserError(`Login failed: the login server's answer could not be read (${r.failure}).`);
  }
  const validated = validateGrant(r.body, { initial: true });
  if (!validated.ok) {
    const error = new UserError(`Login failed: ${validated.reason}.`);
    // Carried so a caller — and the diagnostics recorder — can tell "the provider is not issuing
    // refresh tokens to this client" from "the response was junk". They need different answers.
    error.code = validated.code;
    throw error;
  }
  return validated.tokens;
}

// Returns {tokens} on success, {invalidGrant: true} when the grant was revoked (machine unlinked /
// user deactivated), or {tokens: null, failure} for everything else — classified, because the
// caller's response differs: a dead grant is final, a 5xx or a transport failure earns a backoff.
export async function refreshTokens({ tokenEndpoint, clientId, refreshToken }, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    // Nothing to exchange. Asking anyway would produce a 400 that looks exactly like a dead grant.
    return { tokens: null, failure: GrantFailure.NO_REFRESH_TOKEN };
  }
  const r = await fetchJsonBounded(fetchImpl, tokenEndpoint, formInit({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }), budget(deps));

  // No status at all: the request never got an answer.
  if (r.status == null) return { tokens: null, failure: r.failure };
  if (r.status >= 500) return { tokens: null, failure: GrantFailure.HTTP_5XX };
  // Unlinking the machine destroys the only copy of the refresh token, so it takes POSITIVE
  // evidence: an OAuth error body that actually names a dead grant. Treating "no recognizable error
  // field" as revocation meant any 400/401 that was not really OAuth — a corporate proxy answering
  // `401 Proxy Authentication Required` with an HTML body, a gateway rate-limiting the token
  // endpoint — silently signed the machine out and forced a full browser re-link.
  if (r.status === 400 || r.status === 401) {
    const error = r.body != null && typeof r.body.error === 'string' ? r.body.error : null;
    if (error === 'invalid_grant' || error === 'invalid_client') return { invalidGrant: true };
  }
  if (!r.ok) return { tokens: null, failure: GrantFailure.HTTP_OTHER };

  // A 2xx. Whatever went wrong is about the BODY: it never arrived inside the budget, it overran
  // the size cap, or it was not a grant.
  if (r.failure != null) return { tokens: null, failure: r.failure };
  const validated = validateGrant(r.body, { initial: false });
  return validated.ok ? { tokens: validated.tokens } : { tokens: null, failure: GrantFailure.MALFORMED };
}

// Ask the authorization server to revoke a token (RFC 7009). `revocationEndpoint` comes from
// discovery metadata and is never derived from the token endpoint: a guessed URL that 404s would be
// reported to the user as a revocation that happened.
export async function revokeToken({ revocationEndpoint, clientId, token, tokenTypeHint }, deps = {}) {
  if (typeof revocationEndpoint !== 'string' || revocationEndpoint === '') {
    return { status: 'unavailable' };
  }
  if (typeof token !== 'string' || token === '') return { status: 'unavailable' };
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const params = { token, client_id: clientId };
  if (tokenTypeHint) params.token_type_hint = tokenTypeHint;
  const r = await fetchJsonBounded(fetchImpl, revocationEndpoint, formInit(params), budget(deps));
  // RFC 7009: a successful revocation is 200, and the body is empty — which reads here as a
  // malformed JSON document. The STATUS is the confirmation, so an unparseable body on a 2xx is
  // still a confirmed revocation.
  if (r.status != null && r.status >= 200 && r.status < 300) return { status: 'confirmed', httpStatus: r.status };
  return { status: 'unconfirmed', httpStatus: r.status, failure: r.failure };
}
