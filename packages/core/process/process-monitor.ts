/**
 * Per-session process & port monitor.
 *
 * Surfaces, for every session, the background child processes it has spawned
 * (via `spawnTrackedProcess` / PTY terminals / actions) and any TCP ports those
 * processes — or their descendants — are listening on. The frontend renders
 * this as two badges on each sidebar session row (running processes / listening
 * ports).
 *
 * There's no portable kernel push for "a child just opened a port", so we poll:
 *   - one process-table snapshot to walk the descendant tree of each tracked
 *     PID, and
 *   - one listening-socket snapshot to map listening ports → owning PID.
 * Results are diffed against the last broadcast per session, so a
 * `session_activity` WS message is only emitted when something actually
 * changed. `pokeProcessMonitor()` lets callers (e.g. a fresh spawn/exit) ask
 * for an out-of-band poll so the process badge appears without waiting a full
 * interval; the port badge still trails by up to one interval since a process
 * binds its port a moment after it starts.
 *
 * Both snapshots are async and scoped to the PIDs we actually track. That
 * matters: this runs every POLL_MS on the same thread that serves HTTP and
 * pumps terminal I/O, so anything synchronous here stalls the whole server,
 * and any scan whose cost scales with the machine rather than with the tracked
 * subtree will eventually stall it for a long time.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readlink, readFile } from 'fs/promises';
import { log, logError } from '../lib/logger';
import { trackedProcesses } from '../handlers/processes';

const execFileAsync = promisify(execFile);
const IS_LINUX = process.platform === 'linux';

export type ListeningPort = { port: number; pid: number; command: string };

export type SessionActivity = {
  /** Number of live background processes the session owns (tracked roots). */
  childProcessCount: number;
  /** The tracked root processes, for the hover tooltip. */
  processes: { pid: number; command: string; label?: string }[];
  /** Distinct TCP ports in LISTEN owned by the session's process subtree. */
  listeningPorts: ListeningPort[];
};

type Broadcast = (sessionId: string, msg: object) => void;

/** Steady poll cadence. Idle sessions (no tracked processes) cost nothing —
 *  we early-out before touching the process table. */
const POLL_MS = 3000;
/** Debounce for `pokeProcessMonitor` so a burst of spawns coalesces. */
const POKE_MS = 200;

let timer: ReturnType<typeof setInterval> | null = null;
let pokeTimer: ReturnType<typeof setTimeout> | null = null;
let broadcast: Broadcast | null = null;
/** Guard so a poll that outruns POLL_MS doesn't stack with the next one. */
let polling = false;

/** Last activity payload broadcast per session, JSON-encoded for cheap diffing.
 *  A session leaves this map once it goes fully idle (after one empty
 *  broadcast that clears the badges on the frontend). */
const lastSnapshot = new Map<string, string>();

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Build a ppid → child-pids index from one process-table snapshot. */
async function readProcessParents(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>();
  const add = (pid: number, ppid: number): void => {
    let list = children.get(ppid);
    if (!list) { list = []; children.set(ppid, list); }
    list.push(pid);
  };

  if (IS_LINUX) {
    // Read /proc directly — no subprocess to spawn and reap.
    let entries: string[];
    try { entries = await readdir('/proc'); } catch { return children; }
    await Promise.all(entries.map(async (name) => {
      const pid = parseInt(name, 10);
      if (!pid) return;
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
        // `comm` is parenthesised and may itself contain spaces or parens, so
        // anchor on the last ')': after it come state and ppid.
        const close = stat.lastIndexOf(')');
        if (close === -1) return;
        const ppid = parseInt(stat.slice(close + 2).split(' ')[1] ?? '', 10);
        if (!Number.isNaN(ppid)) add(pid, ppid);
      } catch { /* process exited mid-walk */ }
    }));
    return children;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf-8', timeout: 3000, maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      add(parseInt(m[1]!, 10), parseInt(m[2]!, 10));
    }
  } catch { /* fall through with whatever we have */ }
  return children;
}

