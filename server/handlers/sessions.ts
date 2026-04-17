import { randomUUID } from 'crypto';
import { sessions, saveSessions, sessionToJSON } from '../sessions';
import { spawnClaude } from '../claude';
import { corsHeaders, CWD, PORT, MAIN_SESSION_ID } from '../config';
import { log } from '../logger';
import { trackedProcesses, killProcessTree, saveProcessRegistry } from './processes';
import { killSessionLsp } from './lsp';
import type { Session } from '../types';

export async function handleCreateSession(req: Request, port: number): Promise<Response> {
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
    replayDone: true,
    pendingMessages: [],
    savedCommands: [],
    model,
    permissionMode,
  };
  sessions.set(session.id, session);

  log(`[${session.id.slice(0,8)}] Creating new session, cwd=${cwd}`);
  spawnClaude(session, port);
  saveSessions();

  return Response.json(sessionToJSON(session, port), { headers: corsHeaders });
}

export function handleResumeSession(sessionId: string, port: number): Response {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }
  if (session.process) {
    return Response.json({ error: 'Session already running' }, { status: 409, headers: corsHeaders });
  }
  if (!session.claudeSessionId) {
    log(`[${sessionId.slice(0,8)}] Resuming session (no claude_session_id, starting fresh)`);
    session.replayDone = true;
    spawnClaude(session, port);
  } else {
    log(`[${sessionId.slice(0,8)}] Resuming session with claude_session_id=${session.claudeSessionId}`);
    session.replayDone = false;
    spawnClaude(session, port, session.claudeSessionId);
  }
  saveSessions();
  return Response.json(sessionToJSON(session, port), { headers: corsHeaders });
}

export async function handleRenameSession(sessionId: string, req: Request): Promise<Response> {
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
  return Response.json(sessionToJSON(session, PORT), { headers: corsHeaders });
}

export function handleStopSession(sessionId: string): Response {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }

  // Kill Claude process
  if (session.process) {
    session.process.kill('SIGTERM');
    session.process = null;
  }
  // Close Claude WebSocket
  if (session.claudeWs) {
    try { (session.claudeWs as any).close(); } catch {}
    session.claudeWs = null;
  }
  // Close browser WebSockets
  for (const ws of session.browserWs) {
    try { ws.close(); } catch {}
  }
  session.browserWs.clear();
  // Kill tracked terminal processes for this session
  for (const [id, tp] of trackedProcesses) {
    if (tp.sessionId !== sessionId) continue;
    killProcessTree(tp.pid);
    try { tp.proc?.kill('SIGKILL'); } catch {}
    trackedProcesses.delete(id);
  }
  saveProcessRegistry();

  // Kill LSP servers for this session
  killSessionLsp(sessionId);

  session.ready = false;
  session.status = 'stopped';
  saveSessions();
  log(`[${sessionId.slice(0, 8)}] Session stopped (tab closed)`);

  return Response.json({ ok: true }, { headers: corsHeaders });
}

export function handleDeleteSession(sessionId: string): Response {
  if (sessionId === MAIN_SESSION_ID) {
    return Response.json({ error: 'Cannot delete main session' }, { status: 403, headers: corsHeaders });
  }
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
  killSessionLsp(sessionId);
  sessions.delete(sessionId);
  saveSessions();
  log(`[${sessionId.slice(0, 8)}] Session deleted`);

  return Response.json({ ok: true }, { headers: corsHeaders });
}
