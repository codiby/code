import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import { canReplyTo, readReply, replyFromMessage, replyFromSelection, withReply } from './message-reply';

const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'original', role: 'assistant', content: 'Primera línea\nSegunda línea', timestamp: 1, ...extra,
});

describe('message replies shared with Android', () => {
  test('reads the exact envelope sent by Android, including multiline text', () => {
    const content = '<codiby-reply>{"id":"android-message","role":"assistant","text":"Primera línea\\nSegunda línea"}</codiby-reply>\n\nTesteando';
    expect(readReply(content)).toEqual({
      text: 'Testeando', reply: { id: 'android-message', role: 'assistant', text: 'Primera línea\nSegunda línea' },
    });
  });

  test('the text persisted by the bridge retains the citation through queues and retries', () => {
    const reply = replyFromMessage(message());
    const sent = withReply('Mi respuesta', reply);
    const reloaded = JSON.parse(JSON.stringify({ content: sent }));
    expect(readReply(reloaded.content)).toEqual({ text: 'Mi respuesta', reply });
    expect(withReply('Sin cita', null)).toBe('Sin cita');
  });

  test('a reply to a reply cites its body without nesting envelopes', () => {
    const original = replyFromMessage(message());
    const next = replyFromMessage(message({ role: 'user', content: withReply('Respuesta anterior', original) }));
    expect(next.text).toBe('Respuesta anterior');
    expect(next.role).toBe('user');
    expect(replyFromMessage(message({ content: 'a '.repeat(600) })).text).toHaveLength(600);
    expect(replyFromMessage(message({ content: '', images: [{ media_type: 'image/png', data: 'photo' }] })).text).toBe('Image');
  });

  test('a selection reply quotes only the selected text', () => {
    const m = message({ content: 'First paragraph.\n\nSecond paragraph.' });
    expect(replyFromSelection(m, '  Second paragraph. ')).toEqual({ ...replyFromMessage(m), text: 'Second paragraph.' });
    expect(replyFromSelection(m, 'x'.repeat(700)).text).toHaveLength(600);
    expect(replyFromSelection(m, '   ')).toEqual(replyFromMessage(m));
  });

  test.each([
    'Normal', '<codiby-reply>incompleto', '<codiby-reply>null</codiby-reply>\n\ntexto',
    '<codiby-reply>{"id":"x","role":"system","text":"x"}</codiby-reply>\n\ntexto',
    `<codiby-reply>${JSON.stringify({ id: 'x', role: 'user', text: 'x'.repeat(601) })}</codiby-reply>\n\ntexto`,
  ])('malformed citation remains visible as ordinary text: %s', text => {
    expect(readReply(text)).toEqual({ text, reply: null });
  });

  test('only delivered conversational messages are reply targets', () => {
    expect(canReplyTo(message())).toBe(true);
    expect(canReplyTo(message({ role: 'user' }))).toBe(true);
    expect(canReplyTo(message({ content: '', images: [{ media_type: 'image/png', data: 'photo' }] }))).toBe(true);
    for (const fields of [
      { role: 'system' as const }, { toolName: 'Bash' }, { isToolResult: true },
      { isThinking: true }, { isTerminal: true }, { streaming: true }, { isPending: true },
      { deliveryStatus: 'sending' as const }, { deliveryStatus: 'failed' as const }, { content: '' },
    ]) expect(canReplyTo(message(fields))).toBe(false);
  });
});
