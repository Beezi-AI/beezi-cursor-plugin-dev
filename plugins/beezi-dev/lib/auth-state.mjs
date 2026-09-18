// The typed vocabulary every consumer of this plugin's auth shares (CONTRACTS §2).
//
// It exists because `string | null` is not enough to describe what happened. A bare null meant all
// of: nobody has ever signed in, the keyring did not answer in time, a refresh is in flight in
// another process, the tenant revoked this machine's seat, and the portal refused the request on
// entitlement grounds. Consumers picked the most convenient reading — "not linked" — and one of
// them (the session-start hook) acted on it by DELETING the credential, so an entitlement refusal
// destroyed a working link and then advised a relink that could not restore the seat.
//
// Pure constants and shapes. Nothing here reads the store, the network or the clock, so every lane
// can import it without inheriting a dependency on auth internals.

export const AuthState = Object.freeze({
  // A usable access token is in hand.
  READY: 'ready',
  // No credential exists for this namespace. The only state that justifies offering a sign-in.
  UNLINKED: 'unlinked',
  // Another process holds the mutation lock, or a refresh is in flight. Try again shortly.
  REFRESHING: 'refreshing',
  // The store or the provider could not answer. Says nothing about whether the machine is linked.
  UNAVAILABLE: 'unavailable',
  // The provider confirmed the grant is dead. The credential is RETAINED; the user must sign in
  // again, and the sign-in is what replaces it.
  REAUTH_REQUIRED: 'reauth_required',
  // The portal answered 403: authenticated, but not entitled. Credentials are retained — relinking
  // cannot grant a seat, so destroying them only loses a link that may come back.
  FORBIDDEN: 'forbidden',
});

export const AuthReason = Object.freeze({
  NONE: 'none',
  MISSING: 'missing',
  TIMEOUT: 'timeout',
  UNREADABLE: 'unreadable',
  CORRUPT: 'corrupt',
  CONFLICT: 'conflict',
  LOCKED: 'locked',
  INVALID_GRANT: 'invalid_grant',
  BACKOFF: 'backoff',
  TRANSPORT: 'transport',
  HTTP_5XX: 'http_5xx',
});

// The shape every producer of an auth state returns:
// { state, reason, token: string|null, generation: number|null, epoch: string,
//   account: { tenantId?, userId?, email? } | null }
export function authStateShape(state, reason, over = {}) {
  return {
    state,
    reason,
    token: null,
    generation: null,
    epoch: '',
    account: null,
    ...over,
  };
}

// Does this state mean "offer to sign in"? Exactly one does. Everything else is either usable or a
// condition a sign-in cannot fix, and conflating them is how a transient store failure turned into
// a relink prompt.
export function isUnlinked(state) {
  return state != null && state.state === AuthState.UNLINKED;
}

// May a caller send an authenticated request with this state's token?
export function hasUsableToken(state) {
  return state != null && typeof state.token === 'string' && state.token !== '';
}

// One sentence per state, so the CLI, the MCP bridge and the skills cannot describe the same
// condition differently — and so none of them says "not linked" about a store that merely did not
// answer. Returns null for READY: there is nothing to explain when it works.
export function describeAuthState(state) {
  if (state == null) return null;
  switch (state.state) {
    case AuthState.UNLINKED:
      return 'This machine is not linked to Beezi. Sign in to link it.';
    case AuthState.REAUTH_REQUIRED:
      return 'The sign-in provider rejected this machine\u2019s stored grant, so a new sign-in is needed. '
        + 'The stored credential was kept — signing in replaces it.';
    case AuthState.FORBIDDEN:
      return 'This account is signed in but not permitted to use Beezi analytics here. '
        + 'Signing in again cannot change that — ask a Beezi administrator about access.';
    case AuthState.REFRESHING:
      return 'A token refresh is in progress in another Beezi process. Try again in a moment.';
    case AuthState.UNAVAILABLE:
      if (state.reason === AuthReason.CORRUPT) {
        return 'The stored credential is present but unusable — it may have been written by a newer '
          + 'version of this plugin, or a write was interrupted. This does NOT mean the machine is '
          + 'unlinked. Try `login.mjs --recover-legacy` to adopt a credential an older version left, '
          + 'or sign in again to replace the store.';
      }
      return `The stored credential could not be read (${state.reason}). `
        + 'This does NOT mean the machine is unlinked — try again, and check whether the OS credential store is unlocked.';
    default:
      return null;
  }
}
