import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Folder, FolderOpen, Loader2, Plus, Trash2, X } from 'lucide-react';
import { GROUP_COLORS, GROUP_HEX_COLOR } from '../lib/tab-groups';
import type { ClaudeClient, RemoteTarget, SlackStatus } from '../lib/claude-client';
import { SlackConnect } from './SlackConnect';
import type { Project, ProjectFolder } from '../lib/project-scope';

interface Props {
  /** The project to edit, or a draft (no id yet) for a new one. */
  project: Project | Omit<Project, 'id'>;
  isNew: boolean;
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  /** Folders open sessions run in, offered as one-click additions. */
  suggestions: ProjectFolder[];
  /** GitHub owners seen in the Inbox's pull requests, offered as one-click additions. */
  orgSuggestions?: string[];
  onSave: (project: Omit<Project, 'id'>) => void;
  onDelete?: () => void;
  onClose: () => void;
  /** This project's Slack connection on this machine, and the one made
   *  before projects had their own (offered to move here). */
  slack?: { status?: SlackStatus; legacy?: SlackStatus; manifest: string };
}

const hostName = (remotes: RemoteTarget[], id: string | null) =>
  id ? (remotes.find(r => r.id === id)?.name || id) : 'Local';
/** A remote whose tunnel isn't up can leave a request pending instead of
 *  failing; bound it so the dialog falls back instead of spinning. */
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
const sameFolder = (a: ProjectFolder, b: ProjectFolder) => a.path === b.path && (a.remoteId ?? null) === (b.remoteId ?? null);

/** Create or edit a project: name, colour, and the folders (each on a host)
 *  whose sessions belong to it. */
