import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown, ChevronRight, Search, Archive, X, Pin, History, Plus,
  type LucideIcon,
} from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';
import { ICON_MAP, ICON_MAP_QUICK } from '../lib/group-icons';

type TabGroup = { id: string; name: string; color: string; cwd?: string; icon?: string };

interface Props {
  sessions: SessionInfo[];
  closedSessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  sessionStreaming: Record<string, boolean>;
  /** Per-session "previous turn died without onTurnComplete" flag.
   *  Drives the red dot — last turn was interrupted. */
  sessionInterrupted: Record<string, boolean>;
  sessionHasPermission: Record<string, boolean>;
  sessionTurnComplete: Set<string>;
  /** Per-session timestamp (epoch ms) of the most recent message — used to
   *  render a "5m ago" hint inside vertical tabs. */
  sessionLastMessageAt?: Record<string, number>;
  /** Sessions pinned to the top of their group. Pinned tabs always sort
   *  above non-pinned ones regardless of last-message recency. */
  pinnedSessionIds?: Set<string>;
  /** Toggle pin state for a session. Persisted globally in preferences. */
  onTogglePin?: (sessionId: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onReopen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (fromId: string, toId: string) => void;
  tabGroups: Record<string, TabGroup>;
  tabGroupMap: Record<string, string>;
  /** Per-group remote affiliation. When every member of a group sits on the
   *  same remote, the group header shows a pill in the remote's color. */
  groupRemoteInfo?: Record<string, { remoteId: string; remoteName: string | null; remoteColor: string | null }>;
  expandedGroupIds: Set<string>;
  onCreateGroup: (tabIds: string[]) => void;
  onGroupTabs: (a: string, b: string) => void;
  onAddToGroup: (tabId: string, groupId: string) => void;
  onUngroupTab: (tabId: string) => void;
  onToggleGroup: (groupId: string) => void;
  /** Focus a group without toggling its expansion state. Triggered by the
   *  hover "+" icon on a group header — opens GroupComposer in the main
   *  pane and ensures the group is expanded so members stay visible. */
  onSelectGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onChangeGroupColor: (groupId: string, color: string) => void;
  onChangeGroupIcon?: (groupId: string, icon: string | null) => void;
  /** Create a new session in the group's saved cwd, then add it to the group. */
  onNewSessionInGroup?: (groupId: string) => void;
  /** Open the worktree creation flow for the group's repo, then spawn a
   *  session in the resulting worktree path and add it to the group. */
  onNewSessionInWorktreeForGroup?: (groupId: string) => void;
  /** Move a closed session into the archived bucket. The archive icon next
   *  to each row in the "+" dropdown's CLOSED section calls this — the
   *  session disappears from the dropdown, history is kept, and it can be
   *  permanently deleted later from the archived-sessions management page. */
  onArchiveSession?: (sessionId: string) => void;
  /** Open the destructive-delete confirmation flow for a session. The host
   *  is responsible for showing the confirm modal (with worktree checkbox
   *  and uncommitted-changes warning) and calling the purge API. */
  onRequestDelete?: (sessionId: string) => void;
  /** Open the destructive-delete confirmation flow for an entire group —
   *  the group itself plus every session that belongs to it. Host shows the
   *  confirm modal and purges members. */
  onRequestDeleteGroup?: (groupId: string) => void;
  /** Accent-color controls. `accentPalette` is the swatch set; `getSessionAccent`
   *  resolves a session's current accent; `onPickSessionAccent` sets/clears an
   *  override (null = reset to auto). Only wired when chat-coloring is enabled. */
  accentPalette?: string[];
  getSessionAccent?: (sessionId: string) => string;
  onPickSessionAccent?: (sessionId: string, color: string | null) => void;
  /** When true, the session bar collapses to a thin strip showing only the
   *  toggle icon. When false, the full vertical sidebar is rendered. */
  collapsed?: boolean;
  /** Click handler for the top-left collapse toggle button. */
  onToggleCollapsed?: () => void;
}

const COLOR_MAP: Record<string, { dot: string; bg: string; border: string; ring: string; text: string }> = {
  blue:   { dot: 'bg-blue-400',   bg: 'bg-blue-500/8',   border: 'border-blue-400/25', ring: 'ring-blue-400/40', text: 'text-blue-400' },
  green:  { dot: 'bg-green-400',  bg: 'bg-green-500/8',  border: 'border-green-400/25', ring: 'ring-green-400/40', text: 'text-green-400' },
  amber:  { dot: 'bg-amber-400',  bg: 'bg-amber-500/8',  border: 'border-amber-400/25', ring: 'ring-amber-400/40', text: 'text-amber-400' },
  violet: { dot: 'bg-violet-400', bg: 'bg-violet-500/8', border: 'border-violet-400/25', ring: 'ring-violet-400/40', text: 'text-violet-400' },
  red:    { dot: 'bg-red-400',    bg: 'bg-red-500/8',    border: 'border-red-400/25', ring: 'ring-red-400/40', text: 'text-red-400' },
  pink:   { dot: 'bg-pink-400',   bg: 'bg-pink-500/8',   border: 'border-pink-400/25', ring: 'ring-pink-400/40', text: 'text-pink-400' },
};

/**
 * Compact relative-time formatter for tab age labels — "now", "5m", "2h",
 * "3d", "4w". Returns empty string for missing/zero timestamps so callers
 * can hide the chip cleanly.
 */
function formatTabAge(ts: number | undefined, now: number): string {
  if (!ts) return '';
  const diffMs = Math.max(0, now - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45)        return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60)        return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24)         return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7)         return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5)          return `${wk}w`;
  const mo = Math.floor(day / 30);
  return `${mo}mo`;
}

