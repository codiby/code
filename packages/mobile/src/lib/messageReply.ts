import type { ChatMessage } from '../api/types';

/** Mismo formato que el escritorio (packages/ui/src/lib/message-reply.ts). */
export interface MessageReply {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Lo que el usuario dice de esta cita. Solo viaja en el sobre de varias. */
  readonly note?: string;
}

/** Una cita sin nota: el sobre original, que las versiones viejas aún leen. */
const PREFIX = '<codiby-reply>';
const SUFFIX = '</codiby-reply>\n\n';
/** Varias citas, cada una con su nota, en un solo mensaje. */
const LIST_PREFIX = '<codiby-replies>';
const LIST_SUFFIX = '</codiby-replies>\n\n';

export const MAX_REPLIES = 10;
export const MAX_QUOTE = 600;
export const MAX_NOTE = 2000;

function parseOne(value: unknown, allowNote: boolean): MessageReply | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const r = value as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    !r.id ||
    r.id.length > 200 ||
    (r.role !== 'user' && r.role !== 'assistant') ||
    typeof r.text !== 'string' ||
    r.text.length > MAX_QUOTE
  ) {
    return null;
  }
  if (
    r.note !== undefined &&
    (!allowNote || typeof r.note !== 'string' || r.note.length > MAX_NOTE)
  ) {
    return null;
  }
  const note = typeof r.note === 'string' && r.note.trim() ? r.note : undefined;
  return note
    ? { id: r.id, role: r.role, text: r.text, note }
    : { id: r.id, role: r.role, text: r.text };
}

function envelope(
  content: string,
  prefix: string,
  suffix: string,
  maxLen: number,
): { json: unknown; rest: string } | null {
  if (!content.startsWith(prefix)) {
    return null;
  }
  const end = content.indexOf(suffix, prefix.length);
  if (end < 0 || end > maxLen) {
    return null;
  }
  try {
    return {
      json: JSON.parse(content.slice(prefix.length, end)),
      rest: content.slice(end + suffix.length),
    };
  } catch {
    return null;
  }
}

/** The bridge persists text; keep the quotes in that text for history and retries. */
export function withReplies(
  text: string,
  replies: readonly MessageReply[],
): string {
  const clean = replies.slice(0, MAX_REPLIES).map(r => {
    const note = r.note?.trim().slice(0, MAX_NOTE);
    return note
      ? { id: r.id, role: r.role, text: r.text, note }
      : { id: r.id, role: r.role, text: r.text };
  });
  if (clean.length === 0) {
    return text;
  }
  if (clean.length === 1 && !clean[0].note) {
    return `${PREFIX}${JSON.stringify(clean[0])}${SUFFIX}${text}`;
  }
  return `${LIST_PREFIX}${JSON.stringify(clean)}${LIST_SUFFIX}${text}`;
}

export function readReplies(content: string): {
  text: string;
  replies: MessageReply[];
} {
  const plain = { text: content, replies: [] };
  const single = envelope(content, PREFIX, SUFFIX, 4000);
  if (single) {
    const reply = parseOne(single.json, false);
    return reply ? { text: single.rest, replies: [reply] } : plain;
  }
  const list = envelope(content, LIST_PREFIX, LIST_SUFFIX, 40_000);
  if (
    !list ||
    !Array.isArray(list.json) ||
    list.json.length === 0 ||
    list.json.length > MAX_REPLIES
  ) {
    return plain;
  }
  const replies = list.json.map(v => parseOne(v, true));
  return replies.every((r): r is MessageReply => r !== null)
    ? { text: list.rest, replies }
    : plain;
}

/** Suma una cita a las pendientes; la misma cita dos veces queda una. */
export function addReply(
  list: readonly MessageReply[],
  reply: MessageReply,
): MessageReply[] {
  if (list.some(r => r.id === reply.id && r.text === reply.text)) {
    return [...list];
  }
  return [...list, reply].slice(-MAX_REPLIES);
}

export function replyFromMessage(message: ChatMessage): MessageReply {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    text:
      readReplies(message.content).text.trim().slice(0, MAX_QUOTE) ||
      (message.images.length > 0 ? 'Image' : 'Message'),
  };
}
