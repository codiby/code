import { resolveServerUrl } from '../claude-client';
import { stripRemoteGroups } from '../remote-groups';

/** Fire-and-forget write of UI preferences to the bridge server. Preferences
 *  are the server's source of truth (~/.codiby/ui-preferences.json); the store
 *  mirrors them locally and calls this on every user change so the two stay in
 *  sync. Shared by every slice that owns persisted state.
 *
 *  Groups belonging to another machine are dropped on the way out. The sidebar
 *  renders local and remote folders as one tree, so a handler can end up with a
 *  remote id in hand; writing one here is what left groups pointing at another
 *  machine's cwd in this file. */
export function persistPrefs(patch: Record<string, unknown>): void {
  const body = JSON.stringify(stripRemoteGroups(patch));
  resolveServerUrl().then(base =>
    fetch(`${base}/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {})
  );
}
