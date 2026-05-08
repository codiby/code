import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Pin, Plus } from 'lucide-react';
import { Button, TextField, Input } from '@heroui/react';
import { BottomSheet } from './BottomSheet';
import { MobileNewSessionModal } from './MobileNewSessionModal';
import type { ClaudeClient, ConnectionStatus, SessionInfo } from '../../lib/claude-client';

type TabGroup = { id: string; name: string; color: string };

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient;
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCloseSession: (id: string) => void;
  onReopenSession: (id: string) => void;
  /** Move a closed session into the archived bucket. The archive icon next
   *  to each closed-session row calls this — the session disappears from
   *  this list, history is kept, and it can be permanently deleted later
   *  from the (future) archived-sessions management page. */
  onArchiveSession: (id: string) => void;
  /** Per-session connection status (from the WS multiplexer). */
  statuses?: Record<string, ConnectionStatus | string>;
  /** Per-session streaming flag. */
  streaming?: Record<string, boolean>;
  /** Per-session "previous turn died without onTurnComplete" flag.
   *  Drives the red dot — last turn was interrupted. */
  interrupted?: Record<string, boolean>;
  /** Per-session pending-permission flag. */
  hasPermission?: Record<string, boolean>;
  /** Per-session "turn complete" flash flag. */
  turnComplete?: Set<string>;
  /** Tab groups (shared with desktop via /preferences). */
  tabGroups: Record<string, TabGroup>;
  /** sessionId → groupId. */
  tabGroupMap: Record<string, string>;
  /** Persisted tab order. */
  tabOrder: string[];
  /** Sessions pinned to the top of their group (shared with desktop). */
  pinnedSessionIds?: Set<string>;
  /** Sessions hidden from the open list (still in registry). */
  closedSessionIds: Set<string>;
  /** Sessions hidden from BOTH the open list and the closed-sessions
   *  section. They live in the (future) archived-sessions management
   *  page only. */
  archivedSessionIds: Set<string>;
  /** Whether the opencode binary is available on this host (cached at
   *  app boot). Forwarded to MobileNewSessionModal so the OpenCode
   *  provider option only appears when usable. */
  opencodeAvailable?: boolean;
  /** Provider key set by the launchpad's quick-start chips. When the
   *  sheet becomes visible with this populated, it auto-opens the New
   *  Session modal (the modal reads `claude-ui-last-provider` from
   *  localStorage to seed its provider chip). The sheet calls
   *  `onConsumeNewSessionRequest` once it has acted so the parent
   *  doesn't replay the auto-open every render. */
  pendingNewSessionProvider?: string | null;
  onConsumeNewSessionRequest?: () => void;
}

const COLOR_DOT: Record<string, string> = {
  blue: 'bg-blue-400',
  green: 'bg-green-400',
  amber: 'bg-amber-400',
  violet: 'bg-violet-400',
  red: 'bg-red-400',
  pink: 'bg-pink-400',
};

