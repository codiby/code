/**
 * Project replication between bridges.
 *
 * A project spans every host that has one of its folders. Each of those hosts
 * keeps the same bundle in its own preferences — the definition (name,
 * colour, folders, GitHub orgs) plus its organization (its groups, session
 * assignments, child order, pins) — and the bridges keep it identical among
 * themselves, whether or not any window is open. Whole bundle, last change
 * wins by `updatedAt`; deletions travel as tombstones.
 *
 * Every local write of the preferences goes through `onLocalWrite` (from
 * `updatePreferences`): a project whose definition or organization changed
 * gets a new version, and a sync is scheduled. A sync is one round trip per
 * paired host: we send the versions we hold for the projects it spans and
 * every bundle it may lack; it applies the newer ones and answers with its
 * own newer ones. The same exchange runs at boot and every few minutes, which
 * is how a host that was offline catches up in both directions.
 */

import { listRemotes } from '../network/remotes';
import { getHostIdentity } from '../network/host-identity';
import { peers } from '../network/peers';
import { logError } from '../lib/logger';
import {
  applyPeerProjects, bundleOf, mergeProjects, parseStoredProjects, projectHosts, resolveFolderHosts, stampProjects,
  type OrgBundle, type OrgPrefs, type StoredProject, type TabGroupInfo,
} from './bundle';

type Prefs = Record<string, unknown>;
interface Wire { project: StoredProject; bundle: OrgBundle | null }

let load: () => Prefs = () => ({});
let commit: (prefs: Prefs) => void = () => {};
/** Wire the store: how to read the preferences, and how to save + broadcast. */
export function setProjectSyncStore(read: () => Prefs, write: (prefs: Prefs) => void): void { load = read; commit = write; }

function orgOf(prefs: Prefs): OrgPrefs & { projects: Record<string, StoredProject> } {
  return {
    tabGroups: (prefs.tabGroups as Record<string, TabGroupInfo>) ?? {},
    tabGroupMap: (prefs.tabGroupMap as Record<string, string>) ?? {},
    groupOrder: (prefs.groupOrder as Record<string, string[]>) ?? {},
    pinnedSessionIds: Array.isArray(prefs.pinnedSessionIds) ? prefs.pinnedSessionIds as string[] : [],
    projects: parseStoredProjects(prefs.projects),
  };
}

const hostOfRemote = (remoteId: string) => listRemotes().find(r => r.id === remoteId)?.hostId;

/**
 * Called by `updatePreferences` with the stored prefs and the merged result,
 * before saving. Projects merge per id (a stale window can't drop or rewind
 * one), folders get their host identity, and changed projects are stamped.
 * Returns the prefs to save.
 */
export function onLocalWrite(before: Prefs, next: Prefs, now = Date.now()): Prefs {
  const touched = 'projects' in next && next.projects !== before.projects;
  let projects = touched
    ? mergeProjects(parseStoredProjects(before.projects), parseStoredProjects(next.projects))
    : parseStoredProjects(next.projects);
  projects = resolveFolderHosts(projects, getHostIdentity().hostId, hostOfRemote);
  const stamped = stampProjects(projects, orgOf(next), now);
  if (stamped.changed.length || touched) scheduleSync();
  return { ...next, projects: stamped.projects };
}

function wireFor(prefs: Prefs, filter: (p: StoredProject) => boolean): Wire[] {
  const org = orgOf(prefs);
  return Object.values(org.projects).filter(filter).map(project => ({
    project, bundle: project.deleted ? null : bundleOf(org, project.id),
  }));
}

/** Apply a peer's newer versions; true when anything changed. */
function applyFromPeer(incoming: Wire[]): boolean {
  const prefs = load();
  const applied = applyPeerProjects(orgOf(prefs), incoming, getHostIdentity().hostId);
  if (!applied) return false;
  commit({
    ...prefs,
    projects: applied.projects, tabGroups: applied.tabGroups, tabGroupMap: applied.tabGroupMap,
    groupOrder: applied.groupOrder, pinnedSessionIds: applied.pinnedSessionIds,
  });
  return true;
}

/** `/peer/projects`: take the sender's newer versions, answer with ours. */
export function handlePeerProjects(body: { source: { hostId: string }; projects?: Wire[]; versions?: Record<string, number> }): { projects: Wire[] } {
  const sender = body.source.hostId;
  applyFromPeer(Array.isArray(body.projects) ? body.projects : []);
  const theirs = body.versions ?? {};
  // Ours that span the sender and that it lacks or holds older.
  return { projects: wireFor(load(), p => projectHosts(p).has(sender) && (theirs[p.id] ?? -1) < p.updatedAt) };
}

// ── outgoing ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;

export function scheduleSync(delay = 1500): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void syncAll(); }, delay);
}

async function syncAll(): Promise<void> {
  if (running) { again = true; return; }
  running = true;
  try {
    for (const remote of listRemotes()) {
      if (remote.coordination !== 'write' || !remote.hostId) continue;
      const prefs = load();
      const spanning = wireFor(prefs, p => projectHosts(p).has(remote.hostId!));
      const versions = Object.fromEntries(Object.values(orgOf(prefs).projects).map(p => [p.id, p.updatedAt]));
      try {
        const res = await peers.post<{ projects?: Wire[] }>(remote.id, '/peer/projects', { projects: spanning, versions });
        if (res.projects?.length) applyFromPeer(res.projects);
      } catch (e) {
        // Offline, unpaired, or an older bridge: the periodic pass retries.
        logError(`[projects] sync with ${remote.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    running = false;
    if (again) { again = false; scheduleSync(); }
  }
}

/** Boot: catch up at once, then keep checking — a host that was offline
 *  converges within a few minutes in both directions. */
export function startProjectSync(): void {
  scheduleSync(5000);
  setInterval(() => scheduleSync(0), 3 * 60_000);
}
