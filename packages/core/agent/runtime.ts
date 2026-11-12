/**
 * Runtime dependencies wired from index.ts (sendMessageToSession etc.).
 * Kept in their own module so any area can reach them without importing
 * index.ts (which would be a cycle).
 */

import type { AgentDeps } from './types';

let deps: AgentDeps | null = null;

/**
 * When agent code — a channel's `/stop`, a denied approval — last stopped a
 * session's turn. The channel already answered that ("⏹ Stopped.", "❌
 * Denied"), so dispatch doesn't add an "interrupted" notice for the turn it
 * ended; a Stop pressed in the app goes through index.ts directly and does
 * get one.
 */
const requestedStops = new Map<string, number>();
const REQUESTED_STOP_TTL_MS = 60_000;

export function configureAgentRuntime(d: AgentDeps): void {
  deps = {
    ...d,
    interruptSession: (sessionId) => {
      requestedStops.set(sessionId, Date.now());
      return d.interruptSession(sessionId);
    },
  };
}

export function agentDeps(): AgentDeps {
  if (!deps) throw new Error('Agent runtime not configured — startAgent() has not run');
  return deps;
}

export function hasAgentDeps(): boolean {
  return deps !== null;
}

/** True (once) when agent code stopped `sessionId`'s turn within the last minute. */
export function consumeRequestedStop(sessionId: string, now = Date.now()): boolean {
  const at = requestedStops.get(sessionId);
  requestedStops.delete(sessionId);
  return at !== undefined && now - at <= REQUESTED_STOP_TTL_MS;
}

/** Tests only. */
export function _setAgentDepsForTest(d: AgentDeps | null): void {
  deps = d;
  requestedStops.clear();
}
