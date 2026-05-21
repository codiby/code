/**
 * Native bridge — typed access to `window.codiby` exposed by the Electron
 * preload. In non-desktop contexts (browser dev server, mobile PWA) the
 * bridge is absent and `getNative()` returns null.
 */

type Unlisten = () => void;

type BrowserPreviewEventName =
  | 'browser-preview://ready'
  | 'browser-preview://comments-changed'
  | 'browser-preview://inspect-auto-off'
  | 'browser-preview://url-changed';

export type RelayPayload = { label: string; payload: string | null };

export interface CodibyNative {
  invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;
  onBrowserPreviewEvent(name: BrowserPreviewEventName, cb: (p: RelayPayload) => void): Unlisten;
  onCdpRequest(cb: (req: { requestId: string; action: string; args: unknown }) => void): Unlisten;
  /** Host webContents zoom factor (1.0 = no zoom). Sync, no IPC. */
  getZoomFactor(): number;
}

declare global {
  interface Window {
    codiby?: CodibyNative;
  }
}

export function getNative(): CodibyNative | null {
  if (typeof window === 'undefined') return null;
  return window.codiby ?? null;
}

export function isNative(): boolean {
  return getNative() !== null;
}

/** Invoke a main-process command. Throws when the bridge isn't available. */
export async function invokeNative<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const native = getNative();
  if (!native) {
    throw new Error(`native bridge unavailable — \`${cmd}\` called outside the desktop app`);
  }
  return native.invoke<T>(cmd, args);
}

/** Fire-and-forget variant. Resolves to null on missing bridge or rejection. */
export async function tryInvokeNative<T = unknown>(cmd: string, args?: unknown): Promise<T | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.invoke<T>(cmd, args);
  } catch {
    return null;
  }
}
