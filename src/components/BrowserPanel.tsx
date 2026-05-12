/**
 * Browser preview side-panel — embedded Tauri child webview.
 *
 * The panel renders a React control header at the top (Inspect, Send, Reload,
 * Close). The body is a sized-but-empty `<div ref={bodyRef}>`; its bounding
 * rect is what the Rust `browser_preview` module positions the native child
 * webview to. The page itself lives on that overlaid webview surface — same
 * Codiby window, no separate OS window.
 *
 * Layout sync: a ResizeObserver on the body div re-pushes `set_bounds` on
 * every measurable change. A window-resize listener catches the parent
 * window resizing past what the observer sees. Updates are coalesced into
 * a requestAnimationFrame so a splitter drag doesn't IPC-spam Rust.
 *
 * Wire:
 *
 *   panel → window:    Tauri invokes
 *                       - open_browser_preview(label, url, title, x, y, w, h)
 *                       - browser_preview_set_bounds(label, x, y, w, h)
 *                       - browser_preview_set_inspect(label, enabled)
 *                       - browser_preview_set_comments(label, comments)
 *                       - close_browser_preview(label)
 *
 *   window → panel:    Tauri events (relayed by Rust from the injected
 *                      inspector script).
 *                       - browser-preview://ready
 *                       - browser-preview://comments-changed
 *                       - browser-preview://inspect-auto-off
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MockupComment } from '../lib/mockup-inspector';

type CodibyBridge = {
  onBrowserPreviewEvent(
    eventName:
      | 'browser-preview://ready'
      | 'browser-preview://comments-changed'
      | 'browser-preview://inspect-auto-off'
      | 'browser-preview://url-changed',
    cb: (payload: { label: string; payload: string | null }) => void,
  ): () => void;
};

declare global {
  interface Window {
    codiby?: CodibyBridge;
  }
}

export type BrowserPanelProps = {
  label: string;
  url: string;
  title: string;
  openSeq: number;
  inspect: boolean;
  comments: MockupComment[];
  /** When true, hide the OS-level child webview so a React overlay (e.g.
   *  the Cmd+K palette) is visible. The webview sits on top of all React
   *  content otherwise. */
  obscured: boolean;
  onSetInspect: (next: boolean) => void;
  onSetComments: (next: MockupComment[]) => void;
  onSendToChat: (markdown: string) => void;
  onWriteToChat: (markdown: string) => void;
  onClose: () => void;
};

type RelayPayload = { label: string; payload: string | null };

