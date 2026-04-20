/**
 * Bridge server entry point.
 *
 * Run as HTTP server (default): bun run server/index.ts
 * Run as MCP server (stdio):    bun run server/index.ts --mcp
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

import { PORT, CLAUDE_BIN, corsHeaders, CWD } from './config';
import { log } from './logger';
import { sessions, loadSessions, saveSessions, sessionToJSON } from './sessions';
import { handleCreateSession, handleResumeSession, handleRenameSession, handleStopSession, handleDeleteSession } from './handlers/sessions';
import { ClaudeAdapter } from './provider/adapters/ClaudeAdapter';
import { registerProvider } from './provider/registry';
import { setBridgeDeps, startProviderSession } from './provider/lifecycle';
import { resolvePermissionDecision } from './provider/bridge';
import { handleListDirs, handleListFiles, handleFileIndex } from './handlers/files';
import { handleExecCreate, terminalWsOpen, terminalWsClose } from './handlers/exec';
import { trackedProcesses, handleListProcesses, handleKillProcess, killProcessTree, saveProcessRegistry, restoreProcessRegistry, appendProcessOutput } from './handlers/processes';
import { handleGitModified, handleGitInfo, handleGhPrs, handleGitBranches, handleGitCheckout } from './handlers/git';
import { handleSearch } from './handlers/search';
import { handleCreateWorktree } from './handlers/worktree';
import { getOrCreateLsp, sendToLsp, addLspClient, removeLspClient, killSessionLsp, supportedLanguages } from './handlers/lsp';
import { discoverTargets, connectToTarget, getConnection, disconnectTarget, addCdpClient, removeCdpClient, sendCdpMessage } from './handlers/cdp';
import { registerShutdownHandlers } from './shutdown';
import { startTelegramBot, notifyTelegramIfMainSession, restartTelegramBot, isTelegramBotRunning, setTelegramBroadcaster } from './telegram';
import { ensureMcpConfig } from './ensure-mcp-config';
import { handleMcpRequest, setMcpServerPort } from './mcp';
import {
  getSessionState,
  updateSessionState,
  addMessage,
  updateUIState,
  getStateForClient,
  clearSessionState,
} from './state';
import type { ChatMessage } from './state';
import { loadArchitectCredentials, saveArchitectCredentials, clearArchitectCredentials, loadTicketLinks, saveTicketLink, removeTicketLink, getTicketLink, loadPRLinks, savePRLink, removePRLink, getPRLink, loadPreferences, savePreferences, loadTelegramSettings, saveTelegramSettings } from './storage';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Register provider adapters before loading sessions (so default provider exists)
registerProvider(ClaudeAdapter);

loadSessions();
restoreProcessRegistry();
ensureMcpConfig();
registerShutdownHandlers();

// ---------------------------------------------------------------------------
// Frontend WebSocket multiplexer
// ---------------------------------------------------------------------------

/** All connected frontend WebSocket clients */
const frontendClients = new Set<any>();

/** Which session IDs each frontend client is subscribed to */
const subscriptions = new Map<any, Set<string>>();

/** Broadcast a message to all frontend clients subscribed to a given session */
function broadcastToSession(sessionId: string, msg: object) {
  const data = JSON.stringify(msg);
  for (const [ws, subs] of subscriptions) {
    if (subs.has(sessionId)) {
      try { ws.send(data); } catch {}
    }
  }
}

/** Broadcast the full session list to all connected frontend clients */
function broadcastSessionList() {
  const list = [...sessions.values()].map(s => sessionToJSON(s, server.port));
  const msg = JSON.stringify({ type: 'sessions', sessions: list });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

// ---------------------------------------------------------------------------
// PTY helper (interactive /terminal command)
// ---------------------------------------------------------------------------

/**
 * Locate a Node binary. Bun cannot load node-pty's native binding directly,
 * so the server shells out to a tiny Node helper for each interactive PTY.
 * Caches the result once found.
 */
let cachedNodeBin: string | null = null;
function findNodeBin(): string | null {
  if (cachedNodeBin) return cachedNodeBin;
  // 1. Try PATH via `command -v` (covers nvm/fnm/homebrew/etc)
  try {
    const fromPath = execSync('command -v node 2>/dev/null || which node 2>/dev/null', {
      encoding: 'utf-8',
      shell: '/bin/bash',
      timeout: 2000,
    }).trim();
    if (fromPath && existsSync(fromPath)) { cachedNodeBin = fromPath; return fromPath; }
  } catch {}
  // 2. Try common absolute locations
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    `${process.env.HOME || ''}/.volta/bin/node`,
  ];
  try {
    // nvm installations
    const nvmDir = `${process.env.HOME || ''}/.nvm/versions/node`;
    if (existsSync(nvmDir)) {
      const versions = execSync(`ls -1 ${nvmDir} 2>/dev/null | sort -rV`, { encoding: 'utf-8', timeout: 1000 })
        .trim().split('\n').filter(Boolean);
      for (const v of versions) candidates.push(`${nvmDir}/${v}/bin/node`);
    }
  } catch {}
  for (const p of candidates) {
    if (p && existsSync(p)) { cachedNodeBin = p; return p; }
  }
  return null;
}

/**
 * Resolve the pty-helper.mjs path. When running the source tree it lives next
 * to this file; when bundled as sidecar/service we ship it alongside the
 * bundled `server.js` in the same dir.
 */
