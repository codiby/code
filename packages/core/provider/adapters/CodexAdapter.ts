/**
 * CodexAdapter — OpenAI Codex SDK-backed provider adapter.
 *
 * Wraps `@openai/codex-sdk` behind the generic `ProviderAdapter` interface.
 * The SDK shells out to the bundled `codex exec --experimental-json` binary
 * (vendored via `@openai/codex`), writes the prompt to stdin once and reads
 * JSONL events from stdout. Auth is handled out-of-band — the SDK inherits
 * `process.env`, so credentials from `codex login` (or env vars like
 * `OPENAI_API_KEY` / `CODEX_API_KEY`) are picked up automatically. Taskr
 * does not store or prompt for an API key.
 *
 * Lifecycle differences vs ClaudeAdapter:
 *  - Claude has one continuous `query()` AsyncIterable for the whole session.
 *    Codex is per-turn — each `sendUserMessage` starts a fresh `runStreamed`
 *    and consumes its generator until the turn completes. Between turns no
 *    event loop runs. `onExit` fires only from `close()`.
 *  - The Codex SDK has no return channel (stdin closes after the first
 *    write), so per-tool approval callbacks (`canUseTool`) are not possible.
 *    `permissionMode` maps to a fixed `approvalPolicy` + `sandboxMode` pair
 *    set when the thread is created.
 *  - `setModel` / `setPermissionMode` cannot be live-updated. They're stored
 *    on the adapter and applied on the next thread start (effective after
 *    /clear). The session record's `model`/`permissionMode` fields drive
 *    the next spawn, so persisting via the bridge is enough.
 *
 * MCP integration: HTTP MCP servers from `opts.mcpServers` are forwarded to
 * Codex via `--config mcp_servers.<name>.url=...`. The in-process
 * `codiby-code-sdk` server (built with the Anthropic SDK's
 * `createSdkMcpServer`) is intentionally skipped — it cannot be re-hosted
 * for the Codex CLI without a stdio bridge. Practical effect: Codex
 * sessions don't get the `rename_session` / `post_system_note` /
 * `open_file_in_editor` / `post_image_to_session` tools.
 */

import { Codex, type ApprovalMode, type SandboxMode, type Thread, type ThreadEvent, type ThreadItem, type Usage as CodexUsage, type UserInput } from '@openai/codex-sdk';
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

const PROVIDER_NAME = 'codex';

// `CodexConfigObject` isn't re-exported from the SDK barrel, so we mirror its
// shape here for the `Codex({ config })` constructor argument.
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

function mapPermissionMode(mode: PermissionMode): { approvalPolicy: ApprovalMode; sandboxMode: SandboxMode } {
  // The Codex SDK has no back-channel for approvals, so any policy other
  // than "never" just causes the agent to deny actions. Always pick "never"
  // and vary the sandbox tightness by the requested mode.
  switch (mode) {
    case 'plan': return { approvalPolicy: 'never', sandboxMode: 'read-only' };
    case 'bypassPermissions': return { approvalPolicy: 'never', sandboxMode: 'danger-full-access' };
    case 'acceptEdits':
    case 'default':
    default: return { approvalPolicy: 'never', sandboxMode: 'workspace-write' };
  }
}

function buildCodexConfig(mcpServers?: Record<string, McpServerSpec>): CodexConfigObject | undefined {
  if (!mcpServers) return undefined;
  const codexMcp: CodexConfigObject = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    // Only HTTP MCP servers can be passed through; stdio specs would need
    // an explicit command/args mapping that the codiby-code bridge doesn't
    // currently use, and the Anthropic SDK ones aren't portable at all.
    if (spec.type === 'http') {
      const entry: CodexConfigObject = { url: spec.url };
      if (spec.headers) entry.headers = spec.headers as unknown as CodexConfigObject;
      codexMcp[name] = entry;
    }
  }
  if (Object.keys(codexMcp).length === 0) return undefined;
  return { mcp_servers: codexMcp };
}

