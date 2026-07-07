/**
 * Pure text helpers for writing Markdown code in the chat composer.
 *
 * None of these touch the DOM: each takes the current text plus the
 * selection range and returns the next text together with the caret/selection
 * it should land on. The composer's key handler applies the result to the
 * controlled <textarea> (see ChatComposer). Keeping them pure makes the
 * fence/selection logic easy to reason about and unit-test in isolation.
 */

import { highlightCode, normalizeLang } from './highlight';
import { detectLanguage, displayLang } from './detect-language';

export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const FENCE_RE = /^\s*```/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tint inline `code` spans, keeping the backticks and every other character
 *  exactly in place (alignment with the overlaid textarea depends on it). */
function highlightInline(line: string): string {
  let out = '';
  let last = 0;
  const re = /`[^`\n]+`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += escapeHtml(line.slice(last, m.index));
    out += `<span class="cm-inline-code">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

/**
 * Build the highlight HTML rendered *behind* the composer's transparent
 * textarea (Slack-style in-place highlighting). CRITICAL invariant: the output
 * must reproduce every source character exactly — we only escape and wrap in
 * spans, never add/remove/reflow text — so the textarea's caret and glyphs stay
 * pixel-aligned with this layer.
 *
 * Inline `code` and ``` fences are tinted; fenced bodies are Prism-tokenised
 * per line for real syntax colours. Tokens get COLOUR only — no bold/italic,
 * since changing font weight/style would alter glyph widths and break the
 * alignment (the CSS theme under `.cm-highlight` enforces this).
 */
export function highlightDraft(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.replace(/^\s*`+/, '').trim().split(/\s+/)[0]?.toLowerCase() || '';
      } else {
        inFence = false;
        fenceLang = '';
      }
      out.push(`<span class="cm-fence">${escapeHtml(line)}</span>`);
      continue;
    }
    if (inFence) {
      const grammar = normalizeLang(fenceLang);
      const body = grammar ? highlightCode(line, fenceLang) : escapeHtml(line);
      out.push(`<span class="cm-code-block">${body}</span>`);
      continue;
    }
    out.push(highlightInline(line));
  }
  let html = out.join('\n');
  // A trailing newline needs a filler glyph or the final (empty) row collapses.
  if (text.endsWith('\n')) html += ' ';
  return html;
}

function lineDiv(inner: string, cls?: string): string {
  return `<div class="rc-line${cls ? ' ' + cls : ''}">${inner || '<br>'}</div>`;
}

/**
 * Render the draft for the contenteditable composer (RichInput). Unlike the
 * textarea-overlay `highlightDraft`, this can use real block elements: fenced
 * regions become `.rc-card` blocks (a true bordered card, Slack-style) and each
 * model line is one `.rc-line`. The structure round-trips exactly through
 * `serializeEditor` (one `.rc-line` per `value.split('\n')` entry), which is
 * what keeps the controlled editor's caret stable.
 */
export function renderEditorHtml(text: string): string {
  if (text === '') return lineDiv('');
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i]!.match(/^\s*```([\w+#.-]*)\s*$/);
    if (open) {
      const start = i;
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) j++;
      const closed = j < lines.length;
      const bodyEnd = closed ? j : lines.length;
      const grammar = normalizeLang(open[1]!.toLowerCase())
        || normalizeLang(detectLanguage(lines.slice(start + 1, bodyEnd).join('\n')));
      const cardLines: string[] = [];
      cardLines.push(lineDiv(escapeHtml(lines[start]!), 'rc-cl rc-fence'));
      for (let k = start + 1; k < bodyEnd; k++) {
        cardLines.push(lineDiv(grammar ? highlightCode(lines[k]!, grammar) : escapeHtml(lines[k]!), 'rc-cl'));
      }
      if (closed) cardLines.push(lineDiv(escapeHtml(lines[j]!), 'rc-cl rc-fence'));
      const label = grammar ? ` data-lang="${escapeHtml(displayLang(grammar))}"` : '';
      out.push(`<div class="rc-card"${label}>${cardLines.join('')}</div>`);
      i = closed ? j + 1 : lines.length;
      continue;
    }
    out.push(lineDiv(highlightInline(lines[i]!)));
    i++;
  }
  return out.join('');
}

/** Text of the line the caret sits on. */
function lineAt(text: string, caret: number): string {
  const start = text.lastIndexOf('\n', caret - 1) + 1;
  let end = text.indexOf('\n', caret);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * True when the caret is inside an unclosed ``` fence — i.e. an odd number of
 * fence lines (`^```) precede it. Drives whether Enter should send the message
 * or just break the line, and whether Tab should indent.
 */
export function isInsideCodeFence(text: string, caret: number): boolean {
  let fences = 0;
  for (const line of text.slice(0, caret).split('\n')) {
    if (FENCE_RE.test(line)) fences++;
  }
  return fences % 2 === 1;
}

/** True when any complete or in-progress code markup is present in the text. */
export function hasCodeMarkup(text: string): boolean {
  return text.includes('```') || /`[^`\n]+`/.test(text);
}

/** Replace the selection with `str`, leaving the caret right after it. */
export function insertText(text: string, start: number, end: number, str: string): EditResult {
  const next = text.slice(0, start) + str + text.slice(end);
  const caret = start + str.length;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}

/**
 * Wrap the selection with `before`/`after`. With an empty selection the caret
 * is dropped between the markers (ready to type); otherwise the original
 * selection stays selected inside them. Toggles off when the selection is
 * already wrapped by the same markers.
 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
): EditResult {
  const selected = text.slice(start, end);
  // Unwrap if the markers are already hugging the selection.
  if (
    text.slice(start - before.length, start) === before &&
    text.slice(end, end + after.length) === after
  ) {
    const next = text.slice(0, start - before.length) + selected + text.slice(end + after.length);
    return {
      text: next,
      selectionStart: start - before.length,
      selectionEnd: end - before.length,
    };
  }
  const next = text.slice(0, start) + before + selected + after + text.slice(end);
  if (start === end) {
    const caret = start + before.length;
    return { text: next, selectionStart: caret, selectionEnd: caret };
  }
  return {
    text: next,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length,
  };
}

/**
 * Wrap the selection as a fenced code block, ensuring the ``` markers sit on
 * their own lines. With an empty selection the caret lands on the blank line
 * between the fences.
 */
export function wrapCodeBlock(text: string, start: number, end: number): EditResult {
  const selected = text.slice(start, end);
  const needNlBefore = start > 0 && text[start - 1] !== '\n';
  const needNlAfter = end < text.length && text[end] !== '\n';
  const open = (needNlBefore ? '\n' : '') + '```\n';
  const close = '\n```' + (needNlAfter ? '\n' : '');
  const next = text.slice(0, start) + open + selected + close + text.slice(end);
  const selStart = start + open.length;
  if (start === end) {
    return { text: next, selectionStart: selStart, selectionEnd: selStart };
  }
  return { text: next, selectionStart: selStart, selectionEnd: selStart + selected.length };
}

/**
 * Decide what Enter should do inside code context. Returns an edit to apply, or
 * `null` to signal "not in a code context — let the caller send the message".
 *
 *  - Caret right after a bare opening fence (```` ```lang ````) with no closing
 *    fence below → auto-close: insert a blank body line and a matching ``` ,
 *    parking the caret on the blank line.
 *  - Caret anywhere else inside an open fence → plain newline (so multi-line
 *    code never submits early).
 */
export function fenceEnter(text: string, start: number, end: number): EditResult | null {
  if (start !== end) return null; // active selection — leave to default
  if (!isInsideCodeFence(text, start)) return null;

  const line = lineAt(text, start);
  const atLineEnd = start === text.length || text[start] === '\n';
  const isOpener = /^\s*```[\w+#.-]*$/.test(line);
  const closedBelow = text
    .slice(start)
    .split('\n')
    .some((l, i) => i > 0 && FENCE_RE.test(l));

  if (isOpener && atLineEnd && !closedBelow) {
    const indent = line.match(/^\s*/)![0];
    const insert = '\n' + indent + '\n' + indent + '```';
    const next = text.slice(0, start) + insert + text.slice(start);
    const caret = start + 1 + indent.length; // blank line between the fences
    return { text: next, selectionStart: caret, selectionEnd: caret };
  }

  const next = text.slice(0, start) + '\n' + text.slice(start);
  return { text: next, selectionStart: start + 1, selectionEnd: start + 1 };
}
