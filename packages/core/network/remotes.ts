/**
 * Configured remote workstations.
 *
 * A "remote" is a named pointer to a Host entry in the user's ~/.ssh/config
 * (the alias) plus the port where a bun bridge server is running on that
 * machine. The actual SSH user, IdentityFile, ProxyJump, etc. all come from
 * ~/.ssh/config — we never re-implement them in the UI.
 *
 * Persistence: ~/.codiby/ui-remotes.json (mirrors ui-sessions.json naming).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { log, logError } from '../lib/logger';
import { clearRemoteCache } from './remote-sessions-cache';
import { clearRemoteGroups } from './remote-groups-cache';
import { CODIBY_DIR } from '../config/config';
import type { Remote } from '../types';

export const REMOTES_FILE = join(CODIBY_DIR, 'ui-remotes.json');

/** Palette used when the user picks "Auto" for the color of a new remote.
 *  Kept in sync with GROUP_COLORS in server/mcp.ts and ChatApp.tsx. */
const REMOTE_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'] as const;

export const remotes = new Map<string, Remote>();

export function loadRemotes() {
  try {
    const data: Remote[] = JSON.parse(readFileSync(REMOTES_FILE, 'utf-8'));
    for (const r of data) {
      remotes.set(r.id, {
        id: r.id,
        name: r.name,
        alias: r.alias,
        bunPort: r.bunPort,
        color: r.color,
        createdAt: r.createdAt,
      });
    }
    log(`[remotes] Loaded ${data.length} remotes`);
  } catch {
    // No file yet — start empty.
  }
}

export function saveRemotes() {
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(REMOTES_FILE, JSON.stringify([...remotes.values()], null, 2));
  } catch (e) {
    logError(`[remotes] Failed to save: ${e}`);
  }
}

/** Pick a palette color that isn't already in use, falling back to a hash. */
function pickAutoColor(): string {
  const used = new Set([...remotes.values()].map(r => r.color));
  for (const c of REMOTE_COLORS) {
    if (!used.has(c)) return c;
  }
  // All in use — cycle by count.
  return REMOTE_COLORS[remotes.size % REMOTE_COLORS.length];
}

export type AddRemoteInput = {
  name: string;
  alias: string;
  bunPort?: number;
  color?: string | 'auto';
};

export type RemoteValidationError = {
  field: 'name' | 'alias' | 'bunPort';
  message: string;
};

export function validateRemoteInput(
  input: Partial<AddRemoteInput>,
  ignoreId?: string,
): RemoteValidationError | null {
  if (!input.name || !input.name.trim()) {
    return { field: 'name', message: 'Display name is required.' };
  }
  if (!input.alias || !input.alias.trim()) {
    return { field: 'alias', message: 'SSH alias is required.' };
  }
  if (input.bunPort != null) {
    const p = Number(input.bunPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return { field: 'bunPort', message: 'Port must be between 1 and 65535.' };
    }
  }
  for (const existing of remotes.values()) {
    if (ignoreId && existing.id === ignoreId) continue;
    if (existing.name.trim().toLowerCase() === input.name.trim().toLowerCase()) {
      return { field: 'name', message: `Another remote already uses the name "${existing.name}".` };
    }
    if (existing.alias.trim() === input.alias.trim()) {
      return { field: 'alias', message: `Another remote already uses the alias "${existing.alias}".` };
    }
  }
  return null;
}

export function addRemote(input: AddRemoteInput): Remote {
  const err = validateRemoteInput(input);
  if (err) throw new Error(err.message);
  const color = !input.color || input.color === 'auto' ? pickAutoColor() : input.color;
  const remote: Remote = {
    id: `rmt_${randomUUID()}`,
    name: input.name.trim(),
    alias: input.alias.trim(),
    bunPort: input.bunPort ?? 3111,
    color,
    createdAt: Date.now(),
  };
  remotes.set(remote.id, remote);
  saveRemotes();
  log(`[remotes] Added ${remote.name} (${remote.alias})`);
  return remote;
}

export function updateRemote(id: string, patch: Partial<AddRemoteInput>): Remote {
  const cur = remotes.get(id);
  if (!cur) throw new Error(`Remote ${id} not found`);
  const merged: AddRemoteInput = {
    name: patch.name ?? cur.name,
    alias: patch.alias ?? cur.alias,
    bunPort: patch.bunPort ?? cur.bunPort,
    color: patch.color ?? cur.color,
  };
  const err = validateRemoteInput(merged, id);
  if (err) throw new Error(err.message);
  const next: Remote = {
    ...cur,
    name: merged.name.trim(),
    alias: merged.alias.trim(),
    bunPort: merged.bunPort ?? cur.bunPort,
    color: !merged.color || merged.color === 'auto' ? cur.color : merged.color,
  };
  remotes.set(id, next);
  saveRemotes();
  log(`[remotes] Updated ${next.name} (${next.alias})`);
  return next;
}

export function removeRemote(id: string): Remote | null {
  const cur = remotes.get(id);
  if (!cur) return null;
  remotes.delete(id);
  saveRemotes();
  // Drop the cached session list for this remote — sessions on the remote
  // itself are untouched, but locally we've forgotten about them.
  clearRemoteCache(id);
  clearRemoteGroups(id);
  log(`[remotes] Removed ${cur.name} (${cur.alias})`);
  return cur;
}

export function getRemote(id: string): Remote | null {
  return remotes.get(id) ?? null;
}

export function listRemotes(): Remote[] {
  return [...remotes.values()].sort((a, b) => a.createdAt - b.createdAt);
}
