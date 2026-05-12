# Electron Rewrite Plan

Replace the Tauri 2 desktop shell with Electron so the in-window browser
preview can use CDP (Chromium DevTools Protocol). WKWebView (Tauri's macOS
backend) has no CDP; Chromium does, and with `webContents.debugger.attach`
plus `webContents.session.webRequest` we get the entire devtools + network
surface for free. That unlocks Playwright-style ID-addressed
snapshot/screenshot/click/fill/scroll MCP tools driving the preview.

The React UI (`src/`) and the bridge server (`server/`) are unchanged in
behavior — only their **host** changes. Build pipeline, sidecar spawn, OAuth
flow, and CLI installer all port across.

---

## 1. Surface to preserve

Everything the React side currently calls into the Tauri runtime for:

### `@tauri-apps/api/core::invoke`

| Command                          | Caller                              | Replacement (Electron)                      |
| -------------------------------- | ----------------------------------- | ------------------------------------------- |
| `get_bridge_port`                | `src/lib/claude-client.ts`          | `ipcMain.handle` → discovers / spawns bun   |
| `open_browser_preview`           | `src/components/BrowserPanel.tsx`   | `ipcMain.handle` → `BrowserView` + CDP attach |
| `close_browser_preview`          | `BrowserPanel.tsx`                  | `ipcMain.handle` → removeBrowserView        |
| `browser_preview_set_bounds`     | `BrowserPanel.tsx`                  | `BrowserView.setBounds`                     |
| `browser_preview_set_inspect`    | `BrowserPanel.tsx`                  | `webContents.executeJavaScript`             |
| `browser_preview_set_comments`   | `BrowserPanel.tsx`                  | `webContents.executeJavaScript`             |
| `browser_preview_set_visible`    | `BrowserPanel.tsx`                  | add/remove the BrowserView from window      |
| `browser_preview_navigate`       | `BrowserPanel.tsx`                  | `webContents.{goBack,goForward,reload,loadURL}` |
| `browser_preview_emit`           | injected inspector script (in-page) | preload helper → ipcMain → re-broadcast     |
| `plugin_oauth_login`             | `src/lib/plugin-host.ts`            | new `BrowserWindow` + `did-navigate` capture |

### `@tauri-apps/api/event::listen`

Only `BrowserPanel.tsx` listens, for the four `browser-preview://*` events.
The injected inspector script in the previewed page fires them via
`browser_preview_emit`; main forwards to the renderer via
`webContents.send('browser-preview-event', { event, label, payload })`.

### `@tauri-apps/plugin-notification`

`ChatApp.tsx` uses `isPermissionGranted`, `requestPermission`,
`sendNotification`. Replace with the standard **Web Notification API**,
which Electron supports natively (`new Notification(...)`,
`Notification.requestPermission()`). Small surgical change to `ChatApp.tsx`.

---

## 2. IPC bridge design — Tauri-compat shim + Electron-native channels

Goal: keep `src/` ~unchanged on the bridge-port and `invoke` paths. The
event path needs a tiny shim because porting Tauri 2's `transformCallback`
internals isn't worth the complexity.

### Preload (`electron/preload.ts`)

- `contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', { invoke })`
  where `invoke(cmd, args)` is `ipcRenderer.invoke('tauri:'+cmd, args)`.
  `@tauri-apps/api/core::invoke` *only* reads `window.__TAURI_INTERNALS__.invoke`,
  so this satisfies `claude-client.ts`, `plugin-host.ts`, and every
  `invoke()` call in `BrowserPanel.tsx` with **zero React changes**.
- `contextBridge.exposeInMainWorld('codiby', { onBrowserPreviewEvent })`
  for the four `browser-preview://*` events. `BrowserPanel.tsx` swaps
  `listen(...)` → `window.codiby.onBrowserPreviewEvent(...)` (one
  conditional). The Tauri event-system internals (callback registry,
  worldId-aware eval) are not worth re-implementing — a thin direct
  channel is cleaner.
- Optional polyfill: also expose `__TAURI_INTERNALS__.metadata`/etc.
  no-ops so any future Tauri-api code paths that touch them don't crash.

### Main (`electron/main.ts`)

