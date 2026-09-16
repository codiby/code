/** One folder per name — the rule that keeps every client showing the same
 *  groups.
 *
 *  Each bridge owns its groups in `ui-preferences.json`, and the clients render
 *  them as they come. Before this ran on the server, each client papered over
 *  duplicates on its own: the Android app folded groups by name, the desktop
 *  only folded a remote's group into a local one, so two local `taskr` folders
 *  showed up twice on the desktop and once on the phone. Duplicates got in
 *  through races between clients creating the same group, and through older
 *  builds that echoed a remote's groups back into this file.
 *
 *  So the server is where the rule lives: siblings (same parent) whose names
 *  match after trim + lowercase collapse into one. Pure — `updatePreferences`
 *  runs it on every write and once at startup.
 */

export interface DedupeGroup {
  id: string;
  name?: string;
  parentId?: string | null;
  allowEmpty?: boolean;
  [key: string]: unknown;
}

export interface DedupeInput {
  groups: Record<string, DedupeGroup>;
  /** sessionId → groupId. */
  map: Record<string, string>;
  /** parentKey (`''` = root) → ordered child group ids. */
  groupOrder?: Record<string, string[]>;
  /** Group ids pinned by a client, in pin order. */
  pinnedGroupIds?: string[];
}

export interface DedupeResult {
  groups: Record<string, DedupeGroup>;
  map: Record<string, string>;
  groupOrder?: Record<string, string[]>;
  pinnedGroupIds?: string[];
  /** Duplicate id → the id it was folded into. Empty when nothing changed. */
  merged: Record<string, string>;
}

function nameKey(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function dedupeGroups(input: DedupeInput): DedupeResult {
  let groups: Record<string, DedupeGroup> = { ...input.groups };
  let map: Record<string, string> = { ...input.map };
  const merged: Record<string, string> = {};

  // Merging two parents can put two same-name children under one parent, so
  // repeat until a pass finds nothing. Each pass removes at least one group,
  // which bounds the loop by the group count.
  for (;;) {
    const members = new Map<string, number>();
    for (const gid of Object.values(map)) members.set(gid, (members.get(gid) ?? 0) + 1);

    const winner = new Map<string, string>();
    const alias: Record<string, string> = {};
    for (const group of Object.values(groups)) {
      const name = nameKey(group.name);
      if (!name) continue;
      const key = `${group.parentId ?? ''}\0${name}`;
      const current = winner.get(key);
      if (current === undefined) { winner.set(key, group.id); continue; }
      // The busiest folder keeps its id, so the move touches the fewest
      // sessions; the id breaks ties so every server picks the same one.
      const a = members.get(current) ?? 0;
      const b = members.get(group.id) ?? 0;
      if (b > a || (b === a && group.id < current)) {
        alias[current] = group.id;
        winner.set(key, group.id);
      } else {
        alias[group.id] = current;
      }
    }
    if (!Object.keys(alias).length) break;

    // A loser may point at an id that itself lost later in the same pass.
    const resolve = (id: string): string => {
      let out = id;
      while (alias[out]) out = alias[out]!;
      return out;
    };

    const next: Record<string, DedupeGroup> = {};
    for (const group of Object.values(groups)) {
      if (alias[group.id]) continue;
      next[group.id] = group;
    }
    for (const loserId of Object.keys(alias)) {
      const loser = groups[loserId]!;
      const targetId = resolve(loserId);
      const target = next[targetId]!;
      // The survivor's settings win; the loser only fills what it lacks.
      next[targetId] = { ...loser, ...target, id: targetId, parentId: target.parentId };
      if (loser.allowEmpty) next[targetId]!.allowEmpty = true;
      merged[loserId] = targetId;
    }
    for (const [id, group] of Object.entries(next)) {
      if (group.parentId && alias[group.parentId]) next[id] = { ...group, parentId: resolve(group.parentId) };
    }
    groups = next;
    map = Object.fromEntries(Object.entries(map).map(([sid, gid]) => [sid, alias[gid] ? resolve(gid) : gid]));
  }

  const hasMerged = Object.keys(merged).length > 0;
  const finalId = (id: string): string => {
    let out = id;
    while (merged[out]) out = merged[out]!;
    return out;
  };
  for (const loserId of Object.keys(merged)) merged[loserId] = finalId(loserId);

  let groupOrder = input.groupOrder;
  if (groupOrder && hasMerged) {
    const out: Record<string, string[]> = {};
    for (const [parentKey, ids] of Object.entries(groupOrder)) {
      const key = parentKey ? finalId(parentKey) : '';
      out[key] = uniq([...(out[key] ?? []), ...ids.map(finalId)]);
    }
    groupOrder = out;
  }

  let pinnedGroupIds = input.pinnedGroupIds;
  if (pinnedGroupIds && hasMerged) pinnedGroupIds = uniq(pinnedGroupIds.map(finalId));

  return { groups, map, groupOrder, pinnedGroupIds, merged };
}

/** `dedupeGroups` over a whole preferences blob. Returns the blob untouched
 *  (same reference) when there was nothing to fold, so callers can skip the
 *  write. */
export function dedupePreferenceGroups(prefs: Record<string, unknown>): Record<string, unknown> {
  const groups = prefs.tabGroups;
  if (!groups || typeof groups !== 'object') return prefs;
  const map = prefs.tabGroupMap && typeof prefs.tabGroupMap === 'object'
    ? prefs.tabGroupMap as Record<string, string> : {};
  const groupOrder = prefs.groupOrder && typeof prefs.groupOrder === 'object' && !Array.isArray(prefs.groupOrder)
    ? prefs.groupOrder as Record<string, string[]> : undefined;
  const pinnedGroupIds = Array.isArray(prefs.pinnedGroupIds) ? prefs.pinnedGroupIds as string[] : undefined;

  const out = dedupeGroups({ groups: groups as Record<string, DedupeGroup>, map, groupOrder, pinnedGroupIds });
  if (!Object.keys(out.merged).length) return prefs;
  return {
    ...prefs,
    tabGroups: out.groups,
    tabGroupMap: out.map,
    ...(out.groupOrder ? { groupOrder: out.groupOrder } : {}),
    ...(out.pinnedGroupIds ? { pinnedGroupIds: out.pinnedGroupIds } : {}),
  };
}
