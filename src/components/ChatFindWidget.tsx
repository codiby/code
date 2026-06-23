import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * VSCode-style "find in chat" widget. Floats in the top-right of the active
 * chat pane (⌘F / Ctrl+F to open, Esc to close) and searches the rendered
 * message stream — bubbles, tool output, terminal text, everything inside the
 * scroll container.
 *
 * Matches are painted with the CSS Custom Highlight API rather than by
 * wrapping text in <mark> nodes: the markdown is rendered by React and streams
 * in live, so mutating its DOM would fight reconciliation and break mid-stream.
 * Highlights live in a parallel layer keyed off Range objects, so we can light
 * up every hit (and the current one in orange) without touching a single node.
 */

interface ChatFindWidgetProps {
  open: boolean;
  onClose: () => void;
  /** Returns the scrolling messages container for the active session. */
  getContainer: () => HTMLElement | null;
}

const HL_ALL = 'chat-find';
const HL_CURRENT = 'chat-find-current';

// The Custom Highlight API ships in modern Chromium (Electron) but isn't in
// every TS lib target — reach for it through `any` and feature-detect so the
// widget degrades to count-and-scroll if it's ever missing.
const HighlightCtor: any =
  typeof window !== 'undefined' ? (window as any).Highlight : undefined;
const cssHighlights: any =
  typeof CSS !== 'undefined' ? (CSS as any).highlights : undefined;
