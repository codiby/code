import { corsHeaders } from '../config/config';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  getRun,
  listAutomations,
  listRuns,
  updateAutomation,
} from '../automation/repository';
import { cancelAutomationRun, runAutomation } from '../automation/runner';
import { nextRunFor, scheduleAutomation, unscheduleAutomation } from '../automation/scheduler';
import { automationInputSchema, automationPatchSchema } from '../automation/types';

const RUN_STATUSES = new Set(['scheduled', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped']);

export function handleListAutomations(): Response {
  return Response.json({ automations: listAutomations() }, { headers: corsHeaders });
}

export function handleGetAutomation(id: string): Response {
  const automation = getAutomation(id);
  return automation
    ? Response.json({ automation }, { headers: corsHeaders })
    : Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
}

export async function handleCreateAutomation(req: Request): Promise<Response> {
  try {
    const input = automationInputSchema.parse(await req.json());
    const nextRunAt = input.enabled && input.triggerType === 'cron' && input.cronExpression
      ? nextRunFor(input.cronExpression, input.timezone)
      : null;
    const automation = createAutomation(input, nextRunAt);
    scheduleAutomation(automation);
    return Response.json({ automation }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return invalidInput(error);
  }
}

export async function handleUpdateAutomation(id: string, req: Request): Promise<Response> {
  const current = getAutomation(id);
  if (!current) return Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
  try {
    const patch = automationPatchSchema.parse(await req.json());
    const triggerType = patch.triggerType ?? current.triggerType;
    const cronExpression = patch.cronExpression ?? current.cronExpression;
    const timezone = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    // Only the merged record can tell whether a cron automation still has an
    // expression — e.g. switching a webhook automation over to cron.
    if (triggerType === 'cron' && !cronExpression) {
      return Response.json(
        { error: 'cronExpression is required for cron automations' },
        { status: 400, headers: corsHeaders },
      );
    }
    const nextRunAt = enabled && triggerType === 'cron' && cronExpression
      ? nextRunFor(cronExpression, timezone)
      : null;
    const automation = updateAutomation(id, patch, nextRunAt)!;
    scheduleAutomation(automation);
    return Response.json({ automation }, { headers: corsHeaders });
  } catch (error) {
    return invalidInput(error);
  }
}

/**
 * Webhook entry point — what an external watcher calls when its event fires.
 *
 * Deliberately not guarded by a per-automation secret: the bridge already
 * trusts localhost for every route and demands the bearer token from anything
 * else, so the automation id in the path inherits exactly the same trust model
 * as `/automations/:id/run`.
 */
export async function handleAutomationWebhook(id: string, req?: Request): Promise<Response> {
  const automation = getAutomation(id);
  if (!automation) return Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
  if (automation.triggerType !== 'webhook') {
    return Response.json(
      { error: 'This automation is not webhook-triggered' },
      { status: 409, headers: corsHeaders },
    );
  }
  if (!automation.enabled) {
    return Response.json({ error: 'Automation is paused' }, { status: 409, headers: corsHeaders });
  }
  // The body is whatever the caller sends — the run gets it verbatim so the
  // prompt can react to the specific event. A body that can't be read (or
  // isn't there at all) is not an error: the automation still runs, blind.
  let payload: string | null = null;
  if (req) {
    try {
      const raw = (await req.text()).trim();
      if (raw) payload = prettyJson(raw);
    } catch {}
  }
  const run = await runAutomation(automation, 'webhook', null, payload);
  return run
    ? Response.json({ run }, { status: run.status === 'skipped' ? 409 : 202, headers: corsHeaders })
    : Response.json({ error: 'Run already exists' }, { status: 409, headers: corsHeaders });
}

/** Re-indent JSON bodies so the agent reads a payload, not a single long line. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function handleDeleteAutomation(id: string): Response {
  unscheduleAutomation(id);
  return deleteAutomation(id)
    ? Response.json({ ok: true }, { headers: corsHeaders })
    : Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
}

export async function handleRunAutomation(id: string): Promise<Response> {
  const automation = getAutomation(id);
  if (!automation) return Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
  const run = await runAutomation(automation, 'manual');
  return run
    ? Response.json({ run }, { status: run.status === 'skipped' ? 409 : 202, headers: corsHeaders })
    : Response.json({ error: 'Run already exists' }, { status: 409, headers: corsHeaders });
}

export function handleListAutomationRuns(id: string, req: Request): Response {
  if (!getAutomation(id)) return Response.json({ error: 'Automation not found' }, { status: 404, headers: corsHeaders });
  const params = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
  const before = Number(params.get('before')) || undefined;
  const status = params.get('status') || undefined;
  if (status && !RUN_STATUSES.has(status)) {
    return Response.json({ error: 'Invalid run status' }, { status: 400, headers: corsHeaders });
  }
  const runs = listRuns(id, { limit: limit + 1, before, status });
  const hasMore = runs.length > limit;
  if (hasMore) runs.pop();
  return Response.json({ runs, nextCursor: hasMore ? runs.at(-1)?.createdAt ?? null : null }, { headers: corsHeaders });
}

export function handleGetAutomationRun(automationId: string, runId: string, resultOnly = false): Response {
  const run = getRun(automationId, runId);
  if (!run) return Response.json({ error: 'Run not found' }, { status: 404, headers: corsHeaders });
  return Response.json(resultOnly ? {
    runId: run.id,
    status: run.status,
    resultText: run.resultText,
    error: run.error,
    stopReason: run.stopReason,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
  } : { run }, { headers: corsHeaders });
}

export async function handleCancelAutomationRun(automationId: string, runId: string): Promise<Response> {
  return await cancelAutomationRun(automationId, runId)
    ? Response.json({ ok: true }, { headers: corsHeaders })
    : Response.json({ error: 'Active run not found' }, { status: 404, headers: corsHeaders });
}

function invalidInput(error: unknown): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, {
    status: 400,
    headers: corsHeaders,
  });
}
