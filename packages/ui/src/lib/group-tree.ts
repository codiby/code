/** Sidebar group tree.
 *
 *  Every group in the sidebar is a real, persisted group: created by the user,
 *  or by the bridge on session creation (project autogroup and branch
 *  subgroups, both in `maybeAutoGroupSession`). They live in `tabGroups`, nest
 *  through `parentId` with no depth limit, and hold their members in
 *  `tabGroupMap`.
 *
 *  Nothing is derived at render time. Automatic grouping is a decision made
 *  once, when a session is born; from then on the tree is whatever the user
 *  has arranged, and dragging a session out of a branch group keeps it out.
 *
 *  Everything here is pure so the tree can be unit-tested without a DOM.
 */

import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';

/** True when `cwd` is inside a worktree directory at any depth. `.wt` is the
 *  legacy directory, kept so worktrees created by older versions still read as
 *  worktrees; nothing new is ever placed there. Matches `/` and `\` so Windows
 *  paths test the same. The bridge owns the strict `<repo>/.worktrees/<branch>`
 *  form (`handlers/worktree.ts`), which is where grouping decisions are made. */
export const WORKTREE_CWD_LOOSE_RE = /[\\/]\.(?:worktrees|wt)[\\/]/;

/** The repo that owns a worktree cwd, or null when the path isn't in one.
 *
 *  The bridge's `WORKTREE_CWD_RE` anchors at the end, so it only recognises a
 *  session sitting exactly at the worktree root. A session opened a few
 *  directories below it is still on that branch, so this stops at the
 *  `.worktrees` segment and returns whatever precedes it. */
export function repoRootOfWorktreeCwd(cwd: string): string | null {
  return cwd.match(/^(.*?)[\\/]\.(?:worktrees|wt)[\\/]/)?.[1] || null;
}

/** The group standing for `repoRoot` — where a worktree's group belongs.
 *
 *  Matches on `cwd` first, the field the bridge fills when it autogroups a
 *  project. The folder-name fallback is only consulted for groups that carry
 *  no cwd at all: those predate the field and so cannot contradict it, whereas
 *  a group with a *different* cwd named `code` is a different checkout.
 *  Root-level groups only — a subgroup named after the repo is somebody's
 *  "Backend", not the project itself. */
export function projectGroupIdForRepo(
  repoRoot: string,
  groups: Record<string, TabGroupInfo>,
): string | null {
  const roots = Object.values(groups).filter(g => !g.parentId);
  const byCwd = roots.find(g => g.cwd === repoRoot);
  if (byCwd) return byCwd.id;
  const folder = repoRoot.split(/[\\/]/).filter(Boolean).pop();
  return roots.find(g => !g.cwd && g.name === folder)?.id ?? null;
}

/** The folder already standing for `cwd`, at any depth.
 *
 *  "Create group" on a session should file it here rather than mint a second
 *  folder for the same directory beside the first. Unlike the lookup above
 *  this searches subgroups too: the twin of a branch subgroup is just as
 *  duplicate as the twin of a project.
 *
 *  Exact cwd, with the same cwd-less-only name fallback — two checkouts can
 *  share a folder name (`~/src/code` and `~/vendor/code`), and filing a
 *  session into the wrong project is worse than one extra folder. */
export function groupIdForCwd(
  cwd: string,
  groups: Record<string, TabGroupInfo>,
): string | null {
  if (!cwd) return null;
  const all = Object.values(groups);
  const byCwd = all.find(g => g.cwd === cwd);
  if (byCwd) return byCwd.id;
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop();
  return all.find(g => !g.cwd && !g.parentId && g.name === folder)?.id ?? null;
}

/** Key used for root-level nodes in the parent-indexed maps. Real group ids are
 *  uuids, so the empty string is unambiguous. */
export const ROOT_KEY = '';

