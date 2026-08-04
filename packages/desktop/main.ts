/**
 * Electron entry point.
 *
 *   - install the codiby CLI to ~/.local/bin (best-effort).
 *   - create the main BrowserWindow.
 *   - spawn / discover the bun bridge sidecar (lazy, on first invoke).
 *   - register every `app:*` IPC channel the React code's `invoke()` calls
 *     reach for, plus browser-preview / CDP / plugin OAuth handlers.
 *   - on shutdown, kill the sidecar and tear down all preview surfaces.
 */
import { app, BrowserWindow, ipcMain, shell, dialog, Notification, crashReporter, Menu, clipboard } from 'electron';
import { join, basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { getBridgePort, killSidecar } from './bridge_server';
import { installCliScript } from './cli_installer';
import { wireRendererDiagnostics, diagnosticsLogPath, logMain } from './diagnostics';
import {
  initBrowserPreview,
  openBrowserPreview,
  closeBrowserPreview,
  setBounds,
  setVisible,
  setInspect,
  setComments,
  navigate,
  handleRelay,
  disposeAll,
  type BrowserComment,
} from './browser_preview';
import {
  snapshot as cdpSnapshot,
  screenshot as cdpScreenshot,
  click as cdpClick,
  hover as cdpHover,
  type_ as cdpType,
  pressKey as cdpPressKey,
  selectOption as cdpSelectOption,
  scroll as cdpScroll,
  navigate as cdpNavigate,
  evaluate as cdpEvaluate,
  waitFor as cdpWaitFor,
  consoleMessages as cdpConsoleMessages,
  network as cdpNetwork,
  handleDialog as cdpHandleDialog,
} from './cdp';
import { pluginOauthLogin, type OAuthSpec } from './plugin_oauth';
import { registerUpdaterIpc, startUpdateChecks } from './updater';
import {
  acquireTunnel,
  releaseTunnel,
  disconnectTunnel,
  closeAllTunnels,
  getTunnelStatus,
  getTunnelLocalPort,
  probeRemoteHealth,
  addPortForward,
  removePortForward,
  listActiveForwards,
  onTunnelStatus,
  cleanupStaleControlSockets,
} from './ssh_tunnel';

const DEV = process.env.ELECTRON_DEV === '1' || !app.isPackaged;
const DEV_URL = process.env.CODIBY_DEV_URL || 'http://localhost:3111';

let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Startup performance + memory budget
//
// 1. Single-instance lock: a second `electron .` (or dock double-click)
//    focuses the existing window instead of spawning a whole second
//    process tree (main + renderer + GPU + network = ~500MB duplicated).
// 2. Disable Chromium subsystems we never reach: Cast/media-router,
//    autofill server, translate, optimization-hints. Each saves a few MB
//    and a background timer or two.
// 3. process.noDeprecation: silence Node's deprecation printer (cosmetic,
//    trivial perf). Electron release notes are the source of truth.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.commandLine.appendSwitch(
  'disable-features',
  [
    'DialMediaRouteProvider',
    'MediaRouter',
    'AutofillServerCommunication',
    'Translate',
    'OptimizationHints',
    'OptimizationHintsFetching',
    'CalculateNativeWinOcclusion',
    'SpareRendererForSitePerProcess',
  ].join(','),
);
app.commandLine.appendSwitch('no-pings');

process.noDeprecation = true;

// Last-resort error net for the Electron main process. Without this, a single
// unhandled throw or rejected promise (e.g. in an IPC handler, the updater, or
// a browser-preview callback) bubbles up to Electron's default handler, which
// pops a crash dialog and can quit the app. We swallow + log instead so the
// window stays up; the sidecar has its own equivalent net (see server/logger).
process.on('uncaughtException', (err) => {
  console.error('[electron-main] Uncaught exception (kept app alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron-main] Unhandled promise rejection (kept app alive):', reason);
});

