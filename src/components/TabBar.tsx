import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, ChevronUp, ChevronRight, Search, Archive, X, Pin, History, Plus, Zap,
  Cog, Antenna, LayoutGrid, List, Rows3, FolderTree, SlidersHorizontal, Clock,
  ChevronsDownUp, ChevronsUpDown,
  type LucideIcon,
} from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import { useDrag, useDrop, mergeProps } from 'react-aria';
import type { SessionInfo, ConnectionStatus, SessionActivity } from '../lib/claude-client';
import { DEFAULT_STATUSES, STATUS_ICON, STATUS_COLORS, resolveStatus, projectRootOf, type StatusDef, type LaneSignals } from '../lib/session-status';
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
  /** Active top-level view shown in the main pane. Drives the nav highlight at
   *  the top of the sidebar (sessions list vs Automations). */
  activeNavView?: 'sessions' | 'automations' | 'sessions-board';
  /** Switch the main pane to a top-level view. */
  onSelectNavView?: (view: 'sessions' | 'automations' | 'sessions-board') => void;
  /** Manual per-session status override (sessionId → status id). Takes
   *  precedence over the runtime-derived status in the Status/Project views. */
  sessionLane?: Record<string, string>;
  /** Persist a manual status for a session (null clears it → automatic). */
  onSetSessionLane?: (sessionId: string, lane: string | null) => void;
  /** Per-project custom status sets (project root → statuses). Projects not
   *  present here fall back to DEFAULT_STATUSES. */
  projectStatuses?: Record<string, StatusDef[]>;
  /** Persist a project's custom status set (writes <root>/.codiby/settings.json). */
  onSetProjectStatuses?: (projectRoot: string, statuses: StatusDef[]) => void;
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

// Session-status lanes (LANE_DEFS / LaneId / resolveLane) now live in
// ../lib/session-status so the titlebar status picker shares them.

// Stable accent for a project (its cwd), hashed into a small palette so the
// same folder always gets the same swatch across renders/sessions.
const PROJECT_PALETTE = ['#818cf8', '#34d399', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf'];
function projectColorFor(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length]!;
}
// `projectRootOf` now lives in ../lib/session-status (shared with ChatApp).
function projectLabel(path: string): string {
  if (!path) return 'No folder';
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}
function shortPath(path: string): string {
  if (!path) return '';
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
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

// Custom drag type carrying the session id between a StatusCard and a
// DroppableLane. Kept app-specific so unrelated text drops are ignored.
const SESSION_DRAG_TYPE = 'application/x-codiby-session';
// Custom drag type carrying a project root path when reordering project cards
// in the "Project" view.
const PROJECT_DRAG_TYPE = 'application/x-codiby-project';
// Custom drag type carrying a tab-group id when reordering groups in the List view.
const GROUP_DRAG_TYPE = 'application/x-codiby-group';

// Grouped-view row — react-aria draggable AND a drop target. Dropping it on a
// DroppableLane reassigns the session's manual status; dropping another card
// onto THIS one reorders within the lane (or moves + reorders across lanes).
//
// Live displacement: while a card is dragged over this one, this row slides
// down (a gap opens above it) to show where the dropped card will land; the
// dragged row itself collapses to height 0 so it appears to leave its slot.
// Drag is suppressed while renaming.
function StatusCard(props: RowProps & { onDropCard: (draggedId: string) => void; onDragActive?: (active: boolean) => void; accentColor?: string }) {
  const { onDropCard, onDragActive, accentColor, ...row } = props;
  const editing = props.editingId === props.session.id;
  const ref = useRef<HTMLDivElement | null>(null);
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [SESSION_DRAG_TYPE]: props.session.id, 'text/plain': props.session.name }],
    onDragStart: () => onDragActive?.(true),
    onDragEnd: () => onDragActive?.(false),
  });
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) => (types.has(SESSION_DRAG_TYPE) ? 'move' : 'cancel'),
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === 'text' && item.types.has(SESSION_DRAG_TYPE)) {
          const id = await item.getText(SESSION_DRAG_TYPE);
          if (id && id !== props.session.id) onDropCard(id);
          break;
        }
      }
    },
  });
  const handlers = (editing ? dropProps : mergeProps(dragProps, dropProps)) as React.HTMLAttributes<HTMLElement>;
  // Open the gap with PADDING (not margin) so it grows *inside* the drop
  // target's box — the row's top stays put and the cursor keeps hovering it,
  // which avoids the open→escape→close flicker that margin/height changes cause.
  // The dragged row only dims (collapsing the source mid-dragstart makes the
  // browser abort the drag, which also flickers). ~30px ≈ one compact row.
  const dropping = isDropTarget && !isDragging;
  const style: React.CSSProperties = {
    transition: 'padding-top 160ms ease, opacity 140ms ease, background-color 140ms ease',
    paddingTop: dropping ? 30 : 0,
    // Tint the opened gap with the lane accent so the drop target between rows
    // reads as "drop here" — the parent DroppableLane's isDropTarget never fires
    // while the cursor is over a child row, so colour the row itself.
    borderRadius: 6,
    ...(dropping && accentColor
      ? { background: `${accentColor}14`, boxShadow: `inset 0 1.5px 0 ${accentColor}` }
      : {}),
    ...(isDragging ? { opacity: 0.4 } : {}),
  };
  return (
    <div ref={ref} {...handlers} style={style}>
      <TabRowVisual {...row} dragging={false} />
    </div>
  );
}

