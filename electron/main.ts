/**
 * Electron entry point. Mirrors `src-tauri/src/lib.rs::run()`:
 *
 *   - install the codiby CLI to ~/.local/bin (best-effort).
 *   - create the main BrowserWindow.
 *   - spawn / discover the bun bridge sidecar (lazy, on first invoke).
 *   - register every `tauri:*` IPC channel the React code's `invoke()` shim
 *     reaches for, plus browser-preview / CDP / plugin OAuth handlers.
 *   - on shutdown, kill the sidecar and tear down all preview surfaces.
 */
import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron';
import { join } from 'node:path';

import { getBridgePort, killSidecar } from './bridge_server';
import { installCliScript } from './cli_installer';
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
  fill as cdpFill,
  scroll as cdpScroll,
  network as cdpNetwork,
} from './cdp';
import { pluginOauthLogin, type OAuthSpec } from './plugin_oauth';

const DEV = process.env.ELECTRON_DEV === '1' || !app.isPackaged;
const DEV_URL = process.env.CODIBY_DEV_URL || 'http://localhost:3111';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // External links open in the user's default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  return win;
}

async function loadInitialUrl(win: BrowserWindow): Promise<void> {
  if (DEV) {
    // Tauri's `devUrl` equivalent — the bridge serves the frontend dist over
    // :3111. `run.sh` (started independently) keeps the bundler and bridge alive.
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
  ipcMain.handle('tauri:get_bridge_port', async () => {
    return await getBridgePort();
  });

  // --- browser preview ------------------------------------------------------
  ipcMain.handle('tauri:open_browser_preview', async (_e, args: {
    label: string; url: string; title?: string;
    x: number; y: number; width: number; height: number;
  }) => {
    await openBrowserPreview(args);
  });
  ipcMain.handle('tauri:close_browser_preview', async (_e, args: { label: string }) => {
    return closeBrowserPreview(args.label);
  });
  ipcMain.handle('tauri:browser_preview_set_bounds', async (_e, args: {
    label: string; x: number; y: number; width: number; height: number;
  }) => {
    return setBounds(args.label, { x: args.x, y: args.y, width: args.width, height: args.height });
  });
  ipcMain.handle('tauri:browser_preview_set_visible', async (_e, args: { label: string; visible: boolean }) => {
    return setVisible(args.label, args.visible);
  });
  ipcMain.handle('tauri:browser_preview_set_inspect', async (_e, args: { label: string; enabled: boolean }) => {
    return setInspect(args.label, args.enabled);
  });
  ipcMain.handle('tauri:browser_preview_set_comments', async (_e, args: { label: string; comments: BrowserComment[] }) => {
    return setComments(args.label, args.comments);
  });
  ipcMain.handle('tauri:browser_preview_navigate', async (_e, args: {
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
  ipcMain.handle('tauri:cdp_snapshot', async (_e, args: { label: string }) => {
    return await cdpSnapshot(args.label);
  });
  ipcMain.handle('tauri:cdp_screenshot', async (_e, args: { label: string }) => {
    return await cdpScreenshot(args.label);
  });
  ipcMain.handle('tauri:cdp_click', async (_e, args: { label: string; id: string }) => {
    return await cdpClick(args.label, args.id);
  });
  ipcMain.handle('tauri:cdp_fill', async (_e, args: { label: string; id: string; value: string }) => {
    return await cdpFill(args.label, args.id, args.value);
  });
  ipcMain.handle('tauri:cdp_scroll', async (_e, args: { label: string; id?: string; x?: number; y?: number }) => {
    return await cdpScroll(args.label, { id: args.id, x: args.x, y: args.y });
  });
  ipcMain.handle('tauri:cdp_network', async (_e, args: { label: string; tail?: number }) => {
    return cdpNetwork(args.label, { tail: args.tail });
  });

  // --- plugin OAuth ---------------------------------------------------------
  ipcMain.handle('tauri:plugin_oauth_login', async (_e, args: { spec: OAuthSpec }) => {
    await pluginOauthLogin(args.spec, getBridgePort);
  });

  // --- notifications (Web Notification API uses this under the hood) -------
  // No handler needed — Electron exposes `new Notification(...)` to the
  // renderer natively. Kept here as a note: don't re-implement; just call the
  // Web API from React.
  void Notification; // eslint-disable-line @typescript-eslint/no-unused-expressions
}

app.whenReady().then(async () => {
  installCliScript();

  mainWindow = createMainWindow();
  initBrowserPreview({
    mainWindow,
    onRelay: relayBrowserPreviewEvent,
  });
  registerIpcHandlers();

  await loadInitialUrl(mainWindow);

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
  killSidecar();
});

process.on('exit', () => {
  killSidecar();
});
