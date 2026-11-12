/**
 * Follow the owner's edits to the agent config (PUT /agent/config).
 *
 * The heartbeat and the morning brief run in persona.timezone, and held
 * low-priority notifications wait for the end of quiet hours: either can be
 * stale the moment the owner moves the timezone or the quiet window. The
 * five-minute reconcile in heartbeat.ts would catch the schedules eventually;
 * this makes it immediate and also re-times the held notifications.
 */

import { logError } from '../../lib/logger';
import type { AgentConfig } from '../config';
import { syncManagedAutomations } from './heartbeat';
import { flushQueuedNotifications, queuedNotificationCount } from './notify';

/** Fields the managed automations are built from (see heartbeat.ts `syncManagedAutomations`). */
function scheduleInputsChanged(next: AgentConfig, prev: AgentConfig): boolean {
  return next.persona.timezone !== prev.persona.timezone
    || next.workspaceDir !== prev.workspaceDir
    || next.provider !== prev.provider
    || next.model !== prev.model
    || next.enabled !== prev.enabled;
}

function quietHoursChanged(next: AgentConfig, prev: AgentConfig): boolean {
  const a = next.quietHours;
  const b = prev.quietHours;
  return a.enabled !== b.enabled || a.start !== b.start || a.end !== b.end;
}

export function handleAgentConfigChanged(next: AgentConfig, prev: AgentConfig): void {
  const timezone = next.persona.timezone !== prev.persona.timezone;
  const quiet = quietHoursChanged(next, prev);
  if (scheduleInputsChanged(next, prev) || quiet) {
    try { syncManagedAutomations(); } catch (err) { logError(`[agent] could not re-sync proactive schedules: ${err}`); }
  }
  // Quiet hours shortened or turned off → deliver what they held now;
  // moved or extended → wait for the new end (the flush re-arms itself).
  if ((timezone || quiet) && queuedNotificationCount() > 0) {
    void flushQueuedNotifications().catch(err => logError(`[agent] could not re-time held notifications: ${err}`));
  }
}
