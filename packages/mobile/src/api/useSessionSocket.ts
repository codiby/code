import { useCallback, useEffect, useRef } from 'react';

import { RECONNECTED, useSockets, type Frame, type SocketStatus } from './SocketProvider';
import type { ChatMessage, PermissionRequest } from './types';
import { parseLiveMessage } from './messages';

export type { SocketStatus };

/**
 * Estados que difunde el bridge. El bridge no manda un `idle`: el turno
 * termina con `turn_complete`, o con `interrupted` si se cortó a media
 * respuesta. `idle` lo emite este hook cuando el `session_state` de una
 * (re)suscripción dice que no hay turno en curso.
 */
export const SESSION_STATUSES = [
  'connected',
  'disconnected',
  'streaming',
  'turn_complete',
  'interrupted',
  'idle',
] as const;

export type SessionStatusEvent = (typeof SESSION_STATUSES)[number];

export interface UseSessionSocketResult {
  readonly status: SocketStatus;
  /**
   * false si el socket no está abierto: la respuesta no salió.
   *
   * `updatedInput` solo lo usa `AskUserQuestion`, que no se contesta con un sí
   * o un no sino con las opciones elegidas. Va como el input original más un
   * `answers`, y el bridge lo persiste como resultado de la herramienta.
   */
  readonly respondPermission: (
    requestId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
  ) => boolean;
  /** Suscrita y con la conexión viva. */
  readonly isLive: boolean;
}

export interface UseSessionSocketOptions {
  readonly serverId: string;
  readonly sessionId: string;
  readonly enabled?: boolean;
  readonly onMessage: (message: ChatMessage) => void;
  readonly onStatus: (status: string) => void;
  /** Texto acumulado de la respuesta en curso. `''` retira la vista previa. */
  readonly onPartialText: (text: string) => void;
  /** Igual, para el razonamiento. */
  readonly onPartialThinking: (text: string) => void;
  /** `null` cuando se resuelve o se cancela la petición. */
  readonly onPermission?: (request: PermissionRequest | null) => void;
  /** Total real del historial, que `GET /sessions` no expone. */
  readonly onTotalMessages?: (total: number) => void;
  /**
   * Se llama al reconectar. Mientras el socket estuvo caído pudieron llegar
   * mensajes, y esos no se reenvían: hay que releer la última página.
   */
  readonly onResync?: () => void;
  /**
   * Cambió algo de la sesión en sí —hoy solo el nombre— desde otro cliente.
   *
   * El bridge difunde la lista entera a todos los clientes al renombrar, sin
   * `sessionId`, así que el filtro por sesión la descartaba: el encabezado del
   * chat se quedaba con el nombre que traía al abrirse.
   */
  readonly onMeta?: (meta: { readonly name: string }) => void;
}

export function parsePermission(value: unknown): PermissionRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestId !== 'string' || typeof raw.toolName !== 'string') {
    return null;
  }
  return {
    requestId: raw.requestId,
    toolName: raw.toolName,
    description:
      typeof raw.description === 'string' && raw.description.length > 0
        ? raw.description
        : null,
    input:
      typeof raw.input === 'object' && raw.input !== null
        ? (raw.input as Record<string, unknown>)
        : {},
  };
}

/**
 * Los parciales llegan varias veces por segundo. Renderizar cada uno satura el
 * hilo de JS; agruparlos en ventanas de ~80 ms se sigue viendo continuo y
 * acota los re-renders.
 */
const PARTIAL_FLUSH_MS = 80;

function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Escucha una sesión sobre el socket compartido del servidor.
 *
 * Ya no abre ni cierra nada: pide la suscripción —idempotente— y se registra
 * como oyente. Volver a un chat que ya visitaste no cuesta un apretón de manos
 * nuevo porque la suscripción sigue puesta desde la primera vez.
 */
