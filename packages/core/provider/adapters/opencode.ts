/**
 * OpenCodeAdapter — opencode.ai SDK-backed provider adapter.
 *
 * Wraps `@opencode-ai/sdk` behind the generic `ProviderAdapter` interface.
 * The SDK shells out to the standalone `opencode` binary (installed
 * separately via `npm i -g opencode-ai`, the curl install script, or a
 * package manager) and runs it as `opencode serve --hostname=127.0.0.1
 * --port=<free>`. The adapter then speaks HTTP+SSE to that local server.
 * Each provider session boots its own opencode server scoped to the
 * session's cwd. Auth is handled out-of-band — the spawned binary
 * inherits process.env, so env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * ...) and credentials from `opencode auth login` are picked up
 * automatically. Taskr does not store or prompt for an API key.
 *
 * Lifecycle differences vs ClaudeAdapter:
 *  - The opencode server starts asynchronously: `spawn()` returns
 *    immediately, but `sendUserMessage` and `interrupt` await an
 *    internal ready promise before issuing HTTP calls.
 *  - Streaming arrives via a single SSE subscription (`client.event.
 *    subscribe`). One reader loop runs for the full session lifetime
 *    and drives every onAssistantDelta / onToolUse / onToolResult /
 *    onTodosUpdate / onTurnComplete.
 *  - Per-tool approval is NOT wired. opencode 1.14.x has a bug where
 *    any `Config.permission.* = "ask"` silently hangs the offending
 *    tool at `state.running` without firing `permission.updated`, so
 *    the bridge's onPermissionRequest path can't be exercised. Until
 *    that's fixed upstream, non-plan modes set everything to `allow`
 *    (free-running) and plan mode denies all destructive ops outright.
 *    The `permission.updated` handler stays as a defensive forwarder
 *    in case a future opencode release starts emitting events again.
 *  - `setModel` IS live: opencode's prompt API takes a per-turn
 *    `body.model`, so changing the model just updates an in-memory
 *    field that the next `sendUserMessage` reads. No server restart.
 *  - `setPermissionMode` is NOT live — Config.permission is locked at
 *    server start. The bridge persists the new value on the session
 *    record so it's picked up on the next spawn (effective after
 *    /clear).
 *
 * Model format: opencode requires `{ providerID, modelID }` pairs (e.g.
 * `anthropic/claude-3-5-sonnet-20241022`). If the user's model string
 * lacks a `/`, the adapter omits the model field and lets opencode pick
 * its configured default; otherwise the slash splits provider from id.
 *
 * MCP integration: HTTP MCP servers from `opts.mcpServers` are forwarded
 * to opencode as `Config.mcp` `McpRemoteConfig` entries. The in-process
 * `codiby-code-sdk` server is intentionally skipped — it cannot be
 * re-hosted across the HTTP boundary. Practical effect: opencode
 * sessions don't get the `rename_session` / `post_system_note` /
 * `open_file_in_editor` / `post_image_to_session` tools.
 */

import { createServer } from 'net';
import {
  createOpencodeServer,
  createOpencodeClient,
  type Config,
  type Event,
  type OpencodeClient,
  type Part,
  type ToolPart,
  type TextPart,
  type Permission,
  type FilePartInput,
} from '@opencode-ai/sdk';

import type {
  AssistantToolUseBlock,
  ImageInput,
  McpServerSpec,
  PermissionMode,
  ProviderEvents,
  ProviderSession,
  SpawnOptions,
} from '../types';
import { Adapter } from '../adapter';
import { ProviderSessionBase } from '../session';

const PROVIDER_NAME = 'opencode';

type PermissionConfig = NonNullable<Config['permission']>;
type McpConfig = NonNullable<Config['mcp']>;

