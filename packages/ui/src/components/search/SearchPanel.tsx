import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ClaudeClient } from '../../lib/claude-client';

export function SearchPanel({ client, rootPath, onFileOpen, onClose }: { client: ClaudeClient | null; rootPath: string | null; onFileOpen: (path: string, line?: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [ignore, setIgnore] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doSearch = (q: string, cs: boolean, ig: string) => {
    if (!client || !rootPath || !q.trim()) {
      abortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      client.searchFiles(rootPath, q.trim(), { caseSensitive: cs, ignore: ig, signal: ctrl.signal })
        .then(r => { if (!ctrl.signal.aborted) { setResults(r); setSearching(false); } })
        .catch(() => { if (!ctrl.signal.aborted) { setResults([]); setSearching(false); } });
    }, 150);
  };

  // Re-run when the user toggles case sensitivity or edits the ignore globs
  // so the result set updates in place (VS Code-style).
  useEffect(() => {
    if (query.trim()) doSearch(query, caseSensitive, ignore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, ignore]);

  const grouped = useMemo(() => {
    const map = new Map<string, { file: string; line: number; text: string }[]>();
    for (const r of results) {
      const relFile = rootPath && r.file.startsWith('./') ? r.file.slice(2) : r.file;
      let arr = map.get(relFile);
      if (!arr) { arr = []; map.set(relFile, arr); }
      arr.push(r);
    }
    return Array.from(map, ([file, items]) => ({ file, items }));
  }, [results, rootPath]);

  const toggleFile = (file: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  };

  return (
    <div className="rounded-[11px] border border-[#1e1f24] bg-[#141519] overflow-hidden flex-1 flex flex-col min-h-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_1px_2px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-[9px] h-[34px] px-[11px] shrink-0">
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0 text-[#7c5cff]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        </span>
        <span className="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-[#9aa0a8]">Search</span>
        <button className="ml-auto w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#9aa0a8] hover:bg-[#191a1f] transition-colors" onClick={onClose} aria-label="Close search">&#x2715;</button>
      </div>
      <div className="h-px mx-[11px] bg-[linear-gradient(90deg,transparent,#26272d_12%,#26272d_88%,transparent)]" />
      <div className="px-2 py-2 border-b border-border shrink-0 space-y-1.5">
        <div className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); doSearch(e.target.value, caseSensitive, ignore); }}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
            placeholder="Search in files..."
            className="w-full bg-surface border border-border rounded pl-2 pr-7 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={() => setCaseSensitive(v => !v)}
            title={caseSensitive ? 'Match Case (on)' : 'Match Case (off)'}
            aria-pressed={caseSensitive}
            className={`absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center transition-colors ${caseSensitive ? 'bg-violet-600/30 text-violet-300 ring-1 ring-violet-500/40' : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface-light/50'}`}
          >
            Aa
          </button>
        </div>
        <input
          value={ignore}
          onChange={e => setIgnore(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          placeholder="files to exclude (e.g. *.lock, dist/**)"
          className="w-full bg-surface border border-border rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {searching && <p className="text-[11px] text-zinc-600 text-center py-4">Searching...</p>}
        {!searching && query && grouped.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-4">No results</p>}
        {grouped.map(({ file, items }) => {
          const collapsed = collapsedFiles.has(file);
          const Chev = collapsed ? ChevronRight : ChevronDown;
          const filename = file.split('/').pop() || file;
          const dir = file.slice(0, file.length - filename.length);
          return (
            <div key={file} className="border-b border-border/30">
              <button
                type="button"
                onClick={() => toggleFile(file)}
                className="w-full flex items-center gap-1 px-1.5 py-1 hover:bg-surface-light/40 text-left"
              >
                <Chev className="w-3 h-3 text-zinc-500 shrink-0" strokeWidth={2.5} />
                <span className="text-[11px] text-zinc-300 truncate">{filename}</span>
                {dir && <span className="text-[10px] text-zinc-600 truncate">{dir.replace(/\/$/, '')}</span>}
                <span className="ml-auto text-[10px] text-zinc-500 shrink-0 px-1 rounded bg-surface-light/40">{items.length}</span>
              </button>
              {!collapsed && items.map((r, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 pl-6 pr-2 py-0.5 hover:bg-surface-light/50 cursor-pointer transition-colors"
                  onClick={() => onFileOpen(rootPath ? `${rootPath}/${file}` : file, r.line)}
                >
                  <span className="text-[10px] text-zinc-600 shrink-0 tabular-nums">{r.line}</span>
                  <span className="text-[10px] text-zinc-400 font-mono truncate leading-snug flex-1">{r.text}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
