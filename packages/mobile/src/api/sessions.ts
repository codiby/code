import { ServerError, requestJson } from './client';
import type { HealthResponse, SessionSummary } from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function basename(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

function toSessionSummary(
  value: unknown,
  serverId: string,
): SessionSummary | null {
  const raw = asRecord(value);
  if (raw === null) {
    return null;
  }

  const { id, name, cwd, updated_at: updatedAt } = raw;
  if (typeof id !== 'string' || typeof name !== 'string') {
    return null;
  }

  const cwdText = typeof cwd === 'string' ? cwd : '';

  return {
    id,
    serverId,
    key: `${serverId}:${id}`,
    name,
    cwd: cwdText,
    folder: basename(cwdText),
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    isOpen: raw.status === 'open',
    isRunning: raw.runtime_status === 'running',
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    disposableTtlMs:
      typeof raw.disposable_ttl_ms === 'number' ? raw.disposable_ttl_ms : null,
  };
}

export function fetchHealth(baseUrl: string): Promise<HealthResponse> {
  return requestJson(baseUrl, '/health', body => {
    const raw = asRecord(body);
    if (
      raw === null ||
      typeof raw.status !== 'string' ||
      typeof raw.sessions !== 'number'
    ) {
      throw new ServerError('Respuesta inesperada en /health');
    }
    return { status: raw.status, sessions: raw.sessions };
  });
}

/** Lo que hay que decidir para abrir una sesión. */
export interface NewSession {
  readonly cwd: string;
  /** Vacío deja que el bridge la numere («Session 12»). */
  readonly name: string;
  readonly provider: string;
  /** `null` = el modelo por defecto del proveedor. */
  readonly model: string | null;
  /** El bridge archiva la sesión después de este tiempo sin actividad. */
  readonly disposableTtlMs?: number;
}

/**
 * Abre una sesión en esa máquina y devuelve la fila ya lista para la lista.
 *
 * El bridge arranca el proveedor de forma síncrona, así que un 503 aquí
 * significa que el CLI no existe o no pudo lanzarse — no un fallo de red.
 */
export function createSession(
  baseUrl: string,
  token: string,
  serverId: string,
  draft: NewSession,
): Promise<SessionSummary> {
  return requestJson(
    baseUrl,
    '/sessions',
    body => {
      const session = toSessionSummary(body, serverId);
      if (session === null) {
        throw new ServerError('El servidor no devolvió la sesión creada');
      }
      return session;
    },
    token,
    {
      method: 'POST',
      body: {
        cwd: draft.cwd,
        // Campos vacíos fuera: el bridge distingue ausente de cadena vacía y
        // mandar `name: ''` le quitaría su propio nombre por defecto.
        ...(draft.name.length > 0 ? { name: draft.name } : {}),
        provider: draft.provider,
        ...(draft.model !== null ? { model: draft.model } : {}),
        ...(draft.disposableTtlMs !== undefined
          ? { disposable_ttl_ms: draft.disposableTtlMs }
          : {}),
      },
    },
  );
}

export function renameSession(
  baseUrl: string,
  token: string,
  sessionId: string,
  name: string,
): Promise<void> {
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}`,
    () => undefined,
    token,
    { method: 'PATCH', body: { name } },
  );
}

/**
 * Archivar es reversible: solo cambia `status`. El mismo endpoint sirve para
 * desarchivar pasando `'open'`.
 */
export function setSessionStatus(
  baseUrl: string,
  token: string,
  sessionId: string,
  status: 'open' | 'archived',
): Promise<void> {
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}`,
    () => undefined,
    token,
    { method: 'PATCH', body: { status } },
  );
}

/**
 * Borra la sesión del bridge. Sin `?purge=1`, el historial en disco se
 * conserva — se elige a propósito el menos destructivo de los dos.
 */
export function deleteSession(
  baseUrl: string,
  token: string,
  sessionId: string,
): Promise<void> {
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}`,
    () => undefined,
    token,
    { method: 'DELETE' },
  );
}

/** Devuelve las sesiones ordenadas por actividad reciente, como un chat. */
export function fetchSessions(
  baseUrl: string,
  token: string,
  serverId: string,
): Promise<SessionSummary[]> {
  return requestJson(
    baseUrl,
    '/sessions',
    body => parseSessionList(body, serverId),
    token,
  );
}

/** La lista de `/sessions` o la de `/mobile/home`, que traen la misma forma. */
export function parseSessionList(
  body: unknown,
  serverId: string,
): SessionSummary[] {
  if (!Array.isArray(body)) {
    throw new ServerError('Respuesta inesperada en /sessions');
  }
  // Una sesión malformada se descarta sin tumbar la lista entera.
  return body
    .map(item => toSessionSummary(item, serverId))
    .filter((session): session is SessionSummary => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface ServerFetch {
  readonly id: string;
  readonly baseUrl: string;
  readonly token: string;
}

export interface MergedSessions {
  readonly sessions: SessionSummary[];
  /** Ids de los servidores que no contestaron, para poder avisarlo. */
  readonly failed: string[];
}

/**
 * Pide a todos los servidores a la vez y funde el resultado en una sola lista
 * ordenada por actividad.
 *
 * Un servidor caído no puede tumbar la pantalla entera: cada petición se
 * resuelve por separado y las que fallen solo aportan su id a `failed`.
 */
export async function fetchAllSessions(
  targets: ServerFetch[],
  /** Quién trae la lista de una máquina; el Home usa `/mobile/home`. */
  fetchOne: (
    baseUrl: string,
    token: string,
    serverId: string,
  ) => Promise<SessionSummary[]> = fetchSessions,
): Promise<MergedSessions> {
  const results = await Promise.all(
    targets.map(async target => {
      if (target.baseUrl.length === 0) {
        return { id: target.id, sessions: null };
      }
      try {
        return {
          id: target.id,
          sessions: await fetchOne(target.baseUrl, target.token, target.id),
        };
      } catch {
        return { id: target.id, sessions: null };
      }
    }),
  );

  const sessions: SessionSummary[] = [];
  const failed: string[] = [];
  for (const result of results) {
    if (result.sessions === null) {
      failed.push(result.id);
    } else {
      sessions.push(...result.sessions);
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions, failed };
}
