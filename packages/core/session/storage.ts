/**
 * File-based storage for session data.
 *
 * ~/.codiby/ui-sessions/{session-id}/
 *   ├── messages.jsonl    # Append-only message log
 *   └── state.json        # UI state (input, panels, todos)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';

const SESSIONS_DIR = join(CODIBY_DIR, 'ui-sessions');

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

/** True when the session has at least one message on disk. Stats the log
 *  instead of parsing it — callers only want "did anything ever happen here". */
export function hasStoredMessages(sessionId: string): boolean {
  try {
    return statSync(join(sessionDir(sessionId), 'messages.jsonl')).size > 0;
  } catch {
    return false;
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

const PR_LINKS_FILE = join(CODIBY_DIR,'ui-pr-links.json');

/**
 * A pull request associated with a session. `repo` and `cwd` exist because a
 * session can span two checkouts (e.g. an API change plus its client), and
 * "PR #42" is only unambiguous once you know which repository it belongs to —
 * the detail pane also needs `cwd` to shell out to `gh` in the right place.
 * Both are optional so links written before multi-repo support still load.
 */
export type PRLink = {
  prNumber: number;
  title: string;
  url: string;
  headRefName: string;
  state: string;
  repo?: string;
  cwd?: string;
  linkedAt?: number;
  linkedBy?: 'user' | 'agent';
};

/** Normalize one persisted entry. The file used to hold a single object per
 *  session; anything written before the multi-PR change reads back as a
 *  one-element list rather than being dropped. */
function toLinkList(value: unknown): PRLink[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.filter((l): l is PRLink => !!l && typeof (l as PRLink).prNumber === 'number');
}

/** True when two links point at the same PR. A link whose `repo` is unknown
 *  (legacy, or resolved without a remote) matches on number alone, so
 *  re-linking it with the repo filled in updates the entry instead of
 *  duplicating it. */
function sameLink(a: PRLink, b: PRLink): boolean {
  if (a.prNumber !== b.prNumber) return false;
  if (!a.repo || !b.repo) return true;
  return a.repo.toLowerCase() === b.repo.toLowerCase();
}

export function loadPRLinks(): Record<string, PRLink[]> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(PR_LINKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
  const out: Record<string, PRLink[]> = {};
  for (const [sessionId, value] of Object.entries(parsed || {})) {
    const list = toLinkList(value);
    if (list.length) out[sessionId] = list;
  }
  return out;
}

function writePRLinks(links: Record<string, PRLink[]>) {
  mkdirSync(CODIBY_DIR, { recursive: true });
  writeFileSync(PR_LINKS_FILE, JSON.stringify(links, null, 2));
}

export function getPRLinks(sessionId: string): PRLink[] {
  return loadPRLinks()[sessionId] || [];
}

/** Add a PR to a session, replacing the existing entry for the same PR so a
 *  re-link refreshes title/state instead of piling up duplicates. An existing
 *  entry keeps its position — re-linking a PR shouldn't reshuffle the badges. */
export function addPRLink(sessionId: string, link: PRLink): PRLink[] {
  const all = loadPRLinks();
  const current = all[sessionId] || [];
  const at = current.findIndex(l => sameLink(l, link));
  const next = at === -1
    ? [...current, link]
    : current.map((l, i) => (i === at ? link : l));
  all[sessionId] = next;
  writePRLinks(all);
  return next;
}

/** Replace a session's whole list. Used by the bulk PUT form. */
export function setPRLinks(sessionId: string, links: PRLink[]): PRLink[] {
  const all = loadPRLinks();
  if (links.length) all[sessionId] = links;
  else delete all[sessionId];
  writePRLinks(all);
  return links;
}

/** Remove one PR from a session, or every PR when `match` is omitted. */
export function removePRLink(sessionId: string, match?: { prNumber: number; repo?: string }): PRLink[] {
  const all = loadPRLinks();
  const current = all[sessionId] || [];
  const next = match
    ? current.filter(l => !sameLink(l, { ...match, title: '', url: '', headRefName: '', state: '' }))
    : [];
  if (next.length) all[sessionId] = next;
  else delete all[sessionId];
  writePRLinks(all);
  return next;
}

// ---------------------------------------------------------------------------
// Telegram settings
// ---------------------------------------------------------------------------

const TELEGRAM_FILE = join(CODIBY_DIR,'ui-telegram.json');

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
  mkdirSync(CODIBY_DIR, { recursive: true });
  writeFileSync(TELEGRAM_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Deepgram settings
// ---------------------------------------------------------------------------

const DEEPGRAM_FILE = join(CODIBY_DIR,'ui-deepgram.json');

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
  mkdirSync(CODIBY_DIR, { recursive: true });
  writeFileSync(DEEPGRAM_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Tailscale settings
// ---------------------------------------------------------------------------

const TAILSCALE_FILE = join(CODIBY_DIR,'ui-tailscale.json');

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
  mkdirSync(CODIBY_DIR, { recursive: true });
  writeFileSync(TAILSCALE_FILE, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Global preferences (tabs, groups, etc.)
// ---------------------------------------------------------------------------

const PREFS_FILE = join(CODIBY_DIR,'ui-preferences.json');

export function loadPreferences(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Record<string, unknown>) {
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts — user overrides only (defaults live in the frontend's
// keybinding registry). Stored in a dedicated file so it stays editable by
// hand and separate from UI layout prefs.
// ---------------------------------------------------------------------------

const KEYBINDINGS_FILE = join(CODIBY_DIR, 'keybindings.json');

/** Map of command id → chord (or null to force-unbind). */
export function loadKeybindings(): Record<string, string | null> {
  try {
    const data = JSON.parse(readFileSync(KEYBINDINGS_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveKeybindings(overrides: Record<string, string | null>) {
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(KEYBINDINGS_FILE, JSON.stringify(overrides, null, 2));
  } catch {}
}
