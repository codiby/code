import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Whether the app is in front. `inactive` (iOS, a passing state while the
 * app switcher or a system sheet is up) still counts as in front: only
 * `background` means nobody is looking.
 */
export function isActiveState(state: AppStateStatus | string | null | undefined): boolean {
  return state !== 'background';
}

/**
 * Network work that only matters on screen — route probes, the interface's
 * sockets — keys off this. Phone access keeps the process alive in the
 * background, so without it they kept running with the app closed.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => isActiveState(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => setActive(isActiveState(next)));
    return () => sub.remove();
  }, []);
  return active;
}
