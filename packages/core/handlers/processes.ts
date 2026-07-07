import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { corsHeaders, CODIBY_DIR } from '../config/config';
import { log } from '../lib/logger';
import type { TrackedProcess } from '../types';

export const trackedProcesses = new Map<string, TrackedProcess>();

const PROC_DIR = join(CODIBY_DIR, 'ui-processes');
const PROC_REGISTRY = join(PROC_DIR, 'registry.json');
const PROC_GRAVEYARD = join(PROC_DIR, 'graveyard.json');
const PROC_DISMISSED = join(PROC_DIR, 'dismissed-shells.json');

try { mkdirSync(PROC_DIR, { recursive: true }); } catch {}

type PersistedProc = { id: string; pid: number; command: string; cwd: string; sessionId: string; startedAt: number; kind?: 'oneshot' | 'pty'; label?: string };

// ---------------------------------------------------------------------------
// PTY graveyard — procIds whose PTY died (exit, bridge restart, etc.). The
// `exec_shell` handler consults this before spawning so a terminal bubble
// remounting from chat history doesn't auto-resurrect a process that's
// already dead. Persisted so the marker survives across bridge restarts.
//
// Capped at GRAVEYARD_LIMIT entries (FIFO) so it doesn't grow forever — old
// chat history that's no longer relevant rolls off naturally.
// ---------------------------------------------------------------------------

const GRAVEYARD_LIMIT = 2000;
const graveyard = (() => {
  try {
    const parsed = JSON.parse(readFileSync(PROC_GRAVEYARD, 'utf-8')) as string[];
    return new Set<string>(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set<string>(); }
})();

function persistGraveyard() {
  try { writeFileSync(PROC_GRAVEYARD, JSON.stringify([...graveyard])); } catch {}
}

export function addToGraveyard(procId: string) {
  if (graveyard.has(procId)) return;
  graveyard.add(procId);
  // FIFO eviction: drop the oldest entries when over the cap. Set iteration
  // is insertion order so the first N keys are the oldest.
  while (graveyard.size > GRAVEYARD_LIMIT) {
    const oldest = graveyard.values().next().value;
    if (!oldest) break;
    graveyard.delete(oldest);
  }
  persistGraveyard();
}

export function isInGraveyard(procId: string): boolean {
  return graveyard.has(procId);
}

// ---------------------------------------------------------------------------
// Dismissed shells — per-session set of procIds the user explicitly closed
// (clicked the × on a terminal bubble). The frontend asks the bridge what's
// dismissed for the active session and filters those bubbles out of the
// rendered chat. This makes the backend the authoritative source of which
// shells are visible — the frontend doesn't deduce anything from messages
// alone.
// ---------------------------------------------------------------------------

const dismissedShells = (() => {
  try {
    const parsed = JSON.parse(readFileSync(PROC_DISMISSED, 'utf-8')) as Record<string, string[]>;
    const m = new Map<string, Set<string>>();
    for (const [sid, ids] of Object.entries(parsed || {})) {
      if (Array.isArray(ids)) m.set(sid, new Set(ids));
    }
    return m;
  } catch { return new Map<string, Set<string>>(); }
})();

function persistDismissed() {
  const out: Record<string, string[]> = {};
  for (const [sid, set] of dismissedShells) {
    if (set.size > 0) out[sid] = [...set];
  }
  try { writeFileSync(PROC_DISMISSED, JSON.stringify(out)); } catch {}
}

export function dismissShell(sessionId: string, procId: string): boolean {
  let set = dismissedShells.get(sessionId);
  if (!set) { set = new Set<string>(); dismissedShells.set(sessionId, set); }
  if (set.has(procId)) return false;
  set.add(procId);
  persistDismissed();
  return true;
}

export function isShellDismissed(sessionId: string, procId: string): boolean {
  return dismissedShells.get(sessionId)?.has(procId) === true;
}

export function getDismissedShells(sessionId: string): string[] {
  const set = dismissedShells.get(sessionId);
  return set ? [...set] : [];
}

/** Drop all dismissed entries for a session — used when a session is
 *  deleted so its on-disk record doesn't leak forever. */
export function clearDismissedShells(sessionId: string): void {
  if (!dismissedShells.has(sessionId)) return;
  dismissedShells.delete(sessionId);
  persistDismissed();
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function outputPath(procId: string): string {
  return join(PROC_DIR, `${procId}.log`);
}

/** Append output to the process log file */
export function appendProcessOutput(procId: string, text: string) {
  try { writeFileSync(outputPath(procId), text, { flag: 'a' }); } catch {}
}

/** Read persisted output for a process */
function readProcessOutput(procId: string): string {
  try { return readFileSync(outputPath(procId), 'utf-8'); } catch { return ''; }
}

/** Remove output file for a process */
function removeProcessOutput(procId: string) {
  try { unlinkSync(outputPath(procId)); } catch {}
}

/** Save current process registry to disk */
export function saveProcessRegistry() {
  const entries: PersistedProc[] = [];
  for (const [, tp] of trackedProcesses) {
    entries.push({ id: tp.id, pid: tp.pid, command: tp.command, cwd: tp.cwd, sessionId: tp.sessionId, startedAt: tp.startedAt, kind: tp.kind, label: tp.label });
  }
  try { writeFileSync(PROC_REGISTRY, JSON.stringify(entries)); } catch {}
}

/** On startup, re-adopt processes that are still alive. PTY sessions are
 *  intentionally NOT re-adopted — the Bun.Terminal master end is gone when the
 *  server restarts, so the shell becomes a zombie. Kill them instead. */
export function restoreProcessRegistry() {
  let entries: PersistedProc[];
  try { entries = JSON.parse(readFileSync(PROC_REGISTRY, 'utf-8')); } catch { return; }

  let changed = false;
  for (const entry of entries) {
    if (!isPidAlive(entry.pid)) {
      changed = true;
      removeProcessOutput(entry.id);
      addToGraveyard(entry.id);
      continue;
    }
    // PTY sessions cannot be re-adopted across server restarts — kill, drop,
    // and tomb the procId so the bubble that remounts from chat history
    // doesn't trigger a fresh spawn.
    if (entry.kind === 'pty') {
      // Best-effort: PTY shells weren't started with `detached: true`, so the
      // PID has no process group. Kill the PID directly — its children are
      // orphaned to launchd/init and will exit when their stdin EOFs.
      try { process.kill(entry.pid, 'SIGHUP'); } catch {}
      setTimeout(() => {
        try { process.kill(entry.pid, 'SIGKILL'); } catch {}
      }, 500);
      removeProcessOutput(entry.id);
      addToGraveyard(entry.id);
      changed = true;
      log(`[proc] Dropped stale PTY ${entry.id.slice(0, 8)} (pid=${entry.pid})`);
      continue;
    }
    if (trackedProcesses.has(entry.id)) continue;
    const output = readProcessOutput(entry.id);
    trackedProcesses.set(entry.id, {
      id: entry.id,
      pid: entry.pid,
      command: entry.command,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      proc: null as any,
      viewers: new Set(),
      outputBuffer: output ? [output] : [],
      exitCode: null,
      kind: entry.kind || 'oneshot',
      label: entry.label,
    });
    log(`[proc] Re-adopted process ${entry.id.slice(0, 8)} (pid=${entry.pid}): ${entry.command.slice(0, 60)}`);
  }
  if (changed) saveProcessRegistry();
}

export function getProcessTree(pid: number): { pid: number; command: string; children: { pid: number; command: string }[] } | null {
  try {
    const out = execSync(`ps -o pid=,ppid=,comm= -ax`, { encoding: 'utf-8', timeout: 3000 });
    const rows = out.trim().split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      return { pid: parseInt(parts[0]!, 10), ppid: parseInt(parts[1]!, 10), comm: parts.slice(2).join(' ') };
    }).filter(r => !isNaN(r.pid));

    const entry = rows.find(r => r.pid === pid);
    if (!entry) return null;
    const children = rows.filter(r => r.ppid === pid).map(r => ({ pid: r.pid, command: r.comm }));
    return { pid, command: entry.comm, children };
  } catch {
    return null;
  }
}

