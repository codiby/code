/**
 * Signs the Claude Code CLI in from the app — the in-app version of `/login`.
 *
 * Each bridge host has its own CLI credentials, so this checks the local
 * bridge on mount and every remote as it comes online, and offers to sign in
 * the first one that has no account. A host on a third-party provider
 * (Bedrock, Vertex…) authenticates outside the CLI and is skipped.
 *
 * The browser step has two routes (see core handlers/claude-auth.ts):
 *   - automatic: the authorize page redirects to the CLI's localhost
 *     listener. Usable when the bridge is on this machine or the client could
 *     SSH-forward the callback port from a remote.
 *   - manual: the page shows a `code#state` to paste here. Always offered as
 *     the fallback, and the only route from a phone or a LAN browser.
 *
 * "Después" hides a host until the next app launch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, X, AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import type { ClaudeAuthStatus, ClaudeClient, ClaudeLoginMethod, ClaudeLoginStart, RemoteTarget } from '../lib/claude-client';

type RemoteStatus = { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null };
type Host = { remoteId: string | null; name: string };
type Phase =
  | { kind: 'prompt' }
  | { kind: 'starting' }
  | { kind: 'waiting'; flow: ClaudeLoginStart }
  | { kind: 'submitting'; flow: ClaudeLoginStart }
  | { kind: 'done'; status: ClaudeAuthStatus | null }
  | { kind: 'error'; message: string };

const POLL_MS = 1500;
const LOCAL_KEY = '';

interface Props {
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  remoteStatuses: Record<string, RemoteStatus>;
}

/** Signed out of the first-party API. Other providers sign in outside the CLI. */
const needsLogin = (s: ClaudeAuthStatus | null) =>
  !!s && !s.loggedIn && (!s.apiProvider || s.apiProvider === 'firstParty');

