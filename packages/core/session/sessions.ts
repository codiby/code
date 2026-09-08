import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { log, logError } from '../lib/logger';
import { SESSIONS_FILE, CODIBY_DIR, MAIN_SESSION_ID } from '../config/config';
import { DEFAULT_PROVIDER } from '../provider/registry';
import {
  loadPreferences, savePreferences, hasStoredMessages, loadUIState, deleteSessionData,
} from './storage';
import type { Session, PersistedSession, SessionStatus } from '../types';

export const sessions = new Map<string, Session>();

export function saveSessions() {
  const data: PersistedSession[] = [...sessions.values()].map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    claudeSessionId: s.claudeSessionId, savedCommands: s.savedCommands,
    model: s.model, permissionMode: s.permissionMode, effort: s.effort, provider: s.provider,
    remoteId: s.remoteId,
    portForwards: s.portForwards,
    status: s.status,
    loopState: s.loopState,
  }));
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logError(`[persist] Failed to save: ${e}`);
  }
}

/** One-shot migration: older session files don't carry `status`. We derive it
 *  from the legacy `closedSessionIds` / `archivedSessionIds` arrays in
 *  preferences — both map to `archived` (closed tabs collapse into the
 *  archived state going forward) — and strip those arrays from prefs once
 *  every session has been stamped. */
function migrateLegacySessions(persisted: PersistedSession[]): {
  data: PersistedSession[];
  migrated: boolean;
} {
  const needsMigration = persisted.some(p => !p.status || p.provider === 'claudeAgent');
  if (!needsMigration) return { data: persisted, migrated: false };

  const prefs = loadPreferences();
  const closedRaw = prefs.closedSessionIds;
  const archivedRaw = prefs.archivedSessionIds;
  const closed = new Set(Array.isArray(closedRaw) ? (closedRaw as string[]) : []);
  const archived = new Set(Array.isArray(archivedRaw) ? (archivedRaw as string[]) : []);

  const data = persisted.map<PersistedSession>(p => {
    const provider = p.provider === 'claudeAgent' ? 'claude' : p.provider;
    if (p.status && provider === p.provider) return p;
    const isHidden = closed.has(p.id) || archived.has(p.id);
    return { ...p, provider, status: p.status ?? (isHidden ? 'archived' : 'open') };
  });

  if ('closedSessionIds' in prefs || 'archivedSessionIds' in prefs) {
    delete prefs.closedSessionIds;
    delete prefs.archivedSessionIds;
    savePreferences(prefs);
    log(`[persist] Migrated legacy closed/archived lists into per-session status`);
  }

  return { data, migrated: true };
}

export function loadSessions() {
  try {
    const raw: PersistedSession[] = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const { data, migrated } = migrateLegacySessions(raw);
    for (const p of data) {
      const status: SessionStatus = p.status ?? 'open';
      sessions.set(p.id, {
        id: p.id,
        name: p.name,
        cwd: p.cwd,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt ?? p.createdAt,
        claudeSessionId: p.claudeSessionId,
        savedCommands: p.savedCommands || [],
        model: p.model || null,
        permissionMode: p.permissionMode || 'default',
        effort: p.effort || null,
        provider: p.provider || DEFAULT_PROVIDER,
        browserWs: new Set(),
        providerSession: null,
        providerSessionGen: 0,
        ready: false,
        status,
        runtimeStatus: 'stopped',
        replayDone: false,
        remoteId: p.remoteId ?? null,
        portForwards: p.portForwards ?? [],
        // A loop that was mid-flight when the bridge died is not resumed
        // automatically — it comes back paused so the user decides.
        loopState: p.loopState
          ? { ...p.loopState, phase: p.loopState.phase === 'looping' ? 'paused' : p.loopState.phase }
          : null,
      });
    }
    log(`[persist] Loaded ${data.length} sessions`);
    if (migrated) saveSessions();
  } catch {
    // No file or invalid — start fresh
  }
  pruneEmptySessions();
}

/**
 * A session the user opened and never wrote to is pure tab clutter, so a stray
 * ⌘T doesn't survive a restart: no message ever reached its log and nothing is
 * sitting in its composer. Runs once at boot, right after the session file is
 * read, and drops both the record and its directory on disk.
 *
 * Deliberately left alone:
 *  - the main session, whose id the Telegram bridge references externally;
 *  - remote sessions, whose transcript lives on the other machine and would
 *    never show up in the local message log.
 */
export function pruneEmptySessions() {
  const pruned: string[] = [];
  for (const s of sessions.values()) {
    if (s.id === MAIN_SESSION_ID || s.remoteId) continue;
    if (hasStoredMessages(s.id)) continue;
    // An unsent draft still counts as work in progress.
    const ui = loadUIState(s.id);
    if (typeof ui.input === 'string' && ui.input.trim()) continue;
    if (Array.isArray(ui.inputHistory) && ui.inputHistory.length > 0) continue;
    pruned.push(s.id);
  }
  if (pruned.length === 0) return;

  for (const id of pruned) {
    sessions.delete(id);
    deleteSessionData(id);
  }
  // Group membership is keyed by session id; stale ids would keep inflating
  // the per-project session counts in the settings modal.
  const prefs = loadPreferences();
  const map = prefs.tabGroupMap as Record<string, string> | undefined;
  if (map && typeof map === 'object') {
    const before = Object.keys(map).length;
    for (const id of pruned) delete map[id];
    if (Object.keys(map).length !== before) savePreferences(prefs);
  }
  saveSessions();
  log(`[persist] Pruned ${pruned.length} empty session(s)`);
}

export function broadcast(session: Session, data: string) {
  for (const ws of session.browserWs) {
    try { ws.send(data); } catch {}
  }
}

/** Stamp a session as "just touched" so the archived-sessions dropdown
 *  bubbles it to the top. Persists the change. */
export function touchSession(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.updatedAt = Date.now();
  saveSessions();
}

// Local broadcaster injected by index.ts (avoids a circular import) so the
// sidebar repaints when a session's status flips out from under the user.
let broadcastSessionList: (() => void) | null = null;
export function setStatusBroadcaster(fn: () => void) {
  broadcastSessionList = fn;
}

/** If the session is archived, flip it back to `open` and repaint the
 *  sidebar. Called when an archived conversation receives a new incoming
 *  message so it resurfaces in the session list automatically. Returns true
 *  if it actually un-archived (and thus already bumped `updatedAt` + persisted). */
export function unarchiveSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.status !== 'archived') return false;
  s.status = 'open';
  s.updatedAt = Date.now();
  saveSessions();
  broadcastSessionList?.();
  return true;
}

export function sessionToJSON(s: Session, port: number) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    status: s.status,
    runtime_status: s.runtimeStatus,
    ready: s.ready,
    claude_session_id: s.claudeSessionId,
    ws_url: `ws://localhost:${port}/browser/ws/${s.id}`,
    saved_commands: s.savedCommands || [],
    model: s.model || null,
    permission_mode: s.permissionMode || 'default',
    effort: s.effort || null,
    provider: s.provider || 'claude',
    loop_state: s.loopState ?? null,
  };
}
