/**
 * Proactivity (workstream 2): notify_user, reminders, heartbeat and morning
 * brief, and the run hooks that let them ride on automations.
 *
 * Imported for its side effects by agent/index.ts. Register routes, tools,
 * prompt sections, channels and hooks through ../registry and ../outbox —
 * never by editing bridge or index.ts.
 */

import { registerManagedRunHandler } from '../../automation/managed';
import { log } from '../../lib/logger';
import { isAgentEnabled } from '../config';
import { onAgentConfigChanged, onAgentStart, onAgentStop } from '../registry';
import { handleAgentConfigChanged } from './config-sync';
import { MANAGED_BY, startReconcile, stopReconcile, syncManagedAutomations } from './heartbeat';
import { clearNotificationQueue } from './notify';
import { deliverReminder, REMINDER_KIND } from './reminders';

import './prompt';
import './routes';
import './tools';

const isMessageReminder = (meta: { kind: string; data?: Record<string, unknown> }) =>
  meta.kind === REMINDER_KIND && meta.data?.mode !== 'task';

registerManagedRunHandler(MANAGED_BY, {
  // A message reminder can still reach the owner by push with the agent off;
  // anything that needs an agent turn waits for the agent to be enabled.
  skipReason: (_automation, meta) => (isMessageReminder(meta) || isAgentEnabled() ? null : 'The agent is disabled on this host'),
  isDirect: isMessageReminder,
  runDirect: deliverReminder,
});

onAgentStart('proactive', () => {
  const rows = syncManagedAutomations();
  startReconcile();
  const on = Object.entries(rows).filter(([, row]) => row?.enabled).map(([kind]) => kind);
  if (on.length) log(`[agent] proactive schedules on: ${on.join(', ')}`);
});

onAgentStop('proactive', () => {
  stopReconcile();
  clearNotificationQueue();
  syncManagedAutomations();
});

onAgentConfigChanged(handleAgentConfigChanged);

export { notifyOwner } from './notify';
export { scheduleReminder, listReminders, cancelReminder } from './reminders';
