import { agentDeps, hasAgentDeps } from '../agent/runtime';
import type { AutomationRecord, AutomationRunRecord } from '../database/schema';
import { handleCreateSession } from '../handlers/sessions';
import { log, logError } from '../lib/logger';
import type { TurnCompleteInfo } from '../provider/types';
import { sessions } from '../session/sessions';
import { getSessionState, isSubagentChatter } from '../session/state';
import { managedRunHandler, parseManagedMeta, type ManagedMeta, type ManagedRunHandler } from './managed';
import {
  completeRun,
  createRun,
  finishRun,
  finishRunBySession,
  getActiveRunBySession,
  getAutomationRecord,
  getRun,
  hasActiveRun,
  startRun,
} from './repository';
import type { AutomationRunTrigger } from './types';

type RunnerDeps = {
  port: number;
  sendMessage: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  broadcastSessionList: () => void;
  /**
   * Stops a session's current turn without closing the session — how a
   * targeted run is timed out or cancelled. Optional so older wiring keeps
   * working: it falls back to the agent runtime's, then to the provider.
   */
  interruptSession?: (sessionId: string) => Promise<void> | void;
};

let deps: RunnerDeps | null = null;
const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Runs in flight inside a session the automation did not create, keyed by
 * that session. The session's turn-complete event says nothing about *which*
 * prompt it answered, so this is what ties the completion back to the run
 * that started the turn — and keeps a second automation from piling a turn
 * onto the same session.
 */
interface TargetedRun {
  runId: string;
  automationId: string;
  sessionId: string;
  startedAt: number;
}
const targetedRuns = new Map<string, TargetedRun>();

export function configureAutomationRunner(nextDeps: RunnerDeps): void {
  deps = nextDeps;
}

/**
 * A webhook body big enough to be useful but not big enough to blow the first
 * turn's context. Anything past this is cut, with the cut announced inline so
 * the agent knows it is looking at a fragment rather than the whole event.
 */
const MAX_PAYLOAD_CHARS = 32_000;

/**
 * Appends whatever the caller POSTed to the automation's prompt, so a
 * webhook-triggered run knows *which* event woke it instead of having to
 * re-derive it. Fenced and labelled because it is untrusted input: it comes
 * from whatever service holds the URL.
 */
export function promptWithPayload(prompt: string, payload: string | null): string {
  if (!payload) return prompt;
  const trimmed = payload.trim();
  if (!trimmed) return prompt;
  const body = trimmed.length > MAX_PAYLOAD_CHARS
    ? `${trimmed.slice(0, MAX_PAYLOAD_CHARS)}\n… truncated at ${MAX_PAYLOAD_CHARS} chars`
    : trimmed;
  return `${prompt}\n\n<webhook-payload>\n${body}\n</webhook-payload>`;
}

function formatWhen(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at)).replace(',', '');
  } catch {
    return new Date(at).toISOString();
  }
}

/**
 * The text a targeted run sends. An existing session also hears from its
 * person, so the header tells it this turn was started by a schedule — the
 * same shape as the agent's channel headers ("[Telegram · Wed 12 Nov 09:14]").
 */
export function targetedPrompt(
  automation: Pick<AutomationRecord, 'name' | 'prompt' | 'timezone'>,
  payload: string | null,
  at = Date.now(),
): string {
  return `[Automation · ${automation.name} · ${formatWhen(at, automation.timezone)}]\n${promptWithPayload(automation.prompt, payload)}`;
}

/** True while the session is mid-turn or already running an automation of ours. */
export function isSessionBusy(sessionId: string): boolean {
  return targetedRuns.has(sessionId) || !!getSessionState(sessionId).isStreaming;
}

/** The automation run currently driving a turn in `sessionId`, if one is. */
export function activeTargetedRun(sessionId: string): { runId: string; automationId: string } | null {
  const run = targetedRuns.get(sessionId);
  return run ? { runId: run.runId, automationId: run.automationId } : null;
}

export interface RunOptions {
  /** Replaces the default reason recorded when a targeted run finds its session busy. */
  busyReason?: string;
}

export async function runAutomation(
  automation: AutomationRecord,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null = null,
  payload: string | null = null,
  options: RunOptions = {},
): Promise<AutomationRunRecord | null> {
  if (!deps) throw new Error('Automation runner is not configured');

  if (hasActiveRun(automation.id)) {
    return createRun(automation, trigger, scheduledFor, 'skipped', 'The previous run was still going');
  }

  const meta = parseManagedMeta(automation.description);
  const handler = meta ? managedRunHandler(meta.by) : null;
  if (meta && handler) {
    const veto = handler.skipReason?.(automation, meta) ?? null;
    if (veto) return createRun(automation, trigger, scheduledFor, 'skipped', veto);
    if (handler.isDirect?.(meta) && handler.runDirect) {
      return runDirect(automation, meta, handler, trigger, scheduledFor);
    }
  }

  if (automation.targetSessionId) {
    return runInTarget(automation, automation.targetSessionId, trigger, scheduledFor, payload, options);
  }
  return runInNewSession(automation, trigger, scheduledFor, payload);
}

