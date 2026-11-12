/**
 * What a push looks like on the wire. Pure: no I/O, so the payload shape the
 * phone depends on is pinned by tests.
 *
 * Android gets data-only messages — the app draws every notification itself
 * (notifee), which is the only way to get Approve / Deny buttons, per-request
 * ids it can cancel later, and a quiet channel. iOS does not reliably wake a
 * killed app for data-only pushes, so the same message also carries an APNs
 * alert the system shows on its own; the `APPROVAL` category gives it the
 * buttons, registered by the app at launch.
 *
 * Contract with packages/mobile/src/push: `data` keys and `type` values below.
 */

import type { FcmMessage } from './fcm';

export const ANDROID_CHANNELS = {
  approvals: 'approvals',
  messages: 'messages',
  /** Same as `messages` without sound or heads-up: Android fixes both per channel. */
  quiet: 'messages_quiet',
} as const;

export const APNS_APPROVAL_CATEGORY = 'APPROVAL';

/**
 * A permission request that is really a question for the owner: it can't be
 * answered yes/no, so it goes out without buttons and a tap opens the chat.
 */
export const QUESTION_TOOLS = new Set(['AskUserQuestion']);

export type PushPriority = 'low' | 'normal' | 'urgent';

export type PushPayload =
  | {
      type: 'approval';
      requestId: string;
      /** Short code channels without buttons use; shown so the owner can match it. */
      code?: string | null;
      title: string;
      summary: string;
      toolName: string;
      sessionId: string;
      sessionName: string;
      expiresAt?: number | null;
    }
  | {
      type: 'approval_resolved';
      requestId: string;
      allow: boolean;
      via: string;
      sessionId: string;
      sessionName: string;
    }
  | {
      type: 'notify';
      title?: string | null;
      text: string;
      priority: PushPriority;
      sessionId: string;
      sessionName: string;
      quiet: boolean;
    };

export interface BuildContext {
  /** This bridge's host label, so a phone paired with several hosts knows whom to answer. */
  host: string;
  now: number;
}

/** FCM rejects messages over 4096 bytes; data and the APNs alert both carry the text. */
const MAX_MESSAGE_BYTES = 3800;
const DEFAULT_APPROVAL_TTL_S = 3600;
const NOTIFY_TTL_S = 24 * 3600;
/** APNs collapse ids are capped at 64 bytes. */
const MAX_COLLAPSE_ID = 64;

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+\n/g, '\n').trim();
  if (clean.length <= max) return clean;
  let cut = Math.max(0, max - 1);
  // Never split an emoji (or any astral character) in half: a lone surrogate
  // makes FCM reject the message or the phone draw a "?" box.
  if (cut > 0 && /[\uD800-\uDBFF]/.test(clean[cut - 1]!)) cut--;
  return `${clean.slice(0, cut).trimEnd()}…`;
}

function ttlSeconds(expiresAt: number | null | undefined, now: number): number {
  if (!expiresAt) return DEFAULT_APPROVAL_TTL_S;
  // A request that already expired still gets a short TTL rather than none:
  // FCM treats 0 as "now or never", which would drop it for a phone in Doze.
  return Math.max(30, Math.round((expiresAt - now) / 1000));
}

function approvalTexts(p: Extract<PushPayload, { type: 'approval' }>, bodyMax: number) {
  if (QUESTION_TOOLS.has(p.toolName)) {
    return { title: clip(`Question · ${p.sessionName || 'Session'}`, 120), body: clip(p.summary || p.title, bodyMax) };
  }
  const title = clip(`Approval needed · ${p.sessionName || 'Session'}`, 120);
  const detail = p.summary && p.summary !== p.title ? `${p.title}\n${p.summary}` : p.title || p.toolName;
  const suffix = p.code ? `\nCode ${p.code}` : '';
  return { title, body: clip(detail, bodyMax - suffix.length) + suffix };
}

/**
 * A notification without a title (message reminders: "⏰ Call Ana") is
 * titled with the session that raised it, so the lock screen reads
 * "🤖 Codiby — ⏰ Call Ana" instead of an empty bold line.
 */
function notifyTexts(p: Extract<PushPayload, { type: 'notify' }>, bodyMax: number) {
  return { title: clip(p.title?.trim() || p.sessionName?.trim() || 'Codiby', 120), body: clip(p.text, bodyMax) };
}

