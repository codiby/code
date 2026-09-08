/** One list of sessions out of several bridges.
 *
 *  The frontend holds a connection per machine — the local bun sidecar plus one
 *  per remote — and each reports its own `sessions` frame. The same session can
 *  arrive over more than one of them: the local bridge may surface aggregated
 *  remote rows, an older remote mirrors *its* remotes, and the same machine can
 *  be registered twice (over the LAN and over Tailscale, say). Concatenating
 *  those lists painted one session as several sidebar rows.
 */

import type { SessionInfo } from './claude-client';

/**
 * Deduplicate by session id, keeping the row from the bridge that owns it.
 *
 * `remoteId` is stamped from the reporting connection, so an owned row is one
 * whose remote matches the key it arrived under (`''` for local). First-hand
 * metadata beats a mirror regardless of which arrives first.
 */
export function mergeSessionsByOwner(byConn: Iterable<[string, SessionInfo[]]>): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const [connKey, list] of byConn) {
    for (const session of list) {
      if ((session.remoteId ?? '') === connKey || !byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return [...byId.values()];
}
