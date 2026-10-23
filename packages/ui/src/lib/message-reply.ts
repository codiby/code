import type { ChatMessage } from './claude-client';

/** Shared wire format with Android. The bridge persists this in message text. */
export interface MessageReply {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

const PREFIX = '<codiby-reply>';
const SUFFIX = '</codiby-reply>\n\n';

export function readReply(content: string): { text: string; reply: MessageReply | null } {
  const plain = { text: content, reply: null };
  if (!content.startsWith(PREFIX)) return plain;
  const end = content.indexOf(SUFFIX, PREFIX.length);
  if (end < 0 || end > 4000) return plain;
  try {
    const value: unknown = JSON.parse(content.slice(PREFIX.length, end));
    if (typeof value !== 'object' || value === null) return plain;
    const r = value as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 200 ||
        (r.role !== 'user' && r.role !== 'assistant') ||
        typeof r.text !== 'string' || r.text.length > 600) return plain;
    return {
      text: content.slice(end + SUFFIX.length),
      reply: { id: r.id, role: r.role, text: r.text },
    };
  } catch {
    return plain;
  }
}

export function withReply(text: string, reply: MessageReply | null): string {
  return reply === null ? text : `${PREFIX}${JSON.stringify(reply)}${SUFFIX}${text}`;
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
    text: (message.role === 'user' ? readReply(message.content).text : message.content)
      .trim().slice(0, 600) || (message.images?.length ? 'Imagen' : 'Mensaje'),
  };
}
