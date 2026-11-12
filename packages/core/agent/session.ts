/**
 * The agent session — `MAIN_SESSION_ID`, created independently of any one
 * channel (it used to be born inside the Telegram bot).
 *
 * It never runs in `bypassPermissions`: it takes orders from messaging apps,
 * so every non-trivial tool call goes through the policy layer
 * (provider/bridge.ts → registry.evaluateAgentPolicy).
 */

import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { MAIN_SESSION_ID } from '../config/config';
import { log } from '../lib/logger';
import { DEFAULT_PROVIDER } from '../provider/registry';
import { saveSessions, sessions } from '../session/sessions';
import { addMessage, updateSessionState } from '../session/state';
import type { Session } from '../types';
import { loadAgentConfig, type AgentConfig } from './config';
import { runBeforeThreadRotate } from './registry';
import { agentDeps, hasAgentDeps } from './runtime';

export const AGENT_SESSION_ID = MAIN_SESSION_ID;

export function isAgentSession(sessionId: string | null | undefined): boolean {
  return sessionId === AGENT_SESSION_ID;
}

export function getAgentSession(): Session | null {
  return sessions.get(AGENT_SESSION_ID) ?? null;
}

function sessionName(): string {
  const { persona } = loadAgentConfig();
  return `${persona.emoji ? `${persona.emoji} ` : ''}${persona.name}`.trim();
}

/** Create (or repair) the agent session. Idempotent. */
export function ensureAgentSession(): Session {
  const cfg = loadAgentConfig();
  let session = sessions.get(AGENT_SESSION_ID);
  if (!session) {
    try { mkdirSync(cfg.workspaceDir, { recursive: true }); } catch {}
    const now = Date.now();
    session = {
      id: AGENT_SESSION_ID,
      name: sessionName(),
      cwd: cfg.workspaceDir,
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: 0,
      claudeSessionId: null,
      browserWs: new Set(),
      providerSession: null,
      providerSessionGen: 0,
      ready: false,
      status: 'open',
      runtimeStatus: 'stopped',
      replayDone: true,
      savedCommands: [],
      model: cfg.model,
      permissionMode: 'default',
      effort: null,
      provider: cfg.provider || DEFAULT_PROVIDER,
      remoteId: null,
      portForwards: [],
    };
    sessions.set(AGENT_SESSION_ID, session);
    saveSessions();
    log('[agent] Created the agent session');
    return session;
  }

  let changed = false;
  // Sessions created by the old Telegram bot ran in bypassPermissions, which
  // let any message that reached the bot run shell commands unasked.
  if (session.permissionMode === 'bypassPermissions') {
    session.permissionMode = 'default';
    changed = true;
    log('[agent] Agent session moved from bypassPermissions to default (policy-governed)');
    if (session.providerSession) {
      void Promise.resolve(session.providerSession.setPermissionMode('default')).catch(() => {});
    }
  }
  if (session.name === 'Telegram Agent') {
    session.name = sessionName();
    changed = true;
  }
  if (session.status !== 'open') {
    session.status = 'open';
    changed = true;
  }
  if (changed) saveSessions();
  return session;
}

/** Re-apply the persona name after a config change. */
export function syncAgentSessionName(): void {
  const session = sessions.get(AGENT_SESSION_ID);
  if (!session) return;
  const name = sessionName();
  if (session.name !== name) {
    session.name = name;
    saveSessions();
  }
}

/**
 * Model and workspace edits from the Agent view (PUT /agent/config). The
 * session copies them from the config once, when it is created, so without
 * this a model or folder saved in Persona never applied. Only what this save
 * changed is copied: a model picked in the session's own tab stays until the
 * Agent view says otherwise. Both apply at the provider's next start (fresh
 * thread, idle resume, restart); a resumed thread still starts in the folder
 * it lives in (providerCwd).
 */
export function applyAgentConfigToSession(prev: AgentConfig, next: AgentConfig): void {
  const session = sessions.get(AGENT_SESSION_ID);
  if (!session) return;
  let changed = false;
  if (next.model !== prev.model && session.model !== next.model) {
    session.model = next.model;
    changed = true;
  }
  if (next.workspaceDir !== prev.workspaceDir && session.cwd !== next.workspaceDir) {
    try { mkdirSync(next.workspaceDir, { recursive: true }); } catch {}
    session.cwd = next.workspaceDir;
    changed = true;
  }
  if (!changed) return;
  saveSessions();
  if (hasAgentDeps()) agentDeps().broadcastSessionList();
}

/** The rotation under way, shared by every caller that asks for one meanwhile. */
let rotation: Promise<void> | null = null;

/**
 * The rotation in progress, or null. inbound.ts waits on it before handing
 * an owner message to the agent: sent mid-rotation, the message would either
 * be answered in the thread being retired (and cut off) or respawn the
 * provider on the old thread.
 */
export function agentRotation(): Promise<void> | null {
  return rotation;
}

/**
 * Start a fresh conversation thread for the agent (`/new`). Memory survives —
 * it lives in the agent's own store, not in the transcript. The visible chat
 * keeps its history; only the provider conversation is replaced, so the next
 * message starts with an empty context plus the system prompt.
 *
 * A second request while one runs (a `/new` during the daily rotation) joins
 * it: both want the same fresh thread.
 */
export function rotateAgentThread(reason = 'New conversation'): Promise<void> {
  if (rotation) return rotation;
  const run = rotate(reason).finally(() => {
    if (rotation === run) rotation = null;
  });
  rotation = run;
  return run;
}

async function rotate(reason: string): Promise<void> {
  const session = ensureAgentSession();
  await runBeforeThreadRotate({ reason });
  const provider = session.providerSession;
  session.providerSession = null;
  // Forget the old thread before awaiting close(): a message that respawns
  // the provider meanwhile (the desktop, an automation) would otherwise
  // `--resume` the very thread being retired.
  session.claudeSessionId = null;
  session.providerCwd = null;
  session.forkPending = false;
  session.ready = false;
  session.runtimeStatus = 'stopped';
  saveSessions();
  if (provider) {
    try { await provider.close(); } catch {}
  }
  // Lazy import: provider/bridge imports the agent registry.
  const { clearPendingDecisionsForSession } = await import('../provider/bridge');
  // A provider spawned during close() belongs to the new thread, and its
  // spawn already settled the old turn; resetting now would clobber it.
  const respawned = !!session.providerSession;
  if (!respawned) {
    clearPendingDecisionsForSession(session.id, 'Conversation rotated');
    updateSessionState(session.id, s => ({ ...s, isStreaming: false, partialText: '', partialThinking: '', permRequest: null }));
  }
  const marker = { id: randomUUID(), role: 'system' as const, content: `— ${reason}: the agent starts a fresh thread here (memory is kept) —`, timestamp: Date.now() };
  if (addMessage(session.id, marker) && hasAgentDeps()) {
    agentDeps().broadcastToSession(session.id, { type: 'message', sessionId: session.id, message: marker });
    if (!respawned) agentDeps().broadcastToSession(session.id, { type: 'status', sessionId: session.id, status: 'disconnected' });
    agentDeps().broadcastSessionList();
  }
  log(`[agent] Rotated the agent thread (${reason})`);
}
