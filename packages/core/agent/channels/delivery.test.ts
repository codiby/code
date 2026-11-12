import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { _resetDispatch } from '../dispatch';
import { _setOutboxSleep, registerChannel, sendTo, unregisterChannel } from '../outbox';
import { _setAgentDepsForTest } from '../runtime';
import type { OutboundMessage } from '../types';
import { _resetSettledApprovals, noteApprovalSettled } from './approvals';
import { addChannelConfig, getChannelSecret, removeChannelConfig, type TelegramChannelConfig, type WhatsAppChannelConfig } from './config';
import { DeliveryUncertainError, RetryWindow, failedBeforeSending, isDeliveryUncertain } from './delivery';
import { TelegramApiError, createTelegramApi, type TelegramApi } from './telegram/api';
import { TelegramChannel } from './telegram/adapter';
import { sendOutcome, type CliResult } from './whatsapp/cli';
import { WhatsAppChannel } from './whatsapp/adapter';
import { WebhookChannel, RETRY_WINDOW_MS } from './webhook/adapter';
import type { WebhookChannelConfig } from './config';

const OPEN = { port: 0, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} };
const OWNER_CHAT = 5550101;
const OWNER_JID = '5216731413820@s.whatsapp.net';

function netError(code: string, message = code): Error {
  return Object.assign(new TypeError(message), { code });
}

function timeoutError(): Error {
  return Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
}

beforeEach(() => {
  _resetDispatch();
  _resetSettledApprovals();
  _setOutboxSleep(async () => {});
  _setAgentDepsForTest({ ...OPEN, async sendMessage() { return { ok: true }; } });
});

describe('failedBeforeSending', () => {
  test('refused, unresolvable and unreachable never reached the platform', () => {
    expect(failedBeforeSending(netError('ECONNREFUSED'))).toBe(true);
    expect(failedBeforeSending(netError('ENOTFOUND'))).toBe(true);
    expect(failedBeforeSending(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }))).toBe(true);
  });

  test('timeouts and dropped connections may have been processed', () => {
    expect(failedBeforeSending(timeoutError())).toBe(false);
    expect(failedBeforeSending(netError('ECONNRESET'))).toBe(false);
    expect(failedBeforeSending(new Error('anything else'))).toBe(false);
  });
});

