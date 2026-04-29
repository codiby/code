import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContainer,
  AlertDialogDialog,
  AlertDialogHeader,
  AlertDialogHeading,
  AlertDialogBody,
  AlertDialogFooter,
  Button,
} from '@heroui/react';
import { resolveServerUrl } from '../lib/claude-client';

interface Props {
  onClose: () => void;
}

interface PairInfo {
  url: string;
  token: string;
  lanIp: string;
  port: number;
  funnelUrl?: string;
  funnelHostname?: string;
}

type Mode = 'local' | 'funnel';

/**
 * Modal that shows a QR code the user scans from their phone to open the
 * mobile UI with the bearer token already applied. Hits `/mobile/pair` on
 * the bridge server (localhost-only endpoint).
 */
export function PairPhoneModal({ onClose }: Props) {
  const [info, setInfo] = useState<PairInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<Mode>('local');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const load = async (regenerate = false) => {
    try {
      const baseUrl = await resolveServerUrl();
      const endpoint = regenerate ? '/mobile/pair/regenerate' : '/mobile/pair';
      const res = await fetch(`${baseUrl}${endpoint}`, { method: regenerate ? 'POST' : 'GET' });
      if (!res.ok) {
        setError(`Server returned ${res.status}`);
        return;
      }
      const data = (await res.json()) as PairInfo;
      setInfo(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { load(); }, []);

  const activeUrl = mode === 'funnel' && info?.funnelUrl ? info.funnelUrl : info?.url;
  const hasFunnel = !!info?.funnelUrl;

  // If funnel becomes unavailable while selected, fall back to local.
  useEffect(() => {
    if (mode === 'funnel' && info && !info.funnelUrl) setMode('local');
  }, [mode, info]);

  // Render the QR code whenever the active URL changes
  useEffect(() => {
    if (!activeUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, activeUrl, {
      width: 260,
      margin: 2,
      color: { dark: '#0a0a0a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).catch((e) => setError(String(e)));
  }, [activeUrl]);

  const regenerate = async () => {
    setConfirmingRegen(false);
    setRegenerating(true);
    await load(true);
    setRegenerating(false);
  };

  const copy = async () => {
    if (!activeUrl) return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pair phone"
        className="w-full max-w-md rounded-2xl bg-zinc-950 border border-border shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-border">
          <h2 className="text-sm font-semibold text-zinc-100">Pair Phone</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light flex items-center justify-center text-lg"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5">
          <p className="text-[12px] text-zinc-400 mb-4 leading-relaxed">
            {mode === 'funnel' ? (
              <>Public Tailscale Funnel URL — works from any network. Anyone with this link can attempt to connect, but the bearer token gates access.</>
            ) : (
              <>Scan with your phone's camera. Make sure your phone is on the same WiFi network as this computer.</>
            )}
          </p>

          {error ? (
            <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {hasFunnel && (
                <div className="w-full inline-flex p-0.5 rounded-md bg-surface-light border border-border text-[11px]">
                  <button
                    onClick={() => setMode('local')}
                    className={`flex-1 px-3 py-1.5 rounded-[5px] transition-colors ${
                      mode === 'local'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Local network
                  </button>
                  <button
                    onClick={() => setMode('funnel')}
                    className={`flex-1 px-3 py-1.5 rounded-[5px] transition-colors ${
                      mode === 'funnel'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Tailscale Funnel
                  </button>
                </div>
              )}

              <div className="p-3 rounded-xl bg-white">
                <canvas ref={canvasRef} className="block" />
              </div>
              <div className="w-full">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  {mode === 'funnel' ? 'Funnel URL' : 'Mobile URL'}
                </div>
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 min-w-0 px-3 py-2 rounded-md bg-surface-light border border-border text-[11px] text-zinc-300 font-mono truncate">
                    {activeUrl || 'Loading…'}
                  </code>
                  <button
                    onClick={copy}
                    disabled={!activeUrl}
                    className="px-3 py-2 rounded-md bg-surface-light border border-border text-[11px] text-zinc-200 hover:bg-surface-lighter disabled:opacity-50"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {mode === 'funnel' ? (
                  <div className="mt-1.5 text-[10px] text-zinc-600">
                    Host: <span className="font-mono text-zinc-500">{info?.funnelHostname || '—'}</span>
                  </div>
                ) : (
                  <div className="mt-1.5 text-[10px] text-zinc-600">
                    LAN IP: <span className="font-mono text-zinc-500">{info?.lanIp || '—'}</span>
                    {' · '}Port: <span className="font-mono text-zinc-500">{info?.port ?? '—'}</span>
                  </div>
                )}
              </div>
              <div className="w-full flex items-center gap-2 pt-2 border-t border-border">
                <button
                  onClick={() => setConfirmingRegen(true)}
                  disabled={regenerating}
                  className="flex-1 text-[12px] px-3 py-2 rounded-md text-zinc-300 bg-surface-light border border-border hover:bg-surface-lighter disabled:opacity-50"
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate token'}
                </button>
                <button
                  onClick={onClose}
                  className="flex-1 text-[12px] px-3 py-2 rounded-md text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-border"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <AlertDialog isOpen={confirmingRegen} onOpenChange={setConfirmingRegen}>
        <AlertDialogBackdrop style={{ zIndex: 200 }}>
          <AlertDialogContainer size="sm" placement="center">
            <AlertDialogDialog>
              <AlertDialogHeader>
                <AlertDialogHeading>Regenerate pairing token?</AlertDialogHeading>
              </AlertDialogHeader>
              <AlertDialogBody>
                <p className="text-sm text-zinc-300">
                  All currently paired phones will have to rescan with the new QR code.
                </p>
              </AlertDialogBody>
              <AlertDialogFooter className="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  onPress={() => setConfirmingRegen(false)}
                  isDisabled={regenerating}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onPress={regenerate}
                  isDisabled={regenerating}
                >
                  {regenerating ? 'Regenerating…' : 'Regenerate'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogDialog>
          </AlertDialogContainer>
        </AlertDialogBackdrop>
      </AlertDialog>
    </div>
  );
}
