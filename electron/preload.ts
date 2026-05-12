/**
 * Renderer preload for the main BrowserWindow.
 *
 * Exposes a Tauri-compatible shim so the React code can keep calling
 * `import('@tauri-apps/api/core').invoke(...)` unchanged. Tauri 2's
 * `invoke()` reads `window.__TAURI_INTERNALS__.invoke` — if that exists, the
 * call routes through it.
 *
 * For the browser-preview event subsystem (Tauri's `listen(...)`), we expose
 * a separate `window.codiby` namespace. Tauri 2's event listener internals
 * (transformCallback / world-isolated eval) are not worth porting; React
 * already gates this to a single component (`BrowserPanel.tsx`).
 */
import { contextBridge, ipcRenderer } from 'electron';

type RelayPayload = { label: string; payload: string | null };

contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', {
  invoke: (cmd: string, args?: unknown) =>
    ipcRenderer.invoke(`tauri:${cmd}`, args ?? {}),
  // Tauri internals sometimes also touch these — expose harmless no-ops so
  // any future code paths that lazily probe them don't crash.
  metadata: { plugins: {} },
  transformCallback: () => 0,
});

contextBridge.exposeInMainWorld('codiby', {
  /**
   * Subscribe to a browser-preview relay event. Returns an unlisten fn.
   * The renderer filters by `label` itself; we deliver every relay and let
   * `BrowserPanel.tsx` drop ones from other previews (same shape as the
   * Tauri broadcast it replaces).
   */
  onBrowserPreviewEvent(
    eventName:
      | 'browser-preview://ready'
      | 'browser-preview://comments-changed'
      | 'browser-preview://inspect-auto-off'
      | 'browser-preview://url-changed',
    cb: (payload: RelayPayload) => void,
  ): () => void {
    const handler = (_e: unknown, msg: { event: string; label: string; payload: string | null }) => {
      if (msg.event !== eventName) return;
      cb({ label: msg.label, payload: msg.payload });
    };
    ipcRenderer.on('browser-preview-event', handler);
    return () => ipcRenderer.removeListener('browser-preview-event', handler);
  },

  /**
   * Subscribe to the bridge→main→renderer CDP request channel. The bridge
   * broadcasts `browser_request` over its WS; the renderer hands the
   * request off to main via this callback. Returns an unlisten fn.
   *
   * Wired by `src/lib/browser-cdp-bridge.ts` once it's added in the SDK
   * MCP commit.
   */
  onCdpRequest(cb: (req: { requestId: string; action: string; args: unknown }) => void): () => void {
    const handler = (_e: unknown, req: { requestId: string; action: string; args: unknown }) => {
      cb(req);
    };
    ipcRenderer.on('cdp-request', handler);
    return () => ipcRenderer.removeListener('cdp-request', handler);
  },
});
