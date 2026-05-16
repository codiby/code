/**
 * Chat Focus layout — a tiled grid of chat panes for users who want to drive
 * several Claude sessions in parallel without the surrounding IDE chrome.
 *
 * Layout model: an ordered list of rows; each row contains one or more panes
 * arranged horizontally. Heights (between rows) and widths (between sibling
 * panes) are independently resizable. Panes can be drag-reordered:
 *   - dropping on the top/bottom edge of a pane splits into a new row;
 *   - dropping on the left/right edge inserts in the same row;
 *   - dropping on the center swaps the two panes.
 *
 * Panes map 1:1 to currently-open sessions. When a session is opened or
 * closed elsewhere, the grid reconciles in `useEffect` so the layout stays
 * consistent with the host's session list. Per-pane chat content is rendered
 * by a child component (wired in a follow-up step); this file owns only the
 * grid + drag/resize behavior.
 */
import { useState, useRef, useMemo } from 'react';
import type { ReactNode } from 'react';
import { X, GripVertical, Plus } from 'lucide-react';
import type { SessionInfo } from '../lib/claude-client';

export type Row = {
  id: string;
  height: number;          // flex ratio
  widths: number[];        // flex ratio per pane in this row
  paneIds: string[];       // session ids
};

export type Layout = { rows: Row[] };

/** A user-defined grouping of chats. Each workspace owns its own subset of
 *  open sessions plus the row/column arrangement for them, so the user can
 *  flip between contexts (e.g. "frontend", "infra") without disturbing the
 *  layout of the others. */
export type Workspace = {
  id: string;
  name: string;
  /** Optional accent color hint, falls back to a deterministic palette
   *  derived from the workspace id. */
  color?: string;
  /** Session ids assigned to this workspace. Subset of host's open
   *  sessions. */
  sessionIds: string[];
  /** Row/column arrangement for this workspace's panes. */
  layout: Layout;
};

type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center';

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  /** Render a composer for a given session id. Each pane in focus mode
   *  calls this so it can show the per-session "agent is thinking" loader
   *  animation and accept input independently of the other panes. */
  renderComposer?: (sessionId: string) => ReactNode;

  /** Render the message scroll area for a given session id. Mirrors
   *  `renderComposer` — the host owns the chat-content view, the grid
   *  just hands each pane its session id. */
  renderBody?: (sessionId: string) => ReactNode;

  /** Render extra controls inside a pane's title bar (e.g. browser-preview
   *  chips for that session). Sits between the session name and the close
   *  button. Returning `null` keeps the header minimal. */
  renderPaneHeaderExtras?: (sessionId: string) => ReactNode;

  /** Workspace state is owned by the host so the title bar can surface
   *  workspace-level actions ("add active chat to workspace", "new chat in
   *  workspace") next to the layout-mode switcher. */
  workspaces: Workspace[];
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>;
  activeWorkspaceId: string;
  setActiveWorkspaceId: React.Dispatch<React.SetStateAction<string>>;
  /** Close a workspace. Host decides what to do with sessions that lived in
   *  it (typically: nothing — sessions are owned at the host level and just
   *  lose this workspace grouping). The last remaining workspace cannot be
   *  closed; the workspace bar hides the close affordance in that case. */
  onCloseWorkspace?: (id: string) => void;
  /** Rename a workspace. Triggered by double-click on a workspace tile. */
  onRenameWorkspace?: (id: string, name: string) => void;
  /** Reorder workspaces by drag-and-drop on the workspace bar. `position`
   *  is relative to the target: 'above' inserts before, 'below' inserts
   *  after. */
  onReorderWorkspaces?: (fromId: string, toId: string, position: 'above' | 'below') => void;
}

const LS_KEY_WS = 'claude-ui-focus-workspaces';
const LS_KEY_ACTIVE_WS = 'claude-ui-focus-active-workspace';
const MIN_PANE_PX = 260;
const MIN_ROW_PX = 160;
const ZONE_EDGE = 0.28; // fraction of pane size that counts as an edge zone

const WORKSPACE_COLORS = [
  'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30',
];

function newRowId(): string {
  return 'r_' + Math.random().toString(36).slice(2, 8);
}

function newWorkspaceId(): string {
  return 'ws_' + Math.random().toString(36).slice(2, 8);
}

