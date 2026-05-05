/**
 * Bridge server entry point.
 *
 * Run as HTTP server (default): bun run server/index.ts
 * Run as MCP server (stdio):    bun run server/index.ts --mcp
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { spawn, execSync } from 'child_process';
import { spawnPty } from './pty';

import { PORT, HOST, CLAUDE_BIN, corsHeaders, CWD, loadOrCreateMobileToken, getLanIp, resolveTls } from './config';
import { handleMobilePair, handleMobilePairRegenerate, handleMobileNotifyTest } from './handlers/mobile';
import { notifyPermissionResolved } from './notify';
import { log } from './logger';
import { sessions, loadSessions, saveSessions, sessionToJSON } from './sessions';
import { handleCreateSession, handleResumeSession, handleRenameSession, handleStopSession, handleDeleteSession } from './handlers/sessions';
import { getOpencodeInfo } from './handlers/opencode-info';
import { ClaudeAdapter } from './provider/adapters/ClaudeAdapter';
import { CodexAdapter } from './provider/adapters/CodexAdapter';
import { OpenCodeAdapter } from './provider/adapters/OpenCodeAdapter';
import { registerProvider } from './provider/registry';
import { setBridgeDeps, startProviderSession } from './provider/lifecycle';
import { resolvePermissionDecision } from './provider/bridge';
import { handleListDirs, handleListFiles, handleFileIndex, handleDeletePath, handleRenamePath, handleCreateFile, handleCreateDir, handleRevealInFinder } from './handlers/files';
import { handleExecCreate, terminalWsOpen, terminalWsClose } from './handlers/exec';
import { trackedProcesses, handleListProcesses, handleKillProcess, killProcessTree, saveProcessRegistry, restoreProcessRegistry, appendProcessOutput } from './handlers/processes';
import type { TrackedProcess } from './types';
import { handleGitModified, handleGitInfo, handleGhPrs, handleGitBranches, handleGitCheckout } from './handlers/git';
import { handleSearch } from './handlers/search';
import { handleCreateWorktree } from './handlers/worktree';
import { getOrCreateLsp, sendToLsp, addLspClient, removeLspClient, killSessionLsp, supportedLanguages } from './handlers/lsp';
import { discoverTargets, connectToTarget, getConnection, disconnectTarget, addCdpClient, removeCdpClient, sendCdpMessage } from './handlers/cdp';
import { registerShutdownHandlers } from './shutdown';
import { startTelegramBot, notifyTelegramIfMainSession, restartTelegramBot, isTelegramBotRunning, setTelegramBroadcaster } from './telegram';
import { ensureMcpConfig } from './ensure-mcp-config';
import * as pluginHost from './plugin-host';
import { handleMcpRequest, setMcpDeps } from './mcp';
import {
  getSessionState,
  updateSessionState,
  addMessage,
  healOrphanedToolUses,
  updateUIState,
  getStateForClient,
  clearSessionState,
} from './state';
import type { ChatMessage } from './state';
import { loadPRLinks, savePRLink, removePRLink, getPRLink, loadPreferences, savePreferences, loadTelegramSettings, saveTelegramSettings, loadDeepgramSettings, saveDeepgramSettings, loadTailscaleSettings, saveTailscaleSettings } from './storage';
import { transcribeAudioBuffer } from './deepgram';
import { isTailscaleAvailable, getTailscaleHostname, getFunnelStatus, enableFunnel, disableFunnel } from './tailscale';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Register provider adapters before loading sessions (so default provider exists)
registerProvider(ClaudeAdapter);
registerProvider(CodexAdapter);
registerProvider(OpenCodeAdapter);

// `--spawned-by=app|service` (or `CODIBY_SPAWN_MODE=app|service`) tells the
// server who launched it. In `service` mode (default) we proactively spawn a
// provider for every persisted active session at startup — the LaunchAgent
// runs headless and other clients (mobile, Telegram) expect work to keep
// progressing without an open Tauri window. In `app` mode the Tauri shell is
// the only consumer, so we leave sessions idle and the frontend tells us
// which one to spawn via the `active_tab_change` WS message — that way only
// the tab the user is looking at boots Claude, not all 20 of them.
type SpawnMode = 'app' | 'service';
function parseSpawnMode(): SpawnMode {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--spawned-by') {
      return argv[i + 1] === 'app' ? 'app' : 'service';
    }
    if (a.startsWith('--spawned-by=')) {
      return a.slice('--spawned-by='.length) === 'app' ? 'app' : 'service';
    }
  }
  return (process.env.CODIBY_SPAWN_MODE || '').toLowerCase() === 'app' ? 'app' : 'service';
}
const SPAWN_MODE: SpawnMode = parseSpawnMode();

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

/** Broadcast the full preferences object so clients stay in sync after a
 *  server-side mutation (e.g. an MCP tool updating tab groups). */
