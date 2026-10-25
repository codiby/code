import { NativeModules } from 'react-native';
import type { HomeSnapshot } from '../api/homeSnapshot';
import type { ServerRoutes } from '../api/useServerRoutes';
import type { ServerEntry } from '../config/servers';

/** Configuración mínima que usa el selector nativo, incluso con la app cerrada. */
export function shareTargetsConfig(
  servers: readonly ServerEntry[],
  routes: ServerRoutes = {},
): string {
  return JSON.stringify({
    version: 1,
    servers: servers.flatMap(server => {
      const candidates =
        server.mode === 'local'
          ? [server.localUrl]
          : server.mode === 'remote'
          ? [server.remoteUrl]
          : [server.localUrl, server.remoteUrl];
      const preferred = routes[server.id]?.baseUrl;
      if (preferred && candidates.includes(preferred)) {
        candidates.sort(url => (url === preferred ? -1 : 1));
      }
      const urls = [
        ...new Set(candidates.map(url => url.trim().replace(/\/+$/, ''))),
      ].filter(value => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            url.hostname.length > 0
          );
        } catch {
          return false;
        }
      });
      return urls.length
        ? [
            {
              id: server.id,
              name: server.name,
              color: server.color,
              token: server.token.trim(),
              urls,
            },
          ]
        : [];
    }),
  });
}

export async function syncShareTargets(
  servers: readonly ServerEntry[],
  routes: ServerRoutes = {},
): Promise<void> {
  const native = NativeModules.ShareTargets as
    | { configure: (config: string) => Promise<void> }
    | undefined;
  await native?.configure(shareTargetsConfig(servers, routes));
}

/** La misma foto del inicio; solo metadatos de chats activos, sin conversaciones. */
export function shareSessionsSnapshot(snapshot: HomeSnapshot): string {
  const pinned = new Set(snapshot.pinnedIds);
  return JSON.stringify(
    snapshot.sessions
      .filter(session => session.isOpen)
      .map(session => ({
        id: session.id,
        serverId: session.serverId,
        name: session.name,
        provider: session.provider,
        runtime_status: session.isRunning ? 'running' : 'idle',
        cwd: session.cwd,
        updated_at: session.updatedAt,
        pinned: pinned.has(session.key),
        pinOrder: snapshot.pinnedIds.indexOf(session.key),
        preview: snapshot.previews[session.key]?.text.slice(0, 160) ?? '',
      })),
  );
}

export async function syncShareSessions(snapshot: HomeSnapshot): Promise<void> {
  await NativeModules.ShareTargets?.cacheSessions?.(
    shareSessionsSnapshot(snapshot),
  );
}
