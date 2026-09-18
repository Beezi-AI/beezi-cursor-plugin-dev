import { apiBase } from './config.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { HookScope, hooksStatus as _hooksStatus, installCommand, RELOAD_STEP } from './hooks-install.mjs';
import { pluginHooksAlive as _pluginHooksAlive, readHookSource as _readHookSource } from './hook-source.mjs';

// One answer to "is this machine linked, and is it reporting?".
//
// It exists because there used to be three. `performLogin` asked getCredentials() (raw read, no
// refresh), me.mjs asked getAccessToken() (refresh-aware, wipes on invalid_grant), and each phrased
// the outcome differently — so the MCP tool could say "already linked" in the same minute a script
// said "not linked". Worse, the two run in different environments: the MCP server is spawned by
// Cursor and inherits BEEZI_API_URL, while a script the model runs through the shell tool may not,
// leaving them pointed at different APIs with the same credentials. Every answer therefore carries
// the `apiBase` it was computed against, so a disagreement is visible instead of baffling.

export const LinkState = Object.freeze({
  LINKED: 'linked',
  NOT_LINKED: 'not_linked',
  REVOKED: 'revoked',
  UNREACHABLE: 'unreachable',
});

// { state, account, apiBase, hooks } — `hooks` is the analytics-reporting half of the answer,
// because "linked" alone never explains why no analytics are arriving. It carries BOTH registries,
// `{ bundled: boolean, user: { state, registered } }`, because they cover different hosts and a
// single verdict cannot describe a machine whose IDE reports and whose CLI does not. See hooks().
export async function linkStatus(deps = {}) {
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const whoami = deps.whoami == null ? _whoami : deps.whoami;
  const base = deps.apiBase == null ? apiBase() : deps.apiBase;

  const token = await getAccessToken().catch(() => null);
  if (!token) return { state: LinkState.NOT_LINKED, account: null, apiBase: base, hooks: hooks(deps) };

  const who = await whoami(token, { base });
  if (who === null) return { state: LinkState.UNREACHABLE, account: null, apiBase: base, hooks: hooks(deps) };
  if (!who.valid) return { state: LinkState.REVOKED, account: null, apiBase: base, hooks: hooks(deps) };

  return {
    state: LinkState.LINKED,
    account: who.name || who.email || null,
    apiBase: base,
    hooks: hooks(deps),
    // The raw whoami verdict, carried so callers that need the tenant's tracking policy
    // (performLogin records it; me.mjs prints it) do not have to make a second identical
    // request. Additive — nothing keys on its presence.
    who,
  };
}

// Both registries, reported independently: `{ bundled, user }`. Never let a hook-registry read break
// a link check — the two are independent failures.
//
// This used to SHORT-CIRCUIT. If the bundled registry had been seen firing it returned
// `plugin-hooks` and never looked at the user scope at all, and describeReporting then told the user
// that nothing needed installing. That was right under the old design, where the self-installer
// deleted its own fallback entries once a bundled hook fired — judging by the registry alone told
// those users "run install" while analytics were flowing, and following the advice re-added entries
// the next session would strip again.
//
// It is actively harmful now, on exactly the machines that need the answer. The Cursor CLI does not
// run hooks that come from an installed plugin, marketplace or local; only `~/.cursor/hooks.json`
// and `<project>/.cursor/hooks.json` fire under `cursor-agent` (Cursor staff, forum 163890, still
// open). The two registries are not substitutes — they cover different HOSTS. So a live bundled
// registry says nothing whatsoever about whether `cursor-agent` reports, and answering "nothing
// needs installing" on the strength of it hid a completely uncovered CLI behind a green tick. The
// self-installer no longer removes the user scope either (lib/plugin-install.mjs), so an `absent`
// one is no longer the correct state on ANY machine — it is a missing install every time.
function hooks(deps) {
  const read = deps.hooksStatus == null ? _hooksStatus : deps.hooksStatus;
  const readSource = deps.readHookSource == null ? _readHookSource : deps.readHookSource;
  const alive = deps.pluginHooksAlive == null ? _pluginHooksAlive : deps.pluginHooksAlive;

  // An unreadable probe reads as "not seen firing", which is the conservative direction: it points
  // at the registry that is ours to repair rather than vouching for one we cannot confirm.
  let bundled = false;
  try { bundled = alive({ probe: readSource() }); } catch { /* not seen */ }

  try {
    // Explicit even though it is now the default: this call reported `stale` for months because it
    // was implicit and the default was the legacy scope.
    const s = read({ scope: HookScope.USER });
    return { bundled, user: { state: s.state, registered: s.registered } };
  } catch {
    return { bundled, user: { state: 'unknown', registered: [] } };
  }
}

