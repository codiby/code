import { useState } from 'react';

interface Props {
  /** Absolute path of the image — used only for the header/title. */
  path: string;
  /** `data:` URL (or any <img>-compatible src) with the image bytes. */
  src: string;
  onClose?: () => void;
  onReveal?: () => void;
}

/**
 * Read-only preview tab for image files (png/jpg/svg/…). Opened from the file
 * explorer / changes tree in place of the Monaco text editor. Shows the image
 * fit-to-window over a checkerboard; click toggles between fit and 1:1.
 */
export function ImagePreview({ path, src, onClose, onReveal }: Props) {
  const [actualSize, setActualSize] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState(false);
  const name = path.split('/').pop() || path;

  return (
    <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface">
        <div className="flex items-center gap-2 truncate">
          <span className="text-[12px] font-mono truncate text-zinc-400">{name}</span>
          {dims && (
            <span className="text-[11px] text-zinc-600 shrink-0">{dims.w}&times;{dims.h}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            className="text-[11px] px-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
            onClick={() => setActualSize(v => !v)}
            title={actualSize ? 'Fit to window' : 'Actual size (1:1)'}
          >
            {actualSize ? 'Fit' : '1:1'}
          </button>
          {onReveal && (
            <button
              className="text-[11px] px-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
              onClick={onReveal}
              title="Reveal in Finder"
            >
              Reveal
            </button>
          )}
          {onClose && (
            <button
              className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
              onClick={onClose}
              title="Close"
            >
              &times;
            </button>
          )}
        </div>
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4"
        style={{
          backgroundColor: '#1a1a1a',
          backgroundImage:
            'linear-gradient(45deg, #262626 25%, transparent 25%), linear-gradient(-45deg, #262626 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #262626 75%), linear-gradient(-45deg, transparent 75%, #262626 75%)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
        }}
      >
        {error ? (
          <div className="text-[12px] text-zinc-500">Cannot display image.</div>
        ) : (
          <img
            src={src}
            alt={name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setError(true)}
            onClick={() => setActualSize(v => !v)}
            className={actualSize ? 'cursor-zoom-out' : 'max-w-full max-h-full object-contain cursor-zoom-in'}
            style={{ imageRendering: 'auto' }}
          />
        )}
      </div>
    </div>
  );
}
