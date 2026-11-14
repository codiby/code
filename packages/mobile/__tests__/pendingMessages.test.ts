import type { ChatMessage } from '../src/api/types';
import { keepPending } from '../src/lib/pendingMessages';

const msg = (id: string, content: string, timestamp = 1_000_000, role: ChatMessage['role'] = 'user') =>
  ({ id, role, content, timestamp, seq: 0, toolName: null, toolInput: null, images: [], isThinking: false, thinkingRedacted: false }) as ChatMessage;

test('una carga de la red no se traga la burbuja que aún no confirma el bridge', () => {
  const history = [msg('1', 'viejo', 1, 'assistant')];
  const pending = msg('local-9', '¿ya se vuelven venta?');
  expect(keepPending(history, [pending])).toEqual([...history, pending]);
});

test('cuando llega su eco, la optimista se va', () => {
  const pending = msg('local-9', '¿ya se vuelven venta?', 1_000_000);
  const echo = msg('srv-9', '¿ya se vuelven venta?', 1_000_400);
  expect(keepPending([echo], [pending])).toEqual([echo]);
});

test('un mensaje viejo con el mismo texto no cuenta como eco', () => {
  const pending = msg('local-9', 'continue', 10_000_000);
  const old = msg('srv-1', 'continue', 1_000);
  expect(keepPending([old], [pending])).toEqual([old, pending]);
});

test('sin pendientes devuelve la misma lista', () => {
  const next = [msg('1', 'a')];
  expect(keepPending(next, [msg('2', 'b')])).toBe(next);
});
