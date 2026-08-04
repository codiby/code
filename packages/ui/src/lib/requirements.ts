/**
 * Wire types for the session Requirements panel + Loop mode.
 *
 * Mirrors `packages/core/requirements/*` and `packages/core/loop/*`. The
 * server is the only writer of `status` / `lastVerdict` / `state`; the panel
 * renders what it is told and asks the bridge for every mutation.
 */

export type RequirementState = 'draft' | 'locked' | 'waived' | 'tampered';
export type RequirementStatus = 'pending' | 'running' | 'passing' | 'failing';
export type RequirementKind = 'command' | 'visual';

export interface Requirement {
  id: string;
  sessionId: string;
  position: number;
  title: string;
  kind: RequirementKind;
  command: string | null;
  timeoutMs: number | null;
  judgePrompt: string | null;
  imagePath: string | null;
  captureBrowser: string | null;
  captureUrl: string | null;
  state: RequirementState;
  status: RequirementStatus;
  waiverReason: string | null;
  lastExitCode: number | null;
  lastOutput: string | null;
  lastVerdict: string | null;
  lastImagePath: string | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Server-side heuristic: a check that can never fail. */
  degenerateWarning?: string | null;
}

export interface RequirementProposal {
  id: string;
  sessionId: string;
  requirementId: string;
  action: 'edit' | 'delete' | 'waive';
  payload: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedAt: number | null;
}

export interface RequirementProgress {
  total: number;
  locked: number;
  draft: number;
  waived: number;
  tampered: number;
  passing: number;
  failing: number;
  pending: number;
  pendingProposals: number;
  complete: boolean;
}

export interface RequirementEvent {
  id: string;
  sessionId: string;
  requirementId: string | null;
  event: string;
  actor: 'agent' | 'user' | 'runner';
  detail: string | null;
  createdAt: number;
}

export interface RequirementsSnapshot {
  target: string | null;
  requirements: Requirement[];
  proposals: RequirementProposal[];
  progress: RequirementProgress;
}

export type LoopPhase = 'bootstrap' | 'looping' | 'paused' | 'done';
export type LoopPauseReason =
  | 'max_iterations' | 'max_cost' | 'max_runtime' | 'stalled' | 'awaiting_approval' | 'user';

export interface LoopState {
  phase: LoopPhase;
  iteration: number;
  maxIterations: number;
  startedAt: number;
  costUsd: number;
  pauseReason: LoopPauseReason | null;
  lastFailureKey: string | null;
  stallCount: number;
}

export const emptyProgress = (): RequirementProgress => ({
  total: 0, locked: 0, draft: 0, waived: 0, tampered: 0,
  passing: 0, failing: 0, pending: 0, pendingProposals: 0, complete: false,
});

export const LOOP_PAUSE_LABEL: Record<LoopPauseReason, string> = {
  max_iterations: 'llegó al tope de iteraciones',
  max_cost: 'llegó al tope de costo',
  max_runtime: 'llegó al tope de tiempo',
  stalled: 'los mismos requerimientos fallaron sin cambios en disco',
  awaiting_approval: 'no hay ningún requerimiento aprobado todavía',
  user: 'lo detuviste',
};

/** Human summary of the progress line, e.g. "2/4 passing · 1 borrador". */
export function progressLabel(progress: RequirementProgress): string {
  const parts = [`${progress.passing}/${progress.locked} passing`];
  if (progress.draft) parts.push(`${progress.draft} borrador${progress.draft === 1 ? '' : 'es'}`);
  if (progress.waived) parts.push(`${progress.waived} waived`);
  if (progress.tampered) parts.push(`${progress.tampered} alterado${progress.tampered === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
