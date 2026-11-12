/**
 * Managed automations — rows a feature owns (the agent's heartbeat, morning
 * brief and reminders) rather than a person.
 *
 * The marker lives in the `description` column as a reserved JSON envelope
 * (`{"$managed": {...}}`) so no schema change is needed. The public API
 * refuses descriptions that look like the envelope, so a hand-made automation
 * can never pass itself off as a managed one, and responses swap the
 * envelope for its human `label` before anything renders it.
 *
 * Owners also plug into the runner here (`registerManagedRunHandler`): they
 * can veto a run (e.g. the agent is off on this host) or handle it in code
 * instead of an LLM turn (a reminder delivered verbatim).
 */

import type { AutomationRecord } from '../database/schema';
import { sessions } from '../session/sessions';
import { listAutomations } from './repository';
import type { AutomationRunTrigger } from './types';

const MARKER = '$managed';

export interface ManagedMeta {
  /** Owning feature, e.g. 'agent'. */
  by: string;
  /** Feature-specific kind: 'heartbeat', 'morning_brief', 'reminder'… */
  kind: string;
  /** What the Automations screen shows in place of a description. */
  label: string;
  /** Deleting it from the generic API is allowed (reminders: delete = cancel). */
  deletable?: boolean;
  /** Where the owner edits it instead, e.g. "Agent › Heartbeat". */
  editHint?: string;
  /** Kind-specific payload (reminder mode, priority, original text…). */
  data?: Record<string, unknown>;
}

export function encodeManagedMeta(meta: ManagedMeta): string {
  return JSON.stringify({ [MARKER]: meta });
}

export function parseManagedMeta(description: string | null | undefined): ManagedMeta | null {
  if (!description || !description.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(description) as Record<string, unknown>;
    const meta = parsed?.[MARKER] as Partial<ManagedMeta> | undefined;
    if (!meta || typeof meta !== 'object') return null;
    if (typeof meta.by !== 'string' || typeof meta.kind !== 'string') return null;
    return {
      by: meta.by,
      kind: meta.kind,
      label: typeof meta.label === 'string' ? meta.label : meta.kind,
      deletable: meta.deletable === true,
      editHint: typeof meta.editHint === 'string' ? meta.editHint : undefined,
      data: meta.data && typeof meta.data === 'object' ? meta.data as Record<string, unknown> : undefined,
    };
  } catch {
    return null;
  }
}

/** True for a description a caller must not be allowed to store through the public API. */
export function isReservedDescription(description: string | null | undefined): boolean {
  if (!description || !description.trimStart().startsWith('{')) return false;
  try {
    const parsed = JSON.parse(description) as Record<string, unknown>;
    return !!parsed && typeof parsed === 'object' && MARKER in parsed;
  } catch {
    return false;
  }
}

export function isManagedAutomation(record: Pick<AutomationRecord, 'description'>): boolean {
  return parseManagedMeta(record.description) !== null;
}

/** Live (not deleted) automations one feature owns, optionally of one kind, newest first. */
export function listManaged(by: string, kind?: string): { automation: AutomationRecord; meta: ManagedMeta }[] {
  const out: { automation: AutomationRecord; meta: ManagedMeta }[] = [];
  for (const automation of listAutomations()) {
    const meta = parseManagedMeta(automation.description);
    if (meta && meta.by === by && (!kind || meta.kind === kind)) out.push({ automation, meta });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run hooks
// ---------------------------------------------------------------------------

export interface DirectRunContext {
  runId: string;
  trigger: AutomationRunTrigger;
  scheduledFor: number | null;
}

export interface DirectRunResult {
  ok: boolean;
  resultText?: string;
  error?: string;
}

export interface ManagedRunHandler {
  /** A reason to record the run as `skipped` instead of starting it, or null to go ahead. */
  skipReason?(automation: AutomationRecord, meta: ManagedMeta): string | null;
  /** True when this run is plain code (no LLM turn, no session). */
  isDirect?(meta: ManagedMeta): boolean;
  runDirect?(automation: AutomationRecord, meta: ManagedMeta, ctx: DirectRunContext): Promise<DirectRunResult>;
}

const runHandlers = new Map<string, ManagedRunHandler>();

/** One handler per owning feature (`meta.by`); a later registration replaces the earlier one. */
export function registerManagedRunHandler(by: string, handler: ManagedRunHandler): void {
  runHandlers.set(by, handler);
}

export function managedRunHandler(by: string): ManagedRunHandler | null {
  return runHandlers.get(by) ?? null;
}

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

export interface SerializedAutomation extends AutomationRecord {
  /** Null for automations a person made; set for rows a feature owns. */
  managed: Omit<ManagedMeta, 'data'> | null;
  /** Display name of `targetSessionId`, when that session still exists. */
  targetSessionName: string | null;
}

/** The API shape: the envelope never leaves the bridge as raw JSON. */
export function serializeAutomation(record: AutomationRecord): SerializedAutomation {
  const meta = parseManagedMeta(record.description);
  const target = record.targetSessionId ? sessions.get(record.targetSessionId) : undefined;
  return {
    ...record,
    description: meta ? meta.label : record.description,
    managed: meta ? { by: meta.by, kind: meta.kind, label: meta.label, deletable: meta.deletable, editHint: meta.editHint } : null,
    targetSessionName: target?.name ?? null,
  };
}
