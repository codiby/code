import { useState, useEffect, useCallback, useRef, memo, createContext, useContext } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Copy,
  Edit2,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';

interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  path: string;
}

function pathDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function pathJoin(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

type CreatingIn = { path: string; kind: 'file' | 'dir' } | null;
type MenuState = { entry: FileEntry; parentPath: string; x: number; y: number; confirmingDelete: boolean } | null;

interface ExplorerCtxValue {
  client: ClaudeClient | null;
  onFileOpen: (path: string) => void;
  gitModified: { staged: Set<string>; unstaged: Set<string>; untracked: Set<string> };
  openMenu: (e: React.MouseEvent, entry: FileEntry, parentPath: string) => void;
  editingPath: string | null;
  beginRename: (path: string) => void;
  cancelRename: () => void;
  commitRename: (entry: FileEntry, parentPath: string, newName: string) => Promise<string | null>;
  creatingIn: CreatingIn;
  cancelCreate: () => void;
  commitCreate: (parentPath: string, name: string, kind: 'file' | 'dir') => Promise<string | null>;
}

const ExplorerCtx = createContext<ExplorerCtxValue | null>(null);
function useExplorer(): ExplorerCtxValue {
  const v = useContext(ExplorerCtx);
  if (!v) throw new Error('ExplorerCtx missing');
  return v;
}

interface Props {
  client: ClaudeClient | null;
  rootPath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onFileOpen: (path: string) => void;
  onFileDiff?: (path: string) => void;
  onFileDiffFullView?: (path: string) => void;
  gitModified: { staged: Set<string>; unstaged: Set<string>; untracked: Set<string> };
  activeSessionId: string | null;
  onOpenTerminal?: (command: string) => void;
  onStartReview?: () => void;
  onRefreshGit?: () => void;
  tools?: string[];
  sessionName?: string;
}

// Module-level cache for instant tab switching. Keyed by directory path:
// rootPath for the top-level entries, child dir paths for expanded DirNodes.
const filesCache = new Map<string, FileEntry[]>();

// Refresh emitter: any directory listener registered here is invoked when
// `refreshDir(path)` is called. Used to re-render after a mutation invalidates
// the cache for a particular parent directory.
const dirRefreshListeners = new Set<(path: string) => void>();
function refreshDir(path: string): void {
  filesCache.delete(path);
  dirRefreshListeners.forEach(fn => fn(path));
}

const EXT_COLORS: Record<string, string> = {
  ts: 'text-blue-400', tsx: 'text-blue-400', js: 'text-yellow-400', jsx: 'text-yellow-400',
  json: 'text-yellow-600', md: 'text-zinc-400', css: 'text-purple-400', html: 'text-orange-400',
  py: 'text-green-400', rs: 'text-orange-500', go: 'text-cyan-400',
  yaml: 'text-red-400', yml: 'text-red-400', toml: 'text-red-400',
  svg: 'text-amber-400', png: 'text-emerald-400', jpg: 'text-emerald-400',
  sh: 'text-green-500', bash: 'text-green-500', zsh: 'text-green-500',
};

function getExtColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_COLORS[ext] || 'text-zinc-600';
}

function NodeNameInput({
  initial, onCommit, onCancel, autoSelect,
}: { initial: string; onCommit: (name: string) => Promise<string | null>; onCancel: () => void; autoSelect: 'baseName' | 'all' }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (autoSelect === 'all') {
      el.select();
    } else {
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initial) { onCancel(); return; }
    if (trimmed.includes('/')) { setError('Name cannot contain /'); return; }
    const err = await onCommit(trimmed);
    if (err) setError(err);
  };

  return (
    <TextField
      value={value}
      onChange={(v) => { setValue(v); if (error) setError(null); }}
      aria-label="Name"
      className="flex-1 min-w-0"
    >
      <Input
        ref={inputRef}
        onBlur={submit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          e.stopPropagation();
        }}
        onClick={e => e.stopPropagation()}
        className={`bg-[#1f1f1f] text-[12px] text-zinc-100 px-1 py-0 rounded outline-none ${error ? 'border border-red-500' : 'border border-blue-500/60'}`}
        title={error || undefined}
      />
    </TextField>
  );
}

