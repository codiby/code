/**
 * Permission mode new sessions start in, per bridge.
 *
 * Lives in each bridge's preferences as `defaultPermissionMode`; the bridge
 * applies it to every session created without an explicit mode. Loop can't be
 * a default: picking it arms the loop driver rather than setting a flag.
 */

export const DEFAULTABLE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

export function readDefaultPermissionMode(prefs: Record<string, unknown>): string {
  const raw = prefs.defaultPermissionMode;
  return typeof raw === 'string' && (DEFAULTABLE_PERMISSION_MODES as readonly string[]).includes(raw) ? raw : 'default';
}
