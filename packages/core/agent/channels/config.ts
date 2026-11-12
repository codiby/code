/**
 * Channel configuration — `~/.codiby/agent/channels.json` (0600).
 *
 * Only non-secret settings live here. Bot tokens, inbound webhook tokens and
 * callback signing keys go to the vault under `channel:<id>:<kind>`, so this
 * file can be read, diffed or backed up without leaking credentials.
 *
 * First boot migrates the pre-agent setup (`personal-agent.json`,
 * `ui-telegram.json`, `TELEGRAM_BOT_TOKEN`) without deleting those files.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { CODIBY_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../../config/config';
import { log, logError } from '../../lib/logger';
import { loadTelegramSettings } from '../../session/storage';
import { loadAgentConfig, patchAgentConfig } from '../config';
import { agentDataDir, createJsonStore, readJson } from '../store';
import { deleteSecret, getSecret, hasSecret, listSecrets, setSecret } from '../vault';
import { lidMapEntry } from './whatsapp/payload';

export type ChannelKind = 'telegram' | 'whatsapp' | 'http_webhook' | 'ios_shortcut';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['telegram', 'whatsapp', 'http_webhook', 'ios_shortcut'];

interface BaseChannelConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** Tell the owner (low priority) when someone else writes on this channel. */
  notifyOnOthers: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramPairing {
  chatId: string;
  /** Chat title or the person's name, as Telegram reports it. */
  title: string;
  username: string | null;
  /** Shown to the person in Telegram and in the Channels UI, so the owner approves the right chat. */
  code: string;
  requestedAt: number;
  expiresAt: number;
}

export interface TelegramChannelConfig extends BaseChannelConfig {
  type: 'telegram';
  pendingPairings: TelegramPairing[];
}

export type WhatsAppMarkRead = 'owner' | 'all' | 'off';

export interface WhatsAppChannelConfig extends BaseChannelConfig {
  type: 'whatsapp';
  /** wacli binary (absolute path or a name on PATH). */
  binary: string;
  /** wacli account (`-a`); '' = wacli's default account. */
  account: string;
  /**
   * Base URL the wacli backend POSTs webhooks to. '' = http://127.0.0.1:<bridge port>;
   * set it when the backend runs elsewhere (a container, another host).
   */
  inboundBaseUrl: string;
  /** Keep direct messages from other people in the untrusted inbox. */
  storeDirect: boolean;
  /** Keep group messages in the untrusted inbox (off: groups are noisy). */
  storeGroups: boolean;
  /** `<lid>@lid` → `<phone>@s.whatsapp.net`, for chats wacli reports by LID. */
  lidMap: Record<string, string>;
  /** Read receipts: only the owner's messages (default), everyone's, or none. */
  markRead: WhatsAppMarkRead;
  /** Fetch images, voice notes and documents from the wacli backend. */
  downloadMedia: boolean;
  /** wacli config holding the backend URL + token used for media ('' = wacli's default). */
  wacliConfigPath: string;
}

export type WebhookReplyMode = 'native' | 'callback' | 'none';

export interface WebhookChannelConfig extends BaseChannelConfig {
  type: 'http_webhook' | 'ios_shortcut';
  /** native = hold the HTTP request open for the reply; callback = POST replies to callbackUrl. */
  reply: WebhookReplyMode;
  /** Also used for late native replies and proactive messages when set. */
  callbackUrl: string;
  replyTimeoutSec: number;
}

export type ChannelConfig = TelegramChannelConfig | WhatsAppChannelConfig | WebhookChannelConfig;

export interface ChannelAlerts {
  /** "<session> finished" messages for coding sessions (not the agent). */
  sessionFinished: boolean;
}

export interface ChannelsFile {
  version: 1;
  channels: ChannelConfig[];
  alerts: ChannelAlerts;
  migratedAt: number | null;
}

const FILE = agentDataDir('channels.json');
export const MAX_REPLY_TIMEOUT_SEC = 120;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/i;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function defaultWacliBinary(): string {
  const local = join(homedir(), '.local', 'bin', 'wacli');
  return existsSync(local) ? local : 'wacli';
}

export function defaultChannelName(type: ChannelKind): string {
  switch (type) {
    case 'telegram': return 'Telegram';
    case 'whatsapp': return 'WhatsApp';
    case 'http_webhook': return 'Webhook';
    case 'ios_shortcut': return 'iOS Shortcut';
  }
}

