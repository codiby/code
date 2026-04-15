/**
 * Bridge server entry point.
 *
 * Run as HTTP server (default): bun run server/index.ts
 * Run as MCP server (stdio):    bun run server/index.ts --mcp
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { PORT, CLAUDE_BIN, corsHeaders, ACCEPT_EDITS_TOOLS, CWD } from './config';
import { log } from './logger';
import { sessions, loadSessions, saveSessions, sessionToJSON } from './sessions';
import { handleCreateSession, handleResumeSession, handleRenameSession, handleDeleteSession } from './handlers/sessions';
import { handleListDirs, handleListFiles, handleFileIndex } from './handlers/files';
import { handleExecCreate, terminalWsOpen, terminalWsClose } from './handlers/exec';
import { trackedProcesses, handleListProcesses, handleKillProcess, killProcessTree, saveProcessRegistry, restoreProcessRegistry, appendProcessOutput } from './handlers/processes';
import { handleGitModified, handleGitInfo, handleGhPrs, handleGitBranches, handleGitCheckout } from './handlers/git';
import { handleSearch } from './handlers/search';
import { handleCreateWorktree } from './handlers/worktree';
import { registerShutdownHandlers } from './shutdown';
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
import type { ChatMessage, PermissionRequest } from './state';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

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
// Claude message processing
// ---------------------------------------------------------------------------

/**
 * Process a raw message from the Claude CLI WebSocket, update server state,
 * and broadcast structured events to subscribed frontend clients.
 *
 * Returns true if the message was auto-accepted (no relay to browser needed
 * for raw format — structured events are always emitted).
 */
