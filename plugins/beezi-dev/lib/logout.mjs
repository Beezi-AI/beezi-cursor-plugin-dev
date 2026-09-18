import { apiBase, ENDPOINTS } from './config.mjs';
import { auditLedgerFile } from './paths-cursor.mjs';
import { removeSync } from './fs-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { machineHeaders, setMachineClientId } from './machine-identity.mjs';
import { withCredentialLock } from './credential-lock.mjs';
import {
  CredentialStatus,
  deleteCredentialRecord as _deleteCredentialRecord,
  readCredentialRecord as _readCredentialRecord,
} from './credentials.mjs';
import { getAuthState as _getAuthState } from './token.mjs';
import { AuthState } from './auth-state.mjs';
import { clearAuthMarkers } from './auth-markers.mjs';
import { revokeToken as _revokeToken } from './oauth.mjs';
import { clearTrackingState } from './tracking.mjs';

// Signing out, reported as what actually happened.
//
// The script this replaces claimed success on a 401 or a 403 from the unlink — statuses that say
// the token was not accepted, not that the server removed the machine's row — and it swallowed
// deletion failures entirely, so "Logged out" could mean "the token is still in your keychain and
// the grant is still live". It also read the credential BEFORE `getAccessToken()` could rotate it,
// then revoked the stale copy.
//
// Four independent facts, reported separately, because they genuinely are independent:
//   local   — was the credential deleted, and was that deletion VERIFIED
//   remote  — what the portal's unlink endpoint said
//   revoke  — what the authorization server's revocation endpoint said, if it has one
//   exitCode — 0 only when the local deletion is confirmed; the local half is the only part this
//              machine controls, and it is the only part a success claim may rest on.

// Bounded: a logout must finish whether or not the network does, and it holds the credential lock
// while it runs, so an unbounded request here would block a concurrent login for as long as a
// server cared to stall.
export const LOGOUT_TIMEOUT_MS = 5000;

