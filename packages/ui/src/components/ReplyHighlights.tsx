import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { MessageReply } from '../lib/message-reply';
import { locateQuote } from '../lib/quote-locate';

// Which pending quote the pointer is over, shared by the composer tray (which
// sets it) and the thread highlight (which brightens that quote).
let hot: number | null = null;
const listeners = new Set<() => void>();
export function setHotReply(index: number | null) {
  if (hot === index) return;
  hot = index;
  listeners.forEach(l => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The rendered range of `reply` inside its message, if the quote is still on screen. */
export function findReplyRange(container: HTMLElement | null, reply: MessageReply): Range | null {
  const root = container?.querySelector<HTMLElement>(`[id="msg-${CSS.escape(reply.id)}"]`);
  if (!root) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const span = locateQuote(nodes.map(n => n.data), reply.text);
  if (!span) return null;
  const range = document.createRange();
  range.setStart(nodes[span.startChunk], span.startOffset);
  range.setEnd(nodes[span.endChunk], span.endOffset);
  return range;
}

export function jumpToReply(container: HTMLElement | null, reply: MessageReply) {
  const range = findReplyRange(container, reply);
  const el = range?.startContainer.parentElement ??
    container?.querySelector<HTMLElement>(`[id="msg-${CSS.escape(reply.id)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

interface Badge { n: number; left: number; top: number; hot: boolean }

const sameBadges = (a: Badge[], b: Badge[]) =>
  a.length === b.length && a.every((x, i) =>
    x.n === b[i].n && x.left === b[i].left && x.top === b[i].top && x.hot === b[i].hot);

/**
 * Paints the pending quotes in the thread with the CSS Custom Highlight API,
 * so the message DOM React owns is never touched. Re-locates on every thread
 * mutation, since re-renders replace the text nodes the ranges point at.
 * With several quotes, a numbered badge floats at the end of each one,
 * matching the numbers in the composer.
 */
export function ReplyHighlights({ getContainer, replies }: {
  getContainer: () => HTMLElement | null;
  replies: readonly MessageReply[];
}) {
  const hotIndex = useSyncExternalStore(subscribe, () => hot);
  const [badges, setBadges] = useState<Badge[]>([]);
  // The host passes a fresh closure every render; only the quotes should re-run the effect.
  const containerRef = useRef(getContainer);
  containerRef.current = getContainer;
  useEffect(() => {
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    const container = containerRef.current();
    if (!registry || !container) return;
    const numbered = replies.length > 1;
    const paint = () => {
      const all: Range[] = [];
      const hotRanges: Range[] = [];
      const next: Badge[] = [];
      const box = container.getBoundingClientRect();
      replies.forEach((r, i) => {
        const range = findReplyRange(container, r);
        if (!range) return;
        (i === hotIndex ? hotRanges : all).push(range);
        if (!numbered) return;
        const rects = Array.from(range.getClientRects()).filter(x => x.width > 0);
        const end = rects[rects.length - 1];
        // Off-screen quotes keep their highlight but drop the floating badge.
        if (!end || end.bottom < box.top || end.top > box.bottom) return;
        next.push({ n: i + 1, left: Math.round(end.right + 2), top: Math.round(end.top - 7), hot: i === hotIndex });
      });
      registry.set('codiby-reply', new Highlight(...all));
      registry.set('codiby-reply-hot', new Highlight(...hotRanges));
      setBadges(prev => sameBadges(prev, next) ? prev : next);
    };
    paint();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      container.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      registry.delete('codiby-reply');
      registry.delete('codiby-reply-hot');
      setBadges([]);
    };
  }, [replies, hotIndex]);
  if (!badges.length) return null;
  return createPortal(
    <>
      {badges.map(b => (
        <span
          key={b.n}
          aria-hidden
          style={{ left: b.left, top: b.top }}
          className={`pointer-events-none fixed z-40 grid h-[15px] min-w-[15px] place-items-center rounded-full px-1 text-[9.5px] font-bold leading-none text-white shadow ${b.hot ? 'bg-violet-500 ring-2 ring-violet-300/60' : 'bg-violet-600'}`}
        >
          {b.n}
        </span>
      ))}
    </>,
    document.body,
  );
}
