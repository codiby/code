import { Cron } from 'croner';
import type { AutomationRecord, AutomationRunRecord } from '../database/schema';
import { log, logError } from '../lib/logger';
import { sessions } from '../session/sessions';
import {
  createRun,
  failInterruptedRuns,
  getAutomation,
  listEnabledAutomations,
  setAutomationNextRun,
  updateAutomation,
} from './repository';
import { isSessionBusy, runAutomation } from './runner';

/** What `jobs` holds: a croner job, or one of our own timers. */
interface Job {
  stop(): void;
}

const jobs = new Map<string, Job>();

/** A one-shot automation the bridge missed by more than this is recorded as missed, not fired late. */
export const ONCE_GRACE_MS = 6 * 60 * 60_000;
/** A one-shot run whose target session is busy waits this long between attempts… */
export const ONCE_BUSY_RETRY_MS = 60_000;
/** …this many times, before it is recorded as skipped. */
export const ONCE_BUSY_RETRIES = 10;
/**
 * Overdue one-shot runs found at boot wait this long, so channels can
 * reconnect and the agent session can come up before a reminder goes out.
 */
const BOOT_CATCH_UP_DELAY_MS = 15_000;
/** setTimeout's ceiling (~24.8 days); longer waits re-arm in steps. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function nextRunFor(cronExpression: string, timezone: string, after?: Date): number | null {
  const cron = new Cron(cronExpression, { timezone, paused: true });
  try {
    return cron.nextRun(after)?.getTime() ?? null;
  } finally {
    cron.stop();
  }
}

/** The `nextRunAt` a definition should carry right after it is saved. */
export function plannedNextRun(automation: Pick<AutomationRecord, 'enabled' | 'triggerType' | 'cronExpression' | 'timezone' | 'runAt'>): number | null {
  if (!automation.enabled) return null;
  if (automation.triggerType === 'cron' && automation.cronExpression) return nextRunFor(automation.cronExpression, automation.timezone);
  if (automation.triggerType === 'once') return automation.runAt ?? null;
  return null;
}

/**
 * Fire `fn` at wall-clock time `at`. Re-arms in steps instead of trusting one
 * long timeout, so waits past setTimeout's ceiling work and a machine that
 * slept wakes up to a timer measured against the real clock.
 */
function timerAt(at: number, fn: () => void): Job {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    const wait = Math.max(0, at - Date.now());
    handle = setTimeout(() => {
      if (stopped) return;
      if (Date.now() < at) arm(); else fn();
    }, Math.min(wait, MAX_TIMEOUT_MS));
  };
  arm();
  return { stop() { stopped = true; if (handle) clearTimeout(handle); } };
}

export function startAutomationScheduler(): void {
  const interrupted = failInterruptedRuns();
  if (interrupted) log(`[automation] Marked ${interrupted} interrupted runs as failed`);
  for (const automation of listEnabledAutomations()) scheduleAutomation(automation, { boot: true });
  log(`[automation] Scheduler started with ${jobs.size} jobs`);
}

export function scheduleAutomation(automation: AutomationRecord, options: { boot?: boolean } = {}): void {
  unscheduleAutomation(automation.id);
  if (!automation.enabled || automation.deletedAt) {
    setAutomationNextRun(automation.id, null);
    return;
  }
  if (automation.triggerType === 'once') {
    scheduleOnce(automation, options.boot ?? false);
    return;
  }
  // Webhook automations have no timer of their own — they only run when someone
  // POSTs to their endpoint, so they never hold a job or a `nextRunAt`.
  if (automation.triggerType !== 'cron' || !automation.cronExpression) {
    setAutomationNextRun(automation.id, null);
    return;
  }

  let job: Cron;
  job = new Cron(automation.cronExpression, {
    timezone: automation.timezone,
    protect: true,
    catch: error => logError(`[automation:${automation.id}] Scheduler error: ${error}`),
  }, async () => {
    const scheduledFor = Math.floor(Date.now() / 1000) * 1000;
    await runAutomation(automation, 'scheduled', scheduledFor);
    setAutomationNextRun(automation.id, job.nextRun()?.getTime() ?? null);
  });
  jobs.set(automation.id, job);
  setAutomationNextRun(automation.id, job.nextRun()?.getTime() ?? null);
}

/**
 * One-shot automations. Future: a timer for `runAt`. Past: the bridge was
 * down (or the row was just saved a moment late) — fire now when it is
 * less than ONCE_GRACE_MS late, otherwise record the miss and retire it.
 */
function scheduleOnce(automation: AutomationRecord, boot: boolean, now = Date.now()): void {
  const runAt = automation.runAt;
  if (!runAt) {
    setAutomationNextRun(automation.id, null);
    return;
  }
  if (runAt > now) {
    jobs.set(automation.id, timerAt(runAt, () => void fireOnceAutomation(automation.id)));
    setAutomationNextRun(automation.id, runAt);
    return;
  }
  if (now - runAt >= ONCE_GRACE_MS) {
    recordMissedOnce(automation, now);
    return;
  }
  setAutomationNextRun(automation.id, runAt);
  const at = boot ? now + BOOT_CATCH_UP_DELAY_MS : now;
  jobs.set(automation.id, timerAt(at, () => void fireOnceAutomation(automation.id)));
}

function recordMissedOnce(automation: AutomationRecord, now: number): void {
  const hours = Math.floor((now - automation.runAt!) / 3_600_000);
  createRun(
    automation, 'scheduled', automation.runAt!, 'skipped',
    `Missed while offline: it was due ${new Date(automation.runAt!).toISOString()}, ${hours}h before the bridge came back`,
  );
  updateAutomation(automation.id, { enabled: false }, null);
  log(`[automation:${automation.id}] One-shot run missed while offline`);
}

/**
 * Fire a one-shot automation. A targeted run whose session is mid-turn waits
 * a minute and tries again (up to ONCE_BUSY_RETRIES) instead of being skipped
 * outright — a reminder should land a little late, not vanish. It is disabled
 * before it runs, and the unique (automation, scheduledFor) index makes a
 * second copy impossible even across a crash.
 */
export async function fireOnceAutomation(id: string, attempt = 0): Promise<AutomationRunRecord | null> {
  jobs.delete(id);
  const automation = getAutomation(id);
  if (!automation || !automation.enabled || automation.triggerType !== 'once' || !automation.runAt) return null;

  const target = automation.targetSessionId;
  if (target && sessions.has(target) && isSessionBusy(target) && attempt < ONCE_BUSY_RETRIES) {
    const retryAt = Date.now() + ONCE_BUSY_RETRY_MS;
    jobs.set(id, timerAt(retryAt, () => void fireOnceAutomation(id, attempt + 1)));
    setAutomationNextRun(id, retryAt);
    log(`[automation:${id}] Target busy — retry ${attempt + 1}/${ONCE_BUSY_RETRIES} in ${ONCE_BUSY_RETRY_MS / 1000}s`);
    return null;
  }

  updateAutomation(id, { enabled: false }, null);
  const busyReason = attempt > 0
    ? `"${sessions.get(target!)?.name ?? target}" was still busy after ${attempt} retries, one a minute`
    : undefined;
  try {
    return await runAutomation(automation, 'scheduled', automation.runAt, null, { busyReason });
  } catch (error) {
    logError(`[automation:${id}] One-shot run failed to start: ${error}`);
    return null;
  }
}

export function unscheduleAutomation(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/** True while the scheduler holds a timer for `id` (tests, diagnostics). */
export function isScheduled(id: string): boolean {
  return jobs.has(id);
}

export function stopAutomationScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}