- `ipcMain.handle('tauri:get_bridge_port', getBridgePort)` — same
  spawn-or-discover logic as `src-tauri/src/lib.rs::get_bridge_port`,
  ported to TS (port-file paths, health check, sidecar spawn).
- `ipcMain.handle('tauri:open_browser_preview', …)` etc. — all
  `browser_preview::*` commands routed to `electron/browser_preview.ts`.
- `ipcMain.handle('tauri:browser_preview_emit', …)` — receives the
  in-page inspector's events and rebroadcasts via
  `mainWindow.webContents.send('browser-preview-event', …)`.
- `ipcMain.handle('tauri:plugin_oauth_login', …)` — port of
  `lib.rs::plugin_oauth_login`. New child `BrowserWindow`, watch
  `webContents.on('did-navigate')`, harvest cookies via
  `session.cookies.get({ url })`, POST to the plugin endpoint, close.

### Renderer changes (minimal)

| File                            | Change                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/claude-client.ts`      | None. `__TAURI_INTERNALS__` is present → existing branch fires.        |
| `src/lib/plugin-host.ts`        | None. Dynamic `@tauri-apps/api/core` import resolves via the shim.     |
| `src/components/BrowserPanel.tsx` | Swap `listen` import for `window.codiby.onBrowserPreviewEvent`; or fall back to `listen` if not present (so dev/browser modes keep working). The `invoke()` calls stay verbatim. |
| `src/components/ChatApp.tsx`    | Swap `@tauri-apps/plugin-notification` for Web Notification API.       |

> Note: we keep `@tauri-apps/api` and `@tauri-apps/plugin-*` as runtime
> dependencies until the Tauri side is removed. Their internals are no
> longer load-bearing.

---

## 3. Directory layout

```
electron-rewrite/
├── electron/                  NEW — Electron main + preload code
│   ├── main.ts                Entry: app.whenReady, window, sidecar, IPC
│   ├── preload.ts             contextBridge: __TAURI_INTERNALS__ + codiby
│   ├── bridge_server.ts       Port discovery + sidecar spawn (port of lib.rs)
│   ├── browser_preview.ts     BrowserView lifecycle, layout, inspector injection
│   ├── cdp.ts                 CDP attach + snapshot/screenshot/click/fill/scroll
│   ├── plugin_oauth.ts        Port of lib.rs::plugin_oauth_login
│   ├── cli_installer.ts       Port of lib.rs::install_cli_script (drop ~/.local/bin/codiby)
│   ├── inspector_script.ts    The INSPECTOR_SCRIPT_TEMPLATE string (copied verbatim)
│   └── tsconfig.json          Separate tsconfig — emits CJS for Electron
├── electron-dist/             tsc output, gitignored
├── src/                       React UI (unchanged behavior; small surgical edits)
├── server/                    Bridge server (unchanged)
├── scripts/
│   ├── build.ts               Unchanged
│   ├── bundle-bun.sh          Replaced/parallel: bundles bun + server.js into a resources dir consumable by electron-builder
│   ├── codiby                 Unchanged (CLI script)
│   └── electron-resources.sh  NEW: bundles bun + server.js + dist/ into electron/resources/ for packaging
├── src-tauri.legacy/          Renamed from src-tauri/ to make deprecation obvious; kept until Electron is verified
├── package.json               +electron, +electron-builder, +scripts, "main": "electron-dist/main.js"
└── ELECTRON_REWRITE_PLAN.md   This file
```

Rationale for separate `electron/tsconfig.json`: the root `tsconfig.json`
targets the browser (DOM, ESM) and excludes Node types. The main process
needs Node + Electron types and CJS output (Electron loads `main` as CJS by
default).

---

## 4. Main-process module breakdown

### `electron/main.ts`
- `app.whenReady` → create `BrowserWindow` (1200×800, minWidth/Height 800×600,
  `titleBarStyle: 'hiddenInset'` for the same look as Tauri's `Overlay`).
- `webPreferences`: `contextIsolation: true`, `sandbox: false` (preload
  needs `child_process` access for the sidecar spawn handler we expose),
  `preload: path.join(__dirname, 'preload.js')`.
- Dev mode (`process.env.ELECTRON_DEV === '1'`): `loadURL('http://localhost:3111')`
  (same as Tauri's `devUrl`). Prod: load `file://.../dist/index.html` or
  better, point at the bun sidecar's `http://localhost:<port>/` so the
  CSP/cookie origin matches the WS endpoint exactly.
