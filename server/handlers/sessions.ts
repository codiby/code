import { randomUUID } from 'crypto';
import { sessions, saveSessions, sessionToJSON } from '../sessions';
import { startProviderSession } from '../provider/lifecycle';
import { corsHeaders, CWD, PORT, MAIN_SESSION_ID } from '../config';
import { log } from '../logger';
import { trackedProcesses, killProcessTree, saveProcessRegistry } from './processes';
import { killSessionLsp } from './lsp';
import { DEFAULT_PROVIDER } from '../provider/registry';
import { clearPendingDecisionsForSession } from '../provider/bridge';
import type { Session } from '../types';

export async function handleCreateSession(req: Request, port: number): Promise<Response> {
  let cwd = CWD;
  let name = '';
  let model: string | null = null;
  let permissionMode = 'default';
  let provider = DEFAULT_PROVIDER;
  try {
    const body = await req.json() as Record<string, unknown>;
    if (body.cwd && typeof body.cwd === 'string') cwd = body.cwd;
    if (body.name && typeof body.name === 'string') name = body.name;
    if (body.model && typeof body.model === 'string') model = body.model;
    if (body.permissionMode && typeof body.permissionMode === 'string') permissionMode = body.permissionMode;
    if (body.provider && typeof body.provider === 'string') provider = body.provider;
  } catch {}

  const session: Session = {
    id: randomUUID(),
    name: name || `Session ${sessions.size + 1}`,
    cwd,
    createdAt: Date.now(),
    claudeSessionId: null,
    browserWs: new Set(),
    providerSession: null,
    ready: false,
    status: 'starting',
    replayDone: true,
    savedCommands: [],
    model,
    permissionMode,
    provider,
  };
  sessions.set(session.id, session);

  log(`[${session.id.slice(0,8)}] Creating new session, cwd=${cwd}, provider=${provider}`);
  startProviderSession(session, port);
  saveSessions();

  return Response.json(sessionToJSON(session, port), { headers: corsHeaders });
}

export function handleResumeSession(sessionId: string, port: number): Response {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }
  if (session.providerSession) {
    return Response.json({ error: 'Session already running' }, { status: 409, headers: corsHeaders });
  }
  if (!session.claudeSessionId) {
    log(`[${sessionId.slice(0,8)}] Resuming session (no provider session id, starting fresh)`);
    session.replayDone = true;
    startProviderSession(session, port);
  } else {
    log(`[${sessionId.slice(0,8)}] Resuming session with provider_session_id=${session.claudeSessionId}`);
    session.replayDone = false;
    startProviderSession(session, port, session.claudeSessionId);
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

export async function handleStopSession(sessionId: string): Promise<Response> {
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }

  // Close provider session
  if (session.providerSession) {
    try { await session.providerSession.close(); } catch {}
    session.providerSession = null;
  }
  // Resolve any pending permission prompts so nothing hangs
  clearPendingDecisionsForSession(sessionId, 'Session stopped');

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

export async function handleDeleteSession(sessionId: string): Promise<Response> {
  if (sessionId === MAIN_SESSION_ID) {
    return Response.json({ error: 'Cannot delete main session' }, { status: 403, headers: corsHeaders });
  }
  const session = sessions.get(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders });
  }

  if (session.providerSession) {
    try { await session.providerSession.close(); } catch {}
  }
  clearPendingDecisionsForSession(sessionId, 'Session deleted');
  for (const ws of session.browserWs) {
    try { ws.close(); } catch {}
  }
  killSessionLsp(sessionId);
  sessions.delete(sessionId);
  saveSessions();
  log(`[${sessionId.slice(0, 8)}] Session deleted`);

  return Response.json({ ok: true }, { headers: corsHeaders });
}
