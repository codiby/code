import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Select, SelectTrigger, SelectValue, SelectPopover, SelectIndicator,
  ListBox, ListBoxItem,
} from '@heroui/react';
import {
  ChevronDown, FolderClosed, FolderSearch, Bot, GitBranch, GitFork,
} from 'lucide-react';
import type { ClaudeClient } from '../lib/claude-client';
import { ChatComposer, type PastedImage } from './ChatComposer';
import { WorktreeCreateForm } from './WorktreeCreateForm';
import { WORKTREE_CWD_LOOSE_RE } from '../lib/group-tree';

const PROVIDER_KEY = 'claude-ui-last-provider';
const RECENT_DIRS_KEY = 'claude-ui-recent-dirs';

const PROVIDER_OPTIONS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
] as const;
type ProviderKey = typeof PROVIDER_OPTIONS[number]['key'];

interface GitInfo {
  is_git: boolean;
  branch?: string;
  top_level?: string;
  worktrees?: { path: string; branch: string }[];
  package_manager?: string;
  has_env?: boolean;
}

interface OpencodeInfoLike {
  available?: boolean;
  models?: { id: string; providerName: string; label: string }[];
}

interface Props {
  groupName: string;
  groupCwd: string;
  client: ClaudeClient | null;
  opencodeInfo?: OpencodeInfoLike | null;
  claudeModels?: { id: string; label: string }[];
  /** When the group sits on a remote (all members share the same remoteId),
   *  this is set so spawned sessions land on that remote and the composer
   *  badges itself as remote. Null for local / mixed groups. */
  remoteId?: string | null;
  remoteName?: string | null;
  remoteColor?: string | null;
  onSpawn: (
    cwd: string,
    provider: string,
    prompt: string,
    model?: string,
    permissionMode?: string,
    /** When `cwd` points at a freshly-created worktree, this is the parent
     *  repo's top-level — used by the host to autogroup the new session
     *  under the main repo's folder rather than the worktree branch. */
    worktreeOrigin?: string,
    /** Inherited from the group when it's a remote group. */
    remoteId?: string | null,
    /** Pasted/dropped screenshots to ship with the first message. */
    images?: { media_type: string; data: string }[],
    /** Reasoning effort — forwarded for providers that support it. */
    effort?: string,
  ) => void;
  /** Opens the full folder-picker modal (parent-owned). Invoked from the
   *  "Browse for folder…" item at the bottom of the project dropdown. */
  onBrowseFolder?: () => void;
  /** Keeps the app-wide git status indicator aligned with this composer's
   * branch selection before a session exists for the selected group. */
  onBranchChanged?: (branch: string | null) => void;
}

/**
 * Centered new-session composer rendered in the main chat pane when a tab
 * group is focused but no session in it is active. The actual input bar is
 * the real ChatComposer (same chrome, same controls) so it looks identical
 * to an in-session chat composer. Provider lives in the header above; the
 * worktree affordance sits in a footer row below.
 */
