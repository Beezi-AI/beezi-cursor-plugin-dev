import {
  CredentialStatus,
  commitCredentials as _commitCredentials,
  deleteCredentials as _deleteCredentials,
  getCredentials as _getCredentials,
  readControlSnapshot,
  readCredentialRecord as _readCredentialRecord,
  setCredentials as _setCredentials,
} from './credentials.mjs';
import { withCredentialLock } from './credential-lock.mjs';
import { BACKEND_TIMEOUT_MS } from './credential-backends.mjs';
import { GrantFailure, refreshTokens as _refreshTokens } from './oauth.mjs';
import { setMachineClientId } from './machine-identity.mjs';
import { apiBase } from './config.mjs';
import { readTrackingState } from './tracking.mjs';
import { AuthReason, AuthState, authStateShape } from './auth-state.mjs';
import {
  clearAuthMarkers,
  inBackoff,
  markReauthRequired,
  markRefreshFailure,
  reauthRequiredFor,
} from './auth-markers.mjs';

const SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 86_400;

// How long a refresh waits for the credential lock before reporting REFRESHING. Short on purpose:
// the caller is usually a hook with a budget of its own, and the loser of this race can serve the
// token it already has — the server, not our clock, is the authority on whether it still works.
const LOCK_WAIT_MS = 1000;
const LOCK_WAIT_MAX_MS = 3000;

// Ceiling on how long a token is served from memory, whatever the credential itself claims.
// expires_at is routinely hours out (and DEFAULT_EXPIRES_IN_S below deliberately underestimates to
// a day), so honouring it would mean a link revoked in the portal keeps working inside a running
// bridge until the token would have died on its own. A minute bounds that blindness to something a
// user relinking would never notice, and still covers the burst the memo exists for.
const MEMO_MAX_MS = 60_000;

// The token this process last read out of the credential store, and the instant it stops being
// trustworthy.
//
// getAccessToken() sits on the hot path of the MCP bridge: lib/mcp-bridge.mjs asks for a token on
// EVERY forwarded JSON-RPC message, and that bridge is a long-lived stdio server, not a hook
// process that exits after one event. On Windows the default backend answers by spawning
// powershell.exe and making it compile the CREDENTIAL P/Invoke struct with Add-Type — measured on
// the authoring machine over 7 runs at a median of 532ms per call, of which only 228ms is bare
// `powershell -NoProfile` startup; the rest is the C# compile, paid again from scratch every time.
// A ten-tool-call turn is roughly 13 messages, so about 7 seconds of pure process spawning landed
// directly in the model's tool-call latency, all of it re-reading a credential that had not changed.
//
// Keyed by the store's NAMESPACE and GENERATION, not by time alone. The control record is a small
// non-secret file — one cheap read, no subprocess — and it names the generation that is current, so
// a memo can re-validate itself on every call instead of trusting a clock. That makes every
// committed mutation invalidate it automatically, including one performed by ANOTHER process: a
// login, a refresh or a logout in a hook advances the generation, and the long-lived bridge stops
// serving the previous token on its very next ask rather than up to a minute later.
let memo = null; // { token, clientId, expiresAt, service, generation }

// The seams that replace the credential store outright. A caller that injected one of these is
// asking for THAT store, and answering it from a memo built by the default path — or letting it
// write a memo the default path would then trust — is how one test starts being served another
// test's token. Same rule and same reason as the composerData cache in lib/vscdb.mjs.
//
// `now`/`sleep`/`run`/`platform` are deliberately NOT on this list. They pick the clock, or which
// backend of *this machine's own* store answers (keyring, then the DPAPI/plain file fallback) —
// they do not change whose credential it is, and the memo is written and read through the same
// clock, so an injected one stays self-consistent. `keyringService` IS on it: it selects which
// NAMESPACE answers, which is exactly "whose credential".
const STORE_SEAMS = [
  'getCredentials', 'setCredentials', 'deleteCredentials', 'refreshTokens',
  'getCredentialRecord', 'commitCredentials', 'keyringService',
];

