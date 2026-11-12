import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { sessions } from '../session/sessions';
import { updateSessionState } from '../session/state';
import type { Session } from '../types';
import { encodeManagedMeta, registerManagedRunHandler } from './managed';
import * as repository from './repository';
import {
  _resetAutomationRunnerForTest,
  cancelAutomationRun,
  completeAutomationRun,
  configureAutomationRunner,
  failAutomationRun,
  isSessionBusy,
  runAutomation,
} from './runner';
import {
  fireOnceAutomation,
  isScheduled,
  ONCE_BUSY_RETRIES,
  ONCE_BUSY_RETRY_MS,
  ONCE_GRACE_MS,
  scheduleAutomation,
  unscheduleAutomation,
} from './scheduler';
import type { AutomationCreate } from './types';

const sent: { sessionId: string; text: string }[] = [];
const interrupted: string[] = [];
const closed: string[] = [];

function fakeSession(id = `tab-${randomUUID().slice(0, 8)}`): Session {
  const session = {
    id,
    name: `Tab ${id}`,
    cwd: '/tmp/tab',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUserMessageAt: 0,
    claudeSessionId: null,
    browserWs: new Set(),
    providerSession: {
      close: async () => { closed.push(id); },
      interrupt: async () => {},
    },
    providerSessionGen: 0,
    ready: true,
    status: 'open',
    runtimeStatus: 'running',
    replayDone: true,
    savedCommands: [],
    model: null,
    permissionMode: 'default',
    effort: null,
    provider: 'claude',
    remoteId: null,
    portForwards: [],
  } as unknown as Session;
  sessions.set(id, session);
  return session;
}

function automation(overrides: Partial<AutomationCreate> = {}) {
  return repository.createAutomation({
    name: `Targeted ${randomUUID().slice(0, 6)}`,
    description: null,
    triggerType: 'cron',
    cronExpression: '0 9 * * *',
    runAt: null,
    timezone: 'UTC',
    enabled: true,
    prompt: 'Check the build',
    targetSessionId: null,
    cwd: '/tmp/project',
    provider: 'claude',
    model: null,
    permissionMode: 'default',
    effort: null,
    concurrencyPolicy: 'skip',
    maxRuntimeMs: null,
    ...overrides,
  }, null);
}

beforeEach(() => {
  sent.length = 0;
  interrupted.length = 0;
  closed.length = 0;
  _resetAutomationRunnerForTest();
  configureAutomationRunner({
    port: 0,
    async sendMessage(sessionId, text) {
      sent.push({ sessionId, text });
      return { ok: true };
    },
    broadcastSessionList() {},
    async interruptSession(sessionId) { interrupted.push(sessionId); },
  });
});

afterEach(() => _resetAutomationRunnerForTest());