/** All descendant pids of `root` (inclusive), via BFS over the parent index. */
function collectSubtree(root: number, childrenOf: Map<number, number[]>, into: Set<number>): void {
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    if (into.has(pid)) continue;
    into.add(pid);
    const kids = childrenOf.get(pid);
    if (kids) queue.push(...kids);
  }
}

/** socket inode → local port, for every TCP socket in LISTEN. */
async function readListenInodes(): Promise<Map<string, number>> {
  const byInode = new Map<string, number>();
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = await readFile(path, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    // Line 0 is the header.
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i]!.trim().split(/\s+/);
      if (f.length < 10) continue;
      if (f[3] !== '0A') continue; // 0A = TCP_LISTEN
      const local = f[1] ?? '';
      const colon = local.lastIndexOf(':');
      if (colon === -1) continue;
      const port = parseInt(local.slice(colon + 1), 16);
      const inode = f[9]!;
      if (port > 0 && inode !== '0') byInode.set(inode, port);
    }
  }
  return byInode;
}

/** How many readlink() calls to keep in flight per process. A tracked process
 *  that leaks fds would otherwise put its whole fd table into a single
 *  Promise.all. */
const FD_BATCH = 1024;

/** Parse `lsof -Fpn` machine-readable output into (pid, port) pairs. */
function parseLsof(out: string): { pid: number; port: number }[] {
  const result: { pid: number; port: number }[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') {
      pid = parseInt(rest, 10) || 0;
    } else if (tag === 'n' && pid) {
      // `n` field looks like "*:3000", "127.0.0.1:5173", "[::1]:8080".
      const colon = rest.lastIndexOf(':');
      if (colon === -1) continue;
      const port = parseInt(rest.slice(colon + 1), 10);
      if (port > 0) result.push({ pid, port });
    }
  }
  return result;
}

/** Map listening TCP ports → owning pid, considering only `pids`.
 *
 *  Scoping is the whole point. An unscoped `lsof -iTCP` readlink()s every fd of
 *  every process on the box and only then applies the filter, so its cost is
 *  set by the noisiest process on the machine rather than by anything we care
 *  about — a single process holding a few hundred thousand fds pushes it into
 *  the seconds. We only ever ask about tracked subtrees, so we only look there. */
async function readListeningPorts(pids: Set<number>): Promise<{ pid: number; port: number }[]> {
  if (pids.size === 0) return [];

  if (IS_LINUX) {
    const portByInode = await readListenInodes();
    if (portByInode.size === 0) return [];
    const result: { pid: number; port: number }[] = [];
    await Promise.all([...pids].map(async (pid) => {
      let fds: string[];
      try { fds = await readdir(`/proc/${pid}/fd`); } catch { return; }
      for (let i = 0; i < fds.length; i += FD_BATCH) {
        const targets = await Promise.all(fds.slice(i, i + FD_BATCH).map(
          fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''),
        ));
        for (const target of targets) {
          if (!target.startsWith('socket:[')) continue;
          const port = portByInode.get(target.slice(8, -1));
          if (port) result.push({ pid, port });
        }
      }
    }));
    return result;
  }

  // macOS/BSD: no /proc, so lsof stays — but restricted to the tracked pids.
  const args = ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn', '-a', '-p', [...pids].join(',')];
  try {
    const { stdout } = await execFileAsync('lsof', args, {
      encoding: 'utf-8', timeout: 4000, maxBuffer: 16 * 1024 * 1024,
    });
    return parseLsof(stdout);
  } catch (err) {
    // lsof exits non-zero when nothing matches, but still prints what it found.
    const stdout = (err as { stdout?: string }).stdout;
    return stdout ? parseLsof(stdout) : [];
  }
}

