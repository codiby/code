/**
 * Cached Claude model list.
 *
 * The Claude Agent SDK's `runtime.supportedModels()` is the source of truth
 * for which models the user can pick. It's session-bound — to surface those
 * models in pickers that exist outside a live session (project settings,
 * new-session modals, the mobile composer when no session is active), we
 * snapshot the list whenever any session reports it and persist it to disk
 * so the choice survives bridge restarts.
 *
 * Cache lifecycle:
 *   - On boot, `loadClaudeModelsFromDisk()` rehydrates from
 *     `~/.codiby/ui-claude-models.json`.
 *   - Every time `ClaudeAdapter` fires `onModelsAvailable`, the bridge calls
 *     `setClaudeModels(models)` here, refreshing memory + disk.
 *   - The HTTP endpoint `/providers/claude/info` reads from memory.
 *
 * If the cache is empty (first ever launch, no Claude session has booted
 * yet), pickers render with no Claude-specific options. By design — the
 * user wants zero hardcoded fallback.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config';
import type { ProviderModelInfo } from '../provider/types';

const CACHE_FILE = join(CODIBY_DIR, 'ui-claude-models.json');

let cached: ProviderModelInfo[] | null = null;

function readDisk(): ProviderModelInfo[] | null {
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (!Array.isArray(data)) return null;
    return data.filter((m): m is ProviderModelInfo =>
      m && typeof m === 'object' && typeof m.id === 'string' && typeof m.label === 'string',
    );
  } catch {
    return null;
  }
}

function writeDisk(models: ProviderModelInfo[]) {
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(models, null, 2));
  } catch {}
}

function modelsEqual(a: ProviderModelInfo[], b: ProviderModelInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.label !== y.label || (x.description || '') !== (y.description || '')) return false;
  }
  return true;
}

export function getClaudeModels(): ProviderModelInfo[] {
  if (cached !== null) return cached;
  cached = readDisk() ?? [];
  return cached;
}

export function setClaudeModels(models: ProviderModelInfo[]) {
  const next = models.slice();
  const prev = getClaudeModels();
  if (modelsEqual(prev, next)) return;
  cached = next;
  writeDisk(next);
}

export function getClaudeInfo(): { models: ProviderModelInfo[] } {
  return { models: getClaudeModels() };
}
