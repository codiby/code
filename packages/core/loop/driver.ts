/**
 * Loop driver — the thing that makes a session unable to stop itself.
 *
 * Hooks `onTurnComplete`. When the session is in `loop` permission mode, every
 * finished turn runs the requirement checks server-side; if anything approved
 * is still failing, it injects a continuation prompt and the agent gets
 * another turn. An agent that ends with "done, tell me if you want more" is
 * simply handed the failing list and started again.
 *
 * Loop mode is bypass-equivalent on permissions and auto-continues without
 * supervision, so the caps below are load-bearing: iterations, cost, wall
 * clock, and a stall detector for the case where it keeps failing the same way
 * without touching a file.
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { log } from '../lib/logger';
import type { TurnCompleteInfo } from '../provider/types';
import { loopConfig } from '../requirements/config';
import { progressFor, snapshotFor } from '../requirements/repository';
import { broadcastRequirements, runRequirements } from '../requirements/runner';
import { addMessage } from '../session/state';
import type { ChatMessage } from '../session/state';
import { saveSessions, sessions } from '../session/sessions';
import { emptyLoopState, LOOP_PAUSE_MESSAGES, type LoopPauseReason, type LoopState } from './types';

type LoopDeps = {
  sendMessage: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  broadcastToSession: (sessionId: string, msg: object) => void;
  broadcastSessionList: () => void;
};

let deps: LoopDeps | null = null;

export function configureLoopDriver(next: LoopDeps): void {
  deps = next;
}

/** Sessions whose post-turn evaluation is in flight — guards re-entrancy. */
const evaluating = new Set<string>();

function broadcastLoop(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  deps?.broadcastToSession(sessionId, {
    type: 'loop',
    sessionId,
    loop: session.loopState ?? null,
    progress: progressFor(sessionId),
  });
}

function systemNote(sessionId: string, content: string): void {
  const msg: ChatMessage = { id: randomUUID(), role: 'system', content, timestamp: Date.now() };
  if (addMessage(sessionId, msg)) {
    deps?.broadcastToSession(sessionId, { type: 'message', sessionId, message: msg });
  }
}

function setState(sessionId: string, patch: Partial<LoopState>): LoopState | null {
  const session = sessions.get(sessionId);
  if (!session?.loopState) return null;
  session.loopState = { ...session.loopState, ...patch };
  saveSessions();
  broadcastLoop(sessionId);
  return session.loopState;
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export function startLoop(sessionId: string): { ok: true; loop: LoopState } | { ok: false; error: string } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  const config = loopConfig(sessionId);
  const progress = progressFor(sessionId);
  const state = emptyLoopState(config.maxIterations);
  state.phase = progress.locked > 0 ? 'looping' : 'bootstrap';
  if (state.phase === 'bootstrap') state.pauseReason = 'awaiting_approval';

  session.loopState = state;
  session.permissionMode = 'loop';
  saveSessions();
  deps?.broadcastSessionList();
  broadcastLoop(sessionId);

  systemNote(sessionId, state.phase === 'looping'
    ? `🔁 Loop iniciado — ${progress.locked} requerimiento(s) aprobado(s). La sesión seguirá corriendo hasta que todos pasen o la detengas.`
    : '🔁 Loop armado — esperando que apruebes al menos un requerimiento antes de arrancar.');

  log(`[loop:${sessionId.slice(0, 8)}] started (${state.phase})`);
  return { ok: true, loop: state };
}

export function pauseLoop(sessionId: string, reason: LoopPauseReason = 'user'): LoopState | null {
  const state = setState(sessionId, { phase: 'paused', pauseReason: reason });
  if (state) systemNote(sessionId, `🔁 ${LOOP_PAUSE_MESSAGES[reason]}`);
  return state;
}

export function resumeLoop(sessionId: string): { ok: true; loop: LoopState } | { ok: false; error: string } {
  const session = sessions.get(sessionId);
  if (!session?.loopState) return { ok: false, error: 'Session has no loop to resume' };

  const progress = progressFor(sessionId);
  if (progress.locked === 0) {
    const state = setState(sessionId, { phase: 'bootstrap', pauseReason: 'awaiting_approval' })!;
    return { ok: true, loop: state };
  }
  // Give the resumed run a fresh budget — the caps exist to bound unattended
  // work between check-ins, and the user just checked in.
  const config = loopConfig(sessionId);
  const state = setState(sessionId, {
    phase: 'looping',
    pauseReason: null,
    iteration: 0,
    maxIterations: config.maxIterations,
    startedAt: Date.now(),
    costUsd: 0,
    stallCount: 0,
    lastFailureKey: null,
  })!;
  systemNote(sessionId, '🔁 Loop reanudado.');
  void continueLoop(sessionId);
  return { ok: true, loop: state };
}

/**
 * End the loop outright and clear its state, which is what makes the banner
 * go away. Distinct from `pauseLoop`: a pause is the system saying "I hit a
 * cap, resume me when you've looked"; a stop is the user saying "done".
 */
export function stopLoop(sessionId: string): LoopState | null {
  const session = sessions.get(sessionId);
  if (!session?.loopState) return null;
  session.loopState = null;
  saveSessions();
  broadcastLoop(sessionId);
  systemNote(sessionId, '🔁 Loop detenido.');
  log(`[loop:${sessionId.slice(0, 8)}] stopped by user`);
  return null;
}

