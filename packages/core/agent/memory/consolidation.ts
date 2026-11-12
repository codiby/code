/**
 * Consolidation: before the agent's thread is rotated (`/new`, the daily
 * fresh start, the Agent view's button), the agent gets one turn to save
 * what it learned, because the next thread starts with an empty context.
 *
 * Runs as an `onBeforeThreadRotate` hook, so rotation waits for it — but never
 * longer than the timeout: a stuck turn must not keep `/new` from working.
 */

import { log, logError } from '../../lib/logger';
import { getLastActivityAt, getSessionState, isSubagentChatter, type ChatMessage } from '../../session/state';
import { onAgentTurnComplete } from '../registry';
import { agentDeps, hasAgentDeps } from '../runtime';
import { AGENT_SESSION_ID, getAgentSession } from '../session';
import { countMemoryChangesSince } from './memories';
import { countPeopleChangesSince } from './people';
import { loadMemorySettings, memoryStateStore, type ConsolidationOutcome } from './settings';

export const CONSOLIDATION_TIMEOUT_MS = 120_000;
/** How often a pending wait checks whether the turn died without completing. */
const LIVENESS_POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Waiting for the agent's turn
// ---------------------------------------------------------------------------

const turnWaiters = new Set<(failure: string | undefined) => void>();

// One permanent listener fans out to whoever waits.
onAgentTurnComplete((sessionId, delivered) => {
  if (sessionId !== AGENT_SESSION_ID) return;
  for (const resolve of [...turnWaiters]) resolve(delivered?.failure);
});

export type TurnWait = 'completed' | 'timeout' | 'failed';

/** Waiters still registered (tests check none is left behind). */
export function _pendingTurnWaitersForTest(): number {
  return turnWaiters.size;
}

/**
 * Resolves on the agent's next turn completion. Register before sending the
 * message, or a fast turn could finish before anyone listens. `failed` when
 * the turn completed with a failure (dispatch's provider error, a stop), or
 * when the provider errored or exited mid-turn (the bridge flags
 * `wasInterrupted` and no completion will ever come). `failedTurn` overrides
 * what a completed-but-failed turn resolves to.
 */
export function waitForAgentTurn(timeoutMs: number, opts: { failedTurn?: TurnWait } = {}): { promise: Promise<TurnWait>; cancel(): void } {
  let settle: (r: TurnWait) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const onTurn = (failure: string | undefined) => settle(failure ? (opts.failedTurn ?? 'failed') : 'completed');
  const promise = new Promise<TurnWait>(resolve => {
    settle = (r: TurnWait) => {
      turnWaiters.delete(onTurn);
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve(r);
    };
  });
  turnWaiters.add(onTurn);
  timer = setTimeout(() => settle('timeout'), Math.max(0, timeoutMs));
  poll = setInterval(() => {
    const s = getSessionState(AGENT_SESSION_ID);
    if (s.wasInterrupted && !s.isStreaming) settle('failed');
  }, LIVENESS_POLL_MS);
  return { promise, cancel: () => settle('failed') };
}

// ---------------------------------------------------------------------------
// What counts as "something to consolidate"
// ---------------------------------------------------------------------------

function isConversation(m: ChatMessage): boolean {
  return (m.role === 'user' || m.role === 'assistant') && !isSubagentChatter(m) && !m.parentToolUseId && !!m.content?.trim();
}

/**
 * True when the current thread holds conversation newer than `since` (the
 * last rotation). A thread with no provider conversation at all is already
 * fresh, whatever the visible transcript shows.
 */
export function hasConversationSince(since: number | null): boolean {
  const session = getAgentSession();
  if (!session || (!session.claudeSessionId && !session.providerSession)) return false;
  const msgs = getSessionState(AGENT_SESSION_ID).messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (since !== null && m.timestamp <= since) break;
    if (isConversation(m)) return true;
  }
  return false;
}

/** Last sign of life in the agent session: a message, a tool call, or a user send. */
export function lastAgentActivityAt(): number {
  const msgs = getSessionState(AGENT_SESSION_ID).messages;
  let last = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'system') continue;
    last = m.timestamp;
    break;
  }
  return Math.max(last, getLastActivityAt(AGENT_SESSION_ID) ?? 0, getAgentSession()?.lastUserMessageAt ?? 0);
}

