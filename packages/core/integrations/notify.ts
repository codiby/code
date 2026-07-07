/**
 * Notification abstraction.
 *
 * Currently only supports Telegram (which is the easiest channel because the
 * bridge server runs over plain HTTP on the LAN — Web Push would require
 * HTTPS + service worker + VAPID + iOS PWA install, all of which can be added
 * later behind this same `notify()` interface).
 *
 * `notify()` is fire-and-forget; failures are logged but never thrown. Callers
 * should not await the resolution if they're on a hot path.
 */

import { log } from '../lib/logger';
import { sendTelegramAlert, editTelegramMessage } from './telegram';
import { getLanIp, loadOrCreateMobileToken, PORT, resolveTls } from '../config/config';
import { sessions } from '../session/sessions';

export type NotifyEvent =
  | { type: 'permission_request'; requestId: string; sessionId: string; toolName: string; summary: string }
  | { type: 'turn_complete'; sessionId: string; preview: string }
  | { type: 'test'; message?: string };

// Throttle per (sessionId|type) to avoid notification storms when Claude
// rapidly emits multiple turn_complete events.
const lastSent = new Map<string, number>();
const THROTTLE_MS = 30_000;

function shouldThrottle(key: string): boolean {
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev < THROTTLE_MS) return true;
  lastSent.set(key, now);
  return false;
}

/** Build the deep link a notification recipient should tap to jump to the
 *  mobile UI for a specific session. */
function buildMobileLink(sessionId?: string): string {
  const ip = getLanIp();
  const token = loadOrCreateMobileToken();
  const scheme = resolveTls() ? 'https' : 'http';
  let url = `${scheme}://${ip}:${PORT}/m#t=${token}`;
  if (sessionId) url += `&s=${encodeURIComponent(sessionId)}`;
  return url;
}

function sessionLabel(sessionId: string): string {
  const s = sessions.get(sessionId);
  return s?.name || sessionId.slice(0, 8);
}

// Map of permission requestId → the Telegram message we sent for it, so we
// can edit it in place when the user responds. Capped at 200 entries to
// avoid unbounded growth (entries are removed when resolved or evicted FIFO).
type SentRef = {
  chatId: string | number;
  messageId: number;
  toolName: string;
  summary: string;
  sessionId: string;
};
const sentByRequestId = new Map<string, SentRef>();
const MAX_SENT_ENTRIES = 200;

function rememberSent(requestId: string, ref: SentRef) {
  if (sentByRequestId.size >= MAX_SENT_ENTRIES) {
    // Drop oldest entry (Map preserves insertion order)
    const firstKey = sentByRequestId.keys().next().value;
    if (firstKey) sentByRequestId.delete(firstKey);
  }
  sentByRequestId.set(requestId, ref);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export async function notify(evt: NotifyEvent): Promise<void> {
  try {
    if (evt.type === 'permission_request') {
      // No throttling for permission requests — every one needs its own
      // approve/deny bubble. Throttling would silently drop permissions
      // and leave Claude blocked with no way for the user to respond
      // from Telegram.
      const label = sessionLabel(evt.sessionId);
      const link = buildMobileLink(evt.sessionId);
      const summary = evt.summary || '';
      const text =
        `🔔 *Permission needed* — \`${evt.toolName}\`\n` +
        `Session: ${label}\n` +
        (summary ? `\n${truncate(summary, 800)}\n` : '') +
        `\nOpen: ${link}`;
      // Inline keyboard so the user can approve/deny right from Telegram.
      // The bot's callback_query handler resolves the same pendingDecisions
      // promise as the WS permission_response path.
      const keyboard = [[
        { text: '✅ Approve', callback_data: `pa:${evt.requestId}` },
        { text: '❌ Deny',    callback_data: `pd:${evt.requestId}` },
      ]];
      const sent = await sendTelegramAlert(text, { keyboard });
      if (sent) {
        rememberSent(evt.requestId, {
          chatId: sent.chatId,
          messageId: sent.messageId,
          toolName: evt.toolName,
          summary,
          sessionId: evt.sessionId,
        });
      }
      return;
    }

    if (evt.type === 'turn_complete') {
      if (shouldThrottle(`turn:${evt.sessionId}`)) return;
      const label = sessionLabel(evt.sessionId);
      const link = buildMobileLink(evt.sessionId);
      const preview = (evt.preview || '').trim();
      if (!preview) return; // nothing useful to send
      const text =
        `✅ *${label}* finished:\n\n` +
        `${truncate(preview, 800)}\n\n` +
        `Open: ${link}`;
      await sendTelegramAlert(text);
      return;
    }

    if (evt.type === 'test') {
      const link = buildMobileLink();
      const text = (evt.message || 'Test notification from Codiby Code') +
        `\n\nMobile URL: ${link}`;
      await sendTelegramAlert(text);
      return;
    }
  } catch (err) {
    log(`[notify] ${evt.type} delivery failed: ${err}`);
  }
}

/**
 * Edit the previously-sent permission-request Telegram message to reflect
 * the user's decision. Called from the WS permission_response handler so
 * the original "🔔 Permission needed" alert in Telegram becomes a static
 * "✅ Approved" / "❌ Denied" record once any client (desktop / mobile)
 * responds.
 *
 * Silently no-ops if no message was sent for this requestId (e.g. it was
 * auto-approved before any notification fired, throttled, or evicted).
 */
export async function notifyPermissionResolved(
  requestId: string,
  decision: { allow: boolean; reason?: string },
): Promise<void> {
  const ref = sentByRequestId.get(requestId);
  if (!ref) return;
  sentByRequestId.delete(requestId);
  try {
    const label = sessionLabel(ref.sessionId);
    const headLine = decision.allow
      ? `✅ *Approved* — \`${ref.toolName}\``
      : `❌ *Denied* — \`${ref.toolName}\``;
    const text =
      `${headLine}\n` +
      `Session: ${label}\n` +
      (ref.summary ? `\n${truncate(ref.summary, 800)}\n` : '') +
      (decision.reason ? `\n${truncate(decision.reason, 200)}` : '');
    await editTelegramMessage(ref.chatId, ref.messageId, text);
  } catch (err) {
    log(`[notify] failed to edit permission message: ${err}`);
  }
}
