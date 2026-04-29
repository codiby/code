import { useState, useEffect, useRef, useCallback } from 'react';

export function useSlashCommands(input: string, commands: string[]) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const isActive = input.startsWith('/') && !input.includes(' ');
  const query = input.slice(1).toLowerCase();
  const filtered = isActive
    ? commands.filter(c => c.toLowerCase().startsWith(query)).slice(0, 12)
    : [];

  useEffect(() => setSelectedIndex(0), [query]);

  const onKeyDown = useCallback((e: React.KeyboardEvent, onSelect: (cmd: string) => void) => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'Tab' || (e.key === 'Enter' && filtered.length > 0 && isActive)) {
      e.preventDefault();
      if (filtered[selectedIndex]) onSelect(filtered[selectedIndex]);
    } else if (e.key === 'Escape') {
      setSelectedIndex(-1); // hide
    }
  }, [filtered, selectedIndex, isActive]);

  return { filtered, selectedIndex, isActive: filtered.length > 0 && selectedIndex >= 0, onKeyDown };
}

interface Props {
  filtered: string[];
  selectedIndex: number;
  onSelect: (cmd: string) => void;
  onHover: (index: number) => void;
}

export function SlashCommandList({ filtered, selectedIndex, onSelect, onHover }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-64 overflow-y-auto py-1 z-50"
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd}
          className={`block w-full text-left px-4 py-1.5 text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
          }`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(cmd)}
        >
          <span className="text-blue-400 font-mono">/</span>
          <span className="font-mono">{cmd}</span>
        </button>
      ))}
    </div>
  );
}
