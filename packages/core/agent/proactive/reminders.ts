/**
 * Reminders — managed automations of kind 'reminder', no tables of their own.
 *
 *   mode 'message' (default): at fire time the text goes to the owner as-is,
 *     in code — no LLM turn, no tokens (the runner's direct-run path).
 *   mode 'task': an agent turn in the agent session with the text as its
 *     instructions (a targeted automation; busy → retried for one-shots).
 *
 * One-shot reminders are `once` automations; recurring ones are `cron`.
 */

import {
  encodeManagedMeta,
  listManaged,
  parseManagedMeta,
  type DirectRunContext,
  type DirectRunResult,
  type ManagedMeta,
} from '../../automation/managed';
import { createAutomation, deleteAutomation, getAutomation, latestRun } from '../../automation/repository';
import { nextRunFor, scheduleAutomation, unscheduleAutomation } from '../../automation/scheduler';
import { parseInstant } from '../../automation/types';
import type { AutomationRecord, AutomationRunRecord } from '../../database/schema';
import { isAgentEnabled, loadAgentConfig } from '../config';
import { ownerTargets } from '../outbox';
import { AGENT_SESSION_ID } from '../session';
import type { OutboundPriority } from '../types';
import { EDIT_HINT, MANAGED_BY } from './heartbeat';
import { notifyOwner } from './notify';
import { formatLocal, isoInZone, isValidTimezone, parseLocalIso } from './time';

export const REMINDER_KIND = 'reminder';
export type ReminderMode = 'message' | 'task';

const MAX_TEXT = 2_000;
const MAX_ACTIVE = 100;
const MAX_AHEAD_MS = 2 * 365 * 86_400_000;
/** "Now-ish" stamps a few seconds old still fire, straight away. */
const PAST_SLACK_MS = 30_000;
/** Recurring reminders fire at most this often — a reminder, not a ticker. */
const MIN_CRON_GAP_MS = 5 * 60_000;
const TASK_MAX_RUNTIME_MS = 15 * 60_000;

/** A reminder request the model can fix: the message says how. */
export class ReminderError extends Error {}

export interface ScheduleReminderInput {
  text: string;
  /** ISO-8601; with an offset it is exact, without one it is read in `timezone`. */
  at?: string;
  inMinutes?: number;
  cron?: string;
  timezone?: string;
  mode?: ReminderMode;
  priority?: OutboundPriority;
  createdBy?: { sessionId: string; sessionName: string };
}

export interface ReminderView {
  id: string;
  text: string;
  mode: ReminderMode;
  priority: OutboundPriority;
  schedule: 'once' | 'cron';
  /** One-shot: when it fires (ISO with the zone's offset). */
  at: string | null;
  cron: string | null;
  timezone: string;
  nextRunAt: number | null;
  enabled: boolean;
  /** scheduled · done · missed · failed · skipped · cancelled · running · paused */
  status: string;
  lastRun: { status: string; at: number; error: string | null; resultText: string | null } | null;
  createdAt: number;
  createdBy: string | null;
}

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isPriority(v: unknown): v is OutboundPriority {
  return v === 'low' || v === 'normal' || v === 'urgent';
}

function taskPrompt(text: string, createdAt: number, timezone: string): string {
  return [
    `A reminder you set on ${formatLocal(createdAt, timezone)} is due now. Its instructions:`,
    text,
    '',
    'Carry them out. If the owner needs to hear about it, tell them with notify_user.',
    'Nobody reads your reply: when you are done, reply exactly NO_REPLY.',
  ].join('\n');
}