// Capture native crash dumps locally (renderer/GPU/main). The recurring black
// screen is an EXC_BREAKPOINT/SIGTRAP in the renderer's V8 — the macOS .ips
// report doesn't carry V8's fatal message, but the Crashpad minidump does.
// uploadToServer:false keeps everything on-disk (app.getPath('crashDumps')).
// Must start before `app.whenReady()` so early crashes are caught too.
try {
  crashReporter.start({ productName: 'taskr', companyName: 'codiby', uploadToServer: false });
} catch (e) {
  console.error('[electron-main] crashReporter.start failed:', e);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32' && {
      titleBarOverlay: {
        color: '#131418',
        symbolColor: '#ffffff',
        height: 34,
      },
    }),
    backgroundColor: '#0a0a0a',
    // Defer the visual surface until the renderer commits its first paint.
    // Eliminates the white flash and improves perceived startup latency
    // without changing total work done.
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
      // Persist V8 bytecode across launches — second-and-subsequent boots
      // skip the parse+compile step for hot modules. Disk-resident, no
      // resident-memory cost.
      v8CacheOptions: 'code',
      // The renderer renders a chat UI, so spellcheck stays on.
      spellcheck: true,
      // Default is true; pinned here so a future Electron upgrade can't
      // flip the default to false and starve background tabs of CPU.
      backgroundThrottling: true,
      // Deprecated subsystem. Disabling drops one Blink module from the
      // renderer at no functional cost.
      enableWebSQL: false,
      // The React UI doesn't draw via WebGL directly. Disabling here
      // prevents Blink from initialising the WebGL context backing
      // resources on first paint.
      webgl: false,
    },
  });

  // ready-to-show fires after the renderer commits its first paint — at
  // that point the window can flip from hidden → visible in one frame.
  win.once('ready-to-show', () => win.show());

  // Capture renderer crashes / hangs / load failures (the "black screen")
  // into a persistent log, and make the DevTools chord work even while the
  // page is wedged. See electron/diagnostics.ts.
  wireRendererDiagnostics(win);

  // External links open in the user's default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Native right-click menu. Electron ships no default context menu, so without
  // this a right-click on a link (or selected text) does nothing. Build a menu
  // from the click params: "Copy Link" over links, standard clipboard actions
  // over selections and editable fields.
  win.webContents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const linkUrl = params.linkURL;

    if (linkUrl) {
      items.push(
        { label: 'Open Link in Browser', click: () => { shell.openExternal(linkUrl).catch(() => {}); } },
        { label: 'Copy Link', click: () => clipboard.writeText(linkUrl) },
      );
    }

    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy', enabled: params.editFlags.canCopy });
    }

    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Browser-preview surfaces are native BrowserViews that live in the main
  // process, decoupled from the host renderer's lifecycle. When the user
  // hard-reloads the host (Cmd+Shift+R after a blank/black render), the React
  // tree that owns them is torn down *without* running its unmount cleanup —
  // so any open view is orphaned and keeps painting on top of everything with
  // nothing left to close it. Tear them all down on a real top-frame
  // navigation of the host; the reloaded renderer re-creates whatever previews
  // it still needs on mount. In-document (SPA route) changes are ignored.
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    try { disposeAll(); } catch {}
  });

  return win;
}

async function loadInitialUrl(win: BrowserWindow): Promise<void> {
  if (DEV) {
    // Dev: the bridge serves the frontend dist over :3111. `run.sh`
    // (started independently) keeps the bundler and bridge alive.
    await win.loadURL(DEV_URL);
    return;
  }
  // Prod: bring the bridge up, then point the window at it. Using the bridge's
  // origin (vs file://) keeps cookie/CSP behavior identical to dev.
  const port = await getBridgePort();
  await win.loadURL(`http://localhost:${port}/`);
}

function relayBrowserPreviewEvent(label: string, event: string, payload: string | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('browser-preview-event', { event, label, payload });
}