function getDotClass(connStatus: string, isStreaming: boolean, turnComplete: boolean, wasInterrupted: boolean): string {
  if (connStatus === 'error') return 'bg-red-400';
  if (connStatus === 'connecting') return 'bg-amber-400 animate-pulse';
  if (turnComplete) return 'bg-green-400 animate-pulse';
  if (connStatus === 'connected' && isStreaming) return 'bg-amber-400 animate-pulse';
  // "Last turn died without onTurnComplete" — solid red so the user
  // notices the failure (instead of staring at a stale orange forever).
  // Cleared the moment they start a new turn.
  if (wasInterrupted) return 'bg-red-400';
  if (connStatus === 'connected') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

function SortableTab({ id, session, isActive, connStatus, isStreaming, wasInterrupted, turnComplete, hasPermission, groupColor: _groupColor, compact, ageLabel, isPinned, editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose, onContextMenu }: {
  id: string; session: SessionInfo; isActive: boolean; connStatus: string; isStreaming: boolean; wasInterrupted: boolean; turnComplete?: boolean; hasPermission: boolean; groupColor?: string; compact?: boolean;
  ageLabel?: string;
  isPinned?: boolean;
  editingId: string | null; editName: string; editRef: React.RefObject<HTMLInputElement | null>;
  setEditName: (v: string) => void; startRename: (s: SessionInfo) => void; commitRename: () => void; setEditingId: (id: string | null) => void;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: editingId === session.id });
  // Vertical sidebar: flat active background regardless of group color.
  const activeBg = isActive ? 'bg-surface-light' : '';
  // Remote sessions get a left-edge tint in the remote's color (decided in
  // REMOTES_TASKS.md, Phase 7.1 — borderless, no icon, just the strip).
  const remoteColor = session.remoteColor || null;
  const remoteEdgeClass = remoteColor ? (COLOR_MAP[remoteColor]?.border ?? '') : '';
  const remoteTintClass = remoteColor ? (COLOR_MAP[remoteColor]?.bg ?? '') : '';
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes} {...listeners}
      className={`tab-item group relative flex items-center gap-1.5 px-3 ${compact ? 'h-[26px]' : 'h-[30px]'} text-[12px] cursor-pointer w-full rounded-md transition-colors ${
        remoteColor ? `border-l-2 ${remoteEdgeClass} ${remoteTintClass}` : ''
      } ${
        isActive ? `${activeBg} text-zinc-200` : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
      }`}
      onClick={() => onSelect(session.id)}
      onContextMenu={onContextMenu}
      title={session.remoteName ? `Remote: ${session.remoteName}` : undefined}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(connStatus, isStreaming, !!turnComplete, wasInterrupted)}`} />
      {editingId === session.id ? (
        <TextField value={editName} onChange={setEditName} aria-label="Rename tab" className="w-full min-w-0">
          <Input
            ref={editRef}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
            onBlur={commitRename}
            className="bg-transparent border-0 px-0 py-0 text-[12px] text-zinc-200"
          />
        </TextField>
      ) : (
        <span className="truncate flex-1" onDoubleClick={e => { e.stopPropagation(); startRename(session); }}>{session.name}</span>
      )}
      {/* Pinned indicator — small filled pin next to the name. Hidden while
          renaming so the input has room to breathe. */}
      {isPinned && editingId !== session.id && (
        <Pin
          size={10}
          strokeWidth={2.25}
          className="shrink-0 text-zinc-500 fill-current"
          aria-label="Pinned to top"
        />
      )}
      {/* Age chip — only shown on inactive tabs, replaced by close button on hover. */}
      {ageLabel && editingId !== session.id && !isActive && (
        <span
          className="shrink-0 text-[10px] tabular-nums text-zinc-600 group-hover:hidden"
          title={`Last activity ${ageLabel} ago`}
        >
          {ageLabel}
        </span>
      )}
      <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} className={`shrink-0 ${
        isActive ? 'flex' : 'hidden group-hover:flex'
      }`}>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={() => onClose(session.id)}
          aria-label="Close (keeps history)"
          className={`w-4 h-4 min-w-0 p-0 items-center justify-center rounded-sm leading-none transition-colors ${
            isActive ? 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-light' : 'text-zinc-600 hover:text-zinc-300 hover:bg-surface-light'
          }`}
        >
          <X size={12} strokeWidth={2} />
        </Button>
      </span>
      {hasPermission && !isActive && (
        <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500 border border-[#131418]" />
        </span>
      )}
    </div>
  );
}

function SortableGroupTab({ group, memberCount, isExpanded, hasActive, hasActivity, remoteName, remoteColor, onToggle, onRename, onMenuOpen, onOpenComposer }: {
  group: TabGroup; memberCount: number; isExpanded: boolean; hasActive: boolean; hasActivity?: boolean;
  remoteName?: string | null; remoteColor?: string | null;
  onToggle: () => void; onRename: (name: string) => void; onMenuOpen: (x: number, y: number) => void;
  onOpenComposer: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isOver } = useSortable({ id: `group::${group.id}` });
  const colors = COLOR_MAP[group.color] || COLOR_MAP.blue!;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  // Vertical sidebar: drop the filled background and border — the colored dot
  // alone is enough, keeping the sidebar visually clean (Arc/Zen style).
  const baseCls = `group relative flex items-center gap-1.5 px-2 h-[28px] text-[12px] cursor-pointer rounded-md transition-colors ${isOver ? `ring-1 ${colors.ring}` : ''} hover:bg-surface/60 ${hasActive && !isExpanded ? 'text-zinc-200' : 'text-zinc-400'}`;

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes} {...listeners}
      className={baseCls}
      onClick={onToggle}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        onMenuOpen(e.clientX, e.clientY);
      }}
    >
      {isExpanded
        ? <ChevronDown size={12} className="shrink-0 text-zinc-500" />
        : <ChevronRight size={12} className="shrink-0 text-zinc-500" />}
      {/* Group icon (when set) takes the dot's slot — coloured with the
         group's accent. Falls back to the original colored dot for groups
         without an icon. */}
      {(() => {
        const Icon = group.icon ? ICON_MAP[group.icon] : null;
        if (Icon) {
          return (
            <Icon
              size={12}
              className={`shrink-0 ${colors.text} ${hasActivity ? 'animate-pulse' : ''}`}
              strokeWidth={2.25}
            />
          );
        }
        return (
          <span className={`w-2 h-2 rounded-full shrink-0 ${colors.dot} ${hasActivity ? 'animate-pulse' : ''}`} />
        );
      })()}
      {editing ? (
        <TextField value={name} onChange={setName} aria-label="Group name" className="w-16 min-w-0">
          <Input
            ref={inputRef}
            onKeyDown={e => { if (e.key === 'Enter') { onRename(name); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
            onBlur={() => { onRename(name); setEditing(false); }}
            onClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
            className="bg-transparent border-0 px-0 py-0 text-[12px] text-zinc-200"
          />
        </TextField>
      ) : (
        <span className="text-[12px] truncate flex-1" onDoubleClick={e => { e.stopPropagation(); setEditing(true); setName(group.name); }}>
          {group.name}
        </span>
      )}
      {remoteName && (
        <span
          className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded border shrink-0"
          style={{
            color: remoteColor || '#a78bfa',
            background: `${remoteColor || '#a78bfa'}14`,
            borderColor: `${remoteColor || '#a78bfa'}40`,
            lineHeight: 1,
          }}
          title={`Remote: ${remoteName}`}
        >
          {remoteName}
        </span>
      )}
      <span className="text-[11px] text-zinc-600">{memberCount}</span>
      {/* New session in group — opens GroupComposer for this group.
       *  Right-click on the row still surfaces the full options menu
       *  (color/icon/delete/etc.) via `onMenuOpen`. */}
      <span
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="shrink-0"
        title="New session in group"
      >
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="New session in group"
          className="w-4 h-4 min-w-0 p-0 flex items-center justify-center rounded-sm leading-none text-zinc-600 hover:text-zinc-300 hover:bg-surface-light transition-opacity opacity-0 group-hover:opacity-100"
          onPress={onOpenComposer}
        >
          <Plus size={12} />
        </Button>
      </span>
    </div>
  );
}

function IconPicker({ currentIcon, currentColor, onSelect, onClear }: {
  currentIcon: string | undefined;
  currentColor: string;
  onSelect: (key: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const colorCls = (COLOR_MAP[currentColor] || COLOR_MAP.blue!).text;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return Object.entries(ICON_MAP);
    return Object.entries(ICON_MAP).filter(([key]) => key.includes(q));
  }, [query]);

  const renderIconButton = (key: string, Icon: LucideIcon) => {
    const isActive = currentIcon === key;
    return (
      <Button
        key={key}
        isIconOnly
        size="sm"
        variant="ghost"
        className={`w-6 h-6 min-w-0 p-0 flex items-center justify-center rounded-md transition-colors ${
          isActive ? `bg-surface-light ring-1 ring-white/20 ${colorCls}` : 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-light'
        }`}
        onPress={() => onSelect(key)}
        aria-label={key}
      >
        <Icon size={12} strokeWidth={2.25} />
      </Button>
    );
  };

  return (
    <div>
      <div className="text-[10px] text-zinc-600 mb-1 flex items-center justify-between">
        <span>Icon</span>
        {currentIcon && (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto px-1 py-0 min-w-0 text-[10px] text-zinc-500 hover:text-zinc-300"
            onPress={onClear}
            aria-label="Clear icon (use colored dot)"
          >
            Clear
          </Button>
        )}
      </div>

      {!expanded ? (
        <>
          <div className="grid grid-cols-6 gap-1">
            {Object.entries(ICON_MAP_QUICK).map(([k, I]) => renderIconButton(k, I))}
          </div>
          <Button
            variant="ghost"
            fullWidth
            onPress={() => setExpanded(true)}
            className="mt-1.5 flex items-center justify-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 py-1 h-auto rounded hover:bg-surface-light transition-colors"
          >
            <Search size={10} />
            Browse all icons…
          </Button>
        </>
      ) : (
        <>
          <div className="relative mb-1.5">
            <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600 z-10" />
            <TextField
              value={query}
              onChange={setQuery}
              aria-label="Search icons"
              autoFocus
            >
              <Input
                placeholder="Search icons…"
                className="pl-6 pr-2 py-1 text-[11px]"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </TextField>
          </div>
          <div className="grid grid-cols-6 gap-1 max-h-48 overflow-y-auto">
            {filtered.map(([k, I]) => renderIconButton(k, I))}
            {filtered.length === 0 && (
              <div className="col-span-6 text-[11px] text-zinc-600 text-center py-2">
                No icons match "{query}"
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            fullWidth
            onPress={() => { setExpanded(false); setQuery(''); }}
            className="mt-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 py-1 h-auto rounded hover:bg-surface-light transition-colors"
          >
            ← Back to favorites
          </Button>
        </>
      )}
    </div>
  );
}

export const TabBar = memo(function TabBar(props: Props) {
  const { sessions, closedSessions, activeSessionId, sessionStatuses, sessionStreaming, sessionInterrupted, sessionHasPermission, sessionLastMessageAt,
    pinnedSessionIds, onTogglePin,
    onSelect, onNew, onClose, onReopen, onRename, onReorder,
    tabGroups, tabGroupMap, groupRemoteInfo, expandedGroupIds, sessionTurnComplete, onCreateGroup, onGroupTabs, onAddToGroup, onToggleGroup, onSelectGroup, onRenameGroup, onChangeGroupColor, onChangeGroupIcon, onNewSessionInGroup, onNewSessionInWorktreeForGroup, onArchiveSession, onRequestDelete, onRequestDeleteGroup,
    accentPalette, getSessionAccent, onPickSessionAccent,
    collapsed, onToggleCollapsed } = props;

  // Tick once a minute so age labels refresh from "1m" → "2m" → … without
  // every other parent re-render (memoized parent + memoized TabBar).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Vertical-mode panel width — persisted to localStorage, drag-resizable
  // via the right-edge handle. Clamped to a comfortable range.
  const VERT_WIDTH_MIN = 160;
  const VERT_WIDTH_MAX = 480;
  const VERT_WIDTH_DEFAULT = 208; // matches the previous w-52
  const [vertWidth, setVertWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return VERT_WIDTH_DEFAULT;
    try {
      const raw = localStorage.getItem('tabBarVertWidth');
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n)) return Math.max(VERT_WIDTH_MIN, Math.min(VERT_WIDTH_MAX, n));
    } catch {}
    return VERT_WIDTH_DEFAULT;
  });
  // Track active resize so we can suppress text-selection cursor flickers
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<{ pointerX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!resizing) return;
    // Force a global resize cursor + suppress text selection while dragging
    // — otherwise the cursor flickers back to text-select over chat content.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const next = Math.max(VERT_WIDTH_MIN, Math.min(VERT_WIDTH_MAX, start.startWidth + (e.clientX - start.pointerX)));
      setVertWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      resizeStartRef.current = null;
      try { localStorage.setItem('tabBarVertWidth', String(vertWidth)); } catch {}
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing, vertWidth]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [restoreSearch, setRestoreSearch] = useState('');
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const shiftRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreSearchRef = useRef<HTMLInputElement>(null);

  // Reset the search box every time the restore popover is reopened, and focus
  // it so the user can immediately filter without an extra click.
  useEffect(() => {
    if (showMenu) {
      setRestoreSearch('');
      // Defer until the popover has actually mounted in the DOM.
      requestAnimationFrame(() => restoreSearchRef.current?.focus());
    }
  }, [showMenu]);

  const filteredClosedSessions = useMemo(() => {
    const q = restoreSearch.trim().toLowerCase();
    if (!q) return closedSessions;
    return closedSessions.filter(s => s.name.toLowerCase().includes(q));
  }, [closedSessions, restoreSearch]);
  const editRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => { if (editingId && editRef.current) { editRef.current.focus(); editRef.current.select(); } }, [editingId]);
  const startRename = (s: SessionInfo) => { setEditingId(s.id); setEditName(s.name); };
  const commitRename = () => { if (editingId && editName.trim()) onRename(editingId, editName.trim()); setEditingId(null); };

  // Build render structure
  const renderedGroups = new Set<string>();
  const sortableItems: string[] = [];
  type RenderItem = { type: 'tab'; session: SessionInfo } | { type: 'group'; groupId: string; members: SessionInfo[] };
  const renderList: RenderItem[] = [];

  for (const s of sessions) {
    const gid = tabGroupMap[s.id];
    if (gid && tabGroups[gid]) {
      if (!renderedGroups.has(gid)) {
        renderedGroups.add(gid);
        // Sort group members: pinned sessions first (in tabOrder), then the
        // rest by last-message recency (newest at top). Falls back to the
        // existing tabOrder position when timestamps are missing or equal so
        // the order stays stable across renders.
        const members = sessions
          .filter(m => tabGroupMap[m.id] === gid)
          .slice()
          .sort((a, b) => {
            const pa = pinnedSessionIds?.has(a.id) ? 1 : 0;
            const pb = pinnedSessionIds?.has(b.id) ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const ta = sessionLastMessageAt?.[a.id] || 0;
            const tb = sessionLastMessageAt?.[b.id] || 0;
            if (tb !== ta) return tb - ta;
            return sessions.indexOf(a) - sessions.indexOf(b);
          });
        sortableItems.push(`group::${gid}`);
        if (expandedGroupIds.has(gid)) members.forEach(m => sortableItems.push(m.id));
        renderList.push({ type: 'group', groupId: gid, members });
      }
    } else {
      sortableItems.push(s.id);
      renderList.push({ type: 'tab', session: s });
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromId = String(active.id);
    const overId = String(over.id);

    // Dropped on group header → add to group
    if (overId.startsWith('group::')) {
      onAddToGroup(fromId, overId.replace('group::', ''));
      return;
    }

    // Shift held → create/add to group
    if (shiftRef.current) {
      const targetGroupId = tabGroupMap[overId];
      if (targetGroupId) {
        onAddToGroup(fromId, targetGroupId);
      } else {
        onGroupTabs(fromId, overId);
      }
      return;
    }

    // Default: reorder
    onReorder(fromId, overId);
  };

  const tp = (s: SessionInfo, groupColor?: string, compact?: boolean) => ({
    id: s.id, session: s, isActive: s.id === activeSessionId,
    connStatus: sessionStatuses[s.id] || 'disconnected',
    isStreaming: sessionStreaming[s.id] || false,
    wasInterrupted: sessionInterrupted[s.id] || false,
    turnComplete: sessionTurnComplete.has(s.id),
    hasPermission: sessionHasPermission[s.id] || false,
    groupColor, compact,
    ageLabel: formatTabAge(sessionLastMessageAt?.[s.id], nowMs),
    isPinned: pinnedSessionIds?.has(s.id) || false,
    editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setTabMenu({ tabId: s.id, x: e.clientX, y: e.clientY }); },
  });

  // Shared body of the restore-closed-sessions popover. Used in both the
  // collapsed and expanded toolbar branches so the search-on-top + filtered
  // list behaviour stays identical.
  const renderRestorePopover = () => (
    <>
      <div className="px-2 pb-1 pt-0.5 shrink-0">
        <div className="flex items-center gap-1.5 bg-[#131418] border border-border rounded-md px-2 h-7">
          <Search size={11} className="text-zinc-600 shrink-0" />
          <input
            ref={restoreSearchRef}
            type="text"
            value={restoreSearch}
            onChange={(e) => setRestoreSearch(e.target.value)}
            placeholder="Search closed sessions…"
            className="flex-1 bg-transparent text-[12px] text-zinc-300 placeholder:text-zinc-600 outline-none border-0 min-w-0"
          />
        </div>
      </div>
      <div className="h-px bg-border mx-2 my-1 shrink-0" />
      <div className="overflow-y-auto flex-1">
        {filteredClosedSessions.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-zinc-600 text-center">
            {closedSessions.length === 0 ? 'No closed sessions' : 'No matches'}
          </div>
        ) : (
          filteredClosedSessions.map(s => (
            <div
              key={s.id}
              className="group/arch w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors cursor-pointer"
              onClick={() => { setShowMenu(false); onReopen(s.id); }}
              title="Click to reopen"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
              <span className="truncate flex-1">{s.name}</span>
              <span className="text-[10px] text-zinc-600 shrink-0 font-mono group-hover/arch:hidden">{s.cwd.split('/').pop()}</span>
              {onArchiveSession && (
                <span onClick={(e) => e.stopPropagation()} className="hidden group-hover/arch:flex shrink-0">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => onArchiveSession(s.id)}
                    className="w-5 h-5 min-w-0 p-0 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface transition-colors"
                    aria-label="Archive (hide from this list, keeps history)"
                  >
                    <Archive size={11} strokeWidth={2} />
                  </Button>
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );

  // The collapse toggle now lives in the host's activity bar (see ChatApp),
  // not inside the TabBar — keeping all chrome-toggle affordances in one
  // column avoids two places to click for the same thing.

  // Collapsed: render nothing. The host's activity bar carries the
  // re-expand toggle plus the new-session / history affordances, so a
  // collapsed TabBar would just duplicate that column.
  if (collapsed) return null;

  return (
    <div
      className="tab-bar relative flex flex-col bg-[#131418] shrink-0 select-none h-full border-r border-border"
      style={{ width: vertWidth }}
    >
      {/* Right-edge drag handle for resizing the panel. Sits absolutely on the
          right border so it's always reachable and doesn't take layout space. */}
      <div
        className={`absolute top-0 right-0 h-full w-1 cursor-ew-resize z-10 hover:bg-indigo-400/40 transition-colors ${resizing ? 'bg-indigo-400/60' : ''}`}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          resizeStartRef.current = { pointerX: e.clientX, startWidth: vertWidth };
          setResizing(true);
        }}
        title="Drag to resize"
      />
      <div className="flex flex-col gap-0.5 px-2 py-2 overflow-y-auto flex-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
            {renderList.map(item => {
              if (item.type === 'tab') return <SortableTab key={item.session.id} {...tp(item.session)} />;

              const group = tabGroups[item.groupId]!;
              const colors = COLOR_MAP[group.color] || COLOR_MAP.blue!;
              const isExpanded = expandedGroupIds.has(item.groupId);
              const hasActive = item.members.some(m => m.id === activeSessionId);

              const remote = groupRemoteInfo?.[item.groupId];
              return (
                <div key={`grp-${item.groupId}`} className="flex flex-col gap-0.5">
                  <SortableGroupTab
                    group={group} memberCount={item.members.length} isExpanded={isExpanded} hasActive={hasActive}
                    hasActivity={!isExpanded && item.members.some(m => sessionHasPermission[m.id])}
                    remoteName={remote?.remoteName ?? null}
                    remoteColor={remote?.remoteColor ?? null}
                    onToggle={() => onToggleGroup(item.groupId)}
                    onRename={name => onRenameGroup(item.groupId, name)}
                    onMenuOpen={(x, y) => setGroupMenu({ groupId: item.groupId, x, y })}
                    onOpenComposer={() => onSelectGroup(item.groupId)}
                  />
                  {isExpanded && (
                    // Indent + colored left rail spans the full height of all
                    // child tabs (whatever that ends up being via gap-0.5).
                    <div className={`flex flex-col gap-0.5 pl-2 ml-3 border-l-2 ${colors.border}`}>
                      {item.members.map(m => <SortableTab key={m.id} {...tp(m, group.color, true)} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {/* Group dropdown menu */}
      {groupMenu && (() => {
        const grp = tabGroups[groupMenu.groupId];
        // Use the stored cwd, or fall back to the first member's cwd for
        // legacy groups that pre-date the cwd field. The fallback is what
        // makes "New session in group" appear for groups created before
        // this feature shipped.
        const firstMember = sessions.find(s => tabGroupMap[s.id] === groupMenu.groupId);
        const grpCwd = grp?.cwd || firstMember?.cwd || '';
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setGroupMenu(null)} />
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[200px] py-1"
              style={{ top: groupMenu.y, left: groupMenu.x }}>
              {grpCwd && (
                <div className="px-3 py-1 text-[10px] text-zinc-600 truncate font-mono" title={grpCwd}>
                  📁 {grpCwd.split('/').slice(-2).join('/') || grpCwd}
                </div>
              )}
              <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onPress={() => { onToggleGroup(groupMenu.groupId); setGroupMenu(null); }}>
                {expandedGroupIds.has(groupMenu.groupId) ? 'Collapse' : 'Expand'}
              </Button>
              <div className="px-3 py-1.5">
                <div className="text-[10px] text-zinc-600 mb-1">Color</div>
                <div className="flex items-center gap-1">
                  {Object.entries(COLOR_MAP).map(([key, c]) => (
                    <Button key={key}
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={`Color ${key}`}
                      className={`w-4 h-4 min-w-0 p-0 rounded-full ${c.dot} transition-transform ${tabGroups[groupMenu.groupId]?.color === key ? 'ring-2 ring-white/40 scale-110' : 'hover:scale-110'}`}
                      onPress={() => { onChangeGroupColor(groupMenu.groupId, key); setGroupMenu(null); }}
                    />
                  ))}
                </div>
              </div>
              {onChangeGroupIcon && (
                <div className="px-3 py-1.5">
                  <IconPicker
                    currentIcon={grp?.icon}
                    currentColor={grp?.color || 'blue'}
                    onSelect={(key) => { onChangeGroupIcon(groupMenu.groupId, key); }}
                    onClear={() => { onChangeGroupIcon(groupMenu.groupId, null); }}
                  />
                </div>
              )}
              <div className="h-px bg-border mx-2 my-1" />
              <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onPress={() => {
                  const members = sessions.filter(s => tabGroupMap[s.id] === groupMenu.groupId);
                  for (const m of members) props.onUngroupTab(m.id);
                  setGroupMenu(null);
                }}>
                Ungroup all
              </Button>
              {onRequestDeleteGroup && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                  onPress={() => { onRequestDeleteGroup(groupMenu.groupId); setGroupMenu(null); }}>
                  Delete group…
                </Button>
              )}
            </div>
          </>
        );
      })()}

      {/* Tab context menu */}
      {tabMenu && (() => {
        const isGrouped = !!tabGroupMap[tabMenu.tabId];
        const tabGroupId = tabGroupMap[tabMenu.tabId];
        const otherUngroupedTabs = sessions.filter(s => s.id !== tabMenu.tabId && !tabGroupMap[s.id]);
        const existingGroups = Object.values(tabGroups).filter(g => !tabGroupId || g.id !== tabGroupId);

        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setTabMenu(null)} onContextMenu={e => { e.preventDefault(); setTabMenu(null); }} />
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[180px] py-1"
              style={{ top: tabMenu.y, left: tabMenu.x }}>

              {/* Rename */}
              <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onPress={() => {
                  const s = sessions.find(s => s.id === tabMenu.tabId);
                  if (s) startRename(s);
                  setTabMenu(null);
                }}>
                Rename
              </Button>

              {/* Pin / Unpin (only for grouped tabs — pin order only matters
                  inside a group, where group members sort by recency). */}
              {isGrouped && onTogglePin && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                  onPress={() => { onTogglePin(tabMenu.tabId); setTabMenu(null); }}>
                  <Pin size={11} strokeWidth={2.25} className={pinnedSessionIds?.has(tabMenu.tabId) ? 'fill-current text-zinc-300' : ''} />
                  {pinnedSessionIds?.has(tabMenu.tabId) ? 'Unpin from top' : 'Pin to top'}
                </Button>
              )}

              {/* Close */}
              <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onPress={() => { onClose(tabMenu.tabId); setTabMenu(null); }}>
                Close
              </Button>

              {/* Copy Session ID */}
              {(() => {
                const s = sessions.find(s => s.id === tabMenu.tabId);
                return s?.claude_session_id ? (
                  <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                    onPress={() => { navigator.clipboard.writeText(s.claude_session_id!); setTabMenu(null); }}>
                    Copy Session ID
                  </Button>
                ) : null;
              })()}

              {/* Accent color — sets a per-session override that tints the
                  session's chat (and pane in focus mode). */}
              {onPickSessionAccent && accentPalette && accentPalette.length > 0 && (() => {
                const current = getSessionAccent?.(tabMenu.tabId);
                return (
                  <div className="px-3 py-1.5">
                    <div className="text-[10px] text-zinc-600 mb-1">Accent color</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {accentPalette.map(color => {
                        const selected = current?.toLowerCase() === color.toLowerCase();
                        return (
                          <button
                            key={color}
                            aria-label={`Color ${color}`}
                            onClick={() => { onPickSessionAccent(tabMenu.tabId, color); setTabMenu(null); }}
                            className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${selected ? 'ring-2 ring-white/60' : 'ring-1 ring-black/20'}`}
                            style={{ backgroundColor: color }}
                          />
                        );
                      })}
                      <button
                        onClick={() => { onPickSessionAccent(tabMenu.tabId, null); setTabMenu(null); }}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-0.5"
                        title="Reset to auto (inherit group color)"
                      >
                        Auto
                      </button>
                    </div>
                  </div>
                );
              })()}

              <div className="h-px bg-border mx-2 my-1" />

              {/* New session in this group — preserves an entry-point for
                  group-bound session creation now that the group dropdown
                  no longer offers it. */}
              {isGrouped && onNewSessionInGroup && tabGroupId && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                  onPress={() => { onNewSessionInGroup(tabGroupId); setTabMenu(null); }}>
                  <span className="text-zinc-500">+</span>
                  New session in group
                </Button>
              )}
              {isGrouped && onNewSessionInWorktreeForGroup && tabGroupId && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                  onPress={() => { onNewSessionInWorktreeForGroup(tabGroupId); setTabMenu(null); }}>
                  <span className="text-zinc-500">⌥</span>
                  New session in worktree…
                </Button>
              )}

              {/* Ungroup (if in a group) */}
              {isGrouped && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                  onPress={() => { props.onUngroupTab(tabMenu.tabId); setTabMenu(null); }}>
                  Remove from group
                </Button>
              )}

              {/* Create group (solo) */}
              {!isGrouped && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                  onPress={() => { onCreateGroup([tabMenu.tabId]); setTabMenu(null); }}>
                  Create group
                </Button>
              )}

              {/* Create group with another tab */}
              {!isGrouped && otherUngroupedTabs.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Group with</div>
                  {otherUngroupedTabs.slice(0, 8).map(t => (
                    <Button key={t.id} variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors truncate"
                      onPress={() => { onGroupTabs(tabMenu.tabId, t.id); setTabMenu(null); }}>
                      {t.name}
                    </Button>
                  ))}
                </>
              )}

              {/* Add to existing group */}
              {existingGroups.length > 0 && (
                <>
                  <div className="h-px bg-border mx-2 my-1" />
                  <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Add to group</div>
                  {existingGroups.map(g => {
                    const c = COLOR_MAP[g.color] || COLOR_MAP.blue!;
                    return (
                      <Button key={g.id} variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                        onPress={() => { onAddToGroup(tabMenu.tabId, g.id); setTabMenu(null); }}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                        {g.name}
                      </Button>
                    );
                  })}
                </>
              )}

              {/* Destructive — full purge (history + optionally worktree). */}
              {onRequestDelete && tabMenu.tabId !== 'main-session' && (
                <>
                  <div className="h-px bg-border mx-2 my-1" />
                  <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                    onPress={() => { onRequestDelete(tabMenu.tabId); setTabMenu(null); }}>
                    Delete…
                  </Button>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
});
