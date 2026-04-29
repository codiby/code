import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { sessions, saveSessions, sessionToJSON } from '../sessions';
import { startProviderSession } from '../provider/lifecycle';
import { corsHeaders, CWD, PORT, MAIN_SESSION_ID } from '../config';
import { log, logError } from '../logger';
import { trackedProcesses, killProcessTree, saveProcessRegistry } from './processes';
import { killSessionLsp } from './lsp';
import { DEFAULT_PROVIDER } from '../provider/registry';
import { clearPendingDecisionsForSession } from '../provider/bridge';
import { deleteSessionData } from '../storage';
import type { Session } from '../types';

/** True when `cwd` matches the worktree convention `<repo-parent>/.wt/<branch>`
 *  used by handleCreateWorktree. We only treat these as removable worktrees.
 *  Accepts both `/` and `\` so Windows paths match too. */
function looksLikeWorktree(cwd: string): boolean {
  if (!cwd) return false;
  return /[\\/]\.wt[\\/][^\\/]+$/.test(cwd) || /[\\/]\.wt[\\/]/.test(cwd);
}

/** Try to remove the git worktree at `cwd` from its parent repo. The parent
 *  repo is `<cwd>/../..` for the standard `<repo-parent>/.wt/<branch>` layout,
 *  but we also try a few common siblings if that doesn't pan out. Best-effort
 *  — falls back to a recursive directory delete if `git worktree remove`
 *  refuses (e.g. uncommitted changes). */
function purgeWorktree(cwd: string): { removed: boolean; method: 'git' | 'fs' | 'none' } {
  if (!existsSync(cwd)) return { removed: false, method: 'none' };
  // <cwd>/../..  — typically the parent git repo for `<repo>/.wt/<branch>`
  const wtParent = dirname(cwd);                     // <repo>/.wt
  const candidateRepo = dirname(wtParent);           // <repo>
  const repoCandidates = [candidateRepo, dirname(candidateRepo)];
  for (const repo of repoCandidates) {
    if (!existsSync(join(repo, '.git'))) continue;
    try {
      execSync(`git worktree remove --force "${cwd}"`, { cwd: repo, stdio: 'pipe', timeout: 10_000 });
      log(`[purge] git worktree remove succeeded for ${cwd}`);
      return { removed: true, method: 'git' };
    } catch (err) {
      logError(`[purge] git worktree remove failed at ${repo}: ${err}`);
      // Try the next candidate repo
    }
  }
  // Fallback — just nuke the directory recursively
  try {
    rmSync(cwd, { recursive: true, force: true });
    log(`[purge] fs rm -rf succeeded for ${cwd}`);
    return { removed: true, method: 'fs' };
  } catch (err) {
    logError(`[purge] fs rm -rf failed for ${cwd}: ${err}`);
    return { removed: false, method: 'none' };
  }
}

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

export async function handleDeleteSession(
  sessionId: string,
  purge = false,
  removeWorktree = false,
): Promise<Response> {
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

  let purgeResult: { worktree?: { removed: boolean; method: string }; history?: boolean } | undefined;
  if (purge || removeWorktree) {
    purgeResult = {};
    // 1. Worktree (only when explicitly requested and the cwd matches the
    //    `.wt/<branch>` convention).
    if (removeWorktree && session.cwd && looksLikeWorktree(session.cwd)) {
      purgeResult.worktree = purgeWorktree(session.cwd);
    }
    // 2. Chat history + UI state on disk
    if (purge) {
      try {
        deleteSessionData(sessionId);
        purgeResult.history = true;
        log(`[${sessionId.slice(0, 8)}] Purged session data on disk`);
      } catch (err) {
        logError(`[${sessionId.slice(0, 8)}] Failed to purge session data: ${err}`);
        purgeResult.history = false;
      }
    }
  }
  log(`[${sessionId.slice(0, 8)}] Session ${purge ? 'purged' : 'deleted'}${removeWorktree ? ' (worktree removed)' : ''}`);

  return Response.json({ ok: true, purged: purge, ...purgeResult }, { headers: corsHeaders });
}
