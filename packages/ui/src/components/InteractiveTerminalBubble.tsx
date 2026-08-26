import { useEffect, useRef, useState, memo, forwardRef, useImperativeHandle } from 'react';
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Eraser, X } from 'lucide-react';
import type { TerminalInfo } from '../lib/claude-client';
import type { ClaudeClient } from '../lib/claude-client';
import { useAppStore } from '../lib/store';

// xterm.css is a static side-effect import so Vite unconditionally bundles
// it into the component's CSS chunk. Without the stylesheet, xterm attaches
// to the DOM but the rows are positioned off-screen / invisible — the
// viewport renders as a completely empty black rectangle.
//
// (This file's component is already lazy-loaded via ChatApp's code split, so
// the CSS follows that same split — no unnecessary cost on the initial
// page load.)
import '@xterm/xterm/css/xterm.css';

// xterm.js JS itself is browser-only and must be loaded dynamically so
// Astro's SSR prerender step doesn't try to execute `document.*` code.
type TerminalCtor = typeof import('@xterm/xterm').Terminal;
type FitAddonCtor = typeof import('@xterm/addon-fit').FitAddon;
type SearchAddonCtor = typeof import('@xterm/addon-search').SearchAddon;
type TerminalInstance = InstanceType<TerminalCtor>;
type FitAddonInstance = InstanceType<FitAddonCtor>;
type SearchAddonInstance = InstanceType<SearchAddonCtor>;

// xterm colours are set in JS (not CSS), so the app-wide light/dark toggle
// can't reach them via the stylesheet — the terminal carries its own themes,
// applied on create and swapped live when the app theme flips.
const DARK_TERM_THEME = {
  background: '#0f1012',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#0f1012',
  selectionBackground: '#444',
  black:        '#1e1e1e',
  red:          '#f87171',
  green:        '#4ade80',
  yellow:       '#fbbf24',
  blue:         '#60a5fa',
  magenta:      '#c084fc',
  cyan:         '#22d3ee',
  white:        '#d4d4d4',
  brightBlack:  '#71717a',
  brightRed:    '#fca5a5',
  brightGreen:  '#86efac',
  brightYellow: '#fde68a',
  brightBlue:   '#93c5fd',
  brightMagenta:'#d8b4fe',
  brightCyan:   '#67e8f9',
  brightWhite:  '#f4f4f5',
};
// Light theme: background matches the light "content" surface (#fcfcfd) and the
// ANSI palette is darkened/desaturated so every colour keeps contrast on white
// (bright yellow/green are unreadable on light, so they map to darker tones).
const LIGHT_TERM_THEME = {
  background: '#fcfcfd',
  foreground: '#272a31',
  cursor: '#272a31',
  cursorAccent: '#fcfcfd',
  selectionBackground: '#d7e3f4',
  black:        '#24292e',
  red:          '#cf222e',
  green:        '#116329',
  yellow:       '#7d4e00',
  blue:         '#0969da',
  magenta:      '#8250df',
  cyan:         '#1b7c83',
  white:        '#6e7781',
  brightBlack:  '#57606a',
  brightRed:    '#a40e26',
  brightGreen:  '#1a7f37',
  brightYellow: '#633c01',
  brightBlue:   '#0550ae',
  brightMagenta:'#6639ba',
  brightCyan:   '#3192aa',
  brightWhite:  '#24292f',
};
const termThemeFor = (t: string) => (t === 'light' ? LIGHT_TERM_THEME : DARK_TERM_THEME);
const termBgFor = (t: string) => (t === 'light' ? '#fcfcfd' : '#0f1012');

let xtermModulesPromise: Promise<{ Terminal: TerminalCtor; FitAddon: FitAddonCtor; SearchAddon: SearchAddonCtor }> | null = null;
function loadXterm() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-search'),
    ]).then(([xterm, fit, search]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon, SearchAddon: search.SearchAddon }));
  }
  return xtermModulesPromise;
}