describe('targeted runs', () => {
  test('continue the existing session, labelled as a scheduled turn, and settle only from that session', async () => {
    const tab = fakeSession();
    const a = automation({ targetSessionId: tab.id, name: 'Nightly check' });

    const run = (await runAutomation(a, 'manual'))!;
    expect(run.status).toBe('running');
    expect(run.sessionId).toBe(tab.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe(tab.id);
    expect(sent[0]!.text).toMatch(/^\[Automation · Nightly check · .+\]\nCheck the build$/);
    expect(isSessionBusy(tab.id)).toBe(true);

    // Another session finishing a turn has nothing to do with this run.
    completeAutomationRun(`other-${randomUUID()}`, { resultText: 'unrelated' });
    expect(repository.getRunById(run.id)!.status).toBe('running');

    completeAutomationRun(tab.id, { resultText: 'Build is green', costUsd: 0.01 });
    expect(repository.getRunById(run.id)).toMatchObject({ status: 'succeeded', resultText: 'Build is green' });
    expect(isSessionBusy(tab.id)).toBe(false);
    // A later turn in the same session (the person typing) settles nothing.
    completeAutomationRun(tab.id, { resultText: 'later' });
    expect(repository.getRunById(run.id)!.resultText).toBe('Build is green');
  });

  test('skip with a reason when the session is mid-turn, and never pile two runs onto one session', async () => {
    const tab = fakeSession();
    updateSessionState(tab.id, s => ({ ...s, isStreaming: true }));
    const busy = (await runAutomation(automation({ targetSessionId: tab.id }), 'scheduled', Date.now()))!;
    expect(busy.status).toBe('skipped');
    expect(busy.error).toContain('in the middle of a turn');
    expect(sent).toHaveLength(0);

    updateSessionState(tab.id, s => ({ ...s, isStreaming: false }));
    const first = (await runAutomation(automation({ targetSessionId: tab.id }), 'manual'))!;
    const second = (await runAutomation(automation({ targetSessionId: tab.id }), 'manual'))!;
    expect(first.status).toBe('running');
    expect(second.status).toBe('skipped');
    expect(sent).toHaveLength(1);
  });

  test('cancel interrupts the turn and never closes the borrowed session', async () => {
    const tab = fakeSession();
    const a = automation({ targetSessionId: tab.id });
    const run = (await runAutomation(a, 'manual'))!;

    expect(await cancelAutomationRun(a.id, run.id)).toBe(true);
    expect(interrupted).toEqual([tab.id]);
    expect(closed).toEqual([]);
    expect(repository.getRunById(run.id)!.status).toBe('cancelled');

    // The interrupted turn reports back afterwards; it must not resurrect the run.
    completeAutomationRun(tab.id, { stopReason: 'interrupted' });
    expect(repository.getRunById(run.id)!.status).toBe('cancelled');
    expect(isSessionBusy(tab.id)).toBe(false);
  });

  test('a timeout interrupts instead of closing', async () => {
    const tab = fakeSession();
    const a = automation({ targetSessionId: tab.id, maxRuntimeMs: 1_000 });
    const run = (await runAutomation(a, 'manual'))!;
    await new Promise(r => setTimeout(r, 1_100));
    expect(repository.getRunById(run.id)!.status).toBe('timed_out');
    expect(interrupted).toEqual([tab.id]);
    expect(closed).toEqual([]);
  });

  test('a turn cut short by the person is recorded as cancelled; a provider error fails it', async () => {
    const tab = fakeSession();
    const cut = (await runAutomation(automation({ targetSessionId: tab.id }), 'manual'))!;
    completeAutomationRun(tab.id, { stopReason: 'interrupted' });
    expect(repository.getRunById(cut.id)).toMatchObject({ status: 'cancelled', error: 'Interrupted before it finished' });

    const crashed = (await runAutomation(automation({ targetSessionId: tab.id }), 'manual'))!;
    failAutomationRun(tab.id, 'Provider exited with code 1');
    expect(repository.getRunById(crashed.id)).toMatchObject({ status: 'failed', error: 'Provider exited with code 1' });
  });

  test('a target that no longer exists fails the run instead of spawning a session', async () => {
    const run = (await runAutomation(automation({ targetSessionId: 'gone-session' }), 'manual'))!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no longer exists');
    expect(sent).toHaveLength(0);
  });
});

describe('managed run hooks', () => {
  test('a direct handler runs in code, and a veto records a skip', async () => {
    let vetoed = false;
    registerManagedRunHandler('test-owner', {
      skipReason: () => (vetoed ? 'Owner is off' : null),
      isDirect: meta => meta.kind === 'ping',
      runDirect: async () => ({ ok: true, resultText: 'pong' }),
    });
    const a = automation({ description: encodeManagedMeta({ by: 'test-owner', kind: 'ping', label: 'Ping' }) });

    const run = (await runAutomation(a, 'manual'))!;
    expect(run).toMatchObject({ status: 'succeeded', resultText: 'pong', sessionId: null });
    expect(sent).toHaveLength(0);

    vetoed = true;
    const skipped = (await runAutomation(a, 'manual'))!;
    expect(skipped).toMatchObject({ status: 'skipped', error: 'Owner is off' });
  });
});

describe('one-shot automations', () => {
  test('fire once at runAt, then disable themselves and keep the row', async () => {
    const tab = fakeSession();
    const runAt = Date.now() + 3_600_000;
    const a = automation({ triggerType: 'once', cronExpression: null, runAt, targetSessionId: tab.id });
    scheduleAutomation(a);
    expect(repository.getAutomation(a.id)!.nextRunAt).toBe(runAt);
    expect(isScheduled(a.id)).toBe(true);

    const run = (await fireOnceAutomation(a.id))!;
    expect(run.status).toBe('running');
    expect(run.scheduledFor).toBe(runAt);
    const after = repository.getAutomation(a.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(isScheduled(a.id)).toBe(false);

    // Disabled: a stray second fire does nothing.
    expect(await fireOnceAutomation(a.id)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test('missed by more than the grace window while offline: recorded as skipped, not fired', () => {
    const a = automation({ triggerType: 'once', cronExpression: null, runAt: Date.now() - ONCE_GRACE_MS - 60_000 });
    scheduleAutomation(a, { boot: true });
    const [run] = repository.listRuns(a.id, { limit: 5 });
    expect(run!.status).toBe('skipped');
    expect(run!.error).toMatch(/^Missed while offline/);
    expect(repository.getAutomation(a.id)!.enabled).toBe(false);
    expect(isScheduled(a.id)).toBe(false);
  });

  test('overdue within the grace window: fired on boot (after a short delay)', async () => {
    const tab = fakeSession();
    const runAt = Date.now() - 3_600_000;
    const a = automation({ triggerType: 'once', cronExpression: null, runAt, targetSessionId: tab.id });
    scheduleAutomation(a, { boot: true });
    expect(isScheduled(a.id)).toBe(true);
    expect(repository.getAutomation(a.id)!.nextRunAt).toBe(runAt);
    expect(repository.listRuns(a.id, { limit: 5 })).toHaveLength(0);

    const run = (await fireOnceAutomation(a.id))!;
    expect(run.status).toBe('running');
    expect(run.scheduledFor).toBe(runAt);
  });

  test('a busy target is retried every minute, then skipped after the last retry', async () => {
    const tab = fakeSession();
    updateSessionState(tab.id, s => ({ ...s, isStreaming: true }));
    const a = automation({ triggerType: 'once', cronExpression: null, runAt: Date.now(), targetSessionId: tab.id });

    const before = Date.now();
    expect(await fireOnceAutomation(a.id, 0)).toBeNull();
    const waiting = repository.getAutomation(a.id)!;
    expect(waiting.enabled).toBe(true);
    expect(waiting.nextRunAt!).toBeGreaterThanOrEqual(before + ONCE_BUSY_RETRY_MS);
    expect(isScheduled(a.id)).toBe(true);
    expect(repository.listRuns(a.id, { limit: 5 })).toHaveLength(0);
    unscheduleAutomation(a.id);

    const last = (await fireOnceAutomation(a.id, ONCE_BUSY_RETRIES))!;
    expect(last.status).toBe('skipped');
    expect(last.error).toContain(`still busy after ${ONCE_BUSY_RETRIES} retries`);
    expect(repository.getAutomation(a.id)!.enabled).toBe(false);
    updateSessionState(tab.id, s => ({ ...s, isStreaming: false }));
  });
});
