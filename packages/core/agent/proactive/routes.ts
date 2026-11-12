/**
 * Authed routes for the Heartbeat section:
 *   GET/PUT /agent/heartbeat · POST /agent/heartbeat/run
 *   GET /agent/reminders · DELETE /agent/reminders/:id
 */

import { ZodError } from 'zod';
import { isAgentEnabled, loadAgentConfig } from '../config';
import { HttpError, errorJson, json, readBody } from '../http';
import { registerRoutes } from '../registry';
import { managedStatus, runManagedNow, syncManagedAutomations, type ManagedKind } from './heartbeat';
import { queuedNotificationCount } from './notify';
import { cancelReminder, listReminders } from './reminders';
import {
  DEFAULT_BRIEF_PROMPT,
  DEFAULT_CHECKLIST,
  DEFAULT_HEARTBEAT_CRON,
  heartbeatMessagesToday,
  heartbeatPatchSchema,
  loadHeartbeatConfig,
  patchHeartbeatConfig,
} from './settings';

function heartbeatSnapshot() {
  const agent = loadAgentConfig();
  const config = loadHeartbeatConfig();
  const today = heartbeatMessagesToday(agent.persona.timezone);
  return {
    config,
    agentEnabled: agent.enabled,
    timezone: agent.persona.timezone,
    quietHours: agent.quietHours,
    today: { day: today.day, sent: today.sent, max: config.maxMessagesPerDay },
    queuedNotifications: queuedNotificationCount(),
    heartbeat: managedStatus('heartbeat'),
    morningBrief: managedStatus('morning_brief'),
    defaults: { interval: DEFAULT_HEARTBEAT_CRON, checklist: DEFAULT_CHECKLIST, briefPrompt: DEFAULT_BRIEF_PROMPT },
  };
}

function firstIssue(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid input';
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

registerRoutes([
  {
    method: 'GET',
    path: '/agent/heartbeat',
    handler: () => {
      // Cheap no-op when nothing drifted; repairs rows after a config edit made elsewhere.
      if (isAgentEnabled()) syncManagedAutomations();
      return json(heartbeatSnapshot());
    },
  },
  {
    method: 'PUT',
    path: '/agent/heartbeat',
    handler: async (req) => {
      const parsed = heartbeatPatchSchema.safeParse(await readBody(req));
      if (!parsed.success) throw new HttpError(400, firstIssue(parsed.error));
      patchHeartbeatConfig(parsed.data);
      syncManagedAutomations();
      return json(heartbeatSnapshot());
    },
  },
  {
    method: 'POST',
    path: '/agent/heartbeat/run',
    handler: async (req) => {
      const body = await readBody<{ kind?: unknown }>(req);
      const kind = body.kind ?? 'heartbeat';
      if (kind !== 'heartbeat' && kind !== 'morning_brief') throw new HttpError(400, 'kind must be "heartbeat" or "morning_brief"');
      const { run } = await runManagedNow(kind as ManagedKind);
      if (!run) return errorJson('A run for this schedule is already being recorded', 409);
      return json({ ok: run.status !== 'skipped' && run.status !== 'failed', skipped: run.status === 'skipped', run });
    },
  },
  {
    method: 'GET',
    path: '/agent/reminders',
    handler: (_req, _params, url) => {
      const all = url.searchParams.get('all');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return json({ reminders: listReminders({ includeDone: all === '1' || all === 'true', limit }) });
    },
  },
  {
    method: 'DELETE',
    path: '/agent/reminders/:id',
    handler: (_req, params) => {
      const id = params.id ?? '';
      if (!/^aut_[\w-]{1,80}$/.test(id)) throw new HttpError(400, 'Invalid reminder id');
      return cancelReminder(id) ? json({ ok: true }) : errorJson('Reminder not found', 404);
    },
  },
]);