function normalizePairing(raw: unknown): TelegramPairing | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!r) return null;
  const chatId = str(r.chatId).trim();
  const code = str(r.code).trim();
  if (!/^-?\d{1,20}$/.test(chatId) || !/^\d{6}$/.test(code)) return null;
  return {
    chatId,
    title: str(r.title).slice(0, 200),
    username: typeof r.username === 'string' && r.username ? r.username.slice(0, 64) : null,
    code,
    requestedAt: num(r.requestedAt, 0),
    expiresAt: num(r.expiresAt, 0),
  };
}

/** `<lid>@lid` → `<digits>@s.whatsapp.net` entries only (see whatsapp/payload.ts lidMapEntry). */
function normalizeLidMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || k.length > 100 || v.length > 100) continue;
    const entry = lidMapEntry(k, v);
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

export function normalizeChannel(raw: unknown, now = Date.now()): ChannelConfig | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!r) return null;
  const type = r.type as ChannelKind;
  if (!CHANNEL_KINDS.includes(type)) return null;
  const id = str(r.id).trim();
  if (!ID_RE.test(id)) return null;
  const base: BaseChannelConfig = {
    id,
    name: str(r.name).trim().slice(0, 80) || defaultChannelName(type),
    enabled: bool(r.enabled, true),
    notifyOnOthers: bool(r.notifyOnOthers, false),
    createdAt: num(r.createdAt, now),
    updatedAt: num(r.updatedAt, now),
  };
  if (type === 'telegram') {
    const pairings = Array.isArray(r.pendingPairings) ? r.pendingPairings.map(normalizePairing).filter((p): p is TelegramPairing => !!p) : [];
    return { ...base, type, pendingPairings: pairings.slice(-20) };
  }
  if (type === 'whatsapp') {
    const markRead = r.markRead === 'all' || r.markRead === 'off' ? r.markRead : 'owner';
    return {
      ...base,
      type,
      binary: str(r.binary).trim() || defaultWacliBinary(),
      account: str(r.account).trim(),
      inboundBaseUrl: str(r.inboundBaseUrl).trim().replace(/\/+$/, ''),
      storeDirect: bool(r.storeDirect, true),
      storeGroups: bool(r.storeGroups, false),
      lidMap: normalizeLidMap(r.lidMap),
      markRead,
      downloadMedia: bool(r.downloadMedia, true),
      wacliConfigPath: str(r.wacliConfigPath).trim(),
    };
  }
  const reply: WebhookReplyMode = r.reply === 'callback' || r.reply === 'none' ? r.reply : 'native';
  return {
    ...base,
    type,
    reply,
    callbackUrl: str(r.callbackUrl).trim(),
    replyTimeoutSec: Math.min(MAX_REPLY_TIMEOUT_SEC, Math.max(5, Math.round(num(r.replyTimeoutSec, MAX_REPLY_TIMEOUT_SEC)))),
  };
}

export function normalizeChannelsFile(raw: unknown): ChannelsFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const channels: ChannelConfig[] = [];
  for (const item of Array.isArray(r.channels) ? r.channels : []) {
    const ch = normalizeChannel(item);
    if (!ch || seen.has(ch.id)) continue;
    seen.add(ch.id);
    channels.push(ch);
  }
  const alerts = (r.alerts ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    channels,
    alerts: { sessionFinished: bool(alerts.sessionFinished, true) },
    migratedAt: typeof r.migratedAt === 'number' ? r.migratedAt : null,
  };
}

const store = createJsonStore<ChannelsFile>({ file: FILE, normalize: normalizeChannelsFile, mode: 0o600 });

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export type ChannelSecretKind = 'token' | 'signing';

export function secretName(channelId: string, kind: ChannelSecretKind): string {
  return `channel:${channelId}:${kind}`;
}

/** Server-side only: never return this to a model, a log or a listing. */
export function getChannelSecret(channelId: string, kind: ChannelSecretKind): string | null {
  return getSecret(secretName(channelId, kind));
}

export function setChannelSecret(channelId: string, kind: ChannelSecretKind, value: string): void {
  setSecret(secretName(channelId, kind), value);
}

export function hasChannelSecret(channelId: string, kind: ChannelSecretKind): boolean {
  return hasSecret(secretName(channelId, kind));
}

