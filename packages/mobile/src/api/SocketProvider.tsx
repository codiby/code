import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { toSocketUrl } from './client';
import { useServers } from '../config/ServerConfigContext';

export type SocketStatus = 'connecting' | 'open' | 'closed';

/** Trama sintética que el proveedor inyecta al reconectar. */
export const RECONNECTED = '__reconnected';

export type Frame = Record<string, unknown>;

/** Recibe todas las tramas de un servidor; cada consumidor filtra lo suyo. */
export type FrameListener = (serverId: string, frame: Frame) => void;

export interface SocketApi {
  /** Idempotente. La suscripción se recuerda y se repite al reconectar. */
  readonly subscribe: (
    serverId: string,
    sessionId: string,
    resend?: boolean,
    /**
     * Pide el historial en la respuesta. Por defecto no: el bridge contesta a
     * cada `subscribe` con hasta 200 mensajes, y el Home suscribe todas las
     * sesiones activas — eran megas por el Funnel en cada arranque.
     */
    full?: boolean,
  ) => void;
  readonly addListener: (listener: FrameListener) => () => void;
  readonly send: (serverId: string, payload: unknown) => boolean;
  readonly statusOf: (serverId: string) => SocketStatus;
  /** Suscrita y con el socket abierto: lo que enciende el indicador. */
  readonly isLive: (serverId: string, sessionId: string) => boolean;
  /** Cambia cuando alguna suscripción o estado cambia, para repintar. */
  readonly revision: number;
}

const SocketContext = createContext<SocketApi | null>(null);

const MAX_BACKOFF_MS = 15_000;

/**
 * Suscripción sin historial: el `session_state` trae estado, permiso pendiente
 * y total de mensajes, pero no los mensajes ni los parciales. Es lo único que
 * necesita el Home para el punto de «en vivo».
 */
function liteSubscribe(sessionId: string): string {
  return JSON.stringify({ type: 'subscribe', sessionId, state: false });
}

