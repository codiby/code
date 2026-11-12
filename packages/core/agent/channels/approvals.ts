/**
 * Approvals on channels without buttons. The policy area fans each pending
 * request out with a short code; the owner answers in plain text — "SI 4821",
 * "sí 4821", "yes 4821", "ok 4821", "no 4821" — and this interceptor turns
 * the answer into `answerApproval` before the agent ever sees the text.
 */

import { addInboundInterceptor, answerApproval } from '../registry';
import { sendTo } from '../outbox';
import type { ApprovalPrompt, ApprovalResolvedEvent, InboundEnvelope } from '../types';

const YES = new Set(['si', 'sí', 'yes', 'y', 'ok', 'okay', 'approve', 'approved', 'aprobar', 'aprobado', 'dale', 'va']);
const NO = new Set(['no', 'n', 'deny', 'denied', 'denegar', 'rechazar', 'rechazado']);

/**
 * The whole message must be "<word> <code>": a code has 3–8 letters/digits
 * with at least one digit, so ordinary replies ("ok bye", "no way") pass
 * through to the agent untouched.
 */
export function parseApprovalReply(text: string): { allow: boolean; code: string } | null {
  const m = /^\s*([a-záéíóú]+)\s*[:,#-]?\s*([a-z0-9]{3,8})\s*[.!]*\s*$/i.exec(text);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  const code = m[2]!;
  if (!/\d/.test(code)) return null;
  if (YES.has(word)) return { allow: true, code };
  if (NO.has(word)) return { allow: false, code };
  return null;
}

/**
 * "Expires in 5 min." — or null. `expiresAt` 0 means the request never
 * expires (coding sessions wait for an answer), so nothing is shown for it.
 */
export function approvalExpiry(a: Pick<ApprovalPrompt, 'expiresAt'>, now = Date.now()): string | null {
  if (!a.expiresAt || !Number.isFinite(a.expiresAt) || a.expiresAt <= now) return null;
  return `Expires in ${Math.max(1, Math.round((a.expiresAt - now) / 60_000))} min.`;
}

/**
 * An approval message once it's answered: the header, the "Reply SI …"
 * instructions and the countdown no longer apply, the rest (what was asked)
 * stays under the outcome.
 */
export function settledApprovalBody(body: string): string {
  return body
    .replace(/^(🔔|🔐)[^\n]*\n?/u, '')
    .split('\n')
    .filter(line => !/^\s*Reply\b.*\b(SI|NO)\b/i.test(line) && !/^\s*Expires in \d+ min\.\s*$/.test(line))
    .join('\n')
    .trim();
}

/** Default approval text when the policy area sends none. */
export function approvalBody(a: ApprovalPrompt, now = Date.now()): string {
  const summary = a.summary.trim();
  return [
    `🔔 *Approval needed* — ${a.title}`,
    summary ? summary.slice(0, 800) : null,
    `Session: ${a.sessionName}`,
    approvalExpiry(a, now),
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Settled requests
// ---------------------------------------------------------------------------

/**
 * Requests answered recently, and how. The policy area fans a prompt out to
 * one channel after another, and the outbox retries a failed send after a
 * backoff, so a channel's turn (or its retry) can come after the owner already
 * answered somewhere else. Adapters look here to skip a prompt nobody needs
 * any more, and to settle one that landed while the answer was coming in.
 */
const settled = new Map<string, ApprovalResolvedEvent>();
const MAX_SETTLED = 500;

/** Fed by every resolved approval (channels/index.ts). Idempotent. */
export function noteApprovalSettled(e: ApprovalResolvedEvent): void {
  settled.delete(e.requestId);
  settled.set(e.requestId, e);
  while (settled.size > MAX_SETTLED) settled.delete(settled.keys().next().value!);
}

/** How a request was answered, or null while it is pending (or long forgotten). */
export function approvalSettlement(requestId: string): ApprovalResolvedEvent | null {
  return settled.get(requestId) ?? null;
}

/** Tests only. */
export function _resetSettledApprovals(): void {
  settled.clear();
}

/** "✅ Approved (via app)" — the outcome, naming the surface unless it is this channel itself. */
export function resolvedHeader(e: ApprovalResolvedEvent, channelType: string): string {
  if (e.via === 'expired') return '⌛ Expired';
  if (e.via === 'cancelled') return '🚫 Cancelled';
  const head = e.allow ? '✅ Approved' : '❌ Denied';
  return e.via && e.via !== channelType ? `${head} (via ${e.via})` : head;
}

/**
 * For channels that can't edit a message: their prompt went out while the
 * request was being answered, so it says "reply SI …" about something that
 * is already decided. This follows it, so the owner doesn't answer a ghost.
 */
export function lateApprovalNotice(a: Pick<ApprovalPrompt, 'code' | 'title'>, e: ApprovalResolvedEvent, channelType: string): string {
  return `${resolvedHeader(e, channelType)}: ${a.title}. Approval ${a.code} was already answered — no need to reply.`;
}

export async function interceptApprovalReply(env: InboundEnvelope): Promise<boolean> {
  if (!env.trusted || (env.attachments?.length ?? 0) > 0) return false;
  const parsed = parseApprovalReply(env.text);
  if (!parsed) return false;
  const res = await answerApproval({ code: parsed.code, allow: parsed.allow, via: env.channelType, channelId: env.channelId });
  const reply = res.ok
    ? (parsed.allow ? '✅ Approved.' : '❌ Denied.')
    : `⚠️ ${res.error || `No pending approval with code ${parsed.code}`}`;
  // With a priority, so it is posted on its own: a reply without one takes
  // over the chat's open "Working…" bubble and stops the typing indicator —
  // and that bubble belongs to the turn this very answer just let continue.
  await sendTo(env, { kind: 'text', text: reply, priority: 'normal' });
  return true;
}

let installed = false;
export function installApprovalReplyInterceptor(): void {
  if (installed) return;
  installed = true;
  addInboundInterceptor(interceptApprovalReply);
}
