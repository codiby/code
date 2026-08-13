/** Sidebar group tree: nesting + automatic worktree grouping.
 *
 *  Two kinds of group end up in the sidebar:
 *
 *  - **Manual** (`kind: 'manual'`, the default) — created by the user or by the
 *    bridge's project autogroup. Persisted in `tabGroups`, nested through
 *    `parentId`, with no depth limit.
 *  - **Worktree** (`kind: 'worktree'`) — *derived*. Never persisted, never
 *    written into `tabGroupMap`. Whenever two or more sessions in the same
 *    parent share a working directory, one materialises around them; drop below
 *    two and it evaporates. Keeping it out of `tabGroupMap` is what lets every
 *    other consumer (project settings, env vars, portless) keep resolving a
 *    session to its real project group.
 *
 *  "Worktree" is git's own word for both kinds of checkout: the repo root is
 *  the *main* working tree and `.worktrees/<branch>` are *linked* ones. The derivation
 *  treats them the same — sessions sitting in the repo root cluster under
 *  `main` exactly like sessions on a branch cluster under that branch. It only
 *  kicks in when the parent actually spans more than one directory; a project
 *  whose sessions all live in the same place gains nothing from a lone child
 *  node repeating its own name.
 *
 *  Everything here is pure so the derivation can be unit-tested without a DOM.
 */

import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';

/** `<repo>/.worktrees/<branch>` — the layout every worktree the app creates
 *  uses. `.wt` is the legacy directory, kept here so worktrees created by older
 *  versions keep deriving; nothing new is ever placed there. Matches `/` and
 *  `\` so Windows paths derive the same way, and only when the branch segment
 *  is the *last* component: anything deeper is an ordinary subdirectory of a
 *  worktree, not the worktree root. Mirrors the regex the bridge uses in
 *  `maybeAutoGroupSession`. */
export const WORKTREE_CWD_RE = /^(.*?)[\\/]\.(?:worktrees|wt)[\\/]([^\\/]+)$/;

/** True when `cwd` is inside a worktree directory at any depth — the loose
 *  test, for callers that only need "is this a worktree checkout?" rather than
 *  the repo/branch split. */
export const WORKTREE_CWD_LOOSE_RE = /[\\/]\.(?:worktrees|wt)[\\/]/;

/** Repo root + branch for a worktree cwd, or null when the cwd isn't one.
 *
 *  Under the current layout `repo` is the real owning repo. For a legacy
 *  `<repo-parent>/.wt/<branch>` path it is the directory that *contained* the
 *  repo, which is why the bridge prefers git's own answer (`rootRepoOf`) and
 *  only falls back to this capture. The UI has no git access, so a legacy
 *  worktree can still label its parent one level too high. */
export function worktreeOf(cwd: string | undefined | null): { repo: string; branch: string } | null {
  if (!cwd) return null;
  const m = cwd.match(WORKTREE_CWD_RE);
  if (!m) return null;
  return { repo: m[1]!, branch: m[2]! };
}

/** Derived-group ids carry this prefix so they can never collide with a real
 *  (uuid) group id, and so callers can reject them before they reach
 *  preferences. */
export const DERIVED_GROUP_PREFIX = 'wt:';

export function derivedGroupId(parentId: string, worktreePath: string): string {
  return `${DERIVED_GROUP_PREFIX}${parentId}::${worktreePath}`;
}

/** Label for a derived checkout group. Linked worktrees read as their branch;
 *  the parent project's own directory reads as `main` (git's name for the
 *  primary working tree); anything else falls back to its folder name. */
export function checkoutLabel(cwd: string, parentCwd: string | undefined): string {
  const wt = worktreeOf(cwd);
  if (wt) return wt.branch;
  if (parentCwd && cwd === parentCwd) return 'main';
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

export function isDerivedGroupId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(DERIVED_GROUP_PREFIX);
}

/** Key used for root-level nodes in the parent-indexed maps. Real group ids are
 *  uuids, so the empty string is unambiguous. */
export const ROOT_KEY = '';

