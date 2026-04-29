/**
 * Plugin host singleton — loads plugins from `~/.codiby/plugins/<id>/` at
 * bridge startup, dispatches `/plugins/<id>/...` HTTP requests, and exposes
 * registered SDK tools to the in-process `codiby-code-sdk` MCP server.
 *
 * Plugins are sideloaded folders with this layout:
 *
 *   ~/.codiby/plugins/<id>/
 *     plugin.json         (manifest)
 *     dist/server.js      (optional: registers HTTP routes / MCP tools)
 *     dist/ui.js          (optional: served at /plugins/<id>/static/ui.js)
 *     dist/assets/...     (optional: served at /plugins/<id>/static/assets/...)
 *
 * Public API (consumed by `server/index.ts`):
 *   - `loadPlugins(bridge)`         scan + register at startup
 *   - `dispatch(req, url)`          handle a `/plugins/<id>/<path>` request
 *   - `serveStatic(url)`            serve `/plugins/<id>/static/...` files
 *   - `getPluginListEntries()`      payload for `GET /plugins`
 *   - `getSdkToolDefs()`            tools to merge into `codiby-code-sdk`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { pathToFileURL } from 'url';
import { log as bridgeLog } from '../logger';
import {
  PLUGINS_ROOT,
  createPluginServerHost,
  type HostBridgeAdapter,
  type LoadedPluginRuntime,
} from './host-impl';
import type {
  PluginManifest,
  PluginListEntry,
  PluginContributions,
  PluginServerModule,
  RegisteredSdkTool,
} from './types';

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

const registry = new Map<string, LoadedPluginRuntime>();
let bridgeAdapter: HostBridgeAdapter | null = null;

const ID_REGEX = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SUPPORTED_API: ReadonlySet<string> = new Set(['1']);

const STATIC_MIME: Record<string, string> = {
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.map':  'application/json',
};

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

function validateManifest(raw: unknown, sourceLabel: string): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error(`${sourceLabel}: not an object`);
  const m = raw as Partial<PluginManifest>;
  if (typeof m.id !== 'string' || !ID_REGEX.test(m.id)) {
    throw new Error(`${sourceLabel}: invalid id (must match ${ID_REGEX.source})`);
  }
  if (typeof m.name !== 'string' || !m.name) throw new Error(`${sourceLabel}: missing name`);
  if (typeof m.version !== 'string' || !m.version) throw new Error(`${sourceLabel}: missing version`);
  if (!SUPPORTED_API.has(String(m.codibyCodeApi))) {
    throw new Error(`${sourceLabel}: unsupported codibyCodeApi "${m.codibyCodeApi}" (host supports: ${[...SUPPORTED_API].join(',')})`);
  }
  return m as PluginManifest;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadPlugins(bridge: HostBridgeAdapter): Promise<void> {
  bridgeAdapter = bridge;
  if (!existsSync(PLUGINS_ROOT)) {
    bridgeLog(`[plugin-host] no plugins dir at ${PLUGINS_ROOT} — skipping`);
    return;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(PLUGINS_ROOT).filter((name) => {
      try { return statSync(join(PLUGINS_ROOT, name)).isDirectory(); }
      catch { return false; }
    });
  } catch (err) {
    bridgeLog(`[plugin-host] failed to read ${PLUGINS_ROOT}: ${String(err)}`);
    return;
  }

  for (const folder of entries) {
    await loadOnePlugin(folder, bridge);
  }

  bridgeLog(
    `[plugin-host] loaded ${[...registry.values()].filter(r => !r.error).length}/${entries.length} plugins`,
  );
}

async function loadOnePlugin(folderName: string, bridge: HostBridgeAdapter): Promise<void> {
  const dir = join(PLUGINS_ROOT, folderName);
  const manifestPath = join(dir, 'plugin.json');

  let manifest: PluginManifest;
  let buildHash: string;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest = validateManifest(raw, `~/.codiby/plugins/${folderName}/plugin.json`);
    if (manifest.id !== folderName) {
      throw new Error(`manifest id "${manifest.id}" must match folder name "${folderName}"`);
    }
    buildHash = String(statSync(manifestPath).mtimeMs | 0);
  } catch (err) {
    bridgeLog(`[plugin-host] skipping "${folderName}": ${String(err)}`);
    return;
  }

  const runtime: LoadedPluginRuntime = {
    manifest,
    routes: [],
    sdkTools: [],
    intervals: [],
    buildHash,
    error: null,
  };
  registry.set(manifest.id, runtime);

  if (!manifest.server?.entry) {
    bridgeLog(`[plugin-host] "${manifest.id}" has no server entry — UI-only`);
    return;
  }

  const serverPath = join(dir, manifest.server.entry);
  if (!existsSync(serverPath)) {
    runtime.error = `server entry not found: ${manifest.server.entry}`;
    bridgeLog(`[plugin-host] "${manifest.id}" ${runtime.error}`);
    return;
  }

  try {
    const mod = (await import(pathToFileURL(serverPath).href)) as PluginServerModule;
    const register = mod.register ?? mod.default;
    if (typeof register !== 'function') {
      throw new Error(`server entry must export a register function (default or named)`);
    }
    const host = createPluginServerHost(runtime, bridge);
    await register(host);
    bridgeLog(
      `[plugin-host] registered "${manifest.id}" ` +
      `(${runtime.routes.length} routes, ${runtime.sdkTools.length} tools, ${runtime.intervals.length} intervals)`,
    );
  } catch (err) {
    runtime.error = String((err as Error)?.message ?? err);
    bridgeLog(`[plugin-host] "${manifest.id}" register failed: ${runtime.error}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP dispatch
// ---------------------------------------------------------------------------

/**
 * Serve `/plugins/<id>/static/<path>` from `~/.codiby/plugins/<id>/<path>`.
 * Paths in the manifest (e.g. `ui.entry: "dist/ui.js"`) work verbatim as URLs;
 * the host doesn't impose any directory layout on plugins. `plugin.json`
 * itself is excluded from static serving — it would leak permissions metadata.
 */