async function buildCodexInput(text: string, images?: ImageInput[]): Promise<{ input: string | UserInput[]; cleanup: () => Promise<void> }> {
  if (!images || images.length === 0) return { input: text, cleanup: async () => {} };

  // Codex consumes images as paths on disk via `--image`, so we materialise
  // base64 payloads into temp files for the duration of the turn.
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { promises: fsp } = await import('fs');
  const tempPaths: string[] = [];
  const inputs: UserInput[] = [];
  for (const img of images) {
    const ext = (img.media_type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const path = join(tmpdir(), `codex-img-${randomUUID()}.${ext}`);
    await fsp.writeFile(path, Buffer.from(img.data, 'base64'));
    tempPaths.push(path);
    inputs.push({ type: 'local_image', path });
  }
  inputs.push({ type: 'text', text });
  return {
    input: inputs,
    cleanup: async () => {
      for (const p of tempPaths) {
        try { await fsp.unlink(p); } catch {}
      }
    },
  };
}

function mapUsage(u: CodexUsage | null | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cached_input_tokens,
  };
}

class CodexProviderSession implements ProviderSession {
  readonly provider = PROVIDER_NAME;
  readonly sessionId: string;

  private readonly events: ProviderEvents;
  private readonly codex: Codex;
  private thread: Thread;
  private currentRun: AbortController | null = null;
  private closed = false;
  private initSent = false;
  private readonly model: string | null;
  private readonly permissionMode: PermissionMode;
  private readonly cwd: string;

  constructor(opts: SpawnOptions, events: ProviderEvents) {
    this.sessionId = opts.sessionId;
    this.events = events;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.permissionMode = opts.permissionMode;

    this.codex = new Codex({ config: buildCodexConfig(opts.mcpServers) });

    const threadOptions = {
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true,
      ...(opts.model ? { model: opts.model } : {}),
      ...mapPermissionMode(opts.permissionMode),
    };

    this.thread = opts.resumeSessionId
      ? this.codex.resumeThread(opts.resumeSessionId, threadOptions)
      : this.codex.startThread(threadOptions);
  }

  async sendUserMessage(input: { text: string; images?: ImageInput[] }): Promise<void> {
    if (this.closed) return;
    // One in-flight turn at a time. If a previous turn somehow leaked,
    // abort it so the new one isn't queued behind a dead generator.
    this.currentRun?.abort();
    const controller = new AbortController();
    this.currentRun = controller;

    const { input: codexInput, cleanup } = await buildCodexInput(input.text, input.images);
    void this.runTurn(codexInput, controller, cleanup);
  }

  private async runTurn(input: string | UserInput[], controller: AbortController, cleanup: () => Promise<void>): Promise<void> {
    const agentTexts = new Map<string, string>();
    let lastError: string | null = null;

    try {
      const { events } = await this.thread.runStreamed(input, { signal: controller.signal });
      for await (const ev of events) {
        if (this.closed) break;
        this.dispatch(ev, agentTexts);
        if (ev.type === 'error') lastError = ev.message;
        else if (ev.type === 'turn.failed') lastError = ev.error.message;
      }
      if (lastError && !controller.signal.aborted) {
        this.events.onError(new Error(lastError));
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // User-initiated stop. Emit a turn-complete so the UI clears the
        // streaming indicator without flagging the session as errored.
        this.events.onTurnComplete({ stopReason: 'interrupted' });
      } else {
        this.events.onError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      await cleanup();
      if (this.currentRun === controller) this.currentRun = null;
    }
  }

  private dispatch(ev: ThreadEvent, agentTexts: Map<string, string>): void {
    if (ev.type === 'thread.started') {
      if (!this.initSent) {
        this.initSent = true;
        this.events.onInit({
          providerSessionId: ev.thread_id,
          cwd: this.cwd,
          version: '',
          model: this.model || '',
          tools: [],
          slashCommands: [],
          permissionMode: this.permissionMode,
        });
      }
      return;
    }

    if (ev.type === 'turn.started') return;

    if (ev.type === 'turn.completed') {
      this.events.onTurnComplete({
        stopReason: 'end_turn',
        usage: mapUsage(ev.usage),
        model: this.model || undefined,
      });
      return;
    }

    if (ev.type === 'turn.failed' || ev.type === 'error') {
      // The runTurn caller surfaces these via onError after the generator
      // drains. Nothing to do here.
      return;
    }

    if (ev.type === 'item.started') {
      this.handleItemStarted(ev.item, agentTexts);
      return;
    }
    if (ev.type === 'item.updated') {
      this.handleItemUpdated(ev.item, agentTexts);
      return;
    }
    if (ev.type === 'item.completed') {
      this.handleItemCompleted(ev.item, agentTexts);
      return;
    }
  }

  private handleItemStarted(item: ThreadItem, agentTexts: Map<string, string>): void {
    if (item.type === 'agent_message') {
      agentTexts.set(item.id, item.text || '');
      return;
    }
    if (item.type === 'command_execution') {
      const tool: AssistantToolUseBlock = {
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: item.command },
        parentToolUseId: null,
      };
      this.events.onToolUse(tool);
      return;
    }
  }

