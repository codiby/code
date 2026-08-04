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
 *    and drives every onAssistantDelta / onThinkingDelta / onToolUse /
 *    onToolResult / onTodosUpdate / onTurnComplete.
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
 *  - Reasoning effort maps to opencode's per-prompt `variant`. Variant
 *    availability is determined by the selected provider and model.
 *  - `setPermissionMode` cannot live-update Config.permission, but plan-mode
 *    steering takes effect on the next prompt. The permission configuration
 *    itself is picked up on the next spawn (effective after /clear).
 *  - opencode's `question` tool does NOT go through that permission path —
 *    it has its own protocol (`question.asked` event + `/question/{id}/reply`)
 *    which works fine over HTTP. The adapter maps it onto Codiby's
 *    `AskUserQuestion` so the same inline answer card renders for both
 *    providers. See `handleQuestionRequest`.
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
  type ReasoningPart,
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

/**
 * OpenCode has no built-in equivalent of Claude Code's plan-mode completion
 * flow. Keep this instruction on every plan-mode prompt so its response is
 * submitted through Codiby's reviewable ExitPlanMode tool rather than emitted
 * as plain chat text.
 */
export const PLAN_MODE_SYSTEM_PROMPT = [
  'Plan mode is active.',
  'Inspect the codebase and prepare an actionable implementation plan, but do not make changes.',
  'When the plan is complete, you MUST call the `ExitPlanMode` tool with the full Markdown plan for user review.',
  'Do not reply with the plan only; submit it through `ExitPlanMode`.',
].join('\n');

type PermissionConfig = NonNullable<Config['permission']>;
type McpConfig = NonNullable<Config['mcp']>;

/**
 * OpenCode emits an initial `message.part.updated`, zero or more incremental
 * `message.part.delta` events, then a final updated part carrying `time.end`.
 * The legacy SDK client used here does not include the delta event in its
 * exported `Event` union even though the server sends it.
 */
type MessagePartDeltaEvent = {
  type: 'message.part.delta';
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
};

/**
 * opencode's `question` tool protocol. The server announces a pending question
 * over the event stream and blocks the tool until something POSTs an answer to
 * `/question/{requestID}/reply` (or rejects it). None of this is in the legacy
 * SDK client's types — only the `/v2` surface has it — so the shapes are
 * mirrored here from the server's OpenAPI document.
 *
 * opencode 1.18 emits both the original `question.asked` and the newer
 * `question.v2.asked` on the same stream; the two carry identical payloads but
 * are answered through different routes, so the variant is tracked per request.
 */
type OpenCodeQuestionOption = {
  /** Display text (1-5 words). This is what gets sent back as the answer. */
  label: string;
  description?: string;
};

export type OpenCodeQuestionInfo = {
  question: string;
  /** Very short label (max 30 chars) — rendered as the chip above the question. */
  header: string;
  options: OpenCodeQuestionOption[];
  /** Allow selecting more than one option. */
  multiple?: boolean;
  /** Allow typing a free-text answer (opencode defaults this to true). */
  custom?: boolean;
};

export type OpenCodeQuestionRequest = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
  /** Present when the question came from the `question` tool (the normal case). */
  tool?: { messageID: string; callID: string };
};

type QuestionAskedEvent = {
  type: 'question.asked' | 'question.v2.asked';
  properties: OpenCodeQuestionRequest;
};

type OpenCodeEvent = Event | MessagePartDeltaEvent | QuestionAskedEvent;

/** opencode's tool name for asking the user something. */
export const OPENCODE_QUESTION_TOOL = 'question';
/** Codiby's canonical name for the same thing — what the UI renders a form for. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Translate opencode's question payload into the `AskUserQuestion` tool input
 * the UI expects. The shapes are nearly identical — opencode calls the
 * multi-select flag `multiple`, Claude calls it `multiSelect`.
 */