export type TreeNode =
  | { type: 'session'; id: string; session: SessionInfo; depth: number }
  | {
      type: 'group';
      id: string;
      group: TabGroupInfo;
      /** True for worktree groups — not persisted, not renameable, not movable. */
      derived: boolean;
      depth: number;
      children: TreeNode[];
      /** Sessions anywhere in this subtree, not just direct children. */
      sessionCount: number;
    };

export interface BuildTreeOptions {
  /** Sessions to place, already filtered (search) and in fallback order. */
  sessions: SessionInfo[];
  groups: Record<string, TabGroupInfo>;
  /** sessionId → *manual* groupId. Derived groups never appear here. */
  map: Record<string, string>;
  /** Sessions the user dragged out of their worktree group. They stop counting
   *  towards the automatic grouping until they're dropped back in. */
  pinnedOutOfWorktree?: Set<string>;
  /** The global "Group sessions by worktree" preference. `false` skips the
   *  derivation entirely and every session renders as a direct child of its
   *  group. Defaults to on. */
  groupByWorktree?: boolean;
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
 * Build the render tree: manual subgroups first (in their explicit order), then
 * the derived worktree groups, then the parent's own loose sessions.
 */
export function buildGroupTree(opts: BuildTreeOptions): TreeNode[] {
  const { sessions, groups, map, pinnedOutOfWorktree, childOrder, sortSessions } = opts;
  const groupByWorktree = opts.groupByWorktree !== false;

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
      nodes.push({ type: 'group', id, group, derived: false, depth, children: sub.nodes, sessionCount: sub.sessionCount });
      sessionCount += sub.sessionCount;
    }

    const own = (sessionsByGroup.get(parentKey) ?? []).slice();
    if (sortSessions) own.sort(sortSessions);
    sessionCount += own.length;

    // Bucket this parent's sessions by working directory. Only buckets of two
    // or more materialise; the rest stay loose, in their original position.
    const buckets = new Map<string, SessionInfo[]>();
    for (const session of groupByWorktree ? own : []) {
      if (pinnedOutOfWorktree?.has(session.id)) continue;
      if (!session.cwd) continue;
      const list = buckets.get(session.cwd);
      if (list) list.push(session);
      else buckets.set(session.cwd, [session]);
    }
    // Skip the one case where a node earns nothing: the group has a single
    // checkout and it is the project's own directory, so the child would just
    // repeat the parent under a `main` label. A lone *linked* worktree still
    // gets its node — the branch name is information the parent doesn't carry.
    const parentCwd = groups[parentKey]?.cwd;
    const redundant = buckets.size === 1 && !!parentCwd && buckets.has(parentCwd);
    const grouped = new Set<string>();
    for (const [path, members] of redundant ? [] : buckets) {
      if (members.length < 2) continue;
      const id = derivedGroupId(parentKey, path);
      const group: TabGroupInfo = {
        id,
        name: checkoutLabel(path, parentCwd),
        kind: 'worktree',
        worktreePath: path,
        parentId: parentKey || null,
        cwd: path,
      };
      nodes.push({
        type: 'group',
        id,
        group,
        derived: true,
        depth,
        children: members.map(session => ({ type: 'session' as const, id: session.id, session, depth: depth + 1 })),
        sessionCount: members.length,
      });
      for (const m of members) grouped.add(m.id);
    }

    for (const session of own) {
      if (grouped.has(session.id)) continue;
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

/** Sessions in a group's subtree, following both nesting and the derived
 *  worktree grouping (which doesn't change membership, so this is just the
 *  manual subtree). */
export function sessionIdsInSubtree(
  groups: Record<string, TabGroupInfo>,
  map: Record<string, string>,
  groupId: string,
): string[] {
  const ids = new Set([groupId, ...descendantGroupIds(groups, groupId)]);
  return Object.entries(map).filter(([, gid]) => ids.has(gid)).map(([sid]) => sid);
}

/** Locate a rendered group node by id. The only way to reach a *derived*
 *  group's data, since it exists nowhere but the tree. */
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