  private handleItemUpdated(item: ThreadItem, agentTexts: Map<string, string>): void {
    if (item.type === 'agent_message') {
      agentTexts.set(item.id, item.text);
      // Bridge's onAssistantDelta replaces partialText with the supplied
      // string, so we hand it the latest snapshot rather than a diff.
      this.events.onAssistantDelta(item.text);
      return;
    }
  }

  private handleItemCompleted(item: ThreadItem, agentTexts: Map<string, string>): void {
    switch (item.type) {
      case 'agent_message': {
        agentTexts.delete(item.id);
        this.events.onAssistantText(item.text, { model: this.model || undefined });
        return;
      }
      case 'reasoning': {
        // Drop chain-of-thought from the chat log.
        return;
      }
      case 'command_execution': {
        const isError = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
        const body = item.aggregated_output ?? '';
        const suffix = typeof item.exit_code === 'number' ? `\n[exit ${item.exit_code}]` : '';
        this.events.onToolResult({
          toolUseId: item.id,
          content: body + suffix,
          isError,
          parentToolUseId: null,
        });
        return;
      }
      case 'file_change': {
        const tool: AssistantToolUseBlock = {
          type: 'tool_use',
          id: item.id,
          name: 'CodexEdit',
          input: { changes: item.changes },
          parentToolUseId: null,
        };
        this.events.onToolUse(tool);
        const isError = item.status === 'failed';
        const summary = item.changes?.map((c) => `${c.kind} ${c.path}`).join('\n') || '(no changes)';
        this.events.onToolResult({
          toolUseId: item.id,
          content: isError ? `Patch failed:\n${summary}` : summary,
          isError,
          parentToolUseId: null,
        });
        return;
      }
      case 'mcp_tool_call': {
        const toolName = `${item.server}__${item.tool}`;
        const tool: AssistantToolUseBlock = {
          type: 'tool_use',
          id: item.id,
          name: toolName,
          input: (item.arguments as Record<string, unknown>) ?? {},
          parentToolUseId: null,
        };
        this.events.onToolUse(tool);
        const isError = item.status === 'failed';
        let content: unknown;
        if (isError) {
          content = item.error?.message ?? 'MCP tool call failed';
        } else if (item.result?.content) {
          content = item.result.content;
        } else {
          content = item.result?.structured_content ?? '';
        }
        this.events.onToolResult({ toolUseId: item.id, content, isError, parentToolUseId: null });
        return;
      }
      case 'web_search': {
        const tool: AssistantToolUseBlock = {
          type: 'tool_use',
          id: item.id,
          name: 'WebSearch',
          input: { query: item.query },
          parentToolUseId: null,
        };
        this.events.onToolUse(tool);
        this.events.onToolResult({
          toolUseId: item.id,
          content: `Search complete: ${item.query}`,
          parentToolUseId: null,
        });
        return;
      }
      case 'todo_list': {
        // Reshape Codex's `{ text, completed }` into the `{ content, status,
        // activeForm }` triple the bridge/UI use for TodoWrite output.
        const todos = (item.items || []).map((t) => ({
          content: t.text,
          activeForm: t.text,
          status: t.completed ? 'completed' : 'pending',
        }));
        this.events.onTodosUpdate(todos);
        return;
      }
      case 'error': {
        this.events.onError(new Error(item.message));
        return;
      }
    }
  }

  async interrupt(): Promise<void> {
    this.currentRun?.abort();
  }

  async setModel(_model: string | null): Promise<void> {
    // Codex bakes the model into the thread on creation. Updates take
    // effect on the next session restart (the bridge already persists
    // session.model). No-op at runtime.
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // Same constraint as setModel — applied on next thread start.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.currentRun?.abort();
    this.currentRun = null;
    this.events.onExit(0);
  }
}

export const CodexAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,
  spawn(opts, events) {
    return new CodexProviderSession(opts, events);
  },
};