export function loadInitialWorkspaces(allSessionIds: string[]): {
  workspaces: Workspace[]; activeId: string;
} {
  try {
    const raw = localStorage.getItem(LS_KEY_WS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const stored = parsed as Workspace[];
        const storedActive = localStorage.getItem(LS_KEY_ACTIVE_WS) || stored[0]!.id;
        return {
          workspaces: stored,
          activeId: stored.find(w => w.id === storedActive)?.id ?? stored[0]!.id,
        };
      }
    }
  } catch {}
  // Seed with one workspace owning every currently-open session so the user
  // sees something on first load.
  const ws: Workspace = {
    id: newWorkspaceId(),
    name: 'Default',
    sessionIds: [...allSessionIds],
    layout: {
      rows: allSessionIds.length > 0 ? [{
        id: newRowId(),
        height: 1,
        widths: allSessionIds.map(() => 1),
        paneIds: [...allSessionIds],
      }] : [],
    },
  };
  return { workspaces: [ws], activeId: ws.id };
}

export function persistWorkspaces(workspaces: Workspace[], activeId: string): void {
  try {
    localStorage.setItem(LS_KEY_WS, JSON.stringify(workspaces));
    localStorage.setItem(LS_KEY_ACTIVE_WS, activeId);
  } catch {}
}

export { reconcile as reconcileWorkspaceLayout };

/** Returns a new layout that contains exactly the session ids in `ids`,
 *  preserving the order/structure of `prev` for ids that survive, appending
 *  newcomers to the last row, and dropping panes for missing ids (collapsing
 *  empty rows). */
function reconcile(prev: Layout, ids: string[]): Layout {
  const want = new Set(ids);
  const have = new Set<string>();
  const rows: Row[] = [];
  for (const row of prev.rows) {
    const keptPanes: string[] = [];
    const keptWidths: number[] = [];
    row.paneIds.forEach((pid, i) => {
      if (want.has(pid) && !have.has(pid)) {
        keptPanes.push(pid);
        keptWidths.push(row.widths[i] ?? 1);
        have.add(pid);
      }
    });
    if (keptPanes.length > 0) {
      rows.push({ id: row.id, height: row.height, widths: keptWidths, paneIds: keptPanes });
    }
  }
  const newcomers = ids.filter(id => !have.has(id));
  if (newcomers.length > 0) {
    if (rows.length === 0) {
      rows.push({ id: newRowId(), height: 1, widths: newcomers.map(() => 1), paneIds: newcomers });
    } else {
      const last = rows[rows.length - 1]!;
      last.paneIds.push(...newcomers);
      last.widths.push(...newcomers.map(() => 1));
    }
  }
  return { rows };
}

function pickZone(x: number, y: number, w: number, h: number): DropZone {
  const fx = x / w, fy = y / h;
  if (fy < ZONE_EDGE) return 'top';
  if (fy > 1 - ZONE_EDGE) return 'bottom';
  if (fx < ZONE_EDGE) return 'left';
  if (fx > 1 - ZONE_EDGE) return 'right';
  return 'center';
}

