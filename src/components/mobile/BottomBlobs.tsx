interface BottomBlobsProps {
  /** Pixel height to render the blob container at. Should match whichever
   *  glass pill is currently overhead — the navbar (~62 px) or the composer
   *  (variable when chrome is hidden). */
  heightPx: number;
  /** When false the color spot fades out — used as the "Claude is working"
   *  indicator (visible only while the active session is streaming). */
  visible: boolean;
}

/**
 * Single ambient color spot drifting behind whichever glass pill currently
 * sits at the bottom of the screen — navbar when chrome is visible, composer
 * when chrome is hidden. Doubles as a streaming indicator: it fades in while
 * Claude is generating a response and fades out when the turn completes.
 *
 * Two combined animations on the spot itself:
 *   - `blob-drift`: gentle left↔right horizontal drift (18s loop)
 *   - `blob-hue`:   continuous hue-rotation (20s loop)
 *
 * Pointer-events disabled so the spot never intercepts taps.
 */
export function BottomBlobs({ heightPx, visible }: BottomBlobsProps) {
  return (
    <div
      aria-hidden
      className="fixed left-3 right-3 z-20 rounded-[1.625rem] overflow-hidden pointer-events-none transition-[height,opacity] duration-300 ease-out"
      style={{
        bottom: 'calc(0.75rem + env(safe-area-inset-bottom))',
        height: `${heightPx}px`,
        opacity: visible ? 1 : 0,
      }}
    >
      <div
        className="blob-single absolute rounded-full"
        style={{
          left: '50%',
          top: '50%',
          width: '14rem',
          height: '14rem',
          background:
            'radial-gradient(circle, rgba(99,102,241,0.85) 0%, rgba(99,102,241,0) 70%)',
        }}
      />
    </div>
  );
}
