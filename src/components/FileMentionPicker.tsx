import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Folder, File as FileIcon } from 'lucide-react';
import { searchFiles, type FileEntry } from '../lib/fuzzy-file-search';

export function useFileMention(input: string, fileIndex: FileEntry[]) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const atIdx = input.lastIndexOf('@');
  const isActive = atIdx >= 0 && (atIdx === 0 || input[atIdx - 1] === ' ');
  const query = isActive ? input.slice(atIdx + 1) : '';
  const showPicker = isActive && !query.includes(' ') && fileIndex.length > 0;

  const results = useMemo(() => {
    if (!showPicker || !query) return [];
    return searchFiles(fileIndex, query, 15);
  }, [showPicker, query, fileIndex]);

  useEffect(() => setSelectedIndex(0), [query]);

  const onKeyDown = useCallback((e: React.KeyboardEvent, onSelect: (file: FileEntry) => void) => {
    if (!showPicker || results.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) onSelect(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSelectedIndex(-1);
    }
  }, [showPicker, results, selectedIndex]);

  return { results, selectedIndex, isActive: showPicker && results.length > 0 && selectedIndex >= 0, atIdx, onKeyDown };
}

interface Props {
  results: FileEntry[];
  selectedIndex: number;
  onSelect: (file: FileEntry) => void;
}

export function FileMentionList({ results, selectedIndex, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (results.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-2 bg-surface border border-border-light rounded-lg shadow-xl max-h-64 overflow-y-auto py-1 z-50"
    >
      {results.map((file, i) => {
        const isDir = file.type === 'dir';
        return (
          <button
            key={file.path}
            className={`w-full flex items-center justify-between px-4 py-1.5 text-sm transition-colors ${
              i === selectedIndex
                ? 'bg-surface-light text-zinc-100'
                : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => {}}
            onClick={() => onSelect(file)}
          >
            <span className="flex items-center gap-2 min-w-0">
              {isDir
                ? <Folder size={12} className="shrink-0 text-sky-400/80" />
                : <FileIcon size={12} className="shrink-0 text-zinc-500" />}
              <span className="font-mono truncate">{file.name}{isDir ? '/' : ''}</span>
            </span>
            <span className="text-[11px] text-zinc-600 font-mono truncate ml-3 shrink-0 max-w-[50%] text-right">{file.rel}{isDir ? '/' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}
