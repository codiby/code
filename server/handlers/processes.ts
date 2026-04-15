import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { corsHeaders } from '../config';
import { log } from '../logger';
import type { TrackedProcess } from '../types';

export const trackedProcesses = new Map<string, TrackedProcess>();

const PROC_DIR = join(homedir(), '.claude', 'ui-processes');
const PROC_REGISTRY = join(PROC_DIR, 'registry.json');

try { mkdirSync(PROC_DIR, { recursive: true }); } catch {}

type PersistedProc = { id: string; pid: number; command: string; cwd: string; sessionId: string; startedAt: number };

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
    entries.push({ id: tp.id, pid: tp.pid, command: tp.command, cwd: tp.cwd, sessionId: tp.sessionId, startedAt: tp.startedAt });
  }
  try { writeFileSync(PROC_REGISTRY, JSON.stringify(entries)); } catch {}
}

/** On startup, re-adopt processes that are still alive */
export function restoreProcessRegistry() {
  let entries: PersistedProc[];
  try { entries = JSON.parse(readFileSync(PROC_REGISTRY, 'utf-8')); } catch { return; }

  let changed = false;
  for (const entry of entries) {
    if (!isPidAlive(entry.pid)) {
      changed = true;
      removeProcessOutput(entry.id);
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
  const procs: { id: string; pid: number; command: string; cwd: string; startedAt: number; exitCode: number | null; output: string; children: { pid: number; command: string }[] }[] = [];
  for (const [id, tp] of trackedProcesses) {
    if (tp.sessionId !== sessionId) continue;
    // Check if still alive for re-adopted processes
    if (!tp.proc && !isPidAlive(tp.pid)) {
      trackedProcesses.delete(id);
      removeProcessOutput(id);
      continue;
    }
    const tree = getProcessTree(tp.pid);
    procs.push({
      id,
      pid: tp.pid,
      command: tp.command,
      cwd: tp.cwd,
      startedAt: tp.startedAt,
      exitCode: tp.exitCode,
      output: tp.outputBuffer.join(''),
      children: tree?.children || [],
    });
  }
  return Response.json(procs, { headers: corsHeaders });
}

export function handleKillProcess(processId: string, pid?: number): Response {
  if (pid) {
    killProcessTree(pid);
    return Response.json({ ok: true }, { headers: corsHeaders });
  }
  const tp = trackedProcesses.get(processId);
  if (!tp) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  killProcessTree(tp.pid);
  try { tp.proc?.kill('SIGKILL'); } catch {}
  trackedProcesses.delete(processId);
  removeProcessOutput(processId);
  saveProcessRegistry();
  return Response.json({ ok: true }, { headers: corsHeaders });
}
