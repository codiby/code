/**
 * Preload script attached to every browser-preview `BrowserView`.
 *
 * The previewed page is third-party content. We expose **one** function to
 * its main world — `__codiby_relay(event, payload)` — used by the injected
 * inspector overlay to send DOM events back to the host. Anything else
 * (Node APIs, ipcRenderer, contextBridge surface) stays hidden.
 *
 * Replaces the Tauri-side `INTERNALS.invoke('browser_preview_emit', ...)`
 * path used by the original inspector script.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__codiby_relay', (event: string, payload: string | null) => {
  if (typeof event !== 'string' || !event.startsWith('browser-preview://')) return;
  ipcRenderer.send('browser-preview-relay', { event, payload: payload ?? null });
});
