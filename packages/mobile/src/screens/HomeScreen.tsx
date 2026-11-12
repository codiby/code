import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { planAutoGroup } from '../api/autoGroup';
import { fetchHome, invalidateHome } from '../api/home';
import {
  loadHomeSnapshot,
  peekHomeSnapshot,
  saveHomeSnapshot,
  type HomeSnapshot,
} from '../api/homeSnapshot';
import {
  applyGrouping,
  moveSessionsToGroup,
  savePinned,
  savePinnedGroups,
  type GroupAssignment,
  type ProjectDef,
  type TabGroup,
} from '../api/preferences';
import {
  deleteSession,
  fetchAllSessions,
  parseSessionList,
  renameSession,
  setSessionStatus,
} from '../api/sessions';
import type { SessionSummary } from '../api/types';
import { useRequest } from '../api/useRequest';
import { useSockets } from '../api/SocketProvider';
import { useLiveSessions, type LiveTarget } from '../api/useLiveSessions';
import { usePrefetchChats } from '../api/usePrefetchChats';
import { useSessionPreviews } from '../api/useSessionPreviews';
import {
  ArchiveIcon,
  ChevronDownIcon,
  CloseIcon,
  MoreIcon,
  MoveToGroupIcon,
  PinIcon,
  PlusIcon,
  RenameDialog,
  RenameIcon,
  SearchIcon,
  SessionRow,
  SessionRowSeparator,
  TrashIcon,
} from '../components/SessionList';
import { UsageIndicator } from '../components/UsageIndicator';
import { useServers } from '../config/ServerConfigContext';
import { colorHex, ROUTE_DOT, routeState } from '../config/servers';
import type { Drafts } from '../lib/drafts';
import {
  foreignEntries,
  groupKeys,
  isWithin,
  keyedGroups,
  resolveGroups,
  type ServerGroupMap,
} from '../lib/groupTree';
import { HomeMenu } from './HomeMenu';
import { MoveToGroupSheet } from './MoveToGroupSheet';
import { NewSessionSheet } from './NewSessionSheet';
import { ProjectPickerSheet, type ProjectOption } from './ProjectPickerSheet';
import { ServerSheet } from './ServerSheet';
import { useInk } from '../theme';

/** Alto de la GlassTabBar flotante más su separación. */
const TAB_BAR_CLEARANCE = 120;

/** Nombres de color del escritorio a hex. */
const GROUP_COLORS: Record<string, string> = {
  green: '#15803d',
  violet: '#7c3aed',
  pink: '#be185d',
  amber: '#b45309',
  red: '#be123c',
  blue: '#1d4ed8',
  cyan: '#0e7490',
  slate: '#64748b',
};

interface ChipProps {
  readonly label: string;
  readonly isActive: boolean;
  readonly onPress: () => void;
  readonly color?: string;
}

function Chip({ label, isActive, onPress, color }: ChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      style={isActive ? undefined : CHIP_SHADOW}
      className={`h-[30px] flex-row items-center gap-[5px] rounded-[15px] px-[13px] active:opacity-70 ${
        isActive ? 'bg-accent' : 'bg-white'
      }`}
    >
      {color !== undefined ? (
        <View
          style={{ backgroundColor: color }}
          className="h-2 w-2 rounded-full"
        />
      ) : null}
      <Text
        className={`text-[12px] ${
          isActive ? 'font-semibold text-on-accent' : 'font-medium text-slate-500'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * El `+` del encabezado, a la derecha de la búsqueda.
 *
 * Relleno y no fantasma como los otros dos iconos: es la única acción que
 * crea algo, y un tercer contorno gris junto a la lupa y los puntos se perdía
 * entre ellos.
 */
function NewSessionButton({ onPress }: { readonly onPress: () => void }) {
  const ink = useInk();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New session"
      onPress={onPress}
      className="h-[34px] w-[34px] items-center justify-center rounded-full bg-slate-100 active:opacity-70"
    >
      <PlusIcon size={17} color={ink('#0b7d5c')} />
    </Pressable>
  );
}

const ACCENTS: Record<string, string> = {
  á: 'a',
  é: 'e',
  í: 'i',
  ó: 'o',
  ú: 'u',
  ü: 'u',
  ñ: 'n',
};

/**
 * Minúsculas y sin acentos, para que «bugf» encuentre «BUG-F58» y «sesion»
 * encuentre «Sesión».
 *
 * El plegado va a mano en vez de con `String.normalize('NFD')`: Hermes no
 * garantiza esa API, y fallar aquí dejaría el buscador sin encontrar nada.
 */
function fold(text: string): string {
  let out = '';
  for (const char of text.toLowerCase()) {
    out += ACCENTS[char] ?? char;
  }
  return out;
}

interface GroupChipProps {
  readonly chip: GroupChip;
  readonly isActive: boolean;
  readonly onPress: () => void;
  /** `null` en «Sin grupo», que no se ancla. */
  readonly onLongPress: (() => void) | null;
}

/**
 * Chip de un grupo. Lo que NUNCA se esconde es cuántas están trabajando: si
 * algo está pasando ahí dentro hay que verlo sin elegir el grupo.
 *
 * Mantener pulsado ancla el grupo: va primero en la fila y así se guarda en el
 * bridge, igual para todos los dispositivos.
 */
function GroupChipButton({
  chip,
  isActive,
  onPress,
  onLongPress,
}: GroupChipProps) {
  const ink = useInk();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chip.title}, ${chip.count} ${chip.count === 1 ? 'session' : 'sessions'}${
        chip.isPinned ? ', pinned' : ''
      }`}
      accessibilityHint={
        onLongPress === null
          ? undefined
          : chip.isPinned
            ? 'Long-press to unpin'
            : 'Long-press to pin'
      }
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      onLongPress={onLongPress ?? undefined}
      style={isActive ? undefined : CHIP_SHADOW}
      className={`h-[30px] flex-row items-center gap-[5px] rounded-[15px] px-[13px] active:opacity-70 ${
        isActive ? 'bg-accent' : 'bg-white'
      }`}
    >
      {chip.depth > 0 ? (
        // Marca de subgrupo: en una sola fila, es lo que dice que cuelga del
        // chip de la izquierda.
        <Text className={`text-[11px] ${isActive ? 'text-on-accent' : 'text-slate-400'}`}>
          {'↳'}
        </Text>
      ) : null}
      {chip.isPinned ? (
        <PinIcon size={11} color={isActive ? ink('#ffffff') : ink('#6a707a')} />
      ) : null}
      <View
        style={chip.color === null ? UNGROUPED_DOT : { backgroundColor: chip.color }}
        className="h-2 w-2 rounded-full"
      />
      <Text
        numberOfLines={1}
        className={`max-w-[160px] text-[12px] ${
          isActive ? 'font-semibold text-on-accent' : 'font-medium text-slate-500'
        }`}
      >
        {chip.title}
      </Text>
      <Text
        className={`text-[10.5px] font-bold opacity-75 ${
          isActive ? 'text-on-accent' : 'text-slate-500'
        }`}
      >
        {chip.count}
      </Text>
      {chip.working > 0 ? (
        <View className="h-1.5 w-1.5 rounded-full bg-[#19c37d]" />
      ) : null}
    </Pressable>
  );
}

/** Sombra de 1 px de los chips sin elegir, la misma de la app de chats. */
const CHIP_SHADOW = { boxShadow: '0px 1px 2px rgba(13, 15, 18, 0.06)' } as const;

/** Punto de «Sin grupo». Fuera del JSX por `no-inline-styles`. */
const UNGROUPED_DOT = { backgroundColor: '#94a3b8' } as const;

export interface HomeScreenProps {
  readonly onOpenSession: (session: SessionSummary) => void;
  readonly drafts: Drafts;
}

/**
 * «Todas» son las activas: es lo que uno está trabajando. Lo archivado es un
 * cajón aparte, no un superconjunto.
 */
type Filter = { readonly kind: 'active' } | { readonly kind: 'archived' };

/** Sección que no es un grupo del escritorio y tiene sitio fijo. */
const UNGROUPED_KEY = '__ungrouped';

/** Qué chips de grupo dejaste elegidos. Es de este teléfono, no del proyecto. */
const GROUP_FILTER_KEY = 'codiby.group-filter';

/**
 * Proyecto elegido en el encabezado (clave de un grupo de primer nivel). Sin
 * guardar = «All projects», que es como abre la primera vez.
 */
const PROJECT_KEY = 'codiby.project';

/** Dónde guarda el teléfono los últimos proyectos, para pintar el título al abrir. */
const PROJECT_DEFS_KEY = 'codiby.project-defs';