// A status lane that accepts dropped session cards. `onDropSession` fires with
// the dragged session id; the caller persists the new lane. `dropStyle` is
// merged over `style` while a drag hovers, so the lane can flash its accent.
function DroppableLane({ onDropSession, className, style, dropStyle, children }: {
  onDropSession: (sessionId: string) => void; className?: string; style?: React.CSSProperties; dropStyle?: React.CSSProperties;
  // Children may be a render function so an opaque child (e.g. a collapsed
  // status header) can reflect the drop-target state itself.
  children: React.ReactNode | ((isDropTarget: boolean) => React.ReactNode);
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) => (types.has(SESSION_DRAG_TYPE) ? 'move' : 'cancel'),
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === 'text' && item.types.has(SESSION_DRAG_TYPE)) {
          const id = await item.getText(SESSION_DRAG_TYPE);
          if (id) onDropSession(id);
          break;
        }
      }
    },
  });
  return (
    <div ref={ref} {...dropProps} className={className} style={{ ...style, ...(isDropTarget ? dropStyle : undefined) }}>
      {typeof children === 'function' ? children(isDropTarget) : children}
    </div>
  );
}

// A project card in the "Project" view. Its header is a react-aria drag source
// + drop target for reordering projects; an above/below line shows where the
// dragged project will land (computed from the cursor Y over the header, so the
// indicator never shifts layout and can't flicker). Body passed as children.
function ProjectGroup({ path, label, swatch, sub, chips, chevron, isCollapsed, onToggle, onReorderProject, statuses, onSetStatuses, children }: {
  path: string; label: string; swatch: string; sub: string; chips: React.ReactNode; chevron: React.ReactNode;
  isCollapsed: boolean; onToggle: () => void;
  onReorderProject: (fromPath: string, toPath: string, position: 'above' | 'below') => void;
  statuses: StatusDef[]; onSetStatuses?: (next: StatusDef[]) => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const editBtnRef = useRef<HTMLButtonElement>(null);
  // The OUTER wrapper is the drop target; its padding opens the gap, so the
  // whole card (and every project below it) slides to make room — flicker-free
  // because the padding grows inside the target's own box. Only PROJECT drags
  // are accepted, so dragging a status/session card never lights this up.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<'above' | 'below' | null>(null);
  const posAt = (y: number): 'above' | 'below' => {
    const el = cardRef.current;
    if (!el) return 'above';
    return y < el.getBoundingClientRect().height / 2 ? 'above' : 'below';
  };
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [PROJECT_DRAG_TYPE]: path, 'text/plain': label }],
    onDragEnd: () => setPos(null),
  });
  const { dropProps, isDropTarget } = useDrop({
    ref: cardRef,
    getDropOperation: (types) => (types.has(PROJECT_DRAG_TYPE) ? 'move' : 'cancel'),
    onDropMove(e) { setPos(posAt(e.y)); },
    onDropExit() { setPos(null); },
    async onDrop(e) {
      const position = posAt(e.y);
      let from = '';
      for (const item of e.items) {
        if (item.kind === 'text' && item.types.has(PROJECT_DRAG_TYPE)) { from = await item.getText(PROJECT_DRAG_TYPE); break; }
      }
      setPos(null);
      if (from && from !== path) onReorderProject(from, path, position);
    },
  });
  const gapAbove = isDropTarget && !isDragging && pos === 'above';
  const gapBelow = isDropTarget && !isDragging && pos === 'below';
  return (
    <div
      ref={cardRef}
      {...dropProps}
      style={{
        transition: 'padding-top 160ms ease, padding-bottom 160ms ease, opacity 140ms ease',
        paddingTop: gapAbove ? 34 : 0,
        paddingBottom: gapBelow ? 34 : 0,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <div {...dragProps}>
          <button
            type="button"
            onClick={onToggle}
            className="w-full flex items-center gap-2 px-2.5 h-9 hover:bg-surface-light transition-colors cursor-grab active:cursor-grabbing"
          >
            <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: swatch }} />
            <span className="flex flex-col min-w-0 items-start leading-tight">
              <span className="text-[11.5px] font-bold text-zinc-300 truncate max-w-full">{label}</span>
              {sub && <span className="text-[9px] text-zinc-600 font-mono truncate max-w-full">{sub}</span>}
            </span>
            <span className="ml-auto flex items-center gap-1 shrink-0">{chips}</span>
            {chevron}
          </button>
        </div>
        {onSetStatuses && (
          <div className="relative">
            <button
              ref={editBtnRef}
              type="button"
              onClick={() => setEditing(v => !v)}
              title="Edit statuses"
              aria-label="Edit statuses"
              className={`absolute right-1.5 -top-7 w-6 h-6 grid place-items-center rounded-md transition-colors ${editing ? 'text-zinc-200 bg-surface-light' : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface-light'}`}
            >
              <SlidersHorizontal size={12} strokeWidth={2} />
            </button>
            {editing && (
              <ProjectStatusEditor
                statuses={statuses}
                onSave={(next) => onSetStatuses(next)}
                onClose={() => setEditing(false)}
                anchorRef={editBtnRef}
              />
            )}
          </div>
        )}
        {!isCollapsed && children}
      </div>
    </div>
  );
}

