/**
 * Personal Agent — channel registry, storage, and outbound dispatch.
 *
 * The Personal Agent is the always-on pseudo-session (`MAIN_SESSION_ID`) that
 * receives messages from external sources and routes assistant replies back.
 *
 * A `Channel` is the unit of integration: it declares both *how messages
 * arrive* (`inbound`) and *how replies are delivered* (`outbound`). The
 * channel TYPE identifies the peer on the other side (Telegram bot, HTTP
 * webhook caller, iOS Shortcut); the outbound STRATEGY is orthogonal to the
 * type — a Telegram channel can deliver replies back to Telegram, fire a CLI
 * command, POST to a callback URL, or drop them entirely.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID, randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { CODIBY_DIR, MAIN_SESSION_ID } from '../config/config';
import { loadTelegramSettings, saveTelegramSettings } from '../session/storage';
import { getSessionState } from '../session/state';
import { log, logError } from '../lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelType = 'http_webhook' | 'telegram' | 'ios_shortcut';

export type OutboundStrategy = 'native_reply' | 'callback_url' | 'cli_command' | 'off';

export interface TelegramInbound {
  /** Token from @BotFather. Empty disables the bot. */
  botToken: string;
  /** Optional chat-id restriction. Empty accepts any chat. */
  chatId: string;
}

export interface WebhookInbound {
  /** UUID embedded in the URL path. Acts as a per-channel routing key. */
  webhookId: string;
  /** Optional shared secret. When set, requests must include the matching
   *  `X-Personal-Agent-Token` header. */
  signingSecret: string;
}

export interface CallbackUrlConfig {
  url: string;
  /** Extra headers attached to the outbound POST. */
  headers: Record<string, string>;
}

export interface CliCommandConfig {
  /** Shell-style command with `{{text}}`, `{{session_id}}`, `{{source}}`,
   *  `{{request_id}}` placeholders. */
  command: string;
  /** Working directory the command runs in. Defaults to `~`. */
  cwd: string;
  /** Hard timeout in ms — process is killed if it exceeds this. */
  timeoutMs: number;
  /** When true, the reply text is also written to the process's stdin. */
  pipeStdin: boolean;
  /** Extra env vars merged into the spawn environment. */
  env: Record<string, string>;
}

export type OutboundConfig =
  | { strategy: 'off' }
  | { strategy: 'native_reply' }
  | { strategy: 'callback_url'; callback: CallbackUrlConfig }
  | { strategy: 'cli_command'; cli: CliCommandConfig };

interface ChannelBase {
  id: string;
  name: string;
  enabled: boolean;
  outbound: OutboundConfig;
}

export type TelegramChannel  = ChannelBase & { type: 'telegram';     inbound: TelegramInbound };
export type WebhookChannel   = ChannelBase & { type: 'http_webhook'; inbound: WebhookInbound  };
export type IosShortcutChannel = ChannelBase & { type: 'ios_shortcut'; inbound: WebhookInbound };

export type Channel = TelegramChannel | WebhookChannel | IosShortcutChannel;

export interface PersonalAgentConfig {
  channels: Channel[];
  /** When true, channels with `native_reply` and `callback_url` strategies
   *  skip empty / tool-only assistant turns. */
  suppressEmptyReplies: boolean;
  /** When false (default), the model's thinking / reasoning summaries are
   *  not delivered to outbound channels — only the final user-facing reply
   *  is. Flip this on if a channel should also see the chain-of-thought. */
  includeThinking: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const CONFIG_FILE = join(CODIBY_DIR, 'personal-agent.json');

const DEFAULT_CONFIG: PersonalAgentConfig = {
  channels: [],
  suppressEmptyReplies: true,
  includeThinking: false,
};

function freshWebhookId(): string {
  return randomUUID();
}

function freshSigningSecret(): string {
  return `pa_sk_${randomBytes(16).toString('hex')}`;
}

function makeDefaultOutbound(type: ChannelType): OutboundConfig {
  // Default delivery target depends on what the peer can naturally accept:
  // Telegram and HTTP webhooks both support replying back, iOS Shortcut
  // can't receive anything from us so it ships as `off`.
  if (type === 'ios_shortcut') return { strategy: 'off' };
  return { strategy: 'native_reply' };
}

/** Build a Telegram channel from the legacy `ui-telegram.json` settings file
 *  so existing installs don't lose their bot config when they upgrade. */
function migrateLegacyTelegram(): TelegramChannel | null {
  try {
    const legacy = loadTelegramSettings();
    if (!legacy.botToken) return null;
    return {
      id: randomUUID(),
      type: 'telegram',
      name: 'Telegram',
      enabled: true,
      inbound: { botToken: legacy.botToken, chatId: legacy.chatId },
      outbound: { strategy: 'native_reply' },
    };
  } catch {
    return null;
  }
}

let cache: PersonalAgentConfig | null = null;

export function loadPersonalAgentConfig(): PersonalAgentConfig {
  if (cache) return cache;
  if (existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      cache = normalize(parsed);
      return cache;
    } catch {
      // Corrupt file — fall through to defaults so the UI still loads.
    }
  }
  // First boot of the Personal Agent: migrate any existing Telegram config so
  // users don't have to re-enter their bot token. Persist the migrated shape
  // immediately so the legacy file is only read once.
  const migrated = migrateLegacyTelegram();
  const fresh: PersonalAgentConfig = {
    ...DEFAULT_CONFIG,
    channels: migrated ? [migrated] : [],
  };
  cache = fresh;
  try {
    mkdirSync(CODIBY_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(fresh, null, 2));
    if (migrated) log('[personal-agent] Migrated legacy ui-telegram.json into Telegram channel');
  } catch {}
  return fresh;
}

