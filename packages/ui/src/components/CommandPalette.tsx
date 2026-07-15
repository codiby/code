import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Search, FileText, Compass, Layers, MessageSquare, Globe, Slash,
  Command as CommandIcon, CornerDownLeft, ArrowUp, ArrowDown, type LucideIcon,
} from 'lucide-react';
import { searchFiles, type FileEntry } from '../lib/fuzzy-file-search';
import { chordTokens } from '../lib/keybindings';

export type PaletteMode = 'commands' | 'files';

export interface PaletteAction {
  id: string;
  label: string;
  keys?: string[];
  key?: string;
  /** Canonical keybinding chord (e.g. `'mod+k'`), resolved live from the
   *  registry. Takes precedence over `keys`/`key` for the hint display so the
   *  palette never shows a stale shortcut after a rebind. */
  chord?: string;
  section?: string;
  onRun: () => void;
}

interface Props {
  isOpen: boolean;
  mode: PaletteMode;
  onModeChange: (mode: PaletteMode) => void;
  onClose: () => void;
  actions: PaletteAction[];
  fileIndex: FileEntry[];
  onFileOpen?: (path: string) => void;
  /** Live chords for the two entry points, shown in the footer hop hint. */
  commandChord?: string;
  filesChord?: string;
}

/** Section → glyph mapping for the command list. Keeps the action definitions in
 *  ChatApp free of icon concerns — the palette derives the visual from the
 *  existing `section` label. */
const SECTION_ICON: Record<string, { icon: LucideIcon; color: string }> = {
  Navigation: { icon: Compass, color: 'text-indigo-400' },
  Editor: { icon: FileText, color: 'text-emerald-400' },
  Sessions: { icon: Layers, color: 'text-amber-400' },
  Session: { icon: MessageSquare, color: 'text-amber-400' },
  Browser: { icon: Globe, color: 'text-sky-400' },
  'Slash Commands': { icon: Slash, color: 'text-pink-400' },
};
const DEFAULT_SECTION = { icon: CommandIcon, color: 'text-zinc-400' };

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1) : '';
}

/** A compact key-cap. */
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[16px] px-1.5 py-0.5 rounded-[5px] bg-surface border border-border-light text-[10px] font-mono font-semibold text-zinc-400 leading-none">
      {children}
    </kbd>
  );
}

function ChordHint({ chord }: { chord: string }) {
  return (
    <span className="flex items-center gap-0.5">
      {chordTokens(chord).map((t, i) => <KeyCap key={i}>{t}</KeyCap>)}
    </span>
  );
}

