/**
 * HTTP surface for session requirements.
 *
 * Everything the agent cannot do lives here: approving a draft, deleting,
 * waiving, and resolving the proposals it queued. The actor passed into the
 * repository is `'user'` for every one of these routes — that split is the
 * whole anti-cheat story, so keep it that way.
 */

import { corsHeaders } from '../config/config';
import {
  createProposal,
  deleteRequirement,
  editRequirement,
  getRequirement,
  listEvents,
  lockRequirement,
  resolveProposal,
  setTarget,
  snapshotFor,
  unlockRequirement,
  waiveRequirement,
} from '../requirements/repository';
import { broadcastRequirements, runRequirements, storeRequirementImage } from '../requirements/runner';
import {
  degenerateCheckWarning,
  proposalInputSchema,
  requirementInputSchema,
  requirementPatchSchema,
  targetSchema,
  type RequirementInput,
} from '../requirements/types';
import { addRequirements } from '../requirements/repository';
import { sessions } from '../session/sessions';
import { z } from 'zod';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });
const notFound = (what: string) => json({ error: `${what} not found` }, 404);

function invalidInput(error: unknown): Response {
  return json({ error: error instanceof Error ? error.message : String(error) }, 400);
}

function requireSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Snapshot + a per-requirement warning for checks that can't really fail. */
function payloadFor(sessionId: string) {
  const snapshot = snapshotFor(sessionId);
  return {
    ...snapshot,
    requirements: snapshot.requirements.map(r => ({
      ...r,
      degenerateWarning: degenerateCheckWarning(r.kind as 'command' | 'visual', r.command, r.judgePrompt),
    })),
  };
}

export function handleGetRequirements(sessionId: string): Response {
  if (!requireSession(sessionId)) return notFound('Session');
  return json(payloadFor(sessionId));
}

export async function handleSetTarget(sessionId: string, req: Request): Promise<Response> {
  if (!requireSession(sessionId)) return notFound('Session');
  try {
    const { target } = targetSchema.parse(await req.json());
    setTarget(sessionId, target, 'user');
    broadcastRequirements(sessionId);
    return json(payloadFor(sessionId));
  } catch (error) {
    return invalidInput(error);
  }
}

const createBodySchema = z.object({
  requirements: z.array(requirementInputSchema).min(1).max(50),
});

export async function handleAddRequirements(sessionId: string, req: Request): Promise<Response> {
  if (!requireSession(sessionId)) return notFound('Session');
  try {
    const { requirements } = createBodySchema.parse(await req.json());
    const prepared: RequirementInput[] = [];
    for (const item of requirements) {
      if (item.check.type === 'visual') {
        const stored = await storeRequirementImage(sessionId, `ref-${Date.now()}-${prepared.length}`, item.check.image);
        prepared.push({ ...item, check: { ...item.check, image: stored } });
      } else {
        prepared.push(item);
      }
    }
    addRequirements(sessionId, prepared, 'user');
    broadcastRequirements(sessionId);
    return json(payloadFor(sessionId), 201);
  } catch (error) {
    return invalidInput(error);
  }
}

export async function handleUpdateRequirement(sessionId: string, id: string, req: Request): Promise<Response> {
  if (!requireSession(sessionId)) return notFound('Session');
  if (!getRequirement(sessionId, id)) return notFound('Requirement');
  try {
    const body = await req.json() as Record<string, unknown>;

    // Lifecycle transitions are their own verbs rather than a `state` field —
    // an approval is not the same kind of edit as a title change.
    if (typeof body.action === 'string') {
      const action = body.action;
      if (action === 'lock') {
        const updated = lockRequirement(sessionId, id);
        if (!updated) return json({ error: 'Cannot approve a tampered requirement' }, 409);
      } else if (action === 'unlock') {
        if (!unlockRequirement(sessionId, id)) return json({ error: 'Cannot unlock a tampered requirement' }, 409);
      } else if (action === 'waive') {
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Waived by the user';
        if (!waiveRequirement(sessionId, id, reason)) return json({ error: 'Cannot waive a tampered requirement' }, 409);
      } else {
        return json({ error: `Unknown action "${action}"` }, 400);
      }
      broadcastRequirements(sessionId);
      return json(payloadFor(sessionId));
    }

    const patch = requirementPatchSchema.parse(body);
    if (patch.check?.type === 'visual') {
      patch.check.image = await storeRequirementImage(sessionId, `ref-${id}-${Date.now()}`, patch.check.image);
    }
    const result = editRequirement(sessionId, id, patch, 'user');
    if (!result.ok) return json({ error: result.error }, 400);
    broadcastRequirements(sessionId);
    return json(payloadFor(sessionId));
  } catch (error) {
    return invalidInput(error);
  }
}

export function handleDeleteRequirement(sessionId: string, id: string): Response {
  if (!requireSession(sessionId)) return notFound('Session');
  if (!deleteRequirement(sessionId, id)) return notFound('Requirement');
  broadcastRequirements(sessionId);
  return json(payloadFor(sessionId));
}

export async function handleRunRequirements(sessionId: string, req: Request): Promise<Response> {
  if (!requireSession(sessionId)) return notFound('Session');
  let ids: string[] | undefined;
  try {
    const body = await req.json().catch(() => ({})) as { ids?: unknown };
    if (Array.isArray(body.ids)) ids = body.ids.filter((x): x is string => typeof x === 'string');
  } catch {
    // No body — run everything.
  }
  const summary = await runRequirements(sessionId, ids);
  return json({ summary, ...payloadFor(sessionId) });
}

export async function handleCreateProposal(sessionId: string, id: string, req: Request): Promise<Response> {
  if (!requireSession(sessionId)) return notFound('Session');
  try {
    const input = proposalInputSchema.parse(await req.json());
    const result = createProposal(sessionId, id, input);
    if (!result.ok) return json({ error: result.error }, 400);
    broadcastRequirements(sessionId);
    return json({ proposal: result.proposal }, 201);
  } catch (error) {
    return invalidInput(error);
  }
}

export function handleResolveProposal(
  sessionId: string,
  proposalId: string,
  decision: 'approved' | 'rejected',
): Response {
  if (!requireSession(sessionId)) return notFound('Session');
  const result = resolveProposal(sessionId, proposalId, decision);
  if (!result.ok) return json({ error: result.error }, result.error === 'Proposal not found' ? 404 : 409);
  broadcastRequirements(sessionId);
  return json({ proposal: result.proposal, ...payloadFor(sessionId) });
}

export function handleListRequirementEvents(sessionId: string, req: Request): Response {
  if (!requireSession(sessionId)) return notFound('Session');
  const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 200));
  return json({ events: listEvents(sessionId, limit) });
}
