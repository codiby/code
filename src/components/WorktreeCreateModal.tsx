import { X } from 'lucide-react';
import { Button } from '@heroui/react';
import type { ClaudeClient } from '../lib/claude-client';
import { WorktreeCreateForm } from './WorktreeCreateForm';

interface Props {
  open: boolean;
  /** Close the create dialog without spawning a session — returns the
   *  user to the parent worktree picker. */
  onClose: () => void;
  client: ClaudeClient;
  repoPath: string;
  hasEnv?: boolean;
  detectedPackageManager?: string;
  /** Existing worktrees of `repoPath` — forwarded so the "Existing branch"
   *  picker hides already-checked-out branches. */
  existingWorktrees?: { path: string; branch: string }[];
  /** Called once the worktree is created. Receives the absolute path. */
  onCreated: (path: string) => void;
}

/**
 * Stacked sub-modal opened from `WorktreeModal` when the user clicks
 * "+ New worktree". Just hosts the shared `WorktreeCreateForm` in a
 * dialog chrome — all branch / source / deps logic lives in the form
 * component, which is also embedded by `NewSessionModal`.
 */
export function WorktreeCreateModal({
  open, onClose, client, repoPath, hasEnv, detectedPackageManager, existingWorktrees, onCreated,
}: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-surface border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 520, maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-100">New Worktree</h2>
          <Button isIconOnly size="sm" variant="ghost" onPress={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </div>

        {/* Repo path */}
        <div className="px-5 py-2 border-b border-border shrink-0 text-[11px] text-zinc-500 font-mono truncate" title={repoPath}>
          {repoPath}
        </div>

        {/* Shared form */}
        <div className="px-5 py-4 overflow-y-auto">
          <WorktreeCreateForm
            client={client}
            repoPath={repoPath}
            hasEnv={hasEnv}
            detectedPackageManager={detectedPackageManager}
            existingWorktrees={existingWorktrees}
            hideExistingPicker
            onCreated={(path) => { onCreated(path); onClose(); }}
          />
        </div>
      </div>
    </div>
  );
}
