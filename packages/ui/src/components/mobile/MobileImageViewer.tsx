import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X as XIcon } from 'lucide-react';
import { Button } from '@heroui/react';

interface Props {
  src: string | null;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 28;

type Pointer = { id: number; x: number; y: number };

/**
 * Fullscreen image viewer for mobile. Tap backdrop / X to dismiss; pinch to
 * zoom (1x–6x); drag to pan when zoomed; double-tap toggles between fit and
 * 2.5x centered on the tap point.
 *
 * Hand-rolled pointer handling (rather than CSS touch-action: pinch-zoom)
 * because the webview viewport disables document-level pinch — and we want
 * the gesture scoped to the image, not the whole UI.
 */
export function MobileImageViewer({ src, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, Pointer>>(new Map());
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; scale: number; cx: number; cy: number; tx: number; ty: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const movedRef = useRef(false);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  // Reset transform whenever a new image is shown.
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    pointersRef.current.clear();
    pinchStartRef.current = null;
    panStartRef.current = null;
    lastTapRef.current = null;
    movedRef.current = false;
  }, [src]);

  // Esc closes on desktop browsers / keyboards attached to the phone.
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  // Wheel-to-zoom for mouse + trackpad. Anchored on the cursor so the point
  // under the wheel stays under the wheel — same UX as image editors. We
  // capture-phase listen on document so preventDefault cancels native page
  // scrolling even though React's onWheel is passive.
  useEffect(() => {
    if (!src) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!el.contains(e.target as Node)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      // deltaY > 0 = scroll down = zoom out. ~10% per tick on a normal mouse;
      // trackpads send many small deltas so the same factor feels smooth.
      const factor = Math.exp(-e.deltaY * 0.0025);
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
        const ratio = next / prev - 1;
        const nx = tx - cx * ratio;
        const ny = ty - cy * ratio;
        const clamped = clampPan(nx, ny, next);
        setTx(clamped.x);
        setTy(clamped.y);
        return next;
      });
    };
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => document.removeEventListener('wheel', onWheel);
  }, [src, tx, ty]);

  // Lock body scroll while open so a one-finger pan inside the viewer doesn't
  // bubble up and scroll the chat behind it.
  useEffect(() => {
    if (!src) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [src]);

  // Electron BrowserViews are native windows that always render above the
  // renderer. Tell their React hosts to hide the active view while this
  // DOM-based fullscreen overlay is open.
  useEffect(() => {
    if (!src) return;
    document.dispatchEvent(new CustomEvent('codiby:image-viewer', { detail: true }));
    return () => document.dispatchEvent(new CustomEvent('codiby:image-viewer', { detail: false }));
  }, [src]);

  if (!src) return null;

  const clampPan = (nx: number, ny: number, s: number) => {
    const el = containerRef.current;
    if (!el) return { x: nx, y: ny };
    const w = el.clientWidth;
    const h = el.clientHeight;
    // The image is centered + scaled; the rendered overflow on each axis is
    // (s - 1) * (axis / 2). Allow translation up to that overflow so the user
    // can reach every edge but can't drag the image off the canvas.
    const maxX = Math.max(0, ((s - 1) * w) / 2);
    const maxY = Math.max(0, ((s - 1) * h) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, nx)),
      y: Math.max(-maxY, Math.min(maxY, ny)),
    };
  };

  const setTransform = (nx: number, ny: number, s: number) => {
    const clamped = clampPan(nx, ny, s);
    setScale(s);
    setTx(clamped.x);
    setTy(clamped.y);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY });
    movedRef.current = false;

    const pts = [...pointersRef.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      pinchStartRef.current = {
        dist,
        scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        tx,
        ty,
      };
      panStartRef.current = null;
    } else if (pts.length === 1) {
      panStartRef.current = { x: pts[0].x, y: pts[0].y, tx, ty };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const existing = pointersRef.current.get(e.pointerId);
    if (!existing) return;
    existing.x = e.clientX;
    existing.y = e.clientY;

    const pts = [...pointersRef.current.values()];
    if (pts.length === 2 && pinchStartRef.current) {
      const [a, b] = pts;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const start = pinchStartRef.current;
      const ratio = dist / Math.max(1, start.dist);
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.scale * ratio));
      // Keep the pinch midpoint anchored: translate by how the midpoint
      // would otherwise drift under the new scale.
      const cxNow = (a.x + b.x) / 2;
      const cyNow = (a.y + b.y) / 2;
      const dx = cxNow - start.cx;
      const dy = cyNow - start.cy;
      const el = containerRef.current;
      const w = el?.clientWidth ?? 0;
      const h = el?.clientHeight ?? 0;
      // Shift origin so zoom centers on the original midpoint relative to
      // canvas center, then add finger drift.
      const ox = start.cx - w / 2;
      const oy = start.cy - h / 2;
      const factor = nextScale / start.scale - 1;
      setTransform(start.tx - ox * factor + dx, start.ty - oy * factor + dy, nextScale);
      movedRef.current = true;
    } else if (pts.length === 1 && panStartRef.current) {
      const start = panStartRef.current;
      const dx = pts[0].x - start.x;
      const dy = pts[0].y - start.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true;
      // Allow panning only when zoomed in; at scale 1 the image fits, so a
      // drag is an intent to dismiss / dead.
      if (scale > 1.001) {
        setTransform(start.tx + dx, start.ty + dy, scale);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchStartRef.current = null;
    if (pointersRef.current.size === 0) panStartRef.current = null;

    // Double-tap detection — only when no pinch happened and the finger
    // didn't move appreciably.
    if (!movedRef.current && pointersRef.current.size === 0) {
      const now = Date.now();
      const last = lastTapRef.current;
      if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX) {
        const el = containerRef.current;
        const w = el?.clientWidth ?? 0;
        const h = el?.clientHeight ?? 0;
        if (scale > 1.001) {
          setTransform(0, 0, 1);
        } else {
          const next = 2.5;
          const ox = e.clientX - w / 2;
          const oy = e.clientY - h / 2;
          setTransform(-ox * (next - 1), -oy * (next - 1), next);
        }
        lastTapRef.current = null;
      } else {
        lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  };

  const handleBackdropClick = () => {
    // Single tap on backdrop closes — but only if we're at fit scale and the
    // user wasn't in the middle of a gesture. Avoid closing right after a
    // pinch-end where a stray tap synthesizes.
    if (scale <= 1.001 && !movedRef.current) onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/95 flex items-center justify-center"
      style={{ touchAction: 'none', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={handleBackdropClick}
    >
      <span
        onClick={(e) => e.stopPropagation()}
        className="absolute top-3 right-3 z-10"
        style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={onClose}
          className="w-9 h-9 min-w-0 rounded-full bg-zinc-900/70 border border-white/10 text-zinc-200 flex items-center justify-center active:bg-zinc-800"
          style={{
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          }}
          aria-label="Close image"
        >
          <XIcon size={18} />
        </Button>
      </span>

      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden flex items-center justify-center"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="max-w-full max-h-full object-contain select-none"
          style={{
            transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
            transformOrigin: 'center center',
            transition: pointersRef.current.size === 0 ? 'transform 120ms ease-out' : 'none',
            willChange: 'transform',
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
