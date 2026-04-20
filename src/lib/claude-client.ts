/**
 * Claude Code UI Client — single WebSocket connection to the bridge server.
 * All state lives on the server. The client is a stateless viewer.
 */

export async function resolveServerUrl(): Promise<string> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core');
      const port = await invoke<number>('get_bridge_port');
      return `http://localhost:${port}`;
    } catch (e) {
      console.error('Bridge server not found:', e);
    }
  }
  return (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3111';
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  seq?: number;
  images?: { media_type: string; data: string }[];
  toolName?: string;
  toolInput?: unknown;
  isToolResult?: boolean;
  toolUseId?: string;
  toolResult?: ChatMessage;
  autoApproved?: boolean;
  isError?: boolean;
  isTerminal?: boolean;
  terminalCommand?: string;
  exitCode?: number;
  // Interactive PTY terminal (spawned via /terminal or /t slash command).
  isInteractiveTerminal?: boolean;
  procId?: string;
  terminalExited?: boolean;
  terminalExitCode?: number;
  terminalCwd?: string;
  costUsd?: number;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  displayName?: string;
  description?: string;
  input: Record<string, unknown>;
  title?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  created_at: number;
  status: 'starting' | 'running' | 'stopped';
  ready: boolean;
  claude_session_id: string | null;
  ws_url: string;
  saved_commands: string[];
  model: string | null;
  permission_mode: string;
}

export interface SessionInitInfo {
  tools: string[];
  cwd: string;
  version: string;
  slashCommands: string[];
  model: string;
  permissionMode: string;
}

export interface SessionState {
  messages: ChatMessage[];
  partialText: string;
  isStreaming: boolean;
  permRequest: PermissionRequest | null;
  initInfo: SessionInitInfo | null;
  // UI state
  input: string;
  inputHistory: string[];
  openFile: { path: string; content: string; line?: number } | null;
  openTerminalId: string | null;
  diffView: { path: string; original: string; modified: string } | null;
  editorFullWidth: boolean;
  reviewMode: boolean;
  reviewComments: Record<string, unknown[]>;
  reviewFiles: string[];
  reviewIndex: number;
  todos: { content: string; status: string; activeForm?: string }[];
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

type ClientCallbacks = {
  onSessions: (sessions: SessionInfo[]) => void;
  onSessionState: (sessionId: string, state: SessionState) => void;
  onMessage: (sessionId: string, msg: ChatMessage) => void;
  onPartialText: (sessionId: string, text: string) => void;
  onPermissionRequest: (sessionId: string, req: PermissionRequest) => void;
  onPermissionCancelled: (sessionId: string, requestId: string) => void;
  onStatus: (sessionId: string, status: string) => void;
  onTerminalData: (sessionId: string, procId: string, text: string) => void;
  onTerminalExit: (sessionId: string, procId: string, code: number) => void;
  onTodos: (sessionId: string, todos: { content: string; status: string; activeForm?: string }[]) => void;
  onAutoApproved: (sessionId: string, toolName: string, filePath?: string, command?: string) => void;
  onSessionName: (sessionId: string, name: string) => void;
  onInitInfo: (sessionId: string, info: SessionInitInfo) => void;
  onConnectionChange: (status: ConnectionStatus) => void;
};

export class ClaudeClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private callbacks: ClientCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  // Per-procId listeners for interactive terminals (xterm.js subscribers).
  // Populated by `onTerminalDataForProc` / `onTerminalExitForProc`; fired
  // from the WS message handler so xterm receives the raw byte stream
  // without going through React state.
  private termDataSubs = new Map<string, Set<(text: string) => void>>();
  private termExitSubs = new Map<string, Set<(code: number) => void>>();

  constructor(serverUrl: string, callbacks: ClientCallbacks) {
    this.serverUrl = serverUrl;
    this.callbacks = callbacks;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;
    const wsUrl = this.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
    this.callbacks.onConnectionChange('connecting');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.callbacks.onConnectionChange('connected');
      // Server sends session list automatically on connect — no need to request
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {}
    };

    ws.onclose = () => {
      this.callbacks.onConnectionChange('disconnected');
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    ws.onerror = () => {
      this.callbacks.onConnectionChange('error');
    };
  }

  private handleMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;
    const sessionId = msg.sessionId as string;

