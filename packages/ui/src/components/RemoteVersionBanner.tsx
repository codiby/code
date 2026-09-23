/**
 * Warns when a remote's bridge runs an older release than this app. Both carry
 * the `package.json` version the GitHub release is tagged with — the UI inlined
 * at build time, the bridge through `GET /host`. A bridge too old to report one
 * predates the check and counts as outdated.
 *
 * Checked each time a remote comes online, so redeploying the remote and
 * reconnecting clears the card by itself. Dismissal is remembered per remote
 * *and* version: the next release nags again.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { ClaudeClient, RemoteTarget } from '../lib/claude-client';

type RemoteStatus = { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null };
type Stale = { remoteId: string; name: string; remoteVersion: string | null; appVersion: string };

/** Inlined by scripts/build.ts; empty in a bundle built without it. */
const APP_VERSION = process.env.CODIBY_APP_VERSION || '';
const DISMISS_KEY = 'codiby-remote-version-dismissed';
const DEPLOY_CMD = 'git pull && systemctl --user restart codiby-code.service';

/** -1 / 0 / 1 for x.y.z strings; anything unparsable sorts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)) ?? [0, 0, 0];
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}

function dismissed(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; }
}

interface Props {
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  remoteStatuses: Record<string, RemoteStatus>;
}

export function RemoteVersionBanner({ client, remotes, remoteStatuses }: Props) {
  const [stale, setStale] = useState<Stale[]>([]);
  const [copied, setCopied] = useState(false);
  const lastStatus = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!client || !APP_VERSION) return;
    const appVersion = APP_VERSION;
    for (const [remoteId, { status }] of Object.entries(remoteStatuses)) {
      const was = lastStatus.current[remoteId];
      lastStatus.current[remoteId] = status;
      if (status !== 'online' || was === 'online') continue;
      void client.getHostInfo(remoteId).catch(() => null).then(remote => {
        // No answer at all from the remote: nothing trustworthy to compare.
        if (!remote) return;
        const remoteVersion = remote.appVersion ?? null;
        const outdated = !remoteVersion || compareVersions(remoteVersion, appVersion) < 0;
        const hidden = dismissed()[remoteId] === `${remoteVersion}<${appVersion}`;
        const name = remotes.find(r => r.id === remoteId)?.name || remote.name;
        setStale(prev => {
          const rest = prev.filter(s => s.remoteId !== remoteId);
          return outdated && !hidden ? [...rest, { remoteId, name, remoteVersion, appVersion }] : rest;
        });
      });
    }
  }, [client, remotes, remoteStatuses]);

  if (stale.length === 0) return null;
  const s = stale[0]!;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...dismissed(), [s.remoteId]: `${s.remoteVersion}<${s.appVersion}` }));
    setStale(prev => prev.filter(x => x.remoteId !== s.remoteId));
  };

  const copy = () => {
    void navigator.clipboard.writeText(DEPLOY_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div role="status" className="fixed bottom-4 right-4 z-[9998] w-96 rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-zinc-800 p-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100">{s.name} está desactualizado</div>
          <div className="mt-0.5 text-xs text-zinc-400">
            Su servidor corre {s.remoteVersion ? <span className="font-mono">v{s.remoteVersion}</span> : 'una versión que no reporta la suya'}
            {' '}y esta app es <span className="font-mono">v{s.appVersion}</span>. Algunas funciones pueden fallar.
          </div>
          <button
            type="button"
            onClick={copy}
            title="Copiar"
            className="mt-2 block w-full truncate rounded-md bg-black/40 px-2 py-1.5 text-left font-mono text-[11px] text-zinc-300 hover:bg-black/60"
          >
            {copied ? 'Copiado ✓' : DEPLOY_CMD}
          </button>
          {stale.length > 1 && <div className="mt-1.5 text-[11px] text-zinc-500">+{stale.length - 1} remoto(s) más</div>}
        </div>
        <button type="button" onClick={dismiss} aria-label="Descartar" className="text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
