/**
 * Held notifications across an agent stop and a bridge restart, and the
 * heartbeat's cap counting only what a chat channel actually took.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { _setOutboxSleep, registerChannel, unregisterChannel } from '../outbox';
import { AGENT_SESSION_ID } from '../session';
import { agentDataDir } from '../store';
import type { ChannelAdapter, ChannelAddress, OutboundMessage } from '../types';
import { heldStore } from './held-store';
import {
  _resetNotificationQueue,
  _setNotifyClock,
  clearNotificationQueue,
  flushQueuedNotifications,
  heldNotifications,
  notifyOwner,
  queuedNotificationCount,
  restoreHeldNotifications,
} from './notify';
import { _resetHeartbeatCounter, heartbeatMessagesToday, patchHeartbeatConfig } from './settings';

const MX = 'America/Mexico_City';
/** 23:30 local in Mexico City. */
const NIGHT = Date.parse('2026-11-12T05:30:00Z');
/** 07:00 local: when NIGHT's quiet hours end. */
const MORNING = Date.parse('2026-11-12T13:00:00Z');
/** 10:00 local. */
const DAY = Date.parse('2026-11-12T16:00:00Z');
const FILE = agentDataDir('held-notifications.json');

let sent: { to: ChannelAddress; msg: OutboundMessage }[];
let adapter: ChannelAdapter;
const base = { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' };

/** Timers armed by notify, by delay, without letting any of them fire. */
function captureTimers() {
  const armed: number[] = [];
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    armed.push(ms ?? 0);
    return realSet(() => {}, 0);
  }) as typeof setTimeout;
  return { armed, restore: () => { globalThis.setTimeout = realSet; } };
}

beforeEach(() => {
  sent = [];
  _setOutboxSleep(async () => {});
  _resetHeartbeatCounter();
  _resetNotificationQueue();
  saveAgentConfig({
    ...loadAgentConfig(),
    enabled: true,
    preferredChannel: null,
    persona: { ...loadAgentConfig().persona, timezone: MX },
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
  });
  const id = `held-${randomUUID().slice(0, 6)}`;
  const owner: ChannelAddress = { channelId: id, channelType: 'telegram', peer: 'owner-chat', peerName: 'Owner' };
  adapter = {
    id,
    type: 'telegram',
    name: 'Held test',
    capabilities: { images: false, files: false, voice: false, edits: false, buttons: false, typing: false, maxLength: 4096, markup: 'markdown' },
    ownerAddress: () => owner,
    start() {},
    stop() {},
    async send(to, msg) { sent.push({ to, msg }); return {}; },
    status: () => ({ connected: true }),
  };
  registerChannel(adapter);
});

afterEach(() => {
  unregisterChannel(adapter.id);
  _setNotifyClock(null);
  _resetNotificationQueue();
});

afterAll(() => {
  patchHeartbeatConfig({ maxMessagesPerDay: 6 });
  reloadAgentConfig();
});

