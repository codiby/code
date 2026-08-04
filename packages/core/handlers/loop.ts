/**
 * HTTP surface for Loop mode.
 *
 * Deliberately user-only: there is no MCP tool that starts a loop. Loop is
 * bypass permissions plus unattended auto-continuation, so arming it is a
 * decision the person has to make, not something the agent can talk itself
 * into mid-turn.
 */

import { corsHeaders } from '../config/config';
import { pauseLoop, resumeLoop, startLoop, stopLoop } from '../loop/driver';
import { progressFor } from '../requirements/repository';
import { loopConfig } from '../requirements/config';
import { saveSessions, sessions } from '../session/sessions';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });

function state(sessionId: string) {
  return {
    loop: sessions.get(sessionId)?.loopState ?? null,
    progress: progressFor(sessionId),
    config: loopConfig(sessionId),
  };
}

export function handleGetLoop(sessionId: string): Response {
  if (!sessions.has(sessionId)) return json({ error: 'Session not found' }, 404);
  return json(state(sessionId));
}

export function handleStartLoop(sessionId: string, broadcastSessionList: () => void): Response {
  const result = startLoop(sessionId);
  if (!result.ok) return json({ error: result.error }, 404);
  broadcastSessionList();
  return json(state(sessionId));
}

export function handlePauseLoop(sessionId: string): Response {
  if (!sessions.has(sessionId)) return json({ error: 'Session not found' }, 404);
  pauseLoop(sessionId, 'user');
  return json(state(sessionId));
}

export function handleResumeLoop(sessionId: string): Response {
  const result = resumeLoop(sessionId);
  if (!result.ok) return json({ error: result.error }, 409);
  return json(state(sessionId));
}

/**
 * Stop the loop and drop the session back to a mode where it can talk to the
 * user again. Leaving it in `loop` would keep AskUserQuestion auto-denied with
 * nothing driving the session forward.
 */
export function handleStopLoop(sessionId: string, broadcastSessionList: () => void): Response {
  const session = sessions.get(sessionId);
  if (!session) return json({ error: 'Session not found' }, 404);
  stopLoop(sessionId);
  if (session.permissionMode === 'loop') {
    session.permissionMode = 'bypassPermissions';
    saveSessions();
    broadcastSessionList();
  }
  return json(state(sessionId));
}
