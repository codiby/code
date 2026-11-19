import { createContext } from 'react';

/**
 * Cómo mandar un mensaje del usuario desde dentro de una respuesta del agente
 * (hoy: la opción elegida en un `cx-choice` de un bloque ```ui).
 *
 * Va por contexto por la misma razón que `SessionLinkContext`: el Markdown
 * está muy abajo y quien sabe enviar es la pantalla del chat. `null` deja el
 * botón deshabilitado, p. ej. en el plan o en el resumen de un subagente.
 */
export const SendMessageContext = createContext<
  ((text: string) => void) | null
>(null);
