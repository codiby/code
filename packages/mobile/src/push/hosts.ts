/**
 * Which configured server a push came from, and how to reach it without the
 * React tree — an Approve tapped on a notification runs in a headless task,
 * with no ServerConfigProvider and no live route probes.
 *
 * FCM gives the phone one token for every host, so the bridge names itself
 * in each push (`host`) and the phone remembers, per server, the host label
 * it registered with.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseServers, type ServerEntry } from '../config/servers';

const REGISTRATIONS_KEY = 'codiby.push.registrations';
/** Written by useServerRoutes: the route that answered last, per server. */
const LAST_ROUTES_KEY = 'codiby.last-routes';
const SERVERS_KEY = 'codiby.servers';

export interface HostRegistration {
  readonly serverId: string;
  /** The bridge's host label (`/agent/status` → host). */
  readonly host: string;
  /** This phone's row in the host's device list. */
  readonly deviceId: string;
  /** The FCM token it was registered with — sent as `replacesToken` after a refresh. */
  readonly token: string;
  /** Whether the host had its Firebase key at registration time. */
  readonly configured: boolean;
  readonly at: number;
}

export type Registrations = Readonly<Record<string, HostRegistration>>;

function isRegistration(value: unknown): value is HostRegistration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.serverId === 'string' &&
    typeof r.host === 'string' &&
    typeof r.deviceId === 'string' &&
    typeof r.token === 'string'
  );
}

export async function loadRegistrations(): Promise<Registrations> {
  try {
    const raw = await AsyncStorage.getItem(REGISTRATIONS_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const out: Record<string, HostRegistration> = {};
    for (const [serverId, value] of Object.entries(parsed)) {
      if (isRegistration(value)) {
        out[serverId] = {
          ...value,
          configured: value.configured === true,
          at: Number(value.at) || 0,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Registration of several hosts runs in parallel; serialise the
// read-modify-write so two of them never drop each other's entry.
let writing: Promise<unknown> = Promise.resolve();

function mutate(fn: (current: Registrations) => Registrations): Promise<void> {
  const next = writing.then(async () => {
    const current = await loadRegistrations();
    await AsyncStorage.setItem(REGISTRATIONS_KEY, JSON.stringify(fn(current)));
  });
  writing = next.catch(() => undefined);
  return next;
}

export function saveRegistration(
  registration: HostRegistration,
): Promise<void> {
  return mutate(current => ({
    ...current,
    [registration.serverId]: registration,
  }));
}

export function removeRegistration(serverId: string): Promise<void> {
  return mutate(current => {
    const rest: Record<string, HostRegistration> = { ...current };
    delete rest[serverId];
    return rest;
  });
}

export async function loadServers(): Promise<ServerEntry[]> {
  try {
    return parseServers(await AsyncStorage.getItem(SERVERS_KEY)) ?? [];
  } catch {
    return [];
  }
}

/** The server id a push from `host` belongs to; with a single agent host, that one. */
export function serverIdForHost(
  host: string,
  registrations: Registrations,
): string | null {
  const all = Object.values(registrations);
  const exact = all.filter(r => r.host === host);
  if (exact.length > 0) {
    return exact[0]!.serverId;
  }
  return all.length === 1 ? all[0]!.serverId : null;
}

export async function serverForHost(host: string): Promise<ServerEntry | null> {
  const [servers, registrations] = await Promise.all([
    loadServers(),
    loadRegistrations(),
  ]);
  const serverId = serverIdForHost(host, registrations);
  return servers.find(s => s.id === serverId) ?? null;
}

/**
 * URLs to try, best first: the forced route if the user pinned one, else the
 * route that answered last, then the other.
 */
export async function candidateUrls(server: ServerEntry): Promise<string[]> {
  const local = server.localUrl.trim();
  const remote = server.remoteUrl.trim();
  if (server.mode === 'local') {
    return local ? [local] : [];
  }
  if (server.mode === 'remote') {
    return remote ? [remote] : [];
  }
  let last: unknown = null;
  try {
    const raw = await AsyncStorage.getItem(LAST_ROUTES_KEY);
    last =
      raw === null
        ? null
        : (JSON.parse(raw) as Record<string, unknown>)[server.id];
  } catch {
    last = null;
  }
  const ordered = last === 'remote' ? [remote, local] : [local, remote];
  return ordered.filter(url => url.length > 0);
}
