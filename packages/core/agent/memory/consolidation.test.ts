import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { MAIN_SESSION_ID } from '../../config/config';
import { addMessage, updateSessionState } from '../../session/state';
import { emitAgentTurnComplete, runBeforeThreadRotate } from '../registry';
import { _setAgentDepsForTest } from '../runtime';
import { ensureAgentSession, rotateAgentThread } from '../session';
import type { AgentDeps } from '../types';
import { _pendingTurnWaitersForTest, consolidateBeforeRotate, consolidationPrompt, hasConversationSince } from './consolidation';
import { IDLE_BEFORE_ROTATION_MS, holdWhileRotating, isControlMessage, planDailyRotation, type PlanInput } from './rotation';
import { memorySettingsStore, memoryStateStore, normalizeMemorySettings, normalizeMemoryState } from './settings';
import { latestSlot, nextSlot, zonedEpoch } from './tz';
import './index';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(5);
  }
}

function fakeDeps(onSend?: (text: string) => void, result: { ok: boolean; error?: string } = { ok: true }) {
  const sent: string[] = [];
  const deps: AgentDeps = {
    port: 0,
    async sendMessage(sessionId, text) {
      expect(sessionId).toBe(MAIN_SESSION_ID);
      sent.push(text);
      onSend?.(text);
      return result;
    },
    interruptSession() {},
    broadcastToSession() {},
    broadcastSessionList() {},
  };
  _setAgentDepsForTest(deps);
  return sent;
}

/** An agent thread with one exchange newer than the last rotation. */
function liveThread() {
  const session = ensureAgentSession();
  session.claudeSessionId = 'thread-under-test';
  memoryStateStore.set({ ...normalizeMemoryState(null), lastRotatedAt: Date.now() - 60_000 });
  addMessage(MAIN_SESSION_ID, { id: randomUUID(), role: 'user', content: 'Me encanta el café de olla', timestamp: Date.now() });
  addMessage(MAIN_SESSION_ID, { id: randomUUID(), role: 'assistant', content: 'Anotado.', timestamp: Date.now() });
}

