import { useEffect, useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Pin, Plus, Sun, X } from 'lucide-react';
import { Button } from '@heroui/react';
import type { ClaudeClient, ConnectionStatus, SessionInfo } from '../../lib/claude-client';
import { MobileNewSessionModal } from './MobileNewSessionModal';

type TabGroup = { id: string; name: string; color: string };

interface Props {
  client: ClaudeClient;
  sessions: SessionInfo[];
  activeId: string | null;
  onQuickStart: (provider: string) => void;
  opencodeAvailable: boolean;
  opencodeModels?: Array<{ id: string; label: string; providerName: string }>;
  claudeModels?: Array<{ id: string; label: string }>;
  onSelectSession: (id: string) => void;
  onSessionCreated?: (id: string, cwd: string) => void;
  onCloseSession: (id: string) => void;
  onReopenSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  statuses?: Record<string, ConnectionStatus | string>;
  streaming?: Record<string, boolean>;
  interrupted?: Record<string, boolean>;
  hasPermission?: Record<string, boolean>;
  turnComplete?: Set<string>;
  tabGroups: Record<string, TabGroup>;
  tabGroupMap: Record<string, string>;
  tabOrder: string[];
  pinnedSessionIds?: Set<string>;
  /** Per-session last-message timestamp — used to order sessions by recency
   *  the same way the desktop TabBar does. */
  sessionLastMessageAt?: Record<string, number>;
  keepScreenOn: boolean;
  keepScreenOnSupported: boolean;
  onToggleKeepScreenOn: (next: boolean) => void;
}

const QUICK_START_PROVIDERS: ReadonlyArray<{ key: string; label: string; tagline: string }> = [
  { key: 'claude', label: 'Claude', tagline: 'Anthropic agent' },
  { key: 'codex', label: 'Codex', tagline: 'OpenAI Codex' },
  { key: 'opencode', label: 'OpenCode', tagline: 'opencode.ai router' },
];

const COLOR_DOT: Record<string, string> = {
  blue: 'bg-blue-400',
  green: 'bg-green-400',
  amber: 'bg-amber-400',
  violet: 'bg-violet-400',
  red: 'bg-red-400',
  pink: 'bg-pink-400',
};

