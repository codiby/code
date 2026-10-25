import type { ChatMessage } from '../api/types';

/** El `seq` más alto que ya tenemos. Los que llegan por el socket traen 0. */
export function lastSeqOf(messages: ChatMessage[]): number {
  let max = 0;
  for (const message of messages) {
    if (message.seq > max) {
      max = message.seq;
    }
  }
  return max;
}

/**
 * Funde lo que ya había con lo nuevo que trajo la red.
 *
 * Los que llegaron por el socket traen `seq` 0, así que el orden no puede ir
 * solo por `seq`: se conserva el orden de lo que había, se quitan los que la
 * red ya trae con su `seq` de verdad, y lo nuevo va detrás.
 */
export function mergeNewer(
  current: ChatMessage[],
  newer: ChatMessage[],
): ChatMessage[] {
  if (newer.length === 0) {
    return current;
  }
  const incoming = new Set(newer.map(message => message.id));
  /** Lo que el usuario escribió y ya llegó de verdad, para retirar su burbuja local. */
  const echoed = new Set(
    newer.filter(message => message.role === 'user').map(message => message.content),
  );
  const firstNew = newer[0]!.seq;
  const kept = current.filter(
    message =>
      !incoming.has(message.id) &&
      !(message.sendState !== undefined && echoed.has(message.content)) &&
      // Un mensaje con seq real posterior al primero nuevo ya no cuadra en el
      // orden; lo trae la red en su sitio.
      !(message.seq > 0 && message.seq >= firstNew),
  );
  return [...kept, ...newer];
}
