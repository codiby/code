export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

/** Keep the image point beneath an anchor fixed as the scale changes. */
export function zoomAt(
  transform: { scale: number; x: number; y: number },
  nextScale: number,
  anchor: { x: number; y: number },
) {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  const ratio = scale / transform.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}
