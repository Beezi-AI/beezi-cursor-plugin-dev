// Which Beezi environment this copy of the plugin IS, and every machine-local name derived from
// that answer: the data root, the OS credential service, the materialized plugin directory and the
// hook-handler marker. One module, because the failure mode of spreading it out is silent and
// expensive — a dev build that namespaces its data root but not its keychain entry logs the user
// out of prod, and an uninstall that namespaces its launcher path but not its handler label
// deletes the other variant's hooks.
//
// Node 13.2 floor: bare 'crypto'/'fs'/'path'/'url' specifiers (the `node:` prefix needs 12.20 or
// 14.13.1+ in ESM, and 13.2 is neither), no `?.`, no `??`, no top-level await.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Every environment this plugin is allowed to be. `prod` is spelled as the EMPTY suffix everywhere
// downstream, so an upgrade of an existing prod install keeps reading `~/.beezi-cursor` and the
// `beezi-cursor` keychain entry it already has.
export const ENV_NAMES = ['local', 'dev', 'staging', 'prod'];

export const PROD_API_BASE = 'https://beezi-api-prod.azurewebsites.net/api';

// What lib/config.mjs has always used for a local backend. CONTRACTS §1 spells the literal as
// :3000 and then instructs "keep whatever config.mjs uses today for local" — the instruction wins,
// because the number is what a local developer's server actually listens on.
export const LOCAL_API_BASE = 'http://localhost:5001/api';

// A misconfiguration the operator can fix, not a runtime fault. `userFacing` is the flag
// lib/friendly-error.mjs checks to print a message verbatim instead of classifying it.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.userFacing = true;
  }
}

// plugins/beezi — this file is at plugins/beezi/lib/env-identity.mjs.
const DEFAULT_PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Parsed once per resolved env.json path, for the life of the process.
//
// This is a cache of a FILE THAT CANNOT CHANGE UNDER A RUNNING PROCESS. env.json ships inside the
// plugin directory and is written exactly once, by scripts/make-variant.sh, at build time; the
// running plugin never writes it, and a marketplace upgrade replaces the whole directory and
// restarts. So there is no staleness window to worry about, and the environment being fixed for the
// life of a process is the contract everything else here depends on — a data root or a keychain
// service that changed mid-process would mean a store written under one name and read under another.
//
// It is worth caching because the derived names are read on hot paths: every queue write, every
// state write and every credential read resolves through here.
//
// Keyed by the resolved file path, not global, so a test pointing at a temp directory gets its own
// entry and cannot poison the real one. Nothing invalidates it — if a test ever needs to re-read the
// same path with different content, it must use a different directory.
const bakedCache = new Map();

function envBag(env) {
  return env === undefined || env === null ? process.env : env;
}

// The ONLY place a name becomes a suffix. Exact match against the allowlist, no trimming and no
// case folding: `Dev` and ` dev` are typos worth reporting, and accepting them would mean this
// function's output is no longer a closed set of five strings. Everything downstream — path
// segments, the Windows Credential Manager target, the PowerShell argument that carries the token —
// interpolates that output directly, so the allowlist is the whole defence.
function normalizeName(raw) {
  if (raw === '' || raw === 'prod') return '';
  if (raw === 'local' || raw === 'dev' || raw === 'staging') return raw;
  return null;
}

function bakedFile(pluginRoot) {
  return path.join(pluginRoot === undefined ? DEFAULT_PLUGIN_ROOT : pluginRoot, 'env.json');
}

// Parses the variant's baked identity. Shape is always `{ name, apiBase }`; a document this module
// cannot trust degrades to prod (`{ name: '', apiBase: null }`) and adds `error` so a diagnostic
// can say why. Deliberately non-throwing: this file lives inside an already-installed variant, and
// a throw here is every hook process of that install crashing on startup.
export function readBakedEnv(pluginRoot) {
  const file = bakedFile(pluginRoot);
  const cached = bakedCache.get(file);
  if (cached !== undefined) return cached;

  let result;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    // No env.json is the prod default, not a fault: a source checkout and the prod artifact both
    // read that way, and reporting an error would make a healthy tree look broken.
    result = error != null && error.code === 'ENOENT'
      ? { name: '', apiBase: null }
      : { name: '', apiBase: null, error: 'env.json is unreadable' };
    bakedCache.set(file, result);
    return result;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    result = { name: '', apiBase: null, error: 'env.json is not valid JSON: ' + error.message };
    bakedCache.set(file, result);
    return result;
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    result = { name: '', apiBase: null, error: 'env.json is not a JSON object' };
  } else if (doc.name !== undefined && typeof doc.name !== 'string') {
    result = { name: '', apiBase: null, error: 'env.json name is not a string' };
  } else if (doc.apiBase !== undefined && doc.apiBase !== null && typeof doc.apiBase !== 'string') {
    result = { name: '', apiBase: null, error: 'env.json apiBase is not a string' };
  } else if (typeof doc.apiBase === 'string' && doc.apiBase !== '' && !usableUrl(doc.apiBase)) {
    // A baked endpoint has to BE a URL before it may become one. Returning a bare word would make
    // it this variant's destination, and every POST would then fail at `new URL()` inside the HTTP
    // layer rather than fall back to anything — the same class of failure as defaulting to
    // localhost, one layer later and harder to read. Falling through to prod is the only safe
    // reading of an unusable baked value. (Pinned by test/env-isolation.test.mjs, M05's
    // acceptance check for CONTRACTS §1.)
    result = { name: '', apiBase: null, error: 'env.json apiBase is not an http(s) URL' };
  } else {
    result = {
      name: typeof doc.name === 'string' ? doc.name : '',
      apiBase: typeof doc.apiBase === 'string' && doc.apiBase !== '' ? doc.apiBase : null,
    };
  }
  bakedCache.set(file, result);
  return result;
}

