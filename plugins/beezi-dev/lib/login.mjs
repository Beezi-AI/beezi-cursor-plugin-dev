import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { apiBase, OAUTH_SCOPES } from './config.mjs';
import { UserError } from './friendly-error.mjs';
import { auditLedgerFile } from './paths-cursor.mjs';
import { removeSync } from './fs-compat.mjs';
import { base64url } from './base64url.mjs';
import { discover, registerClient, pkcePair, exchangeCode } from './oauth.mjs';
import { getCredentials, setCredentials } from './credentials.mjs';
import { startLoopback } from './loopback.mjs';
import { setMachineClientId } from './machine-identity.mjs';
import {
  clearTrackingState,
  markLinked,
  recordWhoami,
  readTrackingState,
  currentAccountKey,
} from './tracking.mjs';
import { whoami } from './whoami.mjs';
import { linkStatus, LinkState } from './link-status.mjs';
import { ensureInstalled } from './plugin-install.mjs';
import { runLoginPreflight, describePreflightBlock } from './login-preflight.mjs';
// Through the facade, which is the only door CONTRACTS §8 opens (lib/telemetry.mjs). Binding is
// consent-gated on the far side: with correlation off — the default — it is a single small file
// read that answers `no-consent` before any network call, so an opted-out machine pays nothing.
import { bindInstallation } from './telemetry.mjs';

// The browser PKCE flow that links this machine. It lives in lib because two very different
// callers need it: the CLI script, which prints as it goes, and the MCP bridge's `beezi_login`
// tool, whose process owns stdout for JSON-RPC and must not print a single byte. Hence `onStep`
// rather than console.log — the default is silence, and only the CLI opts into output.

// Non-blocking, but *observed*. It stays async — this used to be execFileSync, which is harmless
// in a CLI but blocks the event loop of the MCP server that now also signs in; cold PowerShell
// costs several hundred ms, during which readline stops draining stdin and the loopback listener
// cannot accept the very callback we are waiting for. It is no longer detached-and-forgotten
// though: a launcher that fails is the difference between "a tab opened" and a user staring at a
// spinner, and under a sandboxed shell (Cursor sandboxes what it runs) or a machine with no http
// association, failing silently leaves nothing to go on. Resolves { ok } | { ok: false, detail }.
function launch(file, args, env, { timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stderr piped, not ignored: ShellExecute failures ("No application is associated with the
      // specified file for this operation") are reported by the launcher, not by the spawn.
      child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    } catch (error) {
      resolve({ ok: false, detail: error == null || error.message == null ? String(error) : error.message });
      return;
    }
    let stderr = '';
    if (child.stderr != null) child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 500); });
    let done = false;
    // Settle once, then stop holding the event loop open on the launcher's account — the caller is
    // about to wait on the loopback callback, which may take minutes. Listeners are left attached
    // rather than stripped: removeAllListeners would also drop the ones Node uses to tear down the
    // child's stdio.
    const settle = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof child.unref === 'function') child.unref();
      resolve(result);
    };
    // The launcher only asks the OS to open a URL, so it should exit immediately. If it does not,
    // treat the launch as unobserved rather than waiting: the caller has already shown the URL.
    const timer = setTimeout(() => settle({ ok: true }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (error) => settle({
      ok: false,
      detail: error == null || error.message == null ? String(error) : error.message,
    }));
    child.on('exit', (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() || `launcher exited ${code}` }));
  });
}

const LAUNCH_TIMEOUT_MS = 5000;

// Ask the OS to open `url` in the user's browser. Resolves { ok } | { ok: false, detail } — never
// rejects, and never throws: the caller has the URL and can always fall back to showing it.
export async function openBrowser(url) {
  // The URL comes from the server response — never pass it through a shell. Require a
  // plain http(s) URL and hand it to the launcher as a single argv element (no shell,
  // no interpolation), so it cannot smuggle command-line metacharacters.
  if (!/^https?:\/\//i.test(url)) return { ok: false, detail: 'refusing to open a non-http(s) URL' };
  try {
    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      // Start-Process uses ShellExecute → the default browser's http(s) association, and
      // handles query strings (?code=…&…) correctly. explorer.exe mis-parses such URLs and
      // can pop a File Explorer / search window instead of the browser. Absolute PowerShell
      // path avoids resolving a bare name against the current directory; the URL is passed
      // as an env var, never spliced into the command text, so it can't be run as script.
      const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return await launch(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:BEEZI_LOGIN_URL'],
        { ...process.env, BEEZI_LOGIN_URL: url },
      );
    }
    if (process.platform === 'darwin') return await launch('/usr/bin/open', [url], process.env);
    return await launch('xdg-open', [url], process.env);
  } catch (error) {
    return { ok: false, detail: error == null || error.message == null ? String(error) : error.message };
  }
}

