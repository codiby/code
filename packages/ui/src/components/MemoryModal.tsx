import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight, Brain, Check, ChevronDown, CircleDot, GitCompare, List, RefreshCw, Search, Send, Trash2, UserRound, X,
} from 'lucide-react';
import type {
  ClaudeClient, HostMemory, MemoryProvider, MemoryTarget, ProjectMemoryInfo, RemoteTarget,
} from '../lib/claude-client';
import {
  MEMORY_INDEX, PROVIDER_FILE, planSync, presenceOf, type Presence, type Side, type SyncMode,
} from '../lib/memory-sync';

type RemoteStatus = { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null };

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient | null;
  remotes: RemoteTarget[];
  remoteStatuses: Record<string, RemoteStatus>;
}

/** `null` is the local bridge everywhere a host id is passed to the client. */
type HostId = string | null;
const LOCAL = 'local';
const idOf = (key: string): HostId => (key === LOCAL ? null : key);

interface HostRow { key: string; name: string; color: string; online: boolean }
type HostData = { status: 'loading' } | { status: 'ok'; memory: HostMemory } | { status: 'error'; error: string };

const USER = '__user';
const TYPES = ['all', 'user', 'feedback', 'project', 'reference'] as const;
const TYPE_BADGE: Record<string, string> = {
  user: 'bg-sky-400/15 text-sky-300',
  feedback: 'bg-amber-400/15 text-amber-300',
  project: 'bg-violet-400/15 text-violet-300',
  reference: 'bg-teal-400/15 text-teal-300',
};
const PROVIDER_BADGE: Record<MemoryProvider, string> = {
  claude: 'bg-violet-400/15 text-violet-300',
  codex: 'bg-sky-400/15 text-sky-300',
  opencode: 'bg-teal-400/15 text-teal-300',
};

/** One selectable file in the middle column. */
type Entry =
  | { scope: 'user'; provider: MemoryProvider; label: string; exists: boolean }
  | { scope: 'project'; name: string; type: string | null; description: string | null };

function ago(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function PresenceChip({ list }: { list: { host: HostRow; presence: Presence }[] }) {
  if (list.length === 0) return null;
  if (list.every(p => p.presence === 'same')) {
    return <span title="Identical on every host" className="ml-auto shrink-0 text-emerald-400"><Check size={11} /></span>;
  }
  if (list.some(p => p.presence === 'differs')) {
    return <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] text-orange-400"><GitCompare size={11} />differs</span>;
  }
  const label = list.every(p => p.presence !== 'same') ? 'only here' : 'not everywhere';
  return <span className="ml-auto shrink-0 flex items-center gap-1 text-[10px] text-amber-400"><CircleDot size={11} />{label}</span>;
}

