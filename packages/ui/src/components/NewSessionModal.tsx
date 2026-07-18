import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Select, SelectTrigger, SelectValue, SelectPopover,
  ListBox, ListBoxItem,
} from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';
import { resolveServerUrl } from '../lib/claude-client';
import { getNative } from '../lib/native';
import { WorktreeCreateForm } from './WorktreeCreateForm';

interface RemoteInfo {
  id: string;
  name: string;
  alias: string;
  color: string;
  status?: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';
}

const REMOTE_DOT: Record<string, string> = {
  blue: 'bg-blue-400', green: 'bg-green-400', amber: 'bg-amber-400',
  violet: 'bg-violet-400', red: 'bg-red-400', pink: 'bg-pink-400',
};

const TARGET_KEY = 'claude-ui-last-target';

const RECENT_KEY = 'claude-ui-recent-dirs';
const PROVIDER_KEY = 'claude-ui-last-provider';
const MAX_RECENT = 10;
const PROVIDER_OPTIONS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
] as const;
type ProviderKey = typeof PROVIDER_OPTIONS[number]['key'];

function getLastProvider(available: ReadonlyArray<{ key: string }>): ProviderKey {
  const v = localStorage.getItem(PROVIDER_KEY);
  if (available.some(o => o.key === v)) return v as ProviderKey;
  return 'claude';
}

