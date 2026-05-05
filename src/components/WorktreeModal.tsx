import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';
import { WorktreeCreateModal } from './WorktreeCreateModal';

interface Props {
  open: boolean;
  onClose: () => void;
  client: ClaudeClient;
  /** Absolute path of the git top-level — the worktree's parent repo. */
  repoPath: string;
  /** Whether the repo has a `.env` file at its top-level (forwarded to
   *  the create sub-modal so it can prefill its copy-env checkbox). */
  hasEnv?: boolean;
  /** Detected package manager (forwarded to the create sub-modal). */
  detectedPackageManager?: string;
  /** Pre-existing worktrees of `repoPath`, surfaced as a clickable list
   *  so the user can spawn a session in one without creating a new
   *  branch. The main repo entry (matching `repoPath`) is filtered out
   *  since the host already exposes that as "New session in group". */
  worktrees?: { path: string; branch: string }[];
  /** Called once a worktree is ready — either picked from the existing
   *  list or freshly created via the sub-modal. Receives the absolute
   *  path so the caller can spawn a session there. */
  onCreated: (path: string) => void;
}

/**
 * Desktop worktree picker. Lets the user click an existing worktree to
 * reuse it, or open a stacked `WorktreeCreateModal` to make a new one.
 * The full-screen mobile variant lives in
 * `mobile/MobileWorktreeModal.tsx`.
 */
export function WorktreeModal({
  open, onClose, client, repoPath, hasEnv, detectedPackageManager, worktrees, onCreated,
}: Props) {
  const [worktreeFilter, setWorktreeFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWorktreeFilter('');
    setShowCreateModal(false);
  }, [open]);

  // Strip the main worktree (the repo root itself) from the picker —
  // selecting it would just reopen the same cwd that "New session in
  // group" already targets.
  const existingWorktrees = useMemo(() => {
    if (!worktrees || worktrees.length === 0) return [];
    return worktrees.filter(wt => wt.path !== repoPath);
  }, [worktrees, repoPath]);

  const filteredWorktrees = useMemo(() => {
    const q = worktreeFilter.trim().toLowerCase();
    if (!q) return existingWorktrees;
    return existingWorktrees.filter(wt =>
      wt.branch.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q)
    );
  }, [existingWorktrees, worktreeFilter]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden"
          style={{ width: 560, maxHeight: '85vh' }}
        >
          {/* Header */}
          <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
            <h2 className="text-sm font-semibold text-zinc-100">Worktree</h2>
            <button className="text-zinc-500 hover:text-zinc-300" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          {/* Repo path */}
          <div className="px-5 py-2 border-b border-border shrink-0 text-[11px] text-zinc-500 font-mono truncate" title={repoPath}>
            {repoPath}
          </div>

          {/* Existing worktrees */}
          {existingWorktrees.length > 0 && (
            <div className="shrink-0 border-b border-border">
              <div className="flex items-center gap-2 px-5 py-1.5 border-b border-border/50">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold shrink-0">Existing worktrees</span>
                <input
                  type="text"
                  value={worktreeFilter}
                  onChange={(e) => setWorktreeFilter(e.target.value)}
                  placeholder="filter…"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[11px] text-zinc-200 placeholder:text-zinc-600 font-mono focus:outline-none focus:border-indigo-500/40"
                />
                <span className="text-[10px] text-zinc-600 shrink-0 tabular-nums">
                  {worktreeFilter ? `${filteredWorktrees.length}/${existingWorktrees.length}` : existingWorktrees.length}
                </span>
              </div>
              <div className="max-h-[28vh] overflow-y-auto py-1">
                {filteredWorktrees.length === 0 ? (
                  <div className="px-5 py-3 text-[11px] text-zinc-600 text-center">No worktrees match.</div>
                ) : filteredWorktrees.map(wt => (
                  <button key={wt.path}
                    className="flex items-center gap-2 w-full text-left text-[12px] px-5 py-1.5 text-zinc-400 hover:bg-surface-light/50 hover:text-zinc-200 transition-colors"
                    onClick={() => { onCreated(wt.path); onClose(); }}
                    title={wt.path}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                    <span className="text-green-400 font-mono shrink-0">{wt.branch}</span>
                    <span className="text-zinc-600 font-mono truncate">{wt.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Footer — open the create sub-modal or dismiss */}
          <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2 shrink-0">
            <button
              className="text-xs text-zinc-400 hover:text-zinc-100 bg-surface-light hover:bg-surface-lighter rounded px-2.5 py-1 transition-colors"
              onClick={() => setShowCreateModal(true)}
            >+ New worktree</button>
            <Button size="sm" variant="ghost" onPress={onClose}>Cancel</Button>
          </div>
        </div>
      </div>

      <WorktreeCreateModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        client={client}
        repoPath={repoPath}
        hasEnv={hasEnv}
        detectedPackageManager={detectedPackageManager}
        onCreated={(path) => {
          // Bubble up and dismiss both modals.
          setShowCreateModal(false);
          onCreated(path);
          onClose();
        }}
      />
    </>
  );
}
