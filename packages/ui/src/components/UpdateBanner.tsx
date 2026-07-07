/**
 * Auto-update banner. Listens for `update-event` from the Electron main
 * process (see electron/updater.ts) and surfaces a bottom-right card when a
 * newer GitHub release is available. Accepting downloads the .dmg (with a
 * progress bar) and triggers the privileged installer, which quits and
 * relaunches the app.
 *
 * No-op outside the desktop app (no `window.codiby` bridge).
 */
import { useEffect, useState } from 'react';
import { Download, X, RefreshCw, AlertTriangle } from 'lucide-react';
import { getNative, type UpdateEvent, type UpdateInfo } from '../lib/native';

type Phase = 'hidden' | 'available' | 'downloading' | 'installing' | 'error';

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const native = getNative();
    if (!native?.onUpdateEvent) return;
    return native.onUpdateEvent((msg: UpdateEvent) => {
      switch (msg.type) {
        case 'available':
          if (msg.info) setInfo(msg.info);
          setPhase((p) => (p === 'downloading' || p === 'installing' ? p : 'available'));
          break;
        case 'progress':
          setProgress(msg.progress ?? 0);
          setPhase('downloading');
          break;
        case 'installing':
          setPhase('installing');
          break;
        case 'error':
          setError(msg.message ?? 'Update failed');
          setPhase('error');
          break;
      }
    });
  }, []);

  if (phase === 'hidden' || !info) return null;

  const startUpdate = () => {
    setPhase('downloading');
    setProgress(0);
    void getNative()?.invoke('update_download_and_install', { info });
  };

  const pct = Math.round(progress * 100);

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-80 rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-zinc-800 p-2">
          {phase === 'error' ? (
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          ) : (
            <Download className="h-4 w-4 text-zinc-200" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {phase === 'error' ? (
            <>
              <div className="text-sm font-medium text-zinc-100">No se pudo actualizar</div>
              <div className="mt-1 break-words text-xs text-zinc-400">{error}</div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-zinc-100">
                Nueva versión disponible
              </div>
              <div className="mt-0.5 text-xs text-zinc-400">
                Codiby Code v{info.version}
              </div>
            </>
          )}
        </div>
        {(phase === 'available' || phase === 'error') && (
          <button
            onClick={() => setPhase('hidden')}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            aria-label="Descartar"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {phase === 'downloading' && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-zinc-200 transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 text-right text-[11px] text-zinc-500">Descargando… {pct}%</div>
        </div>
      )}

      {phase === 'installing' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Instalando — la app se reiniciará…
        </div>
      )}

      {(phase === 'available' || phase === 'error') && (
        <div className="mt-3 flex justify-end gap-2">
          {phase === 'available' && (
            <button
              onClick={() => setPhase('hidden')}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Después
            </button>
          )}
          <button
            onClick={startUpdate}
            className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white"
          >
            {phase === 'error' ? 'Reintentar' : 'Actualizar ahora'}
          </button>
        </div>
      )}
    </div>
  );
}
