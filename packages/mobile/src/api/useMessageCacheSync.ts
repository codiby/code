import { useEffect } from 'react';

import { appendMessage } from './messageStore';
import { parseLiveMessage } from './messages';
import { useSockets, type Frame } from './SocketProvider';

/**
 * Mantiene la caché de mensajes al día mientras no estás en el chat.
 *
 * Se monta una sola vez, arriba del todo. Es lo que hace que volver a una
 * conversación sea instantáneo *y* correcto: como el socket es compartido y la
 * suscripción no se retira al salir, los mensajes de las sesiones que ya
 * visitaste siguen llegando, y aquí se guardan aunque estés en el Home.
 *
 * Sin esto, la caché quedaría congelada en el momento de salir y al volver
 * mostraría una conversación vieja hasta que la recarga la corrigiera — que es
 * justo el parpadeo que se quería quitar.
 */
export function useMessageCacheSync() {
  const sockets = useSockets();

  useEffect(
    () =>
      sockets.addListener((serverId: string, frame: Frame) => {
        if (frame.type !== 'message') {
          return;
        }
        const rawId = frame.sessionId;
        if (typeof rawId !== 'string') {
          return;
        }
        const message = parseLiveMessage(frame.message);
        if (message !== null) {
          // Misma razón que en el resto: la clave lleva el servidor.
          appendMessage(`${serverId}:${rawId}`, message);
        }
      }),
    [sockets],
  );
}