export function GroupComposer({ groupName, groupCwd, client, opencodeInfo, claudeModels = [], remoteId, remoteName, remoteColor, onSpawn, onBrowseFolder, onBranchChanged }: Props) {
  const [prompt, setPrompt] = useState('');
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [cwd, setCwd] = useState(groupCwd);
  const [provider, setProvider] = useState<ProviderKey>(() => {
    const stored = localStorage.getItem(PROVIDER_KEY);
    if (stored && PROVIDER_OPTIONS.some(p => p.key === stored)) return stored as ProviderKey;
    return 'claude';
  });
  const [model, setModel] = useState<string>('');
  const [permissionMode, setPermissionMode] = useState<string>('default');
  const [effort, setEffort] = useState<string>('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [showWorktreeForm, setShowWorktreeForm] = useState(false);
  // Parent repo when the user creates a worktree in this composer. Threaded
  // to the host on submit so the spawned session can autogroup under the
  // main repo's folder name, matching the modal-driven flow. Cleared when
  // the user picks a different folder via the dropdown.
  const [worktreeOrigin, setWorktreeOrigin] = useState<string | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<{ local: string[]; remote: string[]; current: string } | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const [checkingOut, setCheckingOut] = useState(false);
  const folderBtnRef = useRef<HTMLButtonElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);

  // Reset to the group's cwd when the user switches groups under us.
  useEffect(() => {
    setCwd(groupCwd);
    setShowWorktreeForm(false);
    setPrompt('');
    setPastedImages([]);
    setWorktreeOrigin(null);
  }, [groupCwd]);

  // Reload recent dirs from localStorage each time the dropdown opens — the
  // list may have grown since mount via other modals adding to it. Also wire
  // click-outside / Escape to dismiss. For remote groups, skip the local
  // recents entirely — those paths live on the user's local machine, but the
  // session would be spawned on the remote where they don't exist (provider
  // would crash mid-turn → red dot).
  useEffect(() => {
    if (!folderMenuOpen) return;
    if (remoteId) {
      setRecentDirs([]);
    } else {
      try {
        const raw = localStorage.getItem(RECENT_DIRS_KEY);
        const dirs = raw ? JSON.parse(raw) : [];
        setRecentDirs(Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string') : []);
      } catch { setRecentDirs([]); }
    }
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (folderMenuRef.current?.contains(target)) return;
      if (folderBtnRef.current?.contains(target)) return;
      setFolderMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFolderMenuOpen(false); };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [folderMenuOpen]);

  // Build the dropdown list: current cwd first (so it's always reachable as a
  // visual anchor), then de-duped recent dirs.
  const folderOptions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (d: string) => { if (d && !seen.has(d)) { seen.add(d); out.push(d); } };
    if (cwd) push(cwd);
    recentDirs.forEach(push);
    return out;
  }, [cwd, recentDirs]);

  // Refresh git info whenever cwd changes (group switch OR worktree picked).
  useEffect(() => {
    if (!client || !cwd) { setGitInfo(null); return; }
    let cancelled = false;
    client.getGitInfo(cwd).then(info => { if (!cancelled) setGitInfo(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, [client, cwd]);

  // Branch dropdown: fetch branches on open, wire click-outside / Escape.
  useEffect(() => {
    if (!branchMenuOpen) return;
    setBranchFilter('');
    if (client && cwd) {
      client.listBranches(cwd).then(data => {
        setBranches({ local: data.local || [], remote: data.remote || [], current: data.current || '' });
        setTimeout(() => branchInputRef.current?.focus(), 50);
      }).catch(() => {});
    }
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (branchMenuRef.current?.contains(target)) return;
      if (branchBtnRef.current?.contains(target)) return;
      setBranchMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBranchMenuOpen(false); };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [branchMenuOpen, client, cwd]);

  // When the user picks a branch that's already checked out in some worktree,
  // `git checkout` would fail with `fatal: '<branch>' is already used by
  // worktree at '<path>'`. Instead of surfacing the error, switch the
  // composer's cwd to that worktree's path so the session spawns there.
  const switchToWorktree = (wtPath: string) => {
    const main = (gitInfo?.worktrees || []).find(w => !WORKTREE_CWD_LOOSE_RE.test(w.path));
    const isMain = !WORKTREE_CWD_LOOSE_RE.test(wtPath);
    setCwd(wtPath);
    setWorktreeOrigin(isMain ? null : (main?.path ?? null));
  };

  const doCheckout = async (branch: string) => {
    if (!client || !cwd) return;
    // Preflight: if we already know the branch is in a worktree (different
    // from cwd), skip the API call and just switch. Saves a round-trip and
    // avoids the server even attempting an `already used` checkout.
    const existing = (gitInfo?.worktrees || []).find(w => w.branch === branch && w.path && w.path !== cwd);
    if (existing) {
      switchToWorktree(existing.path);
      onBranchChanged?.(branch);
      setBranchMenuOpen(false);
      return;
    }
    setCheckingOut(true);
    try {
      const result = await client.checkoutBranch(cwd, branch);
      if (result.ok) {
        const info = await client.getGitInfo(cwd);
        setGitInfo(info);
        onBranchChanged?.(info.is_git ? info.branch || null : null);
      } else if (result.alreadyInWorktree?.path) {
        // Stale gitInfo: the server saw the branch in a worktree we didn't
        // know about. Switch instead of failing.
        switchToWorktree(result.alreadyInWorktree.path);
        onBranchChanged?.(branch);
      }
    } finally {
      setCheckingOut(false);
      setBranchMenuOpen(false);
    }
  };

  const opencodeAvailable = opencodeInfo?.available ?? false;
  const availableProviders = PROVIDER_OPTIONS.filter(o => o.key !== 'opencode' || opencodeAvailable);
  const folderName = cwd.split('/').filter(Boolean).pop() || groupName || cwd;
  const branchLabel = gitInfo?.is_git ? gitInfo.branch : null;

  const submit = () => {
    if (!prompt.trim() && pastedImages.length === 0) return;
    const images = pastedImages.length > 0
      ? pastedImages.map(({ media_type, data }) => ({ media_type, data }))
      : undefined;
    onSpawn(
      cwd,
      provider,
      prompt.trim(),
      model || undefined,
      permissionMode && permissionMode !== 'default' ? permissionMode : undefined,
      worktreeOrigin || undefined,
      remoteId ?? null,
      images,
      (provider === 'claude' || provider === 'opencode') && effort ? effort : undefined,
    );
    setPastedImages([]);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 overflow-y-auto">
      <div className="w-full max-w-[720px] space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[22px] text-zinc-400 font-light px-3">
          <span>New session in</span>
          {remoteId && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider rounded-md px-2 py-0.5 border"
              style={{
                color: remoteColor || '#a78bfa',
                background: `${remoteColor || '#a78bfa'}14`,
                borderColor: `${remoteColor || '#a78bfa'}40`,
              }}
              title={`This group lives on remote "${remoteName || remoteId}"`}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: remoteColor || '#a78bfa' }} />
              {remoteName || 'remote'}
            </span>
          )}
          <div className="relative inline-flex">
            <button
              ref={folderBtnRef}
              type="button"
              onClick={() => setFolderMenuOpen(o => !o)}
              className="inline-flex items-center gap-1.5 text-zinc-100 px-1.5 py-0 rounded-md hover:bg-white/5 transition-colors"
              aria-haspopup="listbox"
              aria-expanded={folderMenuOpen}
              title={cwd}
            >
              <FolderClosed size={18} className="text-zinc-500" />
              <span className="font-semibold">{folderName}</span>
              <ChevronDown size={16} className="text-zinc-600" />
            </button>
            {folderMenuOpen && (
              <div
                ref={folderMenuRef}
                className="absolute z-50 top-full left-0 mt-1 w-[380px] max-h-[340px] overflow-y-auto bg-surface border border-border-light rounded-lg shadow-2xl py-1"
                role="listbox"
              >
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                  Recent projects
                </div>
                {folderOptions.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-zinc-600">No recent projects</div>
                ) : folderOptions.map(dir => {
                  const name = dir.split('/').filter(Boolean).pop() || dir;
                  const parent = dir.replace(/\/[^/]+\/?$/, '') || (dir.startsWith('/') ? '/' : '');
                  const isCurrent = dir === cwd;
                  return (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => { setCwd(dir); setWorktreeOrigin(null); setFolderMenuOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                        isCurrent ? 'bg-surface-light/60 text-zinc-100' : 'text-zinc-300 hover:bg-surface-light/50 hover:text-zinc-100'
                      }`}
                      role="option"
                      aria-selected={isCurrent}
                    >
                      <FolderClosed size={14} className="text-zinc-500 shrink-0" />
                      <span className="text-sm font-medium truncate">{name}</span>
                      <span className="ml-auto text-[11px] text-zinc-600 font-mono truncate max-w-[180px]">{parent}</span>
                    </button>
                  );
                })}
                {onBrowseFolder && (
                  <>
                    <div className="h-px bg-border my-1" />
                    <button
                      type="button"
                      onClick={() => { setFolderMenuOpen(false); onBrowseFolder(); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-surface-light/50 hover:text-zinc-100"
                    >
                      <FolderSearch size={14} className="text-zinc-500 shrink-0" />
                      <span>Browse for folder…</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <span>with</span>
          <Select
            aria-label="Provider"
            selectedKey={provider}
            onSelectionChange={(key) => {
              setProvider(key as ProviderKey);
              localStorage.setItem(PROVIDER_KEY, String(key));
            }}
          >
            <SelectTrigger className="min-h-0 h-auto py-0 px-1.5 bg-transparent border-0 shadow-none hover:bg-white/5 data-[hovered]:bg-white/5 rounded-md text-[22px] text-zinc-100">
              <Bot size={18} className="text-zinc-500 mr-1.5 shrink-0" />
              <SelectValue className="font-semibold text-zinc-100" />
              <SelectIndicator className="size-4 text-zinc-600 ml-1 shrink-0" />
            </SelectTrigger>
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
        </div>

        <ChatComposer
          sessionId="new-in-group"
          autoFocus
          input={prompt}
          onChangeInput={(val) => setPrompt(prev => (typeof val === 'function' ? val(prev) : val))}
          pastedImages={pastedImages}
          onChangePastedImages={(val) => setPastedImages(prev => (typeof val === 'function' ? val(prev) : val))}
          active={{ isStreaming: false, permRequest: null, inputHistory: [], supportedModels: undefined }}
          activeSession={{ model: model || null, permission_mode: permissionMode, effort: effort || null, provider }}
          connectionStatus="connected"
          opencodeInfo={opencodeInfo ?? null}
          claudeModels={claudeModels}
          slashCommands={[]}
          client={client}
          cwd={cwd}
          onSend={submit}
          onInterrupt={() => {}}
          onSelectModel={setModel}
          onSelectPermissionMode={setPermissionMode}
          onSelectEffort={setEffort}
        />

        <div className="flex items-center justify-end text-xs text-zinc-500 px-3 -mt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowWorktreeForm(s => !s)}
              disabled={!gitInfo?.is_git}
              className={`inline-flex items-center gap-1.5 transition-colors px-2 py-1 rounded ${
                showWorktreeForm ? 'text-zinc-200 bg-surface-light/60' : 'hover:text-zinc-300'
              } ${!gitInfo?.is_git ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <GitFork size={12} />
              <span>Worktree</span>
              <ChevronDown size={12} />
            </button>
            {branchLabel && (
              <div className="relative inline-flex">
                <button
                  ref={branchBtnRef}
                  type="button"
                  onClick={() => setBranchMenuOpen(o => !o)}
                  disabled={checkingOut}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                    branchMenuOpen ? 'text-zinc-200 bg-surface-light/60' : 'text-zinc-400 hover:text-zinc-300 hover:bg-white/5'
                  } ${checkingOut ? 'opacity-60 cursor-wait' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={branchMenuOpen}
                  title={branchLabel}
                >
                  <GitBranch size={12} />
                  <span className="font-mono">{branchLabel}</span>
                  <ChevronDown size={12} />
                </button>
                {branchMenuOpen && (() => {
                  const q = branchFilter.toLowerCase();
                  const filteredLocal = (branches?.local || []).filter(b => !q || b.toLowerCase().includes(q));
                  const filteredRemote = (branches?.remote || []).filter(b => !q || b.toLowerCase().includes(q));
                  const allFiltered = [...filteredLocal, ...filteredRemote];
                  const current = branches?.current || branchLabel;
                  const renderBranch = (branch: string) => (
                    <button
                      key={branch}
                      type="button"
                      onClick={() => doCheckout(branch)}
                      className={`w-full text-left px-3 py-1 text-[11px] transition-colors truncate ${
                        branch === current
                          ? 'text-green-400 bg-green-400/5'
                          : 'text-zinc-400 hover:bg-surface-light hover:text-zinc-200'
                      }`}
                    >
                      {branch === current && <span className="mr-1">&#x2713;</span>}
                      <span className="font-mono">{branch}</span>
                    </button>
                  );
                  return (
                    <div
                      ref={branchMenuRef}
                      className="absolute z-50 bottom-full right-0 mb-1 w-72 bg-surface border border-border-light rounded-lg shadow-2xl overflow-hidden"
                      role="listbox"
                    >
                      <div className="px-2 py-2 border-b border-border">
                        <input
                          ref={branchInputRef}
                          value={branchFilter}
                          onChange={e => setBranchFilter(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Escape') setBranchMenuOpen(false);
                            if (e.key === 'Enter' && allFiltered.length === 1) doCheckout(allFiltered[0]!);
                          }}
                          placeholder="Search branches..."
                          className="w-full bg-surface-light border border-border rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="max-h-60 overflow-y-auto py-1">
                        {!branches && (
                          <p className="text-[11px] text-zinc-600 text-center py-3">Loading…</p>
                        )}
                        {branches && allFiltered.length === 0 && (
                          <p className="text-[11px] text-zinc-600 text-center py-3">No branches found</p>
                        )}
                        {filteredLocal.length > 0 && (
                          <>
                            <div className="px-3 py-0.5 text-[9px] text-zinc-600 uppercase tracking-wider">Local</div>
                            {filteredLocal.map(renderBranch)}
                          </>
                        )}
                        {filteredRemote.length > 0 && (
                          <>
                            <div className="px-3 py-0.5 mt-1 text-[9px] text-zinc-600 uppercase tracking-wider">Remote</div>
                            {filteredRemote.map(renderBranch)}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {showWorktreeForm && gitInfo?.is_git && client && (
          <div className="border border-border rounded-xl bg-surface/40 px-4 py-4">
            <WorktreeCreateForm
              client={client}
              repoPath={gitInfo.top_level!}
              hasEnv={gitInfo.has_env}
              detectedPackageManager={gitInfo.package_manager}
              existingWorktrees={gitInfo.worktrees}
              onCreated={(path) => {
                setCwd(path);
                setWorktreeOrigin(gitInfo.top_level!);
                setShowWorktreeForm(false);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
