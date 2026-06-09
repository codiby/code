/**
 * Swagger UI docs server.
 *
 * A second, decoupled `Bun.serve` (default port 3112) that documents the bridge
 * API. Booted automatically from `server/index.ts` whenever the bridge starts,
 * so the docs are always available alongside a running API — set
 * `CODIBY_SWAGGER=0` to skip, or `CODIBY_SWAGGER_PORT` to relocate it.
 *
 * Serves:
 *   GET /              → Swagger UI (HTML shell, assets from swagger-ui-dist)
 *   GET /openapi.json  → the spec, with servers[0].url pinned to the live bridge
 *   GET /health        → { ok: true }  (readiness probe for curl)
 *   GET /<asset>       → swagger-ui-dist static files (offline, no CDN)
 *
 * Asset resolution (dev + packaged):
 *   1. process.env.CODIBY_SWAGGER_DIST  — set by the Electron shell to the
 *      bundled `swagger-ui-dist` under resourcesPath (packaged build).
 *   2. require('swagger-ui-dist').getAbsoluteFSPath()  — dev, via node_modules.
 */

import { join, normalize } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { log, logError } from './logger';
import { openApiSpec } from './openapi-spec';

const require = createRequire(import.meta.url);

const DEFAULT_PORT = 3112;

/** Locate the swagger-ui-dist asset directory, or null if unavailable. */
function resolveDistDir(): string | null {
  const fromEnv = process.env.CODIBY_SWAGGER_DIST;
  if (fromEnv && existsSync(join(fromEnv, 'swagger-ui-bundle.js'))) return fromEnv;
  try {
    const dir = require('swagger-ui-dist').getAbsoluteFSPath() as string;
    if (existsSync(join(dir, 'swagger-ui-bundle.js'))) return dir;
  } catch {
    // not installed / bundled — handled by caller
  }
  return null;
}

/** Minimal HTML shell that boots Swagger UI against /openapi.json. */
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codiby Code — API Docs</title>
  <link rel="stylesheet" href="./swagger-ui.css" />
  <link rel="icon" type="image/png" href="./favicon-32x32.png" sizes="32x32" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="./swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="./swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: './openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;

/** Strip the leading slash and guard against path traversal. */
function safeAssetName(pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, '');
  if (!rel) return null;
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.includes('/../') || norm.includes('\0')) return null;
  return norm;
}

/**
 * Start the docs server. `apiPort` is the live bridge port — it is written into
 * the served spec so Swagger UI's "Try it out" hits the real API, not 3112.
 * Tolerant: never throws; logs and returns null on failure so a docs problem
 * can't take down the bridge.
 */
export function startSwaggerServer(apiPort: number) {
  if (process.env.CODIBY_SWAGGER === '0') {
    log('[swagger] disabled via CODIBY_SWAGGER=0');
    return null;
  }

  const port = parseInt(process.env.CODIBY_SWAGGER_PORT || String(DEFAULT_PORT), 10);
  const distDir = resolveDistDir();
  if (!distDir) {
    logError('[swagger] swagger-ui-dist assets not found; docs UI unavailable (spec still served if it boots)');
  }

  // Spec is shared/frozen-ish; clone the servers entry so we can pin the live
  // bridge URL without mutating the module-level object across calls.
  const spec = { ...openApiSpec, servers: [{ url: `http://localhost:${apiPort}`, description: 'Local bridge' }] };
  const specJson = JSON.stringify(spec);

  try {
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === '/health') {
          return Response.json({ ok: true, apiPort });
        }
        if (path === '/openapi.json') {
          return new Response(specJson, { headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/' || path === '/index.html') {
          return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        // Static swagger-ui-dist asset.
        if (distDir) {
          const asset = safeAssetName(path);
          if (asset) {
            const file = Bun.file(join(distDir, asset));
            if (await file.exists()) return new Response(file);
          }
        }
        return new Response('Not found', { status: 404 });
      },
    });

    log(`[swagger] API docs at http://localhost:${server.port} (spec → :${apiPort}, assets ${distDir ? 'offline' : 'MISSING'})`);
    return server;
  } catch (err) {
    logError(`[swagger] failed to start on port ${port}:`, err);
    return null;
  }
}

// Allow running the docs server standalone for quick iteration:
//   bun run server/swagger.ts          → docs on 3112, spec points at :3111
//   CODIBY_SWAGGER_PORT=4000 bun run server/swagger.ts
if (import.meta.main) {
  const apiPort = parseInt(process.env.CLAUDE_UI_PORT || '3111', 10);
  startSwaggerServer(apiPort);
}