- Register every `ipcMain.handle('tauri:*')` from the table in §1.
- `app.on('window-all-closed')` → quit on non-macOS; on macOS keep alive.
- `app.on('before-quit')` → kill the sidecar child if we spawned it.
- Boot: call `cli_installer.installCliScript()` (best-effort).

### `electron/bridge_server.ts`
- Constants:
  - `BRIDGE_PORT_FILE = ~/.codiby/server.port` (mac) / `%PROGRAMDATA%\codiby\server.port` (windows) / `$XDG_CONFIG_HOME/codiby/port` (linux).
  - `APP_SPAWN_PORT_FILE` = sibling `app-server.port`.
- `getBridgePort()` — exact port of the Rust logic:
  1. Cached value still healthy? return.
  2. `BRIDGE_PORT_FILE` readable + `/health` 200? cache + return.
  3. `APP_SPAWN_PORT_FILE` readable + `/health` 200? cache + return.
  4. Spawn sidecar.
- `spawnSidecar()` — `child_process.spawn(bunPath, [serverJsPath, '--spawned-by=app'], { env: { CODIBY_CODE_PORT_FILE, CLAUDE_UI_PORT: '3111', CLAUDE_UI_HOST: '127.0.0.1' } })`.
  - In prod: `bunPath = path.join(process.resourcesPath, 'sidecar/bun')`,
    `serverJsPath = path.join(process.resourcesPath, 'server.js')`.
  - In dev: use the host's `bun` (`which bun`) and `server/index.ts` directly
    (run via `bun run server/index.ts`).
  - Watch stdout for `BRIDGE_SERVER_PORT:<n>` line (already emitted by
    `server/index.ts`).
  - Drain stdout forever once port is found so the pipe never fills.
  - On `exit` before announce, reject with the captured stderr.
- `healthCheck(port)` — `fetch('http://127.0.0.1:'+port+'/health', { signal: AbortSignal.timeout(2000) })` and require `200`.
- Kill the child in `app.on('before-quit')` and `process.on('exit')`.

### `electron/browser_preview.ts`
Mirrors `src-tauri/src/browser_preview.rs`. Public functions:
- `openBrowserPreview({ label, url, title, x, y, width, height })`
- `closeBrowserPreview(label)`
- `setBounds(label, { x, y, width, height })`
- `setVisible(label, visible)`
- `setInspect(label, enabled)`
- `setComments(label, comments)`
- `navigate(label, action: 'back'|'forward'|'reload'|'goto', url?)`

