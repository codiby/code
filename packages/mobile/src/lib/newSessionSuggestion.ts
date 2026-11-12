import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ChatMessage } from '../api/types';

/**
 * La oferta del agente de «esto merece su propia sesión»
 * (`suggest_new_session`, ver packages/core/session/new-session-suggestion.ts),
 * leída del propio historial, igual que en el escritorio: sigue en pie
 * mientras la llamada sea lo último y nadie le haya contestado.
 */
export interface NewSessionSuggestion {
  /** Id del mensaje de la llamada; también la clave de «ya contestada». */
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly prompt: string;
  /** Carpeta de la sesión nueva; `null` = la de esta. */
  readonly cwd: string | null;
}

const SUGGEST_NEW_SESSION = /(^|__)(ui_)?suggest_new_session$/;

export function isSuggestNewSessionTool(name: string | null | undefined): boolean {
  return typeof name === 'string' && SUGGEST_NEW_SESSION.test(name);
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** La última oferta sin un mensaje tuyo detrás, o `null`. */
export function pendingNewSessionSuggestion(
  messages: readonly ChatMessage[],
): NewSessionSuggestion | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user' && message.isToolResult !== true) {
      return null;
    }
    if (message.isToolResult === true || !isSuggestNewSessionTool(message.toolName)) {
      continue;
    }
    const input = message.toolInput ?? {};
    const title = str(input.title);
    const prompt = str(input.prompt);
    if (title.length === 0 || prompt.length === 0) {
      return null;
    }
    return {
      id: message.id,
      title,
      prompt,
      reason: str(input.reason),
      cwd: str(input.cwd) || null,
    };
  }
  return null;
}

/** Primer mensaje de la sesión nueva: el encargo, y de dónde viene. */
export function seededPrompt(
  suggestion: NewSessionSuggestion,
  source: { readonly id: string; readonly name: string },
): string {
  return `${suggestion.prompt}\n\n_Started from [${source.name}](codiby-session:${source.id})._`;
}

const STORAGE_KEY = 'codiby.new-session-answered';
const MAX_ANSWERED = 200;

export async function loadAnsweredSuggestions(): Promise<string[]> {
  try {
    const saved: unknown = JSON.parse(
      (await AsyncStorage.getItem(STORAGE_KEY)) ?? '[]',
    );
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function saveAnsweredSuggestion(id: string): Promise<void> {
  const list = (await loadAnsweredSuggestions()).filter(other => other !== id);
  list.push(id);
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(list.slice(-MAX_ANSWERED)),
  ).catch(() => undefined);
}