describe('consolidation before rotation', () => {
  beforeEach(() => {
    memorySettingsStore.set(normalizeMemorySettings(null));
    updateSessionState(MAIN_SESSION_ID, s => ({ ...s, isStreaming: false, wasInterrupted: false }));
  });

  afterEach(() => {
    _setAgentDepsForTest(null);
  });

  test('asks the agent to save what it learned, then waits for its turn', async () => {
    liveThread();
    const sent = fakeDeps(() => setTimeout(() => emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] }), 20));
    const outcome = await consolidateBeforeRotate('New conversation', { timeoutMs: 2_000 });
    expect(outcome).toBe('done');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('remember');
    expect(sent[0]).toContain('update_profile');
    expect(sent[0]).toMatch(/reply with exactly NO_REPLY/);
    const state = memoryStateStore.get();
    expect(state.lastConsolidation).toMatchObject({ reason: 'New conversation', outcome: 'done' });
    // The consolidation exchange itself is older than the new rotation stamp.
    expect(hasConversationSince(state.lastRotatedAt)).toBe(false);
  });

  test('the rotate hook blocks rotation until the agent turn completes', async () => {
    liveThread();
    const sent = fakeDeps();
    let released = false;
    const rotation = runBeforeThreadRotate({ reason: 'Daily fresh start' }).then(() => { released = true; });
    await until(() => sent.length === 1);
    await sleep(30);
    expect(released).toBe(false);
    emitAgentTurnComplete('some-other-session', { texts: [] });
    await sleep(10);
    expect(released).toBe(false);
    emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] });
    await rotation;
    expect(released).toBe(true);
  });

  test('a stuck turn times out and lets the rotation go ahead', async () => {
    liveThread();
    fakeDeps();
    const started = Date.now();
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 60 })).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(memoryStateStore.get().lastConsolidation?.outcome).toBe('timeout');
  });

  test('waits for a turn already in progress before sending its own message', async () => {
    liveThread();
    updateSessionState(MAIN_SESSION_ID, s => ({ ...s, isStreaming: true }));
    const sent = fakeDeps(() => setTimeout(() => emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] }), 10));
    const pending = consolidateBeforeRotate('New conversation', { timeoutMs: 2_000 });
    await sleep(30);
    expect(sent).toHaveLength(0);
    updateSessionState(MAIN_SESSION_ID, s => ({ ...s, isStreaming: false }));
    emitAgentTurnComplete(MAIN_SESSION_ID, { texts: ['the owner’s answer'] });
    expect(await pending).toBe('done');
    expect(sent).toHaveLength(1);
  });

  test('concurrent rotations share one consolidation turn', async () => {
    liveThread();
    const sent = fakeDeps(() => setTimeout(() => emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] }), 20));
    const [a, b] = await Promise.all([
      consolidateBeforeRotate('New conversation', { timeoutMs: 2_000 }),
      consolidateBeforeRotate('Daily fresh start', { timeoutMs: 2_000 }),
    ]);
    expect([a, b]).toEqual(['done', 'done']);
    expect(sent).toHaveLength(1);
  });

  test('skips when nothing happened since the last rotation, or when turned off', async () => {
    liveThread();
    const sent = fakeDeps();
    memoryStateStore.update(s => ({ ...s, lastRotatedAt: Date.now() + 1_000 }));
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 50 })).toBe('nothing_new');
    liveThread();
    memorySettingsStore.set({ ...normalizeMemorySettings(null), consolidateOnRotate: false });
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 50 })).toBe('disabled');
    expect(sent).toHaveLength(0);
  });

  test('a message that cannot be delivered fails fast', async () => {
    liveThread();
    fakeDeps(undefined, { ok: false, error: 'Provider failed to start' });
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 5_000 })).toBe('failed');
    expect(_pendingTurnWaitersForTest()).toBe(0);
  });

  test('a send that throws fails fast and leaves no turn waiter behind', async () => {
    liveThread();
    _setAgentDepsForTest({
      port: 0,
      async sendMessage() { throw new Error('bridge went away'); },
      interruptSession() {},
      broadcastToSession() {},
      broadcastSessionList() {},
    });
    const started = Date.now();
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 5_000 })).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(_pendingTurnWaitersForTest()).toBe(0);
    expect(memoryStateStore.get().lastConsolidation?.outcome).toBe('failed');
  });

  test('a consolidation turn that completes with a failure is failed, not done', async () => {
    liveThread();
    fakeDeps(() => setTimeout(() => emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [], failure: 'Not logged in · Please run /login' }), 10));
    expect(await consolidateBeforeRotate('New conversation', { timeoutMs: 2_000 })).toBe('failed');
    expect(memoryStateStore.get().lastConsolidation).toMatchObject({ outcome: 'failed', saved: 0 });
    expect(_pendingTurnWaitersForTest()).toBe(0);
  });

  test('an owner turn that ends in a failure still counts as finished before consolidating', async () => {
    liveThread();
    updateSessionState(MAIN_SESSION_ID, s => ({ ...s, isStreaming: true }));
    const sent = fakeDeps(() => setTimeout(() => emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] }), 10));
    const pending = consolidateBeforeRotate('New conversation', { timeoutMs: 2_000 });
    await sleep(20);
    expect(sent).toHaveLength(0);
    updateSessionState(MAIN_SESSION_ID, s => ({ ...s, isStreaming: false }));
    emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [], failure: 'The agent\'s turn was interrupted before it finished.' });
    expect(await pending).toBe('done');
    expect(sent).toHaveLength(1);
  });

  test('an owner message sent mid-consolidation waits for the fresh thread', async () => {
    liveThread();
    const sent = fakeDeps();
    // The real path: rotateAgentThread runs the consolidation as its before-rotate hook.
    const rotation = rotateAgentThread('New conversation');
    await until(() => sent.length === 1);
    let delivered = false;
    let threadWhenReleased: string | null | undefined;
    const held = holdWhileRotating('hola, ¿me ayudas con algo?').then(() => {
      delivered = true;
      threadWhenReleased = ensureAgentSession().claudeSessionId;
    });
    // Commands and approval codes pass straight through: the consolidation may be waiting on one.
    await holdWhileRotating('/new');
    await holdWhileRotating('SI 4821');
    await sleep(20);
    expect(delivered).toBe(false);
    emitAgentTurnComplete(MAIN_SESSION_ID, { texts: [] });
    await held;
    await rotation;
    // Released only once the old thread was gone, without polling for it.
    expect(delivered).toBe(true);
    expect(threadWhenReleased).toBeNull();
    // Nothing to wait for once the rotation is over.
    const started = Date.now();
    await holdWhileRotating('hola otra vez');
    expect(Date.now() - started).toBeLessThan(50);
  });

  test('control messages are recognised', () => {
    for (const t of ['/new', ' /status', 'SI 4821', 'sí 4821', 'no 1234', 'YES 99999']) expect(isControlMessage(t)).toBe(true);
    for (const t of ['si', 'no sé', 'hola', 'yes please', 'NO 12']) expect(isControlMessage(t)).toBe(false);
  });

  test('the prompt names the reason and never asks to message anyone', () => {
    const p = consolidationPrompt('Daily fresh start');
    expect(p.startsWith('[Memory · before a fresh thread — Daily fresh start]')).toBe(true);
    expect(p).toContain("Don't message anyone");
  });
});

