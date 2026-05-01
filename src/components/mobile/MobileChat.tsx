import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ChevronDown, ChevronRight, ArrowDown, LayoutGrid, X as XIcon } from 'lucide-react';
import type { ChatMessage, ClaudeClient, PermissionRequest, SessionInfo } from '../../lib/claude-client';
import { getAuthToken, resolveServerUrl } from '../../lib/claude-client';
import { Terminal as TerminalIcon } from 'lucide-react';
import { Markdown } from '../Markdown';
import { InteractiveTerminalBubble } from '../InteractiveTerminalBubble';
import { PermissionCard } from './PermissionCard';
import { MobileAskQuestionCard } from './AskQuestionCard';
import { DiffView } from './DiffView';
import { MobileDiffModal } from './MobileDiffModal';
import { MobileActionSheet, type ActionSheetId } from './MobileActionSheet';
import { MobileImageViewer } from './MobileImageViewer';
import { collapseToolRuns, toolRunSummary } from '../MessageBubble';
import type { ToolRunGroup } from '../MessageBubble';

/** Tailwind classes that bump the Markdown component's default 12px sizing
 *  up to mobile-readable sizes. The Markdown component sets a base of
 *  text-[12px] on its root <div>; everything inside inherits unless a
 *  descendant has its own font-size class (headings, inline code, code blocks).
 *  We bump the base to 15px and let inherited sizes flow through. */
const MOBILE_MD_CLS = 'text-[15px] [&_p]:my-1 [&_pre]:my-2';

interface Props {
  client: ClaudeClient;
  session: SessionInfo | null;
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  permRequest: PermissionRequest | null;
  status: string;
  /** False until the first `session_state` snapshot lands. While false,
   *  empty-state placeholders are suppressed — the BottomLoader bar is the
   *  canonical loading affordance. */
  hydrated: boolean;
  /** Called when the user taps the header to open the sessions sheet. */
  onOpenSessions: () => void;
  /** Called after the user taps Allow/Deny so the caller can clear the
   *  permission card immediately — the server broadcast arrives ~50ms later
   *  over WS, but touch interfaces expect instant feedback. */
  onLocalClearPerm?: (requestId: string) => void;
  /** When true, the bottom nav is hidden and the composer slides down to
   *  occupy the freed space. Toggled by the scroll handler in this component. */
  chromeHidden?: boolean;
  onChromeHiddenChange?: (hidden: boolean) => void;
  /** Called whenever the composer box's rendered pixel height changes —
   *  parent uses it to size the ambient blob container behind the composer. */
  onComposerHeightChange?: (px: number) => void;
  /** Spawn an interactive PTY shell as a chat bubble. Called when the user
   *  types /terminal [cmd], /t [cmd], or > cmd in the input. The parent
   *  manages the local shell list (server doesn't know these messages). */
  onCreateShell?: (procId: string, cwd: string, initialCommand?: string) => void;
  /** Drop a shell from the session after its PTY has exited — fired by the
   *  "close" button on the bubble header, and implicitly by the dock chip's
   *  dismiss affordance. Parent is expected to kill the server-side proc
   *  (best-effort) and remove the entry from its shells list. */
  onRemoveShell?: (procId: string) => void;
  /** Locally-managed interactive shells for this session — rendered inline
   *  at the bottom of the message list. */
  shells?: { id: string; procId: string; cwd: string; command?: string; createdAt: number }[];
  /** Open the new-session modal. Wired by MobileApp; called when the
   *  action sheet's "New session" tile is tapped. */
  onOpenNewSession?: () => void;
  /** `/clear` typed in the composer — archive the current session under
   *  "Cleared: …" and replace this tab with a fresh session in the same
   *  slot. Owned by MobileApp because it touches global tab/group state. */
  onClearSession?: () => void;
  /** Called when the user taps the mode badge to cycle the active session's
   *  permission mode. Lets MobileApp optimistically update its session list
   *  while we also push the change to the server. */
  onPermissionModeChange?: (mode: string) => void;
}

