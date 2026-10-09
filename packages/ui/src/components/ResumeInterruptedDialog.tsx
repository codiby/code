/**
 * Offers to restore sessions that were mid-turn when the app last closed (or
 * the bridge crashed). The bridge keeps the list until it's answered, so a
 * window reload asks again; "Descartar" or "Restaurar" settles it.
 *
 * Restoring sends each picked session a plain "Continúa." message, which
 * respawns its provider with the conversation's resume id.
 */
import { useEffect, useState } from 'react';
import { History, X, Loader2, Check } from 'lucide-react';
import type { ClaudeClient, InterruptedSession } from '../lib/claude-client';

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

export function ResumeInterruptedDialog({
  client,
  onOpenSession,
}: {
  client: ClaudeClient | null;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [list, setList] = useState<InterruptedSession[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return;
    void client.getInterruptedSessions().catch(() => []).then(items => {
      setList(items);
      setPicked(new Set(items.map(s => s.id)));
    });
  }, [client]);

  if (list.length === 0) return null;

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const dismiss = () => {
    void client?.dismissInterruptedSessions().catch(() => {});
    setList([]);
  };

  const resume = async () => {
    if (!client || picked.size === 0) return;
    setBusy(true);
    setError('');
    const ids = [...picked];
    try {
      const results = await client.resumeInterruptedSessions(ids);
      // The ones left unpicked aren't worth asking about again.
      void client.dismissInterruptedSessions().catch(() => {});
      const failed = results.filter(r => !r.ok);
      if (failed.length) {
        setError(`No se pudieron restaurar ${failed.length}: ${failed.map(f => f.error).filter(Boolean).join('; ')}`);
        setList(list.filter(s => failed.some(f => f.id === s.id)));
        setPicked(new Set());
      } else {
        if (ids.length === 1) onOpenSession?.(ids[0]!);
        setList([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const n = list.length;
  const ghostBtn = 'rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-surface-light hover:text-zinc-100 disabled:opacity-40';
  const primaryBtn = 'flex items-center justify-center gap-1.5 rounded-lg bg-zinc-100 py-1.5 text-[12px] font-semibold text-zinc-900 transition-opacity hover:opacity-90 disabled:opacity-40';

  return (
    <div
      role="dialog"
      aria-labelledby="resume-interrupted-title"
      className="fixed bottom-4 right-4 z-[10000] w-[360px] rounded-xl border border-border bg-surface p-3.5 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
          <History className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div id="resume-interrupted-title" className="text-[13px] font-semibold text-zinc-100">
            {n === 1 ? '¿Restaurar la sesión?' : `¿Restaurar ${n} sesiones?`}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
            La app se cerró mientras {n === 1 ? 'esta sesión trabajaba' : 'estas sesiones trabajaban'}. Al restaurar{n === 1 ? 'la' : 'las'}, {n === 1 ? 'continúa' : 'continúan'} donde se {n === 1 ? 'quedó' : 'quedaron'}.
          </div>
        </div>
        <button
          onClick={dismiss}
          disabled={busy}
          aria-label="Cerrar"
          className={`-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-light hover:text-zinc-200 ${busy ? 'invisible' : ''}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 max-h-[180px] space-y-0.5 overflow-y-auto pl-11">
        {list.map(s => (
          <label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-surface-light">
            {/* Drawn box: the native one inherits the accent oddly in the light theme. */}
            <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} disabled={busy} className="peer sr-only" />
            <span
              aria-hidden
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-1 peer-focus-visible:ring-zinc-400 ${
                picked.has(s.id) ? 'border-zinc-100 bg-zinc-100 text-zinc-900' : 'border-zinc-500 bg-transparent'
              }`}
            >
              {picked.has(s.id) && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{s.name || 'Sin nombre'}</span>
            <span className="shrink-0 truncate font-mono text-[10.5px] text-zinc-500">{folderName(s.cwd)}</span>
          </label>
        ))}
      </div>

      {error && <div className="mt-2 pl-11 text-[11px] text-red-400">{error}</div>}

      <div className="mt-3.5 flex items-center gap-1.5 whitespace-nowrap">
        <button onClick={dismiss} disabled={busy} className={`${ghostBtn} ml-auto`}>
          Descartar
        </button>
        <button onClick={() => void resume()} disabled={busy || picked.size === 0} className={`${primaryBtn} w-[118px]`}>
          {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          {busy ? 'Restaurando…' : picked.size === n ? 'Restaurar' : `Restaurar (${picked.size})`}
        </button>
      </div>
    </div>
  );
}
