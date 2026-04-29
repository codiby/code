import { useMemo } from 'react';
import { Plus, FolderOpen, Settings, ChevronRight, Clock, Sun } from 'lucide-react';
import type { SessionInfo } from '../../lib/claude-client';

interface Props {
  sessions: SessionInfo[];
  closedSessionIds: Set<string>;
  archivedSessionIds: Set<string>;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onSelectSession: (id: string) => void;
  onReopenSession: (id: string) => void;
  keepScreenOn: boolean;
  keepScreenOnSupported: boolean;
  onToggleKeepScreenOn: (next: boolean) => void;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  return new Date(ts).toLocaleDateString();
}

export function MobileHome({
  sessions,
  closedSessionIds,
  archivedSessionIds,
  onNewSession,
  onOpenSessions,
  onOpenSettings,
  onSelectSession,
  onReopenSession,
  keepScreenOn,
  keepScreenOnSupported,
  onToggleKeepScreenOn,
}: Props) {
  const openSessions = useMemo(
    () =>
      sessions
        .filter((s) => !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id))
        .slice()
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    [sessions, closedSessionIds, archivedSessionIds],
  );

  const recentClosed = useMemo(
    () =>
      sessions
        .filter((s) => closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id))
        .slice()
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 6),
    [sessions, closedSessionIds, archivedSessionIds],
  );

  return (
    <div
      className="min-h-[100dvh] overflow-y-auto"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 7rem)',
      }}
    >
      <div className="px-6 max-w-md mx-auto">
        {/* Header */}
        <div className="mb-8 mt-2">
          <img src="/brand/codiby-logo.svg" alt="Codiby" className="h-10 w-auto mb-2 select-none" draggable={false} />
          <p className="text-sm text-zinc-500">Editing evolved with Claude.</p>
        </div>

        {/* Primary CTA */}
        <button
          type="button"
          onClick={onNewSession}
          className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl bg-gradient-to-br from-violet-500/20 to-indigo-500/15 border border-violet-500/30 text-zinc-100 active:from-violet-500/30 active:to-indigo-500/25 transition-colors mb-3"
        >
          <span className="w-10 h-10 rounded-xl bg-violet-500/25 flex items-center justify-center shrink-0">
            <Plus className="w-5 h-5 text-violet-200" />
          </span>
          <div className="flex-1 text-left">
            <div className="text-[15px] font-semibold">New Session</div>
            <div className="text-[12px] text-zinc-400">Start a fresh Claude session</div>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        </button>

        {/* Secondary actions */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            type="button"
            onClick={onOpenSessions}
            className="flex flex-col items-start gap-2 px-3 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 text-zinc-300 active:bg-zinc-800/70 transition-colors"
          >
            <FolderOpen className="w-4 h-4 text-zinc-400" />
            <span className="text-[13px] font-medium">All Sessions</span>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex flex-col items-start gap-2 px-3 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 text-zinc-300 active:bg-zinc-800/70 transition-colors"
          >
            <Settings className="w-4 h-4 text-zinc-400" />
            <span className="text-[13px] font-medium">Settings</span>
          </button>
        </div>

        {/* Keep-screen-on toggle */}
        {keepScreenOnSupported && (
          <button
            type="button"
            role="switch"
            aria-checked={keepScreenOn}
            onClick={() => onToggleKeepScreenOn(!keepScreenOn)}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 active:bg-zinc-800/70 transition-colors mb-8"
          >
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              keepScreenOn ? 'bg-amber-500/20' : 'bg-zinc-800/80'
            }`}>
              <Sun className={`w-4 h-4 ${keepScreenOn ? 'text-amber-300' : 'text-zinc-500'}`} />
            </span>
            <div className="flex-1 text-left min-w-0">
              <div className="text-[13px] font-medium text-zinc-200">Keep screen on</div>
              <div className="text-[11px] text-zinc-500">Prevents the display from dimming</div>
            </div>
            <span
              className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${
                keepScreenOn ? 'bg-amber-500/70' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  keepScreenOn ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </span>
          </button>
        )}

        {/* Open sessions */}
        {openSessions.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2 px-1">
              Open
            </h2>
            <div className="space-y-1.5">
              {openSessions.slice(0, 6).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectSession(s.id)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 active:bg-zinc-800/70 transition-colors text-left"
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] text-zinc-200 truncate">{s.name}</div>
                    <div className="text-[11px] text-zinc-500 font-mono truncate">{s.cwd}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent (closed) */}
        {recentClosed.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2 px-1">
              Recent
            </h2>
            <div className="space-y-1.5">
              {recentClosed.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onReopenSession(s.id)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/40 border border-zinc-800/60 active:bg-zinc-800/60 transition-colors text-left"
                >
                  <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] text-zinc-300 truncate">{s.name}</div>
                    <div className="text-[11px] text-zinc-600 font-mono truncate">{s.cwd}</div>
                  </div>
                  {s.created_at ? (
                    <span className="flex items-center gap-1 text-[10px] text-zinc-600 shrink-0">
                      <Clock className="w-3 h-3" />
                      {formatRelativeTime(s.created_at)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        )}

        {openSessions.length === 0 && recentClosed.length === 0 && (
          <div className="text-center text-zinc-600 text-[13px] py-8">
            No sessions yet. Tap <span className="text-zinc-400">New Session</span> to begin.
          </div>
        )}
      </div>
    </div>
  );
}
