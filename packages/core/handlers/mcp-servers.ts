/**
 * MCP server CRUD over the same two config files the loader reads
 * (see ../mcp-config.ts):
 *
 *   - scope "user"    → ~/.claude/settings.json  › mcpServers
 *   - scope "project" → <cwd>/.mcp.json          › mcpServers
 *
 * The UI surfaces a merged, read-friendly list (GET), and writes a single
 * entry at a time (POST add / DELETE remove). Built-in bridge servers
 * (`codiby-code`, `codiby-code-sdk`) are layered on top at spawn time in
 * lifecycle.ts and are NOT stored in these files — we synthesise them into the
 * list as non-removable rows so the user sees the full picture without being
 * able to break the bridge's own wiring.
 *
 * Changes here only take effect on the next provider spawn, so callers should
 * suggest a session restart after a successful add/remove.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { corsHeaders, PORT } from '../config/config';
import { log, logError } from '../lib/logger';

const USER_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const PROJECT_CONFIG_FILENAME = '.mcp.json';

/** Names owned by the bridge — injected at spawn, not stored in config. */
const BUILTIN_NAMES = new Set(['codiby-code', 'codiby-code-sdk']);

type Scope = 'user' | 'project';

type RawServer = {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Where a given scope's mcpServers live. Project scope needs a cwd. */
function configPathFor(scope: Scope, cwd?: string | null): string | null {
  if (scope === 'project') {
    if (!cwd) return null;
    return join(cwd, PROJECT_CONFIG_FILENAME);
  }
  return USER_SETTINGS_PATH;
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
  } catch (e) {
    logError(`[mcp] failed to parse ${path}: ${e}`);
    return {};
  }
}

function readServers(path: string): Record<string, RawServer> {
  const parsed = readJson(path);
  const raw = parsed?.mcpServers;
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, RawServer>;
}

/** Normalise a raw entry into the shape the UI renders. Mirrors the type
 *  inference in mcp-config.normalizeServer so the list matches what actually
 *  loads. */
function describe(name: string, raw: RawServer, source: Scope | 'builtin', removable: boolean) {
  const type = raw.type ?? (raw.command ? 'stdio' : raw.url ? 'http' : 'unknown');
  return {
    name,
    type,
    url: raw.url,
    command: raw.command,
    args: raw.args,
    source,
    removable,
  };
}

export type McpServerView = ReturnType<typeof describe>;

/**
 * GET /mcp-servers?cwd=…
 * Returns the merged, deduped server list: built-ins first, then user, then
 * project (project overrides user on name collision, matching loader
 * precedence). Each row carries `source` + `removable` so the UI knows what it
 * may delete.
 */
export function handleListMcpServers(cwd?: string | null): Response {
  try {
    const out: McpServerView[] = [];
    const seen = new Set<string>();

    // Built-ins — synthesised, non-removable.
    out.push(describe('codiby-code', { type: 'http', url: `http://localhost:${PORT}/mcp` }, 'builtin', false));
    out.push(describe('codiby-code-sdk', { type: 'sdk' }, 'builtin', false));
    seen.add('codiby-code');
    seen.add('codiby-code-sdk');

    const user = readServers(USER_SETTINGS_PATH);
    const project = cwd ? readServers(join(cwd, PROJECT_CONFIG_FILENAME)) : {};

    for (const [name, raw] of Object.entries(user)) {
      if (BUILTIN_NAMES.has(name)) continue; // bridge owns these — already listed
      out.push(describe(name, raw, 'user', true));
      seen.add(name);
    }
    for (const [name, raw] of Object.entries(project)) {
      if (BUILTIN_NAMES.has(name)) continue;
      // Project overrides a same-named user entry.
      const existingIdx = out.findIndex(s => s.name === name && s.source === 'user');
      const row = describe(name, raw, 'project', true);
      if (existingIdx >= 0) out[existingIdx] = row;
      else out.push(row);
    }

    return Response.json(out, { headers: corsHeaders });
  } catch (e) {
    logError(`[mcp] list failed: ${e}`);
    return Response.json({ error: String(e) }, { status: 500, headers: corsHeaders });
  }
}

/** Validate + normalise the spec the UI submits into a storable raw entry. */
function buildSpec(body: any): { ok: true; spec: RawServer } | { ok: false; error: string } {
  const type = body?.type;
  if (type === 'stdio') {
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) return { ok: false, error: 'stdio servers need a command' };
    const spec: RawServer = { type: 'stdio', command };
    if (Array.isArray(body.args) && body.args.length) spec.args = body.args.map(String);
    if (body.env && typeof body.env === 'object' && Object.keys(body.env).length) spec.env = body.env;
    return { ok: true, spec };
  }
  if (type === 'http' || type === 'sse') {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return { ok: false, error: `${type} servers need a url` };
    const spec: RawServer = { type, url };
    if (body.headers && typeof body.headers === 'object' && Object.keys(body.headers).length) spec.headers = body.headers;
    return { ok: true, spec };
  }
  return { ok: false, error: `unsupported type "${type}"` };
}

/**
 * POST /mcp-servers
 * Body: { scope: 'user'|'project', name, type, command?, args?, url?, headers?, env?, cwd? }
 */
export async function handleAddMcpServer(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const scope: Scope = body?.scope === 'project' ? 'project' : 'user';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';

    if (!name) return Response.json({ ok: false, error: 'name required' }, { status: 400, headers: corsHeaders });
    if (BUILTIN_NAMES.has(name)) {
      return Response.json({ ok: false, error: `"${name}" is a reserved built-in name` }, { status: 400, headers: corsHeaders });
    }

    const path = configPathFor(scope, body?.cwd);
    if (!path) return Response.json({ ok: false, error: 'project scope requires cwd' }, { status: 400, headers: corsHeaders });

    const built = buildSpec(body);
    if (!built.ok) return Response.json({ ok: false, error: built.error }, { status: 400, headers: corsHeaders });

    const settings = readJson(path);
    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') settings.mcpServers = {};
    settings.mcpServers[name] = built.spec;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    log(`[mcp] added "${name}" (${built.spec.type}) to ${path}`);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e) {
    logError(`[mcp] add failed: ${e}`);
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: corsHeaders });
  }
}

/**
 * DELETE /mcp-servers/:name?scope=…&cwd=…
 */
export function handleRemoveMcpServer(name: string, scope: Scope, cwd?: string | null): Response {
  try {
    if (BUILTIN_NAMES.has(name)) {
      return Response.json({ ok: false, error: `"${name}" is a built-in and cannot be removed` }, { status: 400, headers: corsHeaders });
    }
    const path = configPathFor(scope, cwd);
    if (!path) return Response.json({ ok: false, error: 'project scope requires cwd' }, { status: 400, headers: corsHeaders });
    if (!existsSync(path)) return Response.json({ ok: true }, { headers: corsHeaders });

    const settings = readJson(path);
    if (settings.mcpServers && typeof settings.mcpServers === 'object' && name in settings.mcpServers) {
      delete settings.mcpServers[name];
      writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
      log(`[mcp] removed "${name}" from ${path}`);
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e) {
    logError(`[mcp] remove failed: ${e}`);
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: corsHeaders });
  }
}
