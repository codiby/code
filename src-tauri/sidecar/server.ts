/**
 * Bridge server that:
 * 1. Accepts WebSocket connections from the browser UI
 * 2. Spawns `claude -p --sdk-url ws://...` which connects back to this server
 * 3. Relays messages between browser <-> claude CLI
 * 4. Manages multiple concurrent sessions
 */

import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PORT = parseInt(process.env.PORT || '0', 10);
const LOG_FILE = join(import.meta.dir, 'server.log');

function log(...args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + '\n'); } catch {}
}

function logError(...args: unknown[]) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ERROR: ${args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(' ')}`;
  console.error(msg);
  try { appendFileSync(LOG_FILE, msg + '\n'); } catch {}
}
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CWD = process.env.CLAUDE_CWD || process.cwd();

const SESSIONS_FILE = join(homedir(), '.claude', 'ui-sessions.json');

// Tools auto-approved in acceptEdits mode
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit']);

type Session = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null; // claude's internal session id for --resume
  claudeWs: WebSocket | null;
  browserWs: Set<any>;
  process: ChildProcess | null;
  ready: boolean;
  status: 'starting' | 'running' | 'stopped';
  pendingMessages: string[]; // buffered messages from Claude before browser connects
  savedCommands: string[];
  model: string | null;
  permissionMode: string; // default | acceptEdits | plan | bypassPermissions
};

type PersistedSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null;
  savedCommands?: string[];
  model?: string | null;
  permissionMode?: string;
};

const sessions = new Map<string, Session>();

function saveSessions() {
  const data: PersistedSession[] = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId, savedCommands: s.savedCommands, model: s.model, permissionMode: s.permissionMode,
  }));
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`[persist] Failed to save: ${e}`);
  }
}

function loadSessions() {
  try {
    const data: PersistedSession[] = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    for (const p of data) {
      sessions.set(p.id, {
        ...p,
        savedCommands: p.savedCommands || [],
        model: p.model || null,
        permissionMode: p.permissionMode || 'default',
        claudeWs: null, browserWs: new Set(), process: null,
        ready: false, status: 'stopped', pendingMessages: [],
      });
    }
    log(`[persist] Loaded ${data.length} sessions`);
  } catch {
    // No file or invalid — start fresh
  }
}

loadSessions();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function broadcast(session: Session, data: string) {
  for (const ws of session.browserWs) {
    try { ws.send(data); } catch {}
  }
}

function sessionToJSON(s: Session) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    created_at: s.createdAt,
    status: s.status,
    ready: s.ready,
    claude_session_id: s.claudeSessionId,
    ws_url: `ws://localhost:${server.port}/browser/ws/${s.id}`,
    saved_commands: s.savedCommands || [],
    model: s.model || null,
    permission_mode: s.permissionMode || 'default',
  };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Log requests (skip health checks and file-index to reduce noise)
    if (url.pathname !== '/health' && url.pathname !== '/file-index' && url.pathname !== '/git-modified' && url.pathname !== '/processes') {
      log(`${req.method} ${url.pathname}${url.search}`);
    }

    // List sessions
    if (url.pathname === '/sessions' && req.method === 'GET') {
      const list = [...sessions.values()].map(sessionToJSON);
      return Response.json(list, { headers: corsHeaders });
    }

    // Create session
    if (url.pathname === '/sessions' && req.method === 'POST') {
      return handleCreateSession(req);
    }

    // Resume session
    const resumeMatch = url.pathname.match(/^\/sessions\/(.+)\/resume$/);
    if (resumeMatch && req.method === 'POST') {
      return handleResumeSession(resumeMatch[1]!);
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

    // Execute shell command (streaming)
    if (url.pathname === '/exec' && req.method === 'POST') {
      const body = await req.json() as { command: string; cwd?: string; sessionId?: string };
      if (!body.command) return Response.json({ error: 'command required' }, { status: 400, headers: corsHeaders });
      return handleExec(body.command, body.cwd || '/', body.sessionId || 'unknown');
    }

    // List processes for a session
    if (url.pathname === '/processes' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return Response.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders });
      return handleListProcesses(sessionId);
    }

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

    // Kill a process
    if (url.pathname === '/kill' && req.method === 'POST') {
      const body = await req.json() as { processId?: string; pid?: number };
      if (!body.processId && !body.pid) return Response.json({ error: 'processId or pid required' }, { status: 400, headers: corsHeaders });
      return handleKillProcess(body.processId || '', body.pid);
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

    // Git modified files list
    if (url.pathname === '/git-modified' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleGitModified(root);
    }

    // Check if a path is a git repo
    // Search files (ripgrep / grep)
    if (url.pathname === '/search' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      const query = url.searchParams.get('q') || '';
      if (!root || !query) return Response.json({ results: [] }, { headers: corsHeaders });
      return handleSearch(root, query);
    }

    // GitHub PRs
    if (url.pathname === '/gh-prs' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      const sessionName = url.searchParams.get('session') || '';
      if (!cwd) return Response.json({ error: 'cwd required' }, { status: 400, headers: corsHeaders });
      return handleGhPrs(cwd, sessionName);
    }

    if (url.pathname === '/git-info' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return Response.json({ error: 'path required' }, { status: 400, headers: corsHeaders });
      return handleGitInfo(dirPath);
    }

    // Create a git worktree
    if (url.pathname === '/worktree' && req.method === 'POST') {
      return handleCreateWorktree(req);
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', sessions: sessions.size }, { headers: corsHeaders });
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
  websocket: {
    open(ws) {
      const { type, sessionId } = ws.data as { type: string; sessionId: string };
      const session = sessions.get(sessionId);
      if (!session) {
        ws.close(4001, 'Session not found');
        return;
      }

      if (type === 'browser') {
        session.browserWs.add(ws);
        log(`[${sessionId.slice(0, 8)}] Browser WS connected (${session.browserWs.size} total), session.status=${session.status}, session.ready=${session.ready}, pending=${session.pendingMessages.length}, hasProcess=${!!session.process}`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
          log(`[${sessionId.slice(0, 8)}] Sent claude_connected to browser (already ready)`);
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
        log(`[${sessionId.slice(0, 8)}] Claude CLI WS connected! Broadcasting claude_connected to ${session.browserWs.size} browser(s)`);
        broadcast(session, JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
      }
    },

    message(ws, message) {
      const { type, sessionId } = ws.data as { type: string; sessionId: string };
      const session = sessions.get(sessionId);
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
      const { type, sessionId } = ws.data as { type: string; sessionId: string };
      const session = sessions.get(sessionId);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        log(`[${sessionId.slice(0, 8)}] Browser disconnected (${session.browserWs.size} remaining)`);
      } else if (type === 'claude') {
        log(`[${sessionId.slice(0, 8)}] Claude CLI disconnected`);
        session.claudeWs = null;
        session.ready = false;
        session.status = 'stopped';
        broadcast(session, JSON.stringify({ type: 'bridge', status: 'claude_disconnected' }) + '\n');
      }
    },
  },
});

function spawnClaude(session: Session, resumeSessionId?: string) {
  const sdkUrl = `ws://localhost:${server.port}/v2/session_ingress/ws/${session.id}`;
  const args = [
    '-p', '--sdk-url', sdkUrl,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId, '--replay-user-messages');
  }

  if (session.model) {
    args.push('--model', session.model);
  }

  const sid = session.id.slice(0, 8);
  const spawnStart = Date.now();
  log(`[${sid}] Spawning: ${CLAUDE_BIN} ${args.join(' ')}`);
  log(`[${sid}] CWD: ${session.cwd}`);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb' },
  });

  session.process = proc;
  session.status = 'starting';
  session.ready = false;

  log(`[${sid}] Process spawned, PID=${proc.pid}, waiting for Claude CLI to connect via WS...`);

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) log(`[${sid}] stdout (${Date.now() - spawnStart}ms): ${text.slice(0, 200)}`);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log(`[${sid}] stderr (${Date.now() - spawnStart}ms): ${msg.slice(0, 200)}`);
  });

  proc.on('exit', (code) => {
    log(`[${sid}] Claude exited with code ${code} after ${Date.now() - spawnStart}ms`);
    const s = sessions.get(session.id);
    if (s) {
      s.status = 'stopped';
      s.ready = false;
      s.process = null;
      saveSessions();
      broadcast(s, JSON.stringify({ type: 'bridge', status: 'claude_exited', code }) + '\n');
    }
  });

  proc.on('error', (err) => {
    logError(`[${sid}] Failed to spawn Claude: ${err.message}`);
  });
}