// Never trust a memo past MEMO_MAX_MS, and never past the credential's own skew-adjusted expiry.
const memoUntil = (expiresAt, nowMs) => Math.min((expiresAt == null ? 0 : expiresAt) - SKEW_MS, nowMs + MEMO_MAX_MS);

// Drop the memo. Every path that can make the stored credential differ from what the memo describes
// has to call this: a fresh sign-in, and the portal answering 401/403 in lib/mcp-bridge.mjs. Miss
// one and a single revoked link becomes unrecoverable for the life of the process — the bridge
// keeps presenting the token the server just rejected, every later request 401s, and nothing ever
// goes back to the store to find out the user has already relinked.
export function invalidateTokenCache() {
  memo = null;
}

function cacheableWith(deps) {
  return !STORE_SEAMS.some((seam) => deps[seam] !== undefined);
}

// ── reading the store through whichever seam the caller supplied

// The caller's deadline, spent where it is actually spent.
//
// `deadlineMs` used to travel only as far as the lock wait, while the credential READ — which on
// Windows spawns PowerShell and makes it compile a P/Invoke struct — kept the 5s backend default.
// A hook that asked for 800ms could therefore be held for five seconds by a cold keychain helper
// and killed by Cursor before it ever saw an answer. A caller that named its own `timeoutMs` keeps
// it; nobody's explicit budget is overridden here.
const MIN_BACKEND_MS = 100;

function storeDeps(deps, options) {
  if (options == null || options.deadlineMs == null) return deps;
  if (deps.timeoutMs !== undefined) return deps;
  const budget = Math.max(MIN_BACKEND_MS, Math.min(BACKEND_TIMEOUT_MS, options.deadlineMs));
  return { ...deps, timeoutMs: budget };
}

// The typed record for the current namespace. A caller that injected the OLD `getCredentials` seam
// still gets its store used; it simply has no generation to report, so markers do not apply to it.
async function loadRecord(deps) {
  if (deps.getCredentialRecord !== undefined) return deps.getCredentialRecord(deps);
  if (deps.getCredentials !== undefined) {
    let creds = null;
    try { creds = await deps.getCredentials(deps); } catch { return { status: CredentialStatus.UNREADABLE, creds: null, generation: 0, epoch: 0 }; }
    return creds == null
      ? { status: CredentialStatus.MISSING, creds: null, generation: 0, epoch: 0 }
      : { status: CredentialStatus.OK, creds, generation: 0, epoch: 0 };
  }
  return _readCredentialRecord(deps);
}

// Store status → auth state. The whole point is that these stay apart: only MISSING is UNLINKED.
const STATUS_MAP = {
  [CredentialStatus.MISSING]: [AuthState.UNLINKED, AuthReason.MISSING],
  [CredentialStatus.TIMEOUT]: [AuthState.UNAVAILABLE, AuthReason.TIMEOUT],
  [CredentialStatus.UNREADABLE]: [AuthState.UNAVAILABLE, AuthReason.UNREADABLE],
  [CredentialStatus.CORRUPT]: [AuthState.UNAVAILABLE, AuthReason.CORRUPT],
  [CredentialStatus.RECOVERY_NEEDED]: [AuthState.UNAVAILABLE, AuthReason.CORRUPT],
  [CredentialStatus.LOCKED]: [AuthState.REFRESHING, AuthReason.LOCKED],
  [CredentialStatus.CONFLICT]: [AuthState.REFRESHING, AuthReason.CONFLICT],
  [CredentialStatus.ERROR]: [AuthState.UNAVAILABLE, AuthReason.UNREADABLE],
};

function accountOf() {
  const tracking = readTrackingState();
  if (tracking == null) return null;
  const email = tracking.email == null ? null : tracking.email;
  if (email == null) return null;
  return { email, userId: email, tenantId: tracking.tenantTier == null ? undefined : tracking.tenantTier };
}

// The identity fence every authenticated sender checks (CONTRACTS §2).
//
// It deliberately does NOT contain the store generation: a same-account refresh advances that on
// every token rotation, and fencing on it would make every sender in the plugin defer its payload
// each time a token aged out. The control record carries a separate epoch sequence that only a new
// login or a logout advances, and that is what appears here.
export async function authEpoch(deps = {}) {
  const snapshot = readControlSnapshot(deps);
  const account = accountOf();
  const tenant = account == null || account.tenantId == null ? '' : account.tenantId;
  const user = account == null || account.userId == null ? '' : account.userId;
  return `${apiBase()}|${tenant}|${user}|${snapshot.epoch}`;
}

