import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { parseManagedMeta } from '../../automation/managed';
import * as repository from '../../automation/repository';
import {
  _resetAutomationRunnerForTest,
  completeAutomationRun,
  configureAutomationRunner,
  runAutomation,
} from '../../automation/runner';
import { fireOnceAutomation, unscheduleAutomation } from '../../automation/scheduler';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { _setOutboxSleep, registerChannel, unregisterChannel } from '../outbox';
import { agentSystemPrompt } from '../prompt';
import { onOwnerNotification, type OwnerNotification } from '../registry';
import { handleAgentRoute } from '../routes';
import { _setAgentDepsForTest } from '../runtime';
import { AGENT_SESSION_ID, ensureAgentSession } from '../session';
import { executeAgentTool } from '../tools';
import type { ChannelAdapter, ChannelAddress, OutboundMessage } from '../types';
import { handleAgentConfigChanged } from './config-sync';
import { activeManagedKind, briefCron, managedAutomation, runManagedNow, syncManagedAutomations } from './heartbeat';
import { _resetNotificationQueue, _setNotifyClock, clearNotificationQueue, flushQueuedNotifications, notifyOwner, queuedNotificationCount } from './notify';
import { _setReminderChannelWait, cancelReminder, listReminders, ReminderError, scheduleReminder } from './reminders';
import { _reloadHeartbeatConfig, _resetHeartbeatCounter, patchHeartbeatConfig } from './settings';
import { isQuietTime, parseLocalIso, quietEndsAt, zonedTimeToUtc } from './time';
import './index';

const MX = 'America/Mexico_City'; // UTC-6 all year since 2022
/** 23:30 local in Mexico City. */
const NIGHT = Date.parse('2026-11-12T05:30:00Z');
/** 10:00 local in Mexico City. */
const DAY = Date.parse('2026-11-12T16:00:00Z');

function fakeChannel(id = `fake-${randomUUID().slice(0, 6)}`) {
  const sent: { to: ChannelAddress; msg: OutboundMessage }[] = [];
  const owner: ChannelAddress = { channelId: id, channelType: 'telegram', peer: 'owner-chat', peerName: 'Owner' };
  const adapter: ChannelAdapter = {
    id,
    type: 'telegram',
    name: `Fake ${id}`,
    capabilities: { images: true, files: true, voice: false, edits: false, buttons: true, typing: false, maxLength: 4096, markup: 'markdown' },
    ownerAddress: () => owner,
    start() {},
    stop() {},
    async send(to, msg) { sent.push({ to, msg }); return { externalId: `x${sent.length}` }; },
    status: () => ({ connected: true }),
  };
  return { adapter, sent };
}

const notifications: OwnerNotification[] = [];
onOwnerNotification(n => notifications.push(n));

const sentToSessions: { sessionId: string; text: string }[] = [];
let ch: ReturnType<typeof fakeChannel>;

function setAgent(patch: Partial<ReturnType<typeof loadAgentConfig>>) {
  saveAgentConfig({ ...loadAgentConfig(), ...patch });
}

beforeEach(() => {
  notifications.length = 0;
  sentToSessions.length = 0;
  _setOutboxSleep(async () => {});
  _setReminderChannelWait(0);
  _resetHeartbeatCounter();
  _resetAutomationRunnerForTest();
  _resetNotificationQueue();
  setAgent({
    enabled: true,
    preferredChannel: null,
    persona: { ...loadAgentConfig().persona, name: 'Codiby', emoji: '', timezone: MX },
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
  });
  ch = fakeChannel();
  registerChannel(ch.adapter);
  ensureAgentSession();
  const deps = {
    port: 0,
    async sendMessage(sessionId: string, text: string) { sentToSessions.push({ sessionId, text }); return { ok: true }; },
    async interruptSession() {},
    broadcastToSession() {},
    broadcastSessionList() {},
  };
  _setAgentDepsForTest(deps);
  configureAutomationRunner(deps);
});

afterEach(() => {
  unregisterChannel(ch.adapter.id);
  _setNotifyClock(null);
  _resetNotificationQueue();
  _resetAutomationRunnerForTest();
});

