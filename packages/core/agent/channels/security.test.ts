/**
 * Channel security controls, end to end through the real routes and
 * adapters: inbound authentication and throttling, owner verification per
 * channel, Telegram pairing, and approval codes typed on a channel.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { MAIN_SESSION_ID } from '../../config/config';
import { clearPendingDecisionsForSession, getPendingDecision, requestPermissionDecision, type BridgeDeps } from '../../provider/bridge';
import { sessions } from '../../session/sessions';
import type { Session } from '../../types';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { _resetDispatch } from '../dispatch';
import { deliverInbound } from '../inbound';
import { _setOutboxSleep, registerChannel, unregisterChannel } from '../outbox';
import { _resetApprovals, _setApprovalScheduler, answerPendingApproval, listPendingApprovals } from '../policy/approvals';
import '../policy/index';
import { setApprovalAnswerer, type ApprovalAnswer } from '../registry';
import { handleAgentRoute } from '../routes';
import { _setAgentDepsForTest } from '../runtime';
import type { AgentDeps, ChannelAdapter, InboundEnvelope } from '../types';
import { _resetSettledApprovals, interceptApprovalReply } from './approvals';
import { addChannelConfig, getChannelConfig, getChannelSecret, normalizeChannel, removeChannelConfig, updateChannelConfig, type ChannelConfig, type TelegramChannelConfig } from './config';
import './index';
import { _setChannelFactory, restartChannel, runningChannel, startChannels, stopChannels } from './manager';
import type { TelegramApi, TgUpdate } from './telegram/api';
import { TelegramChannel } from './telegram/adapter';
import { PAIRING_TTL_MS, _resetPairingCooldowns, approvePairing, livePairings, requestPairing } from './telegram/pairing';
import { WebhookChannel } from './webhook/adapter';
import { WhatsAppChannel } from './whatsapp/adapter';
import { isOwnerMessage, parseLidMap, parseWacliPayload } from './whatsapp/payload';

const OWNER_JID = '5216731413820@s.whatsapp.net';
const STRANGER_JID = '5215550000000@s.whatsapp.net';
const OWNER_CHAT = 6660001;

const toAgent: string[] = [];
const answers: ApprovalAnswer[] = [];

function deps(): AgentDeps {
  return {
    port: 0,
    async sendMessage(_sid, text) { toAgent.push(text); return { ok: true }; },
    interruptSession() {},
    broadcastToSession() {},
    broadcastSessionList() {},
  };
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://127.0.0.1${path}`);
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleAgentRoute(new Request(url, init), url, false).then(r => r!);
}

const inbound = (c: ChannelConfig) => `/agent/channels/${c.id}/inbound`;
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  _setOutboxSleep(async () => {});
  saveAgentConfig({ ...loadAgentConfig(), enabled: true });
  _setChannelFactory(c => {
    if (c.type === 'http_webhook' || c.type === 'ios_shortcut') {
      // Short native timeout so "late reply" cases don't wait 5 s.
      return new WebhookChannel({ ...c, replyTimeoutSec: 0.05 }, { collectMs: 5 }, { token: () => getChannelSecret(c.id, 'token'), signing: () => getChannelSecret(c.id, 'signing') });
    }
    if (c.type === 'whatsapp') {
      return new WhatsAppChannel(c, { run: async () => ({ code: 0, stdout: '', stderr: '' }), transcribe: async () => '', backend: () => null, autoRegister: false }, () => getChannelSecret(c.id, 'token'));
    }
    return { id: c.id, type: c.type, name: c.name, capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 100, markup: 'plain' },
      ownerAddress: () => null, start() {}, stop() {}, async send() { return {}; }, status: () => ({ connected: false }) } satisfies ChannelAdapter;
  });
  await startChannels();
});

afterAll(async () => {
  await stopChannels();
  _setChannelFactory(null);
  _setAgentDepsForTest(null);
  reloadAgentConfig();
});

beforeEach(() => {
  toAgent.length = 0;
  answers.length = 0;
  _resetDispatch();
  _setAgentDepsForTest(deps());
  const base = loadAgentConfig();
  saveAgentConfig({ ...base, enabled: true, owner: { ...base.owner, whatsappJids: [OWNER_JID], telegramChatIds: [String(OWNER_CHAT)] } });
});

// ---------------------------------------------------------------------------
// 1. Inbound endpoints
// ---------------------------------------------------------------------------

describe('channel inbound endpoints', () => {
  const made: ChannelConfig[] = [];
  async function channel(input: Record<string, unknown> & { type: ChannelConfig['type'] }): Promise<ChannelConfig> {
    const cfg = addChannelConfig(input);
    made.push(cfg);
    await restartChannel(cfg.id);
    return cfg;
  }

  afterEach(async () => {
    for (const c of made.splice(0)) {
      removeChannelConfig(c.id);
      await restartChannel(c.id);
    }
  });

  test('missing, wrong, truncated or padded tokens are refused; the agent never hears of them', async () => {
    const cfg = await channel({ type: 'http_webhook', reply: 'none' });
    const token = getChannelSecret(cfg.id, 'token')!;
    const attempts: Record<string, string>[] = [{}, { 'x-codiby-token': '' }, { 'x-codiby-token': token.slice(0, -1) }, { 'x-codiby-token': `${token}a` },
      { 'x-codiby-token': token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) }, { authorization: `Basic ${token}` }, { authorization: 'Bearer' }];
    for (const headers of attempts) {
      expect((await req('POST', inbound(cfg), { text: 'hola' }, headers)).status).toBe(401);
    }
    expect(toAgent).toHaveLength(0);
    // Same token, accepted in either header.
    expect((await req('POST', inbound(cfg), { text: 'uno' }, { 'x-codiby-token': token })).status).toBe(202);
    expect((await req('POST', inbound(cfg), { text: 'dos' }, { authorization: `Bearer ${token}` })).status).toBe(202);
    expect(toAgent).toHaveLength(2);
  });

  test('a channel\'s token opens only that channel', async () => {
    const a = await channel({ type: 'http_webhook', reply: 'none' });
    const b = await channel({ type: 'ios_shortcut', reply: 'none' });
    expect((await req('POST', inbound(b), { text: 'x' }, { 'x-codiby-token': getChannelSecret(a.id, 'token')! })).status).toBe(401);
    expect(toAgent).toHaveLength(0);
  });

  test('WhatsApp inbound takes only its own header, never a Bearer token', async () => {
    const wa = await channel({ type: 'whatsapp', binary: '/opt/wacli', account: 'codiby' });
    const token = getChannelSecret(wa.id, 'token')!;
    const msg = { event: 'message.received', id: `M${randomUUID().slice(0, 8)}`, chat: OWNER_JID, from: OWNER_JID, isGroup: false, fromMe: false, type: 'text', text: 'hola' };
    expect((await req('POST', inbound(wa), msg, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await req('POST', inbound(wa), msg, { 'x-codiby-token': token })).status).toBe(200);
    await tick();
    expect(toAgent).toHaveLength(1);
  });

  test('repeated failures lock the channel — even the right token — and only that channel', async () => {
    const cfg = await channel({ type: 'http_webhook', reply: 'none' });
    const other = await channel({ type: 'http_webhook', reply: 'none' });
    const token = getChannelSecret(cfg.id, 'token')!;
    for (let i = 0; i < 30; i++) expect((await req('POST', inbound(cfg), { text: 'x' }, { 'x-codiby-token': `guess-${i}` })).status).toBe(401);
    expect((await req('POST', inbound(cfg), { text: 'x' }, { 'x-codiby-token': token })).status).toBe(429);
    // The late-reply route shares the lock.
    expect((await req('GET', `/agent/channels/${cfg.id}/replies/req_x`, undefined, { 'x-codiby-token': token })).status).toBe(429);
    expect((await req('POST', inbound(other), { text: 'y' }, { 'x-codiby-token': getChannelSecret(other.id, 'token')! })).status).toBe(202);
    expect(toAgent).toHaveLength(1);
  });

  test('a disabled channel delivers nothing: not over HTTP, not a message already in flight', async () => {
    const cfg = await channel({ type: 'http_webhook', reply: 'none' });
    const token = getChannelSecret(cfg.id, 'token')!;
    updateChannelConfig(cfg.id, { enabled: false });
    await restartChannel(cfg.id);
    expect(runningChannel(cfg.id)).toBeNull();
    expect((await req('POST', inbound(cfg), { text: 'x' }, { 'x-codiby-token': token })).status).toBe(503);
    // An adapter that read its message before the switch hands it over afterwards.
    const late = await deliverInbound({ channelId: cfg.id, channelType: 'http_webhook', peer: 'req_1', trusted: true, text: 'late', receivedAt: Date.now() });
    expect(late.ok).toBe(false);
    expect(toAgent).toHaveLength(0);
  });

  test('late replies need the channel\'s token and only ever return that channel\'s own requests', async () => {
    const a = await channel({ type: 'http_webhook', reply: 'native' });
    const b = await channel({ type: 'http_webhook', reply: 'native' });
    const tokenA = getChannelSecret(a.id, 'token')!;
    const tokenB = getChannelSecret(b.id, 'token')!;
    const res = await req('POST', inbound(a), { text: 'slow question' }, { 'x-codiby-token': tokenA });
    expect(res.status).toBe(202);
    const { requestId } = (await res.json()) as { requestId: string };
    await (runningChannel(a.id) as WebhookChannel).send({ channelId: a.id, channelType: 'http_webhook', peer: requestId }, { kind: 'text', text: 'private answer' });

    expect((await req('GET', `/agent/channels/${a.id}/replies/${requestId}`)).status).toBe(401);
    expect((await req('GET', `/agent/channels/${a.id}/replies/${requestId}`, undefined, { 'x-codiby-token': tokenB })).status).toBe(401);
    const cross = await req('GET', `/agent/channels/${b.id}/replies/${requestId}`, undefined, { 'x-codiby-token': tokenB });
    expect(cross.status).toBe(404);
    expect(await cross.text()).not.toContain('private answer');
    const own = await req('GET', `/agent/channels/${a.id}/replies/${requestId}`, undefined, { authorization: `Bearer ${tokenA}` });
    expect(await own.json()).toEqual({ ok: true, ready: true, reply: 'private answer' });
  });

  test('a webhook token makes its caller the owner, addressed by request — nobody else', async () => {
    const cfg = await channel({ type: 'ios_shortcut', reply: 'none' });
    const ch = runningChannel(cfg.id) as WebhookChannel;
    expect(ch.authenticate(new Request('http://x/', { headers: { 'x-codiby-token': getChannelSecret(cfg.id, 'token')! } }))).toBe(true);
    expect(ch.authenticate(new Request('http://x/', { headers: { 'x-codiby-token': 'nope' } }))).toBe(false);
    // The sender name in the body is a label, never an identity.
    const res = await req('POST', inbound(cfg), { text: 'hola', sender: 'Some Stranger' }, { 'x-codiby-token': getChannelSecret(cfg.id, 'token')! });
    expect(res.status).toBe(202);
    expect(toAgent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Owner verification
// ---------------------------------------------------------------------------

describe('whatsapp owner verification', () => {
  const dm = (from: string, chat = from, extra: Partial<{ isGroup: boolean; fromMe: boolean }> = {}) => ({ from, chat, isGroup: false, fromMe: false, ...extra });

  test('only the owner, in a one-to-one chat', () => {
    expect(isOwnerMessage(dm(OWNER_JID), [OWNER_JID], {})).toBe(true);
    expect(isOwnerMessage(dm(STRANGER_JID), [OWNER_JID], {})).toBe(false);
    // Not in a group, a status broadcast or a newsletter — even the owner.
    for (const chat of ['120363000@g.us', 'status@broadcast', '120363000@newsletter']) {
      expect(isOwnerMessage(dm(OWNER_JID, chat), [OWNER_JID], {})).toBe(false);
    }
    // Never the account's own sends (the agent writing "SI 1234" to the owner).
    expect(isOwnerMessage(dm(OWNER_JID, OWNER_JID, { fromMe: true }), [OWNER_JID], {})).toBe(false);
    // A group JID is a group, whatever the payload's flag says.
    expect(parseWacliPayload({ id: 'X1', chat: '120363000@g.us', from: OWNER_JID, isGroup: false })!.isGroup).toBe(true);
  });

  test('a chat that resolves to somebody else is never the owner, whatever the sender field says', () => {
    expect(isOwnerMessage(dm(OWNER_JID, STRANGER_JID), [OWNER_JID], {})).toBe(false);
    // A LID the map ties to a stranger is that stranger.
    expect(isOwnerMessage(dm(OWNER_JID, '4982225@lid'), [OWNER_JID], { '4982225@lid': STRANGER_JID })).toBe(false);
    // An unmapped LID chat: one-to-one, so it is the sender's own chat.
    expect(isOwnerMessage(dm(OWNER_JID, '4982225@lid'), [OWNER_JID], {})).toBe(true);
  });

  test('the LID map cannot promote a stranger', () => {
    // Only LIDs are translated: an entry keyed by a phone number is ignored…
    expect(isOwnerMessage(dm(STRANGER_JID), [OWNER_JID], { [STRANGER_JID]: OWNER_JID })).toBe(false);
    // …and never even stored, whether typed or sent as an object.
    expect(parseLidMap(`${STRANGER_JID}=${OWNER_JID}\n120363@g.us=${OWNER_JID}\n4982=${OWNER_JID}`)).toEqual({ '4982@lid': OWNER_JID });
    const cfg = normalizeChannel({ id: 'whatsapp-lid', type: 'whatsapp', lidMap: { [STRANGER_JID]: OWNER_JID, '777@lid': '120363@g.us', '4982@LID': '+52 1 673 141 3820' } });
    expect(cfg?.type === 'whatsapp' && cfg.lidMap).toEqual({ '4982@lid': OWNER_JID });
    // A stranger's own LID, unmapped, is not the owner.
    expect(isOwnerMessage(dm('99990001@lid'), [OWNER_JID], {})).toBe(false);
    // Inherited object keys are not map entries.
    expect(isOwnerMessage(dm('constructor@lid'), [OWNER_JID], {})).toBe(false);
  });
});

function fakeTelegramApi() {
  const sent: { chatId: string; text: string }[] = [];
  const callbacks: { id: string; text?: string }[] = [];
  let id = 100;
  const api: TelegramApi = {
    getMe: async () => ({ id: 42, is_bot: true, username: 'codiby_sec_bot' }),
    getUpdates: async () => [],
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: id++ }; },
    async editMessageText() {},
    async deleteMessage() {},
    async sendChatAction() {},
    async answerCallbackQuery(cid, text) { callbacks.push({ id: cid, text }); },
    async downloadFile() { return { data: new Uint8Array(), filePath: 'x' }; },
    async sendFile() { return { message_id: id++ }; },
  };
  return { api, sent, callbacks };
}

let seq = 1;
function tgMessage(chat: { id: number; type: string }, fromId: number | null, text: string): TgUpdate {
  return {
    update_id: seq++,
    message: {
      message_id: seq * 10,
      date: Math.floor(Date.now() / 1000),
      chat: chat as never,
      ...(fromId === null ? {} : { from: { id: fromId, first_name: 'X' } }),
      text,
    },
  };
}

describe('telegram owner verification and pairing', () => {
  let cfg: TelegramChannelConfig;
  let tg: TelegramChannel;
  let fake: ReturnType<typeof fakeTelegramApi>;
  let now: number;

  beforeEach(async () => {
    now = 5_000_000;
    _resetPairingCooldowns();
    setApprovalAnswerer(async a => { answers.push(a); return { ok: true }; });
    cfg = addChannelConfig({ type: 'telegram', name: 'TG sec' }) as TelegramChannelConfig;
    fake = fakeTelegramApi();
    tg = new TelegramChannel(cfg.id, cfg.name, { api: fake.api, transcribe: async () => '', poll: false, now: () => now }, true);
    registerChannel(tg);
    await tg.start();
  });

  afterEach(async () => {
    await tg.stop();
    unregisterChannel(tg.id);
    removeChannelConfig(cfg.id);
    setApprovalAnswerer(answerPendingApproval);
  });

  test('only paired chats reach the agent; in a group both the group and the sender must be paired', async () => {
    const group = { id: -100777, type: 'supergroup' };
    // The owner in an unpaired group.
    await tg.handleUpdate(tgMessage(group, OWNER_CHAT, 'do something'));
    // A paired group, an unpaired sender.
    const base = loadAgentConfig();
    saveAgentConfig({ ...base, owner: { ...base.owner, telegramChatIds: [String(OWNER_CHAT), String(group.id)] } });
    await tg.handleUpdate(tgMessage(group, 4440001, 'do something'));
    // A channel post has no sender at all.
    await tg.handleUpdate(tgMessage(group, null, 'do something'));
    await tg.handleUpdate(tgMessage({ id: -100777, type: 'channel' }, null, 'do something'));
    expect(toAgent).toHaveLength(0);
    await tg.handleUpdate(tgMessage(group, OWNER_CHAT, 'now it is me'));
    await tg.handleUpdate(tgMessage({ id: OWNER_CHAT, type: 'private' }, OWNER_CHAT, 'and here'));
    expect(toAgent).toHaveLength(2);
  });

  test('typed approval codes and button taps from unpaired chats answer nothing', async () => {
    const stranger = { id: 4440002, type: 'private' };
    await tg.handleUpdate(tgMessage(stranger, stranger.id, 'SI 4821'));
    await tg.handleUpdate({ update_id: seq++, callback_query: { id: 'cq1', from: { id: stranger.id, first_name: 'S' }, data: 'pa:req-1', message: { message_id: 1, date: 0, chat: stranger as never } } } as TgUpdate);
    expect(answers).toEqual([]);
    expect(fake.callbacks).toEqual([{ id: 'cq1', text: 'Not authorized' }]);
    // The owner's own tap works.
    await tg.handleUpdate({ update_id: seq++, callback_query: { id: 'cq2', from: { id: OWNER_CHAT, first_name: 'O' }, data: 'pa:req-1', message: { message_id: 2, date: 0, chat: { id: OWNER_CHAT, type: 'private' } as never } } } as TgUpdate);
    expect(answers).toEqual([{ requestId: 'req-1', allow: true, via: 'telegram' }]);
  });

  test('pairing codes: random 6 digits, one per chat, bound to it, single-use, expiring', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = requestPairing(cfg.id, { chatId: String(8000000 + i), title: `c${i}`, username: null }, now);
      expect(r.status).toBe('pending');
      if (r.status === 'pending') {
        expect(r.code).toMatch(/^\d{6}$/);
        codes.add(r.code);
      }
    }
    // crypto.randomInt: 40 draws from a million all but never collide.
    expect(codes.size).toBeGreaterThanOrEqual(39);
    // Only the 10 most recent are kept (the rest must ask again).
    expect(livePairings(getChannelConfig(cfg.id) as TelegramChannelConfig, now)).toHaveLength(10);

    const chat = '8100001';
    const first = requestPairing(cfg.id, { chatId: chat, title: 'Me', username: 'me' }, now);
    const again = requestPairing(cfg.id, { chatId: chat, title: 'Me', username: 'me' }, now + 1_000);
    expect(again.status === 'pending' && first.status === 'pending' && again.code === first.code && !again.isNew).toBe(true);
    // Bound to the chat that asked: approving another chat id does nothing for it.
    expect(() => approvePairing(cfg.id, '8100002', now)).toThrow(/expired or does not exist/);
    expect(loadAgentConfig().owner.telegramChatIds).not.toContain('8100002');
    // Expired: can't be approved any more.
    expect(() => approvePairing(cfg.id, chat, now + PAIRING_TTL_MS + 1)).toThrow(/expired/);
    expect(loadAgentConfig().owner.telegramChatIds).not.toContain(chat);
    // A fresh request after expiry gets a new code; approving it works once.
    const fresh = requestPairing(cfg.id, { chatId: chat, title: 'Me', username: 'me' }, now + PAIRING_TTL_MS + 2);
    expect(fresh.status === 'pending' && fresh.isNew).toBe(true);
    approvePairing(cfg.id, chat, now + PAIRING_TTL_MS + 3);
    expect(loadAgentConfig().owner.telegramChatIds).toContain(chat);
    expect(() => approvePairing(cfg.id, chat, now + PAIRING_TTL_MS + 4)).toThrow(/expired or does not exist/);
  });

  test('a stranger can\'t pair itself: not by echoing its code, not from a group, not through a local caller', async () => {
    const stranger = { id: 4440003, type: 'private' };
    await tg.handleUpdate(tgMessage(stranger, stranger.id, '/start'));
    const code = /Pairing code: (\d{6})/.exec(fake.sent.at(-1)!.text)![1]!;
    await tg.handleUpdate(tgMessage(stranger, stranger.id, code));
    await tg.handleUpdate(tgMessage(stranger, stranger.id, `/pair ${code}`));
    await tg.handleUpdate(tgMessage({ id: -100888, type: 'group' }, stranger.id, '/start'));
    expect(livePairings(getChannelConfig(cfg.id) as TelegramChannelConfig, now).map(p => p.chatId)).toEqual([String(stranger.id)]);
    expect(loadAgentConfig().owner.telegramChatIds).not.toContain(String(stranger.id));
    expect(toAgent).toHaveLength(0);
    // Approving needs the owner (bearer token or the bridge's own UI), not just localhost.
    const url = new URL(`http://127.0.0.1/agent/channels/${cfg.id}/pairings/${stranger.id}`);
    const local = await handleAgentRoute(new Request(url, { method: 'POST', body: JSON.stringify({ approve: true }) }), url, { authenticated: true, ownerVerified: false });
    expect(local!.status).toBe(403);
    expect(loadAgentConfig().owner.telegramChatIds).not.toContain(String(stranger.id));
  });
});

// ---------------------------------------------------------------------------
// 4. Approval codes
// ---------------------------------------------------------------------------

describe('approval codes typed on a channel', () => {
  const bridgeDeps: BridgeDeps = { broadcastToSession: () => {}, sendBrowserRequest: () => {}, broadcastSessionList: () => {} };
  const agentSession = { id: MAIN_SESSION_ID, name: 'Agent', cwd: '/tmp', provider: 'claude' } as Session;
  const coding = { id: 'sec-coding-1', name: 'Coding', cwd: '/tmp/repo', provider: 'claude' } as Session;
  const owner: InboundEnvelope = { channelId: 'sec-owner', channelType: 'whatsapp', peer: OWNER_JID, trusted: true, text: '' };
  const replies: string[] = [];
  const ownerChannel: ChannelAdapter = {
    id: 'sec-owner', type: 'whatsapp', name: 'Sec owner',
    capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4000, markup: 'plain' },
    ownerAddress: () => ({ channelId: 'sec-owner', channelType: 'whatsapp', peer: OWNER_JID }),
    start() {}, stop() {}, async send(_to, msg) { replies.push(msg.text); return {}; }, status: () => ({ connected: true }),
  };

  beforeAll(() => {
    sessions.set(coding.id, coding);
    _setApprovalScheduler(() => setTimeout(() => {}, 0));
  });
  afterAll(() => {
    sessions.delete(coding.id);
    _setApprovalScheduler(null);
  });
  beforeEach(() => {
    replies.length = 0;
    registerChannel(ownerChannel);
    setApprovalAnswerer(answerPendingApproval);
  });
  afterEach(() => {
    unregisterChannel(ownerChannel.id);
    clearPendingDecisionsForSession(MAIN_SESSION_ID);
    clearPendingDecisionsForSession(coding.id);
    _resetApprovals();
    _resetSettledApprovals();
  });

  function ask(session: Session) {
    const requestId = `sec-req-${randomUUID().slice(0, 8)}`;
    void requestPermissionDecision(session, bridgeDeps, { requestId, toolName: 'Bash', input: { command: `touch /tmp/${requestId}` } });
    const pending = listPendingApprovals().find(a => a.requestId === requestId)!;
    return { requestId, code: pending.code };
  }

  test('a code answers its own request only, once; other sessions\' requests stay pending', async () => {
    const a = ask(agentSession);
    const b = ask(coding);
    expect(a.code).toMatch(/^\d{4}$/);
    expect(a.code).not.toBe(b.code);
    expect(await interceptApprovalReply({ ...owner, text: `SI ${a.code}` })).toBe(true);
    expect(getPendingDecision(a.requestId)).toBeFalsy();
    expect(getPendingDecision(b.requestId)).toBeTruthy();
    // Single use: the same code again answers nothing.
    expect(await interceptApprovalReply({ ...owner, text: `NO ${a.code}` })).toBe(true);
    expect(replies.at(-1)).toBe(`⚠️ Approval ${a.code} was already answered or has expired`);
    expect(getPendingDecision(b.requestId)).toBeTruthy();
  });

  test('a typed code can\'t answer another session\'s request that never reached this channel', async () => {
    // No channel up while it asks: the prompt went nowhere.
    unregisterChannel(ownerChannel.id);
    const hidden = ask(coding);
    registerChannel(ownerChannel);
    expect(await interceptApprovalReply({ ...owner, text: `SI ${hidden.code}` })).toBe(true);
    expect(replies.at(-1)).toBe(`⚠️ No pending approval with code ${hidden.code}`);
    expect(getPendingDecision(hidden.requestId)).toBeTruthy();
    // One that was sent here is answerable here.
    const shown = ask(coding);
    expect(await interceptApprovalReply({ ...owner, text: `NO ${shown.code}` })).toBe(true);
    expect(getPendingDecision(shown.requestId)).toBeFalsy();
  });

  test('codes typed by anyone but the owner are ignored', async () => {
    const a = ask(agentSession);
    // An untrusted sender's message is stored, never intercepted.
    const res = await deliverInbound({ channelId: 'sec-stranger', channelType: 'whatsapp', peer: STRANGER_JID, trusted: false, text: `SI ${a.code}`, externalId: randomUUID() });
    expect(res.outcome).toBe('untrusted');
    expect(await interceptApprovalReply({ ...owner, trusted: false, text: `SI ${a.code}` })).toBe(false);
    // Nor is a code riding along with an attachment.
    expect(await interceptApprovalReply({ ...owner, text: `SI ${a.code}`, attachments: [{ kind: 'image', mime: 'image/png', data: 'aGk=' }] })).toBe(false);
    expect(getPendingDecision(a.requestId)).toBeTruthy();
  });
});
