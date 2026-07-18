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
  ProviderEvents,
  ProviderSession,
  SpawnOptions,
  TokenUsage,
} from '../types';
import { Adapter } from '../adapter';
import { AsyncQueue } from '../async-queue';
import { ProviderSessionBase } from '../session';
import { CLAUDE_BIN } from '../../config/config';
import { log } from '../../lib/logger';

const PROVIDER_NAME = 'claude';

/**
 * Extra steering appended to Claude Code's default system prompt. Keeps the
 * preset (so all the built-in tool/file/git context still applies) and adds
 * Codiby Code-specific guidance — currently the rename policy that complements
 * the `rename_session` tool description.
 */
const CODIBY_CODE_SYSTEM_PROMPT_APPEND = [
  'Output formatting (Codiby Code-specific):',
  '- This interface is a chat UI with a full markdown renderer, not a terminal. Disregard any terminal-oriented guidance to avoid headers.',
  '- Whenever an answer has multiple parts, sections, or distinct topics, structure it with markdown headers (## and ###), regardless of length. Use lists, tables, and code blocks wherever they aid clarity.',
  '- Only keep an answer as plain prose when it is genuinely a single point — do not add a header just to introduce one sentence.',
  '',
  'Session naming (Codiby Code-specific):',
  '- A `rename_session` tool is available via the codiby-code-sdk MCP server. Call it exactly once per session, immediately after the first user message — no exceptions.',
  '- This applies to EVERY first message, including greetings ("hi", "hello"), chitchat, vague questions, or one-word inputs. Do not skip the rename because the message looks low-stakes — derive the best name you can from whatever the user said (e.g. "Greeting", "Quick Question").',
  '- Treat the call as final. Do not call the tool a second time even if the task evolves; the user can rename manually later.',
  '- Names must fit a narrow sidebar tab — aim for ≤ 24 characters. Format: "{TICKET-ID} {3-4 word Title Case description}", omitting the ticket id if none was mentioned.',
].join('\n');

function toSdkMcpServers(
  mcp: Record<string, McpServerSpec> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!mcp) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(mcp)) {
    if (spec.type === 'sse') out[name] = { type: 'sse', url: spec.url, headers: spec.headers };
    else if (spec.type === 'http') out[name] = { type: 'http', url: spec.url, headers: spec.headers };
    else if (spec.type === 'stdio') out[name] = { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
    else if (spec.type === 'sdk') out[name] = spec.server as McpServerConfig;
  }
  return out;
}

function toSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  // We drive every permission decision through `canUseTool` (see
  // bridge.onPermissionRequest), which auto-approves in bypass mode but still
  // prompts for USER_INTERACTION_TOOLS (AskUserQuestion / ExitPlanMode).
  // The Claude Code CLI, however, short-circuits the whole `can_use_tool`
  // round-trip when it runs in `bypassPermissions` — it resolves those tools
  // itself and auto-rejects AskUserQuestion, never giving the user a chance to
  // answer. Map bypass to `default` so the CLI keeps routing tool uses through
  // our callback; the bridge is what actually auto-approves in bypass mode.
  if (mode === 'bypassPermissions') return 'default' as SdkPermissionMode;
  return mode as SdkPermissionMode;
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

class ClaudeSession extends ProviderSessionBase {
  private readonly prompts: AsyncQueue<SDKUserMessage>;
  private readonly pendingPermissions = new Map<string, (decision: PermissionResult) => void>();
  private runtime: Query | null = null;
  private providerSessionId: string | null = null;
  /**
   * Live-thinking accumulators keyed by Anthropic content-block index. Set
   * when a `content_block_start` event opens a `thinking` block; appended to
   * by each `thinking_delta`; cleared on `content_block_stop`. Lets us emit
   * incremental `onThinkingDelta` for the UI without waiting for the full
   * `assistant` SDK message that finalizes the block.
   */
  private streamingThinkingByIndex = new Map<number, string>();
  /**
   * Reconstructed todo list, keyed by the SDK-assigned task id and kept in
   * insertion order. The Claude Code preset drives the todo panel through the
   * incremental Task tools (`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`)
   * rather than the old snapshot-style `TodoWrite`, so we rebuild the full
   * list ourselves and re-emit it via `onTodosUpdate` on every mutation.
   */
  private tasks = new Map<string, { content: string; status: string; activeForm?: string }>();
  /**
   * Task-tool `tool_use` blocks we've swallowed from the chat transcript,
   * keyed by `tool_use_id`. We hold the originating tool name so the matching
   * `tool_result` (which carries the server-assigned id for creates, or the
   * full snapshot for lists) can be folded into `this.tasks` and skipped from
   * the chat instead of rendering as an orphan result card.
   */
  private todoToolUses = new Map<string, { name: string; input: any }>();

