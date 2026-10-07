/**
 * Prompts the user to update the Claude Code CLI when a newer version is
 * published on their update channel. The SDK runs whatever `claude` binary is
 * installed on the bridge host, so an outdated CLI means an outdated model
 * list and missing fixes — independent of the app's own version.
 *
 * Checks on mount and hourly. "Después" hides the prompt until the next app
 * launch; "Omitir esta versión" remembers the version in localStorage and
 * only prompts again once a newer one ships.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, RefreshCw, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ClaudeClient, ClaudeVersionStatus } from '../lib/claude-client';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SKIPPED_KEY = 'codiby.claudeUpdate.skippedVersion';

type Phase = 'hidden' | 'available' | 'updating' | 'done' | 'error';

export function ClaudeUpdateDialog({ client }: { client: ClaudeClient | null }) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [status, setStatus] = useState<ClaudeVersionStatus | null>(null);
  const [error, setError] = useState('');
  // Versions dismissed with "Después" during this app run.
  const [snoozed, setSnoozed] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!client) return;
    const s = await client.getClaudeVersion().catch(() => null);
    if (!s?.updateAvailable || !s.latest) return;
    if (s.latest === snoozed) return;
    if (localStorage.getItem(SKIPPED_KEY) === s.latest) return;
    setStatus(s);
    setPhase((p) => (p === 'hidden' ? 'available' : p));
  }, [client, snoozed]);

  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => clearInterval(t);
  }, [check]);

  if (phase === 'hidden' || !status) return null;

  const later = () => {
    setSnoozed(status.latest);
    setPhase('hidden');
  };

  const skip = () => {
    if (status.latest) localStorage.setItem(SKIPPED_KEY, status.latest);
    setPhase('hidden');
  };

  const update = async () => {
    if (!client) return;
    setPhase('updating');
    setError('');
    try {
      const res = await client.updateClaude();
      setStatus(res.status);
      if (res.ok) {
        setPhase('done');
      } else {
        setError(lastLines(res.output) || 'claude update no instaló la nueva versión.');
        setPhase('error');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const busy = phase === 'updating';

  return (
    <div
      role="dialog"
      aria-labelledby="claude-update-title"
      className="fixed bottom-4 right-4 z-[9999] w-[340px] rounded-[12px] border border-[#2dd4bf33] bg-[#141519]/[0.97] p-[14px] shadow-[0_12px_40px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur"
    >
      <div className="flex items-start gap-[11px]">
        <div className="mt-px flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[#2dd4bf26] bg-[#2dd4bf12] text-[#2dd4bf]">
          {phase === 'error' ? <AlertTriangle className="h-4 w-4 text-[#f5b94a]" />
            : phase === 'done' ? <CheckCircle2 className="h-4 w-4" />
            : <ArrowUpCircle className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div id="claude-update-title" className="text-[13px] font-semibold text-[#eef0f2]">
            {phase === 'done' ? 'Claude Code actualizado'
              : phase === 'error' ? 'No se pudo actualizar Claude Code'
              : 'Nueva versión de Claude Code'}
          </div>
          <div className="mt-0.5 text-[11.5px] leading-[1.5] text-[#9aa0a8]">
            {phase === 'done' ? (
              <>Ahora tienes la v{status.installed}. Las sesiones nuevas ya la usan; las abiertas siguen con la anterior hasta que las reinicies.</>
            ) : phase === 'error' ? (
              <span className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-[#ef8a96]">{error}</span>
            ) : (
              <>Hay una versión nueva del CLI que usa la app para hablar con Claude. Actualizar trae los modelos y correcciones más recientes.</>
            )}
          </div>
        </div>
        <button
          onClick={phase === 'done' ? () => setPhase('hidden') : later}
          disabled={busy}
          aria-label="Cerrar"
          className={`ml-auto flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[#6b6e76] hover:bg-[#26272d] hover:text-[#e6e7ea] ${busy ? 'invisible' : ''}`}
        >
          <X className="h-[15px] w-[15px]" />
        </button>
      </div>

      {phase !== 'done' && (
        <div className="mt-[10px] flex items-center gap-[6px] font-mono text-[10.5px]">
          <span className="rounded-[6px] border border-[#ffffff14] bg-[#191a1f] px-[7px] py-px text-[#9aa0a8]">v{status.installed}</span>
          <span className="text-[#6b6e76]">→</span>
          <span className="rounded-[6px] border border-[#2dd4bf2e] bg-[#191a1f] px-[7px] py-px text-[#7ee0c4]">v{status.latest}</span>
          {status.channel !== 'latest' && <span className="text-[#6b6e76]">({status.channel})</span>}
        </div>
      )}

      <div className="mt-[12px] flex items-center gap-2 whitespace-nowrap">
        {phase === 'done' ? (
          <button
            onClick={() => setPhase('hidden')}
            className="ml-auto rounded-[9px] bg-[#2dd4bf] px-[14px] py-[7px] text-[12px] font-bold text-[#04201c] hover:brightness-110"
          >
            Listo
          </button>
        ) : (
          <>
            <button
              onClick={skip}
              disabled={busy}
              className="rounded-[7px] px-[6px] py-[7px] text-[11px] font-medium text-[#6b6e76] hover:text-[#c4c6cc] disabled:opacity-40"
            >
              Omitir esta versión
            </button>
            <button
              onClick={later}
              disabled={busy}
              className="ml-auto rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold text-[#6b6e76] hover:bg-[#1f2025] hover:text-[#c4c6cc] disabled:opacity-40"
            >
              Después
            </button>
            {/* Fixed width so the label swap to "Actualizando…" doesn't reflow the row. */}
            <button
              onClick={update}
              disabled={busy}
              className="flex w-[124px] items-center justify-center gap-1.5 rounded-[9px] bg-[#2dd4bf] py-[7px] text-[12px] font-bold text-[#04201c] transition-[filter] hover:brightness-110 disabled:opacity-50"
            >
              <RefreshCw className={`h-[13px] w-[13px] shrink-0 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Actualizando…' : phase === 'error' ? 'Reintentar' : 'Actualizar'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function lastLines(text: string, n = 6): string {
  return text.trim().split('\n').slice(-n).join('\n');
}