// Bind the loopback listener, reusing this machine's registered client when its
// callback port is free; otherwise register a fresh client on a new port. Clerk
// matches redirect URIs exactly (port included), so client_id and redirect_uri
// always travel together.
async function bindClient(meta, existing, state, deps) {
  if (existing != null && existing.client_id && existing.redirect_uri) {
    const port = Number(new URL(existing.redirect_uri).port);
    try {
      const lb = await deps.startLoopback({ port, expectedState: state });
      return { ...lb, clientId: existing.client_id };
    } catch {
      // Port taken by another process — fall through to a fresh registration.
    }
  }
  const lb = await deps.startLoopback({ port: 0, expectedState: state });
  try {
    const clientId = await deps.registerClient(meta.registrationEndpoint, lb.redirectUri);
    return { ...lb, clientId };
  } catch (error) {
    // The listener is already bound; abandoning it here would hold the port and leave `code`
    // pending until it rejects into nothing — fatal in the MCP server, which lives for the session.
    if (typeof lb.cancel === 'function') lb.cancel();
    throw error;
  }
}

// Report a step that failed, without letting the reporting change anything.
//
// CONTRACTS §8: the recorder is INJECTED and a no-op by default, so a machine with diagnostics
// switched off runs exactly the code a machine with them on runs, minus the callback. It is given a
// structured `reason` and nothing else — never the error, which can carry a URL or a server
// message. The error itself is rethrown untouched.
async function recordingFailure(recordIssue, reason, fn) {
  try {
    return await fn();
  } catch (error) {
    // A refusal that carries its own code reports that code instead of the step name: "the provider
    // issued no refresh token" and "the token exchange 500'd" are the same step and different
    // problems, and only one of them is worth waking somebody up for.
    const code = error != null && typeof error.code === 'string' ? error.code : null;
    try { recordIssue('login_failed', { reason: code == null ? reason : code }); } catch { /* never fails a login */ }
    throw error;
  }
}

// Linking a machine is only half of "analytics now work" — the other half is a hook registry that
// reports. `~/.cursor/hooks.json` is written by ensureInstalled, and until this call it ran from one
// place only: the MCP server's startup, inside the IDE. A user who linked from `cursor-agent`, or
// from the CLI script, therefore had to go and open Cursor before a single session was recorded, and
// nothing anywhere told them so.
//
// Called on the already-linked path too, deliberately. That is not a redundant case — it is the
// commonest reason someone runs sign-in a second time: they are linked, nothing is arriving, and
// they are re-running login to fix it. Doing the repair is a better answer than reporting the link
// they already had. Best-effort and cheap either way (the shim is only rewritten when its content
// changed, and an already-installed registry short-circuits), and a machine that cannot repair
// itself must still be able to finish signing in.
// B1: reassert the diagnostic installation binding, with a token the flow ALREADY holds.
//
// This is the only production call site, and there is no other moment that has one: the identity
// module deliberately imports nothing from lib/token.mjs, so it can never refresh OAuth merely to
// send diagnostics — a machine that cannot authenticate right now simply stays unbound and keeps
// recording anonymously. Signing in is when a token is on the table, which makes login the seam.
//
// Until this existed, `boundAt` was never written on any real machine. `currentInstallationId()`
// therefore always answered null, the `correlate` setting changed nothing observable, and the
// README's claim that the id "is bound to the last Beezi account linked here" described code with
// no caller.
//
// Wrapped whole and awaited but never consequential: a sign-in that has already stored credentials
// and opened a browser must not be reported as failed, or delayed past its own budget, because an
// OPTIONAL diagnostics binding did not answer. postJson bounds it at 3s on the far side.
async function bindDiagnostics(d, token) {
  if (typeof token !== 'string' || token === '') return;
  try {
    await d.bindInstallation({ token });
  } catch { /* diagnostics may never change an authentication outcome */ }
}

function ensureReporting(d) {
  try { d.ensureInstalled(); } catch { /* best-effort */ }
}

