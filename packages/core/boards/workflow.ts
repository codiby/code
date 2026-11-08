import type { WorkflowMode } from './types';

type Move = { fromStatusId: string | null; toStatusId: string };

/**
 * Whether a session may go from one status to another.
 *
 * Kept pure so the UI can call the same rule to grey out unreachable columns
 * while dragging. Staying in place is a reorder, never a transition.
 */
export function canMove(mode: WorkflowMode, transitions: Move[], from: string, to: string): boolean {
  if (from === to || mode === 'free') return true;
  return transitions.some(t => t.toStatusId === to && (t.fromStatusId === null || t.fromStatusId === from));
}
