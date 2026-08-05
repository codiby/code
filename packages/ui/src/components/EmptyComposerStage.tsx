/**
 * Empty-session stage — wraps the live ChatComposer so that a session with no
 * messages reads like the group's new-session screen (GroupComposer): the
 * composer sits in the middle of the pane under a
 * "New session in <folder> with <provider>" headline, with the branch chip
 * below it. Once the first message lands, the headline and the chip collapse
 * away and the composer travels down to its usual slot at the bottom.
 *
 * The composer never changes parent: it always lives in the pane's bottom
 * slot, and "centred" is nothing but a `translateY` on the wrapper. That
 * keeps the transition to a single tween and — more importantly — keeps the
 * contenteditable mounted, so focus, caret position and any in-flight IME
 * composition survive the animation. Reparenting it into a centred container
 * would remount the editor and drop all three.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import gsap from 'gsap';
import { Bot, FolderClosed, GitBranch } from 'lucide-react';

interface Props {
  /** Session this stage is bound to. A change re-lays out without animating —
   *  switching tabs should never look like a send. */
  sessionId: string;
  /** True while the session has no messages: composer centred, chrome shown. */
  centered: boolean;
  /** Basename of the session's cwd, shown in the headline. */
  folderName: string;
  /** Human label for the session's provider ("Claude", "Codex", …). */
  providerLabel: string;
  /** Current git branch of the session's cwd, when known. */
  branch?: string | null;
  /** Chat scroll container — faded up as the composer docks so the first
   *  exchange arrives with the composer rather than popping in behind it. */
  getThreadEl?: () => HTMLElement | null;
  /** The real composer (LoopBanner + ChatComposer). */
  children: ReactNode;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function EmptyComposerStage({
  sessionId, centered, folderName, providerLabel, branch, getThreadEl, children,
}: Props) {
  const stackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // Chrome outlives `centered` by one animation: it has to stay mounted while
  // it fades and collapses, so it's unmounted in the timeline's onComplete.
  const [showChrome, setShowChrome] = useState(centered);
  const animatingRef = useRef(false);
  const prevCenteredRef = useRef(centered);
  const prevSessionRef = useRef(sessionId);

  /** Offset that puts the stack's centre on the pane's centre. The stack is
   *  the pane's bottom-anchored last child, so this is always negative. */
  const centerOffset = () => {
    const stack = stackRef.current;
    const pane = stack?.parentElement;
    if (!stack || !pane) return 0;
    return -Math.max(0, (pane.clientHeight - stack.offsetHeight) / 2);
  };

  // Keep the composer centred as the pane resizes (window, sidebar, panels)
  // and as the composer itself grows while the user types a long first
  // message. Only while centred and idle — mid-tween the timeline owns `y`.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const pane = stack?.parentElement;
    if (!stack || !pane || !centered) return;
    const recenter = () => {
      if (animatingRef.current) return;
      gsap.set(stack, { y: centerOffset() });
    };
    const ro = new ResizeObserver(recenter);
    ro.observe(pane);
    ro.observe(stack);
    return () => ro.disconnect();
  }, [centered, showChrome]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    const sessionChanged = prevSessionRef.current !== sessionId;
    const wasCentered = prevCenteredRef.current;
    prevSessionRef.current = sessionId;
    prevCenteredRef.current = centered;

    const thread = getThreadEl?.() ?? null;
    const chrome = [headRef.current, footRef.current].filter(Boolean) as HTMLElement[];

    const settle = () => {
      gsap.killTweensOf([stack, ...chrome]);
      if (thread) gsap.killTweensOf(thread);
      animatingRef.current = false;
      if (chrome.length) gsap.set(chrome, { clearProps: 'all' });
      if (thread) gsap.set(thread, { clearProps: 'opacity,transform' });
      gsap.set(stack, { y: centered ? centerOffset() : 0 });
      setShowChrome(centered);
    };

    // Centred, or arriving from another session, or already docked: no
    // choreography, just land in the right place.
    if (centered || sessionChanged || !wasCentered) {
      settle();
      return;
    }

    // Centred → docked: the session's first message just landed.
    if (prefersReducedMotion()) { settle(); return; }

    animatingRef.current = true;
    const tl = gsap.timeline({
      defaults: { ease: 'power3.inOut' },
      onComplete: () => { animatingRef.current = false; setShowChrome(false); },
    });
    if (headRef.current) {
      tl.to(headRef.current, { opacity: 0, y: -10, duration: 0.22, ease: 'power2.in' }, 0);
    }
    if (footRef.current) {
      tl.to(footRef.current, { opacity: 0, duration: 0.18, ease: 'power2.in' }, 0);
    }
    if (chrome.length) {
      // Collapsing the chrome's height as the composer travels means the two
      // motions add up instead of the composer jumping at the end.
      tl.to(chrome, { height: 0, duration: 0.45 }, 0.1);
    }
    tl.to(stack, { y: 0, duration: 0.62 }, 0.06);
    if (thread) {
      tl.fromTo(
        thread,
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0, duration: 0.42, ease: 'power2.out', clearProps: 'transform' },
        0.3,
      );
    }
    return () => { tl.kill(); animatingRef.current = false; };
  }, [centered, sessionId]);

  return (
    <div ref={stackRef} className="shrink-0 relative z-10">
      {showChrome && (
        <div ref={headRef} className="overflow-hidden">
          <div className="max-w-4xl mx-auto px-6 pb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[22px] text-zinc-400 font-light">
            <span>New session in</span>
            <span className="inline-flex items-center gap-1.5 text-zinc-100" title={folderName}>
              <FolderClosed size={18} className="text-zinc-500" />
              <span className="font-semibold">{folderName}</span>
            </span>
            <span>with</span>
            <span className="inline-flex items-center gap-1.5 text-zinc-100">
              <Bot size={18} className="text-zinc-500" />
              <span className="font-semibold">{providerLabel}</span>
            </span>
          </div>
        </div>
      )}

      {children}

      {showChrome && (
        <div ref={footRef} className="overflow-hidden">
          <div className="max-w-4xl mx-auto px-6 pb-2 -mt-1 flex items-center justify-end text-xs text-zinc-500">
            {branch && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1" title={branch}>
                <GitBranch size={12} />
                <span className="font-mono">{branch}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
