import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClaudeClient } from '../lib/claude-client';

interface FileResult {
  name: string;
  path: string;
  rel: string;
}

export function useFileMention(
  input: string,
  client: ClaudeClient | null,
  rootPath: string | null,
) {
  const [results, setResults] = useState<FileResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Find the @ trigger: last `@` not preceded by a space-less run (i.e. @ at word boundary)
  const atIdx = input.lastIndexOf('@');
  const isActive = atIdx >= 0 && (atIdx === 0 || input[atIdx - 1] === ' ');
  const query = isActive ? input.slice(atIdx + 1) : '';
  // Don't show if query contains a space (already selected)
  const showPicker = isActive && !query.includes(' ') && !!client && !!rootPath;

  useEffect(() => {
    if (!showPicker || !client || !rootPath) {
      setResults([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      client.findFiles(rootPath, query).then(r => {
        setResults(r);
        setSelectedIndex(0);
      }).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(debounceRef.current);
  }, [showPicker, query, client, rootPath]);

  const onKeyDown = useCallback((e: React.KeyboardEvent, onSelect: (file: FileResult) => void) => {
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
      setResults([]);
    }
  }, [showPicker, results, selectedIndex]);

  return { results, selectedIndex, isActive: showPicker && results.length > 0, atIdx, onKeyDown };
}

interface Props {
  results: { name: string; path: string; rel: string }[];
  selectedIndex: number;
  onSelect: (file: { name: string; path: string; rel: string }) => void;
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
      className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto py-1 z-50"
    >
      {results.map((file, i) => (
        <button
          key={file.path}
          className={`block w-full text-left px-4 py-1.5 text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
          }`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => {}}
          onClick={() => onSelect(file)}
        >
          <span className="text-amber-400 font-mono">@</span>
          <span className="font-mono">{file.rel}</span>
        </button>
      ))}
    </div>
  );
}
