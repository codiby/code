/**
 * Read/write Claude Code's `settings.json` files — the same files the
 * Claude CLI loads at startup. We only touch the `hooks` key from this
 * module; everything else (mcpServers, permissions, model, plugin
 * config, etc.) is preserved verbatim so the user can keep editing the
 * file by hand.
 *
 *   global  → ~/.claude/settings.json
 *   project → <cwd>/.claude/settings.json
 *
 * The same nine event names the Claude CLI recognises are passed through
 * unchanged; we don't validate the matcher / command bodies here.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { log } from '../lib/logger';

export type HookScope = 'global' | 'project';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd';

export interface HookCommand {
  type: 'command';
  command: string;
  /** Optional: timeout in seconds before the runner kills the command. */
  timeout?: number;
}

export interface HookEntry {
  /** Tool name (or pattern) the entry applies to. Only meaningful for
   *  PreToolUse / PostToolUse — other events ignore the matcher. */
  matcher?: string;
  hooks: HookCommand[];
}

export type ClaudeHooks = Partial<Record<HookEvent, HookEntry[]>>;

interface ClaudeSettings {
  hooks?: ClaudeHooks;
  [k: string]: unknown;
}

function settingsPath(scope: HookScope, cwd?: string): string {
  if (scope === 'global') return join(homedir(), '.claude', 'settings.json');
  if (!cwd || !isAbsolute(cwd)) throw new Error(`project hooks need an absolute cwd, got: ${JSON.stringify(cwd)}`);
  return join(cwd, '.claude', 'settings.json');
}

function readRaw(path: string): ClaudeSettings {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeRaw(path: string, settings: ClaudeSettings): void {
  mkdirSync(join(path, '..'), { recursive: true });
  // 2-space indent matches what `ensure-mcp-config.ts` writes elsewhere,
  // and what the Claude CLI itself emits.
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

/** Returns the hooks object alongside metadata so the UI can show the
 *  on-disk path and whether the file exists yet. The hooks payload is
 *  always an object (never undefined) so the client can `Object.keys`
 *  safely. */
export function readClaudeHooks(scope: HookScope, cwd?: string): { path: string; exists: boolean; hooks: ClaudeHooks } {
  const path = settingsPath(scope, cwd);
  const exists = existsSync(path);
  const settings = exists ? readRaw(path) : {};
  return { path, exists, hooks: settings.hooks || {} };
}

/** Writes the `hooks` key, preserving everything else in the file. If
 *  the new hooks object is empty, the key is removed entirely (keeps the
 *  file tidy for users who use `settings.json` mostly for other stuff). */
export function writeClaudeHooks(scope: HookScope, cwd: string | undefined, hooks: ClaudeHooks): { path: string } {
  const path = settingsPath(scope, cwd);
  const current = existsSync(path) ? readRaw(path) : {};
  const cleaned: ClaudeHooks = {};
  for (const [event, entries] of Object.entries(hooks) as [HookEvent, HookEntry[]][]) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const validEntries = entries
      .map(e => ({ matcher: e.matcher?.trim() || undefined, hooks: (e.hooks || []).filter(h => h && typeof h.command === 'string' && h.command.trim()) }))
      .filter(e => e.hooks.length > 0);
    if (validEntries.length > 0) cleaned[event] = validEntries;
  }

  if (Object.keys(cleaned).length === 0) {
    delete current.hooks;
  } else {
    current.hooks = cleaned;
  }

  writeRaw(path, current);
  log(`[hooks] Wrote ${Object.keys(cleaned).length} event group(s) to ${path}`);
  return { path };
}