function buildChatMessage(url: string, title: string, comments: MockupComment[]): string {
  const label = title || url;
  if (!comments.length) {
    // No element picks yet — just hand the agent a pointer to the page
    // currently in the panel. Plain markdown so the URL clicks.
    return `Browser open — \`${label}\` (${url})`;
  }
  const lines = [`Browser feedback — \`${label}\` (${url}):`, ''];
  comments.forEach((c, i) => {
    lines.push(`${i + 1}. \`${c.summary}\``);
    lines.push(`   ${c.text.split('\n').join('\n   ')}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Pick the right scheme for a bare host the user typed in the address bar.
 *  Localhost / loopback / private IPv4 ranges / mDNS `*.local` don't usually
 *  have TLS, so defaulting to https makes them un-reachable. Everything else
 *  defaults to https — typing `example.com` and getting plain http would be
 *  worse than the rare false negative on a corporate http-only intranet host. */
function coerceUrlScheme(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Strip any leading "//" the user might have pasted.
  const bare = trimmed.replace(/^\/\//, '');
  const host = bare.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  const hostname = host.split(':')[0]!.toLowerCase();
  const isLoopbackOrPrivate =
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.') ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localhost') ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  return `${isLoopbackOrPrivate ? 'http' : 'https'}://${bare}`;
}

type Bounds = { x: number; y: number; width: number; height: number };

function readBounds(el: HTMLElement | null): Bounds | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Defensively clamp to integers — sub-pixel bounds cause the OS-level
  // webview to jitter on splitter drags.
  return {
    x: Math.max(0, Math.round(r.left)),
    y: Math.max(0, Math.round(r.top)),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
}

function sameBounds(a: Bounds | null, b: Bounds | null): boolean {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function BrowserPanel({
  label, url, title, openSeq, inspect, comments, obscured,
  onSetInspect, onSetComments, onSendToChat, onWriteToChat, onClose,
}: BrowserPanelProps) {
  const [windowOpen, setWindowOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // The page's *actual* current URL, fed by the `url-changed` relay event.
  // Drifts away from the `url` prop when the user clicks links in the
  // embedded webview or types into the address bar.
  const [currentUrl, setCurrentUrl] = useState(url);
  // What's in the address-bar input. Diverges from `currentUrl` while the
  // user is typing; resets on submit / on a new page load.
  const [addressInput, setAddressInput] = useState(url);
  const addressEditingRef = useRef(false);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Last bounds we pushed to Rust — used to skip redundant IPCs.
  const lastBoundsRef = useRef<Bounds | null>(null);
  // Pending rAF id so we coalesce bursty observer notifications.
  const rafRef = useRef<number | null>(null);

  const commentsRef = useRef<MockupComment[]>(comments);
  commentsRef.current = comments;
  const onSetCommentsRef = useRef(onSetComments);
  onSetCommentsRef.current = onSetComments;
  const onSetInspectRef = useRef(onSetInspect);
  onSetInspectRef.current = onSetInspect;

  // Push current body bounds to Rust. Idempotent — no-ops when the bounds
  // haven't changed since the last push. Uses rAF to batch many synchronous
  // observer fires (splitter drag, fullscreen toggle) into one IPC.
  const pushBoundsIfChanged = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = readBounds(bodyRef.current);
      if (!next) return;
      if (sameBounds(next, lastBoundsRef.current)) return;
      lastBoundsRef.current = next;
      invoke('browser_preview_set_bounds', { label, ...next }).catch(() => {});
    });
  }, [label]);

  // Open: measure body, then ask Rust to attach a child webview to that
  // rect. Close on unmount.
  useEffect(() => {
    if (!isTauri()) {
      setOpenError('Browser preview requires the desktop app (Tauri).');
      return;
    }
    let cancelled = false;
    setOpenError(null);
    setWindowOpen(false);
    lastBoundsRef.current = null;

    // Wait one frame so the body div has a measurable rect even on the
    // first mount (e.g. when the panel pops open from `lastBrowser`).
    const start = requestAnimationFrame(() => {
      const rect = readBounds(bodyRef.current) || { x: 0, y: 0, width: 800, height: 600 };
      lastBoundsRef.current = rect;
      invoke<void>('open_browser_preview', {
        label,
        url,
        title,
        ...rect,
      })
        .then(() => { if (!cancelled) setWindowOpen(true); })
        .catch((e) => { if (!cancelled) setOpenError(String(e)); });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(start);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      invoke('close_browser_preview', { label }).catch(() => {});
    };
  }, [label, url, title, openSeq]);

  // Keep the child webview's bounds in sync with the body div.
  useEffect(() => {
    if (!windowOpen) return;
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => pushBoundsIfChanged());
    observer.observe(el);
    const onWindowResize = () => pushBoundsIfChanged();
    window.addEventListener('resize', onWindowResize);
    // Also push once at startup so the rect we measured pre-add_child is
    // corrected after the actual layout commits.
    pushBoundsIfChanged();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [windowOpen, pushBoundsIfChanged]);

  useEffect(() => {
    if (!windowOpen) return;
    invoke('browser_preview_set_inspect', { label, enabled: inspect }).catch(() => {});
  }, [inspect, windowOpen, label]);

  // Content-keyed diff — the parent recomputes `comments` as `… || []` so the
  // reference changes on every render even when nothing actually changed.
  // Without this guard we'd be invoking `set_comments` continuously, which
  // clobbers the inspector's locally-saved dot a few ms after the user saves
  // it (and the next pick restarts at number 1).
  const lastCommentsSigRef = useRef<string>('');
  useEffect(() => {
    if (!windowOpen) return;
    const sig = JSON.stringify(comments);
    if (sig === lastCommentsSigRef.current) return;
    lastCommentsSigRef.current = sig;
    invoke('browser_preview_set_comments', { label, comments }).catch(() => {});
  }, [comments, windowOpen, label]);

  // Listen for the relay events. Filter by label so two open browser
  // sessions in different tabs don't cross-talk.
  //
  // Under Electron we listen via `window.codiby.onBrowserPreviewEvent` —
  // the Tauri-compat invoke shim covers `invoke(...)` calls but the event
  // subsystem internals (`@tauri-apps/api/event`) require Tauri's
  // transformCallback registry to actually deliver. Under legacy Tauri the
  // old listen() path stays in use.
  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    let cancelled = false;
    const codiby = (typeof window !== 'undefined' ? window.codiby : null) || null;

    (async () => {
      const handle = async (
        eventName:
          | 'browser-preview://ready'
          | 'browser-preview://comments-changed'
          | 'browser-preview://inspect-auto-off'
          | 'browser-preview://url-changed',
        cb: (parsed: unknown) => void,
      ) => {
        const wrap = (p: { label: string; payload: string | null }) => {
          if (p.label !== label) return;
          let parsed: unknown = null;
          if (p.payload != null) {
            try { parsed = JSON.parse(p.payload); } catch { parsed = null; }
          }
          cb(parsed);
        };
        if (codiby) {
          const u = codiby.onBrowserPreviewEvent(eventName, wrap);
          if (cancelled) u();
          else unlistens.push(u);
          return;
        }
        const u = await listen<RelayPayload>(eventName, (e) => wrap(e.payload));
        if (cancelled) u();
        else unlistens.push(u);
      };

      await handle('browser-preview://ready', () => {
        invoke('browser_preview_set_inspect', { label, enabled: inspect }).catch(() => {});
        invoke('browser_preview_set_comments', { label, comments: commentsRef.current }).catch(() => {});
      });

      await handle('browser-preview://comments-changed', (parsed) => {
        if (!Array.isArray(parsed)) return;
        const next: MockupComment[] = parsed
          .filter((c): c is { id: string; selector: string; summary?: string; text?: string } =>
            !!c && typeof c === 'object' && typeof (c as any).id === 'string' && typeof (c as any).selector === 'string')
          .map((c) => ({
            id: c.id,
            selector: c.selector,
            summary: c.summary || c.selector,
            text: c.text || '',
          }));
        onSetCommentsRef.current(next);
      });

      await handle('browser-preview://inspect-auto-off', () => {
        onSetInspectRef.current(false);
      });

      await handle('browser-preview://url-changed', (parsed) => {
        const next = parsed && typeof parsed === 'object' && typeof (parsed as any).url === 'string'
          ? (parsed as any).url as string
          : null;
        if (!next) return;
        setCurrentUrl(next);
        // Only snap the address-bar input to the new URL when the user
        // isn't mid-edit — clobbering an in-progress URL on every popstate
        // would be infuriating.
        if (!addressEditingRef.current) setAddressInput(next);
      });
    })().catch(() => {});

    return () => {
      cancelled = true;
      for (const u of unlistens) { try { u(); } catch {} }
      unlistens = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Reset URL-bar state when the model points us at a new page — we
  // don't want stale `addressInput` from the previous page bleeding into
  // a fresh open.
  useEffect(() => {
    setCurrentUrl(url);
    setAddressInput(url);
    addressEditingRef.current = false;
  }, [url, openSeq]);

  // Hide the OS-level webview while an overlay (palette, modal, etc.)
  // is up so it doesn't sit on top of the React surface. Showing /
  // hiding the webview is a no-op when the same state is pushed twice.
  useEffect(() => {
    if (!windowOpen) return;
    invoke('browser_preview_set_visible', { label, visible: !obscured }).catch(() => {});
  }, [obscured, windowOpen, label]);

  const reload = useCallback(() => {
    if (!isTauri()) return;
    invoke('browser_preview_navigate', { label, action: 'reload', url: null }).catch(() => {});
  }, [label]);

  const goBack = useCallback(() => {
    invoke('browser_preview_navigate', { label, action: 'back', url: null }).catch(() => {});
  }, [label]);

  const goForward = useCallback(() => {
    invoke('browser_preview_navigate', { label, action: 'forward', url: null }).catch(() => {});
  }, [label]);

  const submitAddress = useCallback(() => {
    const next = coerceUrlScheme(addressInput);
    if (!next) return;
    setAddressInput(next);
    addressEditingRef.current = false;
    invoke('browser_preview_navigate', { label, action: 'goto', url: next }).catch((e) => setOpenError(String(e)));
  }, [label, addressInput]);

  const openExternal = useCallback(() => {
    try { window.open(currentUrl || url, '_blank', 'noopener,noreferrer'); } catch {}
  }, [url, currentUrl]);

  const sendToChat = useCallback(() => {
    const md = buildChatMessage(currentUrl || url, title, comments);
    if (md) onSendToChat(md);
  }, [currentUrl, url, title, comments, onSendToChat]);

  const writeToChat = useCallback(() => {
    const md = buildChatMessage(currentUrl || url, title, comments);
    if (md) onWriteToChat(md);
  }, [currentUrl, url, title, comments, onWriteToChat]);

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface gap-2">
        <div className="flex items-center gap-1.5 truncate cursor-default min-w-0">
          <span className="text-[10px] text-sky-400 shrink-0">◐</span>
          <span className="text-[12px] font-mono text-sky-300 shrink-0">browser ·</span>
          <span className="text-[12px] font-mono text-zinc-300 truncate" title={currentUrl || url}>{title || url}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className={`text-[11px] px-2 py-0.5 h-auto rounded transition-colors ${
              inspect
                ? 'bg-sky-500/20 text-sky-200 hover:bg-sky-500/30'
                : 'text-zinc-500 hover:text-sky-300'
            }`}
            onPress={() => onSetInspect(!inspect)}
            isDisabled={!windowOpen}
            aria-label={inspect ? 'Exit inspect mode' : 'Pick elements to comment on'}
          >
            {inspect ? '◉ Inspecting' : '◉ Inspect'}
          </Button>
          {comments.length > 0 && (
            <SendCommentsButton
              count={comments.length}
              onSend={sendToChat}
              onWrite={writeToChat}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-[11px] px-2 py-0.5 h-auto rounded text-zinc-500 hover:text-sky-300"
            onPress={openExternal}
            aria-label="Open in real browser"
          >
            ↗
          </Button>
          <Button isIconOnly size="sm" variant="ghost" className="text-zinc-500 hover:text-zinc-200 text-sm px-1 h-auto min-w-0" onPress={onClose} aria-label="Close browser preview">
            <span>×</span>
          </Button>
        </div>
      </div>
      {/* Navigation row: back / forward / reload / address input. Submit
          coerces bare hosts to https:// and routes through the Rust
          navigate command (which validates the URL before eval'ing into
          the webview). */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0 bg-surface-light">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!windowOpen}
          className="text-[12px] px-1.5 py-0.5 h-auto rounded text-zinc-400 hover:text-sky-300 disabled:opacity-30"
          onPress={goBack}
          aria-label="Back"
        >◀</Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!windowOpen}
          className="text-[12px] px-1.5 py-0.5 h-auto rounded text-zinc-400 hover:text-sky-300 disabled:opacity-30"
          onPress={goForward}
          aria-label="Forward"
        >▶</Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={!windowOpen}
          className="text-[12px] px-1.5 py-0.5 h-auto rounded text-zinc-400 hover:text-sky-300 disabled:opacity-30"
          onPress={reload}
          aria-label="Reload"
        >↻</Button>
        <input
          type="text"
          value={addressInput}
          onChange={(e) => { addressEditingRef.current = true; setAddressInput(e.target.value); }}
          onFocus={(e) => { addressEditingRef.current = true; e.currentTarget.select(); }}
          onBlur={() => { addressEditingRef.current = false; setAddressInput(currentUrl || url); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitAddress(); }
            else if (e.key === 'Escape') { e.preventDefault(); setAddressInput(currentUrl || url); addressEditingRef.current = false; (e.currentTarget as HTMLInputElement).blur(); }
          }}
          placeholder="https://…"
          className="flex-1 min-w-0 bg-[#0f172a]/60 text-[12px] font-mono text-zinc-200 rounded px-2 py-0.5 border border-border focus:border-sky-500/50 focus:outline-none placeholder:text-zinc-600"
          spellCheck={false}
          aria-label="Address bar"
        />
      </div>
      {/* The native child webview is overlaid on top of this div in screen
          coordinates. Keep it visually empty so the OS surface is what the
          user sees once the page boots. Error / loading states render here
          while the webview isn't attached yet. */}
      <div
        ref={bodyRef}
        className="flex-1 relative min-h-0 bg-[#0f172a]/40 overflow-hidden"
      >
        {(openError || !windowOpen) && (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6 text-zinc-400 pointer-events-none">
            <div className="max-w-md">
              {openError ? (
                <>
                  <div className="text-sky-300 text-sm mb-2">Couldn't open browser preview</div>
                  <div className="text-[12px] text-zinc-500 break-words">{openError}</div>
                </>
              ) : (
                <div className="text-[12px] text-zinc-500">Loading {url}…</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SendCommentsButton({
  count, onSend, onWrite,
}: {
  count: number;
  onSend: () => void;
  onWrite: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-stretch">
      <Button
        size="sm"
        variant="ghost"
        className="text-[11px] pl-2 pr-1.5 py-0.5 h-auto rounded-l text-sky-300 hover:bg-sky-500/20 transition-colors border border-r-0 border-transparent hover:border-sky-500/30"
        onPress={onSend}
        aria-label={count > 0 ? 'Send these comments to chat now and clear the dots' : 'Send the current URL to chat'}
      >
        {count > 0 ? `Send ${count} to chat` : 'Send to chat'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-[11px] px-1 py-0.5 h-auto rounded-r text-sky-300 hover:bg-sky-500/20 transition-colors border border-l-0 border-transparent hover:border-sky-500/30"
        onPress={() => setOpen(o => !o)}
        aria-label="More options"
        aria-expanded={open}
      >
        ▾
      </Button>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-20 min-w-[180px] bg-[#1f1f1f] border border-border-light rounded-md shadow-xl overflow-hidden">
          <Button
            variant="ghost"
            fullWidth
            className="block text-left justify-start text-[11px] px-3 py-1.5 h-auto rounded-none text-zinc-300 hover:bg-surface-light transition-colors"
            onPress={() => { setOpen(false); onWrite(); }}
            aria-label="Insert the comments into the chat input without sending"
          >
            Write to chat only
          </Button>
        </div>
      )}
    </div>
  );
}