function DirNode({ entry, depth, parentPath: _parentPath }: { entry: FileEntry; depth: number; parentPath: string }) {
  const ctx = useExplorer();
  const { client, openMenu, editingPath, cancelRename, commitRename, creatingIn, cancelCreate, commitCreate } = ctx;
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>(() => filesCache.get(entry.path) || []);
  const [loading, setLoading] = useState(false);

  const fetchChildren = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const items = await client.listFiles(entry.path);
      filesCache.set(entry.path, items);
      setChildren(items);
    } catch {
      setChildren([]);
    }
    setLoading(false);
  }, [client, entry.path]);

  const toggle = useCallback(async () => {
    if (expanded) { setExpanded(false); return; }
    const cached = filesCache.get(entry.path);
    if (cached) {
      setChildren(cached);
      setExpanded(true);
      // Also refresh in background to catch external changes.
      fetchChildren();
      return;
    }
    await fetchChildren();
    setExpanded(true);
  }, [expanded, entry.path, fetchChildren]);

  // Subscribe to refresh events for our own path.
  useEffect(() => {
    const fn = (path: string) => {
      if (path !== entry.path) return;
      if (expanded) {
        fetchChildren();
      } else {
        // Clear stale local copy so the next expand re-fetches fresh.
        setChildren([]);
      }
    };
    dirRefreshListeners.add(fn);
    return () => { dirRefreshListeners.delete(fn); };
  }, [entry.path, expanded, fetchChildren]);

  // Auto-expand when an inline-create targets this directory.
  useEffect(() => {
    if (creatingIn?.path === entry.path && !expanded) {
      toggle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingIn]);

  const isEditing = editingPath === entry.path;
  const isCreatingHere = creatingIn?.path === entry.path;

  return (
    <div>
      <div
        className="flex items-center gap-1 w-full text-left py-[2px] hover:bg-surface-light/50 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={isEditing ? undefined : toggle}
        onContextMenu={e => { e.preventDefault(); openMenu(e, entry, _parentPath); }}
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-zinc-300">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {isEditing ? (
          <NodeNameInput
            initial={entry.name}
            autoSelect="all"
            onCancel={cancelRename}
            onCommit={async name => commitRename(entry, _parentPath, name)}
          />
        ) : (
          <span className="truncate text-[12px]">{entry.name}</span>
        )}
      </div>
      {expanded && (
        <div>
          {isCreatingHere && (
            <div className="flex items-center gap-1 py-[2px]" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>
              <span className="w-4 flex items-center justify-center shrink-0 text-zinc-500">
                {creatingIn!.kind === 'dir' ? <ChevronRight size={12} /> : <FileIcon size={11} />}
              </span>
              <NodeNameInput
                initial=""
                autoSelect="all"
                onCancel={cancelCreate}
                onCommit={async name => commitCreate(entry.path, name, creatingIn!.kind)}
              />
            </div>
          )}
          {loading && children.length === 0 && (
            <span className="text-[11px] text-zinc-600 block" style={{ paddingLeft: (depth + 1) * 12 + 20 }}>...</span>
          )}
          {children.map(child =>
            child.type === 'dir' ? (
              <DirNode key={child.path} entry={child} depth={depth + 1} parentPath={entry.path} />
            ) : (
              <FileNode key={child.path} entry={child} depth={depth + 1} parentPath={entry.path} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({ entry, depth, parentPath }: { entry: FileEntry; depth: number; parentPath: string }) {
  const { onFileOpen, gitModified, openMenu, editingPath, cancelRename, commitRename } = useExplorer();
  const isStaged = gitModified.staged.has(entry.path);
  const isUnstaged = gitModified.unstaged.has(entry.path);
  const isUntracked = gitModified.untracked.has(entry.path);
  const isModified = isStaged || isUnstaged;
  const color = isModified ? (isStaged ? 'text-green-400' : isUntracked ? 'text-green-400' : 'text-amber-400') : getExtColor(entry.name);
  const isEditing = editingPath === entry.path;
  return (
    <div
      className={`flex items-center gap-1 py-[2px] hover:bg-surface-light/50 cursor-pointer transition-colors ${isModified ? (isStaged ? 'text-green-400/80' : isUntracked ? 'text-green-400/80' : 'text-amber-400/80') : 'text-zinc-500 hover:text-zinc-300'}`}
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={isEditing ? undefined : () => onFileOpen(entry.path)}
      onContextMenu={e => { e.preventDefault(); openMenu(e, entry, parentPath); }}
    >
      <span className={`w-3 flex items-center justify-center shrink-0 ${color}`}>
        <FileIcon size={11} />
      </span>
      {isEditing ? (
        <NodeNameInput
          initial={entry.name}
          autoSelect="baseName"
          onCancel={cancelRename}
          onCommit={async name => commitRename(entry, parentPath, name)}
        />
      ) : (
        <span className="truncate text-[12px]">{entry.name}</span>
      )}
    </div>
  );
}

function ChangesSection({ gitModified, rootPath, onFileDiff, onFileDiffFullView, onStartReview, client, onRefresh }: { gitModified: { staged: Set<string>; unstaged: Set<string>; untracked: Set<string> }; rootPath: string | null; onFileDiff: (path: string) => void; onFileDiffFullView?: (path: string) => void; onStartReview?: () => void; client: ClaudeClient | null; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const stagedFiles = [...gitModified.staged].sort();
  const unstagedFiles = [...gitModified.unstaged].sort();
  const totalCount = new Set([...stagedFiles, ...unstagedFiles]).size;
  if (totalCount === 0) return null;

  const toggleStage = async (e: React.MouseEvent, filePath: string, isStaged: boolean) => {
    e.stopPropagation();
    if (!client || !rootPath) return;
    await client.gitStage(rootPath, [filePath], isStaged);
    onRefresh();
  };

  const stageAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || !rootPath) return;
    await client.gitStage(rootPath, unstagedFiles);
    onRefresh();
  };

  const renderFile = (filePath: string, isStaged: boolean) => {
    if (!filePath) return null;
    const rel = rootPath && filePath.startsWith(rootPath)
      ? filePath.slice(rootPath.length + 1)
      : filePath;
    const name = filePath.split('/').pop() || filePath;
    const isUntracked = gitModified.untracked.has(filePath);
    const color = isStaged ? 'text-green-400' : isUntracked ? 'text-green-400' : 'text-amber-400';
    const badge = isStaged ? 'S' : isUntracked ? 'U' : 'M';
    return (
      <div
        key={`${filePath}-${isStaged ? 's' : 'u'}`}
        className={`flex items-center gap-1 py-[2px] px-2 ${color}/80 hover:bg-surface-light/50 cursor-pointer transition-colors group/file`}
        onClick={() => onFileDiff(filePath)}
        onDoubleClick={() => onFileDiffFullView?.(filePath)}
      >
        <span className={`text-[10px] w-3 text-center shrink-0 ${color}`}>{badge}</span>
        <span className="truncate text-[12px]">{name}</span>
        <span className="text-[10px] text-zinc-600 font-mono truncate ml-auto shrink-0 max-w-[45%] text-right">{rel}</span>
        <span
          className={`px-1 flex items-center transition-colors opacity-0 group-hover/file:opacity-100 shrink-0 ${isStaged ? 'text-zinc-600 hover:text-red-400' : 'text-zinc-600 hover:text-green-400'}`}
          onClick={(e) => toggleStage(e, filePath, isStaged)}
          title={isStaged ? 'Unstage file' : 'Stage file'}
        >
          {isStaged ? <Minus size={12} /> : <Plus size={12} />}
        </span>
      </div>
    );
  };

  return (
    <div className="border-b border-border/50 shrink-0">
      <Button
        variant="ghost"
        fullWidth
        className="flex items-center gap-1 justify-start text-left px-3 py-1.5 h-auto rounded-none hover:bg-surface-light/30 transition-colors group"
        onPress={() => setExpanded(e => !e)}
      >
        <span className="w-3 flex items-center justify-center shrink-0 text-zinc-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Changes</span>
        <span className="text-[10px] text-amber-400/70 ml-auto mr-1">{totalCount}</span>
        <span
          className="text-zinc-600 hover:text-zinc-200 px-1 flex items-center transition-colors opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          title="Refresh"
        >
          <RefreshCw size={12} />
        </span>
        {unstagedFiles.length > 0 && (
          <span
            className="text-zinc-600 hover:text-green-400 px-1 flex items-center transition-colors opacity-0 group-hover:opacity-100"
            onClick={stageAll}
            title="Stage All"
          >
            <Plus size={12} />
          </span>
        )}
        {onStartReview && (
          <span
            className="text-zinc-500 hover:text-green-400 px-1 flex items-center transition-colors"
            onClick={(e) => { e.stopPropagation(); onStartReview(); }}
            title="Start Review"
          >
            <Play size={12} />
          </span>
        )}
      </Button>
      {expanded && (
        <div className="pb-1">
          {stagedFiles.length > 0 && (
            <div className="px-3 py-0.5">
              <span className="text-[10px] text-green-400/60 uppercase tracking-wider">Staged</span>
            </div>
          )}
          {stagedFiles.map(path => renderFile(path, true))}
          {unstagedFiles.length > 0 && (
            <div className="px-3 py-0.5 mt-0.5">
              <span className="text-[10px] text-amber-400/60 uppercase tracking-wider">Changes</span>
            </div>
          )}
          {unstagedFiles.map(path => renderFile(path, false))}
        </div>
      )}
    </div>
  );
}

interface ProcessInfo {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  children: { pid: number; command: string }[];
}

function ProcessNode({ proc, onKill, onView }: { proc: ProcessInfo; onKill: (processId?: string, pid?: number) => void; onView?: (command: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = proc.children.length > 0;

  return (
    <div>
      <div className="flex items-center gap-1 py-[2px] px-2 text-zinc-400 group">
        {hasChildren ? (
          <Button isIconOnly size="sm" variant="ghost" className="w-3 h-auto p-0 min-w-0 text-zinc-500" onPress={() => setExpanded(e => !e)} aria-label="Toggle children">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </Button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
        <span className="truncate text-[11px] font-mono flex-1 cursor-pointer hover:text-zinc-200" onClick={() => onView?.(proc.command)}>{proc.command}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">{proc.pid}</span>
        {onView && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="h-auto p-0 min-w-0 text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
            onPress={() => onView(proc.command)}
            aria-label="Open in panel"
          >
            <ArrowUpRight size={12} />
          </Button>
        )}
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="h-auto p-0 min-w-0 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
          onPress={() => onKill(proc.id)}
          aria-label="Kill process"
        >
          <X size={12} />
        </Button>
      </div>
      {expanded && proc.children.map(child => (
        <div key={child.pid} className="flex items-center gap-1 py-[1px] text-zinc-500 group" style={{ paddingLeft: 28 }}>
          <span className="text-zinc-600 shrink-0 flex items-center"><CornerDownRight size={11} /></span>
          <span className="truncate text-[10px] font-mono flex-1">{child.command}</span>
          <span className="text-[9px] text-zinc-600 shrink-0">{child.pid}</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="h-auto p-0 min-w-0 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0 ml-1 pr-2 transition-opacity"
            onPress={() => onKill(undefined, child.pid)}
            aria-label="Kill process"
          >
            <X size={11} />
          </Button>
        </div>
      ))}
    </div>
  );
}

function ProcessesSection({ client, sessionId, onViewTerminal }: { client: ClaudeClient | null; sessionId: string | null; onViewTerminal?: (command: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!client || !sessionId) { setProcesses([]); return; }
    try {
      const procs = await client.listProcesses(sessionId);
      setProcesses(procs);
    } catch { setProcesses([]); }
  }, [client, sessionId]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 3000);
    return () => clearInterval(intervalRef.current);
  }, [refresh]);

  const handleKill = async (processId?: string, pid?: number) => {
    if (!client || !sessionId) return;
    client.killProcess(sessionId, processId, pid);
    setTimeout(refresh, 500);
  };

  if (processes.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <Button
        variant="ghost"
        fullWidth
        className="flex items-center gap-1 justify-start text-left px-3 py-1.5 h-auto rounded-none hover:bg-surface-light/30 transition-colors"
        onPress={() => setExpanded(e => !e)}
      >
        <span className="w-3 flex items-center justify-center shrink-0 text-zinc-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Processes</span>
        <span className="text-[10px] text-green-400/70 ml-auto">{processes.length}</span>
      </Button>
      {expanded && (
        <div className="pb-1">
          {processes.map(proc => (
            <ProcessNode key={proc.id} proc={proc} onKill={handleKill} onView={onViewTerminal} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileTreeSection({ rootPath, entries, onNewAtRoot }: { rootPath: string | null; entries: FileEntry[]; onNewAtRoot: (kind: 'file' | 'dir') => void }) {
  const { creatingIn, cancelCreate, commitCreate } = useExplorer();
  const [expanded, setExpanded] = useState(true);
  const label = rootPath ? rootPath.split('/').filter(Boolean).pop() || rootPath : 'Files';
  const isCreatingAtRoot = !!rootPath && creatingIn?.path === rootPath;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="flex items-center gap-1 w-full text-left px-3 py-1.5 hover:bg-surface-light/30 transition-colors border-b border-border/50 shrink-0 group cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="w-3 flex items-center justify-center shrink-0 text-zinc-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider truncate">{label}</span>
        {rootPath && (
          <span
            className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={e => e.stopPropagation()}
          >
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="h-auto p-0 min-w-0 text-zinc-600 hover:text-zinc-300"
              onPress={() => onNewAtRoot('file')}
              aria-label="New file"
            >
              <FilePlus size={12} />
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="h-auto p-0 min-w-0 text-zinc-600 hover:text-zinc-300"
              onPress={() => onNewAtRoot('dir')}
              aria-label="New folder"
            >
              <FolderPlus size={12} />
            </Button>
          </span>
        )}
      </div>
      {expanded && (
        <div className="flex-1 overflow-y-auto py-1">
          {!rootPath && (
            <p className="text-[11px] text-zinc-600 px-3 py-4 text-center">No session active</p>
          )}
          {isCreatingAtRoot && (
            <div className="flex items-center gap-1 py-[2px]" style={{ paddingLeft: 8 }}>
              <span className="w-4 flex items-center justify-center shrink-0 text-zinc-500">
                {creatingIn!.kind === 'dir' ? <ChevronRight size={12} /> : <FileIcon size={11} />}
              </span>
              <NodeNameInput
                initial=""
                autoSelect="all"
                onCancel={cancelCreate}
                onCommit={async name => commitCreate(rootPath!, name, creatingIn!.kind)}
              />
            </div>
          )}
          {entries.map(entry =>
            entry.type === 'dir' ? (
              <DirNode key={entry.path} entry={entry} depth={0} parentPath={rootPath || ''} />
            ) : (
              <FileNode key={entry.path} entry={entry} depth={0} parentPath={rootPath || ''} />
            )
          )}
        </div>
      )}
    </div>
  );
}

interface PRInfo {
  number: number;
  title: string;
  headRefName: string;
  state: string;
  url: string;
  isDraft: boolean;
}

const prsCache = new Map<string, PRInfo[]>();

const PR_STATE_COLORS: Record<string, { dot: string; text: string }> = {
  OPEN: { dot: 'bg-green-400', text: 'text-green-400' },
  MERGED: { dot: 'bg-violet-400', text: 'text-violet-400' },
  CLOSED: { dot: 'bg-zinc-500', text: 'text-zinc-500' },
};

function PRsSection({ client, rootPath, sessionName }: { client: ClaudeClient | null; rootPath: string | null; sessionName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const cacheKey = rootPath || '';
  const [prs, setPrs] = useState<PRInfo[]>(() => prsCache.get(cacheKey) || []);

  useEffect(() => {
    if (!client || !rootPath) { setPrs([]); return; }
    // Instant from cache
    const cached = prsCache.get(rootPath);
    if (cached) setPrs(cached);
    // Refresh in background
    client.listPullRequests(rootPath, sessionName).then(data => {
      prsCache.set(rootPath, data);
      setPrs(data);
    }).catch(() => setPrs([]));
  }, [client, rootPath, sessionName]);

  if (prs.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <Button
        variant="ghost"
        fullWidth
        className="flex items-center gap-1 justify-start text-left px-3 py-1.5 h-auto rounded-none hover:bg-surface-light/30 transition-colors"
        onPress={() => setExpanded(e => !e)}
      >
        <span className="w-3 flex items-center justify-center shrink-0 text-zinc-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Pull Requests</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{prs.length}</span>
      </Button>
      {expanded && (
        <div className="pb-1">
          {prs.map(pr => {
            const colors = pr.isDraft
              ? { dot: 'bg-amber-400', text: 'text-amber-400' }
              : PR_STATE_COLORS[pr.state] || PR_STATE_COLORS.OPEN!;
            return (
              <a
                key={pr.number}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1.5 py-[3px] px-2 text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200 cursor-pointer transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${colors.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] shrink-0 ${colors.text}`}>#{pr.number}</span>
                    <span className="text-[11px] truncate">{pr.title}</span>
                  </div>
                  <span className="text-[10px] text-zinc-600 font-mono truncate block">{pr.headRefName}</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolsSection({ tools }: { tools: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 0) return null;

  return (
    <div className="border-b border-border/50 shrink-0">
      <Button
        variant="ghost"
        fullWidth
        className="flex items-center gap-1 justify-start text-left px-3 py-1.5 h-auto rounded-none hover:bg-surface-light/30 transition-colors"
        onPress={() => setExpanded(e => !e)}
      >
        <span className="w-3 flex items-center justify-center shrink-0 text-zinc-400">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Tools</span>
        <span className="text-[10px] text-zinc-600 ml-auto">{tools.length}</span>
      </Button>
      {expanded && (
        <div className="px-3 pb-2 flex flex-wrap gap-1 max-h-40 overflow-y-auto">
          {tools.map(tool => (
            <span key={tool} className="text-[10px] bg-surface-light text-zinc-400 px-1.5 py-0.5 rounded font-mono">
              {tool}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;

function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try { return Number(localStorage.getItem('claude-ui-sidebar-width')) || SIDEBAR_DEFAULT; }
    catch { return SIDEBAR_DEFAULT; }
  });
  const setAndPersist = useCallback((w: number) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
    setWidth(clamped);
    try { localStorage.setItem('claude-ui-sidebar-width', String(clamped)); } catch {}
  }, []);
  return [width, setAndPersist] as const;
}

export const FileExplorer = memo(function FileExplorer({ client, rootPath, collapsed, onToggle, onFileOpen, onFileDiff, onFileDiffFullView, gitModified, activeSessionId, onOpenTerminal, onStartReview, onRefreshGit, tools, sessionName }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>(() => (rootPath ? filesCache.get(rootPath) : null) || []);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const dragging = useRef(false);

  const [menu, setMenu] = useState<MenuState>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<CreatingIn>(null);
  const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchRoot = useCallback(async () => {
    if (!client || !rootPath) return;
    try {
      const data = await client.listFiles(rootPath);
      filesCache.set(rootPath, data);
      setEntries(data);
    } catch {
      setEntries([]);
    }
  }, [client, rootPath]);

  useEffect(() => {
    if (!client || !rootPath) return;
    const cached = filesCache.get(rootPath);
    if (cached) setEntries(cached);
    fetchRoot();
  }, [client, rootPath, fetchRoot]);

  // Refresh subscription for root.
  useEffect(() => {
    const fn = (path: string) => {
      if (rootPath && path === rootPath) fetchRoot();
    };
    dirRefreshListeners.add(fn);
    return () => { dirRefreshListeners.delete(fn); };
  }, [rootPath, fetchRoot]);

  const openMenu = useCallback((e: React.MouseEvent, entry: FileEntry, parentPath: string) => {
    setMenu({ entry, parentPath, x: e.clientX, y: e.clientY, confirmingDelete: false });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
  }, []);

  const beginRename = useCallback((path: string) => {
    setEditingPath(path);
    setCreatingIn(null);
  }, []);
  const cancelRename = useCallback(() => setEditingPath(null), []);

  const commitRename = useCallback(async (entry: FileEntry, parentPath: string, newName: string): Promise<string | null> => {
    if (!client) return 'No client';
    const newPath = pathJoin(pathDirname(entry.path), newName);
    const res = await client.renamePath(entry.path, newPath);
    if (!res.ok) return res.error || 'Rename failed';
    setEditingPath(null);
    refreshDir(parentPath);
    onRefreshGit?.();
    return null;
  }, [client, onRefreshGit]);

  const cancelCreate = useCallback(() => setCreatingIn(null), []);

  const commitCreate = useCallback(async (parentPath: string, name: string, kind: 'file' | 'dir'): Promise<string | null> => {
    if (!client) return 'No client';
    const newPath = pathJoin(parentPath, name);
    const res = kind === 'dir' ? await client.createDir(newPath) : await client.createFile(newPath);
    if (!res.ok) return res.error || 'Create failed';
    setCreatingIn(null);
    refreshDir(parentPath);
    onRefreshGit?.();
    if (kind === 'file') onFileOpen(newPath);
    return null;
  }, [client, onFileOpen, onRefreshGit]);

  const handleDelete = useCallback(async () => {
    if (!menu || !client) return;
    const { entry, parentPath } = menu;
    if (!menu.confirmingDelete) {
      setMenu({ ...menu, confirmingDelete: true });
      if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
      deleteConfirmTimer.current = setTimeout(() => {
        setMenu(m => (m && m.entry.path === entry.path ? { ...m, confirmingDelete: false } : m));
      }, 3000);
      return;
    }
    closeMenu();
    const res = await client.deletePath(entry.path);
    if (!res.ok) {
      // Surface the error; keep this minimal — a toast system isn't wired here.
      // eslint-disable-next-line no-alert
      alert(`Delete failed: ${res.error}`);
      return;
    }
    refreshDir(parentPath);
    onRefreshGit?.();
  }, [menu, client, closeMenu, onRefreshGit]);

  const handleReveal = useCallback(async () => {
    if (!menu || !client) return;
    const path = menu.entry.path;
    closeMenu();
    const res = await client.revealInFinder(path);
    if (!res.ok) {
      // eslint-disable-next-line no-alert
      alert(`Reveal failed: ${res.error}`);
    }
  }, [menu, client, closeMenu]);

  const handleCopyPath = useCallback(() => {
    if (!menu) return;
    navigator.clipboard.writeText(menu.entry.path).catch(() => {});
    closeMenu();
  }, [menu, closeMenu]);

  const handleNewAtRoot = useCallback((kind: 'file' | 'dir') => {
    if (!rootPath) return;
    setCreatingIn({ path: rootPath, kind });
  }, [rootPath]);

  const ctxValue: ExplorerCtxValue = {
    client, onFileOpen, gitModified,
    openMenu,
    editingPath, beginRename, cancelRename, commitRename,
    creatingIn, cancelCreate, commitCreate,
  };

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setSidebarWidth(startW + (ev.clientX - startX));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth, setSidebarWidth]);

  return (
    <ExplorerCtx.Provider value={ctxValue}>
      <aside
        className={`relative border-r border-border bg-[#161616] flex flex-col shrink-0 ${collapsed ? 'w-0 overflow-hidden' : ''}`}
        style={collapsed ? undefined : { width: sidebarWidth }}
      >
        {/* Resize handle */}
        {!collapsed && (
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
            onMouseDown={onResizeStart}
          />
        )}
        {/* Header */}
        <div className="px-3 py-2 flex items-center justify-between border-b border-border shrink-0">
          <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Explorer</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="h-auto p-0 min-w-0 text-zinc-600 hover:text-zinc-300"
            onPress={onToggle}
            aria-label="Toggle file explorer"
          >
            <X size={14} />
          </Button>
        </div>

        {/* Processes */}
        <ProcessesSection client={client} sessionId={activeSessionId} onViewTerminal={onOpenTerminal} />

        {/* Changes */}
        <ChangesSection gitModified={gitModified} rootPath={rootPath} onFileDiff={onFileDiff || onFileOpen} onFileDiffFullView={onFileDiffFullView} onStartReview={onStartReview} client={client} onRefresh={onRefreshGit || (() => {})} />

        {/* Tools */}
        {/* Pull Requests */}
        <PRsSection client={client} rootPath={rootPath} sessionName={sessionName} />

        <ToolsSection tools={tools || []} />

        {/* File tree (collapsible) */}
        <FileTreeSection rootPath={rootPath} entries={entries} onNewAtRoot={handleNewAtRoot} />

        {/* Right-click context menu */}
        {menu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={closeMenu}
              onContextMenu={e => { e.preventDefault(); closeMenu(); }}
            />
            <div
              className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[200px] py-1"
              style={{ top: menu.y, left: menu.x }}
            >
              {menu.entry.type === 'file' && (
                <MenuItem
                  icon={<ExternalLink size={11} />}
                  label="Open"
                  onClick={() => { onFileOpen(menu.entry.path); closeMenu(); }}
                />
              )}
              {menu.entry.type === 'dir' && (
                <>
                  <MenuItem
                    icon={<FilePlus size={11} />}
                    label="New File"
                    onClick={() => { setCreatingIn({ path: menu.entry.path, kind: 'file' }); closeMenu(); }}
                  />
                  <MenuItem
                    icon={<FolderPlus size={11} />}
                    label="New Folder"
                    onClick={() => { setCreatingIn({ path: menu.entry.path, kind: 'dir' }); closeMenu(); }}
                  />
                  <div className="h-px bg-border mx-2 my-1" />
                </>
              )}
              <MenuItem
                icon={<Edit2 size={11} />}
                label="Rename"
                onClick={() => { beginRename(menu.entry.path); closeMenu(); }}
              />
              <MenuItem
                icon={<Copy size={11} />}
                label="Copy Path"
                onClick={handleCopyPath}
              />
              <MenuItem
                icon={<ExternalLink size={11} />}
                label="Reveal in Finder"
                onClick={handleReveal}
              />
              <div className="h-px bg-border mx-2 my-1" />
              <MenuItem
                icon={<Trash2 size={11} />}
                label={menu.confirmingDelete ? 'Click again to delete' : 'Delete'}
                danger
                onClick={handleDelete}
              />
            </div>
          </>
        )}
      </aside>
    </ExplorerCtx.Provider>
  );
});

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  const base = 'w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 justify-start h-auto rounded-none transition-colors';
  const tone = danger
    ? 'text-red-400 hover:bg-red-500/15 hover:text-red-300'
    : 'text-zinc-400 hover:bg-surface-light hover:text-zinc-200';
  return (
    <Button variant="ghost" fullWidth className={`${base} ${tone}`} onPress={onClick}>
      <span className="w-3 flex items-center justify-center shrink-0 opacity-70">{icon}</span>
      {label}
    </Button>
  );
}
