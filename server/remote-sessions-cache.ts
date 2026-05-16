/**
 * Read-through cache of remote sessions metadata.
 *
 * Authority lives on each remote (its own ui-sessions.json). Locally we keep
 * a flattened, read-only snapshot of metadata so the sidebar can show remote
 * sessions even when the SSH tunnel is down (badged "stale / offline").
 *
 * We never cache message bodies (~/.codiby/ui-sessions/{id}/messages.jsonl)
 * — those are streamed on demand through the gateway when a pane opens.
 *
 * File layout:
 *   ~/.codiby/ui-remote-sessions/{remoteId}.json   →  CachedRemoteSession[]
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { log, logError } from './logger';
import { CODIBY_DIR } from './config';
import type { PortForward } from './types';

export const REMOTE_SESSIONS_DIR = join(CODIBY_DIR, 'ui-remote-sessions');

/** Subset of Session metadata that's safe to hold without an active tunnel. */
export type CachedRemoteSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** UI lifecycle (open | archived). */
  status: 'open' | 'archived';
  /** Live process state at the time the cache was refreshed. */
  runtimeStatus: 'starting' | 'running' | 'stopped';
  model: string | null;
  permissionMode: string;
  provider: string;
  claudeSessionId: string | null;
  portForwards: PortForward[];
  /** Last time the cache entry was refreshed from the remote. */
  cachedAt: number;
};

function fileFor(remoteId: string): string {
  return join(REMOTE_SESSIONS_DIR, `${remoteId}.json`);
}

function ensureDir() {
  try {
    mkdirSync(REMOTE_SESSIONS_DIR, { recursive: true });
  } catch (e) {
    logError(`[remote-cache] mkdir failed: ${e}`);
  }
}

export function loadRemoteSessions(remoteId: string): CachedRemoteSession[] {
  try {
    const data = JSON.parse(readFileSync(fileFor(remoteId), 'utf-8'));
    if (Array.isArray(data)) return data as CachedRemoteSession[];
  } catch {
    // Missing or invalid — treat as empty cache.
  }
  return [];
}

export function saveRemoteSessions(remoteId: string, list: CachedRemoteSession[]) {
  ensureDir();
  try {
    writeFileSync(fileFor(remoteId), JSON.stringify(list, null, 2));
  } catch (e) {
    logError(`[remote-cache] save ${remoteId} failed: ${e}`);
  }
}

/** Upsert a single cached session (used when the remote pushes incremental updates). */
export function upsertRemoteSession(remoteId: string, entry: CachedRemoteSession) {
  const list = loadRemoteSessions(remoteId);
  const idx = list.findIndex(s => s.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  saveRemoteSessions(remoteId, list);
}

export function removeCachedRemoteSession(remoteId: string, sessionId: string) {
  const list = loadRemoteSessions(remoteId).filter(s => s.id !== sessionId);
  saveRemoteSessions(remoteId, list);
}

/** Drop the entire cache for a remote (used when the remote is deleted). */
export function clearRemoteCache(remoteId: string) {
  try {
    if (existsSync(fileFor(remoteId))) unlinkSync(fileFor(remoteId));
    log(`[remote-cache] cleared ${remoteId}`);
  } catch (e) {
    logError(`[remote-cache] clear ${remoteId} failed: ${e}`);
  }
}
