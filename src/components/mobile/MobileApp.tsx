import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ClaudeClient,
  resolveServerUrl,
  setAuthToken,
  type ChatMessage,
  type ConnectionStatus,
  type PermissionRequest,
  type SessionInfo,
  type SupportedModel,
} from '../../lib/claude-client';
import { playChime } from '../../lib/chime';
import { useScreenWakeLock } from '../../lib/wake-lock';
import { MobileChat } from './MobileChat';
import { MobileHome } from './MobileHome';
import { GlassNav, type NavTab } from './GlassNav';
import { BottomBlobs } from './BottomBlobs';
import { PwaInstallBanner } from './PwaInstallBanner';
import { MobileFilesSheet } from './MobileFilesSheet';
import { MobileGitSheet } from './MobileGitSheet';
import { MobileSettingsSheet } from './MobileSettingsSheet';
import { BypassWarningModal, shouldWarnBypass } from '../BypassWarningModal';
import type { MockupComment } from '../../lib/mockup-inspector';

const TOKEN_STORAGE_KEY = 'mobileToken';

type SessionRuntime = {
  messages: ChatMessage[];
  partialText: string;
  /** Live-streaming reasoning text. Mirrors desktop's `partialThinking`. */
  partialThinking: string;
  isStreaming: boolean;
  /** Last turn died without onTurnComplete — drives the red dot. */
  wasInterrupted: boolean;
  permRequest: PermissionRequest | null;
  /** False until the first `session_state` snapshot lands; drives the
   *  bottom loader bar while the active session's history is fetching. */
  hydrated: boolean;
};

const EMPTY_RUNTIME: SessionRuntime = {
  messages: [],
  partialText: '',
  partialThinking: '',
  isStreaming: false,
  wasInterrupted: false,
  permRequest: null,
  hydrated: false,
};

/** One mockup pinned to a session — persists across modal open/close so the
 *  user can re-enter from the chat dock pill without losing their comments. */
type MockupEntry = {
  name: string;
  html: string;
  comments: MockupComment[];
};