function shape(state, reason, record, over = {}) {
  return authStateShape(state, reason, {
    generation: record == null ? null : record.generation,
    account: accountOf(),
    ...over,
  });
}

// ── refresh

function lockWait(options) {
  if (options == null || options.deadlineMs == null) return LOCK_WAIT_MS;
  return Math.max(0, Math.min(options.deadlineMs, LOCK_WAIT_MAX_MS));
}

// Perform one refresh for `record`, holding the mutation lock, and commit the result against the
// generation we read. Returns an auth-state shape. Never deletes, never throws.
async function performRefresh(record, deps, options) {
  const refresh = deps.refreshTokens == null ? _refreshTokens : deps.refreshTokens;
  const now = deps.now == null ? Date.now : deps.now;
  const creds = record.creds;
  // The caller's deadline has to reach the rereads INSIDE the lease too. Bounding only the lock wait
  // left a hook that asked for 800ms able to sit for the full backend default on a cold keychain,
  // inside the critical section, and be killed by Cursor before it saw an answer.
  const budgeted = storeDeps(deps, options);

  const outcome = await withCredentialLock(async (handle) => {
    // Everything inside the lease is done THROUGH the lease, so a nested store call re-enters this
    // critical section instead of queueing behind it.
    const leased = { ...budgeted, lock: handle };

    // Reread under the lease. The refresh has been waiting for the lock, and what it was waiting for
    // may well have been a LOGIN: committing our result over that would retire a credential the user
    // just created and leave the machine holding a token for a client that no longer exists.
    const fresh = await loadRecord(leased);
    if (fresh.status === CredentialStatus.OK && fresh.generation !== record.generation) {
      return { kind: 'conflict', creds: fresh.creds, generation: fresh.generation };
    }
    const active = fresh.status === CredentialStatus.OK ? fresh.creds : creds;

    let r;
    try {
      r = await refresh(
        { tokenEndpoint: active.token_endpoint, clientId: active.client_id, refreshToken: active.refresh_token },
        deps,
      );
    } catch {
      // A provider that threw is a transport failure, not a dead grant. Unlinking on it is how a
      // corporate proxy or a DNS blip used to cost a full browser re-link.
      r = { tokens: null };
    }

    if (r.invalidGrant) {
      // POSITIVE evidence that the grant is dead — and still not a reason to delete. The credential
      // stays where it is and the generation is marked; an explicit logout deletes, and a successful
      // sign-in replaces it by committing a new generation, which retires this marker.
      markReauthRequired(record.generation, AuthReason.INVALID_GRANT, deps);
      invalidateTokenCache();
      return { kind: 'reauth' };
    }
    if (r.tokens == null || !r.tokens.access_token) {
      // A credential with no refresh token can never be refreshed, so retrying it on a backoff
      // forever would be a lie: the only way out is a new sign-in.
      if (r.failure === GrantFailure.NO_REFRESH_TOKEN) {
        markReauthRequired(record.generation, AuthReason.INVALID_GRANT, deps);
        invalidateTokenCache();
        return { kind: 'reauth' };
      }
      const reason = r.failure === GrantFailure.HTTP_5XX ? AuthReason.HTTP_5XX : AuthReason.TRANSPORT;
      markRefreshFailure(record.generation, reason, { now });
      return { kind: 'transient', reason };
    }

    const next = {
      ...active,
      access_token: r.tokens.access_token,
      // A provider that legitimately omits a replacement is NOT rotating; erasing the one we hold
      // would leave a credential that can never refresh again.
      refresh_token: r.tokens.refresh_token == null ? active.refresh_token : r.tokens.refresh_token,
      expires_at: now() + (r.tokens.expires_in == null ? DEFAULT_EXPIRES_IN_S : r.tokens.expires_in) * 1000,
    };
    const committed = await commitRefreshed(next, record, leased);
    if (committed != null && committed.conflict === true) {
      return { kind: 'conflict', creds: null, generation: record.generation };
    }
    if (committed == null) return { kind: 'transient', tokens: next };
    clearAuthMarkers(deps);
    invalidateTokenCache();
    return { kind: 'ok', creds: next, generation: committed.generation };
  }, { waitMs: lockWait(options), kill: deps.kill, sleep: deps.sleep });

  if (outcome != null && outcome.ok === false) {
    // Somebody else is mutating the store. Re-read: they may already have published a new token,
    // and if they have not, the one we hold is still the best answer available.
    const again = await loadRecord(budgeted);
    const token = again.status === CredentialStatus.OK ? again.creds.access_token : null;
    return shape(AuthState.REFRESHING, AuthReason.LOCKED, again, { token, epoch: await authEpoch(deps) });
  }
  if (outcome.kind === 'conflict') {
    // A newer credential is committed. Ours is for an identity that no longer applies, so it is
    // abandoned — and the caller is handed the one that IS current, which is usable right now.
    return shape(AuthState.REFRESHING, AuthReason.CONFLICT, { generation: outcome.generation }, {
      token: outcome.creds == null ? null : outcome.creds.access_token,
      epoch: await authEpoch(deps),
    });
  }
  if (outcome.kind === 'reauth') {
    return shape(AuthState.REAUTH_REQUIRED, AuthReason.INVALID_GRANT, record, { epoch: await authEpoch(deps) });
  }
  if (outcome.kind === 'transient') {
    // Transient — let the server 401 if truly dead. The stale token is still offered: it is inside
    // its skew window, not past its expiry, and suppressing it would turn a network blip into an
    // outage for a machine whose token still works.
    const token = outcome.tokens == null ? creds.access_token : outcome.tokens.access_token;
    const reason = outcome.reason == null ? AuthReason.TRANSPORT : outcome.reason;
    return shape(AuthState.READY, reason, record, { token, epoch: await authEpoch(deps) });
  }
  return shape(AuthState.READY, AuthReason.NONE, { generation: outcome.generation }, {
    token: outcome.creds.access_token,
    epoch: await authEpoch(deps),
  });
}

