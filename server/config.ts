import { homedir } from 'os';
import { join } from 'path';

export const PORT = parseInt(process.env.CLAUDE_UI_PORT || '3111', 10);
// Resolve claude binary — check common locations if not in PATH
const findClaude = (): string => {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.HOME || '';
  const candidates = [
    `${home}/.local/bin/claude`,
    `${home}/.claude/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    try { if (require('fs').existsSync(p)) return p; } catch {}
  }
  return 'claude';
};
export const CLAUDE_BIN = findClaude();
export const CWD = process.env.CLAUDE_CWD || process.cwd();
export const SESSIONS_FILE = join(homedir(), '.claude', 'ui-sessions.json');

export const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit']);

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