export function CommandPalette({
  isOpen, mode, onModeChange, onClose, actions, fileIndex, onFileOpen,
  commandChord, filesChord,
}: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commandItems = useMemo(() => {
    if (mode !== 'commands') return [];
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.section && a.section.toLowerCase().includes(q))
    );
  }, [mode, query, actions]);

  const fileItems: PaletteAction[] = useMemo(() => {
    if (mode !== 'files') return [];
    // Empty query → show a small recent-ish slice so the switcher is never blank.
    const results = query
      ? searchFiles(fileIndex, query, 40)
      : fileIndex.filter(f => f.type !== 'dir').slice(0, 40);
    return results
      .filter(f => f.type !== 'dir')
      .map(f => ({
        id: `file-${f.path}`,
        label: f.name,
        section: 'Files',
        key: f.rel,
        onRun: () => onFileOpen?.(f.path),
      }));
  }, [mode, query, fileIndex, onFileOpen]);

  const items = mode === 'commands' ? commandItems : fileItems;

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen, mode]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const item = listRef.current.querySelectorAll('[data-row]')[selectedIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  const run = (action: PaletteAction) => {
    onClose();
    action.onRun();
  };

  const switchMode = (next: PaletteMode) => {
    if (next === mode) return;
    setQuery('');
    setSelectedIndex(0);
    onModeChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // In-palette mode hop mirrors the global ⌘K / ⌘P bindings.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); switchMode('commands'); return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); switchMode('files'); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) run(items[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastSection = '';

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-[540px] bg-[#1c1c1e] border border-border-light rounded-xl shadow-[0_18px_44px_-14px_rgba(0,0,0,0.7)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search header */}
        <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border">
          {mode === 'commands'
            ? <Search className="w-[15px] h-[15px] shrink-0 text-zinc-500" />
            : <FileText className="w-[15px] h-[15px] shrink-0 text-zinc-500" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'commands' ? 'Run a command…' : 'Go to file…'}
            className="flex-1 bg-transparent border-0 outline-none text-[13.5px] text-zinc-200 placeholder:text-zinc-600"
            autoFocus
          />
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold rounded-md px-1.5 py-1 border ${
              mode === 'commands'
                ? 'text-indigo-300 bg-indigo-500/10 border-indigo-500/40'
                : 'text-sky-300 bg-sky-500/10 border-sky-500/40'
            }`}
          >
            {mode === 'commands' ? '⌘K' : '⌘P'}
          </span>
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-[300px] overflow-y-auto py-1">
          {items.length === 0 && (
            <p className="text-xs text-zinc-600 text-center py-6">
              {mode === 'commands' ? 'No matching commands' : 'No matching files'}
            </p>
          )}
          {items.map((action, i) => {
            const isFile = mode === 'files';
            const showSection = !isFile && action.section && action.section !== lastSection;
            lastSection = action.section || '';
            const sec = SECTION_ICON[action.section || ''] || DEFAULT_SECTION;
            const Icon = isFile ? FileText : sec.icon;
            const iconColor = isFile ? 'text-sky-400' : sec.color;
            const ext = isFile ? extOf(action.label) : '';
            const selected = i === selectedIndex;
            return (
              <div key={action.id}>
                {showSection && (
                  <div className="px-3.5 pt-2 pb-1 text-[9.5px] font-bold text-zinc-600 uppercase tracking-[0.08em]">
                    {action.section}
                  </div>
                )}
                <div
                  data-row
                  onMouseMove={() => setSelectedIndex(i)}
                  onClick={() => run(action)}
                  className={`relative flex items-center gap-2.5 mx-1.5 my-px px-2.5 py-1.5 rounded-lg cursor-pointer ${
                    selected ? 'bg-surface-light text-zinc-100' : 'text-zinc-400 hover:bg-surface-light/40'
                  }`}
                >
                  {selected && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-indigo-400" />
                  )}
                  <span className={`w-6 h-6 shrink-0 rounded-md flex items-center justify-center bg-[#202023] border border-border ${iconColor}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] font-medium truncate">{action.label}</span>
                    {isFile && action.key && (
                      <span className="block text-[10.5px] text-zinc-600 font-mono truncate">
                        {action.key.replace(/\/[^/]*$/, '') || action.key}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 flex items-center gap-1">
                    {isFile
                      ? ext && <span className="text-[9.5px] font-mono uppercase tracking-wide text-zinc-600">{ext}</span>
                      : action.chord
                        ? <ChordHint chord={action.chord} />
                        : (action.keys || action.key)
                          ? <span className="flex items-center gap-0.5">
                              {action.keys?.map(k => <KeyCap key={k}>{k === 'escape' ? 'esc' : k}</KeyCap>)}
                              {action.key && <KeyCap>{action.key}</KeyCap>}
                            </span>
                          : <span className="text-[9.5px] text-zinc-700">unbound</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-[#202023] text-[10.5px] text-zinc-500">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <KeyCap><ArrowUp className="w-2.5 h-2.5" /></KeyCap>
              <KeyCap><ArrowDown className="w-2.5 h-2.5" /></KeyCap>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <KeyCap><CornerDownLeft className="w-2.5 h-2.5" /></KeyCap>
              {mode === 'commands' ? 'run' : 'open'}
            </span>
            <button
              onClick={() => switchMode(mode === 'commands' ? 'files' : 'commands')}
              className="inline-flex items-center gap-1 hover:text-zinc-300 transition-colors"
            >
              <ChordHint chord={mode === 'commands' ? (filesChord || 'mod+p') : (commandChord || 'mod+k')} />
              {mode === 'commands' ? 'files' : 'commands'}
            </button>
            <span className="inline-flex items-center gap-1">
              <KeyCap>esc</KeyCap>
              close
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-zinc-600 font-semibold">
            <span className={`w-[5px] h-[5px] rounded-full ${mode === 'commands' ? 'bg-indigo-400' : 'bg-sky-400'}`} />
            taskr
          </span>
        </div>
      </div>
    </div>
  );
}
