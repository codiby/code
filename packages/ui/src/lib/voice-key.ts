/**
 * The ElevenLabs key in Settings → Voice mode is write-only: GET
 * /voice/settings answers `elevenlabs.configured` instead of the key, and a
 * PUT without `apiKey` keeps the saved one. Bridges from before that change
 * still return the key and save whatever comes back (an empty value wipes
 * it), so for them the key they gave is sent back unchanged.
 */

export type ElevenLabsKeyState = {
  configured: boolean;
  /** Set only for a bridge that still returns the key. */
  legacy: { key: string } | null;
};

export function elevenLabsKeyState(elevenlabs: unknown): ElevenLabsKeyState {
  const el = (elevenlabs && typeof elevenlabs === 'object' ? elevenlabs : {}) as { apiKey?: unknown; configured?: unknown };
  if (typeof el.apiKey === 'string') return { configured: el.apiKey.trim().length > 0, legacy: { key: el.apiKey } };
  return { configured: el.configured === true, legacy: null };
}

/** The `apiKey` part of a save: a typed key replaces, an empty field keeps the saved one. */
export function elevenLabsKeyForSave(typed: string, legacy: ElevenLabsKeyState['legacy']): { apiKey?: string } {
  const key = typed.trim() || legacy?.key || '';
  return key ? { apiKey: key } : {};
}

/** "Clear key": `clearApiKey` for current bridges, `apiKey: ''` for older ones. */
export const ELEVENLABS_CLEAR_KEY = { apiKey: '', clearApiKey: true } as const;