export function useSessionSocket({
  serverId,
  sessionId,
  enabled = true,
  onMessage,
  onStatus,
  onPartialText,
  onPartialThinking,
  onPermission,
  onTotalMessages,
  onResync,
  onMeta,
}: UseSessionSocketOptions): UseSessionSocketResult {
  const sockets = useSockets();

  // Los callbacks viven en refs para que cambiar de handler no vuelva a
  // registrar el oyente en cada render.
  const handlers = useRef({
    onMessage,
    onStatus,
    onPartialText,
    onPartialThinking,
    onPermission,
    onTotalMessages,
    onResync,
    onMeta,
  });
  handlers.current = {
    onMessage,
    onStatus,
    onPartialText,
    onPartialThinking,
    onPermission,
    onTotalMessages,
    onResync,
    onMeta,
  };

  /**
   * Contestar va por el mismo socket que trajo la petición. Denegar además
   * interrumpe el turno del lado del bridge — no es «salta esta herramienta».
   */
  const respondPermission = useCallback(
    (
      requestId: string,
      allow: boolean,
      updatedInput?: Record<string, unknown>,
    ) =>
      sockets.send(serverId, {
        type: 'permission_response',
        sessionId,
        requestId,
        allow,
        // Omitido cuando no lo hay: el bridge lo lee como opcional y mandar
        // `undefined` explícito lo dejaría en el JSON como clave ausente igual,
        // pero así queda claro que solo `AskUserQuestion` lo usa.
        ...(updatedInput === undefined ? {} : { updatedInput }),
      }),
    [sockets, serverId, sessionId],
  );

  useEffect(() => {
    if (!enabled || sessionId.length === 0 || serverId.length === 0) {
      return;
    }
    // `resend` a propósito: abrir el chat tiene que pedir el estado actual
    // aunque el Home ya estuviera suscrito, o un permiso levantado antes de
    // entrar no se vería. Cuesta una trama por apertura de chat.
    sockets.subscribe(serverId, sessionId, true);

    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingText: string | null = null;
    let pendingThinking: string | null = null;

    const flushPartials = () => {
      flushTimer = null;
      if (pendingText !== null) {
        handlers.current.onPartialText(pendingText);
        pendingText = null;
      }
      if (pendingThinking !== null) {
        handlers.current.onPartialThinking(pendingThinking);
        pendingThinking = null;
      }
    };

    const schedulePartialFlush = () => {
      if (flushTimer === null) {
        flushTimer = setTimeout(flushPartials, PARTIAL_FLUSH_MS);
      }
    };

    const remove = sockets.addListener((from: string, frame: Frame) => {
      if (from !== serverId) {
        return;
      }
      if (frame.type === RECONNECTED) {
        handlers.current.onResync?.();
        return;
      }
      // La lista completa no lleva `sessionId`: hay que atenderla antes del
      // filtro o se pierde el renombrado hecho desde el escritorio.
      if (frame.type === 'sessions') {
        const list = frame.sessions;
        if (!Array.isArray(list)) {
          return;
        }
        for (const item of list) {
          const entry = item as { id?: unknown; name?: unknown };
          if (entry.id === sessionId && typeof entry.name === 'string') {
            handlers.current.onMeta?.({ name: entry.name });
            return;
          }
        }
        return;
      }

      // El socket es multiplexado: llegan tramas de todas las sesiones.
      if (frame.sessionId !== sessionId) {
        return;
      }

      switch (frame.type) {
        case 'message': {
          const message = parseLiveMessage(frame.message);
          if (message !== null) {
            // Descartar lo pendiente es obligatorio: el mensaje definitivo
            // reemplaza a la vista previa, y un flush agendado que se dispare
            // después volvería a pintar el texto ya asentado — se ve como el
            // mismo mensaje duplicado.
            pendingText = null;
            pendingThinking = null;
            if (flushTimer !== null) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            handlers.current.onMessage(message);
          }
          return;
        }
        case 'partial_text':
          pendingText = typeof frame.text === 'string' ? frame.text : '';
          schedulePartialFlush();
          return;
        case 'partial_thinking':
          pendingThinking = typeof frame.text === 'string' ? frame.text : '';
          schedulePartialFlush();
          return;
        case 'session_state': {
          // Al suscribirse a media respuesta, el estado ya trae lo escrito
          // hasta ahora: sin esto la vista previa arrancaría vacía.
          const partialText = readString(frame.state, 'partialText');
          const partialThinking = readString(frame.state, 'partialThinking');
          if (partialText !== null) {
            handlers.current.onPartialText(partialText);
          }
          if (partialThinking !== null) {
            handlers.current.onPartialThinking(partialThinking);
          }

          const state = frame.state;
          if (typeof state !== 'object' || state === null) {
            return;
          }
          const record = state as Record<string, unknown>;
          // El turno pudo empezar antes de que nos suscribiéramos, así que el
          // evento `status: streaming` ya pasó y no volverá. Y al revés: si
          // terminó con el socket muerto —Android lo congela en segundo
          // plano—, el `turn_complete` se perdió y solo esto lo apaga.
          if (record.isStreaming === true) {
            handlers.current.onStatus('streaming');
          } else if (record.isStreaming === false) {
            handlers.current.onStatus('idle');
          }
          handlers.current.onPermission?.(parsePermission(record.permRequest));
          if (typeof record.totalMessages === 'number') {
            handlers.current.onTotalMessages?.(record.totalMessages);
          }
          return;
        }
        case 'permission_request':
          handlers.current.onPermission?.(parsePermission(frame.request));
          return;
        case 'permission_cancelled':
          handlers.current.onPermission?.(null);
          return;
        case 'status':
          if (typeof frame.status === 'string') {
            handlers.current.onStatus(frame.status);
          }
          return;
        default:
      }
    });

    return () => {
      remove();
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      // La suscripción NO se retira: es lo que hace que volver a este chat sea
      // instantáneo y que el Home lo siga viendo en vivo.
    };
  }, [sockets, serverId, sessionId, enabled]);

  return {
    status: sockets.statusOf(serverId),
    respondPermission,
    isLive: sockets.isLive(serverId, sessionId),
  };
}
