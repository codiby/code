/**
 * Restart-suggestion banner. MCP servers are only read when the provider
 * spawns, so adding/removing one mid-session has no effect until the session
 * is restarted. The MCP manager card (FileExplorer › McpServersSection) emits
 * a `mcp_changed` window event on every successful add/remove; this banner
 * accumulates those, surfaces a bottom-right card, and restarts the session in
 * place (conversation history preserved) when the user accepts.
 *
 * Self-contained at the app root (mirrors UpdateBanner). The actual restart is
 * delegated to ChatApp — which already owns the connected ClaudeClient — via a
 * `request_session_restart` window event; ChatApp replies with
 * `session_restart_done`.
 */
import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

type McpChangedDetail = { action: 'added' | 'removed'; name: string; sessionId: string | null };
type RestartDoneDetail = { sessionId: string | null; ok: boolean; error?: string };

export function RestartSuggestionBanner() {
  // The session whose MCP config changed (the active one at change time).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<McpChangedDetail>).detail;
      if (!d) return;
      setSessionId(d.sessionId);
      setError(null);
      // A name that's added then removed (or vice-versa) cancels out.
      if (d.action === 'added') {
        setRemoved(r => r.filter(n => n !== d.name));
        setAdded(a => (a.includes(d.name) ? a : [...a, d.name]));
      } else {
        setAdded(a => a.filter(n => n !== d.name));
        setRemoved(r => (r.includes(d.name) ? r : [...r, d.name]));
      }
    };
    const onDone = (e: Event) => {
      const d = (e as CustomEvent<RestartDoneDetail>).detail;
      if (!d) return;
      setRestarting(false);
      if (d.ok) { setAdded([]); setRemoved([]); setError(null); }
      else setError(d.error || 'No se pudo reiniciar');
    };
    window.addEventListener('mcp_changed', onChange);
    window.addEventListener('session_restart_done', onDone);
    return () => {
      window.removeEventListener('mcp_changed', onChange);
      window.removeEventListener('session_restart_done', onDone);
    };
  }, []);

  const dismiss = () => { setAdded([]); setRemoved([]); setError(null); };

  const restart = () => {
    if (!sessionId) { dismiss(); return; }
    setRestarting(true);
    setError(null);
    window.dispatchEvent(new CustomEvent('request_session_restart', { detail: { sessionId } }));
  };

  if (added.length === 0 && removed.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-[330px] rounded-[12px] border border-[#2dd4bf33] bg-[#141519]/[0.97] p-[14px] shadow-[0_12px_40px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur">
      <div className="flex items-start gap-[11px]">
        <div className="mt-px flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[#2dd4bf26] bg-[#2dd4bf12] text-[#2dd4bf]">
          <RefreshCw className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#eef0f2]">Reinicia la sesión</div>
          <div className="mt-0.5 text-[11.5px] leading-[1.5] text-[#9aa0a8]">
            {error
              ? <span className="text-[#ef8a96]">{error}</span>
              : 'Los cambios en los servidores MCP solo se aplican al reiniciar el proveedor. Tu conversación se conserva.'}
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Descartar"
          className="ml-auto flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[#6b6e76] hover:bg-[#26272d] hover:text-[#e6e7ea]"
        >
          <X className="h-[15px] w-[15px]" />
        </button>
      </div>

      <div className="mt-[10px] flex flex-wrap gap-[5px]">
        {added.map(n => (
          <span key={`a:${n}`} className="rounded-[6px] border border-[#2dd4bf2e] bg-[#191a1f] px-[7px] py-px font-mono text-[9.5px] text-[#7ee0c4]">+ {n}</span>
        ))}
        {removed.map(n => (
          <span key={`r:${n}`} className="rounded-[6px] border border-[#ef5b6b2e] bg-[#191a1f] px-[7px] py-px font-mono text-[9.5px] text-[#ef8a96] line-through">− {n}</span>
        ))}
      </div>

      <div className="mt-[12px] flex justify-end gap-2">
        <button
          onClick={dismiss}
          disabled={restarting}
          className="rounded-[9px] px-[13px] py-[7px] text-[12px] font-semibold text-[#6b6e76] hover:bg-[#1f2025] hover:text-[#c4c6cc] disabled:opacity-40"
        >
          Más tarde
        </button>
        <button
          onClick={restart}
          disabled={restarting}
          className="flex items-center gap-1.5 rounded-[9px] bg-[#2dd4bf] px-[14px] py-[7px] text-[12px] font-bold text-[#04201c] transition-[filter] hover:brightness-110 disabled:opacity-50"
        >
          <RefreshCw className={`h-[13px] w-[13px] ${restarting ? 'animate-spin' : ''}`} />
          {restarting ? 'Reiniciando…' : 'Reiniciar sesión'}
        </button>
      </div>
    </div>
  );
}