describe('daily rotation plan', () => {
  // Mazatlán is UTC-7 all year: 04:00 local = 11:00Z.
  const TZ = 'America/Mazatlan';
  const day = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m);
  const base = (over: Partial<PlanInput> = {}): PlanInput => ({
    now: day(12, 12), // 05:00 local, an hour after today's slot
    settings: normalizeMemorySettings(null),
    timezone: TZ,
    lastDailySlot: day(11, 11),
    lastActivityAt: day(12, 2), // 19:00 local yesterday
    busy: false,
    hasNew: true,
    ...over,
  });

  test('rotates once the slot passed and the owner has been quiet for two hours', () => {
    expect(planDailyRotation(base())).toEqual({ action: 'rotate', slot: day(12, 11) });
  });

  test('waits for quiet when the owner was active recently', () => {
    // Last message 90 min ago: look again right when the two quiet hours are up.
    const plan = planDailyRotation(base({ lastActivityAt: day(12, 10, 30) }));
    expect(plan).toMatchObject({ action: 'defer', why: 'active', slot: day(12, 11) });
    expect((plan as { wakeAt: number }).wakeAt).toBe(day(12, 10, 30) + IDLE_BEFORE_ROTATION_MS + 60_000);
    // Further away than an hour: wake hourly anyway, to pick up config changes.
    const later = planDailyRotation(base({ lastActivityAt: day(12, 11, 50) }));
    expect((later as { wakeAt: number }).wakeAt).toBe(day(12, 13));
  });

  test('defers while a turn or approval is in flight', () => {
    expect(planDailyRotation(base({ busy: true }))).toMatchObject({ action: 'defer', why: 'busy' });
  });

  test('skips (and remembers the slot) when nothing is new', () => {
    expect(planDailyRotation(base({ hasNew: false }))).toMatchObject({ action: 'skip', slot: day(12, 11) });
  });

  test('does nothing until the next slot once this one is handled', () => {
    const plan = planDailyRotation(base({ lastDailySlot: day(12, 11) }));
    expect(plan.action).toBe('wait');
    expect((plan as { wakeAt: number }).wakeAt).toBeLessThanOrEqual(day(12, 13)); // wakes at least hourly
  });

  test('a first run only records the baseline', () => {
    expect(planDailyRotation(base({ lastDailySlot: null }))).toMatchObject({ action: 'baseline', slot: day(12, 11) });
  });

  test('turned off: sleeps', () => {
    expect(planDailyRotation(base({ settings: { ...normalizeMemorySettings(null), dailyRotation: { enabled: false, time: '04:00' } } })).action).toBe('disabled');
  });

  test('a bad timezone falls back to UTC instead of throwing', () => {
    expect(planDailyRotation(base({ timezone: 'Mars/Olympus' }))).toEqual({ action: 'rotate', slot: day(12, 4) });
  });
});

describe('time zones', () => {
  test('slots follow the owner timezone', () => {
    const now = Date.UTC(2026, 10, 12, 12, 0); // 05:00 in Mazatlán
    expect(latestSlot(now, '04:00', 'America/Mazatlan')).toBe(Date.UTC(2026, 10, 12, 11, 0));
    expect(nextSlot(now, '04:00', 'America/Mazatlan')).toBe(Date.UTC(2026, 10, 13, 11, 0));
    const early = Date.UTC(2026, 10, 12, 10, 0); // 03:00 local: today's slot is still ahead
    expect(latestSlot(early, '04:00', 'America/Mazatlan')).toBe(Date.UTC(2026, 10, 11, 11, 0));
    expect(nextSlot(early, '04:00', 'America/Mazatlan')).toBe(Date.UTC(2026, 10, 12, 11, 0));
  });

  test('handles DST changes and month rollover', () => {
    // New York springs forward on 8 March 2026: 04:00 is EST the day before, EDT that day.
    expect(nextSlot(Date.UTC(2026, 2, 7, 10, 0), '04:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 8, 0));
    expect(zonedEpoch(2026, 3, 7, 4, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 7, 9, 0));
    // 02:30 doesn't exist that night: run just after the jump (03:30 EDT).
    expect(zonedEpoch(2026, 3, 8, 2, 30, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(nextSlot(Date.UTC(2026, 0, 31, 23, 0), '04:00', 'UTC')).toBe(Date.UTC(2026, 1, 1, 4, 0));
  });
});