    switch (type) {
      case 'sessions':
        this.callbacks.onSessions(msg.sessions as SessionInfo[]);
        break;
      case 'session_state':
        this.callbacks.onSessionState(sessionId, msg.state as SessionState);
        break;
      case 'message':
        this.callbacks.onMessage(sessionId, msg.message as ChatMessage);
        break;
      case 'partial_text':
        this.callbacks.onPartialText(sessionId, msg.text as string);
        break;
      case 'permission_request':
        this.callbacks.onPermissionRequest(sessionId, msg.request as PermissionRequest);
        break;
      case 'permission_cancelled':
        this.callbacks.onPermissionCancelled(sessionId, msg.requestId as string);
        break;
      case 'status':
        this.callbacks.onStatus(sessionId, msg.status as string);
        break;
      case 'terminal_data': {
        const procId = msg.procId as string;
        const text = msg.text as string;
        this.callbacks.onTerminalData(sessionId, procId, text);
        const subs = this.termDataSubs.get(procId);
        if (subs) for (const cb of subs) { try { cb(text); } catch {} }
        break;
      }
      case 'terminal_exit': {
        const procId = msg.procId as string;
        const code = msg.code as number;
        this.callbacks.onTerminalExit(sessionId, procId, code);
        const subs = this.termExitSubs.get(procId);
        if (subs) for (const cb of subs) { try { cb(code); } catch {} }
        break;
      }
      case 'todos':
        this.callbacks.onTodos(sessionId, msg.todos as any[]);
        break;
      case 'auto_approved':
        this.callbacks.onAutoApproved(sessionId, msg.toolName as string, msg.filePath as string | undefined, msg.command as string | undefined);
        break;
      case 'session_name':
        this.callbacks.onSessionName(sessionId, msg.name as string);
        break;
      case 'init_info':
        this.callbacks.onInitInfo(sessionId, msg.info as SessionInitInfo);
        break;
    }
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  subscribe(sessionId: string) { this.send({ type: 'subscribe', sessionId }); }
  unsubscribe(sessionId: string) { this.send({ type: 'unsubscribe', sessionId }); }
  getSessionState(sessionId: string) { this.send({ type: 'get_session_state', sessionId }); }
  getSessions() { this.send({ type: 'get_sessions' }); }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  sendMessage(sessionId: string, text: string, images?: { media_type: string; data: string }[]) {
    this.send({ type: 'send_message', sessionId, text, images });
  }

  respondToPermission(sessionId: string, requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) {
    this.send({ type: 'permission_response', sessionId, requestId, allow, updatedInput });
  }

  interrupt(sessionId: string) {
    this.send({ type: 'interrupt', sessionId });
  }

  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  execCommand(sessionId: string, command: string, cwd: string, procId?: string) {
    this.send({ type: 'exec', sessionId, command, cwd, procId });
  }

  killProcess(sessionId: string, processId?: string, pid?: number) {
    this.send({ type: 'kill_process', sessionId, processId, pid });
  }

  // ---- Interactive PTY (/terminal slash command) ----
  execShell(sessionId: string, procId: string, cwd: string, cols: number, rows: number) {
    this.send({ type: 'exec_shell', sessionId, procId, cwd, cols, rows });
  }

  sendTerminalInput(sessionId: string, procId: string, data: string) {
    this.send({ type: 'terminal_input', sessionId, procId, data });
  }

  resizeTerminal(sessionId: string, procId: string, cols: number, rows: number) {
    this.send({ type: 'terminal_resize', sessionId, procId, cols, rows });
  }

  killTerminal(sessionId: string, procId: string) {
    this.send({ type: 'terminal_kill', sessionId, procId });
  }

  /** Subscribe to raw terminal_data chunks for a specific procId. Used by
   *  InteractiveTerminalBubble to stream bytes straight into xterm.js.
   *  Returns an unsubscribe function. */
  onTerminalDataForProc(procId: string, cb: (text: string) => void): () => void {
    let subs = this.termDataSubs.get(procId);
    if (!subs) { subs = new Set(); this.termDataSubs.set(procId, subs); }
    subs.add(cb);
    return () => {
      const s = this.termDataSubs.get(procId);
      s?.delete(cb);
      if (s && s.size === 0) this.termDataSubs.delete(procId);
    };
  }

  onTerminalExitForProc(procId: string, cb: (code: number) => void): () => void {
    let subs = this.termExitSubs.get(procId);
    if (!subs) { subs = new Set(); this.termExitSubs.set(procId, subs); }
    subs.add(cb);
    return () => {
      const s = this.termExitSubs.get(procId);
      s?.delete(cb);
      if (s && s.size === 0) this.termExitSubs.delete(procId);
    };
  }

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------

  updateUIState(sessionId: string, state: Record<string, unknown>) {
    this.send({ type: 'update_ui_state', sessionId, state });
  }

  setModel(sessionId: string, model: string) {
    this.send({ type: 'set_model', sessionId, model });
  }

  setPermissionMode(sessionId: string, mode: string) {
    this.send({ type: 'set_permission_mode', sessionId, mode });
  }

  // ---------------------------------------------------------------------------
  // REST endpoints (still needed for file ops, git, etc.)
  // ---------------------------------------------------------------------------

  async createSession(cwd?: string, name?: string, model?: string): Promise<SessionInfo> {
    const resp = await fetch(`${this.serverUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: cwd || '/', name, model }),
    });
    if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
    return resp.json();
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    const resp = await fetch(`${this.serverUrl}/sessions/${sessionId}/resume`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Failed to resume: ${resp.status}`);
    return resp.json();
  }

