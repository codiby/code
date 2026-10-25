import type { ChatMessage } from '../src/api/types';
import { lastSeqOf, mergeNewer } from '../src/lib/messageMerge';

const msg = (id: string, seq: number): ChatMessage => ({
  id,
  seq,
  role: 'assistant',
  content: id,
  timestamp: 0,
  toolName: null,
  toolInput: null,
  images: [],
  isThinking: false,
  thinkingRedacted: false,
});

describe('mergeNewer', () => {
  it('pega lo nuevo detrás de lo guardado', () => {
    const merged = mergeNewer([msg('a', 1), msg('b', 2)], [msg('c', 3)]);
    expect(merged.map(m => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('cambia el eco del socket (seq 0) por el mensaje con su seq real', () => {
    const merged = mergeNewer(
      [msg('a', 1), msg('b', 0)],
      [msg('b', 2), msg('c', 3)],
    );
    expect(merged.map(m => `${m.id}${m.seq}`)).toEqual(['a1', 'b2', 'c3']);
  });

  it('sin nada nuevo devuelve lo mismo', () => {
    const current = [msg('a', 1)];
    expect(mergeNewer(current, [])).toBe(current);
  });
});

describe('lastSeqOf', () => {
  it('ignora los seq 0 del socket', () => {
    expect(lastSeqOf([msg('a', 5), msg('b', 0)])).toBe(5);
  });
});

describe('mergeNewer con envíos locales', () => {
  it('retira la burbuja local cuando llega el mensaje real', () => {
    const local: ChatMessage = {
      ...msg('local-1', 0),
      role: 'user',
      content: 'hola',
      sendState: 'failed',
    };
    const real: ChatMessage = { ...msg('u1', 7), role: 'user', content: 'hola' };
    const merged = mergeNewer([msg('a', 6), local], [real]);
    expect(merged.map(m => m.id)).toEqual(['a', 'u1']);
  });
});