function broadcastPreferences(prefs: Record<string, unknown>) {
  const msg = JSON.stringify({ type: 'preferences', preferences: prefs });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/** Tell every connected frontend to switch its active tab to `sessionId`.
 *  Used when an external trigger (e.g. the `codiby` CLI) creates a session
 *  and wants the user to land on it immediately. */
function broadcastFocusSession(sessionId: string) {
  const msg = JSON.stringify({ type: 'focus_session', sessionId });
  for (const ws of frontendClients) {
    try { ws.send(msg); } catch {}
  }
}

/**
 * Merge-update preferences on disk and broadcast the new state to every
 * connected frontend. Used by MCP tools that mutate tab groups etc.
 */
function updatePreferences(partial: Record<string, unknown>): Record<string, unknown> {
  const prefs = loadPreferences();
  Object.assign(prefs, partial);
  savePreferences(prefs);
  broadcastPreferences(prefs);
  return prefs;
}

/** Auto-assigns a freshly-created session to a tab group whose name matches
 *  the cwd's project folder, mirroring the cycling-color behavior of the
 *  frontend's `handleCreateGroup`. Single source of truth for every
 *  session-creation entry point: HTTP `POST /sessions` (frontend, mobile,
 *  CLI) and MCP `ui_spawn_session`. No-ops if `autoGroupSessions` is off,
 *  if the cwd is empty, or if the session is already in a group (callers
 *  with an explicit group assignment win). */
const AUTOGROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];
type AutoGroup = { id: string; name: string; color: string; cwd?: string; icon?: string };
function maybeAutoGroupSession(sessionId: string, cwd: string) {
  if (!cwd) return;
  const prefs = loadPreferences();
  if (!prefs.autoGroupSessions) return;
  const map: Record<string, string> = { ...((prefs.tabGroupMap as Record<string, string>) || {}) };
  if (map[sessionId]) return;
  const folder = cwd.split('/').filter(Boolean).pop() || '/';
  const groups: Record<string, AutoGroup> = { ...((prefs.tabGroups as Record<string, AutoGroup>) || {}) };
  let groupId = Object.keys(groups).find(gid => groups[gid]!.name === folder);
  if (!groupId) {
    groupId = randomUUID();
    const color = AUTOGROUP_COLORS[Object.keys(groups).length % AUTOGROUP_COLORS.length]!;
    groups[groupId] = { id: groupId, name: folder, color, cwd };
  }
  map[sessionId] = groupId;
  updatePreferences({ tabGroups: groups, tabGroupMap: map });
}

/**
 * Send a user message to a session — shared between the frontend WebSocket
 * (`send_message`), the HTTP endpoint (`POST /sessions/:id/messages`), and
 * any MCP tools that drive a session. Auto-starts the provider if the
 * session is idle, echoes the message to the session's chat log, flips the
 * streaming flag, and forwards to the provider.
 */
async function sendMessageToSession(
  sessionId: string,
  text: string,
  images?: { media_type: string; data: string }[],
): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  if (!session.providerSession) {
    log(`[${session.id.slice(0, 8)}] Auto-starting provider on sendMessage (session was stopped/idle)`);
    startProviderSession(session, server.port, session.claudeSessionId ?? null);
    saveSessions();
  }
  if (!session.providerSession) {
    return { ok: false, error: 'Provider failed to start' };
  }
  session.replayDone = true;

  // Echo user message to persistence + frontend
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: text,
    timestamp: Date.now(),
    images,
  };
  if (addMessage(sessionId, userMsg)) {
    broadcastToSession(sessionId, { type: 'message', sessionId, message: userMsg });
  }

  updateSessionState(sessionId, s => ({ ...s, isStreaming: true }));
  broadcastToSession(sessionId, { type: 'status', sessionId, status: 'streaming' });

  try {
    await session.providerSession.sendUserMessage({ text, images });
    return { ok: true };
  } catch (err) {
    log(`[${sessionId.slice(0, 8)}] sendUserMessage failed: ${err}`);
    return { ok: false, error: String(err) };
  }
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