// Write the refreshed credential back through whichever write seam the caller supplied. Returns the
// committed generation, or null when the write could not be made.
async function commitRefreshed(next, record, deps) {
  if (deps.commitCredentials !== undefined) return deps.commitCredentials(next, deps);
  if (deps.setCredentials !== undefined) {
    await deps.setCredentials(next, deps);
    return { generation: record.generation };
  }
  // FENCED to the generation this refresh was computed against. Belt as well as braces: the reread
  // above already abandons on a changed generation, and this makes a commit that somehow got past it
  // a refusal rather than an overwrite. With expectGeneration set, commitCredentials does not retry.
  const committed = await _commitCredentials(next, deps, {
    expectGeneration: record.generation,
    lock: deps.lock,
  });
  if (committed == null) return null;
  if (committed.status === CredentialStatus.CONFLICT) return { conflict: true };
  if (committed.status !== CredentialStatus.COMMITTED) return null;
  return committed;
}

// ── the public typed accessor

// The one auth accessor: never throws, never deletes credentials, and reports WHY when there is no
// token rather than collapsing every cause into "not linked".
export async function getAuthState(options = {}, deps = options) {
  const now = deps.now == null ? Date.now : deps.now;
  const cacheable = cacheableWith(deps);
  const scope = cacheable ? readControlSnapshot(deps) : null;

  if (!options.forceRefresh && cacheable && memo && memo.expiresAt > now()
    && memo.service === scope.service && memo.generation === scope.generation) {
    // setMachineClientId writes a module-global in machine-identity.mjs that the HTTP helpers read
    // back for the X-Beezi-Client header. A cache hit that skipped it would silently drop that
    // header on every request after the first, and the portal's linked-machines view would stop
    // being able to attribute them — a bug that shows up as missing data, never as an error.
    setMachineClientId(memo.clientId);
    return shape(AuthState.READY, AuthReason.NONE, { generation: scope.generation }, {
      token: memo.token,
      epoch: await authEpoch(deps),
    });
  }

  const record = await loadRecord(storeDeps(deps, options));
  if (record.status !== CredentialStatus.OK) {
    const mapped = STATUS_MAP[record.status];
    const pair = mapped == null ? [AuthState.UNAVAILABLE, AuthReason.UNREADABLE] : mapped;
    return shape(pair[0], pair[1], record, { epoch: await authEpoch(deps) });
  }

  const creds = record.creds;
  setMachineClientId(creds.client_id);

  // A dead grant for THIS generation. Reported, not acted on: the credential stays, and the user
  // signing in again replaces it.
  if (record.generation > 0 && reauthRequiredFor(record.generation, deps)) {
    return shape(AuthState.REAUTH_REQUIRED, AuthReason.INVALID_GRANT, record, { epoch: await authEpoch(deps) });
  }

  const fresh = (creds.expires_at == null ? 0 : creds.expires_at) - now() > SKEW_MS;
  if (!options.forceRefresh && fresh) {
    if (cacheable) {
      memo = {
        token: creds.access_token,
        clientId: creds.client_id,
        expiresAt: memoUntil(creds.expires_at, now()),
        service: scope.service,
        generation: scope.generation,
      };
    }
    return shape(AuthState.READY, AuthReason.NONE, record, {
      token: creds.access_token,
      epoch: await authEpoch(deps),
    });
  }

  // A refresh is due. Respect the backoff first: a failing provider must not be asked once per hook.
  if (record.generation > 0 && inBackoff(record.generation, { now })) {
    return shape(AuthState.READY, AuthReason.BACKOFF, record, {
      token: creds.access_token,
      epoch: await authEpoch(deps),
    });
  }

  const refreshed = await performRefresh(record, deps, options);
  if (cacheable && refreshed.state === AuthState.READY && refreshed.reason === AuthReason.NONE && refreshed.token) {
    const after = readControlSnapshot(deps);
    memo = {
      token: refreshed.token,
      clientId: creds.client_id,
      expiresAt: memoUntil(now() + DEFAULT_EXPIRES_IN_S * 1000, now()),
      service: after.service,
      generation: after.generation,
    };
  }
  return refreshed;
}

