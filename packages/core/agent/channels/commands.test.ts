import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { memoryStateStore } from '../memory/settings';
import { _setOutboxSleep, registerChannel, unregisterChannel } from '../outbox';
import { _setAgentDepsForTest } from '../runtime';
import type { ChannelAdapter, ChannelAddress, InboundEnvelope, OutboundMessage } from '../types';
import {
  NEW_THREAD_ACK,
  NEW_THREAD_BUSY,
  _setThreadRotatorForTest,
  freshThreadText,
  interceptCommand,
  pendingFreshThread,
} from './commands';

const OPEN = { port: 0, interruptSession() {}, broadcastToSession() {}, broadcastSessionList() {} };

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('/new', () => {
  let sent: { to: ChannelAddress; msg: OutboundMessage }[];
  let adapter: ChannelAdapter;
  let env: InboundEnvelope;
  const memoryBefore = memoryStateStore.get();

  beforeEach(() => {
    sent = [];
    _setOutboxSleep(async () => {});
    _setAgentDepsForTest({ ...OPEN, async sendMessage() { return { ok: true }; } });
    saveAgentConfig({ ...loadAgentConfig(), enabled: true });
    const id = `cmd-${randomUUID().slice(0, 6)}`;
    adapter = {
      id,
      type: 'telegram',
      name: 'Fake TG',
      capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4000, markup: 'plain' },
      ownerAddress: () => ({ channelId: id, channelType: 'telegram', peer: '42' }),
      start() {},
      stop() {},
      async send(to, msg) { sent.push({ to, msg }); return {}; },
      status: () => ({ connected: true }),
    };
    registerChannel(adapter);
    env = { channelId: id, channelType: 'telegram', peer: '42', trusted: true, text: '/new' };
  });

  afterEach(async () => {
    await pendingFreshThread();
    _setThreadRotatorForTest(null);
    unregisterChannel(adapter.id);
    memoryStateStore.set(memoryBefore);
    reloadAgentConfig();
  });

  test('answers right away, rotates in the background and reports when the thread is ready', async () => {
    const gate = deferred();
    const reasons: string[] = [];
    _setThreadRotatorForTest(reason => { reasons.push(reason); return gate.promise; });

    // The interceptor returns while consolidation is still running.
    expect(await interceptCommand(env)).toBe(true);
    expect(reasons).toEqual(['New conversation']);
    expect(sent.map(s => s.msg.text)).toEqual([NEW_THREAD_ACK]);
    // The acknowledgement is a reply (no priority): on Telegram it replaces the working bubble.
    expect(sent[0]!.msg.priority).toBeUndefined();

    // A second /new while it runs doesn't start another rotation.
    expect(await interceptCommand(env)).toBe(true);
    expect(reasons).toHaveLength(1);
    expect(sent.at(-1)!.msg.text).toBe(NEW_THREAD_BUSY);

    gate.resolve();
    await pendingFreshThread();
    const done = sent.at(-1)!;
    expect(done.msg.text).toStartWith('🆕 Fresh thread started.');
    // Posted on its own, so it never takes over the working bubble of a newer message.
    expect(done.msg.priority).toBe('normal');
    expect(done.to.peer).toBe('42');
    expect(pendingFreshThread()).toBeNull();
  });

  test('a failed rotation is reported, not swallowed', async () => {
    _setThreadRotatorForTest(async () => { throw new Error('provider would not close'); });
    await interceptCommand(env);
    await pendingFreshThread();
    expect(sent.map(s => s.msg.text)).toEqual([NEW_THREAD_ACK, '⚠️ Could not start a fresh thread: provider would not close']);
  });

  test('the report says what consolidation saved', () => {
    const startedAt = Date.now();
    memoryStateStore.update(s => ({ ...s, lastConsolidation: { at: startedAt + 5, reason: 'New conversation', outcome: 'done', saved: 3 } }));
    expect(freshThreadText(startedAt)).toBe('🆕 Fresh thread started. Saved 3 things I learned.');
    memoryStateStore.update(s => ({ ...s, lastConsolidation: { at: startedAt + 5, reason: 'x', outcome: 'timeout', saved: 1 } }));
    expect(freshThreadText(startedAt)).toContain('Saved 1 thing I learned. Saving took too long');
    // A record from an earlier rotation says nothing about this one.
    expect(freshThreadText(startedAt + 10)).toBe('🆕 Fresh thread started. Memory is kept.');
  });
});