export function deleteSecretForChannel(channelId: string, kind: ChannelSecretKind): boolean {
  return deleteSecret(secretName(channelId, kind));
}

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

/** Make sure a channel has the secrets its type needs (inbound token, signing key). */
export function ensureChannelSecrets(ch: ChannelConfig): void {
  if (ch.type === 'telegram') return;
  if (!hasChannelSecret(ch.id, 'token')) setChannelSecret(ch.id, 'token', generateToken(ch.type === 'whatsapp' ? 'cwa' : 'cwh'));
  if ((ch.type === 'http_webhook' || ch.type === 'ios_shortcut') && !hasChannelSecret(ch.id, 'signing')) {
    setChannelSecret(ch.id, 'signing', generateToken('cws'));
  }
}

function deleteChannelSecrets(channelId: string): void {
  for (const s of listSecrets(`channel:${channelId}:`)) deleteSecret(s.name);
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

interface LegacyChannel {
  id?: string;
  type?: string;
  name?: string;
  enabled?: boolean;
  inbound?: { botToken?: string; chatId?: string; webhookId?: string; signingSecret?: string };
  outbound?: { strategy?: string; callback?: { url?: string }; cli?: { command?: string } };
}

/** `wa text 5216… {{text}}` → `5216…`: the old way of answering on WhatsApp. */
export function legacyWhatsAppNumber(command: string | undefined): string | null {
  const m = /^\s*(?:\S*\/)?(?:wa|wacli)\s+(?:-a\s+\S+\s+)?text\s+\+?(\d{8,15})\b/.exec(command ?? '');
  return m ? m[1]! : null;
}

function legacyId(raw: string | undefined, fallbackPrefix: string): string {
  return raw && ID_RE.test(raw) ? raw : `${fallbackPrefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Build channels from the pre-agent setup. Secrets go straight to the vault;
 * owner ids found along the way are merged into the agent config.
 */
export function migrateLegacyChannels(now = Date.now()): ChannelConfig[] {
  const out: ChannelConfig[] = [];
  const legacy = readJson<{ channels?: LegacyChannel[] } | null>(join(CODIBY_DIR, 'personal-agent.json'), null);
  const legacyChannels = Array.isArray(legacy?.channels) ? legacy!.channels : [];
  const ownerChats = new Set<string>();
  const ownerJids = new Set<string>();

  let tgToken = '';
  let tgId: string | null = null;
  let tgEnabled = true;
  const tgLegacy = legacyChannels.find(c => c?.type === 'telegram');
  if (tgLegacy?.inbound?.botToken) {
    tgToken = tgLegacy.inbound.botToken.trim();
    tgId = legacyId(tgLegacy.id, 'telegram');
    tgEnabled = tgLegacy.enabled !== false;
    if (tgLegacy.inbound.chatId?.trim()) ownerChats.add(tgLegacy.inbound.chatId.trim());
  }
  try {
    const settings = loadTelegramSettings();
    if (!tgToken && settings.botToken) tgToken = settings.botToken.trim();
    if (settings.chatId) ownerChats.add(settings.chatId.trim());
  } catch {}
  if (!tgToken && TELEGRAM_BOT_TOKEN) tgToken = TELEGRAM_BOT_TOKEN.trim();
  if (TELEGRAM_CHAT_ID) ownerChats.add(TELEGRAM_CHAT_ID.trim());

  if (tgToken) {
    const id = tgId ?? `telegram-${randomUUID().slice(0, 8)}`;
    setChannelSecret(id, 'token', tgToken);
    out.push({ id, type: 'telegram', name: tgLegacy?.name?.trim() || 'Telegram', enabled: tgEnabled, notifyOnOthers: false, pendingPairings: [], createdAt: now, updatedAt: now });
  }

  for (const c of legacyChannels) {
    if (c?.type !== 'http_webhook' && c?.type !== 'ios_shortcut') continue;
    const number = c.outbound?.strategy === 'cli_command' ? legacyWhatsAppNumber(c.outbound.cli?.command) : null;
    if (number) {
      // The old wacli setup was a webhook + a `wa text` reply command. It
      // becomes a real WhatsApp channel, off until the owner registers its
      // webhook (the old URL no longer exists).
      ownerJids.add(`${number}@s.whatsapp.net`);
      const id = legacyId(c.id, 'whatsapp');
      out.push(normalizeChannel({ id, type: 'whatsapp', name: 'WhatsApp', enabled: false, createdAt: now, updatedAt: now }, now)!);
      continue;
    }
    const id = legacyId(c.inbound?.webhookId, c.type === 'ios_shortcut' ? 'shortcut' : 'webhook');
    const strategy = c.outbound?.strategy;
    const reply: WebhookReplyMode = strategy === 'callback_url' ? 'callback' : strategy === 'native_reply' ? 'native' : c.type === 'ios_shortcut' ? 'native' : 'none';
    if (strategy === 'cli_command') log(`[channels] Legacy channel "${c.name}" used a shell command for replies; that is not migrated (replies are off)`);
    const ch = normalizeChannel({
      id,
      type: c.type,
      name: c.name,
      enabled: c.enabled !== false,
      reply,
      callbackUrl: c.outbound?.callback?.url ?? '',
      createdAt: now,
      updatedAt: now,
    }, now)!;
    // Keep the old secret so existing callers keep authenticating.
    if (c.inbound?.signingSecret) setChannelSecret(id, 'token', c.inbound.signingSecret);
    out.push(ch);
  }

  for (const ch of out) ensureChannelSecrets(ch);

  const owner = loadAgentConfig().owner;
  const chats = [...new Set([...owner.telegramChatIds, ...ownerChats])];
  const jids = owner.whatsappJids.length ? owner.whatsappJids : [...ownerJids];
  if (chats.length !== owner.telegramChatIds.length || jids.length !== owner.whatsappJids.length) {
    patchAgentConfig({ owner: { telegramChatIds: chats, whatsappJids: jids } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The channels file, migrating the legacy setup the first time it is read. */
export function loadChannelsFile(): ChannelsFile {
  if (!existsSync(FILE)) {
    let migrated: ChannelConfig[] = [];
    try {
      migrated = migrateLegacyChannels();
      if (migrated.length) log(`[channels] Migrated ${migrated.length} channel(s) from the legacy setup`);
    } catch (err) {
      logError(`[channels] Legacy migration failed: ${err instanceof Error ? err.message : err}`);
    }
    store.set({ version: 1, channels: migrated, alerts: { sessionFinished: true }, migratedAt: Date.now() });
  }
  return store.get();
}

export function listChannelConfigs(): ChannelConfig[] {
  return loadChannelsFile().channels;
}

export function getChannelConfig(id: string): ChannelConfig | null {
  return listChannelConfigs().find(c => c.id === id) ?? null;
}

export function newChannelId(type: ChannelKind): string {
  const prefix = type === 'http_webhook' ? 'webhook' : type === 'ios_shortcut' ? 'shortcut' : type;
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function addChannelConfig(input: Record<string, unknown> & { type: ChannelKind }): ChannelConfig {
  const now = Date.now();
  const ch = normalizeChannel({ ...input, id: newChannelId(input.type), createdAt: now, updatedAt: now }, now);
  if (!ch) throw new Error('Invalid channel');
  ensureChannelSecrets(ch);
  store.update(f => ({ ...f, channels: [...f.channels, ch] }));
  return ch;
}

/** Shallow patch; `type`, `id` and `createdAt` never change. */
export function updateChannelConfig(id: string, patch: Record<string, unknown>): ChannelConfig {
  const current = getChannelConfig(id);
  if (!current) throw new Error(`Unknown channel ${id}`);
  const next = normalizeChannel({ ...current, ...patch, id: current.id, type: current.type, createdAt: current.createdAt, updatedAt: Date.now() });
  if (!next) throw new Error('Invalid channel settings');
  store.update(f => ({ ...f, channels: f.channels.map(c => (c.id === id ? next : c)) }));
  return next;
}

export function removeChannelConfig(id: string): boolean {
  const current = getChannelConfig(id);
  if (!current) return false;
  store.update(f => ({ ...f, channels: f.channels.filter(c => c.id !== id) }));
  deleteChannelSecrets(id);
  return true;
}

export function getChannelAlerts(): ChannelAlerts {
  return loadChannelsFile().alerts;
}

export function setChannelAlerts(patch: Partial<ChannelAlerts>): ChannelAlerts {
  return store.update(f => ({ ...f, alerts: { ...f.alerts, ...patch } })).alerts;
}

/** Tests only: forget the cache (and optionally the file's contents). */
export function _reloadChannelsFile(): ChannelsFile {
  return store.reload();
}
