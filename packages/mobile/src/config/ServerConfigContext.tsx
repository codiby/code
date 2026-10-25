import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useServerRoutes, type ServerRoutes } from '../api/useServerRoutes';
import {
  DEFAULT_SERVERS,
  migrateLegacy,
  parseServers,
  type ServerEntry,
} from './servers';

const STORAGE_KEY = 'codiby.servers';
/** Clave de la config de un solo servidor, anterior a la lista. */
const LEGACY_KEY = 'codiby.server-config';

export interface ServersValue {
  readonly servers: ServerEntry[];
  /** Ruta viva de cada servidor, por id. */
  readonly routes: ServerRoutes;
  /** false mientras se lee lo persistido, para no parpadear el default. */
  readonly isLoaded: boolean;
  readonly saveServers: (next: ServerEntry[]) => Promise<void>;
  readonly upsertServer: (server: ServerEntry) => Promise<void>;
  readonly removeServer: (id: string) => Promise<void>;
  /** Vuelve a sondear todas las rutas ahora mismo. */
  readonly refreshRoutes: () => void;
}

const ServersContext = createContext<ServersValue | null>(null);

export function ServerConfigProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerEntry[]>(DEFAULT_SERVERS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const stored = parseServers(raw);
      if (stored !== null) {
        return stored;
      }
      // Solo se mira la config vieja si no hay lista: así una migración ya
      // hecha no puede resucitar datos que borraste después.
      const legacy = migrateLegacy(await AsyncStorage.getItem(LEGACY_KEY));
      if (legacy !== null) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        return legacy;
      }
      return null;
    };

    load()
      .then(result => {
        if (!cancelled && result !== null) {
          setServers(result);
        }
      })
      .catch(() => {
        // Sin nada usable se queda el default.
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const { routes, refresh: refreshRoutes } = useServerRoutes(servers, isLoaded);

  const saveServers = useCallback(async (next: ServerEntry[]) => {
    setServers(next);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const upsertServer = useCallback(
    async (server: ServerEntry) => {
      const next = servers.some(item => item.id === server.id)
        ? servers.map(item => (item.id === server.id ? server : item))
        : [...servers, server];
      await saveServers(next);
    },
    [servers, saveServers],
  );

  const removeServer = useCallback(
    async (id: string) => {
      await saveServers(servers.filter(item => item.id !== id));
    },
    [servers, saveServers],
  );

  const value = useMemo<ServersValue>(
    () => ({
      servers,
      routes,
      isLoaded,
      saveServers,
      upsertServer,
      removeServer,
      refreshRoutes,
    }),
    [servers, routes, isLoaded, saveServers, upsertServer, removeServer, refreshRoutes],
  );

  return (
    <ServersContext.Provider value={value}>{children}</ServersContext.Provider>
  );
}

export function useServers(): ServersValue {
  const value = useContext(ServersContext);
  if (value === null) {
    throw new Error('useServers requiere un <ServerConfigProvider>');
  }
  return value;
}

/**
 * Ruta viva de un servidor concreto. Es lo que necesita cualquier pantalla que
 * ya sabe con qué sesión trabaja: la sesión trae su `serverId` y de ahí sale a
 * quién hay que pedirle los datos.
 *
 * `baseUrl` vacío significa que esa máquina no responde por ninguna ruta.
 */
export function useRouteFor(serverId: string): {
  baseUrl: string;
  token: string;
} {
  const { routes } = useServers();
  const route = routes[serverId];
  return { baseUrl: route?.baseUrl ?? '', token: route?.token ?? '' };
}
