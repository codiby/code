import { describe, expect, test } from 'bun:test';
import { isHostObscured, paintsNothing, rectsOverlap, samplePoints, type Rect } from './browser-occlusion';

type FakeEl = {
  tagName: string;
  namespaceURI: string;
  childNodes: Array<{ nodeType: number; textContent: string }>;
  style: Partial<CSSStyleDeclaration>;
  rect: Rect;
  children: FakeEl[];
  parent?: FakeEl;
  contains(other: FakeEl): boolean;
  getBoundingClientRect(): Rect;
};

const TRANSPARENT: Partial<CSSStyleDeclaration> = {
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', boxShadow: 'none', backdropFilter: 'none',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  display: 'block', visibility: 'visible', opacity: '1',
};

function el(rect: Rect, style: Partial<CSSStyleDeclaration> = {}, opts: { tag?: string; text?: string } = {}): FakeEl {
  const node: FakeEl = {
    tagName: opts.tag ?? 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: opts.text ? [{ nodeType: 3, textContent: opts.text }] : [],
    style: { ...TRANSPARENT, ...style },
    rect,
    children: [],
    contains(other) {
      for (let n: FakeEl | undefined = other; n; n = n.parent) if (n === node) return true;
      return false;
    },
    getBoundingClientRect: () => rect,
  };
  return node;
}

function adopt(parent: FakeEl, child: FakeEl): FakeEl {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

const inside = (r: Rect, x: number, y: number) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;

/** A document whose stacking order is `layers`, topmost first. */
function fakeDoc(layers: FakeEl[], overlays: FakeEl[] = []) {
  return {
    defaultView: {
      innerWidth: 1000,
      innerHeight: 800,
      getComputedStyle: (e: FakeEl) => e.style,
    },
    elementsFromPoint: (x: number, y: number) => layers.filter(l => inside(l.rect, x, y)),
    querySelectorAll: () => overlays,
  } as unknown as Document;
}

const HOST_RECT: Rect = { left: 500, top: 100, width: 400, height: 600 };

function scene() {
  const root = el({ left: 0, top: 0, width: 1000, height: 800 }, { backgroundColor: 'rgb(15, 16, 18)' });
  const host = adopt(root, el(HOST_RECT));
  const placeholder = adopt(host, el(HOST_RECT, {}, { tag: 'IMG' }));
  return { root, host, placeholder };
}

describe('samplePoints', () => {
  test('covers the corners (inset) and the centre', () => {
    const pts = samplePoints({ left: 0, top: 0, width: 100, height: 50 }, 2, 2, 5);
    expect(pts).toEqual([{ x: 5, y: 5 }, { x: 95, y: 5 }, { x: 5, y: 45 }, { x: 95, y: 45 }, { x: 50, y: 25 }]);
  });
  test('empty for a collapsed host', () => {
    expect(samplePoints({ left: 0, top: 0, width: 4, height: 400 })).toEqual([]);
  });
});

describe('rectsOverlap', () => {
  test('touching edges do not overlap', () => {
    expect(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 9, top: 9, width: 10, height: 10 })).toBe(true);
  });
});

describe('paintsNothing', () => {
  const r = { left: 0, top: 0, width: 1, height: 1 };
  test('a bare transparent wrapper paints nothing', () => {
    const e = el(r);
    expect(paintsNothing(e as unknown as Element, e.style as CSSStyleDeclaration)).toBe(true);
  });
  test('backgrounds, shadows, text and images paint', () => {
    for (const e of [
      el(r, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }),
      el(r, { boxShadow: '0 4px 12px black' }),
      el(r, {}, { text: 'Delete' }),
      el(r, {}, { tag: 'IMG' }),
    ]) expect(paintsNothing(e as unknown as Element, e.style as CSSStyleDeclaration)).toBe(false);
  });
});

describe('isHostObscured', () => {
  test('nothing over the host', () => {
    const { root, host, placeholder } = scene();
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([placeholder, host, root]))).toBe(false);
  });

  test('a menu over a corner of the host', () => {
    const { root, host, placeholder } = scene();
    const menu = el({ left: 450, top: 90, width: 200, height: 150 }, { backgroundColor: 'rgb(31, 31, 31)' });
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([menu, placeholder, host, root]))).toBe(true);
  });

  test('a menu next to the host does not count', () => {
    const { root, host, placeholder } = scene();
    const menu = el({ left: 100, top: 90, width: 300, height: 400 }, { backgroundColor: 'rgb(31, 31, 31)' });
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([menu, placeholder, host, root]))).toBe(false);
  });

  test('a transparent click-catcher alone does not hide the page', () => {
    const { root, host, placeholder } = scene();
    const catcher = el({ left: 0, top: 0, width: 1000, height: 800 });
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([catcher, placeholder, host, root]))).toBe(false);
  });

  test('a modal backdrop over everything', () => {
    const { root, host, placeholder } = scene();
    const backdrop = el({ left: 0, top: 0, width: 1000, height: 800 }, { backgroundColor: 'rgba(0, 0, 0, 0.6)' });
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([backdrop, placeholder, host, root]))).toBe(true);
  });

  test('a pointer-events:none tooltip is caught by rectangle', () => {
    const { root, host, placeholder } = scene();
    const tooltip = el({ left: 480, top: 300, width: 80, height: 24 }, { backgroundColor: 'black' }, { text: 'Reload' });
    // Not in the hit-test stack: hit-testing skips pointer-events:none.
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([placeholder, host, root], [tooltip]))).toBe(true);
    tooltip.style.opacity = '0';
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([placeholder, host, root], [tooltip]))).toBe(false);
  });

  test('a dialog that contains the host does not hide it', () => {
    const root = el({ left: 0, top: 0, width: 1000, height: 800 });
    const dialog = adopt(root, el({ left: 400, top: 50, width: 550, height: 700 }, { backgroundColor: 'rgb(20, 20, 20)' }));
    const host = adopt(dialog, el(HOST_RECT));
    expect(isHostObscured(host as unknown as HTMLElement, fakeDoc([host, dialog, root], [dialog]))).toBe(false);
  });
});
