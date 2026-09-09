/** Codex app-server adapter: persistent JSONL connection, models and interactive approvals. */
import { randomUUID } from 'node:crypto';
import type { McpServerSpec, PermissionMode, ProviderEvents, ProviderSession, SpawnOptions, ImageInput, TokenUsage } from '../types';
import { Adapter } from '../adapter';
import { ProviderSessionBase } from '../session';
import { CodexAppServer, listCodexModels, type CodexConnect, type CodexConnection } from '../codex-app-server';

// Configuration overrides sent to the app-server when opening a thread.
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

export function buildCodexConfig(mcpServers?: Record<string, McpServerSpec>): CodexConfigObject | undefined {
  if (!mcpServers) return undefined;
  const codexMcp: CodexConfigObject = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    // HTTP and stdio are portable. In-process Anthropic SDK servers are not.
    if (spec.type === 'http') {
      const entry: CodexConfigObject = { url: spec.url };
      if (spec.headers) entry.http_headers = spec.headers as unknown as CodexConfigObject;
      if (spec.timeoutMs != null) entry.tool_timeout_sec = spec.timeoutMs / 1000;
      codexMcp[name] = entry;
    } else if (spec.type === 'stdio') {
      codexMcp[name] = { command: spec.command, ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) };
    }
  }
  if (Object.keys(codexMcp).length === 0) return undefined;
  return { mcp_servers: codexMcp };
}

export function codexPermissions(mode: PermissionMode, cwd: string) {
  if (mode === 'bypassPermissions' || mode === 'loop') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  const sandboxPolicy = mode === 'plan'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: mode === 'plan' ? 'read-only' : 'workspace-write', sandboxPolicy };
}

type TurnState = {
  id: string | null;
  cancelled: boolean;
  started: ReturnType<typeof Promise.withResolvers<string | null>>;
  done: ReturnType<typeof Promise.withResolvers<any>>;
  texts: Map<string, string>;
  tools: Set<string>;
  usage?: TokenUsage;
};

export class CodexProviderSession extends ProviderSessionBase {
  private connection: CodexConnection;
  private ready: Promise<void>;
  private threadId = '';
  private defaultModel: string | null = null;
  private active: TurnState | null = null;
  private running: TurnState | null = null;
  private pendingRun: Promise<void> = Promise.resolve();
  private approvals: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(private opts: SpawnOptions, events: ProviderEvents, connect: CodexConnect) {
    super('codex', opts.sessionId, events);
    this.opts = { ...opts };
    this.connection = connect({
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => {
        // The UI displays one decision at a time. Serialize concurrent
        // requests so a later approval cannot hide an unanswered one.
        const result = this.approvals.then(() => this.approve(method, params));
        this.approvals = result.catch(() => {});
        return result;
      },
      exit: error => {
        if (this.closed || this.failed) return;
        this.failed = true;
        this.running?.done.resolve({ status: 'failed', error: { message: error.message } });
        this.events.onError(error);
        this.events.onExit(1);
      },
    });
    this.ready = this.initialize();
    void this.ready.catch(error => {
      if (!this.closed && !this.failed) {
        this.failed = true;
        this.events.onError(error instanceof Error ? error : new Error(String(error)));
        this.events.onExit(1);
        void this.connection.close();
      }
    });
  }

  private async initialize() {
    await this.connection.ready;
    const { sandboxPolicy, ...permissions } = codexPermissions(this.opts.permissionMode, this.opts.cwd);
    const result = await this.connection.request(this.opts.resumeSessionId ? 'thread/resume' : 'thread/start', {
      ...(this.opts.resumeSessionId ? { threadId: this.opts.resumeSessionId, excludeTurns: true } : {}),
      cwd: this.opts.cwd, model: this.opts.model, ...permissions,
      config: buildCodexConfig(this.opts.mcpServers),
      developerInstructions: this.opts.extraSystemPrompt || null,
    });
    this.threadId = result.thread.id;
    this.defaultModel = result.model;
    if (this.closed) return;
    this.events.onInit({ providerSessionId: this.threadId, cwd: this.opts.cwd, version: '', model: result.model || '', tools: [], slashCommands: [], permissionMode: this.opts.permissionMode });
    void listCodexModels(this.connection).then(models => {
      this.defaultModel = models.find(m => m.isDefault)?.model || this.defaultModel;
      if (!this.closed) this.events.onModelsAvailable(models.map(m => ({ id: m.model, label: m.displayName })));
    }).catch(() => {});
  }

