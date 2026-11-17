import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import { addReply, canReplyTo, MAX_REPLIES, readReplies, replyFromMessage, replyFromSelection, withReplies } from './message-reply';

const message = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'original', role: 'assistant', content: 'Primera línea\nSegunda línea', timestamp: 1, ...extra,
});

describe('message replies shared with Android', () => {
  test('reads the exact envelope sent by Android, including multiline text', () => {
    const content = '<codiby-reply>{"id":"android-message","role":"assistant","text":"Primera línea\\nSegunda línea"}</codiby-reply>\n\nTesteando';
    expect(readReplies(content)).toEqual({
      text: 'Testeando', replies: [{ id: 'android-message', role: 'assistant', text: 'Primera línea\nSegunda línea' }],
    });
  });

  test('the text persisted by the bridge retains the citation through queues and retries', () => {
    const reply = replyFromMessage(message());
    const sent = withReplies('Mi respuesta', [reply]);
    const reloaded = JSON.parse(JSON.stringify({ content: sent }));
    expect(readReplies(reloaded.content)).toEqual({ text: 'Mi respuesta', replies: [reply] });
    expect(withReplies('Sin cita', [])).toBe('Sin cita');
  });

  test('one quote without a note keeps the single envelope older clients read', () => {
    expect(withReplies('x', [{ id: 'a', role: 'assistant', text: 'q', note: '  ' }]))
      .toBe('<codiby-reply>{"id":"a","role":"assistant","text":"q"}</codiby-reply>\n\nx');
  });

  test('several quotes with notes travel in one message and come back in order', () => {
    const replies = [
      { id: 'a', role: 'assistant' as const, text: 'Agrupar por repo', note: 'Sí, pero por branch' },
      { id: 'a', role: 'assistant' as const, text: 'Cajón de archivadas' },
      { id: 'b', role: 'user' as const, text: 'Mi pregunta', note: 'Ignora esto' },
    ];
    const sent = withReplies('En general bien', replies);
    expect(sent.startsWith('<codiby-replies>')).toBe(true);
    expect(readReplies(sent)).toEqual({ text: 'En general bien', replies });
    // A single quote with a note needs the list envelope to carry the note.
    expect(readReplies(withReplies('', [replies[0]]))).toEqual({ text: '', replies: [replies[0]] });
  });

  test('pending quotes dedupe and cap', () => {
    const r = { id: 'a', role: 'assistant' as const, text: 'q' };
    expect(addReply(addReply(undefined, r), r)).toEqual([r]);
    let list = addReply(undefined, r);
    for (let i = 0; i < 20; i++) list = addReply(list, { ...r, text: `q${i}` });
    expect(list).toHaveLength(MAX_REPLIES);
    expect(list.at(-1)?.text).toBe('q19');
  });

  test('a reply to a reply cites its body without nesting envelopes', () => {
    const original = replyFromMessage(message());
    const next = replyFromMessage(message({ role: 'user', content: withReplies('Respuesta anterior', [original]) }));
    expect(next.text).toBe('Respuesta anterior');
    expect(next.role).toBe('user');
    const multi = replyFromMessage(message({ role: 'user', content: withReplies('Cuerpo', [{ ...original, note: 'n' }, original]) }));
    expect(multi.text).toBe('Cuerpo');
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
    '<codiby-replies>[]</codiby-replies>\n\ntexto',
    '<codiby-replies>{"id":"x","role":"user","text":"x"}</codiby-replies>\n\ntexto',
    `<codiby-replies>${JSON.stringify([{ id: 'x', role: 'user', text: 'x' }, { id: 'y', role: 'system', text: 'y' }])}</codiby-replies>\n\ntexto`,
    `<codiby-replies>${JSON.stringify([{ id: 'x', role: 'user', text: 'x', note: 5 }])}</codiby-replies>\n\ntexto`,
    `<codiby-replies>${JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, role: 'user', text: 'x' })))}</codiby-replies>\n\ntexto`,
  ])('malformed citation remains visible as ordinary text: %s', text => {
    expect(readReplies(text)).toEqual({ text, replies: [] });
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
