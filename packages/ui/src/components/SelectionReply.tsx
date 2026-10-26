import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Reply } from 'lucide-react';

interface Anchor {
  messageId: string;
  text: string;
  left: number;
  top: number;
}

const BAR_WIDTH = 178;

/** Keys typed into a field are text, not shortcuts. */
function isEditable(el: Element | null): boolean {
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ||
    (el as HTMLElement).isContentEditable);
}

/**
 * Floating `Copy · Reply` bar over text selected inside one message of the
 * thread. Reply quotes just the selection in the composer; Copy goes through
 * the browser's copy so the message's own clipboard handling still applies.
 * Selections spanning two messages, or inside something that can't be replied
 * to (tool steps, terminals), get no bar — a reply cites exactly one message.
 */
export function SelectionReply({
  getContainer, canReply, onReply,
}: {
  getContainer: () => HTMLElement | null;
  /** Whether the message with this id accepts replies. */
  canReply: (messageId: string) => boolean;
  onReply: (messageId: string, text: string) => void;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [copied, setCopied] = useState(false);
  // The latest values, read from document listeners registered once.
  const latest = useRef({ getContainer, canReply, onReply, anchor });
  latest.current = { getContainer, canReply, onReply, anchor };

  const reply = () => {
    const a = latest.current.anchor;
    if (!a) return;
    latest.current.onReply(a.messageId, a.text);
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };

  const copy = () => {
    if (!document.execCommand('copy') && latest.current.anchor) {
      void navigator.clipboard?.writeText(latest.current.anchor.text);
    }
    setCopied(true);
  };

  useEffect(() => {
    let pointerDown = false;

    const measure = () => {
      const sel = window.getSelection();
      const container = latest.current.getContainer();
      if (!sel || sel.isCollapsed || sel.rangeCount !== 1 || !container) return setAnchor(null);
      const range = sel.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const el = common.nodeType === Node.ELEMENT_NODE ? common as Element : common.parentElement;
      const msg = el?.closest<HTMLElement>('[id^="msg-"]');
      const text = sel.toString().trim();
      if (!msg || !container.contains(msg) || !text) return setAnchor(null);
      const messageId = msg.id.slice('msg-'.length);
      if (!latest.current.canReply(messageId)) return setAnchor(null);
      const first = Array.from(range.getClientRects()).find(r => r.width > 0) ?? range.getBoundingClientRect();
      const center = first.left + Math.min(first.width, 240) / 2;
      setCopied(false);
      setAnchor({
        messageId,
        text,
        left: Math.max(8, Math.min(center - BAR_WIDTH / 2, window.innerWidth - BAR_WIDTH - 8)),
        top: Math.max(8, first.top - 40),
      });
    };

    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-selection-reply]')) return;
      pointerDown = true;
      setAnchor(null);
    };
    // Measure once the drag ends, not on every selectionchange mid-drag.
    const onUp = () => { pointerDown = false; setTimeout(measure, 0); };
    const onSelection = () => { if (!pointerDown) measure(); };
    const onScroll = () => setAnchor(null);
    // `R` replies while the bar is up. ⌘⇧R is taken by Electron's hard reload.
    const onKey = (e: KeyboardEvent) => {
      if (!latest.current.anchor || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'r' || isEditable(document.activeElement)) return;
      e.preventDefault();
      reply();
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  if (!anchor) return null;
  return createPortal(
    <div
      data-selection-reply
      // Keep the selection alive through the click.
      onMouseDown={e => e.preventDefault()}
      style={{ left: anchor.left, top: anchor.top }}
      className="selection-reply fixed z-50 flex items-center h-[30px] p-0.5 rounded-lg border border-border-light bg-surface-light text-[12.5px] text-zinc-200 shadow-[0_6px_20px_rgba(0,0,0,.45)]"
    >
      <BarButton onClick={copy} title="Copy selection" kbd="⌘C">
        {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} className="text-zinc-400" />}
        {copied ? 'Copied' : 'Copy'}
      </BarButton>
      <span className="w-px h-4 bg-border-light" />
      <BarButton onClick={reply} title="Reply to selection" kbd="R">
        <Reply size={14} className="text-violet-400" />
        Reply
      </BarButton>
    </div>,
    document.body,
  );
}

function BarButton({ onClick, title, kbd, children }: { onClick: () => void; title: string; kbd: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={`${title} (${kbd})`}
      onClick={onClick}
      className="flex items-center gap-1.5 h-full pl-2 pr-1.5 rounded-md hover:bg-white/5 hover:text-violet-300 transition-colors"
    >
      {children}
      <kbd className="ml-0.5 px-1 rounded border border-border-light font-mono text-[10.5px] leading-4 text-zinc-500">{kbd}</kbd>
    </button>
  );
}