export function savePersonalAgentConfig(config: PersonalAgentConfig): void {
  const next = normalize(config);
  cache = next;
  mkdirSync(CODIBY_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

// ---------------------------------------------------------------------------
// Channel factories — used by the UI when adding a new channel.
// ---------------------------------------------------------------------------

export function makeChannel(type: ChannelType): Channel {
  const id = randomUUID();
  const outbound = makeDefaultOutbound(type);
  if (type === 'telegram') {
    return { id, type: 'telegram', name: 'Telegram', enabled: false, inbound: { botToken: '', chatId: '' }, outbound };
  }
  if (type === 'http_webhook') {
    return {
      id,
      type: 'http_webhook',
      name: 'HTTP Webhook',
      enabled: true,
      inbound: { webhookId: freshWebhookId(), signingSecret: freshSigningSecret() },
      outbound,
    };
  }
  return {
    id,
    type: 'ios_shortcut',
    name: 'iOS Shortcut',
    enabled: false,
    inbound: { webhookId: freshWebhookId(), signingSecret: freshSigningSecret() },
    outbound: { strategy: 'off' },
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Defensive normalisation — incoming objects (whether from disk or the UI)
 *  may be missing fields after upgrades, so backfill defaults rather than
 *  trusting the shape blindly. */
function normalize(raw: any): PersonalAgentConfig {
  const channels: Channel[] = Array.isArray(raw?.channels)
    ? raw.channels.map(normalizeChannel).filter(Boolean) as Channel[]
    : [];
  return {
    channels,
    suppressEmptyReplies: raw?.suppressEmptyReplies !== false,
    includeThinking: !!raw?.includeThinking,
  };
}

function normalizeChannel(raw: any): Channel | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    id: typeof raw.id === 'string' ? raw.id : randomUUID(),
    name: typeof raw.name === 'string' ? raw.name : 'Channel',
    enabled: !!raw.enabled,
    outbound: normalizeOutbound(raw.outbound),
  };
  if (raw.type === 'telegram') {
    return {
      ...base,
      type: 'telegram',
      inbound: {
        botToken: raw?.inbound?.botToken ?? '',
        chatId: raw?.inbound?.chatId ?? '',
      },
    };
  }
  if (raw.type === 'http_webhook' || raw.type === 'ios_shortcut') {
    return {
      ...base,
      type: raw.type,
      inbound: {
        webhookId: raw?.inbound?.webhookId || freshWebhookId(),
        signingSecret: raw?.inbound?.signingSecret ?? '',
      },
    } as Channel;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel lookup
// ---------------------------------------------------------------------------

export function findChannelByWebhookId(webhookId: string): WebhookChannel | IosShortcutChannel | null {
  const cfg = loadPersonalAgentConfig();
  for (const ch of cfg.channels) {
    if ((ch.type === 'http_webhook' || ch.type === 'ios_shortcut') && ch.inbound.webhookId === webhookId) {
      return ch;
    }
  }
  return null;
}

export function getTelegramChannel(): TelegramChannel | null {
  const cfg = loadPersonalAgentConfig();
  for (const ch of cfg.channels) if (ch.type === 'telegram') return ch;
  return null;
}

// ---------------------------------------------------------------------------
// Pending HTTP replies — used by the `native_reply` outbound strategy on
// http_webhook channels. The inbound route holds the response open until
// the dispatcher resolves it with the next assistant turn's text.
// ---------------------------------------------------------------------------

interface PendingReply {
  channelId: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingByRequest = new Map<string, PendingReply>();

export function registerPendingReply(opts: {
  requestId: string;
  channelId: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByRequest.delete(opts.requestId);
      reject(new Error('Personal Agent reply timeout'));
    }, opts.timeoutMs);
    pendingByRequest.set(opts.requestId, {
      channelId: opts.channelId,
      resolve,
      reject,
      timer,
    });
  });
}

function resolveOldestPendingForChannel(channelId: string, text: string): boolean {
  // FIFO: oldest waiting request gets the next assistant turn. Works for the
  // common 1-in/1-out case; cases with overlapping turns just queue.
  for (const [reqId, p] of pendingByRequest) {
    if (p.channelId === channelId) {
      clearTimeout(p.timer);
      pendingByRequest.delete(reqId);
      p.resolve(text);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Outbound dispatcher
// ---------------------------------------------------------------------------

const lastNotifiedByChannel = new Map<string, string>();

/** Substitute `{{text}}`, `{{session_id}}`, `{{source}}`, `{{request_id}}`
 *  inside a CLI command template. Values are rendered as-is — the caller is
 *  responsible for ensuring the template quotes them appropriately. */
function substitutePlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : ''));
}

async function runCliCommand(channel: Channel, text: string, requestId: string): Promise<void> {
  if (channel.outbound.strategy !== 'cli_command') return;
  const { cli } = channel.outbound;
  if (!cli.command.trim()) return;

  const vars = {
    text,
    session_id: MAIN_SESSION_ID,
    source: channel.type,
    request_id: requestId,
  };
  const cmd = substitutePlaceholders(cli.command, vars);
  const cwd = cli.cwd?.trim() ? cli.cwd.replace(/^~(?=\/|$)/, homedir()) : homedir();

  log(`[personal-agent] CLI dispatch (${channel.name}): ${cmd.slice(0, 100)}${cmd.length > 100 ? '…' : ''}`);

  return new Promise<void>((resolve) => {
    const child = spawn(cmd, {
      cwd,
      env: { ...process.env, ...cli.env },
      shell: true,
      stdio: cli.pipeStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1000, cli.timeoutMs || 10_000));

    if (cli.pipeStdin && child.stdin) {
      try { child.stdin.end(text); } catch {}
    }

    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      logError(`[personal-agent] CLI spawn failed (${channel.name}): ${err.message}`);
      resolve();
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        logError(`[personal-agent] CLI timed out (${channel.name}) after ${cli.timeoutMs}ms`);
      } else if (code !== 0) {
        logError(`[personal-agent] CLI exited ${code} (${channel.name}): ${stderr.slice(0, 200)}`);
      }
      resolve();
    });
  });
}

