import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Folder, Home, Clock, GitBranch, Plus } from 'lucide-react';
import { ListBox, ListBoxItem, Select, SelectPopover, SelectTrigger, SelectValue } from '@heroui/react';
import type { ClaudeClient } from '../../lib/claude-client';
import { MobileWorktreeModal } from './MobileWorktreeModal';

// Shared with the desktop NewSessionModal so "recent projects" stay in sync
// across the two entry points.
const RECENT_KEY = 'claude-ui-recent-dirs';
const PROVIDER_KEY = 'claude-ui-last-provider';
const MAX_RECENT = 10;

const PROVIDER_OPTIONS = [
  { key: 'claudeAgent', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
] as const;
type ProviderKey = typeof PROVIDER_OPTIONS[number]['key'];

function getLastProvider(available: ReadonlyArray<{ key: string }>): ProviderKey {
  const v = localStorage.getItem(PROVIDER_KEY);
  if (available.some(o => o.key === v)) return v as ProviderKey;
  return 'claudeAgent';
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
  open: boolean;
  onClose: () => void;
  client: ClaudeClient;
  /** Whether the opencode binary is available on this host (cached at app
   *  boot). When false, the OpenCode provider chip is hidden entirely so
   *  users can't pick a backend that's guaranteed to fail to spawn. */
  opencodeAvailable?: boolean;
  opencodeModels?: Array<{ id: string; label: string; providerName: string }>;
  /** Called once the session is successfully created. The modal has already
   *  closed itself by the time this fires; callers typically switch to the
   *  new session id here. */
  onCreated: (sessionId: string, cwd: string) => void;
}

const CLAUDE_MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

/**
 * Mobile-first "New Session" modal. Fullscreen sheet with breadcrumb
 * navigation, folder browser, and a Recent tab — the same ideas as the
 * desktop NewSessionModal but simplified for one-hand use.
 *
 * Not included (to keep the mobile flow fast): worktree creation and the
 * associated console output. Power users can still reach those from the
 * desktop.
 */
export function MobileNewSessionModal({ open, onClose, client, opencodeAvailable, opencodeModels = [], onCreated }: Props) {
  const availableProviders = PROVIDER_OPTIONS.filter(o => o.key !== 'opencode' || opencodeAvailable);
  const [cwd, setCwd] = useState('/');
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [tab, setTab] = useState<'browse' | 'recent'>('browse');
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderKey>(() => getLastProvider(availableProviders));
  const [model, setModel] = useState('');

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const dirs = await client.listDirs(path.endsWith('/') ? path : path + '/');
      setFolders(dirs);
    } catch { setFolders([]); }
    setLoading(false);
  }, [client]);

  const checkGit = useCallback(async (path: string) => {
    if (!path) { setGitInfo(null); return; }
    try {
      const info = await client.getGitInfo(path);
      setGitInfo(info as GitInfo);
    } catch { setGitInfo(null); }
  }, [client]);

  // On open — always land at the user's home directory so the file browser
  // starts somewhere useful instead of `/`. Recent projects remain reachable
  // via the Recent tab.
  useEffect(() => {
    if (!open) return;
    setRecentDirs(getRecentDirs());
    setError(null);
    setName('');
    setModel('');
    setProvider(getLastProvider(availableProviders));
    setTab('browse');
    let cancelled = false;
    (async () => {
      const home = await client.getUserHome();
      if (cancelled) return;
      setCwd(home);
      loadDir(home);
      checkGit(home);
    })();
    return () => { cancelled = true; };
  }, [open, loadDir, checkGit, client]);

  useEffect(() => {
    setModel('');
  }, [provider]);

  const navigate = (path: string) => {
    const clean = path.replace(/\/$/, '') || '/';
    setCwd(clean);
    loadDir(clean);
    checkGit(clean);
  };

  const segments = useMemo(() => cwd.split('/').filter(Boolean), [cwd]);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await client.createSession(cwd || '/', { name: name.trim() || undefined, provider, model: model || null });
      addRecentDir(cwd);
      localStorage.setItem(PROVIDER_KEY, provider);
      onCreated(session.id, cwd || '/');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const goUp = () => {
    if (cwd === '/' || !cwd) return;
    const parent = cwd.substring(0, cwd.lastIndexOf('/')) || '/';
    navigate(parent);
  };

  if (!open) return null;

  const modelOptions = provider === 'opencode'
    ? opencodeModels.map((m) => ({ id: m.id, label: `${m.providerName} ${m.label}` }))
    : CLAUDE_MODEL_OPTIONS;

  return (
    <div
      className="fixed inset-0 z-50 bg-zinc-950 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Header — Cancel / Title / Create. Title is a path breadcrumb too
          so the user always sees where they are. */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <button
          onClick={onClose}
          disabled={creating}
          className="text-[13px] text-zinc-400 active:text-zinc-200 disabled:opacity-50"
        >
          Cancel
        </button>
        <span className="text-[13px] font-semibold text-zinc-100">New Session</span>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="text-[13px] font-semibold text-indigo-300 active:text-indigo-200 disabled:opacity-50"
        >
          {creating ? '…' : 'Create'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border px-2 shrink-0">
        {(['browse', 'recent'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[12px] border-b-2 transition-colors ${
              tab === t
                ? 'border-indigo-500 text-zinc-100'
                : 'border-transparent text-zinc-500 active:text-zinc-300'
            }`}
          >
            {t === 'browse' ? <Folder size={13} /> : <Clock size={13} />}
            {t === 'browse' ? 'Browse' : `Recent (${recentDirs.length})`}
          </button>
        ))}
        {gitInfo?.is_git && gitInfo.branch && (
          <span className="ml-auto flex items-center gap-1.5 px-2 text-[11px] text-green-400 font-mono truncate max-w-[140px]" title={gitInfo.branch}>
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            <span className="truncate">{gitInfo.branch}</span>
          </span>
        )}
        {gitInfo?.is_git && gitInfo.top_level && (
          <button
            onClick={() => setWorktreeOpen(true)}
            className="ml-1 shrink-0 flex items-center gap-1 text-[11px] text-indigo-300 active:text-indigo-200 px-2 py-1.5 rounded active:bg-white/5"
            aria-label="New worktree"
          >
            <Plus size={12} />
            <GitBranch size={12} />
          </button>
        )}
      </div>

      {/* Breadcrumb — only in Browse mode, one-finger scrollable horizontally
          so deep paths don't break the layout. */}
      {tab === 'browse' && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0 overflow-x-auto">
          <button
            onClick={goUp}
            disabled={cwd === '/' || !cwd}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded text-zinc-400 active:text-zinc-200 active:bg-white/10 disabled:opacity-30"
            aria-label="Parent directory"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => navigate('/')}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded text-zinc-400 active:text-zinc-200 active:bg-white/10"
            aria-label="Root"
          >
            <Home size={14} />
          </button>
          {segments.map((seg, i) => {
            const path = '/' + segments.slice(0, i + 1).join('/');
            const isLast = i === segments.length - 1;
            return (
              <span key={path} className="flex items-center gap-1 shrink-0">
                <span className="text-zinc-700 text-[11px]">/</span>
                <button
                  className={`text-[12px] px-1 ${
                    isLast ? 'text-zinc-100 font-medium' : 'text-zinc-500 active:text-zinc-200'
                  }`}
                  onClick={() => navigate(path)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Existing worktrees for the current repo — shown as chips above the
          folder list in Browse mode. Tap a chip to jump to that worktree's
          path (sets cwd so Create uses it). */}
      {tab === 'browse' && gitInfo?.is_git && gitInfo.worktrees && gitInfo.worktrees.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-border">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1.5">
            Worktrees
          </div>
          <div className="flex gap-1.5 overflow-x-auto -mx-2 px-2 pb-0.5">
            {gitInfo.worktrees.map((wt) => {
              const isActive = cwd === wt.path;
              return (
                <button
                  key={wt.path}
                  onClick={() => navigate(wt.path)}
                  className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-mono border transition-colors ${
                    isActive
                      ? 'bg-green-500/15 border-green-500/40 text-green-100'
                      : 'bg-white/5 border-white/10 text-zinc-300 active:bg-white/10'
                  }`}
                >
                  <GitBranch size={11} className="shrink-0" />
                  <span className="truncate max-w-[160px]">{wt.branch}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Folder list */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'browse' ? (
          loading ? (
            <div className="text-center py-8 text-zinc-600 text-[13px]">Loading…</div>
          ) : folders.length === 0 ? (
            <div className="text-center py-8 text-zinc-600 text-[13px]">No subdirectories</div>
          ) : (
            <ul className="py-1">
              {folders.map((dir) => {
                const clean = dir.replace(/\/$/, '');
                const dirName = clean.split('/').pop() || clean;
                return (
                  <li key={dir}>
                    <button
                      onClick={() => navigate(clean)}
                      className="w-full flex items-center gap-3 px-4 min-h-11 text-[14px] text-zinc-200 active:bg-white/5 active:text-white text-left"
                    >
                      <Folder size={16} className="shrink-0 text-zinc-500" />
                      <span className="truncate">{dirName}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : recentDirs.length === 0 ? (
          <div className="text-center py-8 text-zinc-600 text-[13px]">No recent projects</div>
        ) : (
          <ul className="py-1">
            {recentDirs.map((dir) => {
              const dirName = dir.replace(/\/$/, '').split('/').pop() || dir;
              return (
                <li key={dir}>
                  <button
                    onClick={() => { setTab('browse'); navigate(dir); }}
                    className="w-full flex flex-col items-start gap-0.5 px-4 py-2 min-h-11 text-[14px] text-zinc-200 active:bg-white/5 active:text-white text-left"
                  >
                    <span className="flex items-center gap-2 min-w-0 w-full">
                      <Folder size={14} className="shrink-0 text-zinc-500" />
                      <span className="truncate font-medium">{dirName}</span>
                    </span>
                    <span className="pl-6 text-[11px] text-zinc-600 font-mono truncate max-w-full">
                      {dir}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Bottom area — current path + optional name input + errors. Sticky
          above the keyboard so the Create target stays discoverable. */}
      <div
        className="border-t border-border bg-zinc-950 px-4 pt-3 space-y-2 shrink-0"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">cwd</span>
          <span className="text-[12px] font-mono text-zinc-400 truncate" title={cwd}>{cwd}</span>
        </div>
        <div className="flex items-center gap-1.5 -mx-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold px-1">Provider</span>
          {availableProviders.map(opt => (
            <button
              key={opt.key}
              onClick={() => setProvider(opt.key)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                provider === opt.key
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'bg-white/5 text-zinc-400 border border-white/10 active:bg-white/10'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold shrink-0">Model</span>
          <Select
            aria-label="Model"
            selectedKey={model || 'default'}
            onSelectionChange={(key) => setModel(key === 'default' ? '' : String(key))}
            className="flex-1 min-w-0"
          >
            <SelectTrigger className="min-h-0 h-10 py-0 px-2.5 rounded-lg bg-white/5 border border-white/10 text-[13px] text-zinc-200 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectPopover>
              <ListBox>
                <ListBoxItem key="default" id="default" textValue="Default">
                  <span className="text-xs">Default</span>
                </ListBoxItem>
                {modelOptions.map((m) => (
                  <ListBoxItem key={m.id} id={m.id} textValue={m.label}>
                    <span className="text-xs">{m.label}</span>
                  </ListBoxItem>
                ))}
              </ListBox>
            </SelectPopover>
          </Select>
        </label>
        <input
          type="text"
          placeholder="Session name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-[14px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
        />
        {error && (
          <div className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>

      {gitInfo?.is_git && gitInfo.top_level && (
        <MobileWorktreeModal
          open={worktreeOpen}
          onClose={() => setWorktreeOpen(false)}
          client={client}
          repoPath={gitInfo.top_level}
          hasEnv={gitInfo.has_env}
          detectedPackageManager={gitInfo.package_manager}
          onCreated={(path) => { navigate(path); }}
        />
      )}
    </div>
  );
}
