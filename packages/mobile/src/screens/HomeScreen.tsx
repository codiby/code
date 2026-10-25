import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
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
import { ServerSheet } from './ServerSheet';

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
      className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-1.5 active:opacity-70 ${
        isActive ? 'bg-slate-900' : 'bg-slate-200'
      }`}
    >
      {color !== undefined ? (
        <View
          style={{ backgroundColor: color }}
          className="h-2 w-2 rounded-full"
        />
      ) : null}
      <Text
        className={`text-[11px] font-semibold ${
          isActive ? 'text-white' : 'text-slate-600'
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Nueva sesión"
      onPress={onPress}
      className="h-[34px] w-[34px] items-center justify-center rounded-full bg-slate-900 active:opacity-80"
    >
      <PlusIcon size={19} color="#ffffff" />
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chip.title}, ${chip.count} sesiones${
        chip.isPinned ? ', anclado' : ''
      }`}
      accessibilityHint={
        onLongPress === null
          ? undefined
          : chip.isPinned
            ? 'Mantén pulsado para desanclar'
            : 'Mantén pulsado para anclar'
      }
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      onLongPress={onLongPress ?? undefined}
      className={`flex-row items-center gap-1.5 rounded-full border px-2.5 py-1.5 active:opacity-70 ${
        isActive
          ? 'border-slate-900 bg-slate-900'
          : 'border-slate-200 bg-white'
      }`}
    >
      {chip.depth > 0 ? (
        // Marca de subgrupo: en una sola fila, es lo que dice que cuelga del
        // chip de la izquierda.
        <Text className={`text-[11px] ${isActive ? 'text-slate-400' : 'text-slate-300'}`}>
          {'↳'}
        </Text>
      ) : null}
      {chip.isPinned ? (
        <PinIcon size={11} color={isActive ? '#ffffff' : '#475569'} />
      ) : null}
      <View
        style={chip.color === null ? UNGROUPED_DOT : { backgroundColor: chip.color }}
        className="h-2 w-2 rounded-full"
      />
      <Text
        numberOfLines={1}
        className={`max-w-[160px] text-[11px] font-semibold ${
          isActive ? 'text-white' : 'text-slate-700'
        }`}
      >
        {chip.title}
      </Text>
      <Text
        className={`text-[10px] font-semibold ${
          isActive ? 'text-slate-300' : 'text-slate-400'
        }`}
      >
        {chip.count}
      </Text>
      {chip.working > 0 ? (
        <View className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      ) : null}
    </Pressable>
  );
}

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
    Promise.all(
      reachable.map(route =>
        // Misma petición que la lista (`fetchHome` la comparte): una sola
        // ida y vuelta por máquina trae las dos cosas.
        fetchHome(route.baseUrl, route.token, route.server.id)
          .then(home => home.preferences)
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
        return at !== null && at > item.updatedAt
          ? { ...item, updatedAt: at }
          : item;
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
          return b.updatedAt - a.updatedAt;
        })
    );
  }, [all, filter, pinnedIds, query]);

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
            'Se movieron a medias',
            `No se pudo escribir en ${names}. Sus sesiones se quedaron donde estaban.`,
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
          'Se agrupó a medias',
          `No se pudo escribir en ${names}. Sus sesiones se quedaron sueltas.`,
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
          `${group.name} · ${group.sessions.length}${group.exists ? '' : ' (nuevo)'}`,
      );
    if (plan.groups.length > 6) {
      lines.push(`y ${plan.groups.length - 6} más`);
    }
    Alert.alert(
      `Agrupar ${plan.moved} ${plan.moved === 1 ? 'sesión' : 'sesiones'}`,
      lines.join('\n'),
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Agrupar', onPress: applyAutoGroup },
      ],
    );
  }, [plan, applyAutoGroup]);

  const confirmDelete = useCallback(() => {
    const count = selectedIds.length;
    // Borrar no se deshace: siempre pasa por confirmación, y el botón
    // destructivo nunca es el que queda bajo el pulgar por defecto.
    Alert.alert(
      count === 1 ? 'Borrar la sesión' : `Borrar ${count} sesiones`,
      'Se eliminan del bridge. El historial en disco se conserva.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
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
      ].sort((a, b) => b.updatedAt - a.updatedAt);
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
          lastAt: subtreeOf(key)[0]?.updatedAt ?? 0,
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

    const top = ordered(children.get(null) ?? []);
    if (loose.length > 0 || selectedGroups.includes(UNGROUPED_KEY)) {
      top.push({
        key: UNGROUPED_KEY,
        title: 'Sin grupo',
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
    <View className="flex-1 bg-slate-100">
      <View
        style={{ paddingTop: insets.top + 14 }}
        className="bg-white px-[18px] pb-[11px]"
      >
        {isSelectionMode ? (
          // Barra contextual: sustituye al encabezado mientras hay selección.
          <View className="flex-row items-center gap-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancelar selección"
              onPress={() => setSelectedIds([])}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
            >
              <CloseIcon size={20} color="#0f172a" />
            </Pressable>

            <Text
              numberOfLines={1}
              className="ml-2 flex-1 text-base font-semibold text-slate-900"
            >
              {selectedIds.length === 1
                ? selectedSessions[0]?.name ?? '1 seleccionada'
                : `${selectedIds.length} seleccionadas`}
            </Text>

            {isWorking ? (
              <ActivityIndicator size="small" color="#64748b" />
            ) : (
              <>
                {/* Anclar solo tiene sentido sobre una: con varias, el orden
                    entre ellas quedaría sin definir. */}
                {selectedIds.length === 1 ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Renombrar"
                      onPress={() => setIsRenaming(true)}
                      className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                    >
                      <RenameIcon size={20} color="#475569" />
                    </Pressable>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        pinnedIds.includes(selectedIds[0]!)
                          ? 'Desanclar'
                          : 'Anclar arriba'
                      }
                      onPress={togglePin}
                      className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                    >
                      <PinIcon
                        size={20}
                        color={
                          pinnedIds.includes(selectedIds[0]!)
                            ? '#0f172a'
                            : '#475569'
                        }
                      />
                    </Pressable>
                  </>
                ) : null}

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mover a un grupo"
                  onPress={() => setIsMoving(true)}
                  className="h-9 w-9 items-center justify-center rounded-full bg-slate-100 active:bg-slate-200"
                >
                  <MoveToGroupIcon size={20} color="#0f172a" />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={allArchived ? 'Desarchivar' : 'Archivar'}
                  onPress={applyArchive}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <ArchiveIcon
                    size={20}
                    color={allArchived ? '#0f172a' : '#475569'}
                  />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Borrar"
                  onPress={confirmDelete}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-rose-50"
                >
                  <TrashIcon size={20} color="#be123c" />
                </Pressable>
              </>
            )}
          </View>
        ) : (
          <View className="flex-row items-center gap-2">
            <Text className="text-[23px] font-bold tracking-tight text-slate-900">Conversaciones</Text>

            {isSearching ? (
              <>
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Buscar…"
                  placeholderTextColor="#94a3b8"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  // Sin altura fija y con relleno vertical: en Android un
                  // `TextInput` con `height` recorta la línea de base, porque
                  // el campo no reserva el hueco del descendente.
                  className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] leading-5 text-slate-900"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar búsqueda"
                  onPress={() => {
                    setIsSearching(false);
                    setQuery('');
                  }}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <CloseIcon size={18} color="#475569" />
                </Pressable>
                <NewSessionButton onPress={() => setIsCreating(true)} />
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Buscar sesiones"
                  onPress={() => setIsSearching(true)}
                  // `ml-auto` lo empuja al extremo; al abrirse, el campo ocupa
                  // ese hueco y el título se queda donde estaba.
                  className="ml-auto h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <SearchIcon size={20} color="#475569" />
                </Pressable>
                <NewSessionButton onPress={() => setIsCreating(true)} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Más opciones"
                  onPress={() => setIsMenuOpen(true)}
                  className="-mr-1.5 h-9 w-9 items-center justify-center rounded-full active:bg-slate-100"
                >
                  <MoreIcon size={20} color="#475569" />
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
            accessibilityLabel="Ver servidores"
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
                      {server.name.length > 0 ? server.name : 'Sin nombre'}
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
          className="mt-2.5 grow-0"
          contentContainerClassName="items-center gap-2 pr-4"
        >
          <Chip
            label={`Todas${activeCount > 0 ? ` · ${activeCount}` : ''}`}
            isActive={filter.kind === 'active'}
            onPress={() => setFilter(ACTIVE_FILTER)}
          />

          <Chip
            label={`Archivadas${
              archivedCount > 0 ? ` · ${archivedCount}` : ''
            }`}
            isActive={filter.kind === 'archived'}
            onPress={() => setFilter({ kind: 'archived' })}
          />

          {chips.length > 0 ? <View className="mx-0.5 h-5 w-px bg-slate-300" /> : null}

          {selectedGroups.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Quitar filtro de grupos"
              onPress={clearGroupFilter}
              className="h-[30px] w-[30px] items-center justify-center rounded-full bg-slate-200 active:bg-slate-300"
            >
              <CloseIcon size={14} color="#475569" />
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
              .map(id => servers.find(s => s.id === id)?.name ?? 'Un servidor')
              .join(', ')}
            {failedIds.length === 1
              ? ' no responde por ninguna ruta'
              : ' no responden por ninguna ruta'}
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
              Reintentar
            </Text>
          </Pressable>
        </View>
      ) : null}

      {isFirstLoad ? (
        <View className="flex-1 items-center justify-center">
          {snapshot === undefined ? null : <ActivityIndicator color="#64748b" />}
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={session => session.key}
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
                  visibleGroups.length === 1 &&
                  visibleGroups[0] === groupBySession[item.key]
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
              tintColor="#64748b"
            />
          }
          ListEmptyComponent={
            <View className="items-center px-6 py-16">
              <Text className="text-center text-sm text-slate-500">
                {reachable.length === 0
                  ? 'Ningún servidor responde. Revisa las direcciones en Ajustes.'
                  : query.trim().length > 0
                  ? `Nada coincide con «${query.trim()}».`
                  : visibleGroups.length > 0
                  ? 'No hay sesiones en los grupos elegidos.'
                  : filter.kind === 'archived'
                  ? 'No hay sesiones archivadas.'
                  : 'No hay sesiones activas.'}
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
        onCancel={() => setIsCreating(false)}
        onCreated={session => {
          setIsCreating(false);
          // Primero refrescar y luego abrir: al volver de la conversación la
          // fila ya tiene que estar en la lista, y el bridge la acaba de
          // añadir a su `/sessions`.
          refresh();
          loadPreferences();
          onOpenSession(session);
        }}
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
