import { useEffect } from 'react';

import { fetchMessages, LATEST_SEQ } from './messages';
import { readMessages, whenHydrated, writeMessages } from './messageStore';
import type { SessionSummary } from './types';
import type { ServerRoutes } from './useServerRoutes';

/** Las de arriba de la lista: son las que de verdad se abren. */
const PREFETCH_COUNT = 8;
/** Mismo tamaño que la primera página del chat: por el Funnel pesa. */
const PAGE = 30;

/** Las que ya se están trayendo: el efecto se relanza con cada refresco. */
const inflight = new Set<string>();

/**
 * Trae en segundo plano la última página de los chats de arriba que todavía no
 * están guardados en el teléfono. Así abrir uno nunca enseña el cargador: la
 * conversación ya está y al entrar solo se pone al día.
 *
 * Una sola vez por sesión: lo que ya está guardado lo mantiene al día el
 * socket, y el chat pide lo que falte al abrirse.
 */
export function usePrefetchChats(
  sessions: SessionSummary[],
  routes: ServerRoutes,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    whenHydrated().then(async () => {
      const pending = sessions
        .filter(session => session.isOpen)
        .slice(0, PREFETCH_COUNT)
        .filter(
          session =>
            readMessages(session.key) === null &&
            !inflight.has(session.key) &&
            (routes[session.serverId]?.baseUrl.length ?? 0) > 0,
        );
      // De dos en dos: es trabajo de fondo y no debe competir con lo que la
      // pantalla está pidiendo ahora.
      for (let i = 0; i < pending.length && !cancelled; i += 2) {
        await Promise.all(
          pending.slice(i, i + 2).map(async session => {
            const route = routes[session.serverId]!;
            inflight.add(session.key);
            try {
              const page = await fetchMessages(
                route.baseUrl,
                session.id,
                route.token,
                LATEST_SEQ,
                PAGE,
              );
              // Si mientras tanto se abrió el chat, lo suyo manda.
              if (readMessages(session.key) === null) {
                writeMessages(session.key, page.messages, page.hasMore);
              }
            } catch {
              // Sin precarga, el chat la pide al abrirse, como antes.
            } finally {
              inflight.delete(session.key);
            }
          }),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessions, routes, enabled]);
}
