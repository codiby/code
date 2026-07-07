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
 *   - one `ps` snapshot to walk the descendant tree of each tracked PID, and
 *   - one `lsof` snapshot to map listening ports → owning PID.
 * Results are diffed against the last broadcast per session, so a
 * `session_activity` WS message is only emitted when something actually
 * changed. `pokeProcessMonitor()` lets callers (e.g. a fresh spawn/exit) ask
 * for an out-of-band poll so the process badge appears without waiting a full
 * interval; the port badge still trails by up to one interval since a process
 * binds its port a moment after it starts.
 */

import { execSync } from 'child_process';
import { log, logError } from '../lib/logger';
import { trackedProcesses } from '../handlers/processes';

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
 *  we early-out before touching `ps`/`lsof`. */
const POLL_MS = 3000;
/** Debounce for `pokeProcessMonitor` so a burst of spawns coalesces. */
const POKE_MS = 200;

let timer: ReturnType<typeof setInterval> | null = null;
let pokeTimer: ReturnType<typeof setTimeout> | null = null;
let broadcast: Broadcast | null = null;

/** Last activity payload broadcast per session, JSON-encoded for cheap diffing.
 *  A session leaves this map once it goes fully idle (after one empty
 *  broadcast that clears the badges on the frontend). */
const lastSnapshot = new Map<string, string>();

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Build a ppid → child-pids index from a single `ps` snapshot. */
function readProcessParents(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  let out: string;
  try {
    out = execSync('ps -axo pid=,ppid=', { encoding: 'utf-8', timeout: 3000 });
  } catch {
    return children;
  }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const ppid = parseInt(m[2]!, 10);
    let list = children.get(ppid);
    if (!list) { list = []; children.set(ppid, list); }
    list.push(pid);
  }
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

/** Map every listening TCP port → owning pid via one `lsof` machine-readable
 *  snapshot. Returns [] when lsof is unavailable or errors. */
function readListeningPorts(): { pid: number; port: number }[] {
  let out: string;
  try {
    out = execSync('lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null', { encoding: 'utf-8', timeout: 4000 });
  } catch {
    return [];
  }
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

function computeActivity(): Map<string, SessionActivity> {
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

  const childrenOf = readProcessParents();
  const ports = readListeningPorts();

  for (const [sessionId, roots] of rootsBySession) {
    const subtree = new Set<number>();
    for (const r of roots) collectSubtree(r.pid, childrenOf, subtree);

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

function poll(): void {
  if (!broadcast) return;
  // Idle fast-path: nothing tracked anywhere → clear any lingering badges.
  if (trackedProcesses.size === 0 && lastSnapshot.size === 0) return;

  let activity: Map<string, SessionActivity>;
  try {
    activity = computeActivity();
  } catch (err) {
    logError(`[procmon] poll failed: ${err}`);
    return;
  }

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
}

/** Start the steady poll loop. Idempotent. */
export function startProcessMonitor(broadcastFn: Broadcast): void {
  broadcast = broadcastFn;
  if (timer) return;
  timer = setInterval(poll, POLL_MS);
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
  pokeTimer = setTimeout(() => { pokeTimer = null; poll(); }, POKE_MS);
}
