export interface QuoteSpan {
  startChunk: number;
  startOffset: number;
  endChunk: number;
  /** Exclusive. */
  endOffset: number;
}

/**
 * Find `quote` across the text of consecutive DOM text nodes (`chunks`),
 * ignoring whitespace entirely: a selection's `toString()` adds line breaks
 * between list items and paragraphs that don't exist as text nodes.
 */
export function locateQuote(chunks: readonly string[], quote: string): QuoteSpan | null {
  const needle = quote.replace(/\s+/g, '');
  if (!needle) return null;
  let hay = '';
  const at: [number, number][] = [];
  chunks.forEach((chunk, c) => {
    for (let i = 0; i < chunk.length; i++) {
      if (/\s/.test(chunk[i])) continue;
      hay += chunk[i];
      at.push([c, i]);
    }
  });
  const idx = hay.indexOf(needle);
  if (idx < 0) return null;
  const [startChunk, startOffset] = at[idx];
  const [endChunk, last] = at[idx + needle.length - 1];
  return { startChunk, startOffset, endChunk, endOffset: last + 1 };
}