async function postCallbackUrl(channel: Channel, text: string, requestId: string): Promise<void> {
  if (channel.outbound.strategy !== 'callback_url') return;
  const { callback } = channel.outbound;
  if (!callback.url.trim()) return;
  try {
    const res = await fetch(callback.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...callback.headers,
      },
      body: JSON.stringify({
        text,
        session_id: MAIN_SESSION_ID,
        source: channel.type,
        request_id: requestId,
      }),
    });
    if (!res.ok) {
      logError(`[personal-agent] callback_url returned ${res.status} (${channel.name})`);
    }
  } catch (err) {
    logError(`[personal-agent] callback_url failed (${channel.name}): ${err}`);
  }
}

/** Fan a single assistant text message out to one channel's configured
 *  outbound strategy. Telegram native replies are NOT routed here — the
 *  Telegram bot's own polling loop sends them via sendTelegramResponse in
 *  telegram.ts, which preserves the working-message edit flow. */
async function dispatchToChannel(channel: Channel, text: string): Promise<void> {
  if (!channel.enabled) return;
  const strategy = channel.outbound.strategy;
  if (strategy === 'off') return;

  const requestId = `req_${randomBytes(6).toString('hex')}`;

  if (strategy === 'native_reply') {
    if (channel.type === 'http_webhook') {
      resolveOldestPendingForChannel(channel.id, text);
    }
    // Telegram native replies are handled by notifyTelegramIfMainSession.
    // iOS Shortcut native_reply is meaningless (no outbound channel) — no-op.
    return;
  }

  if (strategy === 'callback_url') {
    await postCallbackUrl(channel, text, requestId);
    return;
  }

  if (strategy === 'cli_command') {
    await runCliCommand(channel, text, requestId);
    return;
  }
}

