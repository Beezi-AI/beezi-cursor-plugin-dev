import { readKeys as readKeysDefault } from './vscdb.mjs';
import { stateVscdbFile } from './paths-cursor.mjs';

// Cursor's third-party extensibility switch — the one setting that decides whether a plugin's
// hooks and commands exist at all.
//
// In `CursorHooksService.reloadHooks`, plugin hooks are loaded inside the `if` branch of this flag;
// the `else` branch logs "Claude Code hooks disabled (thirdPartyExtensibilityEnabled off)" and calls
// `pluginHooks.clear()`. In the commands service, `allowExtensibilityCommands` is this flag AND the
// `enable_cc_plugin_import` server gate, and `loadPluginCommands` is skipped unless both hold.
// Skills are loaded on a different path and are unaffected — which is exactly the shape of the
// failure this reads: the skill appears, the commands and the hooks do not.
//
// Cursor's own default is ON (`thirdPartyExtensibilityEnabled: ch(!0)`), and the key is written
// only once the toggle has been touched. So "no row" means on, and only an unreadable store is
// unknown. The three states are distinct on purpose: a status report that prints "off" when it
// simply could not look sends the user to change a setting that was never the problem.
export const EXTENSIBILITY_KEY = 'cursor/thirdPartyExtensibilityEnabled';

// Where the toggle lives in Cursor's UI. Named here so the two places that mention it cannot drift.
export const EXTENSIBILITY_SETTING = 'Settings → Rules, Skills, Subagents → third-party extensibility';

function parseFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return null;
}

// `true` on, `false` off, `null` when it could not be determined.
export function readExtensibility({ dbFile = null, readKeys = readKeysDefault, ...deps } = {}) {
  let rows;
  try {
    rows = readKeys(dbFile == null ? stateVscdbFile() : dbFile, EXTENSIBILITY_KEY, deps);
  } catch {
    return null;
  }
  if (rows === null || rows === undefined) return null;
  const row = rows.find((r) => r != null && r.key === EXTENSIBILITY_KEY);
  if (!row) return true;
  return parseFlag(row.value);
}

// The line a status report adds when — and only when — the flag explains what the user is seeing.
export function extensibilityNote(state) {
  if (state !== false) return null;
  return `Cursor's third-party extensibility is OFF (${EXTENSIBILITY_SETTING}).\n`
    + "  While it is off Cursor ignores every plugin's bundled hooks and commands, including this\n"
    + '  one\'s. Beezi\'s skills still load, and the user-scope hook registry below is read regardless —\n'
    + '  which is why the fallback install exists. Turning the setting on is the other way out.';
}
