import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { MAIN_SESSION_ID } from '../../config/config';
import { addMessage } from '../../session/state';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { handleAgentTurnComplete, _resetDispatch } from '../dispatch';
import { _setOutboxSleep } from '../outbox';
import { handleAgentRoute } from '../routes';
import { _setAgentDepsForTest } from '../runtime';
import type { ChannelAdapter } from '../types';
import './index';
import { addChannelConfig, getChannelSecret, removeChannelConfig, type WebhookChannelConfig } from './config';
import { _setChannelFactory, restartChannel, startChannels, stopChannels } from './manager';
import { CALLBACK_TIMEOUT_MS, WebhookChannel, checkCallbackUrl, parseWebhookBody, signCallback } from './webhook/adapter';

const OPEN = { port: 0, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://127.0.0.1${path}`);
  return handleAgentRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), url, false);
}

/** The agent "answers" shortly after receiving the message. */
function agentReplies(text: string | null) {
  _setAgentDepsForTest({
    ...OPEN,
    async sendMessage() {
      setTimeout(() => {
        addMessage(MAIN_SESSION_ID, { id: randomUUID(), role: 'assistant', content: text ?? 'NO_REPLY', timestamp: Date.now() });
        handleAgentTurnComplete(MAIN_SESSION_ID);
      }, 5);
      return { ok: true };
    },
  });
}

describe('webhook body validation', () => {
  test('rejects bad shapes with a clear message', () => {
    expect(() => parseWebhookBody([])).toThrow('JSON object');
    expect(() => parseWebhookBody({})).toThrow('Send "text" or "images"');
    expect(() => parseWebhookBody({ text: 'x', images: [{ media_type: 'text/html', data: 'aGk=' }] })).toThrow('media_type');
    expect(() => parseWebhookBody({ text: 'x', images: [{ media_type: 'image/png', data: 'not base64!' }] })).toThrow('base64');
    expect(parseWebhookBody({ text: 'hi', sender: ' Siri ', images: [{ media_type: 'image/png', data: 'data:image/png;base64,aGk=' }] }))
      .toEqual({ text: 'hi', sender: 'Siri', id: null, images: [{ media_type: 'image/png', data: 'aGk=' }] });
  });
});

describe('webhook inbound route', () => {
  let cfg: WebhookChannelConfig;
  let token: string;

  beforeAll(async () => {
    const base = loadAgentConfig();
    saveAgentConfig({ ...base, enabled: true });
    // Only webhook channels are built here, whatever other suites left configured.
    _setChannelFactory(c => {
      if (c.type === 'http_webhook' || c.type === 'ios_shortcut') {
        return new WebhookChannel(c, { collectMs: 20 }, { token: () => getChannelSecret(c.id, 'token'), signing: () => getChannelSecret(c.id, 'signing') });
      }
      return { id: c.id, type: c.type, name: c.name, capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 100, markup: 'plain' },
        ownerAddress: () => null, start() {}, stop() {}, async send() { return {}; }, status: () => ({ connected: false }) } satisfies ChannelAdapter;
    });
    await startChannels();
  });

  afterAll(async () => {
    await stopChannels();
    _setChannelFactory(null);
    reloadAgentConfig();
  });

  beforeEach(async () => {
    _resetDispatch();
    _setOutboxSleep(async () => {});
    cfg = addChannelConfig({ type: 'ios_shortcut', reply: 'native' }) as WebhookChannelConfig;
    token = getChannelSecret(cfg.id, 'token')!;
    await restartChannel(cfg.id);
  });

  afterEach(async () => {
    removeChannelConfig(cfg.id);
    await restartChannel(cfg.id);
  });

  test('rejects missing and wrong tokens', async () => {
    agentReplies('hi');
    expect((await post(`/agent/channels/${cfg.id}/inbound`, { text: 'hola' }))!.status).toBe(401);
    expect((await post(`/agent/channels/${cfg.id}/inbound`, { text: 'hola' }, { 'x-codiby-token': `${token}x` }))!.status).toBe(401);
    expect((await post(`/agent/channels/${cfg.id}/inbound`, { text: 'hola' }, { authorization: 'Bearer nope' }))!.status).toBe(401);
    expect((await post('/agent/channels/does-not-exist/inbound', { text: 'hola' }, { 'x-codiby-token': token }))!.status).toBe(404);
  });

  test('native reply: the response carries the agent\'s answer to that request', async () => {
    agentReplies('Mañana a las **9**.');
    const res = (await post(`/agent/channels/${cfg.id}/inbound`, { text: '¿a qué hora es la cita?' }, { authorization: `Bearer ${token}` }))!;
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; reply: string; requestId: string };
    expect(body.ok).toBe(true);
    // iOS Shortcut channels get plain text.
    expect(body.reply).toBe('Mañana a las 9.');
    expect(body.requestId).toStartWith('req_');
  });

  test('?format=text answers text/plain', async () => {
    agentReplies('Listo.');
    const res = (await post(`/agent/channels/${cfg.id}/inbound?format=text`, { text: 'apaga la luz' }, { 'x-codiby-token': token }))!;
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Listo.');
  });

  test('a turn with nothing to say still ends the request', async () => {
    agentReplies(null);
    const res = (await post(`/agent/channels/${cfg.id}/inbound`, { text: 'log this' }, { 'x-codiby-token': token }))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toBe('');
  });

  test('a disabled agent answers 503 instead of hanging', async () => {
    _setAgentDepsForTest({ ...OPEN, async sendMessage() { return { ok: false, error: 'down' }; } });
    const res = (await post(`/agent/channels/${cfg.id}/inbound`, { text: 'x' }, { 'x-codiby-token': token }))!;
    expect(res.status).toBe(503);
  });
});