function processClaudeMessage(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  let msg: any;
  try {
    msg = JSON.parse(data);
  } catch {
    // Not JSON — relay as-is (legacy)
    broadcastToSession(sessionId, { type: 'raw', sessionId, data });
    return false;
  }

  // ------------------------------------------------------------------
  // Auto-accept permission requests
  // ------------------------------------------------------------------
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
    const toolName = msg.request.tool_name as string;
    const mode = session.permissionMode || 'default';
    const shouldAutoAccept =
      mode === 'bypassPermissions' ||
      (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName));

    if (shouldAutoAccept) {
      const requestId = msg.request_id as string;
      const input = (msg.request.input as Record<string, unknown>) || {};

      // Send allow response directly to Claude CLI
      const response =
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'allow', updatedInput: {} },
          },
        }) + '\n';
      if (session.claudeWs) {
        (session.claudeWs as any).send(response);
      }

      // Notify subscribed frontend clients
      broadcastToSession(sessionId, {
        type: 'auto_approved',
        sessionId,
        toolName,
        filePath: input.file_path || input.path || null,
        command: input.command || null,
      });

      log(`[${session.id.slice(0, 8)}] Auto-approved ${toolName} (mode=${mode})`);
      return true; // auto-accepted
    }
  }

  // ------------------------------------------------------------------
  // Capture claude session id
  // ------------------------------------------------------------------
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
    session.claudeSessionId = msg.session_id as string;
    saveSessions();

    // Capture init info and emit to frontend
    const tools: string[] = [];
    const slashCommands: string[] = [];
    if (Array.isArray(msg.tools)) {
      for (const t of msg.tools) {
        if (t?.name) tools.push(t.name as string);
      }
    }
    const initInfo = {
      tools,
      cwd: session.cwd,
      version: (msg.claudeVersion as string) || '',
      slashCommands,
      model: session.model || '',
      permissionMode: session.permissionMode || 'default',
    };
    updateSessionState(sessionId, s => ({ ...s, initInfo }));
    broadcastToSession(sessionId, { type: 'init_info', sessionId, info: initInfo });
  }

  // ------------------------------------------------------------------
  // Auto-name session from first assistant text
  // ------------------------------------------------------------------
  if (msg.type === 'assistant' && session.name.startsWith('Session ')) {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b.type === 'text');
      if (textBlock?.text) {
        const newName = (textBlock.text as string).slice(0, 40).replace(/\n/g, ' ');
        session.name = newName;
        saveSessions();
        broadcastToSession(sessionId, { type: 'session_name', sessionId, name: newName });
        broadcastSessionList();
      }
    }
  }

  // ------------------------------------------------------------------
  // Permission request (control_request / can_use_tool — not auto-accepted)
  // ------------------------------------------------------------------
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
    const permRequest: PermissionRequest = {
      requestId: msg.request_id as string,
      toolName: msg.request.tool_name as string,
      displayName: msg.request.tool_display_name as string | undefined,
      description: msg.request.description as string | undefined,
      input: (msg.request.input as Record<string, unknown>) || {},
      title: msg.request.title as string | undefined,
    };
    updateSessionState(sessionId, s => ({ ...s, permRequest }));
    broadcastToSession(sessionId, { type: 'permission_request', sessionId, request: permRequest });
    return false;
  }

  // ------------------------------------------------------------------
  // Assistant message (streaming text / tool use)
  // ------------------------------------------------------------------
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      let partialText = '';

      for (const block of content) {
        if (block.type === 'text') {
          partialText += block.text as string;
        } else if (block.type === 'tool_use') {
          // Commit any accumulated text as a message before the tool use
          if (partialText.trim()) {
            const textMsg: ChatMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: partialText,
              timestamp: Date.now(),
            };
            if (addMessage(sessionId, textMsg)) {
              broadcastToSession(sessionId, { type: 'message', sessionId, message: textMsg });
            }
            partialText = '';
          }

          // TodoWrite — update ui.todos instead of adding a chat message
          if (block.name === 'TodoWrite') {
            const todos = (block.input as any)?.todos || [];
            updateUIState(sessionId, { todos });
            broadcastToSession(sessionId, { type: 'todos', sessionId, todos });
          } else {
            // Regular tool use — add as chat message
            const chatMsg: ChatMessage = {
              id: block.id || randomUUID(),
              role: 'assistant',
              content: `Using tool: **${block.name}**`,
              timestamp: Date.now(),
              toolName: block.name as string,
              toolInput: block.input,
            };
            if (addMessage(sessionId, chatMsg)) {
              broadcastToSession(sessionId, { type: 'message', sessionId, message: chatMsg });
            }
          }
        }
      }

      // Check if turn is complete
      const stopReason = msg.message?.stop_reason;
      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        // Commit any remaining partial text as a message
        if (partialText.trim()) {
          const finalMsg: ChatMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: partialText,
            timestamp: Date.now(),
            model: msg.message?.model,
            usage: msg.usage,
          };
          if (addMessage(sessionId, finalMsg)) {
            broadcastToSession(sessionId, { type: 'message', sessionId, message: finalMsg });
          }
        }
        updateSessionState(sessionId, s => ({ ...s, partialText: '', isStreaming: false }));
        broadcastToSession(sessionId, { type: 'status', sessionId, status: 'turn_complete' });
        session.replayDone = true;
      } else if (partialText && session.replayDone) {
        // Only update streaming state for live (non-replay) messages
        updateSessionState(sessionId, s => ({ ...s, partialText, isStreaming: true }));
        broadcastToSession(sessionId, { type: 'partial_text', sessionId, text: partialText });
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Result message (tool result / final response)
  // ------------------------------------------------------------------
  if (msg.type === 'result') {
    session.replayDone = true;
    updateSessionState(sessionId, s => ({ ...s, isStreaming: false, partialText: '' }));

    const content = msg.result;
    if (content) {
      const chatMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: Date.now(),
        costUsd: msg.cost_usd as number | undefined,
        durationMs: msg.duration_ms as number | undefined,
        usage: msg.usage as { input_tokens: number; output_tokens: number } | undefined,
      };
      if (addMessage(sessionId, chatMsg)) {
        broadcastToSession(sessionId, { type: 'message', sessionId, message: chatMsg });
      }
    }

    // Clear any pending permission request
    updateSessionState(sessionId, s => ({ ...s, permRequest: null }));
    broadcastToSession(sessionId, { type: 'status', sessionId, status: 'turn_complete' });
    return false;
  }

  // ------------------------------------------------------------------
  // Tool result (from tool_use)
  // ------------------------------------------------------------------
  if (msg.type === 'tool_result') {
    const chatMsg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      timestamp: Date.now(),
      isToolResult: true,
      isError: msg.is_error as boolean | undefined,
    };
    if (addMessage(sessionId, chatMsg)) {
      broadcastToSession(sessionId, { type: 'message', sessionId, message: chatMsg });
    }
    return false;
  }

  // ------------------------------------------------------------------
  // User message echo — save to JSONL only (frontend already has it)
  // ------------------------------------------------------------------
  if (msg.type === 'user') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          addMessage(sessionId, { id: randomUUID(), role: 'user', content: block.text as string, timestamp: Date.now() });
        }
      }
    } else if (typeof content === 'string') {
      addMessage(sessionId, { id: randomUUID(), role: 'user', content, timestamp: Date.now() });
    }
    return false;
  }

  // Fallback — relay raw for anything not explicitly handled
  return false;
}

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
    if (!session || !session.claudeWs) return;
    session.replayDone = true;

    const payload: any = {
      type: 'user',
      message: {
        role: 'user',
        content: images && images.length > 0
          ? [
              ...images.map((img: { media_type: string; data: string }) => ({
                type: 'image',
                source: { type: 'base64', media_type: img.media_type, data: img.data },
              })),
              { type: 'text', text: msgText },
            ]
          : msgText,
      },
    };
    const line = JSON.stringify(payload) + '\n';
    (session.claudeWs as any).send(line);
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
    if (!session || !session.claudeWs) return;

    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: updatedInput || {} }
          : { behavior: 'deny' },
      },
    }) + '\n';
    (session.claudeWs as any).send(response);

    // Clear permission request from state
    updateSessionState(sessionId, s => ({ ...s, permRequest: null }));
    return;
  }

  // ---- interrupt -----------------------------------------------------------
  if (type === 'interrupt') {
    const { sessionId } = msg as { sessionId: string };
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session || !session.claudeWs) return;
    const line = JSON.stringify({ type: 'interrupt' }) + '\n';
    (session.claudeWs as any).send(line);
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

  // ---- kill_process --------------------------------------------------------
  if (type === 'kill_process') {
    const { sessionId, processId, pid } = msg as { sessionId: string; processId?: string; pid?: number };
    if (!sessionId) return;
    if (pid) {
      killProcessTree(pid);
    } else if (processId) {
      const tp = trackedProcesses.get(processId);
      if (tp) {
        killProcessTree(tp.pid);
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
    // Notify all subscribed clients
    broadcastToSession(sessionId, {
      type: 'session_state',
      sessionId,
      state: getStateForClient(sessionId),
    });
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

    // Claude CLI WebSocket connection (sdk-url endpoint)
    if (url.pathname.match(/\/v2\/session_ingress\/ws\/.+/)) {
      const sessionId = url.pathname.split('/v2/session_ingress/ws/')[1];
      const session = sessions.get(sessionId!);
      if (!session) {
        return new Response('Session not found', { status: 404 });
      }
      const upgraded = server.upgrade(req, { data: { type: 'claude', sessionId } });
      if (!upgraded) return new Response('WebSocket upgrade failed', { status: 500 });
      return undefined;
    }

    // Terminal viewer WebSocket
    const termWsMatch = url.pathname.match(/^\/terminal\/ws\/([^/]+)$/);
    if (termWsMatch) {
      const procId = termWsMatch[1]!;
      const upgraded = server.upgrade(req, { data: { type: 'terminal', procId } });
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
        const content = execSync(`git show HEAD:$(git ls-files --full-name "${filePath}")`, {
          cwd: dirname(filePath),
          encoding: 'utf-8',
          timeout: 5000,
        });
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
        browserWsCount: s.browserWs.size,
        hasClaudeWs: !!s.claudeWs,
        pendingCount: s.pendingMessages.length,
        pendingPreview: s.pendingMessages.map(m => m.slice(0, 80)),
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

      // Legacy per-session browser WebSocket
      if (type === 'browser') {
        const session = sessions.get(sessionId!);
        if (!session) { ws.close(4001, 'Session not found'); return; }
        session.browserWs.add(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS connected (${session.browserWs.size} total)`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
        }
        for (const msg of session.pendingMessages) {
          ws.send(msg);
        }
        if (session.browserWs.size === 1) {
          session.pendingMessages = [];
        }
        return;
      }

      // Claude CLI WebSocket
      if (type === 'claude') {
        const session = sessions.get(sessionId!);
        if (!session) { ws.close(4001, 'Session not found'); return; }
        session.claudeWs = ws as unknown as WebSocket;
        session.ready = true;
        session.status = 'running';
        // Reset streaming state — if a previous CLI disconnected mid-stream, clear it
        updateSessionState(sessionId!, s => ({ ...s, isStreaming: false, partialText: '' }));
        log(`[${sessionId!.slice(0, 8)}] Claude CLI WS connected! Broadcasting to frontend clients`);
        // Notify legacy browser WS clients
        for (const bws of session.browserWs) {
          try { bws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n'); } catch {}
        }
        // Notify new-style frontend clients
        broadcastToSession(sessionId!, { type: 'status', sessionId: sessionId!, status: 'connected' });
        broadcastSessionList();
        return;
      }
    },

    message(ws, message) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      if (type === 'terminal') return;

      // Multiplexed frontend WebSocket
      if (type === 'frontend') {
        handleFrontendMessage(ws, message as string | ArrayBuffer);
        return;
      }

      // Legacy browser / Claude relay
      const session = sessions.get(sessionId!);
      if (!session) return;

      const data = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);

      if (type === 'browser') {
        if (session.claudeWs) {
          const line = data.endsWith('\n') ? data : data + '\n';
          (session.claudeWs as any).send(line);
        }
        return;
      }

      if (type === 'claude') {
        const autoAccepted = processClaudeMessage(sessionId!, data);

        if (!autoAccepted) {
          // Also relay raw to legacy browser WS clients (for backwards compat)
          if (session.browserWs.size > 0) {
            for (const bws of session.browserWs) {
              try { bws.send(data); } catch {}
            }
          } else {
            session.pendingMessages.push(data);
          }
        }
      }
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

      const session = sessions.get(sessionId!);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        log(`[${sessionId!.slice(0, 8)}] Legacy browser WS disconnected (${session.browserWs.size} remaining)`);
        return;
      }

      if (type === 'claude') {
        log(`[${sessionId!.slice(0, 8)}] Claude CLI disconnected`);
        session.claudeWs = null;
        session.ready = false;
        session.status = 'stopped';
        // Reset streaming state — CLI disconnected mid-stream
        const state = getSessionState(sessionId!);
        if (state.isStreaming || state.partialText) {
          // Commit partial text as a message if any
          if (state.partialText.trim()) {
            const finalMsg: ChatMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: state.partialText,
              timestamp: Date.now(),
            };
            if (addMessage(sessionId!, finalMsg)) {
              broadcastToSession(sessionId!, { type: 'message', sessionId: sessionId!, message: finalMsg });
            }
          }
          updateSessionState(sessionId!, s => ({ ...s, isStreaming: false, partialText: '' }));
        }
        // Legacy relay
        for (const bws of session.browserWs) {
          try { bws.send(JSON.stringify({ type: 'bridge', status: 'claude_disconnected' }) + '\n'); } catch {}
        }
        // New-style frontend clients
        broadcastToSession(sessionId!, { type: 'status', sessionId: sessionId!, status: 'disconnected' });
        broadcastSessionList();
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
