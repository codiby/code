import { useState } from 'react';
import { FullscreenPreview } from './FullscreenPreview';
import type { Gallery } from '../lib/preview';
import type { TurnMediaItem } from '../lib/turns';

/** Past this many, the last slot becomes a `+N` that opens the rest. */
const MAX_TILES = 6;

/**
 * Thumbnails of the images and mockups a finished turn produced, under its
 * answer. The fold above hides the work they came from; this keeps them one
 * click away. An image opens the viewer with the turn's images as its
 * filmstrip; a mockup reopens in the preview panel, like its own bar does.
 */
export function TurnMediaStrip({ items }: { items: TurnMediaItem[] }) {
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const images = items.filter(i => i.kind === 'image');

  const open = (item: TurnMediaItem) => {
    if (item.kind === 'mockup') {
      window.dispatchEvent(
        new CustomEvent('codiby-code:open-mockup', { detail: { name: item.name, html: item.html } }),
      );
      return;
    }
    setGallery({ items: images.map(i => ({ src: i.src, kind: 'image' })), index: images.indexOf(item) });
  };

  const overflow = items.length > MAX_TILES;
  const shown = overflow ? items.slice(0, MAX_TILES - 1) : items;
  const rest = overflow ? items.slice(MAX_TILES - 1) : [];

  return (
    <div className="flex items-center gap-1.5 pt-1 pb-2 select-none">
      {shown.map((item, i) => item.kind === 'image' ? (
        <button
          key={i}
          type="button"
          onClick={() => open(item)}
          title={item.caption}
          className="w-12 h-12 shrink-0 rounded-md overflow-hidden border border-border hover:border-zinc-500 transition-colors cursor-zoom-in"
        >
          <img src={item.src} alt="" className="w-full h-full object-cover" />
        </button>
      ) : (
        <button
          key={i}
          type="button"
          onClick={() => open(item)}
          title={`Open mockup "${item.name}" in preview`}
          className="w-12 h-12 shrink-0 rounded-md border border-dashed border-violet-500/35 bg-violet-500/[0.04] hover:bg-violet-500/10 transition-colors flex flex-col items-center justify-center gap-0.5 px-1"
        >
          <span className="text-[13px] text-violet-400 leading-none">▣</span>
          <span className="w-full text-[9px] text-violet-200 font-mono truncate leading-tight">{item.name}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => open(rest[0]!)}
          className="w-12 h-12 shrink-0 rounded-md border border-dashed border-border text-[12px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
        >
          +{rest.length}
        </button>
      )}
      <FullscreenPreview
        gallery={gallery}
        onIndexChange={(index) => setGallery(g => (g ? { ...g, index } : g))}
        onClose={() => setGallery(null)}
      />
    </div>
  );
}
