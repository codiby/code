/**
 * Titlebar power button + mini panel listing every session with a live Claude
 * process. Stopping one kills the process (frees memory) but keeps the session
 * in the sidebar — it just goes "not running" and can be resumed later.
 *
 * Layout: variant E — ultra-dense, grouped by project, per-row stop on hover,
 * plus bulk "Stop idle" / "Stop all".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Power, Square } from 'lucide-react';
import type { SessionInfo } from '../lib/claude-client';
import { projectRootOf } from '../lib/session-status';

interface Props {
  sessions: SessionInfo[];
  sessionStreaming: Record<string, boolean>;
  sessionHasPermission: Record<string, boolean>;
  onStop: (id: string) => void;
}

function basename(p: string): string {
  if (!p) return '—';
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** A live (running) instance — its process is alive (or starting). */
function isLive(s: SessionInfo): boolean {
  return s.runtime_status === 'running' || s.runtime_status === 'starting';
}

export function RunningInstancesButton({ sessions, sessionStreaming, sessionHasPermission, onStop }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const live = useMemo(() => sessions.filter(isLive), [sessions]);
  const idleIds = useMemo(() => live.filter(s => !sessionStreaming[s.id]).map(s => s.id), [live, sessionStreaming]);

  // Group live sessions by project root, ordered by project label.
  const groups = useMemo(() => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of live) {
      const root = projectRootOf(s.cwd || '');
      const arr = m.get(root) || []; arr.push(s); m.set(root, arr);
    }
    return [...m.entries()].sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
  }, [live]);

  const count = live.length;

  return (
    <>
      <button
        ref={btnRef}
        className={`relative w-7 h-6 flex items-center justify-center rounded-md transition-colors ${
          open ? 'text-zinc-200 bg-surface-light' : 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-light'
        }`}
        onClick={() => setOpen(o => !o)}
        title="Running Claude instances"
        aria-label="Running Claude instances"
      >
        <Power className="w-3.5 h-3.5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 flex items-center justify-center rounded-full text-[9px] font-bold leading-none bg-[#5eead4] text-[#06231d] border border-base">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          className="fixed z-50 bg-surface border border-border-light rounded-xl shadow-2xl w-[290px] overflow-hidden flex flex-col max-h-[460px]"
          style={{
            top: (btnRef.current?.getBoundingClientRect().bottom ?? 28) + 6,
            left: Math.max(8, (btnRef.current?.getBoundingClientRect().left ?? 40) - 4),
          }}
        >
          {/* Header */}
          <div className="px-3 pt-2.5 pb-2 border-b border-border shrink-0">
            <div className="flex items-center gap-2 text-[13px] font-bold text-zinc-200">
              <Power size={13} strokeWidth={2} />
              Running instances
              <span className="ml-auto text-[11px] font-bold text-[#5eead4] bg-[#5eead4]/12 rounded-full px-2 py-px">{count}</span>
            </div>
            <div className="text-[10px] text-zinc-600 mt-0.5">Stopping frees memory — sessions stay in the sidebar.</div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1 px-1 py-1.5">
            {count === 0 ? (
              <div className="px-3 py-6 text-[11px] text-zinc-600 text-center">No running instances</div>
            ) : (
              groups.map(([root, list]) => (
                <div key={root}>
                  <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-600 truncate">{basename(root)}</span>
                    <span className="ml-auto text-[9px] font-semibold text-zinc-700">{list.length}</span>
                  </div>
                  {list.map(s => {
                    // A pending permission request blocks the run, so the
                    // session isn't really "working" — drop the typing bars
                    // (mirrors the composer's `isStreaming && !permRequest`).
                    const working = !!sessionStreaming[s.id] && !sessionHasPermission[s.id];
                    return (
                      <div
                        key={s.id}
                        className="group/inst flex items-center gap-2 h-[24px] px-2 rounded-md text-zinc-400 hover:bg-surface-light transition-colors"
                      >
                        {/* dot: working → typing bars, idle → muted teal dot */}
                        <span className="w-[14px] h-[14px] shrink-0 inline-flex items-center justify-center">
                          {working ? (
                            <span className="inline-flex items-end gap-[1.5px]" style={{ height: 9 }}>
                              {[0, 1, 2].map(i => (
                                <span key={i} className="w-[2px] rounded-[1px]" style={{ height: 5, background: '#5eead4', animation: 'sessionTyping 1s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
                              ))}
                            </span>
                          ) : (
                            <span className="rounded-full" style={{ width: 7, height: 7, background: 'color-mix(in srgb, #5eead4 55%, #0a0a0b)' }} />
                          )}
                        </span>
                        <span className="flex-1 min-w-0 text-[12px] truncate">{s.name}</span>
                        {working && <span className="text-[8px] font-bold uppercase tracking-wide text-[#5eead4] bg-[#5eead4]/12 border border-[#5eead4]/25 rounded px-1 shrink-0">working</span>}
                        <button
                          type="button"
                          onClick={() => onStop(s.id)}
                          title="Stop this Claude instance"
                          aria-label="Stop instance"
                          className="shrink-0 w-[18px] h-[18px] grid place-items-center rounded text-zinc-600 opacity-0 group-hover/inst:opacity-100 hover:!text-red-400 hover:bg-red-500/10 transition-all"
                        >
                          <Square size={11} strokeWidth={2.4} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Bulk actions */}
          {count > 0 && (
            <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border shrink-0">
              <button
                type="button"
                disabled={idleIds.length === 0}
                onClick={() => { idleIds.forEach(onStop); }}
                className="h-[26px] px-2.5 rounded-md text-[11px] font-semibold border border-border bg-surface-light text-zinc-300 hover:bg-surface-lighter disabled:opacity-40 disabled:hover:bg-surface-light transition-colors"
              >
                Stop idle ({idleIds.length})
              </button>
              <button
                type="button"
                onClick={() => { live.forEach(s => onStop(s.id)); setOpen(false); }}
                className="ml-auto h-[26px] px-2.5 rounded-md text-[11px] font-semibold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                Stop all
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
