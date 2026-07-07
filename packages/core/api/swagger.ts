/**
 * Swagger UI API docs.
 *
 * Mounted on the bridge itself as a Hono sub-app under `/docs`, so the docs are
 * served from the same port as the API (default 3111) — no second server, no
 * second port. `createDocsApp` builds the sub-app; `server/index.ts` mounts it
 * with `app.route('/docs', createDocsApp(() => server.port))`.
 *
 * Routes (relative to the mount base, e.g. `/docs`):
 *   GET  /              → Swagger UI (HTML shell, assets from swagger-ui-dist)
 *   GET  /openapi.json  → the spec, with servers[0].url pinned to the live bridge
 *   GET  /health        → { ok: true, apiPort }  (readiness probe for curl)
 *   GET  /<asset>       → swagger-ui-dist static files (offline, no CDN)
 *
 * Asset resolution (dev + packaged):
 *   1. process.env.CODIBY_SWAGGER_DIST  — set by the Electron shell to the
 *      bundled `swagger-ui-dist` under resourcesPath (packaged build).
 *   2. require('swagger-ui-dist').getAbsoluteFSPath()  — dev, via node_modules.
 *
 * `startSwaggerServer` remains for standalone dev use (the `scripts/swagger-docs.sh`
 * launcher and `bun run server/swagger.ts`) — it serves the same sub-app from its
 * own `Bun.serve` on `CODIBY_SWAGGER_PORT` (default 3112).
 */

import { join, normalize } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { Hono } from 'hono';
import { log, logError } from '../lib/logger';
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

/**
 * Minimal HTML shell that boots Swagger UI against `<base>/openapi.json`. Uses
 * absolute URLs prefixed with the mount base so it works whether the page is
 * loaded at `/docs` or `/docs/`.
 */
function indexHtml(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codiby Code — API Docs</title>
  <link rel="stylesheet" href="${base}/swagger-ui.css" />
  <link rel="icon" type="image/png" href="${base}/favicon-32x32.png" sizes="32x32" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${base}/swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="${base}/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '${base}/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;
}

/** Strip the leading slash and guard against path traversal. */
function safeAssetName(pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, '');
  if (!rel) return null;
  const norm = normalize(rel);
  if (norm.startsWith('..') || norm.includes('/../') || norm.includes('\0')) return null;
  return norm;
}

/**
 * Build the docs sub-app. `getApiPort` is read per request so the spec's
 * `servers[0].url` always points at the live bridge port (which may differ from
 * the configured one when PORT=0). `base` is the absolute mount path used to
 * build the HTML's asset URLs — `/docs` when mounted on the bridge, `''` when
 * served standalone from its own root.
 *
 * Tolerant: missing swagger-ui-dist assets only disable the UI; the spec and
 * `/openapi.json` still serve.
 */
export function createDocsApp(getApiPort: () => number, base = '/docs'): Hono {
  const distDir = resolveDistDir();
  if (!distDir) {
    logError('[swagger] swagger-ui-dist assets not found; docs UI unavailable (spec still served)');
  }

  const specFor = (apiPort: number) =>
    JSON.stringify({ ...openApiSpec, servers: [{ url: `http://localhost:${apiPort}`, description: 'Local bridge' }] });

  const app = new Hono();

  app.get('/', (c) => c.html(indexHtml(base)));
  app.get('/index.html', (c) => c.html(indexHtml(base)));
  app.get('/openapi.json', () =>
    new Response(specFor(getApiPort()), { headers: { 'Content-Type': 'application/json' } }));
  app.get('/health', () => Response.json({ ok: true, apiPort: getApiPort() }));

  // Static swagger-ui-dist asset (flat files, no subdirectories).
  app.get('/:asset', async (c) => {
    if (!distDir) return new Response('Not found', { status: 404 });
    const asset = safeAssetName(c.req.param('asset'));
    if (asset) {
      const file = Bun.file(join(distDir, asset));
      if (await file.exists()) return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  });

  return app;
}

/**
 * Standalone docs server for quick iteration — serves the same sub-app from its
 * own `Bun.serve`. `apiPort` is the live bridge port the spec should point at.
 * Tolerant: never throws; logs and returns null on failure.
 *
 * The bridge no longer calls this — it mounts `createDocsApp` on its own Hono
 * app instead. Kept for `scripts/swagger-docs.sh` and `bun run server/swagger.ts`.
 */
export function startSwaggerServer(apiPort: number) {
  if (process.env.CODIBY_SWAGGER === '0') {
    log('[swagger] disabled via CODIBY_SWAGGER=0');
    return null;
  }

  const port = parseInt(process.env.CODIBY_SWAGGER_PORT || String(DEFAULT_PORT), 10);
  const app = createDocsApp(() => apiPort, '');

  try {
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });
    log(`[swagger] standalone API docs at http://localhost:${server.port} (spec → :${apiPort})`);
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
