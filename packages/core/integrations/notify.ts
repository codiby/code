/**
 * Owner alerts for coding sessions (not the agent itself): "<session>
 * finished" and the Settings test message. They go through the agent's
 * outbox, so they reach the owner on whichever channel does — Telegram,
 * WhatsApp, a webhook callback — instead of Telegram only.
 *
 * Permission requests are no longer sent from here: the agent's policy area
 * fans every pending approval out to the owner's channels (with buttons or
 * codes) and settles those messages itself. `notify()` is fire-and-forget;
 * failures are logged, never thrown.
 */

import { log } from '../lib/logger';
import { getLanIp, loadOrCreateMobileToken, PORT, resolveTls } from '../config/config';
import { sessions } from '../session/sessions';
import { getChannelAlerts } from '../agent/channels/config';
import { sendToOwner } from '../agent/outbox';

export type NotifyEvent =
  | { type: 'permission_request'; requestId: string; sessionId: string; toolName: string; summary: string }
  | { type: 'turn_complete'; sessionId: string; preview: string }
  | { type: 'test'; message?: string };

// One "finished" alert per session per 30 s: a session that runs many short
// turns back to back would otherwise flood the owner's phone.
const lastSent = new Map<string, number>();
const THROTTLE_MS = 30_000;

function shouldThrottle(key: string, now = Date.now()): boolean {
  const prev = lastSent.get(key);
  if (prev && now - prev < THROTTLE_MS) return true;
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.delete(lastSent.keys().next().value!);
  return false;
}

/** Deep link into the mobile UI for a session. */
function buildMobileLink(sessionId?: string): string {
  const scheme = resolveTls() ? 'https' : 'http';
  let url = `${scheme}://${getLanIp()}:${PORT}/m#t=${loadOrCreateMobileToken()}`;
  if (sessionId) url += `&s=${encodeURIComponent(sessionId)}`;
  return url;
}

function sessionLabel(sessionId: string): string {
  return sessions.get(sessionId)?.name || sessionId.slice(0, 8);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The text sent for a turn_complete alert (exported for tests). */
export function turnCompleteText(label: string, preview: string, link: string): string {
  return `✅ *${label}* finished:\n\n${truncate(preview, 800)}\n\nOpen: ${link}`;
}

export async function notify(evt: NotifyEvent): Promise<void> {
  try {
    if (evt.type === 'permission_request') return;

    if (evt.type === 'turn_complete') {
      const preview = (evt.preview || '').trim();
      if (!preview || !getChannelAlerts().sessionFinished) return;
      if (shouldThrottle(`turn:${evt.sessionId}`)) return;
      const text = turnCompleteText(sessionLabel(evt.sessionId), preview, buildMobileLink(evt.sessionId));
      const res = await sendToOwner({ kind: 'text', text, priority: 'low' });
      if (!res.ok) log(`[notify] turn_complete not delivered: ${res.error}`);
      return;
    }

    if (evt.type === 'test') {
      const text = `${evt.message || 'Test notification from Codiby Code'}\n\nMobile URL: ${buildMobileLink()}`;
      const res = await sendToOwner({ kind: 'text', text, priority: 'normal' });
      if (!res.ok) log(`[notify] test not delivered: ${res.error}`);
    }
  } catch (err) {
    log(`[notify] ${evt.type} delivery failed: ${err}`);
  }
}

/**
 * Kept for the WS permission_response handler. Approval messages on channels
 * are settled by the channels themselves (onApproval → onResolved), so there
 * is nothing left to edit here.
 */
export async function notifyPermissionResolved(
  _requestId: string,
  _decision: { allow: boolean; reason?: string },
): Promise<void> {}
