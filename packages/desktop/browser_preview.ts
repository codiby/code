/**
 * Embedded browser preview — Electron port of `browser_preview.rs`.
 *
 * Each preview is a `BrowserView` attached to the main `BrowserWindow` at
 * the rect computed by the React panel's ResizeObserver. The previewed
 * page is third-party content, so the BrowserView gets its own preload
 * (`preview_preload`) that only exposes a single `__codiby_relay`
 * function — used by the injected inspector script to relay events back
 * to the host renderer.
 *
 * CDP is attached on creation so the `electron/cdp.ts` tools can issue
 * DevTools commands against the same view.
 *
 * Wire protocol:
 *
 *   host → preview:   webContents.executeJavaScript into
 *                      window.__codibyInspector.{setInspecting,setComments}
 *
 *   preview → host:   inspector calls window.__codiby_relay(event, payload)
 *                      → preview_preload IPC `browser-preview-relay`
 *                      → main forwards to host via `browser-preview-event`
 *
 *   Events:
 *     - "browser-preview://ready"
 *     - "browser-preview://comments-changed"
 *     - "browser-preview://inspect-auto-off"
 *     - "browser-preview://url-changed"
 */
import { BrowserView, BrowserWindow, WebContents, session as electronSession } from 'electron';
import { join } from 'node:path';
import { renderInspectorScript } from './inspector_script';
import { attachCdp, detachCdp } from './cdp';

export type BrowserComment = { id: string; selector: string; summary: string; text: string };
export type Bounds = { x: number; y: number; width: number; height: number };

type PreviewState = {
  label: string;
  view: BrowserView;
  attached: boolean;
  bounds: Bounds;
  inspectorReady: boolean;
  /** Cookie-jar name used to build this view's partition. Tracked so an
   *  open call requesting a different jar can tear down and recreate the
   *  view under the new partition — Electron pins the partition at
   *  `BrowserView` construction time, so an in-place swap isn't possible. */
  cookieJar: string;
  /** The model-driven re-open token (`openSeq`) the view was last (re)pointed
   *  for. The React panel re-mounts on every tab switch and re-issues
   *  `open_browser_preview` with the *same* openSeq — that's a pure reattach
   *  and must NOT reload the live page. Only a bumped openSeq (a fresh
   *  `browser_open` from the SDK) is allowed to navigate the existing view.
   *  See the reuse path in `openBrowserPreview`. */
  openSeq: number;
};

const previews = new Map<string, PreviewState>();
const wcIdToLabel = new Map<number, string>();

let mainWindowRef: BrowserWindow | null = null;
let onRelay: ((label: string, event: string, payload: string | null) => void) | null = null;

export function initBrowserPreview(opts: {
  mainWindow: BrowserWindow;
  onRelay: (label: string, event: string, payload: string | null) => void;
}): void {
  mainWindowRef = opts.mainWindow;
  onRelay = opts.onRelay;
}

function requireMainWindow(): BrowserWindow {
  if (!mainWindowRef) throw new Error('browser_preview not initialized — call initBrowserPreview() first');
  return mainWindowRef;
}

function validateLabel(label: string): void {
  if (!label || label.length > 80) throw new Error('label must be 1..=80 chars');
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('label must match [a-zA-Z0-9_-]+');
}

/** Validate a cookie-jar name and turn it into an Electron partition string.
 *  Falsy / missing → the shared "default" jar. The `persist:` prefix tells
 *  Electron to keep cookies on disk across launches; the `codiby-browser-`
 *  namespace keeps these partitions clear of the ones used by `plugin_oauth`. */
const DEFAULT_COOKIE_JAR = 'default';
function partitionForJar(raw: string | undefined | null): string {
  const name = (raw || '').trim() || DEFAULT_COOKIE_JAR;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) {
    throw new Error(`invalid cookieJar "${raw}" — letters/digits/dash/underscore only, 1–40 chars, must start with a letter or digit`);
  }
  return `persist:codiby-browser-${name}`;
}
function normalizeJar(raw: string | undefined | null): string {
  return (raw || '').trim() || DEFAULT_COOKIE_JAR;
}

