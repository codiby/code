/**
 * User-chosen default model per provider (`/default <model>` in the composer).
 *
 * Stored in ui-preferences.json as `defaultModels: { claude?, codex?, opencode? }`.
 * A session whose own `model` is null runs on this default; when no default
 * is set for its provider, the provider picks (null all the way down).
 */
import { loadPreferences } from '../session/storage';

export function getDefaultModels(prefs: Record<string, unknown> = loadPreferences()): Record<string, string> {
  const raw = prefs.defaultModels;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()),
  );
}

/** The model a session should actually run: its own pick, else the user's
 *  default for its provider, else null (provider default). */
export function effectiveModel(session: { model: string | null; provider?: string }): string | null {
  return session.model || getDefaultModels()[session.provider || 'claude'] || null;
}
