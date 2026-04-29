import { useEffect, useRef, useState, memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../lib/claude-client';
import type { ClaudeClient } from '../lib/claude-client';

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
type TerminalInstance = InstanceType<TerminalCtor>;
type FitAddonInstance = InstanceType<FitAddonCtor>;

let xtermModulesPromise: Promise<{ Terminal: TerminalCtor; FitAddon: FitAddonCtor }> | null = null;
function loadXterm() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }));
  }
  return xtermModulesPromise;
}

interface Props {
  message: ChatMessage;
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
   *  parent drop the bubble entirely (remove from shells list + registry).
   *  Only surfaced after the PTY has emitted its exit event; tapping it
   *  is a "goodbye", not a kill. */
  onClose?: () => void;
}

/**
 * Inline interactive PTY terminal rendered inside a chat message bubble.
 *
 * Created client-side when the user types `/terminal` or `/t` in the chat
 * input (see ChatApp.tsx `handleSend`). Mounts an xterm.js instance, asks
 * the server to spawn a PTY (`exec_shell`), pipes keystrokes via
 * `terminal_input`, and streams raw output back into xterm.
 *
 * `message.procId` doubles as the server-side process id (matches `message.id`).
 * On exit, the bubble stays visible but input is disabled and status flips to
 * `exited <code>`. No auto-restart — the user types `/t` again for a new shell.
 */
function InteractiveTerminalBubbleImpl({ message, sessionId, client, minimized, onToggleMinimize, hidden, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalInstance | null>(null);
  const fitRef = useRef<FitAddonInstance | null>(null);
  const didSpawnRef = useRef(false);
  const didReplayRef = useRef(false);
  const didSendInitialRef = useRef(false);
  const gotFirstDataRef = useRef(false);

  const procId = message.procId || message.id;
  const cwd = message.terminalCwd || '/';
  const initialCommand = message.terminalCommand;
  // On reload, the server-side `onTerminalExit` pipeline persists the exit
  // via `message.exitCode` (same reducer as one-shot terminals). Also honor
  // the newer `terminalExited` / `terminalExitCode` fields for forward-compat.
  const persistedExitCode = message.terminalExitCode ?? message.exitCode;
  const [exited, setExited] = useState<boolean>(!!message.terminalExited || persistedExitCode !== undefined);
  const [exitCode, setExitCode] = useState<number | undefined>(persistedExitCode);

  // Mount xterm, spawn PTY, wire subscriptions.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    loadXterm().then(({ Terminal, FitAddon }) => {
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
        theme: {
          background: '#141414',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          cursorAccent: '#141414',
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
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      termRef.current = term;
      fitRef.current = fit;
      try { fit.fit(); } catch {}

      // One-time replay of any persisted output (post-reload rehydrate).
      if (!didReplayRef.current && message.content) {
        try { term.write(message.content); } catch {}
      }
      didReplayRef.current = true;

      // Subscribe to live data BEFORE spawning so we don't miss the first chunk.
      const unsubData = client.onTerminalDataForProc(procId, (text: string) => {
        if (!gotFirstDataRef.current) {
          gotFirstDataRef.current = true;
          // Once the PTY has produced any output, it's safe to inject the
          // optional initial command typed after `/terminal` (e.g. `/t ls`).
          if (initialCommand && !didSendInitialRef.current) {
            didSendInitialRef.current = true;
            try { client.sendTerminalInput(sessionId, procId, initialCommand + '\r'); } catch {}
          }
        }
        try { term.write(text); } catch {}
      });

      const unsubExit = client.onTerminalExitForProc(procId, (code: number) => {
        setExited(true);
        setExitCode(code);
        try { term.options.cursorBlink = false; } catch {}
      });

      // Server sends this right before replaying the authoritative output
      // buffer on a re-attach (tab-switch / bubble remount / PWA reload).
      // Clear xterm first so the replay doesn't land on top of whatever
      // we optimistically wrote from `message.content` — otherwise every
      // character ends up duplicated.
      const unsubReset = client.onTerminalResetForProc(procId, () => {
        try { term.reset(); } catch {}
      });

      // Spawn the PTY exactly once per message mount (StrictMode-safe via ref).
      if (!didSpawnRef.current && !exited) {
        didSpawnRef.current = true;
        client.execShell(sessionId, procId, cwd, term.cols, term.rows);
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
      // `term.scrollLines(...)` calls. Accumulating the pixel delta keeps
      // the motion 1:1 with the finger; we only fire `scrollLines` when
      // the accumulator crosses a full row height, so no jitter.
      // Row height tracks xterm's computed `_core._renderService.dimensions`
      // (device-pixel-ratio aware) when available; falls back to
      // fontSize × lineHeight otherwise.
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
        // Must be non-passive for this to actually stop iOS/Android from
        // scrolling the outer page while we drag inside the terminal.
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

  // When we come back from minimized OR from hidden (shell switch), the
  // container just re-gained layout. Refit xterm to its visible size —
  // ResizeObserver alone doesn't fire when `display` toggles between
  // none/block on a parent.
  useEffect(() => {
    if (minimized || hidden) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // rAF so the browser has applied layout before we measure.
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        if (!exited) client.resizeTerminal(sessionId, procId, term.cols, term.rows);
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

  return (
    <div className="py-1" style={hidden ? { display: 'none' } : undefined}>
      <div className={`rounded-lg border overflow-hidden ${exited ? 'border-border-light bg-[#141414]/60' : 'border-green-900/50 bg-[#141414]'}`}>
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
            {cwdLabel || 'terminal'}
            {initialCommand ? <span className="text-zinc-600"> · {initialCommand}</span> : null}
          </span>
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
                title="Kill shell (SIGHUP)"
              >
                kill
              </button>
            </>
          )}
        </div>
        {/* Keep xterm mounted when minimized (preserves scrollback/cursor) — just hide visually. */}
        <div
          ref={containerRef}
          className="px-2 py-2"
          style={{
            height: minimized ? 0 : 280,
            padding: minimized ? 0 : undefined,
            overflow: 'hidden',
            background: '#141414',
            // Tell the browser we'll handle vertical drags ourselves — pan-y
            // lets a vertical touchmove reach our listener (which then
            // preventDefault's the page scroll). Without this, iOS Safari
            // eats the first touchmove and the page jumps instead of the
            // terminal scrolling.
            touchAction: 'pan-y',
          }}
        />
      </div>
    </div>
  );
}

export const InteractiveTerminalBubble = memo(InteractiveTerminalBubbleImpl);
