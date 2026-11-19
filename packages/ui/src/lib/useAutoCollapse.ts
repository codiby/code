import { useEffect, useRef, useState } from 'react';

/** True while the viewport is narrower than `maxWidth` pixels. */
export function useNarrowViewport(maxWidth: number): boolean {
  const query = `(max-width: ${maxWidth - 1}px)`;
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

/**
 * Collapses a panel when the window gets narrower than `maxWidth`, and puts
 * back whatever state it had once the window is wide again. Only the edge
 * fires, so the user can still open the panel by hand while the window is
 * narrow.
 */
export function useAutoCollapse(
  maxWidth: number,
  collapsed: boolean,
  setCollapsed: (collapsed: boolean) => void,
): void {
  const narrow = useNarrowViewport(maxWidth);
  const before = useRef<boolean | null>(null);
  const latest = useRef(collapsed);
  latest.current = collapsed;
  useEffect(() => {
    if (narrow) {
      before.current = latest.current;
      if (!latest.current) setCollapsed(true);
    } else if (before.current !== null) {
      if (latest.current !== before.current) setCollapsed(before.current);
      before.current = null;
    }
    // setCollapsed is a state setter; only the narrow/wide edge matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
}