Implementation:
- One `Map<string, BrowserView>` keyed by `label`.
- `validateLabel`: same regex `[a-zA-Z0-9_-]+` and length 1..=80.
- `validateUrl`: parse, require http/https.
- Create: `new BrowserView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })`. We do NOT want preload/contextBridge here — the previewed page is third-party and gets sandboxed.
- Add to window: `mainWindow.addBrowserView(view); view.setBounds({...}); view.setAutoResize({ width: false, height: false })` (manual bounds management — React-side ResizeObserver is the source of truth).
- Attach CDP: `view.webContents.debugger.attach('1.3')` then `sendCommand('Page.enable')`, `sendCommand('DOM.enable')`, `sendCommand('Runtime.enable')`, `sendCommand('Network.enable')`. Wire `debugger.on('message', ...)` for events.
- Inject the inspector script:
  - `webContents.on('did-finish-load', () => view.webContents.executeJavaScript(INSPECTOR_SCRIPT))` so it runs on every full-page load.
  - Inspector script template needs adjusting — the Rust version calls `INTERNALS.invoke('browser_preview_emit', {...})` from inside the in-page world. In Electron we have no `__TAURI_INTERNALS__` *inside the preview* (it's a different `webContents` with no preload). Replace that bridge with: a sandbox-friendly call via `window.chrome?.webview?.postMessage` is also not available. Use `console.log('__codiby_relay__:' + JSON.stringify({event, payload}))` and have the main process listen via `webContents.on('console-message')` to pick those lines up, OR — cleaner — attach a small preload to the preview `webContents` that exposes a relay function via contextBridge. Choose the **preload approach** so we don't have to scrape console messages. Preload file: `electron/preview_preload.ts`, exposes `window.__codiby_relay(event, payload)`. Inspector script calls `window.__codiby_relay(event, payload)` instead of `INTERNALS.invoke('browser_preview_emit', ...)`. The preload routes back via `ipcRenderer.send('browser-preview-relay', { label, event, payload })`. Main forwards to the host renderer via `mainWindow.webContents.send('browser-preview-event', ...)`.
- URL changes from real navigation: `view.webContents.on('did-navigate', (_e, url) => relay('browser-preview://url-changed', { url }))` and `did-navigate-in-page` for SPA same-document changes.
- `setBounds`: just `view.setBounds({ x: Math.max(0,Math.round(x)), y: Math.max(0,Math.round(y)), width: Math.max(1,Math.round(width)), height: Math.max(1,Math.round(height)) })`.
- `setVisible(false)`: `mainWindow.removeBrowserView(view)` (keep the view object alive so we can re-add later). `setVisible(true)`: `mainWindow.addBrowserView(view)` if not already attached.
- `setInspect` / `setComments`: `executeJavaScript('window.__codibyInspector?.setInspecting(...)' / 'setComments(...)')` — same as Rust's `webview.eval(...)`.
- `navigate('back'|'forward'|'reload')`: use `webContents.goBack/goForward/reload`. `'goto'`: validate URL, then `webContents.loadURL(url)`.

### `electron/cdp.ts`
Per-preview CDP wrapper. Public functions take a `label`, resolve to the
`BrowserView`'s `webContents.debugger`, and:

- `snapshot(label)` — walk the DOM via `DOM.getDocument` (depth: -1, pierce: true) then filter to interactive nodes (`a, button, input, select, textarea, [role=button]`, etc.). Each candidate gets a synthetic id; store `{id → backendNodeId, nodeName, attrs, snippet}` in a per-label map. Refresh on each snapshot (stale ids drop). Return the tree as JSON. Aim for compact: `{id, role, name, value, bounds, children}`.
- `screenshot(label, opts?)` — `Page.captureScreenshot({ format: 'png', captureBeyondViewport: false })`. Returns base64.
- `click(label, id)` — look up backendNodeId → `DOM.resolveNode → Runtime.callFunctionOn` with `function() { this.click(); }`. Falls back to `DOM.scrollIntoViewIfNeeded` then `Input.dispatchMouseEvent(mousePressed/mouseReleased)` at the node's center if `.click()` is unavailable.
- `fill(label, id, value)` — `Runtime.callFunctionOn` with `function(v) { this.focus(); this.value = v; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`.
- `scroll(label, opts: { id?, x?, y? })` — with id: `Runtime.callFunctionOn` with `function() { this.scrollIntoView({ behavior: 'instant', block: 'center' }); }`. With x/y: `Runtime.evaluate(`window.scrollTo(${x},${y})`)`.
- `network(label, opts: { tail?: number })` — return the last N entries from a per-label ring buffer of `{requestId, method, url, status, mimeType, fromCache, ts}`. Buffer is filled in the `debugger.on('message')` handler watching for `Network.requestWillBeSent` / `Network.responseReceived` / `Network.loadingFinished` / `Network.loadingFailed`. Ring of 200; oldest evicted.

### `electron/plugin_oauth.ts`
Port of `lib.rs::plugin_oauth_login`:
- Same validation (`validatePluginId`, `credentials_endpoint` starts with `/`, non-empty `cookie_names`/`success_path_match`).
- Open a child `BrowserWindow` labeled `plugin-login-<id>` (close any existing of the same label first).
- `webContents.on('did-navigate' | 'did-redirect-navigation', (_e, url) => { if (success_path_match.some(m => new URL(url).pathname.includes(m))) resolveDone(); })`.
- After resolve: 500ms grace, then `session.defaultSession.cookies.get({ url: 'https://'+cookie_domain+'/' })`, filter to `cookie_names`, build JSON, POST to `http://localhost:<port>/plugins/<id>/<credentials_endpoint>`, close window.
- Note: the per-window session can be partitioned with `session: session.fromPartition('persist:plugin-'+id)` if we want isolation between plugins later.

### `electron/cli_installer.ts`
Port of `lib.rs::install_cli_script`:
- Embed `scripts/codiby` at build time (or `fs.readFileSync` from `resources/scripts/codiby` at startup).
- Write to `~/.local/bin/codiby` if missing or differs; `chmod 0755`.
- No-op on Windows; best-effort everywhere else.

### `electron/inspector_script.ts`
Verbatim copy of the JS template from `src-tauri/src/browser_preview.rs::INSPECTOR_SCRIPT_TEMPLATE`, with one swap:

```diff
- INTERNALS.invoke('browser_preview_emit', { label: LABEL, event, payload: payload == null ? null : JSON.stringify(payload) });
+ window.__codiby_relay(event, payload == null ? null : JSON.stringify(payload));
```

Plus `LABEL` interpolation (string replace `__LABEL__`).

The preload that exposes `__codiby_relay` lives in `electron/preview_preload.ts`:

```ts
contextBridge.exposeInMainWorld('__codiby_relay', (event, payload) => {
  if (!event.startsWith('browser-preview://')) return;
  ipcRenderer.send('browser-preview-relay', { event, payload });
});
```

`ipcMain.on('browser-preview-relay', ...)` resolves the sender's
`webContents.id` to a label (we stored the mapping when we built the view)
and re-broadcasts to the main window with the label tagged in.

---

## 5. Build pipeline

### Dev

`package.json` `electron:dev`:
1. `bash run.sh` in the background (frontend watcher + bridge on :3111) — same as Tauri's `beforeDevCommand`.
2. `tsc -p electron/tsconfig.json --watch` writing to `electron-dist/`.
3. Once both are ready, `electron .` with `ELECTRON_DEV=1` so main loads `http://localhost:3111`.

A small orchestrator script (`scripts/electron-dev.ts`) handles the
sequencing (analogous to `run.sh`) so `bun run electron:dev` is a single
entry point.

### Prod

`package.json` `electron:build`:
1. `bun run scripts/build.ts` → `dist/`.
2. `bun build server/index.ts --outfile electron/resources/server.js --target bun --minify` → bundled bridge.
3. `cp $(which bun) electron/resources/bun` (or use `electron/resources/bun-<platform>` for cross-builds — same approach as `bundle-bun.sh`).
4. `tsc -p electron/tsconfig.json` → `electron-dist/`.
5. `electron-builder --mac dmg --win nsis` (mirror `tauri.conf.json` targets).

`electron-builder` config (in `package.json` under `"build"`):

```json
{
  "appId": "com.codiby.code",
  "productName": "Codiby Code",
  "directories": { "buildResources": "electron/build" },
  "files": ["electron-dist/**/*", "dist/**/*", "package.json"],
  "extraResources": [
    { "from": "electron/resources/server.js", "to": "server.js" },
    { "from": "electron/resources/bun",       "to": "bun" },
    { "from": "scripts/codiby",               "to": "scripts/codiby" }
  ],
  "mac": {
    "category": "public.app-category.developer-tools",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "electron/build/entitlements.mac.plist",
    "entitlementsInherit": "electron/build/entitlements.mac.plist",
    "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }]
  },
  "win": { "target": ["nsis"] },
  "afterSign": "electron/build/notarize.js"
}
```

Notarization: `@electron/notarize` driven from `electron/build/notarize.js`,
gated by `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
environment variables. Skipped silently when missing (so local builds work).

Entitlements (`electron/build/entitlements.mac.plist`): allow JIT
(`com.apple.security.cs.allow-jit`), allow unsigned exec memory
(`com.apple.security.cs.allow-unsigned-executable-memory`), allow library
validation (`com.apple.security.cs.disable-library-validation`) — these
match what Electron + a bundled Bun binary need.

### Replace-app flow

`scripts/replace-app.sh` already does the post-build "kill old app, swap
.app, relaunch" dance. Keep it as-is — the new `.app` from
electron-builder lands at `dist/mac/Codiby Code.app` (or
`dist/mac-arm64/Codiby Code.app`). The script just needs the input path
to change (and quitting the app is the same `osascript` Quit).

---

## 6. Pinned dependency versions

Latest at time of writing (verified against npm registry, not training data):

```jsonc
{
  "devDependencies": {
    "electron": "42.0.1",
    "electron-builder": "26.8.1",
    "@electron/notarize": "3.1.1"
  }
}
```

No new runtime dependencies — everything else (`child_process`, `path`,
`fs`, `os`) is Node built-in.

---

## 7. SDK MCP tool integration — `browser_snapshot` / `screenshot` / `click` / `fill` / `scroll` / `network`

The bridge process is where SDK tools run (see `server/provider/sdk-tools.ts`).
It has no direct Electron access. The renderer has — and the renderer
already talks to main via IPC.

### Bridge → renderer → main → CDP request/response pattern

1. SDK tool in the bridge process posts a `browser_request` over the
   existing WS `broadcastToSession(sessionId, { type: 'browser_request',
   sessionId, requestId, action, args })`. Wrap with an `await` on a
   bridge-side pending-promise map keyed by `requestId`.
2. The desktop frontend (`ChatApp.tsx` or a small new
   `lib/browser-cdp-bridge.ts` module wired in `Providers.tsx`) listens
   for `browser_request` on its WS, calls `window.__TAURI_INTERNALS__.invoke(`browser_preview_${action}`, args)` (or a new namespaced `cdp_snapshot` etc. command), and sends a `browser_response` WS back with `{ requestId, result | error }`.
3. The bridge's pending promise resolves on the response.

Why this shape:
- The SDK tools have to run in the bridge (that's where `addMessage`,
  WS broadcast, session state, plugin-tool aggregation all live).
- Main has CDP. Renderer is the only thing wired to both.
- The pattern matches the existing `browser_open` / `browser_close` flow
  (broadcast `open_browser` to the renderer, which then drives the
  native preview) — just bidirectional.

### Tool definitions to add to `server/provider/sdk-tools.ts`

```ts
tool('browser_snapshot', 'Capture an ID-addressed DOM tree of the current browser preview. Use IDs from this in subsequent click/fill/scroll calls. Returns role, name/value, bounds.', {}, async () =>
  await cdpRequest(sessionId, 'snapshot', {})
),
tool('browser_screenshot', 'PNG screenshot of the current browser preview viewport.', {}, async () =>
  await cdpRequest(sessionId, 'screenshot', {})
),
tool('browser_click', 'Click an element previously identified by browser_snapshot.', { id: z.string() }, async ({id}) =>
  await cdpRequest(sessionId, 'click', { id })
),
tool('browser_fill', 'Set the value of an input/textarea identified by browser_snapshot. Fires input + change events.', { id: z.string(), value: z.string() }, async ({id, value}) =>
  await cdpRequest(sessionId, 'fill', { id, value })
),
tool('browser_scroll', 'Scroll an element into view (by id) OR scroll the viewport to absolute x/y.', { id: z.string().optional(), x: z.number().optional(), y: z.number().optional() }, async (args) =>
  await cdpRequest(sessionId, 'scroll', args)
),
tool('browser_network', 'Return the last N network requests seen by the preview. Defaults to 50.', { tail: z.number().int().positive().max(200).optional() }, async ({tail}) =>
  await cdpRequest(sessionId, 'network', { tail: tail ?? 50 })
),
```

`cdpRequest` is a new helper in `server/provider/sdk-tools.ts`-adjacent
module that broadcasts the `browser_request`, awaits the response (with a
~10s timeout), and unwraps `result` / `error` into the MCP tool's content
shape.

Per-session uniqueness: only one CDP-enabled `BrowserView` per session at
a time (label = `browser-<sessionId>`). The bridge tracks that the
session has an open preview before issuing CDP commands — if not, return
"no browser open" as a tool error.

### Renderer-side handler

`lib/browser-cdp-bridge.ts` — register WS handler:

```ts
if (msg.type === 'browser_request') {
  const { requestId, action, args } = msg;
  try {
    const result = await window.__TAURI_INTERNALS__.invoke('cdp_' + action, args);
    client.send({ type: 'browser_response', requestId, result });
  } catch (e) {
    client.send({ type: 'browser_response', requestId, error: String(e) });
  }
}
```

Wire into `ClaudeClient` by adding a new callback (`onBrowserRequest`) to
`ClientCallbacks` and emitting from `handleMessage`. The existing pattern
for `onOpenBrowser` / `onCloseBrowser` is the template.

---

## 8. src-tauri migration strategy

**Decision: rename `src-tauri/` → `src-tauri.legacy/`** during scaffolding.

Reasons:
- `.legacy` makes the deprecation obvious in PR diffs and editor file trees.
- Anything that still imports it (none, since it's a separate Rust crate) breaks loudly.
- We keep it on disk so the Tauri build still works as an escape hatch if Electron blocks.
- Deletion happens in a separate commit once the Electron path is verified end-to-end.

Build scripts referencing the path get updated to point at `src-tauri.legacy/`:
- `scripts/bundle-bun.sh` — `SIDECAR_DIR="$PROJECT_DIR/src-tauri.legacy/sidecar"`.
- `scripts/bump-version.ts` — same.
- `package.json` — `"tauri": "tauri"`, `"tauri:dev"`, etc., add a `TAURI_CONFIG_DIR=src-tauri.legacy` env override (or just remove the scripts; the user said Tauri side is being replaced).

We will mostly leave the Tauri scripts in but mark them as legacy so the user can still run them manually if needed.

---

## 9. Commit plan (small, themed)

On `electron-rewrite` branch, no pushing, no PR:

1. `docs: add ELECTRON_REWRITE_PLAN.md` — this file.
2. `chore: rename src-tauri → src-tauri.legacy; update script paths` — pure mv + sed.
3. `feat(electron): scaffold main, preload, bridge_server, cli_installer` — empty window, sidecar spawn, `get_bridge_port` working, CLI installer.
4. `feat(electron): browser_preview BrowserView lifecycle + inspector injection` — open/close/bounds/visible/navigate, inspector relay via preview preload.
5. `feat(electron): CDP attach + snapshot/screenshot/click/fill/scroll/network` — `electron/cdp.ts` + IPC handlers.
6. `feat(electron): plugin_oauth_login port` — child window + cookie capture.
7. `chore(react): swap @tauri-apps/plugin-notification for Web Notification API; gate BrowserPanel event subscription on Electron path` — minimal renderer edits.
8. `feat(bridge): browser_snapshot/screenshot/click/fill/scroll/network SDK tools + request/response WS plumbing` — bridge + frontend wiring.
9. `chore(build): package.json electron deps + electron-builder config + scripts (no install)`.

Each commit type-checks (`bunx tsc --noEmit -p electron/tsconfig.json` for Electron, `bunx tsc --noEmit` for the renderer). Nothing runs the Electron process.

---

## 10. Done criteria (for the user to verify manually)

1. `bun install` succeeds (user runs, not Claude).
2. `bun run electron:dev` opens an Electron window showing the React UI at `http://localhost:3111`.
3. Spawning a session in a project dir works (sidecar discovered or spawned, `/health` returns 200, WS connects).
4. `browser_open` MCP tool opens a BrowserView pinned to the panel rect; resizing the splitter resizes the view; Cmd+K palette hides it.
5. `browser_snapshot` then `browser_click(id)` actually drives the page.
6. `browser_network` returns recent requests captured by the CDP `Network` domain.
7. Plugin OAuth: a sideloaded plugin's `plugin_oauth_login` opens a child window, captures cookies on the configured success-path match, POSTs to the bridge.
8. CLI: `~/.local/bin/codiby` installed on first launch; `codiby .` from another terminal creates a session and brings the app forward.

---

## 11. Things deliberately NOT in scope for this rewrite

- No CSP rework. Electron and Tauri both load the renderer from
  `http://localhost:3111` in dev / from the same in prod (via the bridge's
  `serveStaticFromDist`), so origin behavior is identical.
- No `@tauri-apps/api` removal. We leave the dependency in `package.json`
  until everything verifies; it stops being load-bearing once the shim is
  in place.
- No mobile changes. Mobile UI (`src/m/`) never hit Tauri internals; it
  uses the same WS bridge that any browser does.
- No bridge-server changes beyond the new SDK tools and the
  `browser_request` / `browser_response` plumbing. Sessions, plugins,
  worktrees, OAuth (server side), tabs — all unchanged.
- No tests. The existing repo has no test runner wired up for this
  layer; introducing one is out of scope.
