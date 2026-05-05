import { useState, useEffect, useRef, useMemo } from 'react';
import { Kbd } from '@heroui/react';
import { searchFiles, type FileEntry } from '../lib/fuzzy-file-search';

export interface PaletteAction {
  id: string;
  label: string;
  keys?: string[];
  key?: string;
  section?: string;
  onRun: () => void;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  fileIndex: FileEntry[];
  onFileOpen?: (path: string) => void;
}

export function CommandPalette({ isOpen, onClose, actions, fileIndex, onFileOpen }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredActions = useMemo(() => {
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.section && a.section.toLowerCase().includes(q))
    );
  }, [query, actions]);

  const fileActions: PaletteAction[] = useMemo(() => {
    if (!query) return [];
    return searchFiles(fileIndex, query, 15)
      .filter(f => f.type !== 'dir')
      .map(f => ({
        id: `file-${f.path}`,
        label: f.name,
        section: 'Files',
        key: f.rel,
        onRun: () => onFileOpen?.(f.path),
      }));
  }, [query, fileIndex, onFileOpen]);

  const filtered = useMemo(() => {
    if (!query) return actions;
    return [...fileActions, ...filteredActions];
  }, [query, actions, fileActions, filteredActions]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  const run = (action: PaletteAction) => {
    onClose();
    action.onRun();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) run(filtered[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastSection = '';

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg bg-[#1e1e1e] border border-border-light rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or file name..."
            className="w-full bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="text-xs text-zinc-600 text-center py-6">No matching commands or files</p>
          )}
          {filtered.map((action, i) => {
            const showSection = action.section && action.section !== lastSection;
            lastSection = action.section || '';
            return (
              <div key={action.id}>
                {showSection && (
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
                    {action.section}
                  </div>
                )}
                <button
                  className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                    i === selectedIndex
                      ? 'bg-surface-light text-zinc-100'
                      : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'
                  }`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(action)}
                >
                  <span className="truncate">{action.label}</span>
                  {action.section === 'Files' && action.key && (
                    <span className="text-[11px] text-zinc-600 font-mono truncate ml-3 shrink-0 max-w-[50%] text-right">{action.key}</span>
                  )}
                  {action.section !== 'Files' && (action.keys || action.key) && (
                    <Kbd keys={action.keys as any} className="bg-surface text-zinc-500 border-border-light">
                      {action.key || ''}
                    </Kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
