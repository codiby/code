/**
 * E2E — the agent reaching out on its own: notify_user under quiet hours,
 * a reminder that fires without an LLM turn, and a heartbeat that has
 * nothing to say. Clocks are fixed; channels are the real adapters over
 * fake transports.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getAutomation } from '../../automation/repository';
import { fireOnceAutomation, unscheduleAutomation } from '../../automation/scheduler';
import { runningChannel } from '../channels/manager';
import type { TelegramChannel } from '../channels/telegram/adapter';
import { flushQueuedNotifications, queuedNotificationCount, _setNotifyClock } from '../proactive/notify';
import { onOwnerNotification, type OwnerNotification } from '../registry';
import {
  api,
  bootAgent,
  DAY,
  messageRows,
  NIGHT,
  OWNER_TG_CHAT,
  OWNER_WA,
  spyChannel,
  waitFor,
  type AgentHarness,
} from './harness';

let h: AgentHarness;
let tgId: string;
let waId: string;
const telegram = () => runningChannel(tgId) as TelegramChannel;

// What the push area is told (it decides on sound from `quiet`).
const notes: OwnerNotification[] = [];
onOwnerNotification(n => notes.push(n));

beforeAll(async () => {
  h = await bootAgent();
  tgId = (await h.addChannel({ type: 'telegram', name: 'Telegram' })).id;
  waId = (await h.addChannel({ type: 'whatsapp', name: 'WhatsApp', binary: '/opt/fake/wacli', account: 'codiby' })).id;
  // Proactive messages go to Telegram first, so "one channel" is predictable.
  expect((await api('PUT', '/agent/config', { preferredChannel: tgId })).status).toBe(200);
});

afterAll(async () => {
  await h.shutdown();
});

beforeEach(() => {
  h.reset();
  notes.length = 0;
});

describe('proactivity end to end', () => {
  test('5 · notify_user in quiet hours: normal arrives silently, low waits for the morning, urgent rings on every channel', async () => {
    const tg = h.transports.tg(tgId);
    const wacli = h.transports.wa(waId);
    const spy = spyChannel(tgId);
    const tgStart = tg.visible(OWNER_TG_CHAT).length;
    const waStart = wacli.textsTo(OWNER_WA).length;
    _setNotifyClock(() => NIGHT);
    try {
      const turn = h.agent.turn();

      const normal = JSON.parse(await turn.mcp('notify_user', { text: 'Build finished ✅' }));
      expect(normal).toMatchObject({ status: 'delivered', quiet: true, priority: 'normal', deliveredTo: [tgId] });
      const delivered = tg.visible(OWNER_TG_CHAT).slice(tgStart);
      expect(delivered.map(m => m.text)).toEqual(['Build finished ✅']);
      // Silent: the channel got it as low priority and Telegram was told not to ring.
      expect(spy.sent.at(-1)!.priority).toBe('low');
      expect(delivered[0]!.silent).toBe(true);
      expect(notes.at(-1)).toMatchObject({ text: 'Build finished ✅', priority: 'normal', quiet: true });
      expect(wacli.textsTo(OWNER_WA).length).toBe(waStart);

      const low = JSON.parse(await turn.mcp('notify_user', { text: 'FYI: the newsletter arrived', priority: 'low' }));
      expect(low).toMatchObject({ status: 'queued', quiet: true });
      expect(low.queuedUntil).toBe(Date.parse('2026-11-12T13:00:00Z')); // 07:00 in Mexico City
      expect(queuedNotificationCount()).toBe(1);
      expect(tg.visible(OWNER_TG_CHAT).length).toBe(tgStart + 1);

      const urgent = JSON.parse(await turn.mcp('notify_user', { text: 'The server is down', priority: 'urgent' }));
      expect(urgent).toMatchObject({ status: 'delivered', quiet: false, priority: 'urgent' });
      expect(urgent.deliveredTo).toEqual(expect.arrayContaining([tgId, waId]));
      const ring = tg.visible(OWNER_TG_CHAT).at(-1)!;
      expect(ring.text).toBe('The server is down');
      expect(ring.silent).toBe(false);
      expect(wacli.textsTo(OWNER_WA).slice(waStart)).toEqual(['The server is down']);
      expect(notes.at(-1)).toMatchObject({ priority: 'urgent', quiet: false });

      // The agent's own turn (not started from a channel) delivers nothing more.
      turn.say('NO_REPLY').end();
      await h.agent.idle();
      expect(tg.visible(OWNER_TG_CHAT).length).toBe(tgStart + 2);

      // Morning: what quiet hours held goes out, with sound.
      _setNotifyClock(() => DAY);
      const flushed = await flushQueuedNotifications();
      expect(flushed.map(r => r.status)).toEqual(['delivered']);
      const morning = tg.visible(OWNER_TG_CHAT).at(-1)!;
      expect(morning.text).toBe('FYI: the newsletter arrived');
      expect(queuedNotificationCount()).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test('6 · a "message" reminder fires and delivers "⏰ …" to the owner without an LLM turn', async () => {
    const tg = h.transports.tg(tgId);
    _setNotifyClock(() => DAY);
    let reminderId = '';
    // The owner asks on Telegram; the agent schedules it and confirms.
    h.agent.brain = async (_msg, turn) => {
      const out = await turn.mcp('schedule_reminder', { text: 'Call the dentist', inMinutes: 30 });
      reminderId = /aut_[\w-]+/.exec(out)?.[0] ?? '';
      turn.say('Listo, te lo recuerdo en 30 minutos.').end();
    };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, 'recuérdame llamar al dentista en 30 min'));
    await h.agent.idle();
    expect(reminderId).toMatch(/^aut_/);
    await waitFor(() => tg.texts(OWNER_TG_CHAT).at(-1) === 'Listo, te lo recuerdo en 30 minutos.', 'the confirmation');
    const reminders = await api('GET', '/agent/reminders');
    expect(reminders.body.reminders.find((r: { id: string }) => r.id === reminderId)).toMatchObject({ mode: 'message', status: 'scheduled' });

    // Fire time (the scheduler's timer, run now instead of in 30 minutes).
    const turnsBefore = h.agent.received.length;
    const before = tg.visible(OWNER_TG_CHAT).length;
    unscheduleAutomation(reminderId);
    const run = await fireOnceAutomation(reminderId);
    expect(run?.status).toBe('succeeded');
    expect(run?.resultText).toContain(tgId);

    const shown = tg.visible(OWNER_TG_CHAT).slice(before);
    expect(shown.map(m => m.text)).toEqual(['⏰ Call the dentist']);
    // No LLM turn: the agent session never heard about it.
    expect(h.agent.received.length).toBe(turnsBefore);
    // One-shot: it retired.
    expect(getAutomation(reminderId)!.enabled).toBe(false);
    const after = await api('GET', '/agent/reminders?all=1');
    expect(after.body.reminders.find((r: { id: string }) => r.id === reminderId)).toMatchObject({ status: 'done' });
    expect(messageRows(tgId).find(r => r.direction === 'out' && r.text === '⏰ Call the dentist')?.status).toBe('sent');
  });

  test('7 · a heartbeat turn that ends in NO_REPLY delivers nothing, on any channel', async () => {
    const tg = h.transports.tg(tgId);
    const wacli = h.transports.wa(waId);
    _setNotifyClock(() => DAY);

    // An ordinary exchange first, so the channels have a recent owner turn behind them.
    h.agent.brain = (_msg, turn) => { turn.say('¡Buenos días!').end(); };
    await telegram().handleUpdate(tg.messageUpdate(OWNER_TG_CHAT, 'buenos días'));
    await h.agent.idle();
    await waitFor(() => tg.texts(OWNER_TG_CHAT).at(-1) === '¡Buenos días!', 'the morning reply');

    const tgCalls = tg.calls.length;
    const waTexts = wacli.runs.filter(a => a.includes('text')).length;
    const outRows = messageRows(tgId).length + messageRows(waId).length;
    let prompt = '';
    h.agent.brain = async (msg, turn) => {
      prompt = msg.text;
      await turn.mcp('recall', { query: 'pending tasks today' });
      turn.think('Nothing here needs the owner right now.');
      turn.say('NO_REPLY').end();
    };
    const res = await api('POST', '/agent/heartbeat/run', { kind: 'heartbeat' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: false });
    await h.agent.idle();

    expect(prompt).toMatch(/^\[Automation · Heartbeat · /);
    expect(prompt).toContain('reply exactly NO_REPLY');
    // Nothing reached the owner: no Telegram call at all, no WhatsApp text, no outbound row.
    expect(tg.calls.slice(tgCalls)).toEqual([]);
    expect(wacli.runs.filter(a => a.includes('text')).length).toBe(waTexts);
    expect(messageRows(tgId).length + messageRows(waId).length).toBe(outRows);

    // The run is recorded as done.
    const status = await api('GET', '/agent/heartbeat');
    expect(status.body.heartbeat.runs[0]).toMatchObject({ status: 'succeeded', resultText: 'NO_REPLY' });

    // A heartbeat that rambles instead of saying NO_REPLY still isn't forwarded:
    // only notify_user reaches the owner from a scheduled turn.
    h.agent.brain = async (_msg, turn) => {
      turn.say('Checked the calendar, all quiet.').end();
    };
    expect((await api('POST', '/agent/heartbeat/run', { kind: 'heartbeat' })).body.ok).toBe(true);
    await h.agent.idle();
    expect(tg.calls.slice(tgCalls)).toEqual([]);
    expect(wacli.runs.filter(a => a.includes('text')).length).toBe(waTexts);
  });
});
