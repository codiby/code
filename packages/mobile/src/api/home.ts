import { ServerError, requestJson } from './client';
import { fetchPreferences, parsePreferences, type Preferences } from './preferences';
import { fetchSessions, parseSessionList } from './sessions';
import type { SessionSummary } from './types';

/** Lo que el Home necesita de UNA máquina. */
export interface HomeData {
  readonly sessions: SessionSummary[];
  readonly preferences: Preferences;
  /** Identidad de la máquina (`host_…`); `null` si no se pudo saber. */
  readonly hostId: string | null;
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
      throw new ServerError('Invalid or missing token');
    }
    if (!response.ok) {
      throw new ServerError(`The server responded with HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      sessions?: unknown;
      preferences?: unknown;
      hostId?: unknown;
    };
    const data: HomeData = {
      sessions: parseSessionList(body.sessions, serverId),
      preferences: parsePreferences(body.preferences),
      hostId: typeof body.hostId === 'string' ? body.hostId : null,
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
    throw new ServerError('Could not reach the server');
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
        if (compact.preferences.projects !== null && compact.hostId !== null) {
          return compact;
        }
        // Bridge anterior a los proyectos en `/mobile/home`: se completan
        // aparte, sin tirar lo demás si eso falla.
        const extra = await fetchProjectsFallback(baseUrl, token);
        return {
          ...compact,
          hostId: compact.hostId ?? extra.hostId,
          preferences: {
            ...compact.preferences,
            projects: compact.preferences.projects ?? extra.projects,
          },
        };
      }
    }
    const [sessions, preferences, host] = await Promise.all([
      fetchSessions(baseUrl, token, serverId),
      fetchPreferences(baseUrl, token),
      fetchHostId(baseUrl, token).catch(() => null),
    ]);
    return { sessions, preferences, hostId: host };
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

/**
 * Proyectos y máquina de un bridge que no los manda en `/mobile/home`. Se
 * guardan un rato: `/preferences` pesa ~90 KB y casi nunca cambia.
 */
const FALLBACK_MS = 5 * 60_000;
const fallbackCache = new Map<
  string,
  {
    readonly at: number;
    readonly hostId: string | null;
    readonly projects: Preferences['projects'];
  }
>();

async function fetchProjectsFallback(
  baseUrl: string,
  token: string,
): Promise<{ hostId: string | null; projects: Preferences['projects'] }> {
  const cached = fallbackCache.get(baseUrl);
  if (cached !== undefined && Date.now() - cached.at < FALLBACK_MS) {
    return cached;
  }
  const [hostId, prefs] = await Promise.all([
    fetchHostId(baseUrl, token).catch(() => null),
    fetchPreferences(baseUrl, token).catch(() => null),
  ]);
  const entry = {
    at: Date.now(),
    hostId,
    projects: prefs?.projects ?? null,
  };
  fallbackCache.set(baseUrl, entry);
  return entry;
}

/** `GET /host`: la identidad estable de la máquina. */
function fetchHostId(baseUrl: string, token: string): Promise<string | null> {
  return requestJson(
    baseUrl,
    '/host',
    body => {
      const hostId = (body as { hostId?: unknown } | null)?.hostId;
      return typeof hostId === 'string' && hostId.length > 0 ? hostId : null;
    },
    token,
  );
}