describe('telegram api: what is safe to retry', () => {
  const TOKEN = '123456:AAHk1mXQ2-test-token-value-abcdefghij';
  const api = (respond: () => Promise<Response>) => createTelegramApi(TOKEN, async () => respond());
  const reject = (err: Error) => api(() => Promise.reject(err));
  const answer = (status: number, body: unknown) => api(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  test('a refused connection is a plain, retryable error', async () => {
    const err = await reject(netError('ECONNREFUSED', `ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`)).sendMessage('1', 'hi').catch(e => e);
    expect(isDeliveryUncertain(err)).toBe(false);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  test('a timeout, a reset, a 5xx or an unreadable 2xx are uncertain', async () => {
    for (const client of [
      reject(timeoutError()),
      reject(netError('ECONNRESET')),
      answer(502, '<html>Bad Gateway</html>'),
      answer(500, { ok: false, error_code: 500, description: 'Internal Server Error' }),
      answer(200, 'not json'),
    ]) {
      const err = await client.sendMessage('1', 'hi').catch(e => e);
      expect(err).toBeInstanceOf(DeliveryUncertainError);
    }
  });

  test('an explicit 4xx from Telegram stays a TelegramApiError', async () => {
    const err = await answer(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }).sendMessage('1', 'hi').catch(e => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).retryAfter).toBe(7);
  });

  test('silent sends set disable_notification, on text and on files', async () => {
    const bodies: (string | FormData)[] = [];
    const client = createTelegramApi(TOKEN, async (_url, init) => {
      bodies.push(init!.body as string | FormData);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    await client.sendMessage('1', 'quiet', { silent: true });
    await client.sendMessage('1', 'loud');
    expect(JSON.parse(bodies[0] as string).disable_notification).toBe(true);
    expect(JSON.parse(bodies[1] as string).disable_notification).toBeUndefined();
    await client.sendFile('1', 'document', { path: import.meta.path, name: 'x.ts' }, 'cap', { silent: true });
    expect((bodies[2] as FormData).get('disable_notification')).toBe('true');
  });
});

describe('telegram adapter: retries never duplicate', () => {
  let cfg: TelegramChannelConfig;
  let channel: TelegramChannel;
  let sends: { text: string; opts: unknown }[];
  let files: string[];
  let failNext: (Error | null)[];

  function api(): TelegramApi {
    let id = 2000;
    const next = () => failNext.shift() ?? null;
    return {
      getMe: async () => ({ id: 1, is_bot: true, username: 'codiby_delivery_bot' }),
      getUpdates: async () => [],
      async sendMessage(_chat, text, opts) {
        const err = next();
        if (err && !(err instanceof DeliveryUncertainError)) throw err;
        sends.push({ text, opts });
        if (err) throw err; // Telegram posted it, but the answer never came back.
        return { message_id: id++ };
      },
      async editMessageText() {},
      async deleteMessage() {},
      async sendChatAction() {},
      async answerCallbackQuery() {},
      async downloadFile() { return { data: new Uint8Array(), filePath: 'x' }; },
      async sendFile(_chat, _kind, file) {
        const err = next();
        if (err && !(err instanceof DeliveryUncertainError)) throw err;
        files.push(file.path);
        if (err) throw err;
        return { message_id: id++ };
      },
    };
  }

  beforeEach(async () => {
    sends = [];
    files = [];
    failNext = [];
    const base = loadAgentConfig();
    saveAgentConfig({ ...base, enabled: true, owner: { ...base.owner, telegramChatIds: [String(OWNER_CHAT)] } });
    cfg = addChannelConfig({ type: 'telegram', name: 'TG delivery' }) as TelegramChannelConfig;
    channel = new TelegramChannel(cfg.id, cfg.name, { api: api(), transcribe: async () => '', poll: false }, true);
    registerChannel(channel);
    await channel.start();
  });

  afterEach(async () => {
    await channel.stop();
    unregisterChannel(channel.id);
    removeChannelConfig(cfg.id);
    reloadAgentConfig();
  });

  const to = () => ({ channelId: cfg.id, channelType: 'telegram' as const, peer: String(OWNER_CHAT) });

  test('low priority is delivered silently; normal priority is not', async () => {
    await sendTo(to(), { kind: 'text', text: 'quiet hours note', priority: 'low' });
    await sendTo(to(), { kind: 'text', text: 'heads up', priority: 'normal' });
    expect((sends[0]!.opts as { silent?: boolean }).silent).toBe(true);
    expect((sends[1]!.opts as { silent?: boolean }).silent).toBeUndefined();
  });

  test('a timeout after Telegram accepted the message is not retried', async () => {
    failNext = [new DeliveryUncertainError('Telegram did not answer: The operation timed out.')];
    const res = await sendTo(to(), { kind: 'text', text: 'only once', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(sends.map(s => s.text)).toEqual(['only once']);
  });

  test('every send Telegram did not confirm says so', async () => {
    failNext = [new DeliveryUncertainError('Telegram did not answer: The operation timed out.')];
    expect(await channel.send(to(), { kind: 'text', text: 'maybe', priority: 'normal' })).toEqual({ unconfirmed: true });
    failNext = [null, new DeliveryUncertainError('Telegram 502: Bad Gateway')];
    const files = await channel.send(to(), { kind: 'file', text: '', files: [{ path: '/tmp/x.pdf' }, { path: '/tmp/y.pdf' }], priority: 'normal' });
    expect(files.unconfirmed).toBe(true);
    expect(files.externalId).toBeDefined();
    // A confirmed send carries no flag at all.
    expect(await channel.send(to(), { kind: 'text', text: 'sure', priority: 'normal' })).not.toHaveProperty('unconfirmed');
  });

  test('a definite failure is retried until it goes through', async () => {
    failNext = [new Error('ECONNREFUSED'), new TelegramApiError(429, 'Too Many Requests')];
    const res = await sendTo(to(), { kind: 'text', text: 'eventually', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(sends.map(s => s.text)).toEqual(['eventually']);
  });

  test('a retry of a multi-file message resumes after the files already sent', async () => {
    const msg: OutboundMessage = { kind: 'file', text: '', files: [{ path: '/tmp/a.pdf' }, { path: '/tmp/b.pdf' }, { path: '/tmp/c.pdf' }], priority: 'normal' };
    // a.pdf goes out, b.pdf is refused once, then everything else works.
    failNext = [null, new Error('ECONNREFUSED')];
    const res = await sendTo(to(), msg);
    expect(res.ok).toBe(true);
    expect(files).toEqual(['/tmp/a.pdf', '/tmp/b.pdf', '/tmp/c.pdf']);
  });

  test('an uncertain file counts as sent and the rest still go out', async () => {
    failNext = [new DeliveryUncertainError('Telegram 502: Bad Gateway')];
    const res = await sendTo(to(), { kind: 'file', text: '', files: [{ path: '/tmp/1.pdf' }, { path: '/tmp/2.pdf' }], priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(files).toEqual(['/tmp/1.pdf', '/tmp/2.pdf']);
  });
});

describe('wacli send outcomes', () => {
  const r = (x: Partial<CliResult>): CliResult => ({ code: 1, stdout: '', stderr: '', ...x });
  test('exit 0 or a printed message id is sent', () => {
    expect(sendOutcome(r({ code: 0 }))).toBe('sent');
    expect(sendOutcome(r({ code: 1, stdout: 'sent id: 3EB0ABCDEF123456\n', stderr: 'error: read receipt failed' }))).toBe('sent');
  });
  test('killed by our timeout, or a timeout waiting for the ack, is uncertain', () => {
    expect(sendOutcome(r({ code: 137, timedOut: true }))).toBe('uncertain');
    expect(sendOutcome(r({ stderr: 'error: timed out waiting for message send response' }))).toBe('uncertain');
    expect(sendOutcome(r({ stderr: 'error: context deadline exceeded' }))).toBe('uncertain');
  });
  test('errors raised before sending are definite', () => {
    expect(sendOutcome(r({ code: 127, stderr: 'No such file or directory' }))).toBe('failed');
    expect(sendOutcome(r({ stderr: 'error: not connected' }))).toBe('failed');
    expect(sendOutcome(r({ stderr: 'error: invalid JID' }))).toBe('failed');
    expect(sendOutcome(r({ stderr: 'error: something odd' }))).toBe('failed');
  });
});

describe('whatsapp adapter: retries never duplicate', () => {
  let cfg: WhatsAppChannelConfig;
  let channel: WhatsAppChannel;
  let runs: string[][];
  let script: CliResult[];

  beforeEach(() => {
    runs = [];
    script = [];
    const base = loadAgentConfig();
    saveAgentConfig({ ...base, enabled: true, owner: { ...base.owner, whatsappJids: [OWNER_JID] } });
    cfg = addChannelConfig({ type: 'whatsapp', binary: '/opt/wacli', account: 'codiby' }) as WhatsAppChannelConfig;
    channel = new WhatsAppChannel(cfg, {
      run: async argv => {
        runs.push(argv);
        return script.shift() ?? { code: 0, stdout: `sent id: 3EB0${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}\n`, stderr: '' };
      },
      transcribe: async () => '',
      backend: () => null,
      autoRegister: false,
    }, () => getChannelSecret(cfg.id, 'token'));
    registerChannel(channel);
    channel.start();
  });

  afterEach(() => {
    channel.stop();
    unregisterChannel(channel.id);
    removeChannelConfig(cfg.id);
    reloadAgentConfig();
  });

  const to = () => ({ channelId: cfg.id, channelType: 'whatsapp' as const, peer: OWNER_JID });
  const texts = () => runs.filter(a => a.includes('text'));

  test('wacli killed by the timeout is not run again', async () => {
    script = [{ code: 137, stdout: '', stderr: '', timedOut: true }];
    const res = await sendTo(to(), { kind: 'text', text: 'once', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(texts()).toHaveLength(1);
  });

  test('every send wacli did not confirm says so', async () => {
    script = [{ code: 137, stdout: '', stderr: '', timedOut: true }];
    expect(await channel.send(to(), { kind: 'text', text: 'maybe', priority: 'normal' })).toEqual({ unconfirmed: true });
    script = [{ code: 0, stdout: 'sent id: 3EB0AAAAAAAA0002\n', stderr: '' }, { code: 1, stdout: '', stderr: 'error: timed out waiting for message send response' }];
    const files = await channel.send(to(), { kind: 'file', text: '', files: [{ path: '/tmp/a.pdf' }, { path: '/tmp/b.pdf' }], priority: 'normal' });
    expect(files).toEqual({ externalId: '3EB0AAAAAAAA0002', unconfirmed: true });
    expect(await channel.send(to(), { kind: 'text', text: 'sure', priority: 'normal' })).not.toHaveProperty('unconfirmed');
  });

  test('an approval answered before its send is skipped; one answered during it gets a follow-up note', async () => {
    const approval = { requestId: `wa-${randomUUID()}`, code: '4821', title: 'Send a message', summary: 'to Bob', toolName: 't', sessionId: 's', sessionName: 'Agent', expiresAt: 0 };
    noteApprovalSettled({ requestId: approval.requestId, allow: true, via: 'telegram' });
    expect(await channel.send(to(), { kind: 'approval', text: '', approval })).toEqual({});
    expect(texts()).toHaveLength(0);

    // Answered on Telegram while wacli was still sending this one.
    const late = { ...approval, requestId: `wa-${randomUUID()}`, code: '5150' };
    channel.stop();
    unregisterChannel(channel.id);
    channel = new WhatsAppChannel(cfg, {
      run: async argv => {
        runs.push(argv);
        if (argv.at(-1)!.includes('SI 5150')) noteApprovalSettled({ requestId: late.requestId, allow: false, via: 'telegram' });
        return { code: 0, stdout: 'sent id: 3EB0AAAAAAAA0003\n', stderr: '' };
      },
      transcribe: async () => '',
      backend: () => null,
      autoRegister: false,
    }, () => getChannelSecret(cfg.id, 'token'));
    registerChannel(channel);
    channel.start();
    const res = await channel.send(to(), { kind: 'approval', text: '', approval: late });
    expect(res.externalId).toBe('3EB0AAAAAAAA0003');
    expect(texts().map(a => a.at(-1))).toEqual([
      expect.stringContaining('Reply "SI 5150"'),
      '❌ Denied (via telegram): Send a message. Approval 5150 was already answered — no need to reply.',
    ]);
  });

  test('a definite wacli failure is retried', async () => {
    script = [{ code: 1, stdout: '', stderr: 'error: not connected' }];
    const res = await sendTo(to(), { kind: 'text', text: 'twice tried', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(texts()).toHaveLength(2);
  });

  test('a media retry resumes after the files already sent', async () => {
    script = [{ code: 0, stdout: 'sent id: 3EB0AAAAAAAA0001\n', stderr: '' }, { code: 1, stdout: '', stderr: 'error: not connected' }];
    const res = await sendTo(to(), { kind: 'file', text: 'docs', files: [{ path: '/tmp/a.pdf' }, { path: '/tmp/b.pdf' }], priority: 'normal' });
    expect(res.ok).toBe(true);
    const paths = runs.filter(a => a.includes('media')).map(a => a.at(-1));
    expect(paths).toEqual(['/tmp/a.pdf', '/tmp/b.pdf', '/tmp/b.pdf']);
    expect(res.externalIds).toEqual(['3EB0AAAAAAAA0001']);
  });
});

describe('webhook callbacks', () => {
  const secrets = { token: () => 'tok', signing: () => 'sign-key' };
  const base: WebhookChannelConfig = {
    id: 'webhook-delivery', type: 'http_webhook', name: 'Hook', enabled: true, notifyOnOthers: false,
    createdAt: 0, updatedAt: 0, reply: 'callback', callbackUrl: 'https://example.test/hook', replyTimeoutSec: 5,
  };
  let posted: { headers: Record<string, string>; body: Record<string, unknown> }[];

  function hook(fail: (n: number) => Error | Response | null) {
    posted = [];
    const ch = new WebhookChannel(base, {
      fetch: async (_u, init) => {
        posted.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
        const f = fail(posted.length);
        if (f instanceof Error) throw f;
        return f ?? new Response('ok');
      },
    }, secrets);
    ch.start();
    registerChannel(ch);
    return ch;
  }

  afterEach(() => unregisterChannel(base.id));
  const owner = { channelId: base.id, channelType: 'http_webhook' as const, peer: 'owner' };

  test('a callback that timed out is not posted again', async () => {
    hook(() => timeoutError());
    const res = await sendTo(owner, { kind: 'text', text: 'once', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(posted).toHaveLength(1);
  });

  test('a callback the receiver did not confirm says so', async () => {
    const ch = hook(() => timeoutError());
    expect(await ch.send(owner, { kind: 'text', text: 'maybe', priority: 'normal' })).toEqual({ unconfirmed: true });
    const ok = hook(() => null);
    expect(await ok.send(owner, { kind: 'text', text: 'sure', priority: 'normal' })).toEqual({});
  });

  test('an approval answered before its callback is not posted; one answered meanwhile gets a follow-up', async () => {
    const approval = { requestId: `hook-${randomUUID()}`, code: '4821', title: 'Run', summary: 'ls', toolName: 'Bash', sessionId: 's', sessionName: 'Coding', expiresAt: 0 };
    hook(() => null);
    noteApprovalSettled({ requestId: approval.requestId, allow: true, via: 'app' });
    await sendTo(owner, { kind: 'approval', text: '', approval, priority: 'normal' });
    expect(posted).toHaveLength(0);

    // Answered on Telegram while the receiver was still taking the approval.
    const late = { ...approval, requestId: `hook-${randomUUID()}`, code: '7777' };
    hook(n => {
      if (n === 1) noteApprovalSettled({ requestId: late.requestId, allow: true, via: 'telegram' });
      return null;
    });
    const res = await sendTo(owner, { kind: 'approval', text: '', approval: late, priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(posted.map(p => p.body.kind)).toEqual(['approval', 'text']);
    expect(posted[1]!.body.text).toBe('✅ Approved (via telegram): Run. Approval 7777 was already answered — no need to reply.');
    expect(posted[1]!.body.deliveryId).not.toBe(posted[0]!.body.deliveryId);
  });

  test('an unreachable receiver or a non-2xx answer is retried with the same delivery id', async () => {
    hook(n => (n === 1 ? netError('ECONNREFUSED') : n === 2 ? new Response('busy', { status: 503 }) : null));
    const res = await sendTo(owner, { kind: 'text', text: 'again', priority: 'normal' });
    expect(res.ok).toBe(true);
    expect(posted).toHaveLength(3);
    const ids = new Set(posted.map(p => p.body.deliveryId));
    expect(ids.size).toBe(1);
    expect(String([...ids][0])).toStartWith('dlv_');
    expect(posted[0]!.headers['X-Codiby-Delivery']).toBe(String([...ids][0]));
  });

  test('approvals that never expire carry expiresAt null, not 0', async () => {
    hook(() => null);
    const approval = { requestId: 'r', code: '4821', title: 'Run', summary: 'ls', toolName: 'Bash', sessionId: 's', sessionName: 'Coding', expiresAt: 0 };
    await sendTo(owner, { kind: 'approval', text: '', approval, priority: 'normal' });
    await sendTo(owner, { kind: 'approval', text: '', approval: { ...approval, expiresAt: 1_900_000_000_000 }, priority: 'normal' });
    expect((posted[0]!.body.approval as { expiresAt: unknown }).expiresAt).toBeNull();
    expect((posted[1]!.body.approval as { expiresAt: unknown }).expiresAt).toBe(1_900_000_000_000);
    expect(String(posted[0]!.body.text)).not.toContain('Expires');
  });
});

describe('inbound ids without a platform message id', () => {
  test('RetryWindow: the same content inside the window hashes the same, after it does not', () => {
    const w = new RetryWindow(60_000);
    const a = w.idFor(['ch', 'Siri', 'log water'], 1_000);
    expect(w.idFor(['ch', 'Siri', 'log water'], 50_000)).toBe(a);
    expect(w.idFor(['ch', 'Siri', 'log coffee'], 50_000)).not.toBe(a);
    expect(w.idFor(['ch', 'Siri', 'log water'], 62_000)).not.toBe(a);
  });

  describe('webhook', () => {
    let cfg: WebhookChannelConfig;
    let ch: WebhookChannel;
    let now: number;
    let delivered: string[];

    beforeEach(() => {
      saveAgentConfig({ ...loadAgentConfig(), enabled: true });
      now = 10_000_000;
      delivered = [];
      _setAgentDepsForTest({ ...OPEN, async sendMessage(_sid, text) { delivered.push(text); return { ok: true }; } });
      cfg = addChannelConfig({ type: 'http_webhook', reply: 'none' }) as WebhookChannelConfig;
      ch = new WebhookChannel(cfg, { now: () => now }, { token: () => 'tok', signing: () => 'sig' });
      ch.start();
      registerChannel(ch);
    });

    afterEach(() => {
      unregisterChannel(cfg.id);
      removeChannelConfig(cfg.id);
      reloadAgentConfig();
    });

    async function post(body: unknown, headers: Record<string, string> = {}) {
      const url = new URL(`http://x/agent/channels/${cfg.id}/inbound`);
      const res = await ch.handleRequest(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }), url);
      return res.json() as Promise<{ duplicate?: boolean; accepted?: boolean }>;
    }

    test('a retried body without an id is delivered once', async () => {
      const text = `remind me ${randomUUID()}`;
      expect((await post({ text })).accepted).toBe(true);
      now += 30_000;
      expect((await post({ text })).duplicate).toBe(true);
      expect(delivered.filter(t => t.includes(text))).toHaveLength(1);
      // Outside the window it is a new message.
      now += RETRY_WINDOW_MS + 1;
      expect((await post({ text })).accepted).toBe(true);
      expect(delivered.filter(t => t.includes(text))).toHaveLength(2);
    });

    test('an Idempotency-Key dedupes regardless of timing; different keys do not', async () => {
      const text = `same words ${randomUUID()}`;
      await post({ text }, { 'Idempotency-Key': 'k-1' });
      now += 10 * RETRY_WINDOW_MS;
      expect((await post({ text }, { 'Idempotency-Key': 'k-1' })).duplicate).toBe(true);
      expect((await post({ text }, { 'Idempotency-Key': 'k-2' })).accepted).toBe(true);
    });

    test('commands are never deduped by content', async () => {
      const url = new URL(`http://x/agent/channels/${cfg.id}/inbound`);
      expect(ch.inboundId(new Request(url, { method: 'POST' }), { text: '/status', images: [], sender: null, id: null })).toBeUndefined();
      expect(ch.inboundId(new Request(url, { method: 'POST' }), { text: 'SI 4821', images: [], sender: null, id: null })).toBeUndefined();
      expect(ch.inboundId(new Request(url, { method: 'POST' }), { text: 'hola', images: [], sender: null, id: 'abc' })).toBe('abc');
    });
  });
});
