/**
 * Loop mode state.
 *
 *   bootstrap — requirements exist but none are approved yet; the loop is
 *               waiting on the user before it will drive anything.
 *   looping   — the driver re-prompts the agent after every turn until all
 *               approved requirements pass.
 *   paused    — a cap was hit or the run stalled. Resumable, not a failure.
 *   done      — every approved requirement passes.
 */
export type LoopPhase = 'bootstrap' | 'looping' | 'paused' | 'done';

export type LoopPauseReason =
  | 'max_iterations'
  | 'max_cost'
  | 'max_runtime'
  | 'stalled'
  | 'awaiting_approval'
  | 'user';

export type LoopState = {
  phase: LoopPhase;
  iteration: number;
  maxIterations: number;
  startedAt: number;
  costUsd: number;
  pauseReason: LoopPauseReason | null;
  /** Fingerprint of the last failing set + workspace, for stall detection. */
  lastFailureKey: string | null;
  stallCount: number;
};

export function emptyLoopState(maxIterations: number): LoopState {
  return {
    phase: 'bootstrap',
    iteration: 0,
    maxIterations,
    startedAt: Date.now(),
    costUsd: 0,
    pauseReason: null,
    lastFailureKey: null,
    stallCount: 0,
  };
}

/** User-facing copy: these land in the chat as system notes. */
export const LOOP_PAUSE_MESSAGES: Record<LoopPauseReason, string> = {
  max_iterations: 'Loop paused: hit the iteration limit.',
  max_cost: 'Loop paused: hit the cost limit.',
  max_runtime: 'Loop paused: hit the time limit.',
  stalled: 'Loop paused: the same requirements kept failing with no changes on disk. It needs your input.',
  awaiting_approval: 'Loop waiting: no requirement has been approved yet.',
  user: 'Loop stopped.',
};
