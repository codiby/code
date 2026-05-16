/**
 * Renderer preload for the main BrowserWindow.
 *
 * Exposes a single `window.codiby` bridge that the renderer uses to talk to
 * the main process. `codiby.invoke(cmd, args)` proxies to `ipcMain.handle`
 * channels registered under `app:<cmd>`. Event subscriptions are exposed as
 * `onBrowserPreviewEvent(...)` and `onCdpRequest(...)` — the React code
 * mounts those callbacks in `BrowserPanel.tsx` and the CDP bridge.
 */
import { contextBridge, ipcRenderer } from 'electron';

type RelayPayload = { label: string; payload: string | null };

contextBridge.exposeInMainWorld('codiby', {
  /**
   * Invoke a typed command on the main process. Returns whatever the
   * `ipcMain.handle('app:<cmd>', …)` handler resolved with, or rejects with
   * its error.
   */
  invoke: (cmd: string, args?: unknown) =>
    ipcRenderer.invoke(`app:${cmd}`, args ?? {}),

  /**
   * Subscribe to a browser-preview relay event. Returns an unlisten fn.
   * The renderer filters by `label` itself; we deliver every relay and let
   * `BrowserPanel.tsx` drop ones from other previews.
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
   * Wired by `src/lib/browser-cdp-bridge.ts`.
   */
  onCdpRequest(cb: (req: { requestId: string; action: string; args: unknown }) => void): () => void {
    const handler = (_e: unknown, req: { requestId: string; action: string; args: unknown }) => {
      cb(req);
    };
    ipcRenderer.on('cdp-request', handler);
    return () => ipcRenderer.removeListener('cdp-request', handler);
  },
});