/** Called from the provider bridge whenever an assistant turn completes on
 *  the Personal Agent's session. Walks new assistant text messages and
 *  dispatches each one through every enabled channel's outbound strategy.
 *  Idempotent across calls: each channel tracks its own last-seen message. */
export function dispatchPersonalAgentReplies(sessionId: string): void {
  if (sessionId !== MAIN_SESSION_ID) return;
  const cfg = loadPersonalAgentConfig();
  if (cfg.channels.length === 0) return;

  const state = getSessionState(sessionId);
  const messages = state.messages;
  if (messages.length === 0) return;

  for (const channel of cfg.channels) {
    if (!channel.enabled) continue;
    if (channel.outbound.strategy === 'off') continue;

    const lastSeen = lastNotifiedByChannel.get(channel.id) ?? null;
    let startIdx: number;
    if (lastSeen) {
      const lastIdx = messages.findIndex(m => m.id === lastSeen);
      startIdx = lastIdx >= 0 ? lastIdx + 1 : 0;
    } else {
      // No cursor yet (channel added since the last prime). Anchor at the
      // current end so only future turns dispatch — never replay older
      // history. The cursor itself is set below so we don't hit this branch
      // again on the next call.
      startIdx = messages.length;
      const tail = messages[messages.length - 1];
      if (tail) lastNotifiedByChannel.set(channel.id, tail.id);
    }

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role !== 'assistant') continue;
      if (msg.toolName || msg.isToolResult) continue;
      if (msg.isThinking && !cfg.includeThinking) continue;
      const text = (msg.content || '').trim();
      if (!text) {
        if (cfg.suppressEmptyReplies) continue;
      }
      // Fire and forget — channel failures shouldn't block dispatch to the
      // other channels.
      dispatchToChannel(channel, msg.content).catch(err => {
        logError(`[personal-agent] dispatchToChannel(${channel.name}) failed: ${err}`);
      });
      lastNotifiedByChannel.set(channel.id, msg.id);
    }
  }
}

/** Prime the per-channel `lastNotifiedByChannel` map at boot so a freshly
 *  restarted bridge doesn't replay every historical assistant turn as if it
 *  just arrived. */
export function primePersonalAgentDispatch(sessionId: string): void {
  if (sessionId !== MAIN_SESSION_ID) return;
  const cfg = loadPersonalAgentConfig();
  const state = getSessionState(sessionId);
  const last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
  if (!last) return;
  for (const ch of cfg.channels) {
    if (!lastNotifiedByChannel.has(ch.id)) lastNotifiedByChannel.set(ch.id, last.id);
  }
}

// ---------------------------------------------------------------------------
// Telegram legacy sync — when the user updates a Telegram channel via the
// new Personal Agent UI, mirror the bot token / chat id into the legacy
// `ui-telegram.json` so the existing bot polling loop in telegram.ts (which
// reads loadTelegramSettings) picks up the change unmodified.
// ---------------------------------------------------------------------------

export function syncTelegramLegacyFromConfig(): { changed: boolean } {
  const tg = getTelegramChannel();
  const desiredToken = tg?.enabled ? tg.inbound.botToken.trim() : '';
  const desiredChat  = tg?.enabled ? tg.inbound.chatId.trim()  : '';
  const current = loadTelegramSettings();
  if (current.botToken === desiredToken && current.chatId === desiredChat) {
    return { changed: false };
  }
  saveTelegramSettings({ botToken: desiredToken, chatId: desiredChat });
  return { changed: true };
}

function normalizeOutbound(raw: any): OutboundConfig {
  const strat: OutboundStrategy = raw?.strategy ?? 'native_reply';
  if (strat === 'off') return { strategy: 'off' };
  if (strat === 'callback_url') {
    return {
      strategy: 'callback_url',
      callback: {
        url: raw?.callback?.url ?? '',
        headers: typeof raw?.callback?.headers === 'object' && raw.callback.headers ? raw.callback.headers : {},
      },
    };
  }
  if (strat === 'cli_command') {
    return {
      strategy: 'cli_command',
      cli: {
        command: raw?.cli?.command ?? '',
        cwd: raw?.cli?.cwd ?? '',
        timeoutMs: Number.isFinite(raw?.cli?.timeoutMs) ? raw.cli.timeoutMs : 10_000,
        pipeStdin: !!raw?.cli?.pipeStdin,
        env: typeof raw?.cli?.env === 'object' && raw.cli.env ? raw.cli.env : {},
      },
    };
  }
  return { strategy: 'native_reply' };
}
