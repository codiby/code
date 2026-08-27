import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy as CopyIcon,
  Download as DownloadIcon,
  ExternalLink,
  File as FileIcon,
  FileText,
  LayoutGrid,
  Link2 as LinkIcon,
  X as XIcon,
} from 'lucide-react';
import { Button } from '@heroui/react';
import {
  copyAddress,
  copyImageToClipboard,
  copyText,
  humanSize,
  previewFileName,
  saveToDisk,
  type Gallery,
  type PreviewItem,
  type PreviewKind,
} from '../lib/preview';

interface Props {
  /** What to show, plus everything the filmstrip can walk. Null when closed. */
  gallery: Gallery | null;
  /** Show a different item of the same gallery. */
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 28;
/** Height the filmstrip reserves at the bottom, so it never covers the item. */
const STRIP_H = 92;

type Pointer = { id: number; x: number; y: number };
type Menu = { x: number; y: number };

/**
 * Fullscreen previewer, shared by the desktop chat, the mobile chat and the
 * Resources drawer. It renders whatever the item is — image, PDF, HTML mockup,
 * or an opaque file — and carries a filmstrip of everything else in the same
 * gallery, so one place answers "show me this, and let me flip through the
 * rest".
 *
 * Images get the full gesture treatment: pinch to zoom (1x–6x), drag to pan
 * when zoomed, double-tap between fit and 2.5x centered on the tap point,
 * wheel/trackpad zoom anchored on the cursor. PDFs and mockups render in an
 * iframe and own their own scrolling, so the gestures stay off them.
 *
 * Hand-rolled pointer handling (rather than CSS touch-action: pinch-zoom)
 * because the webview viewport disables document-level pinch — and we want
 * the gesture scoped to the image, not the whole UI.
 */
export function FullscreenPreview({ gallery, onIndexChange, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeThumbRef = useRef<HTMLButtonElement | null>(null);
  const pointersRef = useRef<Map<number, Pointer>>(new Map());
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const pinchStartRef = useRef<{ dist: number; scale: number; cx: number; cy: number; tx: number; ty: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const movedRef = useRef(false);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const items = gallery?.items ?? [];
  const index = gallery?.index ?? 0;
  const item = gallery ? items[index] ?? null : null;
  const src = item?.src ?? null;
  const isImage = item?.kind === 'image';
  const hasStrip = items.length > 1;

  // Reset transform whenever a new item is shown.
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    pointersRef.current.clear();
    pinchStartRef.current = null;
    panStartRef.current = null;
    lastTapRef.current = null;
    movedRef.current = false;
    // The menu points at the item it was opened over; keeping it around after
    // a step would act on the wrong one.
    setMenu(null);
  }, [src]);

  // Esc closes (the menu first, then the viewer); arrows walk the gallery.
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) setMenu(null);
        else onClose();
        return;
      }
      if (!hasStrip) return;
      // An iframed mockup or PDF has focus of its own; only steal the arrows
      // when the key actually landed on the viewer chrome.
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIndexChange((index - 1 + items.length) % items.length);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIndexChange((index + 1) % items.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, menu, hasStrip, index, items.length, onIndexChange, onClose]);

  // Wheel-to-zoom for mouse + trackpad. Anchored on the cursor so the point
  // under the wheel stays under the wheel — same UX as image editors. We
  // capture-phase listen on document so preventDefault cancels native page
  // scrolling even though React's onWheel is passive. Images only: a PDF or a
  // mockup scrolls inside its own iframe.
  useEffect(() => {
    if (!src || !isImage) return;
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
  }, [src, isImage, tx, ty]);

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
    return () => { document.dispatchEvent(new CustomEvent('codiby:image-viewer', { detail: false })); };
  }, [src]);

  // Keep the current thumbnail in view as the gallery is walked.
  useEffect(() => {
    if (!hasStrip) return;
    activeThumbRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [src, hasStrip]);

  // Nudge the menu back inside the viewport once its real size is known —
  // a right-click near the bottom-right edge would otherwise open off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (x !== menu.x || y !== menu.y) setMenu({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [menu]);

  // Transient confirmation ("Copied", or the reason it failed).
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  if (!item || !src) return null;

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

  const step = (delta: number) => {
    if (!hasStrip) return;
    onIndexChange((index + delta + items.length) % items.length);
  };

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setMenu(null);
    try {
      await fn();
      setFlash(label);
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Right-click is for the context menu — never let it start a pan, or the
    // pointer capture swallows the gesture that follows.
    if (e.button === 2) return;
    if (menu) setMenu(null);
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
    if (menu) { setMenu(null); return; }
    // A click that lands on the empty space around the item dismisses — but
    // not at the tail of a pan/pinch, where a stray click synthesizes.
    if (scale <= 1.001 && !movedRef.current) onClose();
  };

  // preventDefault here also suppresses Electron's native `context-menu` event,
  // so the in-app menu is the only one that shows — and it's the only one the
  // browser and mobile builds have at all.
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const glass = {
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
  } as React.CSSProperties;

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const name = item.name ?? previewFileName(item, index);
  const openExternally = () => window.open(src, '_blank', 'noopener');

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/95 flex items-center justify-center"
      style={{ touchAction: 'none', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={handleBackdropClick}
      onContextMenu={handleContextMenu}
    >
      {/* Header — name, size and position, then the close button. */}
      <div
        className="absolute top-0 left-0 right-0 z-10 flex items-center gap-3 px-4 pointer-events-none"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <div className="min-w-0 flex items-baseline gap-2">
          <span className="text-[12.5px] text-zinc-200 truncate max-w-[46vw]" title={name}>{name}</span>
          {item.size != null && <span className="text-[11px] text-zinc-500 shrink-0">{humanSize(item.size)}</span>}
          {hasStrip && <span className="text-[11px] tabular-nums text-zinc-500 shrink-0">{index + 1} / {items.length}</span>}
        </div>
        <span
          onClick={stop}
          className="ml-auto pointer-events-auto"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onClose}
            className="w-9 h-9 min-w-0 rounded-full bg-zinc-900/70 border border-white/10 text-zinc-200 flex items-center justify-center active:bg-zinc-800"
            style={glass}
            aria-label="Close preview"
          >
            <XIcon size={18} />
          </Button>
        </span>
      </div>

      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden flex items-center justify-center px-4"
        style={{ paddingTop: 56, paddingBottom: hasStrip ? STRIP_H : 24 }}
        onPointerDown={isImage ? handlePointerDown : undefined}
        onPointerMove={isImage ? handlePointerMove : undefined}
        onPointerUp={isImage ? handlePointerUp : undefined}
        onPointerCancel={isImage ? handlePointerUp : undefined}
      >
        {item.kind === 'image' && (
          <img
            src={src}
            alt=""
            draggable={false}
            onClick={stop}
            className="max-w-full max-h-full object-contain select-none"
            style={{
              transform: `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`,
              transformOrigin: 'center center',
              transition: pointersRef.current.size === 0 ? 'transform 120ms ease-out' : 'none',
              willChange: 'transform',
            }}
          />
        )}

        {(item.kind === 'pdf' || item.kind === 'html') && (
          <div className="w-full h-full max-w-[1100px]" onClick={stop}>
            <iframe
              // Remount on navigation: an iframe kept across src changes holds
              // the old document's scroll position and, for PDFs, its viewer
              // state.
              key={src}
              src={item.kind === 'pdf' ? `${src}#view=FitH` : src}
              title={name}
              // A mockup is agent-generated markup — same containment the
              // Resources drawer already used for it. PDFs render in
              // Chromium's own viewer, which needs no scripting.
              sandbox={item.kind === 'html' ? 'allow-scripts' : undefined}
              className="w-full h-full rounded-lg bg-white border border-white/10"
              style={{ touchAction: 'auto' }}
            />
          </div>
        )}

        {item.kind === 'file' && (
          <div
            onClick={stop}
            className="flex flex-col items-center gap-4 px-8 py-10 rounded-2xl bg-zinc-900/70 border border-white/10"
            style={glass}
          >
            <FileIcon size={44} className="text-zinc-500" strokeWidth={1.4} />
            <div className="text-center">
              <div className="text-[13px] text-zinc-200 max-w-[60vw] truncate">{name}</div>
              <div className="text-[11px] text-zinc-500 mt-1">
                {item.mime || 'unknown type'}{item.size != null ? ` · ${humanSize(item.size)}` : ''}
              </div>
            </div>
            <div className="flex gap-2">
              <ActionButton icon={<DownloadIcon size={13} />} label="Save…"
                onClick={() => void runAction('Saved', () => saveToDisk(src, previewFileName(item, index)))} />
              <ActionButton icon={<ExternalLink size={13} />} label="Open" onClick={openExternally} />
            </div>
          </div>
        )}
      </div>

      {hasStrip && (
        <>
          {([['prev', -1], ['next', 1]] as const).map(([which, delta]) => (
            <button
              key={which}
              type="button"
              onClick={(e) => { e.stopPropagation(); step(delta); }}
              className={`absolute top-1/2 -translate-y-1/2 ${which === 'prev' ? 'left-3' : 'right-3'} w-10 h-10 rounded-full bg-zinc-900/70 border border-white/10 text-zinc-200 hover:text-white hover:bg-zinc-800/80 flex items-center justify-center transition-colors`}
              style={{ ...glass, marginTop: -STRIP_H / 2 }}
              aria-label={which === 'prev' ? 'Previous' : 'Next'}
            >
              {which === 'prev' ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
            </button>
          ))}

          <div
            className="absolute left-0 right-0 bottom-0 flex justify-center px-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
            onClick={stop}
          >
            <div
              className="flex gap-1.5 max-w-full overflow-x-auto px-2 py-2 rounded-2xl bg-zinc-900/70 border border-white/10"
              style={{ ...glass, scrollbarWidth: 'none' }}
            >
              {items.map((it, i) => (
                <button
                  key={`${i}:${it.src.slice(-24)}`}
                  ref={i === index ? activeThumbRef : undefined}
                  type="button"
                  onClick={() => onIndexChange(i)}
                  title={it.name}
                  className={`shrink-0 w-12 h-12 rounded-lg overflow-hidden border transition-all ${
                    i === index
                      ? 'border-white/80 opacity-100 scale-100'
                      : 'border-white/10 opacity-50 hover:opacity-90 scale-95'
                  }`}
                  aria-label={it.name ?? `Item ${i + 1} of ${items.length}`}
                  aria-current={i === index}
                >
                  <Thumb item={it} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {flash && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full bg-zinc-900/85 border border-white/10 text-[12px] text-zinc-200 pointer-events-none"
          style={{ ...glass, top: 'calc(env(safe-area-inset-top) + 3.5rem)' }}
        >
          {flash}
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[10001] bg-surface border border-white/10 rounded-lg shadow-xl min-w-[190px] py-1"
          style={{ top: menu.y, left: menu.x }}
          onClick={stop}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {item.kind === 'image' && (
            <MenuItem
              icon={<CopyIcon size={12} />}
              label="Copy Image"
              onClick={() => void runAction('Copied to clipboard', () => copyImageToClipboard(src))}
            />
          )}
          {item.kind === 'html' && (
            <MenuItem
              icon={<Code2 size={12} />}
              label="Copy HTML"
              onClick={() => void runAction('Markup copied', () => copyText(src))}
            />
          )}
          <MenuItem
            icon={<DownloadIcon size={12} />}
            label="Save As…"
            onClick={() => void runAction('Saved', () => saveToDisk(src, previewFileName(item, index)))}
          />
          {!src.startsWith('data:') && (
            <>
              <MenuItem icon={<ExternalLink size={12} />} label="Open in Browser" onClick={() => { setMenu(null); openExternally(); }} />
              <MenuItem
                icon={<LinkIcon size={12} />}
                label="Copy Address"
                onClick={() => void runAction('Address copied', () => copyAddress(src))}
              />
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Filmstrip cell — the bitmap for images, a kind glyph for everything else. */
function Thumb({ item }: { item: PreviewItem }) {
  if (item.kind === 'image') {
    return <img src={item.src} alt="" draggable={false} className="w-full h-full object-cover" />;
  }
  const Glyph = KIND_GLYPH[item.kind];
  return (
    <span className="w-full h-full flex items-center justify-center bg-zinc-800/80">
      <Glyph.icon size={18} className={Glyph.className} strokeWidth={1.5} />
    </span>
  );
}

const KIND_GLYPH: Record<Exclude<PreviewKind, 'image'>, { icon: typeof FileText; className: string }> = {
  pdf: { icon: FileText, className: 'text-rose-300/80' },
  html: { icon: LayoutGrid, className: 'text-violet-300/80' },
  file: { icon: FileIcon, className: 'text-amber-300/80' },
};

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-white/5 hover:text-zinc-100 transition-colors text-left"
    >
      <span className="text-zinc-500 shrink-0">{icon}</span>
      {label}
    </button>
  );
}

function ActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] bg-white/5 border border-white/10 text-zinc-200 hover:bg-white/10 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
