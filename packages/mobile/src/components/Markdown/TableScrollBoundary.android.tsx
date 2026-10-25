import { requireNativeComponent, type ViewProps } from 'react-native';

/** Decide el eje en el hilo nativo antes de que el chat intercepte el toque. */
export const TableScrollBoundary = requireNativeComponent<ViewProps>(
  'CodibyTableScrollBoundary',
);
