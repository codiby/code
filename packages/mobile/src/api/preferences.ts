import { ServerError, requestJson } from './client';

export interface TabGroup {
  readonly id: string;
  readonly name: string;
  /**
   * Nombre de color del escritorio: `green`, `violet`, `amber`… Vacío en un
   * subgrupo sin color propio, que hereda el de su padre (`groupTree`).
   */
  readonly color: string;
  /** Grupo padre, o `null` en uno de primer nivel. */
  readonly parentId: string | null;
}

export interface Preferences {
  readonly groups: TabGroup[];
  /** sessionId → groupId */
  readonly groupBySession: Record<string, string>;
  readonly pinnedIds: string[];
  /**
   * Grupos anclados de esta máquina, en orden de anclaje. `null` si el bridge
   * nunca guardó ninguno: distinguirlo de `[]` es lo que permite migrar una
   * sola vez lo que el teléfono tenía en local.
   */
  readonly pinnedGroupIds: string[] | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function fetchPreferences(
  baseUrl: string,
  token: string,
): Promise<Preferences> {
  return requestJson(baseUrl, '/preferences', parsePreferences, token);
}

/** Lo mismo que devuelve `/preferences`, venga de ahí o de `/mobile/home`. */
export function parsePreferences(body: unknown): Preferences {
  const prefs = asRecord(body);

  const groups: TabGroup[] = Object.entries(asRecord(prefs.tabGroups))
    .map(([id, raw]) => {
      const group = asRecord(raw);
      const parentId =
        typeof group.parentId === 'string' && group.parentId.length > 0
          ? group.parentId
          : null;
      return {
        id,
        name: typeof group.name === 'string' ? group.name : id,
        color:
          typeof group.color === 'string'
            ? group.color
            : parentId === null
            ? 'slate'
            : '',
        parentId,
      };
    })
    .filter(group => group.name.length > 0);

  const groupBySession: Record<string, string> = {};
  for (const [sessionId, groupId] of Object.entries(
    asRecord(prefs.tabGroupMap),
  )) {
    if (typeof groupId === 'string') {
      groupBySession[sessionId] = groupId;
    }
  }

  const pinnedIds = Array.isArray(prefs.pinnedSessionIds)
    ? prefs.pinnedSessionIds.filter(
        (id): id is string => typeof id === 'string',
      )
    : [];

  const pinnedGroupIds = Array.isArray(prefs.pinnedGroupIds)
    ? prefs.pinnedGroupIds.filter((id): id is string => typeof id === 'string')
    : null;

  return { groups, groupBySession, pinnedIds, pinnedGroupIds };
}

/**
 * `PUT /preferences` mezcla por clave (`Object.assign` en el bridge), así que
 * mandar solo los anclados no toca los grupos ni el resto de la configuración.
 * El servidor difunde el cambio por WebSocket, así que el escritorio se entera.
 */
export function savePinned(
  baseUrl: string,
  token: string,
  pinnedIds: string[],
): Promise<void> {
  return requestJson(
    baseUrl,
    '/preferences',
    body => {
      if (asRecord(body).ok !== true) {
        throw new ServerError('El servidor rechazó el cambio');
      }
      return undefined;
    },
    token,
    { method: 'PUT', body: { pinnedSessionIds: pinnedIds } },
  );
}

/**
 * Guarda los grupos anclados de UNA máquina, con sus propios ids. Viven en el
 * bridge para que todos los dispositivos que lo usan los vean igual.
 */
export function savePinnedGroups(
  baseUrl: string,
  token: string,
  pinnedGroupIds: string[],
): Promise<void> {
  return requestJson(
    baseUrl,
    '/preferences',
    body => {
      if (asRecord(body).ok !== true) {
        throw new ServerError('El servidor rechazó el cambio');
      }
      return undefined;
    },
    token,
    { method: 'PUT', body: { pinnedGroupIds } },
  );
}

/** Igual que `fetchPreferences` pero sin interpretar: hace falta para reenviar
 *  tal cual lo que no se toca. */
function fetchRawPreferences(
  baseUrl: string,
  token: string,
): Promise<Record<string, unknown>> {
  return requestJson(baseUrl, '/preferences', body => asRecord(body), token);
}

/** UUID v4 a mano: Hermes no trae `crypto.randomUUID`. */
function uuid(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

export interface MoveResult {
  /** Nombre del grupo tal cual quedó, para poder confirmarlo. */
  readonly groupName: string | null;
}

/** Tonos con los que el escritorio pinta los grupos que crea solo. */
export const AUTOGROUP_COLORS = [
  'blue',
  'green',
  'amber',
  'violet',
  'red',
  'pink',
] as const;

export interface GroupAssignment {
  readonly name: string;
  /** Ids **de esta máquina**, ya filtrados por quien llama. */
  readonly sessionIds: string[];
}

/**
 * Reparte varias sesiones entre varios grupos de UNA máquina, de una sentada.
 *
 * Es `moveSessionsToGroup` repetido, salvo por lo único que importa: un solo
 * ciclo leer-modificar-escribir. Llamar a aquella en bucle haría que cada
 * vuelta releyera las preferencias y reenviara el `tabGroupMap` entero, así que
 * dos escrituras encadenadas podrían pisarse; y con un grupo por proyecto son
 * muchas vueltas contra el mismo archivo.
 */
export async function applyGrouping(
  baseUrl: string,
  token: string,
  assignments: GroupAssignment[],
): Promise<void> {
  const prefs = await fetchRawPreferences(baseUrl, token);
  const rawGroups: Record<string, unknown> = { ...asRecord(prefs.tabGroups) };
  const map: Record<string, unknown> = { ...asRecord(prefs.tabGroupMap) };

  /** nombre normalizado → id, para reutilizar lo que la máquina ya tiene. */
  const byName = new Map<string, string>();
  for (const [id, raw] of Object.entries(rawGroups)) {
    const name = asRecord(raw).name;
    if (typeof name === 'string') {
      byName.set(name.trim().toLowerCase(), id);
    }
  }

  let created = 0;
  for (const assignment of assignments) {
    if (assignment.sessionIds.length === 0) {
      continue;
    }
    const wanted = assignment.name.trim();
    let groupId = byName.get(wanted.toLowerCase());
    if (groupId === undefined) {
      groupId = uuid();
      // El color rota por orden de creación, como en el escritorio: da variedad
      // sin que dos grupos seguidos salgan del mismo tono.
      const color =
        AUTOGROUP_COLORS[created % AUTOGROUP_COLORS.length] ?? 'blue';
      rawGroups[groupId] = { id: groupId, name: wanted, color };
      byName.set(wanted.toLowerCase(), groupId);
      created += 1;
    }
    for (const sessionId of assignment.sessionIds) {
      map[sessionId] = groupId;
    }
  }

  await requestJson(
    baseUrl,
    '/preferences',
    body => {
      if (asRecord(body).ok !== true) {
        throw new ServerError('El servidor rechazó el cambio');
      }
      return undefined;
    },
    token,
    // `tabGroups` va entero y con los objetos originales intactos, por lo mismo
    // que en `moveSessionsToGroup`: cada grupo guarda además `cwd`, `portless`
    // y `envVars`, y reconstruirlo desde lo que la app parsea los borraría.
    { method: 'PUT', body: { tabGroupMap: map, tabGroups: rawGroups } },
  );
}

/**
 * Mueve sesiones de UNA máquina a un grupo, creándolo si no lo tiene.
 *
 * Dos cuidados que no son opcionales:
 *
 * 1. `tabGroupMap` se reenvía **entero**. El bridge hace `Object.assign` al
 *    nivel superior, así que mandar solo las sesiones movidas dejaría a todas
 *    las demás sin grupo.
 * 2. `tabGroups` solo se manda si hay que crear uno, y con los objetos
 *    originales intactos. Cada grupo guarda además `cwd`, `portless` y
 *    `envVars`; reconstruirlo desde lo que la app parsea los borraría.
 */
export async function moveSessionsToGroup(
  baseUrl: string,
  token: string,
  sessionIds: string[],
  /** `null` los saca del grupo en el que estén. */
  groupName: string | null,
  color: string,
): Promise<MoveResult> {
  const prefs = await fetchRawPreferences(baseUrl, token);
  const rawGroups = asRecord(prefs.tabGroups);
  const map: Record<string, unknown> = { ...asRecord(prefs.tabGroupMap) };

  let groupId: string | null = null;
  let created: Record<string, unknown> | null = null;

  if (groupName !== null) {
    const wanted = groupName.trim().toLowerCase();
    for (const [id, raw] of Object.entries(rawGroups)) {
      const name = asRecord(raw).name;
      if (typeof name === 'string' && name.trim().toLowerCase() === wanted) {
        groupId = id;
        break;
      }
    }
    if (groupId === null) {
      groupId = uuid();
      created = {
        ...rawGroups,
        [groupId]: { id: groupId, name: groupName.trim(), color },
      };
    }
  }

  for (const sessionId of sessionIds) {
    if (groupId === null) {
      delete map[sessionId];
    } else {
      map[sessionId] = groupId;
    }
  }

  await requestJson(
    baseUrl,
    '/preferences',
    body => {
      if (asRecord(body).ok !== true) {
        throw new ServerError('El servidor rechazó el cambio');
      }
      return undefined;
    },
    token,
    {
      method: 'PUT',
      body:
        created === null
          ? { tabGroupMap: map }
          : { tabGroupMap: map, tabGroups: created },
    },
  );

  return { groupName };
}
