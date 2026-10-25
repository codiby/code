import { NativeModules } from 'react-native';
import type { ServerEntry } from '../config/servers';

/** Configuración mínima que usa el selector nativo, incluso con la app cerrada. */
export function shareTargetsConfig(servers: readonly ServerEntry[]): string {
  return JSON.stringify({
    version: 1,
    servers: servers.flatMap(server => {
      const candidates =
        server.mode === 'local'
          ? [server.localUrl]
          : server.mode === 'remote'
          ? [server.remoteUrl]
          : [server.localUrl, server.remoteUrl];
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
): Promise<void> {
  const native = NativeModules.ShareTargets as
    | { configure: (config: string) => Promise<void> }
    | undefined;
  await native?.configure(shareTargetsConfig(servers));
}
