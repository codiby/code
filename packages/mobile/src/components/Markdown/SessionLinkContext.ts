import { createContext } from 'react';

/**
 * Qué hacer al tocar un enlace `codiby-session:<id>`.
 *
 * Va por contexto porque el Markdown está muy abajo —burbuja, grupo de
 * herramientas, tabla— y quien sabe abrir una sesión es `App`. `null` deja el
 * chip como texto, igual que antes.
 */
export const SessionLinkContext = createContext<((id: string) => void) | null>(
  null,
);
