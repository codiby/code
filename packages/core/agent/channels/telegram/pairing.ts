/**
 * Telegram pairing — how a chat becomes the owner's.
 *
 * An unknown private chat that sends /start gets a 6-digit code. The request
 * shows up in Agent → Channels with the chat's name and the same code; only
 * an owner approval there adds the chat id to `owner.telegramChatIds`. The
 * code lets the owner check they approve their own chat, not a lookalike
 * that happened to /start the bot at the same time.
 */

import { randomInt } from 'crypto';
import { loadAgentConfig, patchAgentConfig } from '../../config';
import { getChannelConfig, updateChannelConfig, type TelegramChannelConfig, type TelegramPairing } from '../config';

export const PAIRING_TTL_MS = 60 * 60_000;
const MAX_PENDING = 10;
/** After a rejection the same chat cannot ask again for a while (no spamming the owner). */
const REJECT_COOLDOWN_MS = 30 * 60_000;

const rejectedAt = new Map<string, number>();

function telegramConfig(channelId: string): TelegramChannelConfig {
  const cfg = getChannelConfig(channelId);
  if (!cfg || cfg.type !== 'telegram') throw new Error(`Unknown Telegram channel ${channelId}`);
  return cfg;
}

export function livePairings(cfg: TelegramChannelConfig, now = Date.now()): TelegramPairing[] {
  return cfg.pendingPairings.filter(p => p.expiresAt > now);
}

export function isOwnerChatId(chatId: string): boolean {
  return loadAgentConfig().owner.telegramChatIds.includes(chatId);
}

export type PairingRequestResult =
  | { status: 'pending'; code: string; isNew: boolean }
  | { status: 'cooldown' }
  | { status: 'paired' };

/** Create (or reuse) the pending request for a chat. */
export function requestPairing(
  channelId: string,
  chat: { chatId: string; title: string; username: string | null },
  now = Date.now(),
): PairingRequestResult {
  if (isOwnerChatId(chat.chatId)) return { status: 'paired' };
  const rejected = rejectedAt.get(`${channelId}:${chat.chatId}`);
  if (rejected && now - rejected < REJECT_COOLDOWN_MS) return { status: 'cooldown' };

  const cfg = telegramConfig(channelId);
  const live = livePairings(cfg, now);
  const existing = live.find(p => p.chatId === chat.chatId);
  if (existing) return { status: 'pending', code: existing.code, isNew: false };

  const pairing: TelegramPairing = {
    chatId: chat.chatId,
    title: chat.title.slice(0, 200),
    username: chat.username,
    code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    requestedAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  };
  updateChannelConfig(channelId, { pendingPairings: [...live, pairing].slice(-MAX_PENDING) });
  return { status: 'pending', code: pairing.code, isNew: true };
}

/** Approve: the chat becomes an owner chat. Returns the pairing that was approved. */
export function approvePairing(channelId: string, chatId: string, now = Date.now()): TelegramPairing {
  const cfg = telegramConfig(channelId);
  const pairing = livePairings(cfg, now).find(p => p.chatId === chatId);
  if (!pairing) throw new Error('That pairing request expired or does not exist');
  const owner = loadAgentConfig().owner;
  if (!owner.telegramChatIds.includes(chatId)) {
    patchAgentConfig({ owner: { telegramChatIds: [...owner.telegramChatIds, chatId] } });
  }
  updateChannelConfig(channelId, { pendingPairings: cfg.pendingPairings.filter(p => p.chatId !== chatId && p.expiresAt > now) });
  return pairing;
}

export function rejectPairing(channelId: string, chatId: string, now = Date.now()): boolean {
  const cfg = telegramConfig(channelId);
  const had = cfg.pendingPairings.some(p => p.chatId === chatId);
  updateChannelConfig(channelId, { pendingPairings: cfg.pendingPairings.filter(p => p.chatId !== chatId && p.expiresAt > now) });
  rejectedAt.set(`${channelId}:${chatId}`, now);
  return had;
}

/** Remove a chat from the owner's paired chats. */
export function unpairChat(chatId: string): boolean {
  const owner = loadAgentConfig().owner;
  if (!owner.telegramChatIds.includes(chatId)) return false;
  patchAgentConfig({ owner: { telegramChatIds: owner.telegramChatIds.filter(id => id !== chatId) } });
  return true;
}

/** Tests only. */
export function _resetPairingCooldowns(): void {
  rejectedAt.clear();
}
