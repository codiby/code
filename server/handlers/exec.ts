import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { corsHeaders } from '../config';
import { log } from '../logger';
import type { TrackedProcess } from '../types';
import { trackedProcesses, saveProcessRegistry, appendProcessOutput, addToGraveyard } from './processes';
import { getSessionEnvOverrides } from '../session-env';
import { pokeProcessMonitor } from '../process-monitor';

export interface SpawnTrackedOptions {
  command: string;
  cwd: string;
  sessionId: string;
  /** Optional human-readable label surfaced in the Processes panel and used by
   *  `read_terminal_output` for name-based lookup. */
  label?: string;
  /** Pre-allocated procId. Provide when the caller needs to reference the id
   *  before the process is spawned (e.g. WS reply correlation). */
  procId?: string;
  /** Called for every stdout+stderr chunk after it has been buffered and
   *  appended to the on-disk log. */
  onData?: (text: string) => void;
  /** Called once with the final exit code (0 on clean exit, 1 on spawn error). */
  onExit?: (code: number) => void;
  /** Extra env layered on top of session overrides — used for dynamic
   *  taskr-managed values like cross-action portless URL injection. */
  extraEnv?: Record<string, string>;
}

export interface SpawnTrackedResult {
  procId: string;
  pid: number;
  proc: ChildProcess;
  tp: TrackedProcess;
}

/**
 * Spawn a one-shot tracked background process. Used by:
 * - HTTP `POST /exec` (`handleExecCreate`) for the legacy viewer-WS flow
 * - the WS `exec` message in index.ts (broadcasts via `broadcastToSession`)
 * - the `spawn_terminal` SDK MCP tool (model-driven background terminals)
 *
 * The helper owns: spawn args (login shell + profile sourcing + color env),
 * `trackedProcesses` registration, output buffering with rotation, on-disk
 * log appends, and post-exit cleanup. Callers wire their own broadcast /
 * acknowledgement via the `onData` / `onExit` callbacks.
 */
export function spawnTrackedProcess(opts: SpawnTrackedOptions): SpawnTrackedResult {
  const procId = opts.procId || randomUUID();
  const cwd = opts.cwd;
  const command = opts.command;
  const shell = process.env.SHELL || '/bin/sh';
  const init = 'source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; ';
  const proc = spawn(shell, ['-c', init + command], {
    cwd,
    detached: true, // Own process group so kill(-pgid) kills entire tree
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      COLORTERM: 'truecolor',
      PATH: `/usr/local/sbin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      // User-defined globals + per-project env overrides layered on top
      // so the project's API keys / config are visible to commands.
      ...getSessionEnvOverrides(opts.sessionId),
      // Dynamic taskr-injected env (e.g. cross-action portless URLs)
      // wins over project env so consumers always get the live host.
      ...(opts.extraEnv || {}),
    },
    // stdin is piped (not ignored) so callers — including the
    // `send_terminal_input` SDK tool — can feed more input to a long-lived
    // child later. Existing one-shot callers just leave it dangling, which
    // is harmless (the child sees EOF only when the pipe is closed).
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const tp: TrackedProcess = {
    id: procId,
    pid: proc.pid!,
    command,
    cwd,
    sessionId: opts.sessionId,
    startedAt: Date.now(),
    proc,
    viewers: new Set(),
    outputBuffer: [],
    exitCode: null,
    kind: 'oneshot',
    label: opts.label,
  };
  trackedProcesses.set(procId, tp);
  saveProcessRegistry();
  // Surface the new background process on the session's sidebar badges ASAP.
  pokeProcessMonitor();

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString();
    tp.outputBuffer.push(text);
    if (tp.outputBuffer.length > 500) tp.outputBuffer.splice(0, tp.outputBuffer.length - 300);
    appendProcessOutput(procId, text);
    opts.onData?.(text);
  };
  proc.stdout?.on('data', handleChunk);
  proc.stderr?.on('data', handleChunk);

  proc.on('close', (code) => {
    tp.exitCode = code ?? 0;
    opts.onExit?.(tp.exitCode);
    addToGraveyard(procId);
    pokeProcessMonitor();
    // Keep around briefly so any late viewer can see the exit code, then GC.
    setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30_000);
  });

  proc.on('error', (err) => {
    log(`[spawnTrackedProcess] ${procId.slice(0, 8)} error: ${err.message}`);
    tp.exitCode = 1;
    opts.onExit?.(1);
    addToGraveyard(procId);
    setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30_000);
  });

  return { procId, pid: proc.pid!, proc, tp };
}

/**
 * POST /exec — Create a terminal process. Returns { procId, pid } immediately.
 * Client then connects to /terminal/ws/{procId} to view output.
 */
export async function handleExecCreate(req: Request): Promise<Response> {
  const body = await req.json() as { command: string; cwd?: string; sessionId?: string };
  if (!body.command) return Response.json({ error: 'command required' }, { status: 400, headers: corsHeaders });

  const sessionId = body.sessionId || 'unknown';
  const cwd = body.cwd || '/';

  const broadcastToViewers = (procId: string, msg: string) => {
    const tp = trackedProcesses.get(procId);
    if (!tp) return;
    for (const ws of tp.viewers) {
      try { ws.send(msg); } catch {}
    }
  };

  const { procId, pid, tp } = spawnTrackedProcess({
    command: body.command,
    cwd,
    sessionId,
    onData: (text) => broadcastToViewers(procId, JSON.stringify({ type: 'data', text })),
    onExit: (code) => broadcastToViewers(procId, JSON.stringify({ type: 'exit', code })),
  });
  log(`[exec] Started process ${procId.slice(0, 8)} (pid=${pid}): ${tp.command.slice(0, 80)}`);

  return Response.json({ procId, pid }, { headers: corsHeaders });
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
