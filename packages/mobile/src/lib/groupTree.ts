import type { TabGroup } from '../api/preferences';

/**
 * Clave con la que se funden los grupos de varias máquinas.
 *
 * Un grupo de primer nivel se identifica por su nombre normalizado, igual que
 * siempre (así no se pierden los plegados ni los anclados guardados). Un
 * subgrupo lleva delante la clave de su padre: dos proyectos pueden tener cada
 * uno su «code reviews», y fundirlos solo por nombre los mezclaría.
 *
 * Devuelve id → clave para los grupos de UNA máquina. Un grupo sin nombre, o
 * cuyo padre no existe o forma un ciclo, sube al primer nivel o se descarta.
 */
export function groupKeys(groups: TabGroup[]): Map<string, string> {
  const byId = new Map(groups.map(group => [group.id, group]));
  const keys = new Map<string, string>();

  const keyOf = (group: TabGroup, seen: Set<string>): string | null => {
    const cached = keys.get(group.id);
    if (cached !== undefined) {
      return cached;
    }
    const name = group.name.trim().toLowerCase();
    if (name.length === 0) {
      return null;
    }
    const parent =
      group.parentId !== null && !seen.has(group.parentId)
        ? byId.get(group.parentId)
        : undefined;
    seen.add(group.id);
    const parentKey = parent === undefined ? null : keyOf(parent, seen);
    const key = parentKey === null ? name : `${parentKey}/${name}`;
    keys.set(group.id, key);
    return key;
  };

  for (const group of groups) {
    keyOf(group, new Set());
  }
  return keys;
}

/** El `tabGroupMap` de UNA máquina, ya traducido a claves de fusión. */
export interface ServerGroupMap {
  readonly serverId: string;
  /** sessionId crudo → clave de grupo. */
  readonly map: Record<string, string>;
}

/**
 * A qué grupo va cada sesión, con la misma regla que el escritorio.
 *
 * El escritorio guarda en SUS preferencias el grupo de las sesiones de sus
 * remotos (arrastrar una sesión de ryzen9 a una carpeta escribe en el
 * `tabGroupMap` de la Mac, no en el de ryzen9), y esa entrada manda sobre la
 * que tenga el propio dueño. Mirar solo el mapa del dueño dejaba esas sesiones
 * en el grupo viejo o sin grupo.
 *
 * Una entrada ajena solo cuenta si esa máquina no tiene una sesión con ese id:
 * si no, un choque de ids metería una sesión en la carpeta de otra.
 *
 * Devuelve `session.key` (`servidor:id`) → clave de grupo.
 */
export function resolveGroups(
  sessions: ReadonlyArray<{
    readonly key: string;
    readonly id: string;
    readonly serverId: string;
  }>,
  maps: ReadonlyArray<ServerGroupMap>,
): Record<string, string> {
  const owned = new Map<string, Set<string>>();
  for (const session of sessions) {
    const ids = owned.get(session.serverId);
    if (ids === undefined) {
      owned.set(session.serverId, new Set([session.id]));
    } else {
      ids.add(session.id);
    }
  }

  const out: Record<string, string> = {};
  for (const session of sessions) {
    let own: string | undefined;
    let foreign: string | undefined;
    for (const { serverId, map } of maps) {
      const key = map[session.id];
      if (key === undefined) {
        continue;
      }
      if (serverId === session.serverId) {
        own = key;
      } else if (
        foreign === undefined &&
        owned.get(serverId)?.has(session.id) !== true
      ) {
        foreign = key;
      }
    }
    const key = foreign ?? own;
    if (key !== undefined) {
      out[session.key] = key;
    }
  }
  return out;
}

/**
 * Las máquinas que guardan una entrada ajena para alguna de estas sesiones.
 * Mover una sesión tiene que borrar esas entradas: si no, siguen mandando y el
 * cambio no se ve ni aquí ni en el escritorio.
 *
 * Devuelve serverId → ids crudos a limpiar en esa máquina.
 */
export function foreignEntries(
  sessions: ReadonlyArray<{ readonly id: string; readonly serverId: string }>,
  /** Todas las sesiones conocidas, para no tocar una ajena con el mismo id. */
  all: ReadonlyArray<{ readonly id: string; readonly serverId: string }>,
  maps: ReadonlyArray<ServerGroupMap>,
): Map<string, string[]> {
  const owners = new Set(all.map(session => `${session.serverId}:${session.id}`));
  const out = new Map<string, string[]>();
  for (const session of sessions) {
    for (const { serverId, map } of maps) {
      if (
        serverId === session.serverId ||
        map[session.id] === undefined ||
        owners.has(`${serverId}:${session.id}`)
      ) {
        continue;
      }
      out.set(serverId, [...(out.get(serverId) ?? []), session.id]);
    }
  }
  return out;
}

/** ¿`key` es `ancestor` o cuelga de él? Las claves son rutas `padre/hijo`. */
export function isWithin(key: string, ancestor: string): boolean {
  return key === ancestor || key.startsWith(`${ancestor}/`);
}

/**
 * Los grupos de UNA máquina ya con claves de fusión: `id` y `parentId` pasan a
 * ser claves, y el subgrupo sin color toma el de su ancestro más cercano.
 */
export function keyedGroups(groups: TabGroup[]): TabGroup[] {
  const keys = groupKeys(groups);
  const byId = new Map(groups.map(group => [group.id, group]));

  const colorOf = (group: TabGroup): string => {
    let current: TabGroup | undefined = group;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      if (current.color.length > 0) {
        return current.color;
      }
      seen.add(current.id);
      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return 'slate';
  };

  return groups.flatMap(group => {
    const key = keys.get(group.id);
    if (key === undefined) {
      return [];
    }
    const parentKey =
      group.parentId === null ? undefined : keys.get(group.parentId);
    return [
      {
        id: key,
        name: group.name,
        color: colorOf(group),
        parentId: parentKey ?? null,
      },
    ];
  });
}