async function computeActivity(): Promise<Map<string, SessionActivity>> {
  // Group live tracked roots by session.
  const rootsBySession = new Map<string, { pid: number; command: string; label?: string }[]>();
  for (const [, tp] of trackedProcesses) {
    if (!tp.pid || tp.exitCode !== null) continue;
    if (!isPidAlive(tp.pid)) continue;
    let list = rootsBySession.get(tp.sessionId);
    if (!list) { list = []; rootsBySession.set(tp.sessionId, list); }
    list.push({ pid: tp.pid, command: tp.command.slice(0, 200), label: tp.label });
  }

  const activity = new Map<string, SessionActivity>();
  if (rootsBySession.size === 0) return activity;

  const childrenOf = await readProcessParents();

  // Resolve every subtree first so the port scan can be scoped to their union
  // and run once, rather than per session.
  const subtrees = new Map<string, Set<number>>();
  const trackedPids = new Set<number>();
  for (const [sessionId, roots] of rootsBySession) {
    const subtree = new Set<number>();
    for (const r of roots) collectSubtree(r.pid, childrenOf, subtree);
    subtrees.set(sessionId, subtree);
    for (const pid of subtree) trackedPids.add(pid);
  }

  const ports = await readListeningPorts(trackedPids);

  for (const [sessionId, roots] of rootsBySession) {
    const subtree = subtrees.get(sessionId)!;

    const seen = new Set<number>();
    const listeningPorts: ListeningPort[] = [];
    for (const { pid, port } of ports) {
      if (!subtree.has(pid) || seen.has(port)) continue;
      seen.add(port);
      const owner = roots.find(r => r.pid === pid);
      listeningPorts.push({ port, pid, command: owner?.command ?? 'process' });
    }
    listeningPorts.sort((a, b) => a.port - b.port);

    activity.set(sessionId, {
      childProcessCount: roots.length,
      processes: roots,
      listeningPorts,
    });
  }
  return activity;
}

async function poll(): Promise<void> {
  if (!broadcast) return;
  // Idle fast-path: nothing tracked anywhere → clear any lingering badges.
  if (trackedProcesses.size === 0 && lastSnapshot.size === 0) return;
  // A slow poll must not overlap the next tick.
  if (polling) return;
  polling = true;

  try {
    const activity = await computeActivity();

    // Emit changed sessions.
    for (const [sessionId, act] of activity) {
      const key = JSON.stringify(act);
      if (lastSnapshot.get(sessionId) === key) continue;
      lastSnapshot.set(sessionId, key);
      broadcast(sessionId, { type: 'session_activity', sessionId, activity: act });
    }

    // Sessions that dropped to fully idle since last poll → one empty broadcast,
    // then forget them so we don't keep re-emitting the empty state.
    for (const sessionId of [...lastSnapshot.keys()]) {
      if (activity.has(sessionId)) continue;
      lastSnapshot.delete(sessionId);
      broadcast(sessionId, {
        type: 'session_activity',
        sessionId,
        activity: { childProcessCount: 0, processes: [], listeningPorts: [] } as SessionActivity,
      });
    }
  } catch (err) {
    logError(`[procmon] poll failed: ${err}`);
  } finally {
    polling = false;
  }
}

/** Start the steady poll loop. Idempotent. */
export function startProcessMonitor(broadcastFn: Broadcast): void {
  broadcast = broadcastFn;
  if (timer) return;
  timer = setInterval(() => { void poll(); }, POLL_MS);
  log('[procmon] started');
}

export function stopProcessMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (pokeTimer) { clearTimeout(pokeTimer); pokeTimer = null; }
}

/** Request an out-of-band poll (debounced). Call after a tracked process is
 *  spawned or exits so the process badge updates without waiting a full
 *  interval. */
export function pokeProcessMonitor(): void {
  if (!broadcast || pokeTimer) return;
  pokeTimer = setTimeout(() => { pokeTimer = null; void poll(); }, POKE_MS);
}
