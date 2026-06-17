/**
 * Codiby Code Client — single WebSocket connection to the bridge server.
 * All state lives on the server. The client is a stateless viewer.
 */

export async function resolveServerUrl(): Promise<string> {
  const native = (typeof window !== 'undefined') ? window.codiby : null;
  if (native) {
    try {
      const port = await native.invoke<number>('get_bridge_port');
      return `http://localhost:${port}`;
    } catch (e) {
      console.error('Bridge server not found:', e);
    }
  }
  // Mobile / browser case — use the same origin we were loaded from when
  // running outside the desktop app. Falls back to PUBLIC_CLAUDE_SERVER_URL
  // or :3111.
  if (typeof window !== 'undefined' && window.location?.origin && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  return (import.meta as any).env?.PUBLIC_CLAUDE_SERVER_URL || 'http://localhost:3111';
}

// ---------------------------------------------------------------------------
// Claude-hook shapes — re-declared here (instead of imported from server/)
// so the frontend bundle doesn't drag server-side modules in. Must stay in
// lock-step with server/claude-settings.ts.

export type HookScope = 'global' | 'project';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

export type ClaudeHooks = Partial<Record<HookEvent, HookEntry[]>>;

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServerType = 'stdio' | 'http' | 'sse' | 'sdk' | 'unknown';
export type McpServerScope = 'user' | 'project';

/** One row in the MCP manager. `source` distinguishes bridge built-ins (not
 *  removable) from user/project config entries. */
export interface McpServerView {
  name: string;
  type: McpServerType;
  url?: string;
  command?: string;
  args?: string[];
  source: McpServerScope | 'builtin';
  removable: boolean;
}

/** Payload for adding a server. Only the fields for the chosen `type` are read
 *  server-side. */
export interface McpServerInput {
  scope: McpServerScope;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Required when scope is 'project' — the session cwd whose .mcp.json to write. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Mobile auth token (bearer token used by phones on the LAN)
// ---------------------------------------------------------------------------

let _authToken: string | null = null;

/** Set (or clear) the bearer token sent with every HTTP/WS call. */
export function setAuthToken(token: string | null): void {
  _authToken = token && token.length > 0 ? token : null;
}

export function getAuthToken(): string | null {
  return _authToken;
}

/** Append `t=<token>` to a URL string when an auth token is set. */
function withToken(url: string): string {
  if (!_authToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${encodeURIComponent(_authToken)}`;
}

// ---------------------------------------------------------------------------
// Active remote — set by the UI when the focused session lives on a remote.
// `withActiveRemote` injects `?remoteId=` on session-agnostic endpoints (file
// browse, git, search, …) so the local bun bridge proxies them through the
// SSH tunnel. Endpoints that resolve `remoteId` from their own state
// (`/sessions/*`, `/remotes/*`) are not touched.
// ---------------------------------------------------------------------------

let _activeRemoteId: string | null = null;

export function setActiveRemoteId(id: string | null): void {
  _activeRemoteId = id && id.length > 0 ? id : null;
}

/** Append `remoteId=<active>` if the focused session lives on a remote and
 *  the URL doesn't already carry one. No-op on local sessions. */
function withActiveRemote(url: string): string {
  if (!_activeRemoteId) return url;
  if (url.includes('remoteId=')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}remoteId=${encodeURIComponent(_activeRemoteId)}`;
}

/** Build fetch init with Authorization header when a token is set. */
function authedInit(init?: RequestInit): RequestInit {
  if (!_authToken) return init || {};
  const headers = new Headers(init?.headers || {});
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${_authToken}`);
  return { ...(init || {}), headers };
}

/** Fetch wrapper that injects the bearer token on the way out. */
async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(withToken(input), authedInit(init));
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
  /**
   * When this message was produced by a sub-agent (spawned via the Agent
   * tool), this is the `tool_use` id of the parent Agent invocation.
   * `groupMessages()` uses it to nest every sub-agent tool call, tool
   * result, and text bubble inside the Agent card.
   */
  parentToolUseId?: string | null;
  autoApproved?: boolean;
  isError?: boolean;
  /**
   * Set on assistant messages whose `content` is the model's reasoning
   * summary (Anthropic `thinking` / `redacted_thinking` block). Rendered as
   * a collapsible dim bubble — distinct from regular assistant text.
   */
  isThinking?: boolean;
  /** True when the underlying block was `redacted_thinking` (content is a
   *  placeholder; the real reasoning is encrypted by the API). */
  thinkingRedacted?: boolean;
  isTerminal?: boolean;
  terminalCommand?: string;
  exitCode?: number;
  /** Set on `isTerminal` messages produced by the `spawn_terminal` SDK tool.
   *  These render inline in the chat (legacy `isTerminal` reattach messages
   *  without this flag stay hidden until opened from the Processes panel). */
  isManagedTerminal?: boolean;
  // Interactive PTY terminal (spawned via /terminal or /t slash command).
  isInteractiveTerminal?: boolean;
  procId?: string;
  terminalExited?: boolean;
  terminalExitCode?: number;
  terminalCwd?: string;
  /** Display name for the terminal — shown as the chat launch chip's
   *  title and as the tab label in the terminals panel. Set by tools
   *  that spawn named terminals (e.g. `actions_run` sets this to the
   *  action's name) so the chat shows "api" instead of the full
   *  portless wrapper command. */
  terminalName?: string;
  /** Best-effort URL the terminal serves at. Set by `actions_run` to
   *  the portless hostname (e.g. `https://api.localhost`). May be
   *  refined to the actual proxy port via `portless_url_resolved`
   *  events kept in component state. */
  terminalUrl?: string;
  costUsd?: number;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  /**
   * Local-only flag for user messages typed while a turn was still streaming.
   * Rendered as a faded "queued" bubble in the message list; flipped to
   * `false` (or stripped) when the queue drains and the message ships.
   */
  isPending?: boolean;
  /**
   * Local-only delivery lifecycle for user messages composed while the session
   * was not connected (remote bridge offline / runtime stopped). `'sending'`
   * shows a loader while we wait for the session to reconnect and accept it;
   * `'failed'` is set when the delivery timeout elapses, surfacing a Retry
   * button. Undefined once the message ships normally.
   */
  deliveryStatus?: 'sending' | 'failed';
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
  /** Last meaningful activity (message, archive toggle, rename). Used to
   *  sort the archived list "most recent first". */
  updated_at: number;
  /** UI lifecycle: 'open' tabs are visible, 'archived' are hidden. */
  status: 'open' | 'archived';
  /** Live process state for the underlying provider (Claude/Codex/etc). */
  runtime_status: 'starting' | 'running' | 'stopped';
  ready: boolean;
  claude_session_id: string | null;
  ws_url: string;
  saved_commands: string[];
  model: string | null;
  permission_mode: string;
  provider?: string;
  /** Remote workstation this session lives on (null = local). */
  remoteId?: string | null;
  /** Display color of the remote (drives tab tint). */
  remoteColor?: string | null;
  /** Display name of the remote (shown in tooltips / labels). */
  remoteName?: string | null;
}

export interface SessionInitInfo {
  tools: string[];
  cwd: string;
  version: string;
  slashCommands: string[];
  model: string;
  permissionMode: string;
}

/**
 * Provider-side descriptor for one selectable model. Streamed in via the
 * `supported_models` WS message once the live session has reported its
 * available models; consumed by the model picker.
 */
export interface SupportedModel {
  id: string;
  label: string;
  description?: string;
}

export interface SessionState {
  messages: ChatMessage[];
  partialText: string;
  /**
   * Live-streaming thinking text. Updates with each `partial_thinking` WS
   * event as Claude reasons; cleared when the matching permanent
   * `isThinking` ChatMessage arrives or the turn ends. Rendered as a
   * transient italic bubble that morphs into the persisted ThinkingBubble.
   */
  partialThinking: string;
  isStreaming: boolean;
  /** Set by the server when the previous turn died without onTurnComplete. */
  wasInterrupted: boolean;
  permRequest: PermissionRequest | null;
  initInfo: SessionInitInfo | null;
  /** Live model list for the picker. Empty until the provider reports in. */
  supportedModels: SupportedModel[];
  // UI state
  input: string;
  inputHistory: string[];
  /** Open editor tabs (VSCode-style). At most one is a `preview` tab, which is
   *  replaced when the next file opens unless pinned (double-click) or modified.
   *  `content` is the on-disk/last-saved baseline; live unsaved edits live in
   *  Monaco and a host-side buffer. UI-only — preserved across server merges. */
  editorTabs: { path: string; content: string; line?: number; column?: number; dirty: boolean; preview: boolean; readOnly?: boolean; deleted?: boolean; image?: boolean }[];
  /** Path of the revealed editor tab, or null when none is open. */
  activeEditorPath: string | null;
  /** Unified "reveal this tab" signal for the PanelsWorkspace, shared by editor
   *  and browser tabs. `panelFocusSeq` bumps each time so re-focusing an already
   *  open tab still surfaces it. */
  panelFocusTabId: string | null;
  panelFocusSeq: number;
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

/** How the bridge server was launched. Informational only — session spawn is
 *  always lazy now (the server boots a provider when the user focuses a tab
 *  via `notifyActiveTab` or a message arrives for it). Kept on the welcome
 *  message for telemetry / future use. */
export type SpawnMode = 'app' | 'service';

/** A single filesystem change reported by the server-side session watcher.
 *  `path` is relative to the session cwd, POSIX-separated. Kept in lock-step
 *  with `FileChange` in server/watcher.ts. */
export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export type FileChange = {
  kind: FileChangeKind;
  path: string;
  isDir: boolean;
};

type ClientCallbacks = {
  onSessions: (sessions: SessionInfo[]) => void;
  onSessionState: (sessionId: string, state: SessionState) => void;
  onMessage: (sessionId: string, msg: ChatMessage) => void;
  onPartialText: (sessionId: string, text: string) => void;
  onPartialThinking: (sessionId: string, text: string) => void;
  onPermissionRequest: (sessionId: string, req: PermissionRequest) => void;
  onPermissionCancelled: (sessionId: string, requestId: string) => void;
  onStatus: (sessionId: string, status: string) => void;
  onTerminalData: (sessionId: string, procId: string, text: string) => void;
  onTerminalExit: (sessionId: string, procId: string, code: number) => void;
  onTodos: (sessionId: string, todos: { content: string; status: string; activeForm?: string }[]) => void;
  onAutoApproved: (sessionId: string, toolName: string, filePath?: string, command?: string) => void;
  onSessionName: (sessionId: string, name: string) => void;
  onInitInfo: (sessionId: string, info: SessionInitInfo) => void;
  onSupportedModels: (sessionId: string, models: SupportedModel[]) => void;
  onOpenFile: (sessionId: string, path: string, line: number | null) => void;
  onOpenMockup: (sessionId: string, name: string, html: string) => void;
  /** A named browser preview was opened or re-navigated. `name` identifies
   *  which preview within the session (multiple can co-exist). Same name +
   *  same URL reuses the existing OS-level webview; different URL navigates
   *  it; new name opens a fresh preview. `cookieJar` selects the cookie/
   *  storage partition; previews sharing a jar name share cookies, different
   *  jars are fully isolated. Defaults to "default" when the server omits it. */
  onOpenBrowser: (sessionId: string, name: string, url: string, title: string, cookieJar: string) => void;
  onCloseBrowser: (sessionId: string, name: string) => void;
  /** Server-initiated "make this preview the active tab" hint. Emitted by
   *  action-style browser_* SDK tools so the user sees which preview the
   *  agent is driving. The host should only switch when a preview with
   *  `name` is currently open in the session — otherwise ignore. */
  onFocusBrowser: (sessionId: string, name: string) => void;
  /**
   * Bridge → frontend CDP request channel. The bridge issues `browser_request`
   * over the WS when an SDK tool (browser_snapshot / browser_click / etc.)
   * runs; the desktop frontend forwards to Electron main via the
   * `window.codiby.invoke('cdp_<action>', args)` and replies with
   * `respondBrowserRequest`. Optional — non-Electron viewers can leave it
   * unimplemented; the bridge times out and the tool reports failure.
   */
  onBrowserRequest?: (req: { sessionId: string; name: string; requestId: string; action: string; args: unknown }) => void;
  onPreferences: (preferences: Record<string, unknown>) => void;
  onFocusSession: (sessionId: string) => void;
  /** Tunnel status for a remote changed. Used by the chat header chip to
   *  show "tunnel offline" / "reconnecting" without polling. Optional —
   *  consumers that don't show remote UI can omit it. */
  onRemoteStatus?: (remoteId: string, status: 'connecting' | 'online' | 'reconnecting' | 'offline', lastError: string | null) => void;
  /** Server broadcasts this when a session was cleared in place
   *  (`/clear` on a tab that can't be archived). The UI should drop the
   *  in-memory chat history for the session so the next replay/render
   *  starts from an empty log. */
  onSessionCleared?: (sessionId: string) => void;
  onWelcome: (info: { spawnMode: SpawnMode }) => void;
  /** A Portless action's runtime status changed. Optional — viewers that
   *  don't surface Portless UI can omit it. */
  onPortlessStatus?: (status: PortlessActionStatus) => void;
  /** A Portless action was just started. Drives the action-fired toast,
   *  separate from status transitions. */
  onPortlessFired?: (info: { action: PortlessActionStatus; source: 'user' | 'agent'; sessionId?: string }) => void;
  /** Resolved Portless URL — fires after the proxy boots and we know the
   *  actual port it's listening on (typically a high one like :1355 when
   *  portless can't bind :443). Components should replace the optimistic
   *  `https://<host>` they were showing with this URL. */
  onPortlessUrlResolved?: (info: { key: string; groupId: string; actionId: string; url: string }) => void;
  /** A terminal bubble was dismissed (× clicked anywhere or on another
   *  viewer). The bridge owns the dismissed set — receiving this event
   *  means the FE should drop the matching bubble from its rendered list. */
  onShellDismissed?: (info: { sessionId: string; procId: string }) => void;
  /** A terminal was spawned and taskr injected cross-action env vars into
   *  it (e.g., `API_URL` for a web-renter shell). The frontend stores
   *  these to power the `env · N` badge in the terminals panel. */
  onTerminalEnvInjected?: (info: { sessionId: string; procId: string; env: Record<string, string> }) => void;
  /** The server-side workspace watcher reported a batch of file/folder changes
   *  for a session. Optional — viewers that don't surface file activity can
   *  omit it. */
  onFileChanges?: (sessionId: string, changes: FileChange[]) => void;
  onConnectionChange: (status: ConnectionStatus) => void;
};

// ---------------------------------------------------------------------------
// Portless types — kept in lock-step with server/portless.ts.
// ---------------------------------------------------------------------------

export type PortlessActionState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'failed';

export interface PortlessActionStatus {
  key: string;
  groupId: string;
  actionId: string;
  name: string;
  command: string;
  hostname: string;
  url: string;
  cwd: string;
  pid: number | null;
  state: PortlessActionState;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  logTail: string[];
}

export interface PortlessCliStatus {
  available: boolean;
  bin: string | null;
  version: string | null;
}

export type PortlessProxyMode = 'default' | 'http80' | 'https443';

export interface PortlessProxyStatus {
  running: boolean;
  port: number | null;
  mode: PortlessProxyMode | null;
}

export interface PortlessProxyActionResult {
  ok: boolean;
  output: string;
  error?: string;
}

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
  // Fired when the server re-attaches us to an existing PTY — bubbles listen
  // so they can call term.reset() before the authoritative output buffer
  // replay arrives on top of whatever stale content they had rendered from
  // their local chat log.
  private termResetSubs = new Map<string, Set<() => void>>();
  // Track active session subscriptions so they can be re-sent after a
  // reconnect — the server doesn't remember them per-WS-id.
  private activeSubs = new Set<string>();
  // Visibility listener (mobile PWA) — re-checks the connection when the
  // user brings the app back to the foreground.
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;
  private pageShowHandler: (() => void) | null = null;

  constructor(serverUrl: string, callbacks: ClientCallbacks) {
    this.serverUrl = serverUrl;
    this.callbacks = callbacks;
    this.connect();
    // Visibility / lifecycle handling:
    //
    //   • Page goes to background → CLOSE the WS so the page stays
    //     bfcache-eligible. An OPEN WebSocket disqualifies the page from
    //     bfcache (per spec), which forces the browser to do a full reload
    //     when the user comes back — the symptom users report as "the
    //     mobile PWA reloads every time I switch back to it".
    //
    //   • Page comes back (visibilitychange / pageshow / pagehide) →
    //     reconnect if needed. On bfcache restore (`pageshow.persisted ===
    //     true`), no JS state was lost so this is just a WS reopen.
    //
    //   • iOS Safari and Android Chrome both fire visibilitychange for
    //     PWA background/foreground; pageshow/pagehide are the bfcache
    //     entry/exit points specifically.
    if (typeof document !== 'undefined') {
      const reconnect = () => {
        if (this.destroyed) return;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          try { this.ws?.close(); } catch {}
          this.ws = null;
          this.connect();
        }
      };
      const closeForBackground = () => {
        if (this.destroyed) return;
        try { this.ws?.close(); } catch {}
        this.ws = null;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      };
      this.visibilityHandler = () => {
        if (this.destroyed) return;
        if (document.visibilityState === 'visible') reconnect();
        else closeForBackground();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      // bfcache hooks — pagehide closes connections so the page can be
      // saved; pageshow restores them.
      this.pageHideHandler = () => closeForBackground();
      this.pageShowHandler = () => reconnect();
      window.addEventListener('pagehide', this.pageHideHandler);
      window.addEventListener('pageshow', this.pageShowHandler);
    }
  }

  private connect() {
    if (this.destroyed) return;
    // Browsers don't allow custom headers on WS upgrades. We pass the bearer
    // token via the URL query string (`?t=<token>`); the server's authCheck
    // accepts it from either Authorization, ?t=, or Sec-WebSocket-Protocol.
    // Subprotocol negotiation is fragile (the server must echo back the same
    // protocol or browsers close the connection immediately), so a query
    // param keeps the handshake completely standard.
    const baseWs = this.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
    const wsUrl = _authToken ? `${baseWs}?t=${encodeURIComponent(_authToken)}` : baseWs;
    this.callbacks.onConnectionChange('connecting');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.callbacks.onConnectionChange('connected');
      // Server sends session list automatically on connect — no need to request
      // Replay any active subscriptions so the new socket starts receiving
      // session_state / message / permission_request for them again.
      for (const sid of this.activeSubs) {
        try { ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid })); } catch {}
      }
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
      case 'partial_thinking':
        this.callbacks.onPartialThinking(sessionId, (msg.text as string) || '');
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
      case 'terminal_reset': {
        // Server is about to replay the PTY's authoritative output buffer
        // (re-attach path). The viewer should wipe its xterm first so the
        // replay doesn't land on top of stale content rendered from the
        // persisted chat log.
        const procId = msg.procId as string;
        const subs = this.termResetSubs.get(procId);
        if (subs) for (const cb of subs) { try { cb(); } catch {} }
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
      case 'supported_models':
        this.callbacks.onSupportedModels(sessionId, (msg.models as SupportedModel[]) || []);
        break;
      case 'open_file':
        this.callbacks.onOpenFile(sessionId, msg.path as string, (msg.line as number | null) ?? null);
        break;
      case 'open_mockup':
        this.callbacks.onOpenMockup(sessionId, msg.name as string, msg.html as string);
        break;
      case 'open_browser':
        this.callbacks.onOpenBrowser(
          sessionId,
          msg.name as string,
          msg.url as string,
          (msg.title as string) || '',
          (msg.cookieJar as string) || 'default',
        );
        break;
      case 'focus_browser':
        this.callbacks.onFocusBrowser(sessionId, msg.name as string);
        break;
      case 'close_browser':
        this.callbacks.onCloseBrowser(sessionId, msg.name as string);
        break;
      case 'browser_request':
        this.callbacks.onBrowserRequest?.({
          sessionId,
          // `name` selects which preview within the session this request
          // targets; the desktop side uses it to build the OS-level
          // webview label (`browser-<sessionId>-<name>`).
          name: msg.name as string,
          requestId: msg.requestId as string,
          action: msg.action as string,
          args: msg.args,
        });
        break;
      case 'remote.status':
        this.callbacks.onRemoteStatus?.(
          msg.remoteId as string,
          msg.status as 'connecting' | 'online' | 'reconnecting' | 'offline',
          (msg.lastError as string | null) ?? null,
        );
        break;
      case 'preferences':
        this.callbacks.onPreferences(msg.preferences as Record<string, unknown>);
        break;
      case 'focus_session':
        this.callbacks.onFocusSession(msg.sessionId as string);
        break;
      case 'session_cleared':
        this.callbacks.onSessionCleared?.(msg.sessionId as string);
        break;
      case 'welcome':
        this.callbacks.onWelcome({ spawnMode: (msg.spawnMode as SpawnMode) || 'service' });
        break;
      case 'portless_status':
        this.callbacks.onPortlessStatus?.(msg.status as PortlessActionStatus);
        break;
      case 'portless_fired':
        this.callbacks.onPortlessFired?.({
          action: msg.action as PortlessActionStatus,
          source: (msg.source as 'user' | 'agent') || 'user',
          sessionId: msg.sessionId as string | undefined,
        });
        break;
      case 'portless_url_resolved':
        this.callbacks.onPortlessUrlResolved?.({
          key: msg.key as string,
          groupId: msg.groupId as string,
          actionId: msg.actionId as string,
          url: msg.url as string,
        });
        break;
      case 'shell_dismissed':
        this.callbacks.onShellDismissed?.({
          sessionId: msg.sessionId as string,
          procId: msg.procId as string,
        });
        break;
      case 'file_changes':
        this.callbacks.onFileChanges?.(sessionId, (msg.changes as FileChange[]) || []);
        break;
      case 'terminal_env_injected':
        this.callbacks.onTerminalEnvInjected?.({
          sessionId: msg.sessionId as string,
          procId: msg.procId as string,
          env: (msg.env as Record<string, string>) || {},
        });
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

  subscribe(sessionId: string) {
    this.activeSubs.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }
  unsubscribe(sessionId: string) {
    this.activeSubs.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }
  getSessionState(sessionId: string) { this.send({ type: 'get_session_state', sessionId }); }
  getSessions() { this.send({ type: 'get_sessions' }); }

  /** Tell the server which tab the user is currently viewing. In app spawn
   *  mode this is the only signal that boots a session's provider; in
   *  service mode it's a no-op on the server side. Safe to call on every
   *  active-tab change — the server dedupes already-running providers. */
  notifyActiveTab(sessionId: string) {
    this.send({ type: 'active_tab_change', sessionId });
  }

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

  /** Reply to a `browser_request` from the bridge. */
  respondBrowserRequest(
    sessionId: string,
    requestId: string,
    payload: { result?: unknown; error?: string },
  ) {
    this.send({ type: 'browser_response', sessionId, requestId, ...payload });
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
  /** `label` + `command` are only honoured on the fresh-spawn path —
   *  re-attaches preserve whatever the server already has. They let
   *  bubble-driven respawns (after a bridge restart wiped the original
   *  PTY) reclaim their identity so MCP lookups by name still work. */
  execShell(sessionId: string, procId: string, cwd: string, cols: number, rows: number, opts?: { label?: string; command?: string }) {
    this.send({ type: 'exec_shell', sessionId, procId, cwd, cols, rows, label: opts?.label, command: opts?.command });
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

  /** Subscribe to re-attach reset signals for a procId. Fires once per
   *  server-initiated re-attach, right before the authoritative output
   *  buffer replay comes over the data subscription. Bubbles use this to
   *  call `term.reset()` so the replay lands on a clean xterm. */
  onTerminalResetForProc(procId: string, cb: () => void): () => void {
    let subs = this.termResetSubs.get(procId);
    if (!subs) { subs = new Set(); this.termResetSubs.set(procId, subs); }
    subs.add(cb);
    return () => {
      const s = this.termResetSubs.get(procId);
      s?.delete(cb);
      if (s && s.size === 0) this.termResetSubs.delete(procId);
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

  async createSession(
    cwd?: string,
    opts: {
      name?: string; model?: string | null; permissionMode?: string;
      provider?: string; remoteId?: string | null;
      /** Override the path used for server-side autogrouping. Defaults to
       *  `cwd`. Set when the session is spawned in a worktree so it lands
       *  in the parent repo's autogroup instead of one named after the
       *  worktree branch. */
      groupCwd?: string;
    } = {},
  ): Promise<SessionInfo> {
    const resp = await authedFetch(`${this.serverUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: cwd || '/',
        name: opts.name,
        model: opts.model,
        permissionMode: opts.permissionMode,
        provider: opts.provider,
        remoteId: opts.remoteId ?? null,
        group_cwd: opts.groupCwd,
      }),
    });
    if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
    return resp.json();
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/resume`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Failed to resume: ${resp.status}`);
    return resp.json();
  }

  async renameSession(sessionId: string, name: string): Promise<SessionInfo> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`Failed to rename: ${resp.status}`);
    return resp.json();
  }

  async stopSession(sessionId: string): Promise<void> {
    await authedFetch(`${this.serverUrl}/sessions/${sessionId}/stop`, { method: 'POST' });
  }

  /** Restart the provider for a session in place — closes and re-spawns it
   *  with the same id so conversation history is preserved. Used to pick up
   *  MCP-config changes (added/removed servers only load at spawn time). */
  async restartSession(sessionId: string): Promise<SessionInfo> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/restart`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Failed to restart: ${resp.status}`);
    return resp.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await authedFetch(`${this.serverUrl}/sessions/${sessionId}`, { method: 'DELETE' });
  }

  /** Permanently remove a session: drops it from the registry and deletes
   *  its on-disk chat history + UI state. Pass `worktree: true` to also
   *  remove the underlying git worktree (when the session's cwd matches the
   *  `.wt/<branch>` convention). */
  async purgeSession(
    sessionId: string,
    opts: { worktree?: boolean } = {},
  ): Promise<{ ok: boolean; worktree?: { removed: boolean; method: string }; history?: boolean }> {
    const params = new URLSearchParams({ purge: '1' });
    if (opts.worktree) params.set('worktree', '1');
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) return { ok: false };
    return resp.json();
  }

  async getOpencodeInfo(): Promise<{ available: boolean; models: Array<{ id: string; label: string; providerName: string }>; error?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/providers/opencode/info`);
    if (!resp.ok) return { available: false, models: [] };
    return resp.json();
  }

  /**
   * Cached snapshot of the Claude Agent SDK's `supportedModels()` list,
   * captured the last time any session reported in. Empty array if the
   * bridge has never seen a Claude session boot (fresh install with no
   * prior sessions). Pickers that exist outside a live session read this
   * instead of hardcoding a model list.
   */
  async getClaudeInfo(): Promise<{ models: SupportedModel[] }> {
    const resp = await authedFetch(`${this.serverUrl}/providers/claude/info`);
    if (!resp.ok) return { models: [] };
    return resp.json();
  }

  async updateSession(
    sessionId: string,
    updates: { permissionMode?: string; name?: string; status?: 'open' | 'archived' },
  ): Promise<SessionInfo> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!resp.ok) throw new Error(`Failed to update: ${resp.status}`);
    return resp.json();
  }

  /** Hide a session from the tab bar (status=archived). Doesn't stop the
   *  underlying provider — call stopSession separately if you also want to
   *  kill the Claude process. */
  archiveSession(sessionId: string) {
    return this.updateSession(sessionId, { status: 'archived' });
  }

  /** Bring an archived session back into the tab bar (status=open). Does
   *  NOT auto-resume the provider — that happens lazily when the user
   *  focuses the tab or sends a message. */
  unarchiveSession(sessionId: string) {
    return this.updateSession(sessionId, { status: 'open' });
  }

  /** In-place `/clear`: drops the chat history and resets the provider
   *  session id without renaming or replacing the session. Used for tabs
   *  that can't be archived (e.g. the Telegram bot's main-session), since
   *  external bridges hold a reference to the session id. The next user
   *  message starts a fresh Claude conversation. */
  async clearSessionMessages(sessionId: string): Promise<void> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/clear`, {
      method: 'POST',
    });
    if (!resp.ok) throw new Error(`Failed to clear: ${resp.status}`);
  }

  /** Read the `hooks` block from Claude's settings.json — either the
   *  global one at ~/.claude/settings.json, or the project one at
   *  <cwd>/.claude/settings.json. Returns the on-disk path so the UI can
   *  surface it, and a boolean for whether the file exists yet. */
  async getClaudeHooks(scope: HookScope, cwd?: string): Promise<{ path: string; exists: boolean; hooks: ClaudeHooks }> {
    const qs = new URLSearchParams({ scope });
    if (cwd) qs.set('cwd', cwd);
    const resp = await authedFetch(`${this.serverUrl}/claude-hooks?${qs.toString()}`);
    if (!resp.ok) throw new Error(`Failed to read hooks: ${resp.status}`);
    return resp.json();
  }

  /** Write the `hooks` block back to Claude's settings.json. Preserves
   *  every other key in the file (mcpServers, permissions, model, etc.). */
  async setClaudeHooks(scope: HookScope, cwd: string | undefined, hooks: ClaudeHooks): Promise<{ path: string }> {
    const resp = await authedFetch(`${this.serverUrl}/claude-hooks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, cwd, hooks }),
    });
    if (!resp.ok) throw new Error(`Failed to write hooks: ${resp.status}`);
    return resp.json();
  }

  async listDirs(prefix: string): Promise<string[]> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/ls?prefix=${encodeURIComponent(prefix)}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  async getUserHome(): Promise<string> {
    if (this._userHomeCache) return this._userHomeCache;
    const resp = await authedFetch(`${this.serverUrl}/user-home`);
    if (!resp.ok) return '/';
    const data = await resp.json() as { home?: string };
    this._userHomeCache = data.home || '/';
    return this._userHomeCache;
  }
  private _userHomeCache: string | null = null;

  async listFiles(dirPath: string): Promise<{ name: string; path: string; type: 'file' | 'dir' }[]> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/files?path=${encodeURIComponent(dirPath)}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  async readFile(path: string): Promise<{ path: string; content: string } | null> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Fetch a file's raw bytes (with auth) and return a `data:` URL suitable for
   *  an <img src>. Used by the image preview tab — an <img> can't carry the
   *  Authorization header itself, so we read the blob here and inline it. */
  async readFileDataUrl(path: string): Promise<string | null> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-raw?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-content`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return resp.ok;
  }

  async deletePath(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`), { method: 'DELETE' });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async renamePath(from: string, to: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-rename`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async createFile(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-new`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, kind: 'file' }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async createDir(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-new`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, kind: 'dir' }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async revealInFinder(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/file-reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async readFileOriginal(path: string, base?: string | null): Promise<string> {
    const baseParam = base ? `&base=${encodeURIComponent(base)}` : '';
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-original?path=${encodeURIComponent(path)}${baseParam}`));
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.content || '';
  }

  async getGitInfo(path: string): Promise<{
    is_git: boolean; branch?: string; top_level?: string;
    worktrees?: { path: string; branch: string }[];
    package_manager?: string; has_env?: boolean;
  }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/git-info?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return { is_git: false };
    return resp.json();
  }

  async getGitModified(root: string, base?: string | null): Promise<{ path: string; staged: boolean; untracked?: boolean; additions?: number; deletions?: number }[]> {
    const baseParam = base ? `&base=${encodeURIComponent(base)}` : '';
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/git-modified?root=${encodeURIComponent(root)}${baseParam}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  async gitStage(root: string, files: string[], unstage = false): Promise<boolean> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/git-stage`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, files, unstage }),
    });
    return resp.ok;
  }

  async listBranches(cwd: string): Promise<{ current: string; local: string[]; remote: string[] }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/git-branches?cwd=${encodeURIComponent(cwd)}`));
    if (!resp.ok) return { current: '', local: [], remote: [] };
    return resp.json();
  }

  async checkoutBranch(cwd: string, branch: string): Promise<{
    ok: boolean;
    branch?: string;
    error?: string;
    /** Set when the branch is already checked out in another worktree.
     *  The caller can switch its cwd to `path` instead of treating this
     *  as a failure. */
    alreadyInWorktree?: { path: string; branch: string };
  }> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/git-checkout`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, branch }),
    });
    return resp.json();
  }

  async searchFiles(
    root: string,
    query: string,
    opts: { caseSensitive?: boolean; ignore?: string; signal?: AbortSignal } = {},
  ): Promise<{ file: string; line: number; text: string }[]> {
    const params = new URLSearchParams({ root, q: query });
    params.set('case', opts.caseSensitive ? 'sensitive' : 'insensitive');
    if (opts.ignore && opts.ignore.trim()) params.set('ignore', opts.ignore.trim());
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/search?${params}`), { signal: opts.signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.results || [];
  }

  async listPullRequests(cwd: string, sessionName?: string): Promise<{ number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[]> {
    const params = new URLSearchParams({ cwd });
    if (sessionName) params.set('session', sessionName);
    const resp = await authedFetch(`${this.serverUrl}/gh-prs?${params}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  // -------------------------------------------------------------------------
  // MCP server config (read/write of ~/.claude/settings.json + <cwd>/.mcp.json)
  // -------------------------------------------------------------------------

  /** Merged view of configured MCP servers (built-ins + user + project). */
  async listMcpServers(cwd?: string | null): Promise<McpServerView[]> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    const resp = await authedFetch(`${this.serverUrl}/mcp-servers${qs ? `?${qs}` : ''}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  /** Add (or overwrite) a single MCP server entry in the chosen scope. */
  async addMcpServer(input: McpServerInput): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/mcp-servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return resp.json().catch(() => ({ ok: resp.ok }));
  }

  /** Remove a user/project MCP server by name. Built-ins are rejected. */
  async removeMcpServer(name: string, scope: 'user' | 'project', cwd?: string | null): Promise<{ ok: boolean; error?: string }> {
    const params = new URLSearchParams({ scope });
    if (cwd) params.set('cwd', cwd);
    const resp = await authedFetch(`${this.serverUrl}/mcp-servers/${encodeURIComponent(name)}?${params}`, { method: 'DELETE' });
    return resp.json().catch(() => ({ ok: resp.ok }));
  }

  async listProcesses(sessionId: string): Promise<{ id: string; pid: number; command: string; cwd: string; startedAt: number; exitCode?: number | null; kind?: 'oneshot' | 'pty'; output?: string; children: { pid: number; command: string }[] }[]> {
    const resp = await authedFetch(`${this.serverUrl}/processes?sessionId=${sessionId}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  // ---------------------------------------------------------------------------
  // Port forwards (remote sessions only). The local bridge owns the SSH
  // ControlMaster, so add/list/remove all hit the local server even when the
  // session lives on a remote.
  // ---------------------------------------------------------------------------

  async listPortForwards(sessionId: string): Promise<{ localPort: number; remotePort: number; label?: string }[]> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/port-forwards`);
    if (!resp.ok) return [];
    return resp.json();
  }

  async addPortForward(
    sessionId: string,
    body: { remotePort: number; localPort?: number | null; label?: string },
  ): Promise<{ localPort: number; remotePort: number; label?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/port-forwards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async removePortForward(sessionId: string, localPort: number, remotePort: number): Promise<void> {
    await authedFetch(`${this.serverUrl}/sessions/${sessionId}/port-forwards/${localPort}/${remotePort}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // Dismissed shells — bridge-owned list of terminal procIds the user has
  // explicitly closed. The frontend asks at session load (so it knows what
  // to hide) and DELETEs to add a new entry.
  // ---------------------------------------------------------------------------

  async listDismissedShells(sessionId: string): Promise<string[]> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${sessionId}/shells/dismissed`);
    if (!resp.ok) return [];
    const data = await resp.json() as { dismissed?: string[] };
    return data.dismissed || [];
  }

  async dismissShell(sessionId: string, procId: string): Promise<void> {
    await authedFetch(`${this.serverUrl}/sessions/${sessionId}/shells/${encodeURIComponent(procId)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // Portless — named dev-server actions per project. The bridge spawns
  // `portless <name> -- <command>` in the project's cwd and tracks lifetime.
  // ---------------------------------------------------------------------------

  async getPortlessCliStatus(): Promise<PortlessCliStatus> {
    const resp = await authedFetch(`${this.serverUrl}/portless/cli-status`);
    if (!resp.ok) return { available: false, bin: null, version: null };
    return resp.json();
  }

  async listPortlessRunning(): Promise<PortlessActionStatus[]> {
    const resp = await authedFetch(`${this.serverUrl}/portless/status`);
    if (!resp.ok) return [];
    const data = await resp.json() as { actions?: PortlessActionStatus[] };
    return data.actions || [];
  }

  async runPortlessAction(body: {
    groupId: string; actionId: string; name: string; command: string;
    hostname: string; cwd: string; noTls?: boolean;
    source?: 'user' | 'agent'; sessionId?: string;
  }): Promise<PortlessActionStatus> {
    const resp = await authedFetch(`${this.serverUrl}/portless/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({})) as { status?: PortlessActionStatus; error?: string };
    if (!resp.ok || !data.status) throw new Error(data.error || `HTTP ${resp.status}`);
    return data.status;
  }

  async stopPortlessAction(groupId: string, actionId: string): Promise<void> {
    await authedFetch(`${this.serverUrl}/portless/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId, actionId }),
    });
  }

  async stopAllPortlessActions(): Promise<void> {
    await authedFetch(`${this.serverUrl}/portless/stop-all`, { method: 'POST' });
  }

  async forgetPortlessAction(groupId: string, actionId: string): Promise<void> {
    await authedFetch(`${this.serverUrl}/portless/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId, actionId }),
    });
  }

  async detectPortlessScripts(cwd: string): Promise<{ projectName: string | null; suggested: { name: string; command: string }[] }> {
    const resp = await authedFetch(`${this.serverUrl}/portless/detect?cwd=${encodeURIComponent(cwd)}`);
    if (!resp.ok) return { projectName: null, suggested: [] };
    return resp.json();
  }

  async scanEnvForActions(cwd: string, actionNames: string[]): Promise<{
    candidates: { var: string; value: string; file: string; line: number; suggestedAction: string | null; ambiguous: boolean }[];
    scanned: string[];
  }> {
    const params = new URLSearchParams({ cwd, actionNames: actionNames.join(',') });
    const resp = await authedFetch(`${this.serverUrl}/portless/scan-env?${params}`);
    if (!resp.ok) return { candidates: [], scanned: [] };
    return resp.json();
  }

  // ---------------------------------------------------------------------------
  // Portless proxy admin — start/stop the system proxy, trust the local CA.
  // The privileged modes (HTTP :80, HTTPS :443) bring up a system password
  // prompt via osascript on macOS.
  // ---------------------------------------------------------------------------

  async getPortlessProxyStatus(): Promise<PortlessProxyStatus> {
    const resp = await authedFetch(`${this.serverUrl}/portless/proxy/status`);
    if (!resp.ok) return { running: false, port: null, mode: null };
    return resp.json();
  }

  async startPortlessProxy(mode: PortlessProxyMode): Promise<PortlessProxyActionResult> {
    const resp = await authedFetch(`${this.serverUrl}/portless/proxy/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return resp.json().catch(() => ({ ok: false, output: '', error: `HTTP ${resp.status}` }));
  }

  async stopPortlessProxy(): Promise<PortlessProxyActionResult> {
    const resp = await authedFetch(`${this.serverUrl}/portless/proxy/stop`, { method: 'POST' });
    return resp.json().catch(() => ({ ok: false, output: '', error: `HTTP ${resp.status}` }));
  }

  async trustPortlessCA(): Promise<PortlessProxyActionResult> {
    const resp = await authedFetch(`${this.serverUrl}/portless/trust`, { method: 'POST' });
    return resp.json().catch(() => ({ ok: false, output: '', error: `HTTP ${resp.status}` }));
  }

  // ---------------------------------------------------------------------------
  // Preferences (tab groups, ordering, closed sessions) — shared with the
  // desktop UI so both views agree on which sessions are "open" and how they
  // are grouped.
  // ---------------------------------------------------------------------------

  async getPreferences(): Promise<Record<string, unknown>> {
    const resp = await authedFetch(`${this.serverUrl}/preferences`);
    if (!resp.ok) return {};
    return resp.json();
  }

  async updatePreferences(patch: Record<string, unknown>): Promise<boolean> {
    const resp = await authedFetch(`${this.serverUrl}/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return resp.ok;
  }

  async saveCommands(sessionId: string, commands: string[]): Promise<void> {
    await authedFetch(`${this.serverUrl}/save-commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, commands }),
    });
  }

  async getFileIndex(root: string): Promise<{ name: string; path: string; rel: string; type?: 'file' | 'dir' }[]> {
    const resp = await authedFetch(withActiveRemote(`${this.serverUrl}/file-index?root=${encodeURIComponent(root)}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  createWorktree(
    repoPath: string,
    branch: string,
    opts: {
      /** When false, attach the existing `branch` into the worktree instead
       *  of creating a fresh one. Defaults to true (create new). */
      new_branch?: boolean;
      copy_env?: boolean;
      install_deps?: boolean;
      copy_node_modules?: boolean;
      link_node_modules?: boolean;
      package_manager?: string;
      /** Base the new branch on this existing branch instead of HEAD. Only
       *  used when `new_branch` is true. */
      source_branch?: string;
      /** When `source_branch` is set, fetch origin for it first and use
       *  `origin/<source_branch>` as the start-point. */
      pull_source?: boolean;
    },
    callbacks: {
      onLog: (line: string) => void;
      onDone: (result: { path: string; branch: string }) => void;
      onError: (err: string) => void;
    },
  ): { abort: () => void } {
    const ctrl = new AbortController();
    authedFetch(`${this.serverUrl}/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_path: repoPath, branch, ...opts }),
      signal: ctrl.signal,
    }).then(async (resp) => {
      if (!resp.ok || !resp.body) { callbacks.onError(`HTTP ${resp.status}`); return; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // Dispatch by `event:` line. The server sends raw strings for log/error
      // and a JSON envelope for done — blindly JSON.parsing every data line
      // silently dropped errors like "Branch already exists" and left the
      // form spinning forever.
      let evt: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: ')) { evt = line.slice(7).trim(); continue; }
          if (!line.startsWith('data: ')) { if (line === '') evt = null; continue; }
          const raw = line.slice(6);
          if (evt === 'log') callbacks.onLog(raw);
          else if (evt === 'error') callbacks.onError(raw);
          else if (evt === 'done') {
            try {
              const data = JSON.parse(raw);
              if (data?.path) callbacks.onDone(data);
            } catch (e) { callbacks.onError(String(e)); }
          }
        }
      }
    }).catch((e) => { if (!ctrl.signal.aborted) callbacks.onError(e.message); });
    return { abort: () => ctrl.abort() };
  }

  /** Remove an existing git worktree by path. Rejects (with the server's
   *  message) when git refuses — e.g. trying to remove the main worktree. */
  async removeWorktree(repoPath: string, worktreePath: string): Promise<{ ok: boolean; removed?: boolean }> {
    const resp = await authedFetch(`${this.serverUrl}/worktree/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_path: repoPath, worktree_path: worktreePath }),
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const j = await resp.json(); if (j?.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return resp.json();
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (typeof document !== 'undefined') {
      if (this.visibilityHandler) {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
        this.visibilityHandler = null;
      }
      if (this.pageHideHandler) {
        window.removeEventListener('pagehide', this.pageHideHandler);
        this.pageHideHandler = null;
      }
      if (this.pageShowHandler) {
        window.removeEventListener('pageshow', this.pageShowHandler);
        this.pageShowHandler = null;
      }
    }
    this.ws?.close();
  }
}
