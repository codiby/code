import { useState, useEffect, useCallback, useMemo, useRef, memo, createContext, useContext } from 'react';
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
  FolderTree,
  GitBranch,
  GitPullRequest,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import type { ClaudeClient, SessionInfo, ConnectionStatus } from '../lib/claude-client';

/** Session-switcher palette — kept inline so this section stays visually
 *  distinct from the rest of the explorer chrome. Mirrors the colors from
 *  the design mockup the user signed off on. */
const SW = {
  switcherBg: '#131418',
  treeBg: '#14151a',
  border: '#2a2b30',
  text: '#e6e7ea',
  muted: '#8a8c93',
  mutedDim: '#5e6068',
  accent: '#7c5cff',
  accentSoft: '#7c5cff22',
  accentText: '#d9d2ff',
  rowHover: '#1f2025',
  statusGreen: '#3ecf8e',
  statusYellow: '#f5b942',
  statusRed: '#ef5b6b',
};

export interface SessionSwitcherGroup {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

/** Working-tree git state for the Changes card. `stats` maps an absolute file
 *  path to its added/deleted line counts (from `git diff --numstat`); absent
 *  for untracked files, which have no diff. */
export interface GitModifiedState {
  staged: Set<string>;
  unstaged: Set<string>;
  untracked: Set<string>;
  stats: Map<string, { additions: number; deletions: number }>;
}

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
  gitModified: GitModifiedState;
  activeFilePath: string | null;
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
  gitModified: GitModifiedState;
  activeFilePath?: string | null;
  /** Path of the file currently shown in the diff viewer — highlighted in the
   *  Changes list so the user can see which change they're looking at. */
  activeDiffPath?: string | null;
  /** Changes comparison mode + its base branch, plus the setter for the
   *  in-section toggle. 'vs-main' shows branch changes vs the base branch;
   *  'uncommitted' shows the working-tree (staged/unstaged/untracked) view. */
  changesCompare?: 'vs-main' | 'uncommitted';
  onChangesCompareChange?: (mode: 'vs-main' | 'uncommitted') => void;
  baseBranch?: string;
  activeSessionId: string | null;
  onOpenTerminal?: (command: string) => void;
  onStartReview?: () => void;
  onRefreshGit?: () => void;
  tools?: string[];
  sessionName?: string;
  /** Search-as-a-card: when active the search card replaces the other cards.
   *  Controlled by the host so the ⌘⇧F shortcut can drive it. `renderSearchCard`
   *  supplies the actual search UI (the host owns SearchPanel). */
  searchActive?: boolean;
  onSearchActiveChange?: (v: boolean) => void;
  renderSearchCard?: (onClose: () => void) => React.ReactNode;
  /** Optional: list of open sessions to render in the inline session
   *  switcher at the top of the panel. When omitted the switcher is
   *  hidden, preserving the legacy explorer-only layout. */
  sessions?: SessionInfo[];
  sessionStatuses?: Record<string, ConnectionStatus>;
  onSelectSession?: (id: string) => void;
  onNewSession?: () => void;
  tabGroups?: Record<string, SessionSwitcherGroup>;
  tabGroupMap?: Record<string, string>;
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
  json: 'text-yellow-600', md: 'text-[#c4c6cc]', css: 'text-purple-400', html: 'text-orange-400',
  py: 'text-green-400', rs: 'text-orange-500', go: 'text-cyan-400',
  yaml: 'text-red-400', yml: 'text-red-400', toml: 'text-red-400',
  svg: 'text-amber-400', png: 'text-emerald-400', jpg: 'text-emerald-400',
  sh: 'text-green-500', bash: 'text-green-500', zsh: 'text-green-500',
};

function getExtColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_COLORS[ext] || 'text-[#5e6068]';
}