afterAll(() => {
  for (const r of listReminders({ includeDone: true })) unscheduleAutomation(r.id);
  for (const kind of ['heartbeat', 'morning_brief'] as const) {
    const row = managedAutomation(kind);
    if (row) unscheduleAutomation(row.id);
  }
  _setAgentDepsForTest(null);
  reloadAgentConfig();
  _reloadHeartbeatConfig();
});

describe('time and quiet hours', () => {
  const quiet = { enabled: true, start: '23:00', end: '07:00' };

  test('a window that wraps midnight, read in the owner\'s zone', () => {
    expect(isQuietTime(quiet, MX, NIGHT)).toBe(true);
    expect(isQuietTime(quiet, MX, DAY)).toBe(false);
    // 05:30Z is 14:30 in Tokyo: not quiet there.
    expect(isQuietTime(quiet, 'Asia/Tokyo', NIGHT)).toBe(false);
    expect(isQuietTime({ ...quiet, enabled: false }, MX, NIGHT)).toBe(false);
    // Start == end is an empty window, not a 24h one.
    expect(isQuietTime({ enabled: true, start: '09:00', end: '09:00' }, MX, DAY)).toBe(false);
    // A daytime window.
    expect(isQuietTime({ enabled: true, start: '09:00', end: '12:00' }, MX, DAY)).toBe(true);
  });

  test('quiet hours end at the local end time on the right day', () => {
    expect(quietEndsAt(quiet, MX, NIGHT)).toBe(Date.parse('2026-11-12T13:00:00Z'));
    expect(quietEndsAt(quiet, MX, DAY)).toBeNull();
  });

  test('a window ending inside the repeated fall-back hour ends ahead of now on both passes', () => {
    const ny = 'America/New_York';
    const early = { enabled: true, start: '00:00', end: '01:30' };
    // 2026-11-01: 01:15 EDT (05:15Z), then the clocks go back and 01:15 EST (06:15Z).
    expect(quietEndsAt(early, ny, Date.parse('2026-11-01T05:15:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'));
    // Was 05:30Z — in the past — so the held-notification flush re-armed every second.
    expect(quietEndsAt(early, ny, Date.parse('2026-11-01T06:15:00Z'))).toBe(Date.parse('2026-11-01T06:30:00Z'));
    // Across spring-forward the end stays on its wall-clock time (07:00 EDT = 11:00Z).
    expect(quietEndsAt(quiet, ny, Date.parse('2026-03-08T04:30:00Z'))).toBe(Date.parse('2026-03-08T11:00:00Z'));
  });

  test('local wall-clock times convert across DST', () => {
    const ny = 'America/New_York';
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 }, ny)).toBe(Date.parse('2026-03-08T06:30:00Z'));
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, ny)).toBe(Date.parse('2026-03-08T07:30:00Z'));
    expect(parseLocalIso('2026-11-12T09:30', MX)).toBe(Date.parse('2026-11-12T15:30:00Z'));
    expect(parseLocalIso('tomorrow', MX)).toBeNull();
  });
});