export function ProjectDialog({ project, isNew, client, remotes, suggestions, orgSuggestions = [], onSave, onDelete, onClose, slack }: Props) {
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color ?? GROUP_COLORS[0]);
  const [folders, setFolders] = useState<ProjectFolder[]>(project.folders.length ? project.folders : []);
  const [orgs, setOrgs] = useState<string[]>(project.githubOrgs ?? []);
  const [orgDraft, setOrgDraft] = useState('');
  const addOrg = (raw: string) => {
    // Accept a bare owner, owner/repo, or a github.com URL — keep the owner.
    const owner = raw.trim().replace(/^https?:\/\/github\.com\//, '').split('/')[0]?.trim();
    if (owner && !orgs.some(o => o.toLowerCase() === owner.toLowerCase())) setOrgs([...orgs, owner]);
    setOrgDraft('');
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Row whose folder browser is open. */
  const [browsing, setBrowsing] = useState<number | null>(null);

  /** Home folder of a host — what a new row, or a row switched to another
   *  host, starts at: a path from one machine means nothing on another. */
  const homeOf = useCallback(async (remoteId: string | null) => {
    try {
      const home = client ? await within(client.getUserHome(remoteId), 2500) : '';
      if (home && home !== '/') return home;
    } catch { /* host unreachable (tunnel not up yet) — fall through */ }
    // Read it off a session already running on that host.
    for (const s of suggestions) {
      if ((s.remoteId ?? null) !== remoteId) continue;
      const m = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(s.path);
      if (m) return m[1]!;
    }
    return '';
  }, [client, suggestions]);
  const changeHost = async (i: number, remoteId: string | null) => {
    patch(i, { remoteId, path: '' });
    const home = await homeOf(remoteId);
    setFolders(prev => prev.map((f, j) => (j === i && f.remoteId === remoteId && !f.path ? { ...f, path: home } : f)));
  };
  const addFolder = async () => {
    const i = folders.length;
    setFolders(prev => [...prev, { path: '', remoteId: null }]);
    const home = await homeOf(null);
    setFolders(prev => prev.map((f, j) => (j === i && !f.path ? { ...f, path: home } : f)));
    setBrowsing(i);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const unused = useMemo(
    () => suggestions.filter(s => !folders.some(f => sameFolder(f, s))).slice(0, 8),
    [suggestions, folders],
  );
  const cleaned = folders
    .map(f => ({ path: f.path.trim().replace(/[\\/]+$/, ''), remoteId: f.remoteId }))
    .filter(f => f.path);
  const canSave = !!name.trim() && cleaned.length > 0;

  const save = () => {
    if (!canSave) return;
    const all = orgDraft.trim() ? [...orgs, orgDraft.trim().split('/')[0]!] : orgs;
    onSave({ name: name.trim(), color, folders: cleaned, githubOrgs: [...new Set(all)] });
  };
  const patch = (i: number, p: Partial<ProjectFolder>) =>
    setFolders(prev => prev.map((f, j) => (j === i ? { ...f, ...p } : f)));

  return createPortal(
    <div className="fixed inset-0 z-[10001] grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-[92vw] max-h-[88vh] flex flex-col bg-surface rounded-xl border border-border-light shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-label={isNew ? 'New project' : 'Edit project'}
      >
        <div className="flex items-center h-12 px-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-zinc-100">{isNew ? 'New project' : 'Edit project'}</h2>
          <button type="button" onClick={onClose} className="ml-auto w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light" aria-label="Close">
            <X size={15} strokeWidth={1.6} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 overflow-y-auto min-h-0">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-zinc-500">Name</span>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
              placeholder="Project name"
              className="h-8 px-2.5 rounded-md bg-base border border-border text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-zinc-500">Color</span>
            <div className="flex items-center gap-2">
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={`w-[18px] h-[18px] rounded-[5px] transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-offset-[var(--color-surface)] ring-zinc-400 scale-105' : 'hover:scale-110'}`}
                  style={{ background: GROUP_HEX_COLOR[c] }}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-zinc-500">Folders <span className="text-zinc-600">· sessions in these folders, or below them, belong to the project</span></span>
            {folders.length === 0 && (
              <div className="text-[12px] text-zinc-600 px-0.5">No folders yet. Pick one below or add it by path.</div>
            )}
            {folders.map((f, i) => (
              <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <select
                  value={f.remoteId ?? ''}
                  onChange={e => { void changeHost(i, e.target.value || null); }}
                  className="h-8 px-2 rounded-md bg-base border border-border text-[12.5px] text-zinc-300 outline-none"
                  aria-label="Host"
                >
                  <option value="">Local</option>
                  {remotes.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
                  {/* A host not reachable from here: say so instead of the
                      select falling back to its first option, "Local". */}
                  {f.remoteId?.startsWith('host:') && <option value={f.remoteId}>Another machine</option>}
                </select>
                <input
                  value={f.path}
                  onChange={e => patch(i, { path: e.target.value })}
                  placeholder="/Users/you/src/project"
                  className="flex-1 min-w-0 h-8 px-2.5 rounded-md bg-base border border-border font-mono text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
                  aria-label="Folder path"
                />
                <button
                  type="button"
                  onClick={() => setBrowsing(b => (b === i ? null : i))}
                  className={`h-8 flex items-center gap-1.5 px-2.5 rounded-md border text-[12.5px] transition-colors ${
                    browsing === i ? 'border-zinc-500 text-zinc-100 bg-surface-light' : 'border-border text-zinc-400 hover:text-zinc-200 hover:bg-surface-light'
                  }`}
                  aria-expanded={browsing === i}
                  title="Browse folders on this host"
                >
                  <FolderOpen size={14} strokeWidth={1.6} /> Browse
                </button>
                <button
                  type="button"
                  onClick={() => { setFolders(prev => prev.filter((_, j) => j !== i)); setBrowsing(null); }}
                  className="w-8 h-8 grid place-items-center rounded-md text-zinc-600 hover:text-zinc-200 hover:bg-surface-light"
                  aria-label="Remove folder"
                >
                  <X size={14} strokeWidth={1.6} />
                </button>
              </div>
              {browsing === i && (
                <FolderBrowser
                  // Remount per host: a path from one machine means nothing on another.
                  key={f.remoteId ?? ''}
                  client={client}
                  remoteId={f.remoteId}
                  start={f.path}
                  homeOf={homeOf}
                  onNavigate={(path) => patch(i, { path })}
                  onDone={() => setBrowsing(null)}
                />
              )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => { void addFolder(); }}
              className="self-start h-7 flex items-center gap-1.5 px-2 rounded-md text-[12.5px] text-zinc-400 hover:text-zinc-200 hover:bg-surface-light"
            >
              <Plus size={13} strokeWidth={1.6} /> Add folder
            </button>
            {unused.length > 0 && (
              <div className="flex flex-col gap-1 mt-1">
                <span className="text-[11.5px] text-zinc-600">From your open sessions</span>
                <div className="flex flex-wrap gap-1.5">
                  {unused.map(s => (
                    <button
                      key={`${s.remoteId ?? ''}:${s.path}`}
                      type="button"
                      onClick={() => setFolders(prev => [...prev.filter(f => f.path.trim()), s])}
                      className="h-6 flex items-center gap-1.5 px-2 rounded-md border border-border text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:border-border-light"
                      title={`${s.path} · ${hostName(remotes, s.remoteId)}`}
                    >
                      <Plus size={11} strokeWidth={1.8} />
                      <span className="font-mono">{tilde(s.path)}</span>
                      <span className="text-zinc-600">{hostName(remotes, s.remoteId)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-zinc-500">GitHub organizations <span className="text-zinc-600">· their pull requests belong to this project</span></span>
            <div className="flex flex-wrap items-center gap-1.5 min-h-8 px-2 py-1 rounded-md bg-base border border-border focus-within:border-zinc-500">
              {orgs.map(o => (
                <span key={o} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-surface-lighter text-[12.5px] text-zinc-200">
                  {o}
                  <button type="button" onClick={() => setOrgs(orgs.filter(x => x !== o))} className="w-4 h-4 grid place-items-center rounded text-zinc-500 hover:text-zinc-200" aria-label={`Remove ${o}`}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                value={orgDraft}
                onChange={e => setOrgDraft(e.target.value)}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ',') && orgDraft.trim()) { e.preventDefault(); addOrg(orgDraft); }
                  if (e.key === 'Backspace' && !orgDraft && orgs.length) setOrgs(orgs.slice(0, -1));
                }}
                onBlur={() => { if (orgDraft.trim()) addOrg(orgDraft); }}
                placeholder={orgs.length ? '' : 'e.g. your-org'}
                className="flex-1 min-w-[120px] h-6 bg-transparent text-[12.5px] text-zinc-200 placeholder:text-zinc-600 outline-none"
                aria-label="GitHub organization"
              />
            </div>
            {orgSuggestions.filter(o => !orgs.some(x => x.toLowerCase() === o.toLowerCase())).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {orgSuggestions.filter(o => !orgs.some(x => x.toLowerCase() === o.toLowerCase())).map(o => (
                  <button key={o} type="button" onClick={() => addOrg(o)}
                    className="h-6 flex items-center gap-1.5 px-2 rounded-md border border-border text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:border-border-light">
                    <Plus size={11} strokeWidth={1.8} /> {o}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-zinc-500">Slack</span>
            {isNew || !('id' in project)
              ? <div className="text-[12px] text-zinc-600 px-0.5">Create the project first, then connect its Slack workspace here.</div>
              : <SlackConnect client={client} projectId={project.id} status={slack?.status} legacy={slack?.legacy} manifest={slack?.manifest ?? ''} />}
          </div>
        </div>

        <div className="flex items-center gap-2 h-14 px-4 border-t border-border">
          {onDelete && (confirmDelete ? (
            <>
              <span className="text-[12px] text-zinc-500">Delete the project? Sessions and groups stay.</span>
              <button type="button" onClick={onDelete} className="h-8 px-3 rounded-md text-[12.5px] font-medium text-red-400 hover:bg-red-500/10">Delete</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="h-8 flex items-center gap-1.5 px-2.5 rounded-md text-[12.5px] text-zinc-500 hover:text-red-400 hover:bg-red-500/10">
              <Trash2 size={13} strokeWidth={1.6} /> Delete
            </button>
          ))}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="h-8 px-3 rounded-md text-[12.5px] text-zinc-400 hover:text-zinc-200 hover:bg-surface-light">Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="path-primary h-8 px-3 rounded-md text-[12.5px] font-medium disabled:opacity-40"
          >
            {isNew ? 'Create project' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Navigable list of the subfolders of a path on one host. Every step writes
 *  the path back into the row, so "Done" just closes the list. */
function FolderBrowser({ client, remoteId, start, homeOf, onNavigate, onDone }: {
  client: ClaudeClient | null;
  remoteId: string | null;
  start: string;
  homeOf: (remoteId: string | null) => Promise<string>;
  onNavigate: (path: string) => void;
  onDone: () => void;
}) {
  const [path, setPath] = useState(start.replace(/[\\/]+$/, '') || '');
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

  // A blank row starts at the host's home.
  useEffect(() => {
    if (path) return;
    let live = true;
    void homeOf(remoteId).then(h => {
      if (!live) return;
      if (h) { setPath(h); onNavigate(h); }
      else { setDirs([]); setFailed(true); }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteId]);

  useEffect(() => {
    if (!client || !path) return;
    let live = true;
    setDirs(null);
    setFailed(false);
    within(client.listDirs(`${path}/`, remoteId), 6000)
      // Dot-folders (.Trash, .cache…) are never a project; leave them out.
      .then(list => { if (live) setDirs(list.map(d => d.replace(/[\\/]+$/, '')).filter(d => !/[\\/]\.[^\\/]*$/.test(d))); })
      .catch(() => { if (live) { setDirs([]); setFailed(true); } });
    return () => { live = false; };
  }, [client, path, remoteId]);

  const go = (next: string) => { setPath(next); onNavigate(next); };
  const parent = path.replace(/[\\/][^\\/]*$/, '') || '/';
  const name = (d: string) => d.slice(d.replace(/[\\/]+$/, '').search(/[^\\/]*$/));

  return (
    <div className="rounded-lg border border-border bg-base overflow-hidden">
      <div className="flex items-center gap-2 h-8 px-2 border-b border-border">
        <button
          type="button"
          onClick={() => go(parent)}
          disabled={path === '/' || !path}
          className="w-6 h-6 grid place-items-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface-light disabled:opacity-30"
          aria-label="Parent folder"
          title="Parent folder"
        >
          <ArrowUp size={13} strokeWidth={1.8} />
        </button>
        <span className="flex-1 min-w-0 truncate font-mono text-[11.5px] text-zinc-400" title={path}>{path || '…'}</span>
        <button
          type="button"
          onClick={onDone}
          className="h-6 px-2 rounded text-[12px] font-medium text-zinc-200 hover:bg-surface-light"
        >
          Use this folder
        </button>
      </div>
      <div className="max-h-[200px] overflow-y-auto py-1">
        {dirs === null && (
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-600"><Loader2 size={12} className="animate-spin" /> Loading…</div>
        )}
        {dirs?.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-zinc-600">
            {failed ? 'Can’t reach this host right now — type the path instead.' : 'No subfolders'}
          </div>
        )}
        {dirs?.map(d => (
          <button
            key={d}
            type="button"
            onClick={() => go(d)}
            className="w-full flex items-center gap-2 px-3 h-7 text-left text-[12.5px] text-zinc-300 hover:bg-surface-light"
          >
            <Folder size={13} strokeWidth={1.6} className="text-zinc-500 shrink-0" />
            <span className="truncate">{name(d)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
