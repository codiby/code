/**
 * Floating chat bubbles (Messenger chat-heads style).
 *
 * One transparent, frameless, always-on-top window covers the work area of a
 * single display. It stays click-through (`setIgnoreMouseEvents`) except
 * while the cursor is over a bubble or the open panel: the renderer reports
 * where those are (`bubble_hit_rects`) and main polls the cursor against
 * them. Everything
 * visual (stacking, drag, edge snap, dismiss target, panel) is CSS inside that
 * window, so it animates like the in-app mockup instead of moving a native
 * window around frame by frame.
 *
 * The renderer (`?bubbles` route of the regular UI bundle) opens its own
 * ClaudeClient to the bridge, so no session state is relayed through here —
 * main only owns which session ids are floating, and persists that list so
 * the bubbles come back after a relaunch.
 *
 * The same overlay hosts the quick launcher: a global shortcut (⌥Space) moves
 * it to the display under the cursor, makes it take clicks and keys, and asks
 * the renderer to open a Spotlight-style composer whose new session flies
 * straight into the bubble stack.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, type Display } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { logMain, wireRendererDiagnostics } from './diagnostics';

type Deps = {
  /** Existing main window, or null when it was closed (macOS keeps running). */
  getMainWindow: () => BrowserWindow | null;
  /** Re-create / show the main window — used when a bubble docks back. */
  showMainWindow: () => Promise<BrowserWindow>;
  /** Origin the UI is served from (dev server or the bridge). */
  getBaseUrl: () => Promise<string>;
};

let deps: Deps;
let win: BrowserWindow | null = null;
let creating: Promise<BrowserWindow> | null = null;
let ids: string[] = [];
/** Launcher is on screen (reported by the renderer). */
let spotlightOpen = false;
/** Shortcut fired before the renderer could listen; it asks on mount. */
let spotlightPending = false;
/** Undoes the takeover if the renderer never confirms the launcher is up. */
let spotlightWatchdog: ReturnType<typeof setTimeout> | null = null;
const SPOTLIGHT_CONFIRM_MS = 2500;

export const SPOTLIGHT_SHORTCUT = 'Alt+Space';
/** Opens the minimized bubbles from any app, or folds them back. */
export const BUBBLES_SHORTCUT = 'Alt+Escape';

// ---- click-through ----------------------------------------------------------
// Forwarded mouse-moves would be the natural signal, but on macOS they stop
// reaching a transparent window after it's hidden and re-shown (every launcher
// close), leaving bubbles that clicks fall straight through. Polling the
// cursor against rects the renderer reports doesn't depend on any of that.

type HitRect = { x: number; y: number; w: number; h: number };
let hitRects: HitRect[] = [];
/** A drag is in progress: keep taking clicks wherever the cursor goes. */
let hitHold = false;
let clickable = false;
let hitPoll: ReturnType<typeof setInterval> | null = null;
const HIT_POLL_MS = 33;

function setClickable(w: BrowserWindow, v: boolean): void {
  clickable = v;
  w.setIgnoreMouseEvents(!v, { forward: true });
}

function pollHit(): void {
  const w = alive();
  if (!w || !w.isVisible()) return;
  const c = screen.getCursorScreenPoint();
  const b = w.getBounds();
  const x = c.x - b.x;
  const y = c.y - b.y;
  const inside = hitHold || hitRects.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  if (inside !== clickable) setClickable(w, inside);
}

const statePath = () => join(app.getPath('userData'), 'bubbles.json');

function persist(): void {
  try { writeFileSync(statePath(), JSON.stringify({ ids })); } catch {}
}

