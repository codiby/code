/** Recently-used working directories, kept per host.
 *
 *  A path only means something on the machine it came from: `/home/jovaz/vtb`
 *  exists on ryzen9 and nowhere on this Mac. The original storage was one flat
 *  list of strings shared by every session-creation surface, so a directory
 *  browsed on a remote resurfaced under the Local tab (and vice versa) — pick
 *  it and the session boots in a directory that isn't there.
 *
 *  Entries are therefore tagged with the host that produced them. `host` is
 *  `'local'` for this machine, otherwise the remote's id — the same value the
 *  New Session modal keeps in its target tabs, so callers pass what they
 *  already have.
 */

/** Flat `string[]` written by builds before recents were host-aware. Read once
 *  and folded into the new list; never written again. */
const LEGACY_KEY = 'claude-ui-recent-dirs';
const KEY = 'claude-ui-recent-dirs-by-host';
/** Per host, not overall — one busy project shouldn't evict another machine's. */
const MAX_PER_HOST = 10;

/** Host key for this machine. Remotes use their remote id. */
export const LOCAL_HOST = 'local';

export interface RecentDir {
  /** `'local'` or a remote id. */
  host: string;
  dir: string;
}

/** Normalise a caller's host: `null`/`undefined` (the "no remote" convention
 *  used throughout the client) means this machine. */
export function hostKey(remoteId: string | null | undefined): string {
  return remoteId || LOCAL_HOST;
}

function readAll(): RecentDir[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((e): e is RecentDir =>
          !!e && typeof e.host === 'string' && typeof e.dir === 'string');
      }
    }
  } catch {}
  return readLegacy();
}

/** Pre-migration entries have no host. They were written by a build whose only
 *  browsable filesystem was this machine's, so they are local by construction. */
function readLegacy(): RecentDir[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d): d is string => typeof d === 'string')
      .map(dir => ({ host: LOCAL_HOST, dir }));
  } catch { return []; }
}

/** The directories last used on `host`, most recent first. */
export function getRecentDirs(remoteId: string | null | undefined): string[] {
  const host = hostKey(remoteId);
  return readAll().filter(e => e.host === host).map(e => e.dir).slice(0, MAX_PER_HOST);
}

/** Record `dir` as the newest entry for `host`, dropping any earlier use of the
 *  same directory *on that host* — the identical path on another machine is a
 *  different place and keeps its own slot. */
export function addRecentDir(remoteId: string | null | undefined, dir: string): void {
  if (!dir) return;
  const host = hostKey(remoteId);
  const rest = readAll().filter(e => !(e.host === host && e.dir === dir));
  const next = [{ host, dir }, ...rest];
  // Trim per host, preserving the interleaved order of what survives.
  const kept: RecentDir[] = [];
  const perHost = new Map<string, number>();
  for (const entry of next) {
    const n = perHost.get(entry.host) ?? 0;
    if (n >= MAX_PER_HOST) continue;
    perHost.set(entry.host, n + 1);
    kept.push(entry);
  }
  try { localStorage.setItem(KEY, JSON.stringify(kept)); } catch {}
}

/** Drop `host`'s entries that no longer resolve to a directory *on that host*,
 *  returning what survives.
 *
 *  The legacy migration can't tell where a path came from, so everything in the
 *  old flat list landed under `'local'` — including `/home/jovaz/...` paths
 *  browsed on a remote. Only the host itself can say what exists there.
 *
 *  `listDirs` is the client's `/ls` call: without a trailing slash it lists the
 *  parent filtered by name, and it answers `[]` both for "missing" and for "host
 *  unreachable". The root probe tells those apart — an offline remote must not
 *  wipe its own recents. */
export async function pruneRecentDirs(
  remoteId: string | null | undefined,
  listDirs: (prefix: string, remoteId: string | null) => Promise<string[]>,
): Promise<string[]> {
  const host = hostKey(remoteId);
  const remote = remoteId || null;
  const dirs = getRecentDirs(remoteId);
  if (dirs.length === 0) return dirs;
  const strip = (p: string) => p.replace(/[\\/]+$/, '');
  try {
    if ((await listDirs('/', remote)).length === 0) return dirs;
  } catch { return dirs; }
  const checks = await Promise.all(dirs.map(async dir => {
    try {
      const target = strip(dir);
      return (await listDirs(target, remote)).some(d => strip(d) === target);
    } catch { return true; }
  }));
  const missing = new Set(dirs.filter((_, i) => !checks[i]));
  if (missing.size === 0) return dirs;
  const kept = readAll().filter(e => !(e.host === host && missing.has(e.dir)));
  try { localStorage.setItem(KEY, JSON.stringify(kept)); } catch {}
  return dirs.filter(d => !missing.has(d));
}
