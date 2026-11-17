import type { ChatMessage } from './claude-client';

/** Shared wire format with Android. The bridge persists this in message text. */
export interface MessageReply {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** What the user says about this quote. Only in the multi-quote envelope. */
  readonly note?: string;
}

/** One quote, no note: the original envelope, still readable by older clients. */
const PREFIX = '<codiby-reply>';
const SUFFIX = '</codiby-reply>\n\n';
/** Several quotes, each with its own note, sent in one message. */
const LIST_PREFIX = '<codiby-replies>';
const LIST_SUFFIX = '</codiby-replies>\n\n';

export const MAX_REPLIES = 10;
export const MAX_QUOTE = 600;
export const MAX_NOTE = 2000;

type Parsed = { text: string; replies: MessageReply[] };

function parseOne(value: unknown, allowNote: boolean): MessageReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 200 ||
      (r.role !== 'user' && r.role !== 'assistant') ||
      typeof r.text !== 'string' || r.text.length > MAX_QUOTE) return null;
  if (r.note !== undefined && (!allowNote || typeof r.note !== 'string' || r.note.length > MAX_NOTE)) return null;
  const note = typeof r.note === 'string' && r.note.trim() ? r.note : undefined;
  return note ? { id: r.id, role: r.role, text: r.text, note } : { id: r.id, role: r.role, text: r.text };
}

function envelope(content: string, prefix: string, suffix: string, maxLen: number): { json: unknown; rest: string } | null {
  if (!content.startsWith(prefix)) return null;
  const end = content.indexOf(suffix, prefix.length);
  if (end < 0 || end > maxLen) return null;
  try {
    return { json: JSON.parse(content.slice(prefix.length, end)), rest: content.slice(end + suffix.length) };
  } catch {
    return null;
  }
}

/** Split a user message into its quotes and its own text. Malformed envelopes stay visible as text. */
export function readReplies(content: string): Parsed {
  const plain = { text: content, replies: [] };
  const single = envelope(content, PREFIX, SUFFIX, 4000);
  if (single) {
    const reply = parseOne(single.json, false);
    return reply ? { text: single.rest, replies: [reply] } : plain;
  }
  const list = envelope(content, LIST_PREFIX, LIST_SUFFIX, 40_000);
  if (!list || !Array.isArray(list.json) || !list.json.length || list.json.length > MAX_REPLIES) return plain;
  const replies = list.json.map(v => parseOne(v, true));
  return replies.every((r): r is MessageReply => r !== null) ? { text: list.rest, replies } : plain;
}

export function withReplies(text: string, replies: readonly MessageReply[]): string {
  const clean = replies.slice(0, MAX_REPLIES).map(r => {
    const note = r.note?.trim().slice(0, MAX_NOTE);
    return note ? { id: r.id, role: r.role, text: r.text, note } : { id: r.id, role: r.role, text: r.text };
  });
  if (!clean.length) return text;
  if (clean.length === 1 && !clean[0].note) return `${PREFIX}${JSON.stringify(clean[0])}${SUFFIX}${text}`;
  return `${LIST_PREFIX}${JSON.stringify(clean)}${LIST_SUFFIX}${text}`;
}

/** Append a quote to the pending list; the same quote twice is kept once. */
export function addReply(list: readonly MessageReply[] | undefined, reply: MessageReply): MessageReply[] {
  const current = list ?? [];
  if (current.some(r => r.id === reply.id && r.text === reply.text)) return [...current];
  return [...current, reply].slice(-MAX_REPLIES);
}

export function canReplyTo(message: ChatMessage): boolean {
  return (message.role === 'user' || message.role === 'assistant') &&
    !message.toolName && !message.isToolResult && !message.isThinking &&
    !message.isTerminal && !message.streaming && !message.isPending && !message.deliveryStatus &&
    (Boolean(message.content.trim()) || Boolean(message.images?.length));
}

export function replyFromMessage(message: ChatMessage): MessageReply {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    text: (message.role === 'user' ? readReplies(message.content).text : message.content)
      .trim().slice(0, MAX_QUOTE) || (message.images?.length ? 'Image' : 'Message'),
  };
}

/** A reply that quotes only the part of `message` the user selected. */
export function replyFromSelection(message: ChatMessage, selected: string): MessageReply {
  const text = selected.trim().slice(0, MAX_QUOTE);
  return text ? { ...replyFromMessage(message), text } : replyFromMessage(message);
}
