import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Folder, File as FileIcon } from 'lucide-react';
import { searchFiles, type FileEntry } from '../lib/fuzzy-file-search';
import type { ClaudeClient } from '../lib/claude-client';

export function useFileMention(
  input: string,
  fileIndex: FileEntry[],
  client?: ClaudeClient | null,
  cwd?: string | null,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const atIdx = input.lastIndexOf('@');
  const isActive = atIdx >= 0 && (atIdx === 0 || input[atIdx - 1] === ' ');
  const query = isActive ? input.slice(atIdx + 1) : '';
  // Queries starting with `../` (or just `..`) escape the cwd file index and
  // walk into parent directories. We list the resolved dir server-side via
  // `listFiles` instead of fuzzy-searching the preloaded index.
  const isParentNav = query === '..' || query.startsWith('../');
  const showPicker = isActive && !query.includes(' ') &&
    (isParentNav ? !!(client && cwd) : fileIndex.length > 0);

  // Split a parent-nav query into the directory portion (everything up to and
  // including the last `/`) and the prefix filter typed for the basename.
  // `..` with no trailing slash yet lists the parent itself and applies no
  // filter — letting the picker appear as soon as the user types `..`.
  const lastSlash = query.lastIndexOf('/');
  const dirPart = isParentNav
    ? (lastSlash >= 0 ? query.slice(0, lastSlash + 1) : '../')
    : '';
  const filter = isParentNav && lastSlash >= 0
    ? query.slice(lastSlash + 1).toLowerCase()
    : '';

  const [parentEntries, setParentEntries] = useState<FileEntry[]>([]);
  const reqIdRef = useRef(0);
  useEffect(() => {
    if (!isParentNav || !client || !cwd) {
      setParentEntries([]);
      return;
    }
    const id = ++reqIdRef.current;
    client.listFiles(`${cwd}/${dirPart}`).then(items => {
      if (id !== reqIdRef.current) return;
      setParentEntries(items.map(it => ({
        name: it.name,
        path: it.path,
        rel: `${dirPart}${it.name}`,
        type: it.type,
      })));
    }).catch(() => {
      if (id === reqIdRef.current) setParentEntries([]);
    });
  }, [isParentNav, client, cwd, dirPart]);

  const results = useMemo(() => {
    if (!showPicker) return [];
    if (isParentNav) {
      const matches = filter
        ? parentEntries.filter(e => e.name.toLowerCase().startsWith(filter))
        : parentEntries;
      return matches.slice(0, 15);
    }
    if (!query) return [];
    return searchFiles(fileIndex, query, 15);
  }, [showPicker, query, fileIndex, isParentNav, parentEntries, filter]);

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
