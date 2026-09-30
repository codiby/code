/**
 * Floating chat bubbles — the renderer of the transparent overlay window that
 * `packages/desktop/bubbles.ts` keeps on top of every app.
 *
 * The window covers a whole display and is click-through, so this component
 * keeps main posted on where its clickable parts (`data-hit`) are; main
 * watches the cursor and only takes clicks over them. Heads stack at a screen edge, drag with a trailing chain,
 * snap to the nearest side and die on the dismiss target; a click lines them
 * up and opens the panel for one session.
 *
 * It runs its own ClaudeClient against the bridge, subscribed only to the
 * floating sessions, instead of relaying state from the main window.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Mic, Minus, PanelTop, Send, Square, X } from 'lucide-react';
import {
  ClaudeClient,
  resolveServerUrl,
  type ChatMessage,
  type PermissionRequest,
  type SessionInfo,
  type VoiceActivity,
} from '../../lib/claude-client';
import { collectExplainParts } from '../../lib/explain';
import { getNative, tryInvokeNative } from '../../lib/native';
import { collapseToolRuns } from '../MessageBubble';
import { Markdown } from '../Markdown';
import { MobileMessage, MobileToolRunBubble } from '../mobile/MobileChat';
import { PermissionCard } from '../mobile/PermissionCard';
import { MobileAskQuestionCard } from '../mobile/AskQuestionCard';
import { addRecentDir } from '../../lib/recent-dirs';
import { Spotlight, PROVIDER_KEY, basename, type Launch } from './Spotlight';
import { SlashCommandList, useSlashCommands } from '../SlashCommandPicker';
import { ArchiveSuggestionPill } from '../ArchiveSuggestionPill';
import { matchCommand, resolveBindings, type KeybindingOverrides } from '../../lib/keybindings';

const HS = 56;          // head size
const GAP = 16;         // gap between heads in the expanded row
const STACK_STEP = 14;  // vertical offset between heads in the collapsed stack
const STACK_VISIBLE = 4;
const EDGE = 12;        // distance from the screen edge
const PEEK_MS = 4500;
const ANCHOR_KEY = 'codiby-bubble-anchor';

const PALETTE = ['#c8956b', '#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#7dcfff', '#f7768e', '#73daca'];

type Runtime = {
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  permRequest: PermissionRequest | null;
  hydrated: boolean;
  /** One completed turn waiting to be read; intermediate messages don't count. */
  unread: 0 | 1;
  /** Voice mode on this session: a halo and a mic/bars badge on the head. */
  voice: VoiceActivity;
  /** What the provider published for the composer's `/` picker. */
  slashCommands: string[];
};
const EMPTY: Runtime = { messages: [], partialText: '', isStreaming: false, permRequest: null, hydrated: false, unread: 0, voice: 'off', slashCommands: [] };

/** Handled by the bubble itself rather than sent to the agent. */
const BUILTIN_SLASH_COMMANDS = ['restart'];

const SIDES = ['left', 'right', 'top', 'bottom'] as const;
/** `at` runs along the edge: the y of a left/right stack, the x of a top/bottom one. */
type Anchor = { side: typeof SIDES[number]; at: number };
type Drag = { id: string; whole: boolean; x: number; y: number; hot: boolean };
type Grab = { id: string; whole: boolean; sx: number; sy: number; ox: number; oy: number; moved: boolean; last?: Drag };

function hueFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s_-]/gu, '').split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function providerMark(p?: string): string {
  if (p === 'codex') return 'X';
  if (p === 'opencode') return 'O';
  return 'C';
}

function loadAnchor(): Anchor {
  try {
    const a = JSON.parse(localStorage.getItem(ANCHOR_KEY) || '');
    if (SIDES.includes(a?.side) && typeof a.at === 'number') return a;
    // Stored before the top and bottom edges existed.
    if ((a?.side === 'left' || a?.side === 'right') && typeof a.y === 'number') return { side: a.side, at: a.y };
  } catch {}
  return { side: 'right', at: Math.round(window.innerHeight * 0.28) };
}

/** The edge nearest to a point — where a dropped stack snaps to. */
function nearestSide(x: number, y: number, w: number, h: number): Anchor {
  const dist = { left: x, right: w - x, top: y, bottom: h - y };
  const side = SIDES.reduce((a, b) => (dist[b] < dist[a] ? b : a));
  return { side, at: (side === 'left' || side === 'right' ? y : x) - HS / 2 };
}

/** Assistant text worth a peek — not tools, thinking or echoes. */
function isReply(m: ChatMessage): boolean {
  return m.role === 'assistant' && !m.toolName && !m.isToolResult && !m.isThinking && !!m.content?.trim();
}

