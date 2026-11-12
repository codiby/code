/**
 * End-to-end harness for the Codiby Agent: the whole agent runs in-process —
 * every area registered by agent/index.ts, the real channel adapters, the
 * real bridge events, policy, approvals, memory, proactivity and automations —
 * with only the edges faked:
 *
 *   - the LLM:       `FakeAgent` answers each message the agent session gets by
 *                    driving `createBridgeEvents` exactly like a provider would;
 *   - Telegram:      `FakeTelegram` stands in for the Bot API and keeps the
 *                    chat as the owner would see it (edits and deletes applied);
 *   - WhatsApp:      `FakeWacli` stands in for the wacli CLI;
 *   - webhooks:      real `WebhookChannel`s over real `Request`s, with a fake
 *                    fetch for callback URLs;
 *   - push (FCM):    a recording client that never touches the network.
 *
 * Nothing here reaches a real API, and nothing is written outside the test
 * sandbox (scripts/test-preload.ts points CODIBY_DATA_DIR at a temp dir).
 */

import { randomUUID } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { configureAutomationRunner, completeAutomationRun, _resetAutomationRunnerForTest } from '../../automation/runner';
import { database } from '../../database';
import { agentMessages } from '../../database/schema';
import { createBridgeEvents } from '../../provider/bridge';
import type { PermissionDecision, ProviderEvents, TurnCompleteInfo } from '../../provider/types';
import { addMessage, updateSessionState } from '../../session/state';
import type { Session } from '../../types';
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from '../config';
import { _resetDispatch } from '../dispatch';
import { startAgent } from '../index';
import { getChannel, _setOutboxSleep } from '../outbox';
import { runStartHooks, runStopHooks } from '../registry';
import { handleAgentRoute } from '../routes';
import { configureAgentRuntime } from '../runtime';
import { AGENT_SESSION_ID, ensureAgentSession } from '../session';
import { executeAgentTool } from '../tools';
import type { AgentDeps, ChannelAdapter, MessageSource, OutboundMessage } from '../types';
import { getChannelSecret, type ChannelConfig } from '../channels/config';
import { channelsActive, runningChannel, _setChannelFactory } from '../channels/manager';
import { TelegramChannel } from '../channels/telegram/adapter';
import type { EditTextOptions, SendTextOptions, TelegramApi, TgMessage, TgUpdate } from '../channels/telegram/api';
import type { CliResult } from '../channels/whatsapp/cli';
import { WhatsAppChannel } from '../channels/whatsapp/adapter';
import { WebhookChannel } from '../channels/webhook/adapter';
import { _resetActivityTracking } from '../policy/activity';
import { _resetApprovals, _setApprovalScheduler } from '../policy/approvals';
import { _setNotifyClock, _resetNotificationQueue } from '../proactive/notify';
import { _setReminderChannelWait } from '../proactive/reminders';
import { _resetHeartbeatCounter } from '../proactive/settings';
import { _setPushClientForTest } from '../push/sender';

// ---------------------------------------------------------------------------
// Identities and clocks
// ---------------------------------------------------------------------------

/** Port the agent believes the bridge listens on (shows up in webhook URLs). */
export const BRIDGE_PORT = 3914;
export const OWNER_NAME = 'Jova';
export const OWNER_TG_CHAT = 5550123;
export const STRANGER_TG_CHAT = 7770123;
export const OWNER_WA = '5216731400001@s.whatsapp.net';
export const STRANGER_WA = '5215550009999@s.whatsapp.net';
export const MX = 'America/Mexico_City'; // UTC-6 all year since 2022
/** 23:30 local in Mexico City — inside the 23:00–07:00 quiet hours. */
export const NIGHT = Date.parse('2026-11-12T05:30:00Z');
/** 10:00 local in Mexico City. */
export const DAY = Date.parse('2026-11-12T16:00:00Z');
export const AGENT_CTX = { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' };

export const settle = (ms = 25) => new Promise(r => setTimeout(r, ms));

/** Poll until `fn` is truthy; the failure message says what never happened. */
export async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeoutMs = 3_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    // Yield first: the fakes answer instantly, and a person never reacts
    // before the code that sent a message has heard back from the API.
    await settle(5);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
  }
}

/** True when `p` is still unsettled after `ms` — e.g. a permission nobody answered yet. */
export async function stillPending(p: Promise<unknown>, ms = 30): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([p.then(() => null, () => null), settle(ms).then(() => marker)]);
  return winner === marker;
}

