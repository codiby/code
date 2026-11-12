/**
 * Client for the agent's channels (packages/core/agent/channels): Telegram,
 * WhatsApp (wacli), HTTP webhook and iOS Shortcut. Bot tokens are
 * write-only; webhook tokens come back only from an explicit reveal/rotate.
 */

import type { AgentApi } from './api';

export type ChannelKind = 'telegram' | 'whatsapp' | 'http_webhook' | 'ios_shortcut';
export type WebhookReplyMode = 'native' | 'callback' | 'none';
export type WhatsAppMarkRead = 'owner' | 'all' | 'off';

export interface ChannelStatus {
  connected: boolean;
  detail?: string;
  lastError?: string | null;
}

export interface TelegramPairing {
  chatId: string;
  title: string;
  username: string | null;
  code: string;
  requestedAt: number;
  expiresAt: number;
}

interface ChannelBase {
  id: string;
  type: ChannelKind;
  name: string;
  enabled: boolean;
  notifyOnOthers: boolean;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  status: ChannelStatus;
  ownerPaired: boolean;
}

export interface TelegramView extends ChannelBase {
  type: 'telegram';
  telegram: {
    hasToken: boolean;
    botUsername: string | null;
    pairedChats: string[];
    pendingPairings: TelegramPairing[];
  };
}

export interface WhatsAppView extends ChannelBase {
  type: 'whatsapp';
  whatsapp: {
    binary: string;
    account: string;
    inboundBaseUrl: string;
    inboundUrl: string;
    storeDirect: boolean;
    storeGroups: boolean;
    markRead: WhatsAppMarkRead;
    downloadMedia: boolean;
    wacliConfigPath: string;
    lidMap: Record<string, string>;
    ownerJids: string[];
    hasToken: boolean;
  };
}

export interface WebhookView extends ChannelBase {
  type: 'http_webhook' | 'ios_shortcut';
  webhook: {
    reply: WebhookReplyMode;
    callbackUrl: string;
    replyTimeoutSec: number;
    inboundPath: string;
    hasToken: boolean;
    hasSigningSecret: boolean;
  };
}

export type ChannelView = TelegramView | WhatsAppView | WebhookView;

export interface ChannelsOverview {
  agentEnabled: boolean;
  running: boolean;
  preferredChannel: string | null;
  alerts: { sessionFinished: boolean };
  /** Addresses this host is likely reachable at, for webhook URLs. */
  baseUrls: string[];
  channels: ChannelView[];
}

export type ChannelPatch = Partial<{
  name: string;
  enabled: boolean;
  notifyOnOthers: boolean;
  botToken: string;
  binary: string;
  account: string;
  inboundBaseUrl: string;
  storeDirect: boolean;
  storeGroups: boolean;
  markRead: WhatsAppMarkRead;
  downloadMedia: boolean;
  wacliConfigPath: string;
  /** "lid=phone" lines. */
  lidMap: string;
  reply: WebhookReplyMode;
  callbackUrl: string;
  replyTimeoutSec: number;
}>;

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  http_webhook: 'Webhook',
  ios_shortcut: 'iOS Shortcut',
};

const path = (id: string, rest = '') => `/agent/channels/${encodeURIComponent(id)}${rest}`;

export const channelsApi = {
  overview: (api: AgentApi) => api.get<ChannelsOverview>('/agent/channels'),
  create: (api: AgentApi, type: ChannelKind, patch: ChannelPatch = {}) =>
    api.send<ChannelView>('POST', '/agent/channels', { type, ...patch }),
  update: (api: AgentApi, id: string, patch: ChannelPatch) => api.send<ChannelView>('PATCH', path(id), patch),
  remove: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', path(id)),
  restart: (api: AgentApi, id: string) => api.send<ChannelView>('POST', path(id, '/restart')),
  test: (api: AgentApi, id: string, text?: string) => api.send<{ ok: boolean; error?: string }>('POST', path(id, '/test'), text ? { text } : {}),
  answerPairing: (api: AgentApi, id: string, chatId: string, approve: boolean) =>
    api.send<{ ok: true }>('POST', path(id, `/pairings/${encodeURIComponent(chatId)}`), { approve }),
  unpair: (api: AgentApi, id: string, chatId: string) => api.send<{ ok: boolean }>('POST', path(id, '/unpair'), { chatId }),
  secret: (api: AgentApi, id: string, action: 'reveal' | 'rotate', kind: 'token' | 'signing' = 'token') =>
    api.send<{ secret: string; webhook?: { ok: boolean; error?: string } }>('POST', path(id, '/secret'), { action, kind }),
  registerWebhook: (api: AgentApi, id: string) =>
    api.send<{ ok: true; action: 'unchanged' | 'added' | 'updated'; url: string }>('POST', path(id, '/webhook/register')),
  whatsappStatus: (api: AgentApi, id: string) =>
    api.get<{ state: string | null; user: string | null; connected: boolean; error: string | null }>(path(id, '/whatsapp/status')),
  setAlerts: (api: AgentApi, alerts: { sessionFinished: boolean }) =>
    api.send<{ alerts: { sessionFinished: boolean } }>('PUT', '/agent/channels/alerts', alerts),
};

/** "lid@lid=phone@s.whatsapp.net" lines for the LID map editor. */
export function lidMapToText(map: Record<string, string>): string {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** Owner numbers as typed (one per line or comma-separated) → JIDs. */
export function parseOwnerNumbers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const s = raw.trim().toLowerCase();
    if (!s) continue;
    if (s.includes('@')) out.push(s);
    else {
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 8) out.push(`${digits}@s.whatsapp.net`);
    }
  }
  return [...new Set(out)];
}

export function curlExample(url: string, token: string, textFormat = false): string {
  const q = textFormat ? '?format=text' : '';
  return [
    `curl -X POST '${url}${q}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'X-Codiby-Token: ${token}' \\`,
    `  -d '{"text": "What is on my calendar today?", "sender": "curl"}'`,
  ].join('\n');
}
