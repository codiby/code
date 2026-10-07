/**
 * Undo toast for the ctrl/⌘-click shortcut on a session's ✕ button.
 *
 * That gesture skips the delete confirmation modal, so the safety net moved
 * here: the session is hidden from the tab list immediately but the purge only
 * fires once the window drains. Until then "Undo" puts the row back and nothing
 * ever reached the server.
 *
 * Sits bottom-left, near the sidebar row that just vanished.
 */

import { Trash2, Undo2, X } from 'lucide-react';

export interface PendingSessionDelete {
  id: string;
  name: string;
  /** True when the purge will also remove the session's git worktree. */
  worktree: boolean;
  /** Uncommitted files in that worktree; undefined while the git scan is in
   *  flight, which is why the warning line appears a beat late. */
  modifiedCount?: number;
  /** Length of the undo window, in ms — drives the drain bar's duration. */
  windowMs: number;
}

export function SessionDeleteToast({ items, onUndo, onDeleteNow }: {
  items: PendingSessionDelete[];
  onUndo: (id: string) => void;
  onDeleteNow: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-4 z-[9000] flex flex-col gap-2 pointer-events-none">
      {items.map(item => (
        <ToastRow key={item.id} item={item} onUndo={() => onUndo(item.id)} onDeleteNow={() => onDeleteNow(item.id)} />
      ))}
    </div>
  );
}

function ToastRow({ item, onUndo, onDeleteNow }: {
  item: PendingSessionDelete;
  onUndo: () => void;
  onDeleteNow: () => void;
}) {
  const dirty = item.worktree && !!item.modifiedCount;
  return (
    <div
      className="pointer-events-auto w-[320px] rounded-lg border border-border-light shadow-2xl bg-surface overflow-hidden"
      style={{ animation: 'undoToastIn 140ms ease-out', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="px-3 py-2 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-red-500/15 text-red-300">
          <Trash2 className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] font-semibold text-zinc-200 truncate">
            Deleted <span className="text-zinc-100">{item.name}</span>
          </div>
          <div className={`text-[10.5px] truncate ${dirty ? 'text-amber-400' : 'text-zinc-500'}`}>
            {dirty
              ? `Worktree too — ${item.modifiedCount} uncommitted ${item.modifiedCount === 1 ? 'change' : 'changes'}`
              : item.worktree ? 'Worktree will be removed too' : 'History will be removed'}
          </div>
        </div>
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium text-indigo-300 hover:text-indigo-200 hover:bg-surface-lighter transition-colors"
        >
          <Undo2 className="w-3 h-3" />
          Undo
        </button>
        <button
          type="button"
          onClick={onDeleteNow}
          aria-label="Delete now"
          title="Delete now"
          className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-zinc-600 hover:text-zinc-300 hover:bg-surface-lighter transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Time remaining. Pure CSS so the countdown doesn't re-render React. */}
      <div className="h-0.5 bg-surface-light">
        <div
          className={`h-full origin-left ${dirty ? 'bg-amber-500/70' : 'bg-indigo-500/70'}`}
          style={{ animation: `undoToastDrain ${item.windowMs}ms linear forwards` }}
        />
      </div>
    </div>
  );
}
