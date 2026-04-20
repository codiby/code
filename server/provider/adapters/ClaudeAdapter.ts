/**
 * ClaudeAdapter — Claude Agent SDK-backed provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` behind the generic
 * `ProviderAdapter` interface. The SDK runs in-process; no CLI binary is
 * spawned. Auth is read from the user's `claude login` credentials.
 */

import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options as ClaudeQueryOptions,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

import type {
  AssistantToolUseBlock,
  ImageInput,
  McpServerSpec,
  PermissionMode,
  ProviderAdapter,
  ProviderEvents,
  ProviderSession,
  SpawnOptions,
  TokenUsage,
} from '../types';
import { CLAUDE_BIN } from '../../config';

const PROVIDER_NAME = 'claudeAgent';

function toSdkMcpServers(
  mcp: Record<string, McpServerSpec> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!mcp) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(mcp)) {
    if (spec.type === 'sse') out[name] = { type: 'sse', url: spec.url, headers: spec.headers };
    else if (spec.type === 'http') out[name] = { type: 'http', url: spec.url, headers: spec.headers };
    else if (spec.type === 'stdio') out[name] = { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
  }
  return out;
}

function toSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  return mode as SdkPermissionMode;
}

/**
 * Push/pull queue used as the `prompt` input for `query()`.
 *
 * The SDK consumes an `AsyncIterable<SDKUserMessage>`. We keep the iterator
 * alive for the lifetime of the session and feed messages via `push()`.
 * `close()` resolves the iterator's return so the SDK can finalize cleanly.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private pendingResolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise((resolve) => {
          this.pendingResolve = resolve;
        });
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
      },
    };
  }
}

function buildUserMessage(text: string, images?: ImageInput[], sessionId?: string): SDKUserMessage {
  const hasImages = images && images.length > 0;
  const content = hasImages
    ? [
        ...images!.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.media_type as any, data: img.data },
        })),
        { type: 'text' as const, text },
      ]
    : text;

  return {
    type: 'user',
    message: { role: 'user', content: content as any },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

class ClaudeSession implements ProviderSession {
  readonly provider = PROVIDER_NAME;
  readonly sessionId: string;

  private readonly prompts: PromptQueue;
  private readonly events: ProviderEvents;
  private readonly pendingPermissions = new Map<string, (decision: PermissionResult) => void>();
  private runtime: Query | null = null;
  private providerSessionId: string | null = null;
  private closed = false;

  constructor(sessionId: string, events: ProviderEvents) {
    this.sessionId = sessionId;
    this.events = events;
    this.prompts = new PromptQueue();
  }

  start(opts: SpawnOptions): void {
    const canUseTool: CanUseTool = async (toolName, input, callbackOptions) => {
      const requestId = callbackOptions.toolUseID || randomUUID();
      const decision = await this.events.onPermissionRequest({
        requestId,
        toolName,
        displayName: callbackOptions.displayName,
        description: callbackOptions.description,
        title: callbackOptions.title,
        input,
      });
      if (decision.allow) {
        return {
          behavior: 'allow',
          updatedInput: decision.updatedInput ?? input,
        };
      }
      return {
        behavior: 'deny',
        message: decision.message || `Denied by user: ${toolName}`,
        interrupt: decision.interrupt ?? false,
      };
    };

    const sdkOptions: ClaudeQueryOptions = {
      cwd: opts.cwd,
      canUseTool,
      includePartialMessages: true,
      permissionMode: toSdkPermissionMode(opts.permissionMode),
      mcpServers: toSdkMcpServers(opts.mcpServers),
      pathToClaudeCodeExecutable: CLAUDE_BIN,
    };
    if (opts.model) sdkOptions.model = opts.model;
    if (opts.resumeSessionId) sdkOptions.resume = opts.resumeSessionId;
    if (opts.permissionMode === 'bypassPermissions') sdkOptions.allowDangerouslySkipPermissions = true;

    try {
      this.runtime = query({ prompt: this.prompts, options: sdkOptions });
    } catch (err) {
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
      this.events.onExit(1);
      return;
    }

    this.drain().catch((err) => {
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async drain(): Promise<void> {
    if (!this.runtime) return;
    try {
      for await (const msg of this.runtime) {
        if (this.closed) break;
        this.dispatch(msg);
      }
      this.events.onExit(0);
    } catch (err) {
      if (!this.closed) {
        this.events.onError(err instanceof Error ? err : new Error(String(err)));
        this.events.onExit(1);
      }
    }
  }

  private dispatch(msg: SDKMessage): void {
    // System init — capture session id and basic info.
    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      const init = msg as any;
      this.providerSessionId = init.session_id as string;
      const tools: string[] = Array.isArray(init.tools) ? init.tools : [];
      this.events.onInit({
        providerSessionId: this.providerSessionId ?? '',
        cwd: (init.cwd as string) || '',
        version: (init.claude_code_version as string) || '',
        model: (init.model as string) || '',
        tools,
        slashCommands: Array.isArray(init.slash_commands) ? init.slash_commands : [],
        permissionMode: (init.permissionMode as string) || 'default',
      });
      return;
    }

    if (msg.type === 'assistant') {
      const assistant = msg as any;
      const content = assistant.message?.content;
      if (!Array.isArray(content)) return;

      let partialText = '';
      for (const block of content) {
        if (block.type === 'text') {
          partialText += block.text as string;
        } else if (block.type === 'tool_use') {
          if (partialText.trim()) {
            this.events.onAssistantText(partialText, { model: assistant.message?.model });
            partialText = '';
          }
          const tool: AssistantToolUseBlock = {
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            input: (block.input as Record<string, unknown>) ?? {},
          };
          if (tool.name === 'TodoWrite') {
            const todos = (tool.input as any)?.todos ?? [];
            this.events.onTodosUpdate(todos);
          } else {
            this.events.onToolUse(tool);
          }
        }
      }

      const stopReason = assistant.message?.stop_reason as string | null | undefined;
      const usage = assistant.message?.usage as TokenUsage | undefined;

      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        if (partialText.trim()) {
          this.events.onAssistantText(partialText, { model: assistant.message?.model, usage });
        }
        this.events.onAutoNameCandidate(partialText);
        this.events.onTurnComplete({ stopReason, model: assistant.message?.model, usage });
      } else if (partialText) {
        this.events.onAssistantDelta(partialText);
      }
      return;
    }

    if (msg.type === 'user') {
      const user = msg as any;
      const content = user.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === 'tool_result') {
          this.events.onToolResult({
            toolUseId: block.tool_use_id as string | undefined,
            content: block.content,
            isError: block.is_error as boolean | undefined,
          });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      const result = msg as any;
      this.events.onTurnComplete({
        stopReason: result.stop_reason ?? null,
        resultText: typeof result.result === 'string' ? result.result : undefined,
        costUsd: result.total_cost_usd as number | undefined,
        durationMs: result.duration_ms as number | undefined,
        usage: result.usage as TokenUsage | undefined,
      });
      return;
    }
  }

  async sendUserMessage(input: { text: string; images?: ImageInput[] }): Promise<void> {
    if (this.closed) return;
    this.prompts.push(buildUserMessage(input.text, input.images, this.providerSessionId ?? undefined));
  }

  async interrupt(): Promise<void> {
    if (!this.runtime) return;
    try { await this.runtime.interrupt(); } catch {}
  }

  async setModel(model: string | null): Promise<void> {
    if (!this.runtime) return;
    try { await this.runtime.setModel(model ?? undefined); } catch {}
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.runtime) return;
    try { await this.runtime.setPermissionMode(toSdkPermissionMode(mode)); } catch {}
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.prompts.close();
    try { this.runtime?.close(); } catch {}
    this.runtime = null;
    // Reject any pending permission decisions so canUseTool doesn't hang.
    for (const resolve of this.pendingPermissions.values()) {
      try { resolve({ behavior: 'deny', message: 'Session closed', interrupt: true }); } catch {}
    }
    this.pendingPermissions.clear();
  }
}

export const ClaudeAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,
  spawn(opts, events) {
    const session = new ClaudeSession(opts.sessionId, events);
    session.start(opts);
    return session;
  },
};