// Inline editor for a project's custom status set. Add / rename / recolor /
// remove / reorder; every change persists immediately via `onSave`.
function ProjectStatusEditor({ statuses, onSave, onClose, anchorRef }: {
  statuses: StatusDef[]; onSave: (next: StatusDef[]) => void; onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose, anchorRef]);
  const update = (i: number, patch: Partial<StatusDef>) => onSave(statuses.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onSave(statuses.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= statuses.length) return;
    const next = statuses.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onSave(next);
  };
  const add = () => {
    const id = `custom-${statuses.length}-${(seq.current = seq.current + 1)}`;
    onSave([...statuses, { id, label: 'New status', color: STATUS_COLORS[statuses.length % STATUS_COLORS.length]! }]);
  };
  const cycleColor = (i: number, color: string) => {
    const idx = STATUS_COLORS.indexOf(color);
    update(i, { color: STATUS_COLORS[(idx + 1) % STATUS_COLORS.length]! });
  };
  // Render in a portal with fixed positioning so it floats ABOVE the project
  // card instead of being clipped by the card's `overflow-hidden`.
  const rect = anchorRef.current?.getBoundingClientRect();
  const WIDTH = 240;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = rect ? Math.max(8, Math.min(rect.right - WIDTH, vw - WIDTH - 8)) : 8;
  const top = rect ? rect.bottom + 6 : 60;
  return createPortal(
    <div ref={ref} className="fixed z-[10000] w-60 bg-surface border border-border-light rounded-lg shadow-2xl p-2" style={{ top, left }}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 px-1 pb-1.5">Project statuses</div>
      <div className="flex flex-col gap-1">
        {statuses.map((s, i) => (
          <div key={s.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => cycleColor(i, s.color)}
              title="Change color"
              className="w-4 h-4 rounded-full shrink-0 ring-1 ring-black/20"
              style={{ background: s.color }}
            />
            <input
              value={s.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 min-w-0 bg-[#131418] border border-border rounded px-1.5 h-6 text-[12px] text-zinc-200 outline-none focus:border-border-light"
            />
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up"
              className="w-5 h-6 grid place-items-center text-zinc-600 hover:text-zinc-300 disabled:opacity-30">
              <ChevronUp size={12} />
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === statuses.length - 1} title="Move down"
              className="w-5 h-6 grid place-items-center text-zinc-600 hover:text-zinc-300 disabled:opacity-30">
              <ChevronDown size={12} />
            </button>
            <button type="button" onClick={() => remove(i)} disabled={statuses.length <= 1} title="Remove"
              className="w-5 h-6 grid place-items-center text-zinc-600 hover:text-red-400 disabled:opacity-30">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-border">
        <button type="button" onClick={add}
          className="flex items-center gap-1 px-1.5 h-6 rounded text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-surface-light transition-colors">
          <Plus size={12} /> Add status
        </button>
        <button type="button" onClick={() => onSave(DEFAULT_STATUSES)}
          className="px-1.5 h-6 rounded text-[10.5px] text-zinc-500 hover:text-zinc-300 transition-colors" title="Reset to the default statuses">
          Reset
        </button>
      </div>
    </div>,
    document.body,
  );
}

function SortableGroupTab({ group, memberCount, isExpanded, hasActive, hasActivity, remoteName, remoteColor, onToggle, onRename, onMenuOpen, onOpenComposer, onDropSession, onReorderGroup }: {
  group: TabGroup; memberCount: number; isExpanded: boolean; hasActive: boolean; hasActivity?: boolean;
  remoteName?: string | null; remoteColor?: string | null;
  onToggle: () => void; onRename: (name: string) => void; onMenuOpen: (x: number, y: number) => void;
  onOpenComposer: () => void; onDropSession: (sessionId: string) => void;
  onReorderGroup?: (fromGid: string, toGid: string, position: 'above' | 'below') => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<'above' | 'below' | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const posAt = (y: number): 'above' | 'below' => {
    const el = ref.current;
    if (!el) return 'above';
    return y < el.getBoundingClientRect().height / 2 ? 'above' : 'below';
  };
  // Drag the header to reorder the group; suppressed while renaming.
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [GROUP_DRAG_TYPE]: group.id, 'text/plain': group.name }],
    onDragEnd: () => setPos(null),
  });
  // The header is also a drop target: a tab dropped on it joins the group; a
  // group dropped on it reorders (shows an above/below indicator). The drop
  // events don't carry the drag types, so we capture them in getDropOperation.
  const dragKind = useRef<'group' | 'session' | null>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref,
    getDropOperation: (types) => {
      dragKind.current = types.has(GROUP_DRAG_TYPE) ? 'group' : types.has(SESSION_DRAG_TYPE) ? 'session' : null;
      return dragKind.current ? 'move' : 'cancel';
    },
    onDropMove(e) { setPos(dragKind.current === 'group' ? posAt(e.y) : null); },
    onDropExit() { setPos(null); },
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind !== 'text') continue;
        if (item.types.has(SESSION_DRAG_TYPE)) {
          const id = await item.getText(SESSION_DRAG_TYPE);
          setPos(null);
          if (id) onDropSession(id);
          return;
        }
        if (item.types.has(GROUP_DRAG_TYPE)) {
          const fromGid = await item.getText(GROUP_DRAG_TYPE);
          const position = posAt(e.y);
          setPos(null);
          if (fromGid && fromGid !== group.id) onReorderGroup?.(fromGid, group.id, position);
          return;
        }
      }
      setPos(null);
    },
  });
  const colors = COLOR_MAP[group.color] || COLOR_MAP.blue!;
  // Only the tab-add affordance (session hover) lights the ring; group reorder
  // uses the above/below line instead.
  const sessionHover = isDropTarget && pos === null;

  // Vertical sidebar: drop the filled background and border — the colored dot
  // alone is enough, keeping the sidebar visually clean (Arc/Zen style).
  const baseCls = `group relative flex items-center gap-1.5 px-2 h-[28px] text-[12px] cursor-grab active:cursor-grabbing rounded-md transition-colors ${sessionHover ? `ring-1 ${colors.ring}` : ''} hover:bg-surface/60 ${hasActive && !isExpanded ? 'text-zinc-200' : 'text-zinc-400'}`;

  return (
    <div ref={ref} {...mergeProps(editing ? {} : dragProps, dropProps)}
      className={baseCls}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      onClick={onToggle}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        onMenuOpen(e.clientX, e.clientY);
      }}
    >
      {isDropTarget && pos === 'above' && <div className="absolute -top-0.5 left-0 right-0 h-0.5 bg-indigo-400 rounded-full z-10" />}
      {isDropTarget && pos === 'below' && <div className="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-indigo-400 rounded-full z-10" />}
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
  const { sessions, closedSessions, activeSessionId, sessionStatuses, sessionStreaming, sessionInterrupted, sessionHasPermission, sessionActivity, sessionLastMessageAt,
    pinnedSessionIds, onTogglePin,
    onSelect, onNew, onClose, onReopen, onRename, onReorder,
    tabGroups, tabGroupMap, groupRemoteInfo, expandedGroupIds, sessionTurnComplete, onCreateGroup, onGroupTabs, onAddToGroup, onToggleGroup, onSelectGroup, onRenameGroup, onChangeGroupColor, onChangeGroupIcon, onNewSessionInGroup, onNewSessionInWorktreeForGroup, onArchiveSession, onRequestDelete, onRequestDeleteGroup,
    accentPalette, getSessionAccent, onPickSessionAccent,
    collapsed, onToggleCollapsed,
    activeNavView = 'sessions', onSelectNavView,
    sessionLane, onSetSessionLane, projectStatuses, onSetProjectStatuses } = props;

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

  // Session-list grouping mode — "flat" is the original tab-group view (with
  // drag-to-reorder / drag-to-group); "status" and "project" are read-oriented
  // groupings layered on top. Persisted so the choice sticks across launches.
  const [viewMode, setViewMode] = useState<'flat' | 'status' | 'project'>(() => {
    if (typeof window === 'undefined') return 'flat';
    try {
      const raw = localStorage.getItem('tabBarViewMode');
      if (raw === 'status' || raw === 'project' || raw === 'flat') return raw;
    } catch {}
    return 'flat';
  });
  useEffect(() => { try { localStorage.setItem('tabBarViewMode', viewMode); } catch {} }, [viewMode]);
  // Collapsed status/project sections, keyed by a stable section id.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const toggleSection = (key: string) => setCollapsedSections(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  // True while a session card is being dragged — empty status sub-sections are
  // hidden by default but revealed during a drag so they remain drop targets.
  const [draggingSession, setDraggingSession] = useState(false);
  // When on, sessions inside each status (Project view) are ordered by recency
  // (most recent activity first) instead of the manual tab order. Persisted.
  const [projectSortByDate, setProjectSortByDate] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('tabBarProjectSortByDate') === '1'; } catch { return false; }
  });
  const toggleProjectSortByDate = () => setProjectSortByDate(prev => {
    const next = !prev;
    try { localStorage.setItem('tabBarProjectSortByDate', next ? '1' : '0'); } catch {}
    return next;
  });
  // Manual ordering of project cards (by root path) in the Project view,
  // persisted. Projects not in the list fall back to alphabetical, appended.
  const [projectOrder, setProjectOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('tabBarProjectOrder');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  });
  const reorderProject = (fromPath: string, toPath: string, position: 'above' | 'below') => {
    setProjectOrder(prev => {
      // Normalise to a full ordering of the project roots that currently exist:
      // saved order first (still-present only), then any new ones alphabetically.
      const roots = [...new Set(sessions.map(s => projectRootOf(s.cwd || '')))];
      const known = prev.filter(p => roots.includes(p));
      const missing = roots.filter(p => !known.includes(p)).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
      let order = [...known, ...missing].filter(p => p !== fromPath);
      const ti = order.indexOf(toPath);
      if (ti === -1) return prev;
      order.splice(position === 'above' ? ti : ti + 1, 0, fromPath);
      try { localStorage.setItem('tabBarProjectOrder', JSON.stringify(order)); } catch {}
      return order;
    });
  };
  // Manual ordering of tab groups in the List view, persisted. Groups not in
  // the list are appended (new groups go to the end); the order is explicit so
  // groups never reshuffle on their own as member activity changes.
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem('tabBarGroupOrder');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  });
  const reorderGroup = (fromGid: string, toGid: string, position: 'above' | 'below') => {
    setGroupOrder(prev => {
      const present = [...new Set(sessions.map(s => tabGroupMap[s.id]).filter((g): g is string => !!g && !!tabGroups[g]))];
      const known = prev.filter(g => present.includes(g));
      const missing = present.filter(g => !known.includes(g));
      let order = [...known, ...missing].filter(g => g !== fromGid);
      const ti = order.indexOf(toGid);
      if (ti === -1) return prev;
      order.splice(position === 'above' ? ti : ti + 1, 0, fromGid);
      try { localStorage.setItem('tabBarGroupOrder', JSON.stringify(order)); } catch {}
      return order;
    });
  };
  const laneSig: LaneSignals = {
    hasPermission: sessionHasPermission,
    streaming: sessionStreaming,
    interrupted: sessionInterrupted,
    statuses: sessionStatuses,
    turnComplete: sessionTurnComplete,
  };
  // The status set for a project root (its custom set, or the defaults).
  const statusesFor = (root: string): StatusDef[] => projectStatuses?.[root] ?? DEFAULT_STATUSES;
  // A session's status id, resolved against a given status set.
  const laneOfIn = (s: SessionInfo, statuses: StatusDef[]): string => resolveStatus(s.id, sessionLane, laneSig, statuses);
  // Project-aware status of a session (uses its own project's status set).
  const laneOf = (s: SessionInfo): string => laneOfIn(s, statusesFor(projectRootOf(s.cwd || '')));

  // Build render structure. Groups render first, in their explicit manual order
  // (groupOrder); brand-new groups fall to the end (sorted by first appearance).
  // Ungrouped tabs follow, in their tabOrder. This keeps group order stable —
  // it only changes when the user drags a group header to reorder.
  type RenderItem = { type: 'tab'; session: SessionInfo } | { type: 'group'; groupId: string; members: SessionInfo[] };
  const renderList: RenderItem[] = [];

  const ungroupedTabs: SessionInfo[] = [];
  const groupMembers = new Map<string, SessionInfo[]>();
  const groupFirstIdx = new Map<string, number>();
  sessions.forEach((s, i) => {
    const gid = tabGroupMap[s.id];
    if (gid && tabGroups[gid]) {
      if (!groupMembers.has(gid)) { groupMembers.set(gid, []); groupFirstIdx.set(gid, i); }
      groupMembers.get(gid)!.push(s);
    } else {
      ungroupedTabs.push(s);
    }
  });
  const presentGids = [...groupMembers.keys()];
  const knownGids = groupOrder.filter(g => groupMembers.has(g));
  const newGids = presentGids
    .filter(g => !knownGids.includes(g))
    .sort((a, b) => (groupFirstIdx.get(a) ?? 0) - (groupFirstIdx.get(b) ?? 0));
  for (const gid of [...knownGids, ...newGids]) {
    // Sort group members: pinned first, then by last-message recency, with
    // tabOrder as a stable tiebreaker.
    const members = groupMembers.get(gid)!.slice().sort((a, b) => {
      const pa = pinnedSessionIds?.has(a.id) ? 1 : 0;
      const pb = pinnedSessionIds?.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ta = sessionLastMessageAt?.[a.id] || 0;
      const tb = sessionLastMessageAt?.[b.id] || 0;
      if (tb !== ta) return tb - ta;
      return sessions.indexOf(a) - sessions.indexOf(b);
    });
    renderList.push({ type: 'group', groupId: gid, members });
  }
  for (const s of ungroupedTabs) renderList.push({ type: 'tab', session: s });

  // react-aria drop handler for a tab dropped onto another tab. Mirrors the old
  // dnd-kit logic: Shift groups the two (or adds to the target's group), plain
  // drop reorders. Dropping onto a group header is handled by SortableGroupTab.
  const handleDropTab = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    if (shiftRef.current) {
      const targetGroupId = tabGroupMap[toId];
      if (targetGroupId) onAddToGroup(fromId, targetGroupId);
      else onGroupTabs(fromId, toId);
      return;
    }
    onReorder(fromId, toId);
  };

  // Grouped views (Status/Project): dropping a card onto another card. Within
  // the same lane it just reorders; across lanes it also sets the manual status
  // to the target's lane. `toId` is the card dropped onto; `targetLane` its lane.
  const handleDropInLane = (fromId: string, toId: string, targetStatusId: string) => {
    if (fromId === toId) return;
    const from = sessions.find(s => s.id === fromId);
    if (from && laneOf(from) !== targetStatusId) onSetSessionLane?.(fromId, targetStatusId);
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
  const SectionHeader = ({ sectionKey, label, color, count, icon: Icon, height, small }: {
    sectionKey: string; label: string; color: string; count: number; icon?: LucideIcon; height: string; small?: boolean;
  }) => {
    const isCollapsed = collapsedSections.has(sectionKey);
    const Chevron = isCollapsed ? ChevronRight : ChevronDown;
    return (
      <button
        type="button"
        onClick={() => toggleSection(sectionKey)}
        className={`w-full flex items-center gap-1.5 px-2 ${height} hover:bg-surface/50 transition-colors`}
      >
        {Icon
          ? <Icon size={small ? 11 : 12} strokeWidth={2.2} style={{ color }} className="shrink-0" />
          : <span className={`${small ? 'w-1.5 h-1.5' : 'w-2 h-2'} rounded-full shrink-0`} style={{ background: color }} />}
        <span className={`${small ? 'text-[9.5px]' : 'text-[10.5px]'} font-bold uppercase tracking-wide truncate`} style={{ color }}>{label}</span>
        <span className={`ml-auto ${small ? 'text-[9.5px]' : 'text-[10px]'} font-semibold text-zinc-600`}>{count}</span>
        <Chevron size={small ? 11 : 12} className="text-zinc-600 shrink-0" />
      </button>
    );
  };

  // "Status" view: a global board using the DEFAULT statuses (per-project custom
  // sets only apply inside the Project view). Buckets every session by status.
  const renderStatusMode = () => {
    const byLane = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const l = laneOfIn(s, DEFAULT_STATUSES);
      const arr = byLane.get(l) || []; arr.push(s); byLane.set(l, arr);
    }
    // Render every status (even empty ones) so a card can be dropped into any
    // status. Each lane is a react-aria drop target that persists the move.
    return (
      <div className="flex flex-col gap-1.5">
        {DEFAULT_STATUSES.map(def => {
          const items = byLane.get(def.id) || [];
          // Hide statuses with no sessions, unless a drag is in progress (so
          // they stay available as drop targets).
          if (items.length === 0 && !draggingSession) return null;
          const key = `status:${def.id}`;
          const collapsed = collapsedSections.has(key);
          return (
            <DroppableLane
              key={key}
              onDropSession={(id) => onSetSessionLane?.(id, def.id)}
              className="rounded-md bg-surface/60 transition-colors"
              style={{ borderLeft: `2px solid ${def.color}` }}
              dropStyle={{ background: `${def.color}14`, boxShadow: `inset 0 0 0 1.5px ${def.color}` }}
            >
              <SectionHeader sectionKey={key} label={def.label} color={def.color} count={items.length} icon={STATUS_ICON[def.id]} height="h-7" />
              {!collapsed && (
                <div className="flex flex-col gap-0.5 px-1 pb-1.5">
                  {items.map(s => <StatusCard key={s.id} {...tp(s, undefined, true)} accentColor={def.color} onDragActive={setDraggingSession} onDropCard={(from) => handleDropInLane(from, s.id, def.id)} />)}
                  {items.length === 0 && (
                    <div className="px-2 py-1.5 text-[10px] text-zinc-600 text-center">Drop here</div>
                  )}
                </div>
              )}
            </DroppableLane>
          );
        })}
      </div>
    );
  };

  // "Project" view: group by cwd, then by lane within each project. The
  // project header carries a count chip per status present.
  const renderProjectMode = () => {
    const byProj = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const p = projectRootOf(s.cwd || '');
      const arr = byProj.get(p) || []; arr.push(s); byProj.set(p, arr);
    }
    // Order by the persisted projectOrder; unknown projects fall to the end,
    // alphabetically among themselves.
    const orderIndex = (p: string) => { const i = projectOrder.indexOf(p); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    const projects = [...byProj.entries()].sort((a, b) => {
      const ia = orderIndex(a[0]), ib = orderIndex(b[0]);
      if (ia !== ib) return ia - ib;
      return projectLabel(a[0]).localeCompare(projectLabel(b[0]));
    });
    const projKeys = projects.map(([p]) => `proj:${p}`);
    const allCollapsed = projKeys.length > 0 && projKeys.every(k => collapsedSections.has(k));
    const toggleAll = () => setCollapsedSections(prev => {
      const next = new Set(prev);
      if (allCollapsed) projKeys.forEach(k => next.delete(k));
      else projKeys.forEach(k => next.add(k));
      return next;
    });
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={toggleProjectSortByDate}
            className={`flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-medium transition-colors ${projectSortByDate ? 'text-indigo-300 bg-indigo-500/12' : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'}`}
            title={projectSortByDate ? 'Sorting by date within each status (click for manual order)' : 'Sort by date within each status'}
          >
            <Clock size={12} strokeWidth={2} />
            By date
          </button>
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-1 px-2 h-6 rounded-md text-[10.5px] font-medium text-zinc-500 hover:text-zinc-300 hover:bg-surface/50 transition-colors"
            title={allCollapsed ? 'Expand all projects' : 'Collapse all projects'}
          >
            {allCollapsed ? <ChevronsUpDown size={13} strokeWidth={2} /> : <ChevronsDownUp size={13} strokeWidth={2} />}
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
        {projects.map(([path, items]) => {
          const key = `proj:${path}`;
          const isCollapsed = collapsedSections.has(key);
          const color = projectColorFor(path);
          const statuses = statusesFor(path);
          const laneOfHere = (s: SessionInfo) => laneOfIn(s, statuses);
          const lanesIn = statuses.filter(d => items.some(s => laneOfHere(s) === d.id));
          const chips = lanesIn.map(d => {
            const n = items.filter(s => laneOfHere(s) === d.id).length;
            return (
              <span
                key={d.id}
                title={d.label}
                className="inline-flex items-center gap-1 text-[9.5px] font-bold px-1.5 py-px rounded-full"
                style={{ color: d.color, background: `${d.color}1f` }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: d.color }} />{n}
              </span>
            );
          });
          return (
            <ProjectGroup
              key={key}
              path={path}
              label={projectLabel(path)}
              swatch={color}
              sub={shortPath(path)}
              chips={chips}
              chevron={(isCollapsed ? <ChevronRight size={12} className="text-zinc-600 shrink-0" /> : <ChevronDown size={12} className="text-zinc-600 shrink-0" />)}
              isCollapsed={isCollapsed}
              onToggle={() => toggleSection(key)}
              onReorderProject={reorderProject}
              statuses={statuses}
              onSetStatuses={onSetProjectStatuses ? (next) => onSetProjectStatuses(path, next) : undefined}
            >
              {/* "Linear bars" layout: a full-width status header bar followed
                  by flush rows. The whole sub-section is the drop target. */}
              <div className="flex flex-col pb-1">
                {statuses.map(def => {
                  let li = items.filter(s => laneOfHere(s) === def.id);
                  // Hide empty statuses, unless dragging (keeps them droppable).
                  if (li.length === 0 && !draggingSession) return null;
                  if (projectSortByDate) {
                    li = [...li].sort((a, b) => (sessionLastMessageAt?.[b.id] || 0) - (sessionLastMessageAt?.[a.id] || 0));
                  }
                  const skey = `${key}:${def.id}`;
                  const subCollapsed = collapsedSections.has(skey);
                  const SubChevron = subCollapsed ? ChevronRight : ChevronDown;
                  // Drop sets the manual status; cwd is unchanged so the session
                  // stays under this project, just in a different status.
                  return (
                    <DroppableLane
                      key={skey}
                      onDropSession={(id) => onSetSessionLane?.(id, def.id)}
                      className="transition-colors"
                      dropStyle={{ boxShadow: `inset 0 0 0 1.5px ${def.color}` }}
                    >
                      {(isDrop) => (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleSection(skey)}
                            className={`w-full flex items-center gap-2 h-[26px] px-2.5 border-t border-border/60 transition-colors ${isDrop ? '' : 'bg-surface-light hover:bg-surface-lighter'}`}
                            style={isDrop ? { background: `${def.color}26` } : undefined}
                          >
                            <span className="w-[7px] h-[7px] rounded-[2px] shrink-0" style={{ background: def.color }} />
                            <span className="text-[10px] font-bold uppercase tracking-wide truncate" style={isDrop ? { color: def.color } : undefined}>{def.label}</span>
                            <span className="ml-auto text-[10px] font-semibold text-zinc-600">{li.length}</span>
                            <SubChevron size={11} className="text-zinc-600 shrink-0" />
                          </button>
                          {!subCollapsed && li.length > 0 && (
                            <div className="flex flex-col">
                              {li.map(s => <StatusCard key={s.id} {...tp(s, undefined, true)} accentColor={def.color} onDragActive={setDraggingSession} onDropCard={(from) => handleDropInLane(from, s.id, def.id)} />)}
                            </div>
                          )}
                          {!subCollapsed && li.length === 0 && (
                            <div className="px-2.5 py-1.5 text-[9.5px] text-zinc-600 text-center">Drop here</div>
                          )}
                        </>
                      )}
                    </DroppableLane>
                  );
                })}
              </div>
            </ProjectGroup>
          );
        })}
      </div>
    );
  };

  // The collapse toggle now lives in the host's activity bar (see ChatApp),
  // not inside the TabBar — keeping all chrome-toggle affordances in one
  // column avoids two places to click for the same thing.

  // Collapsed: render nothing. The host's activity bar carries the
  // re-expand toggle plus the new-session / history affordances, so a
  // collapsed TabBar would just duplicate that column.
  if (collapsed) return null;

  // Below this width the segmented control drops its labels to stay legible.
  const segIconsOnly = vertWidth < 196;

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
      {/* Top-level nav — switches the main pane between the sessions
          workspace and full-screen views like Automations. Sits above
          the group/session list. */}
      <div className="px-2 pt-2 pb-1 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onSelectNavView?.('sessions-board')}
          className={`w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-colors ${
            activeNavView === 'sessions-board'
              ? 'bg-surface-light text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
          }`}
        >
          <LayoutGrid size={15} strokeWidth={2} className="shrink-0" />
          <span className="flex-1 text-left">Sessions</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectNavView?.('automations')}
          className={`w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-colors ${
            activeNavView === 'automations'
              ? 'bg-surface-light text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface/50'
          }`}
        >
          <Zap size={15} strokeWidth={2} className="shrink-0" />
          <span className="flex-1 text-left">Automations</span>
        </button>
      </div>
      <div className="h-px bg-border mx-3 my-1" />
      {/* View-mode switcher — flat list (original), grouped by session status,
          or grouped by project then status. */}
      <div className="px-2 pb-1">
        <div className="flex items-center gap-0.5 p-0.5 bg-surface border border-border rounded-lg">
          {([
            { mode: 'flat',    label: 'List',    icon: List },
            { mode: 'status',  label: 'Status',  icon: Rows3 },
            { mode: 'project', label: 'Project', icon: FolderTree },
          ] as const).map(({ mode, label, icon: Icon }) => {
            const on = viewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                title={label}
                className={`flex-1 flex items-center justify-center gap-1.5 h-6 rounded-md text-[11px] font-medium transition-colors ${
                  on ? 'bg-surface-light text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Icon size={13} strokeWidth={2} className="shrink-0" />
                {!segIconsOnly && <span className="truncate">{label}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-2 overflow-y-auto flex-1">
        {viewMode === 'status' ? renderStatusMode()
          : viewMode === 'project' ? renderProjectMode()
          : (
          <div className="flex flex-col gap-0.5">
            {renderList.map(item => {
              if (item.type === 'tab') {
                return <ReorderTab key={item.session.id} {...tp(item.session)} onDropTab={(from) => handleDropTab(from, item.session.id)} />;
              }

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
                    onDropSession={(id) => onAddToGroup(id, item.groupId)}
                    onReorderGroup={reorderGroup}
                  />
                  {isExpanded && (
                    // Indent + colored left rail spans the full height of all
                    // child tabs (whatever that ends up being via gap-0.5).
                    <div className={`flex flex-col gap-0.5 pl-2 ml-3 border-l-2 ${colors.border}`}>
                      {item.members.map(m => <ReorderTab key={m.id} {...tp(m, group.color, true)} onDropTab={(from) => handleDropTab(from, m.id)} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}
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

              {/* Manual status — same thing dragging a card into a status does,
                  plus an "Auto" reset back to the runtime-derived status. Uses
                  the session's project status set. */}
              {onSetSessionLane && (() => {
                const tabCwd = sessions.find(s => s.id === tabMenu.tabId)?.cwd || '';
                const tabStatuses = statusesFor(projectRootOf(tabCwd));
                return (
                  <div className="px-3 py-1.5">
                    <div className="text-[10px] text-zinc-600 mb-1">Status</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {tabStatuses.map(d => {
                        const active = sessionLane?.[tabMenu.tabId] === d.id;
                        return (
                          <button
                            key={d.id}
                            aria-label={d.label}
                            title={d.label}
                            onClick={() => { onSetSessionLane(tabMenu.tabId, d.id); setTabMenu(null); }}
                            className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${active ? 'ring-2 ring-white/60' : 'ring-1 ring-black/20'}`}
                            style={{ backgroundColor: d.color }}
                          />
                        );
                      })}
                      {sessionLane?.[tabMenu.tabId] && (
                        <button
                          onClick={() => { onSetSessionLane(tabMenu.tabId, null); setTabMenu(null); }}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-0.5"
                          title="Back to automatic status"
                        >
                          Auto
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

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
