import { useMemo, useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-aria';
import {
  LayoutGrid, List as ListIcon, GitBranch, GitPullRequest, MessageSquare,
  Bell, Code2, Eye, CheckCircle2, X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowRight,
  ExternalLink, Circle, Clock, Search,
} from 'lucide-react';
import type { SessionInfo, ConnectionStatus } from '../lib/claude-client';
import { GROUP_HEX_COLOR, type TabGroupInfo } from '../lib/tab-groups';

// Sessions overview — a triage board/list of every session keyed by its
// *review status* (not a project backlog). Answers the two questions that
// get lost once you have a dozen tabs open: "what was each one about / where
// did it leave off" and "did it pass review yet". Mounted full-window in the
// main pane (replacing the per-session workspace) when the sidebar's
// "Sessions" nav item is active, mirroring AutomationsView.
//
// All data is derived from state ChatApp already holds — no new server work:
// live state from the WS connection, the linked PR (state + branch) from
// prLinks, and the "left off" line from the last assistant message. CI
// check-runs are a future enrichment (would need a /session-review-status
// endpoint) and slot into the QA badge + the "Needs you" lane.

type PRLink = { prNumber: number; title: string; url: string; headRefName: string; state: string };

export interface SessionsBoardViewProps {
  sessions: SessionInfo[];
  statuses: Record<string, ConnectionStatus>;
  streaming: Record<string, boolean>;
  hasPermission: Record<string, boolean>;
  lastMessageAt: Record<string, number>;
  lastPreview: Record<string, string>;
  prLinks: Record<string, PRLink>;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  onSelectSession: (id: string) => void;
  /** Reassign a session to a group (or ungroup it when groupId is null). */
  onAssignGroup: (sessionId: string, groupId: string | null) => void;
}

const NO_GROUP = '__nogroup__';
// react-aria drag payload type carrying a session id between a board card and
// a group drop target.
const BOARD_DRAG_TYPE = 'application/x-codiby-session';
function groupHex(g: TabGroupInfo | undefined): string {
  if (!g) return '#5b5d66';
  return GROUP_HEX_COLOR[g.color ?? ''] || g.color || '#5b5d66';
}

type LaneId = 'needs' | 'working' | 'review' | 'done';

const LANES: Record<LaneId, {
  name: string; sub: string; icon: typeof Code2;
  color: string; chip: string; alert?: boolean;
}> = {
  needs:   { name: 'Needs you',  sub: 'Awaiting your input',     icon: Bell,         color: 'text-amber-400',  chip: 'bg-amber-500/14 text-amber-400',  alert: true },
  working: { name: 'Working',    sub: 'In progress · no PR yet',  icon: Code2,        color: 'text-emerald-400', chip: 'bg-emerald-500/12 text-emerald-400' },
  review:  { name: 'In Review',  sub: 'PR open',                  icon: Eye,          color: 'text-sky-400',     chip: 'bg-sky-500/12 text-sky-400' },
  done:    { name: 'Done',       sub: 'Merged · closed',          icon: CheckCircle2, color: 'text-emerald-400', chip: 'bg-emerald-500/12 text-emerald-400' },
};
const LANE_ORDER: LaneId[] = ['needs', 'working', 'review', 'done'];
const DONE_LIMIT = 30;

function relTime(ts?: number): string {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function basename(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

type Live = { key: 'run' | 'wait' | 'idle'; label: string };
type QA = { tone: 'pass' | 'open' | 'closed' | 'none'; label: string };

interface Row {
  s: SessionInfo;
  lane: LaneId;
  groupId: string;
  live: Live;
  qa: QA;
  pr: PRLink | undefined;
  branch: string;
  ago: string;
  preview: string;
}

export function SessionsBoardView(props: SessionsBoardViewProps) {
  const { sessions, statuses, streaming, hasPermission, lastMessageAt, lastPreview, prLinks, tabGroups, tabGroupMap, onSelectSession, onAssignGroup } = props;
  const [view, setView] = useState<'board' | 'list'>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Collapsed group containers, keyed by `lane:groupKey`.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const rows = useMemo<Row[]>(() => {
    const liveOf = (s: SessionInfo): Live => {
      if (hasPermission[s.id]) return { key: 'wait', label: 'Awaiting input' };
      const conn = statuses[s.id] === 'connected';
      if (conn && streaming[s.id]) return { key: 'run', label: 'Running' };
      if (conn) return { key: 'idle', label: 'Active' };
      return { key: 'idle', label: s.status === 'archived' ? 'Closed' : 'Idle' };
    };
    const out: Row[] = [];
    for (const s of sessions) {
      const pr = prLinks[s.id];
      const st = (pr?.state || '').toUpperCase();
      let lane: LaneId;
      if (hasPermission[s.id]) lane = 'needs';
      else if (st === 'MERGED' || st === 'CLOSED') lane = 'done';
      else if (pr) lane = 'review';
      else if (s.status === 'archived') lane = 'done';
      else lane = 'working';

      let qa: QA;
      if (st === 'MERGED') qa = { tone: 'pass', label: 'Merged' };
      else if (st === 'CLOSED') qa = { tone: 'closed', label: 'PR closed' };
      else if (pr) qa = { tone: 'open', label: `PR #${pr.prNumber}` };
      else if (s.status === 'archived') qa = { tone: 'closed', label: 'Closed' };
      else qa = { tone: 'none', label: 'No PR' };

      out.push({
        s, lane, pr,
        groupId: tabGroupMap[s.id] || NO_GROUP,
        live: liveOf(s),
        qa,
        branch: pr?.headRefName || '',
        ago: relTime(lastMessageAt[s.id]),
        preview: lastPreview[s.id] || '',
      });
    }
    return out;
  }, [sessions, statuses, streaming, hasPermission, lastMessageAt, lastPreview, prLinks, tabGroupMap]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.s.name.toLowerCase().includes(q) ||
      r.preview.toLowerCase().includes(q) ||
      r.branch.toLowerCase().includes(q) ||
      (r.pr ? `#${r.pr.prNumber}`.includes(q) : false));
  }, [rows, query]);

  const byLane = useMemo(() => {
    const m: Record<LaneId, Row[]> = { needs: [], working: [], review: [], done: [] };
    for (const r of filtered) m[r.lane].push(r);
    // Most recently active first within each lane.
    for (const k of LANE_ORDER) m[k].sort((a, b) => (lastMessageAt[b.s.id] || 0) - (lastMessageAt[a.s.id] || 0));
    m.done = m.done.slice(0, DONE_LIMIT);
    return m;
  }, [filtered, lastMessageAt]);

  // Ordered ids for drawer prev/next — follows the lanes in display order.
  const orderedIds = useMemo(() => LANE_ORDER.flatMap(l => byLane[l].map(r => r.s.id)), [byLane]);
  const openRow = openId ? rows.find(r => r.s.id === openId) : undefined;

  const nav = (d: number) => {
    if (!openId || !orderedIds.length) return;
    const i = orderedIds.indexOf(openId);
    const n = (i + d + orderedIds.length) % orderedIds.length;
    setOpenId(orderedIds[n]);
  };

  const openCount = sessions.filter(s => s.status === 'open').length;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base relative">
      {/* Top bar */}
      <div className="h-12 border-b border-border flex items-center gap-3 px-5 shrink-0">
        <h1 className="text-[15px] font-semibold text-zinc-200 flex items-center gap-2">
          <LayoutGrid size={16} strokeWidth={2} className="text-indigo-400" />
          Sessions
          <span className="text-[11px] text-zinc-600 font-normal ml-1">{openCount} open</span>
        </h1>

        <div className="flex items-center bg-surface border border-border rounded-lg p-0.5 gap-0.5 ml-1">
          <ViewToggle on={view === 'list'} onClick={() => setView('list')} icon={ListIcon} label="List" />
          <ViewToggle on={view === 'board'} onClick={() => setView('board')} icon={LayoutGrid} label="Board" />
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-2.5 h-[30px] w-[220px]">
          <Search size={13} strokeWidth={2} className="text-zinc-600 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="bg-transparent border-0 outline-none text-[12px] text-zinc-200 placeholder:text-zinc-600 w-full"
          />
        </div>
      </div>

      {/* Body */}
      {view === 'board'
        ? <BoardView
            byLane={byLane}
            tabGroups={tabGroups}
            onOpen={setOpenId}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            onAssignGroup={onAssignGroup}
          />
        : <ListView byLane={byLane} onOpen={setOpenId} />}

      {/* Detail drawer */}
      {openRow && (
        <Drawer
          row={openRow}
          onClose={() => setOpenId(null)}
          onPrev={() => nav(-1)}
          onNext={() => nav(1)}
          onOpenSession={() => { onSelectSession(openRow.s.id); setOpenId(null); }}
        />
      )}
    </div>
  );
}

