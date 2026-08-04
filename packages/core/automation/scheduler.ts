import { Cron } from 'croner';
import type { AutomationRecord } from '../database/schema';
import { log, logError } from '../lib/logger';
import { failInterruptedRuns, listEnabledAutomations, setAutomationNextRun } from './repository';
import { runAutomation } from './runner';

const jobs = new Map<string, Cron>();

export function nextRunFor(cronExpression: string, timezone: string, after?: Date): number | null {
  const cron = new Cron(cronExpression, { timezone, paused: true });
  try {
    return cron.nextRun(after)?.getTime() ?? null;
  } finally {
    cron.stop();
  }
}

export function startAutomationScheduler(): void {
  const interrupted = failInterruptedRuns();
  if (interrupted) log(`[automation] Marked ${interrupted} interrupted runs as failed`);
  for (const automation of listEnabledAutomations()) scheduleAutomation(automation);
  log(`[automation] Scheduler started with ${jobs.size} jobs`);
}

export function scheduleAutomation(automation: AutomationRecord): void {
  unscheduleAutomation(automation.id);
  if (!automation.enabled || automation.deletedAt) {
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

export function unscheduleAutomation(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function stopAutomationScheduler(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
}