  async sendUserMessage(input: { text: string; images?: ImageInput[] }) {
    if (this.closed) return;
    if (this.active) { this.active.cancelled = true; void this.interruptTurn(this.active); }
    const previous = this.pendingRun;
    const state: TurnState = { id: null, cancelled: false, started: Promise.withResolvers(), done: Promise.withResolvers(), texts: new Map(), tools: new Set() };
    this.active = state;
    this.pendingRun = this.run(input, state, previous);
  }

  private async run(input: { text: string; images?: ImageInput[] }, state: TurnState, previous: Promise<void>) {
    const current = () => !this.closed && !this.failed && this.active === state;
    try {
      await previous;
      await this.ready;
      if (!current() || state.cancelled) return;
      this.running = state;
      const { sandbox, ...permissions } = codexPermissions(this.opts.permissionMode, this.opts.cwd);
      const result = await this.connection.request('turn/start', {
        threadId: this.threadId,
        input: [
          ...(input.images || []).map(image => ({ type: 'image', url: `data:${image.media_type};base64,${image.data}` })),
          { type: 'text', text: input.text, text_elements: [] },
        ],
        model: this.opts.model || this.defaultModel,
        effort: this.opts.effort === 'max' ? 'xhigh' : this.opts.effort || null,
        ...permissions,
      });
      state.id = result.turn.id;
      state.started.resolve(state.id);
      const turn = await state.done.promise;
      if (!current()) return;
      if (turn.status === 'interrupted') state.cancelled = true;
      if (state.cancelled) return;
      if (turn.status === 'failed') this.events.onError(new Error(turn.error?.message || 'Codex turn failed'));
      else this.events.onTurnComplete({ stopReason: 'end_turn', usage: state.usage, model: this.opts.model || this.defaultModel || undefined });
    } catch (error) {
      if (current() && !state.cancelled) this.events.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      state.started.resolve(null);
      state.done.resolve({ status: 'interrupted' });
      if (this.running === state) this.running = null;
      if (current()) {
        this.active = null;
        if (state.cancelled) this.events.onTurnComplete({ stopReason: 'interrupted' });
      }
    }
  }

