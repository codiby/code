import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronRight, Search, Archive, X, Pin, History, Plus,
  Cog, Antenna, Sparkles, Settings, GitBranch, FolderPlus, MoreHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import { useDrag, useDrop, mergeProps } from 'react-aria';
import type { SessionInfo, ConnectionStatus, SessionActivity } from '../lib/claude-client';
import { ICON_MAP, ICON_MAP_QUICK } from '../lib/group-icons';
import type { TabGroupInfo } from '../lib/tab-groups';
import {
  ancestorChain, buildGroupTree, descendantGroupIds, findGroupNode, isAncestorOf, isDerivedGroupId,
  resolveGroupColor, type TreeNode,
} from '../lib/group-tree';

type TabGroup = TabGroupInfo;

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
  /** Per-session running child processes + listening ports. Drives the two
   *  sidebar badges. A session absent from the map has no active processes. */
  sessionActivity?: Record<string, SessionActivity>;
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
  /** Sessions the user pulled out of their automatic worktree group. They stop
   *  counting towards the ≥2 rule until they're dropped back in. */
  pinnedOutOfWorktree?: Set<string>;
  /** Global "Group sessions by worktree" preference. Off skips the derivation
   *  entirely, so every session renders as a direct child of its group. */
  groupByWorktree?: boolean;
  /** Create an empty subgroup under `parentGroupId`. Nesting is unbounded. */
  onCreateSubgroup?: (parentGroupId: string) => void;
  /** Re-parent a group. `null` moves it back to the sidebar root. The host
   *  rejects moves that would put a group inside its own subtree. */
  onMoveGroup?: (groupId: string, newParentId: string | null) => void;
  /** Detach a session from its derived worktree group (see rule: manual wins
   *  over derived). Called on drag-out and from the session context menu. */
  onPinSessionOutOfWorktree?: (sessionId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onChangeGroupColor: (groupId: string, color: string) => void;
  onChangeGroupIcon?: (groupId: string, icon: string | null) => void;
  /** Spawn a session immediately in the group's saved cwd and add it to the
   *  group — no composer step. `cwdOverride` targets a specific worktree when
   *  the "+" was pressed on a derived worktree group; `groupId: null` spawns it
   *  ungrouped, which is what a root-level worktree cluster needs. */
  onNewSessionInGroup?: (groupId: string | null, cwdOverride?: string) => void;
  /** Open the inline GroupComposer for a group (the deliberate, configurable
   *  path — provider, model, first prompt). Offered from the group menu. */
  onOpenGroupComposer?: (groupId: string) => void;
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
  /** Active top-level view shown in the main pane. Drives the nav highlight at
   *  the top of the sidebar. */
  activeNavView?: 'sessions' | 'sessions-board';
  /** Switch the main pane to a top-level view. */
  onSelectNavView?: (view: 'sessions' | 'sessions-board') => void;
  /** Footer actions pinned to the bottom of the sidebar. */
  onOpenSkills?: () => void;
  onOpenSettings?: () => void;
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

// Soft teal used for live (running) sessions — distinct from the status colors.
const RUN_COLOR = '#5eead4';

type DotState = 'off' | 'idle' | 'working' | 'done' | 'starting' | 'error';
function dotStateOf(rt: string | undefined, connStatus: string, isStreaming: boolean, turnComplete: boolean, wasInterrupted: boolean, hasPermission: boolean): DotState {
  if (connStatus === 'error' || wasInterrupted) return 'error';
  // A pending permission request blocks the run — the session isn't actually
  // working, so don't keep the typing bars spinning (mirrors the composer's
  // `isStreaming && !permRequest` gate).
  if (isStreaming && !hasPermission) return 'working';
  if (rt === 'starting' || connStatus === 'connecting') return 'starting';
  if (turnComplete) return 'done';
  // A live Claude process (or an active WS) → "running, idle".
  if (rt === 'running' || connStatus === 'connected') return 'idle';
  return 'off'; // no Claude instance for this session
}

/** The status dot at the start of a session row. Reflects the runtime state:
 *  not-running (hollow ring), running-idle (muted teal dot), working (typing
 *  bars), turn-complete/starting (breathing glow), error (red). Always occupies
 *  a fixed-width box so the name column stays aligned across states. */
function SessionDot({ rt, connStatus, isStreaming, turnComplete, wasInterrupted, hasPermission }: {
  rt?: string; connStatus: string; isStreaming: boolean; turnComplete: boolean; wasInterrupted: boolean; hasPermission: boolean;
}) {
  const st = dotStateOf(rt, connStatus, isStreaming, turnComplete, wasInterrupted, hasPermission);
  const box = 'shrink-0 inline-flex items-center justify-center';
  const boxStyle: React.CSSProperties = { width: 14, height: 14 };
  if (st === 'working') {
    return (
      <span className={`${box} gap-[1.5px]`} style={boxStyle} aria-label="Working">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-[2px] rounded-[1px]" style={{ height: 5, background: RUN_COLOR, animation: 'sessionTyping 1s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
        ))}
      </span>
    );
  }
  if (st === 'done' || st === 'starting') {
    const c = st === 'done' ? '#34d399' : RUN_COLOR;
    return (
      <span className={box} style={boxStyle} aria-label={st === 'done' ? 'Turn complete' : 'Starting'}>
        <span className="w-2 h-2 rounded-full" style={{ background: c, boxShadow: `0 0 7px ${c}`, animation: 'sessionBreathe 1.15s ease-in-out infinite' }} />
      </span>
    );
  }
  if (st === 'error') {
    return (
      <span className={box} style={boxStyle} aria-label="Error">
        <span className="w-2 h-2 rounded-full" style={{ background: '#f87171', boxShadow: '0 0 6px #f87171' }} />
      </span>
    );
  }
  if (st === 'idle') {
    return (
      <span className={box} style={boxStyle} aria-label="Running" title="Running">
        <span className="rounded-full" style={{ width: 7, height: 7, background: 'color-mix(in srgb, #5eead4 55%, #0a0a0b)' }} />
      </span>
    );
  }
  // off — no running Claude instance
  return (
    <span className={box} style={boxStyle} aria-label="Not running" title="Not running">
      <span className="rounded-full border-[1.5px] border-zinc-600 opacity-60" style={{ width: 7, height: 7 }} />
    </span>
  );
}

