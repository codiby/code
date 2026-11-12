/**
 * Sub-agent tasks — folds the Claude Agent SDK's task_* system messages into
 * one record per task for the Agents panel.
 *
 * Messages can arrive out of order (a progress tick before `task_started`
 * after a resume, a notification without a prior update), so every event
 * creates the record if it is missing and only ever moves numbers forward.
 *
 * The records outlive the bridge: session/state.ts mirrors each session's map
 * to `tasks.json` next to its UI state and reads it back on load
 * (restoreStoredTasks), so the Agents panel — and a workflow's agents —
 * stay reachable after a restart.
 */

import type { SubagentTask, SubagentTaskStatus, TaskEvent } from '../provider/types';

const FINAL: ReadonlySet<SubagentTaskStatus> = new Set(['completed', 'failed', 'stopped', 'killed']);

export function isTaskFinal(status: SubagentTaskStatus): boolean {
  return FINAL.has(status);
}

function blank(taskId: string, now: number): SubagentTask {
  return {
    taskId,
    toolUseId: null,
    taskType: 'local_agent',
    description: '',
    subagentType: null,
    workflowName: null,
    prompt: null,
    status: 'running',
    backgrounded: false,
    spawnDepth: 1,
    startedAt: now,
    endedAt: null,
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    lastToolName: null,
    progress: null,
    summary: null,
    error: null,
  };
}

const max = (a: number, b: number | undefined): number => (typeof b === 'number' && Number.isFinite(b) && b > a ? b : a);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Apply one event and return the updated record (never mutates `prev`). */
export function applyTaskEvent(prev: SubagentTask | undefined, ev: Exclude<TaskEvent, { kind: 'snapshot' }>, now = Date.now()): SubagentTask {
  const t: SubagentTask = prev ? { ...prev } : blank(ev.taskId, now);
  switch (ev.kind) {
    case 'started':
      t.toolUseId = ev.toolUseId ?? t.toolUseId;
      t.taskType = ev.taskType || t.taskType;
      t.description = ev.description || t.description;
      t.subagentType = ev.subagentType ?? t.subagentType;
      t.workflowName = ev.workflowName ?? t.workflowName;
      t.prompt = ev.prompt ?? t.prompt;
      t.backgrounded = ev.backgrounded ?? t.backgrounded;
      t.spawnDepth = ev.spawnDepth ?? t.spawnDepth;
      if (!prev) t.startedAt = now;
      // A re-sent start for a task we already finished (resume replay) must not revive it.
      if (!isTaskFinal(t.status)) t.status = 'running';
      break;
    case 'progress':
      t.toolUseId = ev.toolUseId ?? t.toolUseId;
      t.subagentType = ev.subagentType ?? t.subagentType;
      if (!t.description && ev.description) t.description = ev.description;
      t.totalTokens = max(t.totalTokens, ev.totalTokens);
      t.toolUses = max(t.toolUses, ev.toolUses);
      t.durationMs = max(t.durationMs, ev.durationMs);
      t.lastToolName = ev.lastToolName ?? t.lastToolName;
      // `summary` (agentProgressSummaries) beats the generic "Running X" description.
      t.progress = str(ev.summary) ?? str(ev.description) ?? t.progress;
      break;
    case 'updated':
      if (ev.status) t.status = ev.status;
      if (ev.description) t.description = ev.description;
      if (typeof ev.endTime === 'number') t.endedAt = ev.endTime;
      if (ev.error) t.error = ev.error;
      if (typeof ev.backgrounded === 'boolean') t.backgrounded = ev.backgrounded;
      break;
    case 'notification':
      t.toolUseId = ev.toolUseId ?? t.toolUseId;
      t.status = ev.status;
      t.summary = str(ev.summary) ?? t.summary;
      t.totalTokens = max(t.totalTokens, ev.totalTokens);
      t.toolUses = max(t.toolUses, ev.toolUses);
      t.durationMs = max(t.durationMs, ev.durationMs);
      break;
  }
  if (isTaskFinal(t.status) && t.endedAt === null) t.endedAt = now;
  return t;
}

/**
 * `background_tasks_changed` lists what is running right now. It only seeds
 * tasks we have not heard of (e.g. after the bridge restarted mid-run); the
 * lifecycle events stay the source of truth for status.
 */