export function killProcessTree(pid: number) {
  log(`[kill] Killing process group ${pid}`);
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  try { process.kill(pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }, 500);
}

export function handleListProcesses(sessionId: string): Response {
  const procs: { id: string; pid: number; command: string; cwd: string; startedAt: number; exitCode: number | null; kind: 'oneshot' | 'pty'; output: string; label?: string; children: { pid: number; command: string }[] }[] = [];
  for (const [id, tp] of trackedProcesses) {
    if (tp.sessionId !== sessionId) continue;
    // Check if still alive for re-adopted processes
    if (!tp.proc && !isPidAlive(tp.pid)) {
      trackedProcesses.delete(id);
      removeProcessOutput(id);
      continue;
    }
    // Interactive PTYs don't have a meaningful child tree (they own their
    // own xterm subtree via Bun.Terminal); skip the ps-based lookup.
    const tree = tp.kind === 'pty' ? null : getProcessTree(tp.pid);
    procs.push({
      id,
      pid: tp.pid,
      command: tp.command,
      cwd: tp.cwd,
      startedAt: tp.startedAt,
      exitCode: tp.exitCode,
      kind: tp.kind || 'oneshot',
      output: tp.outputBuffer.join(''),
      label: tp.label,
      children: tree?.children || [],
    });
  }
  return Response.json(procs, { headers: corsHeaders });
}

/** Kill a tracked process by id (PTY-aware) and remove it from the registry.
 *  Shared by the HTTP `/kill` endpoint and the `kill_terminal` SDK tool.
 *  Returns false when the procId is unknown. */
export function killTrackedProcess(processId: string): boolean {
  const tp = trackedProcesses.get(processId);
  if (!tp) return false;
  if (tp.kind === 'pty' && tp.pty) {
    try { tp.pty.kill('SIGHUP'); } catch {}
  }
  if (tp.pid) killProcessTree(tp.pid);
  try { tp.proc?.kill('SIGKILL'); } catch {}
  trackedProcesses.delete(processId);
  removeProcessOutput(processId);
  saveProcessRegistry();
  return true;
}

export function handleKillProcess(processId: string, pid?: number): Response {
  if (pid) {
    killProcessTree(pid);
    return Response.json({ ok: true }, { headers: corsHeaders });
  }
  if (!killTrackedProcess(processId)) {
    return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  }
  return Response.json({ ok: true }, { headers: corsHeaders });
}