function mapPermissionMode(mode: PermissionMode): PermissionConfig {
  // NOTE: opencode 1.14.x has a bug where `Config.permission.* = "ask"`
  // silently hangs the tool at `state.running` without ever emitting a
  // `permission.updated` event. Verified locally for `bash`, `edit`,
  // and `external_directory`. We can't wire per-call approvals into
  // the bridge until that's fixed upstream, so non-plan modes default
  // to `allow` (the agent runs tools freely) and `plan` denies
  // destructive ops outright. The bridge's own permissionMode UI still
  // gates writes when the user explicitly picks plan; this adapter
  // just doesn't get the granular per-call prompts Claude does.
  switch (mode) {
    case 'plan':
      return { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' };
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'default':
    default:
      return { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' };
  }
}

function buildOpenCodeMcpConfig(mcpServers?: Record<string, McpServerSpec>): McpConfig | undefined {
  if (!mcpServers) return undefined;
  const out: McpConfig = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    // Only HTTP MCP servers can be passed through; stdio/sse/sdk specs
    // either don't map cleanly or aren't portable across the HTTP gap.
    if (spec.type === 'http') {
      out[name] = {
        type: 'remote',
        url: spec.url,
        ...(spec.headers ? { headers: spec.headers } : {}),
      };
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function parseModel(model: string | null): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash === -1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
        const port = addr.port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        srv.close();
        reject(new Error('Failed to bind ephemeral port for opencode server'));
      }
    });
  });
}

function imageToFilePart(img: ImageInput): FilePartInput {
  return {
    type: 'file',
    mime: img.media_type,
    url: `data:${img.media_type};base64,${img.data}`,
  };
}

class OpenCodeProviderSession extends ProviderSessionBase {
  private readonly cwd: string;
  // Mutable: setModel updates this in place. The next sendUserMessage
  // attaches it to the prompt body so the change takes effect on the
  // very next turn — no session restart needed.
  private model: string | null;
  private readonly permissionMode: PermissionMode;

  private readonly readyPromise: Promise<{
    client: OpencodeClient;
    openSessionId: string;
    closeServer: () => void;
  }>;
  private initSent = false;
  private eventLoopAbort: AbortController | null = null;

  // partID → last text snapshot pushed as a delta but not yet finalised.
  private readonly pendingText = new Map<string, string>();
  // callID set so we only emit onToolUse once per tool invocation.
  private readonly toolUseEmitted = new Set<string>();
  // callIDs that received onToolUse but not yet onToolResult. opencode
  // sometimes ends a turn (session.idle / session.error) without ever
  // transitioning a tool past `running` — particularly when the upstream
  // model API rejects the request. We drain this set on idle so the UI
  // never shows a tool pinned in "in flight" forever.
  private readonly pendingTools = new Set<string>();
  // Last error message captured from the event stream (session.error or
  // assistant message.error). Surfaced as the synthetic tool result body
  // when we have to drain stuck tools — it's far more useful than a
  // generic "did not return".
  private lastTurnError: string | null = null;
  // messageIDs we know belong to user-role messages. Their parts must
  // not be emitted as assistant output (the prompt API echoes the user
  // text back as a part, which would otherwise show up as a duplicated
  // reply in the chat log).
  private readonly userMessageIds = new Set<string>();

