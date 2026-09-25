/** A tool result that carries images (Read on a .png, screenshots) reaches the
 *  UI as the provider's content array serialised to JSON — a wall of base64.
 *  Pull the pictures (and any text beside them) back out so the card can show
 *  them instead. Null when the content isn't such an array. */
export interface ToolResultImages {
  images: string[];
  text: string;
}

export function parseToolResultImages(content: unknown): ToolResultImages | null {
  let blocks: unknown = content;
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
    try { blocks = JSON.parse(trimmed); } catch { return null; }
  }
  if (blocks && !Array.isArray(blocks)) blocks = [blocks];
  if (!Array.isArray(blocks)) return null;

  const images: string[] = [];
  const text: string[] = [];
  for (const b of blocks as Record<string, any>[]) {
    if (b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
      images.push(`data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);
    } else if (b?.type === 'text' && typeof b.text === 'string') {
      text.push(b.text);
    }
  }
  return images.length ? { images, text: text.join('\n') } : null;
}