// ---------------------------------------------------------------------------
// The consolidation turn
// ---------------------------------------------------------------------------

export function consolidationPrompt(reason: string): string {
  return [
    `[Memory · before a fresh thread — ${reason}]`,
    'This conversation is about to be archived and your next one starts with an empty context. Before that, save anything durable you learned in it that is not saved yet:',
    '- core facts about who the owner is → update_profile',
    '- preferences, facts, tasks, useful context → remember (one short fact per call)',
    '- people the owner mentioned (names, nicknames, relation, numbers) → people_upsert',
    'Skip small talk, one-off details and anything already in memory. Never save passwords or other secrets. Don\'t message anyone.',
    'When you are done, reply with exactly NO_REPLY.',
  ].join('\n');
}

let inFlight: Promise<ConsolidationOutcome> | null = null;

export function isConsolidating(): boolean {
  return inFlight !== null;
}

/** The consolidation turn in progress, if any (inbound messages wait for it). */
export function currentConsolidation(): Promise<ConsolidationOutcome> | null {
  return inFlight;
}

/**
 * Give the agent its consolidation turn and record the outcome. Concurrent
 * rotations (a `/new` while the daily one runs) share a single turn.
 */
export function consolidateBeforeRotate(reason: string, opts: { timeoutMs?: number } = {}): Promise<ConsolidationOutcome> {
  if (inFlight) return inFlight;
  inFlight = run(reason, opts.timeoutMs ?? CONSOLIDATION_TIMEOUT_MS).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(reason: string, timeoutMs: number): Promise<ConsolidationOutcome> {
  const startedAt = Date.now();
  let outcome: ConsolidationOutcome;
  try {
    outcome = await consolidate(reason, startedAt + timeoutMs);
  } catch (err) {
    logError(`[agent:memory] consolidation failed: ${err instanceof Error ? err.message : err}`);
    outcome = 'failed';
  }
  const saved = outcome === 'done' || outcome === 'timeout' ? countMemoryChangesSince(startedAt) + countPeopleChangesSince(startedAt) : 0;
  memoryStateStore.update(s => ({
    ...s,
    // Stamped after the turn, so the consolidation exchange itself never counts as "new" next time.
    lastRotatedAt: Date.now(),
    lastConsolidation: { at: startedAt, reason, outcome, saved },
  }));
  log(`[agent:memory] consolidation before "${reason}": ${outcome}${saved ? ` (${saved} saved)` : ''}`);
  return outcome;
}

async function consolidate(reason: string, deadline: number): Promise<ConsolidationOutcome> {
  if (!loadMemorySettings().consolidateOnRotate) return 'disabled';
  if (!hasAgentDeps()) return 'unavailable';
  if (!hasConversationSince(memoryStateStore.get().lastRotatedAt)) return 'nothing_new';

  // A turn already running (the owner's last message): let it finish first, so
  // our completion isn't confused with its completion. Ending in a failure
  // or a stop still ends it.
  if (getSessionState(AGENT_SESSION_ID).isStreaming) {
    const prior = await waitForAgentTurn(deadline - Date.now(), { failedTurn: 'completed' }).promise;
    if (prior !== 'completed') return prior;
  }

  // From here every exit settles the waiter, so no timer or liveness poll
  // outlives a send that threw or was refused.
  const turn = waitForAgentTurn(deadline - Date.now());
  let res: { ok: boolean; error?: string };
  try {
    res = await agentDeps().sendMessage(AGENT_SESSION_ID, consolidationPrompt(reason));
  } catch (err) {
    turn.cancel();
    logError(`[agent:memory] could not ask the agent to consolidate: ${err instanceof Error ? err.message : err}`);
    return 'failed';
  }
  if (!res.ok) {
    turn.cancel();
    logError(`[agent:memory] could not ask the agent to consolidate: ${res.error ?? 'unknown error'}`);
    return 'failed';
  }
  const result = await turn.promise;
  return result === 'completed' ? 'done' : result;
}