describe('webhook channel (direct)', () => {
  const secrets = { token: () => 'tok', signing: () => 'sign-key' };
  const base: WebhookChannelConfig = {
    id: 'webhook-direct', type: 'http_webhook', name: 'Hook', enabled: true, notifyOnOthers: false,
    createdAt: 0, updatedAt: 0, reply: 'native', callbackUrl: '', replyTimeoutSec: 0.05,
  };

  beforeEach(() => {
    _resetDispatch();
    _setAgentDepsForTest({ ...OPEN, async sendMessage() { return { ok: true }; } });
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
  });

  test('a slow agent gets 202 queued, and the late reply can be fetched', async () => {
    const ch = new WebhookChannel(base, { collectMs: 5 }, secrets);
    ch.start();
    const url = new URL('http://x/agent/channels/webhook-direct/inbound');
    const res = await ch.handleRequest(new Request(url, { method: 'POST', body: JSON.stringify({ text: 'slow one' }) }), url);
    expect(res.status).toBe(202);
    const body = await res.json() as { queued: boolean; requestId: string };
    expect(body.queued).toBe(true);
    expect(ch.lateReply(body.requestId)).toEqual({ ready: false, reply: '' });
    await ch.send({ channelId: base.id, channelType: 'http_webhook', peer: body.requestId }, { kind: 'text', text: 'done at last' });
    expect(ch.lateReply(body.requestId)).toEqual({ ready: true, reply: 'done at last' });
  });

  test('callback replies are signed with HMAC-SHA256 over "<timestamp>.<body>"', async () => {
    const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ch = new WebhookChannel({ ...base, reply: 'callback', callbackUrl: 'https://example.test/hook' }, {
      fetch: async (u, init) => {
        posted.push({ url: u, headers: init!.headers as Record<string, string>, body: String(init!.body) });
        return new Response('ok');
      },
      now: () => 1_700_000_000_000,
    }, secrets);
    ch.start();
    expect(ch.ownerAddress()?.peer).toBe('owner');
    await ch.send({ channelId: base.id, channelType: 'http_webhook', peer: 'owner' }, { kind: 'text', text: 'ping', priority: 'low' });
    const p = posted[0]!;
    expect(p.url).toBe('https://example.test/hook');
    expect(p.headers['X-Codiby-Timestamp']).toBe('1700000000');
    expect(p.headers['X-Codiby-Signature']).toBe(signCallback('sign-key', '1700000000', p.body));
    expect(JSON.parse(p.body)).toMatchObject({ channelId: base.id, requestId: null, text: 'ping', priority: 'low' });
  });

  test('native-only channels cannot take proactive messages', async () => {
    const ch = new WebhookChannel(base, {}, secrets);
    expect(ch.ownerAddress()).toBeNull();
    await expect(ch.send({ channelId: base.id, channelType: 'http_webhook', peer: 'owner' }, { kind: 'text', text: 'x' })).rejects.toThrow('no open request');
  });
});

