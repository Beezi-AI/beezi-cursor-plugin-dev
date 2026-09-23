import path from 'path';
import url from 'url';
import { hookSourceFile } from './paths-cursor.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// Which registries have been seen firing on this machine. Bookkeeping and diagnostics — nothing
// here decides whether a hook does its work.
//
// Beezi's hooks can reach a machine two ways:
//
//   plugin-hooks  the bundled `hooks/hooks.json`, discovered by Cursor inside the installed plugin
//   launcher      `~/.beezi-cursor/hooks/beezi-*.cmd|.sh`, merged into `~/.cursor/hooks.json`
//
// This module used to arbitrate between them. A launcher run stood down and exited 0 whenever a
// plugin run had been recorded within PROBE_TTL_MS, and lib/plugin-install.mjs deleted the
// user-scope registry outright once a bundled hook had been seen to fire. Both rested on one
// premise — "the bundled registry is alive, so the launcher is redundant" — and the premise is
// false.
//
// Older Cursor CLI builds (Jun–Aug 2026) did not run hooks that come from an installed plugin,
// marketplace or local, even though they loaded that plugin's rules and skills; only
// `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json` fired under `cursor-agent` (Cursor
// staff, forum 163890). The two
// registries were therefore not substitutes for each other — they covered different hosts. One IDE
// session recording `plugin-hooks` was enough to switch the launchers off for a fortnight and have
// the self-installer delete them, and from then on every `cursor-agent` session on that machine
// reported nothing at all: no sidecar line, no segment, no cost. Silently, and for as long as the
// IDE kept being used, which on a machine that uses both is forever.
//
// CLI 2026.09.18 does run bundled hooks: every event fired twice, once from each registry. That
// makes neither registry redundant. A CLI build that predates the change still runs only the
// launchers, and the bundled entries call bare `node`, so on a CLI-only machine without Node on
// PATH the launchers (which record a node path) are the only hooks that run at all.
//
// Nothing is arbitrated now. Both registries stay installed, both fire, and the duplicate lines they
// write are collapsed by the READER on the host's own event id — see `eid` in lib/sidecar-events.mjs
// and dedupeEvents in lib/delta-cursor.mjs. Identity is a fact about the event; "which registry is
// alive" was a guess about the host, and a wrong guess turned a whole host off.
//
// The record is kept because the status surfaces still have a real question to answer. `install`,
// `me` and the session banner report which registry has been seen doing the work, and "no bundled
// hook has ever run here" is what distinguishes a CLI-only machine on an older CLI build from a
// broken install. Each registry gets its own entry: on a machine where both fire, a single shared
// slot would be rewritten by whichever ran last — on every tool call, in the hottest path the
// plugin has.

export const HookSource = Object.freeze({
  PLUGIN: 'plugin-hooks',
  LAUNCHER: 'launcher',
});

// How long a recorded run keeps vouching for its registry — for the status surfaces only; no
// behaviour is gated on it any more. Long enough to survive a holiday, short enough that a machine
// which has stopped discovering the bundled hooks stops claiming they are alive within a fortnight.
export const PROBE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// `postToolUse` fires on every tool call, so a registry's record is refreshed on a timer rather than
// on every run — the file is only ever read to answer "recently, and by whom".
const REFRESH_MS = 60 * 60 * 1000;

// This module sits in <pluginRoot>/lib, so its own location identifies the copy of the plugin that
// is running. Two copies (a marketplace cache directory and an older local materialization) can be
// installed at once, and a record written by one must not vouch for the other.
export const PLUGIN_ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// `--via plugin-hooks` is passed by the bundled registry only. A launcher carries no flag, so an
// unrecognised or absent value reads as the launcher — the conservative direction, since a launcher
// run is the one that checks before acting.
export function hookVia(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--via');
  return argv[at + 1] === HookSource.PLUGIN ? HookSource.PLUGIN : HookSource.LAUNCHER;
}

// The most recent run, whichever registry it came from. `via`/`pluginRoot`/`ts` are kept at the top
// level — three surfaces read them by name — and `seen` carries the same triple per registry so one
// registry's run cannot erase the other's.
export function readHookSource({ file = hookSourceFile() } = {}) {
  const probe = readJson(file, null);
  if (!probe || typeof probe !== 'object') return null;
  if (typeof probe.ts !== 'number' || typeof probe.via !== 'string') return null;
  return probe;
}

// What a probe records for one registry. Falls back to the top-level triple for a file written
// before `seen` existed: an upgrade must not report every machine's hooks as never having fired.
function runOf(probe, via) {
  if (probe == null) return null;
  const seen = probe.seen;
  const entry = seen == null ? undefined : seen[via];
  if (entry && typeof entry.ts === 'number') return entry;
  if (probe.via === via) return probe;
  return null;
}

// Is the bundled registry known to be firing for THIS copy of the plugin?
export function pluginHooksAlive({ probe, now = Date.now(), pluginRoot = PLUGIN_ROOT } = {}) {
  const run = runOf(probe, HookSource.PLUGIN);
  if (!run) return false;
  if (path.resolve(run.pluginRoot == null ? '' : run.pluginRoot) !== path.resolve(pluginRoot)) return false;
  return now - run.ts <= PROBE_TTL_MS;
}

function stale(probe, { via, pluginRoot, now }) {
  const run = runOf(probe, via);
  if (!run) return true;
  if (path.resolve(run.pluginRoot == null ? '' : run.pluginRoot) !== path.resolve(pluginRoot)) return true;
  return now - run.ts > REFRESH_MS;
}

// Record this run's registry. Best-effort by construction: a hook that cannot write its own
// bookkeeping must still do the work it was started for.
export function recordHookRun({ via, pluginRoot = PLUGIN_ROOT, now = Date.now(), file = hookSourceFile() } = {}) {
  const probe = readHookSource({ file });
  if (!stale(probe, { via, pluginRoot, now })) return probe;
  const run = { pluginRoot, ts: now };
  const seen = probe == null || probe.seen == null ? {} : probe.seen;
  const next = { ...run, via, seen: { ...seen, [via]: run } };
  try { writeJsonSecure(file, next); } catch { /* best effort */ }
  return next;
}

// Called first by every hook script, and always true: every run does the work it was started for.
//
// The stand-down branch that used to live here exited 0 on a launcher run whenever a bundled run had
// been seen in the last fortnight. Under a `cursor-agent` build where the bundled registry does not
// fire, that switched off the only hooks the CLI has — see the module header. Duplicates are
// collapsed at read time now, on the event's own id, so there is nothing left for a hook process to
// arbitrate.
//
// It still returns a boolean, and every hook script still calls it, because this is also where a run
// records its registry for the status surfaces.
export function claimHookRun({ argv = process.argv.slice(2), now = Date.now(), file = hookSourceFile(), pluginRoot = PLUGIN_ROOT } = {}) {
  recordHookRun({ via: hookVia(argv), pluginRoot, now, file });
  return true;
}