export function BubbleApp() {
  const [ids, setIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [rt, setRt] = useState<Record<string, Runtime>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor>(loadAnchor);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [leaving, setLeaving] = useState<string[]>([]);
  const [peek, setPeek] = useState<{ id: string; text: string } | null>(null);
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const [spot, setSpot] = useState<'closed' | 'open' | 'launching'>('closed');
  const [error, setError] = useState<string | null>(null);
  const [kbOverrides, setKbOverrides] = useState<KeybindingOverrides>({});
  const fxRef = useRef<HTMLDivElement>(null);
  const kbBindings = useMemo(() => resolveBindings(kbOverrides), [kbOverrides]);
  const kbBindingsRef = useRef(kbBindings);
  kbBindingsRef.current = kbBindings;
  /** Disposables waiting for their first completed turn to open their chat. */
  const openOnReply = useRef(new Set<string>());
  /** The `disposableOpenOnFirstReply` preference, kept fresh from the bridge. */
  const openOnReplyPref = useRef(true);
  const expandRef = useRef<(id: string) => void>(() => {});
  const toggleRef = useRef<() => void>(() => {});

  const idsRef = useRef(ids);
  idsRef.current = ids;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Bubbles by last opened, newest first — the order Ctrl+Tab walks, like
   *  Alt+Tab. `cycle` is the walk in progress while Ctrl is held; the order
   *  only changes once Ctrl is released, so one press returns to the previous
   *  bubble and holding it reaches further back. */
  const mruRef = useRef<string[]>([]);
  const cycleRef = useRef<{ list: string[]; idx: number } | null>(null);
  const touchMru = (id: string) => { mruRef.current = [id, ...mruRef.current.filter(x => x !== id)]; };
  useEffect(() => {
    if (expanded && !cycleRef.current) touchMru(expanded);
  }, [expanded]);
  const grabRef = useRef<Grab | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The overlay is transparent and always dark, whatever the app theme is.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light');
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
    root.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.className = 'text-zinc-100';
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(ANCHOR_KEY, JSON.stringify(anchor)); } catch {}
  }, [anchor]);

  // ---- floating ids, owned by main ----------------------------------------
  // Newly floated ids go to the front of the stack; the rest keep the order
  // this window gave them (last replied / last opened in front).
  const applyIds = useCallback((incoming: string[]) => {
    setIds(prev => [...incoming.filter(x => !prev.includes(x)), ...prev.filter(x => incoming.includes(x))]);
    setLeaving(prev => prev.filter(x => incoming.includes(x)));
    setExpanded(prev => (prev && incoming.includes(prev) ? prev : null));
  }, []);

  useEffect(() => {
    const native = getNative();
    if (!native) return;
    void tryInvokeNative<string[]>('bubble_list').then(list => { if (list) applyIds(list); });
    // The shortcut press that created this window arrived before we listened.
    void tryInvokeNative<boolean>('bubble_spotlight_take').then(open => { if (open) openSpot(); });
    return native.onBubbleEvent(msg => {
      if (msg.type === 'list') applyIds(msg.ids);
      else if (msg.type === 'spotlight') msg.open ? openSpot() : closeSpot();
      else if (msg.type === 'toggle') toggleRef.current();
    });
  }, [applyIds]);

  const bringToFront = useCallback((id: string) => {
    setIds(prev => (prev[0] === id || !prev.includes(id) ? prev : [id, ...prev.filter(x => x !== id)]));
  }, []);

  const showPeek = useCallback((id: string, text: string) => {
    if (expandedRef.current) return;
    setPeek({ id, text: text.length > 110 ? `${text.slice(0, 110)}…` : text });
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(null), PEEK_MS);
  }, []);

  // ---- bridge client --------------------------------------------------------
  useEffect(() => {
    let dead = false;
    let c: ClaudeClient | null = null;
    const patch = (sid: string, fn: (cur: Runtime) => Runtime) =>
      setRt(prev => ({ ...prev, [sid]: fn(prev[sid] || EMPTY) }));
    const noop = () => {};
    /** A waiting disposable finished its first turn: open it, or at least put
     *  it in front if the user is busy in another bubble's chat. */
    const openWaiting = (sid: string) => {
      if (!openOnReply.current.delete(sid)) return;
      if (expandedRef.current || spotRef.current !== 'closed') bringToFront(sid);
      else expandRef.current(sid);
    };

    resolveServerUrl().then(url => {
      if (dead) return;
      c = new ClaudeClient(url, {
        onSessions: setSessions,
        onSessionState: (sid, state) => {
          // Subscribed after its first turn already finished: open it now.
          if (!state.lite && !state.isStreaming && state.messages?.some(isReply)) openWaiting(sid);
          patch(sid, cur => ({
            ...cur,
            messages: state.lite ? cur.messages : state.messages || [],
            partialText: state.partialText || '',
            isStreaming: !!state.isStreaming,
            unread: state.isStreaming ? 0 : cur.unread,
            permRequest: state.permRequest,
            hydrated: !state.lite || cur.hydrated,
            slashCommands: state.initInfo?.slashCommands ?? cur.slashCommands,
          }));
        },
        onMessage: (sid, msg) => {
          let fresh = false;
          patch(sid, cur => {
            if (cur.messages.some(m => m.id === msg.id)) return cur;
            fresh = true;
            return { ...cur, messages: [...cur.messages, msg], partialText: '', unread: msg.role === 'user' ? 0 : cur.unread };
          });
          if (fresh && isReply(msg) && expandedRef.current !== sid && idsRef.current.includes(sid)) {
            bringToFront(sid);
            showPeek(sid, msg.content.trim());
          }
        },
        onPartialText: (sid, text) => patch(sid, cur => ({ ...cur, partialText: text, isStreaming: true, unread: 0 })),
        onPartialThinking: noop,
        onPermissionRequest: (sid, req) => {
          patch(sid, cur => ({ ...cur, permRequest: req }));
          if (idsRef.current.includes(sid) && expandedRef.current !== sid) {
            bringToFront(sid);
            showPeek(sid, `Needs permission: ${req.displayName || req.title || req.toolName}`);
          }
        },
        onPermissionCancelled: (sid, requestId) => patch(sid, cur =>
          cur.permRequest?.requestId === requestId ? { ...cur, permRequest: null } : cur),
        onStatus: (sid, status) => {
          if (status === 'streaming') patch(sid, cur => ({ ...cur, isStreaming: true, unread: 0 }));
          else if (['turn_complete', 'interrupted', 'disconnected', 'error'].includes(status)) {
            patch(sid, cur => ({
              ...cur,
              isStreaming: false,
              unread: status === 'turn_complete' && expandedRef.current !== sid ? 1 : 0,
              partialText: '',
              permRequest: status === 'turn_complete' ? null : cur.permRequest,
            }));
            if (status === 'turn_complete') openWaiting(sid);
          }
        },
        onVoiceState: (sid, voice) => patch(sid, cur => ({ ...cur, voice })),
        onSessionName: (sid, name) => setSessions(prev => prev.map(s => (s.id === sid ? { ...s, name } : s))),
        onTerminalData: noop,
        onTerminalExit: noop,
        onTodos: noop,
        onAutoApproved: noop,
        onInitInfo: (sid, info) => patch(sid, cur => ({ ...cur, slashCommands: info.slashCommands || [] })),
        onSupportedModels: noop,
        onOpenFile: noop,
        onOpenMockup: noop,
        onOpenBrowser: noop,
        onCloseBrowser: noop,
        onFocusBrowser: noop,
        onPreferences: prefs => {
          if (typeof prefs.disposableOpenOnFirstReply === 'boolean') openOnReplyPref.current = prefs.disposableOpenOnFirstReply;
        },
        onKeybindings: setKbOverrides,
        onFocusSession: noop,
        onWelcome: noop,
        onConnectionChange: noop,
      });
      setClient(c);
      void c.getPreferences().then(prefs => {
        if (typeof prefs.disposableOpenOnFirstReply === 'boolean') openOnReplyPref.current = prefs.disposableOpenOnFirstReply;
      }).catch(() => {});
      void c.getKeybindings().then(setKbOverrides).catch(() => {});
    });
    return () => {
      dead = true;
      c?.destroy();
      setClient(null);
    };
  }, [bringToFront, showPeek]);

  // Subscribe to exactly the floating sessions. Waits for the session list so
  // the client knows which remote (if any) owns each one.
  const subscribed = useRef(new Set<string>());
  useEffect(() => {
    if (!client) { subscribed.current = new Set(); return; }
    const known = new Set(sessions.map(s => s.id));
    for (const id of ids) {
      if (known.has(id) && !subscribed.current.has(id)) {
        client.subscribe(id);
        subscribed.current.add(id);
      }
    }
    for (const id of [...subscribed.current]) {
      if (!ids.includes(id)) {
        client.unsubscribe(id);
        subscribed.current.delete(id);
      }
    }
  }, [client, ids, sessions]);

  // ---- click-through ----------------------------------------------------------
  // Main polls the cursor against these rects to decide when the overlay takes
  // clicks. Forwarded mouse-moves (the obvious way) stop arriving on macOS after
  // the overlay is hidden and re-shown, which left the bubbles dead to clicks.
  const reportHits = useRef<() => void>(() => {});
  useEffect(() => {
    let last = '';
    const report = () => {
      const rects = [...document.querySelectorAll('[data-hit]')]
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
      const hold = !!grabRef.current;
      const key = JSON.stringify([rects, hold]);
      if (key === last) return;
      last = key;
      void tryInvokeNative('bubble_hit_rects', { rects, hold });
    };
    reportHits.current = report;
    // Heads animate for ~0.5s after every change; a short interval follows them.
    const t = setInterval(report, 80);
    report();
    return () => clearInterval(t);
  }, []);

  // ---- expand / collapse --------------------------------------------------
  const expand = useCallback((id: string) => {
    setExpanded(id);
    setRt(prev => (prev[id]?.unread ? { ...prev, [id]: { ...prev[id]!, unread: 0 } } : prev));
    setPeek(null);
    void tryInvokeNative('bubble_focus', { focus: true });
  }, []);
  expandRef.current = expand;
  const collapse = useCallback(() => {
    const id = expandedRef.current;
    if (!id) return;
    setExpanded(null);
    bringToFront(id);
  }, [bringToFront]);
  // ⌥Esc from anywhere: reopen the bubble used last, or fold them back.
  toggleRef.current = () => {
    if (spotRef.current !== 'closed') return;
    if (expandedRef.current) { collapse(); void tryInvokeNative('bubble_resign'); return; }
    const first = mruRef.current.find(id => idsRef.current.includes(id)) ?? idsRef.current[0];
    if (first) expand(first);
  };

  // ---- quick launcher ------------------------------------------------------
  // Main already made the window take clicks and keys when it asked us to open.
  const spotRef = useRef(spot);
  spotRef.current = spot;
  const openSpot = useCallback(() => {
    setExpanded(null);
    setPeek(null);
    setError(null);
    setSpot('open');
    void tryInvokeNative('bubble_spotlight_state', { open: true });
  }, []);
  const closeSpot = useCallback(() => {
    if (spotRef.current !== 'open') return;
    setSpot('closed');
    void tryInvokeNative('bubble_spotlight_state', { open: false });
  }, []);

  // Clicking any other app blurs the overlay — fold back like Messenger does.
  useEffect(() => {
    const endCycle = () => {
      if (!cycleRef.current) return;
      cycleRef.current = null;
      if (expandedRef.current) touchMru(expandedRef.current);
    };
    const onBlur = () => { endCycle(); collapse(); closeSpot(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { collapse(); closeSpot(); return; }
      const open = expandedRef.current;
      // Ctrl+Tab: the previous bubble, like Alt+Tab; keep Ctrl down and press
      // again to go further back, Shift to step forward.
      if (open && e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!cycleRef.current) {
          const ids = idsRef.current;
          // Bubbles never opened yet follow in row order, right to left.
          const list = [open, ...mruRef.current, ...[...ids].reverse()]
            .filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
          cycleRef.current = { list, idx: 0 };
        }
        const c = cycleRef.current;
        if (c.list.length < 2) return;
        c.idx = (c.idx + (e.shiftKey ? -1 : 1) + c.list.length) % c.list.length;
        expandRef.current(c.list[c.idx]!);
        return;
      }
      if (open && matchCommand(e, kbBindingsRef.current) === 'archive-session') {
        e.preventDefault();
        archiveRef.current(open);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Control') endCycle(); };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [collapse, closeSpot]);

  // ---- geometry ---------------------------------------------------------------
  const { w: W, h: H } = size;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const vertical = anchor.side === 'left' || anchor.side === 'right';
  const anchorX = anchor.side === 'left' ? EDGE
    : anchor.side === 'right' ? W - HS - EDGE
    : clamp(anchor.at, EDGE, W - HS - EDGE);
  const anchorY = anchor.side === 'top' ? EDGE
    : anchor.side === 'bottom' ? H - HS - EDGE
    : clamp(anchor.at, EDGE, H - HS - 120);
  const zone = { x: W / 2, y: H - 80 };
  // Opened, the heads line up in a row: along the top for a side stack, on
  // their own edge for a top/bottom one, centred on where the stack sat.
  const rowW = ids.length * HS + Math.max(0, ids.length - 1) * GAP;
  const rowStart = anchor.side === 'left' ? EDGE
    : anchor.side === 'right' ? W - EDGE - rowW
    : clamp(anchorX + HS / 2 - rowW / 2, EDGE, W - EDGE - rowW);
  const rowX = (i: number) => rowStart + i * (HS + GAP);
  const rowY = anchor.side === 'bottom' ? H - HS - EDGE : EDGE;

  const geomRef = useRef({ anchorX, anchorY });
  geomRef.current = { anchorX, anchorY };

  /** Enter in the launcher: create the session and, while the bridge boots it,
   *  squeeze the card into an orb that arcs into the stack. The bubble takes
   *  its place once both are done. ⌘Enter skips the flight and opens a tab. */
  const launch = useCallback(async (l: Launch, card: DOMRect) => {
    if (!client || spotRef.current !== 'open') return;
    setSpot('launching');
    // A disposable has no folder of its own; don't let `~` into the recents.
    if (!l.disposableTtlMs) addRecentDir(null, l.cwd);
    try { localStorage.setItem(PROVIDER_KEY, l.provider); } catch {}
    const created = client.createSession(
      l.disposableTtlMs ? undefined : l.cwd,
      { provider: l.provider, disposableTtlMs: l.disposableTtlMs },
    ).then(s => {
      client.sendMessage(s.id, l.prompt);
      return s;
    });
    let orb: ReturnType<typeof flyOrb> | null = null;
    let failed = false;
    let opened = false;
    try {
      if (l.mode === 'tab') {
        const s = await created;
        await tryInvokeNative('bubble_dock', { sessionId: s.id });
      } else {
        const { anchorX: x, anchorY: y } = geomRef.current;
        orb = flyOrb(fxRef.current!, card, hueFor(l.cwd), initials(basename(l.cwd)), { x, y }, l.prompt);
        const [s] = await Promise.all([created, orb.landed]);
        // A disposable can stay a closed bubble and open once it has answered.
        const wait = !!l.disposableTtlMs && openOnReplyPref.current;
        if (wait) openOnReply.current.add(s.id);
        await tryInvokeNative('bubble_float', { sessionId: s.id });
        const done = orb;
        setTimeout(() => done.remove(), 80);
        if (!wait) {
          // Open its chat right away so the reply shows up as it streams,
          // instead of waiting behind a click on the new bubble.
          expand(s.id);
          opened = true;
        }
      }
    } catch (err) {
      failed = true;
      orb?.remove();
      setError(`Couldn't start the session: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Keep the overlay up long enough to read the error, then hand focus back —
    // unless the new chat is open, which keeps it so the user can reply.
    setTimeout(() => {
      setError(null);
      setSpot('closed');
      void tryInvokeNative('bubble_spotlight_state', { open: false, keepFocus: opened });
    }, failed ? 4000 : 0);
  }, [client, expand]);

  const restPos = (i: number) => (expanded
    ? { x: rowX(i), y: rowY, scale: 1, z: 100, opacity: 1 }
    : {
      // The stack fans out along its edge.
      x: anchorX + (vertical ? 0 : Math.min(i, STACK_VISIBLE - 1) * STACK_STEP),
      y: anchorY + (vertical ? Math.min(i, STACK_VISIBLE - 1) * STACK_STEP : 0),
      scale: 1 - Math.min(i, STACK_VISIBLE - 1) * 0.05,
      z: 100 - i,
      opacity: i < STACK_VISIBLE ? 1 : 0,
    });

  // ---- drag -----------------------------------------------------------------
  const unfloat = useCallback((id: string) => {
    setLeaving(prev => [...prev, id]);
    setTimeout(() => { void tryInvokeNative('bubble_unfloat', { sessionId: id }); }, 230);
  }, []);

  /** Archive the session and drop its bubble. */
  const archive = useCallback((id: string) => {
    openOnReply.current.delete(id);
    client?.archiveAndStopSession(id).catch(() => {});
    unfloat(id);
  }, [client, unfloat]);
  const archiveRef = useRef(archive);
  archiveRef.current = archive;

  const onPointerDown = (id: string, i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = restPos(i);
    grabRef.current = { id, whole: !expanded, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    reportHits.current(); // hold clicks for the whole drag, wherever it goes
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grabRef.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 5) return;
    if (!g.moved) { g.moved = true; setPeek(null); }
    let x = g.ox + dx;
    let y = g.oy + dy;
    const hot = Math.hypot(x + HS / 2 - zone.x, y + HS / 2 - zone.y) < 90;
    if (hot) { x = zone.x - HS / 2; y = zone.y - HS / 2; }
    g.last = { id: g.id, whole: g.whole, x, y, hot };
    setDrag(g.last);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grabRef.current;
    grabRef.current = null;
    reportHits.current();
    if (!g) return;
    const d = g.last;
    setDrag(null);

    if (!g.moved) {
      if (!expanded) expand(ids[0] ?? g.id);
      else if (expanded === g.id) collapse();
      else expand(g.id);
      return;
    }
    if (d?.hot) {
      if (g.whole) ids.forEach(unfloat);
      else unfloat(g.id);
      return;
    }
    if (!g.whole || !d) return;
    // Dropped on another display: main moves the overlay there first.
    const { screenX, screenY } = e;
    void tryInvokeNative<{ x: number; y: number; width: number; height: number } | null>('bubble_drop', { screenX, screenY })
      .then(wa => {
        // Snap to whichever of the four edges is closest.
        if (wa) setAnchor(nearestSide(screenX - wa.x, screenY - wa.y, wa.width, wa.height));
        else setAnchor(nearestSide(d.x + HS / 2, d.y + HS / 2, W, H));
      });
  };

  // ---- render -----------------------------------------------------------------
  const byId = useMemo(() => new Map(sessions.map(s => [s.id, s])), [sessions]);
  const active = expanded ? byId.get(expanded) : undefined;
  const activeIdx = expanded ? ids.indexOf(expanded) : -1;
  const panelW = Math.min(420, W - 2 * EDGE);
  // A bottom row opens its panel upwards; every other one opens it below.
  const panelUp = anchor.side === 'bottom';
  const panelH = panelUp ? Math.min(680, rowY - 14 - EDGE) : Math.min(680, H - (rowY + HS + 14) - EDGE);
  const panelTop = panelUp ? rowY - 14 - panelH : rowY + HS + 14;
  const panelLeft = anchor.side === 'left' ? EDGE
    : anchor.side === 'right' ? W - EDGE - panelW
    : clamp(rowX(Math.max(0, activeIdx)) + HS / 2 - panelW / 2, EDGE, W - EDGE - panelW);
  const peekLeft = clamp(anchorX + HS / 2 - 130, EDGE, W - EDGE - 260);
  const peekStyle: React.CSSProperties = anchor.side === 'right' ? { top: anchorY + 4, right: W - anchorX + 10 }
    : anchor.side === 'left' ? { top: anchorY + 4, left: anchorX + HS + 10 }
    : anchor.side === 'top' ? { top: anchorY + HS + 10, left: peekLeft }
    : { bottom: H - anchorY + 10, left: peekLeft };
  const peekSession = peek ? byId.get(peek.id) : undefined;

  return (
    <div className="bb-root">
      <style>{CSS}</style>

      <div className={`bb-dismiss-grad ${drag ? 'on' : ''}`} />
      <div className={`bb-dismiss ${drag ? 'on' : ''} ${drag?.hot ? 'hot' : ''}`} style={{ left: zone.x - 30, top: zone.y - 30 }}>
        <X size={22} strokeWidth={2.4} />
      </div>

      {ids.map((id, i) => {
        const s = byId.get(id);
        const r = rt[id] || EMPTY;
        const rest = restPos(i);
        let { x, y, scale, opacity } = rest;
        let transition: string | undefined;
        if (leaving.includes(id)) {
          x = zone.x - HS / 2; y = zone.y - HS / 2; scale = 0.2; opacity = 0;
          transition = 'transform .25s ease-in, opacity .2s';
        } else if (drag && drag.id === id) {
          x = drag.x; y = drag.y; scale = 1; transition = 'none';
        } else if (drag?.whole) {
          // Heads behind the grabbed one trail it like a chain.
          x = drag.x; y = drag.y + Math.min(i, STACK_VISIBLE - 1) * STACK_STEP;
          transition = `transform ${0.12 + i * 0.08}s ease-out`;
        }
        const status = r.permRequest ? 'permission' : r.isStreaming ? 'streaming' : '';
        const badge = r.permRequest ? '!' : r.unread || '';
        const voice = r.voice !== 'off' ? `voice-${r.voice}` : '';
        return (
          <div
            key={id}
            data-hit=""
            className={`bb-head ${status} ${voice} ${expanded === id ? 'active' : ''} ${drag?.id === id ? 'dragging' : ''}`}
            style={{ transform: `translate(${x}px, ${y}px) scale(${scale})`, zIndex: drag?.id === id ? 200 : rest.z, opacity, transition }}
            onPointerDown={onPointerDown(id, i)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            title={s?.name}
          >
            <div className="bb-halo" />
            <div className="bb-ring" />
            <div className="bb-av" style={{ background: hueFor(s?.cwd || id) }}>{s ? initials(s.name) : '…'}</div>
            <div className="bb-prov">{providerMark(s?.provider)}</div>
            {r.voice !== 'off' && <VoiceMark voice={r.voice} />}
            <div className={`bb-badge ${badge && expanded !== id ? 'on' : ''}`}>{badge}</div>
          </div>
        );
      })}

      {spot !== 'closed' && (
        <Spotlight
          client={client}
          sessions={sessions}
          colorFor={hueFor}
          launching={spot === 'launching'}
          onClose={closeSpot}
          onLaunch={launch}
        />
      )}
      <div ref={fxRef} />
      {error && <div data-hit="" className="bb-error">{error}</div>}

      {peek && !expanded && !drag && (
        <div
          data-hit=""
          className="bb-peek"
          style={peekStyle}
          onClick={() => expand(peek.id)}
        >
          <small>{peekSession?.name ?? 'Session'}</small>
          {peek.text}
        </div>
      )}

      {expanded && client && (
        <div
          data-hit=""
          className={`bb-panel ${panelUp ? 'up' : ''}`}
          style={{ top: panelTop, left: panelLeft, width: panelW, height: panelH }}
        >
          <div className={`bb-arrow ${panelUp ? 'up' : ''}`} style={{ left: rowX(activeIdx) + HS / 2 - panelLeft - 8 }} />
          <BubblePanel
            key={expanded}
            sessionId={expanded}
            session={active}
            missing={sessions.length > 0 && !active}
            runtime={rt[expanded] || EMPTY}
            client={client}
            onClearPerm={reqId => setRt(prev => {
              const cur = prev[expanded];
              return cur?.permRequest?.requestId === reqId ? { ...prev, [expanded]: { ...cur, permRequest: null } } : prev;
            })}
            onCollapse={collapse}
            onClose={() => unfloat(expanded)}
            archiveChord={kbBindings['archive-session'] ?? null}
            onArchive={() => archive(expanded)}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch flight
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The launcher card squeezes into an orb in place, then arcs into the stack
 *  at `to`, leaving a trail and a ripple where it lands. */
function flyOrb(host: HTMLElement, from: DOMRect, color: string, label: string, to: { x: number; y: number }, text: string) {
  const orb = document.createElement('div');
  orb.className = 'bb-orb';
  const txt = document.createElement('span');
  txt.className = 'bb-orb-t';
  txt.textContent = text;
  orb.appendChild(txt);
  Object.assign(orb.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  host.appendChild(orb);

  const cx = from.left + from.width / 2 - HS / 2;
  const cy = from.top + from.height / 2 - HS / 2;

  const landed = (async () => {
    txt.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    await orb.animate([
      { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '22px', background: 'rgba(20,21,26,.95)' },
      { left: `${cx - 20}px`, top: `${cy + 8}px`, width: `${HS + 40}px`, height: `${HS - 16}px`, borderRadius: '40px', background: 'rgba(200,149,107,.9)', offset: 0.7 },
      { left: `${cx}px`, top: `${cy}px`, width: `${HS}px`, height: `${HS}px`, borderRadius: '50%', background: color },
    ], { duration: 420, easing: 'cubic-bezier(.7,0,.3,1)', fill: 'forwards' }).finished;
    orb.textContent = label;
    orb.style.boxShadow = `0 0 0 2px #0f1012, 0 0 40px ${color}`;

    // Quadratic arc bowing up and away from the stack's edge.
    const kx = (cx + to.x) / 2 + (to.x > cx ? 80 : -80);
    const ky = Math.min(cy, to.y) - 180;
    const frames: Keyframe[] = [];
    for (let i = 0, N = 24; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const x = u * u * cx + 2 * u * t * kx + t * t * to.x;
      const y = u * u * cy + 2 * u * t * ky + t * t * to.y;
      frames.push({ transform: `translate(${x - cx}px, ${y - cy}px) scale(${1 + Math.sin(t * Math.PI) * 0.18})` });
    }
    const fly = orb.animate(frames, { duration: 620, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
    const trail = setInterval(() => {
      const b = orb.getBoundingClientRect();
      const dot = document.createElement('div');
      dot.className = 'bb-trail';
      dot.style.left = `${b.left + b.width / 2 - 5}px`;
      dot.style.top = `${b.top + b.height / 2 - 5}px`;
      host.appendChild(dot);
      setTimeout(() => dot.remove(), 600);
    }, 16);
    await fly.finished;
    clearInterval(trail);

    const ripple = document.createElement('div');
    ripple.className = 'bb-ripple';
    Object.assign(ripple.style, { left: `${to.x}px`, top: `${to.y}px`, borderColor: color });
    host.appendChild(ripple);
    setTimeout(() => ripple.remove(), 800);
    await wait(40);
  })();

  return { landed, remove: () => orb.remove() };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function VoiceBars() {
  return <span className="bb-bars"><i /><i /><i /><i /></span>;
}

/** Bottom-left badge, mirroring the provider mark: a mic while voice mode
 *  listens, moving bars while it speaks. */
function VoiceMark({ voice }: { voice: VoiceActivity }) {
  return (
    <div className="bb-mic">
      {voice === 'speaking' ? <VoiceBars /> : <Mic size={11} strokeWidth={2.5} />}
    </div>
  );
}

const BubblePanel = memo(function BubblePanel({
  sessionId, session, missing, runtime, client, onClearPerm, onCollapse, onClose, archiveChord, onArchive,
}: {
  sessionId: string;
  session: SessionInfo | undefined;
  /** The bridge doesn't list it: deleted, or its remote is offline. */
  missing: boolean;
  runtime: Runtime;
  client: ClaudeClient;
  onClearPerm: (requestId: string) => void;
  onCollapse: () => void;
  onClose: () => void;
  archiveChord: string | null;
  onArchive: () => void;
}) {
  const { messages, partialText, isStreaming, permRequest, hydrated } = runtime;
  const [text, setText] = useState('');
  const slashCommands = useMemo(
    () => [...BUILTIN_SLASH_COMMANDS, ...runtime.slashCommands.filter(c => !BUILTIN_SLASH_COMMANDS.includes(c))],
    [runtime.slashCommands],
  );
  const slash = useSlashCommands(text, slashCommands);
  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `);
    inputRef.current?.focus();
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 60); return () => clearTimeout(t); }, []);

  // Stick to the bottom while new content streams in, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, partialText, permRequest, hydrated]);

  const items = useMemo(() => {
    const resultByToolUseId = new Map<string, ChatMessage>();
    const toolUseIds = new Set<string>();
    for (const m of messages) {
      if (m.toolName && !m.isToolResult) toolUseIds.add(m.id);
      if (m.isToolResult && m.toolUseId) resultByToolUseId.set(m.toolUseId, m);
    }
    const explain = collectExplainParts(messages);
    const visible = messages.filter(m => !explain.hidden.has(m.id)
      && !(m.isToolResult && m.toolUseId && toolUseIds.has(m.toolUseId)));
    return { collapsed: collapseToolRuns(visible), resultByToolUseId, explain };
  }, [messages]);

  const send = () => {
    const v = text.trim();
    if (!v || isStreaming) return;
    if (v === '/restart') {
      setText('');
      void client.restartSession(sessionId).catch(() => {});
      return;
    }
    client.sendMessage(sessionId, v);
    setText('');
    pinned.current = true;
  };

  const respond = (allow: boolean) => {
    if (!permRequest) return;
    onClearPerm(permRequest.requestId);
    client.respondToPermission(sessionId, permRequest.requestId, allow, allow ? permRequest.input : undefined);
  };
  const answer = (answers: Record<string, string>) => {
    if (!permRequest) return;
    onClearPerm(permRequest.requestId);
    client.respondToPermission(sessionId, permRequest.requestId, true, { ...permRequest.input, answers });
  };

  const statusLabel = permRequest ? 'Waiting for permission' : isStreaming ? 'Working…' : 'Idle';
  const statusCls = permRequest ? 'permission' : isStreaming ? 'streaming' : 'idle';

  return (
    <>
      <div className="bb-ph">
        <div className="min-w-0">
          <div className="bb-pt truncate">{session?.name ?? 'Session'}</div>
          <div className="bb-ps">
            <span className={`bb-sdot ${statusCls}`} />{statusLabel}
            {runtime.voice !== 'off' && (
              <span className={`bb-vchip ${runtime.voice}`}>
                {runtime.voice === 'speaking' ? <VoiceBars /> : <span className="bb-vdot" />}
                {runtime.voice === 'speaking' ? 'Speaking' : 'Listening'}
              </span>
            )}
          </div>
        </div>
        <div className="bb-acts">
          <button className="bb-ibtn" title="Back to tab" onClick={() => void tryInvokeNative('bubble_dock', { sessionId })}>
            <PanelTop size={15} />
          </button>
          <button className="bb-ibtn" title="Collapse (Esc)" onClick={onCollapse}><Minus size={15} /></button>
          <button className="bb-ibtn" title="Close bubble" onClick={onClose}><X size={15} /></button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="bb-thread"
        onScroll={e => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {missing
          ? <div className="bb-loading">This session isn't available — it was deleted or its host is offline. Close the bubble with ✕.</div>
          : !hydrated && <div className="bb-loading">Loading…</div>}
        <ul className="flex flex-col gap-3 py-3">
          {items.collapsed.map((item, idx) => {
            if ('toolRun' in item) {
              return (
                <MobileToolRunBubble
                  key={item.items[0]!.id}
                  group={item}
                  resultByToolUseId={items.resultByToolUseId}
                  hasContentAfter={idx < items.collapsed.length - 1 || !!partialText}
                />
              );
            }
            const m = item as ChatMessage;
            return (
              <MobileMessage
                key={m.id}
                msg={m}
                result={m.toolName && !m.isToolResult ? items.resultByToolUseId.get(m.id) : undefined}
                explainParts={items.explain.parts}
              />
            );
          })}
          {partialText && (
            <li className="mx-4 text-zinc-100">
              <Markdown text={partialText} className="text-[15px] [&_p]:my-1 [&_pre]:my-2" />
            </li>
          )}
          {isStreaming && !partialText && !permRequest && (
            <li className="mx-4 bb-typing"><span /><span /><span /></li>
          )}
        </ul>
        {permRequest && (
          permRequest.toolName === 'AskUserQuestion'
            ? <MobileAskQuestionCard request={permRequest} onSubmit={answer} />
            : <PermissionCard request={permRequest} onRespond={respond} />
        )}
      </div>

      <ArchiveSuggestionPill
        messages={messages}
        streaming={isStreaming || !!permRequest}
        typing={!!text.trim()}
        chord={archiveChord}
        onArchive={onArchive}
        className="mb-2"
      />
      <div className="bb-composer">
        {slash.isActive && (
          <SlashCommandList
            filtered={slash.filtered}
            selectedIndex={slash.selectedIndex}
            onSelect={pickSlash}
            onHover={() => {}}
          />
        )}
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          placeholder={`Reply to ${session?.name ?? 'session'}…`}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (slash.isActive) {
              slash.onKeyDown(e, pickSlash);
              if (e.defaultPrevented) return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
        />
        {isStreaming ? (
          <button className="bb-send stop" title="Stop" onClick={() => client.interrupt(sessionId)}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button className="bb-send" title="Send (Enter)" disabled={!text.trim()} onClick={send}>
            <Send size={15} />
          </button>
        )}
      </div>
    </>
  );
});

const CSS = `
.bb-root { position: fixed; inset: 0; overflow: hidden; pointer-events: none; font-family: var(--font-sans); -webkit-user-select: none; user-select: none; }
.bb-root [data-hit] { pointer-events: auto; }

.bb-head { position: absolute; left: 0; top: 0; width: ${HS}px; height: ${HS}px; border-radius: 50%; cursor: grab; touch-action: none;
  transition: transform .5s cubic-bezier(.34,1.56,.64,1), opacity .25s; will-change: transform; }
.bb-head.dragging { cursor: grabbing; }
.bb-av { position: absolute; inset: 0; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; color: #111;
  box-shadow: 0 6px 18px rgba(0,0,0,.45), 0 0 0 2px #0f1012; animation: bb-pop .45s cubic-bezier(.34,1.56,.64,1); transition: transform .15s; }
.bb-head.dragging .bb-av { transform: scale(1.08); }
.bb-head.active .bb-av { box-shadow: 0 6px 18px rgba(0,0,0,.45), 0 0 0 2px #0f1012, 0 0 0 4px #c8956b; }
@keyframes bb-pop { from { transform: scale(0); } }
.bb-prov { position: absolute; right: -1px; bottom: -1px; width: 19px; height: 19px; border-radius: 50%; background: #111; border: 2px solid #0f1012;
  display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #c8956b; }
.bb-ring { position: absolute; inset: -5px; border-radius: 50%; border: 2.5px solid transparent; opacity: 0; transition: opacity .2s; }
.bb-head.streaming .bb-ring { opacity: 1; border-top-color: #7aa2f7; border-right-color: rgba(122,162,247,.35); animation: bb-spin 1s linear infinite; }
.bb-head.permission .bb-ring { opacity: 1; border-color: #e3b341; animation: bb-pulse 1.4s ease-out infinite; }
@keyframes bb-spin { to { transform: rotate(360deg); } }
@keyframes bb-pulse { 0% { box-shadow: 0 0 0 0 rgba(227,179,65,.55); } 100% { box-shadow: 0 0 0 12px rgba(227,179,65,0); } }
.bb-badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #f0524d; color: #fff;
  font-size: 11px; font-weight: 700; display: grid; place-items: center; border: 2px solid #0f1012; transform: scale(0); transition: transform .3s cubic-bezier(.34,1.56,.64,1); }
.bb-badge.on { transform: scale(1); }
.bb-head.permission .bb-badge { background: #e3b341; color: #1b130c; }

.bb-peek { position: absolute; max-width: 260px; background: #f4f4f6; color: #15161a; padding: 8px 12px; border-radius: 16px; font-size: 12.5px; line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; animation: bb-peek-in .3s cubic-bezier(.34,1.56,.64,1); }
.bb-peek small { display: block; font-size: 10.5px; color: #6b6d76; font-weight: 600; margin-bottom: 1px; }
@keyframes bb-peek-in { from { opacity: 0; transform: scale(.85); } }

.bb-dismiss { position: absolute; width: 60px; height: 60px; border-radius: 50%; background: rgba(20,20,24,.85); border: 2px solid rgba(255,255,255,.35);
  display: grid; place-items: center; color: #fff; opacity: 0; transform: translateY(40px) scale(.8); transition: all .25s cubic-bezier(.34,1.56,.64,1); }
.bb-dismiss.on { opacity: 1; transform: none; }
.bb-dismiss.hot { transform: scale(1.25); background: #f0524d; border-color: #f0524d; }
.bb-dismiss-grad { position: absolute; left: 0; right: 0; bottom: 0; height: 200px; background: linear-gradient(transparent, rgba(0,0,0,.45)); opacity: 0; transition: opacity .25s; }
.bb-dismiss-grad.on { opacity: 1; }

.bb-panel { position: absolute; background: #17181b; border: 1px solid #3a3b40; border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,.55);
  display: flex; flex-direction: column; transform-origin: top right; animation: bb-panel-in .35s cubic-bezier(.34,1.56,.64,1); -webkit-user-select: text; user-select: text; }
@keyframes bb-panel-in { from { opacity: 0; transform: scale(.6) translateY(-30px); } }
.bb-arrow { position: absolute; top: -8px; width: 16px; height: 16px; background: #17181b; border-left: 1px solid #3a3b40; border-top: 1px solid #3a3b40;
  transform: rotate(45deg); transition: left .35s cubic-bezier(.34,1.56,.64,1); }
.bb-panel.up { transform-origin: bottom center; animation-name: bb-panel-in-up; }
@keyframes bb-panel-in-up { from { opacity: 0; transform: scale(.6) translateY(30px); } }
.bb-arrow.up { top: auto; bottom: -8px; border: 0; border-right: 1px solid #3a3b40; border-bottom: 1px solid #3a3b40; }
.bb-ph { display: flex; align-items: center; gap: 9px; padding: 12px 10px 10px 16px; border-bottom: 1px solid #2a2b30; }
.bb-pt { font-weight: 600; font-size: 13.5px; }
.bb-ps { font-size: 11px; color: #8b8d96; display: flex; align-items: center; gap: 6px; }
.bb-sdot { width: 7px; height: 7px; border-radius: 50%; background: #7ee787; }
.bb-sdot.streaming { background: #7aa2f7; box-shadow: 0 0 0 3px rgba(122,162,247,.2); }
.bb-sdot.permission { background: #e3b341; }
.bb-halo { position: absolute; inset: -11px; border-radius: 50%; pointer-events: none; opacity: 0; transition: opacity .25s; }
.bb-head.voice-listening .bb-halo { opacity: 1; box-shadow: 0 0 0 2px rgba(115,218,202,.55); animation: bb-breathe 2.4s ease-in-out infinite; }
.bb-head.voice-speaking .bb-halo { opacity: 1; box-shadow: 0 0 0 2px rgba(158,206,106,.7); animation: bb-talk .5s ease-in-out infinite alternate; }
@keyframes bb-breathe { 0%,100% { transform: scale(.96); opacity: .55; } 50% { transform: scale(1.04); opacity: 1; } }
@keyframes bb-talk { from { transform: scale(.97); opacity: .7; } to { transform: scale(1.09); opacity: 1; } }
.bb-mic { position: absolute; left: -3px; bottom: -3px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid #0f1012;
  display: grid; place-items: center; color: #0c1a17; background: #73daca; }
.bb-head.voice-speaking .bb-mic { background: #9ece6a; }
.bb-bars { display: inline-flex; gap: 1.5px; align-items: center; height: 10px; }
.bb-bars i { width: 2px; border-radius: 1px; background: #102016; animation: bb-bar .6s ease-in-out infinite alternate; }
.bb-bars i:nth-child(1) { height: 4px; animation-delay: -.3s; } .bb-bars i:nth-child(2) { height: 9px; animation-delay: -.1s; }
.bb-bars i:nth-child(3) { height: 6px; animation-delay: -.45s; } .bb-bars i:nth-child(4) { height: 8px; animation-delay: -.2s; }
@keyframes bb-bar { from { transform: scaleY(.35); } to { transform: scaleY(1); } }
.bb-vchip { margin-left: 6px; font-size: 11px; padding: 2px 8px 2px 7px; border-radius: 999px; display: inline-flex; align-items: center; gap: 6px; }
.bb-vchip.listening { background: rgba(115,218,202,.12); color: #73daca; }
.bb-vchip.speaking { background: rgba(158,206,106,.13); color: #9ece6a; }
.bb-vchip .bb-bars i { background: #9ece6a; }
.bb-vdot { width: 7px; height: 7px; border-radius: 50%; background: #73daca; animation: bb-breathe 2.4s ease-in-out infinite; }
.bb-acts { margin-left: auto; display: flex; gap: 2px; }
.bb-ibtn { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #8b8d96; }
.bb-ibtn:hover { background: #1c1d21; color: #e6e6ea; }
.bb-thread { flex: 1; min-height: 0; overflow: auto; zoom: .86; }
.bb-loading { padding: 16px; color: #8b8d96; font-size: 13px; }
.bb-typing { display: flex; gap: 4px; padding: 4px 0; }
.bb-typing span { width: 6px; height: 6px; border-radius: 50%; background: #8b8d96; animation: bb-ty 1.2s infinite; }
.bb-typing span:nth-child(2) { animation-delay: .15s; } .bb-typing span:nth-child(3) { animation-delay: .3s; }
@keyframes bb-ty { 0%,60%,100% { opacity: .25; transform: none; } 30% { opacity: 1; transform: translateY(-3px); } }
.bb-composer { position: relative; display: flex; gap: 8px; align-items: flex-end; padding: 10px; border-top: 1px solid #2a2b30; }
.bb-composer textarea { flex: 1; resize: none; max-height: 120px; field-sizing: content; background: #1c1d21; border: 1px solid #2a2b30; border-radius: 18px;
  padding: 8px 14px; color: #e6e6ea; font: inherit; font-size: 13px; outline: none; }
.bb-composer textarea:focus { border-color: #3a3b40; }
.bb-send { width: 36px; height: 36px; flex: none; border-radius: 50%; background: #c8956b; color: #1b130c; display: grid; place-items: center; }
.bb-send:disabled { opacity: .4; }
.bb-send.stop { background: #25262d; color: #e6e6ea; }

.bb-orb { position: absolute; z-index: 300; display: grid; place-items: center; overflow: hidden; color: #111; font-weight: 700; font-size: 15px;
  border-radius: 22px; background: rgba(20,21,26,.95); box-shadow: 0 0 0 1.5px rgba(200,149,107,.8), 0 0 60px rgba(200,149,107,.45); }
.bb-orb-t { position: absolute; inset: 0; padding: 18px 22px 18px 58px; color: #f2f2f5; font: 500 19px/1.45 var(--font-sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bb-trail { position: absolute; z-index: 299; width: 10px; height: 10px; border-radius: 50%; background: radial-gradient(circle, #ffd9b8, rgba(200,149,107,0) 70%); animation: bb-fade .6s ease-out forwards; }
@keyframes bb-fade { to { opacity: 0; transform: scale(.2); } }
.bb-ripple { position: absolute; z-index: 90; width: ${HS}px; height: ${HS}px; border-radius: 50%; border: 2px solid #c8956b; animation: bb-rip .7s cubic-bezier(.16,1,.3,1) forwards; }
@keyframes bb-rip { from { transform: scale(1); opacity: .9; } to { transform: scale(2.6); opacity: 0; } }
.bb-error { position: absolute; left: 50%; top: 24px; transform: translateX(-50%); max-width: 520px; padding: 9px 14px; border-radius: 10px; background: #2a1414;
  border: 1px solid rgba(240,82,77,.45); color: #ffc9c6; font-size: 12.5px; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
`;
