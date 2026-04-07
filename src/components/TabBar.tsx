import { useState, useRef, useEffect } from 'react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

const statusColor: Record<string, string> = {
  connected: 'bg-green-400',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-zinc-600',
  error: 'bg-red-400',
};

export function TabBar({ sessions, activeSessionId, sessionStatuses, onSelect, onNew, onDelete, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
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
    <div className="tab-bar flex items-end bg-[#161616] pl-1 pt-1.5 shrink-0 select-none overflow-x-auto" style={{ minHeight: 38 }}>
      {sessions.map(s => {
        const isActive = s.id === activeSessionId;
        const connStatus = sessionStatuses[s.id] || 'disconnected';

        return (
          <div
            key={s.id}
            className={`tab-item group relative flex items-center gap-1.5 px-3 h-[34px] text-[12px] cursor-pointer shrink-0 max-w-[200px] min-w-[100px] transition-colors ${
              isActive
                ? 'bg-base text-zinc-200 rounded-t-lg z-10'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50 rounded-t-lg'
            }`}
            onClick={() => onSelect(s.id)}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor[connStatus] || statusColor.disconnected}`} />

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
              onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              title="Close tab"
            >
              &times;
            </button>

            {/* Active tab bottom line cover */}
            {isActive && (
              <div className="absolute bottom-0 left-0 right-0 h-px bg-base" />
            )}
          </div>
        );
      })}

      {/* New tab button */}
      <button
        className="flex items-center justify-center w-8 h-[34px] text-zinc-500 hover:text-zinc-300 hover:bg-surface/50 rounded-t-lg shrink-0 text-lg leading-none transition-colors"
        onClick={onNew}
        title="New session"
      >
        +
      </button>
    </div>
  );
}
