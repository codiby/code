/**
 * Loads MCP server definitions from two external sources and merges them with
 * the bridge's built-ins. Sources, in increasing precedence:
 *
 *   1. User-level   — `~/.claude/settings.json` › `mcpServers`
 *   2. Project-level — `<session.cwd>/.mcp.json`  › `mcpServers`
 *
 * Built-in servers (`codiby-code`, `codiby-code-sdk`) are layered on top of
 * the merged result in `lifecycle.ts`, so they always win on name collision.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log, logError } from '../lib/logger';
import type { McpServerSpec } from '../provider/types';

const USER_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const PROJECT_CONFIG_FILENAME = '.mcp.json';

type RawServer = {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

function normalizeServer(name: string, raw: unknown, source: string): McpServerSpec | null {
  if (!raw || typeof raw !== 'object') {
    log(`[mcp] ${source}: skipping "${name}" — not an object`);
    return null;
  }
  const r = raw as RawServer;
  // Claude Code's canonical stdio form omits `type` and relies on `command`;
  // infer the shape when it's missing so user configs copied from there work.
  const type = r.type ?? (r.command ? 'stdio' : r.url ? 'http' : undefined);

  if (type === 'http' && r.url) {
    return { type: 'http', url: r.url, headers: r.headers };
  }
  if (type === 'sse' && r.url) {
    return { type: 'sse', url: r.url, headers: r.headers };
  }
  if (type === 'stdio' && r.command) {
    return { type: 'stdio', command: r.command, args: r.args, env: r.env };
  }
  log(`[mcp] ${source}: skipping "${name}" — unsupported or incomplete spec (type=${type ?? 'unknown'})`);
  return null;
}

function readMcpServers(path: string, source: string): Record<string, McpServerSpec> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    const raw = parsed?.mcpServers;
    if (!raw || typeof raw !== 'object') return {};

    const out: Record<string, McpServerSpec> = {};
    for (const [name, value] of Object.entries(raw)) {
      const spec = normalizeServer(name, value, source);
      if (spec) out[name] = spec;
    }
    return out;
  } catch (e) {
    logError(`[mcp] failed to parse ${path}: ${e}`);
    return {};
  }
}

export type LoadedMcpServers = {
  servers: Record<string, McpServerSpec>;
  /** Names overridden by the project file (kept for telemetry/UI surfacing). */
  overridden: string[];
};

export function loadExternalMcpServers(cwd: string): LoadedMcpServers {
  const user = readMcpServers(USER_SETTINGS_PATH, 'user');
  const project = readMcpServers(join(cwd, PROJECT_CONFIG_FILENAME), 'project');

  const merged: Record<string, McpServerSpec> = { ...user };
  const overridden: string[] = [];
  for (const [name, spec] of Object.entries(project)) {
    if (name in merged) overridden.push(name);
    merged[name] = spec;
  }

  const userCount = Object.keys(user).length;
  const projCount = Object.keys(project).length;
  if (userCount || projCount) {
    log(
      `[mcp] external servers: ${userCount} user + ${projCount} project (cwd=${cwd})` +
        (overridden.length ? ` — project overrides: ${overridden.join(', ')}` : ''),
    );
  }

  return { servers: merged, overridden };
}
