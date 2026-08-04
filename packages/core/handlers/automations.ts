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
    const nextRunAt = input.enabled ? nextRunFor(input.cronExpression, input.timezone) : null;
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
    const cronExpression = patch.cronExpression ?? current.cronExpression;
    const timezone = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    const nextRunAt = enabled ? nextRunFor(cronExpression, timezone) : null;
    const automation = updateAutomation(id, patch, nextRunAt)!;
    scheduleAutomation(automation);
    return Response.json({ automation }, { headers: corsHeaders });
  } catch (error) {
    return invalidInput(error);
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
