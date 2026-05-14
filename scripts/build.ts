/**
 * Frontend build driver.
 *
 * - `bun run scripts/build.ts`            one-shot production build (minified)
 * - `bun run scripts/build.ts --watch`    dev watcher (unminified, inline sourcemaps,
 *                                          rebuilds on changes under src/ and public/)
 *
 * Each entry (desktop + mobile) is bundled in its own `Bun.build` call and its
 * HTML shell is hand-written. Bun's multi-HTML entrypoint mode collapses
 * identical CSS across entries into a single asset path, which errors out — so
 * we avoid the HTML loader entirely and drive the two entries independently.
 *
 * Emitted layout (consumed by `server/index.ts` `serveStaticFromDist`):
 *
 *   dist/index.html                     -> GET /
 *   dist/m/index.html                   -> GET /m/
 *   dist/assets/desktop-<name>-<hash>.{js,css,...}
 *   dist/assets/mobile-<name>-<hash>.{js,css,...}
 *   dist/brand/codiby-{logo,isotipo}.svg, /manifest.webmanifest, /sw.js  (from public/)
 */
import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from 'bun-plugin-tailwind';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');

/**
 * Sideloaded plugins must share React identity with the host (see
 * `scripts/runtime/react.js`). We achieve this by:
 *   1. externalising `react` / `react-dom` / `react/jsx-runtime` from BOTH builds, and
 *   2. emitting standalone runtime bundles to `dist/runtime/<name>.js`,
 *   3. wiring an importmap in the HTML shells so bare specifiers resolve to those.
 */
// Bun emits `react/jsx-dev-runtime` in unminified builds and `react/jsx-runtime`
// when minified, so we ship both — the importmap covers either resolution.
// `react-dom` and `react-dom/client` resolve to the same file; the renderer
// state must not be split across two bundles or createPortal/createRoot would
// have independent reconcilers.
const SHARED_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom/client',
];
const IMPORTMAP_JSON = JSON.stringify({
  imports: {
    'react':                  '/runtime/react.js',
    'react-dom':              '/runtime/react-dom.js',
    'react-dom/client':       '/runtime/react-dom.js',
    'react/jsx-runtime':      '/runtime/jsx-runtime.js',
    'react/jsx-dev-runtime':  '/runtime/jsx-dev-runtime.js',
  },
});
const IMPORTMAP_HTML = `    <script type="importmap">${IMPORTMAP_JSON}</script>`;

type EntryCfg = {
  name: 'desktop' | 'mobile';
  entry: string;                  // absolute path to the .tsx entrypoint
  htmlPath: string;               // absolute path where the HTML shell is written
  html: (refs: { js: string; css: string[] }) => string;
};

const DESKTOP_HTML = ({ js, css }: { js: string; css: string[] }) => `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codiby Code</title>
    <link rel="icon" type="image/svg+xml" href="/brand/codiby-isotipo.svg" />
${IMPORTMAP_HTML}
${css.map((href) => `    <link rel="stylesheet" href="${href}" />`).join('\n')}
  </head>
  <body class="bg-base text-zinc-100">
    <div id="root"></div>
    <script type="module" src="${js}"></script>
  </body>
</html>
`;

const MOBILE_HTML = ({ js, css }: { js: string; css: string[] }) => `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Codiby Code" />
    <meta name="theme-color" content="#0a0a0a" />
    <title>Codiby Code</title>
    <link rel="icon" type="image/svg+xml" href="/brand/codiby-isotipo.svg" />
    <link rel="apple-touch-icon" href="/brand/codiby-app-icon.svg" />
    <link rel="manifest" href="/manifest.webmanifest" />
${IMPORTMAP_HTML}
${css.map((href) => `    <link rel="stylesheet" href="${href}" />`).join('\n')}
  </head>
  <body class="bg-zinc-950 text-zinc-100 overscroll-none" style="overscroll-behavior: none;">
    <div id="root"></div>
    <script type="module" src="${js}"></script>
  </body>
</html>
`;

const ENTRIES: EntryCfg[] = [
  {
    name: 'desktop',
    entry: join(ROOT, 'src/index.tsx'),
    htmlPath: join(OUT, 'index.html'),
    html: DESKTOP_HTML,
  },
  {
    name: 'mobile',
    entry: join(ROOT, 'src/m/main.tsx'),
    htmlPath: join(OUT, 'm/index.html'),
    html: MOBILE_HTML,
  },
];

