import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { corsHeaders } from '../config';
import { log } from '../logger';
import { trackedProcesses, saveProcessRegistry, appendProcessOutput } from './processes';

/**
 * POST /exec — Create a terminal process. Returns { procId, pid } immediately.
 * Client then connects to /terminal/ws/{procId} to view output.
 */
export async function handleExecCreate(req: Request): Promise<Response> {
  const body = await req.json() as { command: string; cwd?: string; sessionId?: string };
  if (!body.command) return Response.json({ error: 'command required' }, { status: 400, headers: corsHeaders });

  const procId = randomUUID();
  const command = body.command;
  const cwd = body.cwd || '/';
  const sessionId = body.sessionId || 'unknown';

  const shell = process.env.SHELL || '/bin/sh';
  const init = 'source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; ';
  const proc = spawn(shell, ['-c', init + command], {
    cwd,
    detached: true, // Own process group so kill(-pgid) kills entire tree
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor', PATH: `/usr/local/sbin:/usr/sbin:/sbin:${process.env.PATH || ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tp = {
    id: procId,
    pid: proc.pid!,
    command,
    cwd,
    sessionId,
    startedAt: Date.now(),
    proc,
    viewers: new Set<any>(),
    outputBuffer: [] as string[],
    exitCode: null as number | null,
  };
  trackedProcesses.set(procId, tp);
  saveProcessRegistry();

  log(`[exec] Started process ${procId.slice(0, 8)} (pid=${proc.pid}): ${command.slice(0, 80)}`);

  const broadcastToViewers = (msg: string) => {
    for (const ws of tp.viewers) {
      try { ws.send(msg); } catch {}
    }
  };

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    tp.outputBuffer.push(text);
    if (tp.outputBuffer.length > 500) tp.outputBuffer.splice(0, tp.outputBuffer.length - 300);
    appendProcessOutput(procId, text);
    broadcastToViewers(JSON.stringify({ type: 'data', text }));
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    tp.outputBuffer.push(text);
    if (tp.outputBuffer.length > 500) tp.outputBuffer.splice(0, tp.outputBuffer.length - 300);
    appendProcessOutput(procId, text);
    broadcastToViewers(JSON.stringify({ type: 'data', text }));
  });

  proc.on('close', (code) => {
    tp.exitCode = code ?? 0;
    log(`[exec] Process ${procId.slice(0, 8)} exited with code ${tp.exitCode}`);
    broadcastToViewers(JSON.stringify({ type: 'exit', code: tp.exitCode }));
    // Keep in trackedProcesses for a bit so viewers can reconnect and see exit code
    setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30000);
  });

  proc.on('error', (err) => {
    tp.exitCode = 1;
    log(`[exec] Process ${procId.slice(0, 8)} error: ${err.message}`);
    broadcastToViewers(JSON.stringify({ type: 'exit', code: 1, error: err.message }));
    setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30000);
  });

  return Response.json({ procId, pid: proc.pid }, { headers: corsHeaders });
}

/**
 * WebSocket /terminal/ws/{procId} — handle terminal viewer connection.
 * Called from the WS open handler in index.ts.
 */
export function terminalWsOpen(ws: any, procId: string) {
  const tp = trackedProcesses.get(procId);
  if (!tp) {
    ws.send(JSON.stringify({ type: 'error', message: 'Process not found' }));
    ws.close();
    return;
  }

  tp.viewers.add(ws);

  // Replay buffered output
  for (const text of tp.outputBuffer) {
    try { ws.send(JSON.stringify({ type: 'data', text })); } catch {}
  }

  // If already exited, send exit code
  if (tp.exitCode !== null) {
    try { ws.send(JSON.stringify({ type: 'exit', code: tp.exitCode })); } catch {}
  }
}

export function terminalWsClose(ws: any, procId: string) {
  const tp = trackedProcesses.get(procId);
  if (tp) {
    tp.viewers.delete(ws);
  }
}