function resolveWhen(input: ScheduleReminderInput, timezone: string, now: number): { runAt: number | null; cron: string | null } {
  const given = [input.at !== undefined, input.inMinutes !== undefined, input.cron !== undefined].filter(Boolean).length;
  if (given !== 1) throw new ReminderError('Pass exactly one of `at`, `inMinutes` or `cron`.');

  if (input.cron !== undefined) {
    const cron = String(input.cron).trim().replace(/\s+/g, ' ');
    if (cron.split(' ').length !== 5) throw new ReminderError('`cron` must have 5 fields (minute hour day month weekday), e.g. "0 9 * * 1".');
    let first: number | null;
    let second: number | null;
    try {
      first = nextRunFor(cron, timezone);
      second = first === null ? null : nextRunFor(cron, timezone, new Date(first));
    } catch (err) {
      throw new ReminderError(`Invalid cron expression: ${err instanceof Error ? err.message : err}`);
    }
    if (first === null) throw new ReminderError('That cron expression never fires.');
    if (second !== null && second - first < MIN_CRON_GAP_MS) {
      throw new ReminderError('A recurring reminder can fire at most every 5 minutes.');
    }
    return { runAt: null, cron };
  }

  let runAt: number | null;
  if (input.inMinutes !== undefined) {
    const minutes = Number(input.inMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ReminderError('`inMinutes` must be a positive number.');
    runAt = now + Math.round(minutes * 60_000);
  } else {
    const raw = String(input.at).trim();
    runAt = parseInstant(raw) ?? parseLocalIso(raw, timezone);
    if (runAt === null) {
      throw new ReminderError(`\`at\` must be ISO-8601, e.g. "${isoInZone(now + 3_600_000, timezone)}".`);
    }
    if (runAt < now - PAST_SLACK_MS) {
      throw new ReminderError(`That time is in the past (it is now ${isoInZone(now, timezone)}).`);
    }
  }
  if (runAt - now > MAX_AHEAD_MS) throw new ReminderError('Reminders can be set at most two years ahead.');
  return { runAt: Math.max(runAt, now), cron: null };
}

export function scheduleReminder(input: ScheduleReminderInput, now = Date.now()): ReminderView {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new ReminderError('`text` is required.');
  if (text.length > MAX_TEXT) throw new ReminderError(`\`text\` is limited to ${MAX_TEXT} characters.`);
  const mode: ReminderMode = input.mode === 'task' ? 'task' : 'message';
  if (input.mode !== undefined && input.mode !== 'task' && input.mode !== 'message') {
    throw new ReminderError('`mode` must be "message" or "task".');
  }
  if (input.priority !== undefined && !isPriority(input.priority)) {
    throw new ReminderError('`priority` must be "low", "normal" or "urgent".');
  }
  const priority: OutboundPriority = input.priority ?? 'normal';

  const agent = loadAgentConfig();
  const timezone = input.timezone?.trim() || agent.persona.timezone;
  if (!isValidTimezone(timezone)) throw new ReminderError(`Unknown timezone "${timezone}" — use an IANA name like "America/Mexico_City".`);
  if (listManaged(MANAGED_BY, REMINDER_KIND).filter(r => r.automation.enabled).length >= MAX_ACTIVE) {
    throw new ReminderError(`There are already ${MAX_ACTIVE} active reminders; cancel some first.`);
  }

  const { runAt, cron } = resolveWhen(input, timezone, now);
  const meta: ManagedMeta = {
    by: MANAGED_BY,
    kind: REMINDER_KIND,
    label: `Reminder: ${preview(text, 80)}`,
    deletable: true,
    editHint: EDIT_HINT,
    data: { mode, text, priority, createdBy: input.createdBy?.sessionName ?? null },
  };
  const automation = createAutomation({
    name: `Reminder: ${preview(text, 60)}`,
    description: encodeManagedMeta(meta),
    triggerType: cron ? 'cron' : 'once',
    cronExpression: cron,
    runAt,
    timezone,
    enabled: true,
    prompt: mode === 'task' ? taskPrompt(text, now, timezone) : text,
    // Message reminders are delivered in code and need no session at all.
    targetSessionId: mode === 'task' ? AGENT_SESSION_ID : null,
    cwd: agent.workspaceDir,
    provider: agent.provider,
    model: agent.model,
    permissionMode: 'default',
    effort: null,
    concurrencyPolicy: 'skip',
    maxRuntimeMs: mode === 'task' ? TASK_MAX_RUNTIME_MS : null,
  }, cron ? nextRunFor(cron, timezone) : runAt);
  scheduleAutomation(automation);
  return reminderView(getAutomation(automation.id) ?? automation)!;
}

function statusOf(row: AutomationRecord, last: AutomationRunRecord | null): string {
  if (last?.status === 'running' || last?.status === 'scheduled') return 'running';
  if (row.enabled) return 'scheduled';
  if (!last) return 'paused';
  if (last.status === 'succeeded') return 'done';
  if (last.status === 'skipped' && last.error?.startsWith('Missed')) return 'missed';
  return last.status;
}

export function reminderView(row: AutomationRecord): ReminderView | null {
  const meta = parseManagedMeta(row.description);
  if (!meta || meta.by !== MANAGED_BY || meta.kind !== REMINDER_KIND) return null;
  const data = meta.data ?? {};
  const last = latestRun(row.id);
  return {
    id: row.id,
    text: typeof data.text === 'string' ? data.text : row.prompt,
    mode: data.mode === 'task' ? 'task' : 'message',
    priority: isPriority(data.priority) ? data.priority : 'normal',
    schedule: row.triggerType === 'cron' ? 'cron' : 'once',
    at: row.runAt ? isoInZone(row.runAt, row.timezone) : null,
    cron: row.cronExpression,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt,
    enabled: row.enabled,
    status: statusOf(row, last),
    lastRun: last ? { status: last.status, at: last.finishedAt ?? last.createdAt, error: last.error, resultText: last.resultText } : null,
    createdAt: row.createdAt,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : null,
  };
}

/** Upcoming first (soonest on top); with `includeDone`, the finished ones follow, newest first. */
export function listReminders(options: { includeDone?: boolean; limit?: number } = {}): ReminderView[] {
  const views = listManaged(MANAGED_BY, REMINDER_KIND)
    .filter(r => options.includeDone || r.automation.enabled)
    .map(r => reminderView(r.automation)!)
    .filter(Boolean);
  const active = views.filter(v => v.enabled).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const done = views.filter(v => !v.enabled).sort((a, b) => (b.lastRun?.at ?? b.createdAt) - (a.lastRun?.at ?? a.createdAt));
  return [...active, ...done].slice(0, Math.max(1, options.limit ?? 200));
}

/** Cancel = soft-delete, so the history stays in the database. Only reminders, never other automations. */
export function cancelReminder(id: string): boolean {
  const row = getAutomation(id);
  if (!row || !reminderView(row)) return false;
  unscheduleAutomation(id);
  return deleteAutomation(id);
}

// ---------------------------------------------------------------------------
// Delivery (the runner's direct-run path for mode 'message')
// ---------------------------------------------------------------------------

let channelWaitMs = 120_000;
const CHANNEL_POLL_MS = 5_000;

/** Tests only. */
export function _setReminderChannelWait(ms: number): void {
  channelWaitMs = ms;
}

/**
 * A reminder that fires right after boot can beat the channels to the
 * network. Wait (briefly) for one to come up rather than fall back to push.
 */
async function waitForOwnerChannel(): Promise<void> {
  const deadline = Date.now() + channelWaitMs;
  while (isAgentEnabled() && ownerTargets().length === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, Math.min(CHANNEL_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
}

export async function deliverReminder(row: AutomationRecord, meta: ManagedMeta, ctx: DirectRunContext): Promise<DirectRunResult> {
  const data = meta.data ?? {};
  const text = typeof data.text === 'string' && data.text.trim() ? data.text.trim() : row.prompt;
  const priority = isPriority(data.priority) ? data.priority : 'normal';
  if (ctx.trigger === 'scheduled') await waitForOwnerChannel();
  const persona = loadAgentConfig().persona;
  const result = await notifyOwner({
    text: `⏰ ${text}`,
    priority,
    sessionId: AGENT_SESSION_ID,
    sessionName: `${persona.emoji ? `${persona.emoji} ` : ''}${persona.name}`.trim(),
    origin: 'reminder',
  });
  switch (result.status) {
    case 'delivered':
      return { ok: true, resultText: `Delivered via ${result.deliveredTo.join(', ')}${result.quiet ? ' (silently — quiet hours)' : ''}` };
    case 'queued':
      return { ok: true, resultText: `Held until ${formatLocal(result.queuedUntil!, loadAgentConfig().persona.timezone)} (quiet hours)` };
    default:
      return { ok: false, error: `${result.error ?? 'Not delivered'} — a push notification was raised, if push is set up.` };
  }
}
