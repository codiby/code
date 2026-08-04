/** Ancestor-chain resolution for nested tab groups.
 *
 *  Groups form a tree via `parentId` (null/absent = root). Every per-project
 *  setting — env vars, portless actions, requirements overrides — is looked up
 *  by walking from the session's own group up to the root and taking the first
 *  ancestor that defines the field. That way a session inside
 *  `utilityprofit › Backend › Migraciones` still picks up the repo-level env
 *  even though its own group defines none.
 *
 *  Shared by the bridge's env/tool/config resolvers so they all inherit the
 *  same way. The UI has its own tree builder (`packages/ui/src/lib/group-tree`)
 *  which additionally derives the worktree groups; those are render-only and
 *  never reach preferences, so this file only ever sees real groups.
 */

export interface GroupWithParent {
  parentId?: string | null;
}

/** Ids of the sidebar's derived worktree groups. They exist only for the
 *  duration of a render, so anything that writes preferences filters them out.
 *  Kept in sync with `packages/ui/src/lib/group-tree.ts`. */
export const DERIVED_GROUP_PREFIX = 'wt:';

export function isDerivedGroupId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(DERIVED_GROUP_PREFIX);
}

/** Groups from `groupId` up to its root ancestor, nearest first. Stops on a
 *  missing id and is cycle-safe (a corrupted `parentId` loop terminates
 *  instead of hanging). Returns `[]` for a missing/undefined group. */
export function groupChain<T extends GroupWithParent>(
  groups: Record<string, T> | undefined,
  groupId: string | undefined | null,
): T[] {
  if (!groups || !groupId) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  let cur: string | null = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const group: T | undefined = groups[cur];
    if (!group) break;
    out.push(group);
    cur = group.parentId ?? null;
  }
  return out;
}

/** Same as `groupChain`, keyed off the session instead of the group. */
export function sessionGroupChain<T extends GroupWithParent>(
  groups: Record<string, T> | undefined,
  map: Record<string, string> | undefined,
  sessionId: string | undefined | null,
): T[] {
  if (!map || !sessionId) return [];
  return groupChain(groups, map[sessionId]);
}

/** First ancestor (nearest first) for which `pick` returns a non-undefined
 *  value, or `undefined` when no ancestor defines it. */
export function inheritFromChain<T extends GroupWithParent, V>(
  chain: T[],
  pick: (group: T) => V | undefined,
): V | undefined {
  for (const group of chain) {
    const value = pick(group);
    if (value !== undefined) return value;
  }
  return undefined;
}