export async function within<T>(p: Promise<T>, what: string, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot API fake — keeps each chat as the person would see it
// ---------------------------------------------------------------------------

export interface TgVisible {
  id: number;
  text: string;
  /** Inline keyboard callback data, null when there are no buttons. */
  buttons: string[] | null;
  markdown: boolean;
  /** Delivered without a notification sound. */
  silent: boolean;
  file?: { kind: string; path: string };
}

export class FakeTelegram {
  readonly calls: { method: string; args: unknown[] }[] = [];
  /**
   * Awaited before a message with buttons goes out — hold it to model a slow
   * or retrying Bot API while something else happens. The message shows up
   * in the chat only once the hold is released.
   */
  holdButtons: Promise<void> | null = null;
  private nextId = 1000;
  private readonly chats = new Map<string, TgVisible[]>();
  private updateSeq = 1;
  private messageSeq = 1;
  readonly api: TelegramApi;

  constructor() {
    const record = (method: string, ...args: unknown[]) => { this.calls.push({ method, args }); };
    const chat = (id: string) => {
      let c = this.chats.get(id);
      if (!c) { c = []; this.chats.set(id, c); }
      return c;
    };
    const find = (chatId: string, messageId: number) => chat(chatId).find(m => m.id === messageId);
    this.api = {
      getMe: async () => ({ id: 42, is_bot: true, username: 'codiby_e2e_bot' }),
      getUpdates: async () => [],
      sendMessage: async (chatId: string, text: string, o?: SendTextOptions) => {
        if (o?.keyboard && this.holdButtons) await this.holdButtons;
        record('sendMessage', chatId, text, o);
        const id = this.nextId++;
        // Read loosely: the option is the channel area's to name, the fake only reports it.
        const silent = !!(o as { silent?: boolean } | undefined)?.silent;
        chat(chatId).push({ id, text, buttons: o?.keyboard ? o.keyboard.flat().map(b => b.callback_data) : null, markdown: !!o?.markdown, silent });
        return { message_id: id };
      },
      editMessageText: async (chatId: string, messageId: number, text: string, o?: EditTextOptions) => {
        record('editMessageText', chatId, messageId, text, o);
        const m = find(chatId, messageId);
        if (!m) return;
        m.text = text;
        m.markdown = !!o?.markdown;
        if (o?.keyboard === null) m.buttons = null;
        else if (o?.keyboard) m.buttons = o.keyboard.flat().map(b => b.callback_data);
      },
      deleteMessage: async (chatId: string, messageId: number) => {
        record('deleteMessage', chatId, messageId);
        const c = chat(chatId);
        const i = c.findIndex(m => m.id === messageId);
        if (i >= 0) c.splice(i, 1);
      },
      sendChatAction: async (chatId: string, action: string) => { record('sendChatAction', chatId, action); },
      answerCallbackQuery: async (id: string, text?: string) => { record('answerCallbackQuery', id, text); },
      downloadFile: async (fileId: string) => { record('downloadFile', fileId); return { data: new Uint8Array([1, 2, 3]), filePath: 'f/file.bin' }; },
      sendFile: async (chatId: string, kind: string, file: { path: string }, caption?: string, o?: unknown) => {
        record('sendFile', chatId, kind, file, caption, o);
        const id = this.nextId++;
        const silent = !!(o as { silent?: boolean } | undefined)?.silent;
        chat(chatId).push({ id, text: caption ?? '', buttons: null, markdown: false, silent, file: { kind, path: file.path } });
        return { message_id: id };
      },
    };
  }

  /** The chat as its participant sees it now. */
  visible(chatId: number | string): TgVisible[] {
    return [...(this.chats.get(String(chatId)) ?? [])];
  }

  texts(chatId: number | string): string[] {
    return this.visible(chatId).map(m => m.text);
  }

  messageUpdate(chatId: number, text: string, extra: Partial<TgMessage> = {}): TgUpdate {
    return {
      update_id: this.updateSeq++,
      message: {
        message_id: this.messageSeq++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: chatId === OWNER_TG_CHAT ? OWNER_NAME : 'Stranger' },
        from: { id: chatId, first_name: chatId === OWNER_TG_CHAT ? OWNER_NAME : 'Stranger' },
        text,
        ...extra,
      },
    };
  }

  /** A button tap on one of the bot's own messages. */
  tapUpdate(chatId: number, messageId: number, data: string): TgUpdate {
    const msg = this.visible(chatId).find(m => m.id === messageId);
    return {
      update_id: this.updateSeq++,
      callback_query: {
        id: `cb-${this.updateSeq}`,
        from: { id: chatId },
        data,
        message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, text: msg?.text ?? '' },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// wacli fake — records every invocation, answers like the real CLI
// ---------------------------------------------------------------------------

export class FakeWacli {
  readonly runs: string[][] = [];
  /** message.received hooks as `wacli webhook ls --json` would list them. */
  hooks: { action: string; url: string; headers: Record<string, string>; when?: { account?: string[] } }[] = [];
  state = 'open';
  private seq = 1;

  readonly run = async (argv: string[]): Promise<CliResult> => {
    this.runs.push(argv);
    const w = argv.indexOf('webhook');
    if (w >= 0) {
      const [, sub, , url] = argv.slice(w);
      if (sub === 'ls') return { code: 0, stdout: JSON.stringify({ token: 'backend-secret', events: { 'message.received': this.hooks } }), stderr: '' };
      if (sub === 'add') {
        const h = argv[argv.indexOf('-H') + 1] ?? '';
        const [name, ...rest] = h.split(':');
        const acc = argv.includes('--for-account') ? [argv[argv.indexOf('--for-account') + 1]!] : undefined;
        this.hooks.push({ action: 'post', url: url!, headers: { [name!.trim()]: rest.join(':').trim() }, ...(acc ? { when: { account: acc } } : {}) });
        return { code: 0, stdout: 'ok\n', stderr: '' };
      }
      if (sub === 'rm') {
        const idx = Number(argv.at(-1));
        if (Number.isInteger(idx)) this.hooks.splice(idx, 1);
        return { code: 0, stdout: 'ok\n', stderr: '' };
      }
    }
    if (argv.includes('status')) return { code: 0, stdout: `account: codiby\nstate:   ${this.state}\n`, stderr: '' };
    if (argv.includes('text') || argv.includes('media')) {
      return { code: 0, stdout: `sent id: 3EB0E2E${String(this.seq++).padStart(9, '0')}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  /** Texts sent to `jid`, in order — what that person sees in WhatsApp. */
  textsTo(jid: string): string[] {
    return this.runs.filter(a => a.includes('text') && a[a.indexOf('--') + 1] === jid).map(a => a.at(-1)!);
  }

  /** The inbound token the channel registered with wacli (what wacli sends back). */
  registeredToken(url: string): string | null {
    const hook = this.hooks.find(h => h.url === url);
    return hook ? hook.headers['x-codiby-token'] ?? null : null;
  }
}

/** A `message.received` webhook body as wacli posts it. */
export function wacliPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'message.received',
    timestamp: Date.now(),
    account: 'codiby',
    id: `E2E${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
    chat: OWNER_WA,
    isGroup: false,
    from: OWNER_WA,
    fromMe: false,
    pushName: OWNER_NAME,
    type: 'text',
    text: 'hola',
    mediaMimetype: null,
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The fake LLM: answers the agent session through the real bridge events
// ---------------------------------------------------------------------------

export interface Delivered {
  sessionId: string;
  text: string;
  images?: { media_type: string; data: string }[];
  source?: MessageSource;
}

/** One provider turn, emitted through `createBridgeEvents` like the Claude adapter does. */
export class FakeTurn {
  private toolSeq = 0;
  private lastText = '';
  constructor(readonly events: ProviderEvents, readonly session: Session) {}

  say(text: string): this {
    this.events.onAssistantText(text);
    this.lastText = text;
    return this;
  }

  think(text: string): this {
    this.events.onThinking({ type: 'thinking', text });
    return this;
  }

  /** A tool call and its result; `run` executes it for real (agent MCP tools) and gets the tool-use id. */
  async tool(name: string, input: Record<string, unknown>, run?: (toolUseId: string) => Promise<unknown> | unknown): Promise<unknown> {
    const id = this.newToolId();
    this.events.onToolUse({ type: 'tool_use', id, name, input });
    const out = run ? await run(id) : 'ok';
    this.result(id, out);
    return out;
  }

  /**
   * A tool call that needs permission, in the order Claude emits it: the
   * tool_use block, then a permission request whose id is the tool-use id.
   */
  call(name: string, input: Record<string, unknown>): { requestId: string; decision: Promise<PermissionDecision> } {
    const id = this.newToolId();
    this.events.onToolUse({ type: 'tool_use', id, name, input });
    return { requestId: id, decision: this.events.onPermissionRequest({ requestId: id, toolName: name, input }) };
  }

  result(toolUseId: string, out: unknown): void {
    this.events.onToolResult({ toolUseId, content: typeof out === 'string' ? out : JSON.stringify(out) });
  }

  private newToolId(): string {
    return `toolu_e2e_${randomUUID().slice(0, 8)}_${this.toolSeq++}`;
  }

  /** Call one of the agent's own MCP tools (memory, reminders, notify_user, inbox…) the way the model would. */
  async mcp(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.tool(`mcp__codiby-code__${name}`, args, async () => {
      const r = await executeAgentTool(name, args, { sessionId: this.session.id, sessionName: this.session.name });
      return (r.content[0] as { text: string }).text;
    });
    return res as string;
  }

  /** A sub-agent (Agent/Task tool) talking inside the turn. */
  subagent(agentId: string, parentToolUseId: string, text: string): this {
    this.events.onThinking({ type: 'thinking', text: `${text} (thinking)`, agentId, parentToolUseId });
    this.events.onAssistantText(text, { agentId, parentToolUseId });
    return this;
  }

  /** The SDK's result message: repeats the last streamed text. */
  end(info: Partial<TurnCompleteInfo> = {}): void {
    this.events.onTurnComplete({ stopReason: 'end_turn', resultText: this.lastText || undefined, costUsd: 0.0001, durationMs: 5, ...info });
  }
}

export type Brain = (msg: Delivered, turn: FakeTurn) => Promise<void> | void;

export class FakeAgent {
  readonly received: Delivered[] = [];
  readonly broadcasts: { sessionId: string; msg: Record<string, unknown> }[] = [];
  readonly interrupts: string[] = [];
  /** How the "model" answers. Null = it receives the message and stays silent. */
  brain: Brain | null = null;
  /** Errors thrown by the brain surface here instead of vanishing in a timer. */
  readonly errors: unknown[] = [];
  private pending: Promise<void>[] = [];

  readonly bridgeDeps: Parameters<typeof createBridgeEvents>[1] = {
    broadcastToSession: (sessionId, msg) => { this.broadcasts.push({ sessionId, msg: msg as Record<string, unknown> }); },
    sendBrowserRequest: () => {},
    broadcastSessionList: () => {},
    // index.ts wires the same: an automation run ends when its turn does.
    onTurnComplete: (sessionId, info) => completeAutomationRun(sessionId, info),
  };

  readonly deps: AgentDeps = {
    port: BRIDGE_PORT,
    sendMessage: async (sessionId, text, images, opts) => this.deliver({ sessionId, text, images, source: opts?.source }),
    interruptSession: (sessionId) => { this.interrupts.push(sessionId); },
    broadcastToSession: (sessionId, msg) => { this.broadcasts.push({ sessionId, msg: msg as Record<string, unknown> }); },
    broadcastSessionList: () => {},
  };

  /** Provider conversations started so far (each `/new` makes the next turn start another). */
  threads = 0;

  /**
   * Bridge events for the agent session. A session without a provider
   * conversation gets one first (onInit), as a freshly spawned provider does —
   * memory consolidation and `/new` key off that conversation id.
   */
  events(): ProviderEvents {
    const session = ensureAgentSession();
    session.replayDone = true;
    const events = createBridgeEvents(session, this.bridgeDeps);
    if (!session.claudeSessionId) {
      events.onInit({
        // Unique per process: the agent session outlives one harness boot.
        providerSessionId: `fake-thread-${++this.threads}-${randomUUID().slice(0, 8)}`,
        cwd: session.cwd,
        version: 'e2e',
        model: 'fake-model',
        tools: [],
        slashCommands: [],
        permissionMode: session.permissionMode || 'default',
      });
    }
    return events;
  }

  turn(): FakeTurn {
    return new FakeTurn(this.events(), ensureAgentSession());
  }

  /** Mirrors index.ts sendMessageToSession: the user message lands in the transcript, then the provider runs. */
  private async deliver(msg: Delivered): Promise<{ ok: boolean; error?: string }> {
    this.received.push(msg);
    addMessage(msg.sessionId, {
      id: randomUUID(),
      role: 'user',
      content: msg.text,
      timestamp: Date.now(),
      ...(msg.images?.length ? { images: msg.images } : {}),
      ...(msg.source ? { source: msg.source } : {}),
    });
    updateSessionState(msg.sessionId, s => ({ ...s, isStreaming: true, wasInterrupted: false }));
    const brain = this.brain;
    if (brain && msg.sessionId === AGENT_SESSION_ID) {
      // The provider answers after sendMessage resolves, like a real stream.
      const p = new Promise<void>(resolve => setTimeout(resolve, 1)).then(() => brain(msg, this.turn())).catch(err => { this.errors.push(err); });
      this.pending.push(p);
    }
    return { ok: true };
  }

  /** Wait for every turn the brain started. */
  async idle(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      await Promise.all(batch);
    }
    await settle();
    if (this.errors.length) throw this.errors[0];
  }

  reset(): void {
    this.received.length = 0;
    this.broadcasts.length = 0;
    this.interrupts.length = 0;
    this.errors.length = 0;
    this.brain = null;
    this.pending = [];
  }
}

// ---------------------------------------------------------------------------
// Channel factory over the fakes
// ---------------------------------------------------------------------------

export interface CallbackPost { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export class FakeTransports {
  readonly telegram = new Map<string, FakeTelegram>();
  readonly wacli = new Map<string, FakeWacli>();
  readonly callbacks: CallbackPost[] = [];

  tg(id: string): FakeTelegram {
    let t = this.telegram.get(id);
    if (!t) { t = new FakeTelegram(); this.telegram.set(id, t); }
    return t;
  }

  wa(id: string): FakeWacli {
    let w = this.wacli.get(id);
    if (!w) { w = new FakeWacli(); this.wacli.set(id, w); }
    return w;
  }

  /** Same shape as manager.ts's default factory, with every transport faked. */
  readonly factory = (cfg: ChannelConfig): ChannelAdapter => {
    switch (cfg.type) {
      case 'telegram':
        return new TelegramChannel(cfg.id, cfg.name, { api: this.tg(cfg.id).api, transcribe: async () => 'voice transcript', poll: false }, !!getChannelSecret(cfg.id, 'token'));
      case 'whatsapp':
        return new WhatsAppChannel(cfg, { run: this.wa(cfg.id).run, transcribe: async () => 'voice transcript', backend: () => null }, () => getChannelSecret(cfg.id, 'token'));
      case 'http_webhook':
      case 'ios_shortcut':
        return new WebhookChannel(cfg, {
          collectMs: 20,
          fetch: async (url, init) => {
            this.callbacks.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
            return new Response('ok');
          },
        }, {
          token: () => getChannelSecret(cfg.id, 'token'),
          signing: () => getChannelSecret(cfg.id, 'signing'),
        });
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers — the same entry point index.ts uses for /agent/*
// ---------------------------------------------------------------------------

/**
 * `authenticated: false` is a caller on the internet (public routes only);
 * `auth` passes what index.ts would establish, e.g. the agent's own shell
 * curling localhost: authenticated, but not owner-verified.
 */
export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: { authenticated?: boolean; auth?: Parameters<typeof handleAgentRoute>[2]; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const url = new URL(`http://127.0.0.1:${BRIDGE_PORT}${path}`);
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await handleAgentRoute(req, url, opts.auth ?? opts.authenticated ?? true);
  if (!res) throw new Error(`No agent route answered ${method} ${path}`);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Inbound/outbound rows in agent_messages (what GET /agent/messages lists). */
export function messageRows(channelId: string) {
  return database.select().from(agentMessages).where(eq(agentMessages.channelId, channelId)).orderBy(desc(agentMessages.createdAt)).all();
}

/** Watch everything the outbox hands one running channel (priority included — the wire APIs can't show it). */
export function spyChannel(channelId: string): { sent: OutboundMessage[]; restore(): void } {
  const adapter = runningChannel(channelId) ?? getChannel(channelId);
  if (!adapter) throw new Error(`Channel ${channelId} is not running`);
  const original = adapter.send.bind(adapter);
  const sent: OutboundMessage[] = [];
  (adapter as { send: ChannelAdapter['send'] }).send = async (to, msg) => { sent.push(msg); return original(to, msg); };
  return { sent, restore: () => { (adapter as { send: ChannelAdapter['send'] }).send = original; } };
}

// ---------------------------------------------------------------------------
// Boot and shutdown
// ---------------------------------------------------------------------------

export interface AgentHarness {
  agent: FakeAgent;
  transports: FakeTransports;
  /** Approval expiry timers, captured so nothing fires on its own. */
  expiries: { fn: () => void; ms: number }[];
  pushes: unknown[];
  /** Create a channel through POST /agent/channels (it starts through the manager with the fake transports). */
  addChannel(body: Record<string, unknown>): Promise<{ id: string; [k: string]: unknown }>;
  /** Reset per-test state (dispatch cursor, approvals, clocks, fake agent). */
  reset(): void;
  shutdown(): Promise<void>;
}

const TELEGRAM_TOKEN = '123456:AAE2eTestTokenValue-abcdefghijklmnop';

/**
 * Boot the agent like index.ts does (startAgent → every area's start hook)
 * with fakes at the edges. Restores the agent config and stops every area on
 * shutdown so later suites see an agent that is off.
 */
export async function bootAgent(): Promise<AgentHarness> {
  const original: AgentConfig = loadAgentConfig();
  const agent = new FakeAgent();
  const transports = new FakeTransports();
  const expiries: { fn: () => void; ms: number }[] = [];
  const pushes: unknown[] = [];
  const created: string[] = [];

  saveAgentConfig({
    ...original,
    enabled: true,
    persona: { ...original.persona, name: 'Codiby', emoji: '', timezone: MX, language: '' },
    owner: { name: OWNER_NAME, telegramChatIds: [String(OWNER_TG_CHAT)], whatsappJids: [OWNER_WA], emails: ['owner@example.com'] },
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    preferredChannel: null,
    model: null,
  });

  _setChannelFactory(transports.factory);
  _setOutboxSleep(async () => {});
  _setApprovalScheduler((fn, ms) => { expiries.push({ fn, ms }); return setTimeout(() => {}, 0); });
  _setReminderChannelWait(0);
  _setPushClientForTest({
    async send(_sa, message) { pushes.push(message); return { ok: true, messageId: `push-${pushes.length}` }; },
    reset() {},
  });
  configureAutomationRunner({ port: BRIDGE_PORT, sendMessage: (sid, text) => agent.deps.sendMessage(sid, text), broadcastSessionList: () => {}, interruptSession: agent.deps.interruptSession });

  await startAgent(agent.deps);
  // startAgent runs the start hooks only on its first call per process; a
  // later suite boots the areas itself.
  if (!channelsActive()) {
    configureAgentRuntime(agent.deps);
    ensureAgentSession();
    await runStartHooks();
  }
  if (!channelsActive()) throw new Error('The agent did not start its channels');

  const harness: AgentHarness = {
    agent,
    transports,
    expiries,
    pushes,
    async addChannel(body) {
      const payload = body.type === 'telegram' && !body.botToken ? { ...body, botToken: TELEGRAM_TOKEN } : body;
      const res = await api('POST', '/agent/channels', payload);
      if (res.status !== 201) throw new Error(`POST /agent/channels → ${res.status}: ${JSON.stringify(res.body)}`);
      created.push(res.body.id);
      return res.body;
    },
    reset() {
      agent.reset();
      configureAgentRuntime(agent.deps);
      _resetDispatch();
      _resetApprovals();
      _resetActivityTracking();
      _resetAutomationRunnerForTest();
      _resetHeartbeatCounter();
      // Drop held notifications too, not just the timer, so tests never leak into each other.
      _resetNotificationQueue();
      _setNotifyClock(null);
      expiries.length = 0;
      pushes.length = 0;
      transports.callbacks.length = 0;
      // A turn left streaming by a failed test must not make the next one look mid-turn.
      updateSessionState(AGENT_SESSION_ID, s => ({ ...s, isStreaming: false, permRequest: null, wasInterrupted: false }));
    },
    async shutdown() {
      await agent.idle().catch(() => {});
      for (const id of created) await api('DELETE', `/agent/channels/${encodeURIComponent(id)}`);
      saveAgentConfig({ ...original, enabled: false });
      await runStopHooks();
      _setChannelFactory(null);
      _setApprovalScheduler(null);
      _setPushClientForTest(null);
      _setNotifyClock(null);
      _resetApprovals();
      _resetDispatch();
      saveAgentConfig(original);
    },
  };
  return harness;
}
