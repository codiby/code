import { useEffect, useRef, useState } from 'react';

import { RECONNECTED, useSockets, type Frame } from './SocketProvider';
import { parseLiveMessage } from './messages';
import { collapse } from './useSessionPreviews';
import { parsePermission } from './useSessionSocket';
import { shortToolName } from '../lib/chatItems';

export interface LiveSession {
  /** Herramienta que espera aprobación; la sesión está detenida. */
  readonly pendingTool: string | null;
  /** El agente está respondiendo ahora mismo. */
  readonly isStreaming: boolean;
  /** Qué está haciendo: la última herramienta que invocó. */
  readonly activity: string | null;
  /** Último texto legible, para adelantar la vista previa sin ir al servidor. */
  readonly preview: string | null;
  /**
   * Cuándo llegó el último mensaje. Basta para reordenar la lista y poner la
   * hora de la fila sin volver a pedir `/sessions`.
   */
  readonly lastAt: number | null;
}

export type LiveSessions = Readonly<Record<string, LiveSession>>;

export interface LiveTarget {
  readonly id: string;
  readonly sessionIds: string[];
}

const IDLE: LiveSession = {
  pendingTool: null,
  isStreaming: false,
  activity: null,
  preview: null,
  lastAt: null,
};

/** Suscribirse a demasiadas sesiones por servidor no aporta nada en una lista. */
const MAX_WATCHED = 20;

/**
 * Solo al reconectar hace falta releer la lista: pudo cambiar mientras no
 * había conexión. Se agrupan los avisos de varios servidores en una recarga.
 *
 * Antes se releía con CADA mensaje de cualquier sesión suscrita: con agentes
 * trabajando eran ~1,5 MB cada 30 s con el Home quieto. Un mensaje solo cambia
 * la hora y el orden de su sesión, y eso ya lo trae el propio mensaje.
 */
const CHANGE_DEBOUNCE_MS = 500;

/**
 * Vigila varias sesiones de varios servidores sobre el socket compartido.
 *
 * `GET /sessions` no dice nada de esto —ni siquiera si la sesión está
 * respondiendo—, así que la única vía es suscribirse. La conexión ya no es de
 * esta pantalla: la mantiene el proveedor y aquí solo se piden suscripciones y
 * se escucha.
 */
export function useLiveSessions(
  targets: readonly LiveTarget[],
  enabled: boolean,
  /** Se llama cuando la lista en sí quedó desfasada y toca releerla. */
  onSessionsChanged: () => void,
  /**
   * El bridge empujó su lista completa por el socket (al renombrar, al
   * arrancar o salir un agente…). Ya viene entera: no hay que pedirla.
   */
  onSessionList?: (serverId: string, list: unknown[]) => void,
): LiveSessions {
  const sockets = useSockets();
  const [live, setLive] = useState<LiveSessions>({});

  // En una ref para que recrear el callback en cada render del Home no
  // vuelva a registrar el oyente.
  const notify = useRef(onSessionsChanged);
  notify.current = onSessionsChanged;
  const pushList = useRef(onSessionList);
  pushList.current = onSessionList;

  // Los arreglos llegan nuevos en cada render; se comparan por contenido para
  // no rehacer las suscripciones cada vez que la lista se recalcula.
  const signature = targets
    .map(target => `${target.id}|${target.sessionIds.slice(0, MAX_WATCHED).join(',')}`)
    .join(';');

  useEffect(() => {
    if (!enabled || signature.length === 0) {
      return;
    }

    for (const chunk of signature.split(';')) {
      const [serverId, ids] = chunk.split('|');
      if (serverId === undefined || ids === undefined || ids.length === 0) {
        continue;
      }
      for (const sessionId of ids.split(',')) {
        sockets.subscribe(serverId, sessionId);
      }
    }
  }, [sockets, signature, enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let changeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleChanged = () => {
      if (changeTimer === null) {
        changeTimer = setTimeout(() => {
          changeTimer = null;
          notify.current();
        }, CHANGE_DEBOUNCE_MS);
      }
    };

    /**
     * Devolver el mismo objeto cuando nada cambió es lo que evita repintar las
     * filas: los parciales llegan varias veces por segundo y casi todos dicen
     * lo que ya sabíamos.
     */
    const patch = (sessionId: string, change: Partial<LiveSession>) => {
      setLive(current => {
        const previous = current[sessionId] ?? IDLE;
        const next = { ...previous, ...change };
        if (
          next.pendingTool === previous.pendingTool &&
          next.isStreaming === previous.isStreaming &&
          next.activity === previous.activity &&
          next.preview === previous.preview &&
          next.lastAt === previous.lastAt
        ) {
          return current;
        }
        return { ...current, [sessionId]: next };
      });
    };

    const remove = sockets.addListener((serverId: string, frame: Frame) => {
      // Al reconectar, la lista pudo cambiar mientras no había conexión.
      if (frame.type === RECONNECTED) {
        scheduleChanged();
        return;
      }
      if (frame.type === 'sessions') {
        if (Array.isArray(frame.sessions) && pushList.current !== undefined) {
          pushList.current(serverId, frame.sessions);
        } else {
          scheduleChanged();
        }
        return;
      }

      const rawId = frame.sessionId;
      if (typeof rawId !== 'string') {
        return;
      }
      // Compuesta: `main-session` existe en todas las máquinas, así que la
      // trama de una pisaría el estado de la otra.
      const sessionId = `${serverId}:${rawId}`;

      switch (frame.type) {
        case 'session_state': {
          const state = frame.state;
          if (typeof state !== 'object' || state === null) {
            return;
          }
          const record = state as Record<string, unknown>;
          patch(sessionId, {
            pendingTool: parsePermission(record.permRequest)?.toolName ?? null,
            isStreaming: record.isStreaming === true,
          });
          return;
        }
        case 'permission_request':
          patch(sessionId, {
            pendingTool: parsePermission(frame.request)?.toolName ?? null,
          });
          return;
        case 'permission_cancelled':
          patch(sessionId, { pendingTool: null });
          return;
        case 'message': {
          const message = parseLiveMessage(frame.message);
          if (message === null) {
            return;
          }
          const at = message.timestamp > 0 ? message.timestamp : Date.now();
          patch(sessionId, { lastAt: at });
          if (message.toolName !== null) {
            patch(sessionId, { activity: shortToolName(message.toolName) });
          } else if (
            !message.isThinking &&
            message.isToolResult !== true &&
            message.content.trim().length > 0
          ) {
            patch(sessionId, {
              preview: collapse(message.content),
              activity: null,
            });
          }
          return;
        }
        // Los parciales no se guardan, solo confirman que sigue viva: con
        // muchas sesiones, almacenar cada token sería repintar sin parar.
        case 'partial_text':
        case 'partial_thinking':
          patch(sessionId, { isStreaming: true });
          return;
        case 'status': {
          if (frame.status === 'streaming') {
            patch(sessionId, { isStreaming: true });
            return;
          }
          if (
            frame.status === 'turn_complete' ||
            frame.status === 'interrupted' ||
            frame.status === 'disconnected'
          ) {
            patch(sessionId, { isStreaming: false, activity: null });
          }
          return;
        }
        default:
      }
    });

    return () => {
      remove();
      if (changeTimer !== null) {
        clearTimeout(changeTimer);
      }
    };
  }, [sockets, enabled]);

  return live;
}
