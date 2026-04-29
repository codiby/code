import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Button,
  TextField, Input,
  Checkbox, CheckboxControl, CheckboxIndicator, CheckboxContent,
  Select, SelectTrigger, SelectValue, SelectPopover,
  ListBox, ListBoxItem,
} from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';

const RECENT_KEY = 'claude-ui-recent-dirs';
const MAX_RECENT = 10;
const PM_OPTIONS = ['bun', 'npm', 'yarn', 'pnpm'] as const;
type PackageManager = typeof PM_OPTIONS[number];

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
  onClose: () => void;
  onCreate: (cwd: string) => void;
}

export function NewSessionModal({ isOpen, client, onClose, onCreate }: Props) {
  const [cwd, setCwd] = useState('/');
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [tab, setTab] = useState<'browse' | 'recent'>('browse');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);

  const [showWorktree, setShowWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [creatingWt, setCreatingWt] = useState(false);
  const [copyEnv, setCopyEnv] = useState(true);
  const [depsMode, setDepsMode] = useState<'install' | 'copy' | 'link' | 'none'>('link');
  const [packageManager, setPackageManager] = useState<PackageManager>('npm');

  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [consoleStatus, setConsoleStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const consoleRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (path: string) => {
    if (!client) return;
    setLoading(true);
    const dirs = await client.listDirs(path.endsWith('/') ? path : path + '/');
    setFolders(dirs);
    setLoading(false);
  }, [client]);

  const checkGit = useCallback(async (path: string) => {
    if (!client || !path) { setGitInfo(null); return; }
    try {
      const info = await client.getGitInfo(path);
      setGitInfo(info);
      if (info.package_manager && PM_OPTIONS.includes(info.package_manager as PackageManager)) {
        setPackageManager(info.package_manager as PackageManager);
      }
      if (info.has_env !== undefined) setCopyEnv(info.has_env);
    } catch { setGitInfo(null); }
  }, [client]);

  useEffect(() => {
    if (isOpen) {
      setRecentDirs(getRecentDirs());
      setShowWorktree(false);
      setWorktreeBranch('');
      setCopyEnv(true);
      setDepsMode('link');
      setConsoleLogs([]);
      setConsoleStatus('idle');
      const start = getRecentDirs()[0] || '/';
      setCwd(start);
      loadDir(start);
      checkGit(start);
    }
  }, [isOpen, loadDir, checkGit]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [consoleLogs]);

  const navigate = (path: string) => {
    setCwd(path);
    loadDir(path);
    checkGit(path);
  };

  const segments = cwd.split('/').filter(Boolean);

  const handleCreate = () => {
    addRecentDir(cwd);
    onCreate(cwd);
    onClose();
  };

  const handleCreateWorktree = () => {
    if (!client || !gitInfo?.top_level || !worktreeBranch.trim()) return;
    setCreatingWt(true);
    setConsoleLogs([]);
    setConsoleStatus('running');

    client.createWorktree(
      gitInfo.top_level,
      worktreeBranch.trim(),
      { copy_env: copyEnv, install_deps: depsMode === 'install', copy_node_modules: depsMode === 'copy', link_node_modules: depsMode === 'link', package_manager: packageManager },
      {
        onLog: (line) => setConsoleLogs(prev => [...prev, line]),
        onDone: (result) => {
          setConsoleLogs(prev => [...prev, '', `Done. Worktree ready at ${result.path}`]);
          setConsoleStatus('done');
          setCreatingWt(false);
          setCwd(result.path);
          addRecentDir(result.path);
          loadDir(result.path);
          checkGit(result.path);
        },
        onError: (err) => {
          setConsoleLogs(prev => [...prev, `ERROR: ${err}`]);
          setConsoleStatus('error');
          setCreatingWt(false);
        },
      },
    );
  };

  if (!isOpen) return null;

  const showConsole = showWorktree && consoleStatus !== 'idle';
  const hasWorktrees = gitInfo?.is_git && gitInfo.worktrees && gitInfo.worktrees.length > 0;
  const showRightPanel = hasWorktrees || showConsole;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={(e) => { if (e.target === e.currentTarget && !creatingWt) onClose(); }}>
      <div
        className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 960, height: '80vh' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">New Session</h2>
          {!creatingWt && (
            <button className="text-zinc-500 hover:text-zinc-300 text-lg leading-none" onClick={onClose}>&times;</button>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Left: folder browser */}
          <div className={`flex flex-col min-h-0 ${showRightPanel ? 'w-[480px] shrink-0' : 'flex-1'}`}>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 px-4 pt-3 pb-2 flex-wrap min-h-[32px] shrink-0">
              <button className="text-xs text-zinc-500 hover:text-zinc-200 flex items-center gap-0.5" onClick={() => navigate('/')}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" /></svg>
                /
              </button>
              {segments.map((seg, i) => {
                const path = '/' + segments.slice(0, i + 1).join('/');
                const isLast = i === segments.length - 1;
                return (
                  <span key={path} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-700 text-xs">/</span>}
                    <button
                      className={`text-xs ${isLast ? 'text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-200'}`}
                      onClick={() => navigate(path)}
                    >{seg}</button>
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
                <button key={t}
                  className={`text-xs px-3 py-1.5 border-b-2 transition-colors ${tab === t ? 'border-blue-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                  onClick={() => setTab(t)}
                >{t === 'recent' ? `Recent (${recentDirs.length})` : 'Browse'}</button>
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
                      <button key={dir}
                        className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-surface-light/70"
                        onClick={() => navigate(dir.replace(/\/$/, ''))}
                      >
                        <span className="text-zinc-600 text-xs">&#x1F4C1;</span>
                        <span className="truncate">{name}</span>
                      </button>
                    );
                  })
              ) : (
                recentDirs.length === 0 ? <p className="text-xs text-zinc-600 text-center py-8">No recent projects</p>
                : recentDirs.map(dir => (
                    <button key={dir}
                      className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm ${cwd === dir ? 'bg-surface-light text-white' : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'}`}
                      onClick={() => navigate(dir)}
                    >
                      <span className="text-zinc-600 text-xs">&#x1F4C1;</span>
                      <span className="font-mono text-xs truncate">{dir}</span>
                    </button>
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
                      <button key={wt.path}
                        className={`flex items-center gap-2 w-full text-left text-xs px-3 py-1.5 transition-colors ${
                          cwd === wt.path ? 'bg-surface-light text-zinc-100' : 'text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200'
                        }`}
                        onClick={() => navigate(wt.path)}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                        <span className="text-green-400 font-mono shrink-0">{wt.branch}</span>
                        <span className="text-zinc-600 font-mono truncate">{wt.path}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Create worktree form */}
              {gitInfo?.is_git && showWorktree && (
                <div className="px-3 py-2 border-b border-border space-y-2 shrink-0">
                  <div className="flex gap-2">
                    <TextField value={worktreeBranch} onChange={setWorktreeBranch} className="flex-1">
                      <Input placeholder="new-branch-name" />
                    </TextField>
                    <Button size="sm" isDisabled={!worktreeBranch.trim() || creatingWt} onPress={handleCreateWorktree}>
                      {creatingWt ? '...' : 'Create'}
                    </Button>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Checkbox isSelected={copyEnv} onChange={setCopyEnv} isDisabled={!gitInfo.has_env}>
                      <CheckboxControl><CheckboxIndicator /></CheckboxControl>
                      <CheckboxContent>
                        <span className="text-xs text-zinc-300">.env{!gitInfo.has_env && <span className="text-zinc-600"> (none)</span>}</span>
                      </CheckboxContent>
                    </Checkbox>
                    <span className="text-xs text-zinc-600">node_modules:</span>
                    {(['install', 'copy', 'link', 'none'] as const).map(mode => (
                      <button key={mode}
                        className={`text-xs px-2 py-0.5 rounded transition-colors ${depsMode === mode ? 'bg-surface-lighter text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface-light'}`}
                        onClick={() => setDepsMode(mode)}
                      >{mode === 'install' ? 'Install' : mode === 'copy' ? 'Copy' : mode === 'link' ? 'Link' : 'Skip'}</button>
                    ))}
                    {depsMode === 'install' && (
                      <Select aria-label="Package manager" selectedKey={packageManager}
                        onSelectionChange={(key) => setPackageManager(key as PackageManager)}>
                        <SelectTrigger className="h-6 text-xs w-24"><SelectValue /></SelectTrigger>
                        <SelectPopover>
                          <ListBox>
                            {PM_OPTIONS.map(pm => (
                              <ListBoxItem key={pm} id={pm} textValue={pm}>
                                <span className="text-sm">{pm}</span>
                                {pm === gitInfo.package_manager && <span className="text-xs text-zinc-500 ml-1">(detected)</span>}
                              </ListBoxItem>
                            ))}
                          </ListBox>
                        </SelectPopover>
                      </Select>
                    )}
                  </div>
                </div>
              )}

              {/* New worktree button (when form is hidden) */}
              {gitInfo?.is_git && !showWorktree && (
                <div className="px-3 py-2 border-b border-border shrink-0">
                  <button
                    className="text-xs text-zinc-400 hover:text-zinc-100 bg-surface-light hover:bg-surface-lighter rounded px-2.5 py-1 transition-colors"
                    onClick={() => { setShowWorktree(true); setConsoleLogs([]); setConsoleStatus('idle'); }}
                  >+ New worktree</button>
                </div>
              )}

              {/* Console output */}
              {showConsole && (
                <>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                    <span className="text-xs text-zinc-400 font-medium">Console</span>
                    <span className={`text-xs ${
                      consoleStatus === 'running' ? 'text-amber-400' :
                      consoleStatus === 'done' ? 'text-green-400' :
                      consoleStatus === 'error' ? 'text-red-400' : 'text-zinc-600'
                    }`}>
                      {consoleStatus === 'running' && 'running...'}
                      {consoleStatus === 'done' && 'complete'}
                      {consoleStatus === 'error' && 'failed'}
                    </span>
                  </div>
                  <div
                    ref={consoleRef}
                    className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-5 bg-base"
                  >
                    {consoleLogs.length === 0 && consoleStatus === 'running' && (
                      <div className="text-zinc-600">Waiting for output...</div>
                    )}
                    {consoleLogs.map((line, i) => (
                      <div key={i} className={
                        line.startsWith('$') ? 'text-blue-400' :
                        line.startsWith('ERROR') ? 'text-red-400' :
                        line.startsWith('Done.') ? 'text-green-400 font-medium' :
                        line.startsWith('Copied') || line.startsWith('Worktree created') ? 'text-amber-400' :
                        'text-zinc-500'
                      }>{line || '\u00A0'}</div>
                    ))}
                    {consoleStatus === 'running' && consoleLogs.length > 0 && (
                      <span className="inline-block w-2 h-3 bg-amber-400/60 animate-pulse mt-1" />
                    )}
                  </div>
                </>
              )}

              {/* Empty state when no console */}
              {!showConsole && (
                <div className="flex-1" />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0">
          <span className="text-xs text-zinc-600 font-mono truncate max-w-[360px]" title={cwd}>{cwd}</span>
          <div className="flex gap-2">
            <Button variant="flat" onPress={onClose} isDisabled={creatingWt}>Cancel</Button>
            <Button onPress={handleCreate} isDisabled={creatingWt}>Open here</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