function registerIpcHandlers(): void {
  // --- bridge port ----------------------------------------------------------
  ipcMain.handle('app:get_bridge_port', async () => {
    return await getBridgePort();
  });

  // --- browser preview ------------------------------------------------------
  ipcMain.handle('app:open_browser_preview', async (_e, args: {
    label: string; url: string; title?: string; cookieJar?: string; openSeq?: number;
    x: number; y: number; width: number; height: number;
  }) => {
    await openBrowserPreview(args);
  });
  ipcMain.handle('app:close_browser_preview', async (_e, args: { label: string }) => {
    return closeBrowserPreview(args.label);
  });
  ipcMain.handle('app:browser_preview_set_bounds', async (_e, args: {
    label: string; x: number; y: number; width: number; height: number;
  }) => {
    return setBounds(args.label, { x: args.x, y: args.y, width: args.width, height: args.height });
  });
  ipcMain.handle('app:browser_preview_set_visible', async (_e, args: { label: string; visible: boolean }) => {
    return setVisible(args.label, args.visible);
  });
  ipcMain.handle('app:browser_preview_set_inspect', async (_e, args: { label: string; enabled: boolean }) => {
    return setInspect(args.label, args.enabled);
  });
  ipcMain.handle('app:browser_preview_set_comments', async (_e, args: { label: string; comments: BrowserComment[] }) => {
    return setComments(args.label, args.comments);
  });
  ipcMain.handle('app:browser_preview_navigate', async (_e, args: {
    label: string; action: 'back' | 'forward' | 'reload' | 'goto'; url: string | null;
  }) => {
    return await navigate(args.label, args.action, args.url);
  });

  // Inspector -> host relay (from preview_preload via ipcRenderer.send).
  ipcMain.on('browser-preview-relay', (e, msg: { event: string; payload: string | null }) => {
    const wcId = e.sender.id;
    handleRelay(wcId, msg.event, msg.payload);
  });

  // --- CDP actions (called from the renderer's browser-cdp-bridge) ----------
  ipcMain.handle('app:cdp_snapshot', async (_e, args: { label: string }) => {
    return await cdpSnapshot(args.label);
  });
  ipcMain.handle('app:cdp_take_screenshot', async (_e, args: { label: string }) => {
    return await cdpScreenshot(args.label);
  });
  ipcMain.handle('app:cdp_click', async (_e, args: { label: string; ref: string; button?: 'left' | 'right' | 'middle'; doubleClick?: boolean }) => {
    return await cdpClick(args.label, args.ref, { button: args.button, doubleClick: args.doubleClick });
  });
  ipcMain.handle('app:cdp_hover', async (_e, args: { label: string; ref: string }) => {
    return await cdpHover(args.label, args.ref);
  });
  ipcMain.handle('app:cdp_type', async (_e, args: { label: string; ref: string; text: string; submit?: boolean }) => {
    return await cdpType(args.label, args.ref, args.text, { submit: args.submit });
  });
  ipcMain.handle('app:cdp_press_key', async (_e, args: { label: string; key: string }) => {
    return await cdpPressKey(args.label, args.key);
  });
  ipcMain.handle('app:cdp_select_option', async (_e, args: { label: string; ref: string; values: string[] }) => {
    return await cdpSelectOption(args.label, args.ref, args.values);
  });
  ipcMain.handle('app:cdp_scroll', async (_e, args: { label: string; ref?: string; x?: number; y?: number }) => {
    return await cdpScroll(args.label, { ref: args.ref, x: args.x, y: args.y });
  });
  ipcMain.handle('app:cdp_navigate', async (_e, args: { label: string; action: 'goto' | 'back' | 'forward' | 'reload'; url?: string }) => {
    return await cdpNavigate(args.label, args.action, args.url);
  });
  ipcMain.handle('app:cdp_evaluate', async (_e, args: { label: string; function: string; ref?: string }) => {
    return await cdpEvaluate(args.label, args.function, { ref: args.ref });
  });
  ipcMain.handle('app:cdp_wait_for', async (_e, args: { label: string; text?: string; textGone?: string; time?: number; timeoutMs?: number }) => {
    return await cdpWaitFor(args.label, { text: args.text, textGone: args.textGone, time: args.time, timeoutMs: args.timeoutMs });
  });
  ipcMain.handle('app:cdp_console_messages', async (_e, args: { label: string; tail?: number }) => {
    return cdpConsoleMessages(args.label, { tail: args.tail });
  });
  ipcMain.handle('app:cdp_network_requests', async (_e, args: { label: string; tail?: number }) => {
    return cdpNetwork(args.label, { tail: args.tail });
  });
  ipcMain.handle('app:cdp_handle_dialog', async (_e, args: { label: string; accept: boolean; promptText?: string }) => {
    return await cdpHandleDialog(args.label, { accept: args.accept, promptText: args.promptText });
  });

  // --- remote SSH tunnels ---------------------------------------------------
  // Main owns the ssh masters. The renderer acquires a tunnel (getting a free
  // local port), then connects DIRECTLY to 127.0.0.1:<port> for that remote's
  // sessions. bun no longer proxies remote traffic.
  ipcMain.handle('app:remote_tunnel_acquire', async (_e, args: { remoteId: string }) => {
    const { localTunnelPort } = await acquireTunnel(args.remoteId);
    return { port: localTunnelPort };
  });
  ipcMain.handle('app:remote_tunnel_release', async (_e, args: { remoteId: string }) => {
    releaseTunnel(args.remoteId);
    return { ok: true };
  });
  ipcMain.handle('app:remote_tunnel_status', async (_e, args: { remoteId: string }) => {
    return getTunnelStatus(args.remoteId);
  });
  ipcMain.handle('app:remote_tunnel_disconnect', async (_e, args: { remoteId: string }) => {
    await disconnectTunnel(args.remoteId);
    return { ok: true };
  });
  ipcMain.handle('app:remote_test', async (_e, args: { remoteId: string }) => {
    return await probeRemoteHealth(args.remoteId);
  });
  ipcMain.handle('app:remote_forward_add', async (_e, args: { remoteId: string; remotePort: number; localPort?: number | null; label?: string }) => {
    return await addPortForward(args.remoteId, args.remotePort, args.localPort ?? null, args.label);
  });
  ipcMain.handle('app:remote_forward_remove', async (_e, args: { remoteId: string; localPort: number; remotePort: number }) => {
    await removePortForward(args.remoteId, args.localPort, args.remotePort);
    return { ok: true };
  });
  ipcMain.handle('app:remote_forward_list', async (_e, args: { remoteId: string }) => {
    return listActiveForwards(args.remoteId);
  });

  // --- plugin OAuth ---------------------------------------------------------
  ipcMain.handle('app:plugin_oauth_login', async (_e, args: { spec: OAuthSpec }) => {
    await pluginOauthLogin(args.spec, getBridgePort);
  });

  // --- file transfer (remote download / upload) -----------------------------
  // The renderer fetches/sends bytes over the SSH-tunnelled bridge; the native
  // side only provides the OS Save-As / Open dialogs and local disk IO.
  ipcMain.handle('app:save_file', async (_e, args: { suggestedName: string; data: Uint8Array }) => {
    const opts = { defaultPath: join(app.getPath('downloads'), args.suggestedName || 'download') };
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { canceled: true };
    writeFileSync(res.filePath, Buffer.from(args.data));
    return { canceled: false, path: res.filePath };
  });
  ipcMain.handle('app:pick_files', async () => {
    const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths.map((p) => ({ name: basename(p), data: readFileSync(p) }));
  });

  // --- auto-update ----------------------------------------------------------
  registerUpdaterIpc(() => mainWindow);

  // --- notifications (Web Notification API uses this under the hood) -------
  // No handler needed — Electron exposes `new Notification(...)` to the
  // renderer natively. Kept here as a note: don't re-implement; just call the
  // Web API from React.
  void Notification; // eslint-disable-line @typescript-eslint/no-unused-expressions
}

