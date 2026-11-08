import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Layers, Pencil, Plus, Search } from 'lucide-react';
import { GROUP_HEX_COLOR } from '../lib/tab-groups';
import type { ProjectSummary } from '../lib/project-scope';

interface Props {
  projects: ProjectSummary[];
  /** null = every project. */
  activeProjectId: string | null;
  /** Open sessions across everything, for the "All projects" row. */
  totalSessions: number;
  onSelect: (projectId: string | null) => void;
  onNew: () => void;
  onEdit: (projectId: string) => void;
}

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');

/** Square monogram in the project's colour. */
function ProjectMark({ name, color }: { name: string; color?: string }) {
  const hex = color ? GROUP_HEX_COLOR[color] : undefined;
  return (
    <span
      className="shrink-0 grid place-items-center w-[18px] h-[18px] rounded-[5px] font-mono font-semibold text-[10px] leading-none"
      style={{ background: hex ?? 'var(--color-surface-lighter)', color: hex ? '#0f1012' : 'var(--color-zinc-300)' }}
    >
      {name.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}

const AllMark = () => (
  <span className="w-[18px] h-[18px] grid place-items-center rounded-[5px] bg-surface-lighter text-zinc-400"><Layers size={11} /></span>
);

/** Path-bar project switcher: scopes the sidebar to one project's folders. */
export function ProjectSwitcher({ projects, activeProjectId, totalSessions, onSelect, onNew, onEdit }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = projects.find(p => p.id === activeProjectId) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => q
    ? projects.filter(p => p.name.toLowerCase().includes(q) || p.folders.some(f => f.path.toLowerCase().includes(q)))
    : projects, [projects, q]);
  // Row 0 is "All projects" unless searching.
  const rows: (ProjectSummary | null)[] = q ? filtered : [null, ...filtered];

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const current = activeProjectId ? projects.findIndex(p => p.id === activeProjectId) + 1 : 0;
    setHighlight(Math.max(0, current));
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // Only on open: re-running on every count tick would reset the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { setHighlight(h => Math.min(h, Math.max(0, rows.length - 1))); }, [rows.length]);

  const pick = (row: ProjectSummary | null) => { onSelect(row ? row.id : null); setOpen(false); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(rows.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[highlight] !== undefined) pick(rows[highlight]!); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div ref={rootRef} className="relative shrink-0" style={NO_DRAG}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch project"
        className={`h-7 flex items-center gap-2 pl-1 pr-1.5 rounded-md transition-colors ${open ? 'bg-surface-light' : 'hover:bg-surface-light'}`}
      >
        {active ? <ProjectMark name={active.name} color={active.color} /> : <AllMark />}
        <span className="text-[13px] font-medium text-zinc-200 max-w-[180px] truncate">{active ? active.name : 'All projects'}</span>
        <ChevronsUpDown size={12} className="text-zinc-600" />
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-[10000] w-[340px] bg-surface border border-border-light rounded-lg shadow-2xl overflow-hidden" onKeyDown={onKeyDown}>
          <div className="flex items-center gap-2 h-10 px-3 border-b border-border">
            <Search size={14} strokeWidth={1.6} className="text-zinc-600 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setHighlight(0); }}
              placeholder="Find a project…"
              aria-label="Find a project"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-zinc-200 placeholder:text-zinc-600 outline-none border-0"
            />
            <kbd className="path-kbd">esc</kbd>
          </div>
          <div role="listbox" className="p-1 max-h-[360px] overflow-y-auto">
            {rows.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-zinc-600">No projects match</div>}
            {rows.map((row, i) => {
              const selected = row ? row.id === activeProjectId : activeProjectId === null;
              const first = row?.folders[0];
              return (
                <div
                  key={row?.id ?? '__all__'}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(row)}
                  className={`group/row grid grid-cols-[18px_1fr_auto] items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer ${i === highlight ? 'bg-surface-light' : ''}`}
                >
                  {row ? <ProjectMark name={row.name} color={row.color} /> : <AllMark />}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-zinc-200 truncate">{row ? row.name : 'All projects'}</span>
                    {first && (
                      <span className="block text-[11px] font-mono text-zinc-500 truncate">
                        {tilde(first.path)}{row!.folders.length > 1 ? ` +${row!.folders.length - 1}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] tabular-nums text-zinc-500">
                    {row && row.waitingCount > 0 && (
                      <span className="flex items-center gap-1" title={`${row.waitingCount} waiting on you`}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--dot-wait)' }} />{row.waitingCount}
                      </span>
                    )}
                    {row && row.liveCount > 0 && (
                      <span className="flex items-center gap-1" title={`${row.liveCount} running`}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--dot-run)' }} />{row.liveCount}
                      </span>
                    )}
                    <span title="Open sessions">{row ? row.sessionCount : totalSessions}</span>
                    {row && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setOpen(false); onEdit(row.id); }}
                        className="w-5 h-5 grid place-items-center rounded text-zinc-600 hover:text-zinc-200 hover:bg-surface-lighter opacity-0 group-hover/row:opacity-100"
                        aria-label={`Edit ${row.name}`}
                        title="Edit project"
                      >
                        <Pencil size={11} strokeWidth={1.8} />
                      </button>
                    )}
                    {selected ? <Check size={13} className="text-zinc-200" /> : <span className="w-[13px]" />}
                  </span>
                </div>
              );
            })}
            {!q && projects.length === 0 && (
              <div className="px-3 pt-2 pb-3 text-[12px] text-zinc-600 leading-relaxed">
                A project gathers the sessions that run in its folders, on any host. Create one to focus the sidebar and the Overview on it.
              </div>
            )}
          </div>
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => { setOpen(false); onNew(); }}
              className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] text-zinc-300 hover:bg-surface-light"
            >
              <Plus size={15} strokeWidth={1.6} className="text-zinc-500" />
              New project…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
