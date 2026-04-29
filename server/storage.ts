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
    // Deduplicate by ID only. The previous content+role dedup (inherited
    // from the CLI-pipe era) collapsed legitimate repeats — identical short
    // assistant texts, tool-results with matching stdout — which happens
    // regularly in bypassPermissions mode.
    const seenIds = new Set<string>();
    const deduped = all.filter((m: any) => {
      if (m.id && seenIds.has(m.id)) return false;
      if (m.id) seenIds.add(m.id);
      return true;
    });
    // Backfill missing `seq` for pre-seq data, preserving file order.
    let backfilled = false;
    deduped.forEach((m: any, i) => {
      if (typeof m.seq !== 'number') { m.seq = i + 1; backfilled = true; }
    });
    // Compact the file if duplicates were found or seq was backfilled
    if (deduped.length < all.length || backfilled) {
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
// PR ↔ Session links
// ---------------------------------------------------------------------------

const PR_LINKS_FILE = join(homedir(), '.claude', 'ui-pr-links.json');

type PRLink = { prNumber: number; title: string; url: string; headRefName: string; state: string };

export function loadPRLinks(): Record<string, PRLink> {
  try {
    return JSON.parse(readFileSync(PR_LINKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function savePRLink(sessionId: string, link: PRLink) {
  const links = loadPRLinks();
  links[sessionId] = link;
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(PR_LINKS_FILE, JSON.stringify(links, null, 2));
}

export function removePRLink(sessionId: string) {
  const links = loadPRLinks();
  delete links[sessionId];
  writeFileSync(PR_LINKS_FILE, JSON.stringify(links, null, 2));
}

export function getPRLink(sessionId: string): PRLink | null {
  return loadPRLinks()[sessionId] || null;
}

// ---------------------------------------------------------------------------
// Telegram settings
// ---------------------------------------------------------------------------

const TELEGRAM_FILE = join(homedir(), '.claude', 'ui-telegram.json');

export type TelegramSettings = { botToken: string; chatId: string };

export function loadTelegramSettings(): TelegramSettings {
  try {
    const parsed = JSON.parse(readFileSync(TELEGRAM_FILE, 'utf-8'));
    return { botToken: parsed.botToken ?? '', chatId: parsed.chatId ?? '' };
  } catch {
    return { botToken: '', chatId: '' };
  }
}

export function saveTelegramSettings(settings: TelegramSettings) {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(TELEGRAM_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Deepgram settings
// ---------------------------------------------------------------------------

const DEEPGRAM_FILE = join(homedir(), '.claude', 'ui-deepgram.json');

export type DeepgramSettings = {
  apiKey: string;
  /** Deepgram model (e.g. "nova-3", "nova-2", "enhanced"). Defaults to nova-3. */
  model: string;
  /** BCP-47 language code or "multi" for multilingual. Defaults to "multi". */
  language: string;
};

const DEFAULT_DEEPGRAM_SETTINGS: DeepgramSettings = {
  apiKey: '',
  model: 'nova-3',
  language: 'multi',
};

export function loadDeepgramSettings(): DeepgramSettings {
  try {
    const parsed = JSON.parse(readFileSync(DEEPGRAM_FILE, 'utf-8'));
    return {
      apiKey: parsed.apiKey ?? '',
      model: parsed.model || DEFAULT_DEEPGRAM_SETTINGS.model,
      language: parsed.language || DEFAULT_DEEPGRAM_SETTINGS.language,
    };
  } catch {
    return { ...DEFAULT_DEEPGRAM_SETTINGS };
  }
}

export function saveDeepgramSettings(settings: DeepgramSettings) {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(DEEPGRAM_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Tailscale settings
// ---------------------------------------------------------------------------

const TAILSCALE_FILE = join(homedir(), '.claude', 'ui-tailscale.json');

export type TailscaleSettings = { funnelEnabled: boolean };

export function loadTailscaleSettings(): TailscaleSettings {
  try {
    const parsed = JSON.parse(readFileSync(TAILSCALE_FILE, 'utf-8'));
    return { funnelEnabled: !!parsed.funnelEnabled };
  } catch {
    return { funnelEnabled: false };
  }
}

export function saveTailscaleSettings(settings: TailscaleSettings) {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(TAILSCALE_FILE, JSON.stringify(settings, null, 2));
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