/**
 * Silent: no sound, no heads-up, Android's quiet channel, iOS "passive".
 * Quiet hours silence everything but urgent; priority 'low' is always
 * silent, as it is on the chat channels (notify.ts sends it as a silent
 * message). Urgent always rings.
 */
export function isSilentNotify(p: Pick<Extract<PushPayload, { type: 'notify' }>, 'priority' | 'quiet'>): boolean {
  return p.priority !== 'urgent' && (p.quiet || p.priority === 'low');
}

function build(token: string, payload: PushPayload, ctx: BuildContext, bodyMax: number): FcmMessage {
  const common = {
    host: ctx.host,
    sessionId: payload.sessionId,
    sessionName: clip(payload.sessionName, 80),
    sentAt: String(ctx.now),
  };

  if (payload.type === 'approval') {
    const { title, body } = approvalTexts(payload, bodyMax);
    const ttl = ttlSeconds(payload.expiresAt, ctx.now);
    const question = QUESTION_TOOLS.has(payload.toolName);
    return {
      token,
      data: {
        ...common,
        type: 'approval',
        requestId: payload.requestId,
        ...(payload.code ? { code: payload.code } : {}),
        toolName: payload.toolName,
        ...(question ? { question: 'true' } : {}),
        title,
        body,
        priority: 'urgent',
        channel: ANDROID_CHANNELS.approvals,
        ...(payload.expiresAt ? { expiresAt: String(payload.expiresAt) } : {}),
      },
      android: { priority: 'HIGH', ttl: `${ttl}s`, collapse_key: payload.requestId },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
          'apns-collapse-id': payload.requestId.slice(0, MAX_COLLAPSE_ID),
          'apns-expiration': String(Math.floor(ctx.now / 1000) + ttl),
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            ...(question ? {} : { category: APNS_APPROVAL_CATEGORY }),
            'thread-id': 'approvals',
            'mutable-content': 1,
            // A session is blocked until someone answers.
            'interruption-level': 'time-sensitive',
          },
        },
      },
    };
  }

  if (payload.type === 'approval_resolved') {
    return {
      token,
      data: {
        ...common,
        type: 'approval_resolved',
        requestId: payload.requestId,
        allow: String(payload.allow),
        via: payload.via,
        title: '',
        body: '',
        priority: 'normal',
      },
      // Same collapse key as the request: a phone that was offline gets only
      // this one instead of a request that is already settled.
      android: { priority: 'NORMAL', ttl: `${DEFAULT_APPROVAL_TTL_S}s`, collapse_key: payload.requestId },
      apns: {
        headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } },
      },
    };
  }

  const { title, body } = notifyTexts(payload, bodyMax);
  const urgent = payload.priority === 'urgent';
  const silent = isSilentNotify(payload);
  return {
    token,
    data: {
      ...common,
      type: 'notify',
      title,
      body,
      priority: payload.priority,
      quiet: String(silent),
      channel: silent ? ANDROID_CHANNELS.quiet : ANDROID_CHANNELS.messages,
    },
    android: { priority: urgent ? 'HIGH' : 'NORMAL', ttl: `${NOTIFY_TTL_S}s` },
    apns: {
      headers: { 'apns-priority': silent ? '5' : '10', 'apns-push-type': 'alert' },
      payload: {
        aps: {
          alert: { title, body },
          ...(silent ? {} : { sound: 'default' }),
          'thread-id': 'messages',
          'mutable-content': 1,
          'interruption-level': urgent ? 'time-sensitive' : silent ? 'passive' : 'active',
        },
      },
    },
  };
}

function byteLength(message: FcmMessage): number {
  return Buffer.byteLength(JSON.stringify({ data: message.data, apns: message.apns?.payload }));
}

/** One FCM message for one device token, shrunk to fit FCM's size limit. */
export function buildFcmMessage(token: string, payload: PushPayload, ctx: BuildContext): FcmMessage {
  let bodyMax = 1200;
  let message = build(token, payload, ctx, bodyMax);
  // Non-Latin text can be 3–4 bytes a character; halve until it fits.
  while (byteLength(message) > MAX_MESSAGE_BYTES && bodyMax > 60) {
    bodyMax = Math.floor(bodyMax / 2);
    message = build(token, payload, ctx, bodyMax);
  }
  return message;
}
