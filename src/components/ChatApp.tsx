import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@heroui/react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { Providers } from './Providers';
import { TabBar } from './TabBar';
import { FileExplorer } from './FileExplorer';
import { MessageBubble } from './MessageBubble';
import { PermissionModal } from './PermissionModal';
import { NewSessionModal } from './NewSessionModal';
import { useSlashCommands, SlashCommandList } from './SlashCommandPicker';
import { useFileMention, FileMentionList } from './FileMentionPicker';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  ClaudeClient,
  type ChatMessage,
  type ConnectionStatus,
  type PermissionRequest,
  type SessionInfo,
  type SessionInitInfo,
} from '../lib/claude-client';

const SERVER_URL = (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3100';
const MSG_KEY_PREFIX = 'claude-ui-msgs-';

function loadMessages(sessionId: string): ChatMessage[] {
  try { return JSON.parse(localStorage.getItem(MSG_KEY_PREFIX + sessionId) || '[]'); }
  catch { return []; }
}
function saveMessages(sessionId: string, messages: ChatMessage[]) {
  try { localStorage.setItem(MSG_KEY_PREFIX + sessionId, JSON.stringify(messages)); }
  catch {}
}
function deleteMessages(sessionId: string) {
  localStorage.removeItem(MSG_KEY_PREFIX + sessionId);
}

type SessionState = {
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  initInfo: SessionInitInfo | null;
  permRequest: PermissionRequest | null;
};

export function ChatApp() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const [input, setInput] = useState('');
  const [pastedImages, setPastedImages] = useState<{ media_type: string; data: string; preview: string }[]>([]);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const clientRef = useRef<ClaudeClient | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const emptyState = (): SessionState => ({ messages: [], partialText: '', isStreaming: false, initInfo: null, permRequest: null });

  const getState = (id: string | null): SessionState => {
    if (!id) return emptyState();
    if (sessionStates[id]) return sessionStates[id];
    // Load persisted messages on first access
    const msgs = loadMessages(id);
    if (msgs.length > 0) {
      const state = { ...emptyState(), messages: msgs };
      // Populate cache synchronously won't work in render, just return it
      return state;
    }
    return emptyState();
  };

  const updateState = useCallback((id: string, fn: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => {
      const current = prev[id] || { ...emptyState(), messages: loadMessages(id) };
      const next = fn(current);
      // Persist messages to localStorage
      if (next.messages !== current.messages) {
        saveMessages(id, next.messages);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  // Initialize client
  useEffect(() => {
    const client = new ClaudeClient(SERVER_URL, {
      onMessage: (sid, msg) => {
        updateState(sid, s => ({ ...s, messages: [...s.messages, msg], partialText: '' }));
      },
      onPartialText: (sid, text) => {
        updateState(sid, s => ({ ...s, partialText: text }));
      },
      onPermissionRequest: (sid, req) => {
        updateState(sid, s => ({ ...s, permRequest: req }));
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
      },
      onTurnComplete: (sid) => {
        updateState(sid, s => ({ ...s, isStreaming: false, partialText: '' }));
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
      // Connect to all running sessions
      for (const s of list) {
        if (s.status !== 'stopped') {
          client.connectSession(s);
        }
      }
      // Select first running session, or just first session
      const running = list.find(s => s.status !== 'stopped');
      if (running) {
        setActiveId(running.id);
      } else if (list.length > 0) {
        setActiveId(list[0]!.id);
      }
    }).catch(() => {});

    return () => client.destroy();
  }, [updateState]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const active = getState(activeId);
  useEffect(() => {
    scrollToBottom();
  }, [active.messages, active.partialText, scrollToBottom]);

  // Re-fetch open file when new messages arrive (file may have been edited)
  useEffect(() => {
    if (!openFile || !client) return;
    client.readFile(openFile.path).then(file => {
      if (file && file.content !== openFile.content) {
        setOpenFile(file);
      }
    }).catch(() => {});
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

  const handleDeleteSession = async (id: string) => {
    await clientRef.current?.deleteSession(id);
    deleteMessages(id);
    setSessions(prev => prev.filter(s => s.id !== id));
    setSessionStates(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setStatuses(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeId === id) {
      const remaining = sessions.filter(s => s.id !== id);
      setActiveId(remaining.length > 0 ? remaining[0]!.id : null);
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

  const handlePermission = (requestId: string, allow: boolean) => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.respondToPermission(activeId, requestId, allow);
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
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const activeStatus = activeId ? (statuses[activeId] || 'disconnected') : 'disconnected';
  const activeSession = sessions.find(s => s.id === activeId);
  const explorerRoot = active.initInfo?.cwd || activeSession?.cwd || null;
  const slashCommands = active.initInfo?.slashCommands || [];
  const slash = useSlashCommands(input, slashCommands);
  const fileMention = useFileMention(input, client, explorerRoot);

  const paletteActions: PaletteAction[] = [
    { id: 'new-session', label: 'New Session', keys: ['command'], key: 'N', section: 'Sessions', onRun: () => setShowNewSession(true) },
    { id: 'focus-input', label: 'Focus Chat Input', keys: ['command'], key: 'L', section: 'Navigation', onRun: () => inputRef.current?.focus() },
    { id: 'toggle-explorer', label: explorerCollapsed ? 'Show File Explorer' : 'Hide File Explorer', keys: ['command'], key: 'B', section: 'Navigation', onRun: () => setExplorerCollapsed(c => !c) },
    { id: 'close-editor', label: 'Close Editor', keys: ['command'], key: 'W', section: 'Navigation', onRun: () => setOpenFile(null) },
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
        {/* Tab bar */}
        <TabBar
          sessions={sessions}
          activeSessionId={activeId}
          sessionStatuses={statuses}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onDelete={handleDeleteSession}
          onRename={handleRenameSession}
        />

        <div className="flex-1 flex min-h-0">
          {/* File Explorer */}
          <FileExplorer
            client={client}
            rootPath={explorerRoot}
            collapsed={explorerCollapsed}
            onToggle={() => setExplorerCollapsed(c => !c)}
            onFileOpen={handleFileOpen}
          />

          <div className="flex-1 flex flex-col min-w-0">
            {!activeId ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-zinc-500 mb-4">No session selected</p>
                  <Button onPress={handleNewSession}>Create a session</Button>
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
                <div className={`flex flex-col min-w-0 ${openFile ? 'w-1/2 border-r border-border' : 'flex-1'}`}>
                  {/* Messages */}
                  <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
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
                      <MessageBubble key={msg.id} message={msg} />
                    ))}
                    {active.isStreaming && !active.partialText && (
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
                      <div className="flex gap-2 items-end">
                        {active.isStreaming && (
                          <Button size="sm" variant="flat" onPress={handleInterrupt}
                            className="shrink-0 text-amber-400">
                            Stop
                          </Button>
                        )}
                        <textarea
                          ref={inputRef}
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          disabled={active.isStreaming || activeStatus !== 'connected'}
                          placeholder="Send a message... (/ commands, @ files)"
                          autoFocus
                          rows={1}
                          className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none outline-none focus:border-zinc-500 transition-colors disabled:opacity-50"
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
                          onKeyDown={(e) => {
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
                        />
                        <Button
                          onPress={handleSend}
                          isDisabled={!input.trim() || active.isStreaming || activeStatus !== 'connected'}
                          className="shrink-0 px-6"
                        >
                          Send
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Editor panel */}
                {openFile && (
                  <div className="w-1/2 flex flex-col min-w-0">
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface">
                      <span className="text-[12px] text-zinc-400 font-mono truncate">
                        {openFile.path.split('/').pop()}
                      </span>
                      <button
                        className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                        onClick={() => setOpenFile(null)}
                      >
                        &times;
                      </button>
                    </div>
                    <div className="flex-1">
                      <Editor
                        path={openFile.path}
                        value={openFile.content}
                        theme="vs-dark"
                        onMount={handleEditorMount}
                        options={{
                          readOnly: true,
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
              </div>

              <PermissionModal request={active.permRequest} onRespond={handlePermission} />
            </>
            )}
          </div>
        </div>

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
          onSearchFiles={explorerRoot && client ? (q) => client.findFiles(explorerRoot, q) : undefined}
          onFileOpen={handleFileOpen}
        />
      </div>
    </Providers>
  );
}
