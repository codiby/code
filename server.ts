/**
 * Bridge server that:
 * 1. Accepts WebSocket connections from the browser UI
 * 2. Spawns `claude -p --sdk-url ws://...` which connects back to this server
 * 3. Relays messages between browser <-> claude CLI
 * 4. Manages multiple concurrent sessions
 */

import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PORT = parseInt(process.env.PORT || '3100', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CWD = process.env.CLAUDE_CWD || process.cwd();

const SESSIONS_FILE = join(homedir(), '.claude', 'ui-sessions.json');

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
};

type PersistedSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string | null;
};

const sessions = new Map<string, Session>();

function saveSessions() {
  const data: PersistedSession[] = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, claudeSessionId: s.claudeSessionId,
  }));
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`[persist] Failed to save: ${e}`);
  }
}

function loadSessions() {
  try {
    const data: PersistedSession[] = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    for (const p of data) {
      sessions.set(p.id, {
        ...p,
        claudeWs: null, browserWs: new Set(), process: null,
        ready: false, status: 'stopped', pendingMessages: [],
      });
    }
    console.log(`[persist] Loaded ${data.length} sessions`);
  } catch {
    // No file or invalid — start fresh
  }
}

loadSessions();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
    ws_url: `ws://localhost:${PORT}/browser/ws/${s.id}`,
  };
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
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

    // Search files by name (recursive, for @ mentions)
    if (url.pathname === '/find-files' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      const query = url.searchParams.get('q') || '';
      if (!root) return Response.json({ error: 'root required' }, { status: 400, headers: corsHeaders });
      return handleFindFiles(root, query);
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

    // Check if a path is a git repo
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
        console.log(`[${sessionId.slice(0, 8)}] Browser connected (${session.browserWs.size} total), replaying ${session.pendingMessages.length} buffered messages`);
        if (session.ready) {
          ws.send(JSON.stringify({ type: 'bridge', status: 'claude_connected' }) + '\n');
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
        console.log(`[${sessionId.slice(0, 8)}] Claude CLI connected`);
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
        if (session.browserWs.size > 0) {
          broadcast(session, data);
        } else {
          // Buffer messages until browser connects
          session.pendingMessages.push(data);
        }

        // Capture claude session id and auto-name
        try {
          const msg = JSON.parse(data);
          // Capture claude's internal session_id from init
          if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
            session.claudeSessionId = msg.session_id;
            saveSessions();
          }
          // Auto-name from first assistant text
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
      }
    },

    close(ws) {
      const { type, sessionId } = ws.data as { type: string; sessionId: string };
      const session = sessions.get(sessionId);
      if (!session) return;

      if (type === 'browser') {
        session.browserWs.delete(ws);
        console.log(`[${sessionId.slice(0, 8)}] Browser disconnected (${session.browserWs.size} remaining)`);
      } else if (type === 'claude') {
        console.log(`[${sessionId.slice(0, 8)}] Claude CLI disconnected`);
        session.claudeWs = null;
        session.ready = false;
        session.status = 'stopped';
        broadcast(session, JSON.stringify({ type: 'bridge', status: 'claude_disconnected' }) + '\n');
      }
    },
  },
});

function spawnClaude(session: Session, resumeSessionId?: string) {
  const sdkUrl = `ws://localhost:${PORT}/v2/session_ingress/ws/${session.id}`;
  const args = [
    '-p', '--sdk-url', sdkUrl,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId, '--replay-user-messages');
  }

  const sid = session.id.slice(0, 8);
  console.log(`[${sid}] Spawning: ${CLAUDE_BIN} ${args.join(' ')}`);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb' },
  });

  session.process = proc;
  session.status = 'starting';
  session.ready = false;

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.log(`[${sid}] stdout: ${text}`);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[${sid}] stderr: ${msg}`);
  });

  proc.on('exit', (code) => {
    console.log(`[${sid}] Claude exited with code ${code}`);
    const s = sessions.get(session.id);
    if (s) {
      s.status = 'stopped';
      s.ready = false;
      s.process = null;
      saveSessions();
      broadcast(s, JSON.stringify({ type: 'bridge', status: 'claude_exited', code }) + '\n');
    }
  });
}

async function handleCreateSession(req: Request): Promise<Response> {
  let cwd = CWD;
  let name = '';
  try {
    const body = await req.json() as Record<string, unknown>;
    if (body.cwd && typeof body.cwd === 'string') cwd = body.cwd;
    if (body.name && typeof body.name === 'string') name = body.name;
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
  };
  sessions.set(session.id, session);

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
    // No claude session to resume — start fresh
    spawnClaude(session);
  } else {
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
      saveSessions();
    }
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
  console.log(`[${sessionId.slice(0, 8)}] Session deleted`);

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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.astro', '__pycache__', '.venv', 'vendor', 'coverage']);

function handleFindFiles(root: string, query: string): Response {
  try {
    const results: { name: string; path: string; rel: string }[] = [];
    const q = query.toLowerCase();
    const maxResults = 30;
    const maxDepth = 6;

    function walk(dir: string, rel: string, depth: number) {
      if (depth > maxDepth || results.length >= maxResults) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (results.length >= maxResults) break;
        const fullPath = resolve(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(fullPath, relPath, depth + 1);
        } else if (!q || e.name.toLowerCase().includes(q) || relPath.toLowerCase().includes(q)) {
          results.push({ name: e.name, path: fullPath, rel: relPath });
        }
      }
    }

    walk(root, '', 0);
    return Response.json(results, { headers: corsHeaders });
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
  if (killed > 0) console.log(`[shutdown] Killed ${killed} Claude processes`);
}

process.on('SIGINT', () => { killAllClaudeProcesses(); process.exit(0); });
process.on('SIGTERM', () => { killAllClaudeProcesses(); process.exit(0); });
process.on('exit', () => { killAllClaudeProcesses(); });
// bun --watch sends SIGUSR2 before restart
process.on('SIGUSR2', () => { killAllClaudeProcesses(); });

console.log(`Bridge server listening on http://localhost:${PORT}`);
console.log(`Claude binary: ${CLAUDE_BIN}`);
console.log(`Working directory: ${CWD}`);
