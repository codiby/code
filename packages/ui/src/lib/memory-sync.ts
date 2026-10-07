// Agent memory — cross-host comparison and sync planning. Pure functions over
// the `/memory` listings of two hosts; the modal does the actual reads/writes.

import type { HostMemory, MemoryProvider, MemoryTarget, ProjectMemoryInfo } from './claude-client';

/** MEMORY.md is never synced as a file: the receiving host appends a pointer
 *  for each memory it gets, so copying the index would clobber its own lines. */
export const MEMORY_INDEX = 'MEMORY.md';

export type Side = 'a' | 'b';
export type SyncMode = 'both' | 'push' | 'pull';
export type Presence = 'same' | 'differs' | 'missing' | 'unpaired';

export interface SyncItem {
  id: string;
  /** Group label: "User (global)" or the project name. */
  group: string;
  file: string;
  /** Present on both sides with different content. */
  conflict: boolean;
  /** Side whose copy is written to the other one. */
  from: Side;
  targets: Record<Side, MemoryTarget>;
  mtime: Record<Side, number | null>;
}

export interface SyncPlan {
  items: SyncItem[];
  /** Projects with memory on one host whose folder the other host has never opened. */
  unpaired: { side: Side; name: string }[];
}

export const PROVIDER_FILE: Record<MemoryProvider, string> = {
  claude: '~/.claude/CLAUDE.md',
  codex: '~/.codex/AGENTS.md',
  opencode: '~/.config/opencode/AGENTS.md',
};

export function pairProjects(a: ProjectMemoryInfo[], b: ProjectMemoryInfo[]) {
  const byKey = new Map(b.map(p => [p.key, p]));
  return {
    pairs: a.filter(p => byKey.has(p.key)).map(p => [p, byKey.get(p.key)!] as const),
    onlyA: a.filter(p => !byKey.has(p.key)),
    onlyB: b.filter(p => !a.some(x => x.key === p.key)),
  };
}

/** Which side a one-sided or conflicting item flows from, or null to skip it. */
function direction(hasA: boolean, hasB: boolean, mode: SyncMode, mtimeA: number | null, mtimeB: number | null): Side | null {
  if (hasA && hasB) {
    if (mode === 'push') return 'a';
    if (mode === 'pull') return 'b';
    return (mtimeB ?? 0) > (mtimeA ?? 0) ? 'b' : 'a';
  }
  if (hasA) return mode === 'pull' ? null : 'a';
  return mode === 'push' ? null : 'b';
}

export function planSync(a: HostMemory, b: HostMemory, mode: SyncMode): SyncPlan {
  const items: SyncItem[] = [];

  for (const ua of a.user) {
    const ub = b.user.find(u => u.provider === ua.provider);
    if (!ub || (!ua.exists && !ub.exists) || ua.hash === ub.hash) continue;
    const from = direction(ua.exists, ub.exists, mode, ua.mtime, ub.mtime);
    if (!from) continue;
    const target: MemoryTarget = { scope: 'user', provider: ua.provider };
    items.push({
      id: `user:${ua.provider}`, group: 'User (global)', file: PROVIDER_FILE[ua.provider],
      conflict: ua.exists && ub.exists, from,
      targets: { a: target, b: target }, mtime: { a: ua.mtime, b: ub.mtime },
    });
  }

  const { pairs, onlyA, onlyB } = pairProjects(a.projects, b.projects);
  for (const [pa, pb] of pairs) {
    const names = new Set([...pa.files, ...pb.files].map(f => f.name));
    names.delete(MEMORY_INDEX);
    for (const name of [...names].sort()) {
      const fa = pa.files.find(f => f.name === name);
      const fb = pb.files.find(f => f.name === name);
      if (fa && fb && fa.hash === fb.hash) continue;
      const from = direction(!!fa, !!fb, mode, fa?.mtime ?? null, fb?.mtime ?? null);
      if (!from) continue;
      items.push({
        id: `project:${pa.key}:${name}`, group: pa.name, file: name,
        conflict: !!fa && !!fb, from,
        targets: { a: { scope: 'project', slug: pa.slug, name }, b: { scope: 'project', slug: pb.slug, name } },
        mtime: { a: fa?.mtime ?? null, b: fb?.mtime ?? null },
      });
    }
  }

  // Only projects with something besides the index are worth flagging.
  const worth = (p: ProjectMemoryInfo) => p.files.some(f => f.name !== MEMORY_INDEX);
  const unpaired = [
    ...onlyA.filter(worth).map(p => ({ side: 'a' as const, name: p.name })),
    ...onlyB.filter(worth).map(p => ({ side: 'b' as const, name: p.name })),
  ];
  return { items, unpaired };
}

/** How one file on `host` compares with the same file on another host. */
export function presenceOf(
  host: HostMemory,
  other: HostMemory,
  ref: { scope: 'user'; provider: MemoryProvider } | { scope: 'project'; key: string; name: string },
): Presence {
  if (ref.scope === 'user') {
    const mine = host.user.find(u => u.provider === ref.provider);
    const theirs = other.user.find(u => u.provider === ref.provider);
    if (!theirs?.exists) return 'missing';
    return mine?.hash === theirs.hash ? 'same' : 'differs';
  }
  const mp = host.projects.find(p => p.key === ref.key);
  const op = other.projects.find(p => p.key === ref.key);
  if (!op) return 'unpaired';
  const theirs = op.files.find(f => f.name === ref.name);
  if (!theirs) return 'missing';
  return mp?.files.find(f => f.name === ref.name)?.hash === theirs.hash ? 'same' : 'differs';
}
