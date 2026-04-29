import { useEffect, useRef, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

const DISMISSED_KEY = 'pwaInstallDismissedAt';
// Re-prompt after 14 days if the user dismissed.
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari pre-PWA flag
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
  // Safari (not Chrome on iOS, which uses CriOS)
  const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIos && isSafari;
}

function isDismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Floating banner that asks the user to install the app as a PWA.
 *
 * Two flavors:
 *   - Chromium-style: listens for `beforeinstallprompt`, shows an Install
 *     button that triggers the native install dialog.
 *   - iOS Safari: shows a hint with the Share icon + "Add to Home Screen"
 *     instructions (since Apple never fires beforeinstallprompt).
 *
 * Hides itself when:
 *   - The app is already running standalone, or
 *   - The user has dismissed it within the last 14 days.
 */
export function PwaInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [installed, setInstalled] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (isStandalone()) { setInstalled(true); return; }
    if (isDismissedRecently()) { setDismissed(true); return; }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); };
    window.addEventListener('beforeinstallprompt', onPrompt as EventListener);
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari never fires beforeinstallprompt — surface the manual hint.
    if (isIosSafari()) {
      // Slight delay so the page settles before the banner pops in
      const t = setTimeout(() => setShowIosHint(true), 1500);
      return () => {
        clearTimeout(t);
        window.removeEventListener('beforeinstallprompt', onPrompt as EventListener);
        window.removeEventListener('appinstalled', onInstalled);
      };
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt as EventListener);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;
  if (!deferredPrompt && !showIosHint) return null;

  const onDismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch {}
    setDismissed(true);
  };

  const onInstall = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      if (outcome === 'accepted') setInstalled(true);
      else onDismiss();
    } catch {
      // Some browsers throw if prompt() is called outside a gesture or twice
      onDismiss();
    }
  };

  return (
    <div
      className="fixed left-3 right-3 z-40 flex items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/85 px-3 py-2.5 shadow-2xl"
      style={{
        // Sits ABOVE the bottom nav (which is at ~5rem from viewport bottom
        // including its height + breathing room).
        bottom: 'calc(5.25rem + env(safe-area-inset-bottom))',
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
      }}
      role="dialog"
      aria-label="Install Claude as an app"
    >
      <div className="shrink-0 w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-300">
        <Download size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-zinc-100 leading-tight">Install Claude</div>
        {deferredPrompt ? (
          <div className="text-[11px] text-zinc-400 leading-tight mt-0.5">
            Add to your home screen for quick access
          </div>
        ) : (
          <div className="text-[11px] text-zinc-400 leading-tight mt-0.5 flex items-center gap-1 flex-wrap">
            Tap <Share size={11} className="inline" /> then "Add to Home Screen"
          </div>
        )}
      </div>
      {deferredPrompt && (
        <button
          type="button"
          onClick={onInstall}
          className="shrink-0 px-3 min-h-9 rounded-full bg-indigo-500 text-white text-[12px] font-semibold active:bg-indigo-600"
        >
          Install
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss install prompt"
        className="shrink-0 w-8 h-8 rounded-full text-zinc-400 active:text-zinc-200 active:bg-white/10 flex items-center justify-center"
      >
        <X size={16} />
      </button>
    </div>
  );
}
