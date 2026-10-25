import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncShareSessions } from '../lib/shareTargets';

import type { TabGroup } from './preferences';
import type { SessionSummary } from './types';
import type { ServerGroupMap } from '../lib/groupTree';

/**
 * Lo último que enseñó el Home, guardado en el teléfono.
 *
 * Es lo que permite pintar la lista en el primer fotograma: sin ella, abrir la
 * app esperaba a sondear las rutas, a `/sessions` y a `/preferences` de cada
 * máquina — segundos por el Funnel — con la pantalla vacía. Con ella se pinta
 * lo de la última vez y la red solo corrige lo que haya cambiado.
 */
export interface HomeSnapshot {
  readonly sessions: SessionSummary[];
  readonly groups: TabGroup[];
  readonly serverMaps: ServerGroupMap[];
  readonly pinnedIds: string[];
  readonly pinnedGroups: string[];
  /** clave de sesión → resumen, con el `updatedAt` para el que vale. */
  readonly previews: Record<
    string,
    { readonly at: number; readonly text: string }
  >;
}

const KEY = 'codiby.home-snapshot.v1';

/** Escribir no corre prisa y la lista cambia a ráfagas: se agrupa. */
const SAVE_DELAY_MS = 1_500;

function parse(raw: string | null): HomeSnapshot | null {
  if (raw === null) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<HomeSnapshot> | null;
    if (value === null || !Array.isArray(value.sessions)) {
      return null;
    }
    return {
      sessions: value.sessions,
      groups: Array.isArray(value.groups) ? value.groups : [],
      serverMaps: Array.isArray(value.serverMaps) ? value.serverMaps : [],
      pinnedIds: Array.isArray(value.pinnedIds) ? value.pinnedIds : [],
      pinnedGroups: Array.isArray(value.pinnedGroups) ? value.pinnedGroups : [],
      previews:
        typeof value.previews === 'object' && value.previews !== null
          ? value.previews
          : {},
    };
  } catch {
    return null;
  }
}

/**
 * La lectura sale al importar el módulo, no al montar el Home: así corre en
 * paralelo con la carga de la config de servidores y con el primer render.
 */
let loaded: HomeSnapshot | null | undefined;

const pending: Promise<HomeSnapshot | null> = AsyncStorage.getItem(KEY)
  .then(parse)
  .catch(() => null)
  .then(value => {
    loaded = value;
    if (value) {
      syncShareSessions(value).catch(() => undefined);
    }
    return value;
  });

export function loadHomeSnapshot(): Promise<HomeSnapshot | null> {
  return pending;
}

/**
 * La foto si ya se terminó de leer; `undefined` si no. Sirve para el estado
 * inicial: montar con ella evita un fotograma en blanco esperando a la promesa.
 */
export function peekHomeSnapshot(): HomeSnapshot | null | undefined {
  return loaded;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let latest: HomeSnapshot | null = null;

export function saveHomeSnapshot(snapshot: HomeSnapshot) {
  latest = snapshot;
  syncShareSessions(snapshot).catch(() => undefined);
  if (timer !== null) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    if (latest === null) {
      return;
    }
    AsyncStorage.setItem(KEY, JSON.stringify(latest)).catch(() => {
      // Perderla solo cuesta que el próximo arranque espere a la red.
    });
  }, SAVE_DELAY_MS);
}
