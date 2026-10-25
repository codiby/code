import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoutePath, ServerEntry } from '../config/servers';

/** Por dónde entró cada servidor la última vez, para no empezar a ciegas. */
const LAST_ROUTES_KEY = 'codiby.last-routes';

/**
 * Cuánto se espera a la local antes de rendirse.
 *
 * Medido contra el sistema real: la LAN contesta en ~12 ms y el Funnel en
 * ~670 ms. 1,5 s deja margen de sobra para una red local lenta sin que la
 * pantalla se sienta colgada.
 */
const LOCAL_TIMEOUT_MS = 1_500;

/** El respaldo sale a internet, así que merece más paciencia. */
const REMOTE_TIMEOUT_MS = 6_000;

/** Cada cuánto se reintenta la local cuando ya se cayó al respaldo. */
const RECHECK_MS = 30_000;

export interface ServerRoute {
  readonly server: ServerEntry;
  /** URL que hay que usar; vacía si no responde ninguna. */
  readonly baseUrl: string;
  readonly token: string;
  /** `null` mientras se prueba o si ninguna ruta contestó. */
  readonly path: RoutePath | null;
  readonly latencyMs: number | null;
  readonly isProbing: boolean;
}

export type ServerRoutes = Readonly<Record<string, ServerRoute>>;

/**
 * `/health` es pública, así que sirve de sonda sin arrastrar el token ni las
 * 607 sesiones de `/sessions` solo para saber si la máquina está viva.
 */
async function probe(url: string, timeoutMs: number): Promise<number | null> {
  if (url.length === 0) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok ? Date.now() - started : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(
  server: ServerEntry,
): Promise<{ baseUrl: string; path: RoutePath | null; latencyMs: number | null }> {
  const local = server.localUrl;
  const remote = server.remoteUrl;

  if (server.mode === 'local') {
    const ms = await probe(local, LOCAL_TIMEOUT_MS);
    return { baseUrl: ms === null ? '' : local, path: ms === null ? null : 'local', latencyMs: ms };
  }
  if (server.mode === 'remote') {
    const ms = await probe(remote, REMOTE_TIMEOUT_MS);
    return { baseUrl: ms === null ? '' : remote, path: ms === null ? null : 'remote', latencyMs: ms };
  }

  // Las dos salen a la vez. En cadena, una local muerta costaba su 1,5 s
  // completo ANTES de empezar siquiera a preguntar por el respaldo: hasta 7,5 s
  // mirando una pantalla vacía. En paralelo el total es el del más lento de los
  // dos, no la suma.
  const localPromise = probe(local, LOCAL_TIMEOUT_MS);
  const remotePromise = probe(remote, REMOTE_TIMEOUT_MS);

  // Se espera a la local antes de mirar la otra, pero ambas ya están en vuelo:
  // cuando la local falla, la respuesta del respaldo suele estar lista.
  const localMs = await localPromise;
  if (localMs !== null) {
    return { baseUrl: local, path: 'local', latencyMs: localMs };
  }
  const remoteMs = await remotePromise;
  if (remoteMs !== null) {
    return { baseUrl: remote, path: 'remote', latencyMs: remoteMs };
  }
  return { baseUrl: '', path: null, latencyMs: null };
}

/**
 * Resuelve por qué ruta se entra a cada servidor y lo mantiene al día.
 *
 * En `auto` se reintenta la local cada 30 s aunque el respaldo funcione: si no,
 * llegar a casa te dejaría gastando datos móviles el resto del día.
 */
export function useServerRoutes(
  servers: ServerEntry[],
  enabled: boolean,
): { routes: ServerRoutes; refresh: () => void } {
  const [routes, setRoutes] = useState<ServerRoutes>({});
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce(value => value + 1), []);

  // La firma resume lo que obliga a volver a sondear. El token no entra: no
  // cambia si la máquina responde, y meterlo forzaría un sondeo por tecla
  // mientras lo pegas en Ajustes.
  const signature = servers
    .map(s => `${s.id}|${s.localUrl}|${s.remoteUrl}|${s.mode}`)
    .join(';');

  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Arranca con la ruta que funcionó la última vez, sin esperar a la sonda.
     *
     * Sondear cuesta un viaje de ida y vuelta antes de poder pedir la primera
     * sesión, y en el caso normal —misma red que la última vez— ese viaje solo
     * confirma lo que ya sabíamos. Se apuesta por lo recordado y se deja que la
     * sonda corrija en segundo plano si la apuesta era mala.
     */
    const optimistic = async () => {
      let remembered: Record<string, RoutePath> = {};
      try {
        const raw = await AsyncStorage.getItem(LAST_ROUTES_KEY);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          remembered = parsed as Record<string, RoutePath>;
        }
      } catch {
        // Sin memoria se sondea a ciegas, como antes.
      }
      if (cancelled) {
        return;
      }
      setRoutes(previous => {
        const next: Record<string, ServerRoute> = { ...previous };
        for (const server of serversRef.current) {
          if (next[server.id]?.baseUrl) {
            continue;
          }
          const path = server.mode === 'auto' ? remembered[server.id] : server.mode;
          const url = path === 'remote' ? server.remoteUrl : server.localUrl;
          if (path === undefined || url.length === 0) {
            continue;
          }
          next[server.id] = {
            server,
            baseUrl: url,
            token: server.token,
            path,
            latencyMs: null,
            isProbing: true,
          };
        }
        return next;
      });
    };

    const run = async () => {
      const current = serversRef.current;

      setRoutes(previous => {
        const next: Record<string, ServerRoute> = {};
        for (const server of current) {
          const before = previous[server.id];
          next[server.id] = {
            server,
            baseUrl: before?.baseUrl ?? '',
            token: server.token,
            path: before?.path ?? null,
            latencyMs: before?.latencyMs ?? null,
            isProbing: true,
          };
        }
        return next;
      });

      // En paralelo: un servidor caído tarda 1,5 s en rendirse y en serie
      // esos tiempos se suman antes de poder pintar nada.
      const results = await Promise.all(
        current.map(async server => ({ server, ...(await resolve(server)) })),
      );
      if (cancelled) {
        return;
      }

      const next: Record<string, ServerRoute> = {};
      for (const item of results) {
        next[item.server.id] = {
          server: item.server,
          baseUrl: item.baseUrl,
          token: item.server.token,
          path: item.path,
          latencyMs: item.latencyMs,
          isProbing: false,
        };
      }
      setRoutes(next);

      // Se guarda la ruta ganadora para que el próximo arranque no empiece a
      // ciegas. Solo las que respondieron: recordar un fallo no sirve de nada.
      const won: Record<string, RoutePath> = {};
      for (const item of results) {
        if (item.path !== null) {
          won[item.server.id] = item.path;
        }
      }
      AsyncStorage.setItem(LAST_ROUTES_KEY, JSON.stringify(won)).catch(() => {
        // Perder la memoria solo cuesta una sonda en el próximo arranque.
      });

      timer = setTimeout(run, RECHECK_MS);
    };

    // La apuesta primero y la sonda a la vez: no se espera a la una para la
    // otra, así que la lista puede empezar a cargarse en el primer milisegundo.
    optimistic();
    run();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [signature, enabled, nonce]);

  return { routes, refresh };
}