/** Mirror of the desktop TabBar's getDotClass. */
function getDotClass(connStatus: string, isStreaming: boolean, turnComplete: boolean, wasInterrupted: boolean): string {
  if (connStatus === 'error') return 'bg-red-400';
  if (connStatus === 'connecting' || connStatus === 'starting') return 'bg-amber-400 animate-pulse';
  if (turnComplete) return 'bg-green-400 animate-pulse';
  if (connStatus === 'connected' && isStreaming) return 'bg-amber-400 animate-pulse';
  // "Last turn died" — solid red so the user notices the failure even
  // after reconnect. Cleared the moment they start a new turn.
  if (wasInterrupted) return 'bg-red-400';
  if (connStatus === 'connected') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

export function MobileSessionsSheet({
  open, onClose, client, sessions, activeId, onSelect, onCloseSession, onReopenSession, onArchiveSession,
  statuses, streaming, interrupted, hasPermission, turnComplete,
  tabGroups, tabGroupMap, tabOrder, pinnedSessionIds, closedSessionIds, archivedSessionIds,
  opencodeAvailable,
  pendingNewSessionProvider, onConsumeNewSessionRequest,
}: Props) {
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());

  // Long-press → inline rename. Timer is keyed per session so two
  // simultaneous touches (rare on mobile) don't clobber each other.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // Auto-open the New Session modal when the sheet becomes visible
  // because of a launchpad quick-start tap. The localStorage write
  // (`claude-ui-last-provider`) happens upstream in MobileApp, so the
  // modal's getLastProvider() picks up the chosen provider as soon as
  // it mounts. Once we've consumed the request, tell the parent to
  // clear it so re-opening the sheet later doesn't trigger a phantom
  // modal.
  useEffect(() => {
    if (!open || !pendingNewSessionProvider) return;
    setNewModalOpen(true);
    onConsumeNewSessionRequest?.();
  }, [open, pendingNewSessionProvider, onConsumeNewSessionRequest]);

  const startLongPress = (s: SessionInfo) => {
    longPressFiredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setEditingId(s.id);
      setEditingName(s.name);
      // Haptic feedback if available
      try { (navigator as unknown as { vibrate?: (n: number) => void }).vibrate?.(10); } catch {}
    }, 550);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const commitRename = async (id: string) => {
    const trimmed = editingName.trim();
    setEditingId(null);
    if (!trimmed) return;
    try { await client.renameSession(id, trimmed); } catch {/* server will broadcast a session_list update on success */}
  };

  // Reset transient form state on close
  useEffect(() => { if (!open) setNewModalOpen(false); }, [open]);

  // Same ordering rules as the desktop ChatApp: filter out closed sessions
  // and sort by persisted tabOrder (sessions not in the order go to the end).
  const openSessions = useMemo(() => {
    const filtered = sessions.filter((s) => !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id));
    return [...filtered].sort((a, b) => {
      const ai = tabOrder.indexOf(a.id);
      const bi = tabOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [sessions, closedSessionIds, archivedSessionIds, tabOrder]);

  const closedSessions = useMemo(
    () => sessions.filter((s) => closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id)),
    [sessions, closedSessionIds, archivedSessionIds],
  );

  // Build the same render structure as TabBar: walk the ordered list, emit a
  // group header the first time we see any of its members, then list members
  // (when the group is expanded). Ungrouped sessions render as flat tabs.
  type RenderItem =
    | { kind: 'tab'; session: SessionInfo }
    | { kind: 'group'; group: TabGroup; members: SessionInfo[] };
  const renderList = useMemo<RenderItem[]>(() => {
    const list: RenderItem[] = [];
    const seenGroups = new Set<string>();
    for (const s of openSessions) {
      const gid = tabGroupMap[s.id];
      if (gid && tabGroups[gid]) {
        if (!seenGroups.has(gid)) {
          seenGroups.add(gid);
          const members = openSessions
            .filter((m) => tabGroupMap[m.id] === gid)
            .slice()
            .sort((a, b) => {
              // Pinned first, otherwise preserve openSessions order (tabOrder).
              const pa = pinnedSessionIds?.has(a.id) ? 1 : 0;
              const pb = pinnedSessionIds?.has(b.id) ? 1 : 0;
              return pb - pa;
            });
          list.push({ kind: 'group', group: tabGroups[gid]!, members });
        }
      } else {
        list.push({ kind: 'tab', session: s });
      }
    }
    return list;
  }, [openSessions, tabGroupMap, tabGroups, pinnedSessionIds]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };

  const renderTab = (s: SessionInfo, opts?: { indented?: boolean }) => {
    const isActive = s.id === activeId;
    const status = (statuses && statuses[s.id]) ||
      (s.ready ? 'connected' : s.status === 'starting' ? 'starting' : 'disconnected');
    const isStreaming = !!streaming?.[s.id];
    const tc = !!turnComplete?.has(s.id);
    const wasInterrupted = !!interrupted?.[s.id];
    const pending = !!hasPermission?.[s.id];
    const isEditing = editingId === s.id;
    return (
      <li key={s.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            // Suppress click that immediately follows a long-press → rename
            if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
            if (isEditing) return;
            onSelect(s.id); onClose();
          }}
          onPointerDown={() => { if (!isEditing) startLongPress(s); }}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(e) => {
            // Right-click on desktop / iOS Safari "Look Up" sheet.
            // Treat as rename instead of OS menu.
            e.preventDefault();
            if (!isEditing) {
              cancelLongPress();
              longPressFiredRef.current = true;
              setEditingId(s.id);
              setEditingName(s.name);
            }
          }}
          className={`group relative flex items-center gap-2 ${opts?.indented ? 'pl-7 pr-3' : 'px-3'} min-h-11 text-[13px] rounded-md transition-colors cursor-pointer select-none ${
            isActive
              ? 'bg-surface-light text-zinc-100'
              : 'text-zinc-400 active:bg-surface/60 active:text-zinc-200'
          }`}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(String(status), isStreaming, tc, wasInterrupted)}`} />
          {isEditing ? (
            <TextField
              value={editingName}
              onChange={setEditingName}
              aria-label="Rename session"
              autoFocus
              className="flex-1 min-w-0"
            >
              <Input
                ref={editInputRef}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id); }
                  if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                }}
                onBlur={() => commitRename(s.id)}
                className="bg-transparent border-none outline-none text-[13px] text-zinc-100"
              />
            </TextField>
          ) : (
            <span className="truncate flex-1">{s.name}</span>
          )}
          {pinnedSessionIds?.has(s.id) && !isEditing && (
            <Pin
              size={11}
              strokeWidth={2.25}
              className="shrink-0 text-zinc-500 fill-current"
              aria-label="Pinned to top"
            />
          )}
          {pending && !isActive && !isEditing && (
            <span className="shrink-0 relative inline-flex w-2.5 h-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
          {!isEditing && (
            <span onClick={(e) => e.stopPropagation()} className="shrink-0">
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => onCloseSession(s.id)}
                className="w-7 h-7 min-w-0 -mr-1 flex items-center justify-center rounded text-zinc-500 active:text-zinc-200 active:bg-white/10"
                aria-label={`Close ${s.name}`}
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </Button>
            </span>
          )}
        </div>
      </li>
    );
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Sessions" maxHeight={0.92}>
      {/* Vertical tab list — visually mirrors the desktop TabBar in vertical mode */}
      <div className="rounded-xl bg-[#161616] border border-white/5 -mx-1 mb-3 py-1">
        {renderList.length === 0 && (
          <p className="text-sm text-zinc-500 px-3 py-4">No open sessions — tap "+" below.</p>
        )}
        <ul className="flex flex-col gap-0.5 px-1.5">
          {renderList.map((item) => {
            if (item.kind === 'tab') return renderTab(item.session);

            const { group, members } = item;
            const isCollapsed = collapsedGroupIds.has(group.id);
            const dot = COLOR_DOT[group.color] || COLOR_DOT.blue!;
            const hasActivity = members.some((m) => hasPermission?.[m.id]);
            return (
              <li key={`grp-${group.id}`} className="flex flex-col gap-0.5">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.id)}
                  className="relative flex items-center gap-2 px-2 min-h-10 text-[13px] rounded-md text-zinc-300 active:bg-surface/60 cursor-pointer"
                >
                  {isCollapsed ? (
                    <ChevronRight size={14} className="shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronDown size={14} className="shrink-0 text-zinc-500" />
                  )}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dot} ${isCollapsed && hasActivity ? 'animate-pulse' : ''}`} />
                  <span className="truncate flex-1 font-medium">{group.name}</span>
                  <span className="text-[11px] text-zinc-500 shrink-0">{members.length}</span>
                </div>
                {!isCollapsed && (
                  <ul className="flex flex-col gap-0.5">
                    {members.map((m) => renderTab(m, { indented: true }))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {/* "+" row — same vertical-tab styling as a tab */}
        <div className="px-1.5 pt-0.5">
          <Button
            variant="ghost"
            fullWidth
            onPress={() => setNewModalOpen(true)}
            className="h-auto min-w-0 flex items-center justify-center gap-2 min-h-11 rounded-md text-zinc-400 active:text-zinc-100 active:bg-surface/60 text-[13px]"
            aria-label="New session"
          >
            <Plus size={16} />
            <span>New session</span>
          </Button>
        </div>
      </div>

      <MobileNewSessionModal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        client={client}
        opencodeAvailable={opencodeAvailable ?? false}
        onCreated={(id) => { onSelect(id); onClose(); }}
      />

      {/* Closed sessions — collapsible, mirrors the desktop "+" dropdown's
          "Closed sessions" section but always present and inline. */}
      {closedSessions.length > 0 && (
        <div className="rounded-xl bg-white/[0.02] border border-white/5 -mx-1">
          <Button
            variant="ghost"
            fullWidth
            onPress={() => setShowClosed((v) => !v)}
            className="h-auto min-w-0 flex items-center gap-2 px-3 min-h-11 text-[12px] text-zinc-400 active:text-zinc-200 active:bg-white/5 rounded-xl"
          >
            {showClosed ? (
              <ChevronDown size={14} className="shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-zinc-500" />
            )}
            <span className="uppercase tracking-wider font-semibold flex-1 text-left">
              Closed sessions
            </span>
            <span className="text-[11px] text-zinc-500">{closedSessions.length}</span>
          </Button>
          {showClosed && (
            <ul className="flex flex-col px-1.5 pb-1.5">
              {closedSessions.map((s) => (
                <li key={s.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => { onReopenSession(s.id); onClose(); }}
                    className="group relative flex items-center gap-2 px-3 min-h-11 text-[13px] rounded-md text-zinc-400 active:bg-surface/60 active:text-zinc-200 cursor-pointer"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                    <span className="truncate flex-1">{s.name}</span>
                    <span className="text-[10px] text-zinc-600 ml-auto shrink-0 font-mono truncate max-w-[40%]">
                      {s.cwd.split('/').pop()}
                    </span>
                    <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        onPress={() => onArchiveSession(s.id)}
                        className="w-8 h-8 min-w-0 -mr-1 flex items-center justify-center rounded text-zinc-500 active:text-zinc-200 active:bg-surface"
                        aria-label="Archive session"
                      >
                        <Archive size={14} strokeWidth={2} />
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