export function ClaudeLoginDialog({ client, remotes, remoteStatuses }: Props) {
  const [queue, setQueue] = useState<Host[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'prompt' });
  const [code, setCode] = useState('');
  const [showManual, setShowManual] = useState(false);
  /** A paste that never reached the CLI (no `#`); the flow is still alive. */
  const [inlineError, setInlineError] = useState('');
  const snoozed = useRef(new Set<string>());
  const lastStatus = useRef<Record<string, string>>({});

  const host = queue[0] ?? null;
  const hostKey = (h: Host) => h.remoteId ?? LOCAL_KEY;

  const enqueue = useCallback((h: Host, status: ClaudeAuthStatus | null) => {
    setQueue(prev => {
      const wanted = needsLogin(status) && !snoozed.current.has(hostKey(h));
      const present = prev.some(x => hostKey(x) === hostKey(h));
      // Keep its place: a remote reconnecting mid-flow must not swap the dialog to another host.
      if (wanted) return present ? prev : [...prev, h];
      return present ? prev.filter(x => hostKey(x) !== hostKey(h)) : prev;
    });
  }, []);

  // Local bridge: once per client.
  useEffect(() => {
    if (!client) return;
    void client.getClaudeAuth(null).catch(() => null).then(s => enqueue({ remoteId: null, name: 'este equipo' }, s));
  }, [client, enqueue]);

  // Remotes: each time one comes online, like RemoteVersionBanner.
  useEffect(() => {
    if (!client) return;
    for (const [remoteId, { status }] of Object.entries(remoteStatuses)) {
      const was = lastStatus.current[remoteId];
      lastStatus.current[remoteId] = status;
      if (status !== 'online' || was === 'online') continue;
      const name = remotes.find(r => r.id === remoteId)?.name || remoteId;
      // A bridge too old for /providers/claude/auth answers null and is left alone.
      void client.getClaudeAuth(remoteId).catch(() => null).then(s => enqueue({ remoteId, name }, s));
    }
  }, [client, remotes, remoteStatuses, enqueue]);

  // Poll the flow while the browser step is in progress. The automatic route
  // finishes on the bridge without any input from here.
  const waitingId = phase.kind === 'waiting' ? phase.flow.id : null;
  useEffect(() => {
    if (!client || !host || !waitingId) return;
    let stopped = false;
    const tick = async () => {
      const flow = await client.getClaudeLoginFlow(host.remoteId).catch(() => null);
      if (stopped || !flow || flow.id !== waitingId) return;
      if (flow.state === 'done') setPhase({ kind: 'done', status: flow.status });
      else if (flow.state === 'error') setPhase({ kind: 'error', message: flow.error || 'No se pudo iniciar sesión.' });
      else if (flow.state === 'cancelled') setPhase({ kind: 'prompt' });
    };
    const t = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [client, host, waitingId]);

  if (!host) return null;

  const reset = () => {
    setPhase({ kind: 'prompt' });
    setCode('');
    setShowManual(false);
    setInlineError('');
  };

  const next = () => {
    setQueue(prev => prev.slice(1));
    reset();
  };

  const later = () => {
    if (phase.kind === 'waiting' || phase.kind === 'submitting') void client?.cancelClaudeLogin(host.remoteId).catch(() => {});
    snoozed.current.add(hostKey(host));
    next();
  };

  const start = async (method: ClaudeLoginMethod) => {
    if (!client) return;
    setPhase({ kind: 'starting' });
    setCode('');
    setInlineError('');
    try {
      const flow = await client.startClaudeLogin(method, host.remoteId);
      setShowManual(!flow.automaticReachable);
      setPhase({ kind: 'waiting', flow });
      window.open(flow.automaticReachable ? flow.automaticUrl : flow.manualUrl, '_blank', 'noopener');
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const submit = async () => {
    if (!client || phase.kind !== 'waiting' || !code.trim()) return;
    // The page shows `code#state`; a pasted redirect URL carries both too.
    if (!code.includes('#') && !/^\s*https?:\/\//i.test(code)) {
      setInlineError('Pega el código completo que muestra la página (incluye un "#").');
      return;
    }
    const flow = phase.flow;
    setPhase({ kind: 'submitting', flow });
    try {
      const res = await client.submitClaudeLoginCode(code, host.remoteId);
      if (res.state === 'done') setPhase({ kind: 'done', status: res.status });
      // The CLI ends the flow on a bad code; a new one is needed either way.
      else if (res.state === 'error') setPhase({ kind: 'error', message: 'El código no fue aceptado. Vuelve a iniciar sesión.' });
      else setPhase({ kind: 'waiting', flow });
    } catch (err) {
      // Malformed paste: the flow is still alive, let them fix it.
      setPhase({ kind: 'waiting', flow });
      setInlineError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = phase.kind === 'starting' || phase.kind === 'submitting';
  const flow = phase.kind === 'waiting' || phase.kind === 'submitting' ? phase.flow : null;
  const where = host.remoteId ? <> en <span className="font-medium text-zinc-200">{host.name}</span></> : null;

  const ghostBtn = 'rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-surface-light hover:text-zinc-100 disabled:opacity-40';
  const primaryBtn = 'flex items-center justify-center gap-1.5 rounded-lg bg-zinc-100 py-1.5 text-[12px] font-semibold text-zinc-900 transition-opacity hover:opacity-90 disabled:opacity-40';

  return (
    <div
      role="dialog"
      aria-labelledby="claude-login-title"
      className="fixed bottom-4 right-4 z-[10000] w-[360px] rounded-xl border border-border bg-surface p-3.5 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            phase.kind === 'error' ? 'bg-amber-500/10 text-amber-400'
              : phase.kind === 'done' ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-[#d97757]/12 text-[#d97757]'
          }`}
        >
          {phase.kind === 'error' ? <AlertTriangle className="h-4 w-4" />
            : phase.kind === 'done' ? <CheckCircle2 className="h-4 w-4" />
            : <KeyRound className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div id="claude-login-title" className="text-[13px] font-semibold text-zinc-100">
            {phase.kind === 'done' ? 'Sesión iniciada'
              : phase.kind === 'error' ? 'No se pudo iniciar sesión'
              : 'Inicia sesión en Claude Code'}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
            {phase.kind === 'done' ? (
              <>
                {phase.status?.email ? <>Conectado como <span className="font-medium text-zinc-200">{phase.status.email}</span>{phase.status.subscriptionType ? ` (${phase.status.subscriptionType})` : ''}</> : 'Claude Code ya tiene cuenta'}
                {where}. Las sesiones nuevas ya la usan; reinicia las que estaban abiertas.
              </>
            ) : phase.kind === 'error' ? (
              <span className="break-words">{phase.message}</span>
            ) : flow ? (
              flow.automaticReachable && !showManual ? (
                <>Se abrió el navegador. Al autorizar, esto se completa solo.</>
              ) : (
                <>Autoriza en el navegador y pega aquí el código que te muestra la página.</>
              )
            ) : (
              <>El CLI de Claude Code{where} no tiene una cuenta. Sin ella, las sesiones de Claude no pueden responder.</>
            )}
          </div>
        </div>
        <button
          onClick={phase.kind === 'done' ? next : later}
          disabled={busy}
          aria-label="Cerrar"
          className={`-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-light hover:text-zinc-200 ${busy ? 'invisible' : ''}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {flow && (
        <div className="mt-3 space-y-2 pl-11">
          {showManual ? (
            <>
              <form
                onSubmit={(e) => { e.preventDefault(); void submit(); }}
                className="flex items-center gap-1.5"
              >
                <input
                  autoFocus
                  value={code}
                  onChange={(e) => { setCode(e.target.value); setInlineError(''); }}
                  placeholder="Pega el código"
                  spellCheck={false}
                  disabled={phase.kind === 'submitting'}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-base px-2.5 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:font-sans placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!code.trim() || phase.kind === 'submitting'}
                  className={`${primaryBtn} w-[72px]`}
                >
                  {phase.kind === 'submitting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Enviar'}
                </button>
              </form>
              {inlineError && <div className="text-[11px] text-red-400">{inlineError}</div>}
              <a
                href={flow.manualUrl}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-[11.5px] text-zinc-400 transition-colors hover:text-zinc-100"
              >
                <ExternalLink className="h-3 w-3" /> Abrir la página para obtener el código
              </a>
            </>
          ) : (
            <div className="flex items-center gap-2 whitespace-nowrap text-[11.5px] text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#d97757]" />
              <span>Esperando autorización…</span>
              <a href={flow.automaticUrl} target="_blank" rel="noopener" className="ml-auto text-zinc-400 transition-colors hover:text-zinc-100">
                Abrir de nuevo
              </a>
            </div>
          )}
        </div>
      )}

      <div className="mt-3.5 flex items-center gap-1.5 whitespace-nowrap">
        {phase.kind === 'done' ? (
          <button onClick={next} className={`${primaryBtn} ml-auto px-4`}>
            Listo
          </button>
        ) : flow ? (
          <>
            {!showManual && (
              <button
                onClick={() => setShowManual(true)}
                className="rounded-lg px-1.5 py-1.5 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-200"
              >
                Pegar un código
              </button>
            )}
            <button
              onClick={() => { void client?.cancelClaudeLogin(host.remoteId).catch(() => {}); reset(); }}
              disabled={busy}
              className={`${ghostBtn} ml-auto`}
            >
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void start('console')}
              disabled={busy}
              title="Facturación por uso de la API en lugar de la suscripción"
              className="rounded-lg px-1.5 py-1.5 text-[11.5px] text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-40"
            >
              Usar Console
            </button>
            <button onClick={later} disabled={busy} className={`${ghostBtn} ml-auto`}>
              Después
            </button>
            {/* Fixed width so the label swap to "Abriendo…" doesn't reflow the row. */}
            <button
              onClick={() => void start('claudeai')}
              disabled={busy}
              className={`${primaryBtn} w-[118px]`}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              {busy ? 'Abriendo…' : phase.kind === 'error' ? 'Reintentar' : 'Iniciar sesión'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