// Desaturated amber for "modified" files — softer than tailwind's amber-400.
const MODIFIED_COLOR = '#d6a85f';

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
        className={`bg-[#1f1f1f] text-[12px] text-white px-1 py-0 rounded outline-none ${error ? 'border border-red-500' : 'border border-[#7c5cff]'}`}
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
        className="flex items-center gap-1 w-full text-left py-[2px] hover:bg-[#1c1d21] transition-colors cursor-pointer"
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={isEditing ? undefined : toggle}
        onContextMenu={e => { e.preventDefault(); openMenu(e, entry, _parentPath); }}
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-[#8a8c93]">
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
          <span className="truncate text-[12px] text-[#cdb98a]">{entry.name}</span>
        )}
      </div>
      {expanded && (
        <div>
          {isCreatingHere && (
            <div className="flex items-center gap-1 py-[2px]" style={{ paddingLeft: (depth + 1) * 12 + 8 }}>
              <span className="w-4 flex items-center justify-center shrink-0 text-[#8a8c93]">
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
            <span className="text-[11px] text-[#5e6068] block" style={{ paddingLeft: (depth + 1) * 12 + 20 }}>...</span>
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
  const { onFileOpen, gitModified, activeFilePath, openMenu, editingPath, cancelRename, commitRename } = useExplorer();
  const isStaged = gitModified.staged.has(entry.path);
  const isUnstaged = gitModified.unstaged.has(entry.path);
  const isUntracked = gitModified.untracked.has(entry.path);
  const isModified = isStaged || isUnstaged || isUntracked;
  const greenish = isStaged || isUntracked;
  // Match the Changes card: added/staged/untracked → green, modified → amber.
  const changeColor = greenish ? GREEN_STATUS : MODIFIED_COLOR;
  const badge = isStaged ? 'S' : isUntracked ? 'U' : isUnstaged ? 'M' : '';
  const isEditing = editingPath === entry.path;
  const isActive = activeFilePath === entry.path;
  // Name color: changed files take the status hue; everything else the default.
  const nameColor = isModified ? changeColor : '#c4c6cc';
  // Icon color: changed → status hue; else per-extension tint.
  const iconColorClass = isModified ? '' : getExtColor(entry.name);
  return (
    <div
      className={`relative flex items-center gap-1 py-[2px] cursor-pointer transition-colors ${isActive ? 'bg-[#7c5cff24] hover:bg-[#7c5cff33]' : 'hover:bg-[#1c1d21]'}`}
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={isEditing ? undefined : () => onFileOpen(entry.path)}
      onContextMenu={e => { e.preventDefault(); openMenu(e, entry, parentPath); }}
    >
      {isActive && <span className="absolute left-0 top-[2px] bottom-[2px] w-[2.5px] rounded-r bg-[#7c5cff]" />}
      <span className={`w-3 flex items-center justify-center shrink-0 ${iconColorClass}`} style={isModified ? { color: changeColor } : undefined}>
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
        <>
          <span className="truncate text-[12px]" style={{ color: nameColor }}>{entry.name}</span>
          {badge && <span className="ml-auto mr-2 text-[9.5px] font-extrabold font-mono shrink-0" style={{ color: changeColor }}>{badge}</span>}
        </>
      )}
    </div>
  );
}

// "modified" amber as an 0x21 (~13%) alpha tint, for the status-glyph chips.
const GREEN_STATUS = '#5cc98c';
function statusTint(hex: string): string { return `${hex}21`; }

/** Pro card surface — flat tone, hairline border, a 1px top sheen and a
 *  whisper of elevation. No heavy drop shadow. Shared by every section card. */
const CARD_CLS = 'rounded-[11px] border border-[#1e1f24] bg-[#141519] overflow-hidden shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_1px_2px_rgba(0,0,0,0.25)]';

/** Hairline divider under a card header — fades at both ends. */
function CardDivider() {
  return <div className="h-px mx-[11px] bg-[linear-gradient(90deg,transparent,#26272d_12%,#26272d_88%,transparent)]" />;
}

/** Refined card header: chevron · accent line-glyph · title · right-aligned
 *  meta (count / hover actions). 34px tall, quiet typography. */
function CardHeader({ icon, iconColor, title, expanded, onToggle, meta }: {
  icon: React.ReactNode;
  iconColor: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  meta?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group/hd w-full flex items-center gap-[9px] h-[34px] px-[11px] text-left hover:bg-white/[0.018] transition-colors"
    >
      <span className="flex text-[#4f525a] group-hover/hd:text-[#6b6e76] transition-colors shrink-0">
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </span>
      <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0" style={{ color: iconColor }}>
        {icon}
      </span>
      <span className="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-[#9aa0a8] truncate">{title}</span>
      {meta && <span className="ml-auto flex items-center gap-2 shrink-0">{meta}</span>}
    </button>
  );
}

/** Segmented Uncommitted / vs-<base> toggle — replaces the old <select>. One
 *  tap, no dropdown, base branch rendered in the accent mono. */
function CompareToggle({ mode, onChange, baseBranch }: { mode: 'vs-main' | 'uncommitted'; onChange: (m: 'vs-main' | 'uncommitted') => void; baseBranch?: string }) {
  return (
    <div
      className="mx-[11px] mt-[9px] mb-[5px] flex bg-[#101116] border border-[#1e1f24] rounded-[9px] p-[3px]"
      onClick={(e) => e.stopPropagation()}
    >
      {(['uncommitted', 'vs-main'] as const).map(m => {
        const active = mode === m;
        return (
          <button
            key={m}
            onClick={() => onChange(m)}
            className={`flex-1 text-[11px] font-semibold py-[5px] leading-[13px] rounded-md transition-colors ${active ? 'bg-[#1e1f24] text-[#e6e7ea] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]' : 'text-[#6b6e76] hover:text-[#9aa0a8]'}`}
          >
            {m === 'uncommitted' ? 'Uncommitted' : <>vs <span className="font-mono text-[10.5px] text-[#7c5cff]">{baseBranch || 'main'}</span></>}
          </button>
        );
      })}
    </div>
  );
}

function ChangesSection({ gitModified, rootPath, onFileDiff, onFileDiffFullView, onStartReview, client, onRefresh, activeDiffPath, compareMode, onCompareModeChange, baseBranch }: { gitModified: GitModifiedState; rootPath: string | null; onFileDiff: (path: string) => void; onFileDiffFullView?: (path: string) => void; onStartReview?: () => void; client: ClaudeClient | null; onRefresh: () => void; activeDiffPath?: string | null; compareMode: 'vs-main' | 'uncommitted'; onCompareModeChange?: (mode: 'vs-main' | 'uncommitted') => void; baseBranch?: string }) {
  const [expanded, setExpanded] = useState(true);
  const vsMain = compareMode === 'vs-main';
  const stagedFiles = [...gitModified.staged].sort();
  const unstagedFiles = [...gitModified.unstaged].sort();
  const uniqueFiles = new Set([...stagedFiles, ...unstagedFiles]);
  const totalCount = uniqueFiles.size;

  // Aggregate +/- across the files shown, for the footer summary.
  let totalAdd = 0, totalDel = 0;
  for (const f of uniqueFiles) {
    const s = gitModified.stats.get(f);
    if (s) { totalAdd += s.additions; totalDel += s.deletions; }
  }

  // Vertical resize: the file-list area has a draggable height, persisted so
  // the card keeps its size across sessions. Dragging the grip between the list
  // and the footer grows/shrinks the whole card.
  const [listHeight, setListHeight] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('changesCardHeight')) : NaN;
    return Number.isFinite(saved) && saved > 80 ? saved : 280;
  });
  const heightRef = useRef(listHeight);
  const onResizeHeight = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = heightRef.current;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(80, Math.min(window.innerHeight * 0.8, startH + (ev.clientY - startY)));
      heightRef.current = next;
      setListHeight(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('changesCardHeight', String(heightRef.current)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const toggleStage = async (e: React.MouseEvent, filePath: string, isStaged: boolean) => {
    e.stopPropagation();
    if (!client || !rootPath) return;
    await client.gitStage(rootPath, [filePath], isStaged);
    onRefresh();
  };

  const stageAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || !rootPath || unstagedFiles.length === 0) return;
    await client.gitStage(rootPath, unstagedFiles);
    onRefresh();
  };

  const unstageAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!client || !rootPath || stagedFiles.length === 0) return;
    await client.gitStage(rootPath, stagedFiles, true);
    onRefresh();
  };

  const renderFile = (filePath: string, isStaged: boolean) => {
    if (!filePath) return null;
    const rel = rootPath && filePath.startsWith(rootPath)
      ? filePath.slice(rootPath.length + 1)
      : filePath;
    const name = filePath.split('/').pop() || filePath;
    // Directory portion only — shown dimmed under the filename. Empty at root.
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const isUntracked = gitModified.untracked.has(filePath);
    const isActive = activeDiffPath === filePath;
    const greenish = isStaged || isUntracked;
    const badge = isStaged ? 'S' : isUntracked ? 'U' : 'M';
    const accent = greenish ? GREEN_STATUS : MODIFIED_COLOR;
    return (
      <div
        key={`${filePath}-${isStaged ? 's' : 'u'}`}
        className={`relative flex items-center gap-2 pr-[11px] py-[5px] cursor-pointer transition-colors group/file ${isActive ? 'bg-[#7c5cff]/[0.10] hover:bg-[#7c5cff]/[0.16]' : 'hover:bg-white/[0.022]'}`}
        onClick={() => onFileDiff(filePath)}
        onDoubleClick={() => onFileDiffFullView?.(filePath)}
        title={rel}
      >
        {/* status accent bar */}
        {isActive && <span className="absolute left-0 top-[5px] bottom-[5px] w-[2px] rounded-r bg-[#7c5cff]" />}
        {/* status glyph chip */}
        <span
          className="ml-[11px] w-[17px] h-[17px] rounded-[5px] flex items-center justify-center text-[9.5px] font-bold font-mono shrink-0"
          style={{ color: accent, background: statusTint(accent) }}
        >
          {badge}
        </span>
        <span className="min-w-0 flex-1 flex flex-col gap-[1px] leading-tight">
          <span className="truncate text-[12.5px] text-[#e6e7ea]">{name}</span>
          {dir && <span className="truncate text-[10px] text-[#4f525a] font-mono">{dir}</span>}
        </span>
        {/* per-file +/- line counts; dim on hover so the stage button reads */}
        {(() => {
          const st = gitModified.stats.get(filePath);
          if (!st || (!st.additions && !st.deletions)) return null;
          return (
            <span className={`flex items-center gap-1.5 text-[10px] font-mono tabular-nums shrink-0 transition-opacity ${!vsMain ? 'group-hover/file:opacity-40' : ''}`}>
              {st.additions > 0 && <span className="text-[#5cc98c]">+{st.additions}</span>}
              {st.deletions > 0 && <span className="text-[#e0808a]">−{st.deletions}</span>}
            </span>
          );
        })()}
        {!vsMain && (
          <span
            className={`w-[22px] h-[22px] rounded-[6px] flex items-center justify-center transition-all opacity-0 group-hover/file:opacity-100 shrink-0 ${isStaged ? 'text-[#4f525a] hover:text-[#e0808a] hover:bg-[#191a1f]' : 'text-[#4f525a] hover:text-[#5cc98c] hover:bg-[#191a1f]'}`}
            onClick={(e) => toggleStage(e, filePath, isStaged)}
            title={isStaged ? 'Unstage file' : 'Stage file'}
          >
            {isStaged ? <Minus size={13} /> : <Plus size={13} />}
          </span>
        )}
      </div>
    );
  };

  const groupHeader = (label: string, count: number, color: string, action?: { label: string; icon: React.ReactNode; onClick: (e: React.MouseEvent) => void; hover: string }) => (
    <div className="sticky top-0 z-[1] bg-[#141519] flex items-center gap-2 px-[11px] pt-2 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color }}>{label}</span>
      <span className="text-[10px] text-[#4f525a] tabular-nums">{count}</span>
      {action && (
        <button
          onClick={action.onClick}
          className={`ml-auto flex items-center gap-1 text-[10.5px] text-[#6b6e76] px-1.5 py-0.5 rounded-md transition-colors ${action.hover}`}
        >
          {action.icon}{action.label}
        </button>
      )}
    </div>
  );

  return (
    <div data-card="changes" className={`${CARD_CLS} flex flex-col`}>
      <CardHeader
        icon={<GitBranch size={13} strokeWidth={1.9} />}
        iconColor={MODIFIED_COLOR}
        title="Changes"
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
        meta={
          <>
            {totalCount > 0 && (
              <span className="text-[11px] font-semibold font-mono tabular-nums" style={{ color: MODIFIED_COLOR }}>{totalCount}</span>
            )}
            <span
              className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#9aa0a8] hover:bg-[#191a1f] transition-colors opacity-0 group-hover/hd:opacity-100"
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              title="Refresh"
            >
              <RefreshCw size={13} />
            </span>
            {onStartReview && (
              <span
                className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#5cc98c] hover:bg-[#191a1f] transition-colors"
                onClick={(e) => { e.stopPropagation(); onStartReview(); }}
                title="Start Review"
              >
                <Play size={13} />
              </span>
            )}
          </>
        }
      />
      {expanded && <CardDivider />}
      {expanded && (
        <>
          {onCompareModeChange && (
            <CompareToggle mode={compareMode} onChange={onCompareModeChange} baseBranch={baseBranch} />
          )}
          {totalCount === 0 ? (
            <div className="px-3 pb-2.5 text-[11px] text-[#5e6068]">
              {vsMain ? `No changes vs ${baseBranch || 'main'}` : 'No uncommitted changes'}
            </div>
          ) : (
            <>
              <div className="pb-1 overflow-y-auto" style={{ height: listHeight }}>
                {/* In vs-main mode everything is one flat list; in uncommitted
                    mode keep the Staged / Changes split. */}
                {!vsMain && stagedFiles.length > 0 && groupHeader('Staged', stagedFiles.length, '#9fe3bd', {
                  label: 'Unstage all', icon: <Minus size={11} />, onClick: unstageAll, hover: 'hover:text-red-400 hover:bg-red-500/10',
                })}
                {!vsMain && stagedFiles.map(path => renderFile(path, true))}
                {!vsMain && unstagedFiles.length > 0 && groupHeader('Changes', unstagedFiles.length, MODIFIED_COLOR, {
                  label: 'Stage all', icon: <Plus size={11} />, onClick: stageAll, hover: 'hover:text-green-400 hover:bg-green-500/10',
                })}
                {(vsMain ? [...stagedFiles, ...unstagedFiles].sort() : unstagedFiles).map(path => renderFile(path, false))}
              </div>
              {/* Vertical resize grip — drag to grow/shrink the card */}
              <div
                onMouseDown={onResizeHeight}
                className="group/grip h-2 shrink-0 cursor-row-resize flex items-center justify-center border-t border-[#1e1f24] hover:bg-[#7c5cff]/10 transition-colors"
                title="Drag to resize"
              >
                <span className="w-7 h-[3px] rounded-full bg-[#26272d] group-hover/grip:bg-[#7c5cff] transition-colors" />
              </div>
              {/* Footer: file count + diff totals + primary actions */}
              <div className="flex items-center gap-2 px-[11px] py-2 border-t border-[#1e1f24]">
                <span className="text-[11px] font-mono tabular-nums flex items-center gap-2">
                  <span className="text-[#6b6e76]">{totalCount} file{totalCount === 1 ? '' : 's'}</span>
                  {(totalAdd > 0 || totalDel > 0) && (
                    <span className="flex items-center gap-1.5">
                      {totalAdd > 0 && <span className="text-[#5cc98c]">+{totalAdd}</span>}
                      {totalDel > 0 && <span className="text-[#e0808a]">−{totalDel}</span>}
                    </span>
                  )}
                </span>
                <div className="ml-auto flex gap-1.5">
                  {!vsMain && unstagedFiles.length > 0 && (
                    <button
                      onClick={stageAll}
                      className="text-[11px] font-semibold px-[11px] py-[5px] rounded-[7px] border border-[#26272d] text-[#9aa0a8] hover:text-[#e6e7ea] hover:border-[#3a3b40] transition-colors"
                    >
                      Stage all
                    </button>
                  )}
                  {onStartReview && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStartReview(); }}
                      className="text-[11px] font-semibold px-[11px] py-[5px] rounded-[7px] bg-[#7c5cff] text-white hover:bg-[#8e72ff] transition-colors"
                    >
                      Review
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </>
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
      <div className="flex items-center gap-1 py-[2px] px-2 text-[#c4c6cc] group">
        {hasChildren ? (
          <Button isIconOnly size="sm" variant="ghost" className="w-3 h-auto p-0 min-w-0 text-[#8a8c93]" onPress={() => setExpanded(e => !e)} aria-label="Toggle children">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </Button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
        <span className="truncate text-[11px] font-mono flex-1 cursor-pointer hover:text-[#e6e7ea]" onClick={() => onView?.(proc.command)}>{proc.command}</span>
        <span className="text-[10px] text-[#5e6068] shrink-0">{proc.pid}</span>
        {onView && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="h-auto p-0 min-w-0 text-[#5e6068] hover:text-[#e6e7ea] opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
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
          className="h-auto p-0 min-w-0 text-[#5e6068] hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0 ml-0.5 transition-opacity"
          onPress={() => onKill(proc.id)}
          aria-label="Kill process"
        >
          <X size={12} />
        </Button>
      </div>
      {expanded && proc.children.map(child => (
        <div key={child.pid} className="flex items-center gap-1 py-[1px] text-[#8a8c93] group" style={{ paddingLeft: 28 }}>
          <span className="text-[#5e6068] shrink-0 flex items-center"><CornerDownRight size={11} /></span>
          <span className="truncate text-[10px] font-mono flex-1">{child.command}</span>
          <span className="text-[9px] text-[#5e6068] shrink-0">{child.pid}</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="h-auto p-0 min-w-0 text-[#5e6068] hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0 ml-1 pr-2 transition-opacity"
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

function ProcessesSection({ client, sessionId, onViewTerminal, onCountChange }: { client: ClaudeClient | null; sessionId: string | null; onViewTerminal?: (command: string) => void; onCountChange?: (n: number) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!client || !sessionId) { setProcesses([]); onCountChange?.(0); return; }
    try {
      const procs = await client.listProcesses(sessionId);
      setProcesses(procs);
      onCountChange?.(procs.length);
    } catch { setProcesses([]); onCountChange?.(0); }
  }, [client, sessionId, onCountChange]);

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
    <div data-card="processes" className={CARD_CLS}>
      <CardHeader
        icon={<Terminal size={13} strokeWidth={1.9} />}
        iconColor="#5cc98c"
        title="Processes"
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
        meta={
          <span className="inline-flex items-center gap-[5px] h-[18px] px-2 rounded-md bg-[#191a1f] border border-[#1e1f24] text-[10px] font-mono text-[#9aa0a8]">
            <span className="w-[5px] h-[5px] rounded-full bg-[#5cc98c]" />
            {processes.length} running
          </span>
        }
      />
      {expanded && (
        <>
          <CardDivider />
          <div className="py-[5px]">
            {processes.map(proc => (
              <ProcessNode key={proc.id} proc={proc} onKill={handleKill} onView={onViewTerminal} />
            ))}
          </div>
        </>
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
    <div data-card="files" className={`${CARD_CLS} flex flex-col ${expanded ? '!flex-1 min-h-0' : ''}`}>
      <div
        className="group/hd flex items-center gap-[9px] w-full text-left h-[34px] px-[11px] hover:bg-white/[0.018] transition-colors shrink-0 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="flex text-[#4f525a] group-hover/hd:text-[#6b6e76] transition-colors shrink-0">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0 text-[#5aa6f0]">
          <FolderTree size={13} strokeWidth={1.9} />
        </span>
        <span className="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-[#9aa0a8] truncate">{label}</span>
        {rootPath && (
          <span
            className="ml-auto flex items-center gap-1 opacity-0 group-hover/hd:opacity-100 transition-opacity"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#9aa0a8] hover:bg-[#191a1f] transition-colors"
              onClick={() => onNewAtRoot('file')}
              aria-label="New file"
            >
              <FilePlus size={13} />
            </button>
            <button
              type="button"
              className="w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#9aa0a8] hover:bg-[#191a1f] transition-colors"
              onClick={() => onNewAtRoot('dir')}
              aria-label="New folder"
            >
              <FolderPlus size={13} />
            </button>
          </span>
        )}
      </div>
      {expanded && <CardDivider />}
      {expanded && (
        <div className="flex-1 overflow-y-auto py-[5px]">
          {!rootPath && (
            <p className="text-[11px] text-[#5e6068] px-3 py-4 text-center">No session active</p>
          )}
          {isCreatingAtRoot && (
            <div className="flex items-center gap-1 py-[2px]" style={{ paddingLeft: 8 }}>
              <span className="w-4 flex items-center justify-center shrink-0 text-[#8a8c93]">
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
  CLOSED: { dot: 'bg-zinc-500', text: 'text-[#8a8c93]' },
};

function PRsSection({ client, rootPath, sessionName, onCountChange }: { client: ClaudeClient | null; rootPath: string | null; sessionName?: string; onCountChange?: (n: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const cacheKey = rootPath || '';
  const [prs, setPrs] = useState<PRInfo[]>(() => prsCache.get(cacheKey) || []);

  useEffect(() => {
    if (!client || !rootPath) { setPrs([]); onCountChange?.(0); return; }
    // Instant from cache
    const cached = prsCache.get(rootPath);
    if (cached) { setPrs(cached); onCountChange?.(cached.length); }
    // Refresh in background
    client.listPullRequests(rootPath, sessionName).then(data => {
      prsCache.set(rootPath, data);
      setPrs(data);
      onCountChange?.(data.length);
    }).catch(() => { setPrs([]); onCountChange?.(0); });
  }, [client, rootPath, sessionName, onCountChange]);

  if (prs.length === 0) return null;

  return (
    <div data-card="prs" className={CARD_CLS}>
      <CardHeader
        icon={<GitPullRequest size={13} strokeWidth={1.9} />}
        iconColor="#56b6e8"
        title="Pull Requests"
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
        meta={<span className="text-[11px] font-semibold font-mono tabular-nums text-[#6b6e76]">{prs.length}</span>}
      />
      {expanded && (
        <>
          <CardDivider />
          <div className="py-[5px]">
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
                className="flex items-start gap-1.5 py-[3px] px-2 text-[#c4c6cc] hover:bg-[#1f2025] hover:text-[#e6e7ea] cursor-pointer transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${colors.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className={`text-[10px] shrink-0 ${colors.text}`}>#{pr.number}</span>
                    <span className="text-[11px] truncate">{pr.title}</span>
                  </div>
                  <span className="text-[10px] text-[#5e6068] font-mono truncate block">{pr.headRefName}</span>
                </div>
              </a>
            );
          })}
          </div>
        </>
      )}
    </div>
  );
}

function ToolsSection({ tools }: { tools: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 0) return null;

  return (
    <div data-card="tools" className={CARD_CLS}>
      <CardHeader
        icon={<Wrench size={13} strokeWidth={1.9} />}
        iconColor="#a78bfa"
        title="Tools"
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
        meta={<span className="text-[11px] font-semibold font-mono tabular-nums text-[#6b6e76]">{tools.length}</span>}
      />
      {expanded && (
        <>
          <CardDivider />
          <div className="px-[11px] py-2 flex flex-wrap gap-1 max-h-40 overflow-y-auto">
          {tools.map(tool => (
            <span key={tool} className="text-[10px] bg-[#191a1f] border border-[#1e1f24] text-[#9aa0a8] px-1.5 py-0.5 rounded font-mono">
              {tool}
            </span>
          ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Session-switcher header + inline collapsible session tree. Lives at the
 *  top of the explorer so the sidebar carries both "what session am I in"
 *  and "what files are in this session" — replacing the standalone session
 *  list panel on the left. */
function SessionSwitcherSection({
  sessions,
  activeSessionId,
  sessionStatuses,
  onSelectSession,
  onNewSession,
  tabGroups,
  tabGroupMap,
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses?: Record<string, ConnectionStatus>;
  onSelectSession: (id: string) => void;
  onNewSession?: () => void;
  tabGroups?: Record<string, SessionSwitcherGroup>;
  tabGroupMap?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = useMemo(
    () => sessions.find(s => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const { groups, ungrouped } = useMemo(() => {
    const byGroup = new Map<string, SessionInfo[]>();
    const orphans: SessionInfo[] = [];
    for (const s of sessions) {
      const gid = tabGroupMap?.[s.id];
      if (gid && tabGroups?.[gid]) {
        let arr = byGroup.get(gid);
        if (!arr) { arr = []; byGroup.set(gid, arr); }
        arr.push(s);
      } else {
        orphans.push(s);
      }
    }
    const grouped: { group: SessionSwitcherGroup; sessions: SessionInfo[] }[] = [];
    for (const [id, list] of byGroup) {
      const g = tabGroups?.[id];
      if (g) grouped.push({ group: g, sessions: list });
    }
    return { groups: grouped, ungrouped: orphans };
  }, [sessions, tabGroups, tabGroupMap]);

  const initial = (active?.name?.trim().charAt(0) || 'S').toUpperCase();

  return (
    <div className="shrink-0" style={{ borderBottom: `1px solid ${SW.border}` }}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
        style={{ background: SW.switcherBg, color: SW.text }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#181a1f'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = SW.switcherBg; }}
        title={active?.name || 'No session'}
        aria-expanded={expanded}
      >
        <span
          className="rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
          style={{ width: 22, height: 22, background: SW.accent, color: 'white' }}
        >
          {initial}
        </span>
        <span className="flex-1 flex flex-col min-w-0" style={{ lineHeight: 1.2 }}>
          <span
            className="text-[10px] font-semibold uppercase"
            style={{ color: SW.mutedDim, letterSpacing: '1.2px' }}
          >
            Session
          </span>
          <span className="text-[13px] font-semibold truncate" style={{ color: SW.text }}>
            {active?.name ?? 'No session'}
          </span>
        </span>
        <ChevronDown
          size={14}
          className="shrink-0"
          style={{
            color: SW.muted,
            transition: 'transform 0.15s',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {expanded && (
        <div
          style={{
            background: SW.treeBg,
            borderTop: `1px solid ${SW.border}`,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          <div
            className="flex items-center px-2 py-1 gap-1"
            style={{ borderBottom: `1px solid ${SW.border}` }}
          >
            <span
              className="pl-1 text-[10px] font-semibold uppercase"
              style={{ color: SW.mutedDim, letterSpacing: '1.2px' }}
            >
              All sessions
            </span>
            <span className="flex-1" />
            {onNewSession && (
              <button
                type="button"
                onClick={onNewSession}
                aria-label="New session"
                title="New session"
                className="flex items-center justify-center rounded transition-colors"
                style={{ width: 22, height: 22, color: SW.muted }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = '#25262b';
                  (e.currentTarget as HTMLElement).style.color = SW.text;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                  (e.currentTarget as HTMLElement).style.color = SW.muted;
                }}
              >
                <Plus size={13} />
              </button>
            )}
          </div>
          <div style={{ padding: '6px 0' }}>
            {groups.map(({ group, sessions: list }) => (
              <SessionGroupNode
                key={group.id}
                group={group}
                sessions={list}
                activeSessionId={activeSessionId}
                sessionStatuses={sessionStatuses}
                onSelectSession={onSelectSession}
              />
            ))}
            {ungrouped.map(s => (
              <SessionRow
                key={s.id}
                session={s}
                isActive={s.id === activeSessionId}
                status={sessionStatuses?.[s.id]}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
            {sessions.length === 0 && (
              <p className="text-[11px] text-center py-3" style={{ color: SW.mutedDim }}>
                No sessions yet
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionGroupNode({
  group,
  sessions,
  activeSessionId,
  sessionStatuses,
  onSelectSession,
}: {
  group: SessionSwitcherGroup;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses?: Record<string, ConnectionStatus>;
  onSelectSession: (id: string) => void;
}) {
  const hasActive = sessions.some(s => s.id === activeSessionId);
  const [expanded, setExpanded] = useState(hasActive);
  useEffect(() => { if (hasActive) setExpanded(true); }, [hasActive]);

  const dot = groupColorDot(group.color);

  return (
    <div>
      <div
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 cursor-pointer transition-colors"
        style={{
          padding: '5px 8px',
          margin: '0 6px',
          borderRadius: 5,
          color: SW.text,
          fontWeight: 600,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = SW.rowHover; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <span style={{ width: 12, color: SW.muted, fontSize: 10 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span
          className="rounded-full shrink-0"
          style={{ width: 7, height: 7, background: dot }}
        />
        <span className="flex-1 text-[12.5px] truncate">{group.name}</span>
        <span className="text-[10.5px] shrink-0" style={{ color: SW.muted }}>
          {sessions.length}
        </span>
      </div>
      {expanded && sessions.map(s => (
        <SessionRow
          key={s.id}
          session={s}
          isActive={s.id === activeSessionId}
          status={sessionStatuses?.[s.id]}
          onSelect={() => onSelectSession(s.id)}
          indent
        />
      ))}
    </div>
  );
}

function SessionRow({
  session,
  isActive,
  status,
  onSelect,
  indent,
}: {
  session: SessionInfo;
  isActive: boolean;
  status?: ConnectionStatus;
  onSelect: () => void;
  indent?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const bg = isActive ? SW.accentSoft : hover ? SW.rowHover : 'transparent';
  const color = isActive ? SW.accentText : SW.text;
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2 cursor-pointer"
      style={{
        padding: '5px 8px',
        paddingLeft: indent ? 26 : 8,
        margin: '0 6px',
        borderRadius: 5,
        background: bg,
        color,
        transition: 'background-color 0.1s',
      }}
    >
      <span
        className="rounded-full shrink-0"
        style={{
          width: 7,
          height: 7,
          background: isActive ? SW.accent : statusDotColor(status),
        }}
      />
      <span className="flex-1 text-[12.5px] truncate">{session.name}</span>
    </div>
  );
}

function statusDotColor(s?: ConnectionStatus): string {
  switch (s) {
    case 'connected': return SW.statusGreen;
    case 'connecting': return SW.statusYellow;
    case 'error': return SW.statusRed;
    default: return SW.mutedDim;
  }
}

function groupColorDot(color: string): string {
  switch (color) {
    case 'blue': return '#60a5fa';
    case 'green': return SW.statusGreen;
    case 'amber': return SW.statusYellow;
    case 'violet': return SW.accent;
    case 'red': return SW.statusRed;
    case 'pink': return '#f472b6';
    default: return SW.muted;
  }
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

/** One rail entry per card below. Presence is computed by the host so the rail
 *  only shows icons for cards that are actually rendered. */
interface RailItem { key: string; title: string; color: string; icon: React.ReactNode; badge?: number }

/** The icon rail — the former sidebar, now a card. A collapse toggle is pinned
 *  far-left (collapses every card down to just this rail); the rest are shortcuts
 *  to each card below. When collapsed only the toggle remains, stacked. */
function PanelRail({ collapsed, onToggleCollapse, items, onJump, searchActive, onToggleSearch }: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  items: RailItem[];
  onJump: (key: string) => void;
  searchActive: boolean;
  onToggleSearch: () => void;
}) {
  return (
    <div
      className={`rounded-[10px] border border-[#1e1f24] bg-[#141519] shrink-0 flex p-[5px] ${collapsed ? 'flex-col gap-[3px] items-center' : 'items-center gap-[3px]'}`}
    >
      <button
        onClick={onToggleCollapse}
        title={collapsed ? 'Expand panel' : 'Collapse panel'}
        aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
        className="relative w-[32px] h-[28px] rounded-[8px] flex items-center justify-center text-[#6b6e76] hover:text-[#e6e7ea] hover:bg-[#191a1f] transition-colors shrink-0"
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      {!collapsed && (
        <>
          <span className="w-px h-[16px] bg-[#1e1f24] mx-[3px] shrink-0" />
          {/* Search: a toggle, not a jump — its card replaces the others */}
          <button
            onClick={onToggleSearch}
            title="Search in files"
            aria-label="Search in files"
            className={`relative w-[32px] h-[28px] rounded-[8px] flex items-center justify-center transition-colors shrink-0 ${searchActive ? 'text-[#e6e7ea] bg-[#7c5cff]/[0.14]' : 'text-[#6b6e76] hover:text-[#9aa0a8] hover:bg-[#191a1f]'}`}
          >
            <Search size={15} />
            {searchActive && <span className="absolute bottom-[2px] left-1/2 -translate-x-1/2 w-[13px] h-[2px] rounded-full bg-current" />}
          </button>
          {items.map(it => (
            <button
              key={it.key}
              onClick={() => onJump(it.key)}
              title={it.title}
              aria-label={it.title}
              className="relative w-[32px] h-[28px] rounded-[8px] flex items-center justify-center text-[#6b6e76] hover:bg-[#191a1f] transition-colors shrink-0"
              style={{ color: it.color }}
            >
              {it.icon}
              {it.badge ? (
                <span
                  className="absolute top-0 right-[1px] min-w-[13px] h-[13px] px-[3px] rounded-[7px] text-[8.5px] font-bold font-mono flex items-center justify-center text-[#0b0c0e]"
                  style={{ background: it.color }}
                >
                  {it.badge}
                </span>
              ) : null}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

export const FileExplorer = memo(function FileExplorer({ client, rootPath, collapsed, onFileOpen, onFileDiff, onFileDiffFullView, gitModified, activeFilePath, activeDiffPath, changesCompare, onChangesCompareChange, baseBranch, activeSessionId, onOpenTerminal, onStartReview, onRefreshGit, tools, sessionName, searchActive = false, onSearchActiveChange, renderSearchCard, sessions, sessionStatuses, onSelectSession, onNewSession, tabGroups, tabGroupMap }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>(() => (rootPath ? filesCache.get(rootPath) : null) || []);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const dragging = useRef(false);

  const [menu, setMenu] = useState<MenuState>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<CreatingIn>(null);
  const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Rail state: whether the cards are collapsed down to just the rail, plus the
  // live counts the Processes / PRs cards report so the rail can badge them.
  const [cardsCollapsed, setCardsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('cardsCollapsed') === '1'; } catch { return false; }
  });
  const [processCount, setProcessCount] = useState(0);
  const [prCount, setPrCount] = useState(0);
  const cardsScrollRef = useRef<HTMLDivElement>(null);

  const toggleCardsCollapsed = useCallback(() => {
    setCardsCollapsed(v => {
      const next = !v;
      try { localStorage.setItem('cardsCollapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  const toggleSearch = useCallback(() => {
    onSearchActiveChange?.(!searchActive);
  }, [onSearchActiveChange, searchActive]);

  const jumpToCard = useCallback((card: string) => {
    // Leaving search first if it's covering the cards, then scroll once the
    // cards column has re-mounted.
    if (searchActive) onSearchActiveChange?.(false);
    requestAnimationFrame(() => {
      cardsScrollRef.current?.querySelector(`[data-card="${card}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [searchActive, onSearchActiveChange]);

  const railItems: RailItem[] = useMemo(() => {
    const changesCount = new Set([...gitModified.staged, ...gitModified.unstaged]).size;
    const items: RailItem[] = [
      { key: 'changes', title: 'Changes', color: MODIFIED_COLOR, icon: <GitBranch size={16} />, badge: changesCount || undefined },
    ];
    if (processCount > 0) items.push({ key: 'processes', title: 'Processes', color: '#5cc98c', icon: <Terminal size={15} />, badge: processCount });
    if (prCount > 0) items.push({ key: 'prs', title: 'Pull Requests', color: '#56b6e8', icon: <GitPullRequest size={15} />, badge: prCount });
    if ((tools?.length ?? 0) > 0) items.push({ key: 'tools', title: 'Tools', color: '#a78bfa', icon: <Wrench size={15} /> });
    items.push({ key: 'files', title: 'Files', color: '#5aa6f0', icon: <FolderTree size={15} /> });
    return items;
  }, [gitModified.staged, gitModified.unstaged, processCount, prCount, tools]);

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

  // Live tree updates from the session file watcher. Each structural change
  // (add/remove of a file or dir — content edits don't change the listing)
  // invalidates the parent directory's cache via refreshDir, which re-fetches
  // any mounted DirNode (or root) and clears collapsed ones so they re-load
  // fresh on next expand. Git status is refreshed too so the Changes section
  // and per-file tints stay in sync.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; changes: { kind: string; path: string }[] }>).detail;
      if (!detail || detail.sessionId !== activeSessionId || !rootPath) return;
      const dirs = new Set<string>();
      for (const c of detail.changes) {
        if (c.kind === 'change') continue;
        dirs.add(pathDirname(pathJoin(rootPath, c.path)));
      }
      if (dirs.size === 0) return;
      dirs.forEach(d => refreshDir(d));
      onRefreshGit?.();
    };
    window.addEventListener('file_changes', handler);
    return () => window.removeEventListener('file_changes', handler);
  }, [activeSessionId, rootPath, onRefreshGit]);

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
    activeFilePath: activeFilePath ?? null,
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
        className={`relative bg-[#0e0f12] flex flex-col shrink-0 min-h-0 overflow-hidden select-none ${collapsed ? 'w-0' : ''}`}
        style={collapsed ? undefined : { width: cardsCollapsed ? 50 : sidebarWidth }}
      >
        {/* Resize handle (hidden while collapsed — width is fixed) */}
        {!collapsed && !cardsCollapsed && (
          <div
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-[#7c5cff]/40 active:bg-[#7c5cff]/60 transition-colors"
            onMouseDown={onResizeStart}
          />
        )}
        {/* Session switcher (replaces the standalone session sidebar when
            wired up by the host). When sessions aren't passed in the panel
            simply opens straight into the cards — no header bar, no divider. */}
        {sessions && onSelectSession && !cardsCollapsed && (
          <SessionSwitcherSection
            sessions={sessions}
            activeSessionId={activeSessionId}
            sessionStatuses={sessionStatuses}
            onSelectSession={onSelectSession}
            onNewSession={onNewSession}
            tabGroups={tabGroups}
            tabGroupMap={tabGroupMap}
          />
        )}

        {/* Icon rail — the former sidebar, now a card. Always present so the
            collapse toggle survives even when every card is hidden. */}
        <div className="p-[7px] shrink-0">
          <PanelRail
            collapsed={cardsCollapsed}
            onToggleCollapse={toggleCardsCollapsed}
            items={railItems}
            onJump={jumpToCard}
            searchActive={searchActive}
            onToggleSearch={toggleSearch}
          />
        </div>

        {/* Search card replaces the other cards while active. */}
        {!cardsCollapsed && searchActive && renderSearchCard && (
          <div className="flex-1 min-h-0 flex flex-col px-[7px] pb-[7px]">
            {renderSearchCard(() => onSearchActiveChange?.(false))}
          </div>
        )}

        {/* Cards column: each section is an independent, collapsible card
            anchored to this hide/show panel. The panel-level scroll keeps the
            cards spaced over the base canvas; the file-tree card grows to fill. */}
        {!cardsCollapsed && !searchActive && (
          <div ref={cardsScrollRef} className="flex-1 min-h-0 flex flex-col gap-[7px] px-[7px] pb-[7px] overflow-y-auto">
            {/* Processes */}
            <ProcessesSection client={client} sessionId={activeSessionId} onViewTerminal={onOpenTerminal} onCountChange={setProcessCount} />

            {/* Changes */}
            <ChangesSection gitModified={gitModified} rootPath={rootPath} onFileDiff={onFileDiff || onFileOpen} onFileDiffFullView={onFileDiffFullView} onStartReview={onStartReview} client={client} onRefresh={onRefreshGit || (() => {})} activeDiffPath={activeDiffPath ?? null} compareMode={changesCompare ?? 'uncommitted'} onCompareModeChange={onChangesCompareChange} baseBranch={baseBranch} />

            {/* Pull Requests */}
            <PRsSection client={client} rootPath={rootPath} sessionName={sessionName} onCountChange={setPrCount} />

            {/* Tools */}
            <ToolsSection tools={tools || []} />

            {/* File tree (collapsible) — grows to fill remaining panel height */}
            <FileTreeSection rootPath={rootPath} entries={entries} onNewAtRoot={handleNewAtRoot} />
          </div>
        )}

        {/* Right-click context menu */}
        {menu && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={closeMenu}
              onContextMenu={e => { e.preventDefault(); closeMenu(); }}
            />
            <div
              className="fixed z-50 bg-surface border border-[#2a2b30]-light rounded-lg shadow-xl min-w-[200px] py-1"
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
    : 'text-[#c4c6cc] hover:bg-surface-light hover:text-[#e6e7ea]';
  return (
    <Button variant="ghost" fullWidth className={`${base} ${tone}`} onPress={onClick}>
      <span className="w-3 flex items-center justify-center shrink-0 opacity-70">{icon}</span>
      {label}
    </Button>
  );
}
