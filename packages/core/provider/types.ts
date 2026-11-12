/**
 * Provider-neutral adapter contracts.
 *
 * Each provider (Claude Agent, Codex, Cursor, ...) implements `ProviderAdapter`
 * to expose a uniform lifecycle to the bridge server. The adapter owns its
 * runtime transport (SDK, CLI, RPC) and surfaces events through `ProviderEvents`.
 *
 * The bridge observes events, translates them into state updates + WebSocket
 * broadcasts, and never touches the underlying transport directly.
 */

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan';

/** Reasoning-effort level. Claude uses it directly; OpenCode maps it to a model variant. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ImageInput = {
  media_type: string;
  data: string;
};

/** Per-call wall-clock budget for a remote MCP server's tools, in ms. Adapters
 *  pass it through to the provider SDK, which otherwise applies its own (much
 *  shorter) default — see the `codiby-code` spec in lifecycle.ts. */
export type McpServerSpec =
  | { type: 'sse'; url: string; headers?: Record<string, string>; timeoutMs?: number }
  | { type: 'http'; url: string; headers?: Record<string, string>; timeoutMs?: number }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  /**
   * An in-process SDK MCP server pre-built via the provider SDK's own helpers
   * (e.g. `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`).
   * The adapter passes the `server` object through untouched so tools run
   * inside the bridge process with access to session state.
   */
  | { type: 'sdk'; server: unknown };

export type SpawnOptions = {
  sessionId: string;
  cwd: string;
  /** Workspace folders besides `cwd` the agent may read and write. */
  additionalDirectories?: string[];
  model: string | null;
  permissionMode: PermissionMode;
  /** Reasoning effort. Claude requires a respawn to apply it; OpenCode maps it
   *  to a per-prompt model variant. Null/undefined → provider default. */
  effort?: EffortLevel | null;
  /** Provider-specific resume token (e.g. a Claude session UUID). */
  resumeSessionId?: string | null;
  /** Branch the conversation behind `resumeSessionId` into a new one instead
   *  of continuing it, so the source session keeps its own history. The
   *  adapter reports the fork's id through `onInit`. */
  forkSession?: boolean;
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Extra steering appended to the provider's system prompt for this session
   * only. Currently the remote-viewer briefing (see network/remote-viewer.ts),
   * which depends on where the user's browser is and so can't live in the
   * adapter's static preamble. Adapters with no system-prompt hook ignore it —
   * the same guidance also arrives as a turn-level reminder.
   */
  extraSystemPrompt?: string | null;
};

export type InitInfo = {
  providerSessionId: string;
  cwd: string;
  version: string;
  model: string;
  tools: string[];
  slashCommands: string[];
  permissionMode: string;
};

export type AssistantTextBlock = { type: 'text'; text: string };
export type AssistantToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * For tool calls made by a sub-agent (spawned via the Agent tool), this is
   * the tool_use id of the parent Agent invocation. `null`/undefined for
   * top-level tool calls. Surfaces the SDK's `parent_tool_use_id` so the UI
   * can group sub-agent activity inside the Agent card.
   */
  parentToolUseId?: string | null;
  /** SDK agent id of the sub-agent that made the call (equals its task id). */
  agentId?: string | null;
};
export type AssistantThinkingBlock = {
  type: 'thinking';
  /** Plain-text reasoning summary the model exposed for this turn. */
  text: string;
  /** Set when the SDK delivered a `redacted_thinking` block — the text is a
   *  placeholder, the actual reasoning is encrypted for multi-turn replay. */
  redacted?: boolean;
  parentToolUseId?: string | null;
  agentId?: string | null;
};
export type AssistantContentBlock = AssistantTextBlock | AssistantToolUseBlock | AssistantThinkingBlock;

/**
 * A background task the provider is running for the session — a sub-agent
 * (Agent tool), a workflow, a shell. Built from the Claude Agent SDK's
 * `task_started` / `task_progress` / `task_updated` / `task_notification`
 * system messages (see session/tasks.ts for the reducer).
 */
export type SubagentTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'killed';

export type SubagentTask = {
  /** SDK task id. For sub-agents it is also the agent id stamped on every message the agent produces. */
  taskId: string;
  /** The tool_use that started it (Agent / Workflow tool call), when known. */
  toolUseId: string | null;
  /** SDK discriminant: 'local_agent', 'local_workflow', 'local_bash', … */
  taskType: string;
  description: string;
  subagentType: string | null;
  workflowName: string | null;
  prompt: string | null;
  status: SubagentTaskStatus;
  backgrounded: boolean;
  /** 1 = started by the main agent, 2 = by one of its sub-agents… */
  spawnDepth: number;
  startedAt: number;
  endedAt: number | null;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName: string | null;
  /** Live one-line progress (task_progress summary / description). */
  progress: string | null;
  /** What the task returned (task_notification summary). */
  summary: string | null;
  error: string | null;
};

