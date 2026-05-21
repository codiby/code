/**
 * SessionTabStrip — horizontal pill tabs that live in the custom titlebar.
 * Replaces the vertical sessions sidebar (TabBar) with a stacked-card pattern
 * inspired by Dia browser.
 *
 * Tabs are mini pills with a state dot at the start; the active one is
 * differentiated by a lighter background (no border highlight). Tab groups
 * render as a `<div>` with a colored bottom border and a leading dot — the
 * dot itself is the collapse/expand affordance.
 */
import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { X, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';

export interface SessionTabStripGroup {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  sessionStreaming: Record<string, boolean>;
  sessionInterrupted: Record<string, boolean>;
  sessionTurnComplete: Set<string>;
  sessionHasPermission: Record<string, boolean>;
  tabGroups: Record<string, SessionTabStripGroup>;
  tabGroupMap: Record<string, string>;
  /** Per-group remote affiliation, derived by the host from members. When a
   *  group's members all share the same remoteId, the group displays a pill
   *  in the remote's color so it's visually clear which remote owns it. */
  groupRemoteInfo?: Record<string, { remoteId: string; remoteName: string | null; remoteColor: string | null }>;
  expandedGroupIds: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onToggleGroup: (id: string) => void;
  onCloseGroup?: (id: string) => void;
}

type State = 'idle' | 'streaming' | 'complete' | 'attention';

function resolveGroupColor(name: string): string {
  switch (name) {
    case 'blue':   return '#60a5fa';
    case 'green':  return '#3ecf8e';
    case 'amber':  return '#f5b942';
    case 'violet': return '#a78bfa';
    case 'red':    return '#ef5b6b';
    case 'pink':   return '#f472b6';
    default:       return '#7c5cff';
  }
}

function deriveState(args: {
  sessionId: string;
  statuses: Record<string, ConnectionStatus>;
  streaming: Record<string, boolean>;
  interrupted: Record<string, boolean>;
  turnComplete: Set<string>;
  hasPermission: Record<string, boolean>;
}): State {
  if (args.hasPermission[args.sessionId]) return 'attention';
  if (args.interrupted[args.sessionId]) return 'attention';
  if (args.statuses[args.sessionId] === 'error') return 'attention';
  if (args.streaming[args.sessionId]) return 'streaming';
  if (args.turnComplete.has(args.sessionId)) return 'complete';
  return 'idle';
}

function dotColor(state: State): string {
  switch (state) {
    case 'streaming': return '#7c5cff';
    case 'complete':  return '#3ecf8e';
    case 'attention': return '#ef5b6b';
    default:          return 'transparent';
  }
}

export function SessionTabStrip({
  sessions,
  activeSessionId,
  sessionStatuses,
  sessionStreaming,
  sessionInterrupted,
  sessionTurnComplete,
  sessionHasPermission,
  tabGroups,
  tabGroupMap,
  groupRemoteInfo,
  expandedGroupIds,
  onSelect,
  onClose,
  onNew,
  onToggleGroup,
  onCloseGroup,
}: Props) {
  // Build the render order: walk sessions in their host-ordered sequence,
  // but every time a session belongs to a group we render the whole group
  // inline (once) at the position of the first encountered member.
  const items = useMemo(() => {
    const result: Array<
      | { kind: 'tab'; session: SessionInfo }
      | { kind: 'group'; group: SessionTabStripGroup; sessions: SessionInfo[] }
    > = [];
    const seenGroups = new Set<string>();
    const groupMembers = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const gid = tabGroupMap[s.id];
      if (gid && tabGroups[gid]) {
        let list = groupMembers.get(gid);
        if (!list) { list = []; groupMembers.set(gid, list); }
        list.push(s);
      }
    }
    for (const s of sessions) {
      const gid = tabGroupMap[s.id];
      if (gid && tabGroups[gid]) {
        if (seenGroups.has(gid)) continue;
        seenGroups.add(gid);
        result.push({ kind: 'group', group: tabGroups[gid]!, sessions: groupMembers.get(gid) ?? [] });
      } else {
        result.push({ kind: 'tab', session: s });
      }
    }
    return result;
  }, [sessions, tabGroups, tabGroupMap]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) { setOverflow({ left: false, right: false }); return; }
    const max = el.scrollWidth - el.clientWidth;
    setOverflow({
      left: el.scrollLeft > 4,
      right: max > 4 && el.scrollLeft < max - 4,
    });
  }, []);

  useEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [recompute, sessions.length, tabGroupMap]);

  const scrollByAmount = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  return (
    <div
      className="flex-1 flex items-center min-w-0 relative"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => scrollByAmount(-200)}
        title="Scroll left"
        aria-label="Scroll left"
        className="shrink-0 flex items-center justify-center rounded-md transition-opacity transition-colors"
        style={{
          width: 22, height: 22,
          marginLeft: 4, marginRight: 2,
          color: '#8a8c93',
          opacity: overflow.left ? 1 : 0,
          pointerEvents: overflow.left ? 'auto' : 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1c1d22'; (e.currentTarget as HTMLElement).style.color = '#e6e7ea'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#8a8c93'; }}
      >
        <ChevronLeft size={14} />
      </button>
      <div
        ref={scrollRef}
        className="flex items-center min-w-0 flex-1 session-tab-strip-scroll"
        style={{ overflowX: 'auto', overflowY: 'hidden', paddingLeft: 4, paddingRight: 4 }}
      >
      {items.map((item, idx) => {
        if (item.kind === 'tab') {
          const state = deriveState({
            sessionId: item.session.id,
            statuses: sessionStatuses,
            streaming: sessionStreaming,
            interrupted: sessionInterrupted,
            turnComplete: sessionTurnComplete,
            hasPermission: sessionHasPermission,
          });
          return (
            <TabPill
              key={item.session.id}
              session={item.session}
              active={item.session.id === activeSessionId}
              state={state}
              overlapPrev={idx > 0 && items[idx - 1]!.kind === 'tab'}
              onSelect={() => onSelect(item.session.id)}
              onClose={() => onClose(item.session.id)}
            />
          );
        }
        const groupColor = resolveGroupColor(item.group.color);
        const expanded = expandedGroupIds.has(item.group.id);
        const remote = groupRemoteInfo?.[item.group.id];
        return (
          <GroupContainer
            key={item.group.id}
            group={item.group}
            color={groupColor}
            remoteName={remote?.remoteName ?? null}
            remoteColor={remote?.remoteColor ?? null}
            sessions={item.sessions}
            activeSessionId={activeSessionId}
            sessionStatuses={sessionStatuses}
            sessionStreaming={sessionStreaming}
            sessionInterrupted={sessionInterrupted}
            sessionTurnComplete={sessionTurnComplete}
            sessionHasPermission={sessionHasPermission}
            expanded={expanded}
            onToggle={() => onToggleGroup(item.group.id)}
            onSelectSession={onSelect}
            onCloseSession={onClose}
            onCloseGroup={onCloseGroup ? () => onCloseGroup(item.group.id) : undefined}
            leadingGap={idx > 0}
          />
        );
      })}
      <button
        type="button"
        onClick={onNew}
        title="New session"
        aria-label="New session"
        className="flex items-center justify-center shrink-0 rounded-md text-[#8a8c93] hover:text-[#e6e7ea] hover:bg-[#1c1d22] transition-colors"
        style={{ width: 24, height: 24, marginLeft: 8 }}
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
      </div>
      <button
        type="button"
        onClick={() => scrollByAmount(200)}
        title="Scroll right"
        aria-label="Scroll right"
        className="shrink-0 flex items-center justify-center rounded-md transition-opacity transition-colors"
        style={{
          width: 22, height: 22,
          marginLeft: 2, marginRight: 4,
          color: '#8a8c93',
          opacity: overflow.right ? 1 : 0,
          pointerEvents: overflow.right ? 'auto' : 'none',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1c1d22'; (e.currentTarget as HTMLElement).style.color = '#e6e7ea'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#8a8c93'; }}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

function TabPill({
  session,
  active,
  state,
  overlapPrev,
  insideGroup,
  onSelect,
  onClose,
}: {
  session: SessionInfo;
  active: boolean;
  state: State;
  overlapPrev?: boolean;
  insideGroup?: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const isAttention = state === 'attention';
  const isStreaming = state === 'streaming';
  const isComplete = state === 'complete';
  const pulses = isStreaming || isComplete;
  // Inactive: titlebar background (recessed). Active: lighter bg, no border change.
  const bg = active ? '#2a2b32' : '#131418';
  const color = active ? '#e6e7ea' : '#8a8c93';
  // Outside a group, tabs overlap each other (stacked card effect).
  // Inside a group, they have positive spacing.
  const marginLeft = insideGroup ? (overlapPrev ? 6 : 0) : (overlapPrev ? -10 : 0);
  return (
    <div
      className="group/tab flex items-center shrink-0 cursor-pointer select-none relative transition-colors"
      onClick={onSelect}
      style={{
        height: 28,
        padding: '2px 8px',
        background: bg,
        color,
        border: '1px solid #2a2b30',
        borderRadius: 8,
        width: 160,
        zIndex: active ? 20 : 1,
        marginLeft,
      }}
      title={session.name}
    >
      <span
        className="shrink-0 rounded-full"
        style={{
          width: 7,
          height: 7,
          background: dotColor(state),
          marginRight: 8,
          animation: pulses ? 'tabDotPulse 1.4s ease-in-out infinite' : undefined,
          boxShadow: isAttention ? '0 0 4px rgba(239,91,107,0.6)' : undefined,
        }}
      />
      <span
        className="truncate min-w-0"
        style={{ fontSize: 12, fontWeight: 500 }}
      >
        {session.name}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close tab"
        aria-label="Close tab"
        className="opacity-0 group-hover/tab:opacity-100 transition-opacity shrink-0 flex items-center justify-center rounded"
        style={{
          width: 14, height: 14,
          color: '#5e6068',
          marginLeft: 2,
          marginRight: -3,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#3a3b40'; (e.currentTarget as HTMLElement).style.color = '#e6e7ea'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#5e6068'; }}
      >
        <X size={9} />
      </button>
    </div>
  );
}

function GroupContainer({
  group: _group,
  color,
  remoteName,
  remoteColor,
  sessions,
  activeSessionId,
  sessionStatuses,
  sessionStreaming,
  sessionInterrupted,
  sessionTurnComplete,
  sessionHasPermission,
  expanded,
  onToggle,
  onSelectSession,
  onCloseSession,
  onCloseGroup,
  leadingGap,
}: {
  group: SessionTabStripGroup;
  color: string;
  remoteName?: string | null;
  remoteColor?: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, ConnectionStatus>;
  sessionStreaming: Record<string, boolean>;
  sessionInterrupted: Record<string, boolean>;
  sessionTurnComplete: Set<string>;
  sessionHasPermission: Record<string, boolean>;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onCloseGroup?: () => void;
  leadingGap?: boolean;
}) {
  const tint = remoteColor || null;
  return (
    <div
      className="group/grp flex items-center shrink-0 relative"
      style={{
        height: 36,
        padding: '2px 8px 4px 8px',
        // When the group sits on a remote, blend the group's accent with the
        // remote tint so both identities are legible at once.
        borderBottom: tint
          ? `2px solid ${tint}`
          : `2px solid ${color}`,
        boxShadow: tint ? `inset 0 1px 0 ${tint}33` : undefined,
        boxSizing: 'border-box',
        marginLeft: leadingGap ? 8 : 0,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        title={expanded ? 'Collapse group' : 'Expand group'}
        aria-label={expanded ? 'Collapse group' : 'Expand group'}
        className="shrink-0 rounded-full cursor-pointer transition-transform hover:scale-110"
        style={{
          width: 9, height: 9,
          background: color,
          marginRight: expanded || remoteName ? 8 : 0,
          padding: 0,
          border: 'none',
          // Subtle ring in the remote's color so even when the group's own
          // color is similar to the remote's, the affiliation is still visible.
          boxShadow: tint ? `0 0 0 2px ${tint}33` : undefined,
        }}
      />
      {remoteName && (
        <span
          className="shrink-0 inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md border"
          style={{
            color: tint || '#a78bfa',
            background: `${tint || '#a78bfa'}14`,
            borderColor: `${tint || '#a78bfa'}40`,
            marginRight: expanded ? 8 : 0,
          }}
          title={`This group lives on remote "${remoteName}"`}
        >
          {remoteName}
        </span>
      )}
      {expanded && sessions.map((s, i) => {
        const state = deriveState({
          sessionId: s.id,
          statuses: sessionStatuses,
          streaming: sessionStreaming,
          interrupted: sessionInterrupted,
          turnComplete: sessionTurnComplete,
          hasPermission: sessionHasPermission,
        });
        return (
          <TabPill
            key={s.id}
            session={s}
            active={s.id === activeSessionId}
            state={state}
            insideGroup
            overlapPrev={i > 0}
            onSelect={() => onSelectSession(s.id)}
            onClose={() => onCloseSession(s.id)}
          />
        );
      })}
      {onCloseGroup && expanded && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCloseGroup(); }}
          title="Close group"
          aria-label="Close group"
          className="opacity-0 group-hover/grp:opacity-100 transition-opacity shrink-0 flex items-center justify-center rounded"
          style={{
            width: 18, height: 18,
            color: '#5e6068',
            marginLeft: 6,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `${color}38`; (e.currentTarget as HTMLElement).style.color = '#e6e7ea'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#5e6068'; }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