/** Styled hover popover listing a session's running processes and listening
 *  ports. Rendered in a portal to document.body so it escapes the sidebar's
 *  overflow clipping, and flips above the anchor when near the viewport bottom. */
function ActivityPopover({ anchor, processes, listeningPorts }: {
  anchor: DOMRect;
  processes: SessionActivity['processes'];
  listeningPorts: SessionActivity['listeningPorts'];
}) {
  const flipUp = anchor.bottom + 260 > window.innerHeight;
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 296)),
    zIndex: 9999,
    pointerEvents: 'none',
    ...(flipUp
      ? { bottom: window.innerHeight - anchor.top + 6 }
      : { top: anchor.bottom + 6 }),
  };
  return createPortal(
    <div
      style={style}
      className="w-72 max-w-[80vw] rounded-lg border border-[#2a2b30] bg-[#1c1d23] px-3 py-2.5 text-[11.5px] shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      {processes.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-amber-400/90">
            <Cog size={11} strokeWidth={2.4} />
            {processes.length} {processes.length === 1 ? 'process' : 'processes'} running
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {processes.map(p => (
              <div key={p.pid} className="flex gap-2 pl-[18px] leading-snug">
                <span className="shrink-0 text-zinc-500 tabular-nums">pid {p.pid}</span>
                <span className="truncate font-mono text-zinc-300">{p.label ? `${p.label}: ` : ''}{p.command}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {processes.length > 0 && listeningPorts.length > 0 && (
        <div className="my-2 h-px bg-[#2a2b30]" />
      )}
      {listeningPorts.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-sky-400/90">
            <Antenna size={11} strokeWidth={2.4} />
            {listeningPorts.length} {listeningPorts.length === 1 ? 'port' : 'ports'} listening
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {listeningPorts.map(p => (
              <div key={p.port} className="flex gap-2 pl-[18px] leading-snug">
                <span className="shrink-0 text-sky-300/90 tabular-nums font-mono">:{p.port}</span>
                <span className="truncate font-mono text-zinc-400">{p.command}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">LISTEN</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Two compact badges shown on a session row: running child processes (amber)
 *  and listening TCP ports (blue). Each is a chip with an icon + count; hover
 *  reveals a styled popover with the underlying pids / commands / ports.
 *  Renders nothing when the session has no activity. */
function SessionActivityBadges({ activity }: { activity?: SessionActivity }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!activity) return null;
  const { childProcessCount, processes, listeningPorts } = activity;
  if (childProcessCount === 0 && listeningPorts.length === 0) return null;

  // One port → show its number; several → show the count.
  const portLabel = listeningPorts.length === 1 ? String(listeningPorts[0]!.port) : `×${listeningPorts.length}`;

  return (
    <span
      className="shrink-0 flex items-center gap-1"
      onMouseEnter={e => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
    >
      {childProcessCount > 0 && (
        <span className="flex items-center gap-0.5 h-[15px] px-1 rounded text-[9.5px] font-semibold tabular-nums text-amber-400/90 bg-amber-400/10">
          <Cog size={9} strokeWidth={2.4} className="animate-[spin_4s_linear_infinite]" />
          {childProcessCount}
        </span>
      )}
      {listeningPorts.length > 0 && (
        <span className="flex items-center gap-0.5 h-[15px] px-1 rounded text-[9.5px] font-semibold tabular-nums text-sky-400/90 bg-sky-400/10">
          <Antenna size={9} strokeWidth={2.4} />
          {portLabel}
        </span>
      )}
      {anchor && <ActivityPopover anchor={anchor} processes={processes} listeningPorts={listeningPorts} />}
    </span>
  );
}

// All the data a session row needs to render. Shared by the dnd-kit
// `SortableTab` (flat "Lista" view) and the react-aria `StatusCard` (grouped
// views) so the visual stays identical regardless of which DnD system drives it.
type RowProps = {
  id: string; session: SessionInfo; isActive: boolean; connStatus: string; isStreaming: boolean; wasInterrupted: boolean; turnComplete?: boolean; hasPermission: boolean; activity?: SessionActivity; groupColor?: string; compact?: boolean;
  ageLabel?: string;
  isPinned?: boolean;
  editingId: string | null; editName: string; editRef: React.RefObject<HTMLInputElement | null>;
  setEditName: (v: string) => void; startRename: (s: SessionInfo) => void; commitRename: () => void; setEditingId: (id: string | null) => void;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

// Presentational session row. The root element is parameterized (ref + spread
// props + style + dragging flag) so either DnD library can own it.
function TabRowVisual({ session, isActive, connStatus, isStreaming, wasInterrupted, turnComplete, hasPermission, activity, compact, ageLabel, isPinned, editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose, onContextMenu, rootRef, rootProps, style, dragging }: RowProps & {
  rootRef?: (el: HTMLElement | null) => void; rootProps?: React.HTMLAttributes<HTMLElement>; style?: React.CSSProperties; dragging?: boolean;
}) {
  // Vertical sidebar: flat active background regardless of group color.
  const activeBg = isActive ? 'bg-surface-light' : '';
  // Remote sessions are identified by a small colored name badge (below) rather
  // than tinting the whole row, matching the group-header / tab-strip pattern.
  const remoteC = session.remoteColor ? (COLOR_MAP[session.remoteColor] ?? null) : null;
  return (
    <div ref={rootRef as React.Ref<HTMLDivElement>} style={style}
      {...rootProps}
      className={`tab-item group relative flex items-center gap-1.5 px-3 ${compact ? 'h-[26px]' : 'h-[30px]'} text-[12px] cursor-pointer w-full rounded-md transition-colors ${dragging ? 'opacity-40' : ''} ${
        isActive ? `${activeBg} text-zinc-200` : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
      }`}
      onClick={() => onSelect(session.id)}
      onContextMenu={onContextMenu}
      title={session.remoteName ? `Remote: ${session.remoteName}` : undefined}
    >
      <SessionDot rt={session.runtime_status} connStatus={connStatus} isStreaming={isStreaming} turnComplete={!!turnComplete} wasInterrupted={wasInterrupted} hasPermission={hasPermission} />
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
      {/* Remote badge — small colored pill with the remote's name, shown
          instead of tinting the whole row. */}
      {session.remoteName && editingId !== session.id && (
        <span
          className={`shrink-0 inline-flex items-center text-[8.5px] font-semibold uppercase tracking-wider leading-none px-1 py-0.5 rounded border ${remoteC ? `${remoteC.text} ${remoteC.bg} ${remoteC.border}` : 'text-zinc-400 bg-surface-light border-border'}`}
          title={`Remote: ${session.remoteName}`}
        >
          {session.remoteName}
        </span>
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
      {/* Running-process / listening-port badges. Always visible (not
          hover-gated) so activity is legible at a glance. */}
      {editingId !== session.id && <SessionActivityBadges activity={activity} />}
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

// Flat "Lista" view row — react-aria draggable + drop target. Dropping another
// tab onto it reorders (or groups, when Shift is held); `onDropTab` decides.
function ReorderTab(props: RowProps & { onDropTab: (draggedId: string) => void }) {
  const { onDropTab, ...row } = props;
  const editing = props.editingId === props.session.id;
  const ref = useRef<HTMLDivElement | null>(null);
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [SESSION_DRAG_TYPE]: props.session.id, 'text/plain': props.session.name }],
  });
  const { dropProps, isDropTarget } = useDrop({
    ref,
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === 'text' && item.types.has(SESSION_DRAG_TYPE)) {
          const id = await item.getText(SESSION_DRAG_TYPE);
          if (id && id !== props.session.id) onDropTab(id);
          break;
        }
      }
    },
  });
  const rootProps = (editing ? dropProps : mergeProps(dragProps, dropProps)) as React.HTMLAttributes<HTMLElement>;
  return (
    <TabRowVisual
      {...row}
      rootRef={(el) => { ref.current = el as HTMLDivElement | null; }}
      rootProps={rootProps}
      dragging={isDragging}
      style={isDropTarget ? { boxShadow: 'inset 0 2px 0 0 #818cf8' } : undefined}
    />
  );
}

// Custom drag type carrying the session id between tab rows in the List view.
// Kept app-specific so unrelated text drops are ignored.
const SESSION_DRAG_TYPE = 'application/x-codiby-session';
// Custom drag type carrying a tab-group id when reordering/nesting groups.
const GROUP_DRAG_TYPE = 'application/x-codiby-group';
/** Id of the group currently being dragged. react-aria only exposes the payload
 *  to a drop target on drop, but the nest/reorder preview has to know during
 *  the move whether the drop would be legal — so the drag source parks it here
 *  and the hovered header reads it. Cleared on drag end. */
let activeGroupDragId: string | null = null;

/** Where a dragged group lands relative to the header it was dropped on.
 *  `inside` nests it (the middle band of the row), the other two make it a
 *  sibling above/below. */
type DropSlot = 'above' | 'inside' | 'below';

function SortableGroupTab({ group, color, derived, memberCount, isExpanded, hasActive, hasActivity, remoteName, remoteColor, canAcceptGroup, onToggle, onRename, onMenuOpen, onNewSession, onDropSession, onDropGroup }: {
  group: TabGroup; color: string; derived?: boolean;
  memberCount: number; isExpanded: boolean; hasActive: boolean; hasActivity?: boolean;
  remoteName?: string | null; remoteColor?: string | null;
  /** Guards the nest/reorder drop — false rejects the drag outright (a group
   *  can't land inside its own subtree, and derived groups take nothing). */
  canAcceptGroup?: (fromGid: string, slot: DropSlot) => boolean;
  onToggle: (deep: boolean) => void; onRename: (name: string) => void; onMenuOpen: (x: number, y: number) => void;
  onNewSession: () => void; onDropSession: (sessionId: string) => void;
  onDropGroup?: (fromGid: string, slot: DropSlot) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DropSlot | null>(null);
  const [rejected, setRejected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  // Top 30% / middle 40% / bottom 30%. The middle band is what makes nesting
  // reachable without a modifier key.
  const posAt = (y: number): DropSlot => {
    const el = ref.current;
    if (!el) return 'above';
    const h = el.getBoundingClientRect().height;
    if (y < h * 0.3) return 'above';
    if (y > h * 0.7) return 'below';
    return 'inside';
  };
  // Drag the header to reorder/nest the group; suppressed while renaming and
  // for derived groups, which the system owns.
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [GROUP_DRAG_TYPE]: group.id, 'text/plain': group.name }],
    onDragStart: () => { activeGroupDragId = group.id; },
    onDragEnd: () => { activeGroupDragId = null; setPos(null); },
  });
  // The header is also a drop target: a tab dropped on it joins the group; a
  // group dropped on it nests or reorders. The drop events don't carry the drag
  // types, so we capture them in getDropOperation.
  const dragKind = useRef<'group' | 'session' | null>(null);
  const draggedGid = useRef<string | null>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) => {
      if (derived) { dragKind.current = null; return 'cancel'; }
      dragKind.current = types.has(GROUP_DRAG_TYPE) ? 'group' : types.has(SESSION_DRAG_TYPE) ? 'session' : null;
      return dragKind.current ? 'move' : 'cancel';
    },
    onDropActivate() { if (!isExpanded) onToggle(false); },
    onDropMove(e) {
      if (dragKind.current !== 'group') { setPos(null); setRejected(false); return; }
      const slot = posAt(e.y);
      const gid = draggedGid.current;
      const ok = !gid || !canAcceptGroup || canAcceptGroup(gid, slot);
      setPos(slot);
      setRejected(!ok);
    },
    onDropExit() { setPos(null); setRejected(false); draggedGid.current = null; },
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind !== 'text') continue;
        if (item.types.has(SESSION_DRAG_TYPE)) {
          const id = await item.getText(SESSION_DRAG_TYPE);
          setPos(null); setRejected(false);
          if (id) onDropSession(id);
          return;
        }
        if (item.types.has(GROUP_DRAG_TYPE)) {
          const fromGid = await item.getText(GROUP_DRAG_TYPE);
          const slot = posAt(e.y);
          setPos(null); setRejected(false);
          if (fromGid && fromGid !== group.id && (!canAcceptGroup || canAcceptGroup(fromGid, slot))) {
            onDropGroup?.(fromGid, slot);
          }
          return;
        }
      }
      setPos(null); setRejected(false);
    },
  });
  // react-aria hands the drag payload to the drop target only on drop, but the
  // above/below/inside preview needs it during the move. Sniff it from the
  // active drag via a module-level handoff set by the drag source.
  useEffect(() => {
    if (isDropTarget) draggedGid.current = activeGroupDragId;
  }, [isDropTarget]);

  const colors = COLOR_MAP[color] || COLOR_MAP.blue!;
  // Only the tab-add affordance (session hover) lights the ring; group nesting
  // gets its own ring, reorder uses the above/below line.
  const sessionHover = isDropTarget && pos === null && !derived;
  const nestHover = isDropTarget && pos === 'inside' && !rejected;

  // Vertical sidebar: drop the filled background and border — the colored dot
  // alone is enough, keeping the sidebar visually clean (Arc/Zen style).
  const baseCls = `group relative flex items-center gap-1.5 px-2 h-[28px] text-[12px] ${derived ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} rounded-md transition-colors ${
    rejected ? 'ring-1 ring-red-400/50 bg-red-500/10'
      : nestHover ? `ring-1 ${colors.ring} bg-surface-light/60`
      : sessionHover ? `ring-1 ${colors.ring}` : ''
  } hover:bg-surface/60 ${hasActive && !isExpanded ? 'text-zinc-200' : 'text-zinc-400'}`;

  return (
    <div ref={ref} {...mergeProps(editing || derived ? {} : dragProps, dropProps)}
      className={baseCls}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      onClick={e => onToggle(e.altKey)}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        onMenuOpen(e.clientX, e.clientY);
      }}
    >
      {isDropTarget && pos === 'above' && !rejected && <div className="absolute -top-0.5 left-0 right-0 h-0.5 bg-indigo-400 rounded-full z-10" />}
      {isDropTarget && pos === 'below' && !rejected && <div className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-indigo-400 rounded-full z-10" />}
      {isExpanded
        ? <ChevronDown size={12} className="shrink-0 text-zinc-500" />
        : <ChevronRight size={12} className="shrink-0 text-zinc-500" />}
      {/* Derived worktree groups always show the branch glyph — they can't
         carry a user-picked icon or colour. Otherwise: the group's icon when
         set, else the original colored dot. */}
      {(() => {
        if (derived) {
          return <GitBranch size={12} className={`shrink-0 ${colors.text} ${hasActivity ? 'animate-pulse' : ''}`} strokeWidth={2.25} />;
        }
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
        <span
          className={`text-[12px] truncate flex-1 ${derived ? 'font-mono text-[11px]' : ''}`}
          onDoubleClick={derived ? undefined : e => { e.stopPropagation(); setEditing(true); setName(group.name); }}
        >
          {group.name}
        </span>
      )}
      {derived && (
        <span
          className={`shrink-0 text-[9px] leading-none px-1 py-[2px] rounded-[3px] border border-dashed ${colors.border} ${colors.text} opacity-70`}
          title="Automatic group: every session here shares a worktree. Dissolves on its own below two sessions."
        >
          wt
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
      {/* Subtree session count, swapped for the hover actions. */}
      <span className="text-[11px] text-zinc-600 group-hover:hidden">{memberCount}</span>
      {/* Spawns a session in this group's cwd immediately — no composer step.
       *  Right-click (or the ⋯ button) surfaces the full options menu. */}
      <span
        onClick={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}
        className="shrink-0 hidden group-hover:flex items-center gap-0.5"
      >
        <span title={derived ? 'New session in this worktree' : 'New session in group'} className="flex">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={derived ? 'New session in this worktree' : 'New session in group'}
            className="w-4 h-4 min-w-0 p-0 flex items-center justify-center rounded-sm leading-none text-zinc-600 hover:text-zinc-300 hover:bg-surface-light"
            onPress={onNewSession}
          >
            <Plus size={12} />
          </Button>
        </span>
        <span title="Group options" className="flex">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Group options"
            className="w-4 h-4 min-w-0 p-0 flex items-center justify-center rounded-sm leading-none text-zinc-600 hover:text-zinc-300 hover:bg-surface-light"
            onPress={() => {
              const r = ref.current?.getBoundingClientRect();
              onMenuOpen(r ? r.right - 8 : 0, r ? r.bottom : 0);
            }}
          >
            <MoreHorizontal size={12} />
          </Button>
        </span>
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
  const { sessions, closedSessions, activeSessionId, sessionStatuses, sessionStreaming, sessionInterrupted, sessionHasPermission, sessionActivity, sessionLastMessageAt,
    pinnedSessionIds, onTogglePin,
    onSelect, onNew, onClose, onReopen, onRename, onReorder,
    tabGroups, tabGroupMap, groupRemoteInfo, expandedGroupIds, sessionTurnComplete, onCreateGroup, onGroupTabs, onAddToGroup, onToggleGroup, onRenameGroup, onChangeGroupColor, onChangeGroupIcon, onNewSessionInGroup, onOpenGroupComposer, onNewSessionInWorktreeForGroup, onArchiveSession, onRequestDelete, onRequestDeleteGroup,
    onCreateSubgroup, onMoveGroup, onPinSessionOutOfWorktree,
    accentPalette, getSessionAccent, onPickSessionAccent,
    collapsed, onToggleCollapsed,
    activeNavView = 'sessions', onSelectNavView,
    onOpenSkills, onOpenSettings } = props;

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
  const [sessionSearch, setSessionSearch] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [restoreSearch, setRestoreSearch] = useState('');
  const [restoreHighlight, setRestoreHighlight] = useState(0);
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const shiftRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreSearchRef = useRef<HTMLInputElement>(null);
  const restoreActiveItemRef = useRef<HTMLDivElement | null>(null);

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

  // Reset the highlighted row when the popover reopens or the query changes,
  // and keep the active row scrolled into view as the user arrows through.
  useEffect(() => { setRestoreHighlight(0); }, [showMenu, restoreSearch]);
  useEffect(() => { restoreActiveItemRef.current?.scrollIntoView({ block: 'nearest' }); }, [restoreHighlight]);

  const onRestoreSearchKeyDown = (e: React.KeyboardEvent) => {
    if (filteredClosedSessions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRestoreHighlight(h => Math.min(h + 1, filteredClosedSessions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRestoreHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const s = filteredClosedSessions[restoreHighlight];
      if (s) { setShowMenu(false); onReopen(s.id); }
    }
  };
  const editRef = useRef<HTMLInputElement>(null);

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

  // Manual ordering of tab groups, persisted per parent: `''` holds the
  // root-level order, every other key holds one group's child order. Groups not
  // in a list are appended (new groups go to the end), so the order is explicit
  // and never reshuffles on its own as member activity changes.
  const [groupOrder, setGroupOrder] = useState<Record<string, string[]>>(() => {
    if (typeof window === 'undefined') return {};
    const readArray = (raw: string | null): string[] => {
      try {
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
      } catch { return []; }
    };
    try {
      const raw = localStorage.getItem('tabBarGroupOrderByParent');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
          }
          return out;
        }
      }
      // Migrate the pre-nesting flat order into the root bucket.
      const legacy = readArray(localStorage.getItem('tabBarGroupOrder'));
      return legacy.length ? { '': legacy } : {};
    } catch { return {}; }
  });
  const persistGroupOrder = (next: Record<string, string[]>) => {
    try { localStorage.setItem('tabBarGroupOrderByParent', JSON.stringify(next)); } catch {}
  };
  /** Place `fromGid` next to `toGid` inside `parentKey`'s child list. The
   *  re-parenting itself is the host's job (`onMoveGroup`); this only fixes the
   *  order within the destination. */
  const reorderGroupWithin = (parentKey: string, fromGid: string, toGid: string, position: 'above' | 'below') => {
    setGroupOrder(prev => {
      const siblings = Object.values(tabGroups)
        .filter(g => (g.parentId ?? '') === parentKey || g.id === fromGid)
        .map(g => g.id);
      const known = (prev[parentKey] ?? []).filter(g => siblings.includes(g));
      const missing = siblings.filter(g => !known.includes(g));
      const order = [...known, ...missing].filter(g => g !== fromGid);
      const ti = order.indexOf(toGid);
      if (ti === -1) return prev;
      order.splice(position === 'above' ? ti : ti + 1, 0, fromGid);
      const next = { ...prev, [parentKey]: order };
      persistGroupOrder(next);
      return next;
    });
  };

  // Derived worktree groups default to expanded — collapsing one is the
  // exception, and their ids are regenerated from the members so they can't be
  // tracked in the server-persisted `expandedGroupIds`.
  const [collapsedDerived, setCollapsedDerived] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem('tabBarCollapsedWorktreeGroups');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
    } catch { return new Set(); }
  });
  const toggleDerived = (id: string) => {
    setCollapsedDerived(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('tabBarCollapsedWorktreeGroups', JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const normalizedSessionSearch = sessionSearch.trim().toLowerCase();
  const visibleSessions = normalizedSessionSearch
    ? sessions.filter(s =>
        s.name.toLowerCase().includes(normalizedSessionSearch) ||
        s.cwd.toLowerCase().includes(normalizedSessionSearch))
    : sessions;

  // Sort each parent's sessions: pinned first, then by last-message recency,
  // with the incoming order as a stable tiebreaker.
  const sessionIndex = useMemo(() => new Map(sessions.map((s, i) => [s.id, i])), [sessions]);
  const tree = useMemo(() => buildGroupTree({
    sessions: visibleSessions,
    groups: tabGroups,
    map: tabGroupMap,
    pinnedOutOfWorktree: props.pinnedOutOfWorktree,
    groupByWorktree: props.groupByWorktree,
    childOrder: groupOrder,
    sortSessions: (a, b) => {
      const pa = pinnedSessionIds?.has(a.id) ? 1 : 0;
      const pb = pinnedSessionIds?.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ta = sessionLastMessageAt?.[a.id] || 0;
      const tb = sessionLastMessageAt?.[b.id] || 0;
      if (tb !== ta) return tb - ta;
      return (sessionIndex.get(a.id) ?? 0) - (sessionIndex.get(b.id) ?? 0);
    },
  }), [visibleSessions, tabGroups, tabGroupMap, props.pinnedOutOfWorktree, props.groupByWorktree, groupOrder, pinnedSessionIds, sessionLastMessageAt, sessionIndex]);

  // react-aria drop handler for a tab dropped onto another tab. Mirrors the old
  // dnd-kit logic: Shift groups the two (or adds to the target's group), plain
  // drop reorders. Dropping onto a group header is handled by SortableGroupTab.
  const handleDropTab = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    // Dragging a session out of the worktree cluster it was auto-placed in is
    // the documented escape hatch — without the pin the derivation would just
    // reclaim it on the next render.
    if (derivedMembership.has(fromId) && derivedMembership.get(fromId) !== derivedMembership.get(toId)) {
      onPinSessionOutOfWorktree?.(fromId);
    }
    if (shiftRef.current) {
      const targetGroupId = tabGroupMap[toId];
      if (targetGroupId) onAddToGroup(fromId, targetGroupId);
      else onGroupTabs(fromId, toId);
      return;
    }
    onReorder(fromId, toId);
  };


  const tp = (s: SessionInfo, groupColor?: string, compact?: boolean) => ({
    id: s.id, session: s, isActive: s.id === activeSessionId,
    connStatus: sessionStatuses[s.id] || 'disconnected',
    isStreaming: sessionStreaming[s.id] || false,
    wasInterrupted: sessionInterrupted[s.id] || false,
    turnComplete: sessionTurnComplete.has(s.id),
    hasPermission: sessionHasPermission[s.id] || false,
    activity: sessionActivity?.[s.id],
    groupColor, compact,
    ageLabel: formatTabAge(sessionLastMessageAt?.[s.id], nowMs),
    isPinned: pinnedSessionIds?.has(s.id) || false,
    editingId, editName, editRef, setEditName, startRename, commitRename, setEditingId, onSelect, onClose,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setTabMenu({ tabId: s.id, x: e.clientX, y: e.clientY }); },
  });

  // ── Tree rendering ────────────────────────────────────────────────────────

  /** sessionId → id of the derived worktree group it currently renders inside.
   *  Drives the "manual wins over derived" rule: dragging one of these rows
   *  anywhere else has to pin it out, or the derivation would just reclaim it
   *  on the next render. */
  const derivedMembership = useMemo(() => {
    const out = new Map<string, string>();
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type !== 'group') continue;
        if (node.derived) for (const child of node.children) out.set(child.id, node.id);
        else walk(node.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const nodeSessionIds = (node: TreeNode): string[] => {
    if (node.type === 'session') return [node.id];
    return node.children.flatMap(nodeSessionIds);
  };

  const isNodeExpanded = (node: Extract<TreeNode, { type: 'group' }>) =>
    !!normalizedSessionSearch || (node.derived ? !collapsedDerived.has(node.id) : expandedGroupIds.has(node.id));

  /** Expand/collapse. Alt-click applies the new state to the whole subtree. */
  const toggleNode = (node: Extract<TreeNode, { type: 'group' }>, deep: boolean) => {
    const target = !isNodeExpanded(node);
    const apply = (n: Extract<TreeNode, { type: 'group' }>) => {
      if (n.derived) {
        if (collapsedDerived.has(n.id) === target) toggleDerived(n.id);
      } else if (expandedGroupIds.has(n.id) !== target) {
        onToggleGroup(n.id);
      }
      if (!deep) return;
      for (const child of n.children) if (child.type === 'group') apply(child);
    };
    apply(node);
  };

  /** A group may not land inside its own subtree, and derived groups accept
   *  nothing (their membership is computed, not stored). */
  const canAcceptGroup = (target: Extract<TreeNode, { type: 'group' }>, fromGid: string, slot: DropSlot) => {
    if (target.derived) return false;
    if (isDerivedGroupId(fromGid)) return false;
    if (slot === 'inside') return !isAncestorOf(tabGroups, fromGid, target.id);
    const destParent = tabGroups[target.id]?.parentId ?? null;
    return !destParent || !isAncestorOf(tabGroups, fromGid, destParent);
  };

  const handleDropGroup = (target: Extract<TreeNode, { type: 'group' }>, fromGid: string, slot: DropSlot) => {
    if (slot === 'inside') {
      onMoveGroup?.(fromGid, target.id);
      if (!expandedGroupIds.has(target.id)) onToggleGroup(target.id);
      return;
    }
    const destParent = tabGroups[target.id]?.parentId ?? null;
    if ((tabGroups[fromGid]?.parentId ?? null) !== destParent) onMoveGroup?.(fromGid, destParent);
    reorderGroupWithin(destParent ?? '', fromGid, target.id, slot);
  };

  /** A session dropped on a group header. Landing on the group it already
   *  belongs to only makes sense as "pull me out of my worktree cluster". */
  const handleDropSessionOnGroup = (sessionId: string, target: Extract<TreeNode, { type: 'group' }>) => {
    if (target.derived) return;
    if (derivedMembership.has(sessionId) && tabGroupMap[sessionId] === target.id) {
      onPinSessionOutOfWorktree?.(sessionId);
      return;
    }
    onAddToGroup(sessionId, target.id);
  };

  const renderTreeNode = (node: TreeNode): React.ReactNode => {
    if (node.type === 'session') {
      const groupId = tabGroupMap[node.id];
      const color = groupId ? resolveGroupColor(tabGroups, groupId, '') : '';
      return (
        <ReorderTab
          key={node.id}
          {...tp(node.session, color || undefined, node.depth > 0)}
          onDropTab={(from) => handleDropTab(from, node.id)}
        />
      );
    }

    const memberIds = nodeSessionIds(node);
    const expanded = isNodeExpanded(node);
    const color = node.derived
      ? resolveGroupColor(tabGroups, node.group.parentId ?? null, 'violet')
      : resolveGroupColor(tabGroups, node.id);
    const colors = COLOR_MAP[color] || COLOR_MAP.blue!;
    const remote = groupRemoteInfo?.[node.id];
    // Past three levels the rail alone carries the hierarchy — keep clawing
    // back horizontal space instead of pushing names off the edge.
    const indent = node.depth >= 3 ? 'pl-1.5 ml-1.5' : 'pl-2 ml-3';

    return (
      <div key={`grp-${node.id}`} className="flex flex-col gap-0.5">
        <SortableGroupTab
          group={node.group}
          color={color}
          derived={node.derived}
          memberCount={node.sessionCount}
          isExpanded={expanded}
          hasActive={memberIds.some(id => id === activeSessionId)}
          hasActivity={!expanded && memberIds.some(id => sessionHasPermission[id])}
          remoteName={remote?.remoteName ?? null}
          remoteColor={remote?.remoteColor ?? null}
          canAcceptGroup={(fromGid, slot) => canAcceptGroup(node, fromGid, slot)}
          onToggle={(deep) => toggleNode(node, deep)}
          onRename={name => onRenameGroup(node.id, name)}
          onMenuOpen={(x, y) => setGroupMenu({ groupId: node.id, x, y })}
          onNewSession={() => {
            // A derived group has no prefs entry of its own: the new session
            // joins its parent (or stays ungrouped at the root) and lands in the
            // shared worktree, which re-derives the same cluster.
            if (node.derived) onNewSessionInGroup?.(node.group.parentId ?? null, node.group.worktreePath);
            else onNewSessionInGroup?.(node.id);
          }}
          onDropSession={(id) => handleDropSessionOnGroup(id, node)}
          onDropGroup={(fromGid, slot) => handleDropGroup(node, fromGid, slot)}
        />
        {expanded && (
          // Indent + colored left rail spanning the full height of the subtree.
          // Derived groups get a dashed rail so "the system owns this" reads at
          // a glance even when the header scrolls out of view.
          <div className={`flex flex-col gap-0.5 border-l-2 ${indent} ${colors.border} ${node.derived ? 'border-dashed' : ''}`}>
            {node.children.map(child => renderTreeNode(child))}
          </div>
        )}
      </div>
    );
  };

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
            onKeyDown={onRestoreSearchKeyDown}
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
          filteredClosedSessions.map((s, i) => (
            <div
              key={s.id}
              ref={i === restoreHighlight ? restoreActiveItemRef : undefined}
              className={`group/arch w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors cursor-pointer ${
                i === restoreHighlight ? 'bg-surface-light text-zinc-200' : 'text-zinc-400 hover:bg-surface-light hover:text-zinc-200'
              }`}
              onClick={() => { setShowMenu(false); onReopen(s.id); }}
              onMouseEnter={() => setRestoreHighlight(i)}
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

  // A collapsible section header (chevron + colored title + count) shared by
  // the status view and the per-project status sub-groups.
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
         <div className="flex items-center gap-1.5 bg-[#1c1d22] border border-[#2a2b30] rounded-md px-2 h-8 shrink-0 mb-1">
           <Search size={12} className="text-zinc-600 shrink-0" />
           <input
             type="search"
             value={sessionSearch}
             onChange={(e) => setSessionSearch(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Escape') {
                 e.currentTarget.blur();
                 setSessionSearch('');
               }
             }}
             placeholder="Search sessions..."
             aria-label="Search sessions"
             className="flex-1 min-w-0 bg-transparent text-[12px] text-zinc-300 placeholder:text-zinc-600 outline-none border-0"
           />
           {sessionSearch && (
             <button
               type="button"
               onClick={() => setSessionSearch('')}
               className="text-zinc-600 hover:text-zinc-300 transition-colors"
               aria-label="Clear session search"
             >
               <X size={12} />
             </button>
           )}
         </div>
         {normalizedSessionSearch && (
           <div className="px-1 pb-1 text-[10px] text-zinc-600">
             {visibleSessions.length} {visibleSessions.length === 1 ? 'result' : 'results'}
           </div>
         )}
         <div className="flex flex-col gap-0.5">
           {tree.length === 0 ? (
             <div className="px-3 py-5 text-center text-[11px] text-zinc-600">No matching sessions</div>
           ) : tree.map(node => renderTreeNode(node))}
        </div>
      </div>

      {/* Footer — fixed actions pinned to the bottom of the sidebar. */}
      <div className="flex flex-col gap-0.5 px-2 py-2 border-t border-border shrink-0">
        <button
          type="button"
          onClick={onOpenSkills}
          className="flex items-center gap-2.5 h-8 px-3 rounded-md text-[12px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-surface-light transition-colors group"
        >
          <Sparkles size={15} className="text-zinc-500 group-hover:text-violet-300 transition-colors" />
          <span>Skills</span>
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-2.5 h-8 px-3 rounded-md text-[12px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-surface-light transition-colors group"
        >
          <Settings size={15} className="text-zinc-500 group-hover:text-violet-300 transition-colors" />
          <span>Settings</span>
        </button>
      </div>

      {/* Group dropdown menu */}
      {groupMenu && (() => {
        const derived = isDerivedGroupId(groupMenu.groupId);
        const derivedNode = derived ? findGroupNode(tree, groupMenu.groupId) : null;
        // A derived group has no preferences entry, so its menu reads off the
        // synthesised node instead of `tabGroups`.
        const grp = derived ? derivedNode?.group : tabGroups[groupMenu.groupId];
        if (!grp) return null;
        // Use the stored cwd, or fall back to the first member's cwd for
        // legacy groups that pre-date the cwd field. The fallback is what
        // makes "New session in group" appear for groups created before
        // this feature shipped.
        const firstMember = sessions.find(s => tabGroupMap[s.id] === groupMenu.groupId);
        const grpCwd = grp.cwd || firstMember?.cwd || '';
        const parentId = grp.parentId ?? null;
        const subtreeCount = derived
          ? (derivedNode?.sessionCount ?? 0)
          : [groupMenu.groupId, ...descendantGroupIds(tabGroups, groupMenu.groupId)]
              .reduce((n, gid) => n + sessions.filter(s => tabGroupMap[s.id] === gid).length, 0);
        // "Move to" targets: every group that isn't this one or one of its own
        // descendants, plus the sidebar root.
        const moveTargets = derived ? [] : Object.values(tabGroups)
          .filter(g => g.id !== groupMenu.groupId && !isAncestorOf(tabGroups, groupMenu.groupId, g.id) && g.id !== parentId);
        const item = 'text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors';
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setGroupMenu(null)} />
            {/* Height is capped to whatever is left below the cursor so a long
                menu scrolls instead of running off the bottom of the window. */}
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[210px] max-w-[260px] py-1 overflow-y-auto"
              style={{ top: groupMenu.y, left: groupMenu.x, maxHeight: `calc(100vh - ${groupMenu.y}px - 12px)` }}>
              {grpCwd && (
                <div className="px-3 py-1 text-[10px] text-zinc-600 truncate font-mono" title={grpCwd}>
                  {derived ? '⑂' : '📁'} {grpCwd.split('/').slice(-2).join('/') || grpCwd}
                </div>
              )}
              <Button variant="ghost" fullWidth className={item}
                onPress={() => {
                  if (derived) toggleDerived(groupMenu.groupId); else onToggleGroup(groupMenu.groupId);
                  setGroupMenu(null);
                }}>
                {(derived ? !collapsedDerived.has(groupMenu.groupId) : expandedGroupIds.has(groupMenu.groupId)) ? 'Collapse' : 'Expand'}
              </Button>

              {/* Creation — instant session, deliberate session, subgroup. */}
              <div className="h-px bg-border mx-2 my-1" />
              {onNewSessionInGroup && (
                <Button variant="ghost" fullWidth className={item}
                  onPress={() => {
                    onNewSessionInGroup(derived ? (parentId ?? groupMenu.groupId) : groupMenu.groupId, derived ? grp.worktreePath : undefined);
                    setGroupMenu(null);
                  }}>
                  New session {derived ? 'in this worktree' : 'here'}
                </Button>
              )}
              {onOpenGroupComposer && !derived && (
                <Button variant="ghost" fullWidth className={item}
                  onPress={() => { onOpenGroupComposer(groupMenu.groupId); setGroupMenu(null); }}>
                  New session…
                </Button>
              )}
              {onCreateSubgroup && !derived && (
                <Button variant="ghost" fullWidth className={`${item} flex items-center gap-2`}
                  onPress={() => { onCreateSubgroup(groupMenu.groupId); setGroupMenu(null); }}>
                  <FolderPlus size={12} className="text-zinc-500" />
                  New subgroup
                </Button>
              )}

              {derived ? (
                <div className="px-3 py-2 text-[10px] text-zinc-600 leading-relaxed border-t border-border mt-1">
                  Automatic group. Every session here shares the worktree
                  <span className="font-mono text-zinc-500"> {grp.name}</span>. It dissolves on its own
                  once fewer than two remain — drag a session out to detach it.
                </div>
              ) : (
                <>
                  <div className="px-3 py-1.5">
                    <div className="text-[10px] text-zinc-600 mb-1">
                      Color {!grp.color && <span className="text-zinc-700">· inherited</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {Object.entries(COLOR_MAP).map(([key, c]) => (
                        <Button key={key}
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={`Color ${key}`}
                          className={`w-4 h-4 min-w-0 p-0 rounded-full ${c.dot} transition-transform ${grp.color === key ? 'ring-2 ring-white/40 scale-110' : 'hover:scale-110'}`}
                          onPress={() => { onChangeGroupColor(groupMenu.groupId, key); setGroupMenu(null); }}
                        />
                      ))}
                    </div>
                  </div>
                  {onChangeGroupIcon && (
                    <div className="px-3 py-1.5">
                      <IconPicker
                        currentIcon={grp.icon}
                        currentColor={resolveGroupColor(tabGroups, groupMenu.groupId)}
                        onSelect={(key) => { onChangeGroupIcon(groupMenu.groupId, key); }}
                        onClear={() => { onChangeGroupIcon(groupMenu.groupId, null); }}
                      />
                    </div>
                  )}

                  {onMoveGroup && (parentId || moveTargets.length > 0) && (
                    <>
                      <div className="h-px bg-border mx-2 my-1" />
                      <div className="px-3 py-1 text-[10px] text-zinc-600 uppercase tracking-wider">Move to</div>
                      {parentId && (
                        <Button variant="ghost" fullWidth className={item}
                          onPress={() => { onMoveGroup(groupMenu.groupId, null); setGroupMenu(null); }}>
                          Top level
                        </Button>
                      )}
                      {moveTargets.slice(0, 12).map(g => (
                        <Button key={g.id} variant="ghost" fullWidth className={`${item} flex items-center gap-2`}
                          onPress={() => { onMoveGroup(groupMenu.groupId, g.id); setGroupMenu(null); }}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${(COLOR_MAP[resolveGroupColor(tabGroups, g.id)] || COLOR_MAP.blue!).dot}`} />
                          <span className="truncate">{g.name}</span>
                        </Button>
                      ))}
                    </>
                  )}

                  <div className="h-px bg-border mx-2 my-1" />
                  <Button variant="ghost" fullWidth className={item}
                    onPress={() => {
                      const members = sessions.filter(s => tabGroupMap[s.id] === groupMenu.groupId);
                      for (const m of members) props.onUngroupTab(m.id);
                      // Children move up a level rather than being orphaned.
                      for (const child of Object.values(tabGroups)) {
                        if ((child.parentId ?? null) === groupMenu.groupId) onMoveGroup?.(child.id, parentId);
                      }
                      setGroupMenu(null);
                    }}>
                    Ungroup all
                  </Button>
                  {onRequestDeleteGroup && (
                    <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                      onPress={() => { onRequestDeleteGroup(groupMenu.groupId); setGroupMenu(null); }}>
                      Delete group and {subtreeCount} {subtreeCount === 1 ? 'session' : 'sessions'}…
                    </Button>
                  )}
                </>
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
            <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl min-w-[180px] max-w-[260px] py-1 overflow-y-auto"
              style={{ top: tabMenu.y, left: tabMenu.x, maxHeight: `calc(100vh - ${tabMenu.y}px - 12px)` }}>

              {/* Rename */}
              <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors"
                onPress={() => {
                  const s = sessions.find(s => s.id === tabMenu.tabId);
                  if (s) startRename(s);
                  setTabMenu(null);
                }}>
                Rename
              </Button>

              {/* Detach from the automatic worktree group. The session stays in
                  the same project group, it just stops being clustered. */}
              {onPinSessionOutOfWorktree && derivedMembership.has(tabMenu.tabId) && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                  onPress={() => { onPinSessionOutOfWorktree(tabMenu.tabId); setTabMenu(null); }}>
                  <GitBranch size={11} strokeWidth={2.25} className="text-zinc-500" />
                  Detach from worktree group
                </Button>
              )}
              {onPinSessionOutOfWorktree && props.pinnedOutOfWorktree?.has(tabMenu.tabId) && (
                <Button variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                  onPress={() => { onPinSessionOutOfWorktree(tabMenu.tabId); setTabMenu(null); }}>
                  <GitBranch size={11} strokeWidth={2.25} className="text-zinc-500" />
                  Rejoin worktree group
                </Button>
              )}

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
                    const c = COLOR_MAP[resolveGroupColor(tabGroups, g.id)] || COLOR_MAP.blue!;
                    // Nesting makes bare names ambiguous — show the path so two
                    // "Backend" subgroups under different repos are telling apart.
                    const path = ancestorChain(tabGroups, g.id).slice(1).reverse().map(id => tabGroups[id]?.name).filter(Boolean);
                    return (
                      <Button key={g.id} variant="ghost" fullWidth className="text-left justify-start px-3 py-1.5 h-auto rounded-none text-[12px] text-zinc-400 hover:bg-surface-light hover:text-zinc-200 transition-colors flex items-center gap-2"
                        onPress={() => { onAddToGroup(tabMenu.tabId, g.id); setTabMenu(null); }}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                        <span className="truncate">
                          {path.length > 0 && <span className="text-zinc-600">{path.join(' › ')} › </span>}
                          {g.name}
                        </span>
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
