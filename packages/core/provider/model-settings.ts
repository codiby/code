import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** The Claude CLI fallback belongs to the session's host, not the SDK model
 * catalogue. Keep this separate from Codiby's explicit defaultModels setting. */
export async function claudeSettingsModel(
  cwd: string,
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (env.ANTHROPIC_MODEL?.trim()) return env.ANTHROPIC_MODEL.trim();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  let model: string | null = null;
  for (const path of [
    join(configDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')).model;
      if (typeof value === 'string' && value.trim()) model = value.trim();
    } catch { /* Missing or malformed settings must not break session discovery. */ }
  }
  return model;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { model: string | null; at: number }>();
const pending = new Map<string, Promise<void>>();

/** Never blocks: returns the last model read for `cwd` (null until the first
 * read lands) and refreshes it in the background, calling `onChange` when it
 * moves. sessionToJSON runs for every session on every list, and a sync read
 * under a macOS privacy-protected folder (~/Desktop, ~/Documents) parks the
 * whole server in open() waiting on a TCC prompt the bun sidecar can't show —
 * the port stays open but nothing ever answers. */
export function cachedClaudeSettingsModel(cwd: string, onChange?: () => void): string | null {
  const hit = cache.get(cwd);
  if ((!hit || Date.now() - hit.at > CACHE_TTL_MS) && !pending.has(cwd)) {
    pending.set(cwd, claudeSettingsModel(cwd)
      .then((model) => {
        cache.set(cwd, { model, at: Date.now() });
        if (model !== (hit?.model ?? null)) onChange?.();
      })
      .finally(() => pending.delete(cwd)));
  }
  return hit?.model ?? null;
}

/** Test hook: resolves once the background read for `cwd` has landed. */
export function settledClaudeSettingsModel(cwd: string): Promise<void> {
  return pending.get(cwd) ?? Promise.resolve();
}
