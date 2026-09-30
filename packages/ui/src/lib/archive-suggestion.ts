/**
 * The agent's "this task looks done" hint (`suggest_archive` tool, see
 * packages/core/session/archive-suggestion.ts), read back out of the
 * transcript. Nothing is stored on the bridge: the pill shows while the call
 * is the latest thing in the session and the user hasn't answered or waved it
 * away. Dismissals live in localStorage so the main window and the floating
 * bubbles agree on them.
 */
import { useSyncExternalStore } from 'react';
import type { ChatMessage } from './claude-client';

export interface ArchiveSuggestion {
  /** The tool call's message id — also the dismissal key. */
  id: string;
  reason: string;
}

/** `mcp__codiby-code-sdk__suggest_archive` or `mcp__codiby-code__ui_suggest_archive`. */
const SUGGEST_ARCHIVE = /(^|__)(ui_)?suggest_archive$/;

export function isSuggestArchiveTool(name: string | undefined): boolean {
  return !!name && SUGGEST_ARCHIVE.test(name);
}

/**
 * The suggestion still standing at the end of `messages`: the last
 * `suggest_archive` call with no user message after it. A failed call, or one
 * without a reason, suggests nothing.
 */
export function pendingArchiveSuggestion(messages: ChatMessage[]): ArchiveSuggestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.isToolResult) return null;
    if (m.isToolResult || !isSuggestArchiveTool(m.toolName)) continue;
    if (m.toolResult?.isError) return null;
    const reason = (m.toolInput as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' && reason.trim() ? { id: m.id, reason: reason.trim() } : null;
  }
  return null;
}

const STORAGE_KEY = 'codiby-archive-dismissed';
const MAX_DISMISSED = 200;
const listeners = new Set<() => void>();

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let snapshot = readDismissed().join('\n');

function refresh() {
  const next = readDismissed().join('\n');
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach(l => l());
}

export function dismissArchiveSuggestion(id: string): void {
  const list = readDismissed().filter(x => x !== id);
  list.push(id);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_DISMISSED))); } catch {}
  refresh();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Another window (the bubbles overlay, a second main window) dismissed one.
  const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) refresh(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** The suggestion to show for a session right now, or null. Hidden while the
 *  agent is still working and while the user has something typed. */
export function useArchiveSuggestion(
  messages: ChatMessage[],
  opts: { streaming: boolean; typing: boolean },
): ArchiveSuggestion | null {
  const dismissed = useSyncExternalStore(subscribe, () => snapshot);
  if (opts.streaming || opts.typing) return null;
  const s = pendingArchiveSuggestion(messages);
  if (!s || dismissed.split('\n').includes(s.id)) return null;
  return s;
}