describe('webhook callback targets', () => {
  const secrets = { token: () => 'tok', signing: () => 'sign-key' };
  const base: WebhookChannelConfig = {
    id: 'webhook-cb', type: 'http_webhook', name: 'Hook', enabled: true, notifyOnOthers: false,
    createdAt: 0, updatedAt: 0, reply: 'callback', callbackUrl: 'https://hooks.example.test/in', replyTimeoutSec: 5,
  };
  const owner = { channelId: base.id, channelType: 'http_webhook' as const, peer: 'owner' };

  test('only http(s), no credentials, no link-local, never this bridge on loopback', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.test/x', 'javascript:alert(1)', 'data:text/plain,x', 'ws://example.test/', 'not a url',
      'https://user:pass@hooks.example.test/', 'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/x',
      'http://127.0.0.1:3111/agent/config', 'http://localhost:3111/', 'http://127.1:3111/', 'http://[::1]:3111/', 'http://0.0.0.0:3111/',
      'http://bridge.localhost:3111/', 'http://[::ffff:127.0.0.1]:3111/', 'http://2130706433:3111/']) {
      expect(() => checkCallbackUrl(bad, 3111), bad).toThrow();
    }
    // The owner's own receivers: LAN, loopback on another port, the internet.
    for (const ok of ['http://192.168.1.10:8123/api/webhook/x', 'http://localhost:5678/webhook', 'http://127.0.0.1:3112/', 'https://hooks.example.test/in', 'http://10.0.0.5/']) {
      expect(() => checkCallbackUrl(ok, 3111), ok).not.toThrow();
    }
  });

  test('a target that never went through the routes is refused before anything is sent', async () => {
    const calls: string[] = [];
    const ch = new WebhookChannel({ ...base, callbackUrl: 'file:///etc/passwd' }, { fetch: async u => { calls.push(u); return new Response('ok'); } }, secrets);
    ch.start();
    await expect(ch.send(owner, { kind: 'text', text: 'x' })).rejects.toThrow(/Callback refused/);
    expect(calls).toEqual([]);
    expect(ch.status().lastError).toContain('must be http(s)');
  });

  test('redirects are not followed, every POST has a timeout, and the body is signed', async () => {
    const inits: RequestInit[] = [];
    const ch = new WebhookChannel(base, {
      fetch: async (_u, init) => { inits.push(init!); return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:3111/agent/config' } }); },
      now: () => 1_700_000_000_000,
    }, secrets);
    ch.start();
    await expect(ch.send(owner, { kind: 'text', text: 'x' })).rejects.toThrow(/307 \(redirects are not followed\)/);
    expect(inits).toHaveLength(1);
    expect(inits[0]!.redirect).toBe('manual');
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(CALLBACK_TIMEOUT_MS).toBe(15_000);
    const headers = inits[0]!.headers as Record<string, string>;
    const body = String(inits[0]!.body);
    expect(headers['X-Codiby-Signature']).toBe(signCallback('sign-key', headers['X-Codiby-Timestamp']!, body));
    // The signature covers the timestamp and the body, under this channel's key only.
    expect(headers['X-Codiby-Signature']).not.toBe(signCallback('sign-key', '1700000001', body));
    expect(headers['X-Codiby-Signature']).not.toBe(signCallback('sign-key', headers['X-Codiby-Timestamp']!, `${body} `));
    expect(headers['X-Codiby-Signature']).not.toBe(signCallback('other-key', headers['X-Codiby-Timestamp']!, body));
  });

  test('the routes refuse a callback that points at this bridge', async () => {
    _setAgentDepsForTest({ ...OPEN, port: 3111, async sendMessage() { return { ok: true }; } });
    const cfg = addChannelConfig({ type: 'http_webhook', reply: 'callback' });
    try {
      const url = new URL(`http://127.0.0.1/agent/channels/${cfg.id}`);
      const patch = (callbackUrl: string) => handleAgentRoute(new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackUrl }) }), url, true);
      const self = (await patch('http://localhost:3111/agent/channels'))!;
      expect(self.status).toBe(400);
      expect(((await self.json()) as { error: string }).error).toContain('this bridge itself');
      expect((await patch('ftp://example.test/'))!.status).toBe(400);
      expect((await patch('http://192.168.1.10:8123/hook'))!.status).toBe(200);
    } finally {
      removeChannelConfig(cfg.id);
      await restartChannel(cfg.id);
    }
  });
});