function validateUrl(raw: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch (e) {
    throw new Error(`invalid url: ${(e as Error).message}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported');
  }
  return parsed;
}

function clampBounds(b: Bounds): Bounds {
  return {
    x: Math.max(0, Math.round(b.x)),
    y: Math.max(0, Math.round(b.y)),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

function previewPreloadPath(): string {
  // Sibling JS in the compiled electron-dist tree.
  return join(__dirname, 'preview_preload.js');
}

/** Called by the host-side `browser-preview-relay` IPC handler in main.ts. */
export function handleRelay(senderWcId: number, event: string, payload: string | null): void {
  const label = wcIdToLabel.get(senderWcId);
  if (!label) return;
  if (!event.startsWith('browser-preview://')) return;
  onRelay?.(label, event, payload);
  if (event === 'browser-preview://ready') {
    const state = previews.get(label);
    if (state) state.inspectorReady = true;
  }
}

function wireWebContents(label: string, wc: WebContents) {
  const inspectorScript = renderInspectorScript(label);

  wc.on('did-finish-load', () => {
    wc.executeJavaScript(inspectorScript).catch(() => {});
  });
  wc.on('did-navigate', (_e, url) => {
    onRelay?.(label, 'browser-preview://url-changed', JSON.stringify({ url }));
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    onRelay?.(label, 'browser-preview://url-changed', JSON.stringify({ url }));
  });
}

export async function openBrowserPreview(args: {
  label: string;
  url: string;
  title?: string; // accepted for API symmetry, no chrome
  cookieJar?: string;
  /** Model-driven re-open token. Same value as last open → pure reattach
   *  (tab switch), keep the live page. Different value → the SDK re-pointed
   *  this browser, navigate to `url`. Undefined falls back to the legacy
   *  URL-diff behaviour. */
  openSeq?: number;
  x: number; y: number; width: number; height: number;
}): Promise<void> {
  validateLabel(args.label);
  const parsed = validateUrl(args.url);
  const targetUrl = parsed.toString();
  const jar = normalizeJar(args.cookieJar);
  const partition = partitionForJar(jar);

  const main = requireMainWindow();
  const bounds = clampBounds({ x: args.x, y: args.y, width: args.width, height: args.height });

  // Reuse an existing preview for this label rather than destroying and
  // recreating. The React panel re-mounts on every tab switch, and a
  // destroy/recreate here would reload the page from scratch every time
  // — losing scroll state, form input, authenticated sessions, etc.
  //
  //   - Reattach (same openSeq) → just re-show it and push fresh bounds,
  //     NEVER reload. A tab switch unmounts/remounts the React panel, which
  //     re-issues open with the *same* openSeq; the live view already holds
  //     the user's current page (post in-page navigation, scroll, form
  //     input), so loading anything here would snap it back to a stale URL.
  //   - Re-point (bumped openSeq, same jar) → navigate the existing view
  //     (loadURL). This is a fresh `browser_open` from the SDK. Cheaper than
  //     destroy+create, preserves the cookie/cache scope.
  //   - Different jar → fall through and recreate. The partition is fixed
  //     at `BrowserView` construction time, so an in-place swap is not
  //     possible; close + open is the only way to apply the new jar.
  //   - No existing view → create.
  const existing = previews.get(args.label);
  if (existing && existing.cookieJar === jar) {
    if (!existing.attached) {
      main.addBrowserView(existing.view);
      existing.attached = true;
    }
    existing.bounds = bounds;
    existing.view.setBounds(bounds);
    // Only navigate when the SDK genuinely re-pointed this browser (openSeq
    // bumped). On a pure reattach the live page is authoritative — leave it
    // be. When openSeq is absent (legacy caller) fall back to the URL diff.
    const repointed = args.openSeq === undefined
      ? existing.view.webContents.getURL() !== targetUrl
      : args.openSeq !== existing.openSeq;
    if (repointed) {
      existing.openSeq = args.openSeq ?? existing.openSeq;
      await existing.view.webContents.loadURL(targetUrl);
    }
    return;
  }
  if (existing) {
    // Jar changed — tear down the live view so the new partition takes
    // effect on the recreate below.
    closeBrowserPreview(args.label);
  }

  const partitionedSession = electronSession.fromPartition(partition);
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: previewPreloadPath(),
      session: partitionedSession,
    },
  });

  const wcId = view.webContents.id;
  const state: PreviewState = {
    label: args.label,
    view,
    attached: true,
    bounds,
    inspectorReady: false,
    cookieJar: jar,
    openSeq: args.openSeq ?? 0,
  };
  previews.set(args.label, state);
  wcIdToLabel.set(wcId, args.label);

  main.addBrowserView(view);
  view.setBounds(bounds);
  view.setAutoResize({ width: false, height: false });

  wireWebContents(args.label, view.webContents);
  attachCdp(args.label, view.webContents);

  await view.webContents.loadURL(targetUrl);
}

export function closeBrowserPreview(label: string): boolean {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  detachCdp(label);
  try {
    if (mainWindowRef && state.attached) mainWindowRef.removeBrowserView(state.view);
  } catch {}
  try {
    // Destroy the underlying webContents. There's no public BrowserView.destroy,
    // but closing the webContents collapses the surface.
    const wc = state.view.webContents as unknown as { destroy?: () => void; close?: () => void };
    if (typeof wc.destroy === 'function') wc.destroy();
    else if (typeof wc.close === 'function') wc.close();
  } catch {}
  wcIdToLabel.delete(state.view.webContents.id);
  previews.delete(label);
  return true;
}

export function setBounds(label: string, b: Bounds): boolean {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  const bounds = clampBounds(b);
  state.bounds = bounds;
  state.view.setBounds(bounds);
  return true;
}

export function setVisible(label: string, visible: boolean): boolean {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  if (!mainWindowRef) return false;
  if (visible && !state.attached) {
    mainWindowRef.addBrowserView(state.view);
    state.view.setBounds(state.bounds);
    state.attached = true;
  } else if (!visible && state.attached) {
    mainWindowRef.removeBrowserView(state.view);
    state.attached = false;
  }
  return true;
}

export function setInspect(label: string, enabled: boolean): boolean {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  const script = `window.__codibyInspector && window.__codibyInspector.setInspecting(${enabled ? 'true' : 'false'});`;
  state.view.webContents.executeJavaScript(script).catch(() => {});
  return true;
}

export function setComments(label: string, comments: BrowserComment[]): boolean {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  const json = JSON.stringify(comments ?? []);
  const script = `window.__codibyInspector && window.__codibyInspector.setComments(${json});`;
  state.view.webContents.executeJavaScript(script).catch(() => {});
  return true;
}

export async function navigate(
  label: string,
  action: 'back' | 'forward' | 'reload' | 'goto',
  url?: string | null,
): Promise<boolean> {
  validateLabel(label);
  const state = previews.get(label);
  if (!state) return false;
  const wc = state.view.webContents;
  switch (action) {
    case 'back':
      if (wc.canGoBack()) wc.goBack();
      return true;
    case 'forward':
      if (wc.canGoForward()) wc.goForward();
      return true;
    case 'reload':
      wc.reload();
      return true;
    case 'goto': {
      if (!url) throw new Error('goto requires `url`');
      const parsed = validateUrl(url);
      await wc.loadURL(parsed.toString());
      return true;
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

/** Look up the underlying WebContents for a label — used by cdp.ts. */
export function getWebContents(label: string): WebContents | null {
  return previews.get(label)?.view.webContents ?? null;
}

/** Drop every preview; used on app shutdown. */
export function disposeAll(): void {
  for (const label of [...previews.keys()]) {
    closeBrowserPreview(label);
  }
}
