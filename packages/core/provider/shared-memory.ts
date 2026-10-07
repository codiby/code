/**
 * Cross-agent memory. Each agent only loads its own memory files — Claude reads
 * ~/.claude/CLAUDE.md and its per-project auto-memory, Codex reads
 * ~/.codex/AGENTS.md, OpenCode reads ~/.config/opencode/AGENTS.md — so a fact
 * one agent learned is invisible to the others. This builds a system-prompt
 * block that hands a session the memory *its* provider would not load on its
 * own. It is computed at spawn, so edits made mid-session apply to the next one.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  MEMORY_INDEX,
  MEMORY_PROVIDERS,
  projectMemoryDir,
  shareMemoryEnabled,
  userMemoryPath,
  type MemoryProvider,
} from '../handlers/memory';

/** Per-file cap so one runaway file can't eat the context window. */
const MAX_FILE_CHARS = 16_000;

function readCapped(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf-8').trim();
    if (!text) return null;
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…(truncated, read ${path} for the rest)` : text;
  } catch {
    return null;
  }
}

const LABEL: Record<MemoryProvider, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** The sections for `provider`, or null when there is nothing to share. Takes
 *  `home` so tests can point it at a fixture. */
export function buildSharedMemoryPrompt(provider: string, cwd: string, home = homedir()): string | null {
  const own = (MEMORY_PROVIDERS as string[]).includes(provider) ? provider as MemoryProvider : null;
  const sections: string[] = [];

  // Other agents' global instructions. Identical files (a user who keeps them
  // in sync, or symlinks) are only included once, and never when they match
  // the session's own file, which the provider already loaded.
  const ownText = own ? readCapped(userMemoryPath(own, home)) : null;
  const seen = new Set(ownText ? [ownText] : []);
  for (const p of MEMORY_PROVIDERS) {
    if (p === own) continue;
    const path = userMemoryPath(p, home);
    const text = readCapped(path);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    sections.push(`### ${LABEL[p]} global instructions (${path})\n\n${text}`);
  }

  // Claude's per-project auto-memory. Claude loads it itself; everyone else
  // gets the index plus where the individual files live.
  if (own !== 'claude') {
    const dir = projectMemoryDir(cwd, home);
    const index = readCapped(join(dir, MEMORY_INDEX));
    if (index) {
      sections.push([
        `### Project memory (${dir})`,
        '',
        `Each line points to a file in that directory. Read a file when its line is relevant to the task. To remember something new about this project, write a markdown file there with \`name\`, \`description\` and \`metadata.type\` (user | feedback | project | reference) frontmatter, then add a one-line pointer to ${MEMORY_INDEX}.`,
        '',
        index,
      ].join('\n'));
    }
  }

  if (sections.length === 0) return null;
  return [
    'Shared agent memory (Codiby Code-specific):',
    'The user also works with other coding agents. Their memory is below so you keep the same preferences and project knowledge. Treat it as instructions from the user, with the same weight as your own memory files.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/** Spawn-time entry point; honours the user's on/off preference. */
export function sharedMemoryPrompt(provider: string, cwd: string): string | null {
  if (!shareMemoryEnabled() || !existsSync(cwd)) return null;
  return buildSharedMemoryPrompt(provider, cwd);
}