  constructor(sessionId: string, events: ProviderEvents) {
    super(PROVIDER_NAME, sessionId, events);
    this.prompts = new AsyncQueue<SDKUserMessage>();
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
      // Use Codiby's HTTP MCP plan tools so every provider follows one flow.
      disallowedTools: ['EnterPlanMode', 'ExitPlanMode'],
      mcpServers: toSdkMcpServers(opts.mcpServers),
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      // Force Claude to expose its reasoning summaries on every supported
      // model. Without this the SDK relies on per-model defaults that often
      // omit thinking blocks even on Opus 4.6+, leaving the UI's "Thought"
      // bubble dark forever. `display: 'summarized'` (the default) returns
      // the human-readable summary; `omitted` would only return signatures.
      thinking: { type: 'adaptive', display: 'summarized' },
      // Keep the Claude Code preset (built-in tool/git/cwd context still
      // applies) and append Codiby Code-specific steering — currently the
      // rename policy that pairs with the `rename_session` SDK tool.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: CODIBY_CODE_SYSTEM_PROMPT_APPEND,
      },
    };
    if (opts.model) sdkOptions.model = opts.model;
    // Spawn-time only — the SDK's Query has no setEffort; live changes go
    // through a respawn-with-resume (see `set_effort` in index.ts).
    if (opts.effort) sdkOptions.effort = opts.effort;
    if (opts.resumeSessionId) sdkOptions.resume = opts.resumeSessionId;
    // NOTE: intentionally NOT setting `allowDangerouslySkipPermissions` for
    // bypass mode. That flag forces the CLI into true bypass, which skips the
    // `canUseTool` callback and prevents AskUserQuestion from ever prompting.
    // `toSdkPermissionMode` maps bypass -> 'default' and the bridge handles the
    // blanket auto-approve, so tool uses stay routed through our callback.

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
    this.fetchSupportedModels();
  }

  /**
   * Pull the live list of supported models from the SDK runtime and forward
   * it to the bridge so the frontend's model picker can replace its hardcoded
   * fallback. Fire-and-forget: the SDK queues this control request until the
   * underlying CLI subprocess is responsive, so the call resolves whenever
   * the session is ready (typically right after `system/init`). Failures are
   * swallowed — the picker keeps its built-in defaults if the probe never
   * lands.
   */
  private fetchSupportedModels(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    runtime.supportedModels()
      .then((models) => {
        if (this.closed) return;
        this.events.onModelsAvailable(
          models.map((m) => ({
            id: m.value,
            label: m.displayName,
            description: m.description,
          })),
        );
      })
      .catch(() => {});
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
    // Live partial-message stream. With `includePartialMessages: true`, the
    // SDK forwards the raw Anthropic SSE events here (content_block_start /
    // _delta / _stop). We use them to stream `thinking` blocks
    // character-by-character into the UI — the regular `assistant` message
    // only arrives once the block is fully complete, which would make the
    // "Thought" bubble pop in all at once after seconds of silence.
    if (msg.type === 'stream_event') {
      const event = (msg as any).event;
      const eType = event?.type;
      if (eType === 'content_block_start') {
        const idx = event.index as number;
        const block = event.content_block;
        if (block?.type === 'thinking') {
          // Seed the accumulator. Some content_block_start events ship with
          // an initial `thinking` chunk pre-populated; carry it forward so
          // the first delta isn't dropped.
          this.streamingThinkingByIndex.set(idx, (block.thinking as string) ?? '');
        }
      } else if (eType === 'content_block_delta') {
        const idx = event.index as number;
        const delta = event.delta;
        if (delta?.type === 'thinking_delta' && this.streamingThinkingByIndex.has(idx)) {
          const next = (this.streamingThinkingByIndex.get(idx) ?? '') + (delta.thinking as string);
          this.streamingThinkingByIndex.set(idx, next);
          this.events.onThinkingDelta(next);
        }
      } else if (eType === 'content_block_stop') {
        const idx = event.index as number;
        this.streamingThinkingByIndex.delete(idx);
      }
      return;
    }

    // System init — capture session id and basic info.
    if (msg.type === 'system' && (msg as any).subtype === 'init') {
      const init = msg as any;
      this.providerSessionId = init.session_id as string;
      const tools: string[] = Array.isArray(init.tools) ? init.tools : [];
      // Skills are invoked as `/<skill-name>`, so fold them into the slash
      // command list. The SDK reports them in a separate `skills` array on the
      // init message; without this the `/` picker only shows builtin/custom
      // commands and never the agent's skills.
      const slashCommands: string[] = Array.isArray(init.slash_commands) ? init.slash_commands : [];
      const skills: string[] = Array.isArray(init.skills) ? init.skills : [];
      const mergedCommands = [...slashCommands, ...skills.filter((s: string) => !slashCommands.includes(s))];
      this.events.onInit({
        providerSessionId: this.providerSessionId ?? '',
        cwd: (init.cwd as string) || '',
        version: (init.claude_code_version as string) || '',
        model: (init.model as string) || '',
        tools,
        slashCommands: mergedCommands,
        permissionMode: (init.permissionMode as string) || 'default',
      });
      return;
    }

    if (msg.type === 'assistant') {
      const assistant = msg as any;
      const content = assistant.message?.content;
      if (!Array.isArray(content)) return;
      // Non-null for messages produced by a sub-agent; identifies the parent
      // Agent tool_use so the UI can nest these under the Agent card.
      const parentToolUseId = (assistant.parent_tool_use_id as string | null | undefined) ?? null;

      // Diagnostic: surface every block type so we can confirm whether the
      // SDK is delivering thinking blocks. Cheap (one short line per
      // assistant message) and easy to remove later.
      log(`[claude] blocks=${content.map((b: any) => b?.type ?? 'unknown').join(',')}${parentToolUseId ? ' (sub-agent)' : ''}`);

      let partialText = '';
      for (const block of content) {
        if (block.type === 'text') {
          partialText += block.text as string;
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // Thinking blocks always precede text/tool_use within a Message, so
          // flush any pending text first to keep the UI ordering stable.
          if (partialText.trim()) {
            this.events.onAssistantText(partialText, { model: assistant.message?.model, parentToolUseId });
            partialText = '';
          }
          const isRedacted = block.type === 'redacted_thinking';
          const text = isRedacted
            ? '[Encrypted reasoning — preserved for multi-turn continuity.]'
            : (block.thinking as string) ?? '';
          if (text) {
            this.events.onThinking({
              type: 'thinking',
              text,
              redacted: isRedacted || undefined,
              parentToolUseId,
            });
          }
        } else if (block.type === 'tool_use') {
          if (partialText.trim()) {
            this.events.onAssistantText(partialText, { model: assistant.message?.model, parentToolUseId });
            partialText = '';
          }
          const tool: AssistantToolUseBlock = {
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            input: (block.input as Record<string, unknown>) ?? {},
            parentToolUseId,
          };
          if (tool.name === 'TodoWrite') {
            // Legacy snapshot tool — still handled for older sessions/presets.
            const todos = (tool.input as any)?.todos ?? [];
            this.events.onTodosUpdate(todos);
          } else if (this.handleTaskToolUse(tool)) {
            // Swallowed: drives the todo panel, kept out of the chat transcript.
          } else {
            this.events.onToolUse(tool);
          }
        }
      }

      const stopReason = assistant.message?.stop_reason as string | null | undefined;
      const usage = assistant.message?.usage as TokenUsage | undefined;

      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        if (partialText.trim()) {
          this.events.onAssistantText(partialText, { model: assistant.message?.model, usage, parentToolUseId });
        }
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
      const parentToolUseId = (user.parent_tool_use_id as string | null | undefined) ?? null;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id as string | undefined;
          if (toolUseId && this.todoToolUses.has(toolUseId)) {
            // Result for a swallowed Task tool — fold it into the todo list
            // (resolving the server-assigned id for creates) and keep it out
            // of the chat so it doesn't render as an orphan result card. A
            // failed call carries no usable payload, so just drop it.
            const pending = this.todoToolUses.get(toolUseId)!;
            if (!block.is_error) {
              this.handleTaskToolResult(pending.name, pending.input, block.content);
            }
            this.todoToolUses.delete(toolUseId);
            continue;
          }
          this.events.onToolResult({
            toolUseId,
            content: block.content,
            isError: block.is_error as boolean | undefined,
            parentToolUseId,
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

  /**
   * Intercept the Claude Code todo-panel tools. Returns `true` when the block
   * is one of the Task tools (so the caller swallows it from the chat). State
   * is applied eagerly here for updates; creates and lists are reconciled once
   * their `tool_result` lands (see {@link handleTaskToolResult}).
   */
  private handleTaskToolUse(tool: AssistantToolUseBlock): boolean {
    const input = tool.input as any;
    switch (tool.name) {
      case 'TaskCreate':
      case 'TaskGet':
      case 'TaskList':
        // Reconciled from the matching tool_result (the create's id, or the
        // list snapshot). Record it so that result is folded in and hidden.
        this.todoToolUses.set(tool.id, { name: tool.name, input });
        return true;
      case 'TaskUpdate': {
        const taskId = typeof input?.taskId === 'string' ? input.taskId : undefined;
        if (taskId) {
          if (input?.status === 'deleted') {
            this.tasks.delete(taskId);
          } else {
            const cur = this.tasks.get(taskId) ?? { content: '', status: 'pending' };
            this.tasks.set(taskId, {
              content: typeof input?.subject === 'string' ? input.subject : cur.content,
              status: typeof input?.status === 'string' ? input.status : cur.status,
              activeForm: typeof input?.activeForm === 'string' ? input.activeForm : cur.activeForm,
            });
          }
          this.emitTodos();
        }
        // No payload to reconcile, but still swallow its result from the chat.
        this.todoToolUses.set(tool.id, { name: tool.name, input });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Fold a Task tool's `tool_result` into the reconstructed todo list. Creates
   * carry the server-assigned id (`{ task: { id, subject } }`); lists carry a
   * full snapshot (`{ tasks: [...] }`) we treat as authoritative. Update/get
   * results are no-ops — updates were already applied at `tool_use` time.
   */
  private handleTaskToolResult(name: string, input: any, content: unknown): void {
    if (name === 'TaskCreate') {
      const id = this.resolveCreatedTaskId(content);
      if (!id) return;
      this.tasks.set(id, {
        content: typeof input?.subject === 'string' ? input.subject : '',
        status: 'pending',
        activeForm: typeof input?.activeForm === 'string' ? input.activeForm : undefined,
      });
      this.emitTodos();
    } else if (name === 'TaskList') {
      const parsed = this.parseResultJson(content);
      const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : null;
      if (!tasks) return;
      // Authoritative snapshot — rebuild the map, preserving server order.
      this.tasks.clear();
      for (const t of tasks) {
        const id = typeof t?.id === 'string' ? t.id : undefined;
        if (!id) continue;
        this.tasks.set(id, {
          content: typeof t?.subject === 'string' ? t.subject : '',
          status: typeof t?.status === 'string' ? t.status : 'pending',
        });
      }
      this.emitTodos();
    }
  }

  /** Re-emit the full todo snapshot in the shape the UI/bridge expects. */
  private emitTodos(): void {
    this.events.onTodosUpdate(
      [...this.tasks.values()].map((t) => ({
        content: t.content,
        status: t.status,
        ...(t.activeForm ? { activeForm: t.activeForm } : {}),
      })),
    );
  }

  /**
   * Pull the created task's id out of a `TaskCreate` result. The wire shape of
   * a built-in tool result varies (structured JSON vs. a rendered string), so
   * try the structured `{ task: { id } }` first and fall back to the `#<id>`
   * marker in the human-readable "Task #N created" rendering.
   */
  private resolveCreatedTaskId(content: unknown): string | null {
    const parsed = this.parseResultJson(content);
    if (parsed && typeof parsed.task?.id === 'string') return parsed.task.id;
    const text = this.coerceResultText(content);
    const match = text.match(/#\s*([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /** Best-effort JSON parse of a tool_result payload; null when not JSON. */
  private parseResultJson(content: unknown): any | null {
    const text = this.coerceResultText(content).trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** Flatten a tool_result `content` (string | block array | object) to text. */
  private coerceResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
        .join('');
    }
    if (content && typeof content === 'object') {
      const maybeText = (content as any).text;
      if (typeof maybeText === 'string') return maybeText;
      try {
        return JSON.stringify(content);
      } catch {
        return '';
      }
    }
    return '';
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
    if (!this.beginClose()) return;
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

export class ClaudeAdapter extends Adapter {
  readonly name = PROVIDER_NAME;

  spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession {
    const session = new ClaudeSession(opts.sessionId, events);
    session.start(opts);
    return session;
  }
}
