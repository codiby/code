import { useCallback, useEffect, useRef, useState } from 'react';

import { ServerError } from './client';
import type { ConnectionState } from './types';

export interface UseRequestResult<T> {
  readonly state: ConnectionState<T>;
  readonly refresh: () => void;
}

/**
 * Ejecuta `run` cuando cambian sus dependencias y bajo demanda. Descarta
 * respuestas de una petición que ya quedó obsoleta, para que cambiar la IP a
 * media petición no pinte el resultado viejo.
 */
export function useRequest<T>(
  run: () => Promise<T>,
  enabled: boolean = true,
): UseRequestResult<T> {
  const [state, setState] = useState<ConnectionState<T>>({
    status: 'idle',
    data: null,
    error: null,
    checkedAt: null,
  });
  const requestIdRef = useRef(0);

  const execute = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState(previous => ({ ...previous, status: 'checking', error: null }));

    try {
      const data = await run();
      if (requestId === requestIdRef.current) {
        setState({ status: 'connected', data, error: null, checkedAt: Date.now() });
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setState({
          status: 'error',
          data: null,
          error:
            error instanceof ServerError ? error.message : 'Error desconocido',
          checkedAt: Date.now(),
        });
      }
    }
  }, [run]);

  // `execute` captura sus propios errores y nunca rechaza.
  useEffect(() => {
    if (enabled) {
      execute();
    }
  }, [execute, enabled]);

  const refresh = useCallback(() => {
    execute();
  }, [execute]);

  return { state, refresh };
}