async function boundedFetch(fetchImpl, url, init, timeoutMs) {
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (timer != null && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    return { res, timedOut: false };
  } catch {
    return { res: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// Ask the portal to unlink this machine: drops its row and deletes its registered OAuth client.
//
// 401/403 is REFUSED, not confirmed. That is AUTH-01: those statuses are the server declining to
// act on this token, and reporting them as a completed unlink told users a grant had been destroyed
// while it was still live in the portal.
async function unlinkOnServer(token, base, fetchImpl, timeoutMs) {
  const { res } = await boundedFetch(fetchImpl, `${base}${ENDPOINTS.machine}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, ...machineHeaders() },
  }, timeoutMs);
  if (res == null) return { status: 'unreachable' };
  const httpStatus = res.status == null ? null : res.status;
  if (res.ok === true) return { status: 'confirmed', httpStatus };
  if (httpStatus != null && httpStatus >= 500) return { status: 'unconfirmed', httpStatus };
  return { status: 'refused', httpStatus };
}

function clearAccountState(deps) {
  // Tenant policy and the one-time-import ledger are ACCOUNT state: leaving them behind lets one
  // account's tracking mode and import history apply to the next account that signs in here.
  try { clearTrackingState(); } catch { /* best-effort */ }
  try { removeSync(auditLedgerFile(), { force: true }); } catch { /* best-effort */ }
  try { clearAuthMarkers(deps); } catch { /* best-effort */ }
  // The queue is deliberately NOT touched. It holds analytics the user's machine recorded and has
  // not yet delivered; deleting it as incidental logout cleanup destroys their data. Queue
  // ownership and retention are module 05/08 policy.
}

// Sign this machine out. Never throws.
export async function performLogout(deps = {}) {
  const readRecord = deps.getCredentialRecord == null ? _readCredentialRecord : deps.getCredentialRecord;
  const getAuthState = deps.getAuthState == null ? _getAuthState : deps.getAuthState;
  const deleteRecord = deps.deleteCredentialRecord == null ? _deleteCredentialRecord : deps.deleteCredentialRecord;
  const revoke = deps.revokeToken == null ? _revokeToken : deps.revokeToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const base = deps.base == null ? apiBase() : deps.base;
  const timeoutMs = deps.timeoutMs == null ? LOGOUT_TIMEOUT_MS : deps.timeoutMs;
  // CONTRACTS §8: injected, no-op by default, and never able to change the outcome or the budget.
  const recordIssue = typeof deps.recordIssue === 'function' ? deps.recordIssue : () => {};
  const onInstallationRotate = typeof deps.onInstallationRotate === 'function' ? deps.onInstallationRotate : () => {};

  const before = await readRecord(deps);
  if (before.status === CredentialStatus.MISSING) {
    // Nothing to unlink. Sending a request on behalf of a machine that is not linked would at best
    // 401 and at worst unlink somebody else's row under a token we should not have.
    clearAccountState(deps);
    return {
      local: { deleted: false, verified: true },
      remote: { status: 'unconfirmed' },
      revoke: { status: 'unavailable' },
      alreadyUnlinked: true,
      exitCode: 0,
    };
  }
  if (before.status !== CredentialStatus.OK) {
    // The store did not answer. "Not linked" is the one reading that is certainly wrong, and
    // deleting on the strength of it would be deleting something we cannot see.
    return {
      local: { deleted: false, verified: false, error: before.status },
      remote: { status: 'unconfirmed' },
      revoke: { status: 'unavailable' },
      exitCode: 1,
    };
  }

  // Refresh BEFORE taking the logout lease. A token that has aged out would be refused by the
  // unlink endpoint, and refreshing inside the lease would mean the lease's own critical section
  // performing a commit.
  const auth = await getAuthState(deps, deps);
  if (auth.state === AuthState.READY && auth.token) setMachineClientId(before.creds.client_id);

  return withCredentialLock(async (handle) => {
    // Everything inside the lease goes THROUGH the lease, so the nested store calls re-enter this
    // critical section rather than queueing behind a lock this function is holding.
    const leased = { ...deps, lock: handle };
    // Reread under the lease: the refresh above may have rotated the token, and the credential that
    // gets revoked and deleted has to be the one that is actually stored right now.
    const current = await readRecord(leased);
    const creds = current.status === CredentialStatus.OK ? current.creds : before.creds;
    const generation = current.status === CredentialStatus.OK ? current.generation : before.generation;
    const token = current.status === CredentialStatus.OK ? creds.access_token : null;

    const remote = token
      ? await unlinkOnServer(token, base, fetchImpl, timeoutMs)
      : { status: 'unconfirmed' };
    if (remote.status !== 'confirmed') {
      recordIssue('logout_unlink_unconfirmed', {
        status: remote.status,
        httpStatus: remote.httpStatus == null ? null : remote.httpStatus,
      });
    }

    // A confirmed unlink deletes the registered OAuth client, which kills the grant — a second
    // revocation would be a redundant round-trip while the user waits. Otherwise fall back to the
    // authorization server, using the endpoint DISCOVERY published and stored with the credential.
    const revocation = remote.status === 'confirmed'
      ? { status: 'unavailable' }
      : await revoke({
        revocationEndpoint: creds.revocation_endpoint,
        clientId: creds.client_id,
        token: creds.refresh_token == null ? creds.access_token : creds.refresh_token,
        tokenTypeHint: creds.refresh_token ? 'refresh_token' : 'access_token',
      }, { fetchImpl, timeoutMs });

    if (!handle.verify()) {
      // The lease was reclaimed underneath us. Whatever is in the store now belongs to whoever won
      // it, and deleting it would take a link this logout never observed.
      return {
        local: { deleted: false, verified: false, error: 'conflict' },
        remote,
        revoke: revocation,
        exitCode: 1,
      };
    }

    // Fenced to the generation this logout actually observed. A sign-in that landed in between
    // committed a newer one, and that link must survive.
    const deletion = await deleteRecord(leased, { expectGeneration: generation, lock: handle });
    const local = {
      deleted: deletion.deleted === true,
      verified: deletion.status === CredentialStatus.OK,
    };
    if (!local.verified) {
      local.error = deletion.status === CredentialStatus.CONFLICT ? 'conflict' : deletion.status;
    }

    if (local.verified) {
      clearAccountState(deps);
      // TEL-04: the installation identity is bound to an account, so signing out rotates it. A
      // no-op until the telemetry lane wires a real callback.
      try { onInstallationRotate('logout'); } catch { /* optional telemetry may never change auth */ }
    }

    return { local, remote, revoke: revocation, exitCode: local.verified ? 0 : 1 };
  }, { waitMs: deps.lockWaitMs == null ? 8000 : deps.lockWaitMs, kill: deps.kill, sleep: deps.sleep })
    .then((result) => (result != null && result.ok === false
      ? {
        local: { deleted: false, verified: false, error: 'locked' },
        remote: { status: 'unconfirmed' },
        revoke: { status: 'unavailable' },
        exitCode: 1,
      }
      : result));
}

// One phrasing of each outcome, so the script and the skill cannot describe the same result
// differently. Returns the lines to print, in order.
export function describeLogout(result) {
  const lines = [];
  if (result.alreadyUnlinked === true) {
    lines.push('Beezi: this machine is not linked. Nothing to do.');
    return lines;
  }

  if (!result.local.verified) {
    if (result.local.error === 'conflict') {
      lines.push('✗ Not logged out: this machine was signed in again while the sign-out was running.');
      lines.push('  The newer sign-in was left alone. Run the sign-out again if you still want it removed.');
      return lines;
    }
    if (result.local.error === 'locked') {
      lines.push('✗ Not logged out: another Beezi process is changing the credentials right now.');
      lines.push('  Wait a few seconds and run the sign-out again.');
      return lines;
    }
    lines.push('✗ Not logged out: the stored credential could not be removed from this machine.');
    lines.push(`  The credential store reported "${result.local.error}", so this machine may still report analytics.`);
    lines.push('  Try again; if it keeps failing, remove the Beezi entry from your OS credential store by hand.');
    if (result.remote.status === 'confirmed') {
      lines.push('  The portal did unlink this machine, so the token it holds is no longer accepted.');
    }
    return lines;
  }

  lines.push('✓ Logged out. The credential was removed from this machine.');
  switch (result.remote.status) {
    case 'confirmed':
      lines.push('  The portal confirmed this machine is unlinked.');
      break;
    case 'refused':
      lines.push(`  The portal refused the unlink (HTTP ${result.remote.httpStatus}), so it may still list this machine.`);
      lines.push('  Remove it from the Connections tab there.');
      break;
    case 'unreachable':
      lines.push('  Could not reach the server, so it may still list this machine.');
      lines.push('  Remove it from the Connections tab there.');
      break;
    default:
      lines.push('  The server did not confirm the unlink, so it may still list this machine.');
      lines.push('  Remove it from the Connections tab there.');
  }
  if (result.revoke.status === 'confirmed') {
    lines.push('  Access was revoked at the sign-in provider.');
  } else if (result.revoke.status === 'unconfirmed') {
    lines.push('  Revocation at the sign-in provider was not confirmed.');
  }
  return lines;
}
