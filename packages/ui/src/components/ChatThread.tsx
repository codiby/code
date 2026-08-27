/**
 * Chat scroll area with entrance motion.
 *
 * Wraps the message list so every block that arrives — the message you just
 * sent, the agent's thinking, its tool runs, each finished text block — rises
 * into place instead of popping in. One tween, one place, same treatment for
 * outgoing and incoming.
 *
 * What gets animated is decided by a watermark on the child COUNT, not by node
 * identity, and that is load-bearing:
 *
 *   - A streaming block re-renders on every delta from the socket. Same node,
 *     same count → nothing re-fires, so a growing block animates once.
 *   - When the turn closes, the live placeholder is swapped for the server's
 *     permanent copy, which carries a different `id` (see the adoption path in
 *     ChatApp's `onMessage`). React remounts that node, so anything keyed on
 *     node identity would flash a second entrance at the end of every turn.
 *     The count doesn't move, so this stays quiet.
 *
 * Bursts are skipped outright: a session switch, a history page-in, or the
 * first hydration mount many children at once, and those arrive at the top or
 * all over, so animating them would ripple the whole viewport.
 */
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type UIEvent } from 'react';
import gsap from 'gsap';

interface Props {
  /** Active session. A change resyncs the watermark without animating. */
  sessionId: string;
  /** Host's scroll-container ref (auto-scroll / scroll-to-bottom indicator). */
  attachRef?: (node: HTMLDivElement | null) => void;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}

/** More children than this at once is never "a message arrived". */
const BURST_LIMIT = 3;

/**
 * Quiet window after landing on a session, in ms.
 *
 * A session's history doesn't arrive in one render: the connection placeholder
 * mounts, then `session_state` replays the transcript, sometimes a beat later.
 * For a short session that's two or three renders of one or two children each
 * — under BURST_LIMIT, so the burst guard lets them through and old messages
 * animate as if they'd just arrived. Nothing real can land this fast after a
 * tab switch (you'd have to type first), so the window costs nothing.
 */
const HYDRATION_MS = 400;

export function ChatThread({ sessionId, attachRef, onScroll, style, className, children }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef(0);
  const sessionRef = useRef(sessionId);
  // Nodes already on screen. Lets a block that arrives *above* a trailing
  // child (a permission card, a queued message) still be the one that
  // animates, instead of the tail element that merely shifted down.
  const seenRef = useRef(new WeakSet<Element>());
  const landedAtRef = useRef(performance.now());

  const setRef = (node: HTMLDivElement | null) => {
    elRef.current = node;
    attachRef?.(node);
  };

  // No dependency array on purpose: the child count can change on any render
  // (a socket delta, a tool result, a permission request), and reading
  // `children.length` is cheaper than threading every one of those into deps.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const nodes = Array.from(el.children);
    const seen = seenRef.current;
    const fresh = nodes.filter(n => !seen.has(n));
    nodes.forEach(n => seen.add(n));

    const sessionChanged = sessionRef.current !== sessionId;
    sessionRef.current = sessionId;
    if (sessionChanged) landedAtRef.current = performance.now();
    const hydrating = performance.now() - landedAtRef.current < HYDRATION_MS;
    const grew = nodes.length - countRef.current;
    countRef.current = nodes.length;

    if (sessionChanged || hydrating || grew <= 0 || grew > BURST_LIMIT || fresh.length === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // `grew` is the truth about how much is actually new; `fresh` can hold one
    // extra when a node was swapped in the same render (the turn-close
    // adoption). Trailing entries are the arrivals.
    gsap.from(fresh.slice(-grew), {
      opacity: 0,
      y: 14,
      duration: 0.32,
      ease: 'power2.out',
      stagger: 0.04,
      clearProps: 'transform,opacity',
    });
  });

  return (
    // `data-image-gallery-root` bounds the fullscreen viewer's filmstrip to
    // this thread — see lib/image-gallery.ts. Focus mode mounts one of these
    // per pane, so each session keeps its own gallery.
    <div ref={setRef} onScroll={onScroll} style={style} className={className} data-image-gallery-root="">
      {children}
    </div>
  );
}
