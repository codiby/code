import { corsHeaders } from '../config/config';
import type { AutomationRecord } from '../database/schema';
import { isReservedDescription, parseManagedMeta, serializeAutomation } from '../automation/managed';
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
import { plannedNextRun, scheduleAutomation, unscheduleAutomation } from '../automation/scheduler';
import { automationInputSchema, automationPatchSchema } from '../automation/types';
import { sessions } from '../session/sessions';

const RUN_STATUSES = new Set(['scheduled', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped']);

/**
 * How far in the past a one-shot `runAt` may be when it is saved. A few
 * seconds of form latency should fire straight away rather than bounce;
 * anything older is almost certainly a typo'd date.
 */
const RUN_AT_SLACK_MS = 60_000;

class InvalidInput extends Error {}

function fail(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: corsHeaders });
}

function ok(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

export function handleListAutomations(): Response {
  return ok({ automations: listAutomations().map(serializeAutomation) });
}

export function handleGetAutomation(id: string): Response {
  const automation = getAutomation(id);
  return automation ? ok({ automation: serializeAutomation(automation) }) : fail('Automation not found', 404);
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new InvalidInput(`Unknown timezone "${timezone}"`);
  }
}

/** The session a targeted automation continues — it has to exist when the automation is saved. */
function resolveTarget(targetSessionId: string | null | undefined) {
  if (!targetSessionId) return null;
  const target = sessions.get(targetSessionId);
  if (!target) throw new InvalidInput(`Target session ${targetSessionId} does not exist`);
  return target;
}

function assertRunAt(triggerType: string, enabled: boolean, runAt: number | null | undefined): void {
  if (triggerType !== 'once' || !enabled) return;
  if (!runAt) throw new InvalidInput('runAt is required for one-shot automations');
  if (runAt < Date.now() - RUN_AT_SLACK_MS) {
    throw new InvalidInput('runAt is in the past — pick a future time for a one-shot automation');
  }
}

export async function handleCreateAutomation(req: Request): Promise<Response> {
  try {
    const input = automationInputSchema.parse(await req.json());
    if (isReservedDescription(input.description)) throw new InvalidInput('That description format is reserved');
    assertTimezone(input.timezone);
    assertRunAt(input.triggerType, input.enabled, input.runAt);
    const target = resolveTarget(input.targetSessionId);
    // A targeted run happens in the session's own folder; the column is
    // still required, so it records that folder.
    const cwd = input.cwd ?? target!.cwd;
    const nextRunAt = plannedNextRun({ ...input, cronExpression: input.cronExpression ?? null, runAt: input.runAt ?? null });
    const automation = createAutomation({ ...input, cwd }, nextRunAt);
    scheduleAutomation(automation);
    return ok({ automation: serializeAutomation(getAutomation(automation.id) ?? automation) }, 201);
  } catch (error) {
    return invalidInput(error);
  }
}

/**
 * Rows a feature owns (the agent's heartbeat, reminders…) are edited through
 * that feature, which keeps its own config in step; the generic API only
 * reads them.
 */
function managedConflict(record: AutomationRecord, action: 'edit' | 'delete'): Response | null {
  const meta = parseManagedMeta(record.description);
  if (!meta) return null;
  if (action === 'delete' && meta.deletable) return null;
  const where = meta.editHint ? ` — change it in ${meta.editHint}` : '';
  return fail(`"${record.name}" is managed by the ${meta.by === 'agent' ? 'Agent' : meta.by}${where}`, 409);
}

export async function handleUpdateAutomation(id: string, req: Request): Promise<Response> {
  const current = getAutomation(id);
  if (!current) return fail('Automation not found', 404);
  const conflict = managedConflict(current, 'edit');
  if (conflict) return conflict;
  try {
    const patch = automationPatchSchema.parse(await req.json());
    if ('description' in patch && isReservedDescription(patch.description)) throw new InvalidInput('That description format is reserved');
    const merged = {
      triggerType: patch.triggerType ?? current.triggerType,
      cronExpression: patch.cronExpression !== undefined ? patch.cronExpression ?? null : current.cronExpression,
      runAt: patch.runAt !== undefined ? patch.runAt ?? null : current.runAt,
      timezone: patch.timezone ?? current.timezone,
      enabled: patch.enabled ?? current.enabled,
    };
    // Only the merged record can tell whether a cron automation still has an
    // expression — e.g. switching a webhook automation over to cron.
    if (merged.triggerType === 'cron' && !merged.cronExpression) {
      throw new InvalidInput('cronExpression is required for cron automations');
    }
    if (patch.timezone) assertTimezone(patch.timezone);
    // Re-enabling a one-shot that already fired needs a new time; a paused
    // one-shot may keep its past time for the record.
    assertRunAt(merged.triggerType, merged.enabled, merged.runAt);
    if (patch.targetSessionId) resolveTarget(patch.targetSessionId);
    const nextRunAt = plannedNextRun(merged);
    const automation = updateAutomation(id, patch, nextRunAt)!;
    scheduleAutomation(automation);
    return ok({ automation: serializeAutomation(getAutomation(id) ?? automation) });
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
  if (!automation) return fail('Automation not found', 404);
  if (automation.triggerType !== 'webhook') return fail('This automation is not webhook-triggered', 409);
  if (!automation.enabled) return fail('Automation is paused', 409);
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
  return run ? ok({ run }, run.status === 'skipped' ? 409 : 202) : fail('Run already exists', 409);
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
  const current = getAutomation(id);
  if (!current) return fail('Automation not found', 404);
  const conflict = managedConflict(current, 'delete');
  if (conflict) return conflict;
  unscheduleAutomation(id);
  return deleteAutomation(id) ? ok({ ok: true }) : fail('Automation not found', 404);
}

export async function handleRunAutomation(id: string): Promise<Response> {
  const automation = getAutomation(id);
  if (!automation) return fail('Automation not found', 404);
  const run = await runAutomation(automation, 'manual');
  return run ? ok({ run }, run.status === 'skipped' ? 409 : 202) : fail('Run already exists', 409);
}

export function handleListAutomationRuns(id: string, req: Request): Response {
  if (!getAutomation(id)) return fail('Automation not found', 404);
  const params = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
  const before = Number(params.get('before')) || undefined;
  const status = params.get('status') || undefined;
  if (status && !RUN_STATUSES.has(status)) return fail('Invalid run status');
  const runs = listRuns(id, { limit: limit + 1, before, status });
  const hasMore = runs.length > limit;
  if (hasMore) runs.pop();
  return ok({ runs, nextCursor: hasMore ? runs.at(-1)?.createdAt ?? null : null });
}

export function handleGetAutomationRun(automationId: string, runId: string, resultOnly = false): Response {
  const run = getRun(automationId, runId);
  if (!run) return fail('Run not found', 404);
  return ok(resultOnly ? {
    runId: run.id,
    status: run.status,
    resultText: run.resultText,
    error: run.error,
    stopReason: run.stopReason,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
  } : { run });
}

export async function handleCancelAutomationRun(automationId: string, runId: string): Promise<Response> {
  return await cancelAutomationRun(automationId, runId)
    ? ok({ ok: true })
    : fail('Active run not found', 404);
}

function invalidInput(error: unknown): Response {
  return fail(error instanceof Error ? error.message : String(error));
}