function restore(): string[] {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'));
    return Array.isArray(raw?.ids) ? raw.ids.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function send(target: BrowserWindow | null, msg: unknown): void {
  if (target && !target.isDestroyed()) target.webContents.send('bubble-event', msg);
}

function broadcastList(): void {
  send(win, { type: 'list', ids });
  send(deps.getMainWindow(), { type: 'list', ids });
}

function alive(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** The overlay with its page loaded. `win` is set as soon as the window
 *  exists, so a caller arriving mid-load (the shortcut right after launch)
 *  waits for that load instead of getting a window with no page in it. */
function ensureWindow(): Promise<BrowserWindow> {
  if (creating) return creating;
  const existing = alive();
  if (!existing) {
    creating = createWindow().finally(() => { creating = null; });
  } else if (!loadedOverlays.has(existing) || existing.webContents.isCrashed()) {
    // A load that failed (bridge not up yet — the window then holds an error
    // page) or a renderer that died would swallow every shortcut press.
    logMain('[bubbles] overlay has no live page; reloading');
    creating = loadOverlay(existing).then(() => existing).finally(() => { creating = null; });
  } else {
    return Promise.resolve(existing);
  }
  return creating;
}

const OVERLAY_LOAD_ATTEMPTS = 5;
/** Overlays whose page actually loaded (not an error page). */
const loadedOverlays = new WeakSet<BrowserWindow>();

async function loadOverlay(w: BrowserWindow): Promise<void> {
  // 127.0.0.1, not localhost: a different site to Chromium, so the overlay
  // always gets its own renderer process. Sharing the main window's process
  // queued the shortcut behind whatever the chat was rendering (seconds while
  // a long session streams). The bridge answers on both hosts.
  loadedOverlays.delete(w);
  for (let attempt = 1; ; attempt++) {
    // Re-resolved each time: the bridge port can change while it boots.
    const url = `${(await deps.getBaseUrl()).replace('//localhost', '//127.0.0.1')}/?bubbles`;
    try {
      await w.loadURL(url);
      loadedOverlays.add(w);
      logMain(`[bubbles] overlay loaded ${url} (pid ${w.webContents.getOSProcessId()})`);
      return;
    } catch (err) {
      logMain(`[bubbles] overlay load failed (attempt ${attempt}/${OVERLAY_LOAD_ATTEMPTS}):`, err);
      if (attempt >= OVERLAY_LOAD_ATTEMPTS || w.isDestroyed()) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = new BrowserWindow({
    ...display.workArea,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // The overlay is almost never the key window; without this the first
    // click on a bubble only focuses it instead of registering.
    acceptFirstMouse: true,
    // A non-activating NSPanel: typing in the bubble's composer doesn't pull
    // the main window (or the Dock icon) to the front of whatever app the
    // user is working in.
    ...(process.platform === 'darwin' && { type: 'panel' as const }),
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
      // Bubbles live next to other apps, so the window is almost never
      // focused — throttling would stall the streaming ring and the peek.
      backgroundThrottling: false,
      webgl: false,
      enableWebSQL: false,
    },
  });
  win = w;
  // Crashes and console errors of the overlay land in main.log like the main window's.
  wireRendererDiagnostics(w);

  w.setAlwaysOnTop(true, 'floating');
  // skipTransformProcessType: otherwise macOS briefly turns the app into a
  // UI-element process, hiding its Dock icon and menu bar.
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  setClickable(w, false);
  hitRects = [];
  hitHold = false;
  if (hitPoll) clearInterval(hitPoll);
  hitPoll = setInterval(pollHit, HIT_POLL_MS);

  w.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  w.once('ready-to-show', () => w.showInactive());
  w.on('closed', () => {
    if (win !== w) return;
    win = null;
    if (hitPoll) clearInterval(hitPoll);
    hitPoll = null;
  });

  await loadOverlay(w);
  return w;
}

function closeWindow(): void {
  const w = alive();
  win = null;
  w?.destroy();
}

async function float(sessionId: string): Promise<void> {
  ids = [sessionId, ...ids.filter(x => x !== sessionId)];
  persist();
  await ensureWindow();
  broadcastList();
}

function unfloat(sessionId: string): void {
  ids = ids.filter(x => x !== sessionId);
  persist();
  broadcastList();
  if (ids.length === 0 && !spotlightOpen) closeWindow();
}

/** ⌥Space: open the launcher on the display under the cursor, or close it. */
/** Hand the screen back: the overlay goes click-through again and stops
 *  holding the keyboard. Safe to call from any state. */
function releaseOverlay(reason: string): void {
  logMain(`[bubbles] launcher closed by main: ${reason}`);
  if (spotlightWatchdog) clearTimeout(spotlightWatchdog);
  spotlightWatchdog = null;
  spotlightOpen = false;
  spotlightPending = false;
  // Forget the launcher's full-screen scrim; the renderer re-reports the rest.
  hitRects = [];
  hitHold = false;
  const w = alive();
  if (!w) return;
  setClickable(w, false);
  w.setAlwaysOnTop(true, 'floating');
  resign();
  send(w, { type: 'spotlight', open: false });
  if (ids.length === 0) closeWindow();
}

async function toggleSpotlight(): Promise<void> {
  // The second press always gets the user out — main does it itself instead
  // of asking a renderer that might be the thing that's stuck.
  if (spotlightOpen) {
    releaseOverlay('shortcut pressed again');
    return;
  }
  spotlightOpen = true;
  spotlightPending = true;
  logMain('[bubbles] launcher: opening');
  const w = await ensureWindow();
  logMain(`[bubbles] launcher: overlay pid ${w.webContents.getOSProcessId()}, main window pid ${deps.getMainWindow()?.webContents.getOSProcessId() ?? '-'}`);
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const b = w.getBounds();
  if (b.x !== wa.x || b.y !== wa.y || b.width !== wa.width || b.height !== wa.height) w.setBounds(wa);
  // Clicks and keyboard are only taken once the renderer confirms the
  // launcher is painted (see `takeOver`): an overlay that never answers must
  // not pull focus away from the user's app or eat their clicks.
  send(w, { type: 'spotlight', open: true });
  // A full-screen overlay that takes clicks but shows nothing would lock the
  // whole desktop; give up unless the renderer reports the launcher is up.
  if (spotlightWatchdog) clearTimeout(spotlightWatchdog);
  spotlightWatchdog = setTimeout(() => {
    spotlightWatchdog = null;
    if (spotlightOpen) releaseOverlay('renderer never confirmed the launcher');
  }, SPOTLIGHT_CONFIRM_MS);
}

/** The launcher is on screen: take clicks and the keyboard, and sit above
 *  full-screen apps and their menu bar. A `panel` window becomes key without
 *  activating the app, so the main window stays where it was. */
function takeOver(): void {
  const w = alive();
  if (!w) return;
  setClickable(w, true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.show();
  w.focus();
}

/** Give keyboard focus back to whatever app the user was in. Hiding a
 *  non-activating panel resigns key without activating our main window. */
function resign(): void {
  const w = alive();
  if (!w || !w.isFocused()) return;
  w.hide();
  w.showInactive();
  setClickable(w, false);
}

/** Keep the overlay on a display that still exists and still has this size. */
function refit(): void {
  const w = alive();
  if (!w) return;
  const b = w.getBounds();
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  if (b.x !== wa.x || b.y !== wa.y || b.width !== wa.width || b.height !== wa.height) w.setBounds(wa);
}

export function registerBubbles(d: Deps): void {
  deps = d;

  ipcMain.handle('app:bubble_list', () => ids);
  ipcMain.handle('app:bubble_float', async (_e, args: { sessionId: string }) => {
    await float(args.sessionId);
    return ids;
  });
  ipcMain.handle('app:bubble_unfloat', (_e, args: { sessionId: string }) => {
    unfloat(args.sessionId);
    return ids;
  });

  // "Back to tab": drop the bubble and bring the main window up on that session.
  ipcMain.handle('app:bubble_dock', async (_e, args: { sessionId: string }) => {
    unfloat(args.sessionId);
    const main = await d.showMainWindow();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    send(main, { type: 'dock', sessionId: args.sessionId });
  });

  ipcMain.handle('app:bubble_hit_rects', (_e, args: { rects: HitRect[]; hold: boolean }) => {
    hitRects = Array.isArray(args.rects) ? args.rects : [];
    hitHold = !!args.hold;
    pollHit();
  });

  // The panel takes keyboard focus while it's open so the composer can type;
  // `panel` windows don't activate the app, so the user's editor stays put.
  ipcMain.handle('app:bubble_focus', (_e, args: { focus: boolean }) => {
    const w = alive();
    if (!w) return;
    if (args.focus) w.focus();
    else w.blur();
  });

  // A drag ended at a screen point. When it's on another display, move the
  // overlay there and hand back the new origin so the renderer can re-anchor.
  ipcMain.handle('app:bubble_drop', (_e, args: { screenX: number; screenY: number }) => {
    const w = alive();
    if (!w) return null;
    const target: Display = screen.getDisplayNearestPoint({ x: Math.round(args.screenX), y: Math.round(args.screenY) });
    const wa = target.workArea;
    const b = w.getBounds();
    if (b.x === wa.x && b.y === wa.y && b.width === wa.width && b.height === wa.height) return null;
    w.setBounds(wa);
    return wa;
  });

  // Launcher lifecycle. `take` lets a freshly-loaded overlay pick up the
  // shortcut press that created it; `state` keeps the toggle honest and lets
  // the overlay go away once nothing is floating.
  ipcMain.handle('app:bubble_spotlight_take', () => {
    const pending = spotlightPending;
    spotlightPending = false;
    return pending;
  });
  ipcMain.handle('app:bubble_spotlight_state', (_e, args: { open: boolean; keepFocus?: boolean }) => {
    logMain(`[bubbles] launcher: renderer reports ${args.open ? 'open' : 'closed'}`);
    if (spotlightWatchdog) clearTimeout(spotlightWatchdog);
    spotlightWatchdog = null;
    spotlightOpen = args.open;
    spotlightPending = false;
    if (args.open) takeOver();
    else {
      alive()?.setAlwaysOnTop(true, 'floating');
      // A launch that opened its chat panel keeps the keyboard for it.
      if (!args.keepFocus) resign();
      const w = alive();
      if (w) setClickable(w, false);
      if (ids.length === 0) closeWindow();
    }
  });
  ipcMain.handle('app:bubble_resign', () => resign());

  if (!globalShortcut.register(SPOTLIGHT_SHORTCUT, () => {
    void toggleSpotlight().catch(err => {
      logMain('[bubbles] launcher failed to open:', err);
      releaseOverlay('open failed');
    });
  })) {
    logMain(`[bubbles] ${SPOTLIGHT_SHORTCUT} is taken by another app; the launcher has no shortcut`);
  }
  // The renderer picks the bubble and calls `bubble_focus`, which gives the
  // panel the keyboard so the reply box can type straight away.
  if (!globalShortcut.register(BUBBLES_SHORTCUT, () => {
    const w = alive();
    if (w && ids.length && !spotlightOpen) send(w, { type: 'toggle' });
  })) {
    logMain(`[bubbles] ${BUBBLES_SHORTCUT} is taken by another app; the bubbles have no shortcut`);
  }
  app.on('will-quit', () => {
    globalShortcut.unregister(SPOTLIGHT_SHORTCUT);
    globalShortcut.unregister(BUBBLES_SHORTCUT);
  });

  screen.on('display-removed', refit);
  screen.on('display-metrics-changed', refit);

  ids = restore();
  if (ids.length) void ensureWindow().catch(err => logMain('[bubbles] overlay restore failed:', err));
}

/** Called when the main window goes away for good (non-macOS quit path). */
export function disposeBubbles(): void {
  closeWindow();
}
