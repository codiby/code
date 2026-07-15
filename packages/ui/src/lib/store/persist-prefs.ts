import { resolveServerUrl } from '../claude-client';

/** Fire-and-forget write of UI preferences to the bridge server. Preferences
 *  are the server's source of truth (~/.codiby/ui-preferences.json); the store
 *  mirrors them locally and calls this on every user change so the two stay in
 *  sync. Shared by every slice that owns persisted state. */
export function persistPrefs(patch: Record<string, unknown>): void {
  resolveServerUrl().then(base =>
    fetch(`${base}/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  );
}
