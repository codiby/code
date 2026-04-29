import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { log, logError } from './logger';
import { SESSIONS_FILE } from './config';
import { DEFAULT_PROVIDER } from './provider/registry';
import type { Session, PersistedSession } from './types';

export const sessions = new Map<string, Session>();

export function saveSessions() {
  const data: PersistedSession[] = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt,
    claudeSessionId: s.claudeSessionId, savedCommands: s.savedCommands,
    model: s.model, permissionMode: s.permissionMode, provider: s.provider,
  }));
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`[persist] Failed to save: ${e}`);
  }
}

export function loadSessions() {
  try {
    const data: PersistedSession[] = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    for (const p of data) {
      sessions.set(p.id, {
        id: p.id,
        name: p.name,
        cwd: p.cwd,
        createdAt: p.createdAt,
        claudeSessionId: p.claudeSessionId,
        savedCommands: p.savedCommands || [],
        model: p.model || null,
        permissionMode: p.permissionMode || 'default',
        provider: p.provider || DEFAULT_PROVIDER,
        browserWs: new Set(),
        providerSession: null,
        ready: false,
        status: 'stopped',
        replayDone: false,
      });
    }
    log(`[persist] Loaded ${data.length} sessions`);
  } catch {
    // No file or invalid — start fresh
  }
}

export function broadcast(session: Session, data: string) {
  for (const ws of session.browserWs) {
    try { ws.send(data); } catch {}
  }
}

export function sessionToJSON(s: Session, port: number) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    created_at: s.createdAt,
    status: s.status,
    ready: s.ready,
    claude_session_id: s.claudeSessionId,
    ws_url: `ws://localhost:${port}/browser/ws/${s.id}`,
    saved_commands: s.savedCommands || [],
    model: s.model || null,
    permission_mode: s.permissionMode || 'default',
    provider: s.provider || 'claudeAgent',
  };
}