async function handleCreateSession(req: Request): Promise<Response> {
  let cwd = CWD;
  let name = '';
  let model: string | null = null;
  let permissionMode = 'default';
  try {
    const body = await req.json() as Record<string, unknown>;
    if (body.cwd && typeof body.cwd === 'string') cwd = body.cwd;
    if (body.name && typeof body.name === 'string') name = body.name;
    if (body.model && typeof body.model === 'string') model = body.model;
    if (body.permissionMode && typeof body.permissionMode === 'string') permissionMode = body.permissionMode;
  } catch {}

  const session: Session = {
    id: randomUUID(),
    name: name || `Session ${sessions.size + 1}`,
    cwd,
    createdAt: Date.now(),
    claudeSessionId: null,
    claudeWs: null,
    browserWs: new Set(),
    process: null,
    ready: false,
    status: 'starting',
    pendingMessages: [],
    savedCommands: [],
    model,
    permissionMode,
  };
  sessions.set(session.id, session);

  log(`[${session.id.slice(0,8)}] Creating new session, cwd=${cwd}`);
  spawnClaude(session);
  saveSessions();

  return Response.json(sessionToJSON(session), { headers: corsHeaders });
}

function handleResumeSession(sessionId: string): Response {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }
  if (session.process) {
    return Response.json({ error: 'Session already running' }, { status: 409, headers: corsHeaders });
  }
  if (!session.claudeSessionId) {
    log(`[${sessionId.slice(0,8)}] Resuming session (no claude_session_id, starting fresh)`);
    spawnClaude(session);
  } else {
    log(`[${sessionId.slice(0,8)}] Resuming session with claude_session_id=${session.claudeSessionId}`);
    spawnClaude(session, session.claudeSessionId);
  }
  saveSessions();
  return Response.json(sessionToJSON(session), { headers: corsHeaders });
}

