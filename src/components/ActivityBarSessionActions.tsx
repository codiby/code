/**
 * Two icon buttons that live in the host's activity bar (40px column on the
 * left of the IDE in standard mode): a quick "+" to spawn a new session and a
 * history icon that pops open the list of recently-closed sessions for
 * one-click reopen. Replaces the inline toolbar that used to sit on top of
 * the vertical TabBar — keeping the TabBar pure tabs.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, History, Search, Archive } from 'lucide-react';
import type { SessionInfo } from '../lib/claude-client';

interface Props {
  closedSessions: SessionInfo[];
  onNew: () => void;
  onReopen: (id: string) => void;
  onArchive?: (id: string) => void;
}

export function ActivityBarSessionActions({ closedSessions, onNew, onReopen, onArchive }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popoverRef.current || !btnRef.current) return;
      const target = e.target as Node;
      if (popoverRef.current.contains(target) || btnRef.current.contains(target)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const filtered = query.trim()
    ? closedSessions.filter(s => s.name.toLowerCase().includes(query.toLowerCase()) || s.cwd.toLowerCase().includes(query.toLowerCase()))
    : closedSessions;

  return (
    <>
      <button
        className="w-7 h-6 flex items-center justify-center rounded-md transition-colors text-zinc-500 hover:text-zinc-200 hover:bg-surface-light"
        onClick={onNew}
        title="New session"
        aria-label="New session"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
      <button
        ref={btnRef}
        className={`w-7 h-6 flex items-center justify-center rounded-md transition-colors ${
          open ? 'text-zinc-200 bg-surface-light' : 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-light'
        }`}
        onClick={() => setOpen(o => !o)}
        title="Restore closed session"
        aria-label="Restore closed session"
      >
        <History className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl w-[280px] py-1 overflow-hidden max-h-[420px] flex flex-col"
          style={{
            top: (btnRef.current?.getBoundingClientRect().top ?? 0),
            left: (btnRef.current?.getBoundingClientRect().right ?? 40) + 6,
          }}
        >
          <div className="px-2 pb-1 pt-1.5 shrink-0">
            <div className="flex items-center gap-1.5 bg-[#131418] border border-border rounded-md px-2 h-7">
              <Search size={11} className="text-zinc-600 shrink-0" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search closed sessions…"
                className="flex-1 bg-transparent text-[12px] text-zinc-300 placeholder:text-zinc-600 outline-none border-0 min-w-0"
              />
            </div>
          </div>
          <div className="h-px bg-border mx-2 my-1 shrink-0" />
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-zinc-600 text-center">
                {closedSessions.length === 0 ? 'No closed sessions' : 'No matches'}
              </div>
            ) : (
              filtered.map(s => (
                <div
                  key={s.id}
                  className="group/arch w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors cursor-pointer"
                  onClick={() => { setOpen(false); onReopen(s.id); }}
                  title="Click to reopen"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                  <span className="truncate flex-1">{s.name}</span>
                  <span className="text-[10px] text-zinc-600 shrink-0 font-mono group-hover/arch:hidden">
                    {s.cwd.split('/').pop()}
                  </span>
                  {onArchive && (
                    <span onClick={(e) => e.stopPropagation()} className="hidden group-hover/arch:flex shrink-0">
                      <button
                        type="button"
                        onClick={() => onArchive(s.id)}
                        className="w-5 h-5 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface transition-colors"
                        aria-label="Archive (hide from this list, keeps history)"
                      >
                        <Archive size={11} strokeWidth={2} />
                      </button>
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