export function MemoryModal({ open, onClose, client, remotes, remoteStatuses }: Props) {
  const hosts = useMemo<HostRow[]>(() => [
    { key: LOCAL, name: 'This computer', color: '#4ade80', online: true },
    ...remotes.map(r => ({
      key: r.id,
      name: r.name || r.id,
      color: r.color || '#60a5fa',
      online: remoteStatuses[r.id]?.status === 'online',
    })),
  ], [remotes, remoteStatuses]);

  const [data, setData] = useState<Record<string, HostData>>({});
  const [hostKey, setHostKey] = useState(LOCAL);
  const [projectKey, setProjectKey] = useState<string>(USER);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<(typeof TYPES)[number]>('all');
  const [query, setQuery] = useState('');

  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [compare, setCompare] = useState<{ host: HostRow; content: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [syncOpen, setSyncOpen] = useState(false);

  const loadHost = useCallback(async (key: string) => {
    if (!client) return;
    setData(d => ({ ...d, [key]: { status: 'loading' } }));
    try {
      const memory = await client.listMemory(idOf(key));
      setData(d => ({ ...d, [key]: { status: 'ok', memory } }));
    } catch (e: any) {
      setData(d => ({ ...d, [key]: { status: 'error', error: e?.message || String(e) } }));
    }
  }, [client]);

  // Every online host loads on open — the presence chips compare across all of them.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSyncOpen(false);
    for (const h of hosts) if (h.online) void loadHost(h.key);
    // Re-running on every status flicker would refetch the world; open is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadHost]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const dirty = content !== baseline;

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (syncOpen) setSyncOpen(false);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, syncOpen, requestClose]);

  const host = hosts.find(h => h.key === hostKey) ?? hosts[0];
  const hostData = data[hostKey];
  const memory = hostData?.status === 'ok' ? hostData.memory : null;
  const others = hosts
    .filter(h => h.key !== hostKey)
    .flatMap(h => {
      const d = data[h.key];
      return d?.status === 'ok' ? [{ host: h, memory: d.memory }] : [];
    });

  const project: ProjectMemoryInfo | null =
    projectKey === USER ? null : memory?.projects.find(p => p.key === projectKey) ?? null;

  const entries = useMemo<Entry[]>(() => {
    if (!memory) return [];
    if (projectKey === USER) {
      return memory.user
        .filter(u => u.exists || others.some(o => o.memory.user.find(x => x.provider === u.provider)?.exists))
        .map(u => ({ scope: 'user', provider: u.provider, label: PROVIDER_FILE[u.provider], exists: u.exists }));
    }
    return (project?.files ?? [])
      .filter(f => f.name !== MEMORY_INDEX)
      .filter(f => typeFilter === 'all' || f.type === typeFilter)
      .map(f => ({ scope: 'project', name: f.name, type: f.type, description: f.description }));
  }, [memory, projectKey, project, typeFilter, others]);

  const entryKey = (e: Entry) => (e.scope === 'user' ? e.provider : e.name);

  // Picking a host or project opens its first file rather than an empty pane.
  useEffect(() => {
    if (entryId == null && entries.length) setEntryId(entryKey(entries[0]));
  }, [entries, entryId]);
  const current: Entry | null = entryId === MEMORY_INDEX && project
    ? { scope: 'project', name: MEMORY_INDEX, type: null, description: null }
    : entries.find(e => entryKey(e) === entryId) ?? null;

  const targetFor = useCallback((e: Entry, p: ProjectMemoryInfo | null): MemoryTarget | null => {
    if (e.scope === 'user') return { scope: 'user', provider: e.provider };
    return p ? { scope: 'project', slug: p.slug, name: e.name } : null;
  }, []);

  const presenceFor = (e: Entry) => {
    if (!memory) return [];
    const ref = e.scope === 'user'
      ? { scope: 'user' as const, provider: e.provider }
      : { scope: 'project' as const, key: projectKey, name: e.name };
    return others.map(o => ({ host: o.host, presence: presenceOf(memory, o.memory, ref) }));
  };

  // Load the selected file.
  useEffect(() => {
    setCompare(null);
    setConfirmDelete(false);
    if (!client || !current || !memory) { setContent(''); setBaseline(''); return; }
    if (current.scope === 'user' && !current.exists) { setContent(''); setBaseline(''); return; }
    const target = targetFor(current, project);
    if (!target) return;
    let cancelled = false;
    setFileLoading(true);
    client.readMemory(idOf(hostKey), target)
      .then(r => { if (!cancelled) { setContent(r.content); setBaseline(r.content); setError(null); } })
      .catch(e => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setFileLoading(false); });
    return () => { cancelled = true; };
    // Keyed on identity, not object refs, so a host reload doesn't wipe edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hostKey, projectKey, entryId, memory != null]);

  const guardDirty = () => !dirty || window.confirm('Discard unsaved changes?');

  const pickHost = (key: string) => {
    if (key === hostKey || !guardDirty()) return;
    setHostKey(key);
    setEntryId(null);
    const d = data[key];
    if (projectKey !== USER && !(d?.status === 'ok' && d.memory.projects.some(p => p.key === projectKey))) setProjectKey(USER);
  };
  const pickProject = (key: string) => {
    if (key === projectKey || !guardDirty()) return;
    setProjectKey(key);
    setEntryId(null);
  };
  const pickEntry = (id: string) => {
    if (id === entryId || !guardDirty()) return;
    setEntryId(id);
  };

  const save = async () => {
    if (!client || !current || !dirty || saving) return;
    const target = targetFor(current, project);
    if (!target) return;
    setSaving(true);
    try {
      await client.writeMemory(idOf(hostKey), target, content);
      setBaseline(content);
      await loadHost(hostKey);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
    setSaving(false);
  };

  const remove = async () => {
    if (!client || !current) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    const target = targetFor(current, project);
    if (!target) return;
    try {
      await client.deleteMemory(idOf(hostKey), target);
      setEntryId(null);
      await loadHost(hostKey);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  /** Write this host's saved copy of the current file to another host. */
  const copyTo = async (other: { host: HostRow; memory: HostMemory }) => {
    if (!client || !current) return;
    const otherProject = current.scope === 'project' ? other.memory.projects.find(p => p.key === projectKey) ?? null : null;
    const target = targetFor(current, otherProject);
    if (!target) return;
    try {
      await client.writeMemory(idOf(other.host.key), target, baseline);
      await loadHost(other.host.key);
      setToast(`Copied to ${other.host.name}`);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const toggleCompare = async (other: { host: HostRow; memory: HostMemory }) => {
    if (!client || !current) return;
    if (compare?.host.key === other.host.key) { setCompare(null); return; }
    const otherProject = current.scope === 'project' ? other.memory.projects.find(p => p.key === projectKey) ?? null : null;
    const target = targetFor(current, otherProject);
    if (!target) return;
    try {
      const r = await client.readMemory(idOf(other.host.key), target);
      setCompare({ host: other.host, content: r.content });
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const toggleSharing = async () => {
    if (!client || !memory) return;
    try {
      await client.setMemorySharing(idOf(hostKey), !memory.shareAcrossProviders);
      await loadHost(hostKey);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  if (!open) return null;

  const totalFiles = Object.values(data).reduce((n, d) => n + (d.status === 'ok'
    ? d.memory.user.filter(u => u.exists).length + d.memory.projects.reduce((m, p) => m + p.files.filter(f => f.name !== MEMORY_INDEX).length, 0)
    : 0), 0);
  const q = query.trim().toLowerCase();
  const projects = (memory?.projects ?? []).filter(p => !q || p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q));
  const userPending = memory ? memory.user.some(u => others.some(o => presenceOf(memory, o.memory, { scope: 'user', provider: u.provider }) !== 'same' && (u.exists || o.memory.user.find(x => x.provider === u.provider)?.exists))) : false;
  const projectPending = (p: ProjectMemoryInfo) => !!memory && p.files.some(f => f.name !== MEMORY_INDEX
    && others.some(o => presenceOf(memory, o.memory, { scope: 'project', key: p.key, name: f.name }) !== 'same'));
  const onlineCount = hosts.filter(h => h.online).length;
  const presence = current && !(current.scope === 'project' && current.name === MEMORY_INDEX) ? presenceFor(current) : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div className="relative flex flex-col bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden w-[1240px] max-w-[calc(100vw-32px)] h-[740px] max-h-[calc(100vh-32px)]">
        {/* Header */}
        <div className="flex items-center gap-2.5 h-[52px] px-4 border-b border-border shrink-0">
          <Brain size={18} className="text-violet-300" />
          <span className="text-sm font-semibold text-zinc-100">Agent memory</span>
          <span className="text-[11px] text-zinc-600">{totalFiles} files · {onlineCount} {onlineCount === 1 ? 'host' : 'hosts'}</span>
          <div className="ml-auto flex items-center gap-2">
            {memory && (
              <button
                type="button"
                onClick={toggleSharing}
                title="When on, new sessions on this host also get the other agents' memory: Codex and OpenCode read Claude's, Claude reads Codex's and OpenCode's."
                className="flex items-center gap-2 h-7 px-2.5 rounded-md text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:bg-surface-lighter"
              >
                <span className={`relative w-7 h-4 rounded-full transition-colors ${memory.shareAcrossProviders ? 'bg-violet-500' : 'bg-zinc-700'}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${memory.shareAcrossProviders ? 'left-3.5' : 'left-0.5'}`} />
                </span>
                Share across agents
              </button>
            )}
            <button
              type="button"
              onClick={() => setSyncOpen(true)}
              disabled={onlineCount < 2}
              title={onlineCount < 2 ? 'Connect another host to sync' : undefined}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border-light bg-surface-light text-[12px] font-semibold text-zinc-200 hover:border-violet-300 hover:text-violet-300 disabled:opacity-40 disabled:pointer-events-none"
            >
              <RefreshCw size={13} />
              Sync between hosts
            </button>
            <button
              type="button"
              onClick={requestClose}
              className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Hosts + projects */}
          <div className="w-[250px] border-r border-border flex flex-col shrink-0">
            <div className="p-3 border-b border-border flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">Host</div>
              <div className="flex flex-col gap-0.5">
                {hosts.map(h => {
                  const d = data[h.key];
                  const sub = !h.online ? 'offline'
                    : d?.status === 'ok' ? (h.key === LOCAL ? d.memory.hostname : `${d.memory.projects.length} projects`)
                    : d?.status === 'error' ? 'error' : '…';
                  return (
                    <button
                      key={h.key}
                      type="button"
                      disabled={!h.online}
                      onClick={() => pickHost(h.key)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-md border text-left disabled:opacity-50 ${
                        h.key === hostKey ? 'bg-surface-light border-border-light' : 'border-transparent hover:bg-surface-light'
                      }`}
                    >
                      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: h.online ? h.color : '#71717a' }} />
                      <span className="text-[12.5px] font-semibold text-zinc-200 truncate">{h.name}</span>
                      <span className="ml-auto text-[10.5px] text-zinc-600 truncate max-w-[45%]">{sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2 bg-base border border-border rounded-md px-2.5 py-1.5 mx-3 mt-3 mb-1.5">
              <Search size={14} className="text-zinc-600 shrink-0" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search projects…"
                className="bg-transparent border-none outline-none text-[12px] text-zinc-200 w-full placeholder:text-zinc-600"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-1.5 pb-2">
              {hostData?.status === 'loading' && <div className="text-[12px] text-zinc-600 px-2 py-3">Loading…</div>}
              {hostData?.status === 'error' && <div className="text-[12px] text-red-400/80 px-2 py-3 leading-snug">{hostData.error}</div>}
              {memory && (
                <>
                  <button
                    type="button"
                    onClick={() => pickProject(USER)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-left ${
                      projectKey === USER ? 'bg-violet-400/10 border-violet-400/25' : 'border-transparent hover:bg-surface-light'
                    }`}
                  >
                    <UserRound size={14} className="text-violet-300 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold text-zinc-200 truncate">User (global)</div>
                      <div className="text-[10.5px] text-zinc-600 font-mono truncate">CLAUDE.md · AGENTS.md</div>
                    </div>
                    {others.length > 0 && <span className={`ml-auto w-1.5 h-1.5 rounded-full shrink-0 ${userPending ? 'bg-amber-400' : 'bg-emerald-400'}`} />}
                  </button>
                  <div className="h-px bg-border my-1.5 mx-1" />
                  <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold px-2 pb-1">Projects</div>
                  {projects.length === 0 && <div className="text-[12px] text-zinc-600 px-2 py-2">No project memory.</div>}
                  {projects.map(p => (
                    <button
                      key={p.slug}
                      type="button"
                      onClick={() => pickProject(p.key)}
                      title={p.path ?? p.slug}
                      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-left ${
                        projectKey === p.key ? 'bg-violet-400/10 border-violet-400/25' : 'border-transparent hover:bg-surface-light'
                      }`}
                    >
                      {others.length > 0 && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${projectPending(p) ? 'bg-amber-400' : 'bg-emerald-400'}`} />}
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-semibold text-zinc-200 truncate">{p.name}</div>
                        <div className="text-[10.5px] text-zinc-600 font-mono truncate">{p.path ?? 'folder no longer exists'}</div>
                      </div>
                      <span className="ml-auto text-[10px] tabular-nums text-zinc-600">{p.files.filter(f => f.name !== MEMORY_INDEX).length}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Files */}
          <div className="w-[300px] border-r border-border flex flex-col shrink-0">
            <div className="p-3 border-b border-border flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">{projectKey === USER ? 'Instruction files' : 'Memories'}</span>
                <span className="text-[10.5px] text-zinc-600">{entries.length}</span>
              </div>
              {projectKey !== USER && (
                <div className="flex flex-wrap gap-1">
                  {TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTypeFilter(t)}
                      className={`text-[11px] px-2.5 py-0.5 rounded capitalize border transition-colors ${
                        typeFilter === t ? 'border-violet-400/40 text-violet-300 bg-violet-400/10' : 'border-border text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {project && (
              <button
                type="button"
                onClick={() => pickEntry(MEMORY_INDEX)}
                className={`m-1.5 flex items-center gap-2 px-2.5 py-2 rounded-md border border-dashed text-left ${
                  entryId === MEMORY_INDEX ? 'border-violet-300 text-violet-300' : 'border-border-light text-zinc-400 hover:text-violet-300 hover:border-violet-300'
                }`}
              >
                <List size={14} />
                <span className="font-mono text-[11.5px]">{MEMORY_INDEX}</span>
                <span className="ml-auto text-[10.5px] text-zinc-600">index</span>
              </button>
            )}
            <div className="flex-1 overflow-y-auto p-1.5">
              {memory && entries.length === 0 && (
                <div className="text-[12px] text-zinc-600 px-2 py-3">
                  {projectKey === USER ? 'No global instruction files on this host.' : 'Nothing here.'}
                </div>
              )}
              {entries.map(e => {
                const id = entryKey(e);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => pickEntry(id)}
                    className={`w-full text-left px-2.5 py-2 rounded-md border mb-0.5 ${
                      entryId === id ? 'bg-surface-light border-border-light' : 'border-transparent hover:bg-surface-light'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {e.scope === 'user' ? (
                        <>
                          <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide shrink-0 ${PROVIDER_BADGE[e.provider]}`}>{e.provider}</span>
                          <span className={`text-[12px] font-mono truncate ${e.exists ? 'text-zinc-200' : 'text-zinc-600 italic'}`}>{e.label}</span>
                        </>
                      ) : (
                        <>
                          {e.type && <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide shrink-0 ${TYPE_BADGE[e.type] ?? 'bg-surface-lighter text-zinc-400'}`}>{e.type}</span>}
                          <span className="text-[12.5px] font-semibold text-zinc-200 truncate">{e.name.replace(/\.md$/, '')}</span>
                        </>
                      )}
                      <PresenceChip list={presenceFor(e)} />
                    </div>
                    {e.scope === 'project' && e.description && (
                      <div className="text-[11px] text-zinc-500 mt-1 leading-snug line-clamp-2">{e.description}</div>
                    )}
                    {e.scope === 'user' && !e.exists && (
                      <div className="text-[11px] text-zinc-600 mt-1">Not on this host</div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detail */}
          <div className="flex-1 min-w-0 flex flex-col">
            {!current ? (
              <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-600">
                {memory ? 'Select a file to view it.' : ''}
              </div>
            ) : (
              <>
                <div className="px-[18px] pt-3.5 pb-3 border-b border-border flex flex-col gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {current.scope === 'user'
                      ? <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide ${PROVIDER_BADGE[current.provider]}`}>{current.provider}</span>
                      : current.type && <span className={`text-[9px] font-semibold px-1.5 py-px rounded uppercase tracking-wide ${TYPE_BADGE[current.type] ?? ''}`}>{current.type}</span>}
                    <span className="text-[15px] font-semibold text-zinc-100 truncate font-mono">
                      {current.scope === 'user' ? current.label : current.name}
                    </span>
                    {current.scope === 'user' && <span className="text-[10px] px-1.5 py-px rounded-full bg-surface-lighter text-zinc-400 shrink-0">applies to every project</span>}
                    {current.scope === 'project' && current.name === MEMORY_INDEX && <span className="text-[10px] px-1.5 py-px rounded-full bg-surface-lighter text-zinc-400 shrink-0">index</span>}
                    {!(current.scope === 'user' && !current.exists) && (
                      <button
                        type="button"
                        onClick={remove}
                        onBlur={() => setConfirmDelete(false)}
                        className={`ml-auto shrink-0 h-7 rounded-md flex items-center justify-center gap-1.5 text-[11.5px] ${
                          confirmDelete ? 'px-2.5 text-red-300 bg-red-400/15' : 'w-7 text-zinc-500 hover:text-red-400 hover:bg-red-400/10'
                        }`}
                        title="Delete"
                      >
                        <Trash2 size={14} />{confirmDelete && 'Click again to delete'}
                      </button>
                    )}
                  </div>
                  {current.scope === 'project' && current.description && <div className="text-[12px] text-zinc-400">{current.description}</div>}
                  {presence.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1.5 text-[10.5px] px-2 py-0.5 rounded-full border border-border text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: host.color }} />{host.name}
                      </span>
                      {presence.map(({ host: h, presence: p }) => {
                        const other = others.find(o => o.host.key === h.key)!;
                        return (
                          <span key={h.key} className="flex items-center gap-1">
                            <span className={`flex items-center gap-1.5 text-[10.5px] px-2 py-0.5 rounded-full border ${
                              p === 'same' ? 'border-border text-zinc-400'
                                : p === 'differs' ? 'border-orange-400/40 text-orange-300'
                                : 'border-dashed border-border text-zinc-600'
                            }`}>
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.color }} />
                              {h.name} · {p === 'same' ? 'identical' : p === 'differs' ? 'differs' : p === 'missing' ? 'missing' : 'project not on host'}
                            </span>
                            {p === 'differs' && (
                              <button type="button" onClick={() => toggleCompare(other)} className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-violet-300">
                                <GitCompare size={11} />{compare?.host.key === h.key ? 'Hide' : 'Compare'}
                              </button>
                            )}
                            {(p === 'differs' || p === 'missing') && !dirty && baseline && (
                              <button type="button" onClick={() => copyTo(other)} className="flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded text-zinc-400 hover:text-violet-300">
                                <Send size={11} />Copy to {h.name}
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="text-[10.5px] text-zinc-600 font-mono truncate">
                    {current.scope === 'user'
                      ? memory?.user.find(u => u.provider === current.provider)?.path
                      : project && `${project.dir}/${current.name}`}
                  </div>
                </div>
                {error && <div className="mx-[18px] mt-3 text-[12px] text-red-400/90">{error}</div>}
                <div className="flex-1 flex gap-3 mx-[18px] my-3.5 min-h-0">
                  <textarea
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    disabled={fileLoading}
                    spellCheck={false}
                    placeholder={current.scope === 'user' && !current.exists ? 'Write instructions to create this file on this host…' : ''}
                    className="flex-1 min-w-0 bg-base border border-border rounded-lg px-4 py-3.5 text-[12.5px] leading-relaxed text-zinc-300 font-mono outline-none focus:border-violet-500 resize-none"
                  />
                  {compare && (
                    <div className="flex-1 min-w-0 flex flex-col">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5 flex items-center gap-1.5">
                        <ArrowLeftRight size={11} />{compare.host.name} (read-only)
                      </div>
                      <pre className="flex-1 overflow-auto bg-base/60 border border-dashed border-border rounded-lg px-4 py-3.5 text-[12.5px] leading-relaxed text-zinc-400 font-mono whitespace-pre-wrap">{compare.content}</pre>
                    </div>
                  )}
                </div>
                <div className="px-[18px] py-2.5 border-t border-border flex items-center gap-2">
                  <span className="text-[11px] text-zinc-600">
                    {current.scope === 'project'
                      ? (() => { const f = project?.files.find(x => x.name === current.name); return f ? `Edited ${ago(f.mtime)} · ${f.size} bytes` : ''; })()
                      : (() => { const u = memory?.user.find(x => x.provider === current.provider); return u?.exists ? `Edited ${ago(u.mtime)} · ${u.size} bytes` : 'Saving creates the file'; })()}
                  </span>
                  <button
                    type="button"
                    disabled={!dirty}
                    onClick={() => setContent(baseline)}
                    className="ml-auto h-7 px-3 rounded-md border border-border-light text-[12px] font-semibold text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={save}
                    className="h-7 px-3 rounded-md bg-violet-600 hover:bg-violet-700 text-[12px] font-semibold text-white disabled:opacity-40"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {syncOpen && client && (
          <SyncDrawer
            client={client}
            hosts={hosts.filter(h => data[h.key]?.status === 'ok')}
            data={data}
            initialA={hostKey}
            onClose={() => setSyncOpen(false)}
            onDone={async (msg, touched) => {
              setSyncOpen(false);
              await Promise.all(touched.map(loadHost));
              setToast(msg);
            }}
          />
        )}

        {toast && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-lighter border border-border-light text-[12px] text-zinc-200 shadow-xl">
            <Check size={14} className="text-emerald-400" />{toast}
          </div>
        )}
      </div>
    </div>
  );
}

function HostSelect({ hosts, value, onChange }: { hosts: HostRow[]; value: string; onChange: (k: string) => void }) {
  const h = hosts.find(x => x.key === value);
  return (
    <label className="relative flex-1 flex items-center gap-1.5 bg-base border border-border rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-zinc-200">
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: h?.color }} />
      <span className="truncate">{h?.name}</span>
      <ChevronDown size={13} className="ml-auto text-zinc-600" />
      <select value={value} onChange={e => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer">
        {hosts.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
      </select>
    </label>
  );
}

function SyncDrawer({ client, hosts, data, initialA, onClose, onDone }: {
  client: ClaudeClient;
  hosts: HostRow[];
  data: Record<string, HostData>;
  initialA: string;
  onClose: () => void;
  onDone: (message: string, touchedHosts: string[]) => void;
}) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(() => hosts.find(h => h.key !== initialA)?.key ?? '');
  const [mode, setMode] = useState<SyncMode>('both');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [winner, setWinner] = useState<Record<string, Side>>({});
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const memA = data[a]?.status === 'ok' ? (data[a] as { memory: HostMemory }).memory : null;
  const memB = data[b]?.status === 'ok' ? (data[b] as { memory: HostMemory }).memory : null;
  const plan = useMemo(() => (memA && memB && a !== b ? planSync(memA, memB, mode) : { items: [], unpaired: [] }), [memA, memB, a, b, mode]);
  const nameOf = (k: string) => hosts.find(h => h.key === k)?.name ?? k;

  const groups = useMemo(() => {
    const m = new Map<string, typeof plan.items>();
    for (const it of plan.items) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return [...m.entries()];
  }, [plan]);

  const chosen = plan.items.filter(i => !skipped.has(i.id));
  const toggle = (ids: string[], on: boolean) => setSkipped(s => {
    const n = new Set(s);
    for (const id of ids) on ? n.delete(id) : n.add(id);
    return n;
  });

  const run = async () => {
    setRunning({ done: 0, total: chosen.length });
    const failed: string[] = [];
    for (const [i, it] of chosen.entries()) {
      const from = winner[it.id] ?? it.from;
      const to: Side = from === 'a' ? 'b' : 'a';
      const fromHost = from === 'a' ? a : b;
      const toHost = to === 'a' ? a : b;
      try {
        const { content } = await client.readMemory(idOf(fromHost), it.targets[from]);
        await client.writeMemory(idOf(toHost), it.targets[to], content);
      } catch (e: any) {
        failed.push(`${it.file}: ${e?.message || e}`);
      }
      setRunning({ done: i + 1, total: chosen.length });
    }
    setRunning(null);
    if (failed.length) { setFailures(failed); return; }
    onDone(`Synced ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'} between ${nameOf(a)} and ${nameOf(b)}`, [a, b]);
  };

  return (
    <div className="absolute top-[52px] right-0 bottom-0 w-[460px] bg-surface border-l border-border-light shadow-[-20px_0_40px_rgba(0,0,0,0.5)] flex flex-col z-10">
      <div className="p-4 border-b border-border flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-zinc-100">
          <RefreshCw size={15} className="text-violet-300" />Sync memory
          <button type="button" onClick={onClose} className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <HostSelect hosts={hosts} value={a} onChange={k => { setA(k); if (k === b) setB(a); }} />
          <ArrowLeftRight size={15} className="text-zinc-500 shrink-0" />
          <HostSelect hosts={hosts} value={b} onChange={k => { setB(k); if (k === a) setA(b); }} />
        </div>
        <div className="flex gap-1">
          {([['both', '⇄ Both ways'], ['push', `→ Only to ${nameOf(b)}`], ['pull', `← Only from ${nameOf(b)}`]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setWinner({}); }}
              className={`flex-1 text-[11px] px-2 py-1 rounded border truncate ${
                mode === m ? 'border-violet-400/40 text-violet-300 bg-violet-400/10' : 'border-border text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
        {plan.items.length === 0 && (
          <div className="text-[12px] text-zinc-500 px-1 py-2 flex items-center gap-2"><Check size={14} className="text-emerald-400" />Nothing to sync — these hosts match.</div>
        )}
        {groups.map(([group, items]) => {
          const allOn = items.every(i => !skipped.has(i.id));
          return (
            <div key={group} className="border border-border rounded-lg overflow-hidden">
              <label className="flex items-center gap-2 px-2.5 py-2 bg-surface-light text-[12px] font-semibold text-zinc-200 cursor-pointer">
                <input type="checkbox" checked={allOn} onChange={e => toggle(items.map(i => i.id), e.target.checked)} className="accent-violet-500" />
                {group}
                <span className="ml-auto text-[10.5px] font-normal text-zinc-600">{items.length}</span>
              </label>
              {items.map(it => {
                const from = winner[it.id] ?? it.from;
                return (
                  <label key={it.id} className="flex items-center gap-2 pl-7 pr-2.5 py-1.5 border-t border-border text-[11.5px] cursor-pointer">
                    <input type="checkbox" checked={!skipped.has(it.id)} onChange={e => toggle([it.id], e.target.checked)} className="accent-violet-500" />
                    <span className="font-mono text-zinc-300 truncate">{it.file}</span>
                    {it.conflict ? (
                      <span className="ml-auto flex items-center gap-1 shrink-0">
                        <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-red-400/15 text-red-300">differs</span>
                        <select
                          value={from}
                          onChange={e => setWinner(w => ({ ...w, [it.id]: e.target.value as Side }))}
                          className="text-[10px] bg-surface-lighter text-zinc-300 rounded px-1 py-px border-none outline-none"
                        >
                          <option value="a">{nameOf(a)} wins{it.mtime.a && it.mtime.b && it.mtime.a > it.mtime.b ? ' (newer)' : ''}</option>
                          <option value="b">{nameOf(b)} wins{it.mtime.a && it.mtime.b && it.mtime.b > it.mtime.a ? ' (newer)' : ''}</option>
                        </select>
                      </span>
                    ) : (
                      <span className="ml-auto text-[10px] font-semibold px-1.5 py-px rounded bg-emerald-400/15 text-emerald-300 shrink-0">
                        {from === 'a' ? `→ ${nameOf(b)}` : `← ${nameOf(b)}`}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          );
        })}
        {plan.unpaired.length > 0 && (
          <div className="text-[11px] text-zinc-500 leading-relaxed bg-base border border-border rounded-md px-2.5 py-2">
            Not synced — the other host has never opened these projects:{' '}
            {plan.unpaired.map(u => `${u.name} (only on ${nameOf(u.side === 'a' ? a : b)})`).join(', ')}.
          </div>
        )}
        <div className="text-[11px] text-zinc-500 leading-relaxed bg-base border border-border rounded-md px-2.5 py-2">
          Projects are matched by <span className="text-zinc-300">git remote</span>, not by path, so the same repo checked out in different folders pairs up.
          {' '}<span className="font-mono">MEMORY.md</span> is rebuilt on the receiving host. Nothing is ever deleted.
        </div>
        {failures.length > 0 && (
          <div className="text-[11px] text-red-300/90 leading-relaxed">{failures.map(f => <div key={f}>{f}</div>)}</div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-border flex items-center gap-2">
        <span className="text-[11px] text-zinc-500">
          {running ? `Syncing ${running.done}/${running.total}…` : `${chosen.length} ${chosen.length === 1 ? 'change' : 'changes'}`}
        </span>
        <button type="button" onClick={onClose} className="ml-auto h-7 px-3 rounded-md border border-border-light text-[12px] font-semibold text-zinc-300 hover:text-zinc-100">
          Cancel
        </button>
        <button
          type="button"
          disabled={!chosen.length || !!running}
          onClick={run}
          className="flex items-center gap-1.5 h-7 px-3 rounded-md bg-violet-600 hover:bg-violet-700 text-[12px] font-semibold text-white disabled:opacity-40"
        >
          <RefreshCw size={13} className={running ? 'animate-spin' : ''} />Sync
        </button>
      </div>
    </div>
  );
}