async function handleRenameSession(sessionId: string, req: Request): Promise<Response> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    if (body.name && typeof body.name === 'string') {
      session.name = body.name;
    }
    if (typeof body.permissionMode === 'string') {
      session.permissionMode = body.permissionMode;
    }
    saveSessions();
  } catch {}
  return Response.json(sessionToJSON(session), { headers: corsHeaders });
}

function handleDeleteSession(sessionId: string): Response {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }

  if (session.process) {
    session.process.kill('SIGTERM');
  }
  for (const ws of session.browserWs) {
    try { ws.close(); } catch {}
  }
  if (session.claudeWs) {
    (session.claudeWs as any).close();
  }
  sessions.delete(sessionId);
  saveSessions();
  log(`[${sessionId.slice(0, 8)}] Session deleted`);

  return Response.json({ ok: true }, { headers: corsHeaders });
}

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, resolve } from 'path';

function handleListDirs(prefix: string): Response {
  try {
    // If prefix ends with /, list contents of that dir. Otherwise list parent filtered by partial name.
    let dir: string;
    let filter: string;
    if (prefix.endsWith('/')) {
      dir = prefix;
      filter = '';
    } else {
      dir = dirname(prefix);
      filter = basename(prefix).toLowerCase();
    }

    if (!existsSync(dir)) {
      return Response.json([], { headers: corsHeaders });
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith('.')) return false;
        if (filter && !e.name.toLowerCase().startsWith(filter)) return false;
        return true;
      })
      .map(e => resolve(dir, e.name) + '/')
      .sort();

    return Response.json(dirs, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

function handleListFiles(dirPath: string): Response {
  try {
    if (!existsSync(dirPath)) {
      return Response.json([], { headers: corsHeaders });
    }
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' as const : 'file' as const,
        path: resolve(dirPath, e.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return Response.json(items, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '__pycache__', '.venv', 'vendor', 'coverage', '.cache', '.turbo', 'target', '__snapshots__']);

const fileIndexCache = new Map<string, { files: { name: string; path: string; rel: string }[]; ts: number }>();
const FILE_INDEX_TTL = 30_000; // 30s cache

function buildFileIndex(root: string): { name: string; path: string; rel: string }[] {
  const files: { name: string; path: string; rel: string }[] = [];
  const maxDepth = 10;
  const maxFiles = 10_000;

  function walk(dir: string, rel: string, depth: number) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (files.length >= maxFiles) break;
      const fullPath = resolve(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(fullPath, relPath, depth + 1);
      } else {
        files.push({ name: e.name, path: fullPath, rel: relPath });
      }
    }
  }

  walk(root, '', 0);
  return files;
}

function handleFileIndex(root: string): Response {
  try {
    const cached = fileIndexCache.get(root);
    if (cached && Date.now() - cached.ts < FILE_INDEX_TTL) {
      return Response.json(cached.files, { headers: corsHeaders });
    }
    const files = buildFileIndex(root);
    fileIndexCache.set(root, { files, ts: Date.now() });
    return Response.json(files, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

function detectPackageManager(dir: string): string | null {
  if (existsSync(`${dir}/bun.lockb`) || existsSync(`${dir}/bun.lock`)) return 'bun';
  if (existsSync(`${dir}/yarn.lock`)) return 'yarn';
  if (existsSync(`${dir}/pnpm-lock.yaml`)) return 'pnpm';
  if (existsSync(`${dir}/package-lock.json`)) return 'npm';
  if (existsSync(`${dir}/package.json`)) return 'npm';
  return null;
}

// Process tracking
interface TrackedProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  startedAt: number;
  proc: ChildProcess;
}

const trackedProcesses = new Map<string, TrackedProcess>();

function getProcessTree(pid: number): { pid: number; command: string; children: { pid: number; command: string }[] } | null {
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

function handleListProcesses(sessionId: string): Response {
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

function killProcessTree(pid: number) {
  try { execSync(`kill -9 -- -${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, { timeout: 3000 }); } catch {}
  // Also try pkill for any remaining children
  try { execSync(`pkill -9 -P ${pid} 2>/dev/null`, { timeout: 3000 }); } catch {}
}

function handleKillProcess(processId: string, pid?: number): Response {
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

function handleExec(command: string, cwd: string, sessionId: string): Response {
  const encoder = new TextEncoder();
  const procId = randomUUID();
  const stream = new ReadableStream({
    start(controller) {
      const shell = process.env.SHELL || '/bin/sh';
      const init = 'source ~/.zprofile 2>/dev/null; source ~/.zshrc 2>/dev/null; ';
      const proc = spawn(shell, ['-c', init + command], { cwd, env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' }, stdio: ['ignore', 'pipe', 'pipe'] });

      const startTime = Date.now();
      let hasOutput = false;
      trackedProcesses.set(procId, { id: procId, pid: proc.pid!, command, cwd, sessionId, startedAt: startTime, proc });

      // Send process ID as first event
      try { controller.enqueue(encoder.encode(`event: pid\ndata: ${JSON.stringify({ procId, pid: proc.pid })}\n\n`)); } catch {}

      const send = (data: string) => {
        hasOutput = true;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      // Keepalive ping every 15s to prevent connection timeout
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); } catch { clearInterval(keepalive); }
      }, 15000);

      proc.stdout.on('data', (chunk: Buffer) => send(chunk.toString()));
      proc.stderr.on('data', (chunk: Buffer) => send(chunk.toString()));

      proc.on('close', (code) => {
        // Check if child processes are still running before closing the stream
        if (code === 0 && hasOutput) {
          try {
            const children = execSync(`pgrep -P ${proc.pid} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 2000 }).trim();
            if (children) {
              const childPid = parseInt(children.split('\n')[0]!, 10);
              log(`[exec] Parent ${proc.pid} exited but child ${childPid} still running, monitoring`);
              const poll = setInterval(() => {
                try {
                  process.kill(childPid, 0);
                } catch {
                  clearInterval(poll);
                  clearInterval(keepalive);
                  trackedProcesses.delete(procId);
                  try {
                    controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ exitCode: 0 })}\n\n`));
                    controller.close();
                  } catch {}
                }
              }, 2000);
              return;
            }
          } catch {}
        }
        clearInterval(keepalive);
        trackedProcesses.delete(procId);
        try {
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ exitCode: code ?? 0 })}\n\n`));
          controller.close();
        } catch {}
      });

      proc.on('error', (err) => {
        clearInterval(keepalive);
        trackedProcesses.delete(procId);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(`Error: ${err.message}`)}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ exitCode: 1 })}\n\n`));
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function handleSearch(root: string, query: string): Response {
  try {
    // Try ripgrep first, fall back to grep
    let cmd: string;
    try {
      execSync('which rg', { encoding: 'utf-8', timeout: 2000 });
      cmd = `rg --json --max-count 5 --max-filesize 1M -e ${JSON.stringify(query)} .`;
    } catch {
      cmd = `grep -rn --include='*' -m 5 ${JSON.stringify(query)} .`;
    }
    const output = execSync(cmd, { cwd: root, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 });

    // Parse ripgrep JSON output
    if (cmd.startsWith('rg')) {
      const results: { file: string; line: number; text: string }[] = [];
      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'match') {
            results.push({
              file: msg.data.path.text,
              line: msg.data.line_number,
              text: msg.data.lines.text.trim().slice(0, 200),
            });
          }
        } catch {}
      }
      return Response.json({ results: results.slice(0, 100) }, { headers: corsHeaders });
    }

    // Parse grep output: file:line:text
    const results = output.split('\n').filter(Boolean).slice(0, 100).map(line => {
      const [file, lineNum, ...rest] = line.split(':');
      return { file: file || '', line: parseInt(lineNum || '0', 10), text: rest.join(':').trim().slice(0, 200) };
    });
    return Response.json({ results }, { headers: corsHeaders });
  } catch {
    return Response.json({ results: [] }, { headers: corsHeaders });
  }
}

function handleGhPrs(cwd: string, sessionName: string): Response {
  try {
    const output = execSync(
      'gh pr list --state all --json number,title,headRefName,state,url,isDraft --limit 20',
      { cwd, encoding: 'utf-8', timeout: 10000 },
    );
    let prs = JSON.parse(output) as { number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[];

    // Match PRs to session name if provided
    if (sessionName) {
      const words = sessionName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const matched = prs.filter(pr => {
          const text = `${pr.title} ${pr.headRefName}`.toLowerCase();
          return words.some(w => text.includes(w));
        });
        if (matched.length > 0) prs = matched;
      }
    }

    return Response.json(prs, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

function handleGitModified(root: string): Response {
  try {
    const gitTop = execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
    const unstaged = execSync('git diff --name-only', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);
    const staged = execSync('git diff --name-only --cached', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: root, encoding: 'utf-8', timeout: 5000 }).split('\n').filter(Boolean);

    const result: { path: string; staged: boolean }[] = [];
    const stagedSet = new Set<string>();

    for (const f of staged) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root)) continue;
      stagedSet.add(p);
      result.push({ path: p, staged: true });
    }
    // Files with unstaged changes (including those also staged — shown in both sections)
    const unstagedSeen = new Set<string>();
    for (const f of [...unstaged, ...untracked]) {
      const p = resolve(gitTop, f);
      if (!p.startsWith(root) || unstagedSeen.has(p)) continue;
      unstagedSeen.add(p);
      result.push({ path: p, staged: false });
    }

    return Response.json(result, { headers: corsHeaders });
  } catch {
    return Response.json([], { headers: corsHeaders });
  }
}

function handleGitInfo(dirPath: string): Response {
  if (!existsSync(dirPath)) {
    return Response.json({ is_git: false, error: 'Path does not exist' }, { headers: corsHeaders });
  }

  const packageManager = detectPackageManager(dirPath);
  const hasEnv = existsSync(`${dirPath}/.env`);

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dirPath, stdio: 'pipe' });
    const branch = execSync('git branch --show-current', { cwd: dirPath, stdio: 'pipe' }).toString().trim();
    const topLevel = execSync('git rev-parse --show-toplevel', { cwd: dirPath, stdio: 'pipe' }).toString().trim();
    let worktrees: { path: string; branch: string }[] = [];
    try {
      const wtOut = execSync('git worktree list --porcelain', { cwd: dirPath, stdio: 'pipe' }).toString();
      const blocks = wtOut.split('\n\n').filter(Boolean);
      worktrees = blocks.map(block => {
        const lines = block.split('\n');
        const wtPath = lines.find(l => l.startsWith('worktree '))?.slice(9) || '';
        const wtBranch = lines.find(l => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') || '';
        return { path: wtPath, branch: wtBranch };
      }).filter(w => w.path);
    } catch {}

    // Detect PM from top-level if dirPath didn't have it
    const pm = packageManager || detectPackageManager(topLevel);
    const envExists = hasEnv || existsSync(`${topLevel}/.env`);

    return Response.json({
      is_git: true, branch, top_level: topLevel, worktrees,
      package_manager: pm, has_env: envExists,
    }, { headers: corsHeaders });
  } catch {
    return Response.json({ is_git: false, package_manager: packageManager, has_env: hasEnv }, { headers: corsHeaders });
  }
}

/**
 * Worktree creation with SSE streaming of setup logs.
 * Returns text/event-stream with log lines, and a final `done` or `error` event.
 */
async function handleCreateWorktree(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const repoPath = body.repo_path as string;
  const branchName = body.branch as string;
  const doCopyEnv = body.copy_env === true;
  const doInstallDeps = body.install_deps === true;
  const doCopyNodeModules = body.copy_node_modules === true;
  const doLinkNodeModules = body.link_node_modules === true;
  const pm = (body.package_manager as string) || 'npm';

  if (!repoPath || !branchName) {
    return Response.json({ error: 'repo_path and branch required' }, { status: 400, headers: corsHeaders });
  }

  const safeBranch = branchName.replace(/[^a-zA-Z0-9_\-/.]/g, '-');
  const wtPath = `${repoPath}/../${basename(repoPath)}-wt-${safeBranch}`;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        try { controller.enqueue(`event: ${event}\ndata: ${data}\n\n`); } catch {}
      };
      const log = (msg: string) => send('log', msg);
      const finish = () => { if (!closed) { closed = true; controller.close(); } };

      try {
        // 1. Create worktree
        log(`$ git worktree add "${wtPath}" -b "${safeBranch}"`);
        try {
          const out = execSync(`git worktree add "${wtPath}" -b "${safeBranch}" 2>&1`, { cwd: repoPath }).toString();
          if (out.trim()) log(out.trim());
        } catch {
          log(`Branch exists, using existing: ${safeBranch}`);
          const out = execSync(`git worktree add "${wtPath}" "${safeBranch}" 2>&1`, { cwd: repoPath }).toString();
          if (out.trim()) log(out.trim());
        }
        const resolvedPath = execSync(`cd "${wtPath}" && pwd`, { stdio: 'pipe' }).toString().trim();
        log(`Worktree created at ${resolvedPath}`);

        // 2. Copy .env
        if (doCopyEnv) {
          const envSrc = `${repoPath}/.env`;
          const envDst = `${resolvedPath}/.env`;
          if (existsSync(envSrc) && !existsSync(envDst)) {
            const { copyFileSync } = await import('fs');
            copyFileSync(envSrc, envDst);
            log('Copied .env');
          } else if (!existsSync(envSrc)) {
            log('.env not found in source, skipping');
          }
        }

        // 3. Install dependencies (streamed)
        if (doInstallDeps) {
          if (!existsSync(`${resolvedPath}/package.json`)) {
            log('No package.json found, skipping install');
          } else {
          const installCmd: Record<string, string> = {
            bun: 'bun install', yarn: 'yarn install',
            pnpm: 'pnpm install', npm: 'npm install',
          };
          const cmd = installCmd[pm] || 'npm install';
          log(`$ ${cmd}`);

          await new Promise<void>((resolve) => {
            const parts = cmd.split(' ');
            const proc = spawn(parts[0]!, parts.slice(1), {
              cwd: resolvedPath,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
            });

            proc.stdout?.on('data', (d: Buffer) => {
              for (const line of d.toString().split('\n').filter(Boolean)) log(line);
            });
            proc.stderr?.on('data', (d: Buffer) => {
              for (const line of d.toString().split('\n').filter(Boolean)) log(line);
            });
            proc.on('close', (code) => {
              log(code === 0 ? 'Dependencies installed' : `Install exited with code ${code}`);
              resolve();
            });
            proc.on('error', (err) => {
              log(`Error: ${err.message}`);
              resolve();
            });
          });
          } // end else (has package.json)
        }

        // 4. Copy node_modules from source repo
        if (doCopyNodeModules) {
          const nmSrc = `${repoPath}/node_modules`;
          const nmDst = `${resolvedPath}/node_modules`;
          if (!existsSync(nmSrc)) {
            log('node_modules not found in source, skipping copy');
          } else if (existsSync(nmDst)) {
            log('node_modules already exists in worktree, skipping copy');
          } else {
            log(`$ tar c node_modules | tar x -C ${resolvedPath}`);
            await new Promise<void>((resolve) => {
              const proc = spawn('sh', ['-c', `cd "${repoPath}" && tar cf - node_modules | tar xf - -C "${resolvedPath}"`], { stdio: ['ignore', 'pipe', 'pipe'] });
              proc.stdout?.on('data', (d: Buffer) => {
                for (const line of d.toString().split('\n').filter(Boolean)) log(line);
              });
              proc.stderr?.on('data', (d: Buffer) => {
                for (const line of d.toString().split('\n').filter(Boolean)) log(line);
              });
              proc.on('close', (code) => {
                log(code === 0 ? 'node_modules linked' : `cp exited with code ${code}`);
                resolve();
              });
              proc.on('error', (err) => {
                log(`Error: ${err.message}`);
                resolve();
              });
            });
          }
        }

        // 5. Symlink node_modules from source repo
        if (doLinkNodeModules) {
          const nmSrc = `${repoPath}/node_modules`;
          const nmDst = `${resolvedPath}/node_modules`;
          if (!existsSync(nmSrc)) {
            log('node_modules not found in source, skipping link');
          } else if (existsSync(nmDst)) {
            log('node_modules already exists in worktree, skipping link');
          } else {
            log(`$ ln -s ${nmSrc} → ${nmDst}`);
            const { symlinkSync } = await import('fs');
            symlinkSync(nmSrc, nmDst);
            log('node_modules symlinked');
          }
        }

        send('done', JSON.stringify({ path: resolvedPath, branch: safeBranch }));
      } catch (e) {
        send('error', String(e));
      }

      finish();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Kill all spawned Claude processes on server shutdown
function killAllClaudeProcesses() {
  let killed = 0;
  for (const session of sessions.values()) {
    if (session.process && !session.process.killed) {
      session.process.kill('SIGTERM');
      killed++;
    }
  }
  if (killed > 0) log(`[shutdown] Killed ${killed} Claude processes`);
}

process.on('SIGINT', () => { killAllClaudeProcesses(); process.exit(0); });
process.on('SIGTERM', () => { killAllClaudeProcesses(); process.exit(0); });
process.on('exit', () => { killAllClaudeProcesses(); });
// bun --watch sends SIGUSR2 before restart
process.on('SIGUSR2', () => { killAllClaudeProcesses(); });

log(`Bridge server listening on http://localhost:${server.port}`);
log(`Claude binary: ${CLAUDE_BIN}`);
log(`Working directory: ${CWD}`);
console.log(`BRIDGE_SERVER_PORT:${server.port}`);
