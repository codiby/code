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

export type ImageInput = {
  media_type: string;
  data: string;
};

export type McpServerSpec =
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
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
  model: string | null;
  permissionMode: PermissionMode;
  /** Provider-specific resume token (e.g. a Claude session UUID). */
  resumeSessionId?: string | null;
  mcpServers?: Record<string, McpServerSpec>;
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
};
export type AssistantContentBlock = AssistantTextBlock | AssistantToolUseBlock;

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
  onInit(info: InitInfo): void;
  onAssistantDelta(text: string): void;
  onAssistantText(text: string, meta?: { model?: string; usage?: TokenUsage; parentToolUseId?: string | null }): void;
  onToolUse(tool: AssistantToolUseBlock): void;
  onToolResult(result: { toolUseId?: string; content: unknown; isError?: boolean; parentToolUseId?: string | null }): void;
  onTodosUpdate(todos: unknown[]): void;
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
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly name: string;
  spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession;
}
