import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';
import { ancestorChain } from './group-tree';

/**
 * Projects are their own thing, defined by the user: a name, a colour and
 * one or more folders, each on a given host (`vtb` on ryzen9 and `vtb` on the
 * Mac are two folders of one project). A session belongs to a project when it
 * runs in one of those folders, or anywhere below it (worktrees included).
 *
 * Groups stay what they were: the user's own folders in the sidebar. Scoping
 * to a project hides sessions from other projects and the groups left with
 * nothing to show; it never moves anything, so drag-and-drop and "ungroup"
 * keep meaning exactly what they mean unscoped. Persisted in the synced
 * preferences under `projects`.
 */

/** The bridge's fixed folder for throwaway sessions. Mirrors core's constant. */
export const DISPOSABLES_GROUP_ID = 'disposables';

export interface ProjectFolder {
  path: string;
  /** Host the folder lives on; null = the machine running this bridge. */
  remoteId: string | null;
}

export interface Project {
  id: string;
  name: string;
  color?: string;
  folders: ProjectFolder[];
  /** GitHub organizations (or users) whose repos belong to the project — its
   *  pull requests land in its Inbox and its agents start in it. */
  githubOrgs?: string[];
}

/** The project a repository (`owner/name`) belongs to, by its GitHub owner. */
export function projectOfRepo(repo: string, projects: Pick<Project, 'id' | 'githubOrgs'>[]): string | null {
  const owner = repo.split('/')[0]?.toLowerCase();
  if (!owner) return null;
  return projects.find(p => p.githubOrgs?.some(o => o.toLowerCase() === owner))?.id ?? null;
}

export interface ProjectSummary extends Project {
  /** Open sessions in the project's folders. */
  sessionCount: number;
  /** Of those, how many are streaming / waiting on a permission. */
  liveCount: number;
  waitingCount: number;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

/** Validate whatever came back from the preferences file. */
export function parseProjects(raw: unknown): Record<string, Project> {
  const out: Record<string, Project> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as Partial<Project>;
    if (typeof p.name !== 'string' || !p.name.trim()) continue;
    const folders = Array.isArray(p.folders)
      ? p.folders
        .filter((f): f is ProjectFolder => !!f && typeof (f as ProjectFolder).path === 'string' && !!(f as ProjectFolder).path.trim())
        .map(f => ({ path: trimSlash(f.path.trim()), remoteId: typeof f.remoteId === 'string' && f.remoteId ? f.remoteId : null }))
      : [];
    out[id] = { id, name: p.name.trim(), color: typeof p.color === 'string' ? p.color : undefined, folders };
  }
  return out;
}

/** True when `session` runs in one of `project`'s folders (or below one), on
 *  that folder's host. */
export function sessionInProject(session: Pick<SessionInfo, 'cwd' | 'remoteId'>, project: Project): boolean {
  const cwd = trimSlash(session.cwd || '');
  if (!cwd) return false;
  const host = session.remoteId ?? null;
  return project.folders.some(f =>
    (f.remoteId ?? null) === host && (cwd === f.path || cwd.startsWith(`${f.path}/`) || cwd.startsWith(`${f.path}\\`)));
}

/** The project a session belongs to: the one with the most specific folder
 *  match, so a nested project wins over the one around it. */
export function projectOfSession(session: Pick<SessionInfo, 'cwd' | 'remoteId'>, projects: Record<string, Project>): string | null {
  let best: { id: string; len: number } | null = null;
  for (const p of Object.values(projects)) {
    if (!sessionInProject(session, p)) continue;
    const len = Math.max(...p.folders.filter(f => sessionInProject(session, { ...p, folders: [f] })).map(f => f.path.length));
    if (!best || len > best.len) best = { id: p.id, len };
  }
  return best?.id ?? null;
}

/** Projects sorted by name, with per-project counts. */
export function listProjects(input: {
  projects: Record<string, Project>;
  sessions: SessionInfo[];
  isLive?: (id: string) => boolean;
  isWaiting?: (id: string) => boolean;
}): ProjectSummary[] {
  const { projects, sessions, isLive, isWaiting } = input;
  return Object.values(projects)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => {
      const members = sessions.filter(s => sessionInProject(s, p));
      return {
        ...p,
        sessionCount: members.length,
        liveCount: members.filter(s => isLive?.(s.id)).length,
        waitingCount: members.filter(s => isWaiting?.(s.id)).length,
      };
    });
}

export interface ScopeInput {
  groups: Record<string, TabGroupInfo>;
  /** sessionId → groupId. */
  map: Record<string, string>;
  sessions: SessionInfo[];
}

/**
 * Narrow the sidebar to one project. Keeps the project's sessions, every
 * group on the way to one of them, and groups created inside the project
 * (`group.projectId`) even while empty. `null` returns the input untouched.
 */
export function scopeToProject(input: ScopeInput, project: Project | null): ScopeInput {
  if (!project) return input;
  const { groups, map, sessions } = input;
  const kept = sessions.filter(s => sessionInProject(s, project));
  const keepGroups = new Set<string>();
  const keepChain = (gid: string | undefined) => {
    if (!gid || !groups[gid]) return;
    for (const id of ancestorChain(groups, gid)) keepGroups.add(id);
  };
  for (const s of kept) keepChain(map[s.id]);
  for (const g of Object.values(groups)) if (g.projectId === project.id) keepChain(g.id);
  // An empty folder kept on purpose (`allowEmpty`) goes with its parent: a
  // ticket folder inside a project's group is that project's, sessions or not.
  keepEmptyChildren(groups, map, keepGroups, g => !g.projectId || g.projectId === project.id);

  const scopedGroups: Record<string, TabGroupInfo> = {};
  for (const id of keepGroups) scopedGroups[id] = groups[id]!;
  const keptIds = new Set(kept.map(s => s.id));
  const scopedMap: Record<string, string> = {};
  for (const [sid, gid] of Object.entries(map)) if (keptIds.has(sid) && keepGroups.has(gid)) scopedMap[sid] = gid;
  return { groups: scopedGroups, map: scopedMap, sessions: kept };
}

/** Add every empty, kept-on-purpose group whose parent is already in `keep`,
 *  down any depth. `ok` filters out groups that belong somewhere else. */
export function keepEmptyChildren(
  groups: Record<string, TabGroupInfo>, map: Record<string, string>, keep: Set<string>,
  ok: (g: TabGroupInfo) => boolean = () => true,
): void {
  const used = new Set(Object.values(map));
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of Object.values(groups)) {
      if (keep.has(g.id) || !g.allowEmpty || used.has(g.id) || !g.parentId || !keep.has(g.parentId) || !ok(g)) continue;
      keep.add(g.id);
      grew = true;
    }
  }
}
