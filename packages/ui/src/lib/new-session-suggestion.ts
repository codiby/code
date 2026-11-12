/**
 * The agent's "this deserves its own session" offer (`suggest_new_session`,
 * see packages/core/session/new-session-suggestion.ts), read back out of the
 * transcript like the archive pill. The card stands while the call is the
 * latest thing in the session and the user hasn't answered it. Answered ids
 * live in localStorage so the main window and the bubbles agree.
 */
import { useSyncExternalStore } from 'react';
import type { ChatMessage } from './claude-client';

export interface NewSessionSuggestion {
  /** The tool call's message id — also the dismissal key. */
  id: string;
  title: string;
  reason: string;
  prompt: string;
  /** Folder for the new session; null = the current session's. */
  cwd: string | null;
}

/** `mcp__codiby-code-sdk__suggest_new_session` or `mcp__codiby-code__ui_suggest_new_session`. */
const SUGGEST_NEW_SESSION = /(^|__)(ui_)?suggest_new_session$/;

export function isSuggestNewSessionTool(name: string | undefined): boolean {
  return !!name && SUGGEST_NEW_SESSION.test(name);
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * The offer still standing at the end of `messages`: the last
 * `suggest_new_session` call with no user message after it. A failed call, or
 * one missing its title or prompt, offers nothing.
 */
export function pendingNewSessionSuggestion(messages: ChatMessage[]): NewSessionSuggestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.isToolResult) return null;
    if (m.isToolResult || !isSuggestNewSessionTool(m.toolName)) continue;
    if (m.toolResult?.isError) return null;
    const input = (m.toolInput ?? {}) as Record<string, unknown>;
    const title = str(input.title);
    const prompt = str(input.prompt);
    if (!title || !prompt) return null;
    return { id: m.id, title, prompt, reason: str(input.reason), cwd: str(input.cwd) || null };
  }
  return null;
}

const STORAGE_KEY = 'codiby-new-session-answered';
const MAX_ANSWERED = 200;
const listeners = new Set<() => void>();

function readAnswered(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let snapshot = readAnswered().join('\n');

function refresh() {
  const next = readAnswered().join('\n');
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach(l => l());
}

/** The user answered the card (either button): it doesn't come back. */
export function answerNewSessionSuggestion(id: string): void {
  const list = readAnswered().filter(x => x !== id);
  list.push(id);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_ANSWERED))); } catch {}
  refresh();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) refresh(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** The offer to show for a session right now, or null. Hidden while the
 *  agent is still working. */
export function useNewSessionSuggestion(
  messages: ChatMessage[],
  opts: { streaming: boolean },
): NewSessionSuggestion | null {
  const answered = useSyncExternalStore(subscribe, () => snapshot);
  if (opts.streaming) return null;
  const s = pendingNewSessionSuggestion(messages);
  if (!s || answered.split('\n').includes(s.id)) return null;
  return s;
}

/** First message of the new session: the agent's brief, plus where it came
 *  from so the new agent can read the source session if it needs more. */
export function seededPrompt(s: NewSessionSuggestion, source: { id: string; name: string }): string {
  return `${s.prompt}\n\n_Started from [${source.name}](codiby-session:${source.id})._`;
}
