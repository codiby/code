import type { ChatMessage } from '../src/api/types';
import { buildChatItems } from '../src/lib/chatItems';

const base = {
  role: 'assistant' as const,
  timestamp: 0,
  toolInput: null,
  images: [],
  isThinking: false,
  thinkingRedacted: false,
};
const call = (id: string, seq: number): ChatMessage => ({
  ...base,
  id,
  seq,
  content: '',
  toolName: 'Read',
  isToolResult: false,
  toolUseId: null,
});
const result = (id: string, seq: number, of: string): ChatMessage => ({
  ...base,
  id,
  seq,
  content: `salida de ${of}`,
  toolName: null,
  isToolResult: true,
  toolUseId: of,
});
const text = (id: string, seq: number): ChatMessage => ({
  ...base,
  id,
  seq,
  content: 'hola',
  toolName: null,
  isToolResult: false,
  toolUseId: null,
});

describe('buildChatItems', () => {
  it('empareja herramientas en paralelo por id y no pinta salidas como burbujas', () => {
    const items = buildChatItems([
      text('t1', 1),
      call('c1', 2),
      call('c2', 3),
      result('r1', 4, 'c1'),
      result('r2', 5, 'c2'),
      text('t2', 6),
    ]);
    const bubbles = items
      .filter(item => item.kind === 'message')
      .map(item => (item.kind === 'message' ? item.message.id : ''));
    expect(bubbles).toEqual(['t1', 't2']);
    const first = items[0];
    expect(first?.kind === 'message' ? first.group?.length : 0).toBe(2);
    if (first?.kind === 'message' && first.group !== null) {
      const outputs = first.group.map(entry =>
        entry.kind === 'tool' ? entry.output?.id : null,
      );
      expect(outputs).toEqual(['r1', 'r2']);
    }
  });

  it('una salida huérfana (su llamada no está en la página) no sale', () => {
    const items = buildChatItems([result('r0', 1, 'fuera'), text('t', 2)]);
    expect(items.map(item => item.key)).toEqual(['t']);
  });

  it('no se come el texto del agente que sigue a una llamada sin salida', () => {
    const items = buildChatItems([call('c1', 1), text('t', 2)]);
    expect(items.some(item => item.kind === 'message' && item.message.id === 't')).toBe(true);
  });
});
