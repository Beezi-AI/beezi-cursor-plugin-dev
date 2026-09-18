import os from 'os';
import path from 'path';
import { homeDigest } from './env-identity.mjs';

// Which keyring namespace this environment and this home own.
//
// The OS keyring is machine-global. The plugin's FILE store is per-home, so two `BEEZI_CURSOR_HOME`
// values already keep their queues and state apart — but before this module they shared one keyring
// service, and the generation slots inside it (`token.g1`, `token.g2`, …) are named by a counter
// each home keeps SEPARATELY in its own control record. Home B's second commit therefore retired
// `token.g1`, which was home A's live credential, and home A silently read as unlinked. A test
// store could do that to a production one.
//
// The discriminator is a digest of the canonical home path, per CONTRACTS §1. It has to be the
// digest and not the path itself: a Windows path contains `\`, `:` and spaces, none of which may
// appear in a Credential Manager target or be interpolated into the PowerShell literal the backend
// builds.
//
// The digest itself now comes FROM `lib/env-identity.mjs` (integration step 3, CR-2). It used to be
// a second, byte-identical copy of that formula, written here because env-identity did not exist
// yet — and the failure mode of the two drifting was silent and total: every machine linked under a
// custom home would read as unlinked. One implementation cannot drift from itself.
//
// What stays here is the ENVIRONMENT-BLIND half: `defaultKeyringService()` answers "which namespace
// does this HOME own", with no environment suffix, and `namespaceSuffix()` compares against it to
// name the control-record files. Keeping that comparison environment-blind is deliberate — it is
// what makes a production store's record files byte-identical before and after CR-2.

export const DEFAULT_SERVICE = 'beezi-cursor';

export { homeDigest };

// The home the user pointed us at, or null for the default one.
export function customHome(env = process.env) {
  const value = env.BEEZI_CURSOR_HOME;
  return value == null || value === '' ? null : value;
}

// Where this environment's data root lives when nobody has overridden it. Kept in step with
// `beeziCursorHome()` in lib/paths-cursor.mjs; the environment suffix on the directory name is
// env-identity's to add.
function defaultHome() {
  return path.join(os.homedir(), '.beezi-cursor');
}

// `beezi-cursor` for the default home — unsuffixed, so an upgrade reads the entry it already has —
// and `beezi-cursor-h<digest>` for any other.
//
// The EQUIVALENCE branch matters as much as the digest: `BEEZI_CURSOR_HOME` pointing AT the default
// home is the default home, and must resolve to the same unsuffixed name as leaving the variable
// unset. env-identity has this branch; without it here, a machine that sets the variable to its own
// default would have its keyring entry, control records and markers file all rename at once the
// moment the two implementations met, and the link would silently disappear.
export function defaultKeyringService(env = process.env) {
  const home = customHome(env);
  if (home === null) return DEFAULT_SERVICE;
  return homeDigest(home) === homeDigest(defaultHome())
    ? DEFAULT_SERVICE
    : `${DEFAULT_SERVICE}-h${homeDigest(home)}`;
}

// A filename component for a namespace: the namespace this home owns stays unsuffixed.
//
// Once env-identity supplies environment suffixes, `defaultKeyringService()` here still returns the
// UNSUFFIXED production name, so a dev variant in its own default home would get
// `credential-store.beezi-cursor-dev.json` rather than the unsuffixed name it will want. That is
// harmless — the name only has to be stable and unique per namespace, and each variant has its own
// data root anyway — but integration should pass the environment through if it wants the tidier
// spelling. Recorded in the handoff rather than guessed at here.
export function namespaceSuffix(service, env = process.env) {
  if (service === defaultKeyringService(env)) return '';
  return `.${service.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
