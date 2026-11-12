/**
 * Remembers which Chromium a bridge started, so the next bridge can reap it.
 *
 * The profile is single-instance: while any Chromium holds its SingletonLock,
 * a new launch just hands its arguments to the old process and exits. A bridge
 * killed with SIGKILL (launchd/systemd restart, OOM) never runs its exit hook,
 * so its Chromium would keep the agent's profile — and with it every launch —
 * locked until someone killed it by hand.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';

interface PidRecord {
  pid: number;
  userDataDir: string;
  startedAt: number;
}

export function writePidFile(file: string, record: PidRecord): void {
  try { writeFileSync(file, JSON.stringify(record), { mode: 0o600 }); } catch {}
}

export function removePidFile(file: string): void {
  try { rmSync(file, { force: true }); } catch {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but not ours — still not something we may kill.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Full command line of `pid`, or null when it can't be read. No shell involved. */
export function processCommandLine(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' ').trim() || null; } catch { return null; }
  }
  try {
    const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' });
    if (res.exitCode !== 0) return null;
    return res.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Kill the Chromium recorded in `file` if it is still running on our profile.
 * The command-line check guards against pid reuse: a recycled pid that now
 * belongs to something else is left alone. Returns the pid it reaped.
 */
export async function reapStaleChromium(file: string, userDataDir: string, deps: {
  isAlive?: (pid: number) => boolean;
  commandLine?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<number | null> {
  if (!existsSync(file)) return null;
  let record: PidRecord | null = null;
  try { record = JSON.parse(readFileSync(file, 'utf-8')) as PidRecord; } catch {}
  removePidFile(file);
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1 || record.userDataDir !== userDataDir) return null;

  const alive = deps.isAlive ?? isAlive;
  const commandLine = deps.commandLine ?? processCommandLine;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? Bun.sleep;

  if (!alive(record.pid)) return null;
  const cmd = commandLine(record.pid);
  if (!cmd || !cmd.includes(`--user-data-dir=${userDataDir}`)) return null;

  try { kill(record.pid, 'SIGTERM'); } catch { return null; }
  for (let i = 0; i < 30 && alive(record.pid); i++) await sleep(100);
  if (alive(record.pid)) {
    try { kill(record.pid, 'SIGKILL'); } catch {}
    for (let i = 0; i < 20 && alive(record.pid); i++) await sleep(50);
  }
  return record.pid;
}
