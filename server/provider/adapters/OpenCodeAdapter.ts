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
 *  - Per-tool approval IS wired through. The starting permission
 *    policy is set at server boot via `Config.permission`
 *    (`permissionMode` maps to `edit`/`bash`/`webfetch`/
 *    `external_directory` policies). Anything set to `ask` triggers a
 *    `permission.updated` event, which the adapter forwards to
 *    `events.onPermissionRequest` and answers via
 *    `POST /session/{id}/permissions/{permissionID}` once the bridge
 *    resolves. allow → `"once"`, deny → `"reject"`.
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
  ProviderAdapter,
  ProviderEvents,
  ProviderSession,
  SpawnOptions,
} from '../types';

const PROVIDER_NAME = 'opencode';

type PermissionConfig = NonNullable<Config['permission']>;
type McpConfig = NonNullable<Config['mcp']>;

function mapPermissionMode(mode: PermissionMode): PermissionConfig {
  // `ask` entries trigger permission.updated events that the adapter
  // forwards to the bridge's onPermissionRequest. Mirrors Claude's
  // mode semantics: plan is read-only, default asks per call,
  // acceptEdits pre-approves file edits, bypass yolos.
  switch (mode) {
    case 'plan':
      return { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' };
    case 'acceptEdits':
      return { edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' };
    case 'bypassPermissions':
      return { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' };
    case 'default':
    default:
      return { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' };
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

class OpenCodeProviderSession implements ProviderSession {
  readonly provider = PROVIDER_NAME;
  readonly sessionId: string;

  private readonly events: ProviderEvents;
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
  private closed = false;
  private initSent = false;
  private eventLoopAbort: AbortController | null = null;

  // partID → last text snapshot pushed as a delta but not yet finalised.
  private readonly pendingText = new Map<string, string>();
  // callID set so we only emit onToolUse once per tool invocation.
  private readonly toolUseEmitted = new Set<string>();
  // messageIDs we know belong to user-role messages. Their parts must
  // not be emitted as assistant output (the prompt API echoes the user
  // text back as a part, which would otherwise show up as a duplicated
  // reply in the chat log).
  private readonly userMessageIds = new Set<string>();

  constructor(opts: SpawnOptions, events: ProviderEvents) {
    this.sessionId = opts.sessionId;
    this.events = events;
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
        this.events.onTurnComplete({
          stopReason: 'end_turn',
          model: this.model || undefined,
        });
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

    if (!this.toolUseEmitted.has(callID) && (status === 'pending' || status === 'running' || status === 'completed' || status === 'error')) {
      const toolUse: AssistantToolUseBlock = {
        type: 'tool_use',
        id: callID,
        name: part.tool,
        input: { ...(part.state.input as Record<string, unknown>) },
        parentToolUseId: null,
      };
      this.events.onToolUse(toolUse);
      this.toolUseEmitted.add(callID);
    }

    if (status === 'completed') {
      this.events.onToolResult({
        toolUseId: callID,
        content: part.state.output,
        parentToolUseId: null,
      });
      return;
    }
    if (status === 'error') {
      this.events.onToolResult({
        toolUseId: callID,
        content: part.state.error,
        isError: true,
        parentToolUseId: null,
      });
      return;
    }
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

  async listModels(): Promise<Array<{ id: string; label: string; providerName: string }>> {
    const { client } = await this.readyPromise;
    const result = await client.provider.list({ throwOnError: true });
    const data = (result as { data?: { all?: unknown[]; connected?: string[] } }).data;
    const all = (data?.all ?? []) as Array<{
      id: string;
      name: string;
      models: Record<string, { id: string; name: string; status?: string }>;
    }>;
    const connected = new Set(data?.connected ?? []);
    const out: Array<{ id: string; label: string; providerName: string }> = [];
    for (const provider of all) {
      // Only surface providers the user is actually authenticated for —
      // listing 200+ models from every backend just to grey them out
      // would be more confusing than useful.
      if (!connected.has(provider.id)) continue;
      for (const [, model] of Object.entries(provider.models)) {
        if (model.status === 'deprecated') continue;
        out.push({
          id: `${provider.id}/${model.id}`,
          label: model.name,
          providerName: provider.name,
        });
      }
    }
    out.sort((a, b) => {
      if (a.providerName !== b.providerName) return a.providerName.localeCompare(b.providerName);
      return a.label.localeCompare(b.label);
    });
    return out;
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
    if (this.closed) return;
    this.closed = true;
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

export const OpenCodeAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,
  spawn(opts, events) {
    return new OpenCodeProviderSession(opts, events);
  },
};