// Link this machine, or report that it already is.
//
// `onStep` receives progress events instead of them being printed: `{ type: 'already-linked',
// account }`, `{ type: 'authorize-url', url }`, `{ type: 'linked', account, storedIn }`. Returns
// the same shape as the terminal event, so a caller that ignores onStep still learns the outcome.
export async function performLogin({ onStep = () => {}, deps = {} } = {}) {
  const d = {
    discover, registerClient, exchangeCode, startLoopback, whoami, linkStatus,
    getCredentials, setCredentials, openBrowser, pkcePair,
    ensureInstalled, runLoginPreflight, bindInstallation,
    ...deps,
  };
  const base = apiBase();
  const recordIssue = typeof deps.recordIssue === 'function' ? deps.recordIssue : () => {};

  // The stored client is still needed for `bindClient` (its redirect port), but whether the
  // machine counts as linked is decided by linkStatus — the same check `me.mjs` and the status
  // tool use, and refresh-aware. Asking the raw credentials here is what let this report
  // "already linked" while a script reported the opposite in the same minute.
  let existing = await d.getCredentials().catch(() => null);
  if (existing) {
    setMachineClientId(existing.client_id);
    const status = await d.linkStatus();
    if (status.state === LinkState.LINKED) {
      ensureReporting(d);
      // The already-linked branch binds too. It is not a redundant case: a machine that signed in
      // once and never again would otherwise never reassert inside the seven-day rebind window,
      // and re-running the login skill is the likeliest moment a user hands this flow a token.
      await bindDiagnostics(d, existing.access_token);
      // The login flow continues into plan capture and the history backfill even when already
      // linked — refresh the cached tracking policy so those steps act on current state.
      try { recordWhoami(status.who, existing.client_id); } catch { /* best-effort */ }
      const result = { type: 'already-linked', account: status.account, apiBase: status.apiBase };
      onStep(result);
      return result;
    }
    // 403: authenticated, and not entitled. link-status has to call that REVOKED (its states are a
    // shared contract), but the raw verdict says which refusal it was — and relinking cannot grant a
    // seat, so starting an OAuth round-trip here would spend the user's time to arrive at the same
    // 403. Stop, and leave the authorization exactly where it is.
    if (status.who != null && status.who.forbidden === true) {
      const refused = { type: 'forbidden', account: status.account, apiBase: status.apiBase };
      onStep(refused);
      return refused;
    }
    if (status.state === LinkState.REVOKED || status.state === LinkState.NOT_LINKED) {
      // The portal rejected the token, or refreshing it hit invalid_grant. Either way the OAuth
      // client registered with that grant is gone, so reusing `existing.client_id` would fail the
      // authorize request with invalid_client — the stale object has to be dropped.
      //
      // Dropped, NOT deleted. This used to erase the credential store here, which meant a sign-in
      // that then failed anywhere downstream (discovery, a closed browser, a token exchange) left
      // the machine with nothing, having started with a link that might well have recovered on its
      // own. Replacement is the successful commit at the end of this function; until it happens the
      // previous authorization stands.
      existing = null;
    }
    // UNREACHABLE → the credentials may be perfectly good; keep the client and reuse its port.
  }

  // Before anything costs the user a browser round-trip: can this machine actually keep what the
  // sign-in is about to produce, and is it installed to report? A thin script cannot be the only
  // guard — the MCP `beezi_login` tool reaches this function directly — so the check lives here,
  // where both entry points share it.
  const preflight = await d.runLoginPreflight({ deps });
  if (!preflight.ok) {
    // No browser, no bound port, no discovery traffic, and nothing written: a sign-in that cannot
    // be persisted is better refused than half-completed.
    try { recordIssue('login_failed', { reason: 'preflight' }); } catch { /* never fails a login */ }
    throw new UserError(describePreflightBlock(preflight.blocking));
  }

  const meta = await recordingFailure(recordIssue, 'discovery', () => d.discover());
  const { verifier, challenge } = d.pkcePair();
  const state = base64url(crypto.randomBytes(16));
  const { redirectUri, clientId, code } = await recordingFailure(
    recordIssue,
    'client_registration',
    () => bindClient(meta, existing, state, d),
  );

  const authorizeUrl = `${meta.authorizationEndpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  // Emitted before the browser opens so a caller can show the URL even if the launcher fails.
  onStep({ type: 'authorize-url', url: authorizeUrl });
  // Awaited so a failed launch is reported rather than swallowed. The loopback listener is already
  // bound, so a callback arriving during this window is still captured.
  const launched = await d.openBrowser(authorizeUrl);
  if (launched == null || !launched.ok) {
    const detail = launched == null || launched.detail == null ? null : launched.detail;
    onStep({ type: 'browser-failed', url: authorizeUrl, detail });
  }

  // blocks until the callback or timeout
  const authCode = await recordingFailure(recordIssue, 'browser_callback', () => code);

  const tokens = await recordingFailure(recordIssue, 'token_exchange', () => d.exchangeCode({
    tokenEndpoint: meta.tokenEndpoint,
    clientId,
    redirectUri,
    code: authCode,
    verifier,
  }));

  // A fresh grant does not depend on whatever it replaces: the user has just signed in, and that
  // intent is valid however the store moved while the browser round-trip was happening. This is the
  // one caller that rebases on a conflict; refresh and logout abandon.
  const storedIn = await recordingFailure(recordIssue, 'credential_store', () => d.setCredentials({
    client_id: clientId,
    redirect_uri: redirectUri,
    token_endpoint: meta.tokenEndpoint,
    // Captured at sign-in so logout never has to guess it, and never has to pay for a second
    // discovery round-trip while the user waits. `null` when the provider publishes none, which
    // logout reports as an UNCONFIRMED revocation rather than inventing `${token_endpoint}/revoke`.
    revocation_endpoint: meta.revocationEndpoint == null ? null : meta.revocationEndpoint,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in == null ? 86_400 : tokens.expires_in) * 1000,
  }));
  setMachineClientId(clientId);
  // A fresh login is a fresh client id, but not necessarily a fresh ACCOUNT — and the pull is
  // per (tenant, user, tool). Hold the previous account before wiping the cache so the whoami
  // below can tell a same-account re-login (keep the link instant and the ledger, or everything
  // live-tracked since the original link double-bills) from a workspace switch (fresh cutoff, so
  // the new tenant loads this machine's history; a foreign ledger replayed here would seal the
  // new tenant's pull empty).
  const previousTracking = readTrackingState();
  clearTrackingState();
  // Stamp the link instant before anything can be tracked under it: the backfill skips sidecars
  // touched after this, which is what stops it re-segmenting sessions live tracking already sent.
  markLinked();

  const who = await d.whoami(tokens.access_token, { base }).catch(() => null);
  // Is this the same account signing in again? Both sides go through currentAccountKey, and
  // neither reads the cache we just wiped: the previous key comes from the state held above, the
  // new one from `who` alone (`tracking: null` — the default would re-read the file). A whoami that
  // did not answer, or answered invalid, yields null and so reads as a SWITCH, which is the
  // conservative side and exactly what the explicit valid-check here used to spell out.
  const previousAccount = currentAccountKey({ tracking: previousTracking });
  const sameAccount =
    previousAccount != null && previousAccount === currentAccountKey({ who, tracking: null });
  if (who && who.valid) {
    // One write, not a wipe-then-restore pair: on a same-account re-login the ORIGINAL link instant
    // rides along in the very patch that records the verdict, so the cache is never left holding
    // the fresh markLinked() stamp. recordWhoami refuses an absent or empty instant, so a first-ever
    // login can pass what it has.
    const linkedAt = sameAccount ? (previousTracking == null ? undefined : previousTracking.linkedAt) : null;
    try { recordWhoami(who, clientId, { linkedAt }); } catch { /* best-effort */ }
  }
  if (!sameAccount) {
    // Different account — or nobody answered (offline whoami reads as a switch, the conservative
    // side: a discarded ledger costs a re-parse, an inherited foreign one costs the new pull).
    try { removeSync(auditLedgerFile(), { force: true }); } catch { /* best-effort */ }
  }
  // The last thing a successful sign-in does, so the machine leaves this function able to REPORT and
  // not merely authenticated. See ensureReporting.
  ensureReporting(d);
  await bindDiagnostics(d, tokens.access_token);
  // apiBase travels with every outcome, not just the already-linked one: a machine signed in
  // against the wrong BEEZI_API_URL is exactly the case this field exists to make visible.
  const account = who == null ? null : (who.name || who.email || null);
  // The authentication succeeded. Anything the preflight could not fix travels WITH that success
  // rather than replacing it: a machine that is linked but not yet reporting has completed the hard
  // half, and telling the user it failed would send them through OAuth again for no reason.
  const result = {
    type: 'linked',
    account,
    storedIn,
    apiBase: base,
    setup: { warnings: preflight.warnings, hooks: preflight.hooks },
  };
  onStep(result);
  return result;
}
