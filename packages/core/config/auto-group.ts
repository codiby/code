/** Where sessions land in the sidebar — the grouping rules, in one place.
 *
 *  Two entry points, same rules:
 *
 *  - `planAutoGroup` places a *freshly-created* session. IO wrapper:
 *    `maybeAutoGroupSession` in `index.ts`.
 *  - `planAutoGroupExisting` retroactively places the sessions already sitting
 *    loose, on explicit user request. IO wrapper: `autoGroupLooseSessions`,
 *    exposed over HTTP so the desktop renderer and the mobile client share it
 *    instead of each carrying its own copy.
 *
 *  Both are pure: they take the current groups/map and return the updated pair,
 *  so the rules can be tested without preferences, git or a server. The wrappers
 *  do the two impure things — resolving the owning repo through git, and
 *  persisting whatever comes back in a single preferences write.
 *
 *  Three rules, first match wins:
 *
 *  1. **Auto-claim** — a group whose `cwd` is exactly the session's, anywhere in
 *     the tree, takes it. This is what carries a branch group forward after the
 *     user renames or moves it.
 *  2. **Branch** — a linked worktree that already holds another loose session
 *     gets a subgroup of the project, named after the branch. Created on the
 *     *second* session: a lone session on a branch does not earn a folder.
 *  3. **Project** — a top-level group named after the repo folder.
 *
 *  Everything it writes is an ordinary persisted group. Nothing re-derives on
 *  render, so once a session is placed the user owns its position.
 */

import { WORKTREE_CWD_RE } from '../handlers/worktree';

export interface AutoGroup {
  id: string;
  name: string;
  color?: string;
  cwd?: string;
  icon?: string;
  /** Autogroups are top-level projects; the user can nest them later. */
  parentId?: string | null;
  /** Set on branch subgroups so later sessions on the same checkout join
   *  without re-running the two-session test. */
  autoClaim?: boolean;
}

export const AUTOGROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];

export interface AutoGroupInput {
  sessionId: string;
  /** Where the session actually runs — what rules 1 and 2 key on. */
  sessionCwd: string;
  /** The repo that owns it, already resolved by the caller (git, falling back
   *  to the `<repo>/.worktrees/<branch>` capture). Rule 3 keys on this. */
  projectCwd: string;
  groups: Record<string, AutoGroup>;
  /** sessionId → groupId, including the session being placed if a caller
   *  already assigned it (in which case nothing here applies). */
  map: Record<string, string>;
  /** Every other live session's cwd, keyed by id. */
  sessionCwds: Record<string, string>;
  autoGroupSessions: boolean;
  groupSessionsByWorktree: boolean;
  newId: () => string;
}

export interface AutoGroupResult {
  groups: Record<string, AutoGroup>;
  map: Record<string, string>;
}

/** The updated groups/map, or `null` when nothing should change. */
export function planAutoGroup(input: AutoGroupInput): AutoGroupResult | null {
  const { sessionId, sessionCwd, projectCwd, sessionCwds, newId } = input;
  if (!projectCwd) return null;
  const map = { ...input.map };
  // An explicit group assignment from the caller wins over every rule here.
  if (map[sessionId]) return null;
  const groups = { ...input.groups };

  const claimed = Object.keys(groups).find(gid => groups[gid]!.autoClaim && groups[gid]!.cwd === sessionCwd);
  if (claimed) {
    map[sessionId] = claimed;
    return { groups, map };
  }

  let projectGroupId: string | null = null;
  if (input.autoGroupSessions) {
    const folder = projectCwd.split('/').filter(Boolean).pop()
      || projectCwd.split('\\').filter(Boolean).pop()
      || '/';
    // Match on top-level groups only: with nesting, a subgroup could legitimately
    // share a name with a project (two repos each with a "Backend" subgroup), and
    // autogrouping into one of those would be wrong.
    projectGroupId = Object.keys(groups).find(gid => groups[gid]!.name === folder && !groups[gid]!.parentId) ?? null;
    if (!projectGroupId) {
      projectGroupId = newId();
      const color = AUTOGROUP_COLORS[Object.keys(groups).length % AUTOGROUP_COLORS.length]!;
      groups[projectGroupId] = { id: projectGroupId, name: folder, color, cwd: projectCwd, parentId: null };
    }
  }

  let targetId = projectGroupId;
  const branch = sessionCwd.match(WORKTREE_CWD_RE)?.[2];
  if (branch && input.groupSessionsByWorktree) {
    // Only bother once the checkout is actually shared. Sessions already filed
    // somewhere else by hand are left alone — the subgroup collects the ones
    // that would otherwise sit loose beside it.
    const loose = Object.keys(sessionCwds).filter(id =>
      id !== sessionId && sessionCwds[id] === sessionCwd && (map[id] ?? null) === projectGroupId);
    if (loose.length) {
      targetId = newId();
      // No colour: a subgroup inherits its project's, so the branch reads as
      // part of that family rather than as a project of its own. The icon is a
      // plain default the user can change — nothing downstream keys on it.
      groups[targetId] = {
        id: targetId, name: branch, cwd: sessionCwd, parentId: projectGroupId,
        icon: 'git-branch', autoClaim: true,
      };
      for (const id of loose) map[id] = targetId;
    }
  }

  if (!targetId) return null;
  map[sessionId] = targetId;
  return { groups, map };
}