/**
 * Un socket por servidor, vivo mientras la app lo esté.
 *
 * Antes había dos y uno era efímero: el Home mantenía el suyo y cada chat abría
 * el propio, lo saludaba y lo tiraba al salir. Entrar a una conversación
 * costaba un apretón de manos entero antes de recibir nada, y salir tiraba
 * suscripciones que en un minuto harían falta otra vez.
 *
 * Ahora la conexión es del servidor, no de la pantalla, y las suscripciones se
 * acumulan a medida que abres sesiones. Volver a un chat ya no conecta nada.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { routes } = useServers();

  const sockets = useRef(new Map<string, WebSocket>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const attempts = useRef(new Map<string, number>());
  /** serverId → sesiones que hay que (re)suscribir en cuanto abra. */
  const subscriptions = useRef(new Map<string, Set<string>>());
  const listeners = useRef(new Set<FrameListener>());
  const statuses = useRef(new Map<string, SocketStatus>());
  const [revision, setRevision] = useState(0);

  const bump = useCallback(() => setRevision(value => value + 1), []);

  // Las rutas cambian de identidad en cada render del proveedor; solo su
  // contenido debe provocar reconexión.
  const wiring = Object.values(routes)
    .filter(route => route.baseUrl.length > 0)
    .map(route => `${route.server.id}|${route.baseUrl}|${route.token}`)
    .sort()
    .join(';');

  useEffect(() => {
    const openSockets = sockets.current;
    const openTimers = timers.current;
    let disposed = false;

    const targets = new Map(
      wiring
        .split(';')
        .filter(chunk => chunk.length > 0)
        .map(chunk => {
          const [id, baseUrl, token] = chunk.split('|');
          return [id ?? '', { baseUrl: baseUrl ?? '', token: token ?? '' }] as const;
        }),
    );

    const setStatus = (serverId: string, status: SocketStatus) => {
      statuses.current.set(serverId, status);
      bump();
    };

    const connect = (serverId: string, baseUrl: string, token: string) => {
      if (disposed) {
        return;
      }
      const socket = new WebSocket(toSocketUrl(baseUrl, token));
      openSockets.set(serverId, socket);
      setStatus(serverId, 'connecting');

      socket.onopen = () => {
        if (disposed) {
          return;
        }
        attempts.current.set(serverId, 0);
        setStatus(serverId, 'open');
        // Se repiten TODAS las suscripciones acumuladas: el bridge las guarda
        // por conexión, así que una reconexión las pierde todas.
        for (const sessionId of subscriptions.current.get(serverId) ?? []) {
          socket.send(liteSubscribe(sessionId));
        }
        for (const listener of listeners.current) {
          listener(serverId, { type: RECONNECTED });
        }
      };

      socket.onmessage = event => {
        if (typeof event.data !== 'string') {
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof payload !== 'object' || payload === null) {
          return;
        }
        for (const listener of listeners.current) {
          listener(serverId, payload as Frame);
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }
        setStatus(serverId, 'closed');
        const attempt = attempts.current.get(serverId) ?? 0;
        attempts.current.set(serverId, attempt + 1);
        openTimers.set(
          serverId,
          setTimeout(
            () => connect(serverId, baseUrl, token),
            Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS),
          ),
        );
      };
      socket.onerror = () => socket.close();
    };

    const drop = (serverId: string) => {
      const timer = openTimers.get(serverId);
      if (timer !== undefined) {
        clearTimeout(timer);
        openTimers.delete(serverId);
      }
      const socket = openSockets.get(serverId);
      if (socket !== undefined) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        openSockets.delete(serverId);
      }
      statuses.current.delete(serverId);
    };

    // Solo se toca lo que cambió: un servidor cuya URL sigue igual conserva su
    // conexión, que es justo lo que evita el parpadeo al recargar la lista.
    for (const serverId of [...openSockets.keys()]) {
      if (!targets.has(serverId)) {
        drop(serverId);
      }
    }
    for (const [serverId, target] of targets) {
      if (!openSockets.has(serverId)) {
        connect(serverId, target.baseUrl, target.token);
      }
    }

    /**
     * Android congela el proceso al bloquear la pantalla y mata los sockets sin
     * entregar siempre el `close`: quedan medio abiertos y no hay evento que
     * dispare la reconexión. Volver a primer plano es la única señal fiable.
     */
    const appState = AppState.addEventListener('change', next => {
      if (next !== 'active' || disposed) {
        return;
      }
      for (const [serverId, target] of targets) {
        drop(serverId);
        attempts.current.set(serverId, 0);
        connect(serverId, target.baseUrl, target.token);
      }
    });

    return () => {
      disposed = true;
      appState.remove();
      for (const serverId of [...openSockets.keys()]) {
        drop(serverId);
      }
    };
  }, [wiring, bump]);

  const subscribe = useCallback(
    /**
     * `resend` repite la trama aunque la sesión ya estuviera suscrita.
     *
     * El bridge contesta a cada `subscribe` con un `session_state`, y ahí es
     * donde viaja el permiso pendiente. Como el Home suscribe todo para el
     * indicador de «en vivo», al abrir un chat la suscripción ya existía y el
     * atajo de aquí se comía la respuesta: una petición de permiso levantada
     * antes de entrar quedaba invisible, y el chat no la enseñaba nunca.
     */
    (serverId: string, sessionId: string, resend = false, full = false) => {
      let owned = subscriptions.current.get(serverId);
      if (owned === undefined) {
        owned = new Set();
        subscriptions.current.set(serverId, owned);
      }
      const isNew = !owned.has(sessionId);
      if (!isNew && !resend) {
        return;
      }
      owned.add(sessionId);
      const socket = sockets.current.get(serverId);
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(
          full
            ? JSON.stringify({ type: 'subscribe', sessionId })
            : liteSubscribe(sessionId),
        );
      }
      // Solo cuando la suscripción es nueva. Un reenvío no cambia quién está
      // en vivo, y avisar igualmente recreaba el valor del contexto, que
      // relanzaba el efecto que llama aquí: bucle infinito y la app caída.
      if (isNew) {
        bump();
      }
    },
    [bump],
  );

  const addListener = useCallback((listener: FrameListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const send = useCallback((serverId: string, payload: unknown) => {
    const socket = sockets.current.get(serverId);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const statusOf = useCallback(
    (serverId: string) => statuses.current.get(serverId) ?? 'closed',
    [],
  );

  const isLive = useCallback(
    (serverId: string, sessionId: string) =>
      statuses.current.get(serverId) === 'open' &&
      (subscriptions.current.get(serverId)?.has(sessionId) ?? false),
    [],
  );

  const value = useMemo<SocketApi>(
    () => ({ subscribe, addListener, send, statusOf, isLive, revision }),
    [subscribe, addListener, send, statusOf, isLive, revision],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSockets(): SocketApi {
  const value = useContext(SocketContext);
  if (value === null) {
    throw new Error('useSockets requiere un <SocketProvider>');
  }
  return value;
}