// The single phrasing of each outcome, so the MCP tool, the CLI script and the session banner
// cannot drift apart — and so none of them names a slash command Cursor does not have.
export function describeLink(status) {
  switch (status.state) {
    case LinkState.LINKED:
      return `This machine is linked to Beezi${status.account ? ` as ${status.account}` : ''} (API: ${status.apiBase}).`;
    case LinkState.REVOKED:
      return `This machine's Beezi link was revoked (API: ${status.apiBase}). Sign in again to re-link.`;
    case LinkState.UNREACHABLE:
      return `Could not reach Beezi at ${status.apiBase} to check the link. Check the connection, or BEEZI_API_URL if that address is wrong.`;
    default:
      return 'This machine is not linked to Beezi. Sign in to link it.';
  }
}

// Analytics need both halves: a link and installed hooks. Returns null when there is nothing to say.
export function describeReporting(status) {
  if (status.state === LinkState.NOT_LINKED) {
    return 'Analytics are NOT being reported — this machine is not linked.';
  }
  if (status.state === LinkState.REVOKED) {
    return 'Analytics are NOT being reported — this machine’s link was revoked.';
  }
  // Unreachable says nothing about the link itself: the credentials may be perfectly good and the
  // hooks may be reporting fine from a process that can see the API. Claiming "not linked" here is
  // what made a status check and the sign-in tool look like they disagreed.
  if (status.state === LinkState.UNREACHABLE) {
    return 'Could not verify the link, so whether analytics are reporting is unknown. Queued reports are retried automatically once the API is reachable.';
  }
  // Two registries, two hosts, and only one of them can be repaired. The bundled registry covers the
  // Cursor IDE and nothing else — `cursor-agent` does not run a plugin's hooks at all (Cursor staff,
  // forum 163890) — so the USER scope is what every line below leads with: it is the half that can
  // be wholly missing while the IDE looks perfectly healthy, and it is the half `install` fixes.
  // What the bundled one is doing is reported after it, never instead of it, so a green tick can
  // never again be read as "both hosts are covered".
  const { bundled, user } = status.hooks;
  const ide = bundled
    ? " The plugin's own bundled hooks are firing too, which covers the Cursor IDE."
    : " The plugin's own bundled hooks have not been seen firing here — normal on a machine that only uses the CLI.";

  switch (user.state) {
    case 'installed':
      return `Analytics hooks are installed in the user-scope registry, which is what covers \`cursor-agent\`.${ide} If nothing is arriving, ${RELOAD_STEP}.`;
    case 'absent':
      return `Analytics are NOT being reported for \`cursor-agent\`: the user-scope hooks are not installed, and that registry is the only one the Cursor CLI reads.${ide} Run ${installCommand()}, then ${RELOAD_STEP}.`;
    case 'stale':
      return `Analytics are NOT being reported for \`cursor-agent\`: the user-scope hooks point at an older plugin version.${ide} Run ${installCommand()}, then ${RELOAD_STEP}.`;
    case 'partial':
      return `Analytics may not be reported for \`cursor-agent\`: the user-scope hook install is incomplete.${ide} Run ${installCommand()}, then ${RELOAD_STEP}.`;
    default:
      return null;
  }
}