// An http/https URL and nothing else. `URL` is a global from Node 10 on, so this is floor-safe.
function usableUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// 'local' | 'dev' | 'staging' | '' (prod). Precedence: BEEZI_CURSOR_ENV, then the baked name, then
// prod.
//
// The two invalid cases are treated differently ON PURPOSE:
//   BEEZI_CURSOR_ENV=qa   -> ConfigError. The operator typed it a second ago; resolving it to prod
//                            would write a QA machine's analytics into the production tenant.
//   env.json name "qa"    -> prod. That file is inside a shipped variant, already installed on a
//                            user's machine, and a throw is a crash loop in every hook.
export function envName(env, pluginRoot) {
  const bag = envBag(env);
  const declared = bag.BEEZI_CURSOR_ENV;
  if (declared !== undefined && declared !== null) {
    const normalized = normalizeName(declared);
    if (normalized === null) {
      throw new ConfigError(
        'invalid BEEZI_CURSOR_ENV: ' + JSON.stringify(declared)
        + ' (expected one of ' + ENV_NAMES.join(', ') + ')',
      );
    }
    return normalized;
  }
  const baked = normalizeName(readBakedEnv(pluginRoot).name);
  return baked === null ? '' : baked;
}

// '' for prod, '-dev' / '-staging' / '-local' otherwise.
export function envSuffix(env, pluginRoot) {
  const name = envName(env, pluginRoot);
  return name === '' ? '' : '-' + name;
}

// BEEZI_API_URL -> localhost when the environment IS local -> the variant's baked base -> prod.
//
// BEEZI_API_URL is a DESTINATION override only. It does not move the identity: a machine pointed at
// the dev API without also setting BEEZI_CURSOR_ENV/BEEZI_CURSOR_HOME writes dev data into the prod
// store under prod credentials.
export function apiBase(env, pluginRoot) {
  const bag = envBag(env);
  const name = envName(bag, pluginRoot);
  if (bag.BEEZI_API_URL !== undefined && bag.BEEZI_API_URL !== null) return bag.BEEZI_API_URL;
  if (name === 'local') return LOCAL_API_BASE;
  const baked = readBakedEnv(pluginRoot).apiBase;
  return baked === null ? PROD_API_BASE : baked;
}

// The directory name under $HOME. Prod stays `.beezi-cursor` so an upgrade reads what is already
// there; every other environment is a separate store that cannot see prod's queue or credentials.
export function dataRootName(env, pluginRoot) {
  return '.beezi-cursor' + envSuffix(env, pluginRoot);
}

// 12 hex characters of the canonical path. On win32 the same directory has many spellings
// (`C:\Users\Dev` / `c:/users/dev`) and they all have to hash to one namespace, or the credential
// entry a login wrote is invisible to the logout that follows it.
export function homeDigest(customHomePath) {
  let canonical = path.resolve(customHomePath);
  if (process.platform === 'win32') canonical = canonical.toLowerCase().split('\\').join('/');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// The OS keyring service (on Windows, the Credential Manager target name).
//
// `customHome` defaults to BEEZI_CURSOR_HOME from the bag, so integration's credentials.mjs is a
// single call. A custom home earns its own service because two homes sharing one keychain entry
// means a logout in either deletes the token of both. An explicit BEEZI_CURSOR_HOME that resolves
// to the environment's DEFAULT home is still the default — suffixing it would orphan the
// credentials the same machine stored before the variable was exported.
export function keyringService(env, customHome, pluginRoot) {
  const bag = envBag(env);
  const suffix = envSuffix(bag, pluginRoot);
  const home = customHome === undefined || customHome === null ? bag.BEEZI_CURSOR_HOME : customHome;
  if (home === undefined || home === null || home === '') return 'beezi-cursor' + suffix;
  if (homeDigest(home) === homeDigest(defaultHomePath(suffix))) return 'beezi-cursor' + suffix;
  return 'beezi-cursor' + suffix + '-h' + homeDigest(home);
}

// `os.homedir()` is read at CALL time, never captured at import: a test that relocates HOME, and a
// Windows profile that moves, both have to be seen by the comparison below.
function defaultHomePath(suffix) {
  return path.join(os.homedir(), '.beezi-cursor' + suffix);
}

// `beezi`, `beezi-dev`, `beezi-staging`, `beezi-local`. This is simultaneously the generated
// plugin's manifest name, the directory `cursorPluginDir()` materializes into, and the marker a
// hook handler carries so an uninstall removes its OWN entries and leaves a sibling variant's
// alone.
export function variantMarker(env, pluginRoot) {
  return 'beezi' + envSuffix(env, pluginRoot);
}
