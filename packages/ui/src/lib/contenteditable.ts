/**
 * Helpers for running a `contenteditable` as a controlled editor whose source
 * of truth is a plain string (the markdown draft). The composer renders the
 * string to a canonical DOM (see `renderEditorHtml`), and after every edit we:
 *   1. serialize the DOM back to a string (`serializeEditor`),
 *   2. measure the caret as a character offset into that string (`getCaret`),
 *   3. re-render the canonical DOM and restore the caret (`setCaret`).
 *
 * Tuned for Chromium (the app only ever runs under Electron), so we can rely on
 * one engine's contenteditable behaviour instead of cross-browser guesswork.
 *
 * The text model: visible lines joined by '\n', exactly like `value.split('\n')`.
 * Each model line is a `.rc-line` element in the canonical DOM; block elements
 * introduce a single newline boundary and `<br>` is a newline.
 */

const BLOCK_TAGS = new Set(['DIV', 'P', 'PRE', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION', 'H1', 'H2', 'H3', 'H4']);

function isBlockEl(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName);
}

/**
 * DOM → string. Models the content as visible lines joined by '\n', matching
 * what the composer renders from `value.split('\n')`. Each *leaf* block element
 * (one with no block children — e.g. an `.rc-line`) is one line; a container
 * block (e.g. an `.rc-card`) just holds more line blocks.
 *
 * The critical subtlety is `<br>`: Chromium inserts a placeholder `<br>` as the
 * lone child of an emptied block to give it height — that is NOT a newline (the
 * block boundary already is the line). A `<br>` that has siblings, or follows
 * text, IS a real line break. Getting this wrong makes emptied lines serialize
 * to a stray '\n' that accumulates on every keystroke (composer grows).
 *
 * Accepts an Element or a DocumentFragment (used by `getCaret` on a clone).
 */
export function serializeEditor(node: Node): string {
  const lines: string[] = [''];
  let started = false;
  const append = (t: string) => { lines[lines.length - 1] += t; if (t) started = true; };

  const walk = (n: Node) => {
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        append(child.nodeValue ?? '');
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (el.hasAttribute('data-noserialize')) continue;
        if (el.tagName === 'BR') {
          const lone = !el.previousSibling && !el.nextSibling;
          const parentEmpty = (el.parentNode as HTMLElement | null)?.textContent === '';
          if (lone && parentEmpty) continue; // placeholder <br>, not a newline
          lines.push('');
          started = true;
          continue;
        }
        if (isBlockEl(el)) {
          if (Array.from(el.children).some(isBlockEl)) {
            walk(el); // container block: its children are the lines
          } else {
            if (started) lines.push(''); // leaf block = its own line
            started = true;
            walk(el);
          }
        } else {
          walk(el); // inline element (span)
        }
      }
    }
  };
  walk(node);
  return lines.join('\n');
}

/**
 * Measure the current selection as { start, end } character offsets into the
 * serialized text, or null when the selection isn't inside `root`. Uses the
 * exact same serializer on the range prefix so the offsets line up with
 * `serializeEditor(root)`.
 */
export function getCaret(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const measure = (container: Node, offset: number): number => {
    const r = document.createRange();
    r.selectNodeContents(root);
    try {
      r.setEnd(container, offset);
    } catch {
      return 0;
    }
    return serializeEditor(r.cloneContents()).length;
  };

  return {
    start: measure(range.startContainer, range.startOffset),
    end: measure(range.endContainer, range.endOffset),
  };
}

/** Find the DOM position for a character offset, using the canonical `.rc-line`
 *  structure plus the known text model (`text`). */
function locate(root: HTMLElement, text: string, target: number): { node: Node; offset: number } | null {
  const lines = text.split('\n');
  let remaining = Math.max(0, Math.min(target, text.length));
  let lineIdx = 0;
  while (lineIdx < lines.length && remaining > lines[lineIdx]!.length) {
    remaining -= lines[lineIdx]!.length + 1; // +1 for the newline separator
    lineIdx++;
  }
  if (lineIdx >= lines.length) {
    lineIdx = lines.length - 1;
    remaining = lines[lineIdx]!.length;
  }
  const lineEls = root.querySelectorAll('.rc-line');
  const el = (lineEls[lineIdx] as HTMLElement) || root;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.nodeValue!.length;
    if (remaining <= pos + len) return { node, offset: remaining - pos };
    pos += len;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: last.nodeValue!.length };
  return { node: el, offset: 0 }; // empty line (only a <br>)
}

/** Restore a selection from character offsets into the canonical DOM. */
export function setCaret(root: HTMLElement, text: string, start: number, end: number): void {
  const a = locate(root, text, start);
  if (!a) return;
  const b = end === start ? a : locate(root, text, end);
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  if (b) r.setEnd(b.node, b.offset);
  else r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
