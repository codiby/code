import { parseLiveMessage } from '../src/api/messages';
import type { ChatMessage } from '../src/api/types';
import {
  addReply,
  readReplies,
  replyFromMessage,
  withReplies,
  type MessageReply,
} from '../src/lib/messageReply';

const readReply = (content: string) => {
  const { text, replies } = readReplies(content);
  return { text, reply: replies[0] ?? null };
};
const withReply = (text: string, reply: MessageReply | null) =>
  withReplies(text, reply ? [reply] : []);

const original = {
  id: 'original',
  role: 'assistant',
  content: 'Primera línea\nSegunda línea',
  images: [],
} as unknown as ChatMessage;

test('la cita y el texto sobreviven al eco del bridge y a la recarga del historial', () => {
  const reply = replyFromMessage(original);
  const encoded = withReply('Mi respuesta', reply);
  const message = parseLiveMessage({
    id: 'response',
    role: 'user',
    content: encoded,
  });
  expect(readReply(message!.content)).toEqual({ text: 'Mi respuesta', reply });
  expect(withReply('Sin cita', null)).toBe('Sin cita');
});

test('responder a una respuesta cita solo su cuerpo y permite fotos sin texto', () => {
  expect(
    replyFromMessage({
      ...original,
      content: withReply('Otra respuesta', replyFromMessage(original)),
    }).text,
  ).toBe('Otra respuesta');
  expect(
    replyFromMessage({
      ...original,
      content: '',
      images: [{ mediaType: 'image/png', data: 'photo' }],
    }).text,
  ).toBe('Image');
  expect(
    replyFromMessage({ ...original, content: 'palabra '.repeat(300) }).text,
  ).toHaveLength(600);
});

test.each([
  '<codiby-reply>incompleto',
  '<codiby-reply>null</codiby-reply>\n\ntexto',
  '<codiby-reply>{"id":"x","role":"system","text":"x"}</codiby-reply>\n\ntexto',
])('no oculta texto que no es una referencia válida: %s', text => {
  expect(readReply(text)).toEqual({ text, reply: null });
});

test('la cita no recorta un cuerpo de 8,000 caracteres al sincronizar', () => {
  const text = 'Una línea normal.\n'.repeat(500).slice(0, 8000);
  const reply = replyFromMessage(original);
  const message = parseLiveMessage({
    id: 'response',
    role: 'user',
    content: withReply(text, reply),
  });
  expect(readReply(message!.content)).toEqual({ text, reply });
});

test('varias citas con nota viajan en un solo mensaje, igual que en escritorio', () => {
  const replies: MessageReply[] = [
    { id: 'a', role: 'assistant', text: 'Agrupar por repo', note: 'Por branch' },
    { id: 'a', role: 'assistant', text: 'Cajón de archivadas' },
  ];
  const message = parseLiveMessage({
    id: 'response',
    role: 'user',
    content: withReplies('En general bien', replies),
  });
  expect(readReplies(message!.content)).toEqual({
    text: 'En general bien',
    replies,
  });
  expect(addReply(addReply([], replies[1]!), replies[1]!)).toEqual([replies[1]]);
});