  async renameSession(sessionId: string, name: string): Promise<SessionInfo> {
    const resp = await fetch(`${this.serverUrl}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`Failed to rename: ${resp.status}`);
    return resp.json();
  }

  async stopSession(sessionId: string): Promise<void> {
    await fetch(`${this.serverUrl}/sessions/${sessionId}/stop`, { method: 'POST' });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fetch(`${this.serverUrl}/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async updateSession(sessionId: string, updates: { permissionMode?: string }): Promise<SessionInfo> {
    const resp = await fetch(`${this.serverUrl}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!resp.ok) throw new Error(`Failed to update: ${resp.status}`);
    return resp.json();
  }

  async listDirs(prefix: string): Promise<string[]> {
    const resp = await fetch(`${this.serverUrl}/ls?prefix=${encodeURIComponent(prefix)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async listFiles(dirPath: string): Promise<{ name: string; path: string; type: string }[]> {
    const resp = await fetch(`${this.serverUrl}/files?path=${encodeURIComponent(dirPath)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async readFile(path: string): Promise<{ path: string; content: string } | null> {
    const resp = await fetch(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    const resp = await fetch(`${this.serverUrl}/file-content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return resp.ok;
  }

  async readFileOriginal(path: string): Promise<string> {
    const resp = await fetch(`${this.serverUrl}/file-original?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.content || '';
  }

  async getGitInfo(path: string): Promise<{
    is_git: boolean; branch?: string; top_level?: string;
    worktrees?: { path: string; branch: string }[];
    package_manager?: string; has_env?: boolean;
  }> {
    const resp = await fetch(`${this.serverUrl}/git-info?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return { is_git: false };
    return resp.json();
  }

  async getGitModified(root: string): Promise<{ path: string; staged: boolean; untracked?: boolean }[]> {
    const resp = await fetch(`${this.serverUrl}/git-modified?root=${encodeURIComponent(root)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async gitStage(root: string, files: string[], unstage = false): Promise<boolean> {
    const resp = await fetch(`${this.serverUrl}/git-stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, files, unstage }),
    });
    return resp.ok;
  }

  async listBranches(cwd: string): Promise<{ current: string; local: string[]; remote: string[] }> {
    const resp = await fetch(`${this.serverUrl}/git-branches?cwd=${encodeURIComponent(cwd)}`);
    if (!resp.ok) return { current: '', local: [], remote: [] };
    return resp.json();
  }

  async checkoutBranch(cwd: string, branch: string): Promise<{ ok: boolean; branch?: string; error?: string }> {
    const resp = await fetch(`${this.serverUrl}/git-checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, branch }),
    });
    return resp.json();
  }

  async searchFiles(root: string, query: string): Promise<{ file: string; line: number; text: string }[]> {
    const params = new URLSearchParams({ root, q: query });
    const resp = await fetch(`${this.serverUrl}/search?${params}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.results || [];
  }

  async listPullRequests(cwd: string, sessionName?: string): Promise<{ number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[]> {
    const params = new URLSearchParams({ cwd });
    if (sessionName) params.set('session', sessionName);
    const resp = await fetch(`${this.serverUrl}/gh-prs?${params}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async listProcesses(sessionId: string): Promise<{ id: string; pid: number; command: string; cwd: string; startedAt: number; exitCode?: number | null; output?: string; children: { pid: number; command: string }[] }[]> {
    const resp = await fetch(`${this.serverUrl}/processes?sessionId=${sessionId}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async saveCommands(sessionId: string, commands: string[]): Promise<void> {
    await fetch(`${this.serverUrl}/save-commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, commands }),
    });
  }

  async getFileIndex(root: string): Promise<{ name: string; path: string; rel: string }[]> {
    const resp = await fetch(`${this.serverUrl}/file-index?root=${encodeURIComponent(root)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  createWorktree(
    repoPath: string,
    branch: string,
    opts: { copy_env?: boolean; install_deps?: boolean; copy_node_modules?: boolean; link_node_modules?: boolean; package_manager?: string },
    callbacks: {
      onLog: (line: string) => void;
      onDone: (result: { path: string; branch: string }) => void;
      onError: (err: string) => void;
    },
  ): { abort: () => void } {
    const ctrl = new AbortController();
    fetch(`${this.serverUrl}/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_path: repoPath, branch, ...opts }),
      signal: ctrl.signal,
    }).then(async (resp) => {
      if (!resp.ok || !resp.body) { callbacks.onError(`HTTP ${resp.status}`); return; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: log')) continue;
          if (line.startsWith('event: done')) continue;
          if (line.startsWith('event: error')) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (typeof data === 'string') callbacks.onLog(data);
              else if (data.path) callbacks.onDone(data);
              else if (data.error) callbacks.onError(data.error);
            } catch {}
          }
        }
      }
    }).catch((e) => { if (!ctrl.signal.aborted) callbacks.onError(e.message); });
    return { abort: () => ctrl.abort() };
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
