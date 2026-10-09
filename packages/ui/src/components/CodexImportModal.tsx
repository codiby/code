/**
 * Picks a Codex thread started outside the app (`codex` in a terminal, Codex
 * Desktop) and imports it as a session, so the conversation continues here.
 *
 * Importing a thread that already has a session tops it up with the turns run
 * in the console since, then opens it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, Search, Terminal, X } from 'lucide-react';
import type { ClaudeClient, CodexThread, RemoteTarget } from '../lib/claude-client';

const REMOTE_DOT: Record<string, string> = {
  blue: 'bg-blue-400', green: 'bg-green-400', amber: 'bg-amber-400',
  violet: 'bg-violet-400', red: 'bg-red-400', pink: 'bg-pink-400',
};

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

const ORIGIN_LABEL: Record<string, string> = { 'codex-tui': 'terminal', codex_exec: 'exec', 'Codex Desktop': 'desktop', codiby_code: 'esta app' };

export function CodexImportModal({
  open,
  client,
  remotes,
  onClose,
  onImported,
}: {
  open: boolean;
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  onClose: () => void;
  onImported: (sessionId: string) => void;
}) {
  // Each host keeps its own ~/.codex, so the list is per host; null = this machine.
  const [host, setHost] = useState<string | null>(null);
  const [threads, setThreads] = useState<CodexThread[] | null>(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !client) return;
    setThreads(null);
    setQuery('');
    setError('');
    let stale = false;
    client.getCodexThreads(host).then(list => { if (!stale) setThreads(list); }).catch(err => {
      if (stale) return;
      setThreads([]);
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { stale = true; };
  }, [open, client, host]);

  // A host removed while the modal was closed falls back to this machine.
  useEffect(() => {
    if (host && !remotes.some(r => r.id === host)) setHost(null);
  }, [remotes, host]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const visible = useMemo(() => {
    // Threads this app started and still holds are already sessions here.
    const list = (threads || []).filter(t => !(t.originator === 'codiby_code' && t.sessionId));
    const q = query.trim().toLowerCase();
    return q ? list.filter(t => `${t.name} ${t.cwd}`.toLowerCase().includes(q)) : list;
  }, [threads, query]);

  if (!open) return null;

  const pick = async (thread: CodexThread) => {
    if (!client || busyId) return;
    setBusyId(thread.id);
    setError('');
    try {
      const { session } = await client.importCodexThread(thread.id, host);
      onImported(session.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="codex-import-title"
    >
      <div className="flex h-[min(70vh,620px)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border p-3.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Terminal className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="codex-import-title" className="text-[13px] font-semibold text-zinc-100">Importar sesión de Codex</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
              Trae una conversación que empezaste con <code className="font-mono">codex</code> en la terminal y continúala aquí. Si ya la importaste, se agregan los turnos nuevos.
            </div>
          </div>
          <button onClick={onClose} aria-label="Cerrar" className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-light hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        {remotes.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3.5 py-2">
            {[{ id: null as string | null, name: 'Local', color: null as string | null | undefined }, ...remotes.map(r => ({ id: r.id as string | null, name: r.name || r.id, color: r.color }))].map(h => (
              <button
                key={h.id ?? 'local'}
                type="button"
                onClick={() => setHost(h.id)}
                disabled={!!busyId}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] uppercase tracking-wider transition-colors ${
                  host === h.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                }`}
              >
                {h.id && <span className={`h-1.5 w-1.5 rounded-full ${REMOTE_DOT[h.color || ''] || 'bg-zinc-500'}`} />}
                {h.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && visible[0]) void pick(visible[0]); }}
            placeholder="Buscar por nombre o carpeta"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto p-1.5">
          {threads === null ? (
            <div className="flex h-[120px] items-center justify-center text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : visible.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-[12px] text-zinc-500">No hay sesiones de Codex para importar.</div>
          ) : visible.map(t => (
            <button
              key={t.id}
              onClick={() => void pick(t)}
              disabled={!!busyId}
              className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-light disabled:opacity-60"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-zinc-100">{t.name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-zinc-500">
                  <span className="truncate font-mono" title={t.cwd}>{folderName(t.cwd)}</span>
                  <span>·</span>
                  <span className="shrink-0">{ago(t.updatedAt)}</span>
                  <span>·</span>
                  <span className="shrink-0">{ORIGIN_LABEL[t.originator] || t.originator || 'codex'}</span>
                  {t.sessionId && <span className="shrink-0 rounded bg-zinc-500/15 px-1 text-zinc-400">importada</span>}
                </div>
              </div>
              {busyId === t.id
                ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
                : <Download className="h-3.5 w-3.5 shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100" />}
            </button>
          ))}
        </div>

        {error && <div className="border-t border-border px-3.5 py-2 text-[11px] text-red-400">{error}</div>}
      </div>
    </div>
  );
}
