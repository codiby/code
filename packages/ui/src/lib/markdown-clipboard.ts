/** Copy rendered prose without the UI controls and layout CSS around it. */
export function copyMarkdownSelection(event: React.ClipboardEvent<HTMLDivElement>): void {
  const selection = window.getSelection();
  if (!event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  // Leave selections spanning other messages or the composer to the browser.
  if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;

  const content = document.createElement('div');
  content.append(range.cloneContents());
  content.querySelectorAll('[data-copy-inline], [data-copy-code], [data-expand-code], .cm-code-fade').forEach(node => node.remove());
  for (const node of content.querySelectorAll('*')) {
    // Semantic tags and list values survive; flex/absolute positioning must not
    // reach rich-text editors, which can translate those boxes into new lines.
    node.removeAttribute('class');
    node.removeAttribute('style');
  }
  event.clipboardData.setData('text/html', content.innerHTML);
  event.clipboardData.setData('text/plain', selection.toString());
  event.preventDefault();
}
