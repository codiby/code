import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';

interface Props {
  sessions: SessionInfo[];
  closedSessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  sessionStreaming: Record<string, boolean>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onReopen: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

function getDotClass(connStatus: string, isStreaming: boolean): string {
  if (connStatus === 'error') return 'bg-red-400';
  if (connStatus === 'connecting') return 'bg-amber-400 animate-pulse';
  if (connStatus === 'connected' && isStreaming) return 'bg-amber-400 animate-pulse';
  if (connStatus === 'connected') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

export function TabBar({ sessions, closedSessions, activeSessionId, sessionStatuses, sessionStreaming, onSelect, onNew, onClose, onReopen, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  const startRename = (s: SessionInfo) => {
    setEditingId(s.id);
    setEditName(s.name);
  };

  const commitRename = () => {
    if (editingId && editName.trim()) {
      onRename(editingId, editName.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="tab-bar flex flex-col bg-[#161616] shrink-0 select-none">
      {/* Spacer for native titlebar */}
      <div className="h-[28px] shrink-0" />
      <div className="flex items-center gap-1 px-1 overflow-x-auto" style={{ minHeight: 34 }}>
      {sessions.map(s => {
        const isActive = s.id === activeSessionId;
        const connStatus = sessionStatuses[s.id] || 'disconnected';

        return (
          <div
            key={s.id}
            className={`tab-item group relative flex items-center gap-1.5 px-3 h-[30px] text-[12px] cursor-pointer shrink-0 max-w-[200px] min-w-[100px] rounded-md transition-colors ${
              isActive
                ? 'bg-surface-light text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
            }`}
            onClick={() => onSelect(s.id)}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(connStatus, sessionStreaming[s.id] || false)}`} />

            {editingId === s.id ? (
              <input
                ref={editRef}
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={commitRename}
                className="bg-transparent border-none outline-none text-[12px] text-zinc-200 w-full min-w-0"
              />
            ) : (
              <span
                className="truncate flex-1"
                onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
              >
                {s.name}
              </span>
            )}

            {/* Close button */}
            <button
              className={`shrink-0 w-4 h-4 flex items-center justify-center rounded-sm text-[14px] leading-none transition-opacity ${
                isActive ? 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-light' : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 hover:bg-surface-light'
              }`}
              onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
              title="Close tab"
            >
              &times;
            </button>

          </div>
        );
      })}

      {/* New/reopen button */}
      <div className="shrink-0" ref={menuRef}>
        <button
          className="flex items-center justify-center w-8 h-[30px] text-zinc-500 hover:text-zinc-300 hover:bg-surface/50 rounded-md text-lg leading-none transition-colors"
          onClick={() => setShowMenu(m => !m)}
          title="Open session"
        >
          +
        </button>
        {showMenu && (() => {
          const rect = menuRef.current?.getBoundingClientRect();
          return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[220px] py-1 overflow-y-auto max-h-80"
              style={{ top: (rect?.bottom ?? 38) + 4, left: rect?.left ?? 0 }}>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-300 hover:bg-surface-light transition-colors"
                onClick={() => { setShowMenu(false); onNew(); }}
              >
                <span className="text-zinc-500">+</span>
                <span>New session</span>
              </button>
              {closedSessions.length > 0 && (
                <>
                  <div className="h-px bg-border mx-2 my-1" />
                  <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Closed sessions</div>
                  {closedSessions.map(s => (
                    <button
                      key={s.id}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                      onClick={() => { setShowMenu(false); onReopen(s.id); }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                      <span className="truncate">{s.name}</span>
                      <span className="text-[10px] text-zinc-600 ml-auto shrink-0 font-mono">{s.cwd.split('/').pop()}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
          );
        })()}
      </div>
      </div>
    </div>
  );
}