const supportsHighlight = !!(HighlightCtor && cssHighlights);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(
  query: string,
  opts: { caseSensitive: boolean; wholeWord: boolean; useRegex: boolean },
): RegExp | null {
  if (!query) return null;
  try {
    const flags = opts.caseSensitive ? 'g' : 'gi';
    if (opts.useRegex) return new RegExp(query, flags);
    let pattern = escapeRegExp(query);
    if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Walk every text node in the container and collect a Range per match. */
function collectRanges(container: HTMLElement, regex: RegExp): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip non-visual nodes (script/style) and anything collapsed away.
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  // TreeWalker yields nodes in document order, so ranges come out sorted —
  // which is exactly the next/prev navigation order we want.
  while ((node = walker.nextNode())) {
    const text = node.nodeValue!;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text))) {
      if (m[0].length === 0) {
        // Zero-width match (e.g. a regex like `a*`) — step forward so we
        // don't spin forever on the same index.
        regex.lastIndex++;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

function applyHighlights(ranges: Range[], currentIdx: number): void {
  if (!supportsHighlight) return;
  cssHighlights.set(HL_ALL, new HighlightCtor(...ranges));
  const cur = ranges[currentIdx];
  cssHighlights.set(HL_CURRENT, cur ? new HighlightCtor(cur) : new HighlightCtor());
}

function clearHighlights(): void {
  if (!supportsHighlight) return;
  cssHighlights.delete(HL_ALL);
  cssHighlights.delete(HL_CURRENT);
}

/** Scroll the container just enough to bring the active match into view. */
function scrollRangeIntoView(container: HTMLElement, range: Range): void {
  const rRect = range.getBoundingClientRect();
  if (rRect.width === 0 && rRect.height === 0) return;
  const cRect = container.getBoundingClientRect();
  const margin = 80;
  if (rRect.top < cRect.top + margin) {
    container.scrollTop -= cRect.top + margin - rRect.top;
  } else if (rRect.bottom > cRect.bottom - margin) {
    container.scrollTop += rRect.bottom - (cRect.bottom - margin);
  }
}

export function ChatFindWidget({ open, onClose, getContainer }: ChatFindWidgetProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(0); // 0-based index into ranges
  const [invalidRegex, setInvalidRegex] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  // Recompute all matches from the live DOM. `keepCurrent` clamps the active
  // index instead of resetting to the first hit (used when the stream mutates
  // under us, so the user doesn't get yanked back to the top).
  const runSearch = useCallback(
    (keepCurrent: boolean) => {
      const container = getContainer();
      const regex = buildRegex(query, { caseSensitive, wholeWord, useRegex });
      setInvalidRegex(useRegex && query.length > 0 && regex === null);

      if (!container || !regex) {
        rangesRef.current = [];
        setMatchCount(0);
        setCurrent(0);
        clearHighlights();
        return;
      }

      const ranges = collectRanges(container, regex);
      rangesRef.current = ranges;
      setMatchCount(ranges.length);
      setCurrent(prev => {
        if (ranges.length === 0) return 0;
        return keepCurrent ? Math.min(prev, ranges.length - 1) : 0;
      });
    },
    [query, caseSensitive, wholeWord, useRegex, getContainer],
  );

  // Focus + select on open; clear highlights on close.
  useEffect(() => {
    if (open) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    } else {
      clearHighlights();
    }
  }, [open]);

  // Re-run search (debounced) whenever the query or options change.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => runSearch(false), 100);
    return () => clearTimeout(t);
  }, [open, runSearch]);

  // The chat streams in live — re-run as the DOM changes so match counts and
  // highlights stay honest. Highlighting never mutates the DOM, so this won't
  // feed back on itself.
  useEffect(() => {
    if (!open || !query) return;
    const container = getContainer();
    if (!container) return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => runSearch(true));
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [open, query, getContainer, runSearch]);

  // Paint the highlights + scroll to the active match whenever the result set
  // or the current index moves.
  useEffect(() => {
    if (!open) return;
    const ranges = rangesRef.current;
    applyHighlights(ranges, current);
    const container = getContainer();
    const range = ranges[current];
    if (container && range) scrollRangeIntoView(container, range);
  }, [open, current, matchCount, getContainer]);

  const goNext = useCallback(() => {
    setCurrent(prev => (matchCount === 0 ? 0 : (prev + 1) % matchCount));
  }, [matchCount]);

  const goPrev = useCallback(() => {
    setCurrent(prev => (matchCount === 0 ? 0 : (prev - 1 + matchCount) % matchCount));
  }, [matchCount]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.shiftKey ? goPrev() : goNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  const counter = invalidRegex
    ? 'Bad pattern'
    : matchCount === 0
      ? query
        ? 'No results'
        : ''
      : `${current + 1} of ${matchCount}`;

  const toggleBase =
    'flex items-center justify-center w-6 h-6 rounded text-[11px] font-medium transition-colors';
  const toggleOn = 'bg-blue-500/30 text-blue-200';
  const toggleOff = 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-lighter';
  const navBtn =
    'flex items-center justify-center w-6 h-6 rounded text-zinc-400 hover:text-zinc-100 hover:bg-surface-lighter disabled:opacity-30 disabled:hover:bg-transparent transition-colors';

  return (
    <div
      className="absolute top-2 right-4 z-30 flex items-center gap-1.5 bg-surface-light border border-border-light rounded-lg shadow-xl px-2 py-1.5"
      onKeyDown={e => e.stopPropagation()}
    >
      <div
        className={`flex items-center gap-1 bg-base border rounded px-1.5 ${
          invalidRegex ? 'border-red-500/60' : 'border-border'
        }`}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Find in chat"
          spellCheck={false}
          className="w-44 bg-transparent text-[12px] text-zinc-100 placeholder-zinc-600 outline-none py-1"
        />
        <button
          type="button"
          title="Match case"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive(v => !v)}
          className={`${toggleBase} ${caseSensitive ? toggleOn : toggleOff}`}
        >
          Aa
        </button>
        <button
          type="button"
          title="Match whole word"
          aria-pressed={wholeWord}
          onClick={() => setWholeWord(v => !v)}
          className={`${toggleBase} ${wholeWord ? toggleOn : toggleOff}`}
        >
          <span className="underline">ab</span>
        </button>
        <button
          type="button"
          title="Use regular expression"
          aria-pressed={useRegex}
          onClick={() => setUseRegex(v => !v)}
          className={`${toggleBase} ${useRegex ? toggleOn : toggleOff}`}
        >
          .*
        </button>
      </div>

      <span
        className={`text-[11px] tabular-nums whitespace-nowrap min-w-[58px] text-center ${
          invalidRegex ? 'text-red-400' : 'text-zinc-500'
        }`}
      >
        {counter}
      </span>

      <button
        type="button"
        title="Previous match (Shift+Enter)"
        onClick={goPrev}
        disabled={matchCount === 0}
        className={navBtn}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        onClick={goNext}
        disabled={matchCount === 0}
        className={navBtn}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button type="button" title="Close (Esc)" onClick={onClose} className={navBtn}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