/** Sideloaded plugins from `~/.codiby/plugins/<id>/`. Empty dir ⇒ no-op. */
await pluginHost.loadPlugins({
  broadcastToAllFrontends(msg) {
    const data = JSON.stringify(msg);
    for (const ws of frontendClients) {
      try { ws.send(data); } catch {}
    }
  },
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

  // ---- active_tab_change ---------------------------------------------------
  // Frontend tells us which tab is in focus (app spawn mode only). Boots the
  // session's provider on demand so we don't spawn 20 Claude CLIs at once
  // when the desktop app first connects. No-op in service mode — there the
  // server already spawned everything at startup.
  if (type === 'active_tab_change') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    if (SPAWN_MODE !== 'app') return;
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.providerSession) return;
    log(`[spawn-mode=app] Active tab → spawning ${sessionId.slice(0, 8)} (${session.name})`);
    try {
      startProviderSession(session, server.port, session.claudeSessionId ?? null);
      saveSessions();
    } catch (err) {
      log(`[spawn-mode=app] Failed to spawn ${sessionId.slice(0, 8)}: ${err}`);
    }
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

    // Mark the session as streaming immediately so connected clients can show
    // a "thinking" indicator while we wait for Claude's first token (which can
    // take a few seconds). The provider's onAssistantDelta will keep
    // isStreaming=true and add partialText; onTurnComplete clears it. Also
    // clear `wasInterrupted` — the user is starting a new turn so the "last
    // turn died" red dot should disappear right when they hit send.
    updateSessionState(sessionId, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
    broadcastToSession(sessionId, { type: 'status', sessionId, status: 'streaming' });

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

    // Clear permission request from state and notify ALL subscribed clients
    // (including the one that responded — its own UI may have already cleared
    // optimistically; for any other connected client this is the only signal).
    updateSessionState(sessionId, s => ({ ...s, permRequest: null }));
    broadcastToSession(sessionId, { type: 'permission_cancelled', sessionId, requestId });

    // Update the original Telegram alert (if any) in place so the message
    // becomes "✅ Approved" / "❌ Denied" instead of staying as a stale
    // "🔔 Permission needed" record.
    notifyPermissionResolved(requestId, { allow });
    return;
  }

  // ---- interrupt -----------------------------------------------------------
  if (type === 'interrupt') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    // Stop is also the user's escape hatch when `isStreaming` is wedged with
    // no live provider (SDK crashed silently, runtime hung past onExit, etc.).
    // Always force-clear server state below; only call provider.interrupt()
    // when the runtime is actually around.
    if (session.providerSession) {
      try { await session.providerSession.interrupt(); } catch (err) {
        log(`[${sessionId.slice(0, 8)}] interrupt failed: ${err}`);
      }
    }
    // Authoritatively flip the session out of "streaming" and notify viewers.
    // Without this the SDK can keep emitting in-flight tool events for a beat
    // after interrupt(), each of which re-arms `isStreaming` in the bridge —
    // leaving the Stop button visible but ineffective. The bridge guards on
    // `wasInterrupted` (set here) so those late events stop re-arming.
    updateSessionState(sessionId, s => ({ ...s, isStreaming: false, partialText: '', wasInterrupted: true }));
    // Pair every in-flight tool_use with a synthetic error result so the
    // per-tool "running" dot clears in the UI. Without this, an interrupted
    // Bash (etc.) shows an amber pulse forever — `anyRunning` keys off
    // unmatched tool_use messages.
    const synthetic = healOrphanedToolUses(sessionId, 'Interrupted by user.');
    for (const msg of synthetic) {
      broadcastToSession(sessionId, { type: 'message', sessionId, message: msg });
    }
    broadcastToSession(sessionId, { type: 'status', sessionId, status: 'interrupted' });
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

    // Re-attach path: if the client already sent us this procId and the PTY
    // is still live, don't spawn a second shell. Instead replay whatever
    // buffered output we have so the xterm that just mounted can paint the
    // current screen — this is how terminals survive a tab switch / PWA
    // reload (the server keeps the PTY alive the whole time).
    const existing = trackedProcesses.get(procId);
    if (existing && existing.kind === 'pty' && existing.exitCode === null) {
      const replay = existing.outputBuffer.join('');
      // Tell the viewer to reset its xterm BEFORE the replay lands. Without
      // this, any optimistic local replay the client did from its persisted
      // chat log (desktop reducer appends every terminal_data into the
      // message's content field) ends up concatenated with our authoritative
      // buffer — producing the doubled-character symptom that looks like
      // `ggitt cchheerrryy--pppiicckk …`.
      broadcastToSession(sessionId, { type: 'terminal_reset', sessionId, procId });
      if (replay) {
        broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text: replay });
      }
      // Push the newly-requested cols/rows through — xterm was probably
      // remounted at a different viewport size than the previous viewer.
      try {
        existing.pty?.resize(execCols, execRows);
        existing.cols = execCols;
        existing.rows = execRows;
      } catch {}
      log(`[exec_shell] re-attached procId=${procId.slice(0, 8)} (reset+replayed ${replay.length} bytes)`);
      return;
    }

    const pty = spawnPty({ cwd: execCwd, cols: execCols, rows: execRows });
    if (!pty) {
      broadcastToSession(sessionId, {
        type: 'terminal_data', sessionId, procId,
        text: '\r\n\x1b[31m[/terminal unavailable: Bun.Terminal requires Bun >= 1.3.5]\x1b[0m\r\n',
      });
      broadcastToSession(sessionId, { type: 'terminal_exit', sessionId, procId, code: 127 });
      return;
    }

    const tp: TrackedProcess = {
      id: procId,
      pid: pty.pid,
      command: '(interactive shell)',
      cwd: execCwd,
      sessionId,
      startedAt: Date.now(),
      proc: null,
      viewers: new Set<any>(),
      outputBuffer: [] as string[],
      exitCode: null,
      kind: 'pty',
      cols: execCols,
      rows: execRows,
      pty,
    };
    trackedProcesses.set(procId, tp);
    saveProcessRegistry();
    log(`[exec_shell] spawned pty procId=${procId.slice(0, 8)} session=${sessionId.slice(0, 8)} pid=${pty.pid} cwd=${execCwd}`);

    pty.onData((text) => {
      tp.outputBuffer.push(text);
      if (tp.outputBuffer.length > 1000) tp.outputBuffer.splice(0, tp.outputBuffer.length - 500);
      appendProcessOutput(procId, text);
      broadcastToSession(sessionId, { type: 'terminal_data', sessionId, procId, text });
    });
    pty.onExit((code) => {
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
    tp.pty?.write(data);
    return;
  }

  // ---- terminal_resize -----------------------------------------------------
  if (type === 'terminal_resize') {
    const { procId, cols, rows } = msg as { procId: string; cols: number; rows: number };
    if (!procId || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const tp = trackedProcesses.get(procId);
    if (!tp || tp.kind !== 'pty' || tp.exitCode !== null) return;
    tp.cols = cols; tp.rows = rows;
    tp.pty?.resize(cols, rows);
    return;
  }

  // ---- terminal_kill -------------------------------------------------------
  // Gracefully end an interactive shell (SIGHUP), falling back to process group
  // kill if the shell doesn't exit within 500ms.
  if (type === 'terminal_kill') {
    const { procId } = msg as { procId: string };
    if (!procId) return;
    const tp = trackedProcesses.get(procId);
    if (!tp) return;
    if (tp.kind === 'pty' && tp.pty) {
      tp.pty.kill('SIGHUP');
      setTimeout(() => {
        if (tp.exitCode !== null) return;
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
        if (tp.kind === 'pty' && tp.pty) {
          tp.pty.kill('SIGHUP');
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
// Mobile auth + static asset serving
// ---------------------------------------------------------------------------

// Don't cache the token in a module-level constant — it can be rotated via
// POST /mobile/pair/regenerate, and a captured copy would keep accepting the
// old value until process restart. `loadOrCreateMobileToken()` reads the
// in-memory cache that `regenerateMobileToken()` invalidates.
loadOrCreateMobileToken();

/**
 * Treat the request as "trusted" if it comes from localhost. The Tauri
 * desktop app always uses localhost, so this preserves zero-config desktop
 * usage while requiring the bearer token from any LAN client.
 */
function isLocalhostRequest(req: Request): boolean {
  const host = req.headers.get('host') || '';
  // Strip port; accept both IPv4/IPv6 loopback
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** Routes that must remain reachable without the bearer token. */
function isPublicRoute(pathname: string): boolean {
  if (pathname === '/health') return true;
  if (pathname === '/manifest.webmanifest') return true;
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return true;
  if (pathname.startsWith('/brand/')) return true;
  // Desktop UI — served by the same bridge that owns the API + WS.
  // Auth (when required) happens client-side; LAN / Funnel browsers bring
  // the bearer token into `/sessions` / `/ws/*` calls.
  if (pathname === '/' || pathname === '/index.html') return true;
  // The mobile page itself is public — auth happens client-side via the token
  // in localStorage / URL fragment before WebSocket / HTTP calls are made.
  if (pathname === '/m' || pathname === '/m/' || pathname === '/m/index.html') return true;
  // PWA service worker — must be reachable without auth so the browser can
  // register it on every page load.
  if (pathname === '/sw.js') return true;
  // Hashed asset chunks produced by `bun build` (was `/_astro/` under Astro).
  if (pathname.startsWith('/assets/')) return true;
  // Shared React runtime bundles referenced by the importmap. Loaded by
  // <script> tags from /m and /, which can't carry the bearer token.
  if (pathname.startsWith('/runtime/')) return true;
  return false;
}

function authCheck(req: Request, url: URL): boolean {
  if (isLocalhostRequest(req)) return true;
  if (isPublicRoute(url.pathname)) return true;
  // Read the current token live so rotation takes effect without a restart.
  const token = loadOrCreateMobileToken();
  // Token sources, in priority order:
  //   1. Authorization: Bearer <token>
  //   2. ?t=<token> query string
  //   3. Sec-WebSocket-Protocol: <token>   (the only header browsers allow on WS upgrade)
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim() === token) return true;
  }
  const qt = url.searchParams.get('t');
  if (qt && qt === token) return true;
  const wsProto = req.headers.get('sec-websocket-protocol');
  if (wsProto && wsProto.split(',').map(s => s.trim()).includes(token)) return true;
  return false;
}

// Serve built static files (desktop + mobile UI) from `dist/`. Produced by
// `bun build` via `scripts/build.ts`. We probe a few common locations so
// this works from source (`bun run server/index.ts`), from a bundled
// `server.js` next to `dist/`, and from the Docker image layout.
const DIST_CANDIDATES = (() => {
  const candidates: string[] = [];
  try {
    const scriptDir = dirname(process.argv[1] || '');
    if (scriptDir) {
      candidates.push(join(scriptDir, 'dist'));        // bundled alongside server.js
      candidates.push(join(scriptDir, '..', 'dist'));  // server in /server, dist in /
    }
  } catch {}
  // Source tree
  try {
    const here = dirname(new URL(import.meta.url).pathname);
    candidates.push(join(here, '..', 'dist'));
  } catch {}
  candidates.push(join(process.cwd(), 'dist'));
  return candidates;
})();

function findDist(): string | null {
  for (const p of DIST_CANDIDATES) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.map':   'application/json',
};

async function serveStaticFromDist(pathname: string): Promise<Response | null> {
  const dist = findDist();
  if (!dist) return null;
  // Map URL → file
  let rel: string;
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
  else if (pathname === '/m' || pathname === '/m/' || pathname === '/m/index.html') rel = 'm/index.html';
  else rel = pathname.replace(/^\//, '');
  const filePath = join(dist, rel);
  // Prevent directory traversal
  if (!filePath.startsWith(dist)) return null;
  try {
    if (!existsSync(filePath)) return null;
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...corsHeaders,
      },
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// Auto-enable HTTPS when cert + key are present under ~/.claude/tls/
const TLS = resolveTls();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  ...(TLS ? { tls: TLS } : {}),

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight (always allowed; auth header is checked on the actual request)
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Mobile bearer-token auth (no-op for localhost / public routes)
    if (!authCheck(req, url)) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders });
    }

    // Sideloaded plugins (`~/.codiby/plugins/<id>/`).
    // - GET /plugins         → manifest list for the frontend loader
    // - /plugins/<id>/...    → plugin-registered routes & static assets
    if (url.pathname === '/plugins' && req.method === 'GET') {
      return new Response(JSON.stringify(pluginHost.getPluginListEntries()), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    if (url.pathname.startsWith('/plugins/')) {
      const resp = await pluginHost.dispatch(req, url);
      if (resp) return resp;
    }

    // Static assets for the desktop + mobile UI (built by `bun build` into dist/)
    if (
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/m' ||
      url.pathname === '/m/' ||
      url.pathname === '/m/index.html' ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname === '/favicon.svg' ||
      url.pathname === '/favicon.ico' ||
      url.pathname === '/sw.js' ||
      url.pathname.startsWith('/brand/') ||
      url.pathname.startsWith('/assets/') ||
      // Shared React runtime bundles for the importmap (host ↔ plugins).
      url.pathname.startsWith('/runtime/')
    ) {
      const resp = await serveStaticFromDist(url.pathname);
      if (resp) return resp;
      if (
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/m' ||
        url.pathname === '/m/'
      ) {
        return new Response(
          'UI not built. Run `bun run build-server` first.',
          { status: 503, headers: { 'Content-Type': 'text/plain', ...corsHeaders } },
        );
      }
      // For asset requests, fall through (they'd return 404 below anyway)
    }

    // Mobile pair endpoints — restricted to localhost so only the desktop user
    // can read/rotate the token.
    if (url.pathname === '/mobile/pair' && req.method === 'GET') {
      if (!isLocalhostRequest(req)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      return handleMobilePair();
    }
    if (url.pathname === '/mobile/pair/regenerate' && req.method === 'POST') {
      if (!isLocalhostRequest(req)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders });
      }
      const res = await handleMobilePairRegenerate();
      // Kick already-authenticated WebSockets so they reconnect with the new
      // token. Localhost clients (the desktop UI) bypass auth and reconnect
      // transparently; remote clients (mobile) will fail re-auth until they
      // re-pair via QR.
      for (const ws of [...frontendClients]) {
        try { ws.close(4401, 'Token rotated'); } catch {}
      }
      for (const tp of trackedProcesses.values()) {
        for (const ws of [...tp.viewers]) {
          try { ws.close(4401, 'Token rotated'); } catch {}
        }
      }
      return res;
    }
    if (url.pathname === '/mobile/notify-test' && req.method === 'POST') {
      return handleMobileNotifyTest(req);
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
      // Apply the `autoGroupSessions` preference server-side so every entry
      // point (frontend, mobile, CLI) honors it without each client needing
      // its own copy of the logic.
      let createdId: string | null = null;
      if (resp.ok) {
        try {
          const body = await resp.clone().json() as { id?: string; cwd?: string };
          if (body?.id) {
            createdId = body.id;
            if (body.cwd) maybeAutoGroupSession(body.id, body.cwd);
          }
        } catch {}
      }
      broadcastSessionList();
      // ?focus=1 → also tell clients to switch their active tab to the new
      // session. Used by the `codiby` CLI so `codiby .` lands the user on
      // the freshly created tab instead of leaving them on whatever was open.
      if (url.searchParams.get('focus') === '1' && createdId) {
        broadcastFocusSession(createdId);
      }
      return resp;
    }

    const resumeMatch = url.pathname.match(/^\/sessions\/(.+)\/resume$/);
    if (resumeMatch && req.method === 'POST') {
      const resp = handleResumeSession(resumeMatch[1]!, server.port);
      broadcastSessionList();
      return resp;
    }

    if (url.pathname === '/providers/opencode/info' && req.method === 'GET') {
      const info = await getOpencodeInfo();
      return Response.json(info, { headers: corsHeaders });
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
      // ?purge=1     → also delete the on-disk chat history + UI state
      // ?worktree=1  → also remove the git worktree (when cwd looks like one)
      // Plain DELETE is the legacy soft-remove (in-memory drop only).
      const purge = url.searchParams.get('purge') === '1';
      const removeWorktree = url.searchParams.get('worktree') === '1';
      const resp = handleDeleteSession(deleteMatch[1]!, purge, removeWorktree);
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

    if (url.pathname === '/file-content' && req.method === 'DELETE') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      return handleDeletePath(filePath);
    }

    if (url.pathname === '/file-rename' && req.method === 'POST') {
      try {
        const body = await req.json() as { from: string; to: string };
        if (!body.from || !body.to) return Response.json({ error: 'from and to required' }, { status: 400, headers: corsHeaders });
        return handleRenamePath(body.from, body.to);
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === '/file-new' && req.method === 'POST') {
      try {
        const body = await req.json() as { path: string; kind: 'file' | 'dir' };
        if (!body.path || !body.kind) return Response.json({ error: 'path and kind required' }, { status: 400, headers: corsHeaders });
        return body.kind === 'dir' ? handleCreateDir(body.path) : handleCreateFile(body.path);
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    if (url.pathname === '/file-reveal' && req.method === 'POST') {
      try {
        const body = await req.json() as { path: string };
        if (!body.path) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
        return handleRevealInFinder(body.path);
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

    // ── Deepgram ────────────────────────────────────────────────────────

    if (url.pathname === '/deepgram/settings' && req.method === 'GET') {
      const settings = loadDeepgramSettings();
      return Response.json({
        apiKey: settings.apiKey,
        model: settings.model,
        language: settings.language,
        configured: Boolean(settings.apiKey),
      }, { headers: corsHeaders });
    }

    if (url.pathname === '/deepgram/settings' && req.method === 'PUT') {
      const body = await req.json() as { apiKey?: string; model?: string; language?: string };
      const apiKey = (body.apiKey ?? '').trim();
      const model = (body.model ?? '').trim() || 'nova-3';
      const language = (body.language ?? '').trim() || 'multi';
      saveDeepgramSettings({ apiKey, model, language });
      return Response.json({ ok: true, configured: Boolean(apiKey) }, { headers: corsHeaders });
    }

    // Transcribe a one-shot audio blob via Deepgram. The mobile composer
    // records a short voice note and POSTs the raw audio bytes here; we
    // stream it to Deepgram (same code path Telegram voice notes use) and
    // return the joined transcript. Client turns it into a regular chat
    // message — no TTS, no streaming back.
    if (url.pathname === '/deepgram/transcribe' && req.method === 'POST') {
      try {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (buf.byteLength === 0) {
          return new Response('empty audio body', { status: 400, headers: corsHeaders });
        }
        const { transcript, detectedLanguage, durationSec } = await transcribeAudioBuffer(buf);
        return Response.json({ transcript, detectedLanguage, durationSec }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(msg, { status: 500, headers: corsHeaders });
      }
    }

    // ── Tailscale Funnel ────────────────────────────────────────────────

    if (url.pathname === '/tailscale/settings' && req.method === 'GET') {
      const settings = loadTailscaleSettings();
      const available = isTailscaleAvailable();
      const hostname = available ? getTailscaleHostname() : null;
      const status = available ? getFunnelStatus() : { active: false, ports: [] };
      return Response.json({
        funnelEnabled: settings.funnelEnabled,
        available,
        hostname,
        funnelActive: status.active,
        funnelPorts: status.ports,
        funnelUrl: settings.funnelEnabled && hostname ? `https://${hostname}` : null,
      }, { headers: corsHeaders });
    }

    if (url.pathname === '/tailscale/settings' && req.method === 'PUT') {
      const body = await req.json() as { funnelEnabled?: boolean };
      const enabled = !!body.funnelEnabled;
      let error: string | null = null;
      if (enabled) {
        const res = enableFunnel(PORT);
        if (!res.ok) error = res.error;
      } else {
        const res = disableFunnel();
        if (!res.ok && isTailscaleAvailable()) error = res.error;
      }
      // Persist intent even if the CLI call fails so the UI reflects the
      // user's choice and we can surface the underlying error.
      saveTailscaleSettings({ funnelEnabled: enabled && !error });
      const hostname = isTailscaleAvailable() ? getTailscaleHostname() : null;
      const status = isTailscaleAvailable() ? getFunnelStatus() : { active: false, ports: [] };
      return Response.json({
        ok: !error,
        error,
        funnelEnabled: enabled && !error,
        available: isTailscaleAvailable(),
        hostname,
        funnelActive: status.active,
        funnelPorts: status.ports,
        funnelUrl: enabled && !error && hostname ? `https://${hostname}` : null,
      }, { status: error ? 400 : 200, headers: corsHeaders });
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
      updatePreferences(body);
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
        // Welcome message first so the client knows whether to auto-resume
        // every stopped session (service mode — sessions are already up) or
        // wait for `active_tab_change` to spawn lazily (app mode).
        ws.send(JSON.stringify({ type: 'welcome', spawnMode: SPAWN_MODE }));
        // Preferences must arrive before the sessions list — the client uses
        // closedSessionIds/archivedSessionIds/tabOrder to decide which tabs to
        // show, so receiving the session list first would race the prefs and
        // briefly render every persisted session as an open tab.
        ws.send(JSON.stringify({ type: 'preferences', preferences: loadPreferences() }));
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

// Write port file for service discovery. Must match the path the Tauri
// frontend reads in `src-tauri/src/lib.rs::bridge_port_file`:
//   - Explicit override: $CODIBY_CODE_PORT_FILE (used by the macOS LaunchAgent
//     and the Windows SCM wrapper).
//   - macOS:   ~/.codiby/server.port         (launchd)
//   - Windows: %PROGRAMDATA%\codiby\server.port (CodibyCodeBridge)
//   - Linux:   $XDG_CONFIG_HOME/codiby/port  (fallback ~/.config/codiby/port)
function resolvePortFile(): string {
  const override = process.env.CODIBY_CODE_PORT_FILE;
  if (override && override.trim()) return override.trim();

  if (process.platform === 'darwin') {
    return join(homedir(), '.codiby', 'server.port');
  }
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'codiby', 'server.port');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'codiby', 'port');
}

const PORT_FILE = resolvePortFile();
try {
  mkdirSync(dirname(PORT_FILE), { recursive: true });
  writeFileSync(PORT_FILE, String(server.port));
} catch {}
process.on('exit', () => { try { unlinkSync(PORT_FILE); } catch {} });
process.on('SIGINT', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });
process.on('SIGTERM', () => { try { unlinkSync(PORT_FILE); } catch {}; process.exit(0); });

{
  const scheme = TLS ? 'https' : 'http';
  log(`Bridge server listening on ${scheme}://localhost:${server.port} (host=${HOST}, tls=${!!TLS})`);
  log(`Claude binary: ${CLAUDE_BIN}`);
  log(`Working directory: ${CWD}`);
  log(`Spawn mode: ${SPAWN_MODE}`);
  const lanIp = getLanIp();
  if (lanIp && lanIp !== '127.0.0.1') {
    log(`Mobile URL: ${scheme}://${lanIp}:${server.port}/m#t=${loadOrCreateMobileToken()}`);
  } else {
    log('Mobile URL: (no LAN IP detected — connect to a WiFi network)');
  }
}
console.log(`BRIDGE_SERVER_PORT:${server.port}`);
setMcpDeps({
  port: server.port,
  sendMessageToSession,
  broadcastSessionList,
  updatePreferences,
  loadPreferences,
  maybeAutoGroupSession,
});
setTelegramBroadcaster(broadcastToSession);
startTelegramBot(server.port);

// Service-mode bulk spawn: bring every persisted, non-closed/non-archived
// session online so background work keeps flowing while no UI is open.
// Throttled to 1s per spawn past the first 5 — Claude's auth backend flags
// many simultaneous CLI handshakes from the same machine as suspicious and
// can return 429s mid-handshake, leaving sessions wedged in `starting`.
async function bulkSpawnActiveSessions(port: number) {
  const prefs = loadPreferences();
  const closedRaw = prefs.closedSessionIds;
  const archivedRaw = prefs.archivedSessionIds;
  const closed = new Set(Array.isArray(closedRaw) ? (closedRaw as string[]) : []);
  const archived = new Set(Array.isArray(archivedRaw) ? (archivedRaw as string[]) : []);
  const active = [...sessions.values()].filter(s =>
    !s.providerSession && !closed.has(s.id) && !archived.has(s.id),
  );
  if (active.length === 0) {
    log(`[spawn-mode=service] No active sessions to spawn`);
    return;
  }
  const throttle = active.length > 5;
  log(`[spawn-mode=service] Spawning ${active.length} active session(s)${throttle ? ' (throttled 1s each)' : ''}`);
  for (let i = 0; i < active.length; i++) {
    const s = active[i]!;
    log(`[spawn-mode=service] (${i + 1}/${active.length}) ${s.id.slice(0, 8)} ${s.name}`);
    try {
      startProviderSession(s, port, s.claudeSessionId);
    } catch (err) {
      log(`[spawn-mode=service] Failed to spawn ${s.id.slice(0, 8)}: ${err}`);
    }
    if (throttle && i < active.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  saveSessions();
}

if (SPAWN_MODE === 'service') {
  bulkSpawnActiveSessions(server.port).catch(err =>
    log(`[spawn-mode=service] bulk spawn error: ${err}`),
  );
}
