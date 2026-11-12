/**
 * /agent/channels routes. Everything is behind the bridge's auth except the
 * two webhook endpoints, which authenticate with the channel's own token
 * (constant-time compare) and are throttled after repeated failures.
 *
 * Routes that create an owner (pairing, channels whose token is the owner)
 * or expose a secret are marked `sensitive` explicitly — not left to the
 * mutation default — so a localhost caller such as the agent's own Bash can
 * never pair itself, reveal a token or redirect replies.
 *
 * Secrets never appear in listings: a Telegram bot token is write-only, and
 * a webhook token is only returned by an explicit reveal / rotate call.
 */

import { getLanIp, PORT, resolveTls } from '../../config/config';
import { logError } from '../../lib/logger';
import { loadAgentConfig, patchAgentConfig } from '../config';
import { HttpError, errorJson, json, readBody, safeEqual } from '../http';
import { sendToOwner } from '../outbox';
import { registerRoutes } from '../registry';
import { agentDeps, hasAgentDeps } from '../runtime';
import {
  addChannelConfig,
  CHANNEL_KINDS,
  ensureChannelSecrets,
  generateToken,
  getChannelAlerts,
  getChannelConfig,
  getChannelSecret,
  hasChannelSecret,
  listChannelConfigs,
  MAX_REPLY_TIMEOUT_SEC,
  removeChannelConfig,
  setChannelAlerts,
  setChannelSecret,
  updateChannelConfig,
  type ChannelConfig,
  type ChannelKind,
  type ChannelSecretKind,
} from './config';
import { channelsActive, channelStartError, restartChannel, runningChannel, whatsappChannelFor } from './manager';
import { approvePairing, livePairings, rejectPairing, unpairChat } from './telegram/pairing';
import { TelegramChannel } from './telegram/adapter';
import { WhatsAppChannel } from './whatsapp/adapter';
import { parseLidMap, parseWacliPayload } from './whatsapp/payload';
import { WebhookChannel, WebhookRequestError, checkCallbackUrl, presentedTokens } from './webhook/adapter';

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function optString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`);
  if (v.length > max) throw new HttpError(400, `"${key}" is too long`);
  if (v.includes('\0')) throw new HttpError(400, `"${key}" is invalid`);
  return v.trim();
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`);
  return v;
}

