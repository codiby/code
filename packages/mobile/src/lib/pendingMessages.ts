import type { ChatMessage } from '../api/types';

/** Id de una burbuja que el teléfono pintó antes de que el bridge la confirme. */
export const OPTIMISTIC_PREFIX = 'local-';

/** Margen para el reloj del teléfono contra el del bridge. */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Lo que trae la red reemplaza la lista, pero no debe tragarse lo que el
 * usuario acaba de mandar y el bridge todavía no devuelve: esas burbujas
 * optimistas se vuelven a poner al final hasta que llegue su eco.
 *
 * Antes, escribir justo al abrir un chat hacía que la primera sincronización
 * borrara la burbuja; con el relevo del chat directo, el mensaje que viaja
 * desaparecía a media animación.
 */
export function keepPending(
  next: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  const confirmed = next.filter(m => !m.id.startsWith(OPTIMISTIC_PREFIX));
  const pending = current.filter(
    m =>
      m.id.startsWith(OPTIMISTIC_PREFIX) &&
      !confirmed.some(
        echo =>
          echo.role === m.role &&
          echo.content === m.content &&
          echo.timestamp >= m.timestamp - CLOCK_SKEW_MS,
      ),
  );
  if (pending.length === 0) {
    return next;
  }
  const ids = new Set(next.map(m => m.id));
  return [...next, ...pending.filter(m => !ids.has(m.id))];
}
