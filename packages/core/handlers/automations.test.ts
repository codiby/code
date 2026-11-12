import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { encodeManagedMeta } from '../automation/managed';
import * as repository from '../automation/repository';
import { unscheduleAutomation } from '../automation/scheduler';
import { sessions } from '../session/sessions';
import type { Session } from '../types';
import {
  handleCreateAutomation,
  handleDeleteAutomation,
  handleGetAutomation,
  handleUpdateAutomation,
} from './automations';

const created: string[] = [];

function post(body: unknown): Request {
  return new Request('http://localhost/automations', { method: 'POST', body: JSON.stringify(body) });
}

function patch(body: unknown): Request {
  return new Request('http://localhost/automations/x', { method: 'PATCH', body: JSON.stringify(body) });
}

async function create(body: Record<string, unknown>) {
  const res = await handleCreateAutomation(post(body));
  const json = await res.json() as { automation?: any; error?: string };
  if (json.automation) created.push(json.automation.id);
  return { status: res.status, ...json };
}

afterAll(() => {
  for (const id of created) unscheduleAutomation(id);
});

describe('automation routes', () => {
  test('a one-shot is scheduled for its runAt', async () => {
    const runAt = Date.now() + 2 * 3_600_000;
    const res = await create({ name: 'Later', prompt: 'Do it', cwd: '/tmp', triggerType: 'once', runAt: new Date(runAt).toISOString() });
    expect(res.status).toBe(201);
    expect(res.automation.triggerType).toBe('once');
    expect(res.automation.runAt).toBe(runAt);
    expect(res.automation.nextRunAt).toBe(runAt);
    expect(res.automation.managed).toBeNull();
  });

  test('a one-shot in the past is refused', async () => {
    const res = await create({ name: 'Too late', prompt: 'x', cwd: '/tmp', triggerType: 'once', runAt: Date.now() - 3_600_000 });
    expect(res.status).toBe(400);
    expect(res.error).toContain('in the past');
  });

  test('a targeted automation takes its folder from the session, and an unknown target is refused', async () => {
    const id = `tab-${randomUUID().slice(0, 8)}`;
    sessions.set(id, { id, name: 'My tab', cwd: '/tmp/tab-folder' } as unknown as Session);
    const res = await create({ name: 'Continue', prompt: 'Go on', cronExpression: '0 9 * * *', targetSessionId: id });
    expect(res.status).toBe(201);
    expect(res.automation.cwd).toBe('/tmp/tab-folder');
    expect(res.automation.targetSessionId).toBe(id);
    expect(res.automation.targetSessionName).toBe('My tab');

    const missing = await create({ name: 'Nowhere', prompt: 'x', cronExpression: '0 9 * * *', targetSessionId: 'nope' });
    expect(missing.status).toBe(400);
    sessions.delete(id);
  });

  test('the managed envelope cannot be forged, and managed rows are read-only', async () => {
    const forged = await create({
      name: 'Fake', prompt: 'x', cwd: '/tmp', cronExpression: '0 9 * * *',
      description: encodeManagedMeta({ by: 'agent', kind: 'heartbeat', label: 'Heartbeat' }),
    });
    expect(forged.status).toBe(400);

    const managed = repository.createAutomation({
      name: 'Heartbeat', description: encodeManagedMeta({ by: 'agent', kind: 'heartbeat', label: 'Check-in', editHint: 'Agent › Heartbeat' }),
      triggerType: 'cron', cronExpression: '0 9 * * *', timezone: 'UTC', enabled: false, prompt: 'x', cwd: '/tmp',
      provider: 'claude', permissionMode: 'default', concurrencyPolicy: 'skip',
    }, null);
    const view = await (handleGetAutomation(managed.id)).json() as { automation: any };
    expect(view.automation.description).toBe('Check-in');
    expect(view.automation.managed).toMatchObject({ by: 'agent', kind: 'heartbeat', editHint: 'Agent › Heartbeat' });

    const edit = await handleUpdateAutomation(managed.id, patch({ enabled: true }));
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { error: string }).error).toContain('Agent › Heartbeat');
    expect(handleDeleteAutomation(managed.id).status).toBe(409);

    const reminder = repository.createAutomation({
      name: 'Reminder', description: encodeManagedMeta({ by: 'agent', kind: 'reminder', label: 'Reminder', deletable: true }),
      triggerType: 'once', runAt: Date.now() + 60_000, timezone: 'UTC', enabled: true, prompt: 'x', cwd: '/tmp',
      provider: 'claude', permissionMode: 'default', concurrencyPolicy: 'skip',
    }, null);
    expect(handleDeleteAutomation(reminder.id).status).toBe(200);
  });

  test('re-enabling a fired one-shot needs a new time', async () => {
    const res = await create({ name: 'Once', prompt: 'x', cwd: '/tmp', triggerType: 'once', runAt: Date.now() + 60_000 });
    const id = res.automation.id as string;
    repository.updateAutomation(id, { enabled: false, runAt: Date.now() - 3_600_000 }, null);
    const stale = await handleUpdateAutomation(id, patch({ enabled: true }));
    expect(stale.status).toBe(400);
    const fresh = await handleUpdateAutomation(id, patch({ enabled: true, runAt: Date.now() + 3_600_000 }));
    expect(fresh.status).toBe(200);
  });
});