async function serveStatic(pluginId: string, relPath: string): Promise<Response | null> {
  const runtime = registry.get(pluginId);
  if (!runtime) return null;
  if (relPath === 'plugin.json' || relPath.startsWith('plugin.json/')) return null;
  const dir = join(PLUGINS_ROOT, pluginId);
  const filePath = join(dir, relPath);
  // Defence-in-depth against directory traversal.
  if (!filePath.startsWith(dir + '/') && filePath !== dir) return null;
  if (!existsSync(filePath)) return null;
  const mime = STATIC_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  return new Response(Bun.file(filePath), {
    headers: {
      'Content-Type': mime,
      // Plugin authors iterate; never aggressively cache.
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Match `/plugins/<id>/<path>` against a registered route. Returns null if the
 * pathname does not address a plugin or the plugin has nothing registered for
 * that method/path (caller should fall through to its own 404 logic).
 */
export async function dispatch(req: Request, url: URL): Promise<Response | null> {
  // Already filtered by caller, but be defensive.
  if (!url.pathname.startsWith('/plugins/')) return null;

  const rest = url.pathname.slice('/plugins/'.length);
  const slash = rest.indexOf('/');
  const pluginId = slash === -1 ? rest : rest.slice(0, slash);
  const subPath = slash === -1 ? '/' : rest.slice(slash) || '/';

  if (!pluginId) return null;
  const runtime = registry.get(pluginId);
  if (!runtime) {
    return new Response(`Unknown plugin "${pluginId}"`, { status: 404 });
  }

  // Static asset path: `/plugins/<id>/static/<file>`
  if (subPath.startsWith('/static/')) {
    return await serveStatic(pluginId, subPath.slice('/static/'.length));
  }

  // Match registered routes
  for (const route of runtime.routes) {
    if (route.method !== req.method) continue;
    const m = route.regex.exec(subPath);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? '');
    });
    try {
      const res = await route.handler(req, { params, searchParams: url.searchParams });
      return res;
    } catch (err) {
      bridgeLog(`[plugin-host] "${pluginId}" ${req.method} ${subPath} failed: ${String(err)}`);
      return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(`No handler for ${req.method} /plugins/${pluginId}${subPath}`, { status: 404 });
}

// ---------------------------------------------------------------------------
// Public read APIs (consumed by other parts of the bridge)
// ---------------------------------------------------------------------------

export function getPluginListEntries(): PluginListEntry[] {
  return [...registry.values()].map((r) => ({
    id: r.manifest.id,
    name: r.manifest.name,
    version: r.manifest.version,
    description: r.manifest.description,
    enabled: r.error === null, // Stage 1.9 will wire this to a real on/off toggle
    hasUi: !!r.manifest.ui?.entry,
    hasServer: !!r.manifest.server?.entry,
    buildHash: r.buildHash,
    contributes: (r.manifest.ui?.contributes ?? {}) as PluginContributions,
    error: r.error ?? undefined,
  }));
}

export function getSdkToolDefs(): RegisteredSdkTool[] {
  const all: RegisteredSdkTool[] = [];
  for (const r of registry.values()) {
    if (r.error) continue;
    all.push(...r.sdkTools);
  }
  return all;
}

/** Used by the bridge to detect when broadcast hooks fire before loadPlugins(). */
export function isReady(): boolean {
  return bridgeAdapter !== null;
}

/** Re-export for callers that only need to know *where* plugins live. */
export { PLUGINS_ROOT } from './host-impl';