describe('held notifications on disk', () => {
  test('a held notification is written owner-only and survives an agent stop', async () => {
    _setNotifyClock(() => NIGHT);
    const res = await notifyOwner({ ...base, text: 'FYI', priority: 'low' });
    expect(res.status).toBe('queued');
    expect(existsSync(FILE)).toBe(true);
    expect(statSync(FILE).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(FILE, 'utf-8'));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ body: 'FYI', until: MORNING, req: { text: 'FYI', priority: 'low' } });

    clearNotificationQueue(); // the agent stopped
    expect(queuedNotificationCount()).toBe(1);
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toHaveLength(1);
  });

  test('after a restart the queue comes back from the file and goes out when quiet hours end', async () => {
    _setNotifyClock(() => NIGHT);
    await notifyOwner({ ...base, text: 'Newsletter arrived', priority: 'low' });
    const written = readFileSync(FILE, 'utf-8');

    // A new process: nothing in memory, the file as the last run left it.
    heldStore.set([]);
    writeFileSync(FILE, written);
    const timers = captureTimers();
    let restoredCount: number;
    try {
      restoredCount = restoreHeldNotifications();
    } finally {
      timers.restore();
    }
    expect(restoredCount).toBe(1);
    expect(heldNotifications().map(h => h.body)).toEqual(['Newsletter arrived']);
    // Armed for the end of quiet hours (plus the one-second margin).
    expect(timers.armed).toEqual([MORNING - NIGHT + 1_000]);

    expect(await flushQueuedNotifications()).toHaveLength(0); // still night
    _setNotifyClock(() => DAY);
    const flushed = await flushQueuedNotifications();
    expect(flushed.map(r => r.status)).toEqual(['delivered']);
    expect(sent.map(s => s.msg.text)).toEqual(['Newsletter arrived']);
    expect(queuedNotificationCount()).toBe(0);
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual([]);
  });

  test('one held past its time while the bridge was down goes out at once, silently if it is quiet again', async () => {
    heldStore.set([{ id: 'old-1', req: { ...base, text: 'Yesterday', priority: 'low' }, body: 'Yesterday', heldAt: NIGHT, until: MORNING }]);
    // Back up the next night: quiet again, but the time it waited for is long gone.
    const nextNight = NIGHT + 86_400_000;
    _setNotifyClock(() => nextNight);
    const timers = captureTimers();
    try {
      expect(restoreHeldNotifications()).toBe(1);
    } finally {
      timers.restore();
    }
    expect(timers.armed).toEqual([1_000]);
    const flushed = await flushQueuedNotifications();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ status: 'delivered', quiet: true });
    expect(sent[0]!.msg).toMatchObject({ text: 'Yesterday', priority: 'low' });
  });

  test('the timer waits for a channel that is still connecting instead of dropping to push', async () => {
    heldStore.set([{ id: 'w-1', req: { ...base, text: 'Morning note', priority: 'low' }, body: 'Morning note', heldAt: NIGHT, until: MORNING }]);
    _setNotifyClock(() => DAY);
    unregisterChannel(adapter.id);
    const timers = captureTimers();
    try {
      expect(await flushQueuedNotifications({ waitForChannel: true })).toEqual([]);
    } finally {
      timers.restore();
    }
    expect(queuedNotificationCount()).toBe(1);
    expect(timers.armed).toEqual([15_000]);
    registerChannel(adapter);
    const flushed = await flushQueuedNotifications({ waitForChannel: true });
    expect(flushed.map(r => r.status)).toEqual(['delivered']);
    expect(queuedNotificationCount()).toBe(0);
  });

  test('a hand-edited file is read defensively', () => {
    writeFileSync(FILE, JSON.stringify([
      { id: 'ok', req: { ...base, text: 'fine', priority: 'low', origin: 'heartbeat' }, body: 'fine', heldAt: 1, until: 2 },
      { id: 'no-body', req: { ...base, text: 'x' }, heldAt: 1, until: 2 },
      { id: 'bad-time', req: { ...base, text: 'x' }, body: 'x', heldAt: 'soon', until: 2 },
      { id: 'odd', req: { ...base, text: 'y', priority: 'shout', origin: 'someone', channelId: 42 }, body: 'y', heldAt: 1, until: 2 },
      'junk',
    ]));
    const items = heldStore.reload();
    expect(items.map(h => h.id)).toEqual(['ok', 'odd']);
    expect(items[0]!.req.origin).toBe('heartbeat');
    expect(items[1]!.req).toEqual({ ...base, text: 'y', priority: 'low' });
    writeFileSync(FILE, '{not json');
    expect(heldStore.reload()).toEqual([]);
  });
});

describe('the heartbeat cap counts what was delivered', () => {
  const hb = { ...base, origin: 'heartbeat' as const };

  test('a message no chat channel took is not counted', async () => {
    _setNotifyClock(() => DAY);
    patchHeartbeatConfig({ maxMessagesPerDay: 1 });
    unregisterChannel(adapter.id);
    expect((await notifyOwner({ ...hb, text: 'nobody hears this' })).status).toBe('push_only');
    expect(heartbeatMessagesToday(MX, DAY).sent).toBe(0);
    registerChannel(adapter);
    expect((await notifyOwner({ ...hb, text: 'this one lands' })).status).toBe('delivered');
    expect(heartbeatMessagesToday(MX, DAY).sent).toBe(1);
    expect((await notifyOwner({ ...hb, text: 'over the cap' })).status).toBe('limited');
  });

  test('a held heartbeat message keeps its place, and counts once it is delivered', async () => {
    _setNotifyClock(() => NIGHT);
    patchHeartbeatConfig({ maxMessagesPerDay: 1 });
    expect((await notifyOwner({ ...hb, text: 'for the morning', priority: 'low' })).status).toBe('queued');
    expect(heartbeatMessagesToday(MX, NIGHT).sent).toBe(0);
    const second = await notifyOwner({ ...hb, text: 'one too many', priority: 'low' });
    expect(second.status).toBe('limited');
    expect(second.error).toContain('1 more is waiting to go out');

    _setNotifyClock(() => DAY);
    expect((await flushQueuedNotifications()).map(r => r.status)).toEqual(['delivered']);
    expect(heartbeatMessagesToday(MX, DAY).sent).toBe(1);
  });
});
