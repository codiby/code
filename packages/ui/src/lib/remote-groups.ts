/** Folding another machine's sidebar into this one.
 *
 *  Every bridge keeps its own `ui-preferences.json`, so a project that exists
 *  on two machines has two unrelated uuids: `utilityprofit` is
 *  `e9418ebb…` here and `d8051d5a…` on ryzen9. Merging those by id leaves two
 *  folders with the same name and no way to tell them apart, so groups fold by
 *  **normalised name** instead — the same rule the mobile client uses in
 *  `HomeScreen.loadPreferences`.
 *
 *  Only the local groups are persisted. A remote group that finds no local
 *  namesake is surfaced under a synthetic `rmt:<remoteId>:<groupId>` id: it
 *  renders like any other folder, but the prefix makes it recognisable
 *  everywhere, so a group the local machine does not own can never be renamed,
 *  deleted or written back into `ui-preferences.json`.
 *
 *  Pure — the IO (which prefs blob came from which bridge) lives in ChatApp.
 */

import type { TabGroupInfo } from './tab-groups';

export const REMOTE_GROUP_PREFIX = 'rmt:';

/** Synthetic id for a remote group with no local namesake. */
export function remoteGroupKey(remoteId: string, groupId: string): string {
  return `${REMOTE_GROUP_PREFIX}${remoteId}:${groupId}`;
}

/** True for a group this machine doesn't own. Guards every mutation and every
 *  `persistPrefs` payload — a synthetic id must never reach the local file. */
export function isRemoteGroupKey(groupId: string | null | undefined): boolean {
  return typeof groupId === 'string' && groupId.startsWith(REMOTE_GROUP_PREFIX);
}

/** The remote a synthetic id belongs to, or null for a local group. */
export function remoteOfGroupKey(groupId: string): string | null {
  if (!isRemoteGroupKey(groupId)) return null;
  const rest = groupId.slice(REMOTE_GROUP_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1 ? null : rest.slice(0, sep);
}

/** The id the group has on its own machine — what a write sent to that bridge
 *  has to name. The remote's own ids may contain `:` (nothing forbids it), so
 *  only the first separator is the boundary. */
export function groupIdOfRemoteKey(groupId: string): string | null {
  if (!isRemoteGroupKey(groupId)) return null;
  const rest = groupId.slice(REMOTE_GROUP_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1 ? null : rest.slice(sep + 1) || null;
}

/** What one remote reported in its own `preferences` frame. */
export interface RemoteGroupPrefs {
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
}

export interface MergeRemoteGroupsInput {
  /** Local groups — persisted, and the side that wins every name collision. */
  groups: Record<string, TabGroupInfo>;
  /** Local sessionId → groupId. */
  map: Record<string, string>;
  /** remoteId → that machine's groups, keyed in connection order. */
  remotes: Record<string, RemoteGroupPrefs>;
  /** Sessions the local bridge owns. A remote entry for one of these is an id
   *  collision, not the same session (`main-session` exists on every machine),
   *  and following it would drag the local tab into the remote's folder. */
  localSessionIds?: ReadonlySet<string>;
}

export interface MergedGroups {
  groups: Record<string, TabGroupInfo>;
  map: Record<string, string>;
}

/** Fold `name` to the key groups merge on. */
function nameKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/** Pick the local group each name folds into. Duplicate local names are a real
 *  state (older builds let a remote's groups leak into this file), so the
 *  busiest one wins and the id breaks ties — the choice has to be the same on
 *  every render or folders would jump between repaints. */
function localGroupsByName(
  groups: Record<string, TabGroupInfo>,
  map: Record<string, string>,
): Map<string, string> {
  const members = new Map<string, number>();
  for (const gid of Object.values(map)) members.set(gid, (members.get(gid) ?? 0) + 1);

  const best = new Map<string, string>();
  for (const group of Object.values(groups)) {
    // Top-level only: two repos can each hold a "backend" subgroup, and folding
    // a remote's subgroup into an unrelated project is worse than not folding.
    if (group.parentId) continue;
    const key = nameKey(group.name);
    if (!key) continue;
    const current = best.get(key);
    if (current === undefined) { best.set(key, group.id); continue; }
    const a = members.get(current) ?? 0;
    const b = members.get(group.id) ?? 0;
    if (b > a || (b === a && group.id < current)) best.set(key, group.id);
  }
  return best;
}

/**
 * The groups and mapping the sidebar renders: the local ones as they are, plus
 * every remote's, folded by name.
 */
export function mergeRemoteGroups(input: MergeRemoteGroupsInput): MergedGroups {
  const remoteIds = Object.keys(input.remotes).sort();
  if (!remoteIds.length) return { groups: input.groups, map: input.map };

  const groups: Record<string, TabGroupInfo> = { ...input.groups };
  const map: Record<string, string> = { ...input.map };
  const byName = localGroupsByName(input.groups, input.map);
  /** `<remoteId>\0<remote group id>` → the id it renders under. */
  const alias = new Map<string, string>();

  // Two passes over the groups: a subgroup can name a parent that hasn't been
  // aliased yet, and `parentId` has to point at the id actually rendered.
  for (const remoteId of remoteIds) {
    for (const group of Object.values(input.remotes[remoteId]!.tabGroups)) {
      if (!group?.id) continue;
      const key = nameKey(group.name);
      const local = !group.parentId && key ? byName.get(key) : undefined;
      if (local) {
        // Folded: the local definition owns cwd, colour and project settings.
        alias.set(`${remoteId}\0${group.id}`, local);
        continue;
      }
      const synthetic = remoteGroupKey(remoteId, group.id);
      alias.set(`${remoteId}\0${group.id}`, synthetic);
      // A remote-only top-level name claims the slot, so a third machine with
      // the same project folds into it instead of adding another folder.
      if (!group.parentId && key) byName.set(key, synthetic);
    }
  }

  for (const remoteId of remoteIds) {
    for (const group of Object.values(input.remotes[remoteId]!.tabGroups)) {
      if (!group?.id) continue;
      const id = alias.get(`${remoteId}\0${group.id}`)!;
      if (!isRemoteGroupKey(id)) continue; // folded into a local group
      const parent = group.parentId ? alias.get(`${remoteId}\0${group.parentId}`) ?? null : null;
      groups[id] = { ...group, id, parentId: parent };
    }
  }

  for (const remoteId of remoteIds) {
    for (const [sessionId, groupId] of Object.entries(input.remotes[remoteId]!.tabGroupMap)) {
      if (input.localSessionIds?.has(sessionId)) continue;
      // A local placement wins: dragging a remote session into one of your own
      // folders is persisted here, and the remote never hears about it.
      if (map[sessionId]) continue;
      const id = alias.get(`${remoteId}\0${groupId}`);
      if (id) map[sessionId] = id;
    }
  }

  return { groups, map };
}

/** Drop every synthetic id from a `persistPrefs` payload. Belt to the guards'
 *  braces: the local file must never gain a group this machine doesn't own. */
export function stripRemoteGroups(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  const groups = out.tabGroups;
  if (groups && typeof groups === 'object') {
    out.tabGroups = Object.fromEntries(
      Object.entries(groups as Record<string, unknown>).filter(([gid]) => !isRemoteGroupKey(gid)),
    );
  }
  const map = out.tabGroupMap;
  if (map && typeof map === 'object') {
    out.tabGroupMap = Object.fromEntries(
      Object.entries(map as Record<string, unknown>)
        .filter(([, gid]) => !isRemoteGroupKey(gid as string)),
    );
  }
  return out;
}