  private notification(method: string, params: any) {
    if (this.closed || params.threadId !== this.threadId) return;
    const state = this.running;
    if (!state) return;
    if (method === 'turn/started') {
      state.id = params.turn.id;
      state.started.resolve(state.id);
      return;
    }
    if (params.turnId && state.id && params.turnId !== state.id) return;
    if (method === 'turn/completed') {
      if (state.id && params.turn.id !== state.id) return;
      state.done.resolve(params.turn);
      return;
    }
    if (this.active !== state || state.cancelled) return;
    if (method === 'item/agentMessage/delta') {
      const text = (state.texts.get(params.itemId) || '') + params.delta;
      state.texts.set(params.itemId, text);
      this.events.onAssistantDelta(text);
    } else if (method === 'item/started') {
      this.toolStarted(params.item, state);
    } else if (method === 'item/completed') {
      this.itemCompleted(params.item, state);
    } else if (method === 'turn/plan/updated') {
      this.events.onTodosUpdate((params.plan || []).map((item: any) => ({ content: item.step, activeForm: item.step, status: item.status === 'inProgress' ? 'in_progress' : item.status })));
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last;
      if (usage) state.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedInputTokens };
    }
  }

  private toolStarted(item: any, state: TurnState) {
    if (state.tools.has(item.id)) return;
    const tool = item.type === 'commandExecution' ? { name: 'Bash', input: { command: item.command, cwd: item.cwd } }
      : item.type === 'fileChange' ? { name: 'CodexEdit', input: { changes: item.changes } }
      : item.type === 'mcpToolCall' ? { name: `${item.server}__${item.tool}`, input: item.arguments || {} }
      : item.type === 'webSearch' ? { name: 'WebSearch', input: { query: item.query } } : null;
    if (!tool) return;
    state.tools.add(item.id);
    this.events.onToolUse({ type: 'tool_use', id: item.id, ...tool, parentToolUseId: null });
  }

  private itemCompleted(item: any, state: TurnState) {
    if (item.type === 'agentMessage') {
      state.texts.delete(item.id);
      this.events.onAssistantText(item.text, { model: this.opts.model || this.defaultModel || undefined });
      return;
    }
    if (item.type === 'reasoning') {
      // Only the public summary is surfaced; raw reasoning content is ignored.
      const text = (item.summary || []).join('\n');
      if (text) this.events.onThinking({ type: 'thinking', text });
      return;
    }
    this.toolStarted(item, state);
    if (!state.tools.has(item.id)) return;
    const isError = item.status === 'failed' || item.status === 'declined' || (item.type === 'commandExecution' && item.exitCode != null && item.exitCode !== 0);
    const content = item.type === 'commandExecution' ? `${item.aggregatedOutput || ''}${item.exitCode != null ? `\n[exit ${item.exitCode}]` : ''}`
      : item.type === 'fileChange' ? (item.changes || []).map((change: any) => `${change.kind?.type || change.kind} ${change.path}`).join('\n')
      : item.type === 'mcpToolCall' ? (item.error?.message || item.result?.content || item.result?.structuredContent || '')
      : `Search complete: ${item.query || ''}`;
    this.events.onToolResult({ toolUseId: item.id, content, isError, parentToolUseId: null });
  }

  private async approve(method: string, params: any): Promise<unknown> {
    const state = this.running;
    const stale = () => this.closed || !state || state.cancelled || this.active !== state || params.threadId !== this.threadId || (params.turnId && state.id && params.turnId !== state.id);
    const ask = async (toolName: string, input: Record<string, unknown>, description?: string) => {
      if (stale()) return { allow: false } as const;
      return this.events.onPermissionRequest({ requestId: randomUUID(), toolName, input, description });
    };
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const decision = await ask(method.includes('commandExecution') ? 'Bash' : 'Edit', params, params.reason || undefined);
      return { decision: !stale() && decision.allow ? 'accept' : 'decline' };
    }
    if (method === 'item/permissions/requestApproval') {
      const decision = await ask('CodexPermissions', params, params.reason || 'Codex requests additional permissions');
      return { permissions: !stale() && decision.allow ? params.permissions : {}, scope: 'turn' };
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = (params.questions || []).map((q: any) => ({ header: q.header, question: q.question, options: q.options || [], multiSelect: false }));
      const decision = await ask('AskUserQuestion', { questions });
      const selected = decision.allow ? (decision.updatedInput?.answers as Record<string, string> || {}) : {};
      return { answers: Object.fromEntries((params.questions || []).map((q: any) => [q.id, { answers: !stale() && decision.allow ? [selected[q.header] || selected[q.question] || selected[q.id] || ''] : [] }])) };
    }
    if (method === 'mcpServer/elicitation/request') {
      // Codex uses this channel for MCP approval forms as well as tool input.
      // Never invent form values: forward fields to the existing question UI.
      const properties = params.requestedSchema?.properties || {};
      const keys = Object.keys(properties);
      const questions = keys.map(key => ({ header: key, question: properties[key].description || properties[key].title || key, options: (properties[key].enum || (properties[key].type === 'boolean' ? ['true', 'false'] : [])).map((value: any) => ({ label: String(value), description: '' })), multiSelect: false }));
      const decision = await ask(keys.length ? 'AskUserQuestion' : 'CodexMCPApproval', keys.length ? { questions, message: params.message } : params, params.message);
      if (stale() || !decision.allow) return { action: 'decline', content: null, _meta: null };
      const answers = (decision.updatedInput?.answers || {}) as Record<string, string>;
      const content = Object.fromEntries(keys.map(key => {
        const value = answers[key] ?? answers[properties[key].description || properties[key].title || key] ?? '';
        if ((properties[key].type === 'number' || properties[key].type === 'integer') && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error(`Invalid numeric answer for ${key}`);
        const type = properties[key].type;
        return [key, type === 'boolean' ? value === 'true' : type === 'integer' || type === 'number' ? Number(value) : value];
      }));
      return { action: 'accept', content: keys.length ? content : null, _meta: null };
    }
    throw new Error(`Unsupported Codex request: ${method}`);
  }

  private async interruptTurn(state: TurnState) {
    const id = await state.started.promise;
    if (!id || this.closed) return;
    try { await this.connection.request('turn/interrupt', { threadId: this.threadId, turnId: id }); }
    catch { state.done.resolve({ status: 'interrupted' }); }
  }
  async interrupt() { if (this.active) { this.active.cancelled = true; await this.interruptTurn(this.active); } }
  async setModel(model: string | null) { this.opts.model = model; }
  async setPermissionMode(mode: PermissionMode) { this.opts.permissionMode = mode; }
  async close() {
    if (!this.beginClose()) return;
    if (this.active) { this.active.cancelled = true; this.active.done.resolve({ status: 'interrupted' }); }
    await this.connection.close();
    await this.pendingRun;
    this.events.onExit(0);
  }
}

export class CodexAdapter extends Adapter {
  readonly name = 'codex';
  constructor(private connect: CodexConnect = handlers => new CodexAppServer(handlers)) { super(); }
  spawn(opts: SpawnOptions, events: ProviderEvents): ProviderSession { return new CodexProviderSession(opts, events, this.connect); }
}
