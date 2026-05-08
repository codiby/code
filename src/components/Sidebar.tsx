import { useState } from 'react';
import { Button, TextField, Input } from '@heroui/react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';
import { PluginSidebarPanels } from './PluginExtensionPoints';

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onResume: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

const statusDot: Record<string, string> = {
  connected: 'bg-green-400',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-zinc-600',
  error: 'bg-red-400',
};

export function Sidebar({ sessions, activeSessionId, sessionStatuses, onSelect, onNew, onDelete, onResume, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

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
    <aside className="w-64 border-r border-border flex flex-col bg-base shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-300">Sessions</span>
        <Button size="sm" onPress={onNew}>+ New</Button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.length === 0 && (
          <p className="text-xs text-zinc-600 text-center py-4">No sessions yet</p>
        )}
        {sessions.map(s => {
          const isActive = s.id === activeSessionId;
          const connStatus = sessionStatuses[s.id] || 'disconnected';
          const isStopped = s.status === 'stopped' && connStatus === 'disconnected';

          if (editingId === s.id) {
            return (
              <div key={s.id} className="px-2 py-1">
                <TextField value={editName} onChange={setEditName}>
                  <Input
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={commitRename}
                  />
                </TextField>
              </div>
            );
          }

          return (
            <div
              key={s.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                isActive ? 'bg-surface-lighttext-white' : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'
              }`}
              onClick={() => onSelect(s.id)}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[connStatus] || statusDot.disconnected}`} />
              <span className="truncate flex-1">{s.name}</span>
              <span
                className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                {isStopped && s.claude_session_id && (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    className="h-auto p-1 text-green-400 hover:text-green-300 text-xs"
                    onPress={() => onResume(s.id)}
                    aria-label="Resume session"
                  >
                    <span>&#x25B6;</span>
                  </Button>
                )}
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="h-auto p-1 text-zinc-500 hover:text-zinc-300 text-xs"
                  onPress={() => startRename(s)}
                  aria-label="Rename"
                >
                  <span>&#x270E;</span>
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="h-auto p-1 text-zinc-500 hover:text-red-400 text-xs"
                  onPress={() => onDelete(s.id)}
                  aria-label="Delete"
                >
                  <span>&times;</span>
                </Button>
              </span>
            </div>
          );
        })}
      </nav>
      <PluginSidebarPanels />
    </aside>
  );
}