async function buildEntry(cfg: EntryCfg) {
  // All JS/CSS land under `dist/assets/` so the server's `/assets/*` public
  // route serves them. `publicPath` must match that URL prefix, because Bun
  // constructs chunk import URLs as `publicPath + basename(chunk)` — any
  // subdir in the naming template is stripped from the URL.
  const assetsDir = join(OUT, 'assets');
  const result = await Bun.build({
    entrypoints: [cfg.entry],
    outdir: assetsDir,
    target: 'browser',
    format: 'esm',
    minify: !WATCH,
    sourcemap: WATCH ? 'inline' : 'linked',
    splitting: true,
    naming: {
      entry: `${cfg.name}-[name]-[hash].[ext]`,
      chunk: `${cfg.name}-[name]-[hash].[ext]`,
      asset: `${cfg.name}-[name]-[hash].[ext]`,
    },
    plugins: [tailwind],
    env: 'PUBLIC_*',          // inline import.meta.env.PUBLIC_*
    publicPath: '/assets/',
    // React/ReactDOM are externalised so their identity is shared with
    // sideloaded plugins via the importmap (see SHARED_EXTERNALS above).
    external: SHARED_EXTERNALS,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for ${cfg.name}`);
  }

  let jsUrl: string | undefined;
  const cssUrls: string[] = [];
  for (const out of result.outputs) {
    const rel = '/assets/' + relative(assetsDir, out.path).split('\\').join('/');
    if (out.kind === 'entry-point') jsUrl = rel;
    else if (rel.endsWith('.css')) cssUrls.push(rel);
  }
  if (!jsUrl) throw new Error(`No entry-point output for ${cfg.name}`);

  await mkdir(dirname(cfg.htmlPath), { recursive: true });
  await writeFile(cfg.htmlPath, cfg.html({ js: jsUrl, css: cssUrls }));

  return { jsUrl, cssUrls, outputs: result.outputs.length };
}

/**
 * Bundle the React-runtime stub files in `scripts/runtime/` into standalone
 * ESM modules under `dist/runtime/`. These get served at `/runtime/<name>.js`
 * and are wired via the importmap in the HTML shells, giving host + every
 * sideloaded plugin a single shared React identity.
 *
 * Only `react.js` actually bundles React's source. Every other stub
 * externalises the modules it depends on so they resolve back to the
 * same /runtime/react.js (etc.) at load time — otherwise we'd ship duplicate
 * React copies and hooks would crash with the classic "two Reacts" error.
 */
async function buildRuntimeModules(): Promise<number> {
  const runtimeOut = join(OUT, 'runtime');
  await mkdir(runtimeOut, { recursive: true });

  const stubs: Array<{ entry: string; outName: string; external: string[] }> = [
    // React lives here; everyone else externalises `react` and resolves back
    // via the importmap (single React identity for hooks).
    { entry: 'react.js',              outName: 'react.js',              external: [] },
    // ReactDOM + react-dom/client are bundled together — the importmap maps
    // BOTH bare specifiers to this file. Splitting them would give createRoot
    // and createPortal independent reconciler state.
    { entry: 'react-dom.js',          outName: 'react-dom.js',          external: ['react'] },
    // jsx-runtime is self-contained (does NOT import from `react/jsx-runtime`,
    // see scripts/runtime/jsx-runtime.js for why), so no externals needed.
    // jsx-dev-runtime imports from the sibling file via relative path.
    { entry: 'jsx-runtime.js',        outName: 'jsx-runtime.js',        external: [] },
    { entry: 'jsx-dev-runtime.js',    outName: 'jsx-dev-runtime.js',    external: [] },
  ];

  let outputs = 0;
  for (const stub of stubs) {
    const result = await Bun.build({
      entrypoints: [join(HERE, 'runtime', stub.entry)],
      outdir: runtimeOut,
      target: 'browser',
      format: 'esm',
      minify: !WATCH,
      sourcemap: WATCH ? 'inline' : 'linked',
      splitting: false,
      // Force the output filename so the importmap URLs stay stable across builds.
      naming: { entry: stub.outName },
      external: stub.external,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Runtime build failed for ${stub.entry}`);
    }
    outputs += result.outputs.length;
  }
  return outputs;
}

async function buildOnce() {
  const started = Date.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let totalOutputs = await buildRuntimeModules();
  for (const cfg of ENTRIES) {
    const { outputs } = await buildEntry(cfg);
    totalOutputs += outputs;
  }

  // Copy verbatim passthroughs (favicon, manifest, sw.js) from public/ into dist/.
  const publicDir = join(ROOT, 'public');
  if (existsSync(publicDir)) {
    await cp(publicDir, OUT, { recursive: true });
  }

  // Stamp the service worker's SHELL_CACHE with a unique per-build id so
  // every deploy forces returning PWAs to evict the stale shell cache on
  // `activate`. Without this step a redeploy can silently keep phones
  // pinned to an older `/m` HTML that references hashed chunks that no
  // longer exist. Base36 ms timestamp keeps the name short (~8 chars) and
  // strictly monotonic across builds within the same wall-clock second.
  const swPath = join(OUT, 'sw.js');
  if (existsSync(swPath)) {
    const buildId = Date.now().toString(36);
    const src = await readFile(swPath, 'utf8');
    if (src.includes('__BUILD_ID__')) {
      await writeFile(swPath, src.split('__BUILD_ID__').join(buildId));
    }
  }

  const ms = Date.now() - started;
  console.log(`[build] ${new Date().toLocaleTimeString()} ok (${ms}ms, ${totalOutputs} outputs)`);
}

if (WATCH) {
  await buildOnce();

  // Serialize rebuilds: only one buildOnce() in flight at a time. A change
  // arriving mid-build sets the `queued` flag so we re-run exactly once
  // after the current build settles, instead of stacking concurrent rebuilds
  // that race on `rm -r dist` and leave the output half-written.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let queued = false;
  const runBuild = async () => {
    if (inFlight) { queued = true; return; }
    inFlight = true;
    try {
      await buildOnce();
    } catch (e) {
      console.error('[build] failed:', e);
    } finally {
      inFlight = false;
      if (queued) { queued = false; runBuild(); }
    }
  };
  const rebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { runBuild(); }, 100);
  };

  watch(join(ROOT, 'src'), { recursive: true }, rebuild);
  if (existsSync(join(ROOT, 'public'))) {
    watch(join(ROOT, 'public'), { recursive: true }, rebuild);
  }
  console.log('[build] watching src/ and public/ (Ctrl-C to stop)');
} else {
  await buildOnce();
}
