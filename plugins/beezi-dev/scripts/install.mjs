import {
  HookScope,
  RELOAD_STEP,
  hooksStatus,
  installHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';
import { pluginHooksAlive, readHookSource } from '../lib/hook-source.mjs';
import { extensibilityNote, readExtensibility } from '../lib/extensibility.mjs';
import {
  DEFAULT_GIT_REF,
  installProjectPlugin,
  projectPluginStatus,
  uninstallProjectPlugin,
} from '../lib/project-install.mjs';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';

// `--scope plugin|user`. The plugin ships its own `hooks/hooks.json`, which Cursor discovers on a
// marketplace install, so this script is a repair path: user scope is what it repairs by default.
// `--scope plugin` remains for the legacy local materialization at ~/.cursor/plugins/local/beezi.
function parseScope(argv) {
  const at = argv.indexOf('--scope');
  if (at === -1) return HookScope.USER;
  const value = argv[at + 1];
  if (value !== HookScope.PLUGIN && value !== HookScope.USER) {
    throw new UserError(`Unknown --scope '${value == null ? '' : value}'. Use 'plugin' or 'user'.`);
  }
  return value;
}

function flag(argv, name, fallback = undefined) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new UserError(`--${name} needs a value.`);
  return value;
}

// The one Cursor setting that can make a correct install look broken. Printed before anything else,
// because every other line of the report is misleading while it is off: the bundled registry is
// loaded and then discarded, so "the plugin ships its own hooks" stops being true on this machine.
function reportExtensibility() {
  const note = extensibilityNote(readExtensibility());
  if (!note) return;
  console.log(`⚠ ${note}`);
  console.log('');
}

function reportProject(dir) {
  const status = projectPluginStatus({ dir });
  if (status.unreadable) {
    console.log(`⚠ Beezi: ${status.file} could not be parsed — project scope was not checked.`);
    return;
  }
  if (!status.installed) return;
  console.log(`✓ Beezi: enabled for this project via ${status.file}`);
  console.log(`  Source: ${status.entry.gitUrl}@${status.entry.gitRef == null ? DEFAULT_GIT_REF : status.entry.gitRef}`);
}

// The bundled registry, which covers the Cursor IDE, and of the CLI builds only those that run
// plugin hooks (2026.09.18 does; older builds did not).
//
// This block used to RETURN. If a plugin hook had been seen firing it printed "no install needed",
// skipped the registry report entirely, and — when the user scope did have entries — offered to
// remove them. Every one of those three lines is now wrong: older `cursor-agent` builds ran no
// plugin hook at all (Cursor staff, forum 163890, Jun–Aug 2026), so on a machine that uses both
// hosts, "no install needed" was printed while every CLI session recorded nothing whatsoever, and
// the removal note described deleting the CLI's only coverage. CLI 2026.09.18 runs the bundled
// hooks too (observed on Windows), but the launchers are still what an older build, or a machine
// without Node on PATH, falls back on.
// lib/plugin-install.mjs no longer performs that removal, and this report no longer stops at the
// half of the answer that looked healthy.
function reportBundled() {
  const probe = readHookSource();
  if (pluginHooksAlive({ probe })) {
    console.log("✓ Beezi: the plugin's own bundled hooks are firing — the Cursor IDE is covered.");
    console.log(`  Last seen: ${new Date(probe.ts).toISOString()}`);
    console.log(`  Plugin:    ${probe.pluginRoot}`);
  } else {
    console.log("• Beezi: the plugin's own bundled hooks have not been seen firing on this machine.");
    console.log('  Normal on older `cursor-agent` builds, without `node` on PATH, or before the first');
    console.log('  session with the plugin enabled. The registry below is what matters either way.');
  }
  console.log('');
}

