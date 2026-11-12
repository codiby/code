/**
 * The heartbeat and the morning brief as managed automations.
 *
 * heartbeat.json says what should exist; `syncManagedAutomations` makes the
 * automation rows match it (create, retune, pause), always targeting the
 * agent session and always in persona.timezone. Rows are paused rather than
 * deleted so their run history survives the toggle, and they only run while
 * the agent is enabled on this host.
 */

import { encodeManagedMeta, listManaged, parseManagedMeta } from '../../automation/managed';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  getAutomationRecord,
  listRuns,
  updateAutomation,
} from '../../automation/repository';
import { activeTargetedRun, runAutomation } from '../../automation/runner';
import { isScheduled, nextRunFor, scheduleAutomation, unscheduleAutomation } from '../../automation/scheduler';
import type { AutomationCreate } from '../../automation/types';
import type { AutomationRecord, AutomationRunRecord } from '../../database/schema';
import { logError } from '../../lib/logger';
import { loadAgentConfig } from '../config';
import { AGENT_SESSION_ID } from '../session';
import { loadHeartbeatConfig, type HeartbeatConfig } from './settings';

export const MANAGED_BY = 'agent';
export const EDIT_HINT = 'Agent › Heartbeat';
export type ManagedKind = 'heartbeat' | 'morning_brief';
export const MANAGED_KINDS: ManagedKind[] = ['heartbeat', 'morning_brief'];

const HEARTBEAT_MAX_RUNTIME_MS = 10 * 60_000;
const BRIEF_MAX_RUNTIME_MS = 15 * 60_000;

/** Delivery rules appended to the owner's checklist — not editable, because the cap and NO_REPLY depend on them. */
export function heartbeatPrompt(cfg: HeartbeatConfig): string {
  const cap = cfg.maxMessagesPerDay === 0
    ? 'The owner turned heartbeat messages off: only an urgent notify_user goes through.'
    : `At most ${cfg.maxMessagesPerDay} heartbeat messages a day.`;
  return [
    cfg.checklist.trim(),
    '',
    'How to finish: this check was started by a schedule, not by the owner, and nobody reads your reply.',
    `Reach the owner only through notify_user, and only when something needs their attention. ${cap}`,
    'Priority: low for nice-to-know, normal for something to act on today, urgent only when waiting would cause harm.',
    'When you are done, reply exactly NO_REPLY.',
  ].join('\n');
}

export function briefPrompt(cfg: HeartbeatConfig): string {
  return [
    cfg.morningBrief.prompt.trim(),
    '',
    'Send the brief to the owner with a single notify_user call (title "Morning brief", priority normal).',
    'Nobody reads your reply: once it is sent, reply exactly NO_REPLY.',
  ].join('\n');
}

