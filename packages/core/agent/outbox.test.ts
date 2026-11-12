import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { database } from '../database';
import { agentMessages } from '../database/schema';
import { TelegramApiError } from './channels/telegram/api';
import { MAX_RETRY_AFTER_MS, _setOutboxSleep, registerChannel, retryAfterMs, sendTo, sendToOwner, unregisterChannel } from './outbox';
import type { ChannelAdapter, ChannelAddress, OutboundMessage, SendResult } from './types';

function channel(id: string, send: (to: ChannelAddress, msg: OutboundMessage) => Promise<SendResult>): { adapter: ChannelAdapter; owner: ChannelAddress } {
  const owner: ChannelAddress = { channelId: id, channelType: 'telegram', peer: `owner-${id}` };
  const adapter: ChannelAdapter = {
    id,
    type: 'telegram',
    name: `Outbox ${id}`,
    capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4096, markup: 'plain' },
    ownerAddress: () => owner,
    start() {},
    stop() {},
    send,
    status: () => ({ connected: true }),
  };
  return { adapter, owner };
}

const rowFor = (channelId: string) =>
  database.select().from(agentMessages).where(eq(agentMessages.channelId, channelId)).all().find(r => r.direction === 'out');

const registered: string[] = [];
function add<T extends { adapter: ChannelAdapter }>(c: T): T { registerChannel(c.adapter); registered.push(c.adapter.id); return c; }

let waits: number[];
beforeEach(() => {
  waits = [];
  _setOutboxSleep(async ms => { waits.push(ms); });
});
afterEach(() => {
  for (const id of registered.splice(0)) unregisterChannel(id);
  _setOutboxSleep(async () => {});
});

describe('unconfirmed sends', () => {
  test('a send the adapter could not confirm is logged as unconfirmed, not sent — and not retried', async () => {
    let calls = 0;
    const c = add(channel(`unc-${randomUUID().slice(0, 6)}`, async () => { calls++; return { unconfirmed: true }; }));
    const res = await sendTo(c.owner, { kind: 'text', text: 'did it arrive?' });
    expect(res).toEqual({ ok: true, externalIds: [], unconfirmed: true });
    expect(calls).toBe(1);
    expect(rowFor(c.adapter.id)?.status).toBe('unconfirmed');
  });

  test('one unconfirmed piece of a split message marks the whole delivery', async () => {
    let n = 0;
    const id = `unc-split-${randomUUID().slice(0, 6)}`;
    const c = add(channel(id, async () => (++n === 2 ? { unconfirmed: true } : { externalId: `m${n}` })));
    (c.adapter.capabilities as { maxLength: number }).maxLength = 40;
    const res = await sendTo(c.owner, { kind: 'text', text: 'word '.repeat(30) });
    expect(res.ok).toBe(true);
    expect(res.unconfirmed).toBe(true);
    expect(rowFor(id)?.status).toBe('unconfirmed');
  });

  test('a confirmed send is still logged as sent', async () => {
    const c = add(channel(`ok-${randomUUID().slice(0, 6)}`, async () => ({ externalId: 'x1' })));
    const res = await sendTo(c.owner, { kind: 'text', text: 'hi' });
    expect(res).toEqual({ ok: true, externalIds: ['x1'] });
    expect(rowFor(c.adapter.id)?.status).toBe('sent');
  });
});