app.whenReady().then(async () => {
  installCliScript();
  logMain(`[startup] taskr ${app.getVersion()} — diagnostics log at ${diagnosticsLogPath()}`);

  mainWindow = createMainWindow();
  initBrowserPreview({
    mainWindow,
    onRelay: relayBrowserPreviewEvent,
  });
  registerIpcHandlers();

  // Remove stale ssh control sockets from a previous run, and forward tunnel
  // status changes to the renderer (replaces bun's `remote.status` WS frames).
  cleanupStaleControlSockets();
  onTunnelStatus((remoteId, status, lastError) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Include the current local port so the renderer can (re)point its direct
      // connection — the port changes whenever the ssh master respawns.
      const port = getTunnelLocalPort(remoteId);
      mainWindow.webContents.send('remote-tunnel-status', { remoteId, status, lastError, port });
    }
  });

  await loadInitialUrl(mainWindow);

  // Begin polling GitHub releases (packaged macOS builds only).
  startUpdateChecks(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      initBrowserPreview({ mainWindow, onRelay: relayBrowserPreviewEvent });
      loadInitialUrl(mainWindow).catch(() => {});
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { disposeAll(); } catch {}
  try { closeAllTunnels(); } catch {}
  killSidecar();
});

process.on('exit', () => {
  try { closeAllTunnels(); } catch {}
  killSidecar();
});
