export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: unknown;
  isToolResult?: boolean;
  isError?: boolean;
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
}

export interface SessionInitInfo {
  tools: string[];
  cwd: string;
  version: string;
  slashCommands: string[];
}

type ClientCallbacks = {
  onMessage: (sessionId: string, msg: ChatMessage) => void;
  onPartialText: (sessionId: string, text: string) => void;
  onPermissionRequest: (sessionId: string, req: PermissionRequest) => void;
  onPermissionCancelled: (sessionId: string, requestId: string) => void;
  onStatusChange: (sessionId: string, status: ConnectionStatus) => void;
  onSessionInit: (sessionId: string, info: SessionInitInfo) => void;
  onTurnComplete: (sessionId: string) => void;
  onSessionNameUpdate: (sessionId: string, name: string) => void;
};

type ActiveSession = {
  ws: WebSocket;
  partialText: string;
  wsBuffer: string;
};

export class ClaudeClient {
  private activeSessions = new Map<string, ActiveSession>();
  private serverUrl: string;
  private callbacks: ClientCallbacks;

  private unloadHandler: (() => void) | null = null;

  constructor(serverUrl: string, callbacks: ClientCallbacks) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.callbacks = callbacks;

    // Close all WebSockets on page unload/refresh
    this.unloadHandler = () => this.disconnectAll();
    window.addEventListener('beforeunload', this.unloadHandler);
  }

  disconnectAll(): void {
    for (const [id, active] of this.activeSessions) {
      active.ws.close(1000, 'page unload');
    }
    this.activeSessions.clear();
  }

  destroy(): void {
    this.disconnectAll();
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await fetch(`${this.serverUrl}/sessions`);
    if (!resp.ok) throw new Error(`Failed to list sessions: ${resp.status}`);
    return resp.json();
  }

  async createSession(cwd?: string, name?: string): Promise<SessionInfo> {
    const resp = await fetch(`${this.serverUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: cwd || '/', name }),
    });
    if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
    return resp.json();
  }

  async listDirs(prefix: string): Promise<string[]> {
    const resp = await fetch(`${this.serverUrl}/ls?prefix=${encodeURIComponent(prefix)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async listFiles(path: string): Promise<{ name: string; type: 'file' | 'dir'; path: string }[]> {
    const resp = await fetch(`${this.serverUrl}/files?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async findFiles(root: string, query: string): Promise<{ name: string; path: string; rel: string }[]> {
    const resp = await fetch(`${this.serverUrl}/find-files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async readFile(path: string): Promise<{ path: string; content: string } | null> {
    const resp = await fetch(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return null;
    return resp.json();
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

  /**
   * Create a worktree with streamed setup logs.
   * Returns callbacks for log lines, completion, and errors.
   */
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
      if (!resp.ok || !resp.body) {
        callbacks.onError(`HTTP ${resp.status}`);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotDone = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data = line.slice(6);
            }
            if (event === 'log') callbacks.onLog(data);
            else if (event === 'done') {
              gotDone = true;
              try { callbacks.onDone(JSON.parse(data)); } catch {}
            }
            else if (event === 'error') { gotDone = true; callbacks.onError(data); }
          }
        }
      } catch {
        // Stream closed — ignore if we already got a done/error event
      }
      if (!gotDone) {
        // Stream ended without done/error — treat as unexpected close
      }
    }).catch((e) => {
      if (e.name !== 'AbortError') callbacks.onError(String(e));
    });

    return { abort: () => ctrl.abort() };
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

  async deleteSession(sessionId: string): Promise<void> {
    this.disconnectSession(sessionId);
    await fetch(`${this.serverUrl}/sessions/${sessionId}`, { method: 'DELETE' });
  }

  connectSession(session: SessionInfo): void {
    if (this.activeSessions.has(session.id)) return;

    this.callbacks.onStatusChange(session.id, 'connecting');

    const ws = new WebSocket(session.ws_url);
    const active: ActiveSession = { ws, partialText: '', wsBuffer: '' };
    this.activeSessions.set(session.id, active);

    ws.onopen = () => {
      console.log(`[ws:${session.id.slice(0,8)}] Browser WS opened, waiting for claude_connected`);
    };

    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      console.log(`[ws:${session.id.slice(0,8)}] Raw frame (${data.length} bytes):`, data.slice(0, 200));
      active.wsBuffer += data;

      const parts = active.wsBuffer.split('\n');
      active.wsBuffer = parts.pop() || '';
      console.log(`[ws:${session.id.slice(0,8)}] Split into ${parts.length} lines, buffer remaining: ${active.wsBuffer.length} bytes`);
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          console.log(`[ws:${session.id.slice(0,8)}] Parsed message type=${msg.type} subtype=${msg.subtype || ''}`);
          this.handleMessage(session.id, msg);
        } catch (e) {
          console.warn(`[ws:${session.id.slice(0,8)}] Parse failed:`, trimmed.slice(0, 200), e);
        }
      }
    };

    ws.onclose = (event) => {
      console.log(`[ws:${session.id.slice(0,8)}] WS closed code=${event.code} reason=${event.reason}`);
      this.activeSessions.delete(session.id);
      this.callbacks.onStatusChange(session.id, 'disconnected');
    };

    ws.onerror = (event) => {
      console.error(`[ws:${session.id.slice(0,8)}] WS error`, event);
      this.callbacks.onStatusChange(session.id, 'error');
    };
  }

  disconnectSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      active.ws.close();
      this.activeSessions.delete(sessionId);
    }
  }

  private handleMessage(sessionId: string, msg: Record<string, unknown>): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;

    const type = msg.type as string;

    switch (type) {
      case 'bridge': {
        const bridgeStatus = msg.status as string;
        if (bridgeStatus === 'claude_connected') {
          this.callbacks.onStatusChange(sessionId, 'connected');
        } else if (bridgeStatus === 'claude_disconnected' || bridgeStatus === 'claude_exited') {
          this.callbacks.onTurnComplete(sessionId);
        }
        break;
      }

      case 'user': {
        // Replayed user messages from --replay-user-messages — skip, we have them in localStorage
        break;
      }

      case 'system': {
        if ((msg.subtype as string) === 'init') {
          this.callbacks.onSessionInit(sessionId, {
            tools: (msg.tools as string[]) || [],
            cwd: (msg.cwd as string) || '',
            version: (msg.claude_code_version as string) || '',
            slashCommands: (msg.slash_commands as string[]) || (msg.skills as string[]) || [],
          });
        }
        break;
      }

      case 'assistant': {
        const message = msg.message as Record<string, unknown>;
        const content = message?.content as Array<Record<string, unknown>>;
        if (!content) break;

        const id = (msg.uuid as string) || crypto.randomUUID();
        active.partialText = '';

        for (const block of content) {
          if (block.type === 'text') {
            active.partialText += block.text as string;
          } else if (block.type === 'tool_use') {
            if (active.partialText.trim()) {
              this.callbacks.onMessage(sessionId, {
                id: `${id}-text`,
                role: 'assistant',
                content: active.partialText,
                timestamp: Date.now(),
              });
              active.partialText = '';
            }
            this.callbacks.onMessage(sessionId, {
              id: (block.id as string) || `${id}-tool`,
              role: 'assistant',
              content: `Using tool: **${block.name}**`,
              timestamp: Date.now(),
              toolName: block.name as string,
              toolInput: block.input,
            });
          }
        }

        if (active.partialText.trim()) {
          this.callbacks.onMessage(sessionId, {
            id,
            role: 'assistant',
            content: active.partialText,
            timestamp: Date.now(),
          });

          // Auto-name: use first assistant text as session name
          const namePreview = active.partialText.slice(0, 40).replace(/\n/g, ' ');
          this.callbacks.onSessionNameUpdate(sessionId, namePreview);

          active.partialText = '';
        }
        break;
      }

      case 'stream_event': {
        const event = msg.event as Record<string, unknown>;
        if (!event) break;
        if ((event.type as string) === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === 'text_delta') {
            active.partialText += delta.text as string;
            this.callbacks.onPartialText(sessionId, active.partialText);
          }
        }
        break;
      }

      case 'control_request': {
        const request = msg.request as Record<string, unknown>;
        if (request?.subtype === 'can_use_tool') {
          this.callbacks.onPermissionRequest(sessionId, {
            requestId: msg.request_id as string,
            toolName: request.tool_name as string,
            displayName: request.display_name as string | undefined,
            description: request.description as string | undefined,
            input: request.input as Record<string, unknown>,
            title: request.title as string | undefined,
          });
        }
        break;
      }

      case 'control_cancel_request': {
        this.callbacks.onPermissionCancelled(sessionId, msg.request_id as string);
        break;
      }

      case 'result': {
        this.callbacks.onMessage(sessionId, {
          id: (msg.uuid as string) || crypto.randomUUID(),
          role: 'system',
          content: msg.subtype === 'success'
            ? 'Turn complete'
            : `Error: ${((msg.errors as string[]) || []).join(', ') || 'Unknown error'}`,
          timestamp: Date.now(),
          isError: msg.is_error as boolean,
          costUsd: msg.total_cost_usd as number | undefined,
          durationMs: msg.duration_ms as number | undefined,
          usage: msg.usage as { input_tokens: number; output_tokens: number } | undefined,
        });
        this.callbacks.onTurnComplete(sessionId);
        break;
      }
    }
  }

  sendMessage(sessionId: string, text: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active || active.ws.readyState !== WebSocket.OPEN) return;

    active.ws.send(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: sessionId,
    }));
  }

  respondToPermission(sessionId: string, requestId: string, allow: boolean): void {
    const active = this.activeSessions.get(sessionId);
    if (!active || active.ws.readyState !== WebSocket.OPEN) return;

    active.ws.send(JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'Denied by user' },
      },
    }));
  }

  interrupt(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (!active || active.ws.readyState !== WebSocket.OPEN) return;

    active.ws.send(JSON.stringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    }));
  }
}
