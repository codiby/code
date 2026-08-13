import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Pin, Plus, RefreshCw, Search, Sun, X } from 'lucide-react';
import { Button } from '@heroui/react';
import type { ClaudeClient, ConnectionStatus, SessionInfo } from '../../lib/claude-client';
import { MobileNewSessionModal } from './MobileNewSessionModal';
import { MobileSessionMenu } from './MobileSessionMenu';

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
  /** Long-press a session row to pin / unpin it. Pinned sessions are lifted
   *  out of their group into a "Pinned" block at the very top. */
  onTogglePin?: (id: string) => void;
  /** Per-session last-message timestamp — used to order sessions by recency
   *  the same way the desktop TabBar does. */
  sessionLastMessageAt?: Record<string, number>;
  keepScreenOn: boolean;
  keepScreenOnSupported: boolean;
  onToggleKeepScreenOn: (next: boolean) => void;
  /** A newer build is installed and parked — the app never swaps to it on
   *  its own, so the refresh button gets a dot to say it's worth tapping. */
  updateReady?: boolean;
  refreshing?: boolean;
  onForceRefresh?: () => void;
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

/** Loose "characters appear in order" fallback so `mbchat` still finds
 *  "Mobile Chat" when the user drops letters on a phone keyboard. */
function isSubsequence(q: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (target[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Rank a session against the search query. Name matches beat project
 *  (cwd basename) matches, which beat group / full-path matches; the loose
 *  subsequence match is the last resort. Returns -1 when nothing matches. */
function sessionMatchScore(q: string, s: SessionInfo, groupName: string): number {
  const name = s.name.toLowerCase();
  const cwd = s.cwd.toLowerCase();
  const project = cwd.split('/').pop() || '';
  const group = groupName.toLowerCase();

  if (name.startsWith(q)) return 1000 - name.length;
  const nameIdx = name.indexOf(q);
  if (nameIdx >= 0) return 800 - nameIdx;
  if (project.includes(q)) return 600 - project.indexOf(q);
  if (group && group.includes(q)) return 500;
  if (cwd.includes(q)) return 400;
  if (isSubsequence(q, name)) return 200;
  return -1;
}

/** Split `text` around every case-insensitive occurrence of `q` so the
 *  matched runs can be emphasised in the result rows. */
function highlight(text: string, q: string) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts: Array<string | { hit: string }> = [];
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) break;
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push({ hit: text.slice(idx, idx + q.length) });
    i = idx + q.length;
  }
  if (!parts.length) return text;
  if (i < text.length) parts.push(text.slice(i));
  return parts.map((p, n) =>
    typeof p === 'string'
      ? <span key={n}>{p}</span>
      : <mark key={n} className="bg-transparent text-amber-300 font-medium">{p.hit}</mark>,
  );
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
  onTogglePin,
  sessionLastMessageAt,
  keepScreenOn,
  keepScreenOnSupported,
  onToggleKeepScreenOn,
  updateReady,
  refreshing,
  onForceRefresh,
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
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Long-press a row → open its context menu (pin / close). The click the
  // browser fires on release is swallowed via `longPressFiredRef` so opening
  // the menu never also opens the chat.
  const [menuSession, setMenuSession] = useState<SessionInfo | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    longPressOriginRef.current = null;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  /** Abort the press once the finger travels — otherwise a scroll that
   *  starts on a row pops the menu open mid-flick. */
  const onLongPressMove = (e: { clientX: number; clientY: number }) => {
    const origin = longPressOriginRef.current;
    if (!origin) return;
    if (Math.abs(e.clientX - origin.x) > 10 || Math.abs(e.clientY - origin.y) > 10) cancelLongPress();
  };
  const openMenu = (s: SessionInfo) => {
    longPressFiredRef.current = true;
    // The row is `select-none`, but a drag that started on neighbouring text
    // (or a selection left over from before) would otherwise stay highlighted
    // under the sheet and bring up the OS "Search with Google" bar.
    try { window.getSelection()?.removeAllRanges(); } catch {}
    setMenuSession(s);
    try { (navigator as unknown as { vibrate?: (n: number) => void }).vibrate?.(10); } catch {}
  };
  const startLongPress = (s: SessionInfo, e: { clientX: number; clientY: number }) => {
    if (!onTogglePin) return;
    longPressFiredRef.current = false;
    cancelLongPress();
    longPressOriginRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => openMenu(s), 500);
  };
  useEffect(() => cancelLongPress, []);
  const visibleQuickStart = QUICK_START_PROVIDERS.filter(p => p.key !== 'opencode' || opencodeAvailable);
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

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

  // Search spans open *and* closed sessions — on a phone the closed bucket is
  // collapsed by default, so a name-based lookup is the only practical way to
  // get back to an old session. Ranked by match quality, then by recency so
  // equally-good matches surface the session that was last touched.
  const results = useMemo(() => {
    if (!searching) return [];
    const scored: Array<{ s: SessionInfo; score: number; group?: TabGroup }> = [];
    for (const s of sessions) {
      const gid = tabGroupMap[s.id];
      const group = gid ? tabGroups[gid] : undefined;
      const score = sessionMatchScore(q, s, group?.name || '');
      if (score >= 0) scored.push({ s, score, group });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = sessionLastMessageAt?.[a.s.id] || 0;
      const tb = sessionLastMessageAt?.[b.s.id] || 0;
      return tb - ta;
    });
    return scored;
  }, [searching, q, sessions, tabGroupMap, tabGroups, sessionLastMessageAt]);

  type RenderItem =
    | { kind: 'tab'; session: SessionInfo }
    | { kind: 'group'; group: TabGroup; members: SessionInfo[] };

  // Pinned sessions are lifted out of their group and float to the very top
  // of the list — on a phone the whole point of a pin is reaching a session
  // without expanding the group it happens to live in. Most recently active
  // first among themselves.
  const pinnedSessions = useMemo(
    () => openSessions
      .filter((s) => pinnedSessionIds?.has(s.id))
      .sort((a, b) => (sessionLastMessageAt?.[b.id] || 0) - (sessionLastMessageAt?.[a.id] || 0)),
    [openSessions, pinnedSessionIds, sessionLastMessageAt],
  );

  const renderList = useMemo<RenderItem[]>(() => {
    const list: RenderItem[] = [];
    const seenGroups = new Set<string>();
    // Pinned ones already render above; skip them everywhere below so a
    // session never shows up twice.
    const rest = openSessions.filter((s) => !pinnedSessionIds?.has(s.id));
    for (const s of rest) {
      const gid = tabGroupMap[s.id];
      if (gid && tabGroups[gid]) {
        if (!seenGroups.has(gid)) {
          seenGroups.add(gid);
          // Group members by last-message recency (newest at top), falling
          // back to tabOrder for stability.
          const members = rest
            .filter((m) => tabGroupMap[m.id] === gid)
            .slice()
            .sort((a, b) => {
              const ta = sessionLastMessageAt?.[a.id] || 0;
              const tb = sessionLastMessageAt?.[b.id] || 0;
              if (tb !== ta) return tb - ta;
              return openSessions.indexOf(a) - openSessions.indexOf(b);
            });
          // A group whose every member is pinned would render as an empty
          // header — drop it.
          if (members.length) list.push({ kind: 'group', group: tabGroups[gid]!, members });
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

  const renderTab = (s: SessionInfo, opts?: { indented?: boolean; groupDot?: string }) => {
    const isActive = s.id === activeId;
    const status = (statuses && statuses[s.id]) ||
      (s.ready ? 'connected' : s.runtime_status === 'starting' ? 'starting' : 'disconnected');
    const pending = !!hasPermission?.[s.id];
    const ageLabel = formatTabAge(sessionLastMessageAt?.[s.id], nowMs);
    const isPinned = !!pinnedSessionIds?.has(s.id);
    return (
      <li key={s.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            // Swallow the click that follows a pin toggle.
            if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
            onSelectSession(s.id);
          }}
          onPointerDown={(e) => startLongPress(s, e)}
          onPointerMove={onLongPressMove}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(e) => {
            // iOS Safari's long-press callout / desktop right-click — show
            // our menu instead of the OS one.
            e.preventDefault();
            cancelLongPress();
            if (onTogglePin) openMenu(s);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelectSession(s.id);
            }
          }}
          className={`group relative flex w-full items-center gap-2 ${opts?.indented ? 'pl-7 pr-3' : 'px-3'} min-h-11 text-[13px] rounded-md transition-colors text-left select-none touch-manipulation [-webkit-touch-callout:none] ${
            isActive
              ? 'bg-surface-light text-zinc-100'
              : 'text-zinc-400 active:bg-surface/60 active:text-zinc-200'
          }`}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${getDotClass(String(status), !!streaming?.[s.id], !!turnComplete?.has(s.id), !!interrupted?.[s.id])}`} />
          <span className="truncate flex-1">{s.name}</span>
          {/* Pinned rows sit outside their group, so carry the group's colour
              along as a hint of where the session actually lives. */}
          {opts?.groupDot && (
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${opts.groupDot}`} aria-hidden />
          )}
          {isPinned && (
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

  /** A single search hit. Flat — groups become a chip instead of a header so
   *  results stay scannable — and closed sessions reopen on tap. */
  const renderResult = ({ s, group }: { s: SessionInfo; group?: TabGroup }) => {
    const isClosed = s.status === 'archived';
    const isActive = s.id === activeId;
    const status = (statuses && statuses[s.id]) ||
      (s.ready ? 'connected' : s.runtime_status === 'starting' ? 'starting' : 'disconnected');
    const ageLabel = formatTabAge(sessionLastMessageAt?.[s.id], nowMs);
    const project = s.cwd.split('/').pop() || '';
    return (
      <li key={s.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
            if (isClosed) onReopenSession(s.id); else onSelectSession(s.id);
          }}
          // Long-press opens the same menu from here — closed sessions are
          // excluded since the pinned block only lists open ones.
          onPointerDown={(e) => { if (!isClosed) startLongPress(s, e); }}
          onPointerMove={onLongPressMove}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(e) => {
            e.preventDefault();
            cancelLongPress();
            if (!isClosed && onTogglePin) openMenu(s);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (isClosed) onReopenSession(s.id); else onSelectSession(s.id);
            }
          }}
          className={`flex w-full items-center gap-2 px-3 min-h-11 text-[13px] rounded-md transition-colors text-left select-none touch-manipulation [-webkit-touch-callout:none] ${
            isActive ? 'bg-surface-light text-zinc-100' : 'text-zinc-400 active:bg-surface/60 active:text-zinc-200'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isClosed
                ? 'bg-zinc-700'
                : getDotClass(String(status), !!streaming?.[s.id], !!turnComplete?.has(s.id), !!interrupted?.[s.id])
            }`}
          />
          <span className="truncate flex-1 min-w-0">{highlight(s.name, q)}</span>
          {pinnedSessionIds?.has(s.id) && (
            <Pin size={11} strokeWidth={2.25} className="shrink-0 text-zinc-500 fill-current" aria-label="Pinned to top" />
          )}
          {group && (
            <span className="shrink-0 flex items-center gap-1 text-[10px] text-zinc-500 max-w-[30%]">
              <span className={`w-1.5 h-1.5 rounded-full ${COLOR_DOT[group.color] || COLOR_DOT.blue!}`} />
              <span className="truncate">{group.name}</span>
            </span>
          )}
          {project && (
            <span className="shrink-0 text-[10px] text-zinc-600 font-mono truncate max-w-[35%]">{project}</span>
          )}
          {isClosed ? (
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-600">Closed</span>
          ) : (
            ageLabel && <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">{ageLabel}</span>
          )}
          {hasPermission?.[s.id] && !isActive && (
            <span className="shrink-0 relative inline-flex w-2.5 h-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
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
          <div className="shrink-0 flex items-center gap-2">
            {onForceRefresh && (
              <Button
                variant="ghost"
                isIconOnly
                onPress={onForceRefresh}
                isDisabled={refreshing}
                aria-label={updateReady ? 'Force refresh — update available' : 'Force refresh'}
                className="relative w-9 h-9 min-w-0 flex items-center justify-center rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-zinc-400 active:bg-zinc-800/70 active:text-zinc-100 disabled:opacity-50"
              >
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
                {updateReady && !refreshing && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-zinc-950" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              onPress={() => setNewModalOpen(true)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-light text-zinc-100 text-[12px] font-medium active:bg-white/15 h-auto min-w-0"
            >
              <Plus size={15} />
              New
            </Button>
          </div>
        </div>

        {/* Session search. 16px text so iOS doesn't zoom the viewport on
            focus; type="search" keeps the keyboard's magnifier key. */}
        <div className="flex items-center gap-2 h-11 px-3 mb-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 focus-within:border-zinc-700">
          <Search size={15} strokeWidth={2} className="shrink-0 text-zinc-600" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setQuery(''); return; }
              if (e.key === 'Enter') {
                e.preventDefault();
                const first = results[0];
                if (!first) return;
                searchInputRef.current?.blur();
                if (first.s.status === 'archived') onReopenSession(first.s.id);
                else onSelectSession(first.s.id);
              }
            }}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[16px] text-zinc-200 placeholder:text-zinc-600 [&::-webkit-search-cancel-button]:hidden"
          />
          {searching && (
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              onPress={() => { setQuery(''); searchInputRef.current?.focus(); }}
              className="shrink-0 w-7 h-7 min-w-0 -mr-1 flex items-center justify-center rounded-full text-zinc-500 active:text-zinc-200 active:bg-white/10"
              aria-label="Clear search"
            >
              <X size={14} strokeWidth={2.25} />
            </Button>
          )}
        </div>

        {searching ? (
          <div className="rounded-xl bg-[#161616] border border-white/5 py-1 mb-3 select-none [-webkit-touch-callout:none]">
            {results.length === 0 ? (
              <p className="text-sm text-zinc-500 px-3 py-4">No sessions match “{query.trim()}”.</p>
            ) : (
              <>
                <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                  {results.length} {results.length === 1 ? 'result' : 'results'}
                </p>
                <ul className="flex flex-col gap-0.5 px-1.5 pb-1">
                  {results.map(renderResult)}
                </ul>
              </>
            )}
          </div>
        ) : (
        <>
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

        {/* Pinned — above every group, in its own card. Long-press any row
            (here or below) to toggle the pin. */}
        {pinnedSessions.length > 0 && (
          <div className="rounded-xl bg-[#161616] border border-white/5 py-1 mb-3 select-none [-webkit-touch-callout:none]">
            <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600 flex items-center gap-1.5">
              <Pin size={10} strokeWidth={2.25} className="fill-current" />
              Pinned
            </p>
            <ul className="flex flex-col gap-0.5 px-1.5 pb-1">
              {pinnedSessions.map((s) => {
                const gid = tabGroupMap[s.id];
                const group = gid ? tabGroups[gid] : undefined;
                return renderTab(s, {
                  groupDot: group ? (COLOR_DOT[group.color] || COLOR_DOT.blue!) : undefined,
                });
              })}
            </ul>
          </div>
        )}

        {/* Hidden entirely when every open session is pinned — an empty card
            under the Pinned block reads as a bug. */}
        {(renderList.length > 0 || pinnedSessions.length === 0) && (
        <div className="rounded-xl bg-[#161616] border border-white/5 py-1 mb-3 select-none [-webkit-touch-callout:none]">
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
        )}

        {closedSessions.length > 0 && (
          <div className="rounded-xl bg-white/[0.02] border border-white/5 select-none [-webkit-touch-callout:none]">
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
        </>
        )}
      </div>

      <MobileSessionMenu
        session={menuSession}
        isPinned={!!(menuSession && pinnedSessionIds?.has(menuSession.id))}
        groupName={menuSession ? tabGroups[tabGroupMap[menuSession.id] || '']?.name : undefined}
        onClose={() => setMenuSession(null)}
        onTogglePin={(id) => onTogglePin?.(id)}
        onCloseSession={onCloseSession}
      />

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
