import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Select, SelectTrigger, SelectValue, SelectPopover, ListBox, ListBoxItem } from '@heroui/react';
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react';
import { DiffReview, type ReviewComment } from './DiffReview';
import { Providers } from './Providers';
import { TabBar } from './TabBar';
import { FileExplorer } from './FileExplorer';
import { MessageBubble, AnsiText } from './MessageBubble';
import { NewSessionModal } from './NewSessionModal';
import { useSlashCommands, SlashCommandList } from './SlashCommandPicker';
import { useFileMention, FileMentionList } from './FileMentionPicker';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { useFileIndex } from '../lib/fuzzy-file-search';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  ClaudeClient,
  type ChatMessage,
  type ConnectionStatus,
  type PermissionRequest,
  type SessionInfo,
  type SessionInitInfo,
} from '../lib/claude-client';

async function resolveServerUrl(): Promise<string> {
  // Check if running inside Tauri
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const port = await invoke<number>('start_bridge_server');
      return `http://localhost:${port}`;
    } catch (e) {
      console.error('Failed to start bridge server:', e);
    }
  }
  return (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3100';
}
let _serverUrl = '';
function uiLog(msg: string) {
  console.log('[UI]', msg);
  if (_serverUrl) fetch(`${_serverUrl}/ui-log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg }) }).catch(() => {});
}

import { loadMessages, saveMessages, deleteMessages } from '../lib/storage';

type SessionState = {
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  initInfo: SessionInitInfo | null;
  permRequest: PermissionRequest | null;
  // Panel state (per-session)
  openFile: { path: string; content: string } | null;
  openTerminalId: string | null;
  diffView: { path: string; original: string; modified: string } | null;
  editorFullWidth: boolean;
  editorDirty: boolean;
  reviewComments: Record<string, ReviewComment[]>;
  reviewMode: boolean;
  reviewFiles: string[];
  reviewIndex: number;
  todos: { content: string; status: string; activeForm?: string }[];
  input: string;
  inputHistory: string[];
  contextTokens: number; // latest input_tokens from result message
};

type AskQuestion = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

function AskUserQuestionForm({ questions, onSubmit }: { questions: AskQuestion[]; onSubmit: (answers: Record<string, string>) => void }) {
  const [selections, setSelections] = useState<Record<string, string>>({});

  const handleSelect = (qIdx: number, label: string) => {
    const key = String(qIdx);
    setSelections(prev => ({ ...prev, [key]: label }));
    // Auto-submit if single question
    if (questions.length === 1) {
      onSubmit({ [key]: label });
    }
  };

  const allAnswered = questions.every((_, i) => selections[String(i)]);

  return (
    <div className="space-y-3 mb-2">
      {questions.map((q, i) => {
        const key = String(i);
        const selected = selections[key];
        return (
          <div key={i}>
            {q.header && (
              <span className="inline-block text-[10px] font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded mb-1">
                {q.header}
              </span>
            )}
            <p className="text-[12px] text-zinc-300 leading-relaxed mb-1.5">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="space-y-1">
                {q.options.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => handleSelect(i, opt.label)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                      selected === opt.label
                        ? 'border-violet-400/50 bg-violet-500/10 ring-1 ring-violet-400/20'
                        : 'border-border hover:border-zinc-600 hover:bg-surface-light/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                        selected === opt.label ? 'border-violet-400' : 'border-zinc-600'
                      }`}>
                        {selected === opt.label && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                      </span>
                      <div>
                        <span className="text-[12px] font-medium text-zinc-200">{opt.label}</span>
                        {opt.description && <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{opt.description}</p>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {questions.length > 1 && (
        <button
          disabled={!allAnswered}
          onClick={() => onSubmit(selections)}
          className="px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors disabled:opacity-40"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

function SearchPanel({ client, rootPath, onFileOpen, onClose }: { client: ClaudeClient | null; rootPath: string | null; onFileOpen: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doSearch = (q: string) => {
    if (!client || !rootPath || !q.trim()) { setResults([]); return; }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      client.searchFiles(rootPath, q.trim()).then(r => { setResults(r); setSearching(false); }).catch(() => { setResults([]); setSearching(false); });
    }, 300);
  };

  return (
    <aside className="w-60 border-r border-border bg-[#161616] flex flex-col shrink-0">
      <div className="px-3 py-2 flex items-center justify-between border-b border-border shrink-0">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Search</span>
        <button className="text-zinc-600 hover:text-zinc-300 text-sm" onClick={onClose}>&#x2715;</button>
      </div>
      <div className="px-2 py-2 border-b border-border shrink-0">
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          placeholder="Search in files..."
          className="w-full bg-surface border border-border rounded px-2 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {searching && <p className="text-[11px] text-zinc-600 text-center py-4">Searching...</p>}
        {!searching && query && results.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-4">No results</p>}
        {results.map((r, i) => {
          const relFile = rootPath && r.file.startsWith('./') ? r.file.slice(2) : r.file;
          return (
            <div
              key={i}
              className="px-2 py-1 hover:bg-surface-light/50 cursor-pointer transition-colors border-b border-border/30"
              onClick={() => onFileOpen(rootPath ? `${rootPath}/${relFile}` : relFile)}
            >
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-zinc-400 truncate">{relFile}</span>
                <span className="text-[10px] text-zinc-600 shrink-0">:{r.line}</span>
              </div>
              <p className="text-[10px] text-zinc-500 font-mono truncate leading-snug">{r.text}</p>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export function ChatApp() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [closedSessionIds, setClosedSessionIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('claude-ui-closed-tabs') || '[]')); }
    catch { return new Set(); }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabOrder, setTabOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('claude-ui-tab-order') || '[]'); }
    catch { return []; }
  });
  // Tab groups
  const [tabGroups, setTabGroups] = useState<Record<string, { id: string; name: string; color: string }>>(() => {
    try { return JSON.parse(localStorage.getItem('claude-ui-tab-groups') || '{}').groups || {}; }
    catch { return {}; }
  });
  const [tabGroupMap, setTabGroupMap] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('claude-ui-tab-groups') || '{}').map || {}; }
    catch { return {}; }
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  const persistGroups = (groups: typeof tabGroups, map: typeof tabGroupMap) => {
    try { localStorage.setItem('claude-ui-tab-groups', JSON.stringify({ groups, map })); } catch {}
  };

  const GROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];
  let groupColorIdx = Object.keys(tabGroups).length;

  const handleCreateGroup = (tabIds: string[]) => {
    const groupId = crypto.randomUUID();
    const color = GROUP_COLORS[groupColorIdx++ % GROUP_COLORS.length]!;
    const newGroups = { ...tabGroups, [groupId]: { id: groupId, name: `Group ${Object.keys(tabGroups).length + 1}`, color } };
    const newMap = { ...tabGroupMap };
    for (const id of tabIds) newMap[id] = groupId;
    setTabGroups(newGroups);
    setTabGroupMap(newMap);
    setExpandedGroupId(groupId);
    persistGroups(newGroups, newMap);
  };

  const handleGroupTabs = (tabIdA: string, tabIdB: string) => {
    handleCreateGroup([tabIdA, tabIdB]);
  };

  const handleAddToGroup = (tabId: string, groupId: string) => {
    const newMap = { ...tabGroupMap, [tabId]: groupId };
    setTabGroupMap(newMap);
    setExpandedGroupId(groupId);
    persistGroups(tabGroups, newMap);
  };

  const handleUngroupTab = (tabId: string) => {
    const newMap = { ...tabGroupMap };
    const groupId = newMap[tabId];
    delete newMap[tabId];
    // Delete group if empty
    const newGroups = { ...tabGroups };
    if (groupId && !Object.values(newMap).includes(groupId)) {
      delete newGroups[groupId];
      if (expandedGroupId === groupId) setExpandedGroupId(null);
    }
    setTabGroupMap(newMap);
    setTabGroups(newGroups);
    persistGroups(newGroups, newMap);
  };

  const lastActivePerGroup = useRef<Record<string, string>>({});

  // Track last active session per group
  useEffect(() => {
    if (activeId && tabGroupMap[activeId]) {
      lastActivePerGroup.current[tabGroupMap[activeId]] = activeId;
    }
  }, [activeId, tabGroupMap]);

  const handleToggleGroup = (groupId: string) => {
    setExpandedGroupId(prev => {
      if (prev === groupId) return null; // collapse
      // Expand — select last focused session in this group
      const lastId = lastActivePerGroup.current[groupId];
      const members = sessions.filter(s => tabGroupMap[s.id] === groupId);
      const target = lastId && members.some(m => m.id === lastId) ? lastId : members[0]?.id;
      if (target) setActiveId(target);
      return groupId;
    });
  };

  const handleRenameGroup = (groupId: string, name: string) => {
    const newGroups = { ...tabGroups, [groupId]: { ...tabGroups[groupId]!, name } };
    setTabGroups(newGroups);
    persistGroups(newGroups, tabGroupMap);
  };

  const handleChangeGroupColor = (groupId: string, color: string) => {
    const newGroups = { ...tabGroups, [groupId]: { ...tabGroups[groupId]!, color } };
    setTabGroups(newGroups);
    persistGroups(newGroups, tabGroupMap);
  };

  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const historyIdxRef = useRef(-1);
  const historyDraftRef = useRef('');
  const [pastedImages, setPastedImages] = useState<{ media_type: string; data: string; preview: string }[]>([]);
  const [showNewSession, setShowNewSession] = useState(false);
  const [turnCompleteIds, setTurnCompleteIds] = useState<Set<string>>(new Set());
  const [showPalette, setShowPalette] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [sidebarView, setSidebarView] = useState<'explorer' | 'search'>('explorer');
  // Panel state helpers (per-session via SessionState)
  const setInput = (val: string | ((prev: string) => string)) => {
    if (!activeId) return;
    updateState(activeId, s => ({ ...s, input: typeof val === 'function' ? val(s.input) : val }));
  };

  const setOpenFile = (file: { path: string; content: string } | null) => {
    if (!activeId) return;
    updateState(activeId, s => ({
      ...s,
      openFile: file,
      openTerminalId: file ? null : s.openTerminalId,
      diffView: file ? null : s.diffView,
      editorFullWidth: file ? s.editorFullWidth : false,
      editorDirty: false,
    }));
  };
  const [gitModified, setGitModified] = useState<{ staged: Set<string>; unstaged: Set<string> }>({ staged: new Set(), unstaged: new Set() });
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const clientRef = useRef<ClaudeClient | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const emptyState = (): SessionState => ({
    messages: [], partialText: '', isStreaming: false, initInfo: null, permRequest: null,
    openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false,
    reviewComments: {}, reviewMode: false, reviewFiles: [], reviewIndex: 0, todos: [],
    input: '', inputHistory: [], contextTokens: 0,
  });

  const loadingRef = useRef(new Set<string>());

  const getState = (id: string | null): SessionState => {
    if (!id) return emptyState();
    if (sessionStates[id]) return sessionStates[id];
    // Trigger async load if not already loading
    if (!loadingRef.current.has(id)) {
      loadingRef.current.add(id);
      loadMessages(id).then(msgs => {
        if (msgs.length > 0) {
          setSessionStates(prev => {
            if (prev[id]) return prev; // already loaded by another path
            return { ...prev, [id]: { ...emptyState(), messages: msgs as ChatMessage[] } };
          });
        }
      });
    }
    return emptyState();
  };

  const updateState = useCallback((id: string, fn: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => {
      const current = prev[id] || emptyState();
      const next = fn(current);
      // Persist messages to localStorage
      if (next.messages !== current.messages) {
        saveMessages(id, next.messages);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  // Initialize client
  // Request notification permission on mount
  useEffect(() => {
    isPermissionGranted().then(granted => {
      if (!granted) requestPermission().catch(() => {});
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveServerUrl().then(serverUrl => {
      if (cancelled) return;
    _serverUrl = serverUrl;
    uiLog(`Server URL resolved: ${serverUrl}`);
    const client = new ClaudeClient(serverUrl, {
      onMessage: (sid, msg) => {
        // Intercept TodoWrite — update task panel, don't add to chat
        if (msg.toolName === 'TodoWrite') {
          const input = msg.toolInput as { todos?: { content: string; status: string; activeForm?: string }[] } | null;
          if (input?.todos) updateState(sid, s => ({ ...s, todos: input.todos! }));
          return;
        }
        updateState(sid, s => ({
          ...s,
          messages: [...s.messages, msg],
          partialText: '',
          contextTokens: msg.usage ? msg.usage.input_tokens + msg.usage.output_tokens : s.contextTokens,
        }));
      },
      onPartialText: (sid, text) => {
        updateState(sid, s => ({ ...s, partialText: text }));
      },
      onPermissionRequest: (sid, req) => {
        updateState(sid, s => ({ ...s, permRequest: req }));
        // Notify when window is not focused
        if (!document.hasFocus()) {
          const body = req.toolName + (req.input?.file_path ? `: ${String(req.input.file_path).split('/').pop()}` : req.input?.command ? `: ${String(req.input.command).slice(0, 60)}` : '');
          isPermissionGranted().then(granted => {
            if (granted) sendNotification({ title: 'Claude needs approval', body });
          }).catch(() => {});
        }
      },
      onPermissionCancelled: (sid, requestId) => {
        updateState(sid, s =>
          s.permRequest?.requestId === requestId ? { ...s, permRequest: null } : s
        );
      },
      onStatusChange: (sid, status) => {
        setStatuses(prev => ({ ...prev, [sid]: status }));
      },
      onSessionInit: (sid, info) => {
        updateState(sid, s => ({ ...s, initInfo: info }));
        setSessions(prev => prev.map(s => s.id === sid ? {
          ...s,
          model: info.model || s.model,
          // Don't override server-persisted permission_mode with CLI default
        } : s));
      },
      onSessionStatusUpdate: (sid, updates) => {
        setSessions(prev => prev.map(s => {
          if (s.id !== sid) return s;
          const patched = { ...s };
          if (updates.permissionMode !== undefined) patched.permission_mode = updates.permissionMode;
          return patched;
        }));
      },
      onAutoApproved: (sid, toolName, filePath, command) => {
        const label = filePath ? `${toolName}: ${filePath.split('/').pop()}` : command ? `${toolName}: ${command.slice(0, 40)}` : toolName;
        updateState(sid, s => ({
          ...s,
          messages: [...s.messages, {
            id: crypto.randomUUID(),
            role: 'system' as const,
            content: `Auto-approved ${label}`,
            timestamp: Date.now(),
            toolName,
          }],
        }));
      },
      onTurnComplete: (sid) => {
        updateState(sid, s => ({ ...s, isStreaming: false, partialText: '' }));
        setTurnCompleteIds(prev => new Set(prev).add(sid));
        setTimeout(() => setTurnCompleteIds(prev => { const next = new Set(prev); next.delete(sid); return next; }), 3000);
      },
      onSessionNameUpdate: (sid, name) => {
        setSessions(prev => prev.map(s => s.id === sid && s.name.startsWith('Session ') ? { ...s, name } : s));
      },
    });
    clientRef.current = client;
    setClient(client);

    // Load existing sessions
    client.listSessions().then(list => {
      setSessions(list);
      // Read closed tabs from localStorage
      let closed: Set<string>;
      try { closed = new Set(JSON.parse(localStorage.getItem('claude-ui-closed-tabs') || '[]')); }
      catch { closed = new Set(); }

      // Connect to all open sessions (resume stopped ones)
      const initialStatuses: Record<string, ConnectionStatus> = {};
      for (const s of list) {
        if (closed.has(s.id)) continue;
        initialStatuses[s.id] = 'connecting';
        if (s.status === 'stopped') {
          client.resumeSession(s.id).then(updated => {
            setSessions(prev => prev.map(p => p.id === s.id ? updated : p));
            client.connectSession(updated);
          }).catch(() => {});
        } else {
          client.connectSession(s);
        }
      }
      setStatuses(initialStatuses);
      // Select first open running session
      const openList = list.filter(s => !closed.has(s.id));
      const running = openList.find(s => s.status !== 'stopped');
      if (running) {
        setActiveId(running.id);
      } else if (openList.length > 0) {
        setActiveId(openList[0]!.id);
      }
    }).catch(() => {});
    }); // end resolveServerUrl().then()

    return () => { cancelled = true; clientRef.current?.destroy(); };
  }, [updateState]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const active = getState(activeId);
  const { openFile, diffView, editorFullWidth, editorDirty, reviewComments, reviewMode, reviewFiles, reviewIndex, todos, input } = active;
  const lastMsgContent = active.messages[active.messages.length - 1]?.content;
  const openTerminal = active.openTerminalId ? active.messages.find(m => m.id === active.openTerminalId && m.isTerminal) || null : null;
  const hasRightPanel = !!openFile || !!openTerminal || !!diffView;
  useEffect(() => {
    scrollToBottom();
  }, [active.messages, active.partialText, lastMsgContent, scrollToBottom]);

  // Scroll when permission request appears (with delay for Monaco to mount)
  useEffect(() => {
    if (active.permRequest) {
      scrollToBottom();
      const t = setTimeout(scrollToBottom, 300);
      return () => clearTimeout(t);
    }
  }, [active.permRequest, scrollToBottom]);

  // Re-fetch open file and git status when new messages arrive
  const msgLenRef = useRef(0);
  useEffect(() => {
    const len = active.messages.length;
    if (len === msgLenRef.current) return;
    msgLenRef.current = len;
    if (!client) return;
    // Debounce: wait a bit for rapid message bursts
    const t = setTimeout(() => {
      if (active.openFile && activeId) {
        const sid = activeId;
        const curFile = active.openFile;
        client.readFile(curFile.path).then(file => {
          if (file && file.content !== curFile.content) {
            updateState(sid, s => ({ ...s, openFile: file }));
          }
        }).catch(() => {});
      }
      refreshGitModified();
    }, 1000);
    return () => clearTimeout(t);
  }, [active.messages.length]);

  const handleNewSession = () => {
    setShowNewSession(true);
  };

  const handleCreateSession = async (cwd: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const session = await client.createSession(cwd);
      setSessions(prev => [session, ...prev]);
      setActiveId(session.id);
      client.connectSession(session);
    } catch {}
  };

  const handleSelectSession = async (id: string) => {
    setActiveId(id);
    historyIdxRef.current = -1;
    historyDraftRef.current = '';
    const session = sessions.find(s => s.id === id);
    const status = statuses[id];
    console.log(`[select] id=${id.slice(0,8)} session.status=${session?.status} connStatus=${status}`);
    if (!session || !clientRef.current) return;

    if (session.status === 'stopped' && (!status || status === 'disconnected')) {
      console.log(`[select] Auto-resuming stopped session ${id.slice(0,8)}`);
      try {
        const updated = await clientRef.current.resumeSession(id);
        console.log(`[select] Resume response:`, updated);
        setSessions(prev => prev.map(s => s.id === id ? updated : s));
        clientRef.current.connectSession(updated);
      } catch (e) {
        console.error(`[select] Resume failed:`, e);
      }
    } else if (!status || status === 'disconnected') {
      console.log(`[select] Connecting browser WS for ${id.slice(0,8)}`);
      clientRef.current.connectSession(session);
    }
  };

  const updateClosedIds = (fn: (prev: Set<string>) => Set<string>) => {
    setClosedSessionIds(prev => {
      const next = fn(prev);
      try { localStorage.setItem('claude-ui-closed-tabs', JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [unsavedClosePrompt, setUnsavedClosePrompt] = useState(false);

  const handleCloseTab = (id: string) => {
    setClosingSessionId(id);
  };

  const confirmCloseTab = async () => {
    const id = closingSessionId;
    if (!id) return;
    setClosingSessionId(null);

    // Save running terminal commands
    const state = getState(id);
    const runningCmds = state.messages
      .filter(m => m.isTerminal && m.exitCode === undefined && m.terminalCommand)
      .map(m => m.terminalCommand!);
    if (clientRef.current && runningCmds.length > 0) {
      await clientRef.current.saveCommands(id, runningCmds);
    }

    clientRef.current?.disconnectSession(id);
    updateClosedIds(prev => new Set(prev).add(id));
    if (activeId === id) {
      const openSessions = sessions.filter(s => s.id !== id && !closedSessionIds.has(s.id));
      setActiveId(openSessions.length > 0 ? openSessions[0]!.id : null);
    }
  };

  const [restoreSessionId, setRestoreSessionId] = useState<string | null>(null);
  const [restoreCommands, setRestoreCommands] = useState<string[]>([]);

  const handleReopenSession = (id: string) => {
    updateClosedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveId(id);
    // Reconnect
    const session = sessions.find(s => s.id === id);
    if (session && clientRef.current) {
      clientRef.current.connectSession(session);
      // Check for saved commands
      if (session.saved_commands && session.saved_commands.length > 0) {
        setRestoreSessionId(id);
        setRestoreCommands(session.saved_commands);
      }
    }
  };

  const confirmRestore = () => {
    const id = restoreSessionId;
    const cmds = restoreCommands;
    setRestoreSessionId(null);
    setRestoreCommands([]);
    if (!id || !clientRef.current) return;
    const session = sessions.find(s => s.id === id);
    const cwd = getState(id).initInfo?.cwd || session?.cwd || '/';
    // Re-run each command
    for (const command of cmds) {
      const msgId = crypto.randomUUID();
      updateState(id, s => ({
        ...s,
        messages: [...s.messages, {
          id: msgId,
          role: 'system' as const,
          content: '',
          isTerminal: true,
          terminalCommand: command,
          timestamp: Date.now(),
        }],
      }));
      clientRef.current!.execCommand(command, cwd, {
        onData: (chunk) => {
          const hasScreenClear = chunk.includes('\x1b[2J') || chunk.includes('\x1b[3J');
          updateState(id, s => ({
            ...s,
            messages: s.messages.map(m => m.id === msgId ? { ...m, content: hasScreenClear ? chunk : m.content + chunk } : m),
          }));
        },
        onDone: (exitCode) => {
          updateState(id, s => ({
            ...s,
            messages: s.messages.map(m => m.id === msgId ? { ...m, exitCode } : m),
          }));
        },
      }, id);
    }
    // Clear saved commands on server
    clientRef.current.saveCommands(id, []);
  };

  const dismissRestore = () => {
    const id = restoreSessionId;
    setRestoreSessionId(null);
    setRestoreCommands([]);
    if (id && clientRef.current) {
      clientRef.current.saveCommands(id, []);
    }
  };

  const handleResumeSession = async (id: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const updated = await client.resumeSession(id);
      setSessions(prev => prev.map(s => s.id === id ? updated : s));
      client.connectSession(updated);
      setActiveId(id);
    } catch {}
  };

  const handleRenameSession = async (id: string, name: string) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const updated = await client.renameSession(id, name);
      setSessions(prev => prev.map(s => s.id === id ? updated : s));
    } catch {}
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text && pastedImages.length === 0) return;
    if (!activeId || !clientRef.current) return;

    // Push to per-session input history
    if (text) {
      updateState(activeId, s => {
        const hist = [...s.inputHistory, text];
        if (hist.length > 100) hist.shift();
        return { ...s, inputHistory: hist };
      });
      historyIdxRef.current = -1;
      historyDraftRef.current = '';
    }

    // Terminal command: > command
    if (text.startsWith('>')) {
      const command = text.slice(1).trim();
      if (!command) return;
      const msgId = crypto.randomUUID();
      const cwd = active.initInfo?.cwd || activeSession?.cwd || '/';

      updateState(activeId, s => ({
        ...s,
        messages: [...s.messages, {
          id: msgId,
          role: 'system' as const,
          content: '',
          isTerminal: true,
          terminalCommand: command,
          timestamp: Date.now(),
        }],
      }));
      setInput('');

      const sid = activeId;
      clientRef.current.execCommand(command, cwd, {
        onData: (chunk) => {
          updateState(sid, s => ({
            ...s,
            messages: s.messages.map(m =>
              m.id === msgId ? { ...m, content: m.content + chunk } : m
            ),
          }));
        },
        onDone: (exitCode) => {
          updateState(sid, s => ({
            ...s,
            messages: s.messages.map(m =>
              m.id === msgId ? { ...m, exitCode } : m
            ),
          }));
          refreshGitModified();
        },
      }, sid);
      return;
    }

    const images = pastedImages.length > 0 ? pastedImages.map(({ media_type, data }) => ({ media_type, data })) : undefined;

    updateState(activeId, s => ({
      ...s,
      messages: [...s.messages, {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: text,
        images,
        timestamp: Date.now(),
      }],
      isStreaming: true,
      partialText: '',
    }));
    setInput('');
    setPastedImages([]);
    clientRef.current.sendMessage(activeId, text || ' ', images);
  };

  const handlePermission = (requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.respondToPermission(activeId, requestId, allow, updatedInput);
    updateState(activeId, s => ({ ...s, permRequest: null }));
  };

  const handleInterrupt = () => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.interrupt(activeId);
    updateState(activeId, s => ({ ...s, isStreaming: false }));
  };

  const handleFileOpen = async (path: string) => {
    if (!client) return;
    const file = await client.readFile(path);
    if (file) setOpenFile(file);
  };

  const handleFileDiff = async (path: string) => {
    if (!client || !activeId) return;
    const sid = activeId;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path),
    ]);
    if (file) {
      updateState(sid, s => ({ ...s, openFile: null, openTerminalId: null, diffView: { path, original, modified: file.content } }));
    }
  };

  const handleStartReview = () => {
    if (!activeId) return;
    const files = [...new Set([...gitModified.staged, ...gitModified.unstaged])].sort();
    if (files.length === 0) return;
    updateState(activeId, s => ({ ...s, reviewMode: true, reviewFiles: files, reviewIndex: 0, editorFullWidth: true, openFile: null, openTerminalId: null }));
    loadReviewFile(files[0]!);
  };

  const loadReviewFile = async (path: string) => {
    if (!client || !activeId) return;
    const sid = activeId;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path),
    ]);
    if (file) {
      updateState(sid, s => ({ ...s, diffView: { path, original, modified: file.content } }));
    }
  };

  const handleReviewNav = (delta: number) => {
    if (!activeId) return;
    const st = getState(activeId);
    const newIdx = st.reviewIndex + delta;
    if (newIdx < 0 || newIdx >= st.reviewFiles.length) return;
    updateState(activeId, s => ({ ...s, reviewIndex: newIdx }));
    loadReviewFile(st.reviewFiles[newIdx]!);
  };

  const handleSubmitReview = () => {
    if (!activeId || !clientRef.current) return;
    const st = getState(activeId);
    const allComments = Object.entries(st.reviewComments).flatMap(([path, cmts]) => {
      const rel = explorerRoot && path.startsWith(explorerRoot) ? path.slice(explorerRoot.length + 1) : path;
      return cmts.map(c => {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`;
        return `@${rel}:${lineRef} — ${c.text}`;
      });
    });
    if (allComments.length === 0) return;
    const reviewText = `Apply these changes to the code:\n${allComments.join('\n')}`;
    updateState(activeId, s => ({
      ...s,
      messages: [...s.messages, { id: crypto.randomUUID(), role: 'user' as const, content: reviewText, timestamp: Date.now() }],
      isStreaming: true, partialText: '',
      reviewMode: false, reviewFiles: [], diffView: null, editorFullWidth: false, reviewComments: {},
    }));
    clientRef.current.sendMessage(activeId, reviewText);
  };

  const handleExitReview = () => {
    if (!activeId) return;
    updateState(activeId, s => ({ ...s, reviewMode: false, reviewFiles: [], diffView: null, editorFullWidth: false }));
  };

  const explorerRootRef = useRef<string | null>(null);

  const refreshGitModified = useCallback(async () => {
    const root = explorerRootRef.current;
    if (!client || !root) return;
    const entries = await client.getGitModified(root);
    const staged = new Set<string>();
    const unstaged = new Set<string>();
    for (const e of entries) {
      if (e.staged) staged.add(e.path);
      else unstaged.add(e.path);
    }
    setGitModified({ staged, unstaged });
  }, [client]);

  // handleSaveFile is now handleSaveFileWrapped (defined above)

  const untitledCountRef = useRef(0);
  const [saveAsPrompt, setSaveAsPrompt] = useState<{ content: string } | null>(null);
  const [saveAsPath, setSaveAsPath] = useState('');
  const saveAsInputRef = useRef<HTMLInputElement>(null);

  const handleNewFile = () => {
    if (!activeId) return;
    untitledCountRef.current++;
    const name = `untitled-${untitledCountRef.current}`;
    updateState(activeId, s => ({
      ...s,
      openFile: { path: name, content: '' },
      openTerminalId: null,
      diffView: null,
      editorDirty: true,
    }));
  };

  const handleSaveAs = (content: string) => {
    const root = explorerRootRef.current || '';
    setSaveAsPath(root ? `${root}/` : '');
    setSaveAsPrompt({ content });
    setTimeout(() => saveAsInputRef.current?.focus(), 50);
  };

  const confirmSaveAs = async () => {
    if (!saveAsPrompt || !saveAsPath.trim() || !clientRef.current || !activeId) return;
    const path = saveAsPath.trim();
    const ok = await clientRef.current.writeFile(path, saveAsPrompt.content);
    if (ok) {
      updateState(activeId, s => ({ ...s, openFile: { path, content: saveAsPrompt.content }, editorDirty: false }));
      refreshGitModified();
    }
    setSaveAsPrompt(null);
    setSaveAsPath('');
  };

  const handleSaveFileWrapped = async () => {
    if (!active.openFile || !activeId) return;
    // Untitled files need Save As
    if (active.openFile.path.startsWith('untitled-')) {
      const editor = editorRef.current;
      const content = editor?.getValue() || active.openFile.content;
      handleSaveAs(content);
      return;
    }
    // Normal save
    if (!clientRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getValue();
    const filePath = active.openFile.path;
    try {
      const ok = await clientRef.current.writeFile(filePath, content);
      if (ok) {
        updateState(activeId, s => ({ ...s, openFile: { path: filePath, content }, editorDirty: false }));
        refreshGitModified();
      }
    } catch {}
  };

  const handleCloseCurrentPanel = () => {
    if (!activeId) return;
    const s = getState(activeId);
    const hasPanel = s.openFile || s.openTerminalId || s.diffView;
    if (hasPanel) {
      if (s.openFile && s.editorDirty) {
        setUnsavedClosePrompt(true);
        return;
      }
      updateState(activeId, st => ({ ...st, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
    } else {
      handleCloseTab(activeId);
    }
  };

  const saveRef = useRef(handleSaveFileWrapped);
  saveRef.current = handleSaveFileWrapped;
  const newFileRef = useRef(handleNewFile);
  newFileRef.current = handleNewFile;
  const closePanelRef = useRef(handleCloseCurrentPanel);
  closePanelRef.current = handleCloseCurrentPanel;

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      switch (e.key) {
        case 'k':
          e.preventDefault();
          setShowPalette(p => !p);
          break;
        case 'b':
          e.preventDefault();
          setExplorerCollapsed(c => !c);
          break;
        case 'l':
          e.preventDefault();
          inputRef.current?.focus();
          break;
        case 's':
          e.preventDefault();
          saveRef.current();
          break;
        case 'w':
          e.preventDefault();
          closePanelRef.current();
          break;
        case 'n':
          if (!e.shiftKey) {
            e.preventDefault();
            newFileRef.current();
          }
          break;
        case 'f':
          if (e.shiftKey) {
            e.preventDefault();
            setSidebarView('search');
            setExplorerCollapsed(false);
          }
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const activeStatus = activeId ? (statuses[activeId] || 'disconnected') : 'disconnected';
  const activeSession = sessions.find(s => s.id === activeId);

  // Ordered sessions for tab bar
  const orderedOpenSessions = sessions
    .filter(s => !closedSessionIds.has(s.id))
    .sort((a, b) => {
      const ai = tabOrder.indexOf(a.id);
      const bi = tabOrder.indexOf(b.id);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });

  const handleReorder = (fromId: string, toId: string) => {
    setTabOrder(prev => {
      // Ensure all open session IDs are in the order
      const openIds = sessions.filter(s => !closedSessionIds.has(s.id)).map(s => s.id);
      const order = prev.filter(id => openIds.includes(id));
      for (const id of openIds) { if (!order.includes(id)) order.push(id); }
      // Move fromId to toId's position
      const fromIdx = order.indexOf(fromId);
      const toIdx = order.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, fromId);
      try { localStorage.setItem('claude-ui-tab-order', JSON.stringify(order)); } catch {}
      return order;
    });
  };
  const explorerRoot = active.initInfo?.cwd || activeSession?.cwd || null;
  explorerRootRef.current = explorerRoot;

  // Load git modified when root changes
  useEffect(() => {
    refreshGitModified();
  }, [explorerRoot, refreshGitModified]);

  // Fetch git branch for status bar
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ local: string[]; remote: string[]; current: string; rect: DOMRect } | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);

  const openBranchMenu = () => {
    try {
      uiLog('openBranchMenu called');
      const c = clientRef.current;
      const root = explorerRootRef.current;
      uiLog(`client: ${!!c}, root: ${root}`);
      const rect = branchBtnRef.current?.getBoundingClientRect() || new DOMRect(10, window.innerHeight - 30, 100, 20);
      uiLog(`rect: ${JSON.stringify({ top: rect.top, left: rect.left })}`);
      setBranchMenu({ local: [], remote: [], current: gitBranch || '', rect });
      setBranchFilter('');
      if (c && root) {
        c.listBranches(root).then(data => {
          uiLog(`branches loaded: local=${data.local?.length}, remote=${data.remote?.length}`);
          setBranchMenu(prev => prev ? { ...prev, local: data.local || [], remote: data.remote || [], current: data.current || '' } : null);
          setTimeout(() => branchInputRef.current?.focus(), 50);
        }).catch(e => { uiLog(`listBranches error: ${e}`); });
      }
    } catch (e) {
      uiLog(`openBranchMenu error: ${e}`);
    }
  };

  const doCheckout = async (branch: string) => {
    const client = clientRef.current;
    const explorerRoot = explorerRootRef.current;
    if (!client || !explorerRoot) return;
    setBranchMenu(null);
    const result = await client.checkoutBranch(explorerRoot, branch);
    if (result.ok && result.branch) {
      setGitBranch(result.branch);
      refreshGitModified();
    }
  };
  useEffect(() => {
    if (!client || !explorerRoot) { setGitBranch(null); return; }
    client.getGitInfo(explorerRoot).then(info => {
      setGitBranch(info.is_git ? info.branch || null : null);
    }).catch(() => setGitBranch(null));
  }, [client, explorerRoot]);

  const slashCommands = active.initInfo?.slashCommands || [];
  const slash = useSlashCommands(input, slashCommands);
  const fileIndex = useFileIndex(client, explorerRoot);
  const fileMention = useFileMention(input, fileIndex);

  const paletteActions: PaletteAction[] = [
    { id: 'new-session', label: 'New Session', keys: ['command'], key: 'N', section: 'Sessions', onRun: () => setShowNewSession(true) },
    { id: 'focus-input', label: 'Focus Chat Input', keys: ['command'], key: 'L', section: 'Navigation', onRun: () => inputRef.current?.focus() },
    { id: 'toggle-explorer', label: explorerCollapsed ? 'Show File Explorer' : 'Hide File Explorer', keys: ['command'], key: 'B', section: 'Navigation', onRun: () => setExplorerCollapsed(c => !c) },
    { id: 'close-editor', label: 'Close Editor / Tab', keys: ['command'], key: 'W', section: 'Navigation', onRun: () => closePanelRef.current() },
    { id: 'new-file', label: 'New File', keys: ['command'], key: 'N', section: 'Editor', onRun: handleNewFile },
    { id: 'save-file', label: 'Save File', keys: ['command'], key: 'S', section: 'Editor', onRun: handleSaveFileWrapped},
    { id: 'clear-chat', label: 'Clear Chat', section: 'Session', onRun: async () => {
      if (!activeId || !clientRef.current) return;
      const session = sessions.find(s => s.id === activeId);
      const cwd = active.initInfo?.cwd || session?.cwd || '/';
      // Close old session
      clientRef.current.disconnectSession(activeId);
      updateState(activeId, s => emptyState());
      deleteMessages(activeId);
      // Create a fresh session with the same cwd
      try {
        const fresh = await clientRef.current.createSession(cwd);
        // Remove old, add new
        setSessions(prev => prev.filter(s => s.id !== activeId).concat(fresh));
        setActiveId(fresh.id);
        clientRef.current.connectSession(fresh);
      } catch {}
    } },
    { id: 'command-palette', label: 'Command Palette', keys: ['command'], key: 'K', section: 'Navigation', onRun: () => {} },
    ...(activeId && active.isStreaming ? [{ id: 'stop', label: 'Stop Generation', keys: ['escape'] as string[], section: 'Session', onRun: handleInterrupt }] : []),
    ...sessions.map(s => ({
      id: `switch-${s.id}`,
      label: `Switch to ${s.name}`,
      section: 'Sessions',
      onRun: () => handleSelectSession(s.id),
    })),
    ...slashCommands.map(cmd => ({
      id: `slash-${cmd}`,
      label: `/${cmd}`,
      section: 'Slash Commands',
      onRun: () => { setInput(`/${cmd} `); inputRef.current?.focus(); },
    })),
  ];

  const handleSlashSelect = (cmd: string) => {
    setInput(`/${cmd} `);
  };

  const handleFileMentionSelect = (file: { name: string; path: string; rel: string }) => {
    // Replace @query with @filepath
    const before = input.slice(0, fileMention.atIdx);
    setInput(`${before}@${file.rel} `);
  };

  const handleEditorMount = useCallback((editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    // Cmd+Option+K: reference file/selection in chat
    editor.addAction({
      id: 'reference-in-chat',
      label: 'Reference in Chat',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK,
      ],
      run: (ed) => {
        const model = ed.getModel();
        if (!model) return;
        const selection = ed.getSelection();
        const hasSelection = selection && !selection.isEmpty();
        const filePath = openFile?.path || '';
        const relativePath = explorerRoot && filePath.startsWith(explorerRoot)
          ? filePath.slice(explorerRoot.length + 1)
          : filePath;

        let reference: string;
        if (hasSelection) {
          const startLine = selection!.startLineNumber;
          const endLine = selection!.endLineNumber;
          const lineRef = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
          reference = `@${relativePath}:${lineRef}`;
        } else {
          reference = `@${relativePath}`;
        }

        setInput(prev => {
          const sep = prev && !prev.endsWith(' ') ? ' ' : '';
          return `${prev}${sep}${reference} `;
        });
        // Focus the chat input
        setTimeout(() => inputRef.current?.focus(), 50);
      },
    });
  }, [openFile, explorerRoot]);

  return (
    <Providers>
      <div className="h-screen bg-base flex flex-col overflow-hidden">
        {/* Titlebar drag region */}
        <div
          data-tauri-drag-region
          className="fixed top-0 left-0 right-0 h-[28px] z-[9999]"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        {/* Tab bar */}
        <TabBar
          sessions={orderedOpenSessions}
          closedSessions={sessions.filter(s => closedSessionIds.has(s.id))}
          activeSessionId={activeId}
          sessionStatuses={statuses}
          sessionStreaming={Object.fromEntries(Object.entries(sessionStates).map(([id, s]) => [id, s.isStreaming]))}
          sessionTurnComplete={turnCompleteIds}
          sessionHasPermission={Object.fromEntries(Object.entries(sessionStates).map(([id, s]) => [id, !!s.permRequest]))}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onClose={handleCloseTab}
          onReopen={handleReopenSession}
          onRename={handleRenameSession}
          onReorder={handleReorder}
          tabGroups={tabGroups}
          tabGroupMap={tabGroupMap}
          expandedGroupId={expandedGroupId}
          onCreateGroup={handleCreateGroup}
          onGroupTabs={handleGroupTabs}
          onAddToGroup={handleAddToGroup}
          onUngroupTab={handleUngroupTab}
          onToggleGroup={handleToggleGroup}
          onRenameGroup={handleRenameGroup}
          onChangeGroupColor={handleChangeGroupColor}
        />

        <div className="flex-1 flex min-h-0">
          {/* Activity Bar */}
          <div className="w-10 bg-[#161616] border-r border-border flex flex-col items-center py-2 gap-1 shrink-0">
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'explorer' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'explorer' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('explorer'); setExplorerCollapsed(false); } }}
              title="Explorer (Cmd+B)"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" /></svg>
            </button>
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'search' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'search' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('search'); setExplorerCollapsed(false); } }}
              title="Search (Cmd+Shift+F)"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="7" /><path d="M16 16L21 21" strokeLinecap="round" /></svg>
            </button>
          </div>

          {/* Side Panel: Explorer or Search */}
          {activeId && sidebarView === 'explorer' && (
          <FileExplorer
            client={client}
            rootPath={explorerRoot}
            collapsed={explorerCollapsed}
            onToggle={() => setExplorerCollapsed(c => !c)}
            onFileOpen={handleFileOpen}
            onFileDiff={handleFileDiff}
            gitModified={gitModified}
            activeSessionId={activeId}
            onOpenTerminal={(command) => {
              const msg = active.messages.findLast(m => m.isTerminal && m.terminalCommand === command);
              if (msg) { if (activeId) updateState(activeId, s => ({ ...s, openFile: null, openTerminalId: msg.id, diffView: null, editorDirty: false })); }
            }}
            onStartReview={handleStartReview}
            onRefreshGit={refreshGitModified}
            tools={active.initInfo?.tools}
            sessionName={activeSession?.name}
          />
          )}

          {/* Search Panel */}
          {activeId && sidebarView === 'search' && !explorerCollapsed && (
            <SearchPanel client={client} rootPath={explorerRoot} onFileOpen={handleFileOpen} onClose={() => setExplorerCollapsed(true)} />
          )}

          <div className="flex-1 flex flex-col min-w-0">
            {!activeId ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-full max-w-md px-6">
                  <h2 className="text-lg text-zinc-300 font-medium mb-1">Claude Code</h2>
                  <p className="text-[13px] text-zinc-600 mb-6">Start a new session or reopen an existing one.</p>

                  <div className="space-y-2 mb-6">
                    <button
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left text-sm text-zinc-300 bg-surface border border-border hover:bg-surface-light hover:border-border-light transition-colors"
                      onClick={handleNewSession}
                    >
                      <span className="text-zinc-500 text-lg">+</span>
                      <div>
                        <div>New Session</div>
                        <div className="text-[11px] text-zinc-600">Create a new Claude session</div>
                      </div>
                    </button>
                  </div>

                  {sessions.filter(s => closedSessionIds.has(s.id)).length > 0 && (
                    <>
                      <p className="text-[11px] text-zinc-600 uppercase tracking-wider mb-2">Recent Sessions</p>
                      <div className="space-y-2">
                        {sessions.filter(s => closedSessionIds.has(s.id)).map(s => (
                          <button
                            key={s.id}
                            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-left text-sm text-zinc-400 bg-surface border border-border hover:bg-surface-light hover:border-border-light hover:text-zinc-200 transition-colors"
                            onClick={() => handleReopenSession(s.id)}
                          >
                            <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate">{s.name}</div>
                              <div className="text-[11px] text-zinc-600 font-mono truncate">{s.cwd}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Info bar */}
                <div className="border-b border-border px-3 py-1 flex items-center gap-3 shrink-0">
                  {explorerCollapsed && (
                    <button
                      className="text-zinc-600 hover:text-zinc-300 text-sm"
                      onClick={() => setExplorerCollapsed(false)}
                      title="Show file explorer"
                    >
                      &#x2630;
                    </button>
                  )}
                  {active.initInfo && (
                    <span className="text-xs text-zinc-600">
                      v{active.initInfo.version} · {active.initInfo.tools.length} tools
                    </span>
                  )}
                  <span className="flex-1" />
                  {active.initInfo?.cwd && (
                    <span className="text-xs text-zinc-600 font-mono truncate max-w-sm">
                      {active.initInfo.cwd}
                    </span>
                  )}
                </div>

              <div className="flex-1 flex min-h-0">
                {/* Chat panel */}
                <div className={`flex flex-col min-w-0 overflow-hidden ${hasRightPanel && !editorFullWidth ? 'w-1/2 border-r border-border' : hasRightPanel && editorFullWidth ? 'hidden' : 'flex-1'}`}>
                  <div className="flex flex-1 min-h-0">
                  {/* Messages */}
                  <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-1">
                    {active.messages.length === 0 && !active.partialText && (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-zinc-600 text-sm">
                          {activeStatus === 'connecting' ? 'Connecting to Claude...' :
                           activeStatus === 'connected' ? 'Send a message to start' :
                           'Waiting for connection...'}
                        </p>
                      </div>
                    )}
                    {active.messages.map(msg => (
                      <MessageBubble key={msg.id} message={msg} onOpenTerminal={(id) => { if (activeId) updateState(activeId, s => ({ ...s, openFile: null, openTerminalId: id, diffView: null, editorDirty: false })); }} />
                    ))}
                    {active.isStreaming && !active.partialText && !active.permRequest && (
                      <div className="py-2">
                        <div className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-[pulse_1.4s_ease-in-out_infinite]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
                        </div>
                      </div>
                    )}
                    {active.partialText && (
                      <div className="py-1">
                        <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
                          {active.partialText}
                          <span className="inline-block w-1 h-3.5 bg-zinc-500/60 animate-pulse ml-0.5 align-text-bottom" />
                        </p>
                      </div>
                    )}
                    {/* Inline permission request */}
                    {active.permRequest && (() => {
                      const req = active.permRequest;
                      const input = req.input;
                      const isEdit = req.toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string';
                      const isBash = req.toolName === 'Bash' && typeof input.command === 'string';
                      const isWrite = req.toolName === 'Write' && typeof input.content === 'string';
                      const isPlan = req.toolName === 'ExitPlanMode';
                      const planContent = isPlan && typeof input.plan === 'string' ? input.plan as string : null;
                      const allowedPrompts = isPlan && Array.isArray(input.allowedPrompts) ? input.allowedPrompts as { tool: string; prompt: string }[] : [];
                      const isAskUser = req.toolName === 'AskUserQuestion';
                      const askQuestions = isAskUser && Array.isArray(input.questions) ? input.questions as { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] : [];
                      const filePath = typeof input.file_path === 'string' ? input.file_path : null;
                      const ext = filePath?.split('.').pop() || '';
                      const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', rs: 'rust', go: 'go', json: 'json', css: 'css', html: 'html', md: 'markdown', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql' };
                      const lang = langMap[ext] || 'plaintext';
                      const oldLines = isEdit ? (input.old_string as string).split('\n').length : 0;
                      const newLines = isEdit ? (input.new_string as string).split('\n').length : 0;
                      const diffHeight = isEdit ? Math.min(Math.max(oldLines, newLines) * 19 + 20, 300) : 0;

                      return (
                        <div className={`py-1 pl-3 ml-1 border-l-2 ${isAskUser ? 'border-violet-500/50' : 'border-amber-500/50'}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[11px] font-mono text-violet-400">{isAskUser ? 'Question' : req.toolName}</span>
                            {!isAskUser && <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">permission required</span>}
                          </div>
                          {filePath && (
                            <p className="text-[11px] text-zinc-500 font-mono mb-1 truncate">{filePath}</p>
                          )}
                          {req.description && !filePath && (
                            <p className="text-[12px] text-zinc-400 mb-1">{req.description}</p>
                          )}

                          {/* Edit tool: inline diff */}
                          {isEdit && (
                            <div className="rounded overflow-hidden border border-border mb-2" style={{ height: diffHeight }}>
                              <DiffEditor
                                original={input.old_string as string}
                                modified={input.new_string as string}
                                language={lang}
                                theme="vs-dark"
                                options={{
                                  readOnly: true,
                                  renderSideBySide: true,
                                  minimap: { enabled: false },
                                  scrollBeyondLastLine: false,
                                  fontSize: 12,
                                  lineNumbers: 'off',
                                  glyphMargin: false,
                                  folding: false,
                                  lineDecorationsWidth: 0,
                                  overviewRulerLanes: 0,
                                  scrollbar: { vertical: 'hidden', horizontal: 'auto' },
                                  renderOverviewRuler: false,
                                  contextmenu: false,
                                  domReadOnly: true,
                                }}
                              />
                            </div>
                          )}

                          {/* Bash tool: command block */}
                          {isBash && (
                            <div className="rounded bg-[#0d0d0d] border border-border mb-2 px-3 py-2">
                              <pre className="text-[12px] font-mono text-green-400 whitespace-pre-wrap break-all m-0 leading-snug">
                                <span className="text-zinc-600 select-none">$ </span>{input.command as string}
                              </pre>
                            </div>
                          )}

                          {/* Write tool: file content preview */}
                          {isWrite && (
                            <div className="rounded overflow-hidden border border-border mb-2" style={{ height: Math.min(((input.content as string).split('\n').length) * 19 + 20, 250) }}>
                              <Editor
                                value={input.content as string}
                                language={lang}
                                theme="vs-dark"
                                options={{
                                  readOnly: true,
                                  minimap: { enabled: false },
                                  scrollBeyondLastLine: false,
                                  fontSize: 12,
                                  lineNumbers: 'on',
                                  glyphMargin: false,
                                  folding: false,
                                  overviewRulerLanes: 0,
                                  scrollbar: { vertical: 'hidden', horizontal: 'auto' },
                                  renderOverviewRuler: false,
                                  contextmenu: false,
                                  domReadOnly: true,
                                }}
                              />
                            </div>
                          )}

                          {/* ExitPlanMode: full-height markdown plan */}
                          {isPlan && (
                            <div className="rounded overflow-hidden border border-violet-500/30 mb-2 flex flex-col" style={{ height: 'calc(60vh)' }}>
                              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-violet-500/20 bg-violet-500/5 shrink-0">
                                <span className="text-[11px] text-violet-400 font-semibold uppercase tracking-wide">Plan</span>
                              </div>
                              {planContent ? (
                                <div className="flex-1 overflow-hidden">
                                  <Editor
                                    value={planContent}
                                    language="markdown"
                                    theme="vs-dark"
                                    options={{
                                      readOnly: true,
                                      minimap: { enabled: false },
                                      scrollBeyondLastLine: false,
                                      fontSize: 13,
                                      lineNumbers: 'off',
                                      glyphMargin: false,
                                      folding: false,
                                      wordWrap: 'on',
                                      overviewRulerLanes: 0,
                                      scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                                      renderOverviewRuler: false,
                                      contextmenu: false,
                                      domReadOnly: true,
                                      padding: { top: 12, bottom: 12 },
                                    }}
                                  />
                                </div>
                              ) : (
                                <p className="text-[12px] text-zinc-500 px-3 py-3">No plan content</p>
                              )}
                              {allowedPrompts.length > 0 && (
                                <div className="border-t border-violet-500/20 px-3 py-2 shrink-0">
                                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Allowed actions</p>
                                  <div className="flex flex-wrap gap-1">
                                    {allowedPrompts.map((p, i) => (
                                      <span key={i} className="text-[11px] bg-surface-light text-zinc-400 px-2 py-0.5 rounded">{p.prompt}</span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* AskUserQuestion: interactive form */}
                          {isAskUser && askQuestions.length > 0 && (
                            <AskUserQuestionForm
                              questions={askQuestions}
                              onSubmit={(answers) => {
                                handlePermission(req.requestId, true, { ...input, answers });
                              }}
                            />
                          )}

                          {/* Fallback for other tools */}
                          {!isEdit && !isBash && !isWrite && !isPlan && !isAskUser && (
                            <pre className="text-[11px] text-zinc-500 whitespace-pre-wrap break-all m-0 mb-2 bg-transparent p-0 max-h-40 overflow-auto leading-tight">
                              {JSON.stringify(input, null, 2)}
                            </pre>
                          )}

                          {!isAskUser && <div className="flex items-center gap-2">
                            <button
                              className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-green-600/15 text-green-400 hover:bg-green-600/25 transition-colors"
                              onClick={() => handlePermission(req.requestId, true)}
                            >
                              Allow
                            </button>
                            {isPlan && (
                              <button
                                className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors"
                                onClick={() => {
                                  handlePermission(req.requestId, true);
                                  if (activeId && clientRef.current) {
                                    setSessions(prev => prev.map(s => s.id === activeId ? { ...s, permission_mode: 'acceptEdits' } : s));
                                    clientRef.current.setPermissionMode(activeId, 'acceptEdits');
                                    clientRef.current.updateSession(activeId, { permissionMode: 'acceptEdits' }).catch(() => {});
                                  }
                                }}
                              >
                                Approve &amp; Accept Edits
                              </button>
                            )}
                            <button
                              className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-red-600/15 text-red-400 hover:bg-red-600/25 transition-colors"
                              onClick={() => handlePermission(req.requestId, false)}
                            >
                              Deny
                            </button>
                          </div>}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Task panel */}
                  {todos.length > 0 && (
                    <div className="w-48 border-l border-border shrink-0 flex flex-col overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
                        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Tasks</span>
                        <span className="text-[10px] text-zinc-600">{todos.filter(t => t.status === 'completed').length}/{todos.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto px-2 py-1.5">
                        {todos.map((todo, i) => (
                          <div key={i} className={`flex items-start gap-1.5 text-[11px] py-0.5 ${todo.status === 'completed' ? 'text-zinc-600' : todo.status === 'in_progress' ? 'text-zinc-200' : 'text-zinc-500'}`}>
                            <span className="w-4 text-center shrink-0 mt-px">
                              {todo.status === 'completed' ? <span className="text-green-400">&#x2713;</span> :
                               todo.status === 'in_progress' ? <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block" /> :
                               <span className="w-1.5 h-1.5 rounded-full border border-zinc-600 inline-block" />}
                            </span>
                            <span className={todo.status === 'completed' ? 'line-through' : ''}>
                              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  </div>

                  {/* Input */}
                  <div className="border-t border-border p-3 shrink-0">
                    <div className="max-w-4xl mx-auto relative">
                      {slash.isActive && (
                        <SlashCommandList
                          filtered={slash.filtered}
                          selectedIndex={slash.selectedIndex}
                          onSelect={handleSlashSelect}
                          onHover={() => {}}
                        />
                      )}
                      {fileMention.isActive && (
                        <FileMentionList
                          results={fileMention.results}
                          selectedIndex={fileMention.selectedIndex}
                          onSelect={handleFileMentionSelect}
                        />
                      )}
                      {/* File reference chips */}
                      {(() => {
                        const refs = input.match(/@[\w.\/\-:]+/g);
                        if (!refs || refs.length === 0) return null;
                        return (
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {refs.map((ref, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-light text-[11px] font-mono text-amber-400/80 border border-border-light"
                              >
                                {ref}
                                <button
                                  className="text-zinc-500 hover:text-zinc-300 ml-0.5"
                                  onClick={() => setInput(prev => prev.replace(ref, '').replace(/  +/g, ' ').trim())}
                                >
                                  &times;
                                </button>
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                      {/* Image previews */}
                      {pastedImages.length > 0 && (
                        <div className="flex gap-2 mb-2 flex-wrap">
                          {pastedImages.map((img, i) => (
                            <div key={i} className="relative group">
                              <img src={img.preview} alt="" className="h-16 rounded border border-border object-cover" />
                              <button
                                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-700 text-zinc-300 text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                onClick={() => setPastedImages(prev => prev.filter((_, j) => j !== i))}
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Model & plan mode */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <Select
                          aria-label="Model"
                          selectedKey={activeSession?.model || 'default'}
                          onSelectionChange={(key) => {
                            if (!activeId || !clientRef.current) return;
                            const modelId = key === 'default' ? '' : String(key);
                            if (modelId) {
                              clientRef.current.setModel(activeId, modelId);
                            }
                            setSessions(prev => prev.map(s => s.id === activeId ? { ...s, model: modelId || null } : s));
                          }}
                          className="w-32"
                        >
                          <SelectTrigger className="h-6 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectPopover>
                            <ListBox>
                              <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                              <ListBoxItem key="claude-sonnet-4-6" id="claude-sonnet-4-6" textValue="Sonnet 4.6"><span className="text-xs">Sonnet 4.6</span></ListBoxItem>
                              <ListBoxItem key="claude-opus-4-6" id="claude-opus-4-6" textValue="Opus 4.6"><span className="text-xs">Opus 4.6</span></ListBoxItem>
                              <ListBoxItem key="claude-haiku-4-5-20251001" id="claude-haiku-4-5-20251001" textValue="Haiku 4.5"><span className="text-xs">Haiku 4.5</span></ListBoxItem>
                            </ListBox>
                          </SelectPopover>
                        </Select>
                        <Select
                          aria-label="Permission mode"
                          selectedKey={activeSession?.permission_mode || 'default'}
                          onSelectionChange={(key) => {
                            if (!activeId || !clientRef.current) return;
                            const mode = String(key);
                            setSessions(prev => prev.map(s => s.id === activeId ? { ...s, permission_mode: mode } : s));
                            clientRef.current.setPermissionMode(activeId, mode);
                            clientRef.current.updateSession(activeId, { permissionMode: mode }).catch(() => {});
                          }}
                          className="w-36"
                        >
                          <SelectTrigger className="h-6 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectPopover>
                            <ListBox>
                              <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                              <ListBoxItem key="acceptEdits" id="acceptEdits" textValue="Accept Edits"><span className="text-xs">Accept Edits</span></ListBoxItem>
                              <ListBoxItem key="plan" id="plan" textValue="Plan"><span className="text-xs">Plan</span></ListBoxItem>
                              <ListBoxItem key="bypassPermissions" id="bypassPermissions" textValue="Bypass"><span className="text-xs">Bypass All</span></ListBoxItem>
                            </ListBox>
                          </SelectPopover>
                        </Select>
                      </div>
                      {(() => {
                        const isTerminalMode = input.startsWith('>');
                        const cmdText = isTerminalMode ? input.slice(1).replace(/^ /, '') : input;
                        return (
                          <div className="flex gap-2 items-center">
                            {active.isStreaming && (
                              <Button size="sm" variant="flat" onPress={handleInterrupt}
                                className="shrink-0 text-amber-400">
                                Stop
                              </Button>
                            )}
                            <div className={`flex-1 flex items-end rounded-lg transition-colors ${isTerminalMode ? 'border bg-[#141414] border-green-900/50' : ''}`}>
                              {isTerminalMode && (
                                <span className="text-green-500 text-sm font-mono pl-3 pr-1 py-2 select-none shrink-0">&gt;</span>
                              )}
                              <textarea
                                ref={inputRef}
                                value={isTerminalMode ? cmdText : input}
                                onChange={(e) => {
                                  if (isTerminalMode) {
                                    const v = e.target.value;
                                    setInput(v ? `> ${v}` : '> ');
                                  } else {
                                    setInput(e.target.value);
                                  }
                                }}
                                disabled={active.isStreaming || activeStatus !== 'connected'}
                                placeholder={isTerminalMode ? 'command...' : 'Send a message... (/ commands, @ files)'}
                                onKeyDown={(e) => {
                                  // Exit terminal mode on backspace when command is empty
                                  if (isTerminalMode && e.key === 'Backspace' && !cmdText) {
                                    e.preventDefault();
                                    setInput('');
                                    return;
                                  }
                                  // Input history navigation (arrow up/down when input is single line)
                                  if (e.key === 'ArrowUp' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    const el = e.currentTarget;
                                    if (el.selectionStart === 0 && el.selectionEnd === 0) {
                                      e.preventDefault();
                                      const hist = active.inputHistory;
                                      if (hist.length === 0) return;
                                      if (historyIdxRef.current === -1) historyDraftRef.current = input;
                                      const newIdx = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
                                      historyIdxRef.current = newIdx;
                                      setInput(hist[newIdx]!);
                                      return;
                                    }
                                  }
                                  if (e.key === 'ArrowDown' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    const el = e.currentTarget;
                                    if (el.selectionStart === el.value.length) {
                                      e.preventDefault();
                                      const hist = active.inputHistory;
                                      if (historyIdxRef.current === -1) return;
                                      const newIdx = historyIdxRef.current + 1;
                                      if (newIdx >= hist.length) {
                                        historyIdxRef.current = -1;
                                        setInput(historyDraftRef.current);
                                      } else {
                                        historyIdxRef.current = newIdx;
                                        setInput(hist[newIdx]!);
                                      }
                                      return;
                                    }
                                  }
                                  if (fileMention.isActive) {
                                    fileMention.onKeyDown(e, handleFileMentionSelect);
                                  } else {
                                    slash.onKeyDown(e, handleSlashSelect);
                                  }
                                  if (e.key === 'Enter' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    e.preventDefault();
                                    handleSend();
                                  }
                                }}
                                autoFocus
                                rows={1}
                                className={`flex-1 rounded-lg py-2 text-sm placeholder:text-zinc-600 resize-none outline-none transition-colors disabled:opacity-50 ${isTerminalMode ? 'bg-transparent border-0 font-mono text-green-300 pl-0 pr-3' : 'bg-surface border border-border text-zinc-200 focus:border-zinc-500 px-3'}`}
                                style={{ minHeight: 38, maxHeight: 200 }}
                                onPaste={(e) => {
                                  const items = e.clipboardData?.items;
                                  if (!items) return;
                                  for (const item of items) {
                                    if (item.type.startsWith('image/')) {
                                      e.preventDefault();
                                      const file = item.getAsFile();
                                      if (!file) continue;
                                      const reader = new FileReader();
                                      reader.onload = () => {
                                        const dataUrl = reader.result as string;
                                        const [header, data] = dataUrl.split(',');
                                        const media_type = header!.match(/:(.*?);/)?.[1] || 'image/png';
                                        setPastedImages(prev => [...prev, { media_type, data: data!, preview: dataUrl }]);
                                      };
                                      reader.readAsDataURL(file);
                                    }
                                  }
                                }}
                                onInput={(e) => {
                                  const el = e.currentTarget;
                                  el.style.height = 'auto';
                                  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                                }}
                              />
                            </div>
                            <Button
                              onPress={handleSend}
                              isDisabled={isTerminalMode ? !cmdText.trim() || active.isStreaming || activeStatus !== 'connected' : !input.trim() || active.isStreaming || activeStatus !== 'connected'}
                              className={`shrink-0 px-6 ${isTerminalMode ? 'bg-green-600 text-white' : ''}`}
                            >
                              {isTerminalMode ? 'Run' : 'Send'}
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Right panel: editor or terminal */}
                {openFile && (
                  <div className={`${editorFullWidth ? 'flex-1' : 'w-1/2'} flex flex-col min-w-0`}>
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => activeId && updateState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className={`text-[12px] font-mono truncate ${gitModified.staged.has(openFile.path) ? 'text-green-400' : gitModified.unstaged.has(openFile.path) ? 'text-amber-400' : 'text-zinc-400'}`}>
                          {openFile.path.split('/').pop()}
                        </span>
                        {editorDirty && <span className="w-2 h-2 rounded-full bg-zinc-400 shrink-0" title="Unsaved changes" />}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {editorDirty && (
                          <button
                            className="text-[11px] text-zinc-500 hover:text-zinc-200 px-1.5"
                            onClick={handleSaveFileWrapped}
                            title="Save (Cmd+S)"
                          >
                            Save
                          </button>
                        )}
                        <button
                          className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                          onClick={() => { setOpenFile(null); }}
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                    <div className="flex-1">
                      <Editor
                        key={openFile.path}
                        path={openFile.path}
                        defaultValue={openFile.content}
                        theme="vs-dark"
                        onMount={handleEditorMount}
                        onChange={(value) => {
                          if (activeId) updateState(activeId, s => ({ ...s, editorDirty: value !== s.openFile?.content }));
                        }}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          padding: { top: 8 },
                        }}
                      />
                    </div>
                  </div>
                )}
                {!openFile && openTerminal && (
                  <div className={`${editorFullWidth ? 'flex-1' : 'w-1/2'} flex flex-col min-w-0`}>
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => activeId && updateState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className="text-[10px] text-zinc-500">$</span>
                        <span className="text-[12px] font-mono text-zinc-300 truncate">{openTerminal.terminalCommand}</span>
                        {openTerminal.exitCode === undefined && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
                        {openTerminal.exitCode !== undefined && openTerminal.exitCode === 0 && <span className="text-[10px] text-green-400 shrink-0">exit 0</span>}
                        {openTerminal.exitCode !== undefined && openTerminal.exitCode !== 0 && <span className="text-[10px] text-red-400 shrink-0">exit {openTerminal.exitCode}</span>}
                      </div>
                      <button
                        className="text-zinc-500 hover:text-zinc-200 text-sm px-1 shrink-0"
                        onClick={() => activeId && updateState(activeId, s => ({ ...s, openTerminalId: null }))}
                      >
                        &times;
                      </button>
                    </div>
                    <pre className="flex-1 overflow-auto px-3 py-2 text-[12px] font-mono text-zinc-400 whitespace-pre-wrap break-all leading-snug m-0 bg-transparent">
                      <AnsiText text={openTerminal.content} />
                      {openTerminal.exitCode === undefined && <span className="inline-block w-1.5 h-3 bg-zinc-500/60 animate-pulse ml-0.5 align-text-bottom" />}
                    </pre>
                  </div>
                )}
                {!openFile && !openTerminal && diffView && (
                  <div className={`${editorFullWidth ? 'flex-1' : 'w-1/2'} flex flex-col min-w-0`}>
                    {/* Review status bar */}
                    {reviewMode && (
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 bg-surface-light">
                        <span className="text-[11px] text-zinc-500">
                          {Object.values(reviewComments).flat().length} comment{Object.values(reviewComments).flat().length !== 1 ? 's' : ''}
                        </span>
                        <span className="flex-1" />
                        <button
                          className="text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-surface-lighter transition-colors"
                          onClick={handleExitReview}
                        >
                          Cancel
                        </button>
                        <button
                          className="flex items-center gap-1 text-[11px] bg-green-600 text-white rounded px-2.5 py-0.5 hover:bg-green-500 disabled:opacity-40 transition-colors"
                          disabled={Object.values(reviewComments).flat().length === 0}
                          onClick={handleSubmitReview}
                        >
                          Submit Review &#x25B6;
                        </button>
                      </div>
                    )}
                    {/* File header */}
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => !reviewMode && activeId && updateState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className="text-[10px] text-amber-400 shrink-0">M</span>
                        <span className="text-[12px] font-mono text-amber-400 truncate">{diffView.path.split('/').pop()}</span>
                        {explorerRoot && (
                          <span className="text-[10px] text-zinc-600 font-mono truncate ml-1">{diffView.path.slice(explorerRoot.length + 1)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!reviewMode && (
                          <>
                            <button
                              className="text-[11px] text-zinc-500 hover:text-zinc-200 px-1.5"
                              onClick={() => { handleFileOpen(diffView.path); }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                              onClick={() => { activeId && updateState(activeId, s => ({ ...s, diffView: null, editorFullWidth: false })); }}
                            >
                              &times;
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 flex flex-col relative min-h-0">
                      <DiffReview
                        original={diffView.original}
                        modified={diffView.modified}
                        filePath={diffView.path}
                        comments={reviewComments[diffView.path] || []}
                        onAddComment={(comment) => {
                          if (!activeId || !diffView) return;
                          const p = diffView.path;
                          updateState(activeId, s => ({ ...s, reviewComments: { ...s.reviewComments, [p]: [...(s.reviewComments[p] || []), comment] } }));
                        }}
                        onDeleteComment={(id) => {
                          if (!activeId || !diffView) return;
                          const p = diffView.path;
                          updateState(activeId, s => ({ ...s, reviewComments: { ...s.reviewComments, [p]: (s.reviewComments[p] || []).filter(c => c.id !== id) } }));
                        }}
                      />
                      {reviewMode && reviewFiles.length > 1 && (
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-800/90 backdrop-blur border border-border rounded-lg shadow-lg px-1.5 py-1 z-10">
                          <button
                            className="text-zinc-400 hover:text-white text-[13px] px-2 py-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent"
                            disabled={reviewIndex === 0}
                            onClick={() => handleReviewNav(-1)}
                          >
                            &#x25C0;
                          </button>
                          <span className="text-[12px] text-zinc-300 px-1.5 tabular-nums select-none">
                            {reviewIndex + 1} / {reviewFiles.length}
                          </span>
                          <button
                            className="text-zinc-400 hover:text-white text-[13px] px-2 py-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent"
                            disabled={reviewIndex === reviewFiles.length - 1}
                            onClick={() => handleReviewNav(1)}
                          >
                            &#x25B6;
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Permission modal removed — shown inline in chat */}
            </>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between px-3 h-[22px] bg-[#181818] border-t border-border text-[11px] shrink-0 select-none">
          <div className="flex items-center gap-3">
            {gitBranch && (
              <button ref={branchBtnRef} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer z-10" onClick={(e) => { e.stopPropagation(); openBranchMenu(); }}>
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.322-1.322 1.322H8.822A1.322 1.322 0 007.5 8.644v1.228a2.251 2.251 0 11-1.5 0V6.128a2.251 2.251 0 111.5 0v.994c0 .045.037.082.082.082h2.596c.045 0 .082-.037.082-.082v-.744A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" /></svg>
                {gitBranch}
              </button>
            )}
            {explorerRoot && (
              <span className="text-zinc-600 font-mono truncate max-w-[300px]">
                {explorerRoot.split('/').slice(-3).join('/')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeId && (
              <span className="flex items-center gap-1 text-zinc-600">
                <span className={`w-1.5 h-1.5 rounded-full ${activeStatus === 'connected' ? 'bg-green-400' : activeStatus === 'connecting' ? 'bg-amber-400' : 'bg-zinc-600'}`} />
                {activeStatus}
              </span>
            )}
            {activeSession?.model && (
              <span className="text-zinc-500">{activeSession.model.replace('claude-', '').replace(/-\d+$/, '')}</span>
            )}
            {activeSession?.permission_mode && activeSession.permission_mode !== 'default' && (
              <span className={`px-1 rounded ${activeSession.permission_mode === 'plan' ? 'text-violet-400 bg-violet-400/10' : activeSession.permission_mode === 'acceptEdits' ? 'text-green-400 bg-green-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                {activeSession.permission_mode}
              </span>
            )}
            {active.contextTokens > 0 && (() => {
              const maxTokens = 200000;
              const pct = Math.min((active.contextTokens / maxTokens) * 100, 100);
              const color = pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-green-400';
              const k = (active.contextTokens / 1000).toFixed(0);
              return (
                <span className="flex items-center gap-1.5 text-zinc-600" title={`${active.contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}>
                  <span className="text-[10px]">{k}k</span>
                  <span className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <span className={`block h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                  </span>
                </span>
              );
            })()}
          </div>
        </div>

        {/* Branch picker */}
        {branchMenu && (() => { try {
          const q = branchFilter.toLowerCase();
          const filteredLocal = branchMenu.local.filter(b => !q || b.toLowerCase().includes(q));
          const filteredRemote = branchMenu.remote.filter(b => !q || b.toLowerCase().includes(q));
          const allFiltered = [...filteredLocal, ...filteredRemote];
          const renderBranch = (branch: string, isRemote: boolean) => (
            <button
              key={`${isRemote ? 'r-' : 'l-'}${branch}`}
              className={`w-full text-left px-3 py-1 text-[11px] transition-colors truncate ${branch === branchMenu.current ? 'text-green-400 bg-green-400/5' : 'text-zinc-400 hover:bg-surface-light hover:text-zinc-200'}`}
              onClick={() => doCheckout(branch)}
            >
              {branch === branchMenu.current && <span className="mr-1">&#x2713;</span>}
              {branch}
            </button>
          );
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBranchMenu(null)} />
              <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl w-72 overflow-hidden"
                style={{ bottom: 26, left: branchMenu.rect.left || 10 }}>
                <div className="px-2 py-2 border-b border-border">
                  <input
                    ref={branchInputRef}
                    value={branchFilter}
                    onChange={e => setBranchFilter(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setBranchMenu(null); if (e.key === 'Enter' && allFiltered.length === 1) doCheckout(allFiltered[0]!); }}
                    placeholder="Search branches..."
                    className="w-full bg-surface-light border border-border rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
                  />
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  {allFiltered.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-3">No branches found</p>}
                  {filteredLocal.length > 0 && (
                    <>
                      <div className="px-3 py-0.5 text-[9px] text-zinc-600 uppercase tracking-wider">Local</div>
                      {filteredLocal.map(b => renderBranch(b, false))}
                    </>
                  )}
                  {filteredRemote.length > 0 && (
                    <>
                      <div className="px-3 py-0.5 mt-1 text-[9px] text-zinc-600 uppercase tracking-wider">Remote</div>
                      {filteredRemote.map(b => renderBranch(b, true))}
                    </>
                  )}
                </div>
              </div>
            </>
          );
        } catch(e) { uiLog(`branchMenu render error: ${e}`); return null; } })()}

        <NewSessionModal
          isOpen={showNewSession}
          client={clientRef.current}
          onClose={() => setShowNewSession(false)}
          onCreate={handleCreateSession}
        />
        <CommandPalette
          isOpen={showPalette}
          onClose={() => setShowPalette(false)}
          actions={paletteActions}
          fileIndex={fileIndex}
          onFileOpen={handleFileOpen}
        />
        {/* Unsaved changes dialog */}
        {unsavedClosePrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setUnsavedClosePrompt(false)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">Unsaved Changes</h3>
              <p className="text-[13px] text-zinc-400 mb-4">
                Do you want to save changes to <span className="text-zinc-200 font-mono">{active.openFile?.path.split('/').pop()}</span> before closing?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={() => {
                  setUnsavedClosePrompt(false);
                  if (activeId) updateState(activeId, s => ({ ...s, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
                }}>Don't Save</Button>
                <Button variant="flat" onPress={() => setUnsavedClosePrompt(false)}>Cancel</Button>
                <Button onPress={async () => {
                  setUnsavedClosePrompt(false);
                  await handleSaveFileWrapped();
                  if (activeId) updateState(activeId, s => ({ ...s, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
                }}>Save</Button>
              </div>
            </div>
          </div>
        )}

        {/* Save As dialog */}
        {saveAsPrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setSaveAsPrompt(null)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-md w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">Save As</h3>
              <input
                ref={saveAsInputRef}
                value={saveAsPath}
                onChange={e => setSaveAsPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmSaveAs(); if (e.key === 'Escape') setSaveAsPrompt(null); }}
                placeholder="/path/to/file.ts"
                className="w-full bg-surface-light border border-border rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 outline-none focus:border-zinc-500 mb-3"
              />
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={() => setSaveAsPrompt(null)}>Cancel</Button>
                <Button onPress={confirmSaveAs} isDisabled={!saveAsPath.trim()}>Save</Button>
              </div>
            </div>
          </div>
        )}

        {closingSessionId && (() => {
          const s = sessions.find(s => s.id === closingSessionId);
          return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setClosingSessionId(null)}>
              <div className="absolute inset-0 bg-black/50" />
              <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
                <h3 className="text-sm font-semibold text-zinc-200 mb-2">Close Session</h3>
                <p className="text-[13px] text-zinc-400 mb-4">
                  This will disconnect and close all running processes for <span className="text-zinc-200">{s?.name || 'this session'}</span>.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="flat" onPress={() => setClosingSessionId(null)}>Cancel</Button>
                  <Button className="bg-red-600 text-white" onPress={confirmCloseTab}>Close</Button>
                </div>
              </div>
            </div>
          );
        })()}
        {restoreSessionId && restoreCommands.length > 0 && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={dismissRestore}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">Restore Processes</h3>
              <p className="text-[13px] text-zinc-400 mb-3">
                This session had running processes. Restore them?
              </p>
              <div className="space-y-1 mb-4">
                {restoreCommands.map((cmd, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded bg-surface-light text-[12px] font-mono text-green-400">
                    <span className="text-zinc-500">$</span> {cmd}
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={dismissRestore}>Dismiss</Button>
                <Button className="bg-green-600 text-white" onPress={confirmRestore}>Restore</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Providers>
  );
}