function findPtyHelperPath(): string | null {
  const candidates: string[] = [];
  // Bundled layouts (install-service.sh + bundle-bun.sh copy next to server.js)
  try {
    const scriptDir = dirname(process.argv[1] || '');
    if (scriptDir) candidates.push(join(scriptDir, 'pty-helper.mjs'));
  } catch {}
  // Source tree
  candidates.push(join(dirname(new URL(import.meta.url).pathname), 'pty-helper.mjs'));
  candidates.push(join(process.cwd(), 'server', 'pty-helper.mjs'));
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

/**
 * Spawn a Node pty-helper subprocess for an interactive shell. Returns null
 * on failure (e.g. Node not installed).
 */
function spawnPtyHelper(opts: {
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
}): {
  proc: ChildProcess;
  writeControl: (obj: { type: string; [k: string]: unknown }) => void;
  onData: (cb: (text: string) => void) => void;
  onReady: (cb: (pid: number) => void) => void;
  onExit: (cb: (code: number) => void) => void;
  onError: (cb: (err: string) => void) => void;
} | null {
  const nodeBin = findNodeBin();
  if (!nodeBin) { log('[pty] Node binary not found — install Node to use /terminal'); return null; }
  const helperPath = findPtyHelperPath();
  if (!helperPath) { log('[pty] pty-helper.mjs not found'); return null; }

  const args = [
    helperPath,
    '--shell', opts.shell || process.env.SHELL || '/bin/bash',
    '--cwd', opts.cwd,
    '--cols', String(opts.cols),
    '--rows', String(opts.rows),
  ];

  const proc = spawn(nodeBin, args, {
    cwd: opts.cwd,
    detached: true,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const writeControl = (obj: { type: string; [k: string]: unknown }) => {
    try { proc.stdin?.write(JSON.stringify(obj) + '\n'); } catch {}
  };

  // Line-buffered JSON parser on helper stdout
  let stdoutBuf = '';
  const dataListeners: ((t: string) => void)[] = [];
  const readyListeners: ((pid: number) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  const errListeners: ((e: string) => void)[] = [];
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'data' && typeof m.data === 'string') dataListeners.forEach(cb => cb(m.data));
      else if (m.type === 'ready' && typeof m.pid === 'number') readyListeners.forEach(cb => cb(m.pid));
      else if (m.type === 'exit') exitListeners.forEach(cb => cb(m.code ?? 0));
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    log(`[pty-helper stderr] ${text.trim().slice(0, 200)}`);
    errListeners.forEach(cb => cb(text));
  });
  proc.on('exit', (code) => exitListeners.forEach(cb => cb(code ?? 0)));
  proc.on('error', (err) => { log(`[pty-helper] error: ${err}`); errListeners.forEach(cb => cb(String(err))); });

  return {
    proc,
    writeControl,
    onData: (cb) => { dataListeners.push(cb); },
    onReady: (cb) => { readyListeners.push(cb); },
    onExit: (cb) => { exitListeners.push(cb); },
    onError: (cb) => { errListeners.push(cb); },
  };
}

// Provider runtime events are handled by `provider/bridge.ts`. No raw Claude
// CLI messages are parsed here — the SDK runs in-process and emits structured
// events that the bridge translates into state updates + WebSocket broadcasts.

// Wire bridge dependencies (used by provider/lifecycle.ts at spawn time)
setBridgeDeps({
  broadcastToSession,
  broadcastSessionList,
  notifyTelegramIfMainSession,
});

// ---------------------------------------------------------------------------
// Frontend WS message handler
// ---------------------------------------------------------------------------

async function handleFrontendMessage(ws: any, rawMessage: string | ArrayBuffer) {
  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage as ArrayBuffer);
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  const { type } = msg as { type: string };

  // ---- get_sessions --------------------------------------------------------
  if (type === 'get_sessions') {
    const list = [...sessions.values()].map(s => sessionToJSON(s, server.port));
    ws.send(JSON.stringify({ type: 'sessions', sessions: list }));
    return;
  }

  // ---- get_session_state ---------------------------------------------------
  if (type === 'get_session_state') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const state = getStateForClient(sessionId);
    ws.send(JSON.stringify({ type: 'session_state', sessionId, state }));
    return;
  }

  // ---- subscribe -----------------------------------------------------------
  if (type === 'subscribe') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    let subs = subscriptions.get(ws);
    if (!subs) { subs = new Set(); subscriptions.set(ws, subs); }
    subs.add(sessionId);

    // Immediately send full session state
    const state = getStateForClient(sessionId);
    ws.send(JSON.stringify({ type: 'session_state', sessionId, state }));

    // Also send current connection status
    const session = sessions.get(sessionId);
    if (session) {
      const status = session.ready ? 'connected' : session.status === 'starting' ? 'starting' : 'disconnected';
      ws.send(JSON.stringify({ type: 'status', sessionId, status }));
    }
    return;
  }

  // ---- unsubscribe ---------------------------------------------------------
  if (type === 'unsubscribe') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    subscriptions.get(ws)?.delete(sessionId);
    return;
  }

  // ---- send_message --------------------------------------------------------
  if (type === 'send_message') {
    const { sessionId, text: msgText, images } = msg as { sessionId: string; text: string; images?: { media_type: string; data: string }[] };
    if (!sessionId || !msgText) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Auto-start the provider if the session is idle (e.g. after a stop, SDK
    // exit, or pre-resume race). Messages would otherwise be silently dropped.
    if (!session.providerSession) {
      log(`[${session.id.slice(0, 8)}] Auto-starting provider on send_message (session was stopped/idle)`);
      startProviderSession(session, server.port, session.claudeSessionId ?? null);
      saveSessions();
    }
    if (!session.providerSession) {
      log(`[${session.id.slice(0, 8)}] Auto-start failed — dropping message`);
      return;
    }
    session.replayDone = true;

    // Echo user message to persistence + frontend
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: msgText,
      timestamp: Date.now(),
      images,
    };
    if (addMessage(sessionId, userMsg)) {
      broadcastToSession(sessionId, { type: 'message', sessionId, message: userMsg });
    }

    // Intercept /model command — switch model via provider session.
    const modelMatch = msgText.match(/^\/model(?:\s+(.+))?$/);
    if (modelMatch) {
      const finishIntercept = (confirmText: string) => {
        const reply: ChatMessage = {
          id: randomUUID(),
          role: 'system',
          content: confirmText,
          timestamp: Date.now(),
        };
        if (addMessage(sessionId, reply)) {
          broadcastToSession(sessionId, { type: 'message', sessionId, message: reply });
        }
        updateSessionState(sessionId, s => ({ ...s, isStreaming: false, partialText: '' }));
        broadcastToSession(sessionId, { type: 'status', sessionId, status: 'turn_complete' });
      };

      const arg = (modelMatch[1] || '').trim();
      if (!arg) {
        const current = session.model || 'default';
        finishIntercept(`Current model: ${current}\nUsage: /model <opus|sonnet|haiku|claude-opus-4-7|default>`);
        return;
      }
      const newModel = arg.toLowerCase() === 'default' ? null : arg;
      session.model = newModel;
      saveSessions();
      broadcastSessionList();

      let confirmText = `Model preference saved: ${newModel ?? 'default'}`;
      try {
        await session.providerSession!.setModel(newModel);
        confirmText = `Model set to: ${newModel ?? 'default'}`;
      } catch (err) {
        confirmText = `Failed to switch model: ${err}`;
      }
      finishIntercept(confirmText);
      return;
    }

    try {
      await session.providerSession!.sendUserMessage({ text: msgText, images });
    } catch (err) {
      log(`[${sessionId.slice(0, 8)}] sendUserMessage failed: ${err}`);
    }
    return;
  }

  // ---- permission_response -------------------------------------------------
  if (type === 'permission_response') {
    const { sessionId, requestId, allow, updatedInput } = msg as {
      sessionId: string;
      requestId: string;
      allow: boolean;
      updatedInput?: Record<string, unknown>;
    };
    if (!sessionId || !requestId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    resolvePermissionDecision(
      requestId,
      allow
        ? { allow: true, updatedInput: updatedInput || {} }
        : { allow: false, interrupt: true },
    );

    // When user denies a tool, also interrupt so the model stops retrying.
    if (!allow && session.providerSession) {
      try { await session.providerSession.interrupt(); } catch {}
    }

    // AskUserQuestion doesn't produce a normal tool_result from the SDK — the
    // answer lives only in the permission updatedInput. Persist it as a
    // synthetic tool_result so reloads can show which option was selected.
    // Works for both live (permRequest still set) and stale (permission lost
    // but tool_use still in history) cases.
    if (
      allow &&
      updatedInput &&
      updatedInput.answers &&
      typeof updatedInput.answers === 'object'
    ) {
      const state = getSessionState(sessionId);
      const isAsk =
        state.permRequest?.toolName === 'AskUserQuestion' ||
        state.messages.some(m => m.id === requestId && m.toolName === 'AskUserQuestion');
      if (isAsk) {
        const already = state.messages.some(m => m.isToolResult && m.toolUseId === requestId);
        if (!already) {
          const resultMsg: ChatMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: JSON.stringify({ answers: updatedInput.answers }),
            timestamp: Date.now(),
            isToolResult: true,
            toolUseId: requestId,
          };
          if (addMessage(sessionId, resultMsg)) {
            broadcastToSession(sessionId, { type: 'message', sessionId, message: resultMsg });
          }
        }
      }
    }

    // Handle ExitPlanMode approval — transition out of plan mode
    if (allow) {
      const state = getSessionState(sessionId);
      if (state.permRequest?.toolName === 'ExitPlanMode' && session.permissionMode === 'plan') {
        session.permissionMode = 'acceptEdits';
        saveSessions();
        broadcastSessionList();
        if (session.providerSession) {
          try { await session.providerSession.setPermissionMode('acceptEdits'); } catch {}
        }
        log(`[${session.id.slice(0, 8)}] ExitPlanMode approved — switched to acceptEdits`);
      }
    }

    // Clear permission request from state
    updateSessionState(sessionId, s => ({ ...s, permRequest: null }));
    return;
  }

  // ---- interrupt -----------------------------------------------------------
  if (type === 'interrupt') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session || !session.providerSession) return;
    try { await session.providerSession.interrupt(); } catch (err) {
      log(`[${sessionId.slice(0, 8)}] interrupt failed: ${err}`);
    }
    return;
  }

  // ---- exec ----------------------------------------------------------------
  if (type === 'exec') {
    const { sessionId, command, cwd, procId: clientProcId } = msg as { sessionId: string; command: string; cwd?: string; procId?: string };
    if (!sessionId || !command) return;

    const procId = clientProcId || randomUUID();
    const execCwd = cwd || '/';
    const shell = process.env.SHELL || '/bin/sh';
    const init = 'source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; ';
    const proc = spawn(shell, ['-c', init + command], {
      cwd: execCwd,
      detached: true,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor', PATH: `/usr/local/sbin:/usr/sbin:/sbin:${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tp = {
      id: procId,
      pid: proc.pid!,
      command,
      cwd: execCwd,
      sessionId,
      startedAt: Date.now(),
      proc,
      viewers: new Set<any>(),
      outputBuffer: [] as string[],
      exitCode: null as number | null,
    };
    trackedProcesses.set(procId, tp);
    saveProcessRegistry();
    log(`[exec/ws] Started process ${procId.slice(0, 8)} (pid=${proc.pid}) for session ${sessionId.slice(0, 8)}: ${command.slice(0, 80)}`);

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tp.outputBuffer.push(text);
      if (tp.outputBuffer.length > 500) tp.outputBuffer.splice(0, tp.outputBuffer.length - 300);
      appendProcessOutput(procId, text);
      broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tp.outputBuffer.push(text);
      if (tp.outputBuffer.length > 500) tp.outputBuffer.splice(0, tp.outputBuffer.length - 300);
      appendProcessOutput(procId, text);
      broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
    });

    proc.on('close', (code) => {
      tp.exitCode = code ?? 0;
      log(`[exec/ws] Process ${procId.slice(0, 8)} exited with code ${tp.exitCode}`);
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code: tp.exitCode });
      setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30000);
    });

    proc.on('error', (err) => {
      tp.exitCode = 1;
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code: 1 });
      setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30000);
    });

    // Acknowledge with procId so the client can correlate
    ws.send(JSON.stringify({ type: 'terminal_data', sessionId, procId, text: '' }));
    return;
  }

  // ---- exec_shell ----------------------------------------------------------
  // Spawn a long-lived interactive PTY shell. Client (xterm.js) streams
  // keystrokes via `terminal_input` and receives output via `terminal_data`.
  if (type === 'exec_shell') {
    const { sessionId, procId: clientProcId, cwd, cols, rows } = msg as {
      sessionId: string; procId?: string; cwd?: string; cols?: number; rows?: number;
    };
    if (!sessionId) return;

    const procId = clientProcId || randomUUID();
    const execCwd = cwd || process.env.HOME || '/';
    const execCols = Math.max(1, Math.min(500, Number(cols) || 120));
    const execRows = Math.max(1, Math.min(200, Number(rows) || 30));

    const helper = spawnPtyHelper({ cwd: execCwd, cols: execCols, rows: execRows });
    if (!helper) {
      broadcastToSession(sessionId, {
        type: 'terminal_data', sessionId, procId,
        text: '\r\n\x1b[31m[/terminal unavailable: Node binary or pty-helper.mjs not found on server]\x1b[0m\r\n',
      });
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code: 127 });
      return;
    }

    const tp = {
      id: procId,
      pid: 0, // filled in on helper 'ready'
      command: '(interactive shell)',
      cwd: execCwd,
      sessionId,
      startedAt: Date.now(),
      proc: helper.proc,
      viewers: new Set<any>(),
      outputBuffer: [] as string[],
      exitCode: null as number | null,
      kind: 'pty' as const,
      cols: execCols,
      rows: execRows,
      writeControl: helper.writeControl,
    };
    trackedProcesses.set(procId, tp);
    saveProcessRegistry();
    log(`[exec_shell] spawned pty helper procId=${procId.slice(0, 8)} session=${sessionId.slice(0, 8)} cwd=${execCwd}`);

    helper.onReady((pid) => {
      tp.pid = pid;
      saveProcessRegistry();
      log(`[exec_shell] pty ready procId=${procId.slice(0, 8)} pid=${pid}`);
    });
    helper.onData((text) => {
      tp.outputBuffer.push(text);
      if (tp.outputBuffer.length > 1000) tp.outputBuffer.splice(0, tp.outputBuffer.length - 500);
      appendProcessOutput(procId, text);
      broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
    });
    helper.onExit((code) => {
      if (tp.exitCode !== null) return; // already handled
      tp.exitCode = code;
      log(`[exec_shell] pty exited procId=${procId.slice(0, 8)} code=${code}`);
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code });
      setTimeout(() => { trackedProcesses.delete(procId); saveProcessRegistry(); }, 30000);
    });

    // Acknowledge so the client can correlate immediately
    ws.send(JSON.stringify({ type: 'terminal_data', sessionId, procId, text: '' }));
    return;
  }

  // ---- terminal_input ------------------------------------------------------
  // Write raw keystrokes (already encoded by xterm) to an interactive PTY.
  if (type === 'terminal_input') {
    const { procId, data } = msg as { procId: string; data: string };
    if (!procId || typeof data !== 'string') return;
    const tp = trackedProcesses.get(procId);
    if (!tp || tp.kind !== 'pty' || tp.exitCode !== null) return;
    tp.writeControl?.({ type: 'write', data });
    return;
  }

  // ---- terminal_resize -----------------------------------------------------
  if (type === 'terminal_resize') {
    const { procId, cols, rows } = msg as { procId: string; cols: number; rows: number };
    if (!procId || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const tp = trackedProcesses.get(procId);
    if (!tp || tp.kind !== 'pty' || tp.exitCode !== null) return;
    tp.cols = cols; tp.rows = rows;
    tp.writeControl?.({ type: 'resize', cols, rows });
    return;
  }

  // ---- terminal_kill -------------------------------------------------------
  // Gracefully end an interactive shell (SIGHUP), falling back to process group
  // kill if the helper doesn't exit within 500ms.
  if (type === 'terminal_kill') {
    const { procId } = msg as { procId: string };
    if (!procId) return;
    const tp = trackedProcesses.get(procId);
    if (!tp) return;
    if (tp.kind === 'pty' && tp.writeControl) {
      tp.writeControl({ type: 'kill', signal: 'SIGHUP' });
      setTimeout(() => {
        if (tp.exitCode !== null) return;
        try { tp.proc?.kill('SIGTERM'); } catch {}
        if (tp.pid) killProcessTree(tp.pid);
      }, 500);
    } else if (tp.pid) {
      killProcessTree(tp.pid);
    }
    return;
  }

  // ---- kill_process --------------------------------------------------------
  if (type === 'kill_process') {
    const { sessionId, processId, pid } = msg as { sessionId: string; processId?: string; pid?: number };
    if (!sessionId) return;
    if (pid) {
      killProcessTree(pid);
    } else if (processId) {
      const tp = trackedProcesses.get(processId);
      if (tp) {
        if (tp.kind === 'pty' && tp.writeControl) {
          tp.writeControl({ type: 'kill', signal: 'SIGHUP' });
        }
        if (tp.pid) killProcessTree(tp.pid);
        try { tp.proc?.kill('SIGKILL'); } catch {}
        trackedProcesses.delete(processId);
        saveProcessRegistry();
      }
    }
    return;
  }

  // ---- update_ui_state -----------------------------------------------------
  if (type === 'update_ui_state') {
    const { sessionId, state } = msg as { sessionId: string; state: Record<string, unknown> };
    if (!sessionId || !state) return;
    updateUIState(sessionId, state);
    return;
  }

  // ---- set_model -----------------------------------------------------------
  if (type === 'set_model') {
    const { sessionId, model } = msg as { sessionId: string; model: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.model = model || null;
    saveSessions();
    if (session.providerSession) {
      try { await session.providerSession.setModel(session.model); } catch {}
    }
    // Notify all subscribed clients
    broadcastToSession(sessionId, {
      type: 'session_state',
      sessionId,
      state: getStateForClient(sessionId),
    });
    return;
  }

  // ---- set_permission_mode -------------------------------------------------
  if (type === 'set_permission_mode') {
    const { sessionId, mode } = msg as { sessionId: string; mode: string };
    if (!sessionId || !mode) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    session.permissionMode = mode;
    saveSessions();
    if (session.providerSession) {
      try { await session.providerSession.setPermissionMode(mode as any); } catch {}
    }
    broadcastSessionList();
    return;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Log requests (skip noisy endpoints)
    if (
      url.pathname !== '/health' &&
      url.pathname !== '/file-index' &&
      url.pathname !== '/git-modified' &&
      url.pathname !== '/processes'
    ) {
      log(`${req.method} ${url.pathname}${url.search}`);
    }

    // -----------------------------------------------------------------------
    // WebSocket upgrades
    // -----------------------------------------------------------------------

    // Single multiplexed frontend WebSocket
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, { data: { type: 'frontend' } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Legacy per-session browser WebSocket (kept for backwards compatibility)
    if (url.pathname.startsWith('/browser/ws/')) {
      const sessionId = url.pathname.split('/browser/ws/')[1];
      const session = sessions.get(sessionId!);
      if (!session) {
        return new Response('Session not found', { status: 404 });
      }
      const upgraded = server.upgrade(req, { data: { type: 'browser', sessionId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // Terminal viewer WebSocket
    const termWsMatch = url.pathname.match(/^\/terminal\/ws\/([^/]+)$/);
    if (termWsMatch) {
      const procId = termWsMatch[1]!;
      const upgraded = server.upgrade(req, { data: { type: 'terminal', procId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // LSP WebSocket — /lsp/ws/{sessionId}/{languageId}
    const lspWsMatch = url.pathname.match(/^\/lsp\/ws\/([^/]+)\/([^/]+)$/);
    if (lspWsMatch) {
      const [, sessionId, languageId] = lspWsMatch;
      const upgraded = server.upgrade(req, { data: { type: 'lsp', sessionId, languageId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // CDP Debug WebSocket — /debug/ws/{connectionId}
    const cdpWsMatch = url.pathname.match(/^\/debug\/ws\/(.+)$/);
    if (cdpWsMatch) {
      const connectionId = decodeURIComponent(cdpWsMatch[1]!);
      const conn = getConnection(connectionId);
      if (!conn) return new Response('Debug connection not found', { status: 404 });
      const upgraded = server.upgrade(req, { data: { type: 'cdp', connectionId } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    if (url.pathname === '/sessions' && req.method === 'GET') {
      const list = [...sessions.values()].map(s => sessionToJSON(s, server.port));
      return Response.json(list, { headers: corsHeaders });
    }

    if (url.pathname === '/sessions' && req.method === 'POST') {
      const resp = await handleCreateSession(req, server.port);
      // Notify all connected frontends that the session list changed
      broadcastSessionList();
      return resp;
    }

    const resumeMatch = url.pathname.match(/^\/sessions\/(.+)\/resume$/);
    if (resumeMatch && req.method === 'POST') {
      const resp = handleResumeSession(resumeMatch[1]!, server.port);
      broadcastSessionList();
      return resp;
    }

    const stopMatch = url.pathname.match(/^\/sessions\/(.+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const resp = handleStopSession(stopMatch[1]!);
      broadcastSessionList();
      return resp;
    }

    const patchMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (patchMatch && req.method === 'PATCH') {
      const resp = await handleRenameSession(patchMatch[1]!, req);
      broadcastSessionList();
      return resp;
    }

    const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const resp = handleDeleteSession(deleteMatch[1]!);
      broadcastSessionList();
      return resp;
    }

    // -----------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------

    if (url.pathname === '/ls' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '/';
      return handleListDirs(prefix);
    }

    if (url.pathname === '/files' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path') || '/';
      return handleListFiles(dirPath);
    }

    if (url.pathname === '/file-index' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleFileIndex(root);
    }

    if (url.pathname === '/file-content' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      try {
        const content = readFileSync(filePath, 'utf-8');
        return Response.json({ path: filePath, content }, { headers: corsHeaders });
      } catch {
        return Response.json({ error: 'Cannot read file' }, { status: 404, headers: corsHeaders });
      }
    }

    if (url.pathname === '/file-content' && req.method === 'PUT') {
      try {
        const body = await req.json() as { path: string; content: string };
        if (!body.path) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
        writeFileSync(body.path, body.content, 'utf-8');
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    // -----------------------------------------------------------------------
    // Exec / Processes
    // -----------------------------------------------------------------------

    if (url.pathname === '/exec' && req.method === 'POST') {
      return handleExecCreate(req);
    }

    if (url.pathname === '/processes' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
      return handleListProcesses(sessionId);
    }

    if (url.pathname === '/kill' && req.method === 'POST') {
      const body = await req.json() as { processId?: string; pid?: number };
      if (!body.processId && !body.pid) return Response.json({ error: 'processId or pid required' }, { status: 400, headers: corsHeaders });
      return handleKillProcess(body.processId || '', body.pid);
    }

    // -----------------------------------------------------------------------
    // Git
    // -----------------------------------------------------------------------

    if (url.pathname === '/file-original' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      try {
        const cwd = dirname(filePath);
        const relPath = execSync(`git ls-files --full-name "${filePath}"`, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
        if (!relPath) return Response.json({ path: filePath, content: '' }, { headers: corsHeaders });
        const content = execSync(`git show HEAD:"${relPath}"`, { cwd, encoding: 'utf-8', timeout: 5000 });
        return Response.json({ path: filePath, content }, { headers: corsHeaders });
      } catch {
        return Response.json({ path: filePath, content: '' }, { headers: corsHeaders });
      }
    }

    if (url.pathname === '/git-modified' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleGitModified(root);
    }

    if (url.pathname === '/git-stage' && req.method === 'POST') {
      const body = await req.json() as { root: string; files: string[]; unstage?: boolean };
      if (!body.root || !body.files?.length) return Response.json({ error: 'root and files required' }, { status: 400, headers: corsHeaders });
      try {
        const gitTop = execSync('git rev-parse --show-toplevel', { cwd: body.root, encoding: 'utf-8', timeout: 5000 }).trim();
        const cmd = body.unstage ? 'git reset HEAD --' : 'git add --';
        execSync(
          `${cmd} ${body.files.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ')}`,
          { cwd: gitTop, encoding: 'utf-8', timeout: 5000 },
        );
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === '/git-info' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      return handleGitInfo(dirPath);
    }

    if (url.pathname === '/git-branches' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
      return handleGitBranches(cwd);
    }

    if (url.pathname === '/git-checkout' && req.method === 'POST') {
      const body = await req.json() as { cwd: string; branch: string };
      if (!body.cwd || !body.branch) return Response.json({ error: 'cwd and branch required' }, { status: 400, headers: corsHeaders });
      return handleGitCheckout(body.cwd, body.branch);
    }

    if (url.pathname === '/gh-prs' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      const sessionName = url.searchParams.get('session') || '';
      if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
      return handleGhPrs(cwd, sessionName);
    }

    // -----------------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------------

    if (url.pathname === '/search' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      const query = url.searchParams.get('q') || '';
      if (!root || !query) return Response.json({ results: [] }, { headers: corsHeaders });
      return handleSearch(root, query);
    }

    // -----------------------------------------------------------------------
    // Worktree
    // -----------------------------------------------------------------------

    if (url.pathname === '/worktree' && req.method === 'POST') {
      return handleCreateWorktree(req);
    }

    // -----------------------------------------------------------------------
    // Misc
    // -----------------------------------------------------------------------

    if (url.pathname === '/save-commands' && req.method === 'POST') {
      const body = await req.json() as { sessionId: string; commands: string[] };
      if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
      const session = sessions.get(body.sessionId);
      if (!session) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
      session.savedCommands = body.commands || [];
      saveSessions();
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (url.pathname === '/mcp') {
      return handleMcpRequest(req);
    }

    // ── Architect ──────────────────────────────────────────────────────────

    if (url.pathname === '/architect/credentials' && req.method === 'GET') {
      const creds = loadArchitectCredentials();
      return Response.json(creds, { headers: corsHeaders });
    }

    if (url.pathname === '/architect/credentials' && req.method === 'PUT') {
      const body = await req.json() as { sessionToken: string; gatePassword?: string };
      saveArchitectCredentials({ sessionToken: body.sessionToken, gatePassword: body.gatePassword ?? null });
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (url.pathname === '/architect/credentials' && req.method === 'DELETE') {
      clearArchitectCredentials();
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // ── Telegram ────────────────────────────────────────────────────────

    if (url.pathname === '/telegram/settings' && req.method === 'GET') {
      const settings = loadTelegramSettings();
      return Response.json({
        botToken: settings.botToken,
        chatId: settings.chatId,
        running: isTelegramBotRunning(),
      }, { headers: corsHeaders });
    }

    if (url.pathname === '/telegram/settings' && req.method === 'PUT') {
      const body = await req.json() as { botToken?: string; chatId?: string };
      saveTelegramSettings({
        botToken: (body.botToken ?? '').trim(),
        chatId: (body.chatId ?? '').trim(),
      });
      restartTelegramBot();
      return Response.json({ ok: true, running: isTelegramBotRunning() }, { headers: corsHeaders });
    }

    if (url.pathname === '/architect/boards' && req.method === 'GET') {
      const creds = loadArchitectCredentials();
      if (!creds.sessionToken) {
        return Response.json({ error: 'not_logged_in' }, { status: 401, headers: corsHeaders });
      }
      try {
        let cookie = `__Secure-next-auth.session-token=${creds.sessionToken}`;
        if (creds.gatePassword) cookie += `; site-gate=${creds.gatePassword}`;
        const res = await fetch('https://architect-ou79.onrender.com/api/engineering/boards', {
          headers: { Cookie: cookie },
        });
        if (!res.ok) return Response.json({ error: 'fetch_failed' }, { status: res.status, headers: corsHeaders });
        return Response.json(await res.json(), { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    if (url.pathname === '/architect/my-items' && req.method === 'GET') {
      const creds = loadArchitectCredentials();
      if (!creds.sessionToken) {
        return Response.json({ error: 'not_logged_in' }, { status: 401, headers: corsHeaders });
      }
      try {
        let cookie = `__Secure-next-auth.session-token=${creds.sessionToken}`;
        if (creds.gatePassword) cookie += `; site-gate=${creds.gatePassword}`;

        // Fetch user, boards, then items for each board the user is a member of
        const [meRes, boardsRes] = await Promise.all([
          fetch('https://architect-ou79.onrender.com/api/me', { headers: { Cookie: cookie } }),
          fetch('https://architect-ou79.onrender.com/api/engineering/boards', { headers: { Cookie: cookie } }),
        ]);
        if (!meRes.ok || !boardsRes.ok) {
          return Response.json({ error: 'fetch_failed' }, { status: 502, headers: corsHeaders });
        }
        const me = await meRes.json() as { githubUsername: string };
        const { boards } = await boardsRes.json() as { boards: { id: string; name: string; isMember: boolean; archived: boolean }[] };

        const memberBoards = boards.filter(b => b.isMember && !b.archived);
        const itemResults = await Promise.all(
          memberBoards.map(b =>
            fetch(`https://architect-ou79.onrender.com/api/engineering/items?boardId=${b.id}`, { headers: { Cookie: cookie } })
              .then(r => r.ok ? r.json() : { items: [] })
          )
        );

        const allItems = itemResults.flatMap((r: any) => r.items || []);
        const myItems = allItems.filter((item: any) =>
          item.engineerUsername === me.githubUsername ||
          item.assignments?.some((a: any) => a.githubUsername === me.githubUsername)
        );

        return Response.json({ items: myItems, username: me.githubUsername }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    const itemDetailMatch = url.pathname.match(/^\/architect\/items\/([^/]+)$/);
    if (itemDetailMatch && req.method === 'GET') {
      const creds = loadArchitectCredentials();
      if (!creds.sessionToken) {
        return Response.json({ error: 'not_logged_in' }, { status: 401, headers: corsHeaders });
      }
      try {
        let cookie = `__Secure-next-auth.session-token=${creds.sessionToken}`;
        if (creds.gatePassword) cookie += `; site-gate=${creds.gatePassword}`;
        const BASE = 'https://architect-ou79.onrender.com';
        const headers = { Cookie: cookie };
        const itemId = itemDetailMatch[1];

        // Find the item across boards
        const boardsRes = await fetch(`${BASE}/api/engineering/boards`, { headers });
        if (!boardsRes.ok) return Response.json({ error: 'fetch_failed' }, { status: 502, headers: corsHeaders });
        const { boards } = await boardsRes.json() as { boards: { id: string; archived: boolean }[] };

        let item: any = null;
        for (const board of boards.filter(b => !b.archived)) {
          const itemsRes = await fetch(`${BASE}/api/engineering/items?boardId=${board.id}`, { headers });
          if (!itemsRes.ok) continue;
          const { items } = await itemsRes.json() as { items: any[] };
          item = items.find((i: any) => i.id === itemId);
          if (item) break;
        }
        if (!item) return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders });

        // Fetch comments, checklist, and activity in parallel
        const [commentsData, checklistData, activityData] = await Promise.all([
          fetch(`${BASE}/api/engineering/items/${itemId}/comments`, { headers })
            .then(r => r.ok ? r.json() : { comments: [] }).catch(() => ({ comments: [] })),
          fetch(`${BASE}/api/engineering/items/${itemId}/checklist`, { headers })
            .then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
          fetch(`${BASE}/api/engineering/items/${itemId}/activity`, { headers })
            .then(r => r.ok ? r.json() : { activities: [] }).catch(() => ({ activities: [] })),
        ]);

        return Response.json({
          item,
          comments: commentsData.comments || [],
          checklist: checklistData.items || [],
          activity: activityData.activities || [],
        }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    if (itemDetailMatch && req.method === 'PATCH') {
      const creds = loadArchitectCredentials();
      if (!creds.sessionToken) {
        return Response.json({ error: 'not_logged_in' }, { status: 401, headers: corsHeaders });
      }
      try {
        let cookie = `__Secure-next-auth.session-token=${creds.sessionToken}`;
        if (creds.gatePassword) cookie += `; site-gate=${creds.gatePassword}`;
        const body = await req.json();
        const res = await fetch(`https://architect-ou79.onrender.com/api/engineering/items/${itemDetailMatch[1]}`, {
          method: 'PATCH',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) return Response.json(data, { status: res.status, headers: corsHeaders });
        return Response.json(data, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    if (url.pathname === '/architect/me' && req.method === 'GET') {
      const creds = loadArchitectCredentials();
      if (!creds.sessionToken) {
        return Response.json({ error: 'not_logged_in' }, { status: 401, headers: corsHeaders });
      }
      try {
        let cookie = `__Secure-next-auth.session-token=${creds.sessionToken}`;
        if (creds.gatePassword) cookie += `; site-gate=${creds.gatePassword}`;
        const res = await fetch('https://architect-ou79.onrender.com/api/me', {
          headers: { Cookie: cookie },
        });
        if (!res.ok) {
          return Response.json({ error: 'auth_failed' }, { status: res.status, headers: corsHeaders });
        }
        const user = await res.json();
        return Response.json(user, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    // ── Ticket Links ──────────────────────────────────────────────────

    const ticketLinkMatch = url.pathname.match(/^\/ticket-link\/([^/]+)$/);
    if (ticketLinkMatch && req.method === 'GET') {
      const link = getTicketLink(ticketLinkMatch[1]!);
      return Response.json({ link }, { headers: corsHeaders });
    }

    if (ticketLinkMatch && req.method === 'PUT') {
      const body = await req.json() as { ticketId: string; humanId: string; title: string };
      saveTicketLink(ticketLinkMatch[1]!, body);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (ticketLinkMatch && req.method === 'DELETE') {
      removeTicketLink(ticketLinkMatch[1]!);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    const ticketReviewMatch = url.pathname.match(/^\/ticket-link\/([^/]+)\/reviewed$/);
    if (ticketReviewMatch && req.method === 'POST') {
      const body = await req.json() as { commentIds: string[] };
      const link = getTicketLink(ticketReviewMatch[1]!);
      if (link) {
        const existing = new Set(link.reviewedCommentIds || []);
        body.commentIds.forEach(id => existing.add(id));
        saveTicketLink(ticketReviewMatch[1]!, {
          ...link,
          lastReviewedAt: new Date().toISOString(),
          reviewedCommentIds: [...existing],
        });
      }
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (url.pathname === '/ticket-links' && req.method === 'GET') {
      return Response.json(loadTicketLinks(), { headers: corsHeaders });
    }

    // ── PR Links ─────────────────────────────────────────────────────

    const prLinkMatch = url.pathname.match(/^\/pr-link\/([^/]+)$/);
    if (prLinkMatch && req.method === 'GET') {
      const link = getPRLink(prLinkMatch[1]!);
      return Response.json({ link }, { headers: corsHeaders });
    }

    if (prLinkMatch && req.method === 'PUT') {
      const body = await req.json() as { prNumber: number; title: string; url: string; headRefName: string; state: string };
      savePRLink(prLinkMatch[1]!, body);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (prLinkMatch && req.method === 'DELETE') {
      removePRLink(prLinkMatch[1]!);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    if (url.pathname === '/pr-links' && req.method === 'GET') {
      return Response.json(loadPRLinks(), { headers: corsHeaders });
    }

    // PR detail via gh CLI
    if (url.pathname === '/pr-detail' && req.method === 'GET') {
      const prNumber = url.searchParams.get('number');
      const cwd = url.searchParams.get('cwd') || CWD;
      if (!prNumber) return Response.json({ error: 'missing number' }, { status: 400, headers: corsHeaders });
      try {
        const prJson = execSync(
          `gh pr view ${prNumber} --json number,title,body,headRefName,baseRefName,state,url,isDraft,additions,deletions,changedFiles,commits,reviews,comments,labels,author,createdAt,updatedAt,mergedAt,mergeable`,
          { cwd, encoding: 'utf-8', timeout: 15000 },
        );
        return Response.json(JSON.parse(prJson), { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ error: e.message || String(e) }, { status: 502, headers: corsHeaders });
      }
    }

    // ── Preferences ──────────────────────────────────────────────────

    if (url.pathname === '/preferences' && req.method === 'GET') {
      return Response.json(loadPreferences(), { headers: corsHeaders });
    }

    if (url.pathname === '/preferences' && req.method === 'PUT') {
      const body = await req.json() as Record<string, unknown>;
      const prefs = loadPreferences();
      Object.assign(prefs, body);
      savePreferences(prefs);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // ── LSP ─────────────────────────────────────────────────────────────

    if (url.pathname === '/lsp/languages' && req.method === 'GET') {
      return Response.json(supportedLanguages(), { headers: corsHeaders });
    }

    // ── Debug (CDP) ──────────────────────────────────────────────────────

    if (url.pathname === '/debug/targets' && req.method === 'GET') {
      const host = url.searchParams.get('host') || '127.0.0.1';
      const port = parseInt(url.searchParams.get('port') || '9229', 10);
      const targets = await discoverTargets(host, port);
      return Response.json(targets, { headers: corsHeaders });
    }

    if (url.pathname === '/debug/connect' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>;
      const host = (body.host as string) || '127.0.0.1';
      const port = (body.port as number) || 9229;
      const targetId = body.targetId as string | undefined;
      const conn = await connectToTarget(host, port, targetId);
      if (!conn) return Response.json({ error: 'Failed to connect' }, { status: 502, headers: corsHeaders });
      return Response.json({ connectionId: conn.id, host: conn.host, port: conn.port, targetId: conn.targetId }, { headers: corsHeaders });
    }

    if (url.pathname === '/debug/disconnect' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>;
      const connectionId = body.connectionId as string;
      if (connectionId) disconnectTarget(connectionId);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // ── Health ──────────────────────────────────────────────────────────

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', sessions: sessions.size }, { headers: corsHeaders });
    }

    if (url.pathname === '/ui-log' && req.method === 'POST') {
      try {
        const body = await req.json() as { msg: string };
        log(`[UI] ${body.msg}`);
      } catch {}
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    const debugMatch = url.pathname.match(/^\/debug\/(.+)$/);
    if (debugMatch && req.method === 'GET') {
      const s = sessions.get(debugMatch[1]!);
      if (!s) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
      return Response.json({
        id: s.id,
        status: s.status,
        ready: s.ready,
        provider: s.provider,
        hasProviderSession: !!s.providerSession,
        browserWsCount: s.browserWs.size,
        frontendClientsCount: frontendClients.size,
        subscribedCount: [...subscriptions.values()].filter(subs => subs.has(debugMatch[1]!)).length,
      }, { headers: corsHeaders });
    }

    return new Response('Not found', { status: 404 });
  },

  // -------------------------------------------------------------------------
  // WebSocket handlers
  // -------------------------------------------------------------------------

  websocket: {
    open(ws) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      // Terminal viewer
      if (type === 'terminal') {
        if (procId) terminalWsOpen(ws, procId);
        return;
      }

      // Multiplexed frontend WebSocket
      if (type === 'frontend') {
        frontendClients.add(ws);
        subscriptions.set(ws, new Set());
        log(`[/ws] Frontend client connected (${frontendClients.size} total)`);
        // Send current session list immediately
        const list = [...sessions.values()].map(s => sessionToJSON(s, server.port));
        ws.send(JSON.stringify({ type: 'sessions', sessions: list }));
        return;
      }

      // Legacy per-session browser WebSocket (kept for compatibility with the
      // older frontend socket; new clients use the multiplexed /ws endpoint).
      if (type === 'browser') {
        const session = sessions.get(sessionId!);
        if (!session) { ws.close(4001, 'Session not found'); return; }
        session.browserWs.add(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS connected (${session.browserWs.size} total)`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
        }
        return;
      }

      // LSP WebSocket
      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (!lsp) { ws.close(4002, 'No language server available'); return; }
        addLspClient(lsp, ws);
        log(`[LSP] Client connected session=${sid?.slice(0, 8)} lang=${languageId}`);
        return;
      }

      // CDP Debug WebSocket
      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (!conn) { ws.close(4003, 'Debug connection not found'); return; }
        addCdpClient(conn, ws);
        log(`[CDP] Client connected to ${connectionId}`);
        return;
      }
    },

    message(ws, message) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      if (type === 'terminal') return;

      // CDP — forward message to debug target
      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (!conn) return;
        const data = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);
        sendCdpMessage(conn, data);
        return;
      }

      // LSP — forward message to language server stdin
      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (!lsp) return;
        try {
          const json = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer));
          sendToLsp(lsp, json);
        } catch {}
        return;
      }

      // Multiplexed frontend WebSocket
      if (type === 'frontend') {
        handleFrontendMessage(ws, message as string | ArrayBuffer);
        return;
      }

      // Legacy per-session browser WebSocket — messages are ignored.
      // New clients use the multiplexed frontend socket; this endpoint remains
      // open only for older clients that expect a one-way event feed.
    },

    close(ws) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      if (type === 'terminal') {
        if (procId) terminalWsClose(ws, procId);
        return;
      }

      if (type === 'frontend') {
        frontendClients.delete(ws);
        subscriptions.delete(ws);
        log(`[/ws] Frontend client disconnected (${frontendClients.size} remaining)`);
        return;
      }

      if (type === 'cdp') {
        const { connectionId } = ws.data as any;
        const conn = getConnection(connectionId);
        if (conn) removeCdpClient(conn, ws);
        log(`[CDP] Client disconnected from ${connectionId}`);
        return;
      }

      if (type === 'lsp') {
        const { sessionId: sid, languageId } = ws.data as any;
        const lsp = getOrCreateLsp(sid, languageId);
        if (lsp) removeLspClient(lsp, ws);
        log(`[LSP] Client disconnected session=${sid?.slice(0, 8)} lang=${languageId}`);
        return;
      }

      const session = sessions.get(sessionId!);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS disconnected (${session.browserWs.size} remaining)`);
        return;
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

// Write port file for service discovery
const PORT_FILE = join(homedir(), '.claude', 'ui-server.port');
try {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(PORT_FILE, String(server.port));
} catch {}
process.on('exit', () => { try { unlinkSync(PORT_FILE); } catch {} });
process.on('SIGINT', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });

log(`Bridge server listening on http://localhost:${server.port}`);
log(`Claude binary: ${CLAUDE_BIN}`);
log(`Working directory: ${CWD}`);
console.log(`BRIDGE_SERVER_PORT:${server.port}`);
setMcpServerPort(server.port);
setTelegramBroadcaster(broadcastToSession);
startTelegramBot(server.port);