export function seedFromSnapshot(
  tasks: Record<string, SubagentTask>,
  snapshot: Extract<TaskEvent, { kind: 'snapshot' }>,
  now = Date.now(),
): SubagentTask[] {
  const added: SubagentTask[] = [];
  for (const s of snapshot.tasks) {
    if (!s.taskId || tasks[s.taskId]) continue;
    const t = blank(s.taskId, now);
    t.taskType = s.taskType || t.taskType;
    t.subagentType = s.subagentType ?? null;
    t.description = s.description || '';
    t.backgrounded = true;
    added.push(t);
  }
  return added;
}

/**
 * Mark every unfinished task as stopped and return the ones that changed.
 * Tasks live in the provider process: once it exits or is replaced, nothing
 * will ever finish them, and pruning never drops a running task, so left
 * alone they would spin in the Agents panel (and fill the map) forever.
 */
export function settleRunningTasks(tasks: Record<string, SubagentTask>, now = Date.now()): SubagentTask[] {
  const settled: SubagentTask[] = [];
  for (const t of Object.values(tasks)) {
    if (isTaskFinal(t.status)) continue;
    settled.push({ ...t, status: 'stopped', endedAt: t.endedAt ?? now });
  }
  return settled;
}

const STATUSES: ReadonlySet<SubagentTaskStatus> = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'killed']);
/** Longest text field kept from tasks.json; the live reducer never produces more than the SDK sends. */
const MAX_STORED_TEXT = 100_000;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const text = (v: unknown, fallback: string | null): string | null => (typeof v === 'string' ? v.slice(0, MAX_STORED_TEXT) : fallback);

/**
 * Records read back from tasks.json (session/storage.ts), as the map the
 * bridge keeps. Anything malformed is dropped or reset to its blank value —
 * the file may predate a field, or have been edited by hand. Tasks the
 * previous run left unfinished are settled as stopped (see
 * settleRunningTasks): their provider process is gone. `savedAt`, when the
 * file was last written, is the latest time they were known to run.
 */
export function restoreStoredTasks(
  raw: unknown,
  savedAt: number | null,
  now = Date.now(),
): { tasks: Record<string, SubagentTask>; settled: number } {
  const tasks: Record<string, SubagentTask> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tasks, settled: 0 };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const r = value as Record<string, unknown>;
    if (typeof r.taskId !== 'string' || !r.taskId || r.taskId !== key || r.taskId.length > 200) continue;
    const t = blank(r.taskId, num(r.startedAt, now));
    t.toolUseId = text(r.toolUseId, null);
    t.taskType = text(r.taskType, null) || t.taskType;
    t.description = text(r.description, '') ?? '';
    t.subagentType = text(r.subagentType, null);
    t.workflowName = text(r.workflowName, null);
    t.prompt = text(r.prompt, null);
    t.status = STATUSES.has(r.status as SubagentTaskStatus) ? (r.status as SubagentTaskStatus) : 'stopped';
    t.backgrounded = r.backgrounded === true;
    t.spawnDepth = Math.max(1, Math.floor(num(r.spawnDepth, 1)));
    t.endedAt = typeof r.endedAt === 'number' && Number.isFinite(r.endedAt) ? r.endedAt : null;
    t.totalTokens = num(r.totalTokens, 0);
    t.toolUses = num(r.toolUses, 0);
    t.durationMs = num(r.durationMs, 0);
    t.lastToolName = text(r.lastToolName, null);
    t.progress = text(r.progress, null);
    t.summary = text(r.summary, null);
    t.error = text(r.error, null);
    // As applyTaskEvent: a finished task always has an end time.
    if (isTaskFinal(t.status) && t.endedAt === null) t.endedAt = savedAt ?? now;
    tasks[t.taskId] = t;
  }
  const settled = settleRunningTasks(tasks, savedAt ?? now);
  for (const t of settled) tasks[t.taskId] = t;
  return { tasks: pruneTasks(tasks), settled: settled.length };
}

/** Keep the map bounded: drop the oldest finished tasks beyond `limit`. */
export function pruneTasks(tasks: Record<string, SubagentTask>, limit = 200): Record<string, SubagentTask> {
  const all = Object.values(tasks);
  if (all.length <= limit) return tasks;
  const finished = all.filter(t => isTaskFinal(t.status)).sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  const drop = new Set(finished.slice(0, all.length - limit).map(t => t.taskId));
  const next: Record<string, SubagentTask> = {};
  for (const t of all) if (!drop.has(t.taskId)) next[t.taskId] = t;
  return next;
}