export function MobileChat({
  client,
  session,
  messages,
  partialText,
  isStreaming,
  permRequest,
  status,
  hydrated,
  onOpenSessions,
  onLocalClearPerm,
  chromeHidden,
  onChromeHiddenChange,
  onComposerHeightChange,
  onCreateShell,
  onRemoveShell,
  shells,
  onOpenNewSession,
  onClearSession,
  onPermissionModeChange,
}: Props) {
  const [input, setInput] = useState('');
  // Pending image attachments — base64 + media_type, shown as thumbnails
  // above the composer, sent alongside the next message.
  type Attachment = { id: string; media_type: string; data: string; previewUrl: string; name: string };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Per-session queue of messages typed while a turn is still streaming.
  // Drained one-at-a-time on the streaming→idle transition for that session.
  type PendingMessage = {
    id: string;
    text: string;
    images?: { media_type: string; data: string }[];
  };
  const [pendingBySession, setPendingBySession] = useState<Record<string, PendingMessage[]>>({});
  const pending = (session && pendingBySession[session.id]) || [];
  const removePending = (sid: string, pid: string) => {
    setPendingBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).filter((p) => p.id !== pid),
    }));
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const chromeBoxRef = useRef<HTMLDivElement>(null);

  // Message-list arrival animation. We animate only DOM children that mount
  // *after* the initial hydration burst — so opening a 200-message session
  // doesn't stagger-animate the whole history. `readyToAnimate` flips ~50 ms
  // after `hydrated` so the bulk render commits unanimated; from then on,
  // any new <li> appended to the UL fades + slides in. The watermark
  // (`lastChildCountRef`) tracks how many children we've already accounted
  // for so we only animate the trailing additions. Resets on session change.
  const ulRef = useRef<HTMLUListElement>(null);
  const lastChildCountRef = useRef(0);
  const [readyToAnimate, setReadyToAnimate] = useState(false);
  useEffect(() => {
    setReadyToAnimate(false);
    lastChildCountRef.current = 0;
    if (!hydrated) return;
    const t = setTimeout(() => {
      if (ulRef.current) lastChildCountRef.current = ulRef.current.children.length;
      setReadyToAnimate(true);
    }, 50);
    return () => clearTimeout(t);
  }, [session?.id, hydrated]);
  useLayoutEffect(() => {
    if (!readyToAnimate || !ulRef.current) return;
    const ul = ulRef.current;
    const count = ul.children.length;
    if (count <= lastChildCountRef.current) {
      // Children removed (partialText unmounted on turn complete, etc.) or
      // unchanged — just resync the watermark, no animation.
      lastChildCountRef.current = count;
      return;
    }
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      const fresh = Array.from(ul.children).slice(lastChildCountRef.current);
      gsap.from(fresh, {
        opacity: 0,
        y: 12,
        duration: 0.28,
        ease: 'power2.out',
        stagger: 0.04,
      });
    }
    lastChildCountRef.current = count;
  }, [messages.length, pending.length, readyToAnimate]);
  // Actual pixel height of the whole bottom chrome column (dock + attachments
  // + recorder + composer) — fed to the scroll area's paddingBottom so the
  // last message and inline permission cards never sit underneath the floating
  // pills. The composer on its own is reported separately via
  // onComposerHeightChange for the ambient blob sizing behind it.
  const [chromeHeightPx, setChromeHeightPx] = useState<number>(56);

  // Per-shell minimized state. Stored as a Set of shell ids so multiple
  // inline terminals can be collapsed independently without tearing down
  // their xterm state (InteractiveTerminalBubble keeps the xterm mounted
  // and just hides the pane, preserving scrollback + cursor).
  const [minimizedShells, setMinimizedShells] = useState<Set<string>>(new Set());
  const toggleShellMinimized = (id: string) => {
    setMinimizedShells((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Action sheet (opened from the dock pill row above the composer).
  // Tiles dispatch into existing composer affordances — there's no new
  // persistence layer behind it.
  const [actionSheetOpen, setActionSheetOpen] = useState(false);

  // Fullscreen image viewer — set by tapping any inline image in the chat.
  // Single state at the chat root so we render exactly one portal modal.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const handleActionSheet = (id: ActionSheetId) => {
    if (id === 'new-terminal') {
      stickToBottomRef.current = true;
      onCreateShell?.(crypto.randomUUID(), session?.cwd || '/');
    } else if (id === 'run-command') {
      setInput('> ');
      requestAnimationFrame(() => taRef.current?.focus());
    } else if (id === 'attach-image') {
      fileInputRef.current?.click();
    } else if (id === 'voice-note') {
      startRecording();
    } else if (id === 'new-session') {
      onOpenNewSession?.();
    }
  };

  // ── Voice-note recorder (Telegram-style) ────────────────────────────────
  // Tap mic → composer swaps for a recording bar with cancel + send. On
  // send we ship the blob to /deepgram/transcribe, turn the transcript
  // into a regular text message, and clear the bar.
  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [recElapsed, setRecElapsed] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCancelledRef = useRef(false);

  const stopRecElapsedTicker = () => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
  };
  const releaseMic = () => {
    if (recStreamRef.current) {
      for (const t of recStreamRef.current.getTracks()) { try { t.stop(); } catch {} }
      recStreamRef.current = null;
    }
    recorderRef.current = null;
  };

  const startRecording = async () => {
    if (!session || recState !== 'idle') return;
    setRecError(null);
    setRecElapsed(0);
    recCancelledRef.current = false;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecError('Mic needs a secure context (https or localhost).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;
      const MR = (window as any).MediaRecorder as typeof MediaRecorder | undefined;
      if (!MR) throw new Error('This browser has no MediaRecorder.');
      // Opus when available, otherwise whatever the browser picks.
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
        .find((c) => !c || MR.isTypeSupported(c)) || '';
      const rec = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
      recChunksRef.current = [];
      rec.addEventListener('dataavailable', (ev) => {
        if (ev.data && ev.data.size > 0) recChunksRef.current.push(ev.data);
      });
      recorderRef.current = rec;
      rec.start();
      const startedAt = Date.now();
      recTimerRef.current = setInterval(() => {
        setRecElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      setRecState('recording');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRecError(msg);
      releaseMic();
    }
  };

  const cancelRecording = () => {
    recCancelledRef.current = true;
    stopRecElapsedTicker();
    const rec = recorderRef.current;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch {}
    releaseMic();
    recChunksRef.current = [];
    setRecState('idle');
    setRecElapsed(0);
  };

  const finishRecording = async () => {
    const rec = recorderRef.current;
    if (!rec || !session) return;
    stopRecElapsedTicker();

    // Wait for the recorder's trailing dataavailable + stop events before
    // assembling the blob, so we don't miss the tail of the utterance.
    const blobPromise = new Promise<Blob>((resolve) => {
      rec.addEventListener('stop', () => {
        const type = rec.mimeType || 'audio/webm';
        resolve(new Blob(recChunksRef.current, { type }));
      }, { once: true });
    });
    try { rec.stop(); } catch {}
    const blob = await blobPromise;
    releaseMic();
    recChunksRef.current = [];

    if (recCancelledRef.current) { setRecState('idle'); return; }
    if (blob.size === 0) {
      setRecError('Empty recording.');
      setRecState('idle');
      return;
    }

    setRecState('transcribing');
    try {
      const base = await resolveServerUrl();
      const token = getAuthToken();
      const url = `${base}/deepgram/transcribe${token ? `?t=${encodeURIComponent(token)}` : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const { transcript } = (await res.json()) as { transcript?: string };
      const clean = (transcript || '').trim();
      if (!clean) {
        setRecError('No speech detected.');
      } else {
        client.sendMessage(session.id, clean);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRecError(`Transcription failed: ${msg}`);
    } finally {
      setRecState('idle');
      setRecElapsed(0);
    }
  };

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => () => {
    stopRecElapsedTicker();
    releaseMic();
  }, []);

  // Report the composer's rendered height up so the parent can size the
  // ambient color-blob container behind it. Fires on mount + every resize.
  useEffect(() => {
    const el = composerBoxRef.current;
    const chrome = chromeBoxRef.current;
    if (chrome) setChromeHeightPx(chrome.getBoundingClientRect().height);
    if (!el) return;
    if (onComposerHeightChange) onComposerHeightChange(el.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === chrome) setChromeHeightPx(e.contentRect.height);
        else if (onComposerHeightChange) onComposerHeightChange(e.contentRect.height);
      }
    });
    ro.observe(el);
    if (chrome) ro.observe(chrome);
    return () => ro.disconnect();
  }, [onComposerHeightChange]);

  // Auto-scroll to bottom when content grows (pinned-to-bottom behavior).
  const stickToBottomRef = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, partialText, permRequest, shells?.length]);

  // Scroll handler — does double duty:
  //   1. Tracks "pinned to bottom" so streaming messages auto-scroll.
  //   2. Detects scroll direction with a small accumulator and tells the
  //      parent to hide / show the bottom chrome (nav + composer follows).
  const lastScrollTopRef = useRef(0);
  const accumDeltaRef = useRef(0);
  // Reactive version of stickToBottomRef — drives the floating
  // "scroll to bottom" button visibility.
  const [showScrollDown, setShowScrollDown] = useState(false);
  // After toggling chrome, the bottom padding changes which can cause the
  // browser to snap scrollTop and emit a scroll event. Without this lockout,
  // that snap is interpreted as an "opposite direction" scroll and the
  // chrome immediately flips back, producing a flicker.
  const chromeLockUntilRef = useRef(0);

  const toggleChrome = (hide: boolean) => {
    if (!onChromeHiddenChange) return;
    onChromeHiddenChange(hide);
    chromeLockUntilRef.current = Date.now() + 350;
    accumDeltaRef.current = 0;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
    // Show the floating jump-to-bottom button only when the user is well
    // away from the bottom (>200px). The threshold is generous so it
    // doesn't flicker for tiny scroll wiggles.
    setShowScrollDown(distanceFromBottom > 200);

    if (!onChromeHiddenChange) { lastScrollTopRef.current = el.scrollTop; return; }

    // While the composer textarea has focus (keyboard open), the user is in
    // "send mode" — don't let scroll events triggered by message-arrival
    // reflow / visualViewport shifts toggle chrome under them. Resume the
    // normal swipe-to-toggle behaviour as soon as focus leaves the textarea.
    if (document.activeElement === taRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      accumDeltaRef.current = 0;
      return;
    }

    // Lockout window after a recent toggle — accept that scrollTop has shifted
    // because of the padding change and reset our reference so the next real
    // user gesture computes a fresh delta.
    if (Date.now() < chromeLockUntilRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      accumDeltaRef.current = 0;
      return;
    }

    const delta = el.scrollTop - lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // Flip sign if direction changed → reset accumulator
    if ((delta > 0 && accumDeltaRef.current < 0) || (delta < 0 && accumDeltaRef.current > 0)) {
      accumDeltaRef.current = 0;
    }
    accumDeltaRef.current += delta;

    // Always show when near top so the user has the nav to switch sessions.
    if (el.scrollTop < 32) {
      if (chromeHidden) toggleChrome(false);
      accumDeltaRef.current = 0;
      return;
    }
    // Hide on a sustained downward swipe; show on any meaningful upward swipe.
    if (accumDeltaRef.current > 60 && !chromeHidden) {
      toggleChrome(true);
    } else if (accumDeltaRef.current < -20 && chromeHidden) {
      toggleChrome(false);
    }
  };

  // Auto-grow the textarea (capped) as the user types
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [input]);

  // When the soft keyboard slides up/down the visual viewport changes size.
  // If a terminal bubble's xterm has focus at that moment, re-align it so
  // the keyboard never sits over the prompt.
  useEffect(() => {
    const vv = (typeof window !== 'undefined' && window.visualViewport) || null;
    if (!vv) return;
    const onResize = () => {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused) return;
      // Skip the composer's own textarea — browser handles it natively.
      if (focused === taRef.current) return;
      const li = focused.closest('li');
      if (!li) return;
      try { li.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch {}
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const resetComposer = () => {
    setInput('');
    setAttachments([]);
    setAttachError(null);
    stickToBottomRef.current = true;
    // Suppress chrome auto-toggle for 800 ms — covers the scroll/reflow churn
    // from the user-message echo + auto-scroll-to-bottom that follows send.
    chromeLockUntilRef.current = Date.now() + 800;
    accumDeltaRef.current = 0;
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) { ta.style.height = 'auto'; }
      // Restore focus so the keyboard stays up after send (matches iMessage/
      // Telegram behaviour). `preventScroll` keeps iOS from jumping the
      // viewport when refocusing under the keyboard.
      ta?.focus({ preventScroll: true });
    }, 0);
  };

  const send = () => {
    if (!session) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    // ─── Client-side `/clear` ────────────────────────────────────────────
    // Archive current chat under "Cleared: …" and replace the tab with a
    // fresh session in the same slot. Never sent to Claude.
    if (text === '/clear') {
      resetComposer();
      onClearSession?.();
      return;
    }

    // ─── Interactive PTY terminal: /terminal [cmd]  or  /t [cmd] ───────
    // Same intercept as ChatApp.tsx — never sent to Claude, spawns a
    // long-lived shell rendered inline via InteractiveTerminalBubble.
    if (onCreateShell) {
      const slashTermMatch = text.match(/^\/(terminal|t)(?:\s+([\s\S]*))?$/);
      if (slashTermMatch) {
        const initialCmd = slashTermMatch[2]?.trim() || '';
        onCreateShell(crypto.randomUUID(), session.cwd || '/', initialCmd || undefined);
        resetComposer();
        return;
      }
      // ─── `> command` prefix → spawn shell that auto-runs the command ──
      if (text.startsWith('>')) {
        const command = text.slice(1).trim();
        if (command) {
          onCreateShell(crypto.randomUUID(), session.cwd || '/', command);
          resetComposer();
          return;
        }
      }
    }

    const images = attachments.length > 0
      ? attachments.map((a) => ({ media_type: a.media_type, data: a.data }))
      : undefined;

    // Queue mode: while a turn is in flight, buffer locally and let the
    // streaming→idle effect drain it on turn complete.
    if (isStreaming) {
      const pendingMsg: PendingMessage = {
        id: crypto.randomUUID(),
        text,
        images,
      };
      setPendingBySession((prev) => ({
        ...prev,
        [session.id]: [...(prev[session.id] || []), pendingMsg],
      }));
      // Free the attachment previews — the queued copy keeps base64 only.
      attachments.forEach((a) => { try { URL.revokeObjectURL(a.previewUrl); } catch {} });
      resetComposer();
      return;
    }

    client.sendMessage(session.id, text, images);
    // Revoke preview blob URLs to free memory
    attachments.forEach((a) => { try { URL.revokeObjectURL(a.previewUrl); } catch {} });
    resetComposer();
  };

  // Drain queued messages on the streaming→idle transition for the active
  // session. Per-session lastStreamingRef keeps the previous value so we
  // only fire on a true→false flip.
  const lastStreamingRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!session) return;
    const sid = session.id;
    const wasStreaming = lastStreamingRef.current[sid] ?? false;
    if (wasStreaming && !isStreaming) {
      const queue = pendingBySession[sid] || [];
      if (queue.length > 0) {
        const [next, ...rest] = queue;
        if (next) {
          setPendingBySession((prev) => ({ ...prev, [sid]: rest }));
          client.sendMessage(sid, next.text, next.images);
          // Mark as streaming again so the next render's diff doesn't
          // re-trigger drain before the server's "streaming" broadcast lands.
          lastStreamingRef.current[sid] = true;
          return;
        }
      }
    }
    lastStreamingRef.current[sid] = isStreaming;
  }, [session?.id, isStreaming, pendingBySession, client]);

  const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image (Anthropic's per-image limit)

  /** Read a File into a base64-encoded string (without the data: URL prefix). */
  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || '');
      // strip "data:image/png;base64," prefix
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  const handleFiles = async (files: FileList | File[]) => {
    setAttachError(null);
    const list = Array.from(files);
    const accepted: Attachment[] = [];
    for (const file of list) {
      // Some pickers report empty type — fall back to extension sniff.
      let type = file.type;
      if (!type) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg') type = 'image/jpeg';
        else if (ext === 'png') type = 'image/png';
        else if (ext === 'gif') type = 'image/gif';
        else if (ext === 'webp') type = 'image/webp';
      }
      if (!ALLOWED_IMAGE_TYPES.has(type)) {
        setAttachError(`Unsupported file type: ${file.name}`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setAttachError(`${file.name} exceeds 10 MB`);
        continue;
      }
      try {
        const data = await fileToBase64(file);
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          media_type: type,
          data,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
        });
      } catch (e) {
        setAttachError(`Failed to read ${file.name}`);
      }
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) { try { URL.revokeObjectURL(target.previewUrl); } catch {} }
      return prev.filter((a) => a.id !== id);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // On mobile, Enter = newline. Use the send button to submit. (No Shift+Enter behavior on touch.)
    // We DO support Cmd/Ctrl+Enter for keyboard users (e.g. iPad with hardware keyboard).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  };

  const interrupt = () => {
    if (!session) return;
    client.interrupt(session.id);
  };

  const respondToPermission = (allow: boolean) => {
    if (!session || !permRequest) return;
    const reqId = permRequest.requestId;
    // Optimistic clear so the card disappears the moment the user taps; the
    // server's permission_cancelled broadcast (~50ms later over WS) confirms.
    onLocalClearPerm?.(reqId);
    client.respondToPermission(session.id, reqId, allow, allow ? permRequest.input : undefined);
  };

  /** Submit an AskUserQuestion answer set — same protocol as the desktop:
   *  approve the permission with the original input + an `answers` map. The
   *  server persists this as a synthetic tool_result so the chat history
   *  shows the answer chosen. */
  const submitAskAnswers = (answers: Record<string, string>) => {
    if (!session || !permRequest) return;
    const reqId = permRequest.requestId;
    onLocalClearPerm?.(reqId);
    client.respondToPermission(session.id, reqId, true, { ...permRequest.input, answers });
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-zinc-950">
      {/* Floating Stop pill — only visible while Claude is streaming.
          Replaces the dedicated header so the chat can use the full height. */}
      {isStreaming && (
        <button
          type="button"
          onClick={interrupt}
          className="fixed left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-full bg-red-500/15 border border-red-500/40 text-[12px] text-red-200 backdrop-blur-md active:bg-red-500/25 shadow-lg flex items-center gap-2"
          style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
          Stop
        </button>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overscroll-contain transition-[padding] duration-200 ease-out"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          // Padding tracks the live-measured bottom chrome column so the
          // last message, inline permission cards, and tool bubbles never
          // sit underneath the floating pills / attachments / composer.
          //   chromeHidden = true  → chrome anchors at 0.75rem + safe,
          //                          so pad = chrome + 1.5rem + safe.
          //   chromeHidden = false → chrome anchors at 5.25rem + safe,
          //                          so pad = chrome + 6rem + safe.
          paddingBottom: chromeHidden
            ? `calc(${chromeHeightPx}px + 1.5rem + env(safe-area-inset-bottom))`
            : `calc(${chromeHeightPx}px + 6rem + env(safe-area-inset-bottom))`,
        }}
      >
        {!session && (
          <div className="px-6 py-12 text-center text-zinc-500">
            <p className="text-sm">No session yet.</p>
            <button
              type="button"
              onClick={onOpenSessions}
              className="mt-4 px-4 py-3 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-200 text-sm font-semibold active:bg-indigo-500/25"
            >
              Pick or create a session
            </button>
          </div>
        )}

        {session && hydrated && messages.length === 0 && !partialText && !permRequest && (
          <div className="px-6 py-12 text-center text-zinc-600 text-sm">
            <p>Start by typing a message below.</p>
          </div>
        )}

        <ul ref={ulRef} className="flex flex-col gap-1 py-3">
          {(() => {
            // Build toolUseId → result map and a set of tool_use ids we have
            // results for. Then SKIP standalone tool_result rows whose parent
            // tool_use is rendered (the result is shown inside the tool's
            // accordion). Orphan results — no matching parent — still render
            // on their own.
            const resultByToolUseId = new Map<string, ChatMessage>();
            const toolUseIds = new Set<string>();
            for (const m of messages) {
              if (m.toolName && !m.isToolResult) toolUseIds.add(m.id);
              if (m.isToolResult && m.toolUseId) resultByToolUseId.set(m.toolUseId, m);
            }
            // Skip tool_result rows that pair with a tool_use rendered above —
            // those get folded into the tool's accordion. Then collapse runs of
            // consecutive same-tool calls into a single "Read 4 files" card.
            const visible = messages.filter(
              (m) => !(m.isToolResult && m.toolUseId && toolUseIds.has(m.toolUseId))
            );
            const collapsed = collapseToolRuns(visible);
            return collapsed.map((item, idx) => {
              if ('toolRun' in item) {
                // Auto-collapse once anything follows: a later grouped item or
                // Claude's currently streaming partial text below.
                const hasContentAfter = idx < collapsed.length - 1 || !!partialText;
                return (
                  <MobileToolRunBubble
                    key={item.items[0]!.id}
                    group={item}
                    resultByToolUseId={resultByToolUseId}
                    hasContentAfter={hasContentAfter}
                  />
                );
              }
              const m = item as ChatMessage;
              return (
                <MobileMessage
                  key={m.id}
                  msg={m}
                  result={m.toolName && !m.isToolResult ? resultByToolUseId.get(m.id) : undefined}
                  onOpenImage={setViewerSrc}
                />
              );
            });
          })()}
          {/* Locally queued user messages — typed while a turn was still
             streaming. Rendered as faded bubbles after the server messages;
             flipped into real bubbles + shipped on the next turn complete. */}
          {session && pending.map((p) => (
            <MobileMessage
              key={p.id}
              msg={{
                id: p.id,
                role: 'user',
                content: p.text,
                timestamp: 0,
                images: p.images,
                isPending: true,
              }}
              onCancelPending={() => removePending(session.id, p.id)}
              onOpenImage={setViewerSrc}
            />
          ))}
          {partialText && (
            <li className="mx-4 text-zinc-100">
              <Markdown text={partialText} className={MOBILE_MD_CLS} />
              <span className="inline-block w-1.5 h-3.5 bg-indigo-400 ml-1 align-middle animate-pulse rounded-sm" />
            </li>
          )}
          {/* "Thinking" indicator now lives in the navbar/composer ambient
             color blob (see BottomBlobs in MobileApp) — it fades in while
             isStreaming is true and out on turn complete. No inline dots. */}
        </ul>

        {/* Interactive shells (locally-managed; not server messages). They
           render below the chat history in creation order — same component
           the desktop uses, so xterm + spawn + input forwarding is identical. */}
        {shells && shells.length > 0 && session && (
          <ul
            className="flex flex-col gap-2 px-3 pb-2"
            // When the user taps inside an xterm (which focuses its hidden
            // textarea), the soft keyboard opens and would otherwise cover
            // the terminal. Scroll the focused bubble into view above the
            // keyboard + the floating composer/nav. The scroll-margin-bottom
            // on each <li> below tells the browser how much vertical space
            // to leave between the bubble and the viewport bottom edge so
            // the bubble lands above the chrome instead of under it.
            onFocusCapture={(e) => {
              const li = (e.target as HTMLElement).closest('li');
              if (!li) return;
              // Auto-hide the bottom navbar when the terminal takes focus —
              // the composer slides down to where the nav was, freeing the
              // most vertical space possible for the terminal + soft keyboard.
              // toggleChrome() sets a scroll-event lockout so the
              // scroll-direction handler doesn't immediately re-show the
              // nav when scrollIntoView fires below.
              toggleChrome(true);
              // Extend the lockout to 1s — the keyboard slide-up animation
              // + viewport resize can produce spurious scroll events well
              // after the initial 350ms.
              chromeLockUntilRef.current = Date.now() + 1000;
              setTimeout(() => {
                try { li.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch {}
              }, 280);
            }}
          >
            {shells.map((sh) => (
              <li
                key={sh.id}
                // Reserve space at the bottom for composer (~3.5rem) + nav
                // (~3.75rem when visible) + breathing room. scroll-margin
                // is consumed by scrollIntoView and visualViewport resize.
                style={{ scrollMarginBottom: chromeHidden ? '5rem' : '10rem' }}
              >
                <InteractiveTerminalBubble
                  sessionId={session.id}
                  client={client}
                  message={{
                    id: sh.id,
                    role: 'system',
                    content: '',
                    timestamp: sh.createdAt,
                    isInteractiveTerminal: true,
                    procId: sh.procId,
                    terminalCommand: sh.command,
                    terminalCwd: sh.cwd,
                  }}
                  // "Minimized" for mobile means the full bubble is moved
                  // off the chat canvas into the floating dock above the
                  // composer. We keep the bubble mounted (hidden only) so
                  // xterm state, PTY connection, and scrollback survive.
                  minimized={false}
                  hidden={minimizedShells.has(sh.id)}
                  onToggleMinimize={() => toggleShellMinimized(sh.id)}
                  onClose={onRemoveShell ? () => {
                    // Drop from the dock set too (if it was docked) so the
                    // chip disappears synchronously with the bubble.
                    setMinimizedShells((prev) => {
                      if (!prev.has(sh.id)) return prev;
                      const next = new Set(prev);
                      next.delete(sh.id);
                      return next;
                    });
                    onRemoveShell(sh.id);
                  } : undefined}
                />
              </li>
            ))}
          </ul>
        )}

        {permRequest && (
          permRequest.toolName === 'AskUserQuestion'
            ? <MobileAskQuestionCard request={permRequest} onSubmit={submitAskAnswers} />
            : <PermissionCard request={permRequest} onRespond={respondToPermission} />
        )}
      </div>

      {/* Floating "scroll to bottom" — appears when the user has scrolled
         well above the bottom of the chat. Sits centered just above the
         composer; tapping it pins the chat back to the latest message. */}
      {showScrollDown && (
        <button
          type="button"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            stickToBottomRef.current = true;
            setShowScrollDown(false);
          }}
          aria-label="Scroll to latest"
          className="fixed left-1/2 -translate-x-1/2 z-30 w-10 h-10 rounded-full bg-zinc-900/85 border border-white/10 text-zinc-200 active:bg-zinc-800 shadow-2xl flex items-center justify-center"
          style={{
            // Sit just above the composer's top edge
            bottom: chromeHidden
              ? 'calc(4.75rem + env(safe-area-inset-bottom))'
              : 'calc(9.25rem + env(safe-area-inset-bottom))',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          <ArrowDown size={16} />
        </button>
      )}

      {/* Composer — uses position: fixed so it anchors to the visual viewport,
          same as the bottom nav. Otherwise on Android the keyboard pushes the
          two anchors apart (nav is fixed/visual, composer was absolute/layout)
          and a huge gap opens up between them. */}
      <div
        ref={chromeBoxRef}
        className="fixed left-0 right-0 z-30 px-3 pt-2 transition-[bottom] duration-200 ease-out"
        style={{
          // When chrome is visible: nav sits at bottom 0.75rem + safe and is
          // ~3.75rem tall → composer sits at 5.25rem + safe (breathing room).
          // When chrome is hidden: composer slides down to 0.75rem + safe,
          // taking the space the nav just vacated.
          bottom: chromeHidden
            ? 'calc(0.75rem + env(safe-area-inset-bottom))'
            : 'calc(5.25rem + env(safe-area-inset-bottom))',
        }}
      >
        {/* Dock row — always visible. The action-sheet trigger anchors the
            row even when no terminals are minimized; minimized shells append
            as floating glass pills. The xterm of each stays alive
            (display:none on the inline bubble). */}
        <div className="mb-2 -mx-1 px-1 flex gap-1.5 overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setActionSheetOpen(true)}
            className="shrink-0 w-9 h-7 flex items-center justify-center rounded-full bg-zinc-900/70 border border-white/10 shadow-lg text-zinc-200 active:bg-zinc-900/90"
            style={{
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            }}
            aria-label="Open actions"
            title="Actions"
          >
            <LayoutGrid size={14} />
          </button>
          {session && (() => {
            const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
            const MODE_LABELS: Record<string, string> = {
              default: 'Default', acceptEdits: 'Edits', plan: 'Plan', bypassPermissions: 'Bypass',
            };
            const MODE_TONES: Record<string, string> = {
              default: 'text-zinc-200',
              acceptEdits: 'text-emerald-300',
              plan: 'text-violet-300',
              bypassPermissions: 'text-amber-300',
            };
            const current = (session.permission_mode || 'default') as typeof PERMISSION_MODES[number];
            const idx = PERMISSION_MODES.indexOf(current);
            const next = PERMISSION_MODES[(idx === -1 ? 0 : idx + 1) % PERMISSION_MODES.length]!;
            return (
              <button
                type="button"
                onClick={() => onPermissionModeChange?.(next)}
                className={`shrink-0 h-7 px-2.5 flex items-center rounded-full bg-zinc-900/70 border border-white/10 shadow-lg text-[11px] font-medium active:bg-zinc-900/90 ${MODE_TONES[current] || 'text-zinc-200'}`}
                style={{
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                }}
                aria-label={`Permission mode: ${MODE_LABELS[current] || current}. Tap to cycle.`}
                title={`Mode: ${MODE_LABELS[current] || current} — tap to cycle`}
              >
                {MODE_LABELS[current] || current}
              </button>
            );
          })()}
          {shells &&
            shells
              .filter((sh) => minimizedShells.has(sh.id))
              .map((sh) => {
                const label = sh.command?.trim() || sh.cwd.split('/').pop() || 'shell';
                return (
                  <button
                    key={sh.id}
                    type="button"
                    onClick={() => toggleShellMinimized(sh.id)}
                    className="shrink-0 flex items-center gap-1.5 max-w-[70vw] px-2.5 py-1 rounded-full bg-zinc-900/70 border border-white/10 shadow-lg text-[12px] text-zinc-200 font-mono active:bg-zinc-900/90"
                    style={{
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                    }}
                    title={sh.command || sh.cwd}
                    aria-label={`Restore terminal: ${label}`}
                  >
                    <TerminalIcon size={12} className="shrink-0 text-emerald-400" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
        </div>

        {/* Attachment thumbnails (above the composer when present) */}
        {attachments.length > 0 && (
          <div className="mb-2 rounded-3xl border border-white/10 bg-zinc-900/85 backdrop-blur-xl px-3 py-2 flex gap-2 overflow-x-auto">
            {attachments.map((a) => (
              <div key={a.id} className="relative shrink-0">
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  className="w-16 h-16 rounded-lg object-cover border border-white/10"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-950 border border-white/20 text-zinc-300 flex items-center justify-center text-[10px] active:bg-zinc-800"
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {attachError && (
          <div className="mb-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-[12px] text-red-300">
            {attachError}
          </div>
        )}

        {recError && (
          <div className="mb-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
            {recError}
          </div>
        )}

        <div
          ref={composerBoxRef}
          className="flex items-end gap-1.5 rounded-[1.625rem] bg-zinc-900/55 pl-5 pr-1.5 py-1.5"
          style={{
            // Same recipe as GlassNav so the moving color blob beneath bleeds
            // through identically. Fixed 26px (1.625rem) corners match the
            // single-line pill look but don't ellipse when the textarea grows
            // to multiple lines (rounded-full would).
            backdropFilter: 'blur(28px) saturate(180%)',
            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
          }}
        >
          {recState !== 'idle' ? (
            // ── Recording / transcribing bar — replaces the textarea while a
            // voice note is being captured or shipped to Deepgram. Same pill
            // shape + glass so the swap doesn't reflow the layout. ────────
            <>
              <div className="flex-1 flex items-center gap-2 text-[13px] py-1.5 text-zinc-200">
                {recState === 'recording' ? (
                  <>
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="font-mono tabular-nums text-zinc-300">
                      {Math.floor(recElapsed / 60).toString().padStart(1, '0')}:
                      {(recElapsed % 60).toString().padStart(2, '0')}
                    </span>
                    <span className="text-zinc-500">Recording…</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 animate-spin text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 11-6.2-8.55" strokeLinecap="round" />
                    </svg>
                    <span className="text-zinc-400">Transcribing…</span>
                  </>
                )}
              </div>
              {recState === 'recording' && (
                <>
                  <button
                    type="button"
                    onClick={cancelRecording}
                    className="shrink-0 w-9 h-9 rounded-full text-zinc-400 active:text-zinc-200 active:bg-white/10 flex items-center justify-center transition"
                    aria-label="Cancel recording"
                  >
                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={finishRecording}
                    className="shrink-0 w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center font-semibold active:bg-indigo-600 transition"
                    aria-label="Send recording"
                  >
                    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M5 12l14-7-7 14-2-5-5-2z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              {/* Hidden native picker — opened by the paperclip button. iOS shows
                  "Photo Library / Take Photo / Choose File" sheet. */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFiles(e.target.files);
                    // Reset so picking the same file again still triggers onChange
                    e.target.value = '';
                  }
                }}
              />
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!session}
                rows={1}
                placeholder={session ? 'Message Claude…' : 'Select a session first'}
                className="flex-1 bg-transparent resize-none outline-none text-[15px] text-zinc-100 placeholder:text-zinc-600 max-h-40 leading-snug py-1.5"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!session}
                className="shrink-0 w-9 h-9 rounded-full text-zinc-400 active:text-zinc-200 active:bg-white/10 flex items-center justify-center disabled:opacity-30 transition"
                aria-label="Attach image"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path
                    d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {!input.trim() && attachments.length === 0 ? (
                // Empty composer → mic button (records voice note, Deepgram
                // transcribes, transcript goes through as a normal message).
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={!session}
                  className="shrink-0 w-9 h-9 rounded-full text-zinc-400 active:text-zinc-200 active:bg-white/10 flex items-center justify-center disabled:opacity-30 transition"
                  aria-label="Record voice note"
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z" />
                    <path d="M19 10v2a7 7 0 01-14 0v-2" />
                    <path d="M12 19v3M8 22h8" strokeLinecap="round" />
                  </svg>
                </button>
              ) : (
                // Has text or attachments → send button.
                <button
                  type="button"
                  onClick={send}
                  // Keep the textarea focused on tap so iOS/Android don't
                  // dismiss the keyboard mid-send (which reflows the chat
                  // and obscures the new bubble's arrival animation).
                  // PointerDown fires on both mouse + touch and — unlike
                  // touchstart — preventDefault here doesn't cancel the
                  // subsequent click.
                  onPointerDown={(e) => e.preventDefault()}
                  disabled={!session}
                  className="shrink-0 w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center font-semibold disabled:opacity-30 disabled:bg-white/10 active:bg-indigo-600 transition"
                  aria-label="Send"
                >
                  <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12l14-7-7 14-2-5-5-2z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <MobileActionSheet
        open={actionSheetOpen}
        onClose={() => setActionSheetOpen(false)}
        onAction={handleActionSheet}
      />

      <MobileImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightweight per-message rendering — kept simple to keep the mobile bundle
// fast. Uses the same shape as the desktop ChatMessage but renders only the
// fields that matter on a phone. No Monaco / xterm / complex tool UIs.
// ---------------------------------------------------------------------------

function MobileMessage({ msg, result, onCancelPending, onOpenImage }: { msg: ChatMessage; result?: ChatMessage; onCancelPending?: () => void; onOpenImage?: (src: string) => void }) {
  if (msg.role === 'user') {
    const hasImages = !!msg.images && msg.images.length > 0;
    const pending = !!msg.isPending;
    // Exact card styling that the assistant messages used to have
    // (commit af1bce6) — full-width rounded card, white/5 background +
    // border, Markdown rendered with the same MOBILE_MD_CLS variant so
    // inline code spans pick up the amber pill treatment.
    return (
      <li
        className={`self-end mr-3 ml-3 max-w-[85%] px-4 py-1 rounded-[1.625rem] bg-white/5 border text-zinc-100 text-right relative ${
          pending ? 'opacity-50 border-dashed border-blue-500/40' : 'border-white/5'
        }`}
      >
        {hasImages && (
          <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
            {msg.images!.map((img, i) => {
              const src = `data:${img.media_type};base64,${img.data}`;
              return (
                <img
                  key={i}
                  src={src}
                  alt="attachment"
                  onClick={() => onOpenImage?.(src)}
                  className="w-24 h-24 rounded-lg object-cover border border-white/10 cursor-zoom-in"
                />
              );
            })}
          </div>
        )}
        {msg.content && <Markdown text={msg.content} className={MOBILE_MD_CLS} />}
        {pending && (
          <div className="flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-blue-300/70 pb-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/60 animate-pulse" />
            Queued
          </div>
        )}
        {pending && onCancelPending && (
          <button
            type="button"
            onClick={onCancelPending}
            className="absolute -top-1.5 -left-1.5 w-6 h-6 rounded-full bg-zinc-950 border border-blue-500/40 text-blue-300 active:text-blue-100 active:bg-zinc-900 flex items-center justify-center"
            aria-label="Cancel queued message"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </li>
    );
  }

  if (msg.role === 'system') {
    if (msg.images && msg.images.length > 0) {
      return (
        <li className="mx-3 flex flex-col items-center gap-1.5">
          <div className="flex flex-wrap gap-1.5 justify-center">
            {msg.images.map((img, i) => {
              const src = `data:${img.media_type};base64,${img.data}`;
              return (
                <img
                  key={i}
                  src={src}
                  alt=""
                  onClick={() => onOpenImage?.(src)}
                  className="max-h-56 rounded-lg object-contain border border-white/10 cursor-zoom-in"
                />
              );
            })}
          </div>
          {msg.content && (
            <span className="text-[11px] text-zinc-500 text-center whitespace-pre-wrap break-words">
              {msg.content}
            </span>
          )}
        </li>
      );
    }
    return (
      <li className="mx-3 text-[11px] text-zinc-500 text-center whitespace-pre-wrap break-words">
        {msg.content}
      </li>
    );
  }

  // Tool use bubble (collapsible, default collapsed — same as desktop).
  // The matching tool_result (if any) is rendered nested inside this same
  // accordion so each tool gets exactly one collapse.
  if (msg.toolName && !msg.isToolResult) {
    return <ToolUseBubble msg={msg} result={result} />;
  }

  // Orphan tool_result (no matching tool_use rendered above) — fall back to
  // its own collapsible bubble so it isn't lost.
  if (msg.isToolResult) {
    return <ToolResultBubble msg={msg} />;
  }

  // Plain assistant text — render as Markdown, no card. Only user messages
  // get a visible bubble; everything else is plain text on the dark canvas.
  return (
    <li className="mx-4 text-zinc-100">
      <Markdown text={msg.content} className={MOBILE_MD_CLS} />
    </li>
  );
}

function MobileToolRunBubble({
  group,
  resultByToolUseId,
  hasContentAfter,
}: {
  group: ToolRunGroup;
  resultByToolUseId: Map<string, ChatMessage>;
  hasContentAfter?: boolean;
}) {
  const [expanded, setExpanded] = useState(!hasContentAfter);
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (hasContentAfter && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setExpanded(false);
    }
  }, [hasContentAfter]);
  const { name, label } = toolRunSummary(group.items);
  const anyError = group.items.some((m) => resultByToolUseId.get(m.id)?.isError);
  const anyRunning = group.items.some((m) => !resultByToolUseId.get(m.id));
  return (
    <li className="mx-3">
      <div className="rounded-xl border border-violet-500/20 overflow-hidden bg-violet-500/[0.04]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left active:bg-white/5"
        >
          <span className="text-zinc-500 shrink-0">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {name ? (
            <>
              <span className="text-[11px] font-mono font-medium text-violet-400 shrink-0">{name}</span>
              <span className="text-[12px] text-zinc-400 truncate flex-1 min-w-0">{label}</span>
            </>
          ) : (
            <span className="text-[11px] font-mono font-medium text-violet-400 truncate flex-1 min-w-0">{label}</span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {anyRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            {anyError && !anyRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            )}
            {!anyRunning && !anyError && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            )}
          </span>
        </button>
        {expanded && (
          <ul className="border-t border-violet-500/10 px-1 py-1 flex flex-col gap-1">
            {group.items.map((m) => (
              <MobileMessage
                key={m.id}
                msg={m}
                result={resultByToolUseId.get(m.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function ToolUseBubble({ msg, result }: { msg: ChatMessage; result?: ChatMessage }) {
  // Default collapsed — mirrors the desktop, where every tool starts collapsed
  // and you click the chevron to expand. Especially useful with acceptEdits /
  // bypassPermissions where Claude fires lots of tools per turn.
  const [expanded, setExpanded] = useState(false);
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  const summary = summariseToolInput(msg.toolName!, msg.toolInput as Record<string, unknown> | undefined);
  const resultText = (result?.content || '').trim();
  const isErr = !!result?.isError;

  // Edit tools get a real diff instead of the raw `old_string → new_string`
  // text dump. We keep the surrounding bubble layout the same.
  const editParts = getEditPartsFromMsg(msg);

  // ExitPlanMode carries a markdown `plan` that the agent wrote — render it
  // as actual markdown (not raw JSON) so it's readable on mobile.
  const planText: string | null = (() => {
    if (msg.toolName !== 'ExitPlanMode') return null;
    const input = (msg.toolInput || {}) as Record<string, unknown>;
    return typeof input.plan === 'string' && input.plan.trim() ? input.plan : null;
  })();

  // Status indicator on the right when collapsed:
  //   - amber pulse: still running (no result yet)
  //   - red:        error
  //   - green:      ok
  // Agent tool gets a cyan spinner instead of a dot so the running state reads
  // as a clear loader on the agent card.
  const isAgent = msg.toolName === 'Agent';
  let statusDot: { color: string; pulse?: boolean } | null = null;
  if (!result && !isAgent) statusDot = { color: 'bg-amber-400', pulse: true };
  else if (result && isErr) statusDot = { color: 'bg-red-400' };
  else if (result) statusDot = { color: 'bg-green-500' };

  return (
    <li className="mx-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1 rounded-lg active:bg-white/5 text-left"
      >
        <span className="text-zinc-500 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[11px] font-mono text-violet-400 shrink-0">{msg.toolName}</span>
        {!expanded && summary && (
          <span className="text-[12px] text-zinc-500 font-mono truncate flex-1 min-w-0">
            {summary.split('\n')[0]}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {msg.autoApproved && (
            <span
              className="text-[9px] uppercase tracking-wider text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded font-mono"
              title="Auto-approved by the current permission mode"
            >
              auto
            </span>
          )}
          {isAgent && !result && (
            <span
              className="w-3 h-3 rounded-full border border-cyan-500/40 border-t-cyan-300 animate-spin"
              aria-label="Agent running"
            />
          )}
          {statusDot && (
            <span className={`w-1.5 h-1.5 rounded-full ${statusDot.color} ${statusDot.pulse ? 'animate-pulse' : ''}`} />
          )}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 mx-1 space-y-1.5">
          {planText ? (
            <div className="px-3 py-2 rounded-xl bg-violet-500/[0.06] border border-violet-500/30 max-h-[60vh] overflow-y-auto">
              <Markdown text={planText} className={MOBILE_MD_CLS} />
            </div>
          ) : editParts ? (
            <div className="rounded-xl overflow-hidden border border-amber-500/20">
              {editParts.filePath && (
                <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-500/5 border-b border-amber-500/20">
                  <span className="text-[11px] font-mono text-zinc-400 truncate" title={editParts.filePath}>
                    {editParts.filePath.split('/').pop()}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDiffFullscreen(true)}
                    className="shrink-0 text-[10px] text-zinc-500 active:text-zinc-200 px-2 py-0.5 rounded active:bg-white/5"
                  >
                    Expand
                  </button>
                </div>
              )}
              <DiffView
                original={editParts.oldStr}
                current={editParts.newStr}
                maxHeight={300}
                wrap
              />
              <MobileDiffModal
                open={diffFullscreen}
                onClose={() => setDiffFullscreen(false)}
                textSource={{
                  original: editParts.oldStr,
                  current: editParts.newStr,
                  title: editParts.filePath || 'Edit',
                }}
              />
            </div>
          ) : summary ? (
            <div className="px-3 py-2 rounded-xl bg-amber-500/5 border border-amber-500/20">
              <pre className="text-[12px] text-zinc-200 font-mono whitespace-pre-wrap break-all m-0 leading-relaxed">
                {summary.length > 4000 ? summary.slice(0, 4000) + '…' : summary}
              </pre>
            </div>
          ) : null}
          {result && (
            <div className={`px-3 py-2 rounded-xl ${isErr ? 'bg-red-500/5 border border-red-500/20' : 'bg-white/[0.03] border border-white/5'}`}>
              <div className={`text-[10px] uppercase tracking-wider mb-1 ${isErr ? 'text-red-400' : 'text-zinc-500'}`}>
                {isErr ? 'Error' : 'Result'}
              </div>
              {resultText ? (
                <pre className="text-[12px] text-zinc-300 font-mono whitespace-pre-wrap break-all m-0 leading-relaxed max-h-72 overflow-auto">
                  {resultText.slice(0, 8000)}
                </pre>
              ) : (
                <p className="text-[11px] text-zinc-500 italic m-0">(empty)</p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ToolResultBubble({ msg }: { msg: ChatMessage }) {
  const content = (msg.content || '').trim();
  // First non-empty line as a teaser when collapsed
  const firstLine = content.split('\n').find((l) => l.trim()) || '';
  const [expanded, setExpanded] = useState(false);
  const isErr = !!msg.isError;
  return (
    <li className="mx-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1 rounded-lg active:bg-white/5 text-left"
      >
        <span className="text-zinc-500 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className={`text-[10px] uppercase tracking-wider shrink-0 ${isErr ? 'text-red-400' : 'text-zinc-500'}`}>
          {isErr ? 'Error' : 'Result'}
        </span>
        {!expanded && firstLine && (
          <span className="text-[12px] text-zinc-500 font-mono truncate flex-1 min-w-0">
            {firstLine}
          </span>
        )}
      </button>
      {expanded && content && (
        <div className={`mt-1 mx-1 px-3 py-2 rounded-xl ${isErr ? 'bg-red-500/5 border border-red-500/20' : 'bg-white/[0.03] border border-white/5'}`}>
          <pre className="text-[12px] text-zinc-300 font-mono whitespace-pre-wrap break-all m-0 leading-relaxed max-h-72 overflow-auto">
            {content.slice(0, 8000)}
          </pre>
        </div>
      )}
    </li>
  );
}

/** Extract the three strings we need to render an Edit tool diff in the
 *  tool-use bubble. Returns null unless this is an Edit with both
 *  old_string + new_string present as strings. */
function getEditPartsFromMsg(msg: ChatMessage): { filePath: string; oldStr: string; newStr: string } | null {
  if (msg.toolName !== 'Edit') return null;
  const input = (msg.toolInput || {}) as Record<string, unknown>;
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  if (!oldStr && !newStr) return null;
  return { filePath, oldStr, newStr };
}

function summariseToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  const get = (k: string) => (typeof (input as Record<string, unknown>)[k] === 'string' ? ((input as Record<string, unknown>)[k] as string) : '');
  switch (name) {
    case 'Bash': return get('command');
    case 'Edit': return `${get('file_path')}\n\n${get('old_string').slice(0, 200)}\n→\n${get('new_string').slice(0, 200)}`;
    case 'Write': return `${get('file_path')}\n\n${get('content').slice(0, 400)}`;
    case 'Read': return get('file_path');
    case 'Grep': case 'Glob': return get('pattern') || get('query');
    case 'ExitPlanMode': return get('plan');
    default:
      try { return JSON.stringify(input).slice(0, 400); } catch { return ''; }
  }
}
