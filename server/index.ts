/**
 * Bridge server entry point.
 *
 * Imports split modules and wires up HTTP routes + WebSocket handlers
 * into a single Bun.serve() instance.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname } from 'path';

import { PORT, CLAUDE_BIN, corsHeaders, ACCEPT_EDITS_TOOLS, CWD } from './config';
import { log } from './logger';
import { sessions, loadSessions, saveSessions, broadcast, sessionToJSON } from './sessions';
import { handleCreateSession, handleResumeSession, handleRenameSession, handleDeleteSession } from './handlers/sessions';
import { handleListDirs, handleListFiles, handleFileIndex } from './handlers/files';
import { handleExecCreate, terminalWsOpen, terminalWsClose } from './handlers/exec';
import { handleListProcesses, handleKillProcess } from './handlers/processes';
import { handleGitModified, handleGitInfo, handleGhPrs, handleGitBranches, handleGitCheckout } from './handlers/git';
import { handleSearch } from './handlers/search';
import { handleCreateWorktree } from './handlers/worktree';
import { registerShutdownHandlers } from './shutdown';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

loadSessions();
registerShutdownHandlers();

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
    if (url.pathname !== '/health' && url.pathname !== '/file-index' && url.pathname !== '/git-modified' && url.pathname !== '/processes') {
      log(`${req.method} ${url.pathname}${url.search}`);
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    // List sessions
    if (url.pathname === '/sessions' && req.method === 'GET') {
      const list = [...sessions.values()].map(s => sessionToJSON(s, server.port));
      return Response.json(list, { headers: corsHeaders });
    }

    // Create session
    if (url.pathname === '/sessions' && req.method === 'POST') {
      return handleCreateSession(req, server.port);
    }

    // Resume session
    const resumeMatch = url.pathname.match(/^\/sessions\/(.+)\/resume$/);
    if (resumeMatch && req.method === 'POST') {
      return handleResumeSession(resumeMatch[1]!, server.port);
    }

    // Rename session
    const patchMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (patchMatch && req.method === 'PATCH') {
      return handleRenameSession(patchMatch[1]!, req);
    }

    // Delete session
    const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      return handleDeleteSession(deleteMatch[1]!);
    }

    // -----------------------------------------------------------------------
    // WebSocket upgrades
    // -----------------------------------------------------------------------

    // Browser WebSocket connection
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
    // Files
    // -----------------------------------------------------------------------

    // List directories for autocomplete
    if (url.pathname === '/ls' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '/';
      return handleListDirs(prefix);
    }

    // List files and directories for file explorer
    if (url.pathname === '/files' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path') || '/';
      return handleListFiles(dirPath);
    }

    // File index (cached, for fuzzy search)
    if (url.pathname === '/file-index' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleFileIndex(root);
    }

    // Read file content for editor
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

    // Write file content
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

    // Execute shell command
    if (url.pathname === '/exec' && req.method === 'POST') {
      return handleExecCreate(req);
    }

    // List processes for a session
    if (url.pathname === '/processes' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
      return handleListProcesses(sessionId);
    }

    // Kill a process
    if (url.pathname === '/kill' && req.method === 'POST') {
      const body = await req.json() as { processId?: string; pid?: number };
      if (!body.processId && !body.pid) return Response.json({ error: 'processId or pid required' }, { status: 400, headers: corsHeaders });
      return handleKillProcess(body.processId || '', body.pid);
    }

    // -----------------------------------------------------------------------
    // Git
    // -----------------------------------------------------------------------

    // Get original file content (git HEAD version) for diff
    if (url.pathname === '/file-original' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      try {
        const content = execSync(`git show HEAD:$(git ls-files --full-name "${filePath}")`, { cwd: dirname(filePath), encoding: 'utf-8', timeout: 5000 });
        return Response.json({ path: filePath, content }, { headers: corsHeaders });
      } catch {
        return Response.json({ path: filePath, content: '' }, { headers: corsHeaders });
      }
    }

    // Git modified files list
    if (url.pathname === '/git-modified' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleGitModified(root);
    }

    // Git stage/unstage files
    if (url.pathname === '/git-stage' && req.method === 'POST') {
      const body = await req.json() as { root: string; files: string[]; unstage?: boolean };
      if (!body.root || !body.files?.length) return Response.json({ error: 'root and files required' }, { status: 400, headers: corsHeaders });
      try {
        const gitTop = execSync('git rev-parse --show-toplevel', { cwd: body.root, encoding: 'utf-8', timeout: 5000 }).trim();
        const cmd = body.unstage ? 'git reset HEAD --' : 'git add --';
        execSync(`${cmd} ${body.files.map(f => `'${f.replace(/'/g, "'\\''")}'`).join(' ')}`, { cwd: gitTop, encoding: 'utf-8', timeout: 5000 });
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    // Git info
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

    // GitHub PRs
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
    // Misc inline endpoints
    // -----------------------------------------------------------------------

    // Save commands for a session
    if (url.pathname === '/save-commands' && req.method === 'POST') {
      const body = await req.json() as { sessionId: string; commands: string[] };
      if (!body.sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
      const session = sessions.get(body.sessionId);
      if (!session) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
      session.savedCommands = body.commands || [];
      saveSessions();
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', sessions: sessions.size }, { headers: corsHeaders });
    }

    // UI logging endpoint
    if (url.pathname === '/ui-log' && req.method === 'POST') {
      try {
        const body = await req.json() as { msg: string };
        log(`[UI] ${body.msg}`);
      } catch {}
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // Debug: check session state
    const debugMatch = url.pathname.match(/^\/debug\/(.+)$/);
    if (debugMatch && req.method === 'GET') {
      const s = sessions.get(debugMatch[1]!);
      if (!s) return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
      return Response.json({
        id: s.id, status: s.status, ready: s.ready,
        browserWsCount: s.browserWs.size, hasClaudeWs: !!s.claudeWs,
        pendingCount: s.pendingMessages.length,
        pendingPreview: s.pendingMessages.map(m => m.slice(0, 80)),
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

      // Browser / Claude — require a valid session
      const session = sessions.get(sessionId!);
      if (!session) {
        ws.close(4001, 'Session not found');
        return;
      }

      if (type === 'browser') {
        session.browserWs.add(ws);
        log(`[${sessionId!.slice(0, 8)}] Browser WS connected (${session.browserWs.size} total), session.status=${session.status}, session.ready=${session.ready}, pending=${session.pendingMessages.length}, hasProcess=${!!session.process}`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
          log(`[${sessionId!.slice(0, 8)}] Sent claude_connected to browser (already ready)`);
        }
        // Replay buffered messages to this new browser
        for (const msg of session.pendingMessages) {
          ws.send(msg);
        }
        // Clear buffer only when first browser connects
        if (session.browserWs.size === 1) {
          session.pendingMessages = [];
        }
      } else if (type === 'claude') {
        session.claudeWs = ws as unknown as WebSocket;
        session.ready = true;
        session.status = 'running';
        log(`[${sessionId!.slice(0, 8)}] Claude CLI WS connected! Broadcasting claude_connected to ${session.browserWs.size} browser(s)`);
        broadcast(session, JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
      }
    },

    message(ws, message) {
      const { type, sessionId } = ws.data as { type: string; sessionId?: string };

      // Terminal viewers don't send meaningful messages — ignore
      if (type === 'terminal') return;

      const session = sessions.get(sessionId!);
      if (!session) return;

      const data = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer);

      if (type === 'browser') {
        if (session.claudeWs) {
          const line = data.endsWith('\n') ? data : data + '\n';
          (session.claudeWs as any).send(line);
        }
      } else if (type === 'claude') {
        // Check for auto-accept before relaying
        let autoAccepted = false;
        try {
          const msg = JSON.parse(data);

          // Auto-accept permission requests based on session permission mode
          if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
            const toolName = msg.request.tool_name as string;
            const mode = session.permissionMode || 'default';
            const shouldAutoAccept = mode === 'bypassPermissions'
              || (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(toolName));

            if (shouldAutoAccept) {
              autoAccepted = true;
              const requestId = msg.request_id as string;
              const input = msg.request.input as Record<string, unknown> || {};
              // Send allow response directly to Claude CLI
              const response = JSON.stringify({
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
              // Notify browser
              const notification = JSON.stringify({
                type: 'bridge',
                status: 'auto_approved',
                tool_name: toolName,
                request_id: requestId,
                file_path: input.file_path || input.path || null,
                command: input.command || null,
              }) + '\n';
              broadcast(session, notification);
              log(`[${session.id.slice(0, 8)}] Auto-approved ${toolName} (mode=${mode})`);
            }
          }

          // Capture claude session id and auto-name
          if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
            session.claudeSessionId = msg.session_id;
            saveSessions();
          }
          if (msg.type === 'assistant' && session.name.startsWith('Session ')) {
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === 'text');
              if (textBlock?.text) {
                session.name = textBlock.text.slice(0, 40).replace(/\n/g, ' ');
                saveSessions();
              }
            }
          }
        } catch {}

        // Only relay to browser if not auto-accepted
        if (!autoAccepted) {
          if (session.browserWs.size > 0) {
            broadcast(session, data);
          } else {
            session.pendingMessages.push(data);
          }
        }
      }
    },

    close(ws) {
      const { type, sessionId, procId } = ws.data as { type: string; sessionId?: string; procId?: string };

      // Terminal viewer
      if (type === 'terminal') {
        if (procId) terminalWsClose(ws, procId);
        return;
      }

      const session = sessions.get(sessionId!);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        log(`[${sessionId!.slice(0, 8)}] Browser disconnected (${session.browserWs.size} remaining)`);
      } else if (type === 'claude') {
        log(`[${sessionId!.slice(0, 8)}] Claude CLI disconnected`);
        session.claudeWs = null;
        session.ready = false;
        session.status = 'stopped';
        broadcast(session, JSON.stringify({ type: 'bridge', status: 'claude_disconnected' }) + '\n');
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

log(`Bridge server listening on http://localhost:${server.port}`);
log(`Claude binary: ${CLAUDE_BIN}`);
log(`Working directory: ${CWD}`);
console.log(`BRIDGE_SERVER_PORT:${server.port}`);