export function ChatFocusLayout({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  renderComposer,
  renderBody,
  renderPaneHeaderExtras,
  workspaces,
  setWorkspaces,
  activeWorkspaceId,
  setActiveWorkspaceId,
  onCloseWorkspace,
  onRenameWorkspace,
  onReorderWorkspaces,
}: Props) {
  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? workspaces[0]!,
    [workspaces, activeWorkspaceId],
  );
  const layout = activeWorkspace?.layout ?? { rows: [] };

  const setLayout = (updater: Layout | ((prev: Layout) => Layout)) => {
    setWorkspaces(prev => prev.map(w => {
      if (w.id !== activeWorkspaceId) return w;
      const next = typeof updater === 'function' ? updater(w.layout) : updater;
      return { ...w, layout: next };
    }));
  };

  const createWorkspace = () => {
    const id = newWorkspaceId();
    const idx = workspaces.length;
    const ws: Workspace = {
      id,
      name: `Workspace ${idx + 1}`,
      color: WORKSPACE_COLORS[idx % WORKSPACE_COLORS.length],
      sessionIds: [],
      layout: { rows: [] },
    };
    setWorkspaces(prev => [...prev, ws]);
    setActiveWorkspaceId(id);
  };

  const selectWorkspace = (id: string) => {
    setActiveWorkspaceId(id);
  };


  // Drag state — kept in a ref so the dragover handler does not re-render
  // 60 times a second. The drop indicator overlay is rendered from React
  // state but throttled by requestAnimationFrame.
  const dragRef = useRef<{ paneId: string } | null>(null);
  const [dropPreview, setDropPreview] = useState<{
    rect: DOMRect; zone: DropZone;
  } | null>(null);

  // ---------- Drag / drop -------------------------------------------------

  const onHeaderDragStart = (paneId: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', paneId);
    dragRef.current = { paneId };
  };

  const onHeaderDragEnd = () => {
    dragRef.current = null;
    setDropPreview(null);
  };

  const onPaneDragOver = (paneEl: HTMLElement) => (e: React.DragEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const rect = paneEl.getBoundingClientRect();
    const zone = pickZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    setDropPreview({ rect, zone });
  };

  const onPaneDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    const current = e.currentTarget as Node;
    if (next && current.contains(next)) return;
    setDropPreview(null);
  };

  const onPaneDrop = (targetPaneId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('text/plain') || dragRef.current?.paneId || '';
    setDropPreview(null);
    if (!fromId || fromId === targetPaneId) return;
    const paneEl = e.currentTarget as HTMLElement;
    const rect = paneEl.getBoundingClientRect();
    const zone = pickZone(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);

    setLayout(prev => applyDrop(prev, fromId, targetPaneId, zone));
  };

  // ---------- Resize ------------------------------------------------------

  const onColResizeStart = (rowIdx: number, leftIdx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const gridEl = (e.currentTarget as HTMLElement).closest('[data-focus-grid]') as HTMLElement;
    if (!gridEl) return;
    const rowEl = gridEl.querySelectorAll<HTMLElement>('[data-focus-row]')[rowIdx];
    if (!rowEl) return;
    const panes = rowEl.querySelectorAll<HTMLElement>('[data-focus-pane]');
    const leftEl = panes[leftIdx];
    const rightEl = panes[leftIdx + 1];
    if (!leftEl || !rightEl) return;
    const startX = e.clientX;
    const leftStart = leftEl.getBoundingClientRect().width;
    const rightStart = rightEl.getBoundingClientRect().width;
    const total = leftStart + rightStart;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const newLeft = Math.max(MIN_PANE_PX, Math.min(total - MIN_PANE_PX, leftStart + dx));
      const newRight = total - newLeft;
      // Live mutate DOM for smoothness; commit on mouseup.
      leftEl.style.flexGrow = String(newLeft);
      rightEl.style.flexGrow = String(newRight);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const newLeftGrow = Number(leftEl.style.flexGrow);
      const newRightGrow = Number(rightEl.style.flexGrow);
      setLayout(prev => {
        const rows = [...prev.rows];
        const row = { ...rows[rowIdx]! };
        row.widths = [...row.widths];
        row.widths[leftIdx] = newLeftGrow;
        row.widths[leftIdx + 1] = newRightGrow;
        rows[rowIdx] = row;
        return { rows };
      });
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const onRowResizeStart = (aboveIdx: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const gridEl = (e.currentTarget as HTMLElement).closest('[data-focus-grid]') as HTMLElement;
    if (!gridEl) return;
    const rows = gridEl.querySelectorAll<HTMLElement>('[data-focus-row]');
    const aboveEl = rows[aboveIdx];
    const belowEl = rows[aboveIdx + 1];
    if (!aboveEl || !belowEl) return;
    const startY = e.clientY;
    const aboveStart = aboveEl.getBoundingClientRect().height;
    const belowStart = belowEl.getBoundingClientRect().height;
    const total = aboveStart + belowStart;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const newAbove = Math.max(MIN_ROW_PX, Math.min(total - MIN_ROW_PX, aboveStart + dy));
      const newBelow = total - newAbove;
      aboveEl.style.flexGrow = String(newAbove);
      belowEl.style.flexGrow = String(newBelow);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const aGrow = Number(aboveEl.style.flexGrow);
      const bGrow = Number(belowEl.style.flexGrow);
      setLayout(prev => {
        const rows = prev.rows.map((r, i) => {
          if (i === aboveIdx) return { ...r, height: aGrow };
          if (i === aboveIdx + 1) return { ...r, height: bGrow };
          return r;
        });
        return { rows };
      });
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ---------- Render ------------------------------------------------------

  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const dragging = dragRef.current?.paneId ?? null;

  return (
    <div className="flex-1 flex min-h-0 min-w-0 bg-base relative">
      <WorkspaceBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelect={selectWorkspace}
        onCreate={createWorkspace}
        onClose={onCloseWorkspace}
        onRename={onRenameWorkspace}
        onReorder={onReorderWorkspaces}
      />
      <div className="flex-1 flex flex-col min-h-0 min-w-0 relative" data-focus-grid>
      {/* Grid */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-2 gap-0">
        {layout.rows.map((row, rIdx) => (
          <RowView
            key={row.id}
            row={row}
            rIdx={rIdx}
            isLast={rIdx === layout.rows.length - 1}
            sessionById={sessionById}
            activeSessionId={activeSessionId}
            dragging={dragging}
            renderComposer={renderComposer}
            renderBody={renderBody}
            renderPaneHeaderExtras={renderPaneHeaderExtras}
            onHeaderDragStart={onHeaderDragStart}
            onHeaderDragEnd={onHeaderDragEnd}
            onPaneDragOver={onPaneDragOver}
            onPaneDragLeave={onPaneDragLeave}
            onPaneDrop={onPaneDrop}
            onColResizeStart={onColResizeStart}
            onRowResizeStart={onRowResizeStart}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        ))}
        {layout.rows.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
            No chats open.
          </div>
        )}
      </div>

      {/* Drop indicator overlay (rendered above all panes) */}
      {dropPreview && <DropIndicator rect={dropPreview.rect} zone={dropPreview.zone} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function RowView(props: {
  row: Row;
  rIdx: number;
  isLast: boolean;
  sessionById: Map<string, SessionInfo>;
  activeSessionId: string | null;
  dragging: string | null;
  renderComposer?: (sessionId: string) => ReactNode;
  renderBody?: (sessionId: string) => ReactNode;
  renderPaneHeaderExtras?: (sessionId: string) => ReactNode;
  onHeaderDragStart: (paneId: string) => (e: React.DragEvent) => void;
  onHeaderDragEnd: () => void;
  onPaneDragOver: (paneEl: HTMLElement) => (e: React.DragEvent) => void;
  onPaneDragLeave: (e: React.DragEvent) => void;
  onPaneDrop: (paneId: string) => (e: React.DragEvent) => void;
  onColResizeStart: (rowIdx: number, leftIdx: number) => (e: React.MouseEvent) => void;
  onRowResizeStart: (aboveIdx: number) => (e: React.MouseEvent) => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}) {
  const { row, rIdx, isLast, sessionById, activeSessionId, dragging } = props;
  return (
    <>
      <div
        data-focus-row
        className="flex min-h-0 gap-0"
        style={{ flex: row.height }}
      >
        {row.paneIds.map((pid, cIdx) => {
          const s = sessionById.get(pid);
          return (
            <PaneShell
              key={pid}
              session={s}
              paneId={pid}
              isActive={activeSessionId === pid}
              flex={row.widths[cIdx] ?? 1}
              dragging={dragging}
              showRightHandle={cIdx < row.paneIds.length - 1}
              composer={props.renderComposer ? props.renderComposer(pid) : null}
              body={props.renderBody ? props.renderBody(pid) : null}
              headerExtras={props.renderPaneHeaderExtras ? props.renderPaneHeaderExtras(pid) : null}
              onColResizeStart={props.onColResizeStart(rIdx, cIdx)}
              onHeaderDragStart={props.onHeaderDragStart(pid)}
              onHeaderDragEnd={props.onHeaderDragEnd}
              onPaneDragOver={props.onPaneDragOver}
              onPaneDragLeave={props.onPaneDragLeave}
              onPaneDrop={props.onPaneDrop(pid)}
              onSelect={() => props.onSelectSession(pid)}
              onClose={() => props.onCloseSession(pid)}
            />
          );
        })}
      </div>
      {!isLast && (
        <div className="relative" style={{ height: 0 }}>
          {/* Row resize handle, hovers between the two rows */}
          <div
            onMouseDown={props.onRowResizeStart(rIdx)}
            className="absolute left-0 right-0 -top-1 h-2 cursor-row-resize z-10 group"
          >
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-border group-hover:bg-zinc-500" />
          </div>
        </div>
      )}
    </>
  );
}

function PaneShell(props: {
  session: SessionInfo | undefined;
  paneId: string;
  isActive: boolean;
  flex: number;
  dragging: string | null;
  showRightHandle: boolean;
  composer: ReactNode;
  body: ReactNode;
  headerExtras?: ReactNode;
  onColResizeStart: (e: React.MouseEvent) => void;
  onHeaderDragStart: (e: React.DragEvent) => void;
  onHeaderDragEnd: () => void;
  onPaneDragOver: (paneEl: HTMLElement) => (e: React.DragEvent) => void;
  onPaneDragLeave: (e: React.DragEvent) => void;
  onPaneDrop: (e: React.DragEvent) => void;
  onSelect: () => void;
  onClose: () => void;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const { session, isActive, flex, dragging, showRightHandle } = props;
  const isMe = dragging === props.paneId;

  return (
    <>
      <div
        data-focus-pane
        ref={paneRef}
        style={{ flex }}
        className={`flex flex-col min-w-0 bg-base border m-1 rounded-xl overflow-hidden relative transition-colors ${
          isActive ? 'border-sky-500/60 ring-1 ring-sky-500/40' : 'border-border'
        } ${isMe ? 'opacity-40' : ''}`}
        onClick={props.onSelect}
        onDragOver={(e) => paneRef.current && props.onPaneDragOver(paneRef.current)(e)}
        onDragLeave={props.onPaneDragLeave}
        onDrop={props.onPaneDrop}
      >
        {/* Header */}
        <div
          draggable
          onDragStart={props.onHeaderDragStart}
          onDragEnd={props.onHeaderDragEnd}
          className="flex items-center gap-2 px-2 h-8 border-b border-border bg-base cursor-grab active:cursor-grabbing select-none shrink-0"
        >
          <GripVertical className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
          <span className="text-[12px] text-zinc-200 font-medium truncate min-w-0">
            {session?.name ?? <span className="text-zinc-500">missing session</span>}
          </span>
          {/* Host-supplied chips (e.g. browser previews) live between the
              name and the cwd. Drag is suppressed so chip clicks don't
              start a pane drag. */}
          {props.headerExtras && (
            <div
              className="flex items-center gap-1 min-w-0 overflow-x-auto cursor-default"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {props.headerExtras}
            </div>
          )}
          <span className="flex-1 min-w-0" />
          {session && (
            <span className="text-[10.5px] text-zinc-500 font-mono truncate min-w-0 max-w-[40%]">
              {session.cwd}
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); props.onClose(); }}
            className="w-5 h-5 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter shrink-0"
            title="Remove from workspace (chat stays open in the tab bar)"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* Body — host-provided per-session chat content (messages,
            streaming partials, inline permission requests). Falls back to
            a placeholder so unwired sessions still show something. */}
        {props.body ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {props.body}
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-3 text-zinc-500 text-xs">
            <div className="opacity-60">
              Chat content for <span className="text-zinc-300">{session?.name ?? props.paneId}</span> renders here.
            </div>
          </div>
        )}

        {/* Per-pane composer slot. Wrapper is borderless — the composer's
            glass frame already provides the visual separator from the chat. */}
        {props.composer && (
          <div className="shrink-0">
            {props.composer}
          </div>
        )}
      </div>

      {showRightHandle && (
        <div
          onMouseDown={props.onColResizeStart}
          className="w-1 cursor-col-resize z-10 shrink-0"
        />
      )}
    </>
  );
}


function DropIndicator({ rect, zone }: { rect: DOMRect; zone: DropZone }) {
  // Position relative to viewport using fixed positioning.
  const style: React.CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: 1000,
    background: 'rgba(244,244,245,0.5)',
    boxShadow: '0 0 8px rgba(244,244,245,0.35)',
    transition: 'all 60ms ease-out',
  };
  const t = 3;
  if (zone === 'top') {
    Object.assign(style, { left: rect.left, top: rect.top - t / 2, width: rect.width, height: t });
  } else if (zone === 'bottom') {
    Object.assign(style, { left: rect.left, top: rect.bottom - t / 2, width: rect.width, height: t });
  } else if (zone === 'left') {
    Object.assign(style, { left: rect.left - t / 2, top: rect.top, width: t, height: rect.height });
  } else if (zone === 'right') {
    Object.assign(style, { left: rect.right - t / 2, top: rect.top, width: t, height: rect.height });
  } else {
    Object.assign(style, {
      left: rect.left + 6, top: rect.top + 6,
      width: rect.width - 12, height: rect.height - 12,
      background: 'transparent',
      boxShadow: 'inset 0 0 0 2px rgba(244,244,245,0.5)',
    });
  }
  return <div style={style} />;
}

// ---------------------------------------------------------------------------
// Pure layout transforms
// ---------------------------------------------------------------------------

export function sameLayout(a: Layout, b: Layout): boolean {
  if (a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) {
    const ra = a.rows[i]!, rb = b.rows[i]!;
    if (ra.paneIds.length !== rb.paneIds.length) return false;
    for (let j = 0; j < ra.paneIds.length; j++) {
      if (ra.paneIds[j] !== rb.paneIds[j]) return false;
    }
  }
  return true;
}

function locate(layout: Layout, paneId: string): { rIdx: number; cIdx: number } | null {
  for (let r = 0; r < layout.rows.length; r++) {
    const c = layout.rows[r]!.paneIds.indexOf(paneId);
    if (c >= 0) return { rIdx: r, cIdx: c };
  }
  return null;
}

/** Remove a pane from the layout. Collapses an empty row. */
function removePane(layout: Layout, paneId: string): Layout {
  const rows = layout.rows.map(r => ({ ...r, paneIds: [...r.paneIds], widths: [...r.widths] }));
  for (const row of rows) {
    const i = row.paneIds.indexOf(paneId);
    if (i >= 0) {
      row.paneIds.splice(i, 1);
      row.widths.splice(i, 1);
      break;
    }
  }
  return { rows: rows.filter(r => r.paneIds.length > 0) };
}

function applyDrop(layout: Layout, fromId: string, toId: string, zone: DropZone): Layout {
  if (fromId === toId) return layout;
  const target = locate(layout, toId);
  if (!target) return layout;

  if (zone === 'center') {
    // Swap positions of fromId and toId.
    const rows = layout.rows.map(r => ({ ...r, paneIds: [...r.paneIds], widths: [...r.widths] }));
    const from = locate({ rows }, fromId);
    const to = locate({ rows }, toId);
    if (!from || !to) return layout;
    const a = rows[from.rIdx]!;
    const b = rows[to.rIdx]!;
    [a.paneIds[from.cIdx], b.paneIds[to.cIdx]] = [b.paneIds[to.cIdx]!, a.paneIds[from.cIdx]!];
    return { rows };
  }

  // Remove from current position first.
  const after = removePane(layout, fromId);
  const t = locate(after, toId);
  if (!t) return layout;
  const rows = after.rows.map(r => ({ ...r, paneIds: [...r.paneIds], widths: [...r.widths] }));

  if (zone === 'left' || zone === 'right') {
    const row = rows[t.rIdx]!;
    const insertAt = zone === 'left' ? t.cIdx : t.cIdx + 1;
    row.paneIds.splice(insertAt, 0, fromId);
    row.widths.splice(insertAt, 0, 1);
    return { rows };
  }

  // top / bottom — new row at index t.rIdx or t.rIdx + 1.
  const insertAt = zone === 'top' ? t.rIdx : t.rIdx + 1;
  rows.splice(insertAt, 0, {
    id: newRowId(), height: 1, widths: [1], paneIds: [fromId],
  });
  return { rows };
}

// ---------------------------------------------------------------------------
// WorkspaceBar — slim icon-only column down the left edge of focus mode.
// Each workspace is a colored tile with an initial; the active tile is
// emphasised. A "+" at the bottom creates a new empty workspace.
// ---------------------------------------------------------------------------

function WorkspaceBar(props: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose?: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  onReorder?: (fromId: string, toId: string, position: 'above' | 'below') => void;
}) {
  const { workspaces, activeWorkspaceId, onSelect, onCreate, onClose, onRename, onReorder } = props;
  const canClose = workspaces.length > 1 && !!onClose;
  // Per-workspace rename popover (anchored to the right of the tile).
  // Only one workspace can be renaming at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Drag-to-reorder state. `dragId` is the workspace being dragged;
  // `dropTarget` is where it would land if dropped now.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'above' | 'below' } | null>(null);
  const beginRename = (w: Workspace) => {
    if (!onRename) return;
    setRenamingId(w.id);
    setRenameDraft(w.name);
  };
  const commitRename = () => {
    if (renamingId && onRename) onRename(renamingId, renameDraft);
    setRenamingId(null);
  };
  const cancelRename = () => {
    setRenamingId(null);
  };
  return (
    <aside className="w-12 shrink-0 border-r border-border bg-base flex flex-col items-center py-2 gap-1.5">
      {workspaces.map((w, i) => {
        const isActive = w.id === activeWorkspaceId;
        const color = w.color ?? WORKSPACE_COLORS[i % WORKSPACE_COLORS.length]!;
        const initial = (w.name.trim().charAt(0) || 'W').toUpperCase();
        const isRenaming = renamingId === w.id;
        const isDragging = dragId === w.id;
        const isDropTarget = dropTarget?.id === w.id;
        return (
          <div
            key={w.id}
            className="relative group"
            onDragOver={(e) => {
              if (!onReorder || !dragId || dragId === w.id) return;
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const position: 'above' | 'below' = (e.clientY - rect.top) < rect.height / 2 ? 'above' : 'below';
              setDropTarget(prev => (prev?.id === w.id && prev.position === position ? prev : { id: w.id, position }));
            }}
            onDragLeave={(e) => {
              const next = e.relatedTarget as Node | null;
              const current = e.currentTarget as Node;
              if (next && current.contains(next)) return;
              setDropTarget(prev => (prev?.id === w.id ? null : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromId = e.dataTransfer.getData('text/plain') || dragId;
              const pos = dropTarget?.id === w.id ? dropTarget.position : 'above';
              setDragId(null);
              setDropTarget(null);
              if (onReorder && fromId && fromId !== w.id) onReorder(fromId, w.id, pos);
            }}
          >
            {/* Drop indicator (above) */}
            {isDropTarget && dropTarget?.position === 'above' && (
              <div className="absolute -top-1 left-0 right-0 h-0.5 bg-sky-400/80 rounded-full shadow-[0_0_6px_rgba(56,189,248,0.6)]" />
            )}
            <button
              onClick={() => onSelect(w.id)}
              onDoubleClick={() => beginRename(w)}
              draggable={!!onReorder && !isRenaming}
              onDragStart={(e) => {
                if (!onReorder) return;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', w.id);
                setDragId(w.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTarget(null);
              }}
              title={`${w.name} · ${w.sessionIds.length} chat${w.sessionIds.length === 1 ? '' : 's'} · double-click to rename · drag to reorder`}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-[12px] font-semibold transition-all ${color} ${
                isActive
                  ? 'ring-2 scale-[1.05]'
                  : 'opacity-70 hover:opacity-100 ring-1 ring-transparent'
              } ${isDragging ? 'opacity-40' : ''}`}
            >
              {initial}
            </button>
            {/* Drop indicator (below) */}
            {isDropTarget && dropTarget?.position === 'below' && (
              <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-sky-400/80 rounded-full shadow-[0_0_6px_rgba(56,189,248,0.6)]" />
            )}
            {canClose && !isRenaming && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose!(w.id); }}
                title="Close workspace"
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-800 border border-border text-zinc-400 hover:bg-red-500/80 hover:text-white hover:border-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            )}
            {isRenaming && (
              <div className="absolute left-10 top-0 z-20 flex items-center gap-1 bg-surface border border-border-light rounded-md shadow-xl px-2 py-1">
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') cancelRename();
                  }}
                  className="w-40 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500"
                  placeholder="Workspace name"
                />
              </div>
            )}
          </div>
        );
      })}
      <button
        onClick={onCreate}
        title="New workspace"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
      >
        <Plus className="w-4 h-4" />
      </button>
    </aside>
  );
}