  constructor(opts: SpawnOptions, events: ProviderEvents) {
    super(PROVIDER_NAME, opts.sessionId, events);
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.permissionMode = opts.permissionMode;

    this.readyPromise = this.boot(opts);
    // Surface boot failures (binary missing, port bind, etc.) to the
    // bridge so the UI shows an error instead of hanging.
    void this.readyPromise.catch((err) => {
      if (this.closed) return;
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async boot(opts: SpawnOptions): Promise<{
    client: OpencodeClient;
    openSessionId: string;
    closeServer: () => void;
  }> {
    const config: Config = {
      permission: mapPermissionMode(opts.permissionMode),
    };
    if (opts.model) config.model = opts.model;
    const mcp = buildOpenCodeMcpConfig(opts.mcpServers);
    if (mcp) config.mcp = mcp;

    const port = await findFreePort();
    const server = await createOpencodeServer({
      hostname: '127.0.0.1',
      port,
      config,
      timeout: 15000,
    });

    if (this.closed) {
      server.close();
      throw new Error('opencode session closed during boot');
    }

    const client = createOpencodeClient({ baseUrl: server.url, directory: opts.cwd });

    let openSessionId: string;
    if (opts.resumeSessionId) {
      openSessionId = opts.resumeSessionId;
    } else {
      const created = await client.session.create({ body: {}, throwOnError: true });
      const data = (created as { data?: { id?: string } }).data;
      if (!data?.id) throw new Error('opencode: session.create did not return an id');
      openSessionId = data.id;
    }

    this.startEventLoop(client, openSessionId);

    if (!this.initSent) {
      this.initSent = true;
      this.events.onInit({
        providerSessionId: openSessionId,
        cwd: this.cwd,
        version: '',
        model: this.model || '',
        tools: [],
        slashCommands: [],
        permissionMode: this.permissionMode,
      });
    }

    return { client, openSessionId, closeServer: () => server.close() };
  }

  private startEventLoop(client: OpencodeClient, openSessionId: string): void {
    const controller = new AbortController();
    this.eventLoopAbort = controller;
    void (async () => {
      try {
        const stream = await client.event.subscribe({ signal: controller.signal });
        for await (const ev of stream.stream) {
          if (this.closed || controller.signal.aborted) break;
          this.handleEvent(ev as Event, openSessionId, client);
        }
      } catch (err) {
        if (controller.signal.aborted || this.closed) return;
        this.events.onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private handleEvent(ev: Event, openSessionId: string, client: OpencodeClient): void {
    switch (ev.type) {
      case 'message.part.updated': {
        const part = ev.properties.part as Part;
        if (part.sessionID !== openSessionId) return;
        this.handlePart(part);
        return;
      }
      case 'message.updated': {
        const info = ev.properties.info;
        if (info.sessionID !== openSessionId) return;
        if (info.role === 'user') this.userMessageIds.add(info.id);
        if (info.role === 'assistant' && info.time?.completed && info.error) {
          const err = info.error;
          const msg =
            'data' in err && typeof (err.data as { message?: string }).message === 'string'
              ? (err.data as { message: string }).message
              : err.name;
          this.lastTurnError = msg;
          this.events.onError(new Error(msg));
        }
        return;
      }
      case 'session.idle': {
        if (ev.properties.sessionID !== openSessionId) return;
        // Flush any text parts that never got a final time.end before idle.
        for (const text of this.pendingText.values()) {
          this.events.onAssistantText(text, { model: this.model || undefined });
        }
        this.pendingText.clear();
        // Drain any tool uses opencode never resolved — emit a synthetic
        // error result so the UI un-sticks the tool card and the chat
        // log isn't pinned waiting forever.
        this.drainPendingTools();
        this.events.onTurnComplete({
          stopReason: 'end_turn',
          model: this.model || undefined,
        });
        this.lastTurnError = null;
        return;
      }
      case 'todo.updated': {
        if (ev.properties.sessionID !== openSessionId) return;
        const todos = ev.properties.todos.map((t) => ({
          content: t.content,
          activeForm: t.content,
          status: t.status,
        }));
        this.events.onTodosUpdate(todos);
        return;
      }
      case 'session.error': {
        if (ev.properties.sessionID && ev.properties.sessionID !== openSessionId) return;
        const err = ev.properties.error;
        if (!err) return;
        const message =
          'data' in err && typeof (err.data as { message?: string }).message === 'string'
            ? (err.data as { message: string }).message
            : err.name;
        // Stash so drainPendingTools can use it as the synthetic body.
        this.lastTurnError = message;
        this.events.onError(new Error(message));
        return;
      }
      case 'permission.updated': {
        const perm = ev.properties as Permission;
        if (perm.sessionID !== openSessionId) return;
        void this.handlePermissionRequest(client, perm).catch((err) => {
          if (this.closed) return;
          this.events.onError(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }
      default:
        return;
    }
  }

  private handlePart(part: Part): void {
    // Drop parts attached to user messages — opencode emits a TextPart
    // for the user's prompt itself, and forwarding it would echo the
    // user's input back as if the agent had replied with it.
    if (this.userMessageIds.has(part.messageID)) return;
    switch (part.type) {
      case 'text':
        this.handleTextPart(part);
        return;
      case 'tool':
        this.handleToolPart(part);
        return;
      // reasoning / step-start / step-finish / snapshot / patch / agent /
      // retry / compaction / file / subtask aren't surfaced to the chat
      // log directly. The bridge derives whatever state it needs from
      // the higher-level events above.
      default:
        return;
    }
  }

  private handleTextPart(part: TextPart): void {
    if (part.synthetic || part.ignored) return;
    const finalised = !!part.time?.end;
    if (finalised) {
      this.pendingText.delete(part.id);
      this.events.onAssistantText(part.text, { model: this.model || undefined });
      return;
    }
    this.pendingText.set(part.id, part.text);
    // The bridge replaces partialText with whatever string is supplied,
    // so we hand it the latest snapshot rather than only the delta.
    this.events.onAssistantDelta(part.text);
  }

  private handleToolPart(part: ToolPart): void {
    const callID = part.callID;
    const status = part.state.status;

    // Skip the `pending` state: the model is still streaming the JSON
    // input, and `state.input` is `{}` until the args are fully parsed
    // (the raw partial lives in `state.raw`). The bridge's onToolUse
    // is one-shot per call, so emitting now would freeze an empty
    // input in the UI even after `running` arrives with the real one.
    if (status !== 'running' && status !== 'completed' && status !== 'error') return;

    if (!this.toolUseEmitted.has(callID)) {
      const toolUse: AssistantToolUseBlock = {
        type: 'tool_use',
        id: callID,
        name: part.tool,
        input: { ...(part.state.input as Record<string, unknown>) },
        parentToolUseId: null,
      };
      this.events.onToolUse(toolUse);
      this.toolUseEmitted.add(callID);
      this.pendingTools.add(callID);
    }

    if (status === 'completed') {
      this.pendingTools.delete(callID);
      this.events.onToolResult({
        toolUseId: callID,
        content: part.state.output,
        parentToolUseId: null,
      });
      return;
    }
    if (status === 'error') {
      this.pendingTools.delete(callID);
      this.events.onToolResult({
        toolUseId: callID,
        content: part.state.error,
        isError: true,
        parentToolUseId: null,
      });
      return;
    }
  }

  private drainPendingTools(): void {
    if (this.pendingTools.size === 0) return;
    const reason =
      this.lastTurnError
        ? `Tool aborted: ${this.lastTurnError}`
        : 'Tool execution did not return a result before the turn ended.';
    for (const callID of this.pendingTools) {
      this.events.onToolResult({
        toolUseId: callID,
        content: reason,
        isError: true,
        parentToolUseId: null,
      });
    }
    this.pendingTools.clear();
  }

  private async handlePermissionRequest(client: OpencodeClient, perm: Permission): Promise<void> {
    // Build a typed input record: opencode passes arbitrary metadata
    // plus an optional pattern (e.g. the bash command, or a file glob).
    const input: Record<string, unknown> = { ...(perm.metadata ?? {}) };
    if (perm.pattern !== undefined) input.pattern = perm.pattern;
    if (perm.callID) input.callID = perm.callID;

    const decision = await this.events.onPermissionRequest({
      requestId: perm.id,
      toolName: perm.type,
      title: perm.title,
      description: perm.title,
      input,
    });

    if (this.closed) return;

    // The bridge models decisions as one-shot allow/deny per call, so
    // map allow → "once" rather than "always" — that way the bridge
    // gets a fresh request for the next call and can apply its own
    // auto-accept logic if any.
    const response: 'once' | 'reject' = decision.allow ? 'once' : 'reject';
    await client.postSessionIdPermissionsPermissionId({
      path: { id: perm.sessionID, permissionID: perm.id },
      body: { response },
    });
  }

  async sendUserMessage(input: { text: string; images?: ImageInput[] }): Promise<void> {
    if (this.closed) return;
    const { client, openSessionId } = await this.readyPromise;
    if (this.closed) return;

    const parts: Array<FilePartInput | { type: 'text'; text: string }> = [];
    if (input.images) {
      for (const img of input.images) parts.push(imageToFilePart(img));
    }
    parts.push({ type: 'text', text: input.text });

    const body: Parameters<OpencodeClient['session']['promptAsync']>[0]['body'] = { parts };
    const model = parseModel(this.model);
    if (model) body!.model = model;

    try {
      await client.session.promptAsync({
        path: { id: openSessionId },
        body,
        throwOnError: true,
      });
    } catch (err) {
      if (this.closed) return;
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async interrupt(): Promise<void> {
    try {
      const { client, openSessionId } = await this.readyPromise;
      await client.session.abort({ path: { id: openSessionId } });
    } catch {
      // If we never reached ready, nothing to abort.
    }
  }

  async setModel(model: string | null): Promise<void> {
    // opencode supports a per-prompt model override (SessionPromptData
    // body.model), so we just stash the new value and the next
    // sendUserMessage will pass it through. No server restart needed.
    this.model = model;
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // Same as setModel — applied on the next server start.
  }

  async close(): Promise<void> {
    if (!this.beginClose()) return;
    this.eventLoopAbort?.abort();
    this.eventLoopAbort = null;
    try {
      const ready = await this.readyPromise;
      ready.closeServer();
    } catch {
      // Boot never completed; no server to close.
    }
    this.events.onExit(0);
  }
}

export class OpenCodeAdapter extends Adapter {
  readonly name = PROVIDER_NAME;

  spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession {
    return new OpenCodeProviderSession(opts, events);
  }
}