// The installable registry — and, under an older `cursor-agent` build that ignores plugin hooks,
// the only one there is.
function reportRegistry(status) {
  // True only of the user scope. `--scope plugin` is the legacy local materialization, which the CLI
  // does not read either, so claiming it covers cursor-agent would be the same mistake in reverse.
  const cliNote = status.scope === HookScope.USER
    ? '  `cursor-agent` reads this registry; older CLI builds read no other.'
    : null;

  if (status.state === 'installed') {
    console.log(`✓ Beezi: analytics hooks are installed (${status.scope} scope).`);
    if (cliNote) console.log(cliNote);
    console.log(`  Registry: ${status.hooksFile}`);
    console.log(`  Events:   ${status.registered.join(', ')}`);
    console.log(`  If analytics are not arriving, ${RELOAD_STEP}.`);
    return;
  }

  if (status.state === 'absent') {
    // No longer "correct when the bundled hooks are alive". An absent user scope leaves an older CLI
    // build, or a machine without `node` on PATH, uncovered whatever the IDE is doing, and it is a
    // missing install every single time.
    console.log(`⚠ Beezi: analytics hooks are NOT installed (${status.scope} scope).`);
    if (cliNote) console.log(cliNote);
    console.log(`  Registry: ${status.hooksFile}`);
    console.log('  Run this script with `install` to fix it.');
    return;
  }

  console.log(
    status.state === 'stale'
      ? '⚠ Beezi: the analytics hooks point at an older plugin version.'
      : '⚠ Beezi: the analytics hook install is incomplete.',
  );
  if (cliNote) console.log(cliNote);
  console.log(`  Registry: ${status.hooksFile}`);
  if (status.registered.length) console.log(`  Registered: ${status.registered.join(', ')}`);
  for (const l of status.missingLaunchers) console.log(`  Missing:    ${l}`);
  for (const l of status.staleLaunchers) console.log(`  Stale:      ${l}`);
  // Named separately from a stale launcher because the file on disk is fine here and the REGISTRY is
  // what an older version wrote — without this line, "points at an older plugin version" is printed
  // above a list of nothing at all, and the one thing that is wrong is the one thing not shown.
  const outdated = status.outdatedEntries == null ? [] : status.outdatedEntries;
  for (const e of outdated) console.log(`  Outdated:   ${e} (registry entry, rewritten by \`install\`)`);
  console.log('  Run this script with `install` to repair.');
}

function reportStatus(scope, dir) {
  reportExtensibility();
  reportBundled();
  reportRegistry(hooksStatus({ scope }));
  reportProject(dir);
}

function main() {
  const argv = process.argv.slice(2);
  const positional = argv.find((a) => !a.startsWith('--'));
  const action = positional == null ? 'status' : positional;
  const dir = flag(argv, 'dir', process.cwd());

  if (action === 'status') return reportStatus(parseScope(argv), dir);

  if (action === 'install') {
    const scope = parseScope(argv);
    const { hooksFile, events, pluginRoot, materialized } = installHooks({
      scope,
      // User scope runs THIS copy of the plugin: a marketplace install is already a real directory
      // on disk, and copying it to ~/.cursor/plugins/local would leave two copies to upgrade.
      materialize: scope === HookScope.PLUGIN,
    });
    if (materialized) console.log(`✓ Beezi: plugin installed at ${pluginRoot}`);
    console.log(`✓ Beezi: analytics hooks written to ${hooksFile}`);
    console.log(`  Scope:  ${scope}`);
    console.log(`  Events: ${events.join(', ')}`);
    console.log('');
    console.log(`  One more step — ${RELOAD_STEP}.`);
    // This used to promise the opposite: "if Cursor discovers the bundled hooks, these entries are
    // removed again automatically". They are not, and removing them was the bug — the entries below
    // are the only hooks `cursor-agent` ever runs, and deleting them because an IDE session had
    // fired a bundled hook turned every subsequent CLI session silent.
    console.log('  These entries stay installed. The plugin also ships its own hooks/hooks.json, which');
    console.log('  Cursor discovers in the IDE — but never under `cursor-agent`, so the two registries');
    console.log('  cover different hosts. Events either one duplicates are collapsed when they are read.');
    return;
  }

  if (action === 'uninstall') {
    const { hooksFile, removed } = uninstallHooks({ scope: parseScope(argv) });
    console.log(
      removed
        ? `✓ Beezi: analytics hooks removed from ${hooksFile}. Your other hooks were left alone.`
        : `Beezi: no analytics hooks were installed in ${hooksFile} — nothing to remove.`,
    );
    return;
  }

  // Project scope, written as a file. Cursor's own UI cannot do this outside a multi-workspace
  // window — it throws "Workspace collection is not available" before it reaches the filesystem —
  // and the file it would have written is the whole of the feature.
  if (action === 'project') {
    const { file, entry } = installProjectPlugin({
      dir,
      gitUrl: flag(argv, 'git-url'),
      gitRef: flag(argv, 'git-ref', DEFAULT_GIT_REF),
    });
    console.log(`✓ Beezi: enabled for this project in ${file}`);
    console.log(`  Source: ${entry.gitUrl}@${entry.gitRef} (${entry.gitPath})`);
    console.log('');
    console.log('  Commit that file to share the plugin with everyone who opens this repository.');
    console.log(`  One more step — ${RELOAD_STEP}.`);
    return;
  }

  if (action === 'project-remove') {
    const { file, removed } = uninstallProjectPlugin({ dir });
    console.log(
      removed
        ? `✓ Beezi: removed from ${file}. Your other settings were left alone.`
        : `Beezi: ${file} does not enable Beezi for this project — nothing to remove.`,
    );
    return;
  }

  console.error(
    `✗ Beezi: unknown action '${action}'. Use install, uninstall, status, project, or project-remove.`,
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