/** "07:30" → "30 7 * * *". */
export function briefCron(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${m} ${h} * * *`;
}

interface Spec {
  kind: ManagedKind;
  name: string;
  label: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  maxRuntimeMs: number;
}

function specs(cfg: HeartbeatConfig, agentEnabled: boolean): Spec[] {
  return [
    {
      kind: 'heartbeat',
      name: 'Heartbeat',
      label: 'The agent\'s periodic check-in',
      cron: cfg.interval,
      prompt: heartbeatPrompt(cfg),
      enabled: agentEnabled && cfg.enabled,
      maxRuntimeMs: HEARTBEAT_MAX_RUNTIME_MS,
    },
    {
      kind: 'morning_brief',
      name: 'Morning brief',
      label: 'The agent\'s summary of the day',
      cron: briefCron(cfg.morningBrief.time),
      prompt: briefPrompt(cfg),
      enabled: agentEnabled && cfg.morningBrief.enabled,
      maxRuntimeMs: BRIEF_MAX_RUNTIME_MS,
    },
  ];
}

const COMPARED: (keyof AutomationCreate & keyof AutomationRecord)[] = [
  'name', 'description', 'triggerType', 'cronExpression', 'timezone', 'enabled', 'prompt',
  'targetSessionId', 'cwd', 'provider', 'model', 'permissionMode', 'maxRuntimeMs',
];

function differs(row: AutomationRecord, fields: AutomationCreate): boolean {
  return COMPARED.some(key => (row[key] ?? null) !== (fields[key] ?? null));
}

/**
 * Make the managed rows match heartbeat.json and the agent config. Cheap
 * when nothing changed (a read and a compare), so it also runs on a timer
 * to pick up a persona timezone change. `create` forces a row for a kind
 * that is off, so "Run now" works before it is ever enabled.
 */
export function syncManagedAutomations(options: { create?: ManagedKind } = {}): Record<ManagedKind, AutomationRecord | null> {
  const agent = loadAgentConfig();
  const cfg = loadHeartbeatConfig();
  const timezone = agent.persona.timezone;
  const out: Record<ManagedKind, AutomationRecord | null> = { heartbeat: null, morning_brief: null };

  for (const spec of specs(cfg, agent.enabled)) {
    const existing = listManaged(MANAGED_BY, spec.kind);
    // Newest first; anything after the first is a leftover from a race.
    for (const extra of existing.slice(1)) {
      unscheduleAutomation(extra.automation.id);
      deleteAutomation(extra.automation.id);
    }
    let row = existing[0]?.automation ?? null;
    if (!row && !spec.enabled && options.create !== spec.kind) continue;

    const fields: AutomationCreate = {
      name: spec.name,
      description: encodeManagedMeta({ by: MANAGED_BY, kind: spec.kind, label: spec.label, editHint: EDIT_HINT }),
      triggerType: 'cron',
      cronExpression: spec.cron,
      runAt: null,
      timezone,
      enabled: spec.enabled,
      prompt: spec.prompt,
      targetSessionId: AGENT_SESSION_ID,
      cwd: agent.workspaceDir,
      provider: agent.provider,
      model: agent.model,
      permissionMode: 'default',
      effort: null,
      concurrencyPolicy: 'skip',
      maxRuntimeMs: spec.maxRuntimeMs,
    };

    try {
      const nextRunAt = spec.enabled ? nextRunFor(spec.cron, timezone) : null;
      if (!row) {
        row = createAutomation(fields, nextRunAt);
        scheduleAutomation(row);
      } else if (differs(row, fields)) {
        row = updateAutomation(row.id, fields, nextRunAt)!;
        scheduleAutomation(row);
      } else if (row.enabled && !isScheduled(row.id)) {
        scheduleAutomation(row);
      }
      out[spec.kind] = getAutomation(row.id);
    } catch (err) {
      logError(`[agent] could not sync the ${spec.kind} automation: ${err}`);
      out[spec.kind] = row;
    }
  }
  return out;
}

export function managedAutomation(kind: ManagedKind): AutomationRecord | null {
  return listManaged(MANAGED_BY, kind)[0]?.automation ?? null;
}

/** POST /agent/heartbeat/run — fire one now, whether or not its schedule is on. */
export async function runManagedNow(kind: ManagedKind): Promise<{ automation: AutomationRecord | null; run: AutomationRunRecord | null }> {
  const automation = syncManagedAutomations({ create: kind })[kind];
  if (!automation) return { automation: null, run: null };
  return { automation, run: await runAutomation(automation, 'manual') };
}

export interface ManagedStatus {
  automationId: string;
  enabled: boolean;
  nextRunAt: number | null;
  cronExpression: string | null;
  timezone: string;
  runs: AutomationRunRecord[];
}

export function managedStatus(kind: ManagedKind, limit = 10): ManagedStatus | null {
  const row = managedAutomation(kind);
  if (!row) return null;
  return {
    automationId: row.id,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    runs: listRuns(row.id, { limit }),
  };
}

/**
 * Which of the agent's managed automations (if any) is driving the agent
 * session's current turn — how notify_user knows a message comes from the
 * heartbeat and must count against its daily cap.
 */
export function activeManagedKind(sessionId: string): string | null {
  const active = activeTargetedRun(sessionId);
  if (!active) return null;
  const meta = parseManagedMeta(getAutomationRecord(active.automationId)?.description);
  return meta?.by === MANAGED_BY ? meta.kind : null;
}

// ---------------------------------------------------------------------------
// Drift check — saves from the Agent view re-sync at once (config-sync.ts,
// on onAgentConfigChanged); this backstop catches config.json edited by
// hand or a save that raced a sync.
// ---------------------------------------------------------------------------

const RECONCILE_MS = 5 * 60_000;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

export function startReconcile(): void {
  stopReconcile();
  reconcileTimer = setInterval(() => {
    try { syncManagedAutomations(); } catch (err) { logError(`[agent] heartbeat reconcile failed: ${err}`); }
  }, RECONCILE_MS);
  reconcileTimer.unref?.();
}

export function stopReconcile(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}
