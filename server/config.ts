import { homedir } from 'os';
import { join } from 'path';

export const PORT = parseInt(process.env.PORT || '3100', 10);
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const CWD = process.env.CLAUDE_CWD || process.cwd();
export const SESSIONS_FILE = join(homedir(), '.claude', 'ui-sessions.json');

export const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit']);

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