export function toAskUserQuestionInput(questions: OpenCodeQuestionInfo[]): Record<string, unknown> {
  return {
    questions: questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      multiSelect: q.multiple === true,
    })),
  };
}

/**
 * Same translation applied to the raw `question` tool input as it arrives on a
 * ToolPart, so the tool card renders identically whether the tool part or the
 * `question.asked` event lands first. Anything that doesn't look like a
 * question payload passes through untouched.
 */
export function normalizeQuestionToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const questions = input.questions;
  if (!Array.isArray(questions)) return input;
  return toAskUserQuestionInput(questions as OpenCodeQuestionInfo[]);
}

/**
 * Translate the UI's answer map back into opencode's reply body.
 *
 * The frontend keys answers by question text (Claude's AskUserQuestion result
 * formatter looks them up that way); opencode wants one entry per question, in
 * question order, each an array of selected labels. Unanswered questions become
 * an empty array rather than being dropped, so the positional mapping holds.
 */
export function toOpenCodeAnswers(
  questions: OpenCodeQuestionInfo[],
  answers: unknown,
): string[][] {
  const byText = (answers && typeof answers === 'object' ? answers : {}) as Record<string, unknown>;
  return questions.map((q) => {
    const value = byText[q.question];
    if (typeof value === 'string') return value.trim() ? [value] : [];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    }
    return [];
  });
}

type StreamingPart = {
  type: 'text' | 'reasoning';
  text: string;
};

export class OpenCodeContentStream {
  private readonly pending = new Map<string, StreamingPart>();

  constructor(
    private readonly events: Pick<
      ProviderEvents,
      'onAssistantDelta' | 'onAssistantText' | 'onThinkingDelta' | 'onThinking'
    >,
    private readonly getModel: () => string | undefined,
  ) {}

  handlePart(part: TextPart | ReasoningPart): void {
    if (part.type === 'text' && (part.synthetic || part.ignored)) {
      this.pending.delete(part.id);
      return;
    }

    if (part.time?.end) {
      this.pending.delete(part.id);
      this.commit({ type: part.type, text: part.text });
      return;
    }

    const current = { type: part.type, text: part.text } satisfies StreamingPart;
    this.pending.set(part.id, current);
    this.emitDelta(current);
  }

  handleDelta(partID: string, field: string, delta: string): void {
    if (field !== 'text' || !delta) return;
    const current = this.pending.get(partID);
    if (!current) return;
    const next = { ...current, text: current.text + delta };
    this.pending.set(partID, next);
    this.emitDelta(next);
  }

  flush(): void {
    for (const part of this.pending.values()) this.commit(part);
    this.pending.clear();
  }

  private emitDelta(part: StreamingPart): void {
    if (!part.text) return;
    if (part.type === 'reasoning') this.events.onThinkingDelta(part.text);
    else this.events.onAssistantDelta(part.text);
  }

  private commit(part: StreamingPart): void {
    if (!part.text.trim()) return;
    if (part.type === 'reasoning') {
      this.events.onThinking({ type: 'thinking', text: part.text });
    } else {
      this.events.onAssistantText(part.text, { model: this.getModel() });
    }
  }
}

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
    case 'loop':
    case 'default':
    default:
      return { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' };
  }
}

