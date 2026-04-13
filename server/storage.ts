/**
 * File-based storage for session data.
 *
 * ~/.claude/ui-sessions/{session-id}/
 *   ├── messages.jsonl    # Append-only message log
 *   └── state.json        # UI state (input, panels, todos)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.claude', 'ui-sessions');

function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Messages (JSONL)
// ---------------------------------------------------------------------------

export function appendMessage(sessionId: string, msg: unknown) {
  const dir = sessionDir(sessionId);
  ensureDir(dir);
  appendFileSync(join(dir, 'messages.jsonl'), JSON.stringify(msg) + '\n');
}

export function appendMessages(sessionId: string, msgs: unknown[]) {
  if (msgs.length === 0) return;
  const dir = sessionDir(sessionId);
  ensureDir(dir);
  const data = msgs.map(m => JSON.stringify(m)).join('\n') + '\n';
  appendFileSync(join(dir, 'messages.jsonl'), data);
}

export function loadMessages(sessionId: string): unknown[] {
  try {
    const file = join(sessionDir(sessionId), 'messages.jsonl');
    const content = readFileSync(file, 'utf-8');
    const all = content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
    // Deduplicate by ID (replays can cause duplicates in the JSONL file)
    const seen = new Set<string>();
    const deduped = all.filter((m: any) => {
      if (!m.id) return true;
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    // Compact the file if duplicates were found
    if (deduped.length < all.length) {
      try {
        const compacted = deduped.map(m => JSON.stringify(m)).join('\n') + '\n';
        writeFileSync(file, compacted);
      } catch {}
    }
    return deduped;
  } catch {
    return [];
  }
}

export function clearMessages(sessionId: string) {
  try {
    const file = join(sessionDir(sessionId), 'messages.jsonl');
    writeFileSync(file, '');
  } catch {}
}

// ---------------------------------------------------------------------------
// UI State (JSON)
// ---------------------------------------------------------------------------

export function saveUIState(sessionId: string, state: Record<string, unknown>) {
  const dir = sessionDir(sessionId);
  ensureDir(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

export function loadUIState(sessionId: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(sessionDir(sessionId), 'state.json'), 'utf-8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function deleteSessionData(sessionId: string) {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch {}
}

export function listSessionDirs(): string[] {
  try {
    ensureDir(SESSIONS_DIR);
    return readdirSync(SESSIONS_DIR).filter(name => {
      return existsSync(join(SESSIONS_DIR, name, 'messages.jsonl')) ||
             existsSync(join(SESSIONS_DIR, name, 'state.json'));
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Global preferences (tabs, groups, etc.)
// ---------------------------------------------------------------------------

const PREFS_FILE = join(homedir(), '.claude', 'ui-preferences.json');

export function loadPreferences(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Record<string, unknown>) {
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch {}
}
