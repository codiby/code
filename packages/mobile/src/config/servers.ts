import { DEFAULT_HOST, DEFAULT_PORT } from '../api/client';

/** Por dónde está entrando la app a un servidor ahora mismo. */
export type RoutePath = 'local' | 'remote';

/**
 * Qué ruta usar. `auto` prueba la local y cae a la de internet; las otras dos
 * existen para cuando la heurística estorba — por ejemplo, forzar el respaldo
 * mientras depuras el Funnel aunque la local responda.
 */
export type RouteMode = 'auto' | RoutePath;

export interface ServerEntry {
  readonly id: string;
  readonly name: string;
  /** Dirección en la red local. Acepta `ip:puerto` o una URL completa. */
  readonly localUrl: string;
  /** Dirección alcanzable desde fuera. Vacía = sin respaldo. */
  readonly remoteUrl: string;
  /** Token del bridge; es el mismo para las dos rutas. */
  readonly token: string;
  /** Nombre de color de la paleta, para la etiqueta de cada fila. */
  readonly color: ServerColor;
  readonly mode: RouteMode;
}

export const SERVER_COLORS = [
  'green',
  'violet',
  'amber',
  'blue',
  'pink',
  'cyan',
] as const;

export type ServerColor = (typeof SERVER_COLORS)[number];

/** Mismos tonos que usa el escritorio para los remotes. */
export const SERVER_HEX: Record<ServerColor, string> = {
  green: '#15803d',
  violet: '#7c3aed',
  amber: '#b45309',
  blue: '#1d4ed8',
  pink: '#be185d',
  cyan: '#0e7490',
};

export function colorHex(color: string): string {
  return SERVER_HEX[color as ServerColor] ?? SERVER_HEX.green;
}

/**
 * Punto de estado de una ruta. Van como constantes y no como objeto en el JSX
 * porque un literal ahí dentro se recrea en cada render y además dispara
 * `react-native/no-inline-styles`.
 */
export const ROUTE_DOT = {
  local: { backgroundColor: '#10b981' },
  remote: { backgroundColor: '#f59e0b' },
  down: { backgroundColor: '#f43f5e' },
} as const;

export type RouteDotKey = keyof typeof ROUTE_DOT;

/** Traduce el estado de una ruta a la clave del punto y a su etiqueta. */
export function routeState(
  hasUrl: boolean,
  path: RoutePath | null,
  isProbing: boolean,
): { readonly dot: RouteDotKey; readonly label: string } {
  if (!hasUrl) {
    return { dot: 'down', label: isProbing ? 'probando' : 'caído' };
  }
  return path === 'remote'
    ? { dot: 'remote', label: 'internet' }
    : { dot: 'local', label: 'local' };
}

/**
 * Normaliza lo que escribiste a una URL utilizable.
 *
 * `192.168.3.40:3111` y `https://algo.ts.net:10000` son ambas válidas: la
 * primera se completa con `http://`, la segunda se respeta tal cual porque el
 * Funnel publica en 443 con certificado y el esquema no es negociable.
 */
export function normalizeUrl(value: string, fallbackPort = DEFAULT_PORT): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return /:\d+$/.test(trimmed)
    ? `http://${trimmed}`
    : `http://${trimmed}:${fallbackPort}`;
}

/** Para la línea de resumen: `ryzen9…ts.net:10000` en vez de la URL entera. */
export function shortUrl(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//, '');
  return withoutScheme.length > 30
    ? `${withoutScheme.slice(0, 14)}…${withoutScheme.slice(-14)}`
    : withoutScheme;
}

let counter = 0;

/**
 * `crypto.randomUUID` no existe en Hermes y no vale la pena un polyfill para
 * esto: el id solo tiene que ser único dentro de la lista guardada.
 */
export function newServerId(): string {
  counter += 1;
  return `srv_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function emptyServer(index: number): ServerEntry {
  return {
    id: newServerId(),
    name: '',
    localUrl: '',
    remoteUrl: '',
    token: '',
    color: SERVER_COLORS[index % SERVER_COLORS.length]!,
    mode: 'auto',
  };
}

function asString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function parseServer(value: unknown, index: number): ServerEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = asString(raw, 'id');
  if (id.length === 0) {
    return null;
  }
  const mode = asString(raw, 'mode');
  const color = asString(raw, 'color');
  return {
    id,
    name: asString(raw, 'name'),
    localUrl: asString(raw, 'localUrl'),
    remoteUrl: asString(raw, 'remoteUrl'),
    token: asString(raw, 'token'),
    color: (SERVER_COLORS as readonly string[]).includes(color)
      ? (color as ServerColor)
      : SERVER_COLORS[index % SERVER_COLORS.length]!,
    mode: mode === 'local' || mode === 'remote' ? mode : 'auto',
  };
}

export function parseServers(raw: string | null): ServerEntry[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const servers = parsed
      .map((item, index) => parseServer(item, index))
      .filter((item): item is ServerEntry => item !== null);
    return servers.length > 0 ? servers : null;
  } catch {
    return null;
  }
}

/**
 * Convierte la config vieja de un solo servidor en la lista nueva.
 *
 * Sin esto, actualizar la app dejaría la pantalla vacía y habría que volver a
 * teclear la IP y los 64 caracteres del token en el celular.
 */
export function migrateLegacy(raw: string | null): ServerEntry[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { host, port, token } = parsed as Record<string, unknown>;
    if (typeof host !== 'string' || host.length === 0) {
      return null;
    }
    const resolvedPort = typeof port === 'number' ? port : DEFAULT_PORT;
    return [
      {
        id: newServerId(),
        name: host.replace(/^https?:\/\//, '').split(/[.:]/)[0] || 'Servidor',
        localUrl: normalizeUrl(host, resolvedPort),
        remoteUrl: '',
        token: typeof token === 'string' ? token : '',
        color: 'green',
        mode: 'auto',
      },
    ];
  } catch {
    return null;
  }
}

export const DEFAULT_SERVERS: ServerEntry[] = [
  {
    id: newServerId(),
    name: 'Local',
    localUrl: normalizeUrl(DEFAULT_HOST, DEFAULT_PORT),
    remoteUrl: '',
    token: '',
    color: 'green',
    mode: 'auto',
  },
];