describe('notify_user delivery', () => {
  test('normal priority during quiet hours arrives silently; push is flagged quiet', async () => {
    _setNotifyClock(() => NIGHT);
    const res = await notifyOwner({ text: 'Build finished', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect(res.status).toBe('delivered');
    expect(res.quiet).toBe(true);
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.msg.priority).toBe('low');
    expect(notifications.at(-1)).toMatchObject({ text: 'Build finished', priority: 'normal', quiet: true });
  });

  test('low priority during quiet hours is held until they end', async () => {
    _setNotifyClock(() => NIGHT);
    const res = await notifyOwner({ text: 'FYI', priority: 'low', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect(res.status).toBe('queued');
    expect(res.queuedUntil).toBe(Date.parse('2026-11-12T13:00:00Z'));
    expect(ch.sent).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(queuedNotificationCount()).toBe(1);

    // Still quiet: nothing goes out.
    expect(await flushQueuedNotifications()).toHaveLength(0);
    _setNotifyClock(() => DAY);
    const flushed = await flushQueuedNotifications();
    expect(flushed[0]!.status).toBe('delivered');
    expect(ch.sent[0]!.msg.text).toBe('FYI');
    expect(notifications.at(-1)).toMatchObject({ quiet: false, priority: 'low' });
  });

  test('an early flush (a quiet-hours edit) replaces the armed timer instead of leaking it', async () => {
    const live = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    // Only timers hours away: the held notification's flush, not test plumbing.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = realSet(fn, ms);
      if ((ms ?? 0) > 60 * 60_000) live.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => { live.delete(t); realClear(t); }) as typeof clearTimeout;
    try {
      _setNotifyClock(() => NIGHT);
      await notifyOwner({ text: 'FYI', priority: 'low', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
      expect(live.size).toBe(1);
      await flushQueuedNotifications(); // still quiet: re-armed
      expect(live.size).toBe(1);
      clearNotificationQueue(); // agent stopped: the timer goes, the notification stays held
      expect(live.size).toBe(0);
      expect(queuedNotificationCount()).toBe(1);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
      for (const t of live) realClear(t as ReturnType<typeof setTimeout>);
    }
  });

  test('urgent always rings, on every channel', async () => {
    _setNotifyClock(() => NIGHT);
    const other = fakeChannel();
    registerChannel(other.adapter);
    const res = await notifyOwner({ text: 'Server down', priority: 'urgent', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    unregisterChannel(other.adapter.id);
    expect(res.quiet).toBe(false);
    expect(res.deliveredTo).toEqual(expect.arrayContaining([ch.adapter.id, other.adapter.id]));
    expect(ch.sent[0]!.msg.priority).toBe('urgent');
    expect(notifications.at(-1)!.quiet).toBe(false);
  });

  test('other sessions are named in the message; the tool is open to every session', async () => {
    _setNotifyClock(() => DAY);
    const result = await executeAgentTool('notify_user', { text: 'Tests pass', title: 'CI' }, { sessionId: 'tab-123', sessionName: 'Refactor auth' });
    expect(result.isError).toBeUndefined();
    expect(ch.sent[0]!.msg.text).toBe('[Refactor auth] **CI**\nTests pass');
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ status: 'delivered', deliveredTo: [ch.adapter.id] });
  });

  test('the heartbeat\'s daily cap stops extra messages but not urgent ones', async () => {
    _setNotifyClock(() => DAY);
    patchHeartbeatConfig({ maxMessagesPerDay: 2 });
    const base = { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby', origin: 'heartbeat' as const };
    expect((await notifyOwner({ ...base, text: 'one' })).status).toBe('delivered');
    expect((await notifyOwner({ ...base, text: 'two' })).status).toBe('delivered');
    const third = await notifyOwner({ ...base, text: 'three' });
    expect(third.status).toBe('limited');
    expect(third.error).toContain('2 of its 2');
    expect((await notifyOwner({ ...base, text: 'fire', priority: 'urgent' })).status).toBe('delivered');
    // Messages that don't come from the heartbeat are never capped.
    expect((await notifyOwner({ ...base, origin: 'tool', text: 'asked for' })).status).toBe('delivered');
    patchHeartbeatConfig({ maxMessagesPerDay: 6 });
  });
});

describe('reminders', () => {
  test('a message reminder is delivered verbatim, with no LLM turn, and then retires', async () => {
    _setNotifyClock(() => DAY);
    const reminder = scheduleReminder({ text: 'Call the dentist', inMinutes: 30 });
    expect(reminder).toMatchObject({ mode: 'message', schedule: 'once', status: 'scheduled' });
    const row = repository.getAutomation(reminder.id)!;
    expect(row.triggerType).toBe('once');
    expect(row.targetSessionId).toBeNull();
    expect(parseManagedMeta(row.description)).toMatchObject({ by: 'agent', kind: 'reminder', deletable: true });

    const run = (await fireOnceAutomation(reminder.id))!;
    expect(run.status).toBe('succeeded');
    expect(run.resultText).toContain(ch.adapter.id);
    expect(ch.sent.map(s => s.msg.text)).toEqual(['⏰ Call the dentist']);
    expect(sentToSessions).toHaveLength(0);
    expect(repository.getAutomation(reminder.id)!.enabled).toBe(false);
    expect(listReminders().some(r => r.id === reminder.id)).toBe(false);
    expect(listReminders({ includeDone: true }).find(r => r.id === reminder.id)!.status).toBe('done');
  });

  test('a task reminder wakes the agent session with the text as instructions', async () => {
    const reminder = scheduleReminder({ text: 'Check the flight status', at: new Date(Date.now() + 3_600_000).toISOString(), mode: 'task' });
    const row = repository.getAutomation(reminder.id)!;
    expect(row.targetSessionId).toBe(AGENT_SESSION_ID);

    const run = (await fireOnceAutomation(reminder.id))!;
    expect(run.status).toBe('running');
    expect(sentToSessions).toHaveLength(1);
    expect(sentToSessions[0]!.sessionId).toBe(AGENT_SESSION_ID);
    expect(sentToSessions[0]!.text).toMatch(/^\[Automation · Reminder: Check the flight status · /);
    expect(sentToSessions[0]!.text).toContain('NO_REPLY');
    expect(activeManagedKind(AGENT_SESSION_ID)).toBe('reminder');
    completeAutomationRun(AGENT_SESSION_ID, { resultText: 'NO_REPLY' });
    expect(repository.getRunById(run.id)!.status).toBe('succeeded');
  });

  test('requests the model can fix are refused with a reason', () => {
    expect(() => scheduleReminder({ text: 'x', inMinutes: 5, at: '2026-11-12T09:00:00Z' })).toThrow(ReminderError);
    expect(() => scheduleReminder({ text: 'x', at: '2001-01-01T00:00:00Z' })).toThrow(/in the past/);
    expect(() => scheduleReminder({ text: 'x', at: 'next tuesday' })).toThrow(/ISO-8601/);
    expect(() => scheduleReminder({ text: 'x', cron: '* * * * *' })).toThrow(/every 5 minutes/);
    expect(() => scheduleReminder({ text: 'x', inMinutes: 5, timezone: 'Mars/Base' })).toThrow(/Unknown timezone/);
    expect(() => scheduleReminder({ text: '  ', inMinutes: 5 })).toThrow(/required/);
  });

  test('an offset-less time is read in the agent\'s timezone; recurring ones use cron', () => {
    const at = new Date(Date.now() + 2 * 86_400_000);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: MX, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const reminder = scheduleReminder({ text: 'Standup', at: `${local}T09:15` });
    expect(reminder.at).toBe(`${local}T09:15:00-06:00`);

    const weekly = scheduleReminder({ text: 'Water the plants', cron: '0 9 * * 1' });
    expect(weekly).toMatchObject({ schedule: 'cron', cron: '0 9 * * 1', timezone: MX });
    expect(weekly.nextRunAt).toBeGreaterThan(Date.now());
    expect(cancelReminder(weekly.id)).toBe(true);
    expect(cancelReminder(weekly.id)).toBe(false);
    cancelReminder(reminder.id);
  });

  test('cancel_reminder only touches reminders', async () => {
    const plain = repository.createAutomation({
      name: 'Not a reminder', triggerType: 'cron', cronExpression: '0 9 * * *', timezone: 'UTC', enabled: false,
      prompt: 'x', cwd: '/tmp', provider: 'claude', permissionMode: 'default', concurrencyPolicy: 'skip',
    }, null);
    const res = await executeAgentTool('cancel_reminder', { id: plain.id }, { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect(res.isError).toBe(true);
    expect(repository.getAutomation(plain.id)).not.toBeNull();
  });

  test('reminder tools are the agent\'s only', async () => {
    const res = await executeAgentTool('schedule_reminder', { text: 'x', inMinutes: 5 }, { sessionId: 'tab-1', sessionName: 'Tab' });
    expect(res.isError).toBe(true);
    const ok = await executeAgentTool('schedule_reminder', { text: 'Stretch', inMinutes: 45, at: '' }, { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect(ok.isError).toBeUndefined();
    const id = /aut_[\w-]+/.exec((ok.content[0] as { text: string }).text)![0];
    const listed = await executeAgentTool('list_reminders', {}, { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect((listed.content[0] as { text: string }).text).toContain(id);
    cancelReminder(id);
  });
});

describe('heartbeat', () => {
  test('heartbeat.json drives managed automations that target the agent session', () => {
    patchHeartbeatConfig({ enabled: true, interval: '0 9-17 * * *', morningBrief: { enabled: false } });
    const rows = syncManagedAutomations();
    const hb = rows.heartbeat!;
    expect(hb).toMatchObject({ enabled: true, cronExpression: '0 9-17 * * *', timezone: MX, targetSessionId: AGENT_SESSION_ID, triggerType: 'cron' });
    expect(parseManagedMeta(hb.description)).toMatchObject({ by: 'agent', kind: 'heartbeat', editHint: 'Agent › Heartbeat' });
    expect(hb.prompt).toContain('NO_REPLY');
    expect(hb.nextRunAt).toBeGreaterThan(Date.now());
    expect(rows.morning_brief).toBeNull();

    // Same row retuned, never a second one.
    patchHeartbeatConfig({ interval: '30 8-20 * * *', morningBrief: { enabled: true, time: '06:45' } });
    const next = syncManagedAutomations();
    expect(next.heartbeat!.id).toBe(hb.id);
    expect(next.heartbeat!.cronExpression).toBe('30 8-20 * * *');
    expect(next.morning_brief!.cronExpression).toBe(briefCron('06:45'));
    expect(briefCron('06:45')).toBe('45 6 * * *');

    // Turning it off pauses the row (history stays), it is not deleted.
    patchHeartbeatConfig({ enabled: false });
    const off = syncManagedAutomations();
    expect(off.heartbeat!.id).toBe(hb.id);
    expect(off.heartbeat!.enabled).toBe(false);
    expect(off.heartbeat!.nextRunAt).toBeNull();
  });

  test('a disabled agent pauses every managed schedule, and its runs are vetoed', async () => {
    patchHeartbeatConfig({ enabled: true, morningBrief: { enabled: true } });
    expect(syncManagedAutomations().heartbeat!.enabled).toBe(true);
    setAgent({ enabled: false });
    const rows = syncManagedAutomations();
    expect(rows.heartbeat!.enabled).toBe(false);
    expect(rows.morning_brief!.enabled).toBe(false);
    const run = (await runAutomation(rows.heartbeat!, 'manual'))!;
    expect(run).toMatchObject({ status: 'skipped', error: 'The agent is disabled on this host' });
    setAgent({ enabled: true });
    patchHeartbeatConfig({ enabled: false, morningBrief: { enabled: false } });
    syncManagedAutomations();
  });

  test('run now drives a turn in the agent session; its notify_user counts against the cap', async () => {
    _setNotifyClock(() => DAY);
    const { run } = await runManagedNow('heartbeat');
    expect(run!.status).toBe('running');
    expect(sentToSessions[0]!.text).toMatch(/^\[Automation · Heartbeat · /);
    expect(activeManagedKind(AGENT_SESSION_ID)).toBe('heartbeat');

    await executeAgentTool('notify_user', { text: 'Meeting in 20 min' }, { sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    const status = await handleAgentRoute(new Request('http://x/agent/heartbeat'), new URL('http://x/agent/heartbeat'), true);
    const body = await status!.json() as { today: { sent: number }; heartbeat: { runs: { status: string }[] } };
    expect(body.today.sent).toBe(1);
    expect(body.heartbeat.runs[0]!.status).toBe('running');

    // A second "run now" while the first is going is skipped, not stacked.
    const again = await runManagedNow('heartbeat');
    expect(again.run!.status).toBe('skipped');
    completeAutomationRun(AGENT_SESSION_ID, { resultText: 'NO_REPLY' });
    expect(repository.getRunById(run!.id)!.status).toBe('succeeded');
  });
});

describe('routes and prompt', () => {
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`);
    const res = await handleAgentRoute(new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }), url, true);
    return { status: res!.status, body: await res!.json() as any };
  };

  test('PUT /agent/heartbeat validates strictly', async () => {
    expect((await call('PUT', '/agent/heartbeat', { interval: '*/2 * * * *' })).status).toBe(400);
    expect((await call('PUT', '/agent/heartbeat', { interval: 'not cron' })).status).toBe(400);
    expect((await call('PUT', '/agent/heartbeat', { maxMessagesPerDay: -1 })).status).toBe(400);
    expect((await call('PUT', '/agent/heartbeat', { surprise: true })).status).toBe(400);
    const ok = await call('PUT', '/agent/heartbeat', { checklist: 'Look at the calendar.', morningBrief: { time: '07:05' } });
    expect(ok.status).toBe(200);
    expect(ok.body.config.checklist).toBe('Look at the calendar.');
    expect(ok.body.config.morningBrief.time).toBe('07:05');
    expect(ok.body.quietHours).toMatchObject({ enabled: true, start: '23:00' });
  });

  test('reminder routes list and cancel', async () => {
    const reminder = scheduleReminder({ text: 'Pay rent', inMinutes: 120 });
    const list = await call('GET', '/agent/reminders');
    expect(list.body.reminders.some((r: { id: string }) => r.id === reminder.id)).toBe(true);
    expect((await call('DELETE', `/agent/reminders/${reminder.id}`)).status).toBe(200);
    expect((await call('DELETE', `/agent/reminders/${reminder.id}`)).status).toBe(404);
    expect((await call('DELETE', '/agent/reminders/..%2Fetc')).status).toBe(400);
    expect((await call('POST', '/agent/heartbeat/run', { kind: 'nap' })).status).toBe(400);
  });

  test('the agent prompt explains reminders and quiet hours', () => {
    const prompt = agentSystemPrompt(ensureAgentSession())!;
    expect(prompt).toContain('## Reminders and proactivity');
    expect(prompt).toContain('23:00–07:00 (America/Mexico_City)');
    expect(prompt).toContain('NO_REPLY');
  });
});

describe('agent config changes', () => {
  const putConfig = async (body: unknown) => {
    const url = new URL('http://x/agent/config');
    const res = await handleAgentRoute(new Request(url, { method: 'PUT', body: JSON.stringify(body) }), url, true);
    return res!.status;
  };
  const settle = () => new Promise(r => setTimeout(r, 20));

  test('a new timezone re-times the heartbeat and the morning brief at once', async () => {
    patchHeartbeatConfig({ enabled: true, interval: '0 9 * * *', morningBrief: { enabled: true, time: '07:30' } });
    syncManagedAutomations();
    expect(managedAutomation('heartbeat')!.timezone).toBe(MX);
    expect(await putConfig({ persona: { ...loadAgentConfig().persona, timezone: 'Europe/Madrid' } })).toBe(200);
    // No waiting for the five-minute reconcile.
    expect(managedAutomation('heartbeat')!.timezone).toBe('Europe/Madrid');
    expect(managedAutomation('morning_brief')!.timezone).toBe('Europe/Madrid');
  });

  test('quiet hours moved keep holding; turned off, what they held goes out now', async () => {
    _setNotifyClock(() => NIGHT);
    await notifyOwner({ text: 'FYI', priority: 'low', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    expect(queuedNotificationCount()).toBe(1);

    expect(await putConfig({ quietHours: { enabled: true, start: '22:00', end: '08:00' } })).toBe(200);
    await settle();
    expect(queuedNotificationCount()).toBe(1);
    expect(ch.sent).toHaveLength(0);

    expect(await putConfig({ quietHours: { enabled: false, start: '22:00', end: '08:00' } })).toBe(200);
    await settle();
    expect(queuedNotificationCount()).toBe(0);
    expect(ch.sent.map(s => s.msg.text)).toEqual(['FYI']);
  });

  test('edits that touch neither leave held notifications alone', async () => {
    _setNotifyClock(() => NIGHT);
    await notifyOwner({ text: 'Later', priority: 'low', sessionId: AGENT_SESSION_ID, sessionName: 'Codiby' });
    const before = loadAgentConfig();
    handleAgentConfigChanged({ ...before, owner: { ...before.owner, name: 'Someone' } }, before);
    await settle();
    expect(queuedNotificationCount()).toBe(1);
    expect(ch.sent).toHaveLength(0);
  });
});