const trimSlash = (path: string) =>
  path.length > 1 ? path.replace(/[\\/]+$/, '') : path;

/**
 * El proyecto de una sesión, con la regla del escritorio (`project-scope`):
 * corre dentro de una de sus carpetas, en la máquina de esa carpeta. Si dos
 * encajan, gana la carpeta más larga: un proyecto anidado manda sobre el que
 * lo rodea (`~/src/codiby` dentro de `~/`).
 */
function projectOf(
  cwd: string,
  hostId: string | null,
  defs: readonly ProjectDef[],
): string | null {
  const path = trimSlash(cwd);
  if (path.length === 0 || hostId === null) {
    return null;
  }
  let best: { id: string; length: number } | null = null;
  for (const def of defs) {
    for (const folder of def.folders) {
      if (folder.hostId !== hostId) {
        continue;
      }
      const inside =
        path === folder.path ||
        path.startsWith(`${folder.path}/`) ||
        path.startsWith(`${folder.path}\\`);
      if (inside && (best === null || folder.path.length > best.length)) {
        best = { id: def.id, length: folder.path.length };
      }
    }
  }
  return best?.id ?? null;
}

/** Sección de la lista: un grupo dentro del proyecto, o la lista entera. */
interface SessionSection {
  readonly key: string;
  /** `null` = sin encabezado (vista «All projects»). */
  readonly title: string | null;
  readonly count: number;
  readonly data: SessionSummary[];
}

/**
 * Dónde guardaba el teléfono los grupos anclados antes de que pasaran al
 * bridge (`pinnedGroupIds`). Solo se lee una vez, para migrarlos.
 */
const LEGACY_PINNED_GROUPS_KEY = 'codiby.pinned-groups';

/** Lo que cada máquina respondió, para traducir claves de grupo a sus ids. */
interface ServerGroups {
  readonly baseUrl: string;
  readonly token: string;
  readonly groups: TabGroup[];
}

/** Ids de UNA máquina para una lista de claves de grupo, en ese orden. */
function idsForKeys(server: ServerGroups, keys: string[]): string[] {
  const byKey = new Map<string, string[]>();
  for (const [id, key] of groupKeys(server.groups)) {
    byKey.set(key, [...(byKey.get(key) ?? []), id]);
  }
  return keys.flatMap(key => byKey.get(key) ?? []);
}

interface GroupChip {
  readonly key: string;
  readonly title: string;
  /** `null` en «Sin grupo», que no tiene color de grupo. */
  readonly color: string | null;
  /** Sesiones del grupo con sus subgrupos, dentro del filtro de estado. */
  readonly count: number;
  readonly working: number;
  readonly isPinned: boolean;
  /** 0 en el primer nivel; los subgrupos se marcan en la fila. */
  readonly depth: number;
}

const ACTIVE_FILTER: Filter = { kind: 'active' };

