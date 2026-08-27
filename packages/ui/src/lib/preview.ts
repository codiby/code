/**
 * Fullscreen preview — what can be previewed, how a gallery of it is
 * assembled, and the clipboard / disk actions offered over an item.
 *
 * Two entry points feed the same viewer: tapping an image in a chat thread
 * (gallery = that thread's images) and opening an item in the Resources drawer
 * (gallery = the session's resources). The chat gallery is read from the DOM
 * rather than threaded through props: chat images are rendered by four
 * unrelated branches (user/system bubbles on desktop and on mobile), and the
 * order the user expects in the filmstrip *is* the order they appear on screen.
 * Marking the images and reading them back in document order gets that for
 * free, and stays correct when a new kind of bubble starts rendering images.
 */
import { getNative } from './native';
import type { SessionResource } from './claude-client';

/** Marks the scroll container that bounds one thread's gallery. */
const GALLERY_ROOT_ATTR = 'data-image-gallery-root';
/** Marks every chat image that should show up in the filmstrip. */
const GALLERY_IMAGE_ATTR = 'data-gallery-image';

/** How the viewer renders an item. Anything unrecognised falls to `file`. */
export type PreviewKind = 'image' | 'pdf' | 'html' | 'file';

export interface PreviewItem {
  /** URL the viewer renders and the actions fetch from. May be a `data:` URL. */
  src: string;
  kind: PreviewKind;
  /** Shown in the header and used as the Save-As default. */
  name?: string;
  mime?: string;
  size?: number;
}

export interface Gallery {
  /** Everything the filmstrip can walk, in the order it's shown. */
  items: PreviewItem[];
  /** Index of the item the user actually opened. */
  index: number;
}

/**
 * Classify a resource for the viewer. `kind` comes from the server's manifest
 * and is authoritative for images and mockups; mime/ext settle the rest.
 */
export function previewKindFor(opts: { kind?: string; mime?: string; ext?: string; name?: string }): PreviewKind {
  const { kind, mime = '', ext = '', name = '' } = opts;
  if (kind === 'image' || mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || /^\.?pdf$/i.test(ext) || /\.pdf$/i.test(name)) return 'pdf';
  if (kind === 'mockup' || mime === 'text/html' || /^\.?html?$/i.test(ext) || /\.html?$/i.test(name)) return 'html';
  return 'file';
}

/** Adapt a Resources-drawer entry to a viewer item. */
export function resourceToPreviewItem(r: SessionResource, src: string): PreviewItem {
  return {
    src,
    kind: previewKindFor({ kind: r.kind, mime: r.mime, ext: r.ext, name: r.name }),
    name: r.name,
    mime: r.mime,
    size: r.size,
  };
}

/**
 * Collect the thread gallery around `el`, an image the user just clicked.
 *
 * Scoped to the nearest marked root so focus mode — which mounts one thread per
 * pane — doesn't splice every visible session into one strip.
 */
export function collectGallery(el: HTMLImageElement): Gallery {
  const toItem = (img: HTMLImageElement): PreviewItem => ({ src: img.currentSrc || img.src, kind: 'image' });
  const root = el.closest(`[${GALLERY_ROOT_ATTR}]`) ?? document;
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>(`img[${GALLERY_IMAGE_ATTR}]`));
  const index = imgs.indexOf(el);
  if (index < 0) return { items: [toItem(el)], index: 0 };
  return { items: imgs.map(toItem), index };
}

/** Best-effort file name for an item, used as the Save-As default. */
export function previewFileName(item: PreviewItem, index: number): string {
  if (item.name) return item.name;
  const src = item.src;
  const fromPath = /^https?:|^file:/.test(src) ? src.split(/[?#]/)[0]!.split('/').pop() : null;
  if (fromPath && /\.[a-z0-9]{2,4}$/i.test(fromPath)) return fromPath;
  const mime = item.mime ?? /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/png';
  const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'bin';
  return `${item.kind}-${index + 1}.${ext}`;
}

async function srcToBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`could not read this file (${res.status})`);
  return res.blob();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = src;
  });
}

/**
 * PNG bytes for `src`. The clipboard only takes `image/png`, so anything else
 * (jpeg screenshots, webp, svg) is re-encoded through a canvas first.
 */
async function srcToPngBlob(src: string): Promise<Blob> {
  const blob = await srcToBlob(src);
  if (blob.type === 'image/png') return blob;

  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  // SVG sources can report 0×0 when they carry no intrinsic size — rasterise
  // those at a sane default rather than producing an empty bitmap.
  canvas.width = img.naturalWidth || 1024;
  canvas.height = img.naturalHeight || 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas is unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode image'))), 'image/png');
  });
}

/**
 * Copy the image itself (not its URL) to the system clipboard.
 *
 * Safari only honours `clipboard.write` when the ClipboardItem is constructed
 * synchronously inside the gesture, which means handing it a *promise* of the
 * bytes; older Chromium builds only accept a resolved Blob. Try the portable
 * form first, fall back to the eager one.
 */
export async function copyImageToClipboard(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('the clipboard is unavailable in this context');
  }
  const pending = srcToPngBlob(src);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]);
  } catch {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pending })]);
  }
}

/** Copy the raw src — a `data:` URL for attachments, a real URL otherwise. */
export async function copyAddress(src: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('the clipboard is unavailable in this context');
  await navigator.clipboard.writeText(src);
}

/** Copy an HTML mockup's markup, so it can be pasted into an editor. */
export async function copyText(src: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('the clipboard is unavailable in this context');
  await navigator.clipboard.writeText(await (await srcToBlob(src)).text());
}

/**
 * Save the item to disk: the native Save-As dialog in the desktop app, a
 * plain browser download everywhere else (mobile PWA, dev server).
 */
export async function saveToDisk(src: string, suggestedName: string): Promise<void> {
  const blob = await srcToBlob(src);
  const native = getNative();
  if (native) {
    await native.invoke('save_file', { suggestedName, data: new Uint8Array(await blob.arrayBuffer()) });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Human-readable byte count, shared by the viewer header and resource cards. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