/** One SDK task message, normalised by the adapter. */
export type TaskEvent =
  | { kind: 'started'; taskId: string; toolUseId?: string | null; taskType?: string; description?: string; subagentType?: string | null; workflowName?: string | null; prompt?: string | null; backgrounded?: boolean; spawnDepth?: number }
  | { kind: 'progress'; taskId: string; toolUseId?: string | null; description?: string; subagentType?: string | null; totalTokens?: number; toolUses?: number; durationMs?: number; lastToolName?: string | null; summary?: string | null }
  | { kind: 'updated'; taskId: string; status?: SubagentTaskStatus; description?: string; endTime?: number | null; error?: string | null; backgrounded?: boolean }
  | { kind: 'notification'; taskId: string; toolUseId?: string | null; status: 'completed' | 'failed' | 'stopped'; summary?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | { kind: 'snapshot'; tasks: { taskId: string; taskType?: string; subagentType?: string | null; description?: string }[] };

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type TurnCompleteInfo = {
  stopReason?: string | null;
  resultText?: string;
  costUsd?: number;
  durationMs?: number;
  usage?: TokenUsage;
  model?: string;
  /**
   * The provider says the turn failed rather than answered (Claude: a result
   * with `is_error`, or an `error_*` subtype). `resultText` is then the
   * provider's error ("Not logged in · Please run /login"), not the model's
   * words — the agent's dispatch relays it as a Codiby notice.
   */
  isError?: boolean;
  /** Error details a failed turn carried (Claude's `result.errors`). */
  errors?: string[];
};

/**
 * Static descriptor for a model the provider exposes for selection. Sourced
 * from the provider once a session is alive (e.g. Claude Agent SDK's
 * `runtime.supportedModels()`) and broadcast to the frontend so the model
 * picker reflects the live list instead of a hardcoded fallback.
 */
export type ProviderModelInfo = {
  id: string;
  label: string;
  description?: string;
};

export type PermissionRequestDetail = {
  requestId: string;
  toolName: string;
  displayName?: string;
  description?: string;
  title?: string;
  input: Record<string, unknown>;
};

export type PermissionDecision =
  | { allow: true; updatedInput?: Record<string, unknown> }
  | { allow: false; message?: string; interrupt?: boolean };

/**
 * Event sink implemented by the bridge. Adapters emit structured events here;
 * the bridge handles persistence, dedup, and fan-out to WebSocket clients.
 *
 * `onPermissionRequest` returns a promise: the adapter awaits the bridge's
 * decision (which may come from auto-accept logic or a user click).
 */
export interface ProviderEvents {
  /** Provider-reported context compaction; never inferred from response latency. */
  onCompaction?(active: boolean): void;
  onInit(info: InitInfo): void;
  /** Slash commands (skills included) known before the first turn. The SDK
   *  answers this as soon as the CLI initializes, while `onInit` waits for a
   *  prompt — without it the `/` picker is empty until the first message. */
  onSlashCommands?(commands: string[]): void;
  onAssistantDelta(text: string): void;
  onAssistantText(text: string, meta?: { model?: string; usage?: TokenUsage; parentToolUseId?: string | null; agentId?: string | null }): void;
  /**
   * Cumulative live-streaming thinking text. Fires multiple times per turn
   * as `thinking_delta` events arrive over the SDK's partial-message channel.
   * The UI shows this as a transient italic bubble that morphs into the
   * permanent `onThinking()` ChatMessage once the block is committed.
   */
  onThinkingDelta(text: string): void;
  onThinking(block: AssistantThinkingBlock): void;
  onToolUse(tool: AssistantToolUseBlock): void;
  onToolResult(result: { toolUseId?: string; content: unknown; isError?: boolean; parentToolUseId?: string | null; agentId?: string | null }): void;
  onTodosUpdate(todos: unknown[]): void;
  /** Sub-agent / workflow / shell task lifecycle (Claude SDK task_* messages). */
  onTaskEvent?(event: TaskEvent): void;
  onModelsAvailable(models: ProviderModelInfo[]): void;
  onPermissionRequest(req: PermissionRequestDetail): Promise<PermissionDecision>;
  onTurnComplete(info: TurnCompleteInfo): void;
  onError(err: Error): void;
  onExit(code: number | null): void;
}

/**
 * A running provider session. Created by `ProviderAdapter.spawn()`.
 * All methods are safe to call after spawn; adapters should no-op after close.
 */
export interface ProviderSession {
  readonly sessionId: string;
  readonly provider: string;
  sendUserMessage(input: { text: string; images?: ImageInput[] }): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string | null): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Follow a workspace change mid-session (see session/workspace.ts).
   *  Optional: a provider without it picks the change up on its next spawn. */
  setWorkspace?(workspace: { cwd: string; additionalDirectories: string[] }): Promise<void>;
  /** Stop one background task (sub-agent, workflow…). Optional. */
  stopTask?(taskId: string): Promise<void>;
  /** Move a foreground task to the background so the turn continues. Optional. */
  backgroundTask?(toolUseId?: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly name: string;
  spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession;
}
