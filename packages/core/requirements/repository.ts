/**
 * Requirements repository.
 *
 * Every write goes through here so the signature chain stays intact and the
 * audit trail gets a row. Two invariants the rest of the codebase leans on:
 *
 *   1. The agent can only append and edit drafts. Deleting, locking and
 *      waiving are user actions — the handlers are what enforce the actor,
 *      but the functions are named so misuse is obvious at the call site.
 *   2. `status` / `lastOutput` / `lastVerdict` are written by exactly one
 *      function (`recordRunResult`), called only by the runner.
 */

import { randomUUID } from 'crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { database } from '../database';
import {
  requirementEvents,
  requirementProposals,
  sessionRequirements,
  sessionTargets,
  type RequirementEventRecord,
  type RequirementProposalRecord,
  type RequirementRecord,
} from '../database/schema';
import { signDefinition, signResult, verifyChain } from './signing';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  type ProposalInput,
  type RequirementActor,
  type RequirementInput,
  type RequirementPatch,
  type RequirementProgress,
  type RequirementStatus,
} from './types';

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

export function getTarget(sessionId: string): string | null {
  return database.select().from(sessionTargets)
    .where(eq(sessionTargets.sessionId, sessionId)).get()?.target ?? null;
}

export function setTarget(sessionId: string, target: string, actor: RequirementActor): string {
  const now = Date.now();
  database.insert(sessionTargets)
    .values({ sessionId, target, updatedAt: now })
    .onConflictDoUpdate({ target: sessionTargets.sessionId, set: { target, updatedAt: now } })
    .run();
  logEvent(sessionId, null, 'target_set', actor, target);
  return target;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function rawList(sessionId: string): RequirementRecord[] {
  return database.select().from(sessionRequirements)
    .where(eq(sessionRequirements.sessionId, sessionId))
    .orderBy(asc(sessionRequirements.position)).all();
}

/**
 * List a session's requirements with the signature chain verified. Rows that
 * fail verification are flipped to `tampered` (and a forged run result is
 * downgraded to `failing`) and persisted in that state, so the tampering is
 * sticky rather than something the agent can wash out with another edit.
 */
export function listRequirements(sessionId: string): RequirementRecord[] {
  const rows = rawList(sessionId);
  if (rows.length === 0) return rows;

  const { tamperedIds, forgedResultIds, brokenChain } = verifyChain(rows);
  if (tamperedIds.size === 0 && forgedResultIds.size === 0) return rows;

  const now = Date.now();
  const patched = rows.map((row) => {
    const forged = forgedResultIds.has(row.id);
    const tampered = tamperedIds.has(row.id);
    if (!forged && !tampered) return row;

    const next: RequirementRecord = {
      ...row,
      state: tampered ? 'tampered' : row.state,
      status: forged || tampered ? 'failing' : row.status,
      lastVerdict: forged
        ? 'Run result signature did not verify — the stored outcome was edited outside the runner.'
        : row.lastVerdict,
      updatedAt: now,
    };
    database.update(sessionRequirements).set({
      state: next.state,
      status: next.status,
      lastVerdict: next.lastVerdict,
      resultSignature: signResult(next),
      updatedAt: now,
    }).where(eq(sessionRequirements.id, row.id)).run();
    logEvent(sessionId, row.id, 'tampered', 'runner',
      tampered ? 'Definition signature or chain link failed to verify' : 'Run result signature failed to verify');
    return next;
  });

  if (brokenChain) {
    logEvent(sessionId, null, 'tampered', 'runner', 'Signature chain is broken — a requirement row was removed outside the app');
  }
  return patched;
}

export function getRequirement(sessionId: string, id: string): RequirementRecord | null {
  return listRequirements(sessionId).find(r => r.id === id) ?? null;
}

export function progressFor(sessionId: string): RequirementProgress {
  const rows = listRequirements(sessionId);
  const locked = rows.filter(r => r.state === 'locked');
  return {
    total: rows.length,
    locked: locked.length,
    draft: rows.filter(r => r.state === 'draft').length,
    waived: rows.filter(r => r.state === 'waived').length,
    tampered: rows.filter(r => r.state === 'tampered').length,
    passing: locked.filter(r => r.status === 'passing').length,
    failing: locked.filter(r => r.status === 'failing').length,
    pending: locked.filter(r => r.status === 'pending' || r.status === 'running').length,
    pendingProposals: listProposals(sessionId, 'pending').length,
    complete: locked.length > 0 && locked.every(r => r.status === 'passing'),
  };
}

// ---------------------------------------------------------------------------
// Writes — definition
// ---------------------------------------------------------------------------

function lastRow(sessionId: string): RequirementRecord | null {
  const rows = rawList(sessionId);
  return rows.length ? rows[rows.length - 1]! : null;
}

function checkColumns(input: RequirementInput) {
  if (input.check.type === 'command') {
    return {
      kind: 'command' as const,
      command: input.check.command,
      timeoutMs: input.check.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      judgePrompt: null,
      imagePath: null,
      captureBrowser: null,
      captureUrl: null,
    };
  }
  return {
    kind: 'visual' as const,
    command: null,
    timeoutMs: null,
    judgePrompt: input.check.prompt,
    // `image` is resolved to a stored file path by the caller before it gets
    // here — the repository never touches the filesystem.
    imagePath: input.check.image,
    captureBrowser: input.check.capture?.browser ?? null,
    captureUrl: input.check.capture?.url ?? null,
  };
}

/**
 * Append-only. There is deliberately no "replace the whole list" entry point:
 * that was the shortest path to an agent quietly dropping the requirement it
 * couldn't satisfy.
 */
export function addRequirements(
  sessionId: string,
  inputs: RequirementInput[],
  actor: RequirementActor,
): RequirementRecord[] {
  const now = Date.now();
  let prev = lastRow(sessionId);
  let position = prev ? prev.position + 1 : 0;
  const created: RequirementRecord[] = [];

  for (const input of inputs) {
    const base = {
      id: `req_${randomUUID()}`,
      sessionId,
      position,
      title: input.title,
      ...checkColumns(input),
      state: 'draft' as const,
      status: 'pending' as const,
      waiverReason: null,
      lastExitCode: null,
      lastOutput: null,
      lastVerdict: null,
      lastImagePath: null,
      lastRunAt: null,
      prevHash: prev?.signature ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const row: RequirementRecord = {
      ...base,
      signature: signDefinition(base, base.prevHash),
      resultSignature: null,
    };
    database.insert(sessionRequirements).values(row).run();
    logEvent(sessionId, row.id, 'created', actor, row.title);
    created.push(row);
    prev = row;
    position += 1;
  }
  return created;
}

/**
 * Re-sign a row after a definition change, then re-sign every row after it so
 * the chain stays continuous.
 */
function resignFrom(sessionId: string, startPosition: number): void {
  const rows = rawList(sessionId);
  let prevHash: string | null = null;
  for (const row of rows) {
    // A tampered row keeps its broken signature: re-signing here would let an
    // unrelated edit elsewhere in the list launder it back to valid.
    if (row.position < startPosition || row.state === 'tampered') {
      prevHash = row.signature;
      continue;
    }
    const signature = signDefinition(row, prevHash);
    if (signature !== row.signature || (row.prevHash ?? null) !== prevHash) {
      database.update(sessionRequirements).set({ prevHash, signature })
        .where(eq(sessionRequirements.id, row.id)).run();
    }
    prevHash = signature;
  }
}

function applyPatch(row: RequirementRecord, patch: RequirementPatch): Partial<RequirementRecord> {
  const next: Partial<RequirementRecord> = {};
  if (patch.title) next.title = patch.title;
  if (patch.check) Object.assign(next, checkColumns({ title: patch.title ?? row.title, check: patch.check }));
  return next;
}

/**
 * Edit a requirement's definition. `actor: 'agent'` is rejected for anything
 * that isn't a draft — the agent's only route past that is `createProposal`.
 */
export function editRequirement(
  sessionId: string,
  id: string,
  patch: RequirementPatch,
  actor: RequirementActor,
): { ok: true; requirement: RequirementRecord } | { ok: false; error: string } {
  const row = getRequirement(sessionId, id);
  if (!row) return { ok: false, error: `No requirement with id "${id}" in this session.` };
  if (actor === 'agent' && row.state !== 'draft') {
    return {
      ok: false,
      error: `Requirement "${row.title}" is ${row.state}; you cannot edit it. Use propose_change to ask the user.`,
    };
  }
  const now = Date.now();
  database.update(sessionRequirements)
    .set({ ...applyPatch(row, patch), updatedAt: now })
    .where(eq(sessionRequirements.id, id)).run();
  resignFrom(sessionId, row.position);
  logEvent(sessionId, id, 'edited', actor, JSON.stringify(patch).slice(0, 500));
  return { ok: true, requirement: getRequirement(sessionId, id)! };
}

/** Swap the reference image without rewriting the rest of the definition. */
export function setRequirementImage(
  sessionId: string,
  id: string,
  imagePath: string,
  actor: RequirementActor,
): { ok: true; requirement: RequirementRecord } | { ok: false; error: string } {
  const row = getRequirement(sessionId, id);
  if (!row) return { ok: false, error: `No requirement with id "${id}" in this session.` };
  if (row.kind !== 'visual') return { ok: false, error: `Requirement "${row.title}" is not a visual check.` };
  if (actor === 'agent' && row.state !== 'draft') {
    return { ok: false, error: `Requirement "${row.title}" is ${row.state}; use propose_change instead.` };
  }
  database.update(sessionRequirements).set({ imagePath, updatedAt: Date.now() })
    .where(eq(sessionRequirements.id, id)).run();
  resignFrom(sessionId, row.position);
  logEvent(sessionId, id, 'edited', actor, `image → ${imagePath}`);
  return { ok: true, requirement: getRequirement(sessionId, id)! };
}

/** User-only: approve a draft so it becomes binding. */
export function lockRequirement(sessionId: string, id: string): RequirementRecord | null {
  const row = getRequirement(sessionId, id);
  if (!row || row.state === 'tampered') return null;
  database.update(sessionRequirements).set({ state: 'locked', updatedAt: Date.now() })
    .where(eq(sessionRequirements.id, id)).run();
  resignFrom(sessionId, row.position);
  logEvent(sessionId, id, 'locked', 'user', row.title);
  return getRequirement(sessionId, id);
}

/** User-only: send a locked requirement back to draft. */
export function unlockRequirement(sessionId: string, id: string): RequirementRecord | null {
  const row = getRequirement(sessionId, id);
  if (!row || row.state === 'tampered') return null;
  database.update(sessionRequirements).set({ state: 'draft', updatedAt: Date.now() })
    .where(eq(sessionRequirements.id, id)).run();
  resignFrom(sessionId, row.position);
  logEvent(sessionId, id, 'unlocked', 'user', row.title);
  return getRequirement(sessionId, id);
}

/** User-only: accept that this one won't be met. Never counts as a pass. */
export function waiveRequirement(sessionId: string, id: string, reason: string): RequirementRecord | null {
  const row = getRequirement(sessionId, id);
  if (!row || row.state === 'tampered') return null;
  database.update(sessionRequirements).set({ state: 'waived', waiverReason: reason, updatedAt: Date.now() })
    .where(eq(sessionRequirements.id, id)).run();
  resignFrom(sessionId, row.position);
  logEvent(sessionId, id, 'waived', 'user', reason);
  return getRequirement(sessionId, id);
}

/** User-only. There is no agent-facing path to this function. */
export function deleteRequirement(sessionId: string, id: string): boolean {
  const row = getRequirement(sessionId, id);
  if (!row) return false;
  database.delete(sessionRequirements).where(eq(sessionRequirements.id, id)).run();
  // Close the gap so positions stay dense, then re-sign the whole chain.
  const rows = rawList(sessionId);
  rows.forEach((r, i) => {
    if (r.position !== i) {
      database.update(sessionRequirements).set({ position: i }).where(eq(sessionRequirements.id, r.id)).run();
    }
  });
  resignFrom(sessionId, 0);
  logEvent(sessionId, id, 'deleted', 'user', row.title);
  return true;
}

// ---------------------------------------------------------------------------
// Writes — run results (runner only)
// ---------------------------------------------------------------------------

export function markRunning(sessionId: string, id: string): void {
  const row = getRequirement(sessionId, id);
  if (!row) return;
  const next = { ...row, status: 'running' as RequirementStatus, lastRunAt: Date.now() };
  database.update(sessionRequirements).set({
    status: next.status,
    lastRunAt: next.lastRunAt,
    resultSignature: signResult(next),
  }).where(eq(sessionRequirements.id, id)).run();
}

export function recordRunResult(
  sessionId: string,
  id: string,
  result: {
    status: Extract<RequirementStatus, 'passing' | 'failing'>;
    exitCode?: number | null;
    output?: string | null;
    verdict?: string | null;
    imagePath?: string | null;
  },
): RequirementRecord | null {
  const row = getRequirement(sessionId, id);
  if (!row) return null;
  // A tampered row can never be reported as passing, whatever the check said.
  const status = row.state === 'tampered' ? 'failing' : result.status;
  const now = Date.now();
  const next = {
    ...row,
    status,
    lastExitCode: result.exitCode ?? null,
    lastVerdict: result.verdict ?? null,
    lastRunAt: now,
  };
  database.update(sessionRequirements).set({
    status,
    lastExitCode: next.lastExitCode,
    lastOutput: (result.output ?? '').slice(-MAX_OUTPUT_CHARS) || null,
    lastVerdict: next.lastVerdict,
    lastImagePath: result.imagePath ?? null,
    lastRunAt: now,
    resultSignature: signResult(next),
    updatedAt: now,
  }).where(eq(sessionRequirements.id, id)).run();
  logEvent(sessionId, id, 'run', 'runner', `${status}${result.exitCode != null ? ` (exit ${result.exitCode})` : ''}`);
  return getRequirement(sessionId, id);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export function createProposal(
  sessionId: string,
  requirementId: string,
  input: ProposalInput,
): { ok: true; proposal: RequirementProposalRecord } | { ok: false; error: string } {
  const row = getRequirement(sessionId, requirementId);
  if (!row) return { ok: false, error: `No requirement with id "${requirementId}" in this session.` };
  if (input.action === 'edit' && !input.payload) {
    return { ok: false, error: 'An `edit` proposal needs a `payload` with the change you want.' };
  }
  const proposal: RequirementProposalRecord = {
    id: `prp_${randomUUID()}`,
    sessionId,
    requirementId,
    action: input.action,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    reason: input.reason,
    status: 'pending',
    createdAt: Date.now(),
    resolvedAt: null,
  };
  database.insert(requirementProposals).values(proposal).run();
  logEvent(sessionId, requirementId, 'proposed', 'agent', `${input.action}: ${input.reason}`);
  return { ok: true, proposal };
}

export function listProposals(sessionId: string, status?: string): RequirementProposalRecord[] {
  const filters = [eq(requirementProposals.sessionId, sessionId)];
  if (status) filters.push(eq(requirementProposals.status, status));
  return database.select().from(requirementProposals).where(and(...filters))
    .orderBy(desc(requirementProposals.createdAt)).all();
}

export function getProposal(sessionId: string, id: string): RequirementProposalRecord | null {
  return database.select().from(requirementProposals).where(and(
    eq(requirementProposals.id, id), eq(requirementProposals.sessionId, sessionId),
  )).get() ?? null;
}

/** User-only. Approving is what actually applies the change. */
export function resolveProposal(
  sessionId: string,
  id: string,
  decision: 'approved' | 'rejected',
): { ok: true; proposal: RequirementProposalRecord } | { ok: false; error: string } {
  const proposal = getProposal(sessionId, id);
  if (!proposal) return { ok: false, error: 'Proposal not found' };
  if (proposal.status !== 'pending') return { ok: false, error: 'Proposal was already resolved' };

  if (decision === 'approved') {
    if (proposal.action === 'delete') {
      deleteRequirement(sessionId, proposal.requirementId);
    } else if (proposal.action === 'waive') {
      waiveRequirement(sessionId, proposal.requirementId, proposal.reason);
    } else if (proposal.action === 'edit' && proposal.payload) {
      editRequirement(sessionId, proposal.requirementId, JSON.parse(proposal.payload), 'user');
    }
  }

  database.update(requirementProposals)
    .set({ status: decision, resolvedAt: Date.now() })
    .where(eq(requirementProposals.id, id)).run();
  logEvent(sessionId, proposal.requirementId, decision === 'approved' ? 'approved' : 'rejected', 'user',
    `${proposal.action}: ${proposal.reason}`);
  return { ok: true, proposal: getProposal(sessionId, id)! };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export function logEvent(
  sessionId: string,
  requirementId: string | null,
  event: string,
  actor: RequirementActor,
  detail?: string | null,
): void {
  database.insert(requirementEvents).values({
    id: `evt_${randomUUID()}`,
    sessionId,
    requirementId,
    event,
    actor,
    detail: detail ?? null,
    createdAt: Date.now(),
  }).run();
}

export function listEvents(sessionId: string, limit = 200): RequirementEventRecord[] {
  return database.select().from(requirementEvents)
    .where(eq(requirementEvents.sessionId, sessionId))
    .orderBy(desc(requirementEvents.createdAt)).limit(limit).all();
}

/** Everything the panel and the loop driver need in one read. */
export function snapshotFor(sessionId: string) {
  return {
    target: getTarget(sessionId),
    requirements: listRequirements(sessionId),
    proposals: listProposals(sessionId, 'pending'),
    progress: progressFor(sessionId),
  };
}
