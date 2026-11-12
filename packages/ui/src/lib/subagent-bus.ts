/**
 * Live sub-agent text/thinking (`subagent_message` frames). They never enter
 * the chat's message list — the Agents panel and window subscribe here.
 */

import type { ChatMessage } from './claude-client';

type Listener = (sessionId: string, message: ChatMessage) => void;

const listeners = new Set<Listener>();

export function publishSubagentMessage(sessionId: string, message: ChatMessage): void {
  for (const fn of listeners) {
    try { fn(sessionId, message); } catch {}
  }
}

export function onSubagentMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
