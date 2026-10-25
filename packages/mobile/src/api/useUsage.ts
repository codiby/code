import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useServers } from '../config/ServerConfigContext';
import { fetchUsage, type UsageSnapshot } from './usage';

const POLL_MS = 5 * 60_000;
export interface UsageResult {
  snapshot: UsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

/** Each route owns its results; a late response cannot cross hosts or tokens. */
export function useUsage(open: boolean) {
  const { servers, routes } = useServers();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    signature: string;
    entries: Record<string, UsageResult>;
  }>({ signature: '', entries: {} });
  const signature = JSON.stringify(
    servers.map(server => ({
      id: server.id,
      baseUrl: routes[server.id]?.baseUrl ?? '',
      token: server.token,
    })),
  );

  useEffect(() => {
    const targets: { id: string; baseUrl: string; token: string }[] =
      JSON.parse(signature);
    let cancelled = false;
    let running = false;
    const load = async () => {
      if (
        running ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      ) {
        return;
      }
      running = true;
      setState(previous => ({
        signature,
        entries: Object.fromEntries(
          targets.map(target => [
            target.id,
            {
              snapshot:
                previous.signature === signature
                  ? previous.entries[target.id]?.snapshot ?? null
                  : null,
              loading: !!target.baseUrl,
              error: target.baseUrl ? null : 'Servidor sin conexión',
            },
          ]),
        ),
      }));
      await Promise.all(
        targets
          .filter(target => target.baseUrl)
          .map(async target => {
            let snapshot: UsageSnapshot | null = null;
            let error: string | null = null;
            try {
              snapshot = await fetchUsage(target.baseUrl, target.token, open);
            } catch (e) {
              error = e instanceof Error ? e.message : 'No se pudo leer el uso';
            }
            if (!cancelled) {
              setState(previous => ({
                signature,
                entries: {
                  ...previous.entries,
                  [target.id]: {
                    snapshot:
                      snapshot ?? previous.entries[target.id]?.snapshot ?? null,
                    loading: false,
                    error,
                  },
                },
              }));
            }
          }),
      );
      running = false;
    };
    load();
    const timer = setInterval(() => {
      load();
    }, POLL_MS);
    const listener = AppState.addEventListener('change', next => {
      if (next === 'active') {
        load();
      }
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      listener.remove();
    };
  }, [signature, open, revision]);

  return {
    entries: state.signature === signature ? state.entries : {},
    refresh: () => setRevision(value => value + 1),
  };
}