function ViewToggle({ on, onClick, icon: Icon, label }: { on: boolean; onClick: () => void; icon: typeof ListIcon; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 h-[24px] px-2.5 rounded-md text-[12px] font-medium transition-colors ${on ? 'bg-surface-lighter text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
    >
      <Icon size={12} strokeWidth={2} />
      {label}
    </button>
  );
}

/* ---------- shared atoms ---------- */

function LiveDot({ live }: { live: Live }) {
  const cls = live.key === 'run' ? 'text-emerald-400' : live.key === 'wait' ? 'text-amber-400' : 'text-zinc-500';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10.5px] font-semibold ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${live.key !== 'idle' ? 'animate-pulse' : ''}`} style={live.key !== 'idle' ? { boxShadow: '0 0 7px currentColor' } : undefined} />
      {live.label}
    </span>
  );
}

function QABadge({ qa }: { qa: QA }) {
  const map = {
    pass:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    open:   'bg-sky-500/10 text-sky-400 border-sky-500/20',
    closed: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/25',
    none:   'bg-surface-lighter text-zinc-500 border-border',
  } as const;
  const Icon = qa.tone === 'pass' ? CheckCircle2 : qa.tone === 'open' ? GitPullRequest : qa.tone === 'closed' ? GitPullRequest : Circle;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-[3px] rounded-md border ${map[qa.tone]}`}>
      <Icon size={11} strokeWidth={2.4} />
      {qa.label}
    </span>
  );
}

