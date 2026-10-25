import { ServerError } from './client';
import { fetchPreferences, parsePreferences, type Preferences } from './preferences';
import { fetchSessions, parseSessionList } from './sessions';
import type { SessionSummary } from './types';

/** Lo que el Home necesita de UNA máquina. */
export interface HomeData {
  readonly sessions: SessionSummary[];
  readonly preferences: Preferences;
}

const TIMEOUT_MS = 8_000;

interface Cached {
  readonly etag: string;
  readonly data: HomeData;
}

/** Última respuesta por máquina, para mandar `If-None-Match` y reusarla en 304. */
const lastByUrl = new Map<string, Cached>();

/** Bridges que aún no tienen `/mobile/home`: se les pregunta a la antigua. */
const legacy = new Set<string>();

/** Petición en vuelo por máquina: la lista y las preferencias la comparten. */
const inflight = new Map<string, Promise<HomeData>>();

/**
 * Cuánto vale una respuesta recién llegada. El Home pide las preferencias en
 * cuanto le llega la lista; sin esto serían dos viajes seguidos por lo mismo.
 */
const FRESH_MS = 2_000;
const recent = new Map<string, { readonly at: number; readonly data: HomeData }>();

/** Tras escribir algo: la próxima lectura tiene que ir a la red. */
export function invalidateHome() {
  recent.clear();
}

async function fetchCompact(
  baseUrl: string,
  token: string,
  serverId: string,
): Promise<HomeData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const cached = lastByUrl.get(baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token.trim().length > 0) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  if (cached !== undefined) {
    headers['If-None-Match'] = cached.etag;
  }
  try {
    const response = await fetch(`${baseUrl}/mobile/home`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304 && cached !== undefined) {
      return cached.data;
    }
    if (response.status === 404) {
      legacy.add(baseUrl);
      return null;
    }
    if (response.status === 401) {
      throw new ServerError('Token inválido o ausente');
    }
    if (!response.ok) {
      throw new ServerError(`El servidor respondió HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      sessions?: unknown;
      preferences?: unknown;
    };
    const data: HomeData = {
      sessions: parseSessionList(body.sessions, serverId),
      preferences: parsePreferences(body.preferences),
    };
    const etag = response.headers.get('etag');
    if (etag !== null) {
      lastByUrl.set(baseUrl, { etag, data });
    }
    return data;
  } catch (error) {
    if (error instanceof ServerError) {
      throw error;
    }
    throw new ServerError('No se pudo alcanzar el servidor');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sesiones y preferencias de una máquina en UNA petición.
 *
 * `/mobile/home` las trae recortadas a lo que la app lee, comprimidas y con
 * ETag: ~55 KB en vez de ~465 KB, y un 304 vacío si nada cambió. Con un bridge
 * que todavía no lo tiene se cae a `/sessions` + `/preferences`, como antes.
 *
 * Llamarla dos veces a la vez comparte la misma petición: la lista y las
 * preferencias se recargan juntas y no deben costar dos viajes.
 */
export function fetchHome(
  baseUrl: string,
  token: string,
  serverId: string,
): Promise<HomeData> {
  const running = inflight.get(baseUrl);
  if (running !== undefined) {
    return running;
  }
  const fresh = recent.get(baseUrl);
  if (fresh !== undefined && Date.now() - fresh.at < FRESH_MS) {
    return Promise.resolve(fresh.data);
  }
  const run = (async () => {
    if (!legacy.has(baseUrl)) {
      const compact = await fetchCompact(baseUrl, token, serverId);
      if (compact !== null) {
        return compact;
      }
    }
    const [sessions, preferences] = await Promise.all([
      fetchSessions(baseUrl, token, serverId),
      fetchPreferences(baseUrl, token),
    ]);
    return { sessions, preferences };
  })();
  inflight.set(baseUrl, run);
  run.then(
    data => {
      inflight.delete(baseUrl);
      recent.set(baseUrl, { at: Date.now(), data });
    },
    () => inflight.delete(baseUrl),
  );
  return run;
}