/** sessionId → the position it was pinned in, oldest pin first.
 *
 *  `pinnedSessionIds` is insertion-ordered: the toggle appends, and the
 *  persisted array round-trips that order, so the set already records *when*
 *  each session was pinned. Comparators can therefore rank pins by this
 *  instead of by activity — a pin that slides down the list the moment another
 *  pinned session gets a message is the opposite of what pinning is for.
 *
 *  Sort descending to put the newest pin on top. Ids that aren't pinned are
 *  absent; a `?? -1` default keeps them below every pin. */
export function pinOrder(pinned: ReadonlySet<string> | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!pinned) return out;
  let i = 0;
  for (const id of pinned) out.set(id, i++);
  return out;
}

export type TreeNode =
  | { type: 'session'; id: string; session: SessionInfo; depth: number }
  | {
      type: 'group';
      id: string;
      group: TabGroupInfo;
      depth: number;
      children: TreeNode[];
      /** Sessions anywhere in this subtree, not just direct children. */
      sessionCount: number;
    };

export interface BuildTreeOptions {
  /** Sessions to place, already filtered (search) and in fallback order. */
  sessions: SessionInfo[];
  groups: Record<string, TabGroupInfo>;
  /** sessionId → groupId. */
  map: Record<string, string>;
  /** parentKey (`''` for root) → explicit child-group order. Ids missing from
   *  the list keep their first-appearance order at the end. */
  childOrder?: Record<string, string[]>;
  /** Applied to the sessions of each individual parent. */
  sortSessions?: (a: SessionInfo, b: SessionInfo) => number;
}

/** Resolve a group's effective parent key, treating a missing parent or a
 *  `parentId` cycle as "root". A cycle can only come from corrupted prefs, but
 *  an infinite render loop is a much worse failure than a flattened tree. */
function parentKeyOf(groups: Record<string, TabGroupInfo>, group: TabGroupInfo): string {
  const parentId = group.parentId;
  if (!parentId || !groups[parentId]) return ROOT_KEY;
  const seen = new Set<string>([group.id]);
  let cur: string | null | undefined = parentId;
  while (cur) {
    if (seen.has(cur)) return ROOT_KEY;
    seen.add(cur);
    cur = groups[cur]?.parentId ?? null;
  }
  return parentId;
}

/** Order `ids` by `explicit`, appending anything missing in its original order. */
function applyOrder(ids: string[], explicit: string[] | undefined): string[] {
  if (!explicit?.length) return ids;
  const present = new Set(ids);
  const known = explicit.filter(id => present.has(id));
  const seen = new Set(known);
  return [...known, ...ids.filter(id => !seen.has(id))];
}

/**
 * Build the render tree: subgroups first (in their explicit order), then the
 * parent's own sessions.
 */
export function buildGroupTree(opts: BuildTreeOptions): TreeNode[] {
  const { sessions, groups, map, childOrder, sortSessions } = opts;

  const groupsByParent = new Map<string, TabGroupInfo[]>();
  for (const group of Object.values(groups)) {
    const key = parentKeyOf(groups, group);
    const list = groupsByParent.get(key);
    if (list) list.push(group);
    else groupsByParent.set(key, [group]);
  }

  const sessionsByGroup = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const gid = map[session.id];
    const key = gid && groups[gid] ? gid : ROOT_KEY;
    const list = sessionsByGroup.get(key);
    if (list) list.push(session);
    else sessionsByGroup.set(key, [session]);
  }

  // A cycle is already flattened by parentKeyOf, but guard the descent too so a
  // group that somehow lists itself as a child can't recurse forever.
  const visiting = new Set<string>();

  const buildLevel = (parentKey: string, depth: number): { nodes: TreeNode[]; sessionCount: number } => {
    const nodes: TreeNode[] = [];
    let sessionCount = 0;

    const childGroups = groupsByParent.get(parentKey) ?? [];
    const orderedIds = applyOrder(childGroups.map(g => g.id), childOrder?.[parentKey]);
    const byId = new Map(childGroups.map(g => [g.id, g]));
    for (const id of orderedIds) {
      const group = byId.get(id);
      if (!group || visiting.has(id)) continue;
      visiting.add(id);
      const sub = buildLevel(id, depth + 1);
      visiting.delete(id);
      // A group with nothing to show stays hidden. `tabGroups` outlives the
      // sessions that filled it (archived members keep their mapping), and a
      // search that matches none of its members empties it too. Folders the
      // user created deliberately empty are the exception.
      if (sub.sessionCount === 0 && sub.nodes.length === 0 && !group.allowEmpty) continue;
      nodes.push({ type: 'group', id, group, depth, children: sub.nodes, sessionCount: sub.sessionCount });
      sessionCount += sub.sessionCount;
    }

    const own = (sessionsByGroup.get(parentKey) ?? []).slice();
    if (sortSessions) own.sort(sortSessions);
    sessionCount += own.length;

    for (const session of own) {
      nodes.push({ type: 'session', id: session.id, session, depth });
    }

    return { nodes, sessionCount };
  };

  return buildLevel(ROOT_KEY, 0).nodes;
}

