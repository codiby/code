/**
 * The push contract with the bridge (packages/core/agent/push/messages.ts).
 * FCM data values are always strings; this turns them back into a typed
 * message and drops anything that doesn't fit, so a malformed push can never
 * reach the notification or the approval endpoint.
 */

export const CHANNELS = {
  approvals: 'approvals',
  messages: 'messages',
  /** No sound or heads-up: Android fixes both per channel, not per notification. */
  quiet: 'messages_quiet',
} as const;

/** iOS category the bridge sets on approval alerts; registered at launch. */
export const APPROVAL_CATEGORY = 'APPROVAL';
export const ACTION_APPROVE = 'approve';
export const ACTION_DENY = 'deny';

/** The agent's always-on session — where a tap without a session lands. */
export const AGENT_SESSION_ID = 'main-session';

export interface ApprovalPush {
  readonly type: 'approval';
  readonly requestId: string;
  readonly code: string | null;
  readonly title: string;
  readonly body: string;
  readonly toolName: string;
  /** A question for the owner (AskUserQuestion): answered in the chat, not yes/no. */
  readonly question: boolean;
  /** Host label of the bridge that asked — how the answer finds its way back. */
  readonly host: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly expiresAt: number | null;
}

export interface ApprovalResolvedPush {
  readonly type: 'approval_resolved';
  readonly requestId: string;
  readonly allow: boolean;
  readonly via: string;
  readonly host: string;
}

export interface NotifyPush {
  readonly type: 'notify';
  readonly title: string;
  readonly body: string;
  readonly host: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly priority: 'low' | 'normal' | 'urgent';
  readonly quiet: boolean;
  readonly channel: string;
}

export type PushData = ApprovalPush | ApprovalResolvedPush | NotifyPush;

/** Where a tap on a notification should take the user. */
export interface OpenTarget {
  readonly host: string;
  readonly sessionId: string;
}

const MAX_ID = 200;

function text(data: Record<string, unknown>, key: string, max = 4000): string {
  const value = data[key];
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function id(data: Record<string, unknown>, key: string): string | null {
  const value = text(data, key, MAX_ID + 1);
  return value.length > 0 && value.length <= MAX_ID && /^[\w.:-]+$/.test(value)
    ? value
    : null;
}

function timestamp(data: Record<string, unknown>, key: string): number | null {
  const value = Number(text(data, key, 20));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parsePushData(raw: unknown): PushData | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const host = text(data, 'host', 200);
  const type = text(data, 'type', 40);

  if (type === 'approval' || type === 'approval_resolved') {
    const requestId = id(data, 'requestId');
    if (requestId === null) {
      return null;
    }
    if (type === 'approval_resolved') {
      return {
        type,
        requestId,
        allow: text(data, 'allow', 5) === 'true',
        via: text(data, 'via', 40),
        host,
      };
    }
    const code = text(data, 'code', 20);
    return {
      type,
      requestId,
      code: code.length > 0 ? code : null,
      title: text(data, 'title', 200) || 'Approval needed',
      body: text(data, 'body'),
      toolName: text(data, 'toolName', 200),
      question: text(data, 'question', 5) === 'true',
      host,
      sessionId: id(data, 'sessionId') ?? '',
      sessionName: text(data, 'sessionName', 200),
      expiresAt: timestamp(data, 'expiresAt'),
    };
  }

  if (type === 'notify') {
    const priority = text(data, 'priority', 10);
    const channel = text(data, 'channel', 40);
    return {
      type,
      title: text(data, 'title', 200) || 'Codiby',
      body: text(data, 'body'),
      host,
      sessionId: id(data, 'sessionId') ?? '',
      sessionName: text(data, 'sessionName', 200),
      priority:
        priority === 'low' || priority === 'urgent' ? priority : 'normal',
      quiet: text(data, 'quiet', 5) === 'true',
      channel: (Object.values(CHANNELS) as string[]).includes(channel)
        ? channel
        : CHANNELS.messages,
    };
  }

  return null;
}

/** Where tapping this push should open. */
export function openTargetOf(data: PushData): OpenTarget {
  const sessionId = data.type === 'approval_resolved' ? '' : data.sessionId;
  return { host: data.host, sessionId: sessionId || AGENT_SESSION_ID };
}

/** Flatten back to strings: notification `data` survives only as a string map. */
export function toNotificationData(data: PushData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}
