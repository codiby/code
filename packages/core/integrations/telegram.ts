/**
 * Compatibility shim for the pre-agent Telegram bot.
 *
 * The bot now lives in agent/channels/telegram as one of the agent's
 * channels: it starts and stops with the agent, replies flow through the
 * agent's dispatch, and tool progress through `emitAgentToolUse`. These
 * exports keep the old call sites (index.ts, lib/shutdown.ts,
 * provider/bridge.ts) and the `/telegram/settings` routes working.
 */

import { loadAgentConfig, patchAgentConfig } from '../agent/config';
import {
  addChannelConfig,
  deleteSecretForChannel,
  hasChannelSecret,
  listChannelConfigs,
  setChannelSecret,
  updateChannelConfig,
  type TelegramChannelConfig,
} from '../agent/channels/config';
import { restartChannel, runningChannel, stopChannels } from '../agent/channels/manager';
import { TelegramChannel } from '../agent/channels/telegram/adapter';

type Broadcaster = (sessionId: string, msg: object) => void;

/** No-op: the agent's runtime broadcasts (see agent/runtime.ts). */
export function setTelegramBroadcaster(_fn: Broadcaster): void {}

/** No-op: Telegram channels start with the agent (agent/channels, onAgentStart). */
export function startTelegramBot(_port: number): void {}

/** Process shutdown: stop polling (and every other channel) before exit. */
export function stopTelegramBot(): void {
  void stopChannels();
}

function telegramConfigs(): TelegramChannelConfig[] {
  return listChannelConfigs().filter((c): c is TelegramChannelConfig => c.type === 'telegram');
}

export function restartTelegramBot(_port?: number): void {
  for (const cfg of telegramConfigs()) void restartChannel(cfg.id);
}

export function isTelegramBotRunning(): boolean {
  return telegramConfigs().some(cfg => {
    const ch = runningChannel(cfg.id);
    return !!ch && ch.status().connected;
  });
}

/** No-op: agent/dispatch.ts delivers the agent's replies to every channel. */
export function notifyTelegramIfMainSession(_sessionId: string): void {}

/** No-op: tool progress reaches the working bubble through emitAgentToolUse. */
export async function updateWorkingWithTool(_toolName: string, _summary: string): Promise<void> {}

// ---------------------------------------------------------------------------
// /telegram/settings (Settings → Telegram Bot)
// ---------------------------------------------------------------------------

export interface TelegramSettingsView {
  /** Always '' — the token is write-only now. */
  botToken: '';
  hasToken: boolean;
  /** First paired chat (legacy field). */
  chatId: string;
  chatIds: string[];
  running: boolean;
  botUsername: string | null;
  channelId: string | null;
  agentEnabled: boolean;
}

export function telegramSettingsView(): TelegramSettingsView {
  const cfg = telegramConfigs()[0] ?? null;
  const agent = loadAgentConfig();
  const adapter = cfg ? runningChannel(cfg.id) : null;
  return {
    botToken: '',
    hasToken: !!cfg && hasChannelSecret(cfg.id, 'token'),
    chatId: agent.owner.telegramChatIds[0] ?? '',
    chatIds: agent.owner.telegramChatIds,
    running: isTelegramBotRunning(),
    botUsername: adapter instanceof TelegramChannel ? adapter.botUsername : null,
    channelId: cfg?.id ?? null,
    agentEnabled: agent.enabled,
  };
}

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/**
 * Apply the old settings form onto the first Telegram channel. An empty
 * `botToken` keeps the stored one (the form can no longer read it back);
 * `clearToken: true` removes it. A `chatId` is added to the paired chats.
 */
export async function applyTelegramSettings(body: unknown): Promise<{ ok: boolean; running: boolean; error?: string }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const token = typeof b.botToken === 'string' ? b.botToken.trim() : '';
  const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
  if (token && !TOKEN_RE.test(token)) return { ok: false, running: isTelegramBotRunning(), error: 'That does not look like a bot token from @BotFather' };
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) return { ok: false, running: isTelegramBotRunning(), error: 'The chat id must be a number' };

  let cfg = telegramConfigs()[0] ?? null;
  if (token) {
    cfg ??= addChannelConfig({ type: 'telegram' }) as TelegramChannelConfig;
    setChannelSecret(cfg.id, 'token', token);
    if (!cfg.enabled) cfg = updateChannelConfig(cfg.id, { enabled: true }) as TelegramChannelConfig;
  } else if (b.clearToken === true && cfg) {
    deleteSecretForChannel(cfg.id, 'token');
  }
  if (chatId) {
    const owner = loadAgentConfig().owner;
    if (!owner.telegramChatIds.includes(chatId)) patchAgentConfig({ owner: { telegramChatIds: [...owner.telegramChatIds, chatId] } });
  }
  if (cfg) await restartChannel(cfg.id);
  return { ok: true, running: isTelegramBotRunning() };
}