interface Props {
  terminal: TerminalInfo;
  sessionId: string;
  client: ClaudeClient;
  /** When true, hide the xterm body and only show the header row. Preserves
   *  the xterm instance (scrollback, cursor, focus) — just collapses its UI. */
  minimized?: boolean;
  /** Called when the user clicks the header chevron to toggle the minimized state. */
  onToggleMinimize?: () => void;
  /** When true, the whole bubble is `display:none` — xterm stays mounted so
   *  scrollback + running processes survive switching between shells. */
  hidden?: boolean;
  /** Called when the user taps "Close" on an exited terminal — lets the
   *  parent drop the bubble entirely. */
  onClose?: () => void;
  /** When true, the bubble renders only the xterm body — no header row,
   *  no rounded border, no inline status chrome. Used when the bottom
   *  Terminals panel hosts the bubble inside its own tab + status strip
   *  and the bubble's own chrome would be redundant duplication. */
  hideHeader?: boolean;
}

/** Imperative handle so an outer toolbar (e.g. the Terminals panel strip)
 *  can clear the active terminal without owning the xterm instance. */
export interface TerminalBubbleHandle {
  clear: () => void;
  openSearch: () => void;
}

/**
 * Live interactive PTY terminal.
 *
 * The terminal is a first-class server resource (see `TerminalInfo`), created
 * over `POST /sessions/:id/terminals` by the user (`/terminal`, the dock's
 * "new" button) or by an MCP tool (`spawn_terminal`, `actions_run`). This
 * component only renders + drives an already-created terminal: it mounts an
 * xterm.js instance, RE-ATTACHES to the server-side PTY (`attachTerminal` —
 * never spawns), pipes keystrokes via `terminal_input`, and streams raw output
 * back into xterm. Any auto-run command is typed by the server on the PTY's
 * first byte, so the bubble never sends it.
 */
