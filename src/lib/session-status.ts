// Single source of truth for session "statuses" used by the sidebar's grouped
// views (TabBar) and the titlebar status picker (ChatApp).
//
// Statuses are configurable per project (persisted in <root>/.codiby/settings.json);
// when a project defines none, DEFAULT_STATUSES is used. A session's status is
// normally derived from its live runtime signals, but a manual override (set by
// dragging a card into a status, or via the pickers) takes precedence and is
// persisted server-side (see /session-status).
import { Bell, CheckCircle2, Circle, Eye, Loader, type LucideIcon } from 'lucide-react';
import type { ConnectionStatus } from './claude-client';

export interface StatusDef { id: string; label: string; color: string }

// The built-in statuses every project starts with.
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'needs',   label: 'Needs Attention', color: '#fbbf24' },
  { id: 'working', label: 'Working',         color: '#34d399' },
  { id: 'review',  label: 'Review',          color: '#38bdf8' },
  { id: 'done',    label: 'Done',            color: '#71717a' },
];

// Icons for the built-in status ids; custom statuses render a plain color dot.
export const STATUS_ICON: Record<string, LucideIcon> = {
  needs: Bell, working: Loader, review: Eye, done: CheckCircle2,
};

// A small palette for new/custom statuses.
export const STATUS_COLORS = ['#fbbf24', '#34d399', '#38bdf8', '#818cf8', '#f472b6', '#fb7185', '#a78bfa', '#2dd4bf', '#71717a'];

export interface LaneSignals {
  hasPermission: Record<string, boolean>;
  streaming: Record<string, boolean>;
  interrupted: Record<string, boolean>;
  statuses: Record<string, ConnectionStatus>;
  turnComplete: Set<string>;
}

/** Runtime-derived status, expressed as one of the default ids. Review is the
 *  "finished a turn, awaiting your review" bucket; everything in-progress is
 *  Working; Done is reached only by manual assignment. */
export function deriveKind(id: string, sig: LaneSignals): string {
  if (sig.hasPermission[id] || sig.interrupted[id] || sig.statuses[id] === 'error') return 'needs';
  if (sig.streaming[id]) return 'working';
  if (sig.turnComplete.has(id)) return 'review';
  return 'working';
}

/** Resolve a session's status id against a given status set: a manual override
 *  wins (when it still exists in the set), else the derived kind (when present),
 *  else the first status. */
export function resolveStatus(id: string, manual: Record<string, string> | undefined, sig: LaneSignals, statuses: StatusDef[]): string {
  const ids = new Set(statuses.map(s => s.id));
  const m = manual?.[id];
  if (m && ids.has(m)) return m;
  const kind = deriveKind(id, sig);
  if (ids.has(kind)) return kind;
  return statuses[0]?.id ?? 'working';
}

export function statusById(statuses: StatusDef[], id: string): StatusDef | undefined {
  return statuses.find(s => s.id === id);
}

// Collapse a worktree cwd back to its main repo. Worktrees live at
// `<repo>/.wt/<branch>`, so a session inside one belongs to the repo.
export function projectRootOf(cwd: string): string {
  if (!cwd) return '';
  const idx = cwd.indexOf('/.wt/');
  return idx >= 0 ? cwd.slice(0, idx) : cwd;
}

// Re-export Circle so consumers can render the "Automatic" affordance.
export { Circle };