export function HomeScreen({ onOpenSession, drafts }: HomeScreenProps) {
  const ink = useInk();
  const { servers, routes, isLoaded, refreshRoutes } = useServers();
  // `revision` cambia con cada suscripción o cambio de estado, así que
  // consumir el contexto basta para que la lista se repinte sola.
  const sockets = useSockets();
  const insets = useSafeAreaInsets();

  const [filter, setFilter] = useState<Filter>(ACTIVE_FILTER);
  // Multiselección: el arreglo es la fuente de verdad, y estar vacío es lo
  // que define «no hay modo selección».
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isWorking, setIsWorking] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Chips de grupo elegidos. Vacío = sin filtro, se ve todo. */
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  /** Id del proyecto del escritorio que se está viendo; `null` = todos. */
  const [project, setProject] = useState<string | null>(null);
  /** `null` hasta que algún bridge los mande. */
  const [projectDefs, setProjectDefs] = useState<ProjectDef[] | null>(null);
  /** serverId → identidad de su máquina, para casar carpetas de proyecto. */
  const [hostByServer, setHostByServer] = useState<
    Record<string, string | null>
  >({});
  const [isPickingProject, setIsPickingProject] = useState(false);
  /** Secciones plegadas dentro del proyecto. Solo en memoria. */
  const [collapsed, setCollapsed] = useState<string[]>([]);
  /**
   * Grupos anclados, **en orden de anclaje**: la posición en el arreglo es el
   * dato, no un adorno. Cada bridge guarda los suyos; aquí van por nombre
   * normalizado, igual que `groups`.
   */
  const [pinnedGroups, setPinnedGroups] = useState<string[]>([]);
  const [serverGroups, setServerGroups] = useState<ServerGroups[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [serverMaps, setServerMaps] = useState<ServerGroupMap[]>([]);
  const prefsSeq = useRef(0);
  /** Si ya llegaron las preferencias de verdad: la foto no las pisa. */
  const hasLivePrefs = useRef(false);
  /**
   * Lo que enseñó el Home la última vez. `undefined` mientras se lee (unos
   * milisegundos), `null` si no había nada guardado.
   */
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null | undefined>(
    peekHomeSnapshot,
  );

  useEffect(() => {
    let cancelled = false;
    loadHomeSnapshot().then(saved => {
      if (cancelled) {
        return;
      }
      setSnapshot(saved);
      if (saved !== null && !hasLivePrefs.current) {
        setGroups(saved.groups);
        setServerMaps(saved.serverMaps);
        setPinnedIds(saved.pinnedIds);
        setPinnedGroups(saved.pinnedGroups);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Servidores con ruta viva, que son a los que tiene sentido preguntar. */
  const reachable = useMemo(
    () =>
      servers
        .map(server => routes[server.id])
        .filter(
          (route): route is NonNullable<typeof route> =>
            route !== undefined && route.baseUrl.length > 0,
        ),
    [servers, routes],
  );

  const reachableKey = reachable
    .map(route => `${route.server.id}|${route.baseUrl}`)
    .join(';');

  const load = useCallback(
    () =>
      fetchAllSessions(
        reachable.map(route => ({
          id: route.server.id,
          baseUrl: route.baseUrl,
          token: route.token,
        })),
        (baseUrl, token, serverId) =>
          fetchHome(baseUrl, token, serverId).then(home => home.sessions),
      ),
    // `reachableKey` resume lo que de verdad cambia la petición; `reachable`
    // se recrea en cada render y reharía la carga sin parar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reachableKey],
  );

  const { state, refresh: refreshList } = useRequest(
    load,
    isLoaded && reachable.length > 0,
  );

  /** Recargar tras un cambio no puede reutilizar la respuesta de antes. */
  const refresh = useCallback(() => {
    invalidateHome();
    refreshList();
  }, [refreshList]);

  /**
   * Cada bridge guarda sus propias preferencias, así que hay que preguntarle a
   * todos y fundir.
   *
   * Los grupos se funden por **nombre**, no por id: cada máquina crea sus
   * grupos por su cuenta, así que «utilityprofit» tiene un UUID distinto en
   * cada una y fundir por id dejaba dos chips con el mismo nombre. El id
   * sintético que se usa aquí es el propio nombre normalizado, así que el
   * filtro por grupo sigue funcionando sin cambios.
   */
  const loadPreferences = useCallback(() => {
    if (!isLoaded || reachable.length === 0) {
      return;
    }
    const seq = ++prefsSeq.current;
    const hostIds: Record<string, string | null> = {};
    Promise.all(
      reachable.map(route =>
        // Misma petición que la lista (`fetchHome` la comparte): una sola
        // ida y vuelta por máquina trae las dos cosas.
        fetchHome(route.baseUrl, route.token, route.server.id)
          .then(home => {
            hostIds[route.server.id] = home.hostId;
            return home.preferences;
          })
          .catch(() => null),
      ),
    ).then(results => {
      // Se recarga tras cada refresco de la lista: una respuesta lenta de una
      // carga vieja no puede pisar a una más nueva.
      if (seq !== prefsSeq.current) {
        return;
      }
      // `results` va en el mismo orden que `reachable`, así que el índice dice
      // de qué servidor viene cada bloque de preferencias.
      const serverIdAt = (index: number) => reachable[index]?.server.id ?? '';
      const byName = new Map<string, TabGroup>();
      /** id original de cada servidor → clave compartida por nombre. */
      const idToKey = new Map<string, string>();
      const pinned: string[] = [];
      const pinnedGroupKeys: string[] = [];
      let hasServerPins = false;
      const answered: ServerGroups[] = [];

      // Primera pasada: todos los grupos de todas las máquinas. Tiene que
      // completarse antes de traducir las sesiones, porque una sesión de un
      // servidor puede apuntar a un grupo que solo se vio en otro.
      for (const [index, prefs] of results.entries()) {
        if (prefs === null) {
          continue;
        }
        const serverId = serverIdAt(index);
        for (const [id, key] of groupKeys(prefs.groups)) {
          idToKey.set(id, key);
        }
        for (const group of keyedGroups(prefs.groups)) {
          // Gana el primero en aparecer: el color es cosmético y no vale la
          // pena resolver el conflicto cuando dos máquinas lo tienen distinto.
          if (!byName.has(group.id)) {
            byName.set(group.id, group);
          }
        }
        pinned.push(...prefs.pinnedIds.map(id => `${serverId}:${id}`));
        answered.push({
          baseUrl: reachable[index]?.baseUrl ?? '',
          token: reachable[index]?.token ?? '',
          groups: prefs.groups,
        });
      }

      // Anclados en el orden de la primera máquina que los tenga; las demás
      // solo añaden los que falten.
      for (const prefs of results) {
        if (prefs === null || prefs.pinnedGroupIds === null) {
          continue;
        }
        hasServerPins = true;
        for (const id of prefs.pinnedGroupIds) {
          const key = idToKey.get(id);
          if (key !== undefined && !pinnedGroupKeys.includes(key)) {
            pinnedGroupKeys.push(key);
          }
        }
      }

      // Cada mapa se guarda con su máquina y sin cruzarlo todavía con las
      // sesiones: el escritorio guarda aquí también las de sus remotos, y cuál
      // manda se decide en `resolveGroups`, cuando ya se sabe de quién es cada
      // sesión.
      const maps: ServerGroupMap[] = [];
      for (const [index, prefs] of results.entries()) {
        if (prefs === null) {
          continue;
        }
        const map: Record<string, string> = {};
        for (const [sessionId, groupId] of Object.entries(
          prefs.groupBySession,
        )) {
          const key = idToKey.get(groupId);
          if (key !== undefined) {
            map[sessionId] = key;
          }
        }
        maps.push({ serverId: serverIdAt(index), map });
      }

      // Proyectos: cada máquina guarda una copia de los suyos; gana la versión
      // más nueva de cada uno.
      const projectById = new Map<string, ProjectDef>();
      let sawProjects = false;
      for (const prefs of results) {
        if (prefs === null || prefs.projects === null) {
          continue;
        }
        sawProjects = true;
        for (const def of prefs.projects) {
          const known = projectById.get(def.id);
          if (known === undefined || def.updatedAt > known.updatedAt) {
            projectById.set(def.id, def);
          }
        }
      }
      if (sawProjects) {
        setProjectDefs([...projectById.values()]);
      }
      setHostByServer(current => ({ ...current, ...hostIds }));

      hasLivePrefs.current = true;
      setGroups([...byName.values()]);
      setServerMaps(maps);
      setPinnedIds(pinned);
      setServerGroups(answered);

      if (hasServerPins) {
        setPinnedGroups(pinnedGroupKeys);
        return;
      }
      // Ningún bridge guardó anclados todavía: subir los que el teléfono tenía
      // en local, una sola vez.
      AsyncStorage.getItem(LEGACY_PINNED_GROUPS_KEY)
        .then(raw => {
          const legacy: unknown = JSON.parse(raw ?? 'null');
          if (!Array.isArray(legacy)) {
            return;
          }
          const keys = legacy.filter(
            (key): key is string => typeof key === 'string',
          );
          setPinnedGroups(keys);
          return Promise.all(
            answered.map(server =>
              savePinnedGroups(
                server.baseUrl,
                server.token,
                idsForKeys(server, keys),
              ),
            ),
          ).then(() => AsyncStorage.removeItem(LEGACY_PINNED_GROUPS_KEY));
        })
        .catch(() => {
          // Se reintenta en la próxima carga: la clave local sigue ahí.
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachableKey, isLoaded]);

  // Las preferencias se vuelven a pedir cada vez que llega la lista (al abrir,
  // al tirar para refrescar y cuando el socket avisa de un cambio): sin eso, lo
  // que se agrupaba en el escritorio no llegaba al teléfono hasta reiniciarlo.
  useEffect(loadPreferences, [loadPreferences, state.data]);

  // Se lee una vez al montar; a partir de ahí manda el estado en memoria.
  useEffect(() => {
    AsyncStorage.getItem(GROUP_FILTER_KEY)
      .then(raw => {
        const saved: unknown = JSON.parse(raw ?? 'null');
        if (Array.isArray(saved)) {
          setSelectedGroups(
            saved.filter((key): key is string => typeof key === 'string'),
          );
        }
      })
      .catch(() => {
        // Sin memoria, sin filtro: es el estado inofensivo.
      });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(PROJECT_KEY)
      .then(raw => {
        if (raw !== null && raw.length > 0) {
          setProject(raw);
        }
      })
      .catch(() => {
        // Sin memoria se abre en «All projects».
      });
  }, []);

  /**
   * Cambiar de proyecto deja los chips en «All»: los subgrupos elegidos del
   * anterior no existen en el nuevo y dejarían la lista vacía sin motivo.
   */
  const chooseProject = useCallback((key: string | null) => {
    setIsPickingProject(false);
    setProject(key);
    setSelectedGroups([]);
    setCollapsed([]);
    AsyncStorage.removeItem(GROUP_FILTER_KEY).catch(() => undefined);
    (key === null
      ? AsyncStorage.removeItem(PROJECT_KEY)
      : AsyncStorage.setItem(PROJECT_KEY, key)
    ).catch(() => {
      // Perderlo solo cuesta abrir en «All projects» la próxima vez.
    });
  }, []);

  /**
   * Tocar un chip lo suma o lo quita del filtro. Tocar un subgrupo con su padre
   * elegido no suma nada, estrecha: `visibleGroups` se queda con lo más
   * profundo de cada rama.
   */
  const toggleGroupFilter = useCallback((key: string) => {
    setSelectedGroups(current => {
      const next = current.includes(key)
        ? // Quitar un grupo quita también los subgrupos elegidos dentro.
          current.filter(other => !isWithin(other, key))
        : [...current, key];
      AsyncStorage.setItem(GROUP_FILTER_KEY, JSON.stringify(next)).catch(() => {
        // Perderlo solo cuesta que el próximo arranque salga sin filtro.
      });
      return next;
    });
  }, []);

  const clearGroupFilter = useCallback(() => {
    setSelectedGroups([]);
    AsyncStorage.removeItem(GROUP_FILTER_KEY).catch(() => undefined);
  }, []);

  /**
   * Anclar añade al final: el que ancles ahora queda debajo de los que ya
   * estaban, que es lo que uno espera al ir anclando de uno en uno.
   *
   * Cada máquina recibe solo los ids de sus grupos. Una que no respondió en la
   * última carga no está en `serverGroups` y conserva lo que tenía, así que una
   * desconexión pasajera no le borra los anclados.
   */
  const toggleGroupPin = useCallback(
    (key: string) => {
      const next = pinnedGroups.includes(key)
        ? pinnedGroups.filter(other => other !== key)
        : [...pinnedGroups, key];
      setPinnedGroups(next);
      for (const server of serverGroups) {
        savePinnedGroups(
          server.baseUrl,
          server.token,
          idsForKeys(server, next),
        ).catch(() => {
          // Perderlo solo cuesta que la próxima carga lo muestre sin anclar.
        });
      }
    },
    [pinnedGroups, serverGroups],
  );

  // Mientras la red no contesta se pinta la foto: la lista de la última vez es
  // mejor que una pantalla vacía, y la red corrige en cuanto llega.
  const fetched = useMemo(
    () => state.data?.sessions ?? snapshot?.sessions ?? [],
    [state.data, snapshot],
  );

  /**
   * Listas que el bridge empujó por el socket después de la última lectura.
   * Mandan sobre lo leído de esa máquina hasta la próxima lectura completa.
   */
  const [pushed, setPushed] = useState<Record<string, SessionSummary[]>>({});
  useEffect(() => setPushed({}), [state.data]);

  const onSessionList = useCallback((serverId: string, list: unknown[]) => {
    try {
      const sessions = parseSessionList(list, serverId);
      setPushed(current => ({ ...current, [serverId]: sessions }));
    } catch {
      // Una trama rara no tumba la lista: se queda la última buena.
    }
  }, []);

  const rawAll = useMemo(() => {
    const pushedIds = Object.keys(pushed);
    if (pushedIds.length === 0) {
      return fetched;
    }
    return [
      ...fetched.filter(item => !pushedIds.includes(item.serverId)),
      ...pushedIds.flatMap(id => pushed[id] ?? []),
    ];
  }, [fetched, pushed]);

  /** Un socket por servidor, vigilando solo sus sesiones activas. */
  const liveTargets = useMemo<LiveTarget[]>(
    () =>
      reachable.map(route => ({
        id: route.server.id,
        sessionIds: rawAll
          .filter(item => item.serverId === route.server.id && item.isOpen)
          .map(item => item.id),
      })),
    [reachable, rawAll],
  );

  const live = useLiveSessions(
    liveTargets,
    isLoaded && state.data !== null,
    refresh,
    onSessionList,
  );

  /**
   * La lista con la hora de cada sesión al día. Un mensaje por el socket la
   * sube a su sitio sin pedir nada a la red.
   */
  const all = useMemo(
    () =>
      rawAll.map(item => {
        const at = live[item.key]?.lastAt ?? null;
        const sentAt = live[item.key]?.lastSentAt ?? null;
        const updatedAt = at !== null && at > item.updatedAt ? at : item.updatedAt;
        const lastSentAt =
          sentAt !== null && sentAt > item.lastSentAt ? sentAt : item.lastSentAt;
        return updatedAt === item.updatedAt && lastSentAt === item.lastSentAt
          ? item
          : { ...item, updatedAt, lastSentAt };
      }),
    [rawAll, live],
  );
  const failedIds = useMemo(() => state.data?.failed ?? [], [state.data]);

  /** Servidor de cada sesión, para la etiqueta y para saber a quién pedirle. */
  const serverOf = useCallback(
    (session: SessionSummary) => servers.find(s => s.id === session.serverId),
    [servers],
  );

  const routeOf = useCallback(
    (session: SessionSummary) => routes[session.serverId],
    [routes],
  );

  const groupBySession = useMemo(
    () => resolveGroups(all, serverMaps),
    [all, serverMaps],
  );

  /** clave de sesión → id de su proyecto (las que no son de ninguno, fuera). */
  const projectBySession = useMemo(() => {
    const out: Record<string, string> = {};
    if (projectDefs === null) {
      return out;
    }
    for (const item of all) {
      const id = projectOf(item.cwd, hostByServer[item.serverId] ?? null, projectDefs);
      if (id !== null) {
        out[item.key] = id;
      }
    }
    return out;
  }, [all, projectDefs, hostByServer]);

  /** Los proyectos ya llegaron y se sabe la máquina de cada servidor. */
  const canScope =
    projectDefs !== null &&
    Object.values(hostByServer).some(hostId => hostId !== null);

  /**
   * Lo que de verdad filtra: de cada rama elegida, lo más profundo. Con
   * «utilityprofit» y su «Out of cycle» elegidos se ve solo el subgrupo; con
   * «utilityprofit» solo, el grupo entero con sus subgrupos.
   */
  const visibleGroups = useMemo(
    () =>
      selectedGroups.filter(
        key =>
          !selectedGroups.some(
            other => other !== key && isWithin(other, key),
          ),
      ),
    [selectedGroups],
  );

  /** Filtradas por estado y búsqueda, todavía sin mirar el grupo. */
  const baseSessions = useMemo(() => {
    /** clave de sesión → orden de anclaje (más alto = anclada después). */
    const pinned = new Map(pinnedIds.map((key, index) => [key, index]));
    const needle = fold(query.trim());
    return (
      all
        .filter(session => {
          // La búsqueda se aplica DENTRO del filtro activo, no lo sustituye: si
          // estás en «Archivadas», buscar no debería sacarte de ahí sin avisar.
          if (
            needle.length > 0 &&
            !fold(session.name).includes(needle) &&
            !fold(session.folder).includes(needle)
          ) {
            return false;
          }
          // El proyecto del encabezado acota todo lo demás: chips, cuentas
          // y la propia lista solo ven lo que cuelga de él.
          if (
            project !== null &&
            canScope &&
            projectBySession[session.key] !== project
          ) {
            return false;
          }
          if (filter.kind === 'archived') {
            return !session.isOpen;
          }
          if (!session.isOpen) {
            return false;
          }
          return true;
        })
        // Las ancladas suben dentro de su grupo, como en el escritorio: entre
        // ellas, la última que anclaste arriba y ahí se queda; el resto, por
        // actividad. El servidor no entra en el orden: mezclarlos es justo el
        // objetivo.
        .sort((a, b) => {
          const pinA = pinned.get(a.key) ?? -1;
          const pinB = pinned.get(b.key) ?? -1;
          if (pinA !== pinB) {
            return pinB - pinA;
          }
          return b.lastSentAt - a.lastSentAt;
        })
    );
  }, [all, filter, pinnedIds, query, project, projectBySession, canScope]);

  // Un proyecto que se borró o renombró en el escritorio ya no tiene a dónde
  // apuntar: se vuelve a «All projects» en vez de enseñar una lista vacía.
  useEffect(() => {
    if (
      project !== null &&
      projectDefs !== null &&
      !projectDefs.some(def => def.id === project)
    ) {
      chooseProject(null);
    }
  }, [projectDefs, project, chooseProject]);

  // Los proyectos se recuerdan para que el título salga bien al abrir, antes
  // de que conteste la red.
  useEffect(() => {
    AsyncStorage.getItem(PROJECT_DEFS_KEY)
      .then(raw => {
        const saved = JSON.parse(raw ?? 'null') as {
          defs?: unknown;
          hosts?: unknown;
        } | null;
        if (Array.isArray(saved?.defs)) {
          setProjectDefs(current => current ?? (saved.defs as ProjectDef[]));
        }
        if (saved?.hosts !== null && typeof saved?.hosts === 'object') {
          setHostByServer(current => ({
            ...(saved.hosts as Record<string, string | null>),
            ...current,
          }));
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (projectDefs !== null) {
      AsyncStorage.setItem(
        PROJECT_DEFS_KEY,
        JSON.stringify({ defs: projectDefs, hosts: hostByServer }),
      ).catch(() => undefined);
    }
  }, [projectDefs, hostByServer]);

  const sessions = useMemo(() => {
    if (visibleGroups.length === 0) {
      return baseSessions;
    }
    return baseSessions.filter(session => {
      const key = groupBySession[session.key];
      return visibleGroups.some(selected =>
        selected === UNGROUPED_KEY
          ? key === undefined
          : key !== undefined && isWithin(key, selected),
      );
    });
  }, [baseSessions, visibleGroups, groupBySession]);

  const activeCount = useMemo(
    () => all.filter(session => session.isOpen).length,
    [all],
  );

  const archivedCount = all.length - activeCount;

  /** Las cuentas de «All» y «Archived», acotadas al proyecto si hay uno. */
  const scoped = useMemo(() => {
    if (project === null) {
      return { active: activeCount, archived: archivedCount };
    }
    let active = 0;
    let archived = 0;
    for (const item of all) {
      const key = groupBySession[item.key];
      if (key === undefined || !isWithin(key, project)) {
        continue;
      }
      if (item.isOpen) {
        active += 1;
      } else {
        archived += 1;
      }
    }
    return { active, archived };
  }, [all, project, groupBySession, activeCount, archivedCount]);

  const selectedSessions = useMemo(
    () => all.filter(session => selectedIds.includes(session.key)),
    [all, selectedIds],
  );

  const toggleSelection = useCallback((session: SessionSummary) => {
    setSelectedIds(current =>
      current.includes(session.key)
        ? current.filter(key => key !== session.key)
        : [...current, session.key],
    );
  }, []);

  /** Agrupa las elegidas por servidor: cada una va a su propio bridge. */
  const forEachSelected = useCallback(
    (
      action: (baseUrl: string, token: string, id: string) => Promise<unknown>,
    ) =>
      Promise.all(
        selectedSessions.map(session => {
          const route = routes[session.serverId];
          if (route === undefined || route.baseUrl.length === 0) {
            return Promise.resolve();
          }
          return action(route.baseUrl, route.token, session.id);
        }),
      ),
    [selectedSessions, routes],
  );

  const togglePin = useCallback(() => {
    const [only] = selectedIds;
    const session = selectedSessions[0];
    if (only === undefined || session === undefined) {
      return;
    }
    const route = routes[session.serverId];
    if (route === undefined || route.baseUrl.length === 0) {
      return;
    }
    const next = pinnedIds.includes(only)
      ? pinnedIds.filter(id => id !== only)
      : [only, ...pinnedIds];

    setPinnedIds(next);
    setSelectedIds([]);
    // Solo se mandan los anclados de ese servidor: si no, le escribiríamos
    // ids de otras máquinas en sus preferencias.
    // De vuelta a ids crudos y solo los de ese servidor: la clave compuesta
    // es interna de la app, el bridge guarda los suyos.
    const own = all
      .filter(
        item => item.serverId === session.serverId && next.includes(item.key),
      )
      .map(item => item.id);
    savePinned(route.baseUrl, route.token, own).catch(() => {
      loadPreferences();
    });
  }, [selectedIds, selectedSessions, pinnedIds, routes, all, loadPreferences]);

  /** Si todas las elegidas ya están archivadas, la acción es desarchivar. */
  const allArchived =
    selectedSessions.length > 0 && selectedSessions.every(s => !s.isOpen);

  const applyArchive = useCallback(() => {
    const nextStatus = allArchived ? 'open' : 'archived';
    setIsWorking(true);
    forEachSelected((baseUrl, token, id) =>
      setSessionStatus(baseUrl, token, id, nextStatus),
    )
      .catch(() => undefined)
      .finally(() => {
        setIsWorking(false);
        setSelectedIds([]);
        refresh();
      });
  }, [allArchived, forEachSelected, refresh]);

  const applyRename = useCallback(
    (name: string) => {
      setIsWorking(true);
      forEachSelected((baseUrl, token, id) =>
        renameSession(baseUrl, token, id, name),
      )
        .catch(() => undefined)
        .finally(() => {
          setIsWorking(false);
          setIsRenaming(false);
          setSelectedIds([]);
          refresh();
        });
    },
    [forEachSelected, refresh],
  );

  /**
   * Una escritura por máquina: los grupos son de cada bridge, así que mover
   * sesiones de dos servidores son dos peticiones, cada una con los ids que esa
   * máquina conoce.
   */
  const applyMove = useCallback(
    (name: string | null, color: string) => {
      const byServer = new Map<string, string[]>();
      for (const session of selectedSessions) {
        const owned = byServer.get(session.serverId);
        if (owned === undefined) {
          byServer.set(session.serverId, [session.id]);
        } else {
          owned.push(session.id);
        }
      }

      // Lo que otra máquina guardó para estas sesiones (el escritorio anota ahí
      // las de sus remotos) manda sobre el dueño: si no se borra, el cambio se
      // escribe pero nadie lo ve.
      const stale = foreignEntries(selectedSessions, all, serverMaps);

      setIsWorking(true);
      Promise.all([
        ...[...byServer.entries()].map(async ([serverId, ids]) => {
          const route = routes[serverId];
          if (route === undefined || route.baseUrl.length === 0) {
            return serverId;
          }
          try {
            await moveSessionsToGroup(route.baseUrl, route.token, ids, name, color);
            return null;
          } catch {
            return serverId;
          }
        }),
        ...[...stale.entries()].map(async ([serverId, ids]) => {
          const route = routes[serverId];
          if (route === undefined || route.baseUrl.length === 0) {
            return serverId;
          }
          try {
            await moveSessionsToGroup(route.baseUrl, route.token, ids, null, '');
            return null;
          } catch {
            return serverId;
          }
        }),
      ]).then(results => {
        setIsWorking(false);
        setIsMoving(false);
        setSelectedIds([]);
        refresh();
        loadPreferences();

        // Se mueve lo que se pueda y se dice qué no: fallar entero por una
        // máquina caída sería peor que mover la mitad.
        const failed = results.filter((id): id is string => id !== null);
        if (failed.length > 0) {
          const names = failed
            .map(id => servers.find(server => server.id === id)?.name ?? id)
            .join(', ');
          Alert.alert(
            'Only some sessions were moved',
            `Could not write to ${names}. Their sessions stayed where they were.`,
          );
        }
      });
    },
    [selectedSessions, all, serverMaps, routes, servers, refresh, loadPreferences],
  );

  /**
   * Qué haría «Auto agrupar» con lo que hay ahora en pantalla.
   *
   * Se calcula sobre `sessions`, no sobre `all`: manda el filtro visible. Con
   * «Archivadas» son 605, y meterlas en grupos por una acción pensada para las
   * activas sería una escritura enorme que nadie pidió.
   */
  const plan = useMemo(
    () => planAutoGroup(sessions, groupBySession, groups),
    [sessions, groupBySession, groups],
  );

  const applyAutoGroup = useCallback(() => {
    // Una escritura por máquina, con los grupos que a esa máquina le tocan.
    const byServer = new Map<string, GroupAssignment[]>();
    for (const group of plan.groups) {
      const ids = new Map<string, string[]>();
      for (const session of group.sessions) {
        const owned = ids.get(session.serverId);
        if (owned === undefined) {
          ids.set(session.serverId, [session.id]);
        } else {
          owned.push(session.id);
        }
      }
      for (const [serverId, sessionIds] of ids) {
        const bucket = byServer.get(serverId);
        const assignment = { name: group.name, sessionIds };
        if (bucket === undefined) {
          byServer.set(serverId, [assignment]);
        } else {
          bucket.push(assignment);
        }
      }
    }

    setIsWorking(true);
    Promise.all(
      [...byServer.entries()].map(async ([serverId, assignments]) => {
        const route = routes[serverId];
        if (route === undefined || route.baseUrl.length === 0) {
          return serverId;
        }
        try {
          await applyGrouping(route.baseUrl, route.token, assignments);
          return null;
        } catch {
          return serverId;
        }
      }),
    ).then(results => {
      setIsWorking(false);
      setIsMenuOpen(false);
      refresh();
      loadPreferences();

      const failed = results.filter((id): id is string => id !== null);
      if (failed.length > 0) {
        const names = failed
          .map(id => servers.find(server => server.id === id)?.name ?? id)
          .join(', ');
        Alert.alert(
          'Only some sessions were grouped',
          `Could not write to ${names}. Their sessions stayed ungrouped.`,
        );
      }
    });
  }, [plan, routes, servers, refresh, loadPreferences]);

  /**
   * Esto escribe en las preferencias de varias máquinas y no hay deshacer, así
   * que primero se enseña exactamente qué grupos van a salir.
   */
  const confirmAutoGroup = useCallback(() => {
    const lines = plan.groups
      .slice(0, 6)
      .map(
        group =>
          `${group.name} · ${group.sessions.length}${group.exists ? '' : ' (new)'}`,
      );
    if (plan.groups.length > 6) {
      lines.push(`and ${plan.groups.length - 6} more`);
    }
    Alert.alert(
      `Group ${plan.moved} ${plan.moved === 1 ? 'session' : 'sessions'}`,
      lines.join('\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Group', onPress: applyAutoGroup },
      ],
    );
  }, [plan, applyAutoGroup]);

  const confirmDelete = useCallback(() => {
    const count = selectedIds.length;
    // Borrar no se deshace: siempre pasa por confirmación, y el botón
    // destructivo nunca es el que queda bajo el pulgar por defecto.
    Alert.alert(
      count === 1 ? 'Delete session' : `Delete ${count} sessions`,
      count === 1
        ? 'It is removed from the bridge. The history on disk is kept.'
        : 'They are removed from the bridge. The history on disk is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setIsWorking(true);
            forEachSelected((baseUrl, token, id) =>
              deleteSession(baseUrl, token, id),
            )
              .catch(() => undefined)
              .finally(() => {
                setIsWorking(false);
                setSelectedIds([]);
                refresh();
              });
          },
        },
      ],
    );
  }, [selectedIds.length, forEachSelected, refresh]);

  const previews = useSessionPreviews(
    sessions,
    routes,
    isLoaded && state.data !== null,
    snapshot?.previews ?? null,
  );

  usePrefetchChats(baseSessions, routes, isLoaded && state.data !== null);

  // Se guarda lo que se ve, para pintarlo al instante en el próximo arranque.
  // Solo con datos de la red: guardar la propia foto no aporta nada.
  useEffect(() => {
    if (state.data === null || !hasLivePrefs.current) {
      return;
    }
    saveHomeSnapshot({
      sessions: state.data.sessions,
      groups,
      serverMaps,
      pinnedIds,
      pinnedGroups,
      previews,
    });
  }, [state.data, groups, serverMaps, pinnedIds, pinnedGroups, previews]);

  /**
   * Sondear tarda hasta 1,5 s por servidor. Sin contarlo como carga, la
   * pantalla alcanza a pintar «ningún servidor responde» antes de haber
   * preguntado — y luego se corrige sola, que es peor que esperar.
   */
  const isProbing = servers.some(
    server => routes[server.id]?.isProbing ?? true,
  );
  /**
   * Los chips de grupo: los de primer nivel siempre, y debajo los subgrupos de
   * lo que esté elegido. Cuentan sobre lo que deja el estado y la búsqueda, no
   * el propio filtro de grupos: si no, elegir uno pondría los demás a cero.
   *
   * El orden lo manda la actividad, no el alfabeto: el grupo con la sesión más
   * reciente va primero. Los anclados van antes, en el orden en que se
   * anclaron, para que no salten de sitio cada vez que alguien les escribe.
   */
  const chips = useMemo(() => {
    const isBusy = (item: SessionSummary) =>
      live[item.key]?.isStreaming === true || item.isRunning;

    const byGroup = new Map<string, SessionSummary[]>();
    const loose: SessionSummary[] = [];
    for (const item of baseSessions) {
      const groupKey = groupBySession[item.key];
      if (groupKey === undefined) {
        loose.push(item);
        continue;
      }
      byGroup.set(groupKey, [...(byGroup.get(groupKey) ?? []), item]);
    }

    const meta = new Map(groups.map(group => [group.id, group]));
    /** clave del padre (`null` = primer nivel) → claves de sus hijos. */
    const children = new Map<string | null, string[]>();
    const addChild = (parent: string | null, key: string) => {
      children.set(parent, [...(children.get(parent) ?? []), key]);
    };
    for (const group of groups) {
      const parent =
        group.parentId !== null && meta.has(group.parentId)
          ? group.parentId
          : null;
      addChild(parent, group.id);
    }
    // Una sesión que apunta a un grupo que ya no llegó sale como chip de
    // primer nivel con su clave de nombre.
    for (const key of byGroup.keys()) {
      if (!meta.has(key)) {
        addChild(null, key);
      }
    }

    const subtrees = new Map<string, SessionSummary[]>();
    const subtreeOf = (key: string): SessionSummary[] => {
      const cached = subtrees.get(key);
      if (cached !== undefined) {
        return cached;
      }
      subtrees.set(key, []); // corta un ciclo si lo hubiera
      const items = [
        ...(byGroup.get(key) ?? []),
        ...(children.get(key) ?? []).flatMap(subtreeOf),
      ].sort((a, b) => b.lastSentAt - a.lastSentAt);
      subtrees.set(key, items);
      return items;
    };

    const chipOf = (key: string): GroupChip => {
      const subtree = subtreeOf(key);
      const group = meta.get(key);
      return {
        key,
        title: group?.name ?? key,
        color: GROUP_COLORS[group?.color ?? 'slate'] ?? GROUP_COLORS.slate!,
        count: subtree.length,
        working: subtree.filter(isBusy).length,
        isPinned: pinnedGroups.includes(key),
        depth: 0,
      };
    };

    // Un chip elegido no se esconde aunque se quede vacío: si no, no habría
    // cómo quitarlo del filtro.
    const ordered = (keys: string[]) =>
      keys
        .map(key => ({
          key,
          rank: pinnedGroups.indexOf(key),
          lastAt: subtreeOf(key)[0]?.lastSentAt ?? 0,
        }))
        .filter(
          entry =>
            subtreeOf(entry.key).length > 0 ||
            selectedGroups.includes(entry.key),
        )
        .sort((a, b) => {
          if (a.rank !== b.rank) {
            if (a.rank === -1) {
              return 1;
            }
            if (b.rank === -1) {
              return -1;
            }
            return a.rank - b.rank;
          }
          return b.lastAt - a.lastAt;
        })
        .map(entry => chipOf(entry.key));

    // Con un proyecto elegido `baseSessions` ya viene acotada, así que los
    // grupos sin sesiones suyas se caen solos, como en el escritorio.
    const top = ordered(children.get(null) ?? []);
    if (loose.length > 0 || selectedGroups.includes(UNGROUPED_KEY)) {
      top.push({
        key: UNGROUPED_KEY,
        title: 'No group',
        color: null,
        count: loose.length,
        working: loose.filter(isBusy).length,
        isPinned: false,
        depth: 0,
      });
    }

    // Una sola fila: los subgrupos de un grupo elegido salen justo detrás de
    // él, y los de un subgrupo elegido detrás de ese, así que la fila se lee
    // como el árbol sin necesitar otra.
    const row: GroupChip[] = [];
    const walk = (chip: GroupChip) => {
      row.push(chip);
      if (!selectedGroups.includes(chip.key)) {
        return;
      }
      for (const child of ordered(children.get(chip.key) ?? [])) {
        walk({ ...child, depth: chip.depth + 1 });
      }
    };
    for (const chip of top) {
      walk(chip);
    }

    return row;
  }, [
    baseSessions,
    pinnedGroups,
    groupBySession,
    groups,
    selectedGroups,
    live,
  ]);

  /**
   * Proyectos del selector, los del escritorio, con lo que tienen abierto.
   * Cuentan sobre todas las sesiones abiertas, no sobre el proyecto elegido:
   * si no, los demás saldrían vacíos.
   */
  const projects = useMemo<ProjectOption[]>(() => {
    if (projectDefs === null) {
      return [];
    }
    const groupName = new Map(groups.map(group => [group.id, group.name]));
    return projectDefs
      .map(def => {
        const members = all.filter(
          item => item.isOpen && projectBySession[item.key] === def.id,
        );
        /** Grupo de primer nivel → su sesión más reciente, para el orden. */
        const tops = new Map<string, number>();
        for (const item of members) {
          const key = groupBySession[item.key];
          if (key !== undefined) {
            const top = key.split('/')[0] ?? key;
            tops.set(top, Math.max(tops.get(top) ?? 0, item.lastSentAt));
          }
        }
        const hostNames = new Set<string>();
        for (const folder of def.folders) {
          const server = servers.find(
            entry => hostByServer[entry.id] === folder.hostId,
          );
          if (server !== undefined && server.name.length > 0) {
            hostNames.add(server.name);
          }
        }
        return {
          key: def.id,
          title: def.name,
          color: GROUP_COLORS[def.color] ?? GROUP_COLORS.slate!,
          count: members.length,
          working: members.filter(
            item =>
              !live[item.key]?.pendingTool &&
              (live[item.key]?.isStreaming === true || item.isRunning),
          ).length,
          waiting: members.filter(item => !!live[item.key]?.pendingTool).length,
          servers: [...hostNames],
          subgroups: [...tops.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key]) => groupName.get(key) ?? key),
          isPinned: false,
          lastAt: members.reduce((max, item) => Math.max(max, item.lastSentAt), 0),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [projectDefs, all, projectBySession, groupBySession, groups, servers, hostByServer, live]);

  const currentProject = useMemo(
    () => projects.find(entry => entry.key === project) ?? null,
    [projects, project],
  );

  /**
   * Con un proyecto elegido, la lista se parte por sus grupos, en el orden de
   * los chips; lo que no está en ningún grupo va al final. Si todas sus
   * sesiones caen bajo un mismo grupo, se baja un nivel: un proyecto que vive
   * entero en «utilityprofit» se lee por sus subgrupos, no como una sola
   * sección. Sin proyecto es una sola sección sin encabezado: la lista de
   * siempre.
   */
  const sections = useMemo<SessionSection[]>(() => {
    if (project === null) {
      return [{ key: 'all', title: null, count: sessions.length, data: sessions }];
    }
    let level: string | null = null;
    for (;;) {
      const prefix: string | null = level;
      const under = sessions.map(item => groupBySession[item.key]);
      if (under.some(key => key === undefined || key === prefix)) {
        break;
      }
      const next = new Set(
        under.map(key => {
          const rest = prefix === null ? key! : key!.slice(prefix.length + 1);
          const head = rest.split('/')[0]!;
          return prefix === null ? head : `${prefix}/${head}`;
        }),
      );
      if (next.size !== 1) {
        break;
      }
      const only: string = [...next][0]!;
      if (sessions.every(item => groupBySession[item.key] === only)) {
        level = only;
        break;
      }
      level = only;
    }

    const byChild = new Map<string, SessionSummary[]>();
    for (const item of sessions) {
      const key = groupBySession[item.key];
      let child = UNGROUPED_KEY;
      if (key !== undefined && (level === null || isWithin(key, level)) && key !== level) {
        const rest = level === null ? key : key.slice(level.length + 1);
        const head = rest.split('/')[0]!;
        child = level === null ? head : `${level}/${head}`;
      }
      byChild.set(child, [...(byChild.get(child) ?? []), item]);
    }
    const chipOrder = chips.map(chip => chip.key);
    const order = [...byChild.keys()]
      .filter(key => key !== UNGROUPED_KEY)
      .sort((a, b) => {
        const ia = chipOrder.indexOf(a);
        const ib = chipOrder.indexOf(b);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib) ||
          (byChild.get(b)![0]!.lastSentAt - byChild.get(a)![0]!.lastSentAt);
      });
    if (byChild.has(UNGROUPED_KEY)) {
      order.push(UNGROUPED_KEY);
    }
    const names = new Map(groups.map(group => [group.id, group.name]));
    // Un solo bloque no necesita encabezado: sería repetir el título.
    if (order.length === 1 && level === null) {
      return [{ key: 'all', title: null, count: sessions.length, data: sessions }];
    }
    return order.map(key => {
      const data = byChild.get(key) ?? [];
      return {
        key,
        title:
          key === UNGROUPED_KEY
            ? level === null
              ? 'No group'
              : names.get(level) ?? 'Other'
            : names.get(key) ?? key.split('/').pop() ?? key,
        count: data.length,
        data: collapsed.includes(key) ? [] : data,
      };
    });
  }, [project, sessions, groupBySession, chips, groups, collapsed]);

  const toggleSection = useCallback((key: string) => {
    setCollapsed(current =>
      current.includes(key)
        ? current.filter(other => other !== key)
        : [...current, key],
    );
  }, []);

  /**
   * Dónde abrir una sesión nueva dentro del proyecto: la carpeta del proyecto
   * en la máquina de su sesión más reciente. La raíz de la carpeta, no la de
   * esa sesión, que suele ser un worktree de un ticket.
   */
  const projectSeed = useMemo(() => {
    const def = projectDefs?.find(entry => entry.id === project);
    if (def === undefined) {
      return undefined;
    }
    const latest = all
      .filter(item => projectBySession[item.key] === def.id)
      .sort((a, b) => b.lastSentAt - a.lastSentAt)[0];
    const folder =
      latest === undefined
        ? undefined
        : def.folders
            .filter(
              entry =>
                entry.hostId === hostByServer[latest.serverId] &&
                (latest.cwd === entry.path ||
                  latest.cwd.startsWith(`${entry.path}/`)),
            )
            .sort((a, b) => b.path.length - a.path.length)[0];
    const fallback =
      folder === undefined
        ? def.folders
            .map(entry => ({
              entry,
              serverId: servers.find(
                server => hostByServer[server.id] === entry.hostId,
              )?.id,
            }))
            .find(candidate => candidate.serverId !== undefined)
        : undefined;
    const serverId = folder !== undefined ? latest!.serverId : fallback?.serverId;
    const cwd = folder?.path ?? fallback?.entry.path;
    if (serverId === undefined || cwd === undefined) {
      return undefined;
    }
    return { serverId, cwd, name: '', text: '', images: [] };
  }, [projectDefs, project, all, projectBySession, hostByServer, servers]);

  /** Nombre del grupo de cada fila: sin secciones, lo tiene que decir ella. */
  const groupNames = useMemo(
    () => new Map(groups.map(group => [group.id, group.name])),
    [groups],
  );

  // Con foto no hay carga que enseñar: la lista ya está. Sin ella, el cargador
  // es honesto — pero no mientras se lee la foto, que tarda milisegundos y
  // solo haría parpadear un spinner.
  const isFirstLoad =
    state.data === null &&
    (snapshot === undefined ||
      (snapshot === null && (state.status === 'checking' || isProbing)));
  const isSelectionMode = selectedIds.length > 0;

  return (
    <View className="flex-1 bg-white">
      <View
        style={{ paddingTop: insets.top + 4 }}
        className="border-b border-slate-200 bg-white px-4"
      >
        {isSelectionMode ? (
          // Barra contextual: sustituye al encabezado mientras hay selección.
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel selection"
              onPress={() => setSelectedIds([])}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
            >
              <CloseIcon size={20} color={ink('#0f172a')} />
            </Pressable>

            <Text
              numberOfLines={1}
              className="ml-2 flex-1 text-base font-semibold text-slate-900"
            >
              {selectedIds.length === 1
                ? selectedSessions[0]?.name ?? '1 selected'
                : `${selectedIds.length} selected`}
            </Text>

            {isWorking ? (
              <ActivityIndicator size="small" color={ink('#64748b')} />
            ) : (
              <>
                {/* Anclar solo tiene sentido sobre una: con varias, el orden
                    entre ellas quedaría sin definir. */}
                {selectedIds.length === 1 ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Rename"
                      onPress={() => setIsRenaming(true)}
                      className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                    >
                      <RenameIcon size={20} color={ink('#475569')} />
                    </Pressable>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        pinnedIds.includes(selectedIds[0]!)
                          ? 'Unpin'
                          : 'Pin to top'
                      }
                      onPress={togglePin}
                      className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                    >
                      <PinIcon
                        size={20}
                        color={
                          pinnedIds.includes(selectedIds[0]!)
                            ? ink('#0f172a')
                            : ink('#475569')
                        }
                      />
                    </Pressable>
                  </>
                ) : null}

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Move to a group"
                  onPress={() => setIsMoving(true)}
                  className="h-9 w-9 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
                >
                  <MoveToGroupIcon size={20} color={ink('#0f172a')} />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={allArchived ? 'Unarchive' : 'Archive'}
                  onPress={applyArchive}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <ArchiveIcon
                    size={20}
                    color={allArchived ? ink('#0f172a') : ink('#475569')}
                  />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete"
                  onPress={confirmDelete}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-rose-50"
                >
                  <TrashIcon size={20} color={ink('#be123c')} />
                </Pressable>
              </>
            )}
          </View>
        ) : (
          <View className="h-12 flex-row items-center gap-2">
            {/* El título es el selector de proyecto: siempre a la vista, y
                tocarlo abre la hoja. Se encoge (no empuja) al abrir la
                búsqueda, para que el campo tenga sitio. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Project: ${currentProject?.title ?? 'All projects'}`}
              accessibilityHint="Choose which project to show"
              onPress={() => setIsPickingProject(true)}
              className={`-ml-1.5 min-w-0 flex-row items-center gap-[7px] rounded-xl px-1.5 py-1 active:bg-slate-100 ${
                isSearching ? 'max-w-[45%] shrink' : 'shrink'
              }`}
            >
              {currentProject !== null ? (
                <View
                  style={{ backgroundColor: currentProject.color }}
                  className="h-2.5 w-2.5 rounded-full"
                />
              ) : null}
              <Text
                numberOfLines={1}
                className="shrink text-[23px] font-bold tracking-[-0.9px] text-slate-900"
              >
                {currentProject?.title ?? 'All projects'}
              </Text>
              <ChevronDownIcon size={18} color={ink('#94a3b8')} />
            </Pressable>

            {isSearching ? (
              <>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search…"
                  placeholderTextColor={ink('#94a3b8')}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  // Sin altura fija y con relleno vertical: en Android un
                  // `TextInput` con `height` recorta la línea de base, porque
                  // el campo no reserva el hueco del descendente.
                  className="flex-1 rounded-[20px] bg-slate-100 px-[14px] py-2 text-[13.5px] leading-5 text-slate-900"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close search"
                  onPress={() => {
                    setIsSearching(false);
                    setQuery('');
                  }}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <CloseIcon size={18} color={ink('#475569')} />
                </Pressable>
                <NewSessionButton onPress={() => setIsCreating(true)} />
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Search sessions"
                  onPress={() => setIsSearching(true)}
                  // `ml-auto` lo empuja al extremo; al abrirse, el campo ocupa
                  // ese hueco y el título se queda donde estaba.
                  className="ml-auto h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <SearchIcon size={20} color={ink('#475569')} />
                </Pressable>
                <NewSessionButton onPress={() => setIsCreating(true)} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="More options"
                  onPress={() => setIsMenuOpen(true)}
                  className="-mr-1.5 h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <MoreIcon size={20} color={ink('#475569')} />
                </Pressable>
              </>
            )}
          </View>
        )}

        {/* Resumen de servidores: texto con puntos, no chips — no filtra
            nada, así que no debe parecer un filtro. */}
        {/* Se queda montada también al seleccionar. Ocultarla encogía el
            encabezado justo al entrar en el modo, y el salto de altura se veía
            como un tirón. Solo deja de responder al toque: abrir la hoja de
            servidores a media selección no viene a cuento. */}
        <View className="mt-1 flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View servers"
            onPress={() => setShowServers(true)}
            disabled={isSelectionMode}
            className={`min-h-11 flex-1 flex-row items-center ${
              isSelectionMode ? 'opacity-40' : 'active:opacity-60'
            }`}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="items-center gap-3.5 pr-2"
            >
              {servers.map(server => {
                const route = routes[server.id];
                const routeInfo = routeState(
                  route !== undefined && route.baseUrl.length > 0,
                  route?.path ?? null,
                  route?.isProbing ?? false,
                );
                return (
                  <View key={server.id} className="flex-row items-center gap-1.5">
                    <View
                      style={ROUTE_DOT[routeInfo.dot]}
                      className="h-2 w-2 rounded-full"
                    />
                    <Text className="text-[11px] font-medium text-slate-600">
                      {server.name.length > 0 ? server.name : 'Untitled'}
                    </Text>
                    <Text className="text-[9.5px] text-slate-400">
                      {routeInfo.label}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
            <Text className="pl-1 text-base text-slate-300">›</Text>
          </Pressable>

          <UsageIndicator disabled={isSelectionMode} />
        </View>

        {/* Una sola fila: el estado primero y luego los grupos. Ningún grupo
            elegido = se ve todo; elegir varios suma. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          className="-mx-4 mt-1 grow-0 bg-slate-100"
          contentContainerClassName="items-center gap-1.5 px-[13px] pb-2.5 pt-2"
        >
          <Chip
            label={`All${scoped.active > 0 ? ` · ${scoped.active}` : ''}`}
            isActive={filter.kind === 'active'}
            onPress={() => setFilter(ACTIVE_FILTER)}
          />

          <Chip
            label={`Archived${
              scoped.archived > 0 ? ` · ${scoped.archived}` : ''
            }`}
            isActive={filter.kind === 'archived'}
            onPress={() => setFilter({ kind: 'archived' })}
          />

          {chips.length > 0 ? <View className="mx-0.5 h-5 w-px bg-slate-300" /> : null}

          {selectedGroups.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear group filter"
              onPress={clearGroupFilter}
              style={CHIP_SHADOW}
              className="h-[30px] w-[30px] items-center justify-center rounded-full bg-white active:opacity-70"
            >
              <CloseIcon size={14} color={ink('#475569')} />
            </Pressable>
          ) : null}

          {chips.map(chip => (
            <GroupChipButton
              key={chip.key}
              chip={chip}
              isActive={selectedGroups.includes(chip.key)}
              onPress={() => toggleGroupFilter(chip.key)}
              onLongPress={
                chip.key === UNGROUPED_KEY
                  ? null
                  : () => toggleGroupPin(chip.key)
              }
            />
          ))}
        </ScrollView>
      </View>

      {failedIds.length > 0 ? (
        <View className="flex-row items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <Text className="flex-1 text-xs text-amber-800">
            {failedIds
              .map(id => servers.find(s => s.id === id)?.name ?? 'A server')
              .join(', ')}
            {failedIds.length === 1
              ? ' is not responding on any route'
              : ' are not responding on any route'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              refreshRoutes();
              refresh();
            }}
            className="rounded-full bg-amber-100 px-3 py-1 active:opacity-70"
          >
            <Text className="text-[11px] font-semibold text-amber-800">
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}

      {isFirstLoad ? (
        <View className="flex-1 items-center justify-center">
          {snapshot === undefined ? null : <ActivityIndicator color={ink('#64748b')} />}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={session => session.key}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) =>
            section.title === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${section.title}, ${section.count} ${
                  section.count === 1 ? 'session' : 'sessions'
                }`}
                accessibilityState={{ expanded: !collapsed.includes(section.key) }}
                onPress={() => toggleSection(section.key)}
                className="flex-row items-center gap-[7px] px-4 pb-1.5 pt-3.5 active:opacity-60"
              >
                <Text className="text-[10px] text-slate-400">
                  {collapsed.includes(section.key) ? '▸' : '▾'}
                </Text>
                <Text
                  numberOfLines={1}
                  className="shrink text-[11.5px] font-semibold tracking-[-0.1px] text-slate-500"
                >
                  {section.title}
                </Text>
                <Text className="ml-auto text-[11px] text-slate-400">
                  {section.count}
                </Text>
              </Pressable>
            )
          }
          renderItem={({ item }) => {
            const server = serverOf(item);
            const route = routeOf(item);
            const isOffline = route === undefined || route.baseUrl.length === 0;
            return (
              <SessionRow
                session={item}
                // En modo selección el toque añade o quita, no abre: si no,
                // habría que apuntar siempre a una casilla diminuta.
                onPress={isSelectionMode ? toggleSelection : onOpenSession}
                onLongPress={toggleSelection}
                isPinned={pinnedIds.includes(item.key)}
                isSelected={selectedIds.includes(item.key)}
                draft={drafts[item.key]}
                // Lo que llegó por el socket manda sobre lo que se pidió al
                // abrir: es más reciente por definición.
                preview={live[item.key]?.preview ?? previews[item.key]?.text}
                pendingTool={live[item.key]?.pendingTool ?? undefined}
                isStreaming={live[item.key]?.isStreaming ?? false}
                activity={live[item.key]?.activity ?? null}
                serverName={server?.name ?? null}
                serverColor={colorHex(server?.color ?? 'green')}
                isOffline={isOffline}
                isLive={sockets.isLive(item.serverId, item.id)}
                // Sin secciones, la fila es la que dice de qué grupo es. Con un
                // solo grupo elegido sería repetir el chip.
                groupName={
                  // Dentro de un proyecto la sección ya dice el subgrupo.
                  project !== null ||
                  (visibleGroups.length === 1 &&
                    visibleGroups[0] === groupBySession[item.key])
                    ? null
                    : groupNames.get(groupBySession[item.key] ?? '') ?? null
                }
              />
            );
          }}
          ItemSeparatorComponent={SessionRowSeparator}
          contentContainerStyle={{
            paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
          }}
          refreshControl={
            <RefreshControl
              refreshing={state.status === 'checking' && state.data !== null}
              onRefresh={() => {
                refreshRoutes();
                refresh();
                loadPreferences();
              }}
              tintColor={ink('#64748b')}
            />
          }
          ListEmptyComponent={
            <View className="items-center px-6 py-16">
              <Text className="text-center text-sm text-slate-500">
                {reachable.length === 0
                  ? 'No server is responding. Check the addresses in Settings.'
                  : query.trim().length > 0
                  ? `Nothing matches "${query.trim()}".`
                  : visibleGroups.length > 0
                  ? 'No sessions in the selected groups.'
                  : currentProject !== null && filter.kind === 'active'
                  ? `No open sessions in ${currentProject.title}.`
                  : filter.kind === 'archived'
                  ? 'No archived sessions.'
                  : 'No active sessions.'}
              </Text>
            </View>
          }
        />
      )}

      <RenameDialog
        visible={isRenaming && selectedSessions.length === 1}
        initialName={selectedSessions[0]?.name ?? ''}
        isWorking={isWorking}
        onCancel={() => setIsRenaming(false)}
        onSubmit={applyRename}
      />

      <HomeMenu
        visible={isMenuOpen}
        isWorking={isWorking}
        loose={plan.moved}
        onClose={() => setIsMenuOpen(false)}
        onAutoGroup={confirmAutoGroup}
      />

      <MoveToGroupSheet
        visible={isMoving}
        sessions={selectedSessions}
        groups={groups}
        groupBySession={groupBySession}
        serverNames={Object.fromEntries(
          servers.map(server => [server.id, server.name]),
        )}
        isWorking={isWorking}
        onCancel={() => setIsMoving(false)}
        onConfirm={applyMove}
      />

      <NewSessionSheet
        visible={isCreating}
        // `all`, no la lista filtrada: las carpetas recientes no deberían
        // depender de si estás mirando activas o archivadas.
        sessions={all}
        initial={projectSeed}
        onCancel={() => setIsCreating(false)}
        onCreated={session => {
          setIsCreating(false);
          // La sesión es del proyecto por su carpeta: no hay que moverla.
          // Primero refrescar y luego abrir: al volver de la conversación la
          // fila ya tiene que estar en la lista, y el bridge la acaba de
          // añadir a su `/sessions`.
          refresh();
          loadPreferences();
          onOpenSession(session);
        }}
      />

      <ProjectPickerSheet
        visible={isPickingProject}
        projects={projects}
        current={project}
        totalOpen={activeCount}
        serverCount={servers.length}
        onSelect={chooseProject}
        onClose={() => setIsPickingProject(false)}
      />

      <ServerSheet
        visible={showServers}
        onClose={() => setShowServers(false)}
        onRetry={() => {
          refreshRoutes();
          refresh();
        }}
      />
    </View>
  );
}
