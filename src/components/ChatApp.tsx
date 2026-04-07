import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, TextField, Input } from '@heroui/react';
import Editor, { type Monaco } from '@monaco-editor/react';
import { Providers } from './Providers';
import { TabBar } from './TabBar';
import { FileExplorer } from './FileExplorer';
import { MessageBubble } from './MessageBubble';
import { PermissionModal } from './PermissionModal';
import { NewSessionModal } from './NewSessionModal';
import { useSlashCommands, SlashCommandList } from './SlashCommandPicker';
import { useFileMention, FileMentionList } from './FileMentionPicker';
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
  const [showNewSession, setShowNewSession] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const clientRef = useRef<ClaudeClient | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

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
    if (!text || !activeId || !clientRef.current) return;

    updateState(activeId, s => ({
      ...s,
      messages: [...s.messages, {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: text,
        timestamp: Date.now(),
      }],
      isStreaming: true,
      partialText: '',
    }));
    setInput('');
    clientRef.current.sendMessage(activeId, text);
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

  const activeStatus = activeId ? (statuses[activeId] || 'disconnected') : 'disconnected';
  const activeSession = sessions.find(s => s.id === activeId);
  const explorerRoot = active.initInfo?.cwd || activeSession?.cwd || null;
  const slashCommands = active.initInfo?.slashCommands || [];
  const slash = useSlashCommands(input, slashCommands);
  const fileMention = useFileMention(input, client, explorerRoot);

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
        const selectedText = selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
        const filePath = openFile?.path || '';
        const relativePath = explorerRoot && filePath.startsWith(explorerRoot)
          ? filePath.slice(explorerRoot.length + 1)
          : filePath;

        let reference: string;
        if (selectedText) {
          const startLine = selection!.startLineNumber;
          const endLine = selection!.endLineNumber;
          const lineRef = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
          reference = `@${relativePath}:${lineRef}\n\`\`\`\n${selectedText}\n\`\`\``;
        } else {
          reference = `@${relativePath}`;
        }

        setInput(prev => {
          const sep = prev && !prev.endsWith(' ') ? ' ' : '';
          return `${prev}${sep}${reference} `;
        });
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
                  <div className="border-t border-border p-4 shrink-0">
                    <form
                      className="flex gap-2 max-w-4xl mx-auto relative"
                      onSubmit={(e) => { e.preventDefault(); if (!slash.isActive && !fileMention.isActive) handleSend(); }}
                    >
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
                      {active.isStreaming && (
                        <Button size="sm" variant="flat" onPress={handleInterrupt}
                          className="shrink-0 text-amber-400">
                          Stop
                        </Button>
                      )}
                      <TextField
                        value={input}
                        onChange={setInput}
                        isDisabled={active.isStreaming || activeStatus !== 'connected'}
                        className="flex-1"
                        aria-label="Message"
                      >
                        <Input
                          placeholder="Send a message... (/ commands, @ files)"
                          autoFocus
                          onKeyDown={(e) => {
                            if (fileMention.isActive) {
                              fileMention.onKeyDown(e, handleFileMentionSelect);
                            } else {
                              slash.onKeyDown(e, handleSlashSelect);
                            }
                          }}
                        />
                      </TextField>
                      <Button
                        type="submit"
                        isDisabled={!input.trim() || active.isStreaming || activeStatus !== 'connected'}
                        className="shrink-0 px-6"
                      >
                        Send
                      </Button>
                    </form>
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
                        defaultValue={openFile.content}
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
      </div>
    </Providers>
  );
}
