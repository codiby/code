/**
 * Detects when DOM UI is painted over a browser-preview host element.
 *
 * The preview page is a native `WebContentsView` that Electron paints above
 * the whole renderer, so no CSS z-index can put a menu, modal, toast or
 * tooltip on top of it. Instead of every overlay registering itself (the
 * old `obscured={showPalette || …}` list), we ask the DOM: sample a grid of
 * points over the host and hit-test each one. If the topmost element at any
 * point is not the host or one of its descendants, something covers the
 * page and the native view must step aside for its screenshot placeholder.
 *
 * Same idea as VS Code's integrated browser (`overlayManager.ts`), which
 * hit-tests the overlap centre of known overlay classes. Hit-testing every
 * sample point instead means new UI needs no registration at all.
 *
 * Two DOM facts shape the checks:
 *  - Hit-testing skips `pointer-events: none` elements (most tooltips), so
 *    elements marked `role="tooltip"` or `data-codiby-overlay` are also
 *    checked by plain rectangle overlap.
 *  - Popovers often put a transparent full-screen click-catcher above
 *    everything. Such a layer doesn't hide the page, so fully transparent
 *    elements are skipped and the hit-test looks at what lies beneath.
 */

export type Rect = { left: number; top: number; width: number; height: number };

/** Inset sample points over `rect`: a `cols`×`rows` grid plus the centre. */
export function samplePoints(rect: Rect, cols = 5, rows = 4, inset = 3): Array<{ x: number; y: number }> {
  if (rect.width <= inset * 2 || rect.height <= inset * 2) return [];
  const points: Array<{ x: number; y: number }> = [];
  const w = rect.width - inset * 2;
  const h = rect.height - inset * 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push({
        x: rect.left + inset + (cols === 1 ? w / 2 : (w * c) / (cols - 1)),
        y: rect.top + inset + (rows === 1 ? h / 2 : (h * r) / (rows - 1)),
      });
    }
  }
  points.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  return points;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
}

function isTransparentColor(color: string): boolean {
  if (!color || color === 'transparent') return true;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1]!.split(/[ ,/]+/).filter(Boolean);
  return parts.length >= 4 && parseFloat(parts[3]!) === 0;
}

/** True for a layer that paints nothing of its own: no background, border,
 *  shadow, backdrop filter or direct text — e.g. a popover's click-catcher
 *  or a full-screen flex wrapper that only positions a dialog. Replaced
 *  elements (img, video, canvas, svg, inputs) always paint. */
export function paintsNothing(el: Element, style: CSSStyleDeclaration): boolean {
  if (/^(IMG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) return false;
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') return false;
  if (!isTransparentColor(style.backgroundColor)) return false;
  if (style.backgroundImage && style.backgroundImage !== 'none') return false;
  if (style.boxShadow && style.boxShadow !== 'none') return false;
  const backdrop = style.backdropFilter || (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
  if (backdrop && backdrop !== 'none') return false;
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    if (parseFloat(style[`border${side}Width`]) > 0 && !isTransparentColor(style[`border${side}Color`])) return false;
  }
  for (const node of el.childNodes) {
    if (node.nodeType === 3 /* TEXT_NODE */ && node.textContent?.trim()) return false;
  }
  return true;
}

function isRendered(style: CSSStyleDeclaration): boolean {
  return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
}

const UNHITTABLE_OVERLAYS = '[role="tooltip"], [data-codiby-overlay]';

/** Whether any DOM UI is currently painted over `host`. */
export function isHostObscured(host: HTMLElement, doc: Document = host.ownerDocument): boolean {
  const r = host.getBoundingClientRect();
  const rect: Rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  const view = doc.defaultView!;
  const vw = view.innerWidth;
  const vh = view.innerHeight;

  for (const p of samplePoints(rect)) {
    // Off-window points can't be hit-tested (and nothing covers them).
    if (p.x < 0 || p.y < 0 || p.x >= vw || p.y >= vh) continue;
    for (const el of doc.elementsFromPoint(p.x, p.y)) {
      if (el === host || host.contains(el)) break; // the host is on top here
      if (el.contains(host)) break; // an ancestor: nothing above the host
      if (paintsNothing(el, view.getComputedStyle(el))) continue;
      return true;
    }
  }

  for (const el of doc.querySelectorAll<HTMLElement>(UNHITTABLE_OVERLAYS)) {
    if (el.contains(host) || host.contains(el)) continue;
    const o = el.getBoundingClientRect();
    if (o.width === 0 || o.height === 0) continue;
    if (rectsOverlap(rect, { left: o.left, top: o.top, width: o.width, height: o.height }) && isRendered(view.getComputedStyle(el))) return true;
  }
  return false;
}

/**
 * Watches `host` and calls `onChange` whenever its obscured state flips.
 * DOM mutations (portals mounting, `class`/`style` toggles that open a menu
 * or start a transition) schedule one check per animation frame; `recheck`
 * lets the caller add its own triggers, e.g. the host moving. Text edits
 * (`characterData`) are ignored so a streaming chat doesn't re-run it.
 */
export function watchOcclusion(host: HTMLElement, onChange: (obscured: boolean) => void): { recheck: () => void; dispose: () => void } {
  const doc = host.ownerDocument;
  const view = doc.defaultView!;
  let current = false;
  let raf: number | null = null;
  let pending = false;
  let disposed = false;

  const run = () => {
    if (disposed || !host.isConnected) return;
    const next = isHostObscured(host, doc);
    if (next !== current) {
      current = next;
      onChange(next);
    }
  };
  // The first trigger in a frame checks right away — from a MutationObserver
  // that is before the new overlay's first paint, so the native view can be
  // gone by the time it shows. Later triggers in the same frame collapse into
  // one check on the next frame, which keeps a burst of mutations cheap.
  const recheck = () => {
    if (disposed) return;
    if (raf != null) {
      pending = true;
      return;
    }
    raf = view.requestAnimationFrame(() => {
      raf = null;
      if (pending) {
        pending = false;
        run();
      }
    });
    run();
  };

  const observer = new view.MutationObserver(recheck);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'data-state', 'data-open', 'data-entering', 'data-exiting'],
  });
  // CSS transitions/animations move overlays without touching attributes.
  doc.addEventListener('transitionend', recheck, true);
  doc.addEventListener('animationend', recheck, true);
  view.addEventListener('resize', recheck);
  recheck();

  return {
    recheck,
    dispose: () => {
      disposed = true;
      observer.disconnect();
      doc.removeEventListener('transitionend', recheck, true);
      doc.removeEventListener('animationend', recheck, true);
      view.removeEventListener('resize', recheck);
      if (raf != null) view.cancelAnimationFrame(raf);
    },
  };
}