/** Compact "5m / 2h / 3d" age label — mirrors desktop's TabBar. */
function formatTabAge(ts: number | undefined, now: number): string {
  if (!ts) return '';
  const diffMs = Math.max(0, now - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  return `${mo}mo`;
}

function getDotClass(connStatus: string, isStreaming: boolean, turnComplete: boolean, wasInterrupted: boolean): string {
  if (connStatus === 'error') return 'bg-red-400';
  if (connStatus === 'connecting' || connStatus === 'starting') return 'bg-amber-400 animate-pulse';
  if (turnComplete) return 'bg-green-400 animate-pulse';
  if (connStatus === 'connected' && isStreaming) return 'bg-amber-400 animate-pulse';
  if (wasInterrupted) return 'bg-red-400';
  if (connStatus === 'connected') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

export function MobileHome({
  client,
  sessions,
  activeId,
  onQuickStart,
  opencodeAvailable,
  opencodeModels = [],
  claudeModels = [],
  onSelectSession,
  onSessionCreated,
  onCloseSession,
  onReopenSession,
  onArchiveSession,
  statuses,
  streaming,
  interrupted,
  hasPermission,
  turnComplete,
  tabGroups,
  tabGroupMap,
  tabOrder,
  pinnedSessionIds,
  sessionLastMessageAt,
  keepScreenOn,
  keepScreenOnSupported,
  onToggleKeepScreenOn,
}: Props) {
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  // Tick once a minute so age labels refresh from "1m" → "2m" → … without
  // hammering the parent for re-renders.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const visibleQuickStart = QUICK_START_PROVIDERS.filter(p => p.key !== 'opencode' || opencodeAvailable);

  const openSessions = useMemo(() => {
    const filtered = sessions.filter((s) => s.status === 'open');
    return [...filtered].sort((a, b) => {
      const ai = tabOrder.indexOf(a.id);
      const bi = tabOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [sessions, tabOrder]);

  const closedSessions = useMemo(
    () => sessions.filter((s) => s.status === 'archived'),
    [sessions],
  );

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
          // Group members: pinned first, then by last-message recency
          // (newest at top), then fall back to tabOrder for stability.
          // Mirrors the desktop TabBar's sort.
          const members = openSessions
            .filter((m) => tabGroupMap[m.id] === gid)
            .slice()
            .sort((a, b) => {
              const pa = pinnedSessionIds?.has(a.id) ? 1 : 0;
              const pb = pinnedSessionIds?.has(b.id) ? 1 : 0;
              if (pa !== pb) return pb - pa;
              const ta = sessionLastMessageAt?.[a.id] || 0;
              const tb = sessionLastMessageAt?.[b.id] || 0;
              if (tb !== ta) return tb - ta;
              return openSessions.indexOf(a) - openSessions.indexOf(b);
            });
          list.push({ kind: 'group', group: tabGroups[gid]!, members });
        }
      } else {
        list.push({ kind: 'tab', session: s });
      }
    }
    return list;
  }, [openSessions, tabGroupMap, tabGroups, pinnedSessionIds, sessionLastMessageAt]);

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
      (s.ready ? 'connected' : s.runtime_status === 'starting' ? 'starting' : 'disconnected');
    const pending = !!hasPermission?.[s.id];
    const ageLabel = formatTabAge(sessionLastMessageAt?.[s.id], nowMs);
    return (
      <li key={s.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelectSession(s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectSession(s.id);
            }
          }}
          className={`group relative flex w-full items-center gap-2 ${opts?.indented ? 'pl-7 pr-3' : 'px-3'} min-h-11 text-[13px] rounded-md transition-colors text-left ${
            isActive
              ? 'bg-surface-light text-zinc-100'
              : 'text-zinc-400 active:bg-surface/60 active:text-zinc-200'
          }`}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(String(status), !!streaming?.[s.id], !!turnComplete?.has(s.id), !!interrupted?.[s.id])}`} />
          <span className="truncate flex-1">{s.name}</span>
          {pinnedSessionIds?.has(s.id) && (
            <Pin size={11} strokeWidth={2.25} className="shrink-0 text-zinc-500 fill-current" aria-label="Pinned to top" />
          )}
          {ageLabel && !isActive && (
            <span
              className="shrink-0 text-[10px] tabular-nums text-zinc-600"
              title={`Last activity ${ageLabel} ago`}
            >
              {ageLabel}
            </span>
          )}
          {pending && !isActive && (
            <span className="shrink-0 relative inline-flex w-2.5 h-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
          <span onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              onPress={() => onCloseSession(s.id)}
              className="shrink-0 w-7 h-7 -mr-1 flex items-center justify-center rounded text-zinc-500 active:text-zinc-200 active:bg-white/10 min-w-0"
              aria-label={`Close ${s.name}`}
            >
              <X size={14} strokeWidth={2.25} />
            </Button>
          </span>
        </div>
      </li>
    );
  };

  return (
    <div
      className="min-h-[100dvh] overflow-y-auto"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1.25rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 7rem)',
      }}
    >
      <div className="px-5 max-w-md mx-auto">
        <div className="mb-5 mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <img src="/brand/codiby-logo.svg" alt="Codiby" className="h-9 w-auto mb-1 select-none" draggable={false} />
            <p className="text-xs text-zinc-500">Sessions</p>
          </div>
          <Button
            variant="ghost"
            onPress={() => setNewModalOpen(true)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-light text-zinc-100 text-[12px] font-medium active:bg-white/15 h-auto min-w-0"
          >
            <Plus size={15} />
            New
          </Button>
        </div>

        <div className="flex items-stretch gap-2 mb-3">
          {visibleQuickStart.map((p) => (
            <Button
              key={p.key}
              variant="ghost"
              onPress={() => { onQuickStart(p.key); setNewModalOpen(true); }}
              className="flex-1 flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 text-zinc-300 active:bg-zinc-800/70 transition-colors min-w-0 h-auto"
            >
              <span className="text-[12px] font-semibold text-zinc-100 leading-tight">{p.label}</span>
              <span className="text-[10px] text-zinc-500 truncate w-full">{p.tagline}</span>
            </Button>
          ))}
        </div>

        {keepScreenOnSupported && (
          <Button
            variant="ghost"
            fullWidth
            aria-label={`Keep screen on: ${keepScreenOn ? 'enabled' : 'disabled'}`}
            aria-pressed={keepScreenOn}
            onPress={() => onToggleKeepScreenOn(!keepScreenOn)}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 active:bg-zinc-800/70 transition-colors mb-3 h-auto justify-start"
          >
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${keepScreenOn ? 'bg-amber-500/20' : 'bg-zinc-800/80'}`}>
              <Sun className={`w-4 h-4 ${keepScreenOn ? 'text-amber-300' : 'text-zinc-500'}`} />
            </span>
            <div className="flex-1 text-left min-w-0">
              <div className="text-[13px] font-medium text-zinc-200">Keep screen on</div>
              <div className="text-[11px] text-zinc-500">Prevents the display from dimming</div>
            </div>
            <span className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${keepScreenOn ? 'bg-amber-500/70' : 'bg-zinc-700'}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${keepScreenOn ? 'translate-x-4' : 'translate-x-0'}`} />
            </span>
          </Button>
        )}

        <div className="rounded-xl bg-[#161616] border border-white/5 py-1 mb-3">
          {renderList.length === 0 && (
            <p className="text-sm text-zinc-500 px-3 py-4">No open sessions. Tap New to begin.</p>
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
                  <Button
                    variant="ghost"
                    fullWidth
                    onPress={() => toggleGroup(group.id)}
                    className="relative flex w-full items-center gap-2 px-2 min-h-10 text-[13px] rounded-md text-zinc-300 active:bg-surface/60 justify-start! h-auto text-left!"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={14} className="shrink-0 text-zinc-500" />
                    ) : (
                      <ChevronDown size={14} className="shrink-0 text-zinc-500" />
                    )}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot} ${isCollapsed && hasActivity ? 'animate-pulse' : ''}`} />
                    <span className="truncate flex-1 font-medium">{group.name}</span>
                    <span className="text-[11px] text-zinc-500 shrink-0">{members.length}</span>
                  </Button>
                  {!isCollapsed && (
                    <ul className="flex flex-col gap-0.5">
                      {members.map((m) => renderTab(m, { indented: true }))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {closedSessions.length > 0 && (
          <div className="rounded-xl bg-white/[0.02] border border-white/5">
            <Button
              variant="ghost"
              fullWidth
              onPress={() => setShowClosed((v) => !v)}
              className="w-full flex items-center gap-2 px-3 min-h-11 text-[12px] text-zinc-400 active:text-zinc-200 active:bg-white/5 rounded-xl justify-start! text-left! h-auto"
            >
              {showClosed ? <ChevronDown size={14} className="shrink-0 text-zinc-500" /> : <ChevronRight size={14} className="shrink-0 text-zinc-500" />}
              <span className="uppercase tracking-wider font-semibold flex-1 text-left">Closed sessions</span>
              <span className="text-[11px] text-zinc-500">{closedSessions.length}</span>
            </Button>
            {showClosed && (
              <ul className="flex flex-col px-1.5 pb-1.5">
                {closedSessions.map((s) => (
                  <li key={s.id}>
                    <Button
                      variant="ghost"
                      fullWidth
                      onPress={() => onReopenSession(s.id)}
                      className="group relative flex w-full items-center gap-2 px-3 min-h-11 text-[13px] rounded-md text-zinc-400 active:bg-surface/60 active:text-zinc-200 justify-start! text-left! h-auto"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                      <span className="truncate flex-1">{s.name}</span>
                      <span className="text-[10px] text-zinc-600 ml-auto shrink-0 font-mono truncate max-w-[40%]">
                        {s.cwd.split('/').pop()}
                      </span>
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => { e.stopPropagation(); onArchiveSession(s.id); }}
                        className="shrink-0 w-8 h-8 -mr-1 flex items-center justify-center rounded text-zinc-500 active:text-zinc-200 active:bg-surface"
                        aria-label="Archive session"
                        title="Archive (hide from this list, keeps history)"
                      >
                        <Archive size={14} strokeWidth={2} />
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <MobileNewSessionModal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        client={client}
        opencodeAvailable={opencodeAvailable}
        opencodeModels={opencodeModels}
        claudeModels={claudeModels}
        onCreated={(id, cwd) => { onSessionCreated?.(id, cwd); onSelectSession(id); setNewModalOpen(false); }}
      />
    </div>
  );
}