export function isLooping(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session?.permissionMode === 'loop'
    && (session.loopState?.phase === 'looping' || session.loopState?.phase === 'bootstrap');
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

/**
 * Fingerprint of "nothing moved": the set of failing requirement ids plus the
 * state of the working tree. Same fingerprint N turns in a row means the agent
 * is spinning, and no amount of extra iterations will help.
 */
async function failureFingerprint(sessionId: string, failingIds: string[]): Promise<string> {
  const session = sessions.get(sessionId);
  let workspace = '';
  if (session?.cwd) {
    try {
      const proc = Bun.spawn(['git', 'status', '--porcelain', '-uall'], {
        cwd: session.cwd,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      workspace = out;
      const head = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: session.cwd, stdout: 'pipe', stderr: 'ignore' });
      const [sha] = await Promise.all([new Response(head.stdout).text(), head.exited]);
      workspace += sha;
    } catch {
      // Not a git repo (or git is missing) — fall back to the failing set alone.
    }
  }
  return createHash('sha256').update([...failingIds].sort().join(',') + workspace).digest('hex');
}

// ---------------------------------------------------------------------------
// The loop itself
// ---------------------------------------------------------------------------

const CONTINUATION_FOOTER = [
  '',
  'Keep working. Do not ask for confirmation and do not stop to summarise:',
  'decide and act. This turn will be re-injected until every approved',
  'requirement passes or the user stops the session.',
].join('\n');

/**
 * Called after every completed turn. Runs the checks, then either finishes,
 * pauses on a cap, or re-prompts the agent with what is still failing.
 */
export async function onLoopTurnComplete(sessionId: string, info: TurnCompleteInfo): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.permissionMode !== 'loop' || !session.loopState) return;
  if (session.loopState.phase === 'paused' || session.loopState.phase === 'done') return;
  if (evaluating.has(sessionId)) return;

  evaluating.add(sessionId);
  try {
    if (info.costUsd) {
      setState(sessionId, { costUsd: (session.loopState.costUsd ?? 0) + info.costUsd });
    }
    await continueLoop(sessionId);
  } catch (error) {
    log(`[loop:${sessionId.slice(0, 8)}] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    evaluating.delete(sessionId);
  }
}

async function continueLoop(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session?.loopState || !deps) return;

  const config = loopConfig(sessionId);
  const before = progressFor(sessionId);

  // Nothing approved yet — the loop refuses to drive against an empty or
  // unapproved list. That is the whole point: the bar has to be set by the
  // user before the agent is held to it.
  if (before.locked === 0) {
    const state = setState(sessionId, { phase: 'bootstrap', pauseReason: 'awaiting_approval' });
    if (state && before.total === 0) {
      systemNote(sessionId, '🔁 Loop en espera — todavía no hay requerimientos. Pídele al agente que los defina y aprueba los que cuentan.');
    } else if (state) {
      systemNote(sessionId, `🔁 Loop en espera — ${before.draft} requerimiento(s) en borrador esperando tu aprobación.`);
    }
    return;
  }

  if (session.loopState.phase === 'bootstrap') {
    setState(sessionId, { phase: 'looping', pauseReason: null });
  }

  await runRequirements(sessionId);
  broadcastRequirements(sessionId);

  const snapshot = snapshotFor(sessionId);
  const progress = snapshot.progress;

  if (progress.complete) {
    setState(sessionId, { phase: 'done', pauseReason: null });
    systemNote(sessionId, `✅ Loop completo — ${progress.passing}/${progress.locked} requerimientos passing.`);
    log(`[loop:${sessionId.slice(0, 8)}] complete after ${session.loopState.iteration} iteration(s)`);
    return;
  }

  const failing = snapshot.requirements.filter(r => r.state === 'locked' && r.status !== 'passing');
  const fingerprint = await failureFingerprint(sessionId, failing.map(r => r.id));
  const stalled = fingerprint === session.loopState.lastFailureKey;
  const stallCount = stalled ? session.loopState.stallCount + 1 : 0;
  setState(sessionId, { lastFailureKey: fingerprint, stallCount });

  const capped = capReached(sessionId, config, stallCount);
  if (capped) {
    pauseLoop(sessionId, capped);
    log(`[loop:${sessionId.slice(0, 8)}] paused (${capped})`);
    return;
  }

  const iteration = session.loopState.iteration + 1;
  setState(sessionId, { iteration });

  const lines = failing.map(r => {
    const head = `✗ [${r.id}] ${r.title}`;
    if (r.kind === 'command') {
      const detail = (r.lastVerdict || r.lastOutput || '').trim();
      const cmd = `${r.command} (exit ${r.lastExitCode ?? '—'})`;
      return detail ? `${head} — ${cmd}\n${detail.split('\n').map(l => `    ${l}`).join('\n')}` : `${head} — ${cmd}`;
    }
    return `${head} — visual: ${r.lastVerdict ?? 'no verdict'}`;
  });

  const prompt = [
    `[loop] Iteration ${iteration}/${config.maxIterations} · ${progress.failing + progress.pending} of ${progress.locked} requirements still failing:`,
    '',
    ...lines,
    CONTINUATION_FOOTER,
  ].join('\n');

  const sent = await deps.sendMessage(sessionId, prompt);
  if (!sent.ok) {
    pauseLoop(sessionId, 'user');
    systemNote(sessionId, `🔁 Loop no pudo continuar: ${sent.error ?? 'falló el envío del prompt de continuación'}.`);
  }
}

function capReached(
  sessionId: string,
  config: ReturnType<typeof loopConfig>,
  stallCount: number,
): LoopPauseReason | null {
  const state = sessions.get(sessionId)?.loopState;
  if (!state) return null;
  if (stallCount >= config.stallThreshold) return 'stalled';
  if (state.iteration + 1 > config.maxIterations) return 'max_iterations';
  if (state.costUsd >= config.maxCostUsd) return 'max_cost';
  if (Date.now() - state.startedAt >= config.maxRuntimeMs) return 'max_runtime';
  return null;
}
