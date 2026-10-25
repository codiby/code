import type { ChatMessage } from '../api/types';

export interface MessageReply {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

const PREFIX = '<codiby-reply>';
const SUFFIX = '</codiby-reply>\n\n';

/** The bridge persists text; keep the citation in that text for history and retries. */
export function withReply(text: string, reply: MessageReply | null): string {
  return reply === null
    ? text
    : `${PREFIX}${JSON.stringify(reply)}${SUFFIX}${text}`;
}

export function readReply(content: string): {
  text: string;
  reply: MessageReply | null;
} {
  const plain = { text: content, reply: null };
  if (!content.startsWith(PREFIX)) {
    return plain;
  }
  const end = content.indexOf(SUFFIX, PREFIX.length);
  if (end < 0 || end > 4000) {
    return plain;
  }
  try {
    const value: unknown = JSON.parse(content.slice(PREFIX.length, end));
    if (typeof value !== 'object' || value === null) {
      return plain;
    }
    const r = value as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      !r.id ||
      r.id.length > 200 ||
      (r.role !== 'user' && r.role !== 'assistant') ||
      typeof r.text !== 'string' ||
      r.text.length > 600
    ) {
      return plain;
    }
    return {
      text: content.slice(end + SUFFIX.length),
      reply: { id: r.id, role: r.role, text: r.text },
    };
  } catch {
    return plain;
  }
}

export function replyFromMessage(message: ChatMessage): MessageReply {
  return {
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    text:
      readReply(message.content).text.trim().slice(0, 600) ||
      (message.images.length > 0 ? 'Imagen' : 'Mensaje'),
  };
}