/** Every group id inside `groupId`'s subtree, excluding `groupId` itself. */
export function descendantGroupIds(groups: Record<string, TabGroupInfo>, groupId: string): string[] {
  const out: string[] = [];
  const queue = [groupId];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const group of Object.values(groups)) {
      if ((group.parentId ?? null) !== cur || seen.has(group.id)) continue;
      seen.add(group.id);
      out.push(group.id);
      queue.push(group.id);
    }
  }
  return out;
}

/** True when `ancestorId` is `groupId` or sits above it. Used to reject a drop
 *  that would put a group inside its own subtree. */
export function isAncestorOf(
  groups: Record<string, TabGroupInfo>,
  ancestorId: string,
  groupId: string,
): boolean {
  if (ancestorId === groupId) return true;
  const seen = new Set<string>();
  let cur: string | null | undefined = groups[groupId]?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = groups[cur]?.parentId ?? null;
  }
  return false;
}

/** Group ids from `groupId` up to its root ancestor, nearest first. */
export function ancestorChain(groups: Record<string, TabGroupInfo>, groupId: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = groupId ?? null;
  while (cur && !seen.has(cur) && groups[cur]) {
    seen.add(cur);
    out.push(cur);
    cur = groups[cur]!.parentId ?? null;
  }
  return out;
}

/** The colour a group renders with: its own, else the nearest ancestor that
 *  sets one, else the caller's fallback. Subgroups are created without a colour
 *  so a whole project branch reads as one family. */
export function resolveGroupColor(
  groups: Record<string, TabGroupInfo>,
  groupId: string | null | undefined,
  fallback = 'blue',
): string {
  for (const id of ancestorChain(groups, groupId)) {
    const color = groups[id]?.color;
    if (color) return color;
  }
  return fallback;
}

/** Sessions in a group's subtree, following the nesting. */
export function sessionIdsInSubtree(
  groups: Record<string, TabGroupInfo>,
  map: Record<string, string>,
  groupId: string,
): string[] {
  const ids = new Set([groupId, ...descendantGroupIds(groups, groupId)]);
  return Object.entries(map).filter(([, gid]) => ids.has(gid)).map(([sid]) => sid);
}

/** Locate a rendered group node by id — the way to reach a group's rendered
 *  `sessionCount`, which only the tree knows. */
export function findGroupNode(
  nodes: TreeNode[],
  groupId: string,
): Extract<TreeNode, { type: 'group' }> | null {
  for (const node of nodes) {
    if (node.type !== 'group') continue;
    if (node.id === groupId) return node;
    const hit = findGroupNode(node.children, groupId);
    if (hit) return hit;
  }
  return null;
}

/** Flatten a tree to the session ids it renders, in visual order. Drives the
 *  sidebar's keyboard/Ctrl-Tab ordering so it matches what the user sees. */
export function flattenSessionIds(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.type === 'session') out.push(node.id);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
