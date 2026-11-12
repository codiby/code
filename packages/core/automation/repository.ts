import { randomUUID } from 'crypto';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { database } from '../database';
import { automationRuns, automations, type AutomationRecord, type AutomationRunRecord } from '../database/schema';
import type { TurnCompleteInfo } from '../provider/types';
import type { AutomationCreate, AutomationPatch, AutomationRunStatus, AutomationRunTrigger } from './types';

const activeAutomation = isNull(automations.deletedAt);

export function listAutomations(): AutomationRecord[] {
  return database.select().from(automations).where(activeAutomation).orderBy(desc(automations.createdAt)).all();
}

export function listEnabledAutomations(): AutomationRecord[] {
  return database.select().from(automations)
    .where(and(activeAutomation, eq(automations.enabled, true))).all();
}

export function getAutomation(id: string): AutomationRecord | null {
  return database.select().from(automations)
    .where(and(eq(automations.id, id), activeAutomation)).get() ?? null;
}

/** Including soft-deleted rows — for questions about a run whose automation may be gone. */
export function getAutomationRecord(id: string): AutomationRecord | null {
  return database.select().from(automations).where(eq(automations.id, id)).get() ?? null;
}

export function createAutomation(input: AutomationCreate, nextRunAt: number | null): AutomationRecord {
  const now = Date.now();
  const record = {
    id: `aut_${randomUUID()}`,
    ...input,
    description: input.description ?? null,
    cronExpression: input.cronExpression ?? null,
    runAt: input.runAt ?? null,
    targetSessionId: input.targetSessionId ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    maxRuntimeMs: input.maxRuntimeMs ?? null,
    nextRunAt,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  database.insert(automations).values(record).run();
  return getAutomation(record.id)!;
}

export function updateAutomation(id: string, patch: AutomationPatch, nextRunAt?: number | null): AutomationRecord | null {
  if (!getAutomation(id)) return null;
  database.update(automations).set({
    ...patch,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    updatedAt: Date.now(),
  }).where(eq(automations.id, id)).run();
  return getAutomation(id);
}

export function setAutomationNextRun(id: string, nextRunAt: number | null): void {
  database.update(automations).set({ nextRunAt }).where(eq(automations.id, id)).run();
}

export function deleteAutomation(id: string): boolean {
  if (!getAutomation(id)) return false;
  database.update(automations).set({
    enabled: false,
    nextRunAt: null,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
  }).where(and(eq(automations.id, id), activeAutomation)).run();
  return true;
}

export function hasActiveRun(automationId: string): boolean {
  return !!database.select({ id: automationRuns.id }).from(automationRuns).where(and(
    eq(automationRuns.automationId, automationId),
    or(eq(automationRuns.status, 'scheduled'), eq(automationRuns.status, 'running')),
  )).get();
}

/**
 * Insert a run. `reason` is stored as the run's `error` — for a `skipped` run
 * it says why it never started (target busy, missed while offline…), which
 * the history would otherwise show as an unexplained gap.
 */
export function createRun(
  automation: AutomationRecord,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null,
  status: AutomationRunStatus = 'scheduled',
  reason?: string,
): AutomationRunRecord | null {
  const now = Date.now();
  const record = {
    id: `run_${randomUUID()}`,
    automationId: automation.id,
    automationName: automation.name,
    trigger,
    scheduledFor,
    status,
    error: reason ?? null,
    finishedAt: status === 'skipped' ? now : null,
    durationMs: status === 'skipped' ? 0 : null,
    createdAt: now,
  };
  try {
    database.insert(automationRuns).values(record).run();
    return getRun(automation.id, record.id);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) return null;
    throw error;
  }
}

/** `sessionId` is null for runs handled in code (a reminder delivered verbatim). */
export function startRun(runId: string, sessionId: string | null): AutomationRunRecord | null {
  database.update(automationRuns).set({ sessionId, status: 'running', startedAt: Date.now() })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'scheduled'))).run();
  return getRunById(runId);
}

/** Settle a running run with its turn's outcome. No-op when it already finished (timed out, cancelled). */
export function completeRun(
  runId: string,
  status: Extract<AutomationRunStatus, 'succeeded' | 'failed' | 'cancelled'>,
  info: TurnCompleteInfo & { error?: string },
): AutomationRunRecord | null {
  const run = getRunById(runId);
  if (!run || run.status !== 'running') return null;
  const finishedAt = Date.now();
  database.update(automationRuns).set({
    status,
    finishedAt,
    durationMs: run.startedAt ? finishedAt - run.startedAt : info.durationMs ?? null,
    resultText: info.resultText ?? null,
    error: info.error ?? null,
    stopReason: info.stopReason ?? null,
    costUsd: info.costUsd ?? null,
    inputTokens: info.usage?.input_tokens ?? null,
    outputTokens: info.usage?.output_tokens ?? null,
  }).where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, 'running'))).run();
  return getRunById(run.id);
}

export function finishRunBySession(
  sessionId: string,
  status: Extract<AutomationRunStatus, 'succeeded' | 'failed'>,
  info: TurnCompleteInfo & { error?: string },
): AutomationRunRecord | null {
  const run = getActiveRunBySession(sessionId);
  return run ? completeRun(run.id, status, info) : null;
}

export function finishRun(
  runId: string,
  status: Extract<AutomationRunStatus, 'failed' | 'timed_out' | 'cancelled'>,
  error?: string,
): AutomationRunRecord | null {
  const run = getRunById(runId);
  if (!run || !['scheduled', 'running'].includes(run.status)) return null;
  const finishedAt = Date.now();
  database.update(automationRuns).set({
    status,
    error: error ?? null,
    finishedAt,
    durationMs: run.startedAt ? finishedAt - run.startedAt : null,
  }).where(eq(automationRuns.id, runId)).run();
  return getRunById(runId);
}

export function getRun(automationId: string, runId: string): AutomationRunRecord | null {
  return database.select().from(automationRuns).where(and(
    eq(automationRuns.id, runId), eq(automationRuns.automationId, automationId),
  )).get() ?? null;
}

export function getRunById(runId: string): AutomationRunRecord | null {
  return database.select().from(automationRuns).where(eq(automationRuns.id, runId)).get() ?? null;
}

export function getActiveRunBySession(sessionId: string): AutomationRunRecord | null {
  return database.select().from(automationRuns).where(and(
    eq(automationRuns.sessionId, sessionId), eq(automationRuns.status, 'running'),
  )).get() ?? null;
}

export function listRuns(automationId: string, options: { limit: number; before?: number; status?: string }): AutomationRunRecord[] {
  const filters = [eq(automationRuns.automationId, automationId)];
  if (options.before) filters.push(lt(automationRuns.createdAt, options.before));
  if (options.status) filters.push(eq(automationRuns.status, options.status));
  return database.select().from(automationRuns).where(and(...filters))
    .orderBy(desc(automationRuns.createdAt)).limit(options.limit).all();
}

export function latestRun(automationId: string): AutomationRunRecord | null {
  return listRuns(automationId, { limit: 1 })[0] ?? null;
}

export function failInterruptedRuns(): number {
  const interrupted = database.select({ id: automationRuns.id }).from(automationRuns)
    .where(or(eq(automationRuns.status, 'scheduled'), eq(automationRuns.status, 'running'))).all();
  database.update(automationRuns).set({
    status: 'failed',
    error: 'Bridge restarted before the automation completed',
    finishedAt: Date.now(),
  }).where(or(eq(automationRuns.status, 'scheduled'), eq(automationRuns.status, 'running'))).run();
  return interrupted.length;
}