// Refresh now, whatever the clock says. `options.forceRefresh` exists because expires_at is only
// ever this client's estimate — the access token is opaque — so a 401 from the API is better
// evidence of expiry than our own clock.
export async function forceRefresh(options = {}, deps = options) {
  invalidateTokenCache();
  const record = await loadRecord(storeDeps(deps, options));
  if (record.status !== CredentialStatus.OK) {
    const mapped = STATUS_MAP[record.status];
    const pair = mapped == null ? [AuthState.UNAVAILABLE, AuthReason.UNREADABLE] : mapped;
    return {
      ok: false,
      token: null,
      state: pair[0],
      reason: pair[1],
      epoch: await authEpoch(deps),
      generation: record.generation,
    };
  }
  setMachineClientId(record.creds.client_id);
  const result = await performRefresh(record, deps, options);
  return {
    ok: result.state === AuthState.READY && result.reason === AuthReason.NONE && !!result.token,
    token: result.token,
    state: result.state,
    reason: result.reason,
    epoch: result.epoch,
    generation: result.generation,
  };
}

// ── compatibility adapter

// The bare-token accessor every existing caller imports. Returns a bearer-ready access token, or
// null when there is not one to offer — a caller that needs to know WHY (and every caller that
// might otherwise act destructively on a null) uses getAuthState instead.
export async function getAccessToken(deps = {}, options = {}) {
  // The two bags stay in their own positions. Merging them worked by accident — `options` happened
  // to be spread first — but it put store seams in the options slot, which is the slot
  // `forceRefresh` and `deadlineMs` live in, and the next option named like a dep would have been
  // read from the wrong object.
  const state = await getAuthState(options, deps);
  return state.token == null ? null : state.token;
}

// Kept so callers that only ever needed the old names keep compiling; they are the same functions
// the store exports.
export { _getCredentials as getCredentials, _setCredentials as setCredentials, _deleteCredentials as deleteCredentials };
