import { ServerError, requestJson } from './client';

export interface SessionResource {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  /** Ruta relativa al bridge, ya con el `/raw`. */
  readonly url: string;
}

function toResource(value: unknown): SessionResource | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    mime: typeof raw.mime === 'string' ? raw.mime : 'application/octet-stream',
    size: typeof raw.size === 'number' ? raw.size : 0,
    url:
      typeof raw.url === 'string'
        ? raw.url
        : `/sessions/${raw.sessionId as string}/resources/${raw.id}/raw`,
  };
}

/**
 * Recursos de una sesión: mockups, imágenes, archivos subidos. `kind` filtra
 * del lado del servidor.
 */
export function fetchResources(
  baseUrl: string,
  token: string,
  sessionId: string,
  kind?: string,
): Promise<SessionResource[]> {
  const query = kind === undefined ? '' : `?kind=${encodeURIComponent(kind)}`;
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/resources${query}`,
    body => {
      const list = Array.isArray(body)
        ? body
        : typeof body === 'object' && body !== null
          ? ((body as Record<string, unknown>).resources ?? [])
          : [];
      if (!Array.isArray(list)) {
        throw new ServerError('Respuesta inesperada en /resources');
      }
      return list
        .map(toResource)
        .filter((item): item is SessionResource => item !== null);
    },
    token,
  );
}

/**
 * URL absoluta del contenido. El token va en la query y no en una cabecera
 * porque el WebView también la usa para las peticiones que dispare la propia
 * página, y esas no heredarían las cabeceras del documento.
 */
export function resourceUrl(
  baseUrl: string,
  resource: SessionResource,
  token: string,
): string {
  const trimmed = token.trim();
  const separator = resource.url.includes('?') ? '&' : '?';
  return trimmed.length > 0
    ? `${baseUrl}${resource.url}${separator}t=${encodeURIComponent(trimmed)}`
    : `${baseUrl}${resource.url}`;
}
