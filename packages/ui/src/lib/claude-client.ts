/**
 * Codiby Code Client — one WebSocket per bridge. There is always a LOCAL
 * connection (to the bun sidecar) plus one DIRECT connection per remote,
 * reached through an SSH tunnel that the Electron main process owns. The
 * client routes each session's REST/WS to the connection its remote belongs
 * to. All state lives on the bridges; the client is a stateless viewer.
 */
import { getNative, isNative } from './native';
import { Conn } from './conn';
import { emptyProgress } from './requirements';
import type {
  LoopState,
  Requirement,
  RequirementEvent,
  RequirementProgress,
  RequirementProposal,
  RequirementsSnapshot,
} from './requirements';

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
// Skills (markdown skill docs across claude / opencode / .agent conventions)
// ---------------------------------------------------------------------------

export type SkillScope = 'user' | 'project';
export type SkillSource = 'claude' | 'opencode' | 'agent';
export type SkillFormat = 'dir' | 'file';

/** Summary shape returned by the list endpoint. */
export interface SkillSummary {
  id: string;
  name: string;
  source: SkillSource;
  scope: SkillScope;
  format: SkillFormat;
  description: string;
  allowedTools: string[];
  path: string;
}

/** Full skill (detail read) — adds the raw markdown and the body-after-frontmatter. */
export interface SkillDetail extends SkillSummary {
  content: string;
  body: string;
}

/** Payload for creating a skill. */
export interface SkillCreateInput {
  name: string;
  description?: string;
  body?: string;
  content?: string;
  source?: SkillSource;
  format?: SkillFormat;
  allowedTools?: string[];
}

