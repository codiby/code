import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'mobileKeepScreenOn';

type WakeLockSentinel = {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
};

function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * Manages a Screen Wake Lock so the device doesn't dim/sleep while the PWA is
 * in the foreground. The browser auto-releases the lock when the tab becomes
 * hidden, so we re-acquire on `visibilitychange` whenever the user has opted
 * in. State is persisted in localStorage so the preference survives reloads.
 */
export function useScreenWakeLock() {
  const supported = isSupported();
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (!supported) return false;
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  const release = useCallback(async () => {
    const s = sentinelRef.current;
    sentinelRef.current = null;
    if (s && !s.released) {
      try { await s.release(); } catch {}
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!supported) return;
    if (sentinelRef.current && !sentinelRef.current.released) return;
    try {
      const s = (await (navigator as any).wakeLock.request('screen')) as WakeLockSentinel;
      sentinelRef.current = s;
      s.addEventListener('release', () => {
        if (sentinelRef.current === s) sentinelRef.current = null;
      });
    } catch {
      // request() rejects if the document isn't visible or the OS denies the
      // lock (e.g. low-power mode). The visibilitychange handler will retry.
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    if (enabled) {
      void acquire();
    } else {
      void release();
    }
    return () => { void release(); };
  }, [supported, enabled, acquire, release]);

  useEffect(() => {
    if (!supported || !enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); };
  }, [supported, enabled, acquire]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  return { supported, enabled, setEnabled };
}