/** One session to consider in a retroactive pass. `projectCwd` is resolved by
 *  the caller through git, which is the whole reason this lives in the bridge:
 *  a session started in `code/packages/ui` resolves to `code`, not `ui`. */
export interface LooseSession {
  sessionId: string;
  sessionCwd: string;
  projectCwd: string;
}

/** One destination group in a retroactive plan. */
export interface AutoGroupPlanEntry {
  name: string;
  /** The group's id. Newly-minted for groups this plan would create — those
   *  ids only survive if the plan is applied. */
  groupId: string;
  /** True when the group already existed before this pass. Drives the "(new)"
   *  marker in the confirmation dialog. */
  exists: boolean;
  sessionIds: string[];
}

export interface ExistingAutoGroupResult {
  groups: Record<string, AutoGroup>;
  map: Record<string, string>;
  plan: AutoGroupPlanEntry[];
  /** Sessions that would move — the sum of the plan's `sessionIds`. */
  moved: number;
}

/** Retroactively group the sessions that are sitting loose in the sidebar.
 *
 *  Distinct from `planAutoGroup`, which only ever runs on a session being
 *  *created* and never touches what already exists. This is the other half:
 *  the same rules, applied to what is already there, on explicit user request.
 *  The two coexist — the `autoGroupSessions` preference gates the first and has
 *  no say here, because the user asking for it *is* the intent.
 *
 *  Every loose session lands in its project's group; a project with a single
 *  loose session still earns one. Resolving the repo root through git is what
 *  makes that safe: sessions scattered across subdirectories of one repo
 *  collapse into a single group instead of one group per subdirectory.
 *
 *  Sessions the user already filed are never touched, and the fold is
 *  idempotent — a second pass finds nothing loose and returns an empty plan.
 */
export function planAutoGroupExisting(input: {
  /** Loose, open sessions only. Anything already in `map` is the user's doing. */
  sessions: LooseSession[];
  groups: Record<string, AutoGroup>;
  map: Record<string, string>;
  newId: () => string;
}): ExistingAutoGroupResult {
  let groups = { ...input.groups };
  let map = { ...input.map };
  // Groups minted during this pass — what separates "joined your existing
  // folder" from "(new)" for the second session that lands in the same one.
  const created = new Set<string>();
  const byGroup = new Map<string, AutoGroupPlanEntry>();

  for (const session of input.sessions) {
    const before = new Set(Object.keys(groups));
    const step = planAutoGroup({
      sessionId: session.sessionId,
      sessionCwd: session.sessionCwd,
      projectCwd: session.projectCwd,
      groups,
      map,
      sessionCwds: {},
      // The user asked for this, so the creation-time preference doesn't apply.
      autoGroupSessions: true,
      // Project grouping only. A branch subgroup is a creation-time concern:
      // it would surface here as a bare `feat-a` entry beside `code`, which
      // reads as a sibling project rather than as part of one.
      groupSessionsByWorktree: false,
      newId: input.newId,
    });
    if (!step) continue;

    groups = step.groups;
    map = step.map;
    const targetId = map[session.sessionId]!;
    for (const id of Object.keys(groups)) if (!before.has(id)) created.add(id);

    const entry = byGroup.get(targetId);
    if (entry) entry.sessionIds.push(session.sessionId);
    else byGroup.set(targetId, {
      name: groups[targetId]!.name,
      groupId: targetId,
      exists: !created.has(targetId),
      sessionIds: [session.sessionId],
    });
  }

  const plan = [...byGroup.values()];
  return { groups, map, plan, moved: plan.reduce((n, e) => n + e.sessionIds.length, 0) };
}