/** Payload for updating a skill (field-level patch, or full `content` replace). */
export interface SkillUpdateInput {
  name?: string;
  description?: string;
  body?: string;
  content?: string;
  allowedTools?: string[];
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
// Session-agnostic endpoints (file browse, git, search, …) are re-pointed at
// the remote's DIRECT tunnel base (see `ClaudeClient.remoteUrl`) instead of
// the local bun bridge. Endpoints that resolve the remote from their own state
// (`/sessions/*`) route via the session's connection; `/remotes/*` stay local.
// ---------------------------------------------------------------------------

let _activeRemoteId: string | null = null;

export function setActiveRemoteId(id: string | null): void {
  _activeRemoteId = id && id.length > 0 ? id : null;
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
   * Local-only, computed by `groupMessages`: the live state of any ```explain
   * block this message authored — the decisions already answered and the
   * continuations they produced. Derived from later messages rather than
   * stored, so a block keeps its state across a remount or a reload.
   */
  explainParts?: import('./explain').ExplainParts;
  /**
   * Set on assistant messages whose `content` is the model's reasoning
   * summary (Anthropic `thinking` / `redacted_thinking` block). Rendered as
   * a collapsible dim bubble — distinct from regular assistant text.
   */
  isThinking?: boolean;
  /** True when the underlying block was `redacted_thinking` (content is a
   *  placeholder; the real reasoning is encrypted by the API). */
  thinkingRedacted?: boolean;
  /**
   * Local-only flag: this message is the live, still-growing block of the
   * current turn (assistant text or `isThinking` reasoning). While true its
   * `content` is replaced in place on each stream delta and the bubble renders
   * with the "live" look (pulsing sparkle / caret, auto-expanded thinking).
   * Flipped to `false` when the matching permanent block arrives, or frozen in
   * place on interrupt/turn-end. Replaces the old side-channel
   * `partialText`/`partialThinking` strings so streaming content lives in the
   * single `messages` array and never re-anchors to the bottom.
   */
  streaming?: boolean;
  /**
   * Local-only marker for a bubble born as a streaming preview. Unlike
   * `streaming` it survives freezeStreaming, so when an interrupt settles the
   * preview before its permanent server copy arrives (the server commits the
   * preview in its interrupt handler), `onMessage` can still adopt this slot
   * instead of appending a duplicate. Retired on the next user send; never
   * persisted server-side.
   */
  placeholder?: boolean;
  /**
   * Local-only React key. A message can change `id` mid-life: an optimistic
   * user send is replaced by the server's echo, and a streaming block is
   * replaced by its permanent copy when the turn closes. Both are the SAME
   * bubble to the reader, but keying off `id` remounts the node — which tears
   * down its DOM element, taking any running entrance animation and any local
   * component state (an expanded tool card, a scrolled code block) with it.
   *
   * The adopting write carries the original `uiKey` across, so React sees one
   * continuous node. `id` stays authoritative for dedupe and scroll targets.
   */
  uiKey?: string;
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

/**
 * A terminal as a first-class resource. Fetched from
 * `GET /sessions/:id/terminals` on connect and kept in sync via the
 * `terminal_created` / `terminal_removed` broadcasts. The terminals dock
 * renders straight from a list of these — terminals are no longer inferred
 * from chat messages. `id === procId`.
 */
export interface TerminalInfo {
  id: string;
  procId: string;
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  exitCode: number | null;
  kind: 'oneshot' | 'pty';
  label?: string;
  terminalName?: string;
  terminalUrl?: string;
  injectedEnv?: Record<string, string>;
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
  /** Reasoning-effort level. Null/absent → provider default. */
  effort?: string | null;
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

/** A local port this session has pushed out to every network interface so a
 *  browser on another machine can reach it. Mirrors `SessionPortForward` in
 *  the bridge's network/port-forward.ts, plus the URL the server built. */
export interface PublishedPort {
  id: string;
  sessionId: string;
  /** Port on the bridge's machine the traffic is delivered to. */
  targetPort: number;
  targetHost: string;
  /** Port bound on 0.0.0.0 — what a remote browser dials. */
  publicPort: number;
  label: string | null;
  createdAt: number;
  connections: number;
  url: string;
  /** True when no remote client was connected, so `url` uses this machine's
   *  own hostname rather than one somebody was seen reaching it on. */
  urlIsGuess: boolean;
  /** Only present on the create response: whether anything answered on the
   *  target port at that moment. */
  listening?: boolean;
}

/** A single filesystem change reported by the server-side session watcher.
 *  `path` is relative to the session cwd, POSIX-separated. Kept in lock-step
 *  with `FileChange` in server/watcher.ts. */
export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export type FileChange = {
  kind: FileChangeKind;
  path: string;
  isDir: boolean;
};

/** A TCP port in LISTEN owned by a session's process subtree. */
export type ListeningPort = { port: number; pid: number; command: string };

/** Live process/port activity for a session, pushed by the server-side
 *  process monitor. Drives the sidebar "running processes" / "listening ports"
 *  badges. Kept in lock-step with `SessionActivity` in
 *  server/process-monitor.ts. */
export type SessionActivity = {
  childProcessCount: number;
  processes: { pid: number; command: string; label?: string }[];
  listeningPorts: ListeningPort[];
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
  /** A terminal was created (by the user or an MCP tool). The dock adds the
   *  tab only in response to this — never optimistically on the create call. */
  onTerminalCreated?: (sessionId: string, terminal: TerminalInfo) => void;
  /** A terminal was killed / GC'd. The dock drops the tab. */
  onTerminalRemoved?: (sessionId: string, procId: string) => void;
  /** Full terminals list for a session, delivered right after (re)subscribe so
   *  the dock repopulates open terminals on connect. */
  onTerminalsSnapshot?: (sessionId: string, terminals: TerminalInfo[]) => void;
  onTodos: (sessionId: string, todos: { content: string; status: string; activeForm?: string }[]) => void;
  /** Requirements snapshot — pushed by the server before and after every check
   *  run, and on any mutation from either the agent's tools or the panel. */
  onRequirements?: (sessionId: string, snapshot: RequirementsSnapshot) => void;
  /** Loop-mode state changed (armed, iteration advanced, paused, completed). */
  onLoop?: (sessionId: string, loop: LoopState | null, progress: RequirementProgress) => void;
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
  /** The keyboard-shortcut override map changed (the shortcuts editor saved,
   *  possibly in another window). */
  onKeybindings?: (overrides: Record<string, string | null>) => void;
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
  onWelcome: (info: { spawnMode: SpawnMode; viewerIsRemote: boolean }) => void;
  /** A session's published ports changed. The agent opens most of these
   *  through `ui_forward_port`, so the popover learns about them here rather
   *  than by polling. Optional — viewers without the chip can omit it. */
  onPublishedPorts?: (sessionId: string, ports: PublishedPort[]) => void;
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
  /** The server-side watcher detected the session repo's checked-out branch
   *  change (checkout, worktree HEAD move). Empty string means detached HEAD. */
  onBranchChanged?: (sessionId: string, branch: string) => void;
  /** The session's running child processes or listening ports changed. Drives
   *  the sidebar badges. Optional — viewers without the badges can omit it. */
  onSessionActivity?: (sessionId: string, activity: SessionActivity) => void;
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
  /** Present when a privileged start was blocked by a foreign listener on the
   *  target port. `funnelConflict` flags the Tailscale-Funnel-on-:443 case so
   *  the UI can offer a one-click "Disable Funnel & retry". */
  conflict?: { port: number; funnelConflict: boolean };
}

/** A browsable per-session resource — pasted image, generated mockup, file. */
export interface SessionResource {
  id: string;
  sessionId: string;
  name: string;
  kind: 'image' | 'mockup' | 'snippet' | 'file' | 'other' | string;
  mime: string;
  ext: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  /** Absolute on-disk path. */
  path: string;
  /** Serve path for the raw blob, relative to the server root. */
  url: string;
}

export class ClaudeClient {
  private serverUrl: string;
  private callbacks: ClientCallbacks;
  private destroyed = false;
  /** Local connection to the bun sidecar. */
  private localConn!: Conn;
  /** Direct connections to remotes, keyed by remoteId. */
  private remoteConns = new Map<string, Conn>();
  /** sessionId → remoteId for sessions that live on a remote (absent = local). */
  private sessionRemote = new Map<string, string>();
  /** Last known SSH-tunnel local port per remote. */
  private remotePorts = new Map<string, number>();
  /** Memoized tunnel-acquire promise per remote (one acquire → one refcount). */
  private remoteBasePromises = new Map<string, Promise<string | null>>();
  /** Remote display metadata (color/name) used to tag discovered sessions. */
  private remoteMeta = new Map<string, { color?: string | null; name?: string | null }>();
  /** Last session list received from each connection ('' = local, else remoteId).
   *  Merged into a single list for `onSessions`. */
  private sessionsByConn = new Map<string, SessionInfo[]>();
  private tunnelStatusUnlisten: (() => void) | null = null;
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
  // Visibility listener (mobile PWA) — re-checks the connection when the
  // user brings the app back to the foreground.
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;
  /** Debounce timer for the background socket-teardown (see visibilityHandler). */
  private bgCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private pageShowHandler: (() => void) | null = null;

  constructor(serverUrl: string, callbacks: ClientCallbacks) {
    this.serverUrl = serverUrl;
    this.callbacks = callbacks;

    // The local connection always exists; its WS status drives the app's
    // connection indicator. Remote connections are added lazily via
    // `setRemotes` / when a remote session is first used.
    this.localConn = new Conn(null, this.serverUrl, {
      resolveBase: async () => this.serverUrl,
      token: () => _authToken,
      onMessage: (msg, rid) => this.handleMessage(msg, rid),
      onStatus: (rid, status) => { if (rid === null) this.callbacks.onConnectionChange(status); },
      onOpen: (send) => send({ type: 'client_capabilities', browserCdp: isNative() }),
    });

    // Discover configured remotes and open a direct connection to each.
    void this.refreshRemotes();

    // Tunnel status (owned by Electron main) → refresh the direct base URL when
    // a remote comes online on a new port, and feed the remote-status UI.
    const native = getNative();
    if (native?.onRemoteTunnelStatus) {
      this.tunnelStatusUnlisten = native.onRemoteTunnelStatus(({ remoteId, status, lastError, port }) => {
        if (port) {
          this.remotePorts.set(remoteId, port);
          this.remoteConns.get(remoteId)?.setBase(`http://127.0.0.1:${port}`);
        }
        const uiStatus = status === 'idle' ? 'offline' : status;
        this.callbacks.onRemoteStatus?.(remoteId, uiStatus as 'connecting' | 'online' | 'reconnecting' | 'offline', lastError);
      });
    }

    // Visibility / lifecycle handling — same rationale as before, applied to
    // every connection (local + each remote):
    //   • background → CLOSE the sockets so the page stays bfcache-eligible.
    //   • foreground / pageshow → reopen any that aren't open.
    if (typeof document !== 'undefined') {
      const reconnect = () => {
        if (this.destroyed) return;
        this.localConn.reopen();
        for (const c of this.remoteConns.values()) c.reopen();
      };
      const closeForBackground = () => {
        if (this.destroyed) return;
        this.localConn.closeForBackground();
        for (const c of this.remoteConns.values()) c.closeForBackground();
      };
      // Tearing every socket down the instant the window is hidden — and
      // reopening on return — makes each session's online indicator flicker on
      // a quick alt-tab / focus change. Debounce the teardown so only a
      // genuinely-backgrounded window (hidden for a while) closes its sockets;
      // a brief hide keeps them open, so `reconnect()` becomes a no-op and the
      // indicators stay steady. The immediate bfcache path is still covered by
      // `pagehide` below.
      const BACKGROUND_CLOSE_DELAY_MS = 30_000;
      const cancelBgClose = () => {
        if (this.bgCloseTimer) { clearTimeout(this.bgCloseTimer); this.bgCloseTimer = null; }
      };
      this.visibilityHandler = () => {
        if (this.destroyed) return;
        if (document.visibilityState === 'visible') {
          cancelBgClose();
          reconnect();
        } else {
          cancelBgClose();
          this.bgCloseTimer = setTimeout(() => { this.bgCloseTimer = null; closeForBackground(); }, BACKGROUND_CLOSE_DELAY_MS);
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      this.pageHideHandler = () => { cancelBgClose(); closeForBackground(); };
      this.pageShowHandler = () => reconnect();
      window.addEventListener('pagehide', this.pageHideHandler);
      window.addEventListener('pageshow', this.pageShowHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Remote connections (direct-to-tunnel)
  // ---------------------------------------------------------------------------

  /** Current http base for a remote from the last known tunnel port, or null. */
  private remoteBase(remoteId: string): string | null {
    const port = this.remotePorts.get(remoteId);
    return port ? `http://127.0.0.1:${port}` : null;
  }

  /** Bring a remote's tunnel up ONCE (memoized), caching the local port. Holds
   *  a single refcount for the remote's lifetime. Memoizing here — and deduping
   *  the spawn in Electron main — is what stops many `ssh` masters racing for
   *  the same control socket. Failed acquires are un-memoized so REST retries. */
  private ensureRemoteBaseUp(remoteId: string): Promise<string | null> {
    let p = this.remoteBasePromises.get(remoteId);
    if (!p) {
      p = this.acquireRemoteBase(remoteId).then((base) => {
        if (!base) this.remoteBasePromises.delete(remoteId);
        return base;
      });
      this.remoteBasePromises.set(remoteId, p);
    }
    return p;
  }

  private async acquireRemoteBase(remoteId: string): Promise<string | null> {
    const native = getNative();
    if (!native) return null;
    try {
      const { port } = await native.invoke<{ port: number }>('remote_tunnel_acquire', { remoteId });
      this.remotePorts.set(remoteId, port);
      const base = `http://127.0.0.1:${port}`;
      this.remoteConns.get(remoteId)?.setBase(base);
      return base;
    } catch {
      return null;
    }
  }

  /** Open (once) the direct connection to a remote's tunnelled bridge. Registers
   *  the Conn SYNCHRONOUSLY (before any await) so concurrent callers share one
   *  connection instead of each opening their own socket + acquiring. */
  private ensureRemoteConn(remoteId: string): Conn {
    let conn = this.remoteConns.get(remoteId);
    if (conn) return conn;
    conn = new Conn(remoteId, this.remoteBase(remoteId), {
      resolveBase: async () => this.remoteBase(remoteId), // cached port; no re-acquire on reconnect
      token: () => null, // the loopback tunnel is trusted; no bearer needed
      onMessage: (msg, rid) => this.handleMessage(msg, rid),
      onStatus: () => {}, // remote UI status comes from the tunnel-status push
      onOpen: (send) => send({ type: 'client_capabilities', browserCdp: isNative() }),
    });
    this.remoteConns.set(remoteId, conn);
    // Bring the tunnel up once and point the connection at the resolved port.
    void this.ensureRemoteBaseUp(remoteId).then((base) => { if (base) conn!.setBase(base); });
    return conn;
  }

  private releaseRemote(remoteId: string) {
    this.remoteBasePromises.delete(remoteId);
    getNative()?.invoke('remote_tunnel_release', { remoteId }).catch(() => {});
  }

  /** Configure which remotes exist (from `/remotes`). Opens a connection per
   *  remote so its session list is discovered directly, and tears down any that
   *  were removed. Also records display metadata used to tag sessions. */
  setRemotes(remotes: { id: string; color?: string | null; name?: string | null }[]) {
    const ids = new Set(remotes.map((r) => r.id));
    for (const r of remotes) this.remoteMeta.set(r.id, { color: r.color, name: r.name });
    for (const r of remotes) this.ensureRemoteConn(r.id);
    for (const [rid, conn] of [...this.remoteConns]) {
      if (!ids.has(rid)) {
        conn.destroy();
        this.remoteConns.delete(rid);
        this.sessionsByConn.delete(rid);
        this.releaseRemote(rid);
      }
    }
  }

  /** Re-point a `${serverUrl}/…` file/git/search URL at the currently-focused
   *  remote's direct tunnel base. No-op when the focused session is local. */
  private async remoteUrl(url: string): Promise<string> {
    if (!_activeRemoteId) return url;
    this.ensureRemoteConn(_activeRemoteId);
    const base = await this.ensureRemoteBaseUp(_activeRemoteId);
    return base ? url.replace(this.serverUrl, base) : url;
  }

  /** Sync http base for a session's bridge from the last-known tunnel port.
   *  Falls back to the local bridge for local sessions (or before the tunnel
   *  port is cached). Used where an await isn't possible — e.g. building an
   *  `<img src>` URL. */
  private baseForSession(sessionId: string): string {
    const rid = this.sessionRemote.get(sessionId);
    return (rid && this.remoteBase(rid)) || this.serverUrl;
  }

  /** http base for a specific session's bridge (session-bound REST). */
  private async sessionBase(sessionId: string): Promise<string> {
    const rid = this.sessionRemote.get(sessionId);
    if (!rid) return this.serverUrl;
    this.ensureRemoteConn(rid);
    // A remote session must NEVER fall back to the local bridge: the local
    // server doesn't own the session, so routing there returns 404 (the
    // reported "GET http://127.0.0.1:<local>/sessions/<id>/terminals" bug).
    // Prefer the freshly-acquired tunnel base, else the port the tunnel-status
    // push already cached; if neither is ready, throw so best-effort callers
    // (fetchTerminals) skip and retry once the tunnel is up — the WS snapshot /
    // `terminal_created` broadcast refills the dock.
    const base = (await this.ensureRemoteBaseUp(rid)) ?? this.remoteBase(rid);
    if (!base) throw new Error(`Remote ${rid} tunnel not ready for session ${sessionId}`);
    return base;
  }

  /** Merge each connection's last session list into one and emit it. */
  private emitMergedSessions() {
    const all: SessionInfo[] = [];
    for (const list of this.sessionsByConn.values()) all.push(...list);
    this.callbacks.onSessions(all);
  }

  /** Load the configured remotes from the local bridge and open a direct
   *  connection to each (discovering their sessions). `/remotes` CRUD +
   *  persistence still lives on the local bun sidecar. */
  async refreshRemotes(): Promise<void> {
    try {
      const resp = await authedFetch(`${this.serverUrl}/remotes`);
      if (!resp.ok) return;
      const remotes = await resp.json() as { id: string; color?: string | null; name?: string | null }[];
      this.setRemotes(remotes);
    } catch {
      // Local bridge not reachable yet — retried on the next `remotes` broadcast.
    }
  }

  private handleMessage(msg: Record<string, unknown>, remoteId: string | null = null) {
    const type = msg.type as string;
    const sessionId = msg.sessionId as string;

    switch (type) {
      case 'sessions': {
        // Each connection reports its own session list. Record the
        // sessionId→remote mapping so later REST/WS route to the right bridge.
        const sessions = (msg.sessions as SessionInfo[]) || [];
        for (const s of sessions) {
          // A session is remote if the reporting connection is a remote OR the
          // payload itself carries a remoteId (e.g. a cached/aggregated entry
          // surfaced over the local connection). Registering BOTH cases keeps
          // `sessionRemote` authoritative so a remote session never falls
          // through to the local bridge — which 404s (the terminal-open bug).
          const rid = remoteId ?? s.remoteId ?? null;
          if (!rid) continue;
          this.sessionRemote.set(s.id, rid);
          // Ensure a direct connection/tunnel exists so `sessionBase` can
          // resolve the remote's port even when the session arrived via the
          // local connection.
          this.ensureRemoteConn(rid);
          const meta = this.remoteMeta.get(rid);
          s.remoteId = rid;
          s.remoteColor = meta?.color ?? s.remoteColor ?? null;
          s.remoteName = meta?.name ?? s.remoteName ?? null;
        }
        this.sessionsByConn.set(remoteId ?? '', sessions);
        this.emitMergedSessions();
        break;
      }
      case 'remotes':
        // The configured-remotes list changed (added/removed/edited in
        // Settings). Re-open/close direct connections to match.
        this.setRemotes((msg.remotes as { id: string; color?: string | null; name?: string | null }[]) || []);
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
      case 'requirements':
        this.callbacks.onRequirements?.(sessionId, {
          target: (msg.target as string | null) ?? null,
          requirements: (msg.requirements as Requirement[]) || [],
          proposals: (msg.proposals as RequirementProposal[]) || [],
          progress: (msg.progress as RequirementProgress) || emptyProgress(),
        });
        break;
      case 'loop':
        this.callbacks.onLoop?.(
          sessionId,
          (msg.loop as LoopState | null) ?? null,
          (msg.progress as RequirementProgress) || emptyProgress(),
        );
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
      case 'keybindings':
        this.callbacks.onKeybindings?.(msg.keybindings as Record<string, string | null>);
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
        this.callbacks.onWelcome({
          spawnMode: (msg.spawnMode as SpawnMode) || 'service',
          viewerIsRemote: msg.viewerIsRemote === true,
        });
        break;
      case 'published_ports':
        this.callbacks.onPublishedPorts?.(msg.sessionId as string, (msg.ports as PublishedPort[]) || []);
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
      case 'branch_changed':
        this.callbacks.onBranchChanged?.(sessionId, (msg.branch as string) || '');
        break;
      case 'session_activity':
        this.callbacks.onSessionActivity?.(sessionId, (msg.activity as SessionActivity) || {
          childProcessCount: 0, processes: [], listeningPorts: [],
        });
        break;
      case 'terminal_env_injected':
        this.callbacks.onTerminalEnvInjected?.({
          sessionId: msg.sessionId as string,
          procId: msg.procId as string,
          env: (msg.env as Record<string, string>) || {},
        });
        break;
      case 'terminal_created':
        this.callbacks.onTerminalCreated?.(sessionId, msg.terminal as TerminalInfo);
        break;
      case 'terminal_removed':
        this.callbacks.onTerminalRemoved?.(sessionId, msg.procId as string);
        break;
    }
  }

  /** Route a session-keyed WS frame to the connection owning that session
   *  (local or the session's remote). Frames without a sessionId go local. */
  private send(msg: object) {
    const sid = (msg as { sessionId?: string }).sessionId;
    const rid = sid ? this.sessionRemote.get(sid) : undefined;
    if (rid) {
      this.ensureRemoteConn(rid).send(msg);
      return;
    }
    this.localConn.send(msg);
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  subscribe(sessionId: string) {
    const rid = this.sessionRemote.get(sessionId);
    if (rid) this.ensureRemoteConn(rid).subscribe(sessionId);
    else this.localConn.subscribe(sessionId);
    // Repopulate the dock with whatever terminals are already alive for this
    // session, as soon as we connect. Best-effort — a not-yet-ready bridge
    // just returns an empty list; a later `terminal_created` fills it in.
    void this.fetchTerminals(sessionId)
      .then(terminals => this.callbacks.onTerminalsSnapshot?.(sessionId, terminals))
      .catch(() => {});
  }
  unsubscribe(sessionId: string) {
    const rid = this.sessionRemote.get(sessionId);
    if (rid) this.remoteConns.get(rid)?.unsubscribe(sessionId);
    else this.localConn.unsubscribe(sessionId);
  }
  getSessionState(sessionId: string) { this.send({ type: 'get_session_state', sessionId }); }
  getSessions() {
    this.localConn.send({ type: 'get_sessions' });
    for (const c of this.remoteConns.values()) c.send({ type: 'get_sessions' });
  }

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

  // ---- Terminal CRUD (REST) ----
  // Lifecycle goes over REST; the terminal appears in the dock only when the
  // server broadcasts `terminal_created` back over the WS. Live I/O
  // (keystrokes / bytes) stays on the WS below.

  /** List every terminal for a session. Fetched on connect + on demand. */
  async fetchTerminals(sessionId: string): Promise<TerminalInfo[]> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/terminals`);
    if (!resp.ok) return [];
    const data = await resp.json() as { terminals?: TerminalInfo[] };
    return data.terminals || [];
  }

  /** Create a terminal. Resolves with the created terminal, but callers should
   *  NOT insert it themselves — the dock adds it when `terminal_created`
   *  arrives over the WS (single source of truth). */
  async createTerminal(
    sessionId: string,
    opts?: { command?: string; cwd?: string; cols?: number; rows?: number; terminalName?: string },
  ): Promise<TerminalInfo | null> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { terminal?: TerminalInfo };
    return data.terminal || null;
  }

  /** Kill + remove a terminal. Close === kill. The dock drops the tab when the
   *  matching `terminal_removed` broadcast arrives. */
  async deleteTerminal(sessionId: string, procId: string): Promise<void> {
    const base = await this.sessionBase(sessionId);
    await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(procId)}`, { method: 'DELETE' });
  }

  // ---- Terminal live I/O (WS) ----

  /** Re-attach a viewer to a live PTY (tab switch / remount / reload). Never
   *  spawns — the server replays the authoritative buffer + resizes. */
  attachTerminal(sessionId: string, procId: string, cols: number, rows: number) {
    this.send({ type: 'terminal_attach', sessionId, procId, cols, rows });
  }

  sendTerminalInput(sessionId: string, procId: string, data: string) {
    this.send({ type: 'terminal_input', sessionId, procId, data });
  }

  resizeTerminal(sessionId: string, procId: string, cols: number, rows: number) {
    this.send({ type: 'terminal_resize', sessionId, procId, cols, rows });
  }

  /** Kill a terminal (alias for deleteTerminal — close === kill). */
  killTerminal(sessionId: string, procId: string) {
    void this.deleteTerminal(sessionId, procId);
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

  /** Change the reasoning effort for a Claude session. Empty string → default.
   *  Takes effect via a server-side respawn-with-resume (spawn-time SDK option). */
  setEffort(sessionId: string, effort: string) {
    this.send({ type: 'set_effort', sessionId, effort });
  }

  // ---------------------------------------------------------------------------
  // REST endpoints (still needed for file ops, git, etc.)
  // ---------------------------------------------------------------------------

  async createSession(
    cwd?: string,
    opts: {
      name?: string; model?: string | null; permissionMode?: string;
      effort?: string | null;
      provider?: string; remoteId?: string | null;
      /** Override the path used for server-side autogrouping. Defaults to
       *  `cwd`. Set when the session is spawned in a worktree so it lands
       *  in the parent repo's autogroup instead of one named after the
       *  worktree branch. */
      groupCwd?: string;
    } = {},
  ): Promise<SessionInfo> {
    const remoteId = opts.remoteId ?? null;
    // Remote sessions are created DIRECTLY on the remote bridge (through its
    // tunnel) — the remote is just a normal bridge, so no remoteId in the body.
    let base = this.serverUrl;
    if (remoteId) {
      this.ensureRemoteConn(remoteId);
      base = (await this.ensureRemoteBaseUp(remoteId)) ?? this.serverUrl;
    }
    const resp = await authedFetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: cwd || '/',
        name: opts.name,
        model: opts.model,
        permissionMode: opts.permissionMode,
        effort: opts.effort,
        provider: opts.provider,
        group_cwd: opts.groupCwd,
      }),
    });
    if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
    const session = await resp.json() as SessionInfo;
    if (remoteId) {
      // Record the mapping so subsequent REST/WS route to this remote; the
      // remote's `sessions` broadcast will surface it in the merged list.
      this.sessionRemote.set(session.id, remoteId);
      const meta = this.remoteMeta.get(remoteId);
      session.remoteId = remoteId;
      session.remoteColor = meta?.color ?? null;
      session.remoteName = meta?.name ?? null;
    }
    return session;
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}/resume`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Failed to resume: ${resp.status}`);
    return resp.json();
  }

  async renameSession(sessionId: string, name: string): Promise<SessionInfo> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`Failed to rename: ${resp.status}`);
    return resp.json();
  }

  async stopSession(sessionId: string): Promise<void> {
    const base = await this.sessionBase(sessionId);
    await authedFetch(`${base}/sessions/${sessionId}/stop`, { method: 'POST' });
  }

  /** Restart the provider for a session in place — closes and re-spawns it
   *  with the same id so conversation history is preserved. Used to pick up
   *  MCP-config changes (added/removed servers only load at spawn time). */
  async restartSession(sessionId: string): Promise<SessionInfo> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}/restart`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Failed to restart: ${resp.status}`);
    return resp.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const base = await this.sessionBase(sessionId);
    await authedFetch(`${base}/sessions/${sessionId}`, { method: 'DELETE' });
  }

  /** Permanently remove a session: drops it from the registry and deletes
   *  its on-disk chat history + UI state. Pass `worktree: true` to also
   *  remove the underlying git worktree (when the session's cwd matches the
   *  `.worktrees/<branch>` convention, or the legacy `.wt/<branch>`). */
  async purgeSession(
    sessionId: string,
    opts: { worktree?: boolean } = {},
  ): Promise<{ ok: boolean; worktree?: { removed: boolean; method: string }; history?: boolean }> {
    const params = new URLSearchParams({ purge: '1' });
    if (opts.worktree) params.set('worktree', '1');
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}?${params}`, { method: 'DELETE' });
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
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}`, {
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

  /** Archive before stopping so the stop broadcast cannot briefly resurface
   *  the session with its previous open status. */
  async archiveAndStopSession(sessionId: string): Promise<void> {
    try {
      await this.archiveSession(sessionId);
    } finally {
      await this.stopSession(sessionId);
    }
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
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(`${base}/sessions/${sessionId}/clear`, {
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/ls?prefix=${encodeURIComponent(prefix)}`));
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/files?path=${encodeURIComponent(dirPath)}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  async readFile(path: string): Promise<{ path: string; content: string } | null> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Page of chat history strictly older than `beforeSeq`, oldest-first.
   *  The store only keeps a window of each transcript; the "Show older"
   *  button pulls earlier slices from the server's JSONL-backed state. */
  async fetchOlderMessages(sessionId: string, beforeSeq: number, limit = 200): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/sessions/${sessionId}/messages?before_seq=${beforeSeq}&limit=${limit}`));
    if (!resp.ok) throw new Error(`Failed to load older messages: ${resp.status}`);
    return resp.json();
  }

  /** Fetch a file's raw bytes (with auth) and return a `data:` URL suitable for
   *  an <img src>. Used by the image preview tab — an <img> can't carry the
   *  Authorization header itself, so we read the blob here and inline it. */
  async readFileDataUrl(path: string): Promise<string | null> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-raw?path=${encodeURIComponent(path)}`));
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-content`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return resp.ok;
  }

  /** Read a file's raw bytes for the file-explorer "Download" action. On a
   *  remote session `withActiveRemote` routes this through the SSH tunnel, so
   *  the bytes are read on the remote machine. Returns null on failure. */
  async readFileBytes(path: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-raw?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return null;
    const mime = resp.headers.get('content-type') || 'application/octet-stream';
    return { bytes: await resp.arrayBuffer(), mime };
  }

  /** Write raw bytes to a file for the file-explorer "Upload" action. On a
   *  remote session this is proxied over the SSH tunnel, so the file lands on
   *  the remote filesystem. */
  async uploadFileBytes(path: string, bytes: ArrayBuffer | Uint8Array): Promise<boolean> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-raw?path=${encodeURIComponent(path)}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
    return resp.ok;
  }

  /** Persist a large pasted snippet under ~/.codiby/<sessionId>/<uuid><.ext>.
   *  Returns the absolute path + generated filename, or null on failure. */
  async saveSnippet(sessionId: string, content: string, ext?: string): Promise<{ path: string; name: string; uuid: string } | null> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/snippet`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, content, ext }),
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  async deletePath(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-content?path=${encodeURIComponent(path)}`), { method: 'DELETE' });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async renamePath(from: string, to: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-rename`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async createFile(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-new`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, kind: 'file' }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }

  async createDir(path: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-new`), {
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-original?path=${encodeURIComponent(path)}${baseParam}`));
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.content || '';
  }

  async getGitInfo(path: string): Promise<{
    is_git: boolean; branch?: string; top_level?: string;
    worktrees?: { path: string; branch: string }[];
    parent_branch?: string | null;
    package_manager?: string; has_env?: boolean;
  }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/git-info?path=${encodeURIComponent(path)}`));
    if (!resp.ok) return { is_git: false };
    return resp.json();
  }

  async getGitModified(root: string, base?: string | null): Promise<{ path: string; staged: boolean; untracked?: boolean; additions?: number; deletions?: number }[]> {
    const baseParam = base ? `&base=${encodeURIComponent(base)}` : '';
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/git-modified?root=${encodeURIComponent(root)}${baseParam}`));
    if (!resp.ok) return [];
    return resp.json();
  }

  async gitStage(root: string, files: string[], unstage = false): Promise<boolean> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/git-stage`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, files, unstage }),
    });
    return resp.ok;
  }

  async listBranches(cwd: string): Promise<{ current: string; local: string[]; remote: string[] }> {
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/git-branches?cwd=${encodeURIComponent(cwd)}`));
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/git-checkout`), {
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/search?${params}`), { signal: opts.signal });
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

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  /** List skills for a scope. `root` (the project cwd) is required for 'project'. */
  async listSkills(scope: SkillScope, root?: string | null): Promise<SkillSummary[]> {
    const params = new URLSearchParams({ scope });
    if (root) params.set('root', root);
    const resp = await authedFetch(`${this.serverUrl}/skills?${params}`);
    if (!resp.ok) return [];
    return resp.json();
  }

  /** Read one skill in full (includes raw markdown `content`). */
  async getSkill(id: string): Promise<SkillDetail | null> {
    const resp = await authedFetch(`${this.serverUrl}/skills/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Create a skill in the given scope. `root` required for 'project'. */
  async createSkill(scope: SkillScope, root: string | null, input: SkillCreateInput): Promise<SkillDetail | { error: string }> {
    const params = new URLSearchParams({ scope });
    if (root) params.set('root', root);
    const resp = await authedFetch(`${this.serverUrl}/skills?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  }

  /** Patch a skill by its opaque id. */
  async updateSkill(id: string, patch: SkillUpdateInput): Promise<SkillDetail | { error: string }> {
    const resp = await authedFetch(`${this.serverUrl}/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
  }

  /** Delete a skill by its opaque id. */
  async deleteSkill(id: string): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return resp.json().catch(() => ({ ok: resp.ok }));
  }

  // -------------------------------------------------------------------------
  // Session resources — pasted images, generated mockups, uploaded files.
  // -------------------------------------------------------------------------

  /** List a session's resources, newest first. Optionally filter by kind. */
  // ---------------------------------------------------------------------------
  // Requirements + Loop.
  //
  // Approving, waiving, deleting and resolving proposals exist ONLY here: the
  // agent's MCP tools are append-only by design, so every one of these calls is
  // a deliberate user action. Mutations return the fresh snapshot, and the
  // server also broadcasts `requirements` over the WS, so callers can rely on
  // either path.
  // ---------------------------------------------------------------------------

  async fetchRequirements(sessionId: string): Promise<RequirementsSnapshot | null> {
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return null; }
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/requirements`);
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  }

  private async requirementsCall(
    sessionId: string,
    path: string,
    init?: RequestInit,
  ): Promise<RequirementsSnapshot | null> {
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return null; }
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}${path}`, init);
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  }

  private static jsonInit(method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    };
  }

  setRequirementsTarget(sessionId: string, target: string) {
    return this.requirementsCall(sessionId, '/requirements/target', ClaudeClient.jsonInit('PUT', { target }));
  }

  /** Approve a draft so it becomes binding, or send a locked one back. */
  setRequirementState(
    sessionId: string,
    rid: string,
    action: 'lock' | 'unlock' | 'waive',
    reason?: string,
  ) {
    return this.requirementsCall(
      sessionId,
      `/requirements/${encodeURIComponent(rid)}`,
      ClaudeClient.jsonInit('PATCH', { action, reason }),
    );
  }

  editRequirement(sessionId: string, rid: string, patch: { title?: string; check?: unknown }) {
    return this.requirementsCall(
      sessionId,
      `/requirements/${encodeURIComponent(rid)}`,
      ClaudeClient.jsonInit('PATCH', patch),
    );
  }

  deleteRequirement(sessionId: string, rid: string) {
    return this.requirementsCall(sessionId, `/requirements/${encodeURIComponent(rid)}`, { method: 'DELETE' });
  }

  /** Run every check, or just `ids`. Resolves once the server is done. */
  runRequirements(sessionId: string, ids?: string[]) {
    return this.requirementsCall(sessionId, '/requirements/run', ClaudeClient.jsonInit('POST', ids ? { ids } : {}));
  }

  resolveRequirementProposal(sessionId: string, pid: string, decision: 'approve' | 'reject') {
    return this.requirementsCall(
      sessionId,
      `/proposals/${encodeURIComponent(pid)}/${decision}`,
      ClaudeClient.jsonInit('POST'),
    );
  }

  async fetchRequirementEvents(sessionId: string, limit = 200): Promise<RequirementEvent[]> {
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return []; }
    const resp = await authedFetch(
      `${base}/sessions/${encodeURIComponent(sessionId)}/requirements/events?limit=${limit}`,
    );
    if (!resp.ok) return [];
    const data = await resp.json().catch(() => ({})) as { events?: RequirementEvent[] };
    return data.events || [];
  }

  /**
   * Arm / pause / resume / stop Loop mode. Deliberately user-only — there is no
   * MCP tool for any of these, because loop is bypass permissions plus
   * unattended auto-continuation.
   */
  async loopControl(
    sessionId: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
  ): Promise<{ loop: LoopState | null; progress: RequirementProgress } | null> {
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return null; }
    const resp = await authedFetch(
      `${base}/sessions/${encodeURIComponent(sessionId)}/loop/${action}`,
      { method: 'POST' },
    );
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  }

  async fetchLoop(sessionId: string): Promise<{ loop: LoopState | null; progress: RequirementProgress } | null> {
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return null; }
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/loop`);
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  }

  async listResources(sessionId: string, kind?: string): Promise<SessionResource[]> {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    // Resources live on the bridge that owns the session — route to the
    // remote's tunnel base, never the local bridge (which has none of them).
    let base: string;
    try { base = await this.sessionBase(sessionId); } catch { return []; }
    const resp = await authedFetch(`${base}/sessions/${encodeURIComponent(sessionId)}/resources${qs}`);
    if (!resp.ok) return [];
    return resp.json().catch(() => []);
  }

  /** Delete a single resource (blob + manifest entry). */
  async deleteResource(sessionId: string, rid: string): Promise<{ ok: boolean; error?: string }> {
    const base = await this.sessionBase(sessionId);
    const resp = await authedFetch(
      `${base}/sessions/${encodeURIComponent(sessionId)}/resources/${encodeURIComponent(rid)}`,
      { method: 'DELETE' },
    );
    return resp.json().catch(() => ({ ok: resp.ok }));
  }

  /** Token-authed URL for a resource's raw bytes — safe to use as `<img src>`.
   *  Sync, so it routes via the session's last-known tunnel base. */
  resourceRawUrl(sessionId: string, rid: string): string {
    const base = this.baseForSession(sessionId);
    return withToken(`${base}/sessions/${encodeURIComponent(sessionId)}/resources/${encodeURIComponent(rid)}/raw`);
  }

  // ---------------------------------------------------------------------------
  // Published ports — this machine's local ports pushed out to a browser
  // running somewhere else. The opposite direction to the SSH forwards below,
  // and always the local bridge's job, so these go over plain HTTP.
  // ---------------------------------------------------------------------------

  async listPublishedPorts(sessionId: string): Promise<PublishedPort[]> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/published-ports`);
    if (!resp.ok) throw new Error(`Failed to load published ports (${resp.status})`);
    return resp.json();
  }

  async publishPort(
    sessionId: string,
    body: { port: number; publicPort?: number | null; host?: string; label?: string },
  ): Promise<PublishedPort> {
    const resp = await authedFetch(`${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/published-ports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // The server sends a readable reason for both 409 (port taken) and 400
      // (bad input); surfacing the status number instead would waste it.
      const detail = await resp.json().catch(() => null);
      throw new Error(detail?.error || `Failed to publish port (${resp.status})`);
    }
    return resp.json();
  }

  async unpublishPort(sessionId: string, publicPort: number): Promise<void> {
    const resp = await authedFetch(
      `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/published-ports/${publicPort}`,
      { method: 'DELETE' },
    );
    if (!resp.ok) {
      const detail = await resp.json().catch(() => null);
      throw new Error(detail?.error || `Failed to close port ${publicPort}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Port forwards (remote sessions only). Electron main owns the SSH
  // ControlMaster now, so add/list/remove go through main IPC keyed by the
  // session's remoteId. No-op for local sessions.
  // ---------------------------------------------------------------------------

  async listPortForwards(sessionId: string): Promise<{ localPort: number; remotePort: number; label?: string }[]> {
    const remoteId = this.sessionRemote.get(sessionId);
    if (!remoteId) return [];
    return (await getNative()?.invoke<{ localPort: number; remotePort: number; label?: string }[]>('remote_forward_list', { remoteId })) ?? [];
  }

  async addPortForward(
    sessionId: string,
    body: { remotePort: number; localPort?: number | null; label?: string },
  ): Promise<{ localPort: number; remotePort: number; label?: string }> {
    const remoteId = this.sessionRemote.get(sessionId);
    if (!remoteId) throw new Error('Port forwards are only available for remote sessions');
    const native = getNative();
    if (!native) throw new Error('Port forwards require the desktop app');
    const { localPort } = await native.invoke<{ localPort: number }>('remote_forward_add', {
      remoteId, remotePort: body.remotePort, localPort: body.localPort ?? null, label: body.label,
    });
    return { localPort, remotePort: body.remotePort, label: body.label };
  }

  async removePortForward(sessionId: string, localPort: number, remotePort: number): Promise<void> {
    const remoteId = this.sessionRemote.get(sessionId);
    if (!remoteId) return;
    await getNative()?.invoke('remote_forward_remove', { remoteId, localPort, remotePort });
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

  /** Toggle Tailscale Funnel. Used by the Portless proxy pane to clear a
   *  Funnel-on-:443 conflict before retrying an HTTPS start. */
  async setTailscaleFunnel(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const resp = await authedFetch(`${this.serverUrl}/tailscale/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ funnelEnabled: enabled }),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok && !data.error, error: data.error };
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

  /** Read the user's keyboard-shortcut overrides (command id → chord, or null
   *  to force-unbind). Defaults live in the frontend registry, not here. */
  async getKeybindings(): Promise<Record<string, string | null>> {
    const resp = await authedFetch(`${this.serverUrl}/keybindings`);
    if (!resp.ok) return {};
    return resp.json();
  }

  /** Replace the whole override map (not a merge — sending without a key
   *  deletes that override). The server persists and broadcasts the result. */
  async updateKeybindings(overrides: Record<string, string | null>): Promise<boolean> {
    const resp = await authedFetch(`${this.serverUrl}/keybindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(overrides),
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
    const resp = await authedFetch(await this.remoteUrl(`${this.serverUrl}/file-index?root=${encodeURIComponent(root)}`));
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
    this.tunnelStatusUnlisten?.();
    this.tunnelStatusUnlisten = null;
    if (this.bgCloseTimer) { clearTimeout(this.bgCloseTimer); this.bgCloseTimer = null; }
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
    this.localConn.destroy();
    for (const [rid, c] of this.remoteConns) { c.destroy(); this.releaseRemote(rid); }
    this.remoteConns.clear();
  }
}