async function runInNewSession(
  automation: AutomationRecord,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null,
  payload: string | null,
): Promise<AutomationRunRecord | null> {
  const run = createRun(automation, trigger, scheduledFor);
  if (!run) return null;

  const request = new Request(`http://localhost:${deps!.port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${automation.name} - ${new Date().toISOString()}`,
      cwd: automation.cwd,
      provider: automation.provider,
      model: automation.model,
      permissionMode: automation.permissionMode,
      effort: automation.effort,
    }),
  });

  try {
    const response = await handleCreateSession(request, deps!.port);
    if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
    const created = await response.json() as { id: string };
    startRun(run.id, created.id);
    deps!.broadcastSessionList();

    if (automation.maxRuntimeMs) {
      const handle = setTimeout(() => void timeoutRun(run.id, created.id, automation.id), automation.maxRuntimeMs);
      timeoutHandles.set(run.id, handle);
    }

    const sent = await deps!.sendMessage(created.id, promptWithPayload(automation.prompt, payload));
    if (!sent.ok) {
      clearRunTimeout(run.id);
      finishRun(run.id, 'failed', sent.error || 'Failed to send automation prompt');
    }
    return getRun(automation.id, run.id);
  } catch (error) {
    clearRunTimeout(run.id);
    finishRun(run.id, 'failed', error instanceof Error ? error.message : String(error));
    logError(`[automation:${automation.id}] ${error}`);
    return getRun(automation.id, run.id);
  }
}

/**
 * Continue an existing session (the agent's, or any tab) instead of spawning
 * one. The session keeps its own folder, provider, model and permissions —
 * the automation's are ignored — and it is never closed by the automation:
 * a timeout or cancel only interrupts the turn this run started.
 */
async function runInTarget(
  automation: AutomationRecord,
  targetId: string,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null,
  payload: string | null,
  options: RunOptions,
): Promise<AutomationRunRecord | null> {
  const target = sessions.get(targetId);
  if (!target) {
    const run = createRun(automation, trigger, scheduledFor);
    if (!run) return null;
    finishRun(run.id, 'failed', `The target session ${targetId} no longer exists`);
    return getRun(automation.id, run.id);
  }
  if (isSessionBusy(targetId)) {
    return createRun(
      automation, trigger, scheduledFor, 'skipped',
      options.busyReason ?? `"${target.name}" was in the middle of a turn`,
    );
  }

  const run = createRun(automation, trigger, scheduledFor);
  if (!run) return null;
  // Claimed before the send, so a turn that completes straight away still
  // finds its run, and a second automation sees the session as taken.
  startRun(run.id, targetId);
  targetedRuns.set(targetId, { runId: run.id, automationId: automation.id, sessionId: targetId, startedAt: Date.now() });
  if (automation.maxRuntimeMs) {
    const handle = setTimeout(() => void timeoutRun(run.id, targetId, automation.id), automation.maxRuntimeMs);
    timeoutHandles.set(run.id, handle);
  }

  try {
    const sent = await deps!.sendMessage(targetId, targetedPrompt(automation, payload));
    if (!sent.ok) {
      releaseTarget(targetId, run.id);
      clearRunTimeout(run.id);
      finishRun(run.id, 'failed', sent.error || 'Failed to send the automation prompt');
    }
  } catch (error) {
    releaseTarget(targetId, run.id);
    clearRunTimeout(run.id);
    finishRun(run.id, 'failed', error instanceof Error ? error.message : String(error));
    logError(`[automation:${automation.id}] ${error}`);
  }
  return getRun(automation.id, run.id);
}

/** A run its owner handles in code — no session, no tokens (e.g. a reminder sent verbatim). */
async function runDirect(
  automation: AutomationRecord,
  meta: ManagedMeta,
  handler: ManagedRunHandler,
  trigger: AutomationRunTrigger,
  scheduledFor: number | null,
): Promise<AutomationRunRecord | null> {
  const run = createRun(automation, trigger, scheduledFor);
  if (!run) return null;
  startRun(run.id, null);
  try {
    const result = await handler.runDirect!(automation, meta, { runId: run.id, trigger, scheduledFor });
    completeRun(run.id, result.ok ? 'succeeded' : 'failed', { resultText: result.resultText, error: result.error });
  } catch (error) {
    completeRun(run.id, 'failed', { error: error instanceof Error ? error.message : String(error) });
    logError(`[automation:${automation.id}] direct run failed: ${error}`);
  }
  return getRun(automation.id, run.id);
}

