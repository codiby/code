import { createContext } from 'react';

/** Un toque dentro de un scroll horizontal pertenece a ese scroll hasta soltar. */
export const HorizontalScrollGestureContext = createContext<
  (() => void) | undefined
>(undefined);
