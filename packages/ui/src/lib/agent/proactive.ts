/**
 * Proactivity client — heartbeat, morning brief and reminders on the agent's
 * host (mirrors packages/core/agent/proactive). Quiet hours live in the core
 * agent config and go through `agentCore.saveConfig`.
 *
 * Also holds the pure helpers that map the heartbeat's cron to the
 * "how often + active hours" controls, so they can be tested without a DOM.
 */

import type { AutomationRun } from '../claude-client';
import type { AgentApi, AgentConfig } from './api';

export interface MorningBriefConfig {
  enabled: boolean;
  /** Local "HH:MM" in the agent's timezone. */
  time: string;
  prompt: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  /** 5-field cron in the agent's timezone. */
  interval: string;
  checklist: string;
  maxMessagesPerDay: number;
  morningBrief: MorningBriefConfig;
}

export type HeartbeatPatch = Partial<Omit<HeartbeatConfig, 'morningBrief'>> & { morningBrief?: Partial<MorningBriefConfig> };

export interface ManagedScheduleStatus {
  automationId: string;
  enabled: boolean;
  nextRunAt: number | null;
  cronExpression: string | null;
  timezone: string;
  runs: AutomationRun[];
}

export interface HeartbeatSnapshot {
  config: HeartbeatConfig;
  agentEnabled: boolean;
  timezone: string;
  quietHours: AgentConfig['quietHours'];
  today: { day: string; sent: number; max: number };
  queuedNotifications: number;
  heartbeat: ManagedScheduleStatus | null;
  morningBrief: ManagedScheduleStatus | null;
  defaults: { interval: string; checklist: string; briefPrompt: string };
}

export interface Reminder {
  id: string;
  text: string;
  mode: 'message' | 'task';
  priority: 'low' | 'normal' | 'urgent';
  schedule: 'once' | 'cron';
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

export type ManagedKind = 'heartbeat' | 'morning_brief';

export const proactiveApi = {
  heartbeat: (api: AgentApi) => api.get<HeartbeatSnapshot>('/agent/heartbeat'),
  saveHeartbeat: (api: AgentApi, patch: HeartbeatPatch) => api.send<HeartbeatSnapshot>('PUT', '/agent/heartbeat', patch),
  runNow: (api: AgentApi, kind: ManagedKind) =>
    api.send<{ ok: boolean; skipped: boolean; run: AutomationRun }>('POST', '/agent/heartbeat/run', { kind }),
  reminders: (api: AgentApi, includeDone = false) =>
    api.get<{ reminders: Reminder[] }>(`/agent/reminders${includeDone ? '?all=1' : ''}`),
  cancelReminder: (api: AgentApi, id: string) => api.send<{ ok: true }>('DELETE', `/agent/reminders/${encodeURIComponent(id)}`),
};

// ---------------------------------------------------------------------------
// Heartbeat schedule ⇄ cron
// ---------------------------------------------------------------------------

export interface HeartbeatPreset {
  id: string;
  label: string;
  /** The cron minute field. */
  minute: string;
  /** Step over the active hours (1 = every hour). */
  hourStep: number;
}

export const HEARTBEAT_PRESETS: HeartbeatPreset[] = [
  { id: '30m', label: 'Every 30 min', minute: '*/30', hourStep: 1 },
  { id: '1h', label: 'Hourly', minute: '0', hourStep: 1 },
  { id: '2h', label: 'Every 2 h', minute: '0', hourStep: 2 },
  { id: '4h', label: 'Every 4 h', minute: '0', hourStep: 4 },
];

export interface HeartbeatSchedule {
  presetId: string;
  /** First and last active hour, inclusive (0–23, from ≤ to). */
  from: number;
  to: number;
}

/** Preset + active hours → cron. All day collapses to `*`. */
export function buildHeartbeatCron(schedule: HeartbeatSchedule): string {
  const preset = HEARTBEAT_PRESETS.find(p => p.id === schedule.presetId) ?? HEARTBEAT_PRESETS[1]!;
  const from = Math.max(0, Math.min(23, Math.round(schedule.from)));
  const to = Math.max(from, Math.min(23, Math.round(schedule.to)));
  const range = from === 0 && to === 23 ? '*' : `${from}-${to}`;
  const hours = preset.hourStep > 1 ? `${range}/${preset.hourStep}` : range;
  return `${preset.minute} ${hours} * * *`;
}

/** The inverse, for the shapes `buildHeartbeatCron` produces; null means "custom". */
export function parseHeartbeatCron(cron: string): HeartbeatSchedule | null {
  const m = /^(0|\*\/30) (\*|(\d{1,2})-(\d{1,2}))(?:\/(\d+))? \* \* \*$/.exec(cron.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const [, minute, , fromRaw, toRaw, stepRaw] = m;
  const step = stepRaw ? Number(stepRaw) : 1;
  const preset = HEARTBEAT_PRESETS.find(p => p.minute === minute && p.hourStep === step);
  if (!preset) return null;
  const from = fromRaw === undefined ? 0 : Number(fromRaw);
  const to = toRaw === undefined ? 23 : Number(toRaw);
  if (from > to || to > 23) return null;
  return { presetId: preset.id, from, to };
}

/** "Hourly, 08:00–22:59" / "Every 30 min, all day". */
export function describeHeartbeatSchedule(schedule: HeartbeatSchedule): string {
  const preset = HEARTBEAT_PRESETS.find(p => p.id === schedule.presetId) ?? HEARTBEAT_PRESETS[1]!;
  if (schedule.from === 0 && schedule.to === 23) return `${preset.label}, all day`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${preset.label}, ${pad(schedule.from)}:00–${pad(schedule.to)}:59`;
}

export const REMINDER_STATUS_TONE: Record<string, 'zinc' | 'green' | 'amber' | 'red' | 'indigo'> = {
  scheduled: 'indigo',
  running: 'indigo',
  done: 'green',
  missed: 'amber',
  skipped: 'amber',
  failed: 'red',
  timed_out: 'red',
  cancelled: 'zinc',
  paused: 'zinc',
};
