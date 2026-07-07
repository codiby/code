/**
 * Ensures the MCP server config exists in ~/.claude/settings.json
 * Called at bridge server startup.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log } from './logger';
import { PORT } from './config';

const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');
const MCP_SERVER_NAME = 'codiby-code';

export function ensureMcpConfig() {
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });

    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {}

    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    const expected = {
      type: 'http',
      url: `http://localhost:${PORT}/mcp`,
    };

    const existing = settings.mcpServers[MCP_SERVER_NAME];
    const needsUpdate = !existing
      || existing.type !== expected.type
      || existing.url !== expected.url;

    if (needsUpdate) {
      settings.mcpServers[MCP_SERVER_NAME] = expected;
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      log(`[mcp] Updated MCP config in ${SETTINGS_FILE} → ${expected.url}`);
    } else {
      log(`[mcp] MCP config already up to date`);
    }
  } catch (e) {
    log(`[mcp] Failed to ensure MCP config: ${e}`);
  }
}
