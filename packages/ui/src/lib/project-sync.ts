import type { TabGroupInfo } from './tab-groups';
import { ancestorChain } from './group-tree';

/**
 * Keeping a project identical on every host that has a folder in it.
 *
 * Each host stores its own preferences. A project is replicated as a bundle
 * into the preferences of every host it spans: its definition plus its
 * *organization* — the groups that belong to it, which session sits in each,
 * their child order and pins. Whole bundle, last change wins (`updatedAt`).
 *
 * The organization is derived from preference data alone (never from which
 * sessions a window can currently see), so both hosts compute the same bundle
 * from the same prefs. That is what stops a sync from being mistaken for an
 * edit and bounced back. A change is detected by comparing the bundle's
 * fingerprint with the one stored in the project.
 */

/** A folder as stored and replicated: the host by its stable identity. */
export interface StoredFolder {
  path: string;
  /** `host_…` of the machine the folder lives on. */
  hostId?: string;
  /** Legacy: registry id from before folders carried a host identity. */
  remoteId?: string | null;
}

export interface StoredProject {
  id: string;
  name: string;
  color?: string;
  folders: StoredFolder[];
  updatedAt: number;
  /** Fingerprint of the organization last written with this version. */
  fp?: string;
  /** Tombstone: a deletion has to travel too. */
  deleted?: boolean;
}

/** The slice of preferences a project's organization lives in. */
export interface OrgPrefs {
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  groupOrder: Record<string, string[]>;
  pinnedSessionIds: string[];
}

export interface OrgBundle {
  groups: Record<string, TabGroupInfo>;
  map: Record<string, string>;
  order: Record<string, string[]>;
  pins: string[];
}

/** Groups that belong to `projectId`: tagged with it, or below one that is. */
export function projectGroupIds(groups: Record<string, TabGroupInfo>, projectId: string): Set<string> {
  const out = new Set<string>();
  for (const g of Object.values(groups)) {
    if (ancestorChain(groups, g.id).some(id => groups[id]?.projectId === projectId)) out.add(g.id);
  }
  return out;
}

export function bundleOf(prefs: OrgPrefs, projectId: string): OrgBundle {
  const ids = projectGroupIds(prefs.tabGroups, projectId);
  const groups: Record<string, TabGroupInfo> = {};
  for (const id of ids) groups[id] = prefs.tabGroups[id]!;
  const map: Record<string, string> = {};
  for (const [sid, gid] of Object.entries(prefs.tabGroupMap)) if (ids.has(gid)) map[sid] = gid;
  const order: Record<string, string[]> = {};
  for (const [parent, list] of Object.entries(prefs.groupOrder)) if (ids.has(parent)) order[parent] = list;
  const pins = prefs.pinnedSessionIds.filter(sid => sid in map);
  return { groups, map, order, pins };
}

/** Key-order-independent JSON, so equal bundles always print the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function fingerprint(b: OrgBundle): string {
  // Pins are a set; their order isn't organization.
  return stable({ ...b, pins: [...b.pins].sort() });
}

/** Replace `projectId`'s organization in `prefs` with `bundle`. Everything
 *  outside the project is left exactly as it was. */
export function applyBundle(prefs: OrgPrefs, projectId: string, bundle: OrgBundle): OrgPrefs {
  const old = projectGroupIds(prefs.tabGroups, projectId);
  const tabGroups: Record<string, TabGroupInfo> = {};
  for (const [id, g] of Object.entries(prefs.tabGroups)) if (!old.has(id)) tabGroups[id] = g;
  Object.assign(tabGroups, bundle.groups);

  const tabGroupMap: Record<string, string> = {};
  for (const [sid, gid] of Object.entries(prefs.tabGroupMap)) {
    // Drop assignments into the project's old groups; the bundle restates them.
    if (old.has(gid) || sid in bundle.map) continue;
    tabGroupMap[sid] = gid;
  }
  Object.assign(tabGroupMap, bundle.map);

  const groupOrder: Record<string, string[]> = {};
  for (const [parent, list] of Object.entries(prefs.groupOrder)) if (!old.has(parent)) groupOrder[parent] = list;
  Object.assign(groupOrder, bundle.order);

  const inBundle = new Set(Object.keys(bundle.map));
  const pins = new Set(bundle.pins);
  const pinnedSessionIds = [
    ...prefs.pinnedSessionIds.filter(sid => !inBundle.has(sid) || pins.has(sid)),
    ...bundle.pins.filter(sid => !prefs.pinnedSessionIds.includes(sid)),
  ];
  return { tabGroups, tabGroupMap, groupOrder, pinnedSessionIds };
}

/** Read the replicated projects out of a preferences blob, tombstones included. */
export function parseStoredProjects(raw: unknown): Record<string, StoredProject> {
  const out: Record<string, StoredProject> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<StoredProject>;
    const updatedAt = typeof p.updatedAt === 'number' ? p.updatedAt : 0;
    const folders = (Array.isArray(p.folders) ? p.folders : [])
      .filter((f): f is StoredFolder => !!f && typeof (f as StoredFolder).path === 'string' && !!(f as StoredFolder).path.trim())
      .map(f => ({
        path: f.path.trim().replace(/(.)[\\/]+$/, '$1'),
        ...(typeof f.hostId === 'string' && f.hostId ? { hostId: f.hostId } : {}),
        ...(typeof f.remoteId === 'string' && f.remoteId ? { remoteId: f.remoteId } : {}),
      }));
    // A tombstone keeps its folders: they name the hosts the deletion goes to.
    if (p.deleted) { out[id] = { id, name: '', folders, updatedAt, deleted: true }; continue; }
    if (typeof p.name !== 'string' || !p.name.trim()) continue;
    out[id] = {
      id, name: p.name.trim(), color: typeof p.color === 'string' ? p.color : undefined,
      folders, updatedAt, ...(typeof p.fp === 'string' ? { fp: p.fp } : {}),
    };
  }
  return out;
}

/** Hosts a project spans, by identity. */
export function projectHosts(p: StoredProject): Set<string> {
  return new Set(p.folders.map(f => f.hostId).filter((h): h is string => !!h));
}