function getRecentDirs(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}
function addRecentDir(dir: string) {
  const recent = getRecentDirs().filter(d => d !== dir);
  recent.unshift(dir);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

interface GitInfo {
  is_git: boolean;
  branch?: string;
  top_level?: string;
  worktrees?: { path: string; branch: string }[];
  package_manager?: string;
  has_env?: boolean;
}

interface Props {
  isOpen: boolean;
  client: ClaudeClient | null;
  opencodeAvailable?: boolean;
  onClose: () => void;
  onCreate: (cwd: string, provider: string, remoteId?: string | null) => void;
}

export function NewSessionModal({ isOpen, client, opencodeAvailable, onClose, onCreate }: Props) {
  // -------------------------------------------------------------------------
  // Target (local vs one of the configured remotes). The header shows discrete
  // tabs; default is whichever target was used last (per machine, localStorage)
  // falling back to 'local'.
  // -------------------------------------------------------------------------
  const [remotesList, setRemotesList] = useState<RemoteInfo[]>([]);
  const [target, setTarget] = useState<string>(() => localStorage.getItem(TARGET_KEY) || 'local');
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // Resolve the server URL once and load remotes whenever the modal opens.
  useEffect(() => {
    let cancelled = false;
    resolveServerUrl().then(u => { if (!cancelled) setServerUrl(u); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isOpen || !serverUrl) return;
    (async () => {
      try {
        const res = await fetch(`${serverUrl}/remotes`);
        if (res.ok) setRemotesList(await res.json());
      } catch {}
    })();
  }, [isOpen, serverUrl]);

  // If the saved target points to a remote that no longer exists, fall back
  // to 'local' on open.
  useEffect(() => {
    if (target === 'local') return;
    if (remotesList.length === 0) return;
    if (!remotesList.some(r => r.id === target)) setTarget('local');
  }, [remotesList, target]);

  const isRemote = target !== 'local';

  // Resolve the base URL for the chosen target. Local → the bun sidecar; a
  // remote → its DIRECT tunnel base (Electron main owns the tunnel), acquired
  // over IPC. bun no longer proxies remote file/git browsing.
  const targetUrl = useCallback(async (path: string): Promise<string> => {
    if (!serverUrl) return path;
    if (target === 'local') return `${serverUrl}${path}`;
    try {
      const native = getNative();
      const res = await native?.invoke<{ port: number }>('remote_tunnel_acquire', { remoteId: target });
      if (res?.port) return `http://127.0.0.1:${res.port}${path}`;
    } catch {}
    return `${serverUrl}${path}`;
  }, [serverUrl, target]);

  const availableProviders = PROVIDER_OPTIONS.filter(o => o.key !== 'opencode' || opencodeAvailable);
  const [cwd, setCwd] = useState('/');
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [tab, setTab] = useState<'browse' | 'recent'>('browse');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);

  const [showWorktree, setShowWorktree] = useState(false);

  const [provider, setProvider] = useState<ProviderKey>(() => getLastProvider(availableProviders));

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      if (!isRemote && client) {
        const dirs = await client.listDirs(path.endsWith('/') ? path : path + '/');
        setFolders(dirs);
      } else {
        const p = path.endsWith('/') ? path : path + '/';
        const res = await fetch(await targetUrl(`/ls?prefix=${encodeURIComponent(p)}`));
        if (res.ok) {
          const data = await res.json();
          setFolders(Array.isArray(data) ? data : (data.dirs || []));
        } else {
          setFolders([]);
        }
      }
    } catch {
      setFolders([]);
    } finally {
      setLoading(false);
    }
  }, [client, isRemote, targetUrl]);

  const checkGit = useCallback(async (path: string) => {
    if (!path) { setGitInfo(null); return; }
    try {
      let info: GitInfo;
      if (!isRemote && client) {
        info = await client.getGitInfo(path);
      } else {
        const res = await fetch(await targetUrl(`/git/info?cwd=${encodeURIComponent(path)}`));
        if (!res.ok) { setGitInfo(null); return; }
        info = await res.json();
      }
      setGitInfo(info);
    } catch { setGitInfo(null); }
  }, [client, isRemote, targetUrl]);

  const fetchUserHome = useCallback(async (): Promise<string> => {
    try {
      if (!isRemote && client) return await client.getUserHome();
      const res = await fetch(await targetUrl('/user-home'));
      if (res.ok) {
        const data = await res.json();
        return data.home || '/';
      }
    } catch {}
    return '/';
  }, [client, isRemote, targetUrl]);

  useEffect(() => {
    if (!isOpen) return;
    setRecentDirs(getRecentDirs());
    setShowWorktree(false);
    let cancelled = false;
    (async () => {
      const home = await fetchUserHome();
      if (cancelled) return;
      setCwd(home);
      loadDir(home);
      checkGit(home);
    })();
    return () => { cancelled = true; };
  }, [isOpen, target, fetchUserHome, loadDir, checkGit]);

  const navigate = (path: string) => {
    setCwd(path);
    loadDir(path);
    checkGit(path);
  };

  const segments = cwd.split('/').filter(Boolean);

  const handleCreate = () => {
    addRecentDir(cwd);
    localStorage.setItem(PROVIDER_KEY, provider);
    localStorage.setItem(TARGET_KEY, target);
    onCreate(cwd, provider, isRemote ? target : null);
    onClose();
  };

  /** Bubble the freshly-created worktree path back into the folder browser
   *  so the user lands on it and "Open here" creates a session there. */
  const handleWorktreeCreated = (path: string) => {
    setCwd(path);
    addRecentDir(path);
    loadDir(path);
    checkGit(path);
  };

  if (!isOpen) return null;

  const hasWorktrees = gitInfo?.is_git && gitInfo.worktrees && gitInfo.worktrees.length > 0;
  const showRightPanel = hasWorktrees || showWorktree;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 960, height: '80vh' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center gap-3 shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100 shrink-0">New Session</h2>
          {/* Target tabs — choose where this session will run */}
          <div className="flex items-center gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => setTarget('local')}
              className={`text-[11px] uppercase tracking-wider px-2 py-1 rounded-md transition-colors ${
                target === 'local'
                  ? 'text-zinc-100 bg-zinc-700'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              Local
            </button>
            {remotesList.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => setTarget(r.id)}
                className={`text-[11px] uppercase tracking-wider px-2 py-1 rounded-md transition-colors flex items-center gap-1.5 ${
                  target === r.id
                    ? 'text-zinc-100 bg-zinc-700'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                }`}
                title={`${r.alias} · ${r.status ?? 'idle'}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${REMOTE_DOT[r.color] || 'bg-zinc-500'}`} />
                {r.name}
              </button>
            ))}
          </div>
          <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close" className="ml-auto">
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: folder browser */}
          <div className={`flex flex-col min-h-0 ${showRightPanel ? 'w-[480px] shrink-0' : 'flex-1'}`}>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 px-4 pt-3 pb-2 flex-wrap min-h-[32px] shrink-0">
              <Button size="sm" variant="ghost" className="text-xs text-zinc-500 hover:text-zinc-200 flex items-center gap-0.5 h-auto px-1.5 py-0.5 min-w-0" onPress={() => navigate('/')}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" /></svg>
                /
              </Button>
              {segments.map((seg, i) => {
                const path = '/' + segments.slice(0, i + 1).join('/');
                const isLast = i === segments.length - 1;
                return (
                  <span key={path} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-700 text-xs">/</span>}
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`text-xs h-auto px-1.5 py-0.5 min-w-0 ${isLast ? 'text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-200'}`}
                      onPress={() => navigate(path)}
                    >{seg}</Button>
                  </span>
                );
              })}
              {gitInfo?.is_git && (
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  <span className="text-xs text-green-400 font-mono">{gitInfo.branch}</span>
                </span>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border px-4 shrink-0">
              {(['browse', 'recent'] as const).map(t => (
                <Button key={t}
                  size="sm"
                  variant="ghost"
                  className={`text-xs px-3 py-1.5 h-auto rounded-none border-b-2 transition-colors ${tab === t ? 'border-blue-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                  onPress={() => setTab(t)}
                >{t === 'recent' ? `Recent (${recentDirs.length})` : 'Browse'}</Button>
              ))}
            </div>

            {/* Folder list */}
            <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0">
              {tab === 'browse' ? (
                loading ? <p className="text-xs text-zinc-600 text-center py-8">Loading...</p>
                : folders.length === 0 ? <p className="text-xs text-zinc-600 text-center py-8">No subdirectories</p>
                : folders.map(dir => {
                    const name = dir.replace(/\/$/, '').split('/').pop() || dir;
                    return (
                      <Button key={dir}
                        variant="ghost"
                        fullWidth
                        className="flex items-center gap-2 justify-start text-left px-3 py-1.5 h-auto rounded-md text-sm text-zinc-300 hover:bg-surface-light/70"
                        onPress={() => navigate(dir.replace(/\/$/, ''))}
                      >
                        <span className="text-zinc-600 text-xs">&#x1F4C1;</span>
                        <span className="truncate">{name}</span>
                      </Button>
                    );
                  })
              ) : (
                recentDirs.length === 0 ? <p className="text-xs text-zinc-600 text-center py-8">No recent projects</p>
                : recentDirs.map(dir => (
                    <Button key={dir}
                      variant="ghost"
                      fullWidth
                      className={`flex items-center gap-2 justify-start text-left px-3 py-1.5 h-auto rounded-md text-sm ${cwd === dir ? 'bg-surface-light text-white' : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'}`}
                      onPress={() => navigate(dir)}
                    >
                      <span className="text-zinc-600 text-xs">&#x1F4C1;</span>
                      <span className="font-mono text-xs truncate">{dir}</span>
                    </Button>
                  ))
              )}
            </div>

          </div>

          {/* Right: worktrees + console */}
          {showRightPanel && (
            <div className="flex-1 flex flex-col border-l border-border min-w-0">
              {/* Worktrees list */}
              {gitInfo?.worktrees && gitInfo.worktrees.length > 0 && (
                <div className="shrink-0 border-b border-border">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
                    <span className="text-xs text-zinc-400 font-medium">Worktrees</span>
                    <span className="text-[10px] text-zinc-600">{gitInfo.worktrees.length}</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto py-1">
                    {gitInfo.worktrees.map(wt => (
                      <Button key={wt.path}
                        variant="ghost"
                        fullWidth
                        className={`flex items-center gap-2 justify-start text-left text-xs px-3 py-1.5 h-auto rounded-none transition-colors ${
                          cwd === wt.path ? 'bg-surface-light text-zinc-100' : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'
                        }`}
                        onPress={() => navigate(wt.path)}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                        <span className="text-green-400 font-mono shrink-0">{wt.branch}</span>
                        <span className="text-zinc-600 font-mono truncate">{wt.path}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* "+ New worktree" affordance — toggles the shared form in. */}
              {gitInfo?.is_git && !showWorktree && (
                <div className="px-3 py-2 border-b border-border shrink-0">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => setShowWorktree(true)}
                  >+ New worktree</Button>
                </div>
              )}

              {/* Worktree creation form — shared component, also used by
               *  the standalone WorktreeCreateModal opened from a tab
               *  group's "New session in worktree" dropdown item. */}
              {gitInfo?.is_git && showWorktree && client && (
                <div className="px-4 py-4 border-b border-border shrink-0 overflow-y-auto">
                  <WorktreeCreateForm
                    client={client}
                    repoPath={gitInfo.top_level!}
                    hasEnv={gitInfo.has_env}
                    detectedPackageManager={gitInfo.package_manager}
                    existingWorktrees={gitInfo.worktrees}
                    hideExistingPicker
                    onCreated={handleWorktreeCreated}
                  />
                </div>
              )}

              <div className="flex-1" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0">
          <span className="text-xs text-zinc-600 font-mono truncate max-w-[360px]" title={cwd}>{cwd}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Provider</span>
            <Select aria-label="Provider" selectedKey={provider}
              onSelectionChange={(key) => setProvider(key as ProviderKey)}>
              <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
              <SelectPopover>
                <ListBox>
                  {availableProviders.map(opt => (
                    <ListBoxItem key={opt.key} id={opt.key} textValue={opt.label}>
                      <span className="text-sm">{opt.label}</span>
                    </ListBoxItem>
                  ))}
                </ListBox>
              </SelectPopover>
            </Select>
            <Button variant="secondary" onPress={onClose}>Cancel</Button>
            <Button onPress={handleCreate}>Open here</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