const InteractiveTerminalBubbleImpl = forwardRef<TerminalBubbleHandle, Props>(function InteractiveTerminalBubbleImpl({ terminal, sessionId, client, minimized, onToggleMinimize, hidden, onClose, hideHeader }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalInstance | null>(null);
  const fitRef = useRef<FitAddonInstance | null>(null);
  const searchAddonRef = useRef<SearchAddonInstance | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didAttachRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState({ resultIndex: -1, resultCount: 0 });

  // Right-click context menu anchor (viewport coords), null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const theme = useAppStore(s => s.theme);
  const termBg = termBgFor(theme);

  // Swap the xterm palette live when the app theme flips (the instance persists
  // across the toggle, so we mutate its options rather than recreating it).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termThemeFor(theme);
  }, [theme]);

  const procId = terminal.procId || terminal.id;
  const cwd = terminal.cwd || '/';
  // `command` is "(interactive shell)" for a bare shell — don't surface that.
  const displayCommand = terminal.command && terminal.command !== '(interactive shell)' ? terminal.command : undefined;
  const [exited, setExited] = useState<boolean>(terminal.exitCode !== null && terminal.exitCode !== undefined);
  const [exitCode, setExitCode] = useState<number | undefined>(terminal.exitCode ?? undefined);

  // Mount xterm, attach to the PTY, wire subscriptions.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    loadXterm().then(({ Terminal, FitAddon, SearchAddon }) => {
      if (cancelled || !containerRef.current) return;

      const term = new Terminal({
        fontFamily: '"SF Mono", "Fira Code", Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: !exited,
        cursorStyle: 'block',
        allowProposedApi: true,
        scrollback: 5000,
        convertEol: false,
        // Read non-reactively so a theme flip doesn't re-run this mount effect
        // (which would recreate the terminal). The effect below updates the
        // live theme instead.
        theme: termThemeFor(useAppStore.getState().theme),
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fit;
      searchAddonRef.current = search;
      const searchResultsDisposable = search.onDidChangeResults(setSearchResults);
      try { fit.fit(); } catch {}

      // Subscribe to live data BEFORE attaching so we don't miss the replay.
      const unsubData = client.onTerminalDataForProc(procId, (text: string) => {
        try { term.write(text); } catch {}
      });

      const unsubExit = client.onTerminalExitForProc(procId, (code: number) => {
        setExited(true);
        setExitCode(code);
        try { term.options.cursorBlink = false; } catch {}
      });

      // Server sends this right before replaying the authoritative output
      // buffer on attach. Clear xterm first so the replay doesn't land on top
      // of any stale content.
      const unsubReset = client.onTerminalResetForProc(procId, () => {
        try { term.reset(); } catch {}
      });

      // Attach exactly once per mount (StrictMode-safe via ref). Skip while
      // `hidden` — the bubble is inside a `display:none` tab so `fit.fit()`
      // saw a 0×0 container and cols/rows are still xterm defaults (80×24).
      // The resize-on-show effect below performs the first attach with the
      // real dimensions once the tab becomes visible.
      if (!didAttachRef.current && !exited && !hidden) {
        didAttachRef.current = true;
        client.attachTerminal(sessionId, procId, term.cols, term.rows);
      }

      // Forward keystrokes (xterm already encodes Enter as \r, Ctrl+C as \x03, arrows, etc.)
      const onDataDisposable = term.onData((data: string) => {
        if (exited) return;
        try { client.sendTerminalInput(sessionId, procId, data); } catch {}
      });

      // Resize on container size change
      const ro = new ResizeObserver(() => {
        if (!fitRef.current || !termRef.current) return;
        try {
          fitRef.current.fit();
          const { cols, rows } = termRef.current;
          if (!exited) client.resizeTerminal(sessionId, procId, cols, rows);
        } catch {}
      });
      if (containerRef.current) ro.observe(containerRef.current);

      // Finger-drag scrolling — xterm's viewport doesn't react to touch
      // gestures on its own, so we translate vertical drags into
      // `term.scrollLines(...)` calls.
      const readRowHeight = (): number => {
        try {
          const d = (term as any)._core?._renderService?.dimensions;
          const css = d?.css?.cell?.height ?? d?.actualCellHeight;
          if (typeof css === 'number' && css > 0) return css;
        } catch {}
        return 12 * 1.2; // matches the config above
      };

      let touchLastY = 0;
      let touchAccumPx = 0;
      let touchActive = false;
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        touchLastY = e.touches[0]!.clientY;
        touchAccumPx = 0;
        touchActive = true;
      };
      const onTouchMove = (e: TouchEvent) => {
        if (!touchActive || e.touches.length !== 1) return;
        const y = e.touches[0]!.clientY;
        touchAccumPx += touchLastY - y;
        touchLastY = y;
        const rowPx = readRowHeight();
        const lines = Math.trunc(touchAccumPx / rowPx);
        if (lines !== 0) {
          try { term.scrollLines(lines); } catch {}
          touchAccumPx -= lines * rowPx;
        }
        e.preventDefault();
      };
      const onTouchEnd = () => { touchActive = false; };
      const termEl = containerRef.current;
      if (termEl) {
        termEl.addEventListener('touchstart', onTouchStart, { passive: true });
        termEl.addEventListener('touchmove', onTouchMove, { passive: false });
        termEl.addEventListener('touchend', onTouchEnd, { passive: true });
        termEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
      }

      cleanup = () => {
        try { ro.disconnect(); } catch {}
        try { onDataDisposable.dispose(); } catch {}
        try { searchResultsDisposable.dispose(); } catch {}
        try { unsubData(); } catch {}
        try { unsubExit(); } catch {}
        try { unsubReset(); } catch {}
        if (termEl) {
          try { termEl.removeEventListener('touchstart', onTouchStart); } catch {}
          try { termEl.removeEventListener('touchmove', onTouchMove); } catch {}
          try { termEl.removeEventListener('touchend', onTouchEnd); } catch {}
          try { termEl.removeEventListener('touchcancel', onTouchEnd); } catch {}
        }
        try { term.dispose(); } catch {}
        termRef.current = null;
        fitRef.current = null;
        searchAddonRef.current = null;
      };
    }).catch((err) => {
      console.error('[InteractiveTerminalBubble] failed to load xterm:', err);
    });

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procId]);

  const handleKill = () => {
    if (exited) return;
    try { client.killTerminal(sessionId, procId); } catch {}
  };

  // Wipe the xterm viewport + scrollback, keeping the current prompt line.
  // Purely client-side (the server's replay buffer is untouched) — refocus
  // so the user can keep typing right after clearing.
  const clearTerminal = () => {
    const term = termRef.current;
    if (!term) return;
    try { term.clear(); } catch {}
    try { if (!exited) term.focus(); } catch {}
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchResults({ resultIndex: -1, resultCount: 0 });
    try { searchAddonRef.current?.clearDecorations(); } catch {}
    try { termRef.current?.focus(); } catch {}
  };

  const search = (direction: 'next' | 'previous', query = searchQuery) => {
    const addon = searchAddonRef.current;
    if (!addon || !query) {
      try { addon?.clearDecorations(); } catch {}
      setSearchResults({ resultIndex: -1, resultCount: 0 });
      return;
    }
    const options = {
      incremental: direction === 'next',
      decorations: {
        matchBackground: theme === 'light' ? '#fef08a' : '#665c1e',
        matchOverviewRuler: theme === 'light' ? '#ca8a04' : '#eab308',
        activeMatchBackground: theme === 'light' ? '#f59e0b' : '#b45309',
        activeMatchColorOverviewRuler: theme === 'light' ? '#b45309' : '#fb923c',
      },
    };
    try {
      if (direction === 'previous') addon.findPrevious(query, options);
      else addon.findNext(query, options);
    } catch {}
  };

  const openSearch = () => setSearchOpen(true);
  useImperativeHandle(ref, () => ({ clear: clearTerminal, openSearch }), [exited]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [searchOpen]);

  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Dismiss the menu on any outside interaction (click, another right-click,
  // scroll, resize, Escape).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const contextMenu = menu ? (
    <div
      className="fixed z-[9999] min-w-[168px] rounded-md border border-border-light bg-surface-light py-1 shadow-xl"
      style={{ top: menu.y, left: menu.x }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-surface-lighter hover:text-zinc-100"
        onClick={() => { clearTerminal(); setMenu(null); }}
      >
        <Eraser className="w-3.5 h-3.5" />
        Clear terminal
      </button>
    </div>
  ) : null;

  const searchWidget = searchOpen ? (
    <div
      className="absolute right-3 top-2 z-20 flex h-8 items-center overflow-hidden rounded-md border border-border-light bg-surface-light shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={searchInputRef}
        value={searchQuery}
        onChange={(e) => {
          const query = e.target.value;
          setSearchQuery(query);
          search('next', query);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') closeSearch();
          else if (e.key === 'Enter') search(e.shiftKey ? 'previous' : 'next');
        }}
        className="h-full w-52 bg-transparent px-2.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
        placeholder="Find in terminal"
        aria-label="Find in terminal"
      />
      <span className="min-w-12 px-1 text-center text-[10px] tabular-nums text-zinc-500">
        {searchQuery ? (searchResults.resultCount ? `${searchResults.resultIndex + 1}/${searchResults.resultCount}` : 'No results') : ''}
      </span>
      <button type="button" onClick={() => search('previous')} className="h-full w-7 inline-flex items-center justify-center text-zinc-400 hover:bg-surface-lighter hover:text-zinc-100" title="Previous match (Shift+Enter)">
        <ChevronsUp size={13} />
      </button>
      <button type="button" onClick={() => search('next')} className="h-full w-7 inline-flex items-center justify-center text-zinc-400 hover:bg-surface-lighter hover:text-zinc-100" title="Next match (Enter)">
        <ChevronsDown size={13} />
      </button>
      <button type="button" onClick={closeSearch} className="h-full w-7 inline-flex items-center justify-center text-zinc-400 hover:bg-surface-lighter hover:text-zinc-100" title="Close (Escape)">
        <X size={13} />
      </button>
    </div>
  ) : null;

  // When we come back from minimized OR from hidden (shell switch), the
  // container just re-gained layout. Refit xterm to its visible size —
  // ResizeObserver alone doesn't fire when `display` toggles between
  // none/block on a parent. Also handles the deferred-attach case: the mount
  // effect skips attach when `hidden` is true, and this effect picks it up
  // the first time the bubble actually has layout.
  useEffect(() => {
    if (minimized || hidden) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        if (!didAttachRef.current && !exited) {
          didAttachRef.current = true;
          client.attachTerminal(sessionId, procId, term.cols, term.rows);
        } else if (!exited) {
          client.resizeTerminal(sessionId, procId, term.cols, term.rows);
        }
        term.focus();
      } catch {}
    });
    return () => cancelAnimationFrame(raf);
  }, [minimized, hidden, exited, client, sessionId, procId]);

  // Short, readable cwd label
  const cwdLabel = (() => {
    if (!cwd) return '';
    const home = (typeof window !== 'undefined' && (window as any).__HOME__) || '';
    const s = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return s.length > 40 ? '…' + s.slice(-40) : s;
  })();

  // Header-less mode: the bottom Terminals panel hosts the bubble inside
  // its own tab + status strip, so the bubble's wrapper / header would
  // just be duplicated chrome. Render only the xterm container.
  if (hideHeader) {
    return (
      <>
        <div className="relative h-full w-full" style={{ display: hidden ? 'none' : undefined }}>
          {searchWidget}
          <div
            ref={containerRef}
            onContextMenu={openContextMenu}
            style={{
              height: '100%',
              width: '100%',
              background: termBg,
              padding: '6px 8px',
              overflow: 'hidden',
              touchAction: 'pan-y',
            }}
          />
        </div>
        {contextMenu}
      </>
    );
  }

  return (
    <div className="py-1" style={hidden ? { display: 'none' } : undefined}>
      {contextMenu}
      <div
        className={`rounded-lg border overflow-hidden ${exited ? 'border-border-light' : 'border-green-900/50'}`}
        style={{ background: termBg, opacity: exited ? 0.85 : undefined }}
      >
        <div
          className={`flex items-center gap-2 px-3 py-1.5 bg-surface-light border-b border-border-light select-none ${onToggleMinimize ? 'cursor-pointer hover:bg-surface-lighter' : ''}`}
          onClick={onToggleMinimize}
          title={onToggleMinimize ? (minimized ? 'Click to expand' : 'Click to minimize') : undefined}
        >
          <span className="text-zinc-500 shrink-0">
            {minimized ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <span className="text-[10px] text-green-400 font-mono shrink-0">$</span>
          <span className="text-[11px] font-mono text-zinc-400 truncate flex-1">
            {terminal.terminalName ? (
              <>
                <span className="text-violet-300 font-medium">{terminal.terminalName}</span>
                {cwdLabel ? <span className="text-zinc-600"> · {cwdLabel}</span> : null}
              </>
            ) : (
              <>
                {cwdLabel || 'terminal'}
                {displayCommand ? <span className="text-zinc-600"> · {displayCommand}</span> : null}
              </>
            )}
          </span>
          <button
            className="text-zinc-500 hover:text-zinc-100 shrink-0 p-0.5 rounded hover:bg-surface-lighter transition-colors"
            onClick={(e) => { e.stopPropagation(); clearTerminal(); }}
            title="Clear terminal"
          >
            <Eraser size={12} />
          </button>
          {exited ? (
            <>
              <span className={`text-[10px] font-mono shrink-0 ${exitCode === 0 ? 'text-green-400' : 'text-red-400'}`}>
                exit {exitCode ?? 0}
              </span>
              {onClose && (
                <button
                  className="text-zinc-400 hover:text-zinc-100 text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border border-border-light hover:border-zinc-600 transition-colors"
                  onClick={(e) => { e.stopPropagation(); onClose(); }}
                  title="Remove this terminal"
                >
                  close
                </button>
              )}
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-[10px] text-green-400 shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                running
              </span>
              <button
                className="text-zinc-500 hover:text-red-400 text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border border-border-light hover:border-red-900/60 transition-colors"
                onClick={(e) => { e.stopPropagation(); handleKill(); }}
                title="Kill shell"
              >
                kill
              </button>
            </>
          )}
        </div>
        {/* Keep xterm mounted when minimized (preserves scrollback/cursor) — just hide visually. */}
        <div className="relative">
          {searchWidget}
          <div
            ref={containerRef}
            onContextMenu={openContextMenu}
            className="px-2 py-2"
            style={{
              height: minimized ? 0 : 280,
              padding: minimized ? 0 : undefined,
              overflow: 'hidden',
              background: termBg,
              touchAction: 'pan-y',
            }}
          />
        </div>
      </div>
    </div>
  );
});

export const InteractiveTerminalBubble = memo(InteractiveTerminalBubbleImpl);
