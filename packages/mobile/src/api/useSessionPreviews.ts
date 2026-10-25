import { useEffect, useRef, useState } from 'react';

import { fetchMessages, LATEST_SEQ } from './messages';
import type { SessionSummary } from './types';
import type { ServerRoutes } from './useServerRoutes';
import { shortToolName } from '../lib/chatItems';

/** Cuántas filas se previsualizan. Más allá no caben en pantalla. */
const MAX_SESSIONS = 24;

/**
 * Peticiones en vuelo a la vez. Eran 4, y con 24 filas son seis viajes
 * seguidos: por el Funnel, ~670 ms cada uno, así que las últimas filas tardaban
 * cuatro segundos en tener texto. Son GET diminutos; el bridge los aguanta.
 */
const CONCURRENCY = 12;

/**
 * El último mensaje suele ser una llamada de herramienta o un razonamiento;
 * ninguno de los dos sirve como resumen. Se piden unos cuantos y se elige el
 * último que de verdad diga algo.
 */
const WINDOW = 8;

/** clave de sesión → resumen, con el `updatedAt` para el que se calculó. */
export type Previews = Readonly<
  Record<string, { readonly at: number; readonly text: string }>
>;

/**
 * El resumen se pinta como texto plano, así que la sintaxis de markdown solo
 * estorba: `**no** está` se lee peor que `no está`. Se quitan los marcadores
 * pero se conserva lo que envuelven.
 */
export function collapse(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      // La fila de alineación de una tabla no es contenido; sin quitarla
      // primero deja un rastro de guiones.
      .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, ' ')
      .replace(/^\s*#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // El separador de celdas pasa a espacio, no se borra: si no, las
      // columnas se pegarían entre sí.
      .replace(/\|/g, ' ')
      // Sin tocar el guion bajo: `in_progress` es un identificador, no
      // cursiva, y quitarlo lo convertiría en `inprogress`.
      .replace(/[*~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  );
}

/**
 * `GET /sessions` no incluye nada del último mensaje, así que el resumen se
 * pide por sesión. La caché va por `id:updatedAt`: mientras la sesión no
 * cambie, no se vuelve a pedir.
 */
export function useSessionPreviews(
  sessions: SessionSummary[],
  routes: ServerRoutes,
  enabled: boolean,
  /** Lo guardado en el teléfono: lo que no cambió no se vuelve a pedir. */
  seed: Previews | null,
): Previews {
  const [previews, setPreviews] = useState<Previews>({});
  const cache = useRef(new Map<string, string>());

  const publish = () => {
    const next: Record<string, { at: number; text: string }> = {};
    for (const [cacheKey, value] of cache.current) {
      // La clave es `servidor:sesión:updatedAt`; se recorta solo la fecha,
      // que es lo único que sobra para indexar. Gana la más reciente.
      const cut = cacheKey.lastIndexOf(':');
      const sessionKey = cacheKey.slice(0, cut);
      const at = Number(cacheKey.slice(cut + 1));
      if (value.length > 0 && (next[sessionKey]?.at ?? -1) < at) {
        next[sessionKey] = { at, text: value };
      }
    }
    setPreviews(next);
  };

  useEffect(() => {
    if (seed === null) {
      return;
    }
    for (const [key, entry] of Object.entries(seed)) {
      const cacheKey = `${key}:${entry.at}`;
      if (!cache.current.has(cacheKey)) {
        cache.current.set(cacheKey, entry.text);
      }
    }
    publish();
    // `publish` solo lee la ref; la siembra se hace una vez por foto.
  }, [seed]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const pending = sessions
      .slice(0, MAX_SESSIONS)
      .filter(
        session =>
          !cache.current.has(`${session.key}:${session.updatedAt}`) &&
          // Sin ruta viva no hay a quién preguntarle; la fila se pinta
          // apagada y sin vista previa.
          (routes[session.serverId]?.baseUrl.length ?? 0) > 0,
      );

    if (pending.length === 0) {
      return;
    }

    const run = async () => {
      for (let i = 0; i < pending.length; i += CONCURRENCY) {
        if (cancelled) {
          return;
        }
        const batch = pending.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async session => {
            let text = '';
            const route = routes[session.serverId];
            try {
              const page = await fetchMessages(
                route!.baseUrl,
                session.id,
                route!.token,
                LATEST_SEQ,
                WINDOW,
              );
              const readable = [...page.messages]
                .reverse()
                .find(
                  message =>
                    message.toolName === null &&
                    !message.isThinking &&
                    message.isToolResult !== true &&
                    message.content.trim().length > 0,
                );
              if (readable !== undefined) {
                text = collapse(readable.content);
              } else {
                // Solo hubo herramientas: al menos se dice cuál.
                const lastTool = [...page.messages]
                  .reverse()
                  .find(message => message.toolName !== null);
                text =
                  lastTool === undefined
                    ? ''
                    : shortToolName(lastTool.toolName ?? '');
              }
            } catch {
              text = '';
            }
            cache.current.set(`${session.key}:${session.updatedAt}`, text);
          }),
        );

        if (!cancelled) {
          publish();
        }
      }
    };

    // `run` atrapa sus propios fallos por sesión y nunca rechaza.
    run();
    return () => {
      cancelled = true;
    };
    // `seed` entra en las dependencias para que, si la foto llega después de
    // la lista, no se pidan resúmenes que ya estaban guardados.
  }, [sessions, routes, enabled, seed]);

  return previews;
}
