/**
 * Slash commands (skills included) for a folder, without a session's
 * provider running. A session that hasn't been sent a message doesn't spawn
 * Claude, but the composer's `/` picker should still be full — so this asks a
 * short-lived Claude for the list over the SDK's initialize handshake (no
 * prompt, no turn), kills it, and caches the answer per folder.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_BIN } from '../config/config';

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

const cache = new Map<string, { at: number; commands: Promise<string[]> }>();

/** A prompt stream that never yields: the CLI initializes, no turn starts. */
async function* idle(): AsyncGenerator<SDKUserMessage> {
  await new Promise<never>(() => {});
}

async function probe(cwd: string): Promise<string[]> {
  const abortController = new AbortController();
  const q = query({ prompt: idle(), options: { cwd, pathToClaudeCodeExecutable: CLAUDE_BIN, abortController } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('slash probe timed out')), TIMEOUT_MS); }),
    ]);
    return commands.map(c => c.name);
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

export function claudeSlashCommands(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.commands;
  const commands = probe(cwd);
  cache.set(cwd, { at: Date.now(), commands });
  // A failed probe isn't cached: the next fresh session tries again.
  commands.catch(() => { if (cache.get(cwd)?.commands === commands) cache.delete(cwd); });
  return commands;
}