describe('retry after', () => {
  test('reads Telegram\'s retry_after (seconds) off TelegramApiError, capped at two minutes', () => {
    expect(retryAfterMs(new TelegramApiError(429, 'Too Many Requests: retry after 7', 7))).toBe(7_000);
    expect(retryAfterMs(new TelegramApiError(429, 'Too Many Requests', 3600))).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(120_000);
    expect(retryAfterMs(Object.assign(new Error('wrapped'), { cause: new TelegramApiError(429, 'x', 2) }))).toBe(2_000);
    expect(retryAfterMs(new TelegramApiError(400, 'Bad Request'))).toBeNull();
    expect(retryAfterMs(new Error('boom'))).toBeNull();
    expect(retryAfterMs({ retryAfter: -1 })).toBeNull();
  });

  test('a 429 waits what the platform asked instead of the fixed backoff', async () => {
    let calls = 0;
    const c = add(channel(`rl-${randomUUID().slice(0, 6)}`, async () => {
      calls++;
      if (calls === 1) throw new TelegramApiError(429, 'Too Many Requests: retry after 9', 9);
      if (calls === 2) throw new Error('flaky');
      return { externalId: 'ok' };
    }));
    const res = await sendTo(c.owner, { kind: 'text', text: 'hi' });
    expect(res.ok).toBe(true);
    // 9 s as asked, then the usual 4 s step for the plain error that followed.
    expect(waits).toEqual([9_000, 4_000]);
  });

  test('a retry waiting out its backoff never goes out through a channel stopped meanwhile', async () => {
    let calls = 0;
    const id = `rl-stop-${randomUUID().slice(0, 6)}`;
    const c = add(channel(id, async () => {
      if (++calls === 1) throw new TelegramApiError(429, 'Too Many Requests', 30);
      return { externalId: 'late' };
    }));
    // The agent is disabled during the 30 s wait: its channels stop and unregister.
    _setOutboxSleep(async () => { unregisterChannel(id); });
    const res = await sendTo(c.owner, { kind: 'text', text: 'too late' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('stopped');
    expect(calls).toBe(1);
    expect(rowFor(id)?.status).toBe('failed');
  });

  test('a channel restarted with new settings during the backoff takes the retry', async () => {
    const id = `rl-swap-${randomUUID().slice(0, 6)}`;
    const old = add(channel(id, async () => { throw new TelegramApiError(429, 'Too Many Requests', 5); }));
    const fresh = channel(id, async () => ({ externalId: 'from-new' }));
    _setOutboxSleep(async () => { registerChannel(fresh.adapter); });
    const res = await sendTo(old.owner, { kind: 'text', text: 'hi' });
    expect(res).toMatchObject({ ok: true, externalIds: ['from-new'] });
  });

  test('an absurd retry_after is capped, not waited out', async () => {
    let calls = 0;
    const c = add(channel(`rl-cap-${randomUUID().slice(0, 6)}`, async () => {
      if (++calls === 1) throw new TelegramApiError(429, 'Too Many Requests', 86_400);
      return {};
    }));
    expect((await sendTo(c.owner, { kind: 'text', text: 'hi' })).ok).toBe(true);
    expect(waits).toEqual([MAX_RETRY_AFTER_MS]);
  });

  test('a channel waiting out its rate limit does not hold up another channel', async () => {
    let releaseWait!: () => void;
    const held = new Promise<void>(r => { releaseWait = r; });
    _setOutboxSleep(ms => (ms === 30_000 ? held : Promise.resolve()));
    let limited = true;
    const slow = add(channel(`rl-slow-${randomUUID().slice(0, 6)}`, async () => {
      if (limited) { limited = false; throw new TelegramApiError(429, 'Too Many Requests', 30); }
      return {};
    }));
    const fastSent: string[] = [];
    const fast = add(channel(`rl-fast-${randomUUID().slice(0, 6)}`, async (_to, msg) => { fastSent.push(msg.text); return {}; }));

    const slowDelivery = sendTo(slow.owner, { kind: 'text', text: 'slow' });
    expect(await sendTo(fast.owner, { kind: 'text', text: 'fast' })).toMatchObject({ ok: true });
    expect(fastSent).toEqual(['fast']);
    releaseWait();
    expect((await slowDelivery).ok).toBe(true);
  });

  test('sendToOwner with all: true reaches every channel side by side', async () => {
    let releaseWait!: () => void;
    const held = new Promise<void>(r => { releaseWait = r; });
    _setOutboxSleep(ms => (ms === 45_000 ? held : Promise.resolve()));
    let limited = true;
    const slow = add(channel(`all-slow-${randomUUID().slice(0, 6)}`, async () => {
      if (limited) { limited = false; throw new TelegramApiError(429, 'Too Many Requests', 45); }
      return {};
    }));
    const fastSent: string[] = [];
    const fast = add(channel(`all-fast-${randomUUID().slice(0, 6)}`, async (_to, msg) => { fastSent.push(msg.text); return {}; }));

    const all = sendToOwner({ kind: 'text', text: 'urgent', priority: 'urgent' }, { all: true });
    // The other channel has it while the first is still waiting.
    await new Promise(r => setTimeout(r, 5));
    expect(fastSent).toEqual(['urgent']);
    releaseWait();
    const res = await all;
    expect(res.ok).toBe(true);
    expect(res.deliveredTo).toEqual(expect.arrayContaining([slow.adapter.id, fast.adapter.id]));
  });
});
