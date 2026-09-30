/**
 * User-chosen permission mode for new sessions.
 *
 * Stored in ui-preferences.json as `defaultPermissionMode`. A session created
 * without an explicit mode starts in it; sessions already running keep theirs.
 * Loop is left out: it has to arm the loop driver, not just set a flag.
 */
import { loadPreferences } from './storage';

export const DEFAULTABLE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

export function getDefaultPermissionMode(prefs: Record<string, unknown> = loadPreferences()): string {
  const raw = prefs.defaultPermissionMode;
  return typeof raw === 'string' && (DEFAULTABLE_PERMISSION_MODES as readonly string[]).includes(raw) ? raw : 'default';
}
