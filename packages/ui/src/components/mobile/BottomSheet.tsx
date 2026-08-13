import { useEffect, useRef, useState } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@heroui/react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Max height as a viewport-height fraction (0–1). Default 0.85. */
  maxHeight?: number;
  /** Block text selection across the whole sheet. Set it on sheets opened by
   *  a long press: the finger is still down when the sheet slides up under
   *  it, so the gesture carries on into whatever text lands beneath — which
   *  Android turns into a selection plus its dictionary/"Search with Google"
   *  bar right on top of the sheet. */
  noSelect?: boolean;
}

/**
 * A swipe-down-to-dismiss bottom sheet. Uses pointer events so it works on
 * both touch and mouse. Keeps the body fixed while open to prevent the page
 * underneath from scrolling.
 */
export function BottomSheet({ open, onClose, title, children, maxHeight = 0.85, noSelect }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef<{ y: number; t: number } | null>(null);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Reset drag state on each open
  useEffect(() => { if (open) setDragY(0); }, [open]);

  const onPointerDown = (e: ReactPointerEvent) => {
    dragStartRef.current = { y: e.clientY, t: Date.now() };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const dy = e.clientY - dragStartRef.current.y;
    setDragY(dy > 0 ? dy : 0);
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    const dy = e.clientY - dragStartRef.current.y;
    const dt = Date.now() - dragStartRef.current.t;
    const velocity = dt > 0 ? dy / dt : 0;
    dragStartRef.current = null;
    if (dy > 120 || velocity > 0.6) {
      onClose();
    } else {
      setDragY(0);
    }
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop. A plain div on purpose: as a HeroUI <Button> its own width
          rules beat `inset-0`, so it rendered as a ~32px strip down the left
          edge — a black band over the page, and a backdrop that only closed
          the sheet if you happened to tap those 32px. The sheet stays
          dismissable via its × button and swipe-down, so the backdrop is
          decorative to assistive tech. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 w-full h-full bg-black/60 backdrop-blur-sm transition-opacity"
        style={{ opacity: 1 - Math.min(dragY / 400, 0.4) }}
      />
      {/* Sheet */}
      <div
        ref={sheetRef}
        className={`absolute inset-x-0 bottom-0 rounded-t-3xl bg-zinc-950 border-t border-white/10 shadow-2xl flex flex-col ${
          noSelect ? 'select-none [-webkit-touch-callout:none]' : ''
        }`}
        style={{
          maxHeight: `${maxHeight * 100}vh`,
          transform: `translateY(${dragY}px)`,
          transition: dragStartRef.current ? 'none' : 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {/* Drag handle (pointer-event surface) */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="pt-2 pb-1 flex items-center justify-center cursor-grab touch-none select-none"
          style={{ touchAction: 'none' }}
        >
          <div className="w-10 h-1.5 rounded-full bg-white/20" />
        </div>
        {title && (
          <div className="px-5 pb-3 pt-1 flex items-center justify-between">
            {/* Never worth selecting, and it's what sits under the finger
                when a long press opens the sheet. */}
            <h2 className="text-base font-semibold text-zinc-100 select-none [-webkit-touch-callout:none]">{title}</h2>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onClose}
              className="w-8 h-8 min-w-0 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-zinc-200 text-lg"
              aria-label="Close"
            >
              ×
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}
