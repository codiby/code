import { execSync } from 'child_process';
import { corsHeaders } from '../config';
import type { TrackedProcess } from '../types';

export const trackedProcesses = new Map<string, TrackedProcess>();

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

export function handleListProcesses(sessionId: string): Response {
  const procs: { id: string; pid: number; command: string; cwd: string; startedAt: number; children: { pid: number; command: string }[] }[] = [];
  for (const [id, tp] of trackedProcesses) {
    if (tp.sessionId !== sessionId) continue;
    const tree = getProcessTree(tp.pid);
    procs.push({
      id,
      pid: tp.pid,
      command: tp.command,
      cwd: tp.cwd,
      startedAt: tp.startedAt,
      children: tree?.children || [],
    });
  }
  return Response.json(procs, { headers: corsHeaders });
}

export function killProcessTree(pid: number) {
  try { execSync(`kill -9 -- -${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, { timeout: 3000 }); } catch {}
  // Also try pkill for any remaining children
  try { execSync(`pkill -9 -P ${pid} 2>/dev/null`, { timeout: 3000 }); } catch {}
}

export function handleKillProcess(processId: string, pid?: number): Response {
  if (pid) {
    killProcessTree(pid);
    return Response.json({ ok: true }, { headers: corsHeaders });
  }
  const tp = trackedProcesses.get(processId);
  if (!tp) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  killProcessTree(tp.pid);
  try { tp.proc.kill('SIGKILL'); } catch {}
  trackedProcesses.delete(processId);
  return Response.json({ ok: true }, { headers: corsHeaders });
}