/** Last assistant text the session produced since `since`, ignoring sub-agents' own chatter. */
function lastAssistantText(sessionId: string, since: number): string | undefined {
  return [...getSessionState(sessionId).messages].reverse().find(message =>
    message.role === 'assistant' &&
    !message.toolName &&
    !message.isToolResult &&
    !message.isThinking &&
    !isSubagentChatter(message) &&
    message.timestamp >= since,
  )?.content;
}

export function completeAutomationRun(sessionId: string, info: TurnCompleteInfo): void {
  const targeted = targetedRuns.get(sessionId);
  if (targeted) {
    releaseTarget(sessionId, targeted.runId);
    clearRunTimeout(targeted.runId);
    const completedInfo = { ...info, resultText: info.resultText || lastAssistantText(sessionId, targeted.startedAt) };
    if (info.stopReason === 'interrupted') {
      // Someone stopped the turn or barged in with a message: the run did not
      // fail on its own, it was cut short.
      completeRun(targeted.runId, 'cancelled', { ...completedInfo, error: 'Interrupted before it finished' });
    } else {
      completeRun(targeted.runId, info.stopReason === 'error' ? 'failed' : 'succeeded', completedInfo);
    }
    log(`[automation:${targeted.automationId}] Run ${targeted.runId} completed in ${sessionId}`);
    return;
  }

  const run = getActiveRunBySession(sessionId);
  if (!run) return;
  const completedInfo = { ...info, resultText: info.resultText || lastAssistantText(sessionId, run.startedAt ?? run.createdAt) };
  clearRunTimeout(run.id);
  const failed = info.stopReason === 'error' || info.stopReason === 'interrupted';
  finishRunBySession(sessionId, failed ? 'failed' : 'succeeded', completedInfo);
  log(`[automation:${run.automationId}] Run ${run.id} completed`);
}

export function failAutomationRun(sessionId: string, error: string): void {
  const targeted = targetedRuns.get(sessionId);
  if (targeted) {
    releaseTarget(sessionId, targeted.runId);
    clearRunTimeout(targeted.runId);
    completeRun(targeted.runId, 'failed', { error });
    return;
  }
  const run = getActiveRunBySession(sessionId);
  if (!run) return;
  clearRunTimeout(run.id);
  finishRunBySession(sessionId, 'failed', { error });
}

export async function cancelAutomationRun(automationId: string, runId: string): Promise<boolean> {
  const run = getRun(automationId, runId);
  if (!run || !['scheduled', 'running'].includes(run.status)) return false;
  await stopRun(run.id, run.sessionId, automationId, 'cancelled', 'Cancelled by user');
  return true;
}

function clearRunTimeout(runId: string): void {
  const handle = timeoutHandles.get(runId);
  if (handle) clearTimeout(handle);
  timeoutHandles.delete(runId);
}

function releaseTarget(sessionId: string, runId: string): void {
  if (targetedRuns.get(sessionId)?.runId === runId) targetedRuns.delete(sessionId);
}

async function timeoutRun(runId: string, sessionId: string, automationId: string): Promise<void> {
  timeoutHandles.delete(runId);
  await stopRun(runId, sessionId, automationId, 'timed_out', 'Automation exceeded its maximum runtime');
}

/**
 * Settle a run from the outside (timeout, cancel) and stop its work. A
 * session the automation spawned is closed; a session it only borrowed has
 * its turn interrupted and stays open for whoever owns it.
 */
async function stopRun(
  runId: string,
  sessionId: string | null,
  automationId: string,
  status: 'timed_out' | 'cancelled',
  reason: string,
): Promise<void> {
  clearRunTimeout(runId);
  const ours = !!sessionId && targetedRuns.get(sessionId)?.runId === runId;
  // Release first: the interrupt makes the provider report the turn as
  // finished, and that report must not settle the run a second time.
  if (ours) releaseTarget(sessionId!, runId);
  const finished = finishRun(runId, status, reason);
  if (!finished || !sessionId) return;
  if (ours) {
    await interruptTurn(sessionId);
    return;
  }
  // Never close a session the automation did not create, even one whose
  // run this process lost track of.
  if (getAutomationRecord(automationId)?.targetSessionId === sessionId) return;
  try { await sessions.get(sessionId)?.providerSession?.close(); } catch {}
}

async function interruptTurn(sessionId: string): Promise<void> {
  try {
    if (deps?.interruptSession) await deps.interruptSession(sessionId);
    else if (hasAgentDeps()) await agentDeps().interruptSession(sessionId);
    else await sessions.get(sessionId)?.providerSession?.interrupt();
  } catch (error) {
    logError(`[automation] Could not interrupt ${sessionId}: ${error}`);
  }
}

/** Tests only. */
export function _resetAutomationRunnerForTest(): void {
  for (const handle of timeoutHandles.values()) clearTimeout(handle);
  timeoutHandles.clear();
  targetedRuns.clear();
}
