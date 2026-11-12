import { useColorScheme } from 'nativewind';
import { useCallback } from 'react';

import { INK_DARK, INK_LIGHT } from './themeInk';

export function useIsDark(): boolean {
  return useColorScheme().colorScheme === 'dark';
}

/**
 * Para colores que no pasan por `className` (iconos, spinners): traduce los
 * hex de `slate` a la paleta neutra de cada tema, y aclara los acentos en
 * oscuro. Un color sin equivalente se devuelve tal cual.
 */
export function useInk(): (hex: string) => string {
  const dark = useIsDark();
  return useCallback(
    (hex: string) =>
      (dark ? INK_DARK : INK_LIGHT)[hex.toLowerCase()] ?? hex,
    [dark],
  );
}
