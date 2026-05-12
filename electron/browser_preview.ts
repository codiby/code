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
 * Wire protocol (mirrors the Tauri version):
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
import { BrowserView, BrowserWindow, WebContents } from 'electron';
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
  x: number; y: number; width: number; height: number;
}): Promise<void> {
  validateLabel(args.label);
  const parsed = validateUrl(args.url);

  const main = requireMainWindow();

  // Close any existing preview with the same label first.
  closeBrowserPreview(args.label);

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: previewPreloadPath(),
    },
  });

  const wcId = view.webContents.id;
  const bounds = clampBounds({ x: args.x, y: args.y, width: args.width, height: args.height });
  const state: PreviewState = {
    label: args.label,
    view,
    attached: true,
    bounds,
    inspectorReady: false,
  };
  previews.set(args.label, state);
  wcIdToLabel.set(wcId, args.label);

  main.addBrowserView(view);
  view.setBounds(bounds);
  view.setAutoResize({ width: false, height: false });

  wireWebContents(args.label, view.webContents);
  attachCdp(args.label, view.webContents);

  await view.webContents.loadURL(parsed.toString());
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