function PRChip({ pr }: { pr: PRLink | undefined }) {
  if (!pr) return <span className="text-[10.5px] text-zinc-600 font-mono">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-zinc-400 font-mono">
      <GitPullRequest size={11} strokeWidth={2} />#{pr.prNumber}
    </span>
  );
}

/* ---------- BOARD ---------- */

interface BoardProps {
  byLane: Record<LaneId, Row[]>;
  tabGroups: Record<string, TabGroupInfo>;
  onOpen: (id: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  onAssignGroup: (sessionId: string, groupId: string | null) => void;
}

function BoardView(p: BoardProps) {
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="flex gap-4 p-[18px] items-start min-h-full">
        {LANE_ORDER.map(l => {
          const lane = LANES[l];
          const items = p.byLane[l];
          const Icon = lane.icon;
          // Cluster the lane's rows by group, ordered by group name (ungrouped last).
          const groups = clusterByGroup(items, p.tabGroups);
          return (
            <div key={l} className={`flex-none w-[300px] rounded-xl border flex flex-col ${lane.alert ? 'border-amber-500/30' : 'border-border'} bg-surface`}>
              <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5">
                <span className={`w-[26px] h-[26px] rounded-lg grid place-items-center ${lane.chip}`}><Icon size={15} strokeWidth={2} /></span>
                <div>
                  <div className={`text-[12px] font-semibold uppercase tracking-wide ${lane.alert ? lane.color : 'text-zinc-400'}`}>{lane.name}</div>
                  <div className="text-[10.5px] text-zinc-600">{lane.sub}</div>
                </div>
                <span className={`ml-auto text-[11px] font-semibold rounded-full px-2 py-px ${lane.alert ? 'bg-amber-500/18 text-amber-400' : 'bg-surface-lighter text-zinc-400'}`}>{items.length}</span>
              </div>
              <div className="flex flex-col gap-2.5 px-2.5 pb-3">
                {items.length === 0 && <div className="text-[11px] text-zinc-600 px-2 py-3 text-center">—</div>}
                {groups.map(({ key, group, rows }) => (
                  <GroupCard
                    key={key}
                    laneKey={l}
                    groupKey={key}
                    group={group}
                    rows={rows}
                    alert={!!lane.alert}
                    {...p}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function clusterByGroup(rows: Row[], tabGroups: Record<string, TabGroupInfo>) {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = map.get(r.groupId) || [];
    arr.push(r);
    map.set(r.groupId, arr);
  }
  return [...map.entries()]
    .map(([key, rs]) => ({ key, group: key === NO_GROUP ? undefined : tabGroups[key], rows: rs }))
    .sort((a, b) => {
      if (a.key === NO_GROUP) return 1;
      if (b.key === NO_GROUP) return -1;
      return (a.group?.name || '').localeCompare(b.group?.name || '');
    });
}

function GroupCard({ laneKey, groupKey, group, rows, alert, onOpen, collapsed, onToggleCollapse, onAssignGroup }:
  { laneKey: LaneId; groupKey: string; group: TabGroupInfo | undefined; rows: Row[]; alert: boolean } & Omit<BoardProps, 'byLane' | 'tabGroups'>) {
  const hex = groupHex(group);
  const dropKey = `${laneKey}:${groupKey}`;
  const isCollapsed = collapsed.has(dropKey);
  const hasWaiting = alert && rows.some(r => r.live.key === 'wait');
  const Chevron = isCollapsed ? ChevronUp : ChevronDown;
  // react-aria drop target: dropping a session card here reassigns it to this
  // group (or ungroups it when this is the "No group" cluster).
  const dropRef = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useDrop({
    ref: dropRef,
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === 'text' && item.types.has(BOARD_DRAG_TYPE)) {
          const id = await item.getText(BOARD_DRAG_TYPE);
          if (id) onAssignGroup(id, groupKey === NO_GROUP ? null : groupKey);
          break;
        }
      }
    },
  });
  return (
    <div
      ref={dropRef}
      {...dropProps}
      className="rounded-xl border overflow-hidden transition-colors"
      style={{
        borderColor: isDropTarget ? hex : `${hex}40`,
        background: `linear-gradient(180deg, ${hex}17, ${hex}08), var(--color-surface-light)`,
        outline: isDropTarget ? `2px dashed ${hex}` : undefined,
        outlineOffset: -2,
      }}
    >
      {/* discreet group label — click to collapse */}
      <button
        type="button"
        onClick={() => onToggleCollapse(dropKey)}
        className="w-full flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 hover:bg-white/[0.02] transition-colors"
      >
        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: hex }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 truncate">{group?.name || 'No group'}</span>
        {hasWaiting && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" style={{ boxShadow: '0 0 6px currentColor' }} />}
        <span className="ml-auto text-[10px] font-semibold text-zinc-600">{rows.length}</span>
        <Chevron size={13} strokeWidth={2.2} className="text-zinc-600 shrink-0" />
      </button>
      {/* normal session cards inside */}
      {!isCollapsed && (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {rows.map(r => (
            <BoardCard
              key={r.s.id}
              r={r}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardCard({ r, onOpen }:
  { r: Row; onOpen: (id: string) => void }) {
  const { dragProps, isDragging } = useDrag({
    getItems: () => [{ [BOARD_DRAG_TYPE]: r.s.id, 'text/plain': r.s.name }],
  });
  return (
    <div
      {...dragProps}
      onClick={() => onOpen(r.s.id)}
      className={`text-left rounded-lg border border-border px-2.5 py-2 cursor-grab active:cursor-grabbing hover:border-border-light hover:-translate-y-px transition-all ${isDragging ? 'opacity-40' : ''}`}
      style={{ background: 'linear-gradient(180deg, rgba(255,255,255,.022), transparent 40%), var(--color-surface-lighter)' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <LiveDot live={r.live} />
        <span className="ml-auto text-[9.5px] text-zinc-600">{r.ago}</span>
      </div>
      <div className="text-[12px] font-semibold text-zinc-200 leading-tight mb-0.5 truncate">{r.s.name}</div>
      {r.preview && <div className="text-[10.5px] text-zinc-500 leading-tight mb-2 truncate">{r.preview}</div>}
      <div className="flex items-center gap-1.5 flex-wrap">
        <QABadge qa={r.qa} />
        {r.branch && (
          <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 font-mono max-w-[130px]">
            <GitBranch size={10} strokeWidth={2} /><span className="truncate">{r.branch}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- LIST ---------- */

function ListView({ byLane, onOpen }: { byLane: Record<LaneId, Row[]>; onOpen: (id: string) => void }) {
  return (
    <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2">
      {LANE_ORDER.map(l => {
        const lane = LANES[l];
        const items = byLane[l];
        if (!items.length) return null;
        const Icon = lane.icon;
        return (
          <div key={l} className="mb-1">
            <div className="flex items-center gap-2.5 px-1.5 pt-4 pb-2">
              <span className={`w-[18px] h-[18px] rounded grid place-items-center ${lane.chip}`}><Icon size={11} strokeWidth={2} /></span>
              <h3 className={`text-[11px] font-bold uppercase tracking-wide ${lane.alert ? lane.color : 'text-zinc-400'}`}>{lane.name}</h3>
              <span className="text-[11px] font-semibold rounded-full px-2 py-px bg-surface-lighter text-zinc-400">{items.length}</span>
            </div>
            <div className={`flex flex-col rounded-xl border border-border overflow-hidden bg-surface ${l === 'done' ? 'opacity-70' : ''}`}>
              {items.map(r => <ListRow key={r.s.id} r={r} onOpen={onOpen} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ListRow({ r, onOpen }: { r: Row; onOpen: (id: string) => void }) {
  const dotCls = r.live.key === 'run' ? 'bg-emerald-400' : r.live.key === 'wait' ? 'bg-amber-400' : 'bg-zinc-600';
  return (
    <button
      type="button"
      onClick={() => onOpen(r.s.id)}
      className="grid items-center gap-3.5 px-3.5 py-2.5 border-b border-border last:border-b-0 hover:bg-surface-light transition-colors text-left"
      style={{ gridTemplateColumns: '10px minmax(0,1.6fr) auto 92px 56px' }}
    >
      <span className={`w-2 h-2 rounded-full justify-self-center ${dotCls} ${r.live.key !== 'idle' ? 'animate-pulse' : ''}`} />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-zinc-200 truncate">{r.s.name}</div>
        <div className="text-[11.5px] text-zinc-500 truncate mt-0.5">{r.preview || basename(r.s.cwd)}</div>
      </div>
      <QABadge qa={r.qa} />
      <PRChip pr={r.pr} />
      <span className="text-[11px] text-zinc-600 text-right">{r.ago}</span>
    </button>
  );
}

/* ---------- DRAWER ---------- */

function Drawer({ row, onClose, onPrev, onNext, onOpenSession }: {
  row: Row; onClose: () => void; onPrev: () => void; onNext: () => void; onOpenSession: () => void;
}) {
  const { s, pr, live, qa, branch, ago, preview } = row;
  return (
    <>
      <div className="absolute inset-0 bg-black/50 z-40" onClick={onClose} />
      <aside className="absolute top-0 right-0 bottom-0 w-[460px] max-w-[92vw] bg-surface border-l border-border shadow-2xl z-50 flex flex-col">
        {/* head */}
        <div className="px-[18px] pt-4 pb-3.5 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <IconBtn onClick={onPrev}><ChevronLeft size={14} strokeWidth={2.2} /></IconBtn>
            <IconBtn onClick={onNext}><ChevronRight size={14} strokeWidth={2.2} /></IconBtn>
            <div className="ml-1"><LiveDot live={live} /></div>
            <IconBtn onClick={onClose} className="ml-auto"><X size={14} strokeWidth={2.2} /></IconBtn>
          </div>
          <h2 className="text-[17px] font-bold text-zinc-100 leading-tight mb-2.5">{s.name}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            {pr && <MetaChip><GitPullRequest size={11} strokeWidth={2} />#{pr.prNumber}</MetaChip>}
            {branch && <MetaChip mono><GitBranch size={11} strokeWidth={2} />{branch}</MetaChip>}
            {s.model && <MetaChip>{s.model.replace(/^claude-/, '')}</MetaChip>}
            {s.cwd && <MetaChip mono>{basename(s.cwd)}</MetaChip>}
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-[18px] py-4">
          {/* QA / review */}
          <Section icon={CheckCircle2} title="QA & Review">
            <div className={`rounded-xl border px-3.5 py-3 ${qaHero(qa.tone)}`}>
              <div className="flex items-center gap-2.5 text-[13px] font-bold">
                {qa.tone === 'pass' ? <CheckCircle2 size={15} strokeWidth={2.2} /> : <GitPullRequest size={15} strokeWidth={2.2} />}
                {qaHeroLabel(qa, pr)}
              </div>
              {pr && (
                <button
                  type="button"
                  onClick={() => window.open(pr.url, '_blank')}
                  className="mt-2.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-sky-400 hover:underline"
                >
                  <ExternalLink size={12} strokeWidth={2} />{pr.title || `Open PR #${pr.prNumber}`}
                </button>
              )}
              <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
                CI check status isn't wired yet — once a <code className="font-mono text-zinc-400">/session-review-status</code> endpoint lands, per-check ✓/✕ shows here.
              </p>
            </div>
          </Section>

          {/* where it left off */}
          <Section icon={Clock} title="Where it left off">
            <div className="rounded-xl border border-border bg-surface-light px-3.5 py-3 text-[13px] leading-relaxed text-zinc-300">
              {preview
                ? <><span className="text-zinc-500">{ago ? `${ago} ago` : 'recently'} · last message</span><p className="mt-1.5">{preview}</p></>
                : <span className="text-zinc-500">No messages captured for this session yet.</span>}
            </div>
          </Section>

          {/* meta */}
          <Section icon={MessageSquare} title="Session">
            <div className="rounded-xl border border-border bg-surface-light divide-y divide-border text-[12.5px]">
              <KV k="Last activity" v={ago ? `${ago} ago` : '—'} />
              <KV k="Status" v={s.status === 'archived' ? 'Closed' : 'Open'} />
              <KV k="Folder" v={s.cwd || '—'} mono />
              {branch && <KV k="Branch" v={branch} mono />}
            </div>
          </Section>
        </div>

        {/* footer */}
        <div className="px-[18px] py-3 border-t border-border flex gap-2.5">
          <button
            type="button"
            onClick={onOpenSession}
            className="flex-1 inline-flex items-center justify-center gap-2 h-[38px] rounded-lg text-[12.5px] font-semibold bg-indigo-400 text-[#0f1012] hover:brightness-110"
          >
            <ArrowRight size={14} strokeWidth={2.4} />Open session
          </button>
          {pr && (
            <button
              type="button"
              onClick={() => window.open(pr.url, '_blank')}
              className="inline-flex items-center justify-center gap-2 h-[38px] px-3.5 rounded-lg text-[12.5px] font-semibold bg-surface-light border border-border text-zinc-200 hover:bg-surface-lighter"
            >
              <GitPullRequest size={14} strokeWidth={2} />PR
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function qaHero(tone: QA['tone']): string {
  return tone === 'pass' ? 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-400'
    : tone === 'open' ? 'border-sky-500/22 bg-sky-500/[0.07] text-sky-400'
    : tone === 'closed' ? 'border-zinc-500/25 bg-surface-light text-zinc-400'
    : 'border-border bg-surface-light text-zinc-400';
}
function qaHeroLabel(qa: QA, pr: PRLink | undefined): string {
  if (qa.tone === 'pass') return 'Approved & merged';
  if (qa.tone === 'open') return pr ? `In review — PR #${pr.prNumber} open` : 'In review';
  if (qa.tone === 'closed') return pr ? `PR #${pr.prNumber} closed` : 'Session closed';
  return 'No PR opened yet — work in progress';
}

function IconBtn({ children, onClick, className = '' }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`w-7 h-7 grid place-items-center rounded-lg border border-border bg-surface-light text-zinc-400 hover:text-zinc-100 hover:bg-surface-lighter ${className}`}>
      {children}
    </button>
  );
}

function MetaChip({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold text-zinc-400 bg-surface-light border border-border rounded-md px-2 py-1 ${mono ? 'font-mono' : ''}`}>
      {children}
    </span>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h4 className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-wide text-zinc-600 mb-2.5">
        <Icon size={12} strokeWidth={2} />{title}
      </h4>
      {children}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="text-zinc-500 shrink-0">{k}</span>
      <span className={`ml-auto text-zinc-300 truncate text-right ${mono ? 'font-mono text-[11.5px]' : ''}`}>{v}</span>
    </div>
  );
}