export function MobileApp() {
  // ---------------------------------------------------------------------
  // Token bootstrap. Token may arrive in two ways:
  //   1. URL hash fragment from a paired QR code: #t=<token>&s=<sessionId>
  //   2. localStorage (persisted from a previous load)
  // ---------------------------------------------------------------------
  const [token, setToken] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [pendingSessionFromHash, setPendingSessionFromHash] = useState<string | null>(null);

  // Register the PWA service worker once on mount. Silently no-ops on
  // insecure contexts (e.g. http://<lan-ip>) — installability still works
  // on iOS Safari via "Add to Home Screen", and Android Chrome will pick
  // up the SW automatically when the page is served over HTTPS.
  //
  // Update flow:
  //  1. On register we check for updates immediately and on tab focus.
  //  2. When a new SW reaches the `waiting` state (because the current tab is
  //     still controlled by the old one), we tell it to skipWaiting.
  //  3. The new SW's `activate` handler posts a `sw-activated` message; we
  //     also listen to `controllerchange` as a backstop. Either one triggers
  //     a single reload so the page loads the new `/m` shell with fresh
  //     hashed asset refs.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let reloadPending = false;
    const reloadOnce = () => {
      if (reloadPending) return;
      reloadPending = true;
      // Give the browser a tick to finalize the controller swap before reload.
      setTimeout(() => window.location.reload(), 50);
    };

    const askToSkip = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting) {
        try { reg.waiting.postMessage({ type: 'skip-waiting' }); } catch {}
      }
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        // If there's already a waiting worker from a previous load, kick it.
        askToSkip(reg);
        // Re-check for updates when the tab becomes visible again — picks up
        // new deploys that happened while the PWA was backgrounded.
        const poll = () => { reg.update().catch(() => {}); };
        const onVis = () => { if (document.visibilityState === 'visible') poll(); };
        document.addEventListener('visibilitychange', onVis);
        // Also a time-based check as a backstop (every 5 min) for long-lived
        // sessions that never lose focus.
        const t = setInterval(poll, 5 * 60 * 1000);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              // There's a fresh worker waiting and we're currently controlled
              // by the old one — nudge it to activate.
              askToSkip(reg);
            }
          });
        });
        // Store cleanup on window so React strict-mode double-invoke doesn't
        // leak. We intentionally don't remove these across unmounts of the
        // component because the registration is a page-lifetime concern.
        (window as any).__codibyCodeSwCleanup__ = () => {
          document.removeEventListener('visibilitychange', onVis);
          clearInterval(t);
        };
      })
      .catch(() => {/* secure-context restriction or registration error — ignore */});

    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'sw-activated') reloadOnce();
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);

    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce);
    };
  }, []);

  useEffect(() => {
    const hash = window.location.hash || '';
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const t = params.get('t');
    const s = params.get('s');
    let resolved: string | null = null;
    if (t) {
      try { localStorage.setItem(TOKEN_STORAGE_KEY, t); } catch {}
      resolved = t;
      // Strip the token from the URL (security) but KEEP the session id
      // so refresh restores the user's last open session.
      try {
        const newHash = s ? `#s=${s}` : '';
        history.replaceState(null, '', window.location.pathname + newHash);
      } catch {}
    } else {
      try { resolved = localStorage.getItem(TOKEN_STORAGE_KEY); } catch {}
    }
    if (resolved) {
      setAuthToken(resolved);
      setToken(resolved);
    }
    if (s) setPendingSessionFromHash(s);
    setBootstrapping(false);
  }, []);

  // ---------------------------------------------------------------------
  // Server URL + ClaudeClient lifecycle (recreate when token changes)
  // ---------------------------------------------------------------------
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  useEffect(() => { resolveServerUrl().then(setServerUrl); }, []);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Record<string, SessionRuntime>>({});
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [statusBySession, setStatusBySession] = useState<Record<string, string>>({});
  const [turnCompleteSet, setTurnCompleteSet] = useState<Set<string>>(new Set());
  const [supportedModelsBySession, setSupportedModelsBySession] = useState<Record<string, SupportedModel[]>>({});
  // Tab grouping / ordering / closed sessions — shared with the desktop UI
  // via `~/.codiby/ui-preferences.json` so both views agree.
  const [tabGroups, setTabGroups] = useState<Record<string, { id: string; name: string; color: string }>>({});
  const [tabGroupMap, setTabGroupMap] = useState<Record<string, string>>({});
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(new Set());
  // Cached opencode probe — see ChatApp.tsx for the desktop equivalent.
  const [opencodeInfo, setOpencodeInfo] = useState<{ available: boolean; models: Array<{ id: string; label: string; providerName: string }> } | null>(null);
  // Cached Claude model list (SDK-reported). Empty until the bridge has
  // seen at least one Claude session — there is no hardcoded fallback.
  const [claudeModels, setClaudeModels] = useState<SupportedModel[]>([]);
  // Mockups broadcast by the `mockup_write` / `mockup_edit` SDK tools, keyed
  // by session id. The list is the dock pill row above the composer; the
  // optional `openName` per session is the mockup currently rendered in the
  // full-screen modal. Closing the modal clears `openName` but leaves the
  // entry in the list so the pill stays.
  const [mockupsBySession, setMockupsBySession] = useState<Record<string, MockupEntry[]>>({});
  const [openMockupBySession, setOpenMockupBySession] = useState<Record<string, string | null>>({});
  const clientRef = useRef<ClaudeClient | null>(null);

  useEffect(() => {
    if (!serverUrl || bootstrapping) return;
    if (clientRef.current) {
      clientRef.current.destroy();
      clientRef.current = null;
    }
    const client = new ClaudeClient(serverUrl, {
      onSessions: (list) => {
        setSessions(list);
        // Restore from URL hash (`#s=<id>`) on a fresh load. With no hash
        // we land on the home screen — no auto-pick.
        setActiveId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          if (pendingSessionFromHash && list.some((s) => s.id === pendingSessionFromHash)) {
            return pendingSessionFromHash;
          }
          return null;
        });
      },
      onSessionState: (sessionId, state) => {
        if (state.supportedModels) {
          setSupportedModelsBySession((prev) => ({ ...prev, [sessionId]: state.supportedModels || [] }));
        }
        setRuntime((prev) => ({
          ...prev,
          [sessionId]: {
            messages: state.messages || [],
            partialText: state.partialText || '',
            partialThinking: state.partialThinking || '',
            isStreaming: !!state.isStreaming,
            wasInterrupted: !!state.wasInterrupted,
            permRequest: state.permRequest,
            hydrated: true,
          },
        }));
      },
      onMessage: (sessionId, msg) => {
        setRuntime((prev) => {
          const cur = prev[sessionId] || EMPTY_RUNTIME;
          // De-dupe by id (server sometimes re-broadcasts persisted messages)
          if (cur.messages.some((m) => m.id === msg.id)) return prev;
          return {
            ...prev,
            [sessionId]: {
              ...cur,
              messages: [...cur.messages, msg],
              partialText: '',
              partialThinking: msg.isThinking ? '' : cur.partialThinking,
              isStreaming: false,
              wasInterrupted: false,
            },
          };
        });
        // Server-driven interactive terminals (the `spawn_terminal` SDK
        // tool pushes a `isInteractiveTerminal: true` chat message). The
        // desktop renders these from `state.messages`; mobile reads its
        // shell dock from a separate `shellsBySession` map, so we hydrate
        // it here whenever such a message arrives.
        if (msg.isInteractiveTerminal && msg.procId) {
          setShellsBySession((prev) => {
            const list = prev[sessionId] || [];
            if (list.some((s) => s.procId === msg.procId)) return prev;
            return {
              ...prev,
              [sessionId]: [
                ...list,
                {
                  id: msg.procId!,
                  procId: msg.procId!,
                  cwd: msg.terminalCwd || '/',
                  command: msg.terminalCommand,
                  createdAt: msg.timestamp || Date.now(),
                },
              ],
            };
          });
        }
      },
      onPartialText: (sessionId, text) => {
        setRuntime((prev) => {
          const cur = prev[sessionId] || EMPTY_RUNTIME;
          return { ...prev, [sessionId]: { ...cur, partialText: text, isStreaming: true, wasInterrupted: false } };
        });
      },
      onPartialThinking: (sessionId, text) => {
        setRuntime((prev) => {
          const cur = prev[sessionId] || EMPTY_RUNTIME;
          return { ...prev, [sessionId]: { ...cur, partialThinking: text, isStreaming: !!text || cur.isStreaming, wasInterrupted: false } };
        });
      },
      onPermissionRequest: (sessionId, req) => {
        setRuntime((prev) => {
          const cur = prev[sessionId] || EMPTY_RUNTIME;
          return { ...prev, [sessionId]: { ...cur, permRequest: req } };
        });
        // Same audio cue as desktop — short two-note chime so the user
        // notices Claude needs them.
        playChime();
      },
      onPermissionCancelled: (sessionId, requestId) => {
        setRuntime((prev) => {
          const cur = prev[sessionId];
          if (!cur || cur.permRequest?.requestId !== requestId) return prev;
          return { ...prev, [sessionId]: { ...cur, permRequest: null } };
        });
      },
      onStatus: (sessionId, status) => {
        setStatusBySession((prev) => ({ ...prev, [sessionId]: status }));
        if (status === 'streaming') {
          // Server flips this on as soon as the user message is dispatched —
          // before the first token. Keeps the "thinking" indicator visible
          // even when the SDK takes a few seconds to respond. Also clears
          // any prior "interrupted" flag — there's a fresh turn now.
          setRuntime((prev) => {
            const cur = prev[sessionId] || EMPTY_RUNTIME;
            if (cur.isStreaming && !cur.wasInterrupted) return prev;
            return { ...prev, [sessionId]: { ...cur, isStreaming: true, wasInterrupted: false } };
          });
          return;
        }
        if (status === 'interrupted') {
          // Provider died mid-turn (no onTurnComplete arrived). Drop the
          // "thinking" state and surface a red dot so the user knows the
          // last turn failed instead of just sitting on a stale orange.
          setRuntime((prev) => {
            const cur = prev[sessionId];
            if (!cur) return prev;
            return { ...prev, [sessionId]: { ...cur, isStreaming: false, partialText: '', partialThinking: '', wasInterrupted: true } };
          });
          return;
        }
        if (status === 'turn_complete') {
          // Only chime when the session was actually streaming before this
          // event — avoids chiming on reconnect/replay where the SDK emits
          // a turn_complete for an already-finished historic turn.
          let wasStreaming = false;
          setRuntime((prev) => {
            const cur = prev[sessionId];
            if (!cur) return prev;
            wasStreaming = !!cur.isStreaming;
            return { ...prev, [sessionId]: { ...cur, isStreaming: false, wasInterrupted: false, permRequest: null, partialText: '', partialThinking: '' } };
          });
          if (wasStreaming) playChime();
          // Flash the green "turn complete" dot for the inactive session list,
          // then clear after a few seconds (matches desktop behavior).
          setTurnCompleteSet((prev) => {
            const next = new Set(prev);
            next.add(sessionId);
            return next;
          });
          setTimeout(() => {
            setTurnCompleteSet((prev) => {
              if (!prev.has(sessionId)) return prev;
              const next = new Set(prev);
              next.delete(sessionId);
              return next;
            });
          }, 4000);
        }
      },
      onTerminalData: () => {/* Mobile doesn't render the live terminal stream */},
      onTerminalExit: () => {},
      onTodos: () => {},
      onAutoApproved: () => {},
      onSessionName: (sessionId, name) => {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name } : s)));
      },
      onInitInfo: () => {},
      onSupportedModels: (sessionId, models) => {
        setSupportedModelsBySession((prev) => ({ ...prev, [sessionId]: models }));
        // Treat the live session's report as the freshest snapshot of the
        // SDK's supportedModels(). Mirror it into the shared cache so pickers
        // outside this session (new-session modal) reflect the latest list.
        if (models.length > 0) setClaudeModels(models);
      },
      onOpenFile: () => {},
      onOpenMockup: (sessionId, name, html) => {
        // Insert/update the entry, preserving any existing comments so a
        // mockup_edit pass doesn't wipe in-flight feedback.
        setMockupsBySession((prev) => {
          const list = prev[sessionId] || [];
          const idx = list.findIndex((m) => m.name === name);
          const next: MockupEntry[] = idx === -1
            ? [...list, { name, html, comments: [] }]
            : list.map((m, i) => (i === idx ? { ...m, html } : m));
          return { ...prev, [sessionId]: next };
        });
        // Mirror desktop: every broadcast pops the modal open. Edits to an
        // already-open mockup just refresh in place.
        setOpenMockupBySession((prev) => ({ ...prev, [sessionId]: name }));
      },
      // Mobile doesn't render the browser preview yet — proxy iframe rendering
      // needs a different chrome on phones. Stub the callbacks so the desktop
      // `browser_open` tool doesn't crash on a connected mobile client.
      onOpenBrowser: () => {},
      onCloseBrowser: () => {},
      onFocusBrowser: () => {},
      onPreferences: (prefs) => {
        if (prefs.tabGroups && typeof prefs.tabGroups === 'object') {
          setTabGroups(prefs.tabGroups as Record<string, { id: string; name: string; color: string }>);
        }
        if (prefs.tabGroupMap && typeof prefs.tabGroupMap === 'object') {
          setTabGroupMap(prefs.tabGroupMap as Record<string, string>);
        }
      },
      onFocusSession: (sid) => setActiveId(sid),
      onWelcome: () => {/* Mobile resumes sessions on user action only */},
      onConnectionChange: setConnection,
    });
    clientRef.current = client;
    // Probe opencode once per mount; cached server-side, so the bridge
    // only spawns the binary on the first call.
    let cancelled = false;
    client.getOpencodeInfo()
      .then(info => { if (!cancelled) setOpencodeInfo({ available: info.available, models: info.models || [] }); })
      .catch(() => { if (!cancelled) setOpencodeInfo({ available: false, models: [] }); });
    // Seed the shared Claude model cache. Per-session updates keep it fresh
    // (see the `onSupportedModels` handler that mirrors into `claudeModels`).
    client.getClaudeInfo()
      .then(info => { if (!cancelled) setClaudeModels(info.models || []); })
      .catch(() => {});
    return () => {
      cancelled = true;
      client.destroy();
      clientRef.current = null;
    };
  }, [serverUrl, bootstrapping, token, pendingSessionFromHash]);

  // Subscribe to the active session whenever it changes
  useEffect(() => {
    const c = clientRef.current;
    if (!c || !activeId) return;
    c.subscribe(activeId);
    // Lazy spawn: ask the bridge to boot this session's provider if it
    // isn't already running. The server dedupes already-running providers.
    c.notifyActiveTab(activeId);
    return () => { c.unsubscribe(activeId); };
  }, [activeId, sessions.length]);

  // Reflect the active session id in the URL hash so refreshing the page
  // restores the same session. Also listen to hashchange so browser
  // back/forward navigation keeps state in sync.
  useEffect(() => {
    if (bootstrapping) return;
    try {
      const desired = activeId ? `#s=${activeId}` : '';
      const current = window.location.hash || '';
      if (desired !== current) {
        history.replaceState(null, '', window.location.pathname + desired);
      }
    } catch {}
  }, [activeId, bootstrapping]);

  useEffect(() => {
    const onHashChange = () => {
      const params = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
      const s = params.get('s');
      if (s && s !== activeId && sessions.some((x) => x.id === s)) {
        setActiveId(s);
      } else if (!s && activeId) {
        // Hash cleared (e.g. user manually removed it) — leave activeId alone
        // so the chat doesn't suddenly empty out.
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [activeId, sessions]);

  // Load tab groups + ordering + closed-session prefs (shared with desktop)
  useEffect(() => {
    const c = clientRef.current;
    if (!c) return;
    c.getPreferences().then((prefs) => {
      if (prefs.tabGroups && typeof prefs.tabGroups === 'object') {
        setTabGroups(prefs.tabGroups as Record<string, { id: string; name: string; color: string }>);
      }
      if (prefs.tabGroupMap && typeof prefs.tabGroupMap === 'object') {
        setTabGroupMap(prefs.tabGroupMap as Record<string, string>);
      }
      if (Array.isArray(prefs.tabOrder)) {
        setTabOrder(prefs.tabOrder as string[]);
      }
      if (Array.isArray(prefs.pinnedSessionIds)) {
        setPinnedSessionIds(new Set(prefs.pinnedSessionIds as string[]));
      }
    }).catch(() => {});
  }, [serverUrl, token]);

  /** Optimistically flip a session's status locally — the broadcast list
   *  arrives a tick later and overwrites with the authoritative value.
   *  Bumps updated_at so the just-archived session sorts to the top of
   *  the restore list without waiting for the server roundtrip. */
  const setSessionStatusLocal = (id: string, status: 'open' | 'archived') => {
    const now = Date.now();
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status, updated_at: now } : s));
  };

  /** Hide a session (status=archived) and stop its provider. */
  const closeSession = (id: string) => {
    const c = clientRef.current;
    if (!c) return;
    c.unsubscribe(id);
    c.stopSession(id).catch(() => {});
    setSessionStatusLocal(id, 'archived');
    c.archiveSession(id).catch(() => {});
    setActiveId((prev) => {
      if (prev !== id) return prev;
      const open = sessions.filter((s) => s.id !== id && s.status === 'open');
      return open[0]?.id || null;
    });
  };

  /** Alias kept for parity with the desktop UI — closed and archived
   *  collapsed into the same hidden state. */
  const archiveSession = (id: string) => {
    setSessionStatusLocal(id, 'archived');
    clientRef.current?.archiveSession(id).catch(() => {});
  };

  /** Bring an archived session back into the tab bar and focus it. The
   *  server boots its provider lazily when the active-tab effect fires. */
  const reopenSession = (id: string) => {
    const c = clientRef.current;
    if (!c) return;
    setSessionStatusLocal(id, 'open');
    c.unarchiveSession(id).catch(() => {});
    setActiveId(id);
  };

  /** `/clear` — archive the active chat under "Cleared: <name>" and replace
   *  this tab with a fresh session in the same tabOrder slot and group.
   *  Mirrors `clearSession` in ChatApp.tsx. */
  const clearActiveSession = async () => {
    const c = clientRef.current;
    if (!c || !activeId) return;
    const old = sessions.find((s) => s.id === activeId);
    if (!old) return;

    const cwd = old.cwd || '/';
    const originalName = old.name;
    const inheritedModel = old.model ?? null;
    const inheritedPermissionMode = old.permission_mode || 'default';
    const inheritedProvider = old.provider || 'claudeAgent';
    const groupId = tabGroupMap[activeId];
    const oldId = activeId;

    let fresh;
    try {
      fresh = await c.createSession(cwd, {
        name: originalName,
        model: inheritedModel,
        permissionMode: inheritedPermissionMode,
        provider: inheritedProvider,
      });
    } catch (err) {
      console.error('[MobileApp] /clear createSession failed:', err);
      return;
    }

    c.updateSession(oldId, { name: `Cleared: ${originalName}` }).catch(() => {});
    c.stopSession(oldId).catch(() => {});
    c.unsubscribe(oldId);

    setRuntime((prev) => { const next = { ...prev }; delete next[oldId]; return next; });

    setSessionStatusLocal(oldId, 'archived');
    c.archiveSession(oldId).catch(() => {});

    setTabOrder((prev) => {
      const next = [...prev];
      const idx = next.indexOf(oldId);
      if (idx === -1) next.push(fresh.id);
      else next[idx] = fresh.id;
      c.updatePreferences({ tabOrder: next }).catch(() => {});
      return next;
    });

    if (groupId) {
      setTabGroupMap((prev) => {
        const next = { ...prev };
        delete next[oldId];
        next[fresh.id] = groupId;
        c.updatePreferences({ tabGroupMap: next }).catch(() => {});
        return next;
      });
    }

    setActiveId(fresh.id);
  };

  /** Tap-to-cycle permission mode — keeps MobileApp's local sessions list in
   *  sync with the server-side change so the badge re-renders immediately. */
  const applyPermissionMode = (sessionId: string, mode: string) => {
    const c = clientRef.current;
    if (!c) return;
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, permission_mode: mode } : s)));
    c.setPermissionMode(sessionId, mode);
    c.updateSession(sessionId, { permissionMode: mode }).catch(() => {});
  };

  // Bypass-mode warning gate — shared between the chat cycle button and the
  // settings sheet. First flip to bypass pops a confirm modal; the user can
  // tick "don't show again" to suppress future prompts.
  const [pendingBypassSessionId, setPendingBypassSessionId] = useState<string | null>(null);

  const requestPermissionMode = (sessionId: string, mode: string) => {
    if (mode === 'bypassPermissions' && shouldWarnBypass()) {
      setPendingBypassSessionId(sessionId);
      return;
    }
    applyPermissionMode(sessionId, mode);
  };

  const setPermissionModeForActive = (mode: string) => {
    if (!activeId) return;
    requestPermissionMode(activeId, mode);
  };

  const setModelForSession = (sessionId: string, model: string | null) => {
    const c = clientRef.current;
    if (!c) return;
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, model } : s)));
    c.setModel(sessionId, model || '');
  };

  // Screen wake lock — opt-in toggle on the launchpad keeps the display from
  // dimming while the PWA is in the foreground (useful when watching long
  // turns play out). The lock auto-releases on hide; the hook re-acquires it
  // on visibilitychange.
  const wakeLock = useScreenWakeLock();

  // ---------------------------------------------------------------------
  // Nav state
  // ---------------------------------------------------------------------
  const [tab, setTab] = useState<NavTab>('home');
  // Bottom chrome (nav + composer) auto-hides on downward scroll, comes
  // back on upward scroll or near the top of the chat.
  const [chromeHidden, setChromeHidden] = useState(false);

  // Local interactive shells — keyed by session. The server has no record of
  // these (they're entirely client-side bubbles); the InteractiveTerminalBubble
  // does the WS-side spawn/IO. Same data shape the desktop uses.
  type LocalShell = { id: string; procId: string; cwd: string; command?: string; createdAt: number };
  const [shellsBySession, setShellsBySession] = useState<Record<string, LocalShell[]>>({});
  const createShell = (procId: string, cwd: string, command?: string) => {
    if (!activeId) return;
    setShellsBySession((prev) => {
      const list = prev[activeId] || [];
      if (list.some((s) => s.procId === procId)) return prev;
      return { ...prev, [activeId]: [...list, { id: procId, procId, cwd, command, createdAt: Date.now() }] };
    });
  };

  // Remove a shell from the local list once its PTY has exited. The server
  // auto-prunes the process registry 30 s after exit, so we only need to drop
  // our UI reference (and fire a best-effort kill to speed up server cleanup).
  const removeShell = (procId: string) => {
    if (!activeId) return;
    try { void clientRef.current?.killProcess(procId); } catch {}
    setShellsBySession((prev) => {
      const list = prev[activeId] || [];
      const next = list.filter((s) => s.procId !== procId);
      if (next.length === list.length) return prev;
      return { ...prev, [activeId]: next };
    });
    // Also drop from the minimized set if it was docked.
    // (toggleShellMinimized lives in MobileChat; the next hydration cycle
    // won't re-add this procId because it no longer exists server-side.)
  };

  // Server-side shell persistence — every time the active session changes we
  // pull the list of live PTYs for it from `/processes` and hydrate the local
  // shell registry. The bridge server keeps PTYs running across PWA reloads
  // and client disconnects (they only die on server restart or explicit
  // kill), so this is what restores the mobile terminals end-to-end when the
  // user closes the app and comes back. Shells created locally during the
  // session merge on top (createShell dedupes by procId).
  const hydratedSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !activeId) return;
    // Re-hydrate on every open — the PTY registry can change behind our back
    // (other clients, /processes endpoint pruning exited PTYs after 30 s).
    let cancelled = false;
    (async () => {
      try {
        const procs = await client.listProcesses(activeId);
        if (cancelled) return;
        const live = procs.filter((p) => p.kind === 'pty' && (p.exitCode == null));
        if (live.length === 0 && hydratedSessionsRef.current.has(activeId)) return;
        hydratedSessionsRef.current.add(activeId);
        setShellsBySession((prev) => {
          const existing = prev[activeId] || [];
          const existingIds = new Set(existing.map((s) => s.procId));
          const additions: LocalShell[] = [];
          for (const p of live) {
            if (existingIds.has(p.id)) continue;
            // The user's `/terminal` shells are tracked on the bridge with
            // command: '(interactive shell)' — that's a placeholder, not
            // something to surface. PTYs spawned by `spawn_terminal` have
            // a real command we want to keep as the badge label.
            const cmd = p.command && p.command !== '(interactive shell)' ? p.command : undefined;
            additions.push({
              id: p.id,
              procId: p.id,
              cwd: p.cwd,
              command: cmd,
              createdAt: p.startedAt || Date.now(),
            });
          }
          if (additions.length === 0) return prev;
          return { ...prev, [activeId]: [...existing, ...additions] };
        });
      } catch {/* best-effort — swallow fetch errors */}
    })();
    return () => { cancelled = true; };
  }, [activeId]);
  // Always show chrome when a sheet is open (otherwise the user can't dismiss it)
  const effectiveChromeHidden = chromeHidden && tab === 'chat';
  // Composer's actual rendered height (px), reported up from MobileChat via
  // ResizeObserver. Used to size the ambient blob container behind it when
  // chrome is hidden. Defaults to the navbar's height.
  const NAV_HEIGHT_PX = 62; // 3.875rem
  const [composerHeightPx, setComposerHeightPx] = useState<number>(NAV_HEIGHT_PX);
  const blobHeightPx = effectiveChromeHidden ? composerHeightPx : NAV_HEIGHT_PX;
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) || null,
    [sessions, activeId],
  );
  const activeRuntime = (activeId && runtime[activeId]) || EMPTY_RUNTIME;
  const activeMockups = (activeId && mockupsBySession[activeId]) || [];
  const openMockupName = (activeId && openMockupBySession[activeId]) || null;
  const openMockup = openMockupName
    ? activeMockups.find((m) => m.name === openMockupName) || null
    : null;

  const setMockupComments = (mockupName: string, next: MockupComment[]) => {
    if (!activeId) return;
    setMockupsBySession((prev) => {
      const list = prev[activeId] || [];
      const idx = list.findIndex((m) => m.name === mockupName);
      if (idx === -1) return prev;
      return {
        ...prev,
        [activeId]: list.map((m, i) => (i === idx ? { ...m, comments: next } : m)),
      };
    });
  };

  const openMockupModal = (mockupName: string) => {
    if (!activeId) return;
    setOpenMockupBySession((prev) => ({ ...prev, [activeId]: mockupName }));
  };

  const closeMockupModal = () => {
    if (!activeId) return;
    setOpenMockupBySession((prev) => ({ ...prev, [activeId]: null }));
  };
  const activeStatus = (activeId && statusBySession[activeId]) ||
    (activeSession?.ready ? 'connected' : connection);
  const activeModelOptions = useMemo(() => {
    if (!activeSession) return [];
    const providerModels = activeSession.provider === 'opencode'
      ? (opencodeInfo?.models ?? []).map((m) => ({ id: m.id, label: `${m.providerName} ${m.label}` }))
      : (supportedModelsBySession[activeSession.id]?.length ? supportedModelsBySession[activeSession.id]! : claudeModels);
    if (activeSession.model && !providerModels.some((m) => m.id === activeSession.model)) {
      return [{ id: activeSession.model, label: activeSession.model }, ...providerModels];
    }
    return providerModels;
  }, [activeSession, opencodeInfo?.models, supportedModelsBySession, claudeModels]);

  // Derive per-session flags for the sessions sheet
  const streamingBySession = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const [id, r] of Object.entries(runtime)) out[id] = r.isStreaming;
    return out;
  }, [runtime]);
  const interruptedBySession = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const [id, r] of Object.entries(runtime)) out[id] = r.wasInterrupted;
    return out;
  }, [runtime]);
  const permissionBySession = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const [id, r] of Object.entries(runtime)) out[id] = !!r.permRequest;
    return out;
  }, [runtime]);
  // Per-session "last activity at" timestamp — used to order sessions by
  // recency in the home list (mirrors desktop's TabBar). Tool use / tool
  // results DO count: a session mid-agentic-run (streaming Read/Bash/Edit) is
  // genuinely the most recently active, and skipping its tool chatter used to
  // freeze its "last time" until a final text reply landed. Only system notes
  // (terminal/mockup bookkeeping) are skipped — those aren't the agent talking.
  const sessionLastMessageAt = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) {
      const r = runtime[s.id];
      const msgs = r?.messages || [];
      let last = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'system') continue;
        const t = m.timestamp;
        if (typeof t === 'number' && t > last) { last = t; break; }
      }
      out[s.id] = last || (s.created_at ?? 0);
    }
    return out;
  }, [sessions, runtime]);

  // ---------------------------------------------------------------------
  // Empty state when no token
  // ---------------------------------------------------------------------
  if (bootstrapping) {
    return <FullscreenMessage>Loading…</FullscreenMessage>;
  }

  if (!token) {
    return (
      <FullscreenMessage>
        <div className="text-center max-w-sm">
          <h1 className="text-xl font-semibold text-zinc-100 mb-2">Pair this device</h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Open the desktop Claude Code app, choose <span className="text-zinc-200 font-medium">Pair Phone</span> from settings,
            and scan the QR code with your camera.
          </p>
        </div>
      </FullscreenMessage>
    );
  }

  const indicatorStatus: ConnectionStatus | 'loading' =
    connection !== 'connected'
      ? connection
      : (activeId && !runtime[activeId]?.hydrated ? 'loading' : 'connected');

  const client = clientRef.current;
  if (!client) {
    return <FullscreenMessage>Connecting…</FullscreenMessage>;
  }

  const selectSessionAndOpenChat = (id: string) => {
    setActiveId(id);
    setTab('chat');
  };

  const reopenSessionAndOpenChat = (id: string) => {
    reopenSession(id);
    setTab('chat');
  };

  const selectNavTab = (next: NavTab) => {
    if (next === 'chat' && !activeId) {
      setTab('home');
      return;
    }
    setTab(next);
  };

  return (
    <div className="relative min-h-[100dvh] bg-zinc-950">
      <BottomLoader status={indicatorStatus} />
      {tab === 'home' || !activeSession ? (
        <MobileHome
          client={client}
          sessions={sessions}
          activeId={activeId}
          onQuickStart={(provider) => {
            try { localStorage.setItem('claude-ui-last-provider', provider); } catch {}
          }}
          opencodeAvailable={opencodeInfo?.available ?? false}
          opencodeModels={opencodeInfo?.models ?? []}
          claudeModels={claudeModels}
          onSelectSession={selectSessionAndOpenChat}
          onCloseSession={closeSession}
          onReopenSession={reopenSessionAndOpenChat}
          onArchiveSession={archiveSession}
          statuses={statusBySession}
          streaming={streamingBySession}
          interrupted={interruptedBySession}
          hasPermission={permissionBySession}
          turnComplete={turnCompleteSet}
          tabGroups={tabGroups}
          tabGroupMap={tabGroupMap}
          tabOrder={tabOrder}
          pinnedSessionIds={pinnedSessionIds}
          sessionLastMessageAt={sessionLastMessageAt}
          keepScreenOn={wakeLock.enabled}
          keepScreenOnSupported={wakeLock.supported}
          onToggleKeepScreenOn={wakeLock.setEnabled}
        />
      ) : (
        <MobileChat
          client={client}
          session={activeSession}
          messages={activeRuntime.messages}
          partialText={activeRuntime.partialText}
          partialThinking={activeRuntime.partialThinking}
          isStreaming={activeRuntime.isStreaming}
          permRequest={activeRuntime.permRequest}
          status={activeStatus}
          hydrated={activeRuntime.hydrated}
          onOpenSessions={() => setTab('home')}
          onLocalClearPerm={(reqId) => {
            if (!activeId) return;
            setRuntime((prev) => {
              const cur = prev[activeId];
              if (!cur || cur.permRequest?.requestId !== reqId) return prev;
              return { ...prev, [activeId]: { ...cur, permRequest: null } };
            });
          }}
          chromeHidden={effectiveChromeHidden}
          onChromeHiddenChange={setChromeHidden}
          onComposerHeightChange={setComposerHeightPx}
          onCreateShell={createShell}
          onRemoveShell={removeShell}
          shells={(activeId && shellsBySession[activeId]) || undefined}
          onOpenNewSession={() => setTab('home')}
          onClearSession={clearActiveSession}
          onPermissionModeChange={setPermissionModeForActive}
          modelOptions={activeModelOptions}
          onModelChange={(model) => activeId && setModelForSession(activeId, model)}
          mockups={activeMockups}
          openMockup={openMockup}
          onOpenMockup={openMockupModal}
          onCloseMockup={closeMockupModal}
          onSetMockupComments={setMockupComments}
        />
      )}

      {/* Ambient color spot doubles as the "Claude is working" indicator:
          it fades in while the active session is streaming and fades out on
          turn complete. Sits behind whichever glass pill is overhead and
          resizes to match it. */}
      <BottomBlobs heightPx={blobHeightPx} visible={activeRuntime.isStreaming} />

      <GlassNav
        active={tab}
        onSelect={selectNavTab}
        hasPending={!!activeRuntime.permRequest}
        hidden={effectiveChromeHidden}
      />

      <PwaInstallBanner />

      {clientRef.current && (
        <MobileFilesSheet
          open={tab === 'files'}
          onClose={() => setTab('chat')}
          client={clientRef.current}
          initialCwd={activeSession?.cwd || '/'}
        />
      )}

      {clientRef.current && (
        <MobileGitSheet
          open={tab === 'git'}
          onClose={() => setTab('chat')}
          client={clientRef.current}
          cwd={activeSession?.cwd || '/'}
        />
      )}

      <MobileSettingsSheet
        open={tab === 'settings'}
        onClose={() => setTab('chat')}
      />

      <BypassWarningModal
        open={pendingBypassSessionId !== null}
        onCancel={() => setPendingBypassSessionId(null)}
        onConfirm={() => {
          if (pendingBypassSessionId) applyPermissionMode(pendingBypassSessionId, 'bypassPermissions');
          setPendingBypassSessionId(null);
        }}
      />
    </div>
  );
}

function FullscreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-zinc-950 text-zinc-200">
      {children}
    </div>
  );
}

function BottomLoader({ status }: { status: ConnectionStatus | 'loading' }) {
  const visible = status !== 'connected';
  const sliderClass =
    status === 'connecting' ? 'bg-gradient-to-r from-amber-400/0 via-amber-400 to-amber-400/0' :
    status === 'loading' ? 'bg-gradient-to-r from-indigo-400/0 via-indigo-400 to-indigo-400/0' :
    'bg-gradient-to-r from-red-400/0 via-red-400 to-red-400/0';
  const label =
    status === 'connecting' ? 'Connecting…' :
    status === 'loading' ? 'Loading session…' :
    status === 'error' ? 'Connection error' :
    'Disconnected';
  return (
    <div
      aria-hidden={!visible}
      role="status"
      aria-label={label}
      className="fixed left-3 right-3 z-30 h-[3px] overflow-hidden rounded-full bg-zinc-800/40 transition-opacity duration-200"
      style={{
        // Sit flush above the GlassNav (~60 px pill at bottom-3 + safe area)
        // with a 4 px breathing gap. Above-nav placement keeps the bar visible
        // on iOS PWA — at `env(safe-area-inset-bottom)` it lands in the home-
        // indicator zone where the system overlay hides it.
        bottom: 'calc(0.75rem + env(safe-area-inset-bottom) + 60px + 4px)',
        opacity: visible ? 1 : 0,
        pointerEvents: 'none',
      }}
    >
      <div className={`connection-bar-slider absolute top-0 bottom-0 w-1/3 rounded-full ${sliderClass}`} />
    </div>
  );
}