export function buildOpenCodeMcpConfig(mcpServers?: Record<string, McpServerSpec>): McpConfig | undefined {
  if (!mcpServers) return undefined;
  const out: McpConfig = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    // Only HTTP MCP servers can be passed through; stdio/sse/sdk specs
    // either don't map cleanly or aren't portable across the HTTP gap.
    if (spec.type === 'http') {
      const url = new URL(spec.url);
      // OpenCode does not reliably preserve custom MCP headers across its
      // streamable-HTTP transport. Bind Codiby's owning UI session into the
      // server URL as well, while preserving headers for other MCP servers.
      const uiSessionId = spec.headers?.['x-session-id'];
      if (uiSessionId) url.searchParams.set('session_id', uiSessionId);
      out[name] = {
        type: 'remote',
        url: url.toString(),
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
  private readonly effort: string | null;
  private permissionMode: PermissionMode;

  private readonly readyPromise: Promise<{
    client: OpencodeClient;
    openSessionId: string;
    closeServer: () => void;
  }>;
  private initSent = false;
  private eventLoopAbort: AbortController | null = null;
  // Base URL of this session's opencode server. Captured as soon as the
  // server binds so the event loop can answer questions before `readyPromise`
  // settles (the `/question` routes aren't on the legacy SDK client, so they
  // go out over plain fetch).
  private serverUrl: string | null = null;

  private readonly contentStream: OpenCodeContentStream;
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
  // Question request ids already routed to the user. opencode 1.18 ships both
  // `question.asked` and `question.v2.asked` on the same stream; today only one
  // fires per question, but a release that emits both must not raise the prompt
  // twice (the second reply would 404 against an already-answered request).
  private readonly questionsHandled = new Set<string>();
  // messageIDs we know belong to user-role messages. Their parts must
  // not be emitted as assistant output (the prompt API echoes the user
  // text back as a part, which would otherwise show up as a duplicated
  // reply in the chat log).
  private readonly userMessageIds = new Set<string>();

  constructor(opts: SpawnOptions, events: ProviderEvents) {
    super(PROVIDER_NAME, opts.sessionId, events);
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.effort = opts.effort ?? null;
    this.permissionMode = opts.permissionMode;
    this.contentStream = new OpenCodeContentStream(
      events,
      () => this.model || undefined,
    );

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

    this.serverUrl = server.url;
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
          this.handleEvent(ev as OpenCodeEvent, openSessionId, client);
        }
      } catch (err) {
        if (controller.signal.aborted || this.closed) return;
        this.events.onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private handleEvent(ev: OpenCodeEvent, openSessionId: string, client: OpencodeClient): void {
    switch (ev.type) {
      case 'message.part.updated': {
        const part = ev.properties.part as Part;
        if (part.sessionID !== openSessionId) return;
        this.handlePart(part);
        return;
      }
      case 'message.part.delta': {
        const delta = ev.properties;
        if (delta.sessionID !== openSessionId) return;
        this.contentStream.handleDelta(delta.partID, delta.field, delta.delta);
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
        // Flush any text/reasoning parts that never got a final time.end.
        this.contentStream.flush();
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
      case 'question.asked':
      case 'question.v2.asked': {
        const req = ev.properties;
        if (req.sessionID !== openSessionId) return;
        void this.handleQuestionRequest(req, ev.type === 'question.v2.asked').catch((err) => {
          if (this.closed) return;
          this.events.onError(err instanceof Error ? err : new Error(String(err)));
        });
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
      case 'reasoning':
        this.contentStream.handlePart(part);
        return;
      case 'tool':
        this.handleToolPart(part);
        return;
      // step-start / step-finish / snapshot / patch / agent / retry /
      // compaction / file / subtask aren't surfaced to the chat log directly.
      // The bridge derives whatever state it needs from higher-level events.
      default:
        return;
    }
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
      // opencode's `question` tool is Codiby's AskUserQuestion under another
      // name. Rename it (and normalise its input) so the UI renders the inline
      // answer form instead of a generic tool card.
      const isQuestion = part.tool === OPENCODE_QUESTION_TOOL;
      const input = { ...(part.state.input as Record<string, unknown>) };
      const toolUse: AssistantToolUseBlock = {
        type: 'tool_use',
        id: callID,
        name: isQuestion ? ASK_USER_QUESTION_TOOL : part.tool,
        input: isQuestion ? normalizeQuestionToolInput(input) : input,
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

  /**
   * Bridge opencode's `question` protocol onto Codiby's AskUserQuestion flow.
   *
   * opencode blocks the tool until the request is replied to or rejected, so
   * this routes the questions through `onPermissionRequest` (the same channel
   * Claude's AskUserQuestion uses) and posts the user's selection back.
   */
  private async handleQuestionRequest(req: OpenCodeQuestionRequest, v2: boolean): Promise<void> {
    const questions = Array.isArray(req.questions) ? req.questions : [];
    if (questions.length === 0) return;
    if (this.questionsHandled.has(req.id)) return;
    this.questionsHandled.add(req.id);
    const input = toAskUserQuestionInput(questions);

    // The UI only renders the answer form inside the tool card, and the
    // `question.asked` event can beat the tool part's `running` transition.
    // Synthesise the tool_use here when it hasn't gone out yet; the later
    // ToolPart is deduped by `toolUseEmitted`.
    const callID = req.tool?.callID ?? req.id;
    if (!this.toolUseEmitted.has(callID)) {
      this.events.onToolUse({
        type: 'tool_use',
        id: callID,
        name: ASK_USER_QUESTION_TOOL,
        input,
        parentToolUseId: null,
      });
      this.toolUseEmitted.add(callID);
      this.pendingTools.add(callID);
    }

    // Keyed by the tool call id, not the question request id, so the answer the
    // bridge persists as a synthetic tool_result attaches to the tool card.
    const decision = await this.events.onPermissionRequest({
      requestId: callID,
      toolName: ASK_USER_QUESTION_TOOL,
      title: questions[0]?.question,
      description: questions[0]?.header,
      input,
    });

    if (this.closed) return;

    if (decision.allow) {
      await this.postQuestionResponse(req, v2, 'reply', {
        answers: toOpenCodeAnswers(questions, decision.updatedInput?.answers),
      });
      return;
    }

    // A denial that carries a message is an automatic one (loop mode, session
    // shutdown) and the message tells the agent how to proceed. `reject` has no
    // room for text, so feed the reason back as the answer — that mirrors what
    // Claude receives as the denied tool's result.
    if (decision.message) {
      await this.postQuestionResponse(req, v2, 'reply', {
        answers: questions.map(() => [decision.message as string]),
      });
      return;
    }

    await this.postQuestionResponse(req, v2, 'reject');
  }

  /**
   * POST to opencode's question routes. These live outside the legacy SDK
   * client (only its `/v2` surface generates them), so they go out as raw
   * fetches against the session's own server.
   */
  private async postQuestionResponse(
    req: OpenCodeQuestionRequest,
    v2: boolean,
    action: 'reply' | 'reject',
    body?: unknown,
  ): Promise<void> {
    if (!this.serverUrl) return;
    const path = v2
      ? `/api/session/${encodeURIComponent(req.sessionID)}/question/${encodeURIComponent(req.id)}/${action}`
      : `/question/${encodeURIComponent(req.id)}/${action}`;
    const url = new URL(path, this.serverUrl);
    // The legacy routes are directory-scoped the same way the SDK client is.
    if (!v2) url.searchParams.set('directory', this.cwd);

    try {
      const res = await fetch(url, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        throw new Error(`opencode question ${action} failed (${res.status}): ${await res.text()}`);
      }
    } catch (err) {
      if (this.closed) return;
      this.events.onError(err instanceof Error ? err : new Error(String(err)));
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

    // The legacy SDK client omits `variant` from its generated type, but
    // opencode's prompt endpoint accepts it to select a model variant.
    const body: NonNullable<Parameters<OpencodeClient['session']['promptAsync']>[0]['body']> & {
      variant?: string;
    } = { parts };
    const model = parseModel(this.model);
    if (model) body.model = model;
    if (this.effort) body.variant = this.effort;
    if (this.permissionMode === 'plan') body.system = PLAN_MODE_SYSTEM_PROMPT;

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

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // OpenCode locks Config.permission at server start, but the next prompt
    // can still receive plan-mode steering immediately.
    this.permissionMode = mode;
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
