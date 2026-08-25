/**
 * The inline-markdown subset used by prose that lives *inside* a rendered block
 * (a diffdoc note, an explain step) rather than in the message body.
 *
 * Deliberately a subset — code, bold, italic. Markdown.tsx's `renderInline`
 * cannot be reused here because Markdown imports those components, and this
 * prose is a sentence or two, not a document. Keeping it in one place means
 * DiffDoc and Explain can't drift apart on what a note may contain.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderInlineSubset(text: string, codeClass: string, strongClass: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, `<code class="${codeClass}">$1</code>`)
    .replace(/\*\*(.+?)\*\*/g, `<strong class="${strongClass}">$1</strong>`)
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>');
}
