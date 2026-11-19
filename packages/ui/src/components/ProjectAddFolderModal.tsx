import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Folder, Loader2, X } from 'lucide-react';
import type { ClaudeClient } from '../lib/claude-client';
import type { ProjectFolder } from '../lib/project-scope';

interface Props {
  project: { name: string; color?: string };
  /** Hosts a folder can live on (`id: null` = this machine). */
  hosts: { id: string | null; name: string; color?: string }[];
  /** Host the browser opens on. */
  initialHost: string | null;
  /** The project's folders, shown as already added. */
  existing: ProjectFolder[];
  client: ClaudeClient | null;
  onAdd: (folder: ProjectFolder) => void;
  onClose: () => void;
}

/** A remote whose tunnel isn't up can leave a request pending instead of
 *  failing; bound it so the modal says so instead of spinning. */
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
const baseName = (p: string) => trim(p).split(/[\\/]/).filter(Boolean).pop() || p;

/** "Add folder to the project…": browse a host's folders and add one. */
export function ProjectAddFolderModal({ project, hosts, initialHost, existing, client, onAdd, onClose }: Props) {
  const [host, setHost] = useState<string | null>(initialHost);
  const [path, setPath] = useState('');
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // What was being browsed on the previous host, and that host's home: on a
  // host switch the same folder is looked for on the new one.
  const browsedRef = useRef({ path: '', home: '' });

  // Switching host keeps the folder when the new host has it — the same path,
  // or the same place under its home (/Users/j/src/up → /home/j/src/up).
  // Only when neither exists does it open at the new host's home.
  useEffect(() => {
    let live = true;
    const prev = browsedRef.current;
    browsedRef.current = { path: '', home: '' };
    setPath('');
    setDirs(null);
    setSelected(null);
    setFailed(false);
    if (!client) return;
    // Without an answer, start beside a folder the project already has there.
    const known = existing.find(f => (f.remoteId ?? null) === host)?.path;
    const fallback = known ? trim(known).replace(/[\\/][^\\/]*$/, '') || '/' : '';
    const exists = (dir: string) => within(client.listDirs(dir, host), 4000)
      .then(list => list.some(d => trim(d) === dir))
      .catch(() => false);
    const show = (p: string, home: string) => { browsedRef.current = { path: p, home }; setPath(p); };
    within(client.getUserHome(host), 4000)
      .then(async raw => {
        const home = raw && raw !== '/' ? trim(raw) : '';
        const underHome = prev.home && prev.path.startsWith(`${prev.home}/`) && home
          ? home + prev.path.slice(prev.home.length) : '';
        for (const candidate of [...new Set([prev.path, underHome].filter(Boolean))]) {
          if (candidate === '/' || candidate === prev.home) continue;   // a home isn't "the same folder"
          if (await exists(candidate)) { if (live) show(candidate, home); return; }
          if (!live) return;
        }
        if (live) show(home || fallback || '/', home);
      })
      .catch(() => {
        if (!live) return;
        if (fallback) show(fallback, '');
        else { setDirs([]); setFailed(true); }
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, host]);

  // Track the folder in view (a picked one first), so a host switch knows what to look for.
  useEffect(() => {
    const current = selected ?? path;
    if (current) browsedRef.current = { ...browsedRef.current, path: trim(current) };
  }, [path, selected]);

  useEffect(() => {
    if (!client || !path) return;
    let live = true;
    setDirs(null);
    setFailed(false);
    within(client.listDirs(path === '/' ? '/' : `${path}/`, host), 6000)
      // Dot-folders (.Trash, .cache…) are never a project; leave them out.
      .then(list => { if (live) setDirs(list.map(trim).filter(d => !/[\\/]\.[^\\/]*$/.test(d))); })
      .catch(() => { if (live) { setDirs([]); setFailed(true); } });
    return () => { live = false; };
  }, [client, path, host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const inProject = (p: string) => existing.some(f => (f.remoteId ?? null) === host && trim(f.path) === trim(p));
  const open = (p: string) => { setSelected(null); setPath(p); };
  const parent = path.replace(/[\\/][^\\/]*$/, '') || '/';
  // Nothing picked in the list adds the folder being browsed.
  const target = selected ?? path;
  const canAdd = !!target && !inProject(target);
  const add = () => { if (canAdd) onAdd({ path: trim(target), remoteId: host }); };
  const crumbs = path.split('/').filter(Boolean).map((seg, i, all) => ({ seg, at: `/${all.slice(0, i + 1).join('/')}` }));
  const hostIndex = Math.max(0, hosts.findIndex(h => h.id === host));
  const hostLabel = hosts[hostIndex]?.name ?? 'Local';

  return createPortal(
    <div className="fixed inset-0 z-[10001] grid place-items-center bg-black/50 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={`Add folder to ${project.name}`}
        className="w-[440px] max-w-[92vw] rounded-2xl bg-zinc-900/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60 p-1.5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 pl-2.5 pr-1 h-9">
          <span
            className="w-4 h-4 rounded-[5px] grid place-items-center font-mono text-[9.5px] font-semibold shrink-0"
            style={{ background: project.color ?? 'var(--color-surface-lighter)', color: project.color ? '#0f1012' : 'var(--color-zinc-300)' }}
          >
            {project.name.trim().charAt(0).toUpperCase()}
          </span>
          <h2 className="text-[13px] font-semibold text-zinc-100 truncate">Add folder to {project.name}</h2>
          <div className="flex-1" />
          {hosts.length > 1 && (
            <div
              role="radiogroup"
              aria-label="Host"
              className="relative grid p-0.5 rounded-full bg-white/[0.05] shrink-0"
              style={{ gridTemplateColumns: `repeat(${hosts.length}, minmax(0, 1fr))` }}
            >
              <span
                className="absolute top-0.5 bottom-0.5 left-0.5 rounded-full bg-zinc-700/80 transition-transform duration-200"
                style={{ width: `calc((100% - 4px) / ${hosts.length})`, transform: `translateX(${hostIndex * 100}%)` }}
              />
              {hosts.map(h => (
                <button
                  key={h.id ?? 'local'}
                  type="button"
                  role="radio"
                  aria-checked={h.id === host}
                  onClick={() => setHost(h.id)}
                  className={`relative z-10 h-6 px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-[11.5px] transition-colors ${
                    h.id === host ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.color || (h.id ? '#a78bfa' : '#71717a') }} />
                  {h.name}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 grid place-items-center rounded-full text-zinc-500 hover:text-zinc-200 hover:bg-white/5 shrink-0"
            aria-label="Close"
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>

        <div className="mt-1 rounded-xl bg-black/25 border border-white/[0.06] overflow-hidden">
          <div className="flex items-center gap-0.5 px-1 h-8 border-b border-white/[0.04]">
            <button
              type="button"
              onClick={() => open(parent)}
              disabled={!path || path === '/'}
              className="w-6 h-6 grid place-items-center rounded-full text-zinc-500 hover:text-zinc-200 hover:bg-white/5 disabled:opacity-30 shrink-0"
              aria-label="Parent folder"
              title="Parent folder"
            >
              <ChevronLeft size={13} strokeWidth={1.8} />
            </button>
            <div className="flex items-center min-w-0 overflow-hidden font-mono text-[11.5px]" title={path}>
              <button type="button" onClick={() => open('/')} className="h-6 px-1.5 rounded-full text-zinc-500 hover:text-zinc-200 hover:bg-white/5 shrink-0">/</button>
              {crumbs.map((c, i) => (
                <span key={c.at} className="flex items-center min-w-0">
                  {i > 0 && <span className="text-zinc-700">/</span>}
                  <button
                    type="button"
                    onClick={() => open(c.at)}
                    className={`h-6 px-1.5 rounded-full truncate ${i === crumbs.length - 1 ? 'text-zinc-300' : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'}`}
                  >
                    {c.seg}
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div role="listbox" aria-label="Folders" className="h-[196px] overflow-y-auto p-1">
            {dirs === null && (
              <div className="flex items-center gap-2 px-2 h-7 text-[12px] text-zinc-600"><Loader2 size={12} className="animate-spin" /> Loading…</div>
            )}
            {dirs?.length === 0 && (
              <div className="px-2 h-7 flex items-center text-[12px] text-zinc-600">
                {failed ? `Can’t reach ${hostLabel} right now.` : 'No subfolders'}
              </div>
            )}
            {dirs?.map(d => {
              const added = inProject(d);
              const on = selected === d;
              return (
                <div
                  key={d}
                  role="option"
                  aria-selected={on}
                  aria-disabled={added}
                  onClick={() => { if (!added) setSelected(on ? null : d); }}
                  onDoubleClick={() => open(d)}
                  className={`group flex items-center gap-2 h-7 px-2 rounded-lg cursor-pointer text-[12.5px] select-none ${
                    on ? 'bg-violet-500/15 text-zinc-100' : added ? 'text-zinc-600' : 'text-zinc-300 hover:bg-white/[0.05]'
                  }`}
                >
                  <Folder size={13} strokeWidth={1.6} className={`shrink-0 ${on ? 'text-violet-300' : added ? 'text-zinc-700' : 'text-zinc-500'}`} />
                  <span className="flex-1 truncate">{baseName(d)}</span>
                  {added && <span className="text-[10.5px] text-zinc-600">In project</span>}
                  {on && <Check size={13} strokeWidth={2.2} className="text-violet-300 shrink-0" />}
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); open(d); }}
                    className="w-5 h-5 grid place-items-center rounded-full text-zinc-600 hover:text-zinc-200 hover:bg-white/5 opacity-0 group-hover:opacity-100 shrink-0"
                    aria-label={`Open ${baseName(d)}`}
                  >
                    <ChevronRight size={12} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1.5 pl-2.5 pt-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500" title={target}>
            {target ? `${host ? `${hostLabel}:` : ''}${tilde(target)}` : ''}
          </span>
          <button type="button" onClick={onClose} className="h-7 px-3 rounded-full text-[12px] text-zinc-400 hover:text-zinc-100 hover:bg-white/5">
            Cancel
          </button>
          <button
            type="button"
            onClick={add}
            disabled={!canAdd}
            className="h-7 px-3 rounded-full text-[12px] font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-40"
          >
            Add folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
