/**
 * En el emulador de Android, 10.0.2.2 es el alias del loopback del host. El
 * bridge escucha en 127.0.0.1, así que desde un dispositivo físico hay que
 * apuntar a la IP LAN de la máquina (y que el bridge escuche en 0.0.0.0).
 */
export const DEFAULT_HOST = '10.0.2.2';
export const DEFAULT_PORT = 3111;

const REQUEST_TIMEOUT_MS = 8_000;

export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

/**
 * Acepta dos formas de `host`:
 *
 * - `192.168.3.161` — se le pega `http://` y el puerto, como siempre.
 * - `https://algo.ts.net` — se usa tal cual y el puerto se ignora.
 *
 * La segunda existe por el Funnel de Tailscale: publica en el 443 con
 * certificado válido, así que la URL no lleva puerto y el esquema no es
 * negociable. Forzar `http://host:puerto` no podía expresarla.
 */
export function buildBaseUrl(host: string, port: number): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}:${port}`;
}

/**
 * `authCheck` acepta el token por query string; negociar por
 * Sec-WebSocket-Protocol falla porque el servidor no lo devuelve en el
 * handshake y el cliente de Android aborta la conexión.
 */
export function toSocketUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/^http/, 'ws');
  const trimmed = token.trim();
  return trimmed.length > 0
    ? `${base}/ws?t=${encodeURIComponent(trimmed)}`
    : `${base}/ws`;
}

/**
 * GET con timeout que normaliza cualquier fallo a `ServerError`, para que las
 * pantallas nunca tengan que distinguir entre un abort, un DNS caído y un 500.
 *
 * El bridge trata como confiable cualquier petición cuyo header `Host` sea
 * loopback; desde el emulador el Host es 10.0.2.2, así que todo lo que no sea
 * `/health` exige el token móvil de `~/.codiby/ui-mobile-token`.
 */
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  parse: (body: unknown) => T,
  token: string = '',
  init: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** Por defecto 8 s; un envío con imágenes por una red lenta necesita más. */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token.trim().length > 0) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    if (response.status === 401) {
      throw new ServerError('Token inválido o ausente');
    }
    if (!response.ok) {
      throw new ServerError(`El servidor respondió HTTP ${response.status}`);
    }

    return parse(await response.json());
  } catch (error) {
    if (error instanceof ServerError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServerError(`Sin respuesta en ${timeoutMs / 1000} s`);
    }
    throw new ServerError('No se pudo alcanzar el servidor');
  } finally {
    clearTimeout(timeout);
  }
}
