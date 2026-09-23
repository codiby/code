/**
 * Warns when a remote's bridge runs an older release than this app. Both carry
 * the `package.json` version the GitHub release is tagged with — the UI inlined
 * at build time, the bridge through `GET /host`. A bridge too old to report one
 * predates the check and counts as outdated.
 *
 * Checked each time a remote comes online, so redeploying the remote and
 * reconnecting clears the card by itself. Dismissal is remembered per remote
 * *and* version: the next release nags again.
 *
 * A bridge that reports `canSelfUpdate` gets an Update button: `/self-update`
 * fast-forwards its checkout and restarts it, and the card polls `/host` until
 * the bridge answers from the new commit.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { ClaudeClient, RemoteTarget } from '../lib/claude-client';

type RemoteStatus = { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null };
type Stale = { remoteId: string; name: string; remoteVersion: string | null; appVersion: string; canSelfUpdate: boolean };
type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'updating'; step: string }
  | { kind: 'error'; message: string };

/** Inlined by scripts/build.ts; empty in a bundle built without it. */
const APP_VERSION = process.env.CODIBY_APP_VERSION || '';
const DISMISS_KEY = 'codiby-remote-version-dismissed';
const DEPLOY_CMD = 'git pull && systemctl --user restart codiby-code.service';
const POLL_MS = 3000;
// The restart reinstalls deps and rebuilds both frontends before serving.
const RESTART_TIMEOUT_MS = 5 * 60_000;

/** -1 / 0 / 1 for x.y.z strings; anything unparsable sorts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)) ?? [0, 0, 0];
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}

const isOutdated = (remoteVersion: string | null, appVersion: string) =>
  !remoteVersion || compareVersions(remoteVersion, appVersion) < 0;

function dismissed(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Props {
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  remoteStatuses: Record<string, RemoteStatus>;
}

export function RemoteVersionBanner({ client, remotes, remoteStatuses }: Props) {
  const [stale, setStale] = useState<Stale[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const lastStatus = useRef<Record<string, string>>({});
  const updating = useRef(false);

  useEffect(() => {
    if (!client || !APP_VERSION) return;
    const appVersion = APP_VERSION;
    for (const [remoteId, { status }] of Object.entries(remoteStatuses)) {
      const was = lastStatus.current[remoteId];
      lastStatus.current[remoteId] = status;
      // A self-update in flight owns its card until it lands.
      if (status !== 'online' || was === 'online' || updating.current) continue;
      void client.getHostInfo(remoteId).catch(() => null).then(remote => {
        // No answer at all from the remote: nothing trustworthy to compare.
        if (!remote) return;
        const remoteVersion = remote.appVersion ?? null;
        const hidden = dismissed()[remoteId] === `${remoteVersion}<${appVersion}`;
        const name = remotes.find(r => r.id === remoteId)?.name || remote.name;
        setStale(prev => {
          const rest = prev.filter(s => s.remoteId !== remoteId);
          return isOutdated(remoteVersion, appVersion) && !hidden
            ? [...rest, { remoteId, name, remoteVersion, appVersion, canSelfUpdate: !!remote.canSelfUpdate }]
            : rest;
        });
      });
    }
  }, [client, remotes, remoteStatuses]);

  if (stale.length === 0) return null;
  const s = stale[0]!;

  const drop = (remoteId: string) => {
    setStale(prev => prev.filter(x => x.remoteId !== remoteId));
    setPhase({ kind: 'idle' });
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...dismissed(), [s.remoteId]: `${s.remoteVersion}<${s.appVersion}` }));
    drop(s.remoteId);
  };

  const copy = () => {
    void navigator.clipboard.writeText(DEPLOY_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const runUpdate = async () => {
    if (!client) return;
    updating.current = true;
    setPhase({ kind: 'updating', step: 'Descargando cambios…' });
    try {
      const result = await client.selfUpdate(s.remoteId);
      if (!result.ok) { setPhase({ kind: 'error', message: result.error }); return; }
      if (!result.restarting) {
        setPhase({ kind: 'error', message: `${s.name} ya está en lo último de ${result.branch} (v${result.version}), que todavía no tiene v${s.appVersion}.` });
        return;
      }
      setPhase({ kind: 'updating', step: `Reiniciando en v${result.version}…` });
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const host = await client.getHostInfo(s.remoteId).catch(() => null);
        if (host?.commit !== result.commit) continue;
        const remoteVersion = host.appVersion ?? null;
        if (isOutdated(remoteVersion, s.appVersion)) {
          setStale(prev => prev.map(x => x.remoteId === s.remoteId ? { ...x, remoteVersion } : x));
          setPhase({ kind: 'error', message: `Se actualizó a v${remoteVersion} (lo último de ${result.branch}), pero esta app es v${s.appVersion}.` });
        } else {
          drop(s.remoteId);
        }
        return;
      }
      setPhase({ kind: 'error', message: `${s.name} no volvió en 5 min. Revisa: journalctl --user -u codiby-code.service` });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      updating.current = false;
    }
  };

  const busy = phase.kind === 'updating';

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

          {phase.kind === 'confirm' ? (
            <div className="mt-2.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-zinc-300">
              Se reinicia el servidor de {s.name} y se cortan las sesiones que estén corriendo ahí.
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={runUpdate} className="rounded-md bg-zinc-100 px-2.5 py-1 font-medium text-zinc-900 hover:bg-white">
                  Actualizar y reiniciar
                </button>
                <button type="button" onClick={() => setPhase({ kind: 'idle' })} className="rounded-md px-2.5 py-1 text-zinc-400 hover:text-zinc-200">
                  Cancelar
                </button>
              </div>
            </div>
          ) : busy ? (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-zinc-300">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />
              {phase.step}
            </div>
          ) : (
            <>
              {phase.kind === 'error' && (
                <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-red-400">{phase.message}</div>
              )}
              {s.canSelfUpdate ? (
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'confirm' })}
                  className="mt-2.5 rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-white"
                >
                  {phase.kind === 'error' ? 'Reintentar' : 'Actualizar'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={copy}
                  title="Copiar"
                  className="mt-2 block w-full truncate rounded-md bg-black/40 px-2 py-1.5 text-left font-mono text-[11px] text-zinc-300 hover:bg-black/60"
                >
                  {copied ? 'Copiado ✓' : DEPLOY_CMD}
                </button>
              )}
            </>
          )}
          {stale.length > 1 && <div className="mt-1.5 text-[11px] text-zinc-500">+{stale.length - 1} remoto(s) más</div>}
        </div>
        <button type="button" onClick={dismiss} disabled={busy} aria-label="Descartar" className="text-zinc-500 hover:text-zinc-300 disabled:opacity-30">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
