/**
 * Read-only view of the configured remotes for the Electron main process.
 *
 * A "remote" is a named pointer to a Host entry in ~/.ssh/config (the alias)
 * plus the port where a bun bridge listens on that machine. The bun sidecar
 * owns the canonical CRUD + persistence (server/remotes.ts → ~/.codiby/
 * ui-remotes.json); main only needs to READ it to resolve alias/bunPort when
 * spawning an SSH tunnel. We re-read the file on demand (it's tiny and changes
 * rarely) so edits made through Settings are picked up without an IPC notify.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODIBY_DIR = join(homedir(), '.codiby');
const REMOTES_FILE = join(CODIBY_DIR, 'ui-remotes.json');

export interface Remote {
  id: string;
  name: string;
  alias: string;
  bunPort: number;
  color: string;
  createdAt: number;
}

export function loadRemotes(): Remote[] {
  try {
    const data = JSON.parse(readFileSync(REMOTES_FILE, 'utf-8'));
    if (Array.isArray(data)) return data as Remote[];
  } catch {
    // No file yet / unreadable — treat as no remotes configured.
  }
  return [];
}

export function getRemote(id: string): Remote | null {
  return loadRemotes().find((r) => r.id === id) ?? null;
}
