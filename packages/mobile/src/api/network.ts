import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/** Mirrors `NetworkWatcher.Transport` on Android. */
export type Transport = 'wifi' | 'cellular' | 'other' | 'none' | 'unknown';

interface NativeNetworkEvents {
  current(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

function native(): NativeNetworkEvents | undefined {
  return Platform.OS === 'android'
    ? (NativeModules.NetworkEvents as NativeNetworkEvents | undefined)
    : undefined;
}

function asTransport(value: unknown): Transport {
  return value === 'wifi' || value === 'cellular' || value === 'other' || value === 'none'
    ? value
    : 'unknown';
}

/**
 * Called when the default network changes (Wi-Fi ↔ mobile ↔ none). Without
 * the native module (iOS, tests) nothing ever fires and callers keep their
 * timers as the fallback.
 */
export function onNetworkChange(listener: (transport: Transport) => void): () => void {
  const module = native();
  if (!module) {
    return () => undefined;
  }
  const emitter = new NativeEventEmitter(module as never);
  const sub = emitter.addListener('networkChanged', (event: { transport?: unknown }) =>
    listener(asTransport(event?.transport)),
  );
  return () => sub.remove();
}

export async function currentTransport(): Promise<Transport> {
  try {
    return asTransport(await native()?.current());
  } catch {
    return 'unknown';
  }
}

/** LAN-only hosts: unreachable over mobile data, so not worth a probe there. */
export function isPrivateUrl(url: string): boolean {
  const match = url.trim().match(/^[a-z]+:\/\/([^/:?#]+)/i);
  const host = match?.[1]?.toLowerCase() ?? '';
  if (host === 'localhost' || host.endsWith('.local')) {
    return true;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n))) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
