/** Idle shutdown: a running session whose provider has seen no message and no
 *  tool call for `IDLE_SHUTDOWN_MS` gets its provider closed. The session stays
 *  open in the sidebar as `stopped`; selecting it or sending a message resumes
 *  the same conversation.
 *
 *  "Activity" is the in-memory clock in `state.ts`, bumped by every
 *  `addMessage` (tool calls and results included) and by every provider
 *  start, so a fresh resume never looks stale.
 *
 *  Pure: the IO (closing the provider, broadcast, timer) lives in `index.ts`.
 */

export const IDLE_SHUTDOWN_MS = 60 * 60_000;

type Candidate = { id: string; running: boolean; busy: boolean; lastActivityAt: number };

/** Ids of running sessions idle for at least `ttlMs`. A session mid-turn is
 *  skipped: a long tool run or a pending permission prompt adds no message
 *  until it ends, and shutting it down would kill live work. */
export function idleSessions(list: Iterable<Candidate>, now: number, ttlMs = IDLE_SHUTDOWN_MS): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (!s.running || s.busy) continue;
    if (now - s.lastActivityAt >= ttlMs) out.push(s.id);
  }
  return out;
}