function optUrl(body: Record<string, unknown>, key: string): string | undefined {
  const v = optString(body, key, 2000);
  if (v === undefined || v === '') return v;
  let u: URL;
  try { u = new URL(v); } catch { throw new HttpError(400, `"${key}" must be a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, `"${key}" must be an http(s) URL`);
  return v.replace(/\/+$/, '');
}

const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

/** Settings a caller may change, per channel type. Unknown keys are ignored. */
function channelPatch(type: ChannelKind, body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) patch[k] = v; };
  put('name', optString(body, 'name', 80));
  put('enabled', optBool(body, 'enabled'));
  put('notifyOnOthers', optBool(body, 'notifyOnOthers'));
  if (type === 'whatsapp') {
    const binary = optString(body, 'binary', 300);
    if (binary !== undefined && binary !== '' && !binary.startsWith('/') && !/^[\w.-]+$/.test(binary)) {
      throw new HttpError(400, '"binary" must be an absolute path or a command name');
    }
    put('binary', binary);
    const account = optString(body, 'account', 64);
    if (account && !/^[\w.-]+$/.test(account)) throw new HttpError(400, '"account" may only contain letters, digits, . _ -');
    put('account', account);
    put('inboundBaseUrl', optUrl(body, 'inboundBaseUrl'));
    put('storeDirect', optBool(body, 'storeDirect'));
    put('storeGroups', optBool(body, 'storeGroups'));
    put('downloadMedia', optBool(body, 'downloadMedia'));
    const markRead = body.markRead;
    if (markRead !== undefined) {
      if (markRead !== 'owner' && markRead !== 'all' && markRead !== 'off') throw new HttpError(400, '"markRead" must be owner, all or off');
      patch.markRead = markRead;
    }
    const wacliConfigPath = optString(body, 'wacliConfigPath', 500);
    if (wacliConfigPath && !wacliConfigPath.startsWith('/')) throw new HttpError(400, '"wacliConfigPath" must be an absolute path');
    put('wacliConfigPath', wacliConfigPath);
    if (body.lidMap !== undefined) {
      if (typeof body.lidMap === 'string') patch.lidMap = parseLidMap(body.lidMap);
      else if (body.lidMap && typeof body.lidMap === 'object' && !Array.isArray(body.lidMap)) patch.lidMap = body.lidMap;
      else throw new HttpError(400, '"lidMap" must be "lid=phone" lines or an object');
    }
  }
  if (type === 'http_webhook' || type === 'ios_shortcut') {
    const reply = body.reply;
    if (reply !== undefined) {
      if (reply !== 'native' && reply !== 'callback' && reply !== 'none') throw new HttpError(400, '"reply" must be native, callback or none');
      patch.reply = reply;
    }
    const callbackUrl = optUrl(body, 'callbackUrl');
    if (callbackUrl) {
      try { checkCallbackUrl(callbackUrl); } catch (err) { throw new HttpError(400, `"callbackUrl": ${err instanceof Error ? err.message : err}`); }
    }
    put('callbackUrl', callbackUrl);
    const timeout = body.replyTimeoutSec;
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 5 || timeout > MAX_REPLY_TIMEOUT_SEC) {
        throw new HttpError(400, `"replyTimeoutSec" must be between 5 and ${MAX_REPLY_TIMEOUT_SEC}`);
      }
      patch.replyTimeoutSec = timeout;
    }
  }
  return patch;
}

function telegramToken(body: Record<string, unknown>): string | undefined {
  const token = optString(body, 'botToken', 200);
  if (!token) return undefined;
  if (!TELEGRAM_TOKEN_RE.test(token)) throw new HttpError(400, 'That does not look like a bot token from @BotFather (123456:ABC…)');
  return token;
}

function requireChannel(id: string): ChannelConfig {
  const cfg = getChannelConfig(id);
  if (!cfg) throw new HttpError(404, 'Unknown channel');
  return cfg;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function bridgePort(): number {
  return hasAgentDeps() ? agentDeps().port : PORT;
}

export function inboundPath(id: string): string {
  return `/agent/channels/${encodeURIComponent(id)}/inbound`;
}

function suggestedBaseUrls(): string[] {
  const scheme = resolveTls() ? 'https' : 'http';
  const port = bridgePort();
  const out = [`${scheme}://${getLanIp()}:${port}`, `http://127.0.0.1:${port}`];
  return [...new Set(out)];
}

export function channelView(cfg: ChannelConfig) {
  const adapter = runningChannel(cfg.id);
  const status = adapter
    ? adapter.status()
    : {
        connected: false,
        detail: !cfg.enabled ? 'Disabled' : channelsActive() ? 'Not running' : 'The agent is off on this host',
        lastError: channelStartError(cfg.id),
      };
  const owner = loadAgentConfig().owner;
  const base = {
    id: cfg.id,
    type: cfg.type,
    name: cfg.name,
    enabled: cfg.enabled,
    notifyOnOthers: cfg.notifyOnOthers,
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
    running: !!adapter,
    status,
    ownerPaired: adapter ? !!adapter.ownerAddress() : false,
  };
  if (cfg.type === 'telegram') {
    return {
      ...base,
      telegram: {
        hasToken: hasChannelSecret(cfg.id, 'token'),
        botUsername: adapter instanceof TelegramChannel ? adapter.botUsername : null,
        pairedChats: owner.telegramChatIds,
        pendingPairings: livePairings(cfg),
      },
    };
  }
  if (cfg.type === 'whatsapp') {
    const wa = adapter instanceof WhatsAppChannel ? adapter : whatsappChannelFor(cfg);
    return {
      ...base,
      whatsapp: {
        binary: cfg.binary,
        account: cfg.account,
        inboundBaseUrl: cfg.inboundBaseUrl,
        inboundUrl: wa.inboundUrl(),
        storeDirect: cfg.storeDirect,
        storeGroups: cfg.storeGroups,
        markRead: cfg.markRead,
        downloadMedia: cfg.downloadMedia,
        wacliConfigPath: cfg.wacliConfigPath,
        lidMap: cfg.lidMap,
        ownerJids: owner.whatsappJids,
        hasToken: hasChannelSecret(cfg.id, 'token'),
      },
    };
  }
  return {
    ...base,
    webhook: {
      reply: cfg.reply,
      callbackUrl: cfg.callbackUrl,
      replyTimeoutSec: cfg.replyTimeoutSec,
      inboundPath: inboundPath(cfg.id),
      hasToken: hasChannelSecret(cfg.id, 'token'),
      hasSigningSecret: hasChannelSecret(cfg.id, 'signing'),
    },
  };
}

// ---------------------------------------------------------------------------
// Public inbound: auth + throttling
// ---------------------------------------------------------------------------

const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 30;
const failures = new Map<string, { count: number; since: number }>();

function throttled(id: string, now = Date.now()): boolean {
  const f = failures.get(id);
  if (!f || now - f.since > FAILURE_WINDOW_MS) return false;
  return f.count >= MAX_FAILURES;
}

function recordFailure(id: string, now = Date.now()): void {
  const f = failures.get(id);
  if (!f || now - f.since > FAILURE_WINDOW_MS) failures.set(id, { count: 1, since: now });
  else f.count++;
}

/** Check a request against the channel's token from the vault (works while the channel is stopped). */
export function authenticateInbound(cfg: ChannelConfig, req: Request): boolean {
  const secret = getChannelSecret(cfg.id, 'token');
  if (!secret) return false;
  if (cfg.type === 'whatsapp') return safeEqual(req.headers.get('x-codiby-token') ?? '', secret);
  return presentedTokens(req).some(t => safeEqual(t, secret));
}

const unauthorized = () => errorJson('Unauthorized', 401);

async function handleInbound(req: Request, params: Record<string, string>, url: URL): Promise<Response> {
  const cfg = getChannelConfig(params.id!);
  if (!cfg || cfg.type === 'telegram') return errorJson('Not found', 404);
  if (throttled(cfg.id)) return errorJson('Too many failed attempts — try again later', 429);
  if (!authenticateInbound(cfg, req)) {
    recordFailure(cfg.id);
    return unauthorized();
  }
  const adapter = runningChannel(cfg.id);
  if (!adapter) return errorJson('This channel is not running (disabled, or the agent is off on this host)', 503);

  if (adapter instanceof WhatsAppChannel) {
    const raw = await readBody<unknown>(req);
    const parsed = parseWacliPayload(raw, cfg.type === 'whatsapp' ? cfg.lidMap : {});
    if (parsed?.test) return json({ ok: true, test: true });
    // Answer wacli right away: transcription and media can outlast its webhook timeout.
    void adapter.handlePayload(raw).catch(err => logError(`[whatsapp] ${adapter.name}: inbound failed: ${err instanceof Error ? err.stack || err.message : err}`));
    return json({ ok: true, accepted: true });
  }
  if (adapter instanceof WebhookChannel) {
    try {
      return await adapter.handleRequest(req, url);
    } catch (err) {
      if (err instanceof WebhookRequestError) return errorJson(err.message, err.status);
      throw err;
    }
  }
  return errorJson('Not found', 404);
}

function handleLateReply(req: Request, params: Record<string, string>): Response {
  const cfg = getChannelConfig(params.id!);
  if (!cfg || (cfg.type !== 'http_webhook' && cfg.type !== 'ios_shortcut')) return errorJson('Not found', 404);
  if (throttled(cfg.id)) return errorJson('Too many failed attempts — try again later', 429);
  if (!authenticateInbound(cfg, req)) {
    recordFailure(cfg.id);
    return unauthorized();
  }
  const adapter = runningChannel(cfg.id);
  const late = adapter instanceof WebhookChannel ? adapter.lateReply(params.requestId!) : null;
  if (!late) return errorJson('Unknown or expired request', 404);
  return json({ ok: true, ready: late.ready, reply: late.ready ? late.reply : null }, late.ready ? 200 : 202);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function afterChange(id: string) {
  await restartChannel(id);
  const cfg = getChannelConfig(id);
  return cfg ? channelView(cfg) : null;
}

export function registerChannelRoutes(): void {
  registerRoutes([
    {
      method: 'GET',
      path: '/agent/channels',
      handler: () => {
        const cfg = loadAgentConfig();
        return json({
          agentEnabled: cfg.enabled,
          running: channelsActive(),
          preferredChannel: cfg.preferredChannel,
          alerts: getChannelAlerts(),
          baseUrls: suggestedBaseUrls(),
          channels: listChannelConfigs().map(channelView),
        });
      },
    },
    {
      method: 'POST',
      path: '/agent/channels',
      // Can add a webhook whose token is then the owner, or a bot that takes orders.
      sensitive: true,
      handler: async (req) => {
        const body = await readBody(req);
        const type = body.type as ChannelKind;
        if (!CHANNEL_KINDS.includes(type)) throw new HttpError(400, `"type" must be one of ${CHANNEL_KINDS.join(', ')}`);
        const token = type === 'telegram' ? telegramToken(body) : undefined;
        if (type === 'telegram' && !token) throw new HttpError(400, 'A bot token from @BotFather is required');
        const cfg = addChannelConfig({ ...channelPatch(type, body), type });
        if (token) setChannelSecret(cfg.id, 'token', token);
        return json(await afterChange(cfg.id), 201);
      },
    },
    {
      method: 'PUT',
      path: '/agent/channels/alerts',
      handler: async (req) => {
        const body = await readBody(req);
        return json({ alerts: setChannelAlerts({ ...(optBool(body, 'sessionFinished') !== undefined ? { sessionFinished: body.sessionFinished as boolean } : {}) }) });
      },
    },
    {
      method: 'PATCH',
      path: '/agent/channels/:id',
      // Swaps bot tokens and callback URLs (where replies, approvals included, are sent).
      sensitive: true,
      handler: async (req, params) => {
        const cfg = requireChannel(params.id!);
        const body = await readBody(req);
        if (cfg.type === 'telegram') {
          const token = telegramToken(body);
          if (token) setChannelSecret(cfg.id, 'token', token);
        }
        updateChannelConfig(cfg.id, channelPatch(cfg.type, body));
        return json(await afterChange(cfg.id));
      },
    },
    {
      method: 'DELETE',
      path: '/agent/channels/:id',
      sensitive: true,
      handler: async (_req, params) => {
        const cfg = requireChannel(params.id!);
        updateChannelConfig(cfg.id, { enabled: false });
        await restartChannel(cfg.id);
        removeChannelConfig(cfg.id);
        if (loadAgentConfig().preferredChannel === cfg.id) patchAgentConfig({ preferredChannel: null });
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/restart',
      handler: async (_req, params) => {
        const cfg = requireChannel(params.id!);
        return json(await afterChange(cfg.id));
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/test',
      handler: async (req, params) => {
        const cfg = requireChannel(params.id!);
        const body = await readBody(req);
        const custom = optString(body, 'text', 2000);
        if (!runningChannel(cfg.id)) throw new HttpError(409, 'This channel is not running');
        const persona = loadAgentConfig().persona;
        const res = await sendToOwner({ kind: 'text', text: custom || `👋 Test message from ${persona.name} on ${cfg.name}.`, priority: 'normal' }, { channelId: cfg.id });
        return json({ ok: res.ok, ...(res.error ? { error: res.error } : {}) }, res.ok ? 200 : 502);
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/pairings/:chatId',
      // Approving a pairing makes a chat the owner.
      sensitive: true,
      handler: async (req, params) => {
        const cfg = requireChannel(params.id!);
        if (cfg.type !== 'telegram') throw new HttpError(400, 'Only Telegram channels pair chats');
        const body = await readBody(req);
        const approve = optBool(body, 'approve');
        if (approve === undefined) throw new HttpError(400, '"approve" is required');
        const chatId = params.chatId!;
        if (!/^-?\d{1,20}$/.test(chatId)) throw new HttpError(400, 'Invalid chat id');
        if (!approve) {
          rejectPairing(cfg.id, chatId);
          return json({ ok: true });
        }
        try {
          approvePairing(cfg.id, chatId);
        } catch (err) {
          throw new HttpError(404, err instanceof Error ? err.message : 'Pairing not found');
        }
        const adapter = runningChannel(cfg.id);
        if (adapter instanceof TelegramChannel) await adapter.announcePaired(chatId);
        return json({ ok: true, channel: channelView(getChannelConfig(cfg.id)!) });
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/unpair',
      sensitive: true,
      handler: async (req, params) => {
        const cfg = requireChannel(params.id!);
        if (cfg.type !== 'telegram') throw new HttpError(400, 'Only Telegram channels pair chats');
        const body = await readBody(req);
        const chatId = optString(body, 'chatId', 30);
        if (!chatId) throw new HttpError(400, '"chatId" is required');
        return json({ ok: unpairChat(chatId) });
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/secret',
      // Reveals or rotates the token that makes a webhook caller the owner.
      sensitive: true,
      handler: async (req, params) => {
        const cfg = requireChannel(params.id!);
        if (cfg.type === 'telegram') throw new HttpError(400, 'Bot tokens are write-only — paste a new one to replace it');
        const body = await readBody(req);
        const action = body.action;
        const kind = (body.kind ?? 'token') as ChannelSecretKind;
        if (action !== 'reveal' && action !== 'rotate') throw new HttpError(400, '"action" must be reveal or rotate');
        if (kind !== 'token' && kind !== 'signing') throw new HttpError(400, '"kind" must be token or signing');
        if (kind === 'signing' && cfg.type === 'whatsapp') throw new HttpError(400, 'WhatsApp channels have no signing secret');
        ensureChannelSecrets(cfg);
        if (action === 'rotate') {
          const prefix = kind === 'signing' ? 'cws' : cfg.type === 'whatsapp' ? 'cwa' : 'cwh';
          setChannelSecret(cfg.id, kind, generateToken(prefix));
        }
        const secret = getChannelSecret(cfg.id, kind);
        if (!secret) throw new HttpError(500, 'Could not read the secret');
        let webhook: { ok: boolean; error?: string } | undefined;
        if (action === 'rotate' && cfg.type === 'whatsapp') {
          // The wacli hook carries the old token; re-register so inbound keeps working.
          const wa = runningChannel(cfg.id);
          try {
            await (wa instanceof WhatsAppChannel ? wa : whatsappChannelFor(cfg)).registerWebhook();
            webhook = { ok: true };
          } catch (err) {
            webhook = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return json({ secret, ...(webhook ? { webhook } : {}) });
      },
    },
    {
      method: 'POST',
      path: '/agent/channels/:id/webhook/register',
      // Writes the inbound token into wacli's config.
      sensitive: true,
      handler: async (_req, params) => {
        const cfg = requireChannel(params.id!);
        if (cfg.type !== 'whatsapp') throw new HttpError(400, 'Only WhatsApp channels register a wacli webhook');
        ensureChannelSecrets(cfg);
        const wa = runningChannel(cfg.id);
        try {
          const res = await (wa instanceof WhatsAppChannel ? wa : whatsappChannelFor(cfg)).registerWebhook();
          return json({ ok: true, ...res });
        } catch (err) {
          return errorJson(err instanceof Error ? err.message : String(err), 502);
        }
      },
    },
    {
      method: 'GET',
      path: '/agent/channels/:id/whatsapp/status',
      handler: async (_req, params) => {
        const cfg = requireChannel(params.id!);
        if (cfg.type !== 'whatsapp') throw new HttpError(400, 'Not a WhatsApp channel');
        const wa = runningChannel(cfg.id);
        const adapter = wa instanceof WhatsAppChannel ? wa : whatsappChannelFor(cfg);
        const st = await adapter.refreshStatus();
        return json({ ...st, connected: st.state === 'open', error: adapter.status().lastError ?? null });
      },
    },
    { method: 'POST', path: '/agent/channels/:id/inbound', public: true, handler: handleInbound },
    { method: 'GET', path: '/agent/channels/:id/replies/:requestId', public: true, handler: handleLateReply },
  ]);
}
